import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import {
  validateUserInput,
  type ApprovalDecision,
  type JsonValue,
  type UserInput,
} from "./item.js";
import type { ModelTool } from "./model.js";
import {
  DEFAULT_TOOL_OUTPUT_CAPTURE_BYTES,
  type ToolOutputCaptureMetadata,
  type ToolOutputSpool,
} from "./tool-output-spool.js";

const TOOL_OUTPUT_CAPTURE = Symbol("tool-output-capture");
const TOOL_OUTPUT_SUFFIX = Symbol("tool-output-suffix");

export interface ToolInvocation {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  cwd: string;
  signal: AbortSignal;
  threadId?: string;
}

export interface ToolExecutionResult {
  output: string;
  exitCode: number;
  contentType?: string;
  structuredContent?: JsonValue;
  /** Content a trusted builtin asks Zen to include in the next model sample. */
  modelContent?: UserInput;
  /** Host-local capture state; AgentRuntime renders it before canonical append. */
  [TOOL_OUTPUT_CAPTURE]?: ToolOutputCaptureMetadata;
  /** Bounded builtin control text appended after any rendered capture receipt. */
  [TOOL_OUTPUT_SUFFIX]?: string;
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
  /** Known model modalities required before this tool body may execute. */
  readonly requiredModelInputModalities?: readonly string[];
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
  readonly requiredModelInputModalities: readonly string[];
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
      requiredModelInputModalities: Object.freeze([
        ...(registration.runtime.requiredModelInputModalities ?? []),
      ]),
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
    modelInputModalities?: readonly string[] | null,
  ): Promise<ToolExecutionResult> {
    const runtime = this.#requirePrepared(prepared).runtime;
    try {
      prepared.invocation.signal.throwIfAborted();
      if (
        modelInputModalities !== undefined &&
        modelInputModalities !== null &&
        prepared.requiredModelInputModalities.some(
          (modality) => !modelInputModalities.includes(modality),
        )
      ) {
        throw new Error(
          `The selected model does not support ${prepared.requiredModelInputModalities.join(
            ", ",
          )} input required by ${prepared.invocation.name}`,
        );
      }
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
  if (result.modelContent !== undefined) {
    if (owner.kind !== "builtin") {
      throw new Error("Only builtin tools may return model content");
    }
    validateUserInput(result.modelContent, "$modelContent");
  }
  if (!hasContentType || !hasStructuredContent) {
    return result.modelContent === undefined
      ? result
      : {
          output: result.output,
          exitCode: result.exitCode,
          modelContent: Object.freeze(
            structuredClone(result.modelContent),
          ) as UserInput,
          ...(result[TOOL_OUTPUT_CAPTURE] === undefined
            ? {}
            : { [TOOL_OUTPUT_CAPTURE]: result[TOOL_OUTPUT_CAPTURE] }),
          ...(result.sourceTruncated === undefined
            ? {}
            : { sourceTruncated: result.sourceTruncated }),
        };
  }
  const contentType = result.contentType!;
  if (!/^[a-z][a-z0-9-]{1,62}\/[a-z][a-z0-9.+-]{0,127}$/u.test(contentType)) {
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
    ...(result.modelContent === undefined
      ? {}
      : {
          modelContent: Object.freeze(
            structuredClone(result.modelContent),
          ) as UserInput,
        }),
    ...(result[TOOL_OUTPUT_CAPTURE] === undefined
      ? {}
      : { [TOOL_OUTPUT_CAPTURE]: result[TOOL_OUTPUT_CAPTURE] }),
    ...(result[TOOL_OUTPUT_SUFFIX] === undefined
      ? {}
      : { [TOOL_OUTPUT_SUFFIX]: result[TOOL_OUTPUT_SUFFIX] }),
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
    description:
      "Run a shell command in the thread working directory. Long-running commands return a host-local session_id for shell_wait.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        yield_time_ms: {
          type: "integer",
          description:
            "Milliseconds to wait before yielding a running session.",
          minimum: 1,
          maximum: 60000,
        },
        timeout_ms: {
          type: "integer",
          description:
            "Hard command deadline in milliseconds (maximum 24 hours).",
          minimum: 1,
          maximum: 86400000,
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  };

  readonly #maxOutputBytes: number;
  readonly #initialYieldMs: number;
  readonly #defaultTimeoutMs: number;
  readonly #terminationGraceMs: number;
  readonly #completedSessionRetentionMs: number;
  readonly #maxSessions: number;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #toolOutputSpool: ToolOutputSpool | undefined;
  readonly #sessions = new Map<string, ShellSession>();
  readonly waitRuntime: ShellWaitToolRuntime;
  #closed = false;

  constructor(
    options: {
      maxOutputBytes?: number;
      initialYieldMs?: number;
      defaultTimeoutMs?: number;
      terminationGraceMs?: number;
      completedSessionRetentionMs?: number;
      maxSessions?: number;
      environment?: Readonly<NodeJS.ProcessEnv>;
      blockedEnvironmentVariables?: readonly string[];
      toolOutputSpool?: ToolOutputSpool;
    } = {},
  ) {
    const sourceEnvironment = options.environment ?? process.env;
    const blockedEnvironmentVariables =
      options.blockedEnvironmentVariables ?? [];
    this.#maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_TOOL_OUTPUT_CAPTURE_BYTES;
    this.#initialYieldMs = boundedInteger(
      options.initialYieldMs ?? 10_000,
      "Shell initial yield",
      1,
      60_000,
    );
    this.#defaultTimeoutMs = boundedInteger(
      options.defaultTimeoutMs ?? 10 * 60_000,
      "Shell timeout",
      1,
      24 * 60 * 60_000,
    );
    this.#terminationGraceMs = options.terminationGraceMs ?? 250;
    this.#completedSessionRetentionMs =
      options.completedSessionRetentionMs ?? 5 * 60_000;
    this.#maxSessions = boundedInteger(
      options.maxSessions ?? 64,
      "Shell session limit",
      1,
      1_024,
    );
    this.#toolOutputSpool = options.toolOutputSpool;
    this.#environment = Object.freeze(
      sanitizeToolEnvironment(sourceEnvironment, blockedEnvironmentVariables),
    );
    this.waitRuntime = new ShellWaitToolRuntime(this);
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
    if (this.#closed) throw new Error("Shell runtime is closed");
    if (this.#sessions.size >= this.#maxSessions) {
      throw new Error(
        `Shell session limit reached (${String(this.#maxSessions)}); wait for or terminate an existing session`,
      );
    }
    const threadId = invocation.threadId;
    const yieldTimeMs = optionalBoundedInteger(
      invocation.arguments.yield_time_ms,
      this.#initialYieldMs,
      "shell.yield_time_ms",
      1,
      60_000,
    );
    const timeoutMs = optionalBoundedInteger(
      invocation.arguments.timeout_ms,
      this.#defaultTimeoutMs,
      "shell.timeout_ms",
      1,
      24 * 60 * 60_000,
    );
    const session = new ShellSession({
      id: randomUUID(),
      threadId,
      command,
      cwd: invocation.cwd,
      environment: this.#environment,
      timeoutMs,
      maxOutputBytes: this.#maxOutputBytes,
      terminationGraceMs: this.#terminationGraceMs,
      completedSessionRetentionMs: this.#completedSessionRetentionMs,
      toolOutputSpool: this.#toolOutputSpool,
      onExpired: (id) => this.#sessions.delete(id),
    });
    this.#sessions.set(session.id, session);
    const result = await session.initialResult(yieldTimeMs, invocation.signal);
    if (session.final) {
      session.consume();
      this.#sessions.delete(session.id);
    } else if (threadId === undefined) {
      const unscoped = await session.wait(yieldTimeMs, invocation.signal, true);
      session.consume();
      this.#sessions.delete(session.id);
      return {
        ...unscoped,
        output: `${result.output}\n${unscoped.output}\n[long-running shell commands require a thread id]`,
        exitCode: 1,
      };
    }
    return result;
  }

  async wait(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    if (invocation.name !== "shell_wait") {
      throw new Error(`Unsupported tool: ${invocation.name}`);
    }
    const id = invocation.arguments.session_id;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("shell_wait.session_id must be a non-empty string");
    }
    const session = this.#sessions.get(id);
    if (
      session === undefined ||
      invocation.threadId === undefined ||
      session.threadId !== invocation.threadId
    ) {
      throw new Error("Shell session not found for this thread");
    }
    const yieldTimeMs = optionalBoundedInteger(
      invocation.arguments.yield_time_ms,
      this.#initialYieldMs,
      "shell_wait.yield_time_ms",
      1,
      60_000,
    );
    const terminate = invocation.arguments.terminate ?? false;
    if (typeof terminate !== "boolean") {
      throw new Error("shell_wait.terminate must be a boolean");
    }
    const result = await session.wait(
      yieldTimeMs,
      invocation.signal,
      terminate,
    );
    if (session.final) {
      session.consume();
      this.#sessions.delete(id);
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled(
      [...this.#sessions.values()].map(
        async (session) => await session.close(),
      ),
    );
    this.#sessions.clear();
  }
}

