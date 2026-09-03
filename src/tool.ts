import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { ApprovalDecision, JsonValue } from "./item.js";
import type { ModelTool } from "./model.js";
import {
  DEFAULT_TOOL_OUTPUT_CAPTURE_BYTES,
  type ToolOutputCaptureMetadata,
  type ToolOutputSpool,
} from "./tool-output-spool.js";

const TOOL_OUTPUT_CAPTURE = Symbol("tool-output-capture");

export interface ToolInvocation {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  cwd: string;
  signal: AbortSignal;
}

export interface ToolExecutionResult {
  output: string;
  exitCode: number;
  contentType?: string;
  structuredContent?: JsonValue;
  /** Host-local capture state; AgentRuntime renders it before canonical append. */
  [TOOL_OUTPUT_CAPTURE]?: ToolOutputCaptureMetadata;
  /** True when the runtime already omitted source bytes before returning. */
  sourceTruncated?: boolean;
}

export const MAX_STRUCTURED_TOOL_RESULT_BYTES = 1024 * 1024;

export type ToolBundleKind = "builtin" | "plugin" | "external";

export interface ToolBundleIdentity {
  kind: ToolBundleKind;
  id: string;
}

export type ToolExecutionMode = "parallel_safe" | "exclusive";

/** One exact model-visible tool and its execution body. */
export interface ToolRuntime {
  readonly name: string;
  readonly specification: ModelTool;
  /** Runtime body scheduling only; not permission or resource scope. */
  readonly executionMode?: ToolExecutionMode;
  execute(invocation: ToolInvocation): Promise<ToolExecutionResult>;
}

/** Runtime capability available only to host-owned builtin composite tools. */
export interface CompositeToolRuntime extends ToolRuntime {
  executeComposite(
    invocation: ToolInvocation,
    nested: NestedToolInvocationPort,
  ): Promise<ToolExecutionResult>;
}

/** Optional shared ownership, atomic publication, and prepared-call lease. */
export interface ToolBundle {
  readonly identity: ToolBundleIdentity;
  readonly tools: readonly ToolRuntime[];
  retainPreparedInvocation?(): () => void;
}

export interface NestedToolInvocationPort {
  invoke(
    name: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
    observation?: Promise<NestedToolObservation>,
  ): Promise<ToolExecutionResult>;
}

export type NestedToolObservation = "observed" | "unawaited";

export class UnawaitedNestedToolCallError extends Error {
  constructor() {
    super(
      "Tool call was abandoned because run_code returned without awaiting it.",
    );
    this.name = "UnawaitedNestedToolCallError";
  }
}

export type ToolPolicy = "full_access" | "ask_unknown";
export type StoredToolPolicyDecision = "approved" | "denied";

/** Host-owned persistence port for stable tool-name admission decisions. */
export interface ToolPolicyStore {
  get(toolName: string): Promise<StoredToolPolicyDecision | undefined>;
  set(toolName: string, decision: StoredToolPolicyDecision): Promise<void>;
}

export class InMemoryToolPolicyStore implements ToolPolicyStore {
  readonly #decisions = new Map<string, StoredToolPolicyDecision>();

  constructor(
    initial: Readonly<Record<string, StoredToolPolicyDecision>> = {},
  ) {
    for (const [toolName, decision] of Object.entries(initial)) {
      this.#decisions.set(toolName, decision);
    }
  }

  async get(toolName: string): Promise<StoredToolPolicyDecision | undefined> {
    return this.#decisions.get(toolName);
  }

  async set(
    toolName: string,
    decision: StoredToolPolicyDecision,
  ): Promise<void> {
    this.#decisions.set(toolName, decision);
  }
}

export class SetToolPolicyStore implements ToolPolicyStore {
  readonly #approvedTools: Set<string>;
  readonly #deniedTools: Set<string>;

  constructor(options: {
    approvedTools: Set<string>;
    deniedTools: Set<string>;
  }) {
    this.#approvedTools = options.approvedTools;
    this.#deniedTools = options.deniedTools;
  }

