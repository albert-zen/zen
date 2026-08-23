import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { ModelTool } from "../../../../src/model.js";
import type {
  ToolEnvironment,
  ToolExecutionResult,
  ToolInvocation,
  ToolProvider,
} from "../../../../src/tool.js";
import { normalizeToolExecutionResult } from "../../../../src/tool.js";
import type {
  RegisteredZenXCapability,
  ZenXPluginManifestV2,
  ZenXPluginRuntimeLifecycle,
  ZenXPluginRuntimeStage,
} from "./capabilities/types.js";
import {
  executePluginHostSdkRequest,
  validatePluginHostSdkRequest,
  ZENX_PLUGIN_HOST_SDK_VERSION,
  type ZenXPluginHostSdkV1,
} from "./plugin-host-sdk.js";

const PLUGIN_RUNTIME_PROTOCOL_VERSION = 1;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_START_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_PENDING_REQUESTS = 64;

export interface PluginRuntimeIdentity {
  pluginId: string;
  packageVersion: string;
}

export interface PluginRuntimeInvocation {
  invocationId: string;
  tool: string;
  arguments: Record<string, unknown>;
  context: { callId: string; cwd: string };
  signal: AbortSignal;
}

/** Provider-neutral boundary implemented by plugin code or its transport adapter. */
export interface PluginRuntime {
  readonly identity: PluginRuntimeIdentity;
  invoke(invocation: PluginRuntimeInvocation): Promise<ToolExecutionResult>;
  close(): Promise<void>;
}

export interface PluginRuntimeRegistration {
  identity: PluginRuntimeIdentity;
  definitions: readonly ModelTool[];
  start(sdk?: ZenXPluginHostSdkV1): Promise<PluginRuntime>;
}

interface ActiveRuntime {
  token: object;
  provider: SupervisedPluginProvider;
  unregisterProvider(): void;
}

interface StagedRuntime {
  token: object;
  provider: SupervisedPluginProvider;
}

/**
 * Host-owned transient runtime registry. It admits exact namespaced ownership,
 * publishes one Tool Environment provider, and never retries failed runtimes.
 */
export class PluginRuntimeSupervisor {
  readonly #toolEnvironment: ToolEnvironment;
  readonly #hostSdkFor: (pluginId: string) => Promise<ZenXPluginHostSdkV1>;
  readonly #active = new Map<string, ActiveRuntime>();
  readonly #staged = new Map<string, StagedRuntime>();
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(
    toolEnvironment: ToolEnvironment,
    options: {
      hostSdkFor?(pluginId: string): Promise<ZenXPluginHostSdkV1>;
    } = {},
  ) {
    this.#toolEnvironment = toolEnvironment;
    this.#hostSdkFor =
      options.hostSdkFor ?? (async (pluginId) => unavailableHostSdk(pluginId));
  }

  async start(registration: PluginRuntimeRegistration): Promise<void> {
    const staged = await this.stage(registration);
    try {
      await staged.publish();
    } catch (error) {
      await staged.rollback();
      throw error;
    }
  }

