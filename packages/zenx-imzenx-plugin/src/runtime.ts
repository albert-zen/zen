import { attachPawPipe, type PawRequest } from "./paw-pipe.js";
import { configuration, type Configuration } from "./configuration.js";
import type { ManagedChannelInspection } from "./channel-schema.js";
import { inspectReadiness, type ReadinessCheck } from "./readiness.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ZenXPluginHostSdkV1 } from "@zenx/plugin-sdk";

export interface ImZenXHost {
  readonly dataDirectory: string;
  setRuntimeProject?(directory: string): void;
  registerManagedEdit?(
    edit: (
      configFile: string,
      action: () => Promise<unknown>,
    ) => Promise<unknown>,
  ): () => void;
  readManagedChannels?(
    channelsConfigFile: string,
  ): Promise<Record<string, unknown> | undefined>;
  inspectManagedChannels?(
    channelsConfigFile: string,
  ): Promise<ManagedChannelInspection | undefined>;
  pawRequest?(
    cwd: string,
    operation: Parameters<PawRequest>[0],
    params: Parameters<PawRequest>[1],
  ): Promise<unknown>;
  isServerReady(): boolean;
  onServerStatus(listener: () => void): () => void;
  readConnection(): Promise<{
    url: string;
    authentication: { tokenFile: string };
  }>;
}
interface Invocation {
  arguments: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}