  async get(toolName: string): Promise<StoredToolPolicyDecision | undefined> {
    if (this.#approvedTools.has(toolName)) return "approved";
    if (this.#deniedTools.has(toolName)) return "denied";
    return undefined;
  }

  async set(
    toolName: string,
    decision: StoredToolPolicyDecision,
  ): Promise<void> {
    if (decision === "approved") {
      this.#deniedTools.delete(toolName);
      this.#approvedTools.add(toolName);
    } else {
      this.#approvedTools.delete(toolName);
      this.#deniedTools.add(toolName);
    }
  }
}

export interface PreparedToolInvocation {
  readonly owner: ToolBundleIdentity;
  readonly definition: ModelTool;
  readonly invocation: ToolInvocation;
  readonly executionMode: ToolExecutionMode;
}

export interface ToolAdmissionOptions {
  policy: ToolPolicy;
  approvalRequest: ApprovalRequest;
  requestApproval?: ApprovalHandler;
}

interface RuntimeRegistration {
  runtime: ToolRuntime;
  definition: ModelTool;
}

interface BundleRegistration {
  identity: ToolBundleIdentity;
  bundle: ToolBundle;
  runtimes: readonly RuntimeRegistration[];
}

export interface StagedToolBundleRegistration {
  /** Publishes a fully validated bundle by in-memory map replacement only. */
  publish(): () => void;
  rollback(): void;
}

export interface ToolDefinitionEntry {
  owner: ToolBundleIdentity;
  definition: ModelTool;
}

interface PreparedRuntimeRegistration {
  runtime: ToolRuntime;
  release: (() => void) | undefined;
  released: boolean;
}

/**
 * Dynamic exact-name runtime registry and invocation boundary. Preparing
 * captures the exact runtime so later bundle changes affect only future calls.
 */
export class ToolEnvironment {
  readonly #bundles = new Map<string, BundleRegistration>();
  readonly #tools = new Map<string, BundleRegistration & RuntimeRegistration>();
  readonly #reservedBundleKeys = new Set<string>();
  readonly #reservedToolNames = new Set<string>();
  readonly #preparedRuntimes = new WeakMap<
    PreparedToolInvocation,
    PreparedRuntimeRegistration
  >();
  readonly #policyStore: ToolPolicyStore;
  readonly #pendingAdmissions = new Map<string, Promise<void>>();

  constructor(
    options: {
      runtimes?: readonly ToolRuntime[];
      bundles?: readonly ToolBundle[];
      policyStore?: ToolPolicyStore;
      approvedTools?: Set<string>;
      deniedTools?: Set<string>;
    } = {},
  ) {
    if (
      options.policyStore !== undefined &&
      (options.approvedTools !== undefined || options.deniedTools !== undefined)
    ) {
      throw new Error(
        "Provide policyStore or approvedTools/deniedTools, not both",
      );
    }
    this.#policyStore =
      options.policyStore ??
      (options.approvedTools !== undefined || options.deniedTools !== undefined
        ? new SetToolPolicyStore({
            approvedTools: options.approvedTools ?? new Set<string>(),
            deniedTools: options.deniedTools ?? new Set<string>(),
          })
        : new InMemoryToolPolicyStore());
    for (const runtime of options.runtimes ?? []) {
      this.registerRuntime(runtime);
    }
    for (const bundle of options.bundles ?? []) {
      this.registerBundle(bundle);
    }
  }

  get definitions(): ModelTool[] {
    return [...this.#bundles.values()].flatMap((registration) =>
      registration.runtimes.map(({ definition }) =>
        structuredClone(definition),
      ),
    );
  }

  /** Fresh owner-aware definitions for request-time capability projection. */
  get definitionEntries(): ToolDefinitionEntry[] {
    return [...this.#bundles.values()].flatMap((registration) =>
      registration.runtimes.map(({ definition }) => ({
        owner: { ...registration.identity },
        definition: structuredClone(definition),
      })),
    );
  }

  registerBundle(bundle: ToolBundle): () => void {
    return this.stageBundle(bundle).publish();
  }

  /** Registers one independently owned runtime without a caller-visible bundle. */
  registerRuntime(
    runtime: ToolRuntime,
    owner: ToolBundleIdentity = { kind: "builtin", id: runtime.name },
  ): () => void {
    return this.registerBundle({ identity: owner, tools: [runtime] });
  }

  stageBundle(
    bundle: ToolBundle,
    options: { replaceCurrent?: boolean } = {},
  ): StagedToolBundleRegistration {
    const identity = Object.freeze({ ...bundle.identity });
    const key = bundleIdentityKey(identity);
    if (
      this.#reservedBundleKeys.has(key) ||
      (this.#bundles.has(key) && !options.replaceCurrent)
    ) {
      throw new Error(`Tool bundle is already registered: ${key}`);
    }
    const runtimes = bundle.tools.map((runtime) => {
      const definition = structuredClone(runtime.specification);
      if (runtime.name.length === 0 || definition.name.length === 0) {
        throw new Error(`Tool bundle ${key} has an empty tool name`);
      }
      if (definition.name !== runtime.name) {
        throw new Error(
          `Tool runtime ${runtime.name} specification name must match exactly`,
        );
      }
      return { runtime, definition };
    });
    const localNames = new Set<string>();
    for (const { runtime } of runtimes) {
      if (localNames.has(runtime.name)) {
        throw new Error(
          `Tool bundle ${key} defines ${runtime.name} more than once`,
        );
      }
      const current = this.#tools.get(runtime.name);
      if (
        this.#reservedToolNames.has(runtime.name) ||
        (current !== undefined &&
          (!options.replaceCurrent ||
            bundleIdentityKey(current.identity) !== key))
      ) {
        throw new Error(`Tool is already registered: ${runtime.name}`);
      }
      localNames.add(runtime.name);
    }
    const registration = { identity, bundle, runtimes };
    this.#reservedBundleKeys.add(key);
    for (const { runtime } of runtimes)
      this.#reservedToolNames.add(runtime.name);
    let state: "staged" | "published" | "rolled-back" = "staged";
    const releaseReservation = (): void => {
      this.#reservedBundleKeys.delete(key);
      for (const { runtime } of runtimes)
        this.#reservedToolNames.delete(runtime.name);
    };
    return {
      publish: () => {
        if (state === "published") {
          return () => this.#unregisterRegistration(key, registration);
        }
        if (state === "rolled-back") return () => {};
        state = "published";
        releaseReservation();
        const current = this.#bundles.get(key);
        if (current !== undefined) this.#unregisterRegistration(key, current);
        this.#bundles.set(key, registration);
        for (const runtime of runtimes)
          this.#tools.set(runtime.runtime.name, {
            ...registration,
            ...runtime,
          });
        return () => this.#unregisterRegistration(key, registration);
      },
      rollback: () => {
        if (state !== "staged") return;
        state = "rolled-back";
        releaseReservation();
      },
    };
  }

  unregisterBundle(identity: ToolBundleIdentity): boolean {
    const key = bundleIdentityKey(identity);
    const registration = this.#bundles.get(key);
    if (registration === undefined) return false;
    return this.#unregisterRegistration(key, registration);
  }

  #unregisterRegistration(
    key: string,
    registration: BundleRegistration,
  ): boolean {
    if (this.#bundles.get(key) !== registration) return false;
    this.#bundles.delete(key);
    for (const { runtime } of registration.runtimes) {
      if (this.#tools.get(runtime.name)?.bundle === registration.bundle) {
        this.#tools.delete(runtime.name);
      }
    }
    return true;
  }

  prepare(invocation: ToolInvocation): PreparedToolInvocation {
    const registration = this.#tools.get(invocation.name);
    if (registration === undefined) {
      throw new Error(`Unsupported tool: ${invocation.name}`);
    }
    const prepared: PreparedToolInvocation = Object.freeze({
      owner: registration.identity,
      definition: structuredClone(registration.definition),
      executionMode: executionModeFor(registration.runtime),
      invocation: Object.freeze({
        ...invocation,
        arguments: Object.freeze(structuredClone(invocation.arguments)),
      }),
    });
    this.#preparedRuntimes.set(prepared, {
      runtime: registration.runtime,
      release: registration.bundle.retainPreparedInvocation?.(),
      released: false,
    });
    return prepared;
  }

  async admit(
    prepared: PreparedToolInvocation,
    options: ToolAdmissionOptions,
  ): Promise<ApprovalDecision> {
    this.#requirePrepared(prepared);
    if (options.policy === "full_access") return "accept";

    const toolName = prepared.invocation.name;
    try {
      for (;;) {
        const stored = await this.#policyStore.get(toolName);
        if (stored === "approved") return "accept";
        if (stored === "denied") {
          this.#releasePrepared(prepared);
          return "decline";
        }
        const pending = this.#pendingAdmissions.get(toolName);
        if (pending !== undefined) {
          await waitForToolAbort(pending, prepared.invocation.signal);
          continue;
        }
        if (options.requestApproval === undefined) {
          throw new Error(
            "Approval is required, but this client cannot answer approval requests",
          );
        }

        let release!: () => void;
        const admission = new Promise<void>((resolve) => {
          release = resolve;
        });
        this.#pendingAdmissions.set(toolName, admission);
        try {
          const decision = await waitForToolAbort(
            options.requestApproval(options.approvalRequest),
            prepared.invocation.signal,
          );
          if (decision === "accept") {
            await this.#policyStore.set(toolName, "approved");
          } else if (decision === "decline") {
            await this.#policyStore.set(toolName, "denied");
          }
          if (decision === "decline" || decision === "cancel") {
            this.#releasePrepared(prepared);
          }
          return decision;
        } finally {
          if (this.#pendingAdmissions.get(toolName) === admission) {
            this.#pendingAdmissions.delete(toolName);
          }
          release();
        }
      }
    } catch (error) {
      this.#releasePrepared(prepared);
      throw error;
    }
  }

  /** Inherited child admission: remembered deny wins; unknown never prompts. */
  async admitInherited(
    prepared: PreparedToolInvocation,
  ): Promise<ApprovalDecision> {
    this.#requirePrepared(prepared);
    try {
      const stored = await this.#policyStore.get(prepared.invocation.name);
      if (stored === "denied") {
        this.#releasePrepared(prepared);
        return "decline";
      }
      return "accept";
    } catch (error) {
      this.#releasePrepared(prepared);
      throw error;
    }
  }

  async execute(
    prepared: PreparedToolInvocation,
    nested?: NestedToolInvocationPort,
  ): Promise<ToolExecutionResult> {
    const runtime = this.#requirePrepared(prepared).runtime;
    try {
      prepared.invocation.signal.throwIfAborted();
      const result =
        nested !== undefined &&
        prepared.owner.kind === "builtin" &&
        isCompositeToolRuntime(runtime)
          ? await runtime.executeComposite(prepared.invocation, nested)
          : await runtime.execute(prepared.invocation);
      try {
        return normalizeToolExecutionResult(result, prepared.owner);
      } catch (error) {
        throw new ToolResultNormalizationError(error);
      }
    } finally {
      this.#releasePrepared(prepared);
    }
  }

  #requirePrepared(
    prepared: PreparedToolInvocation,
  ): PreparedRuntimeRegistration {
    const registration = this.#preparedRuntimes.get(prepared);
    if (registration === undefined) {
      throw new Error("Tool invocation was not prepared by this environment");
    }
    return registration;
  }

  #releasePrepared(prepared: PreparedToolInvocation): void {
    const registration = this.#preparedRuntimes.get(prepared);
    if (registration === undefined || registration.released) return;
    registration.released = true;
    this.#preparedRuntimes.delete(prepared);
    registration.release?.();
  }
}

