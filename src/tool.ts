import type { AttachmentStore } from "./attachment.js";
import type { RuntimeTrace } from "./trace.js";
import {
  createToolTraceCapture,
  TraceReadToolRuntime,
  type ToolTraceCapture,
} from "./trace-tool.js";
import {
  attachModelReferenceBindings,
  trustedModelReferenceBindings,
  type ModelReferenceBinding,
} from "./model-references.js";
import {
  ShellSessionsRuntime,
  type ShellPtyProvider,
  type ShellTerminalControl,
} from "./shell-session.js";
import {
  MAX_TOOL_YIELD_TIME_MS,
  ToolTaskManager,
  ToolWaitRuntime,
  type ToolResourceClaim,
  type ToolTaskOptions,
  type ToolTaskPolicy,
} from "./tool-task.js";
export type {
  ToolResourceClaim,
  ToolTaskOptions,
  ToolTaskPolicy,
} from "./tool-task.js";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
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
import type { ToolBundleIdentity } from "./tool-identity.js";
export type { ToolBundleKind, ToolBundleIdentity } from "./tool-identity.js";
import {
  DEFAULT_TOOL_OUTPUT_CAPTURE_BYTES,
  renderToolOutput,
  utf8Prefix,
  type ToolOutputCaptureMetadata,
  type ToolOutputSpool,
} from "./tool-output-spool.js";
import type { ShellOutputFilter } from "./shell-output-filter.js";
import {
  MAX_TOOL_TASK_CONTROL_BYTES,
  TOOL_TASK_CONTENT_TYPE,
  validateTargetToolTaskEnvelope,
} from "./tool-task-content.js";

const TOOL_OUTPUT_CAPTURE = Symbol("tool-output-capture");
const TOOL_OUTPUT_SUFFIX = Symbol("tool-output-suffix");

/** Host-resolved target identity; generation is revalidated by the domain Host. */
export interface ToolApprovalScope {
  readonly key: string;
  readonly label: string;
  readonly generation: string;
}

/** Observed shell facts, independent of task completion or cancellation. */
export type ShellLifecycleFacts = {
  stdio: "open" | "eof";
} & (
  | { foreground: "running" }
  | {
      foreground: "exited";
      /** Null means signal termination, not a successful exit. */
      foreground_exit_code: number | null;
      foreground_signal: NodeJS.Signals | null;
    }
);

export interface ToolInvocation {
  /** Trusted host provenance; never accepted from tool argument JSON. */
  modelReferences?: readonly ModelReferenceBinding[];
  modelTraceInspectionTool?: "trace_read";
  traceOutput?: ToolTraceCapture;
  /** Host-minted human terminal request. Never accepted from tool arguments. */
  userTerminal?: { cols: number; rows: number };
  callId: string;
  /** ToolEnvironment-minted snapshot; callers must not supply this field. */
  readonly approvalScope?: ToolApprovalScope;
  /** Host-minted only for direct plugin UI commands; never inherited from tool arguments. */
  trustedPluginUi?: true;
  /** Runtime-owned canonical tool_call Item identity, independent of provider call IDs. */
  canonicalToolCallId?: string;
  name: string;
  arguments: Record<string, unknown>;
  cwd: string;
  signal: AbortSignal;
  threadId?: string;
  sandbox?: SandboxMode;
  /** Programmatic consumers must receive the existing unfiltered contract. */
  outputAudience?: "model" | "program";
  task?: {
    yieldTimeMs?: number;
    timeoutMs?: number;
    previewBytes?: number;
    waitForCompletion?: boolean;
  };
  /** Host-owned streaming sink; bytes emitted here must not be repeated in final output. */
  taskContext?: {
    onOutput(text: string): void;
    onShellOutput?(text: string): void;
    onShellControl?(control: ShellTerminalControl): void;
    /** Trusted executor evidence; settlement alone did not prove cancellation. */
    onCancellationUnconfirmed?(): void;
    /** Builtin shell observations only; absent before successful spawn. */
    onShellLifecycle?(facts: ShellLifecycleFacts): void;
    onModelContent?(content: UserInput): void;
    requestYield?(): void;
  };
}

export interface ToolExecutionResult {
  referenceBindings?: readonly ModelReferenceBinding[];
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

export type ToolExecutionMode = "parallel_safe" | "exclusive";

/** One exact model-visible tool and its execution body. */
export interface ToolRuntime {
  readonly name: string;
  readonly specification: ModelTool;
  /** Runtime body scheduling only; not permission or resource scope. */
  readonly executionMode?: ToolExecutionMode;
  /** Trusted local Shell runtime, eligible for non-consuming session observation. */
  readonly shellSession?: true;
  /** Host builtin enforces invocation.sandbox before producing file effects. */
  readonly enforcesSandbox?: boolean;
  /** Explicit target-side opt-in for ordinary text/JSON remote execution. */
  readonly remoteExecution?: "text-json";
  readonly taskPolicy?: ToolTaskPolicy;
  /** Invocation-specific Host resource claims, acquired atomically before execute. */
  resourceClaims?(invocation: ToolInvocation): readonly ToolResourceClaim[];
  /** Trusted target resolver, called once with immutable prepared arguments. */
  approvalScope?(invocation: ToolInvocation): ToolApprovalScope | undefined;
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
  /** Optional as a pair; scoped admission never falls back to get/set. */
  getScoped?(
    toolName: string,
    scopeKey: string,
  ): Promise<StoredToolPolicyDecision | undefined>;
  setScoped?(
    toolName: string,
    scopeKey: string,
    decision: StoredToolPolicyDecision,
  ): Promise<void>;
}

export class InMemoryToolPolicyStore implements ToolPolicyStore {
  readonly #decisions = new Map<string, StoredToolPolicyDecision>();
  readonly #scopedDecisions = new Map<
    string,
    Map<string, StoredToolPolicyDecision>
  >();

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

