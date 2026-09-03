import type {
  ThreadListEntry,
  ThreadSnapshot,
  UnavailableThreadSnapshot,
} from "../../app-server.js";
import type {
  CanonicalItem,
  ThreadMetadataItem,
  ToolCallItem,
  ToolResultItem,
} from "../../item.js";
import { previewFromUserMessage, textFromUserMessage } from "../../item.js";
import type { DerivedTurn } from "../../thread.js";
import type { NativeThreadSummary } from "../../thread-summary.js";
import { encodeModelKey } from "./model-key.js";

export interface CodexThread {
  id: string;
  sessionId: string;
  forkedFromId: null;
  parentThreadId: null;
  preview: string;
  ephemeral: false;
  isPinned: false;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  recencyAt: null;
  status:
    | { type: "idle" }
    | { type: "systemError" }
    | { type: "active"; activeFlags: [] };
  path: null;
  cwd: string;
  cliVersion: string;
  source: "appServer";
  threadSource: null;
  agentNickname: null;
  agentRole: null;
  gitInfo: null;
  name: string | null;
  turns: CodexTurn[];
}

export interface CodexTurn {
  id: string;
  items: CodexThreadItem[];
  itemsView: "full";
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: {
    message: string;
    codexErrorInfo: null;
    additionalDetails: null;
  } | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export type CodexThreadItem =
  | {
      type: "userMessage";
      id: string;
      clientId: string | null;
      content: Array<{ type: "text"; text: string; text_elements: [] }>;
      /** Durable placement anchor for a mid-turn steer. */
      deliveryAfter?: string;
    }
  | {
      type: "agentMessage";
      id: string;
      text: string;
      phase: "final_answer";
      memoryCitation: null;
    }
  | {
      type: "reasoning";
      id: string;
      summary: string[];
      content: string[];
    }
  | CodexCommandItem;

export interface CodexCommandItem {
  type: "commandExecution";
  id: string;
  pluginId: null;
  scriptPath: null;
  command: string;
  cwd: string;
  processId: null;
  source: "agent";
  status: "inProgress" | "completed" | "failed" | "declined";
  commandActions: [];
  aggregatedOutput: string | null;
  exitCode: number | null;
  durationMs: null;
  /** Zen fixed-subset extensions projected from the canonical tool call. */
  toolName?: string;
  toolArguments?: Readonly<Record<string, unknown>>;
  /** Model response whose tool batch this call belongs to. */
  modelResponseId?: string;
  callId?: string;
  parentCallId?: string;
  /** Zen fixed-subset extension; omitted for ordinary and legacy results. */
  contentType?: string;
  structuredContent?: ToolResultItem["structuredContent"];
}

export function projectThread(
  snapshot: ThreadListEntry,
  options: { includeTurns: boolean },
): CodexThread {
  if (isUnavailableThread(snapshot)) {
    return projectUnavailableThread(snapshot);
  }
  const metadata = metadataFor(snapshot.items);
  const createdAt = seconds(metadata.createdAt);
  const updatedAt = seconds(
    snapshot.items.at(-1)?.createdAt ?? metadata.createdAt,
  );
  const active = snapshot.turns.some((turn) => turn.status === "inProgress");
  return {
    id: snapshot.id,
    sessionId: snapshot.id,
    forkedFromId: null,
    parentThreadId: null,
    preview: firstUserMessagePreview(snapshot.items),
    ephemeral: false,
    isPinned: false,
    modelProvider: snapshot.providerProfileId,
    createdAt,
    updatedAt,
    recencyAt: null,
    status: active ? { type: "active", activeFlags: [] } : { type: "idle" },
    path: null,
    cwd: snapshot.cwd,
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: snapshot.name ?? null,
    turns: options.includeTurns
      ? snapshot.turns.map((turn) => projectTurn(turn, true, snapshot.cwd))
      : [],
  };
}

export function projectThreadSummary(
  summary: NativeThreadSummary,
): CodexThread {
  if (summary.status === "systemError") {
    return projectUnavailableThread({
      id: summary.threadId,
      status: "systemError",
      error: summary.error,
      archived: summary.archived,
      ...(summary.name === undefined ? {} : { name: summary.name }),
    });
  }
  return {
    id: summary.threadId,
    sessionId: summary.threadId,
    forkedFromId: null,
    parentThreadId: null,
    preview: summary.preview,
    ephemeral: false,
    isPinned: false,
    modelProvider:
      summary.currentMetadata.providerProfileId ??
      summary.currentMetadata.provider,
    createdAt: seconds(summary.createdAt),
    updatedAt: seconds(summary.updatedAt),
    recencyAt: null,
    status:
      summary.status === "active"
        ? { type: "active", activeFlags: [] }
        : { type: "idle" },
    path: null,
    cwd: summary.currentMetadata.cwd,
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: summary.name ?? null,
    turns: [],
  };
}

function isUnavailableThread(
  snapshot: ThreadListEntry,
): snapshot is UnavailableThreadSnapshot {
  return "status" in snapshot && snapshot.status === "systemError";
}

function projectUnavailableThread(
  snapshot: UnavailableThreadSnapshot,
): CodexThread {
  return {
    id: snapshot.id,
    sessionId: snapshot.id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "Thread journal could not be loaded.",
    ephemeral: false,
    isPinned: false,
    modelProvider: "",
    createdAt: 0,
    updatedAt: 0,
    recencyAt: null,
    status: { type: "systemError" },
    path: null,
    cwd: "",
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: snapshot.name ?? null,
    turns: [],
  };
}

export function projectTurn(
  turn: DerivedTurn,
  includeItems = true,
  cwd = "",
): CodexTurn {
  const started = turn.items.find((item) => item.type === "turn_started");
  const terminal = [...turn.items]
    .reverse()
    .find(
      (item) => item.type === "turn_completed" || item.type === "turn_aborted",
    );
  const failure = [...turn.items]
    .reverse()
    .find((item) => item.type === "failure");
  const startedAt = started === undefined ? null : seconds(started.createdAt);
  const completedAt =
    terminal === undefined ? null : seconds(terminal.createdAt);
  return {
    id: turn.id,
    items: includeItems ? projectItems(turn.items, cwd) : [],
    itemsView: "full",
    status: turn.status,
    error:
      failure?.type === "failure"
        ? {
            message: failure.message,
            codexErrorInfo: null,
            additionalDetails: null,
          }
        : null,
    startedAt,
    completedAt,
    durationMs:
      startedAt === null || completedAt === null
        ? null
        : Math.max(0, (completedAt - startedAt) * 1000),
  };
}

export function projectCompletedItem(
  item: CanonicalItem,
): CodexThreadItem | null {
  switch (item.type) {
    case "user_message":
      return {
        type: "userMessage",
        id: item.id,
        clientId: item.clientId ?? null,
        content: [
          { type: "text", text: textFromUserMessage(item), text_elements: [] },
        ],
        ...(item.deliveryAfter === undefined
          ? {}
          : { deliveryAfter: item.deliveryAfter }),
      };
    case "agent_message":
      return {
        type: "agentMessage",
        id: item.id,
        text: item.text,
        phase: "final_answer",
        memoryCitation: null,
      };
    case "reasoning":
      return {
        type: "reasoning",
        id: item.id,
        summary: item.summary === undefined ? [] : [item.summary],
        content:
          item.contentVisibility === "public" ? [item.reasoningContent] : [],
      };
    case "tool_call":
      return projectCommandStarted(item, "");
    case "failure":
    case "context_compaction":
    case "model_usage":
    case "thread_configuration_changed":
    case "thread_metadata":
    case "tool_result":
    case "turn_aborted":
    case "turn_completed":
    case "turn_replacement_requested":
    case "turn_started":
      return null;
  }
}

export function projectCommandStarted(
  call: ToolCallItem,
  cwd: string,
): CodexCommandItem {
  return {
    type: "commandExecution",
    id: call.id,
    pluginId: null,
    scriptPath: null,
    command:
      call.name === "shell" && typeof call.arguments.command === "string"
        ? call.arguments.command
        : call.name === "run_code" && typeof call.arguments.code === "string"
          ? call.arguments.code
          : `${call.name} ${JSON.stringify(call.arguments)}`,
    cwd,
    processId: null,
    source: "agent",
    status: "inProgress",
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
    toolName: call.name,
    toolArguments: structuredClone(call.arguments),
    callId: call.callId,
    ...(call.modelResponseId === undefined
      ? {}
      : { modelResponseId: call.modelResponseId }),
    ...(call.parentCallId === undefined
      ? {}
      : { parentCallId: call.parentCallId }),
  };
}

export function projectCommandCompleted(
  call: ToolCallItem,
  result: ToolResultItem,
  cwd: string,
): CodexCommandItem {
  const started = projectCommandStarted(call, cwd);
  return {
    ...started,
    status: commandExecutionStatus(result),
    aggregatedOutput: result.output,
    exitCode: result.exitCode,
    ...(result.contentType === undefined
      ? {}
      : {
          contentType: result.contentType,
          structuredContent: structuredClone(result.structuredContent),
        }),
  };
}

function commandExecutionStatus(
  result: ToolResultItem,
): "completed" | "failed" | "declined" {
  if (result.executionStatus !== undefined) return result.executionStatus;
  if (
    (result.exitCode === 126 &&
      result.output === "User declined this tool call.") ||
    (result.exitCode === 130 &&
      result.output === "User cancelled this tool call.")
  ) {
    return "declined";
  }
  return result.exitCode === 0 ? "completed" : "failed";
}

export function threadSettings(
  snapshot: Pick<
    ThreadSnapshot,
    | "providerProfileId"
    | "modelId"
    | "reasoningEffort"
    | "cwd"
    | "approvalPolicy"
    | "sandbox"
  >,
): Record<string, unknown> {
  return {
    model: encodeModelKey(snapshot),
    modelProvider: snapshot.providerProfileId,
    serviceTier: null,
    cwd: snapshot.cwd,
    instructionSources: [],
    approvalPolicy:
      snapshot.approvalPolicy === "never" ? "never" : "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    reasoningEffort: snapshot.reasoningEffort,
  };
}

export function threadSettingsUpdated(
  snapshot: Pick<
    ThreadSnapshot,
    | "providerProfileId"
    | "modelId"
    | "reasoningEffort"
    | "cwd"
    | "approvalPolicy"
    | "sandbox"
  >,
): Record<string, unknown> {
  return {
    approvalPolicy:
      snapshot.approvalPolicy === "never" ? "never" : "on-request",
    approvalsReviewer: "user",
    collaborationMode: {
      mode: "default",
      settings: {
        model: encodeModelKey(snapshot),
        reasoning_effort: snapshot.reasoningEffort,
      },
    },
    cwd: snapshot.cwd,
    effort: snapshot.reasoningEffort,
    model: encodeModelKey(snapshot),
    modelProvider: snapshot.providerProfileId,
    personality: null,
    sandboxPolicy: { type: "dangerFullAccess" },
    serviceTier: null,
    summary: null,
  };
}

function projectItems(
  items: readonly CanonicalItem[],
  cwd: string,
): CodexThreadItem[] {
  const output: CodexThreadItem[] = [];
  const callIndex = new Map<string, number>();
  const calls = new Map<string, ToolCallItem>();

  for (const item of items) {
    if (item.type === "tool_call") {
      calls.set(item.callId, item);
      callIndex.set(item.callId, output.length);
      output.push(projectCommandStarted(item, cwd));
      continue;
    }
    if (item.type === "tool_result") {
      const call = calls.get(item.callId);
      const index = callIndex.get(item.callId);
      if (call !== undefined && index !== undefined) {
        output[index] = projectCommandCompleted(call, item, cwd);
      }
      continue;
    }
    const projected = projectCompletedItem(item);
    if (projected !== null) {
      output.push(projected);
    }
  }
  return output;
}

function metadataFor(items: readonly CanonicalItem[]): ThreadMetadataItem {
  const metadata = [...items]
    .reverse()
    .find(
      (item): item is ThreadMetadataItem => item.type === "thread_metadata",
    );
  if (metadata === undefined) {
    throw new Error("Thread has no metadata item");
  }
  return metadata;
}

function firstUserMessagePreview(items: readonly CanonicalItem[]): string {
  const message = items.find((item) => item.type === "user_message");
  return message === undefined ? "" : previewFromUserMessage(message);
}

function seconds(timestamp: string): number {
  return Math.floor(new Date(timestamp).getTime() / 1000);
}