function executionModeFor(runtime: ToolRuntime): ToolExecutionMode {
  if (runtime.name === "shell") return "exclusive";
  return runtime.executionMode === "parallel_safe"
    ? "parallel_safe"
    : "exclusive";
}

function isCompositeToolRuntime(
  runtime: ToolRuntime,
): runtime is CompositeToolRuntime {
  return (
    "executeComposite" in runtime &&
    typeof runtime.executeComposite === "function"
  );
}

export class ToolResultNormalizationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ToolResultNormalizationError";
  }
}

export function normalizeToolExecutionResult(
  result: ToolExecutionResult,
  owner: ToolBundleIdentity,
): ToolExecutionResult {
  if (
    typeof result.output !== "string" ||
    !Number.isSafeInteger(result.exitCode) ||
    (result.sourceTruncated !== undefined &&
      typeof result.sourceTruncated !== "boolean")
  ) {
    throw new Error("Tool returned an invalid output or exit code");
  }
  const hasContentType = result.contentType !== undefined;
  const hasStructuredContent = result.structuredContent !== undefined;
  if (hasContentType !== hasStructuredContent) {
    throw new Error(
      "Structured tool results require both contentType and structuredContent",
    );
  }
  if (!hasContentType || !hasStructuredContent) return result;
  const contentType = result.contentType!;
  if (!/^[a-z][a-z0-9-]{1,62}\/[a-z][a-z0-9.-]{0,127}$/u.test(contentType)) {
    throw new Error(`Invalid structured result contentType: ${contentType}`);
  }
  if (owner.kind === "plugin" && !contentType.startsWith(`${owner.id}/`)) {
    throw new Error(
      `Plugin ${owner.id} does not own structured result contentType ${contentType}`,
    );
  }
  assertJsonValue(result.structuredContent, "$structuredContent");
  const encoded = JSON.stringify(result.structuredContent);
  if (Buffer.byteLength(encoded, "utf8") > MAX_STRUCTURED_TOOL_RESULT_BYTES) {
    throw new Error(
      `Structured tool result exceeded its ${String(MAX_STRUCTURED_TOOL_RESULT_BYTES)} byte limit`,
    );
  }
  return {
    output: result.output,
    exitCode: result.exitCode,
    contentType,
    structuredContent: deepFreeze(structuredClone(result.structuredContent)),
    ...(result[TOOL_OUTPUT_CAPTURE] === undefined
      ? {}
      : { [TOOL_OUTPUT_CAPTURE]: result[TOOL_OUTPUT_CAPTURE] }),
    ...(result.sourceTruncated === undefined
      ? {}
      : { sourceTruncated: result.sourceTruncated }),
  };
}