  async getScoped(
    toolName: string,
    scopeKey: string,
  ): Promise<StoredToolPolicyDecision | undefined> {
    return this.#scopedDecisions.get(toolName)?.get(scopeKey);
  }

  async setScoped(
    toolName: string,
    scopeKey: string,
    decision: StoredToolPolicyDecision,
  ): Promise<void> {
    let decisions = this.#scopedDecisions.get(toolName);
    if (decisions === undefined) {
      decisions = new Map();
      this.#scopedDecisions.set(toolName, decisions);
    }
    decisions.set(scopeKey, decision);
  }
}

export class SetToolPolicyStore implements ToolPolicyStore {
  readonly #approvedTools: Set<string>;
  readonly #deniedTools: Set<string>;
  readonly #scopedDecisions = new Map<
    string,
    Map<string, StoredToolPolicyDecision>
  >();

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

  async getScoped(
    toolName: string,
    scopeKey: string,
  ): Promise<StoredToolPolicyDecision | undefined> {
    return this.#scopedDecisions.get(toolName)?.get(scopeKey);
  }

  async setScoped(
    toolName: string,
    scopeKey: string,
    decision: StoredToolPolicyDecision,
  ): Promise<void> {
    let decisions = this.#scopedDecisions.get(toolName);
    if (decisions === undefined) {
      decisions = new Map();
      this.#scopedDecisions.set(toolName, decisions);
    }
    decisions.set(scopeKey, decision);
  }
}

export interface PreparedToolInvocation {
  readonly approvalScope?: ToolApprovalScope;
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
  generation: string;
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

export interface ToolRemoteDefinitionEntry extends ToolDefinitionEntry {
  generation: string;
  eligible: boolean;
  reason?: string;
}

/** Host-owned transport boundary; Core retains caller admission and append. */
export interface ToolTargetRoute {
  readonly owner: ToolBundleIdentity;
  readonly definition: ModelTool;
  readonly executionMode: ToolExecutionMode;
  readonly requiredModelInputModalities?: readonly string[];
  /** Qualified task observation remains exempt from ordinary tool admission. */
  readonly waitPolicyExempt?: boolean;
  /** Host-only opt-in for a separately bounded, exact target-owned task receipt. */
  readonly resultEnvelope?: "tool-task";
  execute(): Promise<ToolExecutionResult>;
}

export interface ToolTargetRouter {
  prepare(
    invocation: ToolInvocation,
    local?: ToolRemoteDefinitionEntry,
  ): ToolTargetRoute | undefined;
}

interface PreparedRuntimeRegistration {
  admission?: { policy: ToolPolicy; scope?: ToolApprovalScope };
  runtime?: ToolRuntime;
  route?: ToolTargetRoute;
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
  readonly #pendingScopedAdmissions = new Map<
    string,
    Map<string, Promise<void>>
  >();
  #targetRouter: ToolTargetRouter | undefined;
  #trace: RuntimeTrace | undefined;
  #attachments: AttachmentStore | undefined;
  bindTrace(trace: RuntimeTrace, attachments?: AttachmentStore): void {
    if (this.#trace !== undefined && this.#trace !== trace)
      throw new Error(
        "ToolEnvironment already belongs to a different Trace owner",
      );
    this.#trace = trace;
    this.#attachments = attachments ?? this.#attachments;
  }

  constructor(
    options: {
      taskOptions?: ToolTaskOptions;
      /** Publish read-only shared Shell observation in desktop Hosts. */
      shellSessions?: boolean;
      toolOutputSpool?: ToolOutputSpool;
      runtimes?: readonly ToolRuntime[];
      bundles?: readonly ToolBundle[];
      policyStore?: ToolPolicyStore;
      approvedTools?: Set<string>;
      deniedTools?: Set<string>;
      targetRouter?: ToolTargetRouter;
      trace?: RuntimeTrace;
      attachments?: AttachmentStore;
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
    this.#targetRouter = options.targetRouter;
    this.#trace = options.trace;
    this.#attachments = options.attachments;
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
    if (
      options.shellSessions &&
      (options.runtimes ?? []).some((runtime) => runtime.shellSession)
    )
      this.registerRuntime(new ShellSessionsRuntime(this.taskManager));
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

  /** Exact target registrations; replacements invalidate old generations. */
  get remoteDefinitions(): ToolRemoteDefinitionEntry[] {
    return [...this.#bundles.values()].flatMap((registration) =>
      registration.runtimes.map(({ runtime, definition, generation }) => ({
        owner: { ...registration.identity },
        definition: structuredClone(definition),
        generation,
        ...remoteEligibility(runtime),
      })),
    );
  }

  /** Target Host timing semantics; never projected into foreign tool schemas. */
  taskTimingArguments(
    name: string,
  ): ToolTaskPolicy["timingArguments"] | undefined {
    const mapping = this.#tools.get(name)?.runtime.taskPolicy?.timingArguments;
    return mapping === undefined
      ? undefined
      : {
          ...(mapping.yieldTimeMs === undefined
            ? {}
            : { yieldTimeMs: mapping.yieldTimeMs }),
          ...(mapping.timeoutMs === undefined
            ? {}
            : { timeoutMs: mapping.timeoutMs }),
        };
  }

  /** Target-owned timing, including this Environment's configured defaults. */
  resolveTaskTiming(
    invocation: Pick<ToolInvocation, "name" | "arguments" | "task">,
  ): { yieldTimeMs: number; timeoutMs: number } {
    const runtime = this.#tools.get(invocation.name)?.runtime;
    if (runtime === undefined)
      throw new Error(`Unsupported tool: ${invocation.name}`);
    return this.taskManager.resolveTiming(runtime, invocation);
  }

  /** Host composition may attach its routing service after registry creation. */
  setTargetRouter(router: ToolTargetRouter | undefined): void {
    this.#targetRouter = router;
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
      if (
        runtime.approvalScope !== undefined &&
        runtime.enforcesSandbox === true
      )
        throw new Error(
          `Tool ${runtime.name}: approvalScope cannot be combined with enforcesSandbox`,
        );
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
      return { runtime, definition, generation: randomUUID() };
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

  prepare(
    invocation: ToolInvocation,
    /** A target gateway has already selected this Host; domain execution stays local. */
    options: { targetRouting?: boolean } = {},
  ): PreparedToolInvocation {
    if ("approvalScope" in invocation)
      throw new Error(
        "Tool approval scope must come from the trusted runtime resolver",
      );
    const registration = this.#tools.get(invocation.name);
    const traceOutput =
      invocation.traceOutput ??
      (this.#trace && invocation.threadId
        ? createToolTraceCapture(
            this.#trace,
            {
              threadId: invocation.threadId,
              callId: invocation.callId,
              toolName: invocation.name,
              ...(invocation.canonicalToolCallId === undefined
                ? {}
                : { toolCallItemId: invocation.canonicalToolCallId }),
              origin: "tool-environment",
            },
            this.#attachments ? { attachments: this.#attachments } : {},
          )
        : undefined);
    const { modelTraceInspectionTool: _claimedReader, ...trustedInvocation } =
      invocation;
    const frozenInvocation: ToolInvocation = Object.freeze({
      ...trustedInvocation,
      ...(this.#tools.get("trace_read")?.runtime instanceof TraceReadToolRuntime
        ? { modelTraceInspectionTool: "trace_read" as const }
        : {}),
      ...(traceOutput === undefined ? {} : { traceOutput }),
      arguments: Object.freeze(structuredClone(invocation.arguments)),
    });
    const local =
      registration === undefined
        ? undefined
        : {
            owner: { ...registration.identity },
            definition: structuredClone(registration.definition),
            generation: registration.generation,
            ...remoteEligibility(registration.runtime),
          };
    const explicitRemote = requestsRemoteTarget(
      frozenInvocation,
      local?.definition,
    );
    const route =
      options.targetRouting === false
        ? undefined
        : this.#targetRouter?.prepare(frozenInvocation, local);
    if (route !== undefined) {
      deepFreeze(frozenInvocation.arguments);
      const capturedRoute: ToolTargetRoute = Object.freeze({
        owner: Object.freeze({ ...route.owner }),
        definition: deepFreeze(structuredClone(route.definition)),
        executionMode: route.executionMode,
        requiredModelInputModalities: Object.freeze([
          ...(route.requiredModelInputModalities ?? []),
        ]),
        ...(route.waitPolicyExempt === undefined
          ? {}
          : { waitPolicyExempt: route.waitPolicyExempt }),
        ...(route.resultEnvelope === undefined
          ? {}
          : { resultEnvelope: route.resultEnvelope }),
        execute: route.execute.bind(route),
      });
      const prepared: PreparedToolInvocation = Object.freeze({
        owner: capturedRoute.owner,
        definition: capturedRoute.definition,
        executionMode: capturedRoute.executionMode,
        requiredModelInputModalities:
          capturedRoute.requiredModelInputModalities!,
        invocation: frozenInvocation,
      });
      this.#preparedRuntimes.set(prepared, {
        route: capturedRoute,
        release: undefined,
        released: false,
      });
      return prepared;
    }
    if (
      explicitRemote &&
      local?.eligible === false &&
      registration?.runtime !== this.waitRuntime
    )
      throw new Error(
        `Tool ${invocation.name} is not eligible for remote execution: ${local.reason ?? "unsupported runtime"}`,
      );
    if (explicitRemote)
      throw new Error(
        `Remote execution target is unavailable for ${invocation.name}`,
      );
    if (registration === undefined) {
      throw new Error(`Unsupported tool: ${invocation.name}`);
    }
    let localInvocation = frozenInvocation;
    if (
      local?.eligible === true &&
      !ownsRoutingField(local.definition, "device") &&
      !ownsRoutingField(local.definition, "target_context") &&
      (Object.hasOwn(frozenInvocation.arguments, "device") ||
        Object.hasOwn(frozenInvocation.arguments, "target_context"))
    ) {
      const {
        device: _device,
        target_context: _context,
        ...arguments_
      } = frozenInvocation.arguments;
      localInvocation = Object.freeze({
        ...frozenInvocation,
        arguments: Object.freeze(arguments_),
      });
    }
    // Scoped targets are resolved only after local routing inputs are final.
    // Deep-freeze before resolution so approval and dispatch see the same input.
    let approvalScope: ToolApprovalScope | undefined;
    if (registration.runtime.approvalScope !== undefined) {
      deepFreeze(localInvocation.arguments);
      approvalScope = captureApprovalScope(
        registration.runtime.approvalScope(localInvocation),
      );
      if (approvalScope !== undefined)
        localInvocation = Object.freeze({ ...localInvocation, approvalScope });
    }
    const prepared: PreparedToolInvocation = Object.freeze({
      ...(approvalScope === undefined ? {} : { approvalScope }),
      owner: registration.identity,
      definition: structuredClone(registration.definition),
      executionMode: executionModeFor(registration.runtime),
      requiredModelInputModalities: Object.freeze([
        ...(registration.runtime.requiredModelInputModalities ?? []),
      ]),
      invocation: localInvocation,
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
    const registration = this.#requirePrepared(prepared);
    const runtime = registration.runtime;
    const scope = prepared.approvalScope;
    const approvalRequest =
      scope === undefined
        ? options.approvalRequest
        : {
            ...options.approvalRequest,
            approvalTarget: Object.freeze({
              key: scope.key,
              label: scope.label,
            }),
            command: `[Target: ${scope.label}]\n${options.approvalRequest.command}`,
          };
    const sandbox = prepared.invocation.sandbox ?? "danger-full-access";
    if (
      sandbox !== "danger-full-access" &&
      runtime !== this.waitRuntime &&
      registration.route === undefined
    ) {
      const escalation =
        prepared.invocation.arguments.sandbox_permissions ===
        "require_escalated";
      if (
        prepared.owner.kind === "builtin" &&
        runtime?.enforcesSandbox === true &&
        !escalation
      ) {
        registration.admission = {
          policy: options.policy,
          ...(scope === undefined ? {} : { scope }),
        };
        return "accept";
      }
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
            ...approvalRequest,
            scope: "once",
            command: `[One-time full file access: ${sandbox}]\n${approvalRequest.command}`,
          }),
          prepared.invocation.signal,
        );
        if (decision === "accept" || decision === "acceptForSession") {
          this.#unsandboxedAdmissions.add(prepared);
          registration.admission = {
            policy: options.policy,
            ...(scope === undefined ? {} : { scope }),
          };
        } else this.#releasePrepared(prepared);
        return decision;
      } catch (error) {
        this.#releasePrepared(prepared);
        throw error;
      }
    }
    if (
      runtime === this.waitRuntime ||
      registration.route?.waitPolicyExempt === true ||
      options.policy === "full_access"
    ) {
      registration.admission = {
        policy: options.policy,
        ...(scope === undefined ? {} : { scope }),
      };
      return "accept";
    }

    const toolName = prepared.invocation.name;
    try {
      const policy = this.#policyFor(prepared);
      let pendingAdmissions = this.#pendingAdmissions;
      if (scope !== undefined) {
        const scoped =
          this.#pendingScopedAdmissions.get(toolName) ??
          new Map<string, Promise<void>>();
        this.#pendingScopedAdmissions.set(toolName, scoped);
        pendingAdmissions = scoped;
      }
      const pendingKey = scope?.key ?? toolName;
      for (;;) {
        const stored = await policy.get();
        if (stored === "approved") {
          registration.admission = {
            policy: options.policy,
            ...(scope === undefined ? {} : { scope }),
          };
          return "accept";
        }
        if (stored === "denied") {
          this.#releasePrepared(prepared);
          return "decline";
        }
        const pending = pendingAdmissions.get(pendingKey);
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
        pendingAdmissions.set(pendingKey, admission);
        try {
          const decision = await waitForToolAbort(
            options.requestApproval(approvalRequest),
            prepared.invocation.signal,
          );
          if (decision === "accept") {
            await policy.set("approved");
          } else if (decision === "decline") {
            await policy.set("denied");
          }
          if (decision === "decline" || decision === "cancel") {
            this.#releasePrepared(prepared);
          } else {
            registration.admission = {
              policy: options.policy,
              ...(scope === undefined ? {} : { scope }),
            };
          }
          return decision;
        } finally {
          if (pendingAdmissions.get(pendingKey) === admission) {
            pendingAdmissions.delete(pendingKey);
          }
          release();
        }
      }
    } catch (error) {
      this.#releasePrepared(prepared);
      throw error;
    }
  }

