import {
  isRoomModelTool,
  roomModelDefinition,
  decodeRoomArguments,
  projectRoomResult,
} from "./model-room-facade.js";
import {
  isThreadModelTool,
  threadModelDefinition,
  decodeThreadArguments,
  projectThreadToolResult,
} from "./model-thread-facade.js";
import type {
  ToolExecutionResult,
  ToolInvocation,
} from "../../../../../src/tool.js";
import type { ModelTool } from "../../../../../src/model.js";
import {
  ModelReferenceRegistry,
  ModelReferenceBudgetError,
  CAPABILITY_REFERENCE_BUDGET,
  attachModelReferenceBindings,
  type ModelReferenceBinding,
  type ModelReferenceScope,
} from "../../../../../src/model-references.js";
import { asJson, record, pick } from "./model-facade-fields.js";
import {
  isComputerModelTool,
  computerModelDefinition,
  decodeComputerArguments,
  projectComputerResult,
} from "./model-computer-facade.js";

export function hasModelToolFacade(name: string): boolean {
  return (
    isComputerModelTool(name) ||
    isThreadModelTool(name) ||
    isRoomModelTool(name)
  );
}
export function modelToolDefinition<T extends ModelTool>(tool: T): T {
  return isComputerModelTool(tool.name)
    ? computerModelDefinition(tool)
    : isThreadModelTool(tool.name)
      ? threadModelDefinition(tool)
      : isRoomModelTool(tool.name)
        ? roomModelDefinition(tool)
        : structuredClone(tool);
}
const UI_ONLY_ROOMS = new Set([
  "zenx_rooms_operations",
  "zenx_rooms_prepare_introduction",
  "zenx_rooms_start_introduction",
  "zenx_rooms_prepare_message",
  "zenx_rooms_cancel_prepared",
  "zenx_rooms_operation",
  "zenx_rooms_delivery",
  "zenx_rooms_ack_operation",
  "zenx_rooms_workspaces",
  "zenx_rooms_preview_target",
  "zenx_rooms_create_assistant",
  "zenx_rooms_assistant_delivery",
  "zenx_rooms_assistant_heartbeat",
  "zenx_rooms_assistant_replies",
]);
export const isModelCallableTool = (tool: Pick<ModelTool, "name">) =>
  !UI_ONLY_ROOMS.has(tool.name);
export function modelPluginDocument(id: string, original: string): string {
  if (id === "computer")
    return "Inspect an exact semantic window target for scoped control refs. Follow cursor alone for immutable continuation. Foreground tools may take focus. Native owner, permission, freshness, binding and capture checks remain authoritative. A ref never grants authority, selects the newest capture, or makes dispatch proof of effect. Refresh stale observations; never automatically repeat an uncertain action.";
  if (["zenx-self-control", "zenx-subagents"].includes(id))
    return "Manage Threads by semantic name or exact scoped ref. Read history preserves literal user/tool text, failures and unknown outcomes; selected sources are read-only. Workflow updates use immutable snapshots and native CAS. Discover models by semantic name and exact selection refs. Created/accepted is not completed work; never retry uncertain mutations automatically.";
  if (id === "zenx-rooms")
    return "Use exact scoped Room, Thread and message refs. Workspace edits use immutable snapshots and original CAS. Literal names, messages and planning notes are unchanged. Refs never grant membership, permission, delivery or completed work.";
  return original;
}
export interface ModelFacadeTraceCapture {
  recordResult(result: ToolExecutionResult, layer?: string): Promise<unknown>;
  recordInvocation?(details: Record<string, unknown>): Promise<void>;
  recordReferenceBindings?(bindings: readonly unknown[]): Promise<void>;
}
export type ModelFacadeInvocation = ToolInvocation & {
  modelReferences?: readonly ModelReferenceBinding[];
  traceOutput?: ModelFacadeTraceCapture;
  modelTraceInspectionTool?: string;
};
function decode(
  name: string,
  args: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  if (isRoomModelTool(name))
    return decodeRoomArguments(name, args, refs, epoch);
  return isThreadModelTool(name)
    ? decodeThreadArguments(name, args, refs, epoch)
    : decodeComputerArguments(name, args, refs, epoch);
}
function project(
  name: string,
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  if (isRoomModelTool(name))
    return projectRoomResult(name, result, args, refs, epoch);
  return isThreadModelTool(name)
    ? projectThreadToolResult(name, result, args, refs, epoch)
    : projectComputerResult(result, args, refs, epoch);
}
function outcome(result: Record<string, unknown>): Record<string, unknown> {
  const fields = [
    "status",
    "executionStatus",
    "dispatch",
    "applicationEffect",
    "created",
    "updated",
    "deleted",
    "applied",
    "accepted",
    "queued",
    "timedOut",
    "error",
    "followUpError",
  ];
  const facts = Object.fromEntries(
    Object.entries(pick(result, fields)).filter(
      ([, v]) =>
        v === null || ["string", "boolean", "number"].includes(typeof v),
    ),
  );
  const delivery = record(result.delivery);
  if (delivery) {
    const nested = outcome(delivery);
    if (nested.classification === "known") facts.delivery = nested;
  }
  return {
    classification: Object.keys(facts).length ? "known" : "unclassified",
    ...facts,
  };
}
/** Typed child projection only; the normal Host dispatch and guards remain authoritative. */
export async function invokeModelToolFacade(options: {
  invocation: ModelFacadeInvocation;
  epoch: string;
  references: ModelReferenceRegistry;
  dispatch(invocation: ToolInvocation): Promise<ToolExecutionResult>;
}): Promise<
  ToolExecutionResult & { referenceBindings?: ModelReferenceBinding[] }
