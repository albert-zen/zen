import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

import {
  ZenXProtocolClient,
  type ClientRequestMethod,
  type ClientRequestParams,
  type ClientRequestResults,
  type ServerNotificationMethod,
  type ServerNotificationParams,
  type ServerRequestParams,
  type ServerRequestResults,
} from "../protocol-client/index.js";
import {
  isHostEvent,
  type HostCommand,
  type ZenXHostConfig,
} from "./host-messages.js";
import type { ZenXCapabilityHost } from "./capabilities/types.js";

export type AppServerHostStatus =
  | { type: "starting" }
  | { type: "ready"; reconnected: boolean }
  | { type: "reconnecting"; attempt: number; delayMs: number }
  | { type: "error"; message: string }
  | { type: "stopped" };

export interface AppServerManagerOptions {
  entryPath: string;
  tokenFile: string;
  hostConfig: ZenXHostConfig;
  execPath?: string;
  execArgv?: string[];
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  capabilityHost?: ZenXCapabilityHost;
}

type NotificationListener = (
  method: ServerNotificationMethod,
  params: ServerNotificationParams[ServerNotificationMethod],
) => void;

export type ApprovalDecision =
  ServerRequestResults["item/commandExecution/requestApproval"]["decision"];

export interface ApprovalRequestEvent {
  requestId: string;
  params: ServerRequestParams["item/commandExecution/requestApproval"];
}

export interface ApprovalResolvedEvent {
  requestId: string;
  threadId: string;
  decision: ApprovalDecision | null;
}

interface PendingApproval {
  event: ApprovalRequestEvent;
  decision: ApprovalDecision | null;
  resolve(result: { decision: ApprovalDecision }): void;
}

export class AppServerManager {
  readonly #options: AppServerManagerOptions;
  readonly #statusListeners = new Set<(status: AppServerHostStatus) => void>();
  readonly #notificationListeners = new Set<NotificationListener>();
  readonly #approvalListeners = new Set<
    (event: ApprovalRequestEvent) => void
  >();
  readonly #approvalResolvedListeners = new Set<
    (event: ApprovalResolvedEvent) => void
  >();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #activeCapabilityInvocations = new Map<string, AbortController>();
  #status: AppServerHostStatus = { type: "stopped" };
  #child: ChildProcess | undefined;
  #client: ZenXProtocolClient | undefined;
  #stopping = false;

  constructor(options: AppServerManagerOptions) {
    this.#options = options;
  }

  get status(): AppServerHostStatus {
    return this.#status;
  }

  get processId(): number | undefined {
    return this.#child?.pid;
  }

  reportStartupError(error: unknown): void {
    if (this.#child !== undefined) {
      throw new Error("Cannot replace the status of a running App Server host");
    }
    this.#setStatus({ type: "error", message: asError(error).message });
  }

  async start(): Promise<void> {
    if (this.#child !== undefined) {
      throw new Error("ZenX App Server host is already running");
    }
    this.#stopping = false;
    this.#setStatus({ type: "starting" });
    const bearerToken = await createPrivateTokenFile(this.#options.tokenFile);
    const child = fork(this.#options.entryPath, [], {
      cwd: process.cwd(),
      env: {
        ...(this.#options.environment ?? process.env),
        ...(this.#options.execPath === undefined
          ? {}
          : { ELECTRON_RUN_AS_NODE: "1" }),
      },
      execPath: this.#options.execPath,
      execArgv: this.#options.execArgv,
      silent: true,
    });
    this.#child = child;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      console.error(`[ZenX App Server] ${chunk.toString().trimEnd()}`);
    });
    child.once("exit", (code, signal) => {
      this.#handleChildExit(child, code, signal);
    });

