import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ZenXPluginHostSdkV1 } from "@zenx/plugin-sdk";

export interface ImZenXHost {
  readonly dataDirectory: string;
  isServerReady(): boolean;
  onServerStatus(listener: () => void): () => void;
  readConnection(): Promise<{
    url: string;
    authentication: { tokenFile: string };
  }>;
}
interface Configuration {
  pythonExecutable: string;
  channelsConfigFile: string;
  cwd: string;
  sharedFilesystemRoot?: string;
  permissionMode: "full-access" | "approval-required";
  allowUnrestrictedFullAccess: boolean;
}
interface Invocation {
  arguments: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}
type State =
  | "unconfigured"
  | "waiting-for-zas"
  | "starting"
  | "connected"
  | "failed"
  | "stopped";

/** A plugin lifecycle owner, never an Agent, transcript, or delivery worker. */
export class ImZenXRuntime {
  readonly storage = { version: 1, initialValue: {} } as const;
  readonly #host: ImZenXHost;
  #sdk: ZenXPluginHostSdkV1 | undefined;
  #config: Configuration | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;
  #unsubscribe: (() => void) | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  #state: State = "unconfigured";
  #error: string | undefined;

  constructor(host: ImZenXHost) {
    this.#host = host;
  }

  async start(sdk: ZenXPluginHostSdkV1): Promise<void> {
    this.#sdk = sdk;
    const value = await sdk.storage.get();
    if (value["configuration"] !== undefined)
      this.#config = configuration(value["configuration"]);
    this.#unsubscribe = this.#host.onServerStatus(() => {
      void this.#serialize(async () => {
        await this.#stop();
        if (!this.#closed) await this.#connect();
      }).catch(() => {});
    });
    // Plugin initialization precedes ZAS startup. Never block the Host on IM.
    void this.#serialize(() => this.#connect()).catch(() => {});
  }

  async invoke(name: string, invocation: Invocation): Promise<unknown> {
    invocation.signal.throwIfAborted();
    if (name === "imzenx_status") return this.status();
    return await this.#serialize(async () => {
      invocation.signal.throwIfAborted();
      if (this.#closed || this.#sdk === undefined)
        throw new Error("IMZenX is stopped");
      if (name === "imzenx_configure") {
        const input = invocation.arguments["input"] ?? invocation.arguments;
        const next = configuration(input);
        await this.#sdk.storage.set({ configuration: next });
        this.#config = next;
      } else if (name !== "imzenx_connect") {
        throw new Error(`Unknown IMZenX tool: ${name}`);
      }
      await this.#stop();
      invocation.signal.throwIfAborted();
      await this.#connect();
      return this.status();
    });
  }

  status() {
    return {
      state: this.#state,
      ...(this.#error === undefined ? {} : { error: this.#error }),
      configuration: this.#config ?? null,
      subscriptions:
        "One selected Thread per IM conversation. /subscribe <id> or /pick selects it; /unsubscribe removes it. Bindings survive restart.",
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    // Stop promptly even if the queue is waiting for the child's ready message.
    await this.#stop();
    await this.#queue.catch(() => {});
    this.#state = "stopped";
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(action);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #connect(): Promise<void> {
    if (this.#closed) return;
    this.#error = undefined;
    if (this.#config === undefined) {
      this.#state = "unconfigured";
      return;
    }
    if (!this.#host.isServerReady()) {
      this.#state = "waiting-for-zas";
      return;
    }
    this.#state = "starting";
    try {
      const descriptor = await this.#host.readConnection();
      await mkdir(this.#host.dataDirectory, { recursive: true, mode: 0o700 });
      if (this.#closed || !this.#host.isServerReady()) return;
      const config = this.#config;
      const sourceRoot = fileURLToPath(
        new URL("../python/src", import.meta.url),
      );
      const child = spawn(config.pythonExecutable, ["-u", "-m", "imzen.zenx"], {
        shell: false,
        cwd: config.cwd,
        env: { ...process.env, PYTHONPATH: sourceRoot, PYTHONUNBUFFERED: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.#child = child;
      // SDK/channel stdout cannot be interpreted as model output or a transcript.
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.once("exit", () => {
        if (this.#child !== child) return;
        this.#child = undefined;
        this.#state = "failed";
        this.#error =
          "IM Gateway exited. Check configuration, then Connect again.";
      });
      const ready = waitForReady(child);
      child.stdin.write(
        JSON.stringify({
          IMZEN_APP_SERVER_URL: descriptor.url,
          IMZEN_APP_SERVER_AUTH_TOKEN_FILE: descriptor.authentication.tokenFile,
          IMZEN_CWD: config.cwd,
          IMZEN_CHANNELS_CONFIG_FILE: config.channelsConfigFile,
          IMZEN_GATEWAY_STATE_FILE: path.join(
            this.#host.dataDirectory,
            "gateway.sqlite3",
          ),
          IMZEN_PERMISSION_MODE: config.permissionMode,
          IMZEN_ALLOW_UNRESTRICTED_FULL_ACCESS: String(
            config.allowUnrestrictedFullAccess,
          ),
          ...(config.sharedFilesystemRoot === undefined
            ? {}
            : {
                IMZEN_APP_SERVER_SHARED_FILESYSTEM_ROOT:
                  config.sharedFilesystemRoot,
              }),
        }) + "\n",
      );
      await ready;
      if (this.#child === child && !this.#closed) this.#state = "connected";
    } catch (error) {
      await this.#stop();
      if (this.#closed) return;
      this.#state = "failed";
      this.#error =
        error instanceof Error ? error.message : "IM Gateway failed";
      throw error;
    }
  }

  async #stop(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (
      child === undefined ||
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
      const finish = () => {
        clearTimeout(timeout);
        resolve();
      };
      child.once("exit", finish);
      child.once("error", finish);
      child.stdin.end();
    });
  }
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => finish(new Error("IM Gateway startup timed out")),
      15000,
    );
    const failed = () =>
      finish(
        new Error(
          "IM Gateway failed to start. Check Python and channel configuration.",
        ),
      );
    const data = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 65536) {
        failed();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const value = JSON.parse(line) as { type?: string };
          if (value.type === "ready") {
            finish();
            return;
          }
          if (value.type === "failed") {
            failed();
            return;
          }
        } catch {
          /* Channel diagnostics are not the ready handshake. */
        }
      }
    };
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout.off("data", data);
      child.off("error", failed);
      child.off("exit", failed);
      child.stdout.resume();
      if (error === undefined) resolve();
      else reject(error);
    };
    child.stdout.on("data", data);
    child.once("error", failed);
    child.once("exit", failed);
  });
}