function assertJsonValue(
  value: unknown,
  path: string,
  seen = new Set<object>(),
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(
      `Structured tool result contains a non-finite number at ${path}`,
    );
  }
  if (typeof value !== "object") {
    throw new Error(`Structured tool result is not JSON-compatible at ${path}`);
  }
  if (seen.has(value))
    throw new Error(`Structured tool result is cyclic at ${path}`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value))
        throw new Error(
          `Structured tool result contains a sparse array at ${path}`,
        );
      assertJsonValue(value[index], `${path}[${String(index)}]`, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(
        `Structured tool result contains a non-JSON object at ${path}`,
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(
        `Structured tool result contains a symbol-keyed value at ${path}`,
      );
    }
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(entry, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function deepFreeze<T extends JsonValue>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const entry of Array.isArray(value) ? value : Object.values(value))
    deepFreeze(entry);
  return Object.freeze(value);
}

export interface ApprovalRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  callId: string;
  command: string;
  toolName?: string;
  toolArguments?: Readonly<Record<string, unknown>>;
  cwd: string;
  signal: AbortSignal;
}

export type ApprovalHandler = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision>;

export class ShellToolRuntime implements ToolRuntime {
  readonly name = "shell";
  readonly specification: ModelTool = {
    name: this.name,
    description: "Run a shell command in the thread working directory.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  };

  readonly #maxOutputBytes: number;
  readonly #redactedValues: readonly string[];
  readonly #terminationGraceMs: number;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #toolOutputSpool: ToolOutputSpool | undefined;

  constructor(
    options: {
      maxOutputBytes?: number;
      terminationGraceMs?: number;
      environment?: Readonly<NodeJS.ProcessEnv>;
      blockedEnvironmentVariables?: readonly string[];
      redactedValues?: readonly string[];
      toolOutputSpool?: ToolOutputSpool;
    } = {},
  ) {
    const sourceEnvironment = options.environment ?? process.env;
    const blockedEnvironmentVariables =
      options.blockedEnvironmentVariables ?? [];
    this.#maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_TOOL_OUTPUT_CAPTURE_BYTES;
    this.#redactedValues = Object.freeze(
      [
        ...(options.redactedValues ?? []),
        ...blockedEnvironmentVariables.map(
          (name) => sourceEnvironment[name] ?? "",
        ),
      ].filter((value, index, values) => {
        return value.length > 0 && values.indexOf(value) === index;
      }),
    );
    this.#terminationGraceMs = options.terminationGraceMs ?? 250;
    this.#toolOutputSpool = options.toolOutputSpool;
    this.#environment = Object.freeze(
      sanitizeToolEnvironment(sourceEnvironment, blockedEnvironmentVariables),
    );
  }

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    if (invocation.name !== "shell") {
      throw new Error(`Unsupported tool: ${invocation.name}`);
    }
    const command = invocation.arguments.command;
    if (typeof command !== "string" || command.length === 0) {
      throw new Error("shell.command must be a non-empty string");
    }
    invocation.signal.throwIfAborted();

    return await new Promise<ToolExecutionResult>((resolve, reject) => {
      const child = spawn(command, {
        cwd: invocation.cwd,
        env: this.#environment,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      const capture = this.#toolOutputSpool?.beginCapture({
        redactedValues: this.#redactedValues,
        maxCaptureBytes: this.#maxOutputBytes,
      });
      const stdoutDecoder =
        capture === undefined ? undefined : new StringDecoder("utf8");
      const stderrDecoder =
        capture === undefined ? undefined : new StringDecoder("utf8");
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let terminationStarted = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const collect = (chunk: Buffer, decoder?: StringDecoder): void => {
        if (capture !== undefined) {
          capture.write(decoder!.write(chunk));
          return;
        }
        if (bytes >= this.#maxOutputBytes) {
          return;
        }
        const remaining = this.#maxOutputBytes - bytes;
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        bytes += kept.length;
      };
      child.stdout.on("data", (chunk: Buffer) => collect(chunk, stdoutDecoder));
      child.stderr.on("data", (chunk: Buffer) => collect(chunk, stderrDecoder));

      const killProcessTree = (signal: NodeJS.Signals): void => {
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // The process group may already have exited. Fall back to the
            // direct child so a spawn race cannot leave it running.
          }
        }
        try {
          child.kill(signal);
        } catch {
          // A concurrent exit is indistinguishable from successful cleanup.
        }
      };
      const abort = (): void => {
        if (terminationStarted) {
          return;
        }
        terminationStarted = true;
        killProcessTree("SIGTERM");
        forceKillTimer = setTimeout(() => {
          killProcessTree("SIGKILL");
          // A descendant can outlive the wrapper while retaining these file
          // descriptors. Closing our ends guarantees the invocation itself
          // cannot wait forever after the forced termination deadline.
          child.stdout.destroy();
          child.stderr.destroy();
          forceKillTimer = undefined;
          finishWithError(abortReason(invocation.signal));
        }, this.#terminationGraceMs);
      };
      const cleanup = (): void => {
        invocation.signal.removeEventListener("abort", abort);
        // Keep the forced group kill scheduled after an abort even if the
        // wrapper shell closes first; a descendant may have redirected its
        // stdio and still be alive in the same process group.
        if (!terminationStarted && forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
        }
      };
      const finishWithError = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        void capture?.discard();
        reject(error);
      };
      invocation.signal.addEventListener("abort", abort, { once: true });
      if (invocation.signal.aborted) {
        abort();
      }

      child.once("error", (error) => {
        finishWithError(error);
      });
      child.once("close", (code, signal) => {
        if (settled) {
          return;
        }
        if (invocation.signal.aborted) {
          if (forceKillTimer !== undefined) {
            clearTimeout(forceKillTimer);
            forceKillTimer = undefined;
          }
          // `close` proves the wrapper and inherited pipes are gone, but a
          // descendant with redirected stdio may still occupy the group.
          killProcessTree("SIGKILL");
          finishWithError(abortReason(invocation.signal));
          return;
        }
        settled = true;
        cleanup();
        if (capture !== undefined) {
          capture.write(stdoutDecoder!.end());
          capture.write(stderrDecoder!.end());
          if (signal !== null) capture.write(`\n[terminated by ${signal}]`);
          void capture
            .finish()
            .then((outputCapture) => {
              resolve({
                output: outputCapture.output ?? "",
                [TOOL_OUTPUT_CAPTURE]: outputCapture,
                exitCode: code ?? 128,
              });
            })
            .catch((error: unknown) => reject(error));
          return;
        }
        const suffix =
          bytes >= this.#maxOutputBytes ? "\n[output truncated by Zen]" : "";
        const output = redactValues(
          `${Buffer.concat(chunks).toString("utf8")}${suffix}`,
          this.#redactedValues,
        );
        resolve({
          output:
            signal === null ? output : `${output}\n[terminated by ${signal}]`,
          exitCode: code ?? 128,
        });
      });
    });
  }
}

export function capturedToolOutput(
  result: ToolExecutionResult,
): ToolOutputCaptureMetadata | undefined {
  return result[TOOL_OUTPUT_CAPTURE];
}

function bundleIdentityKey(identity: ToolBundleIdentity): string {
  if (identity.id.trim().length === 0) {
    throw new Error("Tool bundle id must not be empty");
  }
  return `${identity.kind}:${identity.id}`;
}

async function waitForToolAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}

function redactValues(output: string, values: readonly string[]): string {
  let redacted = output;
  for (const value of values) {
    redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  return redacted;
}

const SAFE_ENVIRONMENT_VARIABLES = new Set([
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "WINDIR",
]);

/**
 * Shell tools get a deliberately small process environment. Provider keys and
 * unrelated host configuration must never become implicit model-visible input.
 */
export function sanitizeToolEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  blockedEnvironmentVariables: readonly string[] = [],
): NodeJS.ProcessEnv {
  const blocked = new Set(blockedEnvironmentVariables);
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      !blocked.has(name) &&
      (SAFE_ENVIRONMENT_VARIABLES.has(name) || name.startsWith("LC_"))
    ) {
      environment[name] = value;
    }
  }
  return environment;
}