  async stage(
    registration: PluginRuntimeRegistration,
    hostSdk?: ZenXPluginHostSdkV1,
  ): Promise<ZenXPluginRuntimeStage> {
    return await this.#serializeMutation(async () => {
      validateIdentity(registration.identity);
      validateNamespacedDefinitions(
        registration.identity.pluginId,
        registration.definitions,
      );
      const pluginId = registration.identity.pluginId;
      if (this.#staged.has(pluginId)) {
        throw new Error(`Plugin runtime is already staged: ${pluginId}`);
      }

      const sdk = hostSdk ?? (await this.#hostSdkFor(pluginId));
      if (
        sdk.version !== ZENX_PLUGIN_HOST_SDK_VERSION ||
        sdk.pluginId !== pluginId
      ) {
        throw new Error(`Plugin Host SDK identity mismatch for ${pluginId}`);
      }
      const runtime = await registration.start(sdk);
      if (!sameIdentity(runtime.identity, registration.identity)) {
        await closeAfterStartFailure(runtime);
        throw new Error(`Plugin runtime identity mismatch for ${pluginId}`);
      }
      const token = Object.freeze({});
      const provider = new SupervisedPluginProvider(
        registration.identity,
        registration.definitions,
        runtime,
      );
      this.#staged.set(pluginId, { token, provider });
      return {
        publish: async () => {
          await this.#publish(pluginId, token);
        },
        rollback: async () => {
          await this.#rollback(pluginId, token);
        },
      };
    });
  }

  async #publish(pluginId: string, token: object): Promise<void> {
    await this.#serializeMutation(async () => {
      const staged = this.#staged.get(pluginId);
      if (staged?.token !== token) {
        if (this.#active.get(pluginId)?.token === token) return;
        throw new Error(
          `Plugin runtime stage is no longer current: ${pluginId}`,
        );
      }
      const unregisterProvider = this.#toolEnvironment.registerProvider(
        staged.provider,
      );
      this.#staged.delete(pluginId);
      this.#active.set(pluginId, {
        token,
        provider: staged.provider,
        unregisterProvider,
      });
    });
  }

  async #rollback(pluginId: string, token: object): Promise<void> {
    await this.#serializeMutation(async () => {
      const staged = this.#staged.get(pluginId);
      if (staged?.token === token) {
        this.#staged.delete(pluginId);
        await staged.provider.retire();
        return;
      }
      const active = this.#active.get(pluginId);
      if (active?.token !== token) return;
      await this.#stop(pluginId);
    });
  }

  async stop(pluginId: string): Promise<void> {
    await this.#serializeMutation(async () => {
      await this.#stop(pluginId);
    });
  }

  async #stop(pluginId: string): Promise<void> {
    const active = this.#active.get(pluginId);
    if (active === undefined) return;
    this.#active.delete(pluginId);
    active.unregisterProvider();
    await active.provider.retire();
  }

  async close(): Promise<void> {
    await this.#serializeMutation(async () => {
      const failures: Error[] = [];
      for (const pluginId of [...this.#active.keys()]) {
        try {
          await this.#stop(pluginId);
        } catch (error) {
          failures.push(asError(error));
        }
      }
      for (const [pluginId, staged] of [...this.#staged]) {
        this.#staged.delete(pluginId);
        try {
          await staged.provider.retire();
        } catch (error) {
          failures.push(asError(error));
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Plugin runtime shutdown failed");
      }
    });
  }

  /** Human/plugin-product path: routes directly and creates no AppServer Turn. */
  async invoke(
    pluginId: string,
    invocation: Omit<PluginRuntimeInvocation, "invocationId"> & {
      invocationId?: string;
    },
  ): Promise<ToolExecutionResult> {
    const active = this.#active.get(pluginId);
    if (active === undefined) {
      throw new Error(`Plugin runtime is not enabled: ${pluginId}`);
    }
    return await active.provider.invoke({
      ...invocation,
      invocationId: invocation.invocationId ?? randomUUID(),
    });
  }

  async #serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(mutation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

class SupervisedPluginProvider implements ToolProvider {
  readonly identity;
  readonly definitions: readonly ModelTool[];
  readonly #runtime: PluginRuntime;
  readonly #toolNames: Set<string>;
  readonly #active = new Set<Promise<unknown>>();
  readonly #drainWaiters = new Set<() => void>();
  #prepared = 0;
  #closePromise: Promise<void> | undefined;

  constructor(
    identity: PluginRuntimeIdentity,
    definitions: readonly ModelTool[],
    runtime: PluginRuntime,
  ) {
    this.identity = { kind: "plugin", id: identity.pluginId } as const;
    this.definitions = definitions.map((definition) =>
      structuredClone(definition),
    );
    this.#toolNames = new Set(definitions.map((definition) => definition.name));
    this.#runtime = runtime;
  }

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    return await this.invoke({
      invocationId: invocation.callId,
      tool: invocation.name,
      arguments: invocation.arguments,
      context: { callId: invocation.callId, cwd: invocation.cwd },
      signal: invocation.signal,
    });
  }

  retainPreparedInvocation(): () => void {
    this.#prepared += 1;
    let retained = true;
    return () => {
      if (!retained) return;
      retained = false;
      this.#prepared -= 1;
      this.#notifyDrain();
    };
  }

  async invoke(
    invocation: PluginRuntimeInvocation,
  ): Promise<ToolExecutionResult> {
    if (!this.#toolNames.has(invocation.tool)) {
      throw new Error(
        `Plugin ${this.identity.id} does not own tool ${invocation.tool}`,
      );
    }
    invocation.signal.throwIfAborted();
    const operation = this.#runtime.invoke(invocation);
    this.#active.add(operation);
    try {
      return normalizeToolExecutionResult(
        validateResult(await operation, this.identity.id),
        this.identity,
      );
    } finally {
      this.#active.delete(operation);
      this.#notifyDrain();
    }
  }

  async retire(): Promise<void> {
    while (this.#prepared > 0 || this.#active.size > 0) {
      await new Promise<void>((resolve) => {
        this.#drainWaiters.add(resolve);
      });
    }
    this.#closePromise ??= this.#runtime.close();
    await this.#closePromise;
  }

  #notifyDrain(): void {
    for (const resolve of this.#drainWaiters) resolve();
    this.#drainWaiters.clear();
  }
}