function configuration(value: unknown): Configuration {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("IMZenX configuration must be an object");
  const input = value as Record<string, unknown>;
  const absolute = (key: string) => {
    const candidate = input[key];
    if (
      typeof candidate !== "string" ||
      !path.isAbsolute(candidate) ||
      candidate.includes("\0")
    )
      throw new Error(`${key} must be an absolute path`);
    return candidate;
  };
  const permissionMode = input["permissionMode"] ?? "full-access";
  if (
    permissionMode !== "full-access" &&
    permissionMode !== "approval-required"
  )
    throw new Error("Invalid permissionMode");
  const unrestricted = input["allowUnrestrictedFullAccess"] ?? false;
  if (typeof unrestricted !== "boolean")
    throw new Error("allowUnrestrictedFullAccess must be boolean");
  return {
    pythonExecutable: absolute("pythonExecutable"),
    channelsConfigFile: absolute("channelsConfigFile"),
    cwd: absolute("cwd"),
    ...(input["sharedFilesystemRoot"] === undefined ||
    input["sharedFilesystemRoot"] === ""
      ? {}
      : { sharedFilesystemRoot: absolute("sharedFilesystemRoot") }),
    permissionMode,
    allowUnrestrictedFullAccess: unrestricted,
  };
}

export function createZenXTrustedPlugin(host: ImZenXHost): ImZenXRuntime {
  return new ImZenXRuntime(host);
}