> {
  const { invocation, epoch, references, dispatch } = options;
  if (
    !hasModelToolFacade(invocation.name) ||
    invocation.trustedPluginUi ||
    !invocation.threadId
  )
    return await dispatch(invocation);
  const refs = references.scope(
    invocation.threadId,
    invocation.modelReferences,
    CAPABILITY_REFERENCE_BUDGET,
  );
  const modelArguments = structuredClone(invocation.arguments);
  const args = decode(invocation.name, modelArguments, refs, epoch);
  const inputBindings = refs.newBindings;
  await invocation.traceOutput?.recordInvocation?.({
    captureLayer: "model-reference-resolved-dispatch",
    tool: invocation.name,
    modelArguments,
    backendArguments: args,
  });
  await invocation.traceOutput?.recordReferenceBindings?.(inputBindings);
  invocation.signal.throwIfAborted();
  const raw = await dispatch({ ...invocation, arguments: args });
  const capture = record(
    await invocation.traceOutput?.recordResult(
      raw,
      "capability-result-before-model-projection",
    ),
  );
  // Only durable capture plus an actually registered reader permits a trace ref.
  let inspection: { ref: string; tool: string } | undefined;
  if (
    invocation.modelTraceInspectionTool === "trace_read" &&
    capture?.durability === "durable" &&
    record(capture.locator)
  )
    inspection = {
      ref: refs.bind(
        "trace",
        "tool-result",
        asJson({ locator: capture.locator, tool: "trace_read" }),
      ),
      tool: "trace_read",
    };
  const retained = refs.newBindings;
  const attach = (result: ToolExecutionResult, bindings = refs.newBindings) =>
    bindings.length
      ? attachModelReferenceBindings({ ...result }, bindings)
      : result;
  if (raw.exitCode !== 0) return attach(raw);
  let value: unknown;
  try {
    value = JSON.parse(raw.output);
  } catch {
    return attach(raw);
  }
  const result = record(value);
  if (!result) return attach(raw);
  let projected: Record<string, unknown>;
  try {
    projected = project(invocation.name, result, args, refs, epoch);
  } catch (error) {
    if (!(error instanceof ModelReferenceBudgetError)) throw error;
    const fallback = {
      ...raw,
      output: JSON.stringify({
        projection: "projection_unavailable",
        reason: "Compact reference publication budget exceeded",
        toolReturn: { exitCode: raw.exitCode },
        outcome: outcome(result),
        ...(inspection ? { trace: inspection } : {}),
        safeNextStep: inspection
          ? "Inspect the retained result through the exact Trace ref, or read current state with a smaller scope. Do not retry a mutation merely because compact projection is unavailable."
          : "Read current state with a smaller scope. No model Trace reader is available for this receipt; do not retry a mutation merely because compact projection is unavailable.",
      }),
    };
    delete fallback.contentType;
    delete fallback.structuredContent;
    delete fallback.modelContent;
    await invocation.traceOutput?.recordReferenceBindings?.(retained);
    return attach(fallback, retained);
  }
  await invocation.traceOutput?.recordReferenceBindings?.(refs.newBindings);
  const projectedResult: ToolExecutionResult = {
    ...raw,
    output: JSON.stringify(projected),
  };
  if (raw.structuredContent !== undefined) {
    projectedResult.contentType = "application/json";
    projectedResult.structuredContent = asJson(projected);
  }
  delete projectedResult.modelContent;
  return attach(projectedResult);
}