export interface BundledPluginModule {
  invoke(
    invocation: PluginRuntimeInvocation,
    sdk: ZenXPluginHostSdkV1,
  ): Promise<ToolExecutionResult>;
  close?(): Promise<void> | void;
}

export class BundledModulePluginRuntime implements PluginRuntime {
  readonly identity: PluginRuntimeIdentity;
  readonly #module: BundledPluginModule;
  readonly #sdk: ZenXPluginHostSdkV1;
  #closed = false;

  constructor(
    identity: PluginRuntimeIdentity,
    module: BundledPluginModule,
    sdk?: ZenXPluginHostSdkV1,
  ) {
    this.identity = Object.freeze({ ...identity });
    this.#module = module;
    this.#sdk = sdk ?? unavailableHostSdk(identity.pluginId);
  }

  async invoke(
    invocation: PluginRuntimeInvocation,
  ): Promise<ToolExecutionResult> {
    if (this.#closed)
      throw new Error(`Plugin runtime is closed: ${this.identity.pluginId}`);
    return await this.#module.invoke(invocation, this.#sdk);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#module.close?.();
  }
}

interface PendingProcessRequest {
  resolve(result: ToolExecutionResult): void;
  reject(error: Error): void;
  signal: AbortSignal;
  abort(): void;
  timer: NodeJS.Timeout;
}

export class ProcessPluginRuntime implements PluginRuntime {
  readonly identity: PluginRuntimeIdentity;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #maxMessageBytes: number;
  readonly #requestTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #maxPendingRequests: number;
  readonly #sdk: ZenXPluginHostSdkV1;
  readonly #pending = new Map<string, PendingProcessRequest>();
  readonly #cancelled = new Set<string>();
  readonly #hostRequests = new Set<string>();
  #buffer = Buffer.alloc(0);
  #failure: Error | undefined;
  #closed = false;

  private constructor(
    identity: PluginRuntimeIdentity,
    child: ChildProcessWithoutNullStreams,
    options: Required<
      Pick<
        ProcessPluginRuntimeOptions,
        | "maxMessageBytes"
        | "requestTimeoutMs"
        | "closeTimeoutMs"
        | "maxPendingRequests"
      >
    >,
    sdk: ZenXPluginHostSdkV1,
  ) {
    this.identity = Object.freeze({ ...identity });
    this.#child = child;
    this.#maxMessageBytes = options.maxMessageBytes;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#maxPendingRequests = options.maxPendingRequests;
    this.#sdk = sdk;
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => this.#onData(chunk));
    child.once("error", (error) =>
      this.#fail(new Error(`Plugin runtime process error: ${error.message}`)),
    );
    child.once("exit", (code, signal) => {
      if (!this.#closed) {
        this.#fail(
          new Error(
            `Plugin runtime ${identity.pluginId} exited unexpectedly (${signal ?? String(code)})`,
          ),
        );
      }
    });
  }

  static async start(
    identity: PluginRuntimeIdentity,
    options: ProcessPluginRuntimeOptions,
  ): Promise<ProcessPluginRuntime> {
    validateIdentity(identity);
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.environment ?? minimalPluginEnvironment(process.env),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const runtime = new ProcessPluginRuntime(
      identity,
      child,
      {
        maxMessageBytes: options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
        requestTimeoutMs:
          options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
        maxPendingRequests:
          options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
      },
      options.hostSdk ?? unavailableHostSdk(identity.pluginId),
    );
    try {
      await runtime.#waitForReady(
        options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      );
      return runtime;
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
  }