export class ShellWaitToolRuntime implements ToolRuntime {
  readonly name = "shell_wait";
  readonly specification: ModelTool = {
    name: this.name,
    description:
      "Wait for new output or completion from a shell session. Use terminate: true to stop that session. Running status is explicit in structuredContent; wait again only when the command's progress is needed.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        yield_time_ms: {
          type: "integer",
          minimum: 1,
          maximum: 60000,
        },
        terminate: { type: "boolean" },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  };

  readonly #shell: ShellToolRuntime;

  constructor(shell: ShellToolRuntime) {
    this.#shell = shell;
  }

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    return await this.#shell.wait(invocation);
  }
}

type ShellFinalReason = "completed" | "timeout" | "interrupted" | "terminated";

interface ShellFinalState {
  reason: ShellFinalReason;
  exitCode: number;
  signal: NodeJS.Signals | null;
}

class ShellSession {
  readonly id: string;
  readonly threadId: string | undefined;
  readonly #timeoutMs: number;
  readonly #terminationGraceMs: number;
  readonly #completedSessionRetentionMs: number;
  readonly #maxOutputBytes: number;
  readonly #toolOutputSpool: ToolOutputSpool | undefined;
  readonly #onExpired: (id: string) => void;
  readonly #child: ChildProcessByStdio<null, Readable, Readable>;
  readonly #stdoutDecoder = new StringDecoder("utf8");
  readonly #stderrDecoder = new StringDecoder("utf8");
  readonly #listeners = new Set<() => void>();
  #window: ShellOutputWindow;
  #final: ShellFinalState | undefined;
  #terminationReason: Exclude<ShellFinalReason, "completed"> | undefined;
  #hardTimeout: NodeJS.Timeout | undefined;
  #forceKillTimer: NodeJS.Timeout | undefined;
  #expiryTimer: NodeJS.Timeout | undefined;
  #originSignal: AbortSignal | undefined;
  #originAbort: (() => void) | undefined;