type State =
  | "waiting-for-activation"
  | "unconfigured"
  | "prepared"
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
  #activeConfig: Configuration | undefined;
  #explicitConnectRequired = false;
  #singleConsumerConfirmationRequired = false;
  #child: ChildProcessWithoutNullStreams | undefined;
  #unsubscribe: (() => void) | undefined;
  #unregisterManagedEdit: (() => void) | undefined;
  #detachPaw: (() => void) | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  #activated = false;
  #generation = 0;
  // Transient admission fence only; persisted configuration remains authoritative.
  readonly #revisionNamespace = randomUUID();
  #configurationEpoch = 0;
  #managedEditEpoch = 0;
  readonly #managedContentEpochs = new Map<string, number>();
  #state: State = "unconfigured";
  #error: string | undefined;

  constructor(host: ImZenXHost) {
    this.#host = host;
  }

  async start(sdk: ZenXPluginHostSdkV1): Promise<void> {
    this.#closed = false;
    this.#activated = false;
    this.#generation += 1;
    this.#state = "waiting-for-activation";
    this.#error = undefined;
    this.#sdk = sdk;
    const value = await sdk.storage.get();
    this.#config =
      value["configuration"] === undefined
        ? undefined
        : configuration(value["configuration"]);
    this.#explicitConnectRequired = value["explicitConnectRequired"] === true;
    this.#singleConsumerConfirmationRequired =
      value["singleConsumerConfirmationRequired"] === true;
    this.#configurationEpoch += 1;
  }

  /** Preparation has no IM side effects; replacement waits for the old consumer. */
  activate(previousRetired: Promise<void>): void {
    const generation = this.#generation;
    void previousRetired.then(
      () => {
        if (this.#closed || generation !== this.#generation) return;
        this.#activated = true;
        this.#host.setRuntimeProject?.(
          fileURLToPath(new URL("../python/", import.meta.url)),
        );
        this.#unregisterManagedEdit = this.#host.registerManagedEdit?.(
          (configFile, action) =>
            this.#serialize(async () => {
              if (
                this.#closed ||
                !this.#activated ||
                this.#sdk === undefined ||
                generation !== this.#generation
              )
                throw new Error("IMZenX is stopped");
              const matchesCurrentConfiguration =
                this.#config !== undefined &&
                path.resolve(this.#config.channelsConfigFile) ===
                  path.resolve(configFile);
              if (matchesCurrentConfiguration)
                await this.#prepare(this.#config!);
              // Keep the same queue until the trusted native vault edit completes.
              // It is not a model tool argument or an exposed generic callback API.
              try {
                return await action();
              } finally {
                // A queued acknowledgement made during this edit is stale even
                // after a failed/partial write. Review and explicitly connect again.
                if (matchesCurrentConfiguration) this.#configurationEpoch += 1;
                // Configure can select this marker for the first time, so edits
                // also invalidate pending Configure admissions before selection.
                this.#managedEditEpoch += 1;
                const marker = path.resolve(configFile);
                this.#managedContentEpochs.set(
                  marker,
                  (this.#managedContentEpochs.get(marker) ?? 0) + 1,
                );
              }
            }),
        );
        this.#unsubscribe = this.#host.onServerStatus(() => {
          void this.#serialize(async () => {
            await this.#stop();
            if (!this.#closed) await this.#connect();
          }).catch(() => {});
        });
        // Never block Catalog publication or Host startup on an IM connection.
        void this.#serialize(() => this.#connect()).catch(() => {});
      },
      () => {
        if (this.#closed || generation !== this.#generation) return;
        this.#state = "failed";
        this.#error =
          "Previous IM Gateway did not stop. Restart ZenX before reconnecting.";
      },
    );
  }

  async invoke(name: string, invocation: Invocation): Promise<unknown> {
    invocation.signal.throwIfAborted();
    if (name === "imzenx_status") return this.status();
    const admittedGeneration = this.#generation;
    const admittedConfigurationEpoch = this.#configurationEpoch;
    const admittedManagedEditEpoch = this.#managedEditEpoch;
    return await this.#serialize(async () => {
      invocation.signal.throwIfAborted();
      if (this.#closed || this.#sdk === undefined)
        throw new Error("IMZenX is stopped");
      if (
        (name === "imzenx_connect" || name === "imzenx_configure") &&
        (admittedGeneration !== this.#generation ||
          admittedConfigurationEpoch !== this.#configurationEpoch ||
          (name === "imzenx_configure" &&
            admittedManagedEditEpoch !== this.#managedEditEpoch))
      )
        throw new Error(
          "IM settings changed while this connection was waiting. Review the saved settings, confirm other bot consumers are stopped, then Connect again.",
        );
      if (name === "imzenx_readiness") {
        const input = invocation.arguments["input"] ?? invocation.arguments;
        if (typeof input !== "object" || input === null || Array.isArray(input))
          throw new Error("IMZenX readiness arguments must be an object");
        const selected =
          Object.keys(input as Record<string, unknown>).length === 0
            ? this.#config
            : configuration(input, "approval-required");
        let managed: ManagedChannelInspection | undefined;
        if (
          selected !== undefined &&
          this.#host.inspectManagedChannels !== undefined
        ) {
          try {
            managed = await this.#host.inspectManagedChannels(
              selected.channelsConfigFile,
            );
          } catch {
            throw new Error(
              "Unable to inspect this IMZenX managed configuration",
            );
          }
        }
        const inspected =
          selected === undefined
            ? {
                checks: [
                  {
                    id: "configuration",
                    status: "blocked",
                    message:
                      "Choose your own Python executable, private channel file and workspace first.",
                  } satisfies ReadinessCheck,
                ],
                enabledChannels: [],
              }
            : await inspectReadiness(selected, invocation.signal, managed);
        const serverReady = this.#host.isServerReady();
        const checks: ReadinessCheck[] = [
          ...inspected.checks,
          {
            id: "server",
            status: serverReady ? "ready" : "blocked",
            message: serverReady
              ? "This Host's local Zen App Server is ready."
              : "This Host's local Zen App Server is not ready.",
            ...(serverReady
              ? {}
              : {
                  action:
                    "Start the local Zen App Server in ZenX, then check again.",
                }),
          },
          {
            id: "single-consumer",
            status: "warning",
            message:
              "Readiness cannot prove that another client is not using this bot. Confirm that other consumers are stopped before connecting.",
          },
        ];
        return {
          configurationRevision: this.#configurationRevision(selected),
          ready: checks.every((check) => check.status !== "blocked"),
          checks,
          enabledChannels: inspected.enabledChannels,
          singleConsumerConfirmationRequired: true,
          connectionState: this.#state,
        };
      }
      if (!this.#activated)
        throw new Error("IMZenX is waiting for runtime activation");
      const input = invocation.arguments["input"] ?? invocation.arguments;
      if (name === "imzenx_prepare") {
        const next = configuration(input, "approval-required");
        await this.#prepare(next);
        return this.status();
      }
      if (name !== "imzenx_configure" && name !== "imzenx_connect")
        throw new Error(`Unknown IMZenX tool: ${name}`);
      if (typeof input !== "object" || input === null || Array.isArray(input))
        throw new Error("IMZenX connection arguments must be an object");
      const {
        singleConsumerConfirmed,
        expectedConfigurationRevision,
        ...fields
      } = input as Record<string, unknown>;
      if (
        singleConsumerConfirmed !== undefined &&
        typeof singleConsumerConfirmed !== "boolean"
      )
        throw new Error("singleConsumerConfirmed must be boolean");
      const reviewedConfiguration =
        name === "imzenx_configure" ? configuration(fields) : this.#config;
      const managedSelection =
        reviewedConfiguration === undefined
          ? undefined
          : await this.#host.inspectManagedChannels?.(
              reviewedConfiguration.channelsConfigFile,
            );
      const confirmationRequired =
        this.#singleConsumerConfirmationRequired ||
        managedSelection !== undefined;
      if (confirmationRequired && singleConsumerConfirmed !== true)
        throw new Error(
          "Confirm that other consumers of this bot are stopped, then Connect with singleConsumerConfirmed=true.",
        );
      if (
        (confirmationRequired || expectedConfigurationRevision !== undefined) &&
        (typeof expectedConfigurationRevision !== "string" ||
          expectedConfigurationRevision !==
            this.#configurationRevision(reviewedConfiguration))
      )
        throw new Error(
          "IM settings changed after readiness was reviewed. Check readiness, confirm other bot consumers are stopped, then Connect again.",
        );
      if (name === "imzenx_configure") {
        const next = reviewedConfiguration!;
        await this.#sdk.storage.set({
          configuration: next,
          explicitConnectRequired: false,
          singleConsumerConfirmationRequired: confirmationRequired,
        });
        this.#config = next;
        this.#configurationEpoch += 1;
      } else {
        if (Object.keys(fields).length > 0)
          throw new Error(
            "IMZenX Connect accepts only singleConsumerConfirmed and expectedConfigurationRevision",
          );
        if (this.#config !== undefined)
          await this.#sdk.storage.set({
            configuration: this.#config,
            explicitConnectRequired: false,
            singleConsumerConfirmationRequired: confirmationRequired,
          });
      }
      this.#singleConsumerConfirmationRequired = confirmationRequired;
      this.#explicitConnectRequired = false;
      await this.#stop();
      invocation.signal.throwIfAborted();
      await this.#connect();
      return this.status();
    });
  }

  status() {
    return {
      state: this.#state,
      configurationRevision: this.#configurationRevision(this.#config),
      ...(this.#error === undefined ? {} : { error: this.#error }),
      configuration: this.#config ?? null,
      activeConfiguration: this.#activeConfig ?? null,
      explicitConnectRequired: this.#explicitConnectRequired,
      singleConsumerConfirmationRequired:
        this.#singleConsumerConfirmationRequired,
      connectionMeaning:
        "Connected means the SDK Gateway started; real bot delivery is not verified.",
      subscriptions:
        "One selected Thread per IM conversation. Use /threads then /pick <number> to select and receive replies; /new clears selection. Bindings survive restart; list again before using a number.",
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#generation += 1;
    this.#activated = false;
    this.#unregisterManagedEdit?.();
    this.#unregisterManagedEdit = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    // Stop promptly even if the queue is waiting for the child's ready message.
    await this.#stop();
    await this.#queue.catch(() => {});
    this.#state = "stopped";
  }

  async #prepare(next: Configuration): Promise<void> {
    if (this.#sdk === undefined) throw new Error("IMZenX is stopped");
    await this.#sdk.storage.set({
      configuration: next,
      explicitConnectRequired: true,
      singleConsumerConfirmationRequired: true,
    });
    this.#config = next;
    this.#configurationEpoch += 1;
    this.#explicitConnectRequired = true;
    this.#singleConsumerConfirmationRequired = true;
    // Saving never changes the running consumer. Pending paths need Connect.
    if (this.#child === undefined) {
      this.#state = "prepared";
      this.#error = undefined;
    }
  }

  /** Opaque, nonsecret acknowledgement revision; never a credential or durable state. */
  #configurationRevision(selected: Configuration | undefined): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          namespace: this.#revisionNamespace,
          generation: this.#generation,
          configuration: this.#configurationEpoch,
          managedEdit:
            selected === undefined
              ? 0
              : (this.#managedContentEpochs.get(
                  path.resolve(selected.channelsConfigFile),
                ) ?? 0),
          selected: selected ?? null,
        }),
      )
      .digest("hex");
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(action);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #connect(): Promise<void> {
    if (this.#closed || !this.#activated) return;
    this.#error = undefined;
    if (this.#config === undefined) {
      this.#state = "unconfigured";
      return;
    }
    if (this.#explicitConnectRequired) {
      this.#state = "prepared";
      return;
    }
    if (!this.#host.isServerReady()) {
      this.#state = "waiting-for-zas";
      return;
    }
    this.#state = "starting";
    try {
      const descriptor = await this.#host.readConnection();
      // Only the Host-owned exact configuration reference can resolve private
      // values. They go solely to the trusted Gateway's existing private pipe.
      const managedChannels = await this.#host.readManagedChannels?.(
        this.#config.channelsConfigFile,
      );
      await mkdir(this.#host.dataDirectory, { recursive: true, mode: 0o700 });
      if (this.#closed || !this.#host.isServerReady()) return;
      const config = this.#config;
      const sourceRoot = fileURLToPath(
        new URL("../python/src", import.meta.url),
      );
      // A workspace package must never shadow the trusted Gateway and receive
      // decrypted channel values. Isolated mode excludes cwd, PYTHON* and user
      // site startup paths; only this admitted package's source is added back.
      const bootstrap = `import runpy, sys; sys.path.insert(0, ${JSON.stringify(sourceRoot)}); runpy.run_module("imzen.zenx", run_name="__main__")`;
      const child = spawn(
        config.pythonExecutable,
        ["-I", "-u", "-c", bootstrap],
        {
          shell: false,
          cwd: config.cwd,
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      this.#child = child;
      this.#activeConfig = config;
      // SDK/channel stdout cannot be interpreted as model output or a transcript.
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.once("exit", () => {
        if (this.#child !== child) return;
        this.#child = undefined;
        this.#activeConfig = undefined;
        this.#state = "failed";
        this.#error =
          "IM Gateway exited. Check configuration, then Connect again.";
      });
      this.#detachPaw = attachPawPipe(
        child,
        async (operation, params) => {
          if (!this.#host.pawRequest)
            throw new Error("PAW Rooms unavailable on this Host");
          return this.#host.pawRequest(config.cwd, operation, params);
        },
        () => this.#child === child && !this.#closed,
      );
      const ready = waitForReady(child);
      child.stdin.write(
        JSON.stringify({
          IMZEN_APP_SERVER_URL: descriptor.url,
          IMZEN_APP_SERVER_AUTH_TOKEN_FILE: descriptor.authentication.tokenFile,
          IMZEN_CWD: config.cwd,
          IMZEN_CHANNELS_CONFIG_FILE: config.channelsConfigFile,
          ...(managedChannels === undefined
            ? {}
            : { IMZEN_CHANNELS_CONFIG: managedChannels }),
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
      // Host, SDK and filesystem diagnostics may contain private data. Only our
      // fixed startup failures belong in status or a tool's exception message.
      this.#error =
        error instanceof Error &&
        error.message === "IM Gateway startup timed out"
          ? "IM Gateway startup timed out"
          : "IM Gateway failed to start. Check Python and channel configuration.";
      throw new Error(this.#error);
    }
  }

  async #stop(): Promise<void> {
    const child = this.#child;
    this.#detachPaw?.();
    this.#detachPaw = undefined;
    this.#child = undefined;
    this.#activeConfig = undefined;
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

export function createZenXTrustedPlugin(host: ImZenXHost): ImZenXRuntime {
  return new ImZenXRuntime(host);
}