  async #waitForReady(timeoutMs: number): Promise<void> {
    const id = "__ready__";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            `Plugin runtime ${this.identity.pluginId} did not become ready`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        signal: new AbortController().signal,
        abort: () => {},
        timer,
      });
    });
  }

  async invoke(
    invocation: PluginRuntimeInvocation,
  ): Promise<ToolExecutionResult> {
    this.#assertAvailable();
    invocation.signal.throwIfAborted();
    if (invocation.invocationId === "__ready__") {
      throw new Error("Plugin invocation id is reserved: __ready__");
    }
    if (
      this.#pending.has(invocation.invocationId) ||
      this.#cancelled.has(invocation.invocationId)
    ) {
      throw new Error(
        `Duplicate plugin invocation id: ${invocation.invocationId}`,
      );
    }
    if (this.#pending.size >= this.#maxPendingRequests) {
      throw new Error(
        `Plugin runtime ${this.identity.pluginId} has too many pending requests`,
      );
    }
    const message = encodeMessage(
      {
        version: PLUGIN_RUNTIME_PROTOCOL_VERSION,
        hostSdkVersion: ZENX_PLUGIN_HOST_SDK_VERSION,
        type: "invoke",
        id: invocation.invocationId,
        tool: invocation.tool,
        arguments: invocation.arguments,
        context: invocation.context,
      },
      this.#maxMessageBytes,
    );
    return await new Promise<ToolExecutionResult>((resolve, reject) => {
      const abort = (): void => {
        this.#rememberCancellation(invocation.invocationId);
        this.#write({
          version: PLUGIN_RUNTIME_PROTOCOL_VERSION,
          type: "cancel",
          id: invocation.invocationId,
        });
        this.#settle(invocation.invocationId, () =>
          reject(abortError(invocation.signal)),
        );
      };
      const timer = setTimeout(() => {
        this.#rememberCancellation(invocation.invocationId);
        this.#write({
          version: PLUGIN_RUNTIME_PROTOCOL_VERSION,
          type: "cancel",
          id: invocation.invocationId,
        });
        this.#settle(invocation.invocationId, () =>
          reject(
            new Error(
              `Plugin runtime request timed out: ${invocation.invocationId}`,
            ),
          ),
        );
      }, this.#requestTimeoutMs);
      this.#pending.set(invocation.invocationId, {
        resolve,
        reject,
        signal: invocation.signal,
        abort,
        timer,
      });
      invocation.signal.addEventListener("abort", abort, { once: true });
      this.#child.stdin.write(message);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#write({ version: PLUGIN_RUNTIME_PROTOCOL_VERSION, type: "close" });
    for (const id of [...this.#pending.keys()]) {
      if (id !== "__ready__")
        this.#settle(id, (pending) =>
          pending.reject(
            new Error(`Plugin runtime ${this.identity.pluginId} closed`),
          ),
        );
    }
    if (this.#child.exitCode !== null || this.#child.signalCode !== null)
      return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#child.kill("SIGKILL");
        resolve();
      }, this.#closeTimeoutMs);
      this.#child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #onData(chunk: Buffer): void {
    if (this.#failure !== undefined) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (
      this.#buffer.length > this.#maxMessageBytes &&
      !this.#buffer.includes(10)
    ) {
      this.#fail(
        new Error(
          `Plugin runtime ${this.identity.pluginId} exceeded its message limit`,
        ),
      );
      return;
    }
    for (;;) {
      const newline = this.#buffer.indexOf(10);
      if (newline === -1) return;
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.length > this.#maxMessageBytes) {
        this.#fail(
          new Error(
            `Plugin runtime ${this.identity.pluginId} exceeded its message limit`,
          ),
        );
        return;
      }
      try {
        this.#onMessage(JSON.parse(line.toString("utf8")) as unknown);
      } catch (error) {
        this.#fail(
          new Error(
            `Plugin runtime ${this.identity.pluginId} returned malformed protocol: ${describeError(error)}`,
          ),
        );
        return;
      }
    }
  }

  #onMessage(value: unknown): void {
    if (
      !isRecord(value) ||
      value.version !== PLUGIN_RUNTIME_PROTOCOL_VERSION ||
      typeof value.type !== "string"
    ) {
      throw new Error("invalid envelope");
    }
    if (value.type === "ready") {
      if (!this.#pending.has("__ready__")) {
        throw new Error("unexpected ready message");
      }
      if (
        value.pluginId !== this.identity.pluginId ||
        value.packageVersion !== this.identity.packageVersion
      ) {
        throw new Error("ready identity mismatch");
      }
      this.#settle("__ready__", (pending) =>
        pending.resolve({ output: "", exitCode: 0 }),
      );
      return;
    }
    if (value.type === "host_request") {
      if (
        value.hostSdkVersion !== ZENX_PLUGIN_HOST_SDK_VERSION ||
        typeof value.id !== "string" ||
        typeof value.invocationId !== "string" ||
        !this.#pending.has(value.invocationId)
      ) {
        throw new Error("invalid Host SDK request envelope");
      }
      const requestId = value.id;
      const invocationId = value.invocationId;
      const hostRequestKey = `${invocationId}\0${requestId}`;
      if (
        this.#hostRequests.has(hostRequestKey) ||
        this.#hostRequests.size >= this.#maxPendingRequests
      ) {
        throw new Error("Plugin Runtime exceeded its Host SDK request limit");
      }
      const request = validatePluginHostSdkRequest(value.request);
      this.#hostRequests.add(hostRequestKey);
      void executePluginHostSdkRequest(this.#sdk, request)
        .then(
          (result) =>
            this.#write({
              version: PLUGIN_RUNTIME_PROTOCOL_VERSION,
              hostSdkVersion: ZENX_PLUGIN_HOST_SDK_VERSION,
              type: "host_result",
              id: requestId,
              invocationId,
              result,
            }),
          (error: unknown) =>
            this.#write({
              version: PLUGIN_RUNTIME_PROTOCOL_VERSION,
              hostSdkVersion: ZENX_PLUGIN_HOST_SDK_VERSION,
              type: "host_result",
              id: requestId,
              invocationId,
              error: describeError(error),
            }),
        )
        .finally(() => this.#hostRequests.delete(hostRequestKey));
      return;
    }
    if (
      (value.type !== "result" && value.type !== "error") ||
      typeof value.id !== "string"
    ) {
      throw new Error("unexpected message");
    }
    if (
      [...this.#hostRequests].some((key) => key.startsWith(`${value.id}\0`))
    ) {
      throw new Error(
        `Plugin runtime ${value.id} settled before its Host SDK requests`,
      );
    }
    if (value.id === "__ready__") {
      throw new Error("reserved invocation id");
    }
    const pending = this.#pending.get(value.id);
    if (pending === undefined) {
      if (this.#cancelled.delete(value.id)) return;
      throw new Error(`unknown invocation ${value.id}`);
    }
    if (value.type === "error") {
      if (typeof value.message !== "string")
        throw new Error("invalid error result");
      const message = value.message;
      this.#settle(value.id, (request) => request.reject(new Error(message)));
      return;
    }
    const result = validateResult(value.result, this.identity.pluginId);
    this.#settle(value.id, (request) => request.resolve(result));
  }

  #settle(id: string, action: (pending: PendingProcessRequest) => void): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.abort);
    action(pending);
  }

  #write(value: unknown): void {
    if (this.#child.stdin.destroyed) return;
    try {
      this.#child.stdin.write(encodeMessage(value, this.#maxMessageBytes));
    } catch {
      // The process failure/exit path is the authoritative rejection surface.
    }
  }

  #rememberCancellation(invocationId: string): void {
    if (this.#cancelled.size >= this.#maxPendingRequests) {
      const oldest = this.#cancelled.values().next().value as
        string | undefined;
      if (oldest !== undefined) this.#cancelled.delete(oldest);
    }
    this.#cancelled.add(invocationId);
  }

  #fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    for (const id of [...this.#pending.keys()]) {
      this.#settle(id, (pending) => pending.reject(error));
    }
    if (!this.#closed) this.#child.kill("SIGKILL");
  }

  #assertAvailable(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closed)
      throw new Error(`Plugin runtime is closed: ${this.identity.pluginId}`);
  }
}

export interface ProcessPluginRuntimeOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  maxMessageBytes?: number;
  maxPendingRequests?: number;
  hostSdk?: ZenXPluginHostSdkV1;
}

export class HttpPluginRuntime implements PluginRuntime {
  readonly identity: PluginRuntimeIdentity;
  readonly #url: URL;
  readonly #requestTimeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #maxPendingRequests: number;
  readonly #controllers = new Map<string, AbortController>();
  readonly #sdk: ZenXPluginHostSdkV1;
  #closed = false;

  constructor(
    identity: PluginRuntimeIdentity,
    options: HttpPluginRuntimeOptions,
  ) {
    validateIdentity(identity);
    this.identity = Object.freeze({ ...identity });
    this.#url = new URL(options.url);
    if (this.#url.protocol !== "http:" && this.#url.protocol !== "https:") {
      throw new Error("Plugin HTTP runtime URL must use http or https");
    }
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#maxMessageBytes =
      options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.#maxPendingRequests =
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
    this.#sdk = options.hostSdk ?? unavailableHostSdk(identity.pluginId);
  }

  async invoke(
    invocation: PluginRuntimeInvocation,
  ): Promise<ToolExecutionResult> {
    if (this.#closed)
      throw new Error(`Plugin runtime is closed: ${this.identity.pluginId}`);
    invocation.signal.throwIfAborted();
    if (this.#controllers.has(invocation.invocationId)) {
      throw new Error(
        `Duplicate plugin invocation id: ${invocation.invocationId}`,
      );
    }
    if (this.#controllers.size >= this.#maxPendingRequests) {
      throw new Error(
        `Plugin HTTP runtime ${this.identity.pluginId} has too many pending requests`,
      );
    }
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(invocation.signal.reason);
    invocation.signal.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            `Plugin HTTP request timed out: ${invocation.invocationId}`,
          ),
        ),
      this.#requestTimeoutMs,
    );
    this.#controllers.set(invocation.invocationId, controller);
    try {
      let requestBody: unknown = {
        version: PLUGIN_RUNTIME_PROTOCOL_VERSION,
        hostSdkVersion: ZENX_PLUGIN_HOST_SDK_VERSION,
        id: invocation.invocationId,
        plugin: this.identity,
        tool: invocation.tool,
        arguments: invocation.arguments,
        context: invocation.context,
      };
      for (let hostCall = 0; ; hostCall += 1) {
        if (hostCall > this.#maxPendingRequests)
          throw new Error(
            `Plugin HTTP runtime ${this.identity.pluginId} exceeded its Host SDK call limit`,
          );
        const response = await fetch(this.#url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encodeJson(requestBody, this.#maxMessageBytes),
          signal: controller.signal,
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > this.#maxMessageBytes)
          throw new Error(
            `Plugin HTTP runtime ${this.identity.pluginId} exceeded its response limit`,
          );
        if (!response.ok)
          throw new Error(
            `Plugin HTTP runtime ${this.identity.pluginId} failed with HTTP ${String(response.status)}`,
          );
        let value: unknown;
        try {
          value = JSON.parse(bytes.toString("utf8")) as unknown;
        } catch (error) {
          throw new Error(
            `Plugin HTTP runtime ${this.identity.pluginId} returned malformed JSON: ${describeError(error)}`,
          );
        }
        if (
          !isRecord(value) ||
          value.version !== PLUGIN_RUNTIME_PROTOCOL_VERSION ||
          value.id !== invocation.invocationId
        ) {
          throw new Error(
            `Plugin HTTP runtime ${this.identity.pluginId} returned an invalid envelope`,
          );
        }
        if (isRecord(value.hostRequest)) {
          if (value.hostSdkVersion !== ZENX_PLUGIN_HOST_SDK_VERSION) {
            throw new Error(
              `Plugin HTTP runtime ${this.identity.pluginId} returned an incompatible Host SDK request`,
            );
          }
          const hostRequestId = value.hostRequest.id;
          if (typeof hostRequestId !== "string")
            throw new Error(
              `Plugin HTTP runtime ${this.identity.pluginId} returned an invalid Host SDK request`,
            );
          let hostResult: unknown;
          let hostError: string | undefined;
          try {
            hostResult = await executePluginHostSdkRequest(
              this.#sdk,
              validatePluginHostSdkRequest(value.hostRequest.request),
            );
          } catch (error) {
            hostError = describeError(error);
          }
          requestBody = {
            version: PLUGIN_RUNTIME_PROTOCOL_VERSION,
            hostSdkVersion: ZENX_PLUGIN_HOST_SDK_VERSION,
            id: invocation.invocationId,
            plugin: this.identity,
            hostResult: {
              id: hostRequestId,
              ...(hostError === undefined
                ? { result: hostResult }
                : { error: hostError }),
            },
          };
          continue;
        }
        if (typeof value.error === "string") throw new Error(value.error);
        return validateResult(value.result, this.identity.pluginId);
      }
    } finally {
      clearTimeout(timer);
      invocation.signal.removeEventListener("abort", forwardAbort);
      this.#controllers.delete(invocation.invocationId);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#controllers.values())
      controller.abort(
        new Error(`Plugin runtime ${this.identity.pluginId} closed`),
      );
    this.#controllers.clear();
  }
}

export interface HttpPluginRuntimeOptions {
  url: string;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
  maxPendingRequests?: number;
  hostSdk?: ZenXPluginHostSdkV1;
}

/** Bridges Catalog lifecycle mutations to a supervisor without owning lifecycle state. */
export class CatalogPluginRuntimeLifecycle implements ZenXPluginRuntimeLifecycle {
  readonly #supervisor: PluginRuntimeSupervisor;
  readonly #registrationFor: (
    registration: RegisteredZenXCapability,
  ) => PluginRuntimeRegistration;
  readonly #hostSdkFor?: (registration: RegisteredZenXCapability) => Promise<{
    sdk: ZenXPluginHostSdkV1;
    rollback?(): Promise<void>;
  }>;

  constructor(options: {
    supervisor: PluginRuntimeSupervisor;
    registrationFor(
      registration: RegisteredZenXCapability,
    ): PluginRuntimeRegistration;
    hostSdkFor?(registration: RegisteredZenXCapability): Promise<{
      sdk: ZenXPluginHostSdkV1;
      rollback?(): Promise<void>;
    }>;
  }) {
    this.#supervisor = options.supervisor;
    this.#registrationFor = options.registrationFor;
    this.#hostSdkFor = options.hostSdkFor;
  }

  async stage(
    registration: RegisteredZenXCapability,
  ): Promise<ZenXPluginRuntimeStage> {
    if (registration.package.manifest.schemaVersion !== 2) {
      throw new Error("Plugin Runtime requires manifest v2");
    }
    const prepared =
      this.#hostSdkFor === undefined
        ? undefined
        : await this.#hostSdkFor(registration);
    try {
      const stage = await this.#supervisor.stage(
        this.#registrationFor(registration),
        prepared?.sdk,
      );
      return {
        publish: async () => await stage.publish(),
        rollback: async () => {
          let runtimeError: unknown;
          try {
            await stage.rollback();
          } catch (error) {
            runtimeError = error;
          }
          await prepared?.rollback?.();
          if (runtimeError !== undefined) throw runtimeError;
        },
      };
    } catch (error) {
      await prepared?.rollback?.();
      throw error;
    }
  }

  async stop(pluginId: string): Promise<void> {
    await this.#supervisor.stop(pluginId);
  }
}

