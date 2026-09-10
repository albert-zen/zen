import {
  MAX_TOOL_YIELD_TIME_MS,
  ToolTaskManager,
  ToolWaitRuntime,
  type ToolTaskOptions,
  type ToolTaskPolicy,
} from "./tool-task.js";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { sandboxCommand } from "./sandbox.js";
import type { SandboxMode } from "./item.js";
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
  utf8Prefix,
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
  sandbox?: SandboxMode;
  task?: {
    yieldTimeMs?: number;
    timeoutMs?: number;
    previewBytes?: number;
    waitForCompletion?: boolean;
  };
  /** Host-owned streaming sink; bytes emitted here must not be repeated in final output. */
  taskContext?: {
    onOutput(text: string): void;
    onModelContent?(content: UserInput): void;
    requestYield?(): void;
  };
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
  /** Host builtin enforces invocation.sandbox before producing file effects. */
  readonly enforcesSandbox?: boolean;
  readonly taskPolicy?: ToolTaskPolicy;
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
  drain?(): Promise<void>;
  codeContext?: {
    tools: readonly { name: string; description: string }[];
    storedValues: Record<string, JsonValue>;
    store(key: string, value: JsonValue): Promise<void>;
    resolveMedia(
      media: readonly { type: "image" | "audio"; value: JsonValue }[],
    ): Promise<UserInput>;
  };
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
  readonly taskManager: ToolTaskManager;
  readonly waitRuntime: ToolWaitRuntime;
  readonly #bundles = new Map<string, BundleRegistration>();
  readonly #tools = new Map<string, BundleRegistration & RuntimeRegistration>();
  readonly #reservedBundleKeys = new Set<string>();
  readonly #reservedToolNames = new Set<string>();
  readonly #preparedRuntimes = new WeakMap<
    PreparedToolInvocation,
    PreparedRuntimeRegistration
  >();
  readonly #unsandboxedAdmissions = new WeakSet<PreparedToolInvocation>();
  readonly #policyStore: ToolPolicyStore;
  readonly #pendingAdmissions = new Map<string, Promise<void>>();

  constructor(
    options: {
      taskOptions?: ToolTaskOptions;
      toolOutputSpool?: ToolOutputSpool;
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
    this.taskManager = new ToolTaskManager({
      ...options.taskOptions,
      ...(options.toolOutputSpool === undefined
        ? {}
        : { toolOutputSpool: options.toolOutputSpool }),
    });
    this.waitRuntime = new ToolWaitRuntime(this.taskManager);
    this.registerRuntime(this.waitRuntime);
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
    if (
      bundle.tools.some(
        (runtime) => runtime.name === "wait" && runtime !== this.waitRuntime,
      ) ||
      (bundle.identity.kind === "builtin" &&
        bundle.identity.id === "wait" &&
        bundle.tools[0] !== this.waitRuntime)
    )
      throw new Error("The wait tool is reserved by the runtime");
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
      if (executionModeFor(runtime) === "parallel_safe") {
        definition.description = `[parallel_safe] ${definition.description}`;
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
    if (key === "builtin:wait") return false;
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
    const runtime = this.#requirePrepared(prepared).runtime;
    const sandbox = prepared.invocation.sandbox ?? "danger-full-access";
    if (sandbox !== "danger-full-access" && runtime !== this.waitRuntime) {
      const escalation =
        prepared.invocation.arguments.sandbox_permissions ===
        "require_escalated";
      if (
        prepared.owner.kind === "builtin" &&
        runtime.enforcesSandbox === true &&
        !escalation
      )
        return "accept";
      try {
        if (
          options.policy === "full_access" ||
          options.requestApproval === undefined
        ) {
          throw new Error(
            "This call needs one-time approval to run outside the file sandbox, but approvals are unavailable.",
          );
        }
        const decision = await waitForToolAbort(
          options.requestApproval({
            ...options.approvalRequest,
            scope: "once",
            command: `[One-time full file access: ${sandbox}]\n${options.approvalRequest.command}`,
          }),
          prepared.invocation.signal,
        );
        if (decision === "accept" || decision === "acceptForSession")
          this.#unsandboxedAdmissions.add(prepared);
        else this.#releasePrepared(prepared);
        return decision;
      } catch (error) {
        this.#releasePrepared(prepared);
        throw error;
      }
    }
    if (
      this.#requirePrepared(prepared).runtime === this.waitRuntime ||
      options.policy === "full_access"
    )
      return "accept";

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
    if (this.#requirePrepared(prepared).runtime === this.waitRuntime)
      return "accept";
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
    let retained = false;
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
      // The manager owns this envelope; its nested tool payload was already
      // normalized at the original execution boundary. Do not charge the
      // fixed control envelope against the tool's original JSON byte budget.
      if (runtime === this.waitRuntime)
        return await runtime.execute(prepared.invocation);
      const execute = async (original: ToolInvocation) => {
        const invocation = this.#unsandboxedAdmissions.has(prepared)
          ? { ...original, sandbox: "danger-full-access" as const }
          : original;
        const result =
          nested !== undefined &&
          prepared.owner.kind === "builtin" &&
          isCompositeToolRuntime(runtime)
            ? await runtime.executeComposite(invocation, nested)
            : await runtime.execute(invocation);
        await nested?.drain?.();
        try {
          return normalizeToolExecutionResult(result, prepared.owner);
        } catch (error) {
          throw new ToolResultNormalizationError(error);
        }
      };
      if (runtime instanceof ToolWaitRuntime)
        return await execute(prepared.invocation);
      const scope =
        (isCompositeToolRuntime(runtime)
          ? "independent"
          : runtime.taskPolicy?.resourceScope) ??
        (runtime.executionMode === "parallel_safe" ? "independent" : "bundle");
      const key =
        scope === "independent"
          ? undefined
          : scope === "runtime"
            ? runtime
            : bundleIdentityKey(prepared.owner);
      retained = true;
      try {
        return await this.taskManager.run(
          runtime,
          prepared.invocation,
          execute,
          { resourceKey: key, release: () => this.#releasePrepared(prepared) },
        );
      } catch (error) {
        // Admission/validation can fail before the task acquires its lease.
        if (!this.taskManager.ownsInvocation(prepared.invocation))
          this.#releasePrepared(prepared);
        throw error;
      }
    } finally {
      if (!retained) this.#releasePrepared(prepared);
    }
  }

  async close(): Promise<void> {
    await this.taskManager.close();
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
  scope?: "once";
  toolName?: string;
  toolArguments?: Readonly<Record<string, unknown>>;
  cwd: string;
  signal: AbortSignal;
}

export type ApprovalHandler = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision>;

/** Concrete process execution only; the environment owns waiting and deadlines. */
export class ShellToolRuntime implements ToolRuntime {
  readonly enforcesSandbox = true;
  readonly name = "shell";
  readonly executionMode = "parallel_safe";
  readonly taskPolicy: ToolTaskPolicy = {
    resourceScope: "independent",
    cancellation: "confirmed-on-settle",
    timingArguments: { yieldTimeMs: "yield_time_ms", timeoutMs: "timeout_ms" },
  };
  readonly specification: ModelTool = {
    name: this.name,
    description:
      "Run a shell command. Independent commands can run concurrently; await commands sequentially when their effects depend on each other. Long operations return a task_id for wait. yield_time_ms controls how long to wait before returning a task receipt (maximum 180 seconds); timeout_ms controls the separate execution deadline (default 10 minutes, maximum 24 hours).",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_permissions: {
          type: "string",
          enum: ["use_default", "require_escalated"],
          description:
            "Use require_escalated to request one-time approval for a command that needs file access outside the current policy.",
        },
        command: { type: "string" },
        yield_time_ms: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TOOL_YIELD_TIME_MS,
        },
        timeout_ms: { type: "integer", minimum: 1, maximum: 86400000 },
      },
      required: ["command"],
      additionalProperties: false,
    },
  };
  readonly #environment: NodeJS.ProcessEnv;
  readonly #terminationGraceMs: number;
  readonly #maxOutputBytes: number;
  readonly #spool: ToolOutputSpool | undefined;
  constructor(
    options: {
      environment?: Readonly<NodeJS.ProcessEnv>;
      blockedEnvironmentVariables?: readonly string[];
      terminationGraceMs?: number;
      maxOutputBytes?: number;
      toolOutputSpool?: ToolOutputSpool;
    } = {},
  ) {
    this.#environment = Object.freeze(
      sanitizeToolEnvironment(
        options.environment ?? process.env,
        options.blockedEnvironmentVariables ?? [],
      ),
    );
    this.#terminationGraceMs = options.terminationGraceMs ?? 250;
    this.#maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_TOOL_OUTPUT_CAPTURE_BYTES;
    this.#spool = options.toolOutputSpool;
  }
  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    invocation.signal.throwIfAborted();
    const command = invocation.arguments.command;
    if (typeof command !== "string" || command.trim().length === 0)
      throw new Error("shell.command must be a non-empty string");
    const capture =
      invocation.taskContext === undefined
        ? new ToolOutputWindow(this.#maxOutputBytes, this.#spool)
        : undefined;
    const write = (text: string) => {
      if (capture !== undefined) capture.write(text);
      else invocation.taskContext?.onOutput(text);
    };
    const launch = await sandboxCommand(
      invocation.sandbox ?? "danger-full-access",
      invocation.cwd,
      command,
    );
    const child = spawn(launch.file, launch.args, {
      cwd: invocation.cwd,
      env: this.#environment,
      shell:
        (invocation.sandbox ?? "danger-full-access") === "danger-full-access",
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout = new StringDecoder("utf8"),
      stderr = new StringDecoder("utf8");
    child.stdout.on("data", (chunk: Buffer) => write(stdout.write(chunk)));
    child.stderr.on("data", (chunk: Buffer) => write(stderr.write(chunk)));
    let killTimer: NodeJS.Timeout | undefined;
    let aborted = false;
    const kill = (signal: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          /* Group already exited. */
        }
      }
      try {
        child.kill(signal);
      } catch {
        /* Child already exited. */
      }
    };
    const exitCode = await new Promise<number>((resolve) => {
      let finished = false;
      const finish = (code: number) => {
        if (finished) return;
        finished = true;
        if (killTimer !== undefined) clearTimeout(killTimer);
        invocation.signal.removeEventListener("abort", abort);
        write(stdout.end());
        write(stderr.end());
        resolve(code);
      };
      const abort = () => {
        if (aborted || finished) return;
        aborted = true;
        kill("SIGTERM");
        killTimer = setTimeout(() => {
          kill("SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
          finish(130);
        }, this.#terminationGraceMs);
      };
      child.once("error", (error) => {
        write(`\n[shell spawn failed: ${error.message}]`);
        finish(1);
      });
      child.once("close", (code) => {
        if (aborted) kill("SIGKILL");
        finish(aborted ? 130 : (code ?? 128));
      });
      invocation.signal.addEventListener("abort", abort, { once: true });
      if (invocation.signal.aborted) abort();
    });
    if (capture === undefined) return { output: "", exitCode };
    const output = await capture.finish();
    return attachToolOutputCapture(
      { output: output.output, exitCode },
      output.metadata,
    );
  }
}

export class ToolOutputWindow {
  readonly #maxOutputBytes: number;
  readonly #capture: ReturnType<ToolOutputSpool["beginCapture"]> | undefined;
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  #truncated = false;
  hasOutput = false;

  constructor(
    maxOutputBytes: number,
    spool: ToolOutputSpool | undefined,
    previewBytes?: number,
  ) {
    this.#maxOutputBytes =
      spool === undefined && previewBytes !== undefined
        ? Math.min(maxOutputBytes, previewBytes)
        : maxOutputBytes;
    this.#capture = spool?.beginCapture({
      maxCaptureBytes: maxOutputBytes,
      ...(previewBytes === undefined ? {} : { previewBytes }),
    });
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

  async finish(sourceTruncated = false): Promise<{
    output: string;
    metadata?: ToolOutputCaptureMetadata;
  }> {
    if (this.#capture !== undefined) {
      const metadata = await this.#capture.finish({ sourceTruncated });
      return { output: metadata.output ?? "", metadata };
    }
    const bytes = utf8Prefix(Buffer.concat(this.#chunks), this.#bytes);
    const text = bytes.toString("utf8");
    return {
      output:
        text +
        (this.#truncated || sourceTruncated
          ? "\n[output truncated by Zen]"
          : ""),
      metadata: inlineToolOutputCapture(
        text,
        this.#truncated || sourceTruncated,
      ),
    };
  }

  /** Append original capture bytes, never its model-facing receipt. */
  async appendCapture(capture: ToolOutputCaptureMetadata): Promise<boolean> {
    if (capture.output !== undefined) {
      this.write(capture.output);
      return capture.sourceTruncated;
    }
    if (capture.path === undefined) {
      this.write(capture.head);
      return true;
    }
    try {
      const file = await open(capture.path, "r");
      try {
        const hash = createHash("sha256");
        const decoder = new StringDecoder("utf8");
        const buffer = Buffer.alloc(64 * 1024);
        let offset = 0;
        while (offset < capture.capturedBytes) {
          const { bytesRead } = await file.read(
            buffer,
            0,
            Math.min(buffer.length, capture.capturedBytes - offset),
            offset,
          );
          if (bytesRead === 0) break;
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          this.write(decoder.write(chunk));
          offset += bytesRead;
        }
        this.write(decoder.end());
        const extra = await file.read(buffer, 0, 1, offset);
        return (
          capture.sourceTruncated ||
          offset !== capture.capturedBytes ||
          extra.bytesRead !== 0 ||
          hash.digest("hex") !== capture.sha256
        );
      } finally {
        await file.close();
      }
    } catch {
      return true;
    }
  }

  async discard(): Promise<void> {
    await this.#capture?.discard();
  }
}

export function attachToolOutputCapture(
  result: ToolExecutionResult,
  metadata?: ToolOutputCaptureMetadata,
  suffix = "",
): ToolExecutionResult {
  return {
    ...result,
    output: result.output + suffix,
    [TOOL_OUTPUT_CAPTURE]:
      metadata ??
      capturedToolOutput(result) ??
      inlineToolOutputCapture(result.output, result.sourceTruncated ?? false),
    ...(suffix.length === 0 ? {} : { [TOOL_OUTPUT_SUFFIX]: suffix }),
  };
}

function inlineToolOutputCapture(
  output: string,
  sourceTruncated: boolean,
): ToolOutputCaptureMetadata {
  const bytes = Buffer.from(output);
  return {
    capturedBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    lifetime: "host_instance",
    sourceTruncated,
    head: output,
    tail: "",
    ...(sourceTruncated ? {} : { output }),
  };
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
