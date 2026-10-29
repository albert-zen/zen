import {
  isFleetModelTool,
  isFleetModelInvocation,
  fleetModelDefinition,
  fleetDeviceModelDefinition,
  fleetModelDocument,
  invokeFleetModelToolFacade,
} from "./model-fleet-facade.js";
import {
  isBrowserModelTool,
  browserModelDefinition,
  browserModelDocument,
  invokeBrowserModelToolFacade,
  type BrowserModelConnections,
} from "./model-browser-facade.js";
import { copyBrowserModelContext } from "./model-browser-metadata.js";
import {
  isBoardModelTool,
  boardModelDefinition,
  boardModelDocument,
  decodeBoardArguments,
  projectBoardResult,
} from "./model-board-facade.js";
import {
  isTriggerModelTool,
  triggerModelDefinition,
  decodeTriggerArguments,
  projectTriggerResult,
} from "./model-trigger-facade.js";
import {
  isSidebarModelTool,
  sidebarModelDefinition,
  decodeSidebarArguments,
  projectSidebarResult,
} from "./model-sidebar-facade.js";
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
import { computerModelDocument } from "../../../../../packages/zenx-computer-plugin/src/model-contract.js";

export function hasModelToolFacade(name: string): boolean {
  return (
    isFleetModelTool(name) ||
    isBrowserModelTool(name) ||
    isTriggerModelTool(name) ||
    isSidebarModelTool(name) ||
    isComputerModelTool(name) ||
    isThreadModelTool(name) ||
    isBoardModelTool(name) ||
    isRoomModelTool(name)
  );
}
export function modelToolDefinition<T extends ModelTool>(tool: T): T {
  if (isFleetModelTool(tool.name)) return fleetModelDefinition(tool);
  tool = fleetDeviceModelDefinition(tool);
  if (isBrowserModelTool(tool.name)) return browserModelDefinition(tool);
  if (isBoardModelTool(tool.name)) return boardModelDefinition(tool);
  if (isTriggerModelTool(tool.name)) return triggerModelDefinition(tool);
  if (isSidebarModelTool(tool.name)) return sidebarModelDefinition(tool);
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
  !UI_ONLY_ROOMS.has(tool.name) && tool.name !== "zenx_board_ui";
export function modelPluginDocument(id: string, original: string): string {
  if (id === "zenx-fleet") return fleetModelDocument;
  if (id === "browser") return browserModelDocument;
  if (id === "zenx-board") return boardModelDocument;
  if (id === "computer") return computerModelDocument;
  if (id === "zenx-subagents")
    return "Create/list native child Threads with exact parent refs. fresh/fork may receive an explicit task; side-chat snapshots parent context and waits for user input, so task is not allowed. Read/send use exact ref or semantic name. Creation remains true even if title/message follow-up fails; inspect status and preserve unknown outcomes rather than replaying mutations.";
  if (id === "zenx-self-control")
    return "Manage Threads by semantic name or exact scoped ref. Read history preserves literal user/tool text, failures and unknown outcomes; selected sources are read-only. Workflow updates use immutable snapshots and native CAS. Discover models by semantic name and exact selection refs. Created/accepted is not completed work; never retry uncertain mutations automatically.";
  if (id === "zenx-rooms")
    return "Use exact scoped Room, Thread and message refs. Workspace edits use immutable snapshots and original CAS. Literal names, messages and planning notes are unchanged. Refs never grant membership, permission, delivery or completed work.";
  if (id === "zenx-triggers")
    return "Discover Trigger definitions/history with exact short refs. Notification and watched source Threads retain their exact native routes. Resume and target creation use immutable snapshots; native permissions and definition/configuration fences still run. Programs/prompts/signal names are literal. Preserve unknown delivery and failed outcomes; never infer work completion from dispatch or retry uncertain mutations automatically.";
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
};
function decode(
  name: string,
  args: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  if (isBoardModelTool(name))
    return decodeBoardArguments(name, args, refs, epoch);
  if (isTriggerModelTool(name))
    return decodeTriggerArguments(name, args, refs, epoch);
  if (isSidebarModelTool(name))
    return decodeSidebarArguments(name, args, refs, epoch);
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
  raw: ToolExecutionResult,
): Record<string, unknown> {
  if (isBoardModelTool(name))
    return projectBoardResult(result, refs, epoch, raw);
  if (isTriggerModelTool(name))
    return projectTriggerResult(name, result, args, refs, epoch);
  if (isSidebarModelTool(name))
    return projectSidebarResult(result, refs, epoch);
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
  browserConnections?: BrowserModelConnections;
  dispatch(invocation: ToolInvocation): Promise<ToolExecutionResult>;
}): Promise<
  ToolExecutionResult & { referenceBindings?: readonly ModelReferenceBinding[] }
> {
  const { invocation, epoch, references, dispatch } = options;
  if (
    (!hasModelToolFacade(invocation.name) &&
      !isFleetModelInvocation(invocation)) ||
    invocation.trustedPluginUi ||
    !invocation.threadId
  )
    return await dispatch(invocation);
  if (isFleetModelInvocation(invocation))
    return invokeFleetModelToolFacade(options);
  if (isBrowserModelTool(invocation.name))
    return invokeBrowserModelToolFacade({
      ...options,
      connections: options.browserConnections,
    });
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
  const raw = await dispatch(
    copyBrowserModelContext(args, { ...invocation, arguments: args }),
  );
  const capture = record(
    await invocation.traceOutput?.recordResult(
      raw,
      "capability-result-before-model-projection",
    ),
  );
  // The successful compact projection is the preview; raw IDs stay in the file.
  const {
    preview: _preview,
    previewTruncated: _previewTruncated,
    ...resultFile
  } = record(capture?.resultFile) ?? {};
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
    projected = project(invocation.name, result, args, refs, epoch, raw);
  } catch (error) {
    if (!(error instanceof ModelReferenceBudgetError)) throw error;
    const fallback = {
      ...raw,
      output: JSON.stringify({
        projection: "projection_unavailable",
        reason: "Compact reference publication budget exceeded",
        toolReturn: { exitCode: raw.exitCode },
        outcome: outcome(result),
        ...(capture?.resultFile ? { raw_result_file: capture.resultFile } : {}),
        safeNextStep:
          (capture?.resultFile
            ? "Read raw_result_file with shell/file tools, or read current state with a smaller scope. "
            : "Raw result file unavailable; read current state with a smaller scope. ") +
          "Do not retry a mutation merely because compact projection is unavailable.",
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
    output: JSON.stringify({
      ...projected,
      ...(capture?.resultFile ? { raw_result_file: resultFile } : {}),
    }),
  };
  if (raw.structuredContent !== undefined) {
    projectedResult.contentType = "application/json";
    projectedResult.structuredContent = asJson({
      ...projected,
      ...(capture?.resultFile ? { raw_result_file: resultFile } : {}),
    });
  }
  delete projectedResult.modelContent;
  return attach(projectedResult);
}