export function bundledPackageRegistration(
  registration: RegisteredZenXCapability,
): PluginRuntimeRegistration {
  const manifest = registration.package.manifest;
  if (manifest.schemaVersion !== 2)
    throw new Error("Plugin Runtime requires manifest v2");
  return {
    identity: { pluginId: manifest.id, packageVersion: manifest.version },
    definitions: manifest.tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
    start: async (sdk) => {
      const hostSdk = sdk ?? unavailableHostSdk(manifest.id);
      await registration.package.start?.(hostSdk);
      return new BundledModulePluginRuntime(
        { pluginId: manifest.id, packageVersion: manifest.version },
        {
          invoke: async (invocation, hostSdk) =>
            normalizePackageResult(
              await registration.package.invoke(
                invocation.tool,
                {
                  callId: invocation.context.callId,
                  name: invocation.tool,
                  arguments: invocation.arguments,
                  cwd: invocation.context.cwd,
                  signal: invocation.signal,
                },
                hostSdk,
              ),
            ),
        },
        hostSdk,
      );
    },
  };
}

function normalizePackageResult(value: unknown): ToolExecutionResult {
  if (
    isRecord(value) &&
    typeof value.output === "string" &&
    Number.isSafeInteger(value.exitCode)
  ) {
    return {
      output: value.output,
      exitCode: value.exitCode as number,
      ...(Object.hasOwn(value, "contentType") ||
      Object.hasOwn(value, "structuredContent")
        ? {
            contentType: value.contentType as string,
            structuredContent:
              value.structuredContent as ToolExecutionResult["structuredContent"],
          }
        : {}),
    };
  }
  const output = typeof value === "string" ? value : JSON.stringify(value);
  return { output: output ?? String(value), exitCode: 0 };
}

