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
} from "../protocol-client/index.js";
import {
  isHostEvent,
  type HostCommand,
  type ZenXHostConfig,
} from "./host-messages.js";

export type AppServerHostStatus =
  | { type: "starting" }
  | { type: "ready" }
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
}

type NotificationListener = (
  method: ServerNotificationMethod,
  params: ServerNotificationParams[ServerNotificationMethod],
) => void;

export class AppServerManager {
  readonly #options: AppServerManagerOptions;
  readonly #statusListeners = new Set<(status: AppServerHostStatus) => void>();
  readonly #notificationListeners = new Set<NotificationListener>();
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
        },
      );
      this.#client = await ZenXProtocolClient.connect({
        url,
        clientInfo: { name: "zenx", title: "ZenX", version: "0.1.0" },
        bearerTokenFile: this.#options.tokenFile,
      });
      this.#forwardNotifications(this.#client);
      this.#setStatus({ type: "ready" });
    } catch (error) {
      const message = asError(error).message;
      this.#setStatus({ type: "error", message });
      child.kill("SIGTERM");
      throw new Error(message);
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

  onStatus(listener: (status: AppServerHostStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onNotification(listener: NotificationListener): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
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
    for (const method of [
      "thread/started",
      "thread/name/updated",
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
        for (const listener of this.#notificationListeners) {
          listener(method, params);
        }
      });
    }
  }

  #handleChildExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.#child !== child) return;
    this.#child = undefined;
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
