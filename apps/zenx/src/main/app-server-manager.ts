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
import type {
  ZenXCapabilityHost,
  ZenXCapabilityHostSnapshot,
  ZenXPostCommitCapabilityRefresh,
} from "./capabilities/types.js";
import type {
  NativeThreadSummary,
  ThreadSummaryListOptions,
} from "../../../../src/thread-summary.js";
import type { ZenXThreadAttachmentProjection } from "./image-attachments.js";
import type { ModelUsageProjection } from "../../../../src/model-usage.js";
import { AppServerConnectionPublisher } from "./app-server-connection.js";

export type AppServerHostStatus =
  | { type: "starting" }
  | { type: "ready"; reconnected: boolean }
  | { type: "reconnecting"; attempt: number; delayMs: number }
  | { type: "error"; message: string }
  | { type: "stopped" };

export interface AppServerManagerOptions {
  entryPath: string;
  tokenFile: string;
  descriptorFile?: string;
  reclaimStaleConnectionDescriptor?: boolean;
  hostConfig: ZenXHostConfig;
  execPath?: string;
  execArgv?: string[];
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  recoveryDelaysMs?: readonly number[];
  capabilityHost?: ZenXCapabilityHost;
  capabilityReplacementTimeoutMs?: number;
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
  readonly #activeCapabilityInvocations = new Map<
    string,
    { controller: AbortController; execution: Promise<void> }
  >();
  readonly #pendingThreadSummaryRequests = new Map<
    string,
    {
      resolve(summaries: NativeThreadSummary[]): void;
      reject(error: Error): void;
    }
  >();
  readonly #pendingThreadAttachmentRequests = new Map<
    string,
    {
      resolve(attachments: ZenXThreadAttachmentProjection): void;
      reject(error: Error): void;
    }
  >();
  readonly #pendingThreadUsageRequests = new Map<
    string,
    {
      resolve(usage: ModelUsageProjection): void;
      reject(error: Error): void;
    }
  >();
  readonly #pendingCapabilityReplacements = new Map<
    string,
    { resolve(): void; reject(error: Error): void }
  >();
  #status: AppServerHostStatus = { type: "stopped" };
  #child: ChildProcess | undefined;
  #client: ZenXProtocolClient | undefined;
  #acceptingCapabilityInvocations = false;
  #stopping = false;
  #recoverUnexpectedExits = false;
  #stopPromise: Promise<void> | undefined;
  #recoveryPromise: Promise<void> | undefined;
  #lifecycle = 0;
  #nextThreadSummaryRequest = 1;
  #nextThreadAttachmentRequest = 1;
  #nextThreadUsageRequest = 1;
  #nextCapabilityReplacementRequest = 1;
  #capabilityRestartTail: Promise<void> = Promise.resolve();
  #connectionPublisher: AppServerConnectionPublisher | undefined;
  #bearerToken: string | undefined;
  #authorityUrl: string | undefined;
  #publishedCapabilitySnapshot: ZenXCapabilityHostSnapshot | undefined;

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
    if (this.#child !== undefined || this.#recoveryPromise !== undefined) {
      throw new Error("ZenX App Server host is already running");
    }
    this.#stopping = false;
    this.#recoverUnexpectedExits = false;
    const lifecycle = ++this.#lifecycle;
    this.#setStatus({ type: "starting" });
    try {
      if (
        this.#options.descriptorFile !== undefined &&
        this.#connectionPublisher === undefined
      ) {
        const publisher = new AppServerConnectionPublisher(
          this.#options.descriptorFile,
        );
        await publisher.acquire({
          reclaimStale: this.#options.reclaimStaleConnectionDescriptor,
        });
        this.#connectionPublisher = publisher;
      }
      await this.#startHost(lifecycle);
      this.#setStatus({ type: "ready", reconnected: false });
    } catch (error) {
      const message = asError(error).message;
      if (
        this.#options.descriptorFile === undefined ||
        this.#connectionPublisher !== undefined
      ) {
        await removeTokenFile(this.#options.tokenFile);
        this.#bearerToken = undefined;
        this.#authorityUrl = undefined;
      }
      await this.#releaseConnectionPublisher();
      if (lifecycle === this.#lifecycle && !this.#stopping) {
        this.#setStatus({ type: "error", message });
      }
      throw new Error(message);
    }
  }