function validateNamespacedDefinitions(
  pluginId: string,
  definitions: readonly ModelTool[],
): void {
  const prefix = `${pluginId.replaceAll("-", "_")}_`;
  if (definitions.length === 0)
    throw new Error(`Plugin ${pluginId} declares no tools`);
  const names = new Set<string>();
  for (const definition of definitions) {
    if (!definition.name.startsWith(prefix))
      throw new Error(
        `Plugin tool ${definition.name} must be namespaced with ${prefix}`,
      );
    if (names.has(definition.name))
      throw new Error(
        `Plugin ${pluginId} defines ${definition.name} more than once`,
      );
    names.add(definition.name);
  }
}

function validateIdentity(identity: PluginRuntimeIdentity): void {
  if (
    !/^[a-z][a-z0-9-]{1,62}$/u.test(identity.pluginId) ||
    identity.packageVersion.length === 0
  ) {
    throw new Error("Plugin runtime identity is invalid");
  }
}

function minimalPluginEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["HOME", "LANG", "PATH", "SHELL", "TMPDIR"]) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  return environment;
}

function sameIdentity(
  left: PluginRuntimeIdentity,
  right: PluginRuntimeIdentity,
): boolean {
  return (
    left.pluginId === right.pluginId &&
    left.packageVersion === right.packageVersion
  );
}