  get final(): boolean {
    return this.#final !== undefined;
  }

  constructor(options: {
    id: string;
    threadId: string | undefined;
    command: string;
    cwd: string;
    environment: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
    terminationGraceMs: number;
    completedSessionRetentionMs: number;
    toolOutputSpool: ToolOutputSpool | undefined;
    onExpired(id: string): void;
  }) {
    this.id = options.id;
    this.threadId = options.threadId;
    this.#timeoutMs = options.timeoutMs;
    this.#maxOutputBytes = options.maxOutputBytes;
    this.#terminationGraceMs = options.terminationGraceMs;
    this.#completedSessionRetentionMs = options.completedSessionRetentionMs;
    this.#toolOutputSpool = options.toolOutputSpool;
    this.#onExpired = options.onExpired;
    this.#window = this.#newWindow();
    this.#child = spawn(options.command, {
      cwd: options.cwd,
      env: options.environment,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.#child.stdout.on("data", (chunk: Buffer) => {
      this.#window.write(this.#stdoutDecoder.write(chunk));
      this.#notify();
    });
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#window.write(this.#stderrDecoder.write(chunk));
      this.#notify();
    });
    this.#child.once("error", (error) => {
      this.#window.write(`\n[shell spawn failed: ${error.message}]`);
      this.#finish({ reason: "completed", exitCode: 1, signal: null });
    });
    this.#child.once("close", (code, signal) => {
      this.#window.write(this.#stdoutDecoder.end());
      this.#window.write(this.#stderrDecoder.end());
      const reason = this.#terminationReason ?? "completed";
      // TERM can close the wrapper while a redirected descendant remains in
      // the owned group. Do not cancel the final group kill in that state.
      if (this.#terminationReason !== undefined)
        this.#killProcessTree("SIGKILL");
      this.#finish({
        reason,
        exitCode:
          reason === "timeout"
            ? 124
            : reason === "interrupted" || reason === "terminated"
              ? 130
              : (code ?? 128),
        signal,
      });
    });
    this.#hardTimeout = setTimeout(() => {
      this.#terminate("timeout");
    }, this.#timeoutMs);
    this.#hardTimeout.unref();
  }

  async initialResult(
    yieldTimeMs: number,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    this.#originSignal = signal;
    this.#originAbort = () => this.#terminate("interrupted");
    signal.addEventListener("abort", this.#originAbort, { once: true });
    await this.#waitForChange(yieldTimeMs, signal, false, false);
    if (this.#final === undefined) {
      return await this.#drain("running");
    }
    return await this.#drain(
      this.#final.reason === "completed" ? "quiet-final" : "final",
    );
  }

  async wait(
    yieldTimeMs: number,
    signal: AbortSignal,
    terminate: boolean,
  ): Promise<ToolExecutionResult> {
    if (terminate && this.#final === undefined) this.#terminate("terminated");
    await this.#waitForChange(yieldTimeMs, signal, true, terminate);
    if (this.#final === undefined) return await this.#drain("running");
    return await this.#drain("final");
  }

  consume(): void {
    if (this.#expiryTimer !== undefined) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.#final === undefined) this.#terminate("terminated");
    if (this.#final === undefined) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          if (this.#final === undefined) return;
          this.#listeners.delete(finish);
          resolve();
        };
        this.#listeners.add(finish);
      });
    }
    await this.#window.discard();
    if (this.#expiryTimer !== undefined) clearTimeout(this.#expiryTimer);
  }

  async #waitForChange(
    yieldTimeMs: number,
    signal: AbortSignal,
    returnOnOutput: boolean,
    terminationRequested: boolean,
  ): Promise<void> {
    if (signal.aborted && this.#final === undefined)
      this.#terminate("interrupted");
    if (
      this.#final !== undefined ||
      (returnOnOutput &&
        this.#window.hasOutput &&
        !terminationRequested &&
        this.#terminationReason === undefined)
    ) {
      return;
    }
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        if (this.#final === undefined) this.#terminate("interrupted");
        if (this.#final !== undefined) done();
      };
      const changed = () => {
        if (
          this.#final !== undefined ||
          (returnOnOutput &&
            !terminationRequested &&
            this.#terminationReason === undefined &&
            this.#window.hasOutput)
        ) {
          done();
        }
      };
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.#listeners.delete(changed);
      };
      this.#listeners.add(changed);
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(done, yieldTimeMs);
      if (this.#final !== undefined) done();
    });
  }

  #terminate(reason: Exclude<ShellFinalReason, "completed">): void {
    if (this.#final !== undefined || this.#terminationReason !== undefined)
      return;
    this.#terminationReason = reason;
    this.#killProcessTree("SIGTERM");
    this.#forceKillTimer = setTimeout(() => {
      this.#killProcessTree("SIGKILL");
      this.#child.stdout.destroy();
      this.#child.stderr.destroy();
      this.#finish({
        reason,
        exitCode: reason === "timeout" ? 124 : 130,
        signal: "SIGKILL",
      });
    }, this.#terminationGraceMs);
  }

  #killProcessTree(signal: NodeJS.Signals): void {
    if (process.platform !== "win32" && this.#child.pid !== undefined) {
      try {
        process.kill(-this.#child.pid, signal);
        return;
      } catch {
        // The group may have exited between observation and termination.
      }
    }
    try {
      this.#child.kill(signal);
    } catch {
      // A concurrent exit is equivalent to successful cleanup.
    }
  }

  #finish(final: ShellFinalState): void {
    if (this.#final !== undefined) return;
    this.#final = final;
    if (this.#hardTimeout !== undefined) clearTimeout(this.#hardTimeout);
    if (this.#forceKillTimer !== undefined) clearTimeout(this.#forceKillTimer);
    if (this.#originSignal !== undefined && this.#originAbort !== undefined) {
      this.#originSignal.removeEventListener("abort", this.#originAbort);
    }
    this.#expiryTimer = setTimeout(() => {
      void this.#window.discard();
      this.#onExpired(this.id);
    }, this.#completedSessionRetentionMs);
    this.#expiryTimer.unref();
    this.#notify();
  }

  async #drain(
    kind: "running" | "quiet-final" | "final",
  ): Promise<ToolExecutionResult> {
    const final = this.#final;
    let control = "";
    if (kind === "running") {
      control = `${this.#window.hasOutput ? "\n" : ""}[command still running]\nsession_id: ${this.id}\ntimeout_ms: ${String(this.#timeoutMs)}`;
    } else if (kind === "final" && final !== undefined) {
      const status =
        final.reason === "timeout"
          ? `command timed out after ${String(this.#timeoutMs)} ms`
          : final.reason === "completed"
            ? "command completed"
            : final.reason === "terminated"
              ? "command terminated by shell_wait"
              : "command interrupted";
      control = `${this.#window.hasOutput ? "\n" : ""}[${status}]\nexit_code: ${String(final.exitCode)}`;
    }
    if (
      final?.signal !== null &&
      final?.signal !== undefined &&
      final.reason === "completed"
    ) {
      control += `\n[terminated by ${final.signal}]`;
    }
    const window = this.#window;
    if (final === undefined) this.#window = this.#newWindow();
    const capture = await window.finish();
    const status =
      final?.reason === "timeout"
        ? "timed_out"
        : final?.reason === "interrupted" || final?.reason === "terminated"
          ? "cancelled"
          : (final?.reason ?? "running");
    const sessionState =
      final === undefined
        ? {
            status,
            session_id: this.id,
            timeout_ms: this.#timeoutMs,
            exit_code: null,
          }
        : {
            status,
            session_id: this.id,
            exit_code: final.exitCode,
          };
    return {
      output:
        capture.metadata === undefined
          ? `${capture.output}${control}`
          : capture.output,
      ...(capture.metadata === undefined
        ? {}
        : {
            [TOOL_OUTPUT_CAPTURE]: capture.metadata,
            ...(control.length === 0 ? {} : { [TOOL_OUTPUT_SUFFIX]: control }),
          }),
      exitCode: final?.exitCode ?? 0,
      ...(kind === "quiet-final"
        ? {}
        : {
            contentType: "application/vnd.zen.shell-session+json",
            structuredContent: sessionState,
          }),
    };
  }

  #newWindow(): ShellOutputWindow {
    return new ShellOutputWindow(this.#maxOutputBytes, this.#toolOutputSpool);
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

class ShellOutputWindow {
  readonly #maxOutputBytes: number;
  readonly #capture: ReturnType<ToolOutputSpool["beginCapture"]> | undefined;
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  #truncated = false;
  hasOutput = false;

  constructor(maxOutputBytes: number, spool: ToolOutputSpool | undefined) {
    this.#maxOutputBytes = maxOutputBytes;
    this.#capture = spool?.beginCapture({ maxCaptureBytes: maxOutputBytes });
  }

  write(text: string): void {
    if (text.length === 0) return;
    this.hasOutput = true;
    if (this.#capture !== undefined) {
      this.#capture.write(text);
      return;
    }
    const encoded = Buffer.from(text, "utf8");
    const remaining = this.#maxOutputBytes - this.#bytes;
    if (remaining <= 0) {
      this.#truncated = true;
      return;
    }
    const kept = encoded.subarray(0, remaining);
    this.#chunks.push(kept);
    this.#bytes += kept.length;
    this.#truncated ||= kept.length < encoded.length;
  }

  async finish(): Promise<{
    output: string;
    metadata?: ToolOutputCaptureMetadata;
  }> {
    if (this.#capture !== undefined) {
      const metadata = await this.#capture.finish();
      return { output: metadata.output ?? "", metadata };
    }
    return {
      output: `${Buffer.concat(this.#chunks).toString("utf8")}${
        this.#truncated ? "\n[output truncated by Zen]" : ""
      }`,
    };
  }

  async discard(): Promise<void> {
    await this.#capture?.discard();
  }
}

function optionalBoundedInteger(
  value: unknown,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  return value === undefined
    ? fallback
    : boundedInteger(value, label, minimum, maximum);
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${label} must be an integer from ${String(minimum)} to ${String(maximum)}`,
    );
  }
  return value;
}

export function capturedToolOutput(
  result: ToolExecutionResult,
): ToolOutputCaptureMetadata | undefined {
  return result[TOOL_OUTPUT_CAPTURE];
}

export function toolOutputSuffix(
  result: ToolExecutionResult,
): string | undefined {
  return result[TOOL_OUTPUT_SUFFIX];
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