  async #startHost(lifecycle: number): Promise<void> {
    this.#acceptingCapabilityInvocations = false;
    const bearerToken =
      this.#bearerToken ??
      (await createPrivateTokenFile(this.#options.tokenFile));
    this.#bearerToken = bearerToken;
    if (lifecycle !== this.#lifecycle || this.#stopping) {
      await removeTokenFile(this.#options.tokenFile);
      throw new Error("Zen App Server startup was cancelled");
    }
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
      const capabilities = this.#options.capabilityHost?.hostSnapshot() ?? {
        definitions: [],
      };
      const url = await waitForReady(
        child,
        this.#options.startupTimeoutMs ?? 10_000,
        {
          type: "start",
          config: this.#options.hostConfig,
          bearerToken,
          listen: this.#authorityUrl ?? "ws://127.0.0.1:0",
          capabilities,
        },
      );
      if (this.#authorityUrl !== undefined && url !== this.#authorityUrl) {
        throw new Error("Zen App Server changed its published authority");
      }
      this.#authorityUrl = url;
      this.#installCapabilityBridge(child);
      const client = await ZenXProtocolClient.connect({
        url,
        clientInfo: { name: "zenx", title: "ZenX", version: "0.1.0" },
        bearerTokenFile: this.#options.tokenFile,
      });
      if (lifecycle !== this.#lifecycle || this.#stopping) {
        client.close();
        throw new Error("Zen App Server startup was cancelled");
      }
      this.#client = client;
      this.#publishedCapabilitySnapshot = structuredClone(capabilities);
      this.#forwardNotifications(client);
      await this.#connectionPublisher?.publish({
        version: 1,
        transport: "websocket",
        url,
        authentication: {
          type: "bearer-file",
          tokenFile: path.resolve(this.#options.tokenFile),
        },
      });
      this.#acceptingCapabilityInvocations = true;
      this.#recoverUnexpectedExits = true;
    } catch (error) {
      this.#acceptingCapabilityInvocations = false;
      this.#client?.close();
      this.#client = undefined;
      if (this.#child === child) this.#child = undefined;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      throw error;
    }
  }

  async restart(hostConfig: ZenXHostConfig): Promise<void> {
    if (this.#status.type !== "stopped" || this.#child !== undefined) {
      await this.stop({ preserveConnectionAuthority: true });
    }
    this.#options.hostConfig = hostConfig;
    await this.start();
  }