function validateResult(value: unknown, pluginId: string): ToolExecutionResult {
  if (
    !isRecord(value) ||
    typeof value.output !== "string" ||
    !Number.isSafeInteger(value.exitCode)
  ) {
    throw new Error(`Plugin runtime ${pluginId} returned an invalid result`);
  }
  return {
    output: value.output,
    exitCode: value.exitCode as number,
    ...(Object.hasOwn(value, "contentType") ||
    Object.hasOwn(value, "structuredContent")
      ? {
          contentType: value.contentType as string,
          structuredContent:
            value.structuredContent as ToolExecutionResult["structuredContent"],
        }
      : {}),
  };
}

function encodeMessage(value: unknown, maxBytes: number): string {
  return `${encodeJson(value, maxBytes)}\n`;
}

function encodeJson(value: unknown, maxBytes: number): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes)
    throw new Error("Plugin runtime request exceeded its message limit");
  return encoded;
}

async function closeAfterStartFailure(runtime: PluginRuntime): Promise<void> {
  try {
    await runtime.close();
  } catch {
    /* Preserve the admission failure. */
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function manifestRuntimeIdentity(
  manifest: ZenXPluginManifestV2,
): PluginRuntimeIdentity {
  return { pluginId: manifest.id, packageVersion: manifest.version };
}

function unavailableHostSdk(pluginId: string): ZenXPluginHostSdkV1 {
  const unavailable = async (): Promise<never> => {
    throw new Error(`Plugin Host SDK is not configured: ${pluginId}`);
  };
  return Object.freeze({
    version: ZENX_PLUGIN_HOST_SDK_VERSION,
    pluginId,
    query: Object.freeze({ projects: Object.freeze({ list: unavailable }) }),
    actions: Object.freeze({
      threads: Object.freeze({ startTurn: unavailable }),
    }),
    ui: Object.freeze({
      handles: Object.freeze({ read: unavailable }),
      commands: Object.freeze({ execute: unavailable }),
    }),
    storage: Object.freeze({ version: 1, get: unavailable, set: unavailable }),
  });
}