    try {
      const url = await waitForReady(
        child,
        this.#options.startupTimeoutMs ?? 10_000,
        {
          type: "start",
          config: this.#options.hostConfig,
          bearerToken,
          capabilities: this.#options.capabilityHost?.hostSnapshot() ?? {
            definitions: [],
          },
        },
      );
      this.#installCapabilityBridge(child);
      this.#client = await ZenXProtocolClient.connect({
        url,
        clientInfo: { name: "zenx", title: "ZenX", version: "0.1.0" },
        bearerTokenFile: this.#options.tokenFile,
      });
      this.#forwardNotifications(this.#client);
      this.#setStatus({ type: "ready", reconnected: false });
    } catch (error) {
      const message = asError(error).message;
      this.#setStatus({ type: "error", message });
      child.kill("SIGTERM");
      throw new Error(message);
    }
  }

  async restart(hostConfig: ZenXHostConfig): Promise<void> {
    await this.stop();
    this.#options.hostConfig = hostConfig;
    await this.start();
  }

  async restartCapabilities(): Promise<void> {
    await this.restart(this.#options.hostConfig);
  }

  async request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequestParams[M],
  ): Promise<ClientRequestResults[M]> {
    if (this.#status.type !== "ready" || this.#client === undefined) {
      const detail =
        this.#status.type === "error" ? `: ${this.#status.message}` : "";
      throw new Error(`Zen App Server is not ready${detail}`);
    }
    return await this.#client.request(method, params);
  }

  onStatus(listener: (status: AppServerHostStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onNotification(listener: NotificationListener): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onApprovalRequest(
    listener: (event: ApprovalRequestEvent) => void,
  ): () => void {
    this.#approvalListeners.add(listener);
    return () => this.#approvalListeners.delete(listener);
  }

  get pendingApprovalRequests(): readonly ApprovalRequestEvent[] {
    return [...this.#pendingApprovals.values()].map((pending) => pending.event);
  }

  onApprovalResolved(
    listener: (event: ApprovalResolvedEvent) => void,
  ): () => void {
    this.#approvalResolvedListeners.add(listener);
    return () => this.#approvalResolvedListeners.delete(listener);
  }

  respondToApproval(requestId: string, decision: ApprovalDecision): void {
    const pending = this.#pendingApprovals.get(requestId);
    if (pending === undefined) {
      throw new Error(`Approval request ${requestId} is no longer pending`);
    }
    if (pending.decision !== null) {
      throw new Error(`Approval request ${requestId} already has a response`);
    }
    pending.decision = decision;
    pending.resolve({ decision });
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#cancelPendingApprovals();
    this.#cancelCapabilityInvocations();
    this.#client?.close();
    this.#client = undefined;
    const child = this.#child;
    if (child !== undefined && child.exitCode === null) {
      child.send({ type: "shutdown" } satisfies HostCommand);
      await waitForExit(child, 3_000);
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    this.#child = undefined;
    await removeTokenFile(this.#options.tokenFile);
    this.#setStatus({ type: "stopped" });
  }

  #forwardNotifications(client: ZenXProtocolClient): void {
    client.onStatus((status) => {
      if (client !== this.#client || this.#stopping) return;
      if (status.type === "reconnecting") {
        this.#setStatus({
          type: "reconnecting",
          attempt: status.attempt,
          delayMs: status.delayMs,
        });
      } else if (status.type === "ready" && status.reconnected) {
        this.#setStatus({ type: "ready", reconnected: true });
      } else if (status.type === "protocolError") {
        this.#setStatus({ type: "error", message: status.error.message });
      }
    });
    client.onServerRequest(
      "item/commandExecution/requestApproval",
      async (params, context) => {
        const requestId = String(context.requestId);
        if (this.#pendingApprovals.has(requestId)) {
          throw new Error(`Duplicate approval request ${requestId}`);
        }
        return await new Promise<{ decision: ApprovalDecision }>((resolve) => {
          const event = { requestId, params };
          this.#pendingApprovals.set(requestId, {
            event,
            decision: null,
            resolve,
          });
          for (const listener of this.#approvalListeners) listener(event);
        });
      },
    );
    for (const method of [
      "thread/started",
      "thread/name/updated",
      "thread/archived",
      "thread/unarchived",
      "thread/settings/updated",
      "turn/started",
      "item/started",
      "item/agentMessage/delta",
      "item/commandExecution/outputDelta",
      "item/completed",
      "serverRequest/resolved",
      "turn/completed",
      "error",
    ] as const) {
      client.onNotification(method, (params) => {
        if (method === "serverRequest/resolved") {
          this.#resolveApproval(
            params as ServerNotificationParams["serverRequest/resolved"],
          );
        }
        for (const listener of this.#notificationListeners) {
          listener(method, params);
        }
      });
    }
  }

  #resolveApproval(
    params: ServerNotificationParams["serverRequest/resolved"],
  ): void {
    const pending = this.#pendingApprovals.get(params.requestId);
    if (pending === undefined) return;
    if (pending.decision === null) {
      pending.decision = "cancel";
      pending.resolve({ decision: "cancel" });
    }
    const event = {
      requestId: params.requestId,
      threadId: params.threadId,
      decision: pending.decision,
    } satisfies ApprovalResolvedEvent;
    this.#pendingApprovals.delete(params.requestId);
    for (const listener of this.#approvalResolvedListeners) listener(event);
  }

  #handleChildExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    this.#cancelPendingApprovals();
    this.#cancelCapabilityInvocations();
    this.#client?.close();
    this.#client = undefined;
    if (!this.#stopping) {
      const reason =
        signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
      this.#setStatus({
        type: "error",
        message: `Zen App Server stopped unexpectedly (${reason})`,
      });
    }
  }

  #setStatus(status: AppServerHostStatus): void {
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }

  #cancelPendingApprovals(): void {
    for (const pending of this.#pendingApprovals.values()) {
      pending.resolve({ decision: "cancel" });
    }
    this.#pendingApprovals.clear();
  }

  #installCapabilityBridge(child: ChildProcess): void {
    child.on("message", (message: unknown) => {
      if (!isHostEvent(message) || this.#child !== child) return;
      if (message.type === "capability/cancel") {
        this.#activeCapabilityInvocations
          .get(message.invocationId)
          ?.abort(
            new DOMException("Capability invocation cancelled", "AbortError"),
          );
        return;
      }
      if (message.type !== "capability/invoke") return;
      const host = this.#options.capabilityHost;
      if (host === undefined) {
        child.send({
          type: "capability/result",
          invocationId: message.invocationId,
          error: "ZenX capability host is unavailable",
        } satisfies HostCommand);
        return;
      }
      if (this.#activeCapabilityInvocations.has(message.invocationId)) {
        child.send({
          type: "capability/result",
          invocationId: message.invocationId,
          error: `Duplicate capability invocation ${message.invocationId}`,
        } satisfies HostCommand);
        return;
      }
      const controller = new AbortController();
      this.#activeCapabilityInvocations.set(message.invocationId, controller);
      void host
        .execute({ ...message.invocation, signal: controller.signal })
        .then((result) => {
          if (this.#child === child && child.connected) {
            child.send({
              type: "capability/result",
              invocationId: message.invocationId,
              output: result.output,
              exitCode: result.exitCode,
            } satisfies HostCommand);
          }
        })
        .catch((error: unknown) => {
          if (this.#child === child && child.connected) {
            child.send({
              type: "capability/result",
              invocationId: message.invocationId,
              error: asError(error).message,
            } satisfies HostCommand);
          }
        })
        .finally(() => {
          this.#activeCapabilityInvocations.delete(message.invocationId);
        });
    });
  }

  #cancelCapabilityInvocations(): void {
    for (const controller of this.#activeCapabilityInvocations.values()) {
      controller.abort(
        new DOMException("ZenX App Server host stopped", "AbortError"),
      );
    }
    this.#activeCapabilityInvocations.clear();
  }
}

async function createPrivateTokenFile(filePath: string): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const handle = await open(filePath, "w", 0o600);
  try {
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await chmod(filePath, 0o600);
  return token;
}

async function removeTokenFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function waitForReady(
  child: ChildProcess,
  timeoutMs: number,
  command: HostCommand,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out starting Zen App Server")),
      timeoutMs,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onMessage = (message: unknown): void => {
      if (!isHostEvent(message)) return;
      if (message.type !== "ready" && message.type !== "error") return;
      cleanup();
      if (message.type === "ready") resolve(message.url);
      else reject(new Error(message.message));
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      cleanup();
      reject(
        new Error(
          `Zen App Server exited during startup (${signal ?? String(code)})`,
        ),
      );
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
    child.send(command);
  });
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", exited);
      resolve();
    }, timeoutMs);
    const exited = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", exited);
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