  async restartCapabilities(): Promise<void> {
    const restart = this.#capabilityRestartTail.then(
      async () => await this.restart(this.#options.hostConfig),
    );
    this.#capabilityRestartTail = restart.then(
      () => undefined,
      () => undefined,
    );
    await restart;
  }

  async refreshCapabilitiesAfterCommit(): Promise<ZenXPostCommitCapabilityRefresh> {
    try {
      await this.restartCapabilities();
      return { status: "refreshed" };
    } catch (error) {
      return { status: "failed", message: asError(error).message };
    }
  }

  async refreshPluginAfterCommit(
    targetPluginId: string,
  ): Promise<{ status: "reloaded" } | { status: "failed"; message: string }> {
    try {
      if (!/^[a-z][a-z0-9-]{1,62}$/u.test(targetPluginId)) {
        throw new Error(`Invalid target plugin id: ${targetPluginId}`);
      }
      const child = this.#child;
      const capabilityHost = this.#options.capabilityHost;
      if (
        this.#status.type !== "ready" ||
        child === undefined ||
        !child.connected ||
        capabilityHost === undefined
      ) {
        throw new Error("Zen App Server is not ready for plugin reload");
      }
      const requestId = `capability-replace-${String(this.#nextCapabilityReplacementRequest++)}`;
      const capabilities = capabilityHost.hostSnapshot();
      if (this.#publishedCapabilitySnapshot !== undefined) {
        assertTargetOnlyCapabilityChange(
          this.#publishedCapabilitySnapshot,
          capabilities,
          targetPluginId,
        );
      }
      await new Promise<void>((resolve, reject) => {
        const timeoutMs = this.#options.capabilityReplacementTimeoutMs ?? 5_000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
          reject(
            new Error(
              "Capability replacement timeout must be a positive integer",
            ),
          );
          return;
        }
        const timer = setTimeout(() => {
          if (!this.#pendingCapabilityReplacements.delete(requestId)) return;
          reject(
            new Error(
              `Plugin ${targetPluginId} capability replacement timed out after ${String(timeoutMs)}ms`,
            ),
          );
        }, timeoutMs);
        const pending = {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        this.#pendingCapabilityReplacements.set(requestId, pending);
        child.send(
          {
            type: "capabilities/replace",
            requestId,
            targetPluginId,
            capabilities,
          } satisfies HostCommand,
          (error) => {
            if (error === null) return;
            if (!this.#pendingCapabilityReplacements.delete(requestId)) return;
            pending.reject(error);
          },
        );
      });
      this.#publishedCapabilitySnapshot = structuredClone(capabilities);
      return { status: "reloaded" };
    } catch (error) {
      return { status: "failed", message: asError(error).message };
    }
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

  async listThreadSummaries(
    options: ThreadSummaryListOptions = {},
  ): Promise<NativeThreadSummary[]> {
    if (
      this.#status.type !== "ready" ||
      this.#child === undefined ||
      !this.#child.connected
    ) {
      const detail =
        this.#status.type === "error" ? `: ${this.#status.message}` : "";
      throw new Error(`Zen App Server is not ready${detail}`);
    }
    const requestId = `thread-summary-${String(this.#nextThreadSummaryRequest++)}`;
    return await new Promise<NativeThreadSummary[]>((resolve, reject) => {
      this.#pendingThreadSummaryRequests.set(requestId, { resolve, reject });
      this.#child!.send(
        {
          type: "thread-summary/list",
          requestId,
          options,
        } satisfies HostCommand,
        (error) => {
          if (error === null) return;
          this.#pendingThreadSummaryRequests.delete(requestId);
          reject(error);
        },
      );
    });
  }

  async readThreadAttachments(
    threadId: string,
  ): Promise<ZenXThreadAttachmentProjection> {
    if (
      this.#status.type !== "ready" ||
      this.#child === undefined ||
      !this.#child.connected
    ) {
      const detail =
        this.#status.type === "error" ? `: ${this.#status.message}` : "";
      throw new Error(`Zen App Server is not ready${detail}`);
    }
    const requestId = `thread-attachments-${String(this.#nextThreadAttachmentRequest++)}`;
    return await new Promise<ZenXThreadAttachmentProjection>(
      (resolve, reject) => {
        this.#pendingThreadAttachmentRequests.set(requestId, {
          resolve,
          reject,
        });
        this.#child!.send(
          {
            type: "thread-attachments/read",
            requestId,
            threadId,
          } satisfies HostCommand,
          (error) => {
            if (error === null) return;
            this.#pendingThreadAttachmentRequests.delete(requestId);
            reject(error);
          },
        );
      },
    );
  }

  async readThreadUsage(threadId: string): Promise<ModelUsageProjection> {
    if (
      this.#status.type !== "ready" ||
      this.#child === undefined ||
      !this.#child.connected
    ) {
      const detail =
        this.#status.type === "error" ? `: ${this.#status.message}` : "";
      throw new Error(`Zen App Server is not ready${detail}`);
    }
    const requestId = `thread-usage-${String(this.#nextThreadUsageRequest++)}`;
    return await new Promise<ModelUsageProjection>((resolve, reject) => {
      this.#pendingThreadUsageRequests.set(requestId, { resolve, reject });
      this.#child!.send(
        {
          type: "thread-usage/read",
          requestId,
          threadId,
        } satisfies HostCommand,
        (error) => {
          if (error === null) return;
          this.#pendingThreadUsageRequests.delete(requestId);
          reject(error);
        },
      );
    });
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

  async stop(
    options: { preserveConnectionAuthority?: boolean } = {},
  ): Promise<void> {
    if (this.#stopPromise !== undefined) {
      await this.#stopPromise;
      if (
        options.preserveConnectionAuthority !== true &&
        this.#connectionPublisher !== undefined
      ) {
        await this.stop();
      }
      return;
    }
    this.#stopping = true;
    this.#recoverUnexpectedExits = false;
    ++this.#lifecycle;
    this.#acceptingCapabilityInvocations = false;
    const stopping = this.#performStop(
      options.preserveConnectionAuthority === true,
    );
    this.#stopPromise = stopping;
    try {
      await stopping;
    } finally {
      if (this.#stopPromise === stopping) this.#stopPromise = undefined;
    }
  }

  async #performStop(preserveConnectionAuthority: boolean): Promise<void> {
    if (!preserveConnectionAuthority) {
      await this.#connectionPublisher?.revoke();
    }
    this.#cancelPendingApprovals();
    this.#rejectPendingThreadSummaryRequests(
      new Error("Zen App Server host stopped"),
    );
    this.#rejectPendingThreadAttachmentRequests(
      new Error("Zen App Server host stopped"),
    );
    this.#rejectPendingThreadUsageRequests(
      new Error("Zen App Server host stopped"),
    );
    this.#rejectPendingCapabilityReplacements(
      new Error("Zen App Server host stopped"),
    );
    await this.#cancelAndSettleCapabilityInvocations();
    this.#client?.close();
    this.#client = undefined;
    this.#publishedCapabilitySnapshot = undefined;
    const child = this.#child;
    if (child !== undefined && child.exitCode === null) {
      child.send({ type: "shutdown" } satisfies HostCommand);
      const exitedGracefully = await waitForExit(child, 3_000);
      if (!exitedGracefully) {
        child.kill("SIGTERM");
        const terminated = await waitForExit(child, 3_000);
        if (!terminated) {
          throw new Error(
            `Timed out after 3000ms waiting for Zen App Server child ${String(
              child.pid ?? "unknown",
            )} to settle after SIGTERM`,
          );
        }
      }
    }
    this.#child = undefined;
    await this.#recoveryPromise;
    if (!preserveConnectionAuthority) {
      await removeTokenFile(this.#options.tokenFile);
      this.#bearerToken = undefined;
      this.#authorityUrl = undefined;
      await this.#releaseConnectionPublisher();
    }
    this.#setStatus({ type: "stopped" });
  }

  async #releaseConnectionPublisher(): Promise<void> {
    const publisher = this.#connectionPublisher;
    this.#connectionPublisher = undefined;
    await publisher?.release();
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
      "item/reasoning/summaryPartAdded",
      "item/reasoning/summaryTextDelta",
      "item/reasoning/textDelta",
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
    this.#acceptingCapabilityInvocations = false;
    this.#cancelPendingApprovals();
    this.#abortCapabilityInvocations();
    this.#rejectPendingThreadSummaryRequests(
      new Error("Zen App Server stopped before returning Thread summaries"),
    );
    this.#rejectPendingThreadAttachmentRequests(
      new Error("Zen App Server stopped before returning Thread attachments"),
    );
    this.#rejectPendingThreadUsageRequests(
      new Error("Zen App Server stopped before returning Thread usage"),
    );
    this.#rejectPendingCapabilityReplacements(
      new Error("Zen App Server stopped before replacing capabilities"),
    );
    this.#client?.close();
    this.#client = undefined;
    if (!this.#stopping && this.#recoverUnexpectedExits) {
      const reason =
        signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
      this.#beginRecovery(reason);
    }
  }

  #beginRecovery(reason: string): void {
    if (this.#recoveryPromise !== undefined || this.#stopping) return;
    const lifecycle = this.#lifecycle;
    const delays = this.#options.recoveryDelaysMs ?? [100, 500, 1_000];
    const recovery = (async () => {
      let lastError = new Error(
        `Zen App Server stopped unexpectedly (${reason})`,
      );
      for (const [index, delayMs] of delays.entries()) {
        const attempt = index + 1;
        this.#setStatus({ type: "reconnecting", attempt, delayMs });
        await delay(delayMs);
        if (lifecycle !== this.#lifecycle || this.#stopping) return;
        try {
          await this.#startHost(lifecycle);
          this.#recoveryPromise = undefined;
          this.#setStatus({ type: "ready", reconnected: true });
          return;
        } catch (error) {
          lastError = asError(error);
        }
      }
      if (lifecycle === this.#lifecycle && !this.#stopping) {
        this.#recoverUnexpectedExits = false;
        await this.#connectionPublisher?.revoke();
        await removeTokenFile(this.#options.tokenFile);
        this.#bearerToken = undefined;
        this.#authorityUrl = undefined;
        this.#setStatus({
          type: "error",
          message: `Zen App Server recovery failed after ${String(delays.length)} attempts: ${lastError.message}`,
        });
      }
    })();
    this.#recoveryPromise = recovery;
    void recovery.finally(() => {
      if (this.#recoveryPromise === recovery) {
        this.#recoveryPromise = undefined;
      }
    });
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
      if (this.#child !== child) return;
      const hostEvent = isHostEvent(message) ? message : undefined;
      if (hostEvent?.type === "thread-summary/result") {
        const pending = this.#pendingThreadSummaryRequests.get(
          hostEvent.requestId,
        );
        if (pending !== undefined) {
          this.#pendingThreadSummaryRequests.delete(hostEvent.requestId);
          if (hostEvent.error !== undefined)
            pending.reject(new Error(hostEvent.error));
          else pending.resolve(hostEvent.summaries);
        }
        return;
      }
      if (hostEvent?.type === "thread-attachments/result") {
        const pending = this.#pendingThreadAttachmentRequests.get(
          hostEvent.requestId,
        );
        if (pending !== undefined) {
          this.#pendingThreadAttachmentRequests.delete(hostEvent.requestId);
          if (hostEvent.error !== undefined)
            pending.reject(new Error(hostEvent.error));
          else pending.resolve(hostEvent.attachments);
        }
        return;
      }
      if (hostEvent?.type === "thread-usage/result") {
        const pending = this.#pendingThreadUsageRequests.get(
          hostEvent.requestId,
        );
        if (pending !== undefined) {
          this.#pendingThreadUsageRequests.delete(hostEvent.requestId);
          if (hostEvent.error !== undefined)
            pending.reject(new Error(hostEvent.error));
          else pending.resolve(hostEvent.usage);
        }
        return;
      }
      if (hostEvent?.type === "capabilities/replaced") {
        const pending = this.#pendingCapabilityReplacements.get(
          hostEvent.requestId,
        );
        if (pending !== undefined) {
          this.#pendingCapabilityReplacements.delete(hostEvent.requestId);
          if (hostEvent.error === undefined) pending.resolve();
          else pending.reject(new Error(hostEvent.error));
        }
        return;
      }
      if (hostEvent === undefined) {
        const threadSummaryRequestId = readHostMessageRequestId(message);
        if (threadSummaryRequestId !== undefined) {
          const pending = this.#pendingThreadSummaryRequests.get(
            threadSummaryRequestId,
          );
          if (pending !== undefined) {
            this.#pendingThreadSummaryRequests.delete(threadSummaryRequestId);
            pending.reject(
              new Error("Malformed native Thread summary response"),
            );
          }
          const attachmentPending = this.#pendingThreadAttachmentRequests.get(
            threadSummaryRequestId,
          );
          if (attachmentPending !== undefined) {
            this.#pendingThreadAttachmentRequests.delete(
              threadSummaryRequestId,
            );
            attachmentPending.reject(
              new Error("Malformed native Thread attachment response"),
            );
          }
          const usagePending = this.#pendingThreadUsageRequests.get(
            threadSummaryRequestId,
          );
          if (usagePending !== undefined) {
            this.#pendingThreadUsageRequests.delete(threadSummaryRequestId);
            usagePending.reject(
              new Error("Malformed native Thread usage response"),
            );
          }
          const replacementPending = this.#pendingCapabilityReplacements.get(
            threadSummaryRequestId,
          );
          if (replacementPending !== undefined) {
            this.#pendingCapabilityReplacements.delete(threadSummaryRequestId);
            replacementPending.reject(
              new Error("Malformed capability replacement response"),
            );
          }
        }
        return;
      }
      if (hostEvent.type === "capability/cancel") {
        this.#activeCapabilityInvocations
          .get(hostEvent.invocationId)
          ?.controller.abort(
            new DOMException("Capability invocation cancelled", "AbortError"),
          );
        return;
      }
      if (hostEvent.type !== "capability/invoke") return;
      if (!this.#acceptingCapabilityInvocations) {
        child.send({
          type: "capability/result",
          invocationId: hostEvent.invocationId,
          error: "ZenX capability host is stopping",
        } satisfies HostCommand);
        return;
      }
      const host = this.#options.capabilityHost;
      if (host === undefined) {
        child.send({
          type: "capability/result",
          invocationId: hostEvent.invocationId,
          error: "ZenX capability host is unavailable",
        } satisfies HostCommand);
        return;
      }
      if (this.#activeCapabilityInvocations.has(hostEvent.invocationId)) {
        child.send({
          type: "capability/result",
          invocationId: hostEvent.invocationId,
          error: `Duplicate capability invocation ${hostEvent.invocationId}`,
        } satisfies HostCommand);
        return;
      }
      const controller = new AbortController();
      const execution = Promise.resolve()
        .then(
          async () =>
            await host.execute({
              ...hostEvent.invocation,
              signal: controller.signal,
            }),
        )
        .then((result) => {
          if (this.#child === child && child.connected) {
            child.send({
              type: "capability/result",
              invocationId: hostEvent.invocationId,
              output: result.output,
              exitCode: result.exitCode,
              ...(result.contentType === undefined
                ? {}
                : {
                    contentType: result.contentType,
                    structuredContent: result.structuredContent,
                  }),
              ...(result.sourceTruncated === undefined
                ? {}
                : { sourceTruncated: result.sourceTruncated }),
            } satisfies HostCommand);
          }
        })
        .catch((error: unknown) => {
          if (this.#child === child && child.connected) {
            child.send({
              type: "capability/result",
              invocationId: hostEvent.invocationId,
              error: asError(error).message,
            } satisfies HostCommand);
          }
        })
        .finally(() => {
          if (
            this.#activeCapabilityInvocations.get(hostEvent.invocationId)
              ?.execution === execution
          ) {
            this.#activeCapabilityInvocations.delete(hostEvent.invocationId);
          }
        });
      this.#activeCapabilityInvocations.set(hostEvent.invocationId, {
        controller,
        execution,
      });
    });
  }

  #abortCapabilityInvocations(): Promise<void>[] {
    const executions: Promise<void>[] = [];
    for (const active of this.#activeCapabilityInvocations.values()) {
      active.controller.abort(
        new DOMException("ZenX App Server host stopped", "AbortError"),
      );
      executions.push(active.execution);
    }
    return executions;
  }

  async #cancelAndSettleCapabilityInvocations(): Promise<void> {
    await Promise.allSettled(this.#abortCapabilityInvocations());
  }

  #rejectPendingThreadSummaryRequests(error: Error): void {
    for (const pending of this.#pendingThreadSummaryRequests.values()) {
      pending.reject(error);
    }
    this.#pendingThreadSummaryRequests.clear();
  }

  #rejectPendingThreadAttachmentRequests(error: Error): void {
    for (const pending of this.#pendingThreadAttachmentRequests.values()) {
      pending.reject(error);
    }
    this.#pendingThreadAttachmentRequests.clear();
  }

  #rejectPendingThreadUsageRequests(error: Error): void {
    for (const pending of this.#pendingThreadUsageRequests.values()) {
      pending.reject(error);
    }
    this.#pendingThreadUsageRequests.clear();
  }

  #rejectPendingCapabilityReplacements(error: Error): void {
    for (const pending of this.#pendingCapabilityReplacements.values()) {
      pending.reject(error);
    }
    this.#pendingCapabilityReplacements.clear();
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