  /** Scoped children need an exact grant or an admitted Full Access parent. */
  async admitInherited(
    prepared: PreparedToolInvocation,
    parent?: PreparedToolInvocation,
  ): Promise<ApprovalDecision> {
    const registration = this.#requirePrepared(prepared);
    if (
      registration.runtime === this.waitRuntime ||
      registration.route?.waitPolicyExempt === true
    )
      return "accept";
    try {
      let inheritedAdmission: PreparedRuntimeRegistration["admission"];
      if (parent !== undefined) {
        const parentRegistration = this.#requirePrepared(parent);
        if (
          parent === prepared ||
          parent.owner.kind !== "builtin" ||
          parentRegistration.runtime === undefined ||
          !isCompositeToolRuntime(parentRegistration.runtime) ||
          parentRegistration.admission === undefined ||
          parent.invocation.threadId !== prepared.invocation.threadId
        )
          throw new Error(
            "Inherited approval requires an exact admitted composite parent",
          );
        inheritedAdmission = parentRegistration.admission;
      }
      if (
        prepared.approvalScope !== undefined &&
        inheritedAdmission?.policy === "full_access" &&
        (inheritedAdmission.scope === undefined ||
          (inheritedAdmission.scope.key === prepared.approvalScope.key &&
            inheritedAdmission.scope.generation ===
              prepared.approvalScope.generation))
      ) {
        // Each scoped hop narrows even an unscoped Full Access ancestor.
        registration.admission = {
          policy: "full_access",
          scope: prepared.approvalScope,
        };
        return "accept";
      }
      const stored = await this.#policyFor(prepared).get();
      if (
        stored === "denied" ||
        (prepared.approvalScope !== undefined && stored !== "approved")
      ) {
        this.#releasePrepared(prepared);
        return "decline";
      }
      // A separate scoped grant admits this call, not its ancestor's bypass.
      registration.admission =
        prepared.approvalScope === undefined
          ? (inheritedAdmission ?? { policy: "ask_unknown" })
          : { policy: "ask_unknown", scope: prepared.approvalScope };
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
    const registration = this.#requirePrepared(prepared);
    const runtime = registration.runtime;
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
      // Do not introduce an await(undefined) into the historical no-Trace launch path.
      if (prepared.invocation.traceOutput)
        await prepared.invocation.traceOutput.recordInvocation({
          name: prepared.invocation.name,
          arguments: prepared.invocation.arguments,
          cwd: prepared.invocation.cwd,
          sandbox: prepared.invocation.sandbox,
        });
      if (registration.route !== undefined) {
        const result = await registration.route.execute();
        if (prepared.invocation.traceOutput)
          await prepared.invocation.traceOutput.recordResult(
            result,
            "target-result-before-normalization",
          );
        if (result.modelContent !== undefined)
          throw new ToolResultNormalizationError(
            "Remote execution supports text/JSON results only",
          );
        try {
          return registration.route.resultEnvelope === "tool-task"
            ? normalizeTargetToolTaskResult(result, prepared.owner)
            : normalizeToolExecutionResult(result, prepared.owner);
        } catch (error) {
          throw new ToolResultNormalizationError(error);
        }
      }
      if (runtime === undefined)
        throw new Error("Prepared tool invocation has no execution body");
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
        if (
          invocation.traceOutput &&
          !invocation.traceOutput.hasObservedResult()
        )
          await invocation.traceOutput.recordResult(
            result,
            "tool-result-before-normalization",
          );
        try {
          return normalizeToolExecutionResult(result, prepared.owner);
        } catch (error) {
          throw new ToolResultNormalizationError(error);
        }
      };
      // Observation is a control operation, like wait, and must remain usable
      // when every execution slot is occupied by the sessions being inspected.
      if (
        runtime instanceof ToolWaitRuntime ||
        runtime instanceof ShellSessionsRuntime
      )
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
      const resourceClaims = isCompositeToolRuntime(runtime)
        ? []
        : (runtime.resourceClaims?.(prepared.invocation) ??
          (key === undefined ? [] : [{ key, access: "exclusive" as const }]));
      retained = true;
      try {
        return await this.taskManager.run(
          runtime,
          prepared.invocation,
          execute,
          {
            resourceClaims,
            release: () => this.#releasePrepared(prepared),
          },
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

  /** Release a prepared-call lease when its body will not execute. */
  discard(prepared: PreparedToolInvocation): void {
    this.#releasePrepared(prepared);
  }

  #policyFor(prepared: PreparedToolInvocation): {
    get(): Promise<StoredToolPolicyDecision | undefined>;
    set(decision: StoredToolPolicyDecision): Promise<void>;
  } {
    const toolName = prepared.invocation.name;
    const scope = prepared.approvalScope;
    if (scope === undefined)
      return {
        get: () => this.#policyStore.get(toolName),
        set: (decision) => this.#policyStore.set(toolName, decision),
      };
    const { getScoped, setScoped } = this.#policyStore;
    if (getScoped === undefined || setScoped === undefined)
      throw new Error("Tool policy store does not support scoped decisions");
    return {
      get: () => getScoped.call(this.#policyStore, toolName, scope.key),
      set: (decision) =>
        setScoped.call(this.#policyStore, toolName, scope.key, decision),
    };
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

function captureApprovalScope(
  scope: ToolApprovalScope | undefined,
): ToolApprovalScope | undefined {
  if (scope === undefined) return undefined;
  if (
    scope === null ||
    typeof scope !== "object" ||
    typeof scope.key !== "string" ||
    scope.key.trim().length === 0 ||
    typeof scope.label !== "string" ||
    scope.label.trim().length === 0 ||
    typeof scope.generation !== "string" ||
    scope.generation.trim().length === 0
  )
    throw new Error("Invalid trusted tool approval scope");
  return Object.freeze({
    key: scope.key,
    label: scope.label,
    generation: scope.generation,
  });
}

function executionModeFor(runtime: ToolRuntime): ToolExecutionMode {
  return runtime.executionMode === "parallel_safe"
    ? "parallel_safe"
    : "exclusive";
}

function remoteEligibility(
  runtime: ToolRuntime,
): Pick<ToolRemoteDefinitionEntry, "eligible" | "reason"> {
  if (runtime instanceof ToolWaitRuntime)
    return { eligible: false, reason: "Task observation is Host-owned" };
  if (runtime.approvalScope !== undefined)
    return {
      eligible: false,
      reason: "Instance-scoped admission is unavailable for remote execution",
    };
  if (isCompositeToolRuntime(runtime))
    return { eligible: false, reason: "Composite tools execute locally" };
  if ((runtime.requiredModelInputModalities?.length ?? 0) !== 0)
    return {
      eligible: false,
      reason: "Remote execution supports text/JSON only",
    };
  return runtime.remoteExecution === "text-json"
    ? { eligible: true }
    : {
        eligible: false,
        reason: "Runtime has not opted in to remote execution",
      };
}

function requestsRemoteTarget(
  invocation: ToolInvocation,
  definition: ModelTool | undefined,
): boolean {
  return (
    (!ownsRoutingField(definition, "device") &&
      invocation.arguments.device !== undefined &&
      invocation.arguments.device !== "local") ||
    (!ownsRoutingField(definition, "target_context") &&
      invocation.arguments.target_context !== undefined)
  );
}

function ownsRoutingField(
  definition: ModelTool | undefined,
  field: string,
): boolean {
  const properties = definition?.inputSchema.properties;
  return (
    properties !== null &&
    typeof properties === "object" &&
    Object.hasOwn(properties, field)
  );
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
  const bindings = trustedModelReferenceBindings(result);
  if (result.referenceBindings !== undefined && bindings === undefined)
    throw new Error("Untrusted model reference bindings");
  const normalized = normalizeToolResultWithBudget(
    result,
    owner,
    MAX_STRUCTURED_TOOL_RESULT_BYTES,
  );
  return bindings === undefined
    ? normalized
    : attachModelReferenceBindings(normalized, bindings);
}

function normalizeTargetToolTaskResult(
  result: ToolExecutionResult,
  owner: ToolBundleIdentity,
): ToolExecutionResult {
  if (owner.kind !== "external")
    throw new Error(
      "Only external-owned Host routes may return task envelopes",
    );
  if (result.contentType !== TOOL_TASK_CONTENT_TYPE)
    throw new Error("Target task envelope has an unsupported contentType");
  assertJsonValue(result.structuredContent, "$structuredContent");
  const { control, payload } = validateTargetToolTaskEnvelope(
    result.structuredContent,
    result.exitCode,
  );
  const normalizedControl = normalizeToolResultWithBudget(
    { ...result, structuredContent: control },
    owner,
    MAX_TOOL_TASK_CONTROL_BYTES,
  );
  if (payload === undefined) return normalizedControl;
  const normalizedPayload = normalizeToolExecutionResult(
    { output: "", exitCode: result.exitCode, ...payload },
    owner,
  );
  return {
    ...normalizedControl,
    structuredContent: deepFreeze({
      ...(normalizedControl.structuredContent as Record<string, JsonValue>),
      result: normalizedPayload.structuredContent!,
      result_content_type: normalizedPayload.contentType!,
    }),
  };
}

/** Private budgets are selected by validated Host boundaries, never result metadata. */
function normalizeToolResultWithBudget(
  result: ToolExecutionResult,
  owner: ToolBundleIdentity,
  maxStructuredBytes: number,
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
  if (Buffer.byteLength(encoded, "utf8") > maxStructuredBytes) {
    throw new Error(
      `Structured tool result exceeded its ${String(maxStructuredBytes)} byte limit`,
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

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value))
    return value;
  seen.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value))
    deepFreeze(entry, seen);
  return Object.freeze(value);
}

export interface ApprovalRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  callId: string;
  command: string;
  scope?: "once";
  /** Trusted target context; never a model-supplied authority. */
  approvalTarget?: Readonly<Pick<ToolApprovalScope, "key" | "label">>;
  toolName?: string;
  toolArguments?: Readonly<Record<string, unknown>>;
  cwd: string;
  signal: AbortSignal;
}

export type ApprovalHandler = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision>;

/** Concrete process execution only; the environment owns waiting and deadlines. */
export interface ShellProcessTermination {
  /** The invocation owns launch-observation helpers even after a fast command exits. */
  readonly ready?: Promise<void>;
  terminate(): Promise<{ ok: boolean; error: string }>;
}

export class ShellToolRuntime implements ToolRuntime {
  readonly enforcesSandbox = true;
  readonly remoteExecution = "text-json";
  readonly shellSession = true;
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
      "Run a shell command. Independent commands can run concurrently; await commands sequentially when their effects depend on each other. Long operations return a task_id for wait. yield_time_ms controls how long to wait before returning a task receipt (maximum 180 seconds); timeout_ms controls the separate execution deadline (default 10 minutes, maximum 24 hours). Shell task completion waits for the direct command process to exit and stdout/stderr to close; descendants inheriting these pipes can keep it running. Receipts may include independent foreground (running/exited) and stdio (open/eof) observations, plus foreground_exit_code and foreground_signal after exit, even while task status stays running. running (foreground_exited) means exited + open, never completion. Redirect intentional background output to files or /dev/null; backgrounding a compound command such as cd x && nohup y & may leave a subshell holding pipes. Cancellation/timeout targets the owned process group on POSIX (the direct child on Windows); backgrounding is not a detach exemption, but escaped process groups are not contained. Pipe EOF is not proof that every redirected descendant exited. Use an OS service manager for services that must outlive the Host.",
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
  readonly #outputFilter: ShellOutputFilter | undefined;
  readonly #pty: ShellPtyProvider | undefined;
  readonly #trackProcess:
    ((child: ChildProcess) => ShellProcessTermination) | undefined;
  constructor(
    options: {
      environment?: Readonly<NodeJS.ProcessEnv>;
      blockedEnvironmentVariables?: readonly string[];
      terminationGraceMs?: number;
      maxOutputBytes?: number;
      toolOutputSpool?: ToolOutputSpool;
      experimentalOutputFilter?: ShellOutputFilter;
      pty?: ShellPtyProvider;
      /** Host adapter; ownership stays scoped to this exact invocation. */
      trackProcess?: (child: ChildProcess) => ShellProcessTermination;
      ownedCleanupWaitMs?: number;
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
    this.#outputFilter = options.experimentalOutputFilter;
    this.#pty = options.pty;
    this.#trackProcess = options.trackProcess;
    if (options.trackProcess !== undefined) {
      if (options.ownedCleanupWaitMs !== undefined) {
        this.taskPolicy = {
          ...this.taskPolicy,
          shutdownWaitMs: options.ownedCleanupWaitMs,
        };
      }
      this.specification = {
        ...this.specification,
        description: this.specification.description.replace(
          "the direct child on Windows",
          "the Host's captured, identity-verified process tree on Windows; ambiguous ownership or failed verification remains cancellation_unconfirmed",
        ),
      };
    }
  }
  async #interactive(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    if (!this.#pty || !invocation.taskContext || !invocation.threadId)
      throw new Error("Interactive Shell is unavailable on this Host");
    if (invocation.sandbox !== "danger-full-access")
      throw new Error(
        "Interactive terminals require the thread's Full Access policy; restricted Shell commands remain available",
      );
    const terminal = await this.#pty.spawn({
      cwd: invocation.cwd,
      env: this.#environment,
      ...invocation.userTerminal!,
    });
    const write = (text: string) => {
      // The PTY only exposes decoded text; its producer cannot be paused. The sink bounds pending bytes and records any gap.
      if (invocation.traceOutput)
        void invocation.traceOutput.write("pty", text, "pty-decoded-text");
      invocation.taskContext!.onShellOutput?.(text);
      invocation.taskContext!.onOutput(text);
    };
    invocation.taskContext.onShellControl?.(terminal);
    // PTY exit does not establish two pipe EOF observations. Do not synthesize
    // the optional pipe lifecycle facts provided by ordinary command shells.
    return await new Promise<ToolExecutionResult>((resolve) => {
      let ended = false;
      let forced: NodeJS.Timeout | undefined;
      const data = terminal.onData(write);
      const exit = terminal.onExit(({ exitCode }) => {
        if (ended) return;
        ended = true;
        if (forced) clearTimeout(forced);
        invocation.signal.removeEventListener("abort", abort);
        data.dispose();
        exit.dispose();
        if (invocation.traceOutput)
          void invocation.traceOutput
            .end("pty", true)
            .then(() => resolve({ output: "", exitCode }));
        else resolve({ output: "", exitCode });
      });
      const abort = () => {
        if (ended) return;
        try {
          terminal.kill("SIGTERM");
        } catch {
          /* Wait for observed exit. */
        }
        forced ??= setTimeout(() => {
          if (!ended) {
            try {
              terminal.kill("SIGKILL");
            } catch {
              /* Exit remains unconfirmed. */
            }
          }
        }, this.#terminationGraceMs);
        forced.unref();
      };
      invocation.signal.addEventListener("abort", abort, { once: true });
      if (invocation.signal.aborted) abort();
    });
  }
  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    invocation.signal.throwIfAborted();
    if (invocation.userTerminal !== undefined)
      return this.#interactive(invocation);
    const command = invocation.arguments.command;
    if (typeof command !== "string" || command.trim().length === 0)
      throw new Error("shell.command must be a non-empty string");
    const launch = await sandboxCommand(
      invocation.sandbox ?? "danger-full-access",
      invocation.cwd,
      command,
    );
    const filter =
      invocation.outputAudience === "model" &&
      this.#spool !== undefined &&
      this.#outputFilter?.matches(command)
        ? this.#outputFilter
        : undefined;
    const rawCapture =
      filter === undefined
        ? undefined
        : this.#spool!.beginCapture({ maxCaptureBytes: this.#maxOutputBytes });
    const capture =
      rawCapture !== undefined
        ? undefined
        : invocation.taskContext === undefined
          ? new ToolOutputWindow(this.#maxOutputBytes, this.#spool)
          : undefined;
    const write = (text: string) => {
      invocation.taskContext?.onShellOutput?.(text);
      if (rawCapture !== undefined) rawCapture.write(text);
      else if (capture !== undefined) capture.write(text);
      else invocation.taskContext?.onOutput(text);
    };
    const child = spawn(launch.file, launch.args, {
      cwd: invocation.cwd,
      env: this.#environment,
      shell:
        (invocation.sandbox ?? "danger-full-access") === "danger-full-access",
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let processOwner: ShellProcessTermination | undefined;
    try {
      processOwner = this.#trackProcess?.(child);
    } catch (error) {
      // A failed ownership observer must not abandon the already-spawned task.
      processOwner = {
        async terminate() {
          return {
            ok: false,
            error: `Process ownership unavailable: ${String(error)}`,
          };
        },
      };
    }
    let lifecycle: ShellLifecycleFacts | undefined;
    let stdoutEof = false;
    let stderrEof = false;
    let finished = false;
    const reportLifecycle = () => {
      if (finished || lifecycle === undefined) return;
      lifecycle = {
        ...lifecycle,
        stdio: stdoutEof && stderrEof ? "eof" : "open",
      };
      invocation.taskContext?.onShellLifecycle?.(lifecycle);
    };
    child.once("spawn", () => {
      lifecycle = { foreground: "running", stdio: "open" };
      reportLifecycle();
    });
    child.once("exit", (code, signal) => {
      if (lifecycle === undefined) return;
      lifecycle = {
        foreground: "exited",
        stdio: "open",
        foreground_exit_code: code,
        foreground_signal: signal,
      };
      reportLifecycle();
    });
    // Only readable end confirms EOF. close/destroy (including forced
    // cancellation cleanup) cannot establish that writers closed their pipes.
    child.stdout.once("end", () => {
      stdoutEof = true;
      reportLifecycle();
    });
    child.stderr.once("end", () => {
      stderrEof = true;
      reportLifecycle();
    });
    const stdout = new StringDecoder("utf8"),
      stderr = new StringDecoder("utf8");
    const rawPending: Promise<void>[] = [];
    const observePipe = (
      pipe: typeof child.stdout,
      decoder: StringDecoder,
      source: string,
    ) => {
      pipe.on("data", (chunk: Buffer) => {
        if (!invocation.traceOutput) {
          write(decoder.write(chunk));
          return;
        }
        pipe.pause();
        const pending = invocation.traceOutput
          .write(source, chunk, "child-process-pipe")
          .then(() => {
            write(decoder.write(chunk));
            pipe.resume();
          });
        rawPending.push(pending);
        void pending.finally(() => {
          const index = rawPending.indexOf(pending);
          if (index >= 0) rawPending.splice(index, 1);
        });
      });
    };
    observePipe(child.stdout, stdout, "stdout");
    observePipe(child.stderr, stderr, "stderr");
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
      const finish = (code: number) => {
        if (finished) return;
        finished = true;
        if (killTimer !== undefined) clearTimeout(killTimer);
        invocation.signal.removeEventListener("abort", abort);
        void Promise.all(rawPending).then(async () => {
          write(stdout.end());
          write(stderr.end());
          if (invocation.traceOutput) {
            await invocation.traceOutput.end(
              "stdout",
              stdoutEof,
              stdoutEof ? undefined : "pipe_closed_without_eof",
            );
            await invocation.traceOutput.end(
              "stderr",
              stderrEof,
              stderrEof ? undefined : "pipe_closed_without_eof",
            );
          }
          resolve(code);
        });
      };
      const abort = () => {
        if (aborted || finished) return;
        aborted = true;
        if (processOwner !== undefined) {
          void processOwner.terminate().then(
            (result) => {
              if (!result.ok) {
                invocation.taskContext?.onCancellationUnconfirmed?.();
                write(
                  `\n[Shell Stop unconfirmed: ${result.error.slice(0, 1024)}]\n`,
                );
              }
              child.stdout.destroy();
              child.stderr.destroy();
              finish(130);
            },
            (error: unknown) => {
              invocation.taskContext?.onCancellationUnconfirmed?.();
              write(
                `\n[Shell Stop unconfirmed: ${String(error).slice(0, 1024)}]\n`,
              );
              child.stdout.destroy();
              child.stderr.destroy();
              finish(130);
            },
          );
          return;
        }
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
        if (aborted && processOwner !== undefined) return;
        finish(1);
      });
      child.once("close", (code) => {
        // Native child/pipe closure is separate from the adapter's bounded
        // ownership verification. It cannot prematurely confirm a Stop.
        if (aborted && processOwner !== undefined) return;
        if (processOwner?.ready !== undefined) {
          void processOwner.ready.then(
            () => {
              if (!aborted) finish(code ?? 128);
            },
            (error: unknown) => {
              write(
                `\n[Shell ownership observation failed: ${String(error).slice(0, 1024)}]\n`,
              );
              if (!aborted) finish(code ?? 128);
            },
          );
          return;
        }
        if (aborted) kill("SIGKILL");
        finish(aborted ? 130 : (code ?? 128));
      });
      invocation.signal.addEventListener("abort", abort, { once: true });
      if (invocation.signal.aborted) abort();
    });
    if (rawCapture !== undefined && filter !== undefined) {
      const raw = await rawCapture.finish({ retainFile: true });
      let output = renderToolOutput(raw);
      let status = "raw";
      let reason =
        "cancelled, truncated, unavailable, or over filter input limit";
      if (
        !invocation.signal.aborted &&
        !raw.sourceTruncated &&
        raw.path !== undefined &&
        raw.capturedBytes <= filter.maxInputBytes
      ) {
        try {
          const filtered = await filter.filter(
            await readFile(raw.path, "utf8"),
            invocation.signal,
          );
          const receipt = `\n[filtered output: ${filter.id}]\nraw_output: ${raw.path}\nraw_bytes: ${raw.capturedBytes}\nraw_sha256: ${raw.sha256}\nlifetime: ${raw.lifetime}\nsource_truncated: false`;
          if (Buffer.byteLength(filtered + receipt) < raw.capturedBytes) {
            output = filtered + receipt;
            status = "filtered";
            reason = "";
          } else reason = "filtered output plus receipt is not smaller";
        } catch (error) {
          reason = String(error).slice(0, 512);
        }
      }
      const structuredContent = {
        outputPresentation: {
          filter: filter.id,
          status,
          reason,
          raw: {
            path: raw.path ?? null,
            bytes: raw.capturedBytes,
            sha256: raw.sha256,
            lifetime: raw.lifetime,
            sourceTruncated: raw.sourceTruncated,
          },
        },
      };
      if (invocation.taskContext !== undefined) {
        invocation.taskContext.onOutput(output);
        return {
          output: "",
          exitCode,
          contentType: "application/vnd.zen.shell-output-presentation+json",
          structuredContent,
        };
      }
      return {
        output,
        exitCode,
        contentType: "application/vnd.zen.shell-output-presentation+json",
        structuredContent,
      };
    }
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

export function carryToolResultReferences(
  source: ToolExecutionResult,
  target: ToolExecutionResult,
): ToolExecutionResult {
  const bindings = trustedModelReferenceBindings(source);
  return bindings === undefined
    ? target
    : attachModelReferenceBindings(target, bindings);
}

export function attachToolOutputCapture(
  result: ToolExecutionResult,
  metadata?: ToolOutputCaptureMetadata,
  suffix = "",
): ToolExecutionResult {
  return carryToolResultReferences(result, {
    ...result,
    output: result.output + suffix,
    [TOOL_OUTPUT_CAPTURE]:
      metadata ??
      capturedToolOutput(result) ??
      inlineToolOutputCapture(result.output, result.sourceTruncated ?? false),
    ...(suffix.length === 0 ? {} : { [TOOL_OUTPUT_SUFFIX]: suffix }),
  });
}

function inlineToolOutputCapture(
  output: string,
  sourceTruncated: boolean,
): ToolOutputCaptureMetadata {
  const bytes = Buffer.from(output);
  return {
    unspooled: true,
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
  const key = (name: string) =>
    process.platform === "win32" ? name.toUpperCase() : name;
  const blocked = new Set(blockedEnvironmentVariables.map(key));
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      !blocked.has(key(name)) &&
      (SAFE_ENVIRONMENT_VARIABLES.has(key(name)) || name.startsWith("LC_"))
    ) {
      environment[name] = value;
    }
  }
  return environment;
}