function assertTargetOnlyCapabilityChange(
  previous: ZenXCapabilityHostSnapshot,
  next: ZenXCapabilityHostSnapshot,
  targetPluginId: string,
): void {
  const targetToolNames = new Set(
    [...(previous.plugins ?? []), ...(next.plugins ?? [])]
      .filter((plugin) => plugin.id === targetPluginId)
      .flatMap((plugin) => plugin.tools.map((tool) => tool.name)),
  );
  const withoutTarget = (snapshot: ZenXCapabilityHostSnapshot) => ({
    definitions: snapshot.definitions
      .filter((definition) => !targetToolNames.has(definition.name))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
    plugins: (snapshot.plugins ?? [])
      .filter((plugin) => plugin.id !== targetPluginId)
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  });
  if (
    JSON.stringify(withoutTarget(previous)) !==
    JSON.stringify(withoutTarget(next))
  ) {
    throw new Error(
      `Plugin reload for ${targetPluginId} changed a non-target capability projection`,
    );
  }
}

async function removeTokenFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
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
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      child.off("exit", didExit);
      resolve(exited);
    };
    const didExit = (): void => finish(true);
    child.once("exit", didExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function readHostMessageRequestId(value: unknown): string | undefined {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      !("requestId" in value) ||
      typeof value.requestId !== "string"
    ) {
      return undefined;
    }
    return value.requestId;
  } catch {
    return undefined;
  }
}
