import type {
  ImportedToolCallOrigin,
  ThreadImportOrigin,
} from "./thread-import.js";
import { IMPORTED_TOOL_RESULT_CONTENT_TYPE } from "./thread-import.js";
import {
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  type AttachmentRef,
} from "./attachment-ref.js";

/** Observation receipt for a copied tool call, never an executed child operation. */
export const SIDE_CHAT_TOOL_SNAPSHOT_CONTENT_TYPE =
  "zen.side-chat-tool-snapshot.v1";

/** Original UTF-8 text budget for the fixed repository instruction snapshot. */
export const MAX_WORKSPACE_INSTRUCTION_BYTES = 128 * 1024;

export interface WorkspaceInstructionFile {
  path: string;
  text: string;
}

export type ItemType =
  | "thread_metadata"
  | "thread_forked"
  | "thread_instruction"
  | "thread_deleted"
  | "thread_restored"
  | "thread_configuration_changed"
  | "context_compaction"
  | "turn_started"
  | "turn_completed"
  | "turn_aborted"
  | "turn_replacement_requested"
  | "user_message_queued"
  | "user_message_queue_cancelled"
  | "user_message_queue_edited"
  | "user_message"
  | "host_message"
  | "host_message_queued"
  | "host_message_cancelled"
  | "thread_message"
  | "thread_message_queued"
  | "thread_message_cancelled"
  | "agent_message"
  | "model_usage"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "code_state"
  | "failure";

const CANONICAL_ITEM_TYPES = {
  thread_metadata: true,
  thread_forked: true,
  thread_instruction: true,
  thread_deleted: true,
  thread_restored: true,
  thread_configuration_changed: true,
  context_compaction: true,
  turn_started: true,
  turn_completed: true,
  turn_aborted: true,
  turn_replacement_requested: true,
  user_message_queued: true,
  user_message_queue_cancelled: true,
  user_message_queue_edited: true,
  user_message: true,
  host_message: true,
  host_message_queued: true,
  host_message_cancelled: true,
  thread_message: true,
  thread_message_queued: true,
  thread_message_cancelled: true,
  agent_message: true,
  model_usage: true,
  reasoning: true,
  tool_call: true,
  tool_result: true,
  code_state: true,
  failure: true,
} as const satisfies Record<ItemType, true>;

export interface ItemBase {
  id: string;
  threadId: string;
  turnId?: string;
  createdAt: string;
  type: ItemType;
}

interface ThreadMetadataItemBase extends ItemBase {
  importedFrom?: ThreadImportOrigin;
  type: "thread_metadata";
  cwd: string;
  /** Immutable creation relation; ordinary copies do not inherit it. */
  parentThreadId?: string;
  /** Only new Threads opt in; existing journals are never retroactively loaded. */
  workspaceInstructionPolicy?: "repo-root-on-first-message";
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
}

export interface LegacyThreadMetadataItem extends ThreadMetadataItemBase {
  model: string;
  provider: string;
}

export interface ProviderThreadMetadataItem extends ThreadMetadataItemBase {
  providerProfileId: string;
  modelId: string;
  /** null preserves an intentional request for the Provider's text default. */
  reasoningEffort: string | null;
}

export type ThreadMetadataItem =
  LegacyThreadMetadataItem | ProviderThreadMetadataItem;

export interface ThreadForkedItem extends ItemBase {
  type: "thread_forked";
  sourceThreadId: string;
  sourceBoundaryItemId: string;
  /** Absent only on full-context snapshots without a source Turn. */
  sourceTurnId?: string;
  workspace: "same-directory";
  /** A full canonical snapshot, with inherited execution made inert. */
  context?: "full";
}

/** Host-authored model instruction that does not create or schedule a Turn. */
export interface ThreadInstructionItem extends ItemBase {
  type: "thread_instruction";
  text: string;
}

/** Recoverable lifecycle controls; never model input or a purge instruction. */
export interface ThreadDeletedItem extends ItemBase {
  type: "thread_deleted";
}

export interface ThreadRestoredItem extends ItemBase {
  type: "thread_restored";
  deletionItemId: string;
}

export interface CanonicalProviderSelection {
  providerProfileId: string;
  modelId: string;
  /** null means Zen did not request a Provider-specific reasoning control. */
  reasoningEffort: string | null;
}

export interface LegacyThreadConfigurationChangedItem extends ItemBase {
  type: "thread_configuration_changed";
  model: {
    from: string;
    to: string;
  };
}

export interface ProviderThreadConfigurationChangedItem extends ItemBase {
  type: "thread_configuration_changed";
  selection: {
    from: CanonicalProviderSelection;
    to: CanonicalProviderSelection;
  };
}

export interface ThreadPermissionConfiguration {
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
}
export interface ThreadPermissionsChangedItem extends ItemBase {
  type: "thread_configuration_changed";
  permissions: {
    from: ThreadPermissionConfiguration;
    to: ThreadPermissionConfiguration;
  };
}
export type ThreadConfigurationChangedItem =
  | LegacyThreadConfigurationChangedItem
  | ProviderThreadConfigurationChangedItem
  | ThreadPermissionsChangedItem;

export interface TurnStartedItem extends ItemBase {
  type: "turn_started";
  turnId: string;
  /** First-message repository snapshot; absent on later and historical Turns. */
  workspaceInstructions?: WorkspaceInstructionFile[];
  /** Frozen provider selection used by this Turn; absent on legacy Items. */
  selection?: CanonicalProviderSelection;
}

export interface TurnCompletedItem extends ItemBase {
  type: "turn_completed";
  turnId: string;
  status: "completed" | "failed";
}

export interface TurnAbortedItem extends ItemBase {
  type: "turn_aborted";
  turnId: string;
  reason: string;
}

interface TurnReplacementRequestedItemBase extends ItemBase {
  type: "turn_replacement_requested";
  sender?: ThreadMessageSender;
  turnId: string;
  successorTurnId: string;
  clientId: string;
}

export interface LegacyTurnReplacementRequestedItem extends TurnReplacementRequestedItemBase {
  text: string;
  input?: never;
}

export interface TypedTurnReplacementRequestedItem extends TurnReplacementRequestedItemBase {
  input: UserInput;
  text?: never;
}

export type TurnReplacementRequestedItem =
  LegacyTurnReplacementRequestedItem | TypedTurnReplacementRequestedItem;

export interface TextUserInputPart {
  type: "text";
  text: string;
  /** Host-loaded skill snapshot; text and source remain canonical on replay. */
  skillSource?: {
    kind: "catalog" | "instruction";
    id?: string;
    path?: string;
    sha256?: string;
  };
}

export interface ImageUserInputPart {
  type: "image";
  attachment: AttachmentRef;
}

export interface AudioUserInputPart {
  type: "audio";
  attachment: AttachmentRef;
}

export type UserInputPart =
  TextUserInputPart | ImageUserInputPart | AudioUserInputPart;
export type UserInput = readonly UserInputPart[];

interface UserMessageItemBase extends ItemBase {
  type: "user_message";
  turnId: string;
  clientId?: string;
  /**
   * Model-response item whose tool/result step must finish before this
   * same-Turn steer is presented to the next model sample.
   */
  deliveryAfter?: string;
}

/** Existing text-only journals remain readable without a rewrite. */
export interface LegacyUserMessageItem extends UserMessageItemBase {
  text: string;
  content?: never;
}

export interface MultimodalUserMessageItem extends UserMessageItemBase {
  content: UserInput;
  text?: never;
}

export type UserMessageItem = LegacyUserMessageItem | MultimodalUserMessageItem;

/** Host-captured provenance. Neither sender identity nor authority comes from message text. */
export interface ThreadMessageSender {
  /** Present only when the receiving Host captured an authenticated Fleet peer. */
  deviceId?: string;
  threadId: string;
  /** Host-captured display snapshot only; never an identity or authorization key. */
  threadName?: string;
  /** Local canonical Turn; remote peers cannot assert a local Turn. */
  turnId?: string;
  toolCallId: string;
  callId: string;
}

/** Host-authored wakeup; source IDs are provenance, never human authority. */
export interface HostWakeupInput {
  clientId: string;
  source: "bootstrap" | "trigger" | "room";
  sourceId?: string;
  text: string;
}
export interface HostMessageItem extends ItemBase, HostWakeupInput {
  type: "host_message";
  sender: "host";
  turnId: string;
  mode: "start" | "steer";
  deliveryAfter?: string;
}
export interface QueuedHostMessageItem extends ItemBase, HostWakeupInput {
  type: "host_message_queued";
  sender: "host";
  input: UserInput;
  /** Whether this input may join an already admitted Turn. */
  intent: "steer" | "queue";
  deliveryMode: "batch-next";
}
export interface HostMessageCancelledItem extends ItemBase {
  type: "host_message_cancelled";
  queuedItemId: string;
  clientId: string;
}

export interface ThreadMessageInput {
  sender: Pick<ThreadMessageSender, "threadId" | "toolCallId" | "callId">;
  text: string;
  messageType?: "guidance" | "follow_up" | "replacement";
}

export interface ThreadMessageItem extends ItemBase {
  type: "thread_message";
  mode: "steer" | "batch-next" | "replace";
  messageType: "guidance" | "follow_up" | "replacement";
  turnId: string;
  clientId: string;
  sender: ThreadMessageSender;
  content: UserInput;
  deliveryAfter?: string;
}

export interface QueuedThreadMessageItem extends ItemBase {
  type: "thread_message_queued";
  messageType: "guidance" | "follow_up" | "replacement";
  clientId: string;
  sender: ThreadMessageSender;
  input: UserInput;
  deliveryMode: "batch-next";
}

export interface ThreadMessageCancelledItem extends ItemBase {
  type: "thread_message_cancelled";
  queuedItemId: string;
  clientId: string;
}

export type QueuedInputItem =
  QueuedUserMessageItem | QueuedThreadMessageItem | QueuedHostMessageItem;
export type DeliveredInputItem =
  UserMessageItem | ThreadMessageItem | HostMessageItem;
export interface InitialInputMessage {
  hostInput?: HostWakeupInput;
  input: UserInput;
  clientId: string;
  sender?: ThreadMessageSender;
  messageType?: "guidance" | "follow_up" | "replacement";
  mode?: "batch-next" | "replace";
}

export interface AgentMessageItem extends ItemBase {
  type: "agent_message";
  turnId: string;
  text: string;
  /** Observed partial text from an interrupted model sample; never replayed. */
  incomplete?: true;
}

/** Provider-reported usage for one stable model response. */
export interface ModelUsageItem extends ItemBase {
  type: "model_usage";
  turnId: string;
  modelResponseId: string;
  /** Total input tokens, including cached input. */
  inputTokens: number;
  /** Cached subset of inputTokens; absent when the Provider did not report it. */
  cachedInputTokens?: number;
  outputTokens: number;
  /** Reasoning subset of outputTokens, when reported separately. */
  reasoningOutputTokens?: number;
}

export type ReasoningItem =
  | (ItemBase & {
      type: "reasoning";
      turnId: string;
      reasoningContent: string;
      /** Observed public trace from an interrupted model sample; never replayed. */
      incomplete?: true;
      summary?: string;
      contentVisibility: "public" | "opaque";
      /** Stable provider identity retained only when its adapter requires replay. */
      providerItemId?: string;
    })
  /** Existing summary-only journals remain readable without a rewrite. */
  | (ItemBase & {
      type: "reasoning";
      turnId: string;
      summary: string;
      reasoningContent?: never;
      contentVisibility?: never;
      providerItemId?: never;
      incomplete?: never;
    });

export interface ToolCallItem extends ItemBase {
  type: "tool_call";
  turnId: string;
  callId: string;
  /** Stable id of the model response that produced this call. */
  modelResponseId?: string;
  /** Immediate composite-tool parent; absent on legacy and model-authored calls. */
  parentCallId?: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Imported history only; never a registered local tool or execution grant. */
  imported?: ImportedToolCallOrigin;
}

export interface ToolResultItem extends ItemBase {
  type: "tool_result";
  turnId: string;
  callId: string;
  output: string;
  /** null is reserved for imported historical observations with unknown outcome. */
  exitCode: number | null;
  /** Runtime-owned execution fact; absent on legacy Items. */
  executionStatus?: "completed" | "failed" | "declined";
  /** Optional provider-neutral data for product rendering; absent on legacy Items. */
  contentType?: string;
  structuredContent?: JsonValue;
  /** Provider-neutral content returned to the model by a trusted builtin tool. */
  modelContent?: UserInput;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export interface FailureItem extends ItemBase {
  type: "failure";
  turnId: string;
  code: string;
  message: string;
}

interface ContextCompactionItemBase extends ItemBase {
  /** Rules reread when this compaction was committed; [] clears prior rules. */
  workspaceInstructions?: WorkspaceInstructionFile[];
  type: "context_compaction";
  /** Legacy journals omit this; current writers identify who requested reset. */
  initiator?: "human" | "automatic" | "agent";
  coveredThroughItemId: string;
  summary: string;
  retainedItemIds: string[];
  /** Legacy Items have no flag and retain their original projection unchanged. */
  includeOriginalReference?: boolean;
  algorithmVersion: string;
}

/** Existing journals omit provenance; current generated writers identify it. */
export interface ProviderGeneratedContextCompactionItem extends ContextCompactionItemBase {
  provenance?: "provider_generated";
  turnId?: never;
  callId?: never;
  sourceModelResponseId?: never;
  providerProfileId: string;
  modelId: string;
  reasoningEffort: string | null;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface AgenticContextCompactionItem extends ContextCompactionItemBase {
  provenance: "agentic";
  turnId: string;
  callId: string;
  sourceModelResponseId: string;
  providerProfileId?: never;
  modelId?: never;
  reasoningEffort?: never;
  tokenUsage?: never;
}

export type ContextCompactionItem =
  ProviderGeneratedContextCompactionItem | AgenticContextCompactionItem;

export interface QueuedUserMessageItem extends ItemBase {
  type: "user_message_queued";
  clientId: string;
  input: UserInput;
  /** Explicit native manual choice; absent preserves legacy FIFO turns. */
  deliveryMode?: "batch-next";
}

/** A replacement input revision; the initial queued Item owns identity/order. */
export interface QueuedUserMessageEditedItem extends ItemBase {
  type: "user_message_queue_edited";
  queuedItemId: string;
  clientId: string;
  editId: string;
  revision: number;
  input: UserInput;
}

/** A completed cancellation fact; the original queued input stays in history. */
export interface QueuedUserMessageCancelledItem extends ItemBase {
  type: "user_message_queue_cancelled";
  queuedItemId: string;
  clientId: string;
}

export interface CodeStateItem extends ItemBase {
  type: "code_state";
  turnId: string;
  callId: string;
  key: string;
  value: JsonValue;
}

export type CanonicalItem =
  | HostMessageItem
  | QueuedHostMessageItem
  | HostMessageCancelledItem
  | ThreadMessageItem
  | QueuedThreadMessageItem
  | ThreadMessageCancelledItem
  | CodeStateItem
  | QueuedUserMessageItem
  | QueuedUserMessageCancelledItem
  | QueuedUserMessageEditedItem
  | ThreadMetadataItem
  | ThreadForkedItem
  | ThreadInstructionItem
  | ThreadDeletedItem
  | ThreadRestoredItem
  | ThreadConfigurationChangedItem
  | ContextCompactionItem
  | TurnStartedItem
  | TurnCompletedItem
  | TurnAbortedItem
  | TurnReplacementRequestedItem
  | UserMessageItem
  | AgentMessageItem
  | ModelUsageItem
  | ReasoningItem
  | ToolCallItem
  | ToolResultItem
  | FailureItem;

export type SandboxMode =
  "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "always" | "never";
export type ApprovalDecision =
  "accept" | "acceptForSession" | "decline" | "cancel";

export function normalizeUserInput(input: string | UserInput): UserInput {
  const normalized: UserInput =
    typeof input === "string" ? [{ type: "text", text: input }] : input;
  if (normalized.length === 0) {
    throw new Error("User input cannot be empty");
  }
  for (const part of normalized) {
    if (part.type === "text") {
      if (part.text.length === 0) throw new Error("Text input cannot be empty");
    } else if (part.attachment.type !== "attachment") {
      throw new Error("Media input must contain an AttachmentRef");
    }
  }
  return structuredClone(normalized);
}

export function contentFromUserMessage(item: UserMessageItem): UserInput {
  return item.content ?? [{ type: "text", text: item.text }];
}

export function textFromUserInput(input: UserInput): string {
  return input
    .filter((part): part is TextUserInputPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function textFromUserMessage(item: UserMessageItem): string {
  return item.text ?? textFromUserInput(item.content);
}

export function previewFromUserInput(input: UserInput): string {
  const text = textFromUserInput(input);
  return text.length > 0
    ? text
    : input.some((part) => part.type === "image")
      ? "[Image]"
      : input.some((part) => part.type === "audio")
        ? "[Audio]"
        : "";
}

export function previewFromUserMessage(item: UserMessageItem): string {
  return item.text ?? previewFromUserInput(item.content);
}

export function sameUserInput(left: UserInput, right: UserInput): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => {
      const candidate = right[index];
      if (candidate === undefined || part.type !== candidate.type) return false;
      if (part.type === "text") {
        return candidate.type === "text" && part.text === candidate.text;
      }
      return (
        candidate.type !== "text" &&
        part.attachment.sha256 === candidate.attachment.sha256 &&
        part.attachment.mediaType === candidate.attachment.mediaType &&
        part.attachment.byteLength === candidate.attachment.byteLength &&
        part.attachment.width === candidate.attachment.width &&
        part.attachment.height === candidate.attachment.height
      );
    })
  );
}

/** Validate one parsed JSON value at the journal trust boundary. */
export function decodeCanonicalItem(value: unknown): CanonicalItem {
  const item = requireRecord(value, "Item");
  requireNonEmptyString(item.id, "Item.id");
  requireNonEmptyString(item.threadId, "Item.threadId");
  requireTimestamp(item.createdAt, "Item.createdAt");
  const rawType = requireNonEmptyString(item.type, "Item.type");
  if (!hasOwn(CANONICAL_ITEM_TYPES, rawType)) {
    throw new Error(`Unknown canonical Item type: ${rawType}`);
  }
  const type = rawType as ItemType;

  if (type === "turn_started" || type === "context_compaction") {
    if (item.workspaceInstructions !== undefined) {
      if (!Array.isArray(item.workspaceInstructions)) {
        throw new Error("workspaceInstructions must be an array");
      }
      let instructionBytes = 0;
      for (const entry of item.workspaceInstructions) {
        const file = requireRecord(entry, "workspace instruction file");
        requireNonEmptyString(file.path, "workspace instruction path");
        if (typeof file.text !== "string") {
          throw new Error("workspace instruction text must be a string");
        }
        instructionBytes += Buffer.byteLength(file.text, "utf8");
        if (instructionBytes > MAX_WORKSPACE_INSTRUCTION_BYTES) {
          throw new Error("Snapshot exceeds the workspace instruction budget");
        }
      }
    }
  }

  switch (type) {
    case "thread_metadata":
      requireNoTurnId(item);
      if (item.importedFrom !== undefined) {
        const origin = requireRecord(item.importedFrom, "importedFrom");
        for (const key of [
          "format",
          "sourceId",
          "sourceVersion",
          "sourceCwd",
          "sha256",
        ])
          requireNonEmptyString(origin[key], `importedFrom.${key}`);
        requireOptionalNonEmptyString(
          origin.sourceProvider,
          "importedFrom.sourceProvider",
        );
        requireOptionalNonEmptyString(
          origin.sourceModel,
          "importedFrom.sourceModel",
        );
        if (!/^[a-f0-9]{64}$/u.test(String(origin.sha256)))
          throw new Error("Invalid import digest");
        if (origin.contextBasis !== undefined) {
          const basis = requireRecord(
            origin.contextBasis,
            "importedFrom.contextBasis",
          );
          requireEnum(
            basis.kind,
            ["replacement-history", "summary-checkpoint"],
            "importedFrom.contextBasis.kind",
          );
          requireSafeInteger(
            basis.sourceLine,
            "importedFrom.contextBasis.sourceLine",
          );
          requireSafeInteger(
            basis.earlierRecords,
            "importedFrom.contextBasis.earlierRecords",
          );
          if (Number(basis.sourceLine) < 2 || Number(basis.earlierRecords) < 0)
            throw new Error("Invalid import checkpoint provenance");
        }
        requireSafeInteger(
          origin.historyItemCount,
          "importedFrom.historyItemCount",
        );
        if (
          Number(origin.historyItemCount) < 1 ||
          !Array.isArray(origin.exclusions) ||
          origin.exclusions.some((value) => typeof value !== "string")
        )
          throw new Error("Invalid import provenance");
      }
      requireNonEmptyString(item.cwd, "thread_metadata.cwd");
      if (item.parentThreadId !== undefined) {
        requireNonEmptyString(
          item.parentThreadId,
          "thread_metadata.parentThreadId",
        );
        if (item.parentThreadId === item.threadId)
          throw new Error("Thread cannot be its own parent");
      }
      if (item.workspaceInstructionPolicy !== undefined) {
        requireEnum(
          item.workspaceInstructionPolicy,
          ["repo-root-on-first-message"],
          "thread_metadata.workspaceInstructionPolicy",
        );
      }
      requireEnum(
        item.sandbox,
        ["read-only", "workspace-write", "danger-full-access"],
        "thread_metadata.sandbox",
      );
      requireEnum(
        item.approvalPolicy,
        ["always", "never"],
        "thread_metadata.approvalPolicy",
      );
      requireExactlyOneShape(
        item,
        ["model", "provider"],
        ["providerProfileId", "modelId", "reasoningEffort"],
        "thread_metadata",
      );
      if (hasOwn(item, "model")) {
        requireNonEmptyString(item.model, "thread_metadata.model");
        requireNonEmptyString(item.provider, "thread_metadata.provider");
      } else {
        validateSelection(item, "thread_metadata");
      }
      break;
    case "thread_forked":
      requireNoTurnId(item);
      requireNonEmptyString(
        item.sourceThreadId,
        "thread_forked.sourceThreadId",
      );
      requireNonEmptyString(
        item.sourceBoundaryItemId,
        "thread_forked.sourceBoundaryItemId",
      );
      if (item.context !== undefined)
        requireEnum(item.context, ["full"], "thread_forked.context");
      if (item.context === "full")
        requireOptionalNonEmptyString(
          item.sourceTurnId,
          "thread_forked.sourceTurnId",
        );
      else
        requireNonEmptyString(item.sourceTurnId, "thread_forked.sourceTurnId");
      requireEnum(
        item.workspace,
        ["same-directory"],
        "thread_forked.workspace",
      );
      break;
    case "thread_deleted":
      requireNoTurnId(item);
      break;
    case "thread_restored":
      requireNoTurnId(item);
      requireNonEmptyString(
        item.deletionItemId,
        "thread_restored.deletionItemId",
      );
      break;
    case "thread_instruction":
      requireNoTurnId(item);
      requireNonEmptyString(item.text, "thread_instruction.text");
      break;
    case "thread_configuration_changed":
      requireNoTurnId(item);
      if (hasOwn(item, "permissions")) {
        if (hasOwn(item, "model") || hasOwn(item, "selection"))
          throw new Error("Permission changes cannot include model selection");
        const change = requireRecord(item.permissions, "permissions");
        for (const key of ["from", "to"]) {
          const value = requireRecord(change[key], `permissions.${key}`);
          requireEnum(
            value.sandbox,
            ["read-only", "workspace-write", "danger-full-access"],
            "permissions.sandbox",
          );
          requireEnum(
            value.approvalPolicy,
            ["always", "never"],
            "permissions.approvalPolicy",
          );
        }
        break;
      }
      requireExactlyOneShape(
        item,
        ["model"],
        ["selection"],
        "thread_configuration_changed",
      );
      if (hasOwn(item, "model")) {
        const model = requireRecord(
          item.model,
          "thread_configuration_changed.model",
        );
        requireNonEmptyString(
          model.from,
          "thread_configuration_changed.model.from",
        );
        requireNonEmptyString(
          model.to,
          "thread_configuration_changed.model.to",
        );
      } else {
        const selection = requireRecord(
          item.selection,
          "thread_configuration_changed.selection",
        );
        validateSelection(
          requireRecord(
            selection.from,
            "thread_configuration_changed.selection.from",
          ),
          "thread_configuration_changed.selection.from",
        );
        validateSelection(
          requireRecord(
            selection.to,
            "thread_configuration_changed.selection.to",
          ),
          "thread_configuration_changed.selection.to",
        );
      }
      break;
    case "context_compaction": {
      if (
        item.initiator !== undefined &&
        item.initiator !== "human" &&
        item.initiator !== "automatic" &&
        item.initiator !== "agent"
      ) {
        throw new Error("context_compaction.initiator is invalid");
      }
      requireNonEmptyString(
        item.coveredThroughItemId,
        "context_compaction.coveredThroughItemId",
      );
      requireNonEmptyString(item.summary, "context_compaction.summary");
      requireNonEmptyString(
        item.algorithmVersion,
        "context_compaction.algorithmVersion",
      );
      requireStringArray(
        item.retainedItemIds,
        "context_compaction.retainedItemIds",
      );
      if (
        item.includeOriginalReference !== undefined &&
        typeof item.includeOriginalReference !== "boolean"
      ) {
        throw new Error(
          "context_compaction.includeOriginalReference must be a boolean",
        );
      }
      if (item.provenance === "agentic") {
        requireTurnId(item, type);
        requireNonEmptyString(item.callId, "context_compaction.callId");
        requireNonEmptyString(
          item.sourceModelResponseId,
          "context_compaction.sourceModelResponseId",
        );
        rejectPresent(
          item,
          ["providerProfileId", "modelId", "reasoningEffort", "tokenUsage"],
          type,
        );
      } else {
        if (
          item.provenance !== undefined &&
          item.provenance !== "provider_generated"
        ) {
          throw new Error(
            "context_compaction.provenance has an unsupported value",
          );
        }
        requireNoTurnId(item);
        requireNonEmptyString(
          item.providerProfileId,
          "context_compaction.providerProfileId",
        );
        requireNonEmptyString(item.modelId, "context_compaction.modelId");
        requireReasoningEffort(
          item.reasoningEffort,
          "context_compaction.reasoningEffort",
        );
        rejectPresent(item, ["callId", "sourceModelResponseId"], type);
        const usage = requireRecord(
          item.tokenUsage,
          "context_compaction.tokenUsage",
        );
        requireTokenCount(
          usage.inputTokens,
          "context_compaction.tokenUsage.inputTokens",
        );
        requireTokenCount(
          usage.outputTokens,
          "context_compaction.tokenUsage.outputTokens",
        );
      }
      break;
    }
    case "turn_started":
      requireTurnId(item, type);
      if (item.selection !== undefined) {
        validateSelection(
          requireRecord(item.selection, "turn_started.selection"),
          "turn_started.selection",
        );
      }
      break;
    case "turn_completed":
      requireTurnId(item, type);
      requireEnum(
        item.status,
        ["completed", "failed"],
        "turn_completed.status",
      );
      break;
    case "turn_aborted":
      requireTurnId(item, type);
      requireNonEmptyString(item.reason, "turn_aborted.reason");
      break;
    case "turn_replacement_requested":
      if (item.sender !== undefined) {
        validateThreadMessageSender(item.sender, `${type}.sender`);
      }
      requireTurnId(item, type);
      requireNonEmptyString(item.successorTurnId, `${type}.successorTurnId`);
      requireNonEmptyString(item.clientId, `${type}.clientId`);
      requireExactlyOneShape(item, ["text"], ["input"], type);
      if (hasOwn(item, "text"))
        requireNonEmptyString(item.text, `${type}.text`);
      else validateUserInput(item.input, `${type}.input`);
      break;
    case "host_message":
    case "host_message_queued":
      if (type === "host_message") requireTurnId(item, type);
      else requireNoTurnId(item);
      requireEnum(item.sender, ["host"], `${type}.sender`);
      requireEnum(
        item.source,
        ["bootstrap", "trigger", "room"],
        `${type}.source`,
      );
      requireNonEmptyString(item.clientId, `${type}.clientId`);
      requireNonEmptyString(item.text, `${type}.text`);
      if (item.source !== "bootstrap")
        requireNonEmptyString(item.sourceId, `${type}.sourceId`);
      else requireOptionalNonEmptyString(item.sourceId, `${type}.sourceId`);
      if (type === "host_message") {
        requireEnum(item.mode, ["start", "steer"], `${type}.mode`);
        requireOptionalNonEmptyString(
          item.deliveryAfter,
          `${type}.deliveryAfter`,
        );
      } else {
        requireEnum(item.intent, ["steer", "queue"], `${type}.intent`);
        requireEnum(item.deliveryMode, ["batch-next"], `${type}.deliveryMode`);
        validateUserInput(item.input, `${type}.input`);
        if (
          JSON.stringify(item.input) !==
          JSON.stringify([{ type: "text", text: item.text }])
        )
          throw new Error(`${type}.input must match Host text`);
      }
      break;
    case "thread_message":
    case "thread_message_queued": {
      if (type === "thread_message") requireTurnId(item, type);
      else requireNoTurnId(item);
      requireNonEmptyString(item.clientId, `${type}.clientId`);
      requireEnum(
        item.messageType,
        ["guidance", "follow_up", "replacement"],
        `${type}.messageType`,
      );
      if (type === "thread_message")
        requireEnum(
          item.mode,
          ["steer", "batch-next", "replace"],
          `${type}.mode`,
        );
      validateThreadMessageSender(item.sender, `${type}.sender`);
      if (type === "thread_message") {
        validateUserInput(item.content, `${type}.content`);
        requireOptionalNonEmptyString(
          item.deliveryAfter,
          `${type}.deliveryAfter`,
        );
      } else {
        validateUserInput(item.input, `${type}.input`);
        requireEnum(item.deliveryMode, ["batch-next"], `${type}.deliveryMode`);
      }
      break;
    }
    case "user_message_queued":
      requireNonEmptyString(item.clientId, `${type}.clientId`);
      validateUserInput(item.input, `${type}.input`);
      break;
    case "user_message_queue_edited":
      requireNoTurnId(item);
      requireNonEmptyString(item.queuedItemId, `${type}.queuedItemId`);
      requireNonEmptyString(item.clientId, `${type}.clientId`);
      requireNonEmptyString(item.editId, `${type}.editId`);
      requireSafeInteger(item.revision, `${type}.revision`);
      if ((item.revision as number) < 1)
        throw new Error(`${type}.revision must be positive`);
      validateUserInput(item.input, `${type}.input`);
      break;
    case "host_message_cancelled":
    case "thread_message_cancelled":
    case "user_message_queue_cancelled":
      requireNoTurnId(item);
      requireNonEmptyString(item.queuedItemId, `${type}.queuedItemId`);
      requireNonEmptyString(item.clientId, `${type}.clientId`);
      break;
    case "user_message":
      requireTurnId(item, type);
      requireOptionalNonEmptyString(item.clientId, `${type}.clientId`);
      requireOptionalNonEmptyString(
        item.deliveryAfter,
        `${type}.deliveryAfter`,
      );
      requireExactlyOneShape(item, ["text"], ["content"], type);
      if (hasOwn(item, "text"))
        requireNonEmptyString(item.text, `${type}.text`);
      else validateUserInput(item.content, `${type}.content`);
      break;
    case "agent_message":
      requireTurnId(item, type);
      requireString(item.text, `${type}.text`);
      if (item.incomplete !== undefined && item.incomplete !== true) {
        throw new Error("agent_message.incomplete must be true when present");
      }
      break;
    case "model_usage":
      requireTurnId(item, type);
      requireNonEmptyString(item.modelResponseId, `${type}.modelResponseId`);
      requireTokenCount(item.inputTokens, `${type}.inputTokens`);
      requireOptionalTokenCount(
        item.cachedInputTokens,
        `${type}.cachedInputTokens`,
      );
      requireTokenCount(item.outputTokens, `${type}.outputTokens`);
      requireOptionalTokenCount(
        item.reasoningOutputTokens,
        `${type}.reasoningOutputTokens`,
      );
      break;
    case "reasoning":
      requireTurnId(item, type);
      if (item.incomplete !== undefined && item.incomplete !== true) {
        throw new Error("reasoning.incomplete must be true when present");
      }
      if (hasOwn(item, "reasoningContent")) {
        requireString(item.reasoningContent, `${type}.reasoningContent`);
        requireOptionalString(item.summary, `${type}.summary`);
        requireEnum(
          item.contentVisibility,
          ["public", "opaque"],
          `${type}.contentVisibility`,
        );
        requireOptionalNonEmptyString(
          item.providerItemId,
          `${type}.providerItemId`,
        );
      } else {
        requireString(item.summary, `${type}.summary`);
        rejectPresent(
          item,
          ["contentVisibility", "providerItemId", "incomplete"],
          type,
        );
      }
      break;
    case "tool_call":
      requireTurnId(item, type);
      requireNonEmptyString(item.callId, `${type}.callId`);
      requireOptionalNonEmptyString(
        item.modelResponseId,
        `${type}.modelResponseId`,
      );
      requireOptionalNonEmptyString(item.parentCallId, `${type}.parentCallId`);
      requireNonEmptyString(item.name, `${type}.name`);
      requireRecord(item.arguments, `${type}.arguments`);
      if (item.imported !== undefined) {
        requireRecord(item.imported, `${type}.imported`);
        const origin = item.imported as Record<string, unknown>;
        requireEnum(
          origin.inputFormat,
          ["json", "text"],
          `${type}.imported.inputFormat`,
        );
        requireOptionalNonEmptyString(
          origin.namespace,
          `${type}.imported.namespace`,
        );
        if (origin.inputFormat === "text") {
          const args = item.arguments as Record<string, unknown>;
          requireString(args.input, `${type}.arguments.input`);
          if (Object.keys(args).some((key) => key !== "input"))
            throw new Error(
              "Historical text calls require exactly their original input",
            );
        }
        rejectPresent(item, ["parentCallId", "modelResponseId"], type);
      }
      break;
    case "tool_result": {
      requireTurnId(item, type);
      requireNonEmptyString(item.callId, `${type}.callId`);
      requireString(item.output, `${type}.output`);
      if (item.exitCode === null) {
        if (
          item.contentType !== IMPORTED_TOOL_RESULT_CONTENT_TYPE ||
          item.executionStatus !== undefined
        )
          throw new Error(
            "Unknown exit status requires an imported historical result",
          );
      } else requireSafeInteger(item.exitCode, `${type}.exitCode`);
      if (item.executionStatus !== undefined) {
        requireEnum(
          item.executionStatus,
          ["completed", "failed", "declined"],
          `${type}.executionStatus`,
        );
      }
      const hasContentType = item.contentType !== undefined;
      const hasStructuredContent = item.structuredContent !== undefined;
      if (hasContentType !== hasStructuredContent) {
        throw new Error(
          `${type} requires contentType and structuredContent together`,
        );
      }
      if (hasContentType) {
        requireNonEmptyString(item.contentType, `${type}.contentType`);
        validateJsonValue(item.structuredContent, `${type}.structuredContent`);
      }
      if (item.modelContent !== undefined) {
        validateUserInput(item.modelContent, `${type}.modelContent`);
      }
      break;
    }
    case "code_state":
      requireTurnId(item, type);
      requireNonEmptyString(item.callId, `${type}.callId`);
      requireNonEmptyString(item.key, `${type}.key`);
      validateJsonValue(item.value, `${type}.value`);
      break;
    case "failure":
      requireTurnId(item, type);
      requireNonEmptyString(item.code, `${type}.code`);
      requireString(item.message, `${type}.message`);
      break;
    default:
      return unreachableItemType(type);
  }
  return item as unknown as CanonicalItem;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function requireNonEmptyString(value: unknown, name: string): string {
  const result = requireString(value, name);
  if (result.length === 0) throw new Error(`${name} must not be empty`);
  return result;
}

function requireOptionalString(value: unknown, name: string): void {
  if (value !== undefined) requireString(value, name);
}

function requireOptionalNonEmptyString(value: unknown, name: string): void {
  if (value !== undefined) requireNonEmptyString(value, name);
}

function requireTimestamp(value: unknown, name: string): void {
  const timestamp = requireNonEmptyString(value, name);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${name} must be a valid timestamp`);
  }
}

function requireTurnId(item: Record<string, unknown>, type: string): void {
  requireNonEmptyString(item.turnId, `${type}.turnId`);
}

function requireNoTurnId(item: Record<string, unknown>): void {
  if (hasOwn(item, "turnId"))
    throw new Error(`${String(item.type)} must not have turnId`);
}

function requireEnum(
  value: unknown,
  allowed: readonly string[],
  name: string,
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${name} has an unsupported value`);
  }
}

function requireSafeInteger(value: unknown, name: string): void {
  if (!Number.isSafeInteger(value))
    throw new Error(`${name} must be a safe integer`);
}

function requireTokenCount(value: unknown, name: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function requireOptionalTokenCount(value: unknown, name: string): void {
  if (value !== undefined) requireTokenCount(value, name);
}

function requireStringArray(value: unknown, name: string): void {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  for (const entry of value) requireNonEmptyString(entry, `${name} entry`);
}

function validateSelection(value: Record<string, unknown>, name: string): void {
  requireNonEmptyString(value.providerProfileId, `${name}.providerProfileId`);
  requireNonEmptyString(value.modelId, `${name}.modelId`);
  requireReasoningEffort(value.reasoningEffort, `${name}.reasoningEffort`);
}

function requireReasoningEffort(value: unknown, name: string): void {
  if (value === null) return;
  requireNonEmptyString(value, name);
}

export function validateUserInput(value: unknown, name: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  for (const [index, rawPart] of value.entries()) {
    const part = requireRecord(rawPart, `${name}[${String(index)}]`);
    if (part.type === "text") {
      requireNonEmptyString(part.text, `${name}[${String(index)}].text`);
      if (part.skillSource !== undefined) {
        const source = requireRecord(part.skillSource, "skillSource");
        requireEnum(
          source.kind,
          ["catalog", "instruction"],
          "skillSource.kind",
        );
        if (source.kind === "instruction") {
          requireNonEmptyString(source.id, "skillSource.id");
          requireNonEmptyString(source.path, "skillSource.path");
          const hash = requireNonEmptyString(
            source.sha256,
            "skillSource.sha256",
          );
          if (!/^[a-f0-9]{64}$/u.test(hash))
            throw new Error("Invalid Skill source hash");
        }
      }
    } else if (part.type === "image" || part.type === "audio") {
      validateAttachmentRef(
        part.attachment,
        `${name}[${String(index)}].attachment`,
        part.type,
      );
    } else {
      throw new Error(`${name}[${String(index)}] has an unsupported type`);
    }
  }
}

function validateAttachmentRef(
  value: unknown,
  name: string,
  kind: "image" | "audio",
): void {
  const ref = requireRecord(value, name);
  requireEnum(ref.type, ["attachment"], `${name}.type`);
  const sha256 = requireNonEmptyString(ref.sha256, `${name}.sha256`);
  if (!/^[a-f0-9]{64}$/u.test(sha256))
    throw new Error(`${name}.sha256 is invalid`);
  requireEnum(
    ref.mediaType,
    kind === "image"
      ? ["image/png", "image/jpeg", "image/gif", "image/webp"]
      : ["audio/wav", "audio/mpeg"],
    `${name}.mediaType`,
  );
  requireSafeInteger(ref.byteLength, `${name}.byteLength`);
  if (
    (ref.byteLength as number) <= 0 ||
    (ref.byteLength as number) >
      (kind === "image" ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES)
  ) {
    throw new Error(`${name}.byteLength is outside the supported range`);
  }
  if (kind === "audio") {
    if (ref.width !== undefined || ref.height !== undefined)
      throw new Error(`${name} audio must not have image dimensions`);
    return;
  }
  for (const dimension of ["width", "height"] as const) {
    requireSafeInteger(ref[dimension], `${name}.${dimension}`);
    if ((ref[dimension] as number) <= 0)
      throw new Error(`${name}.${dimension} must be positive`);
    if ((ref[dimension] as number) > MAX_IMAGE_DIMENSION) {
      throw new Error(`${name}.${dimension} exceeds the supported limit`);
    }
  }
  if ((ref.width as number) * (ref.height as number) > MAX_IMAGE_PIXELS) {
    throw new Error(`${name} exceeds the supported pixel limit`);
  }
}

function validateJsonValue(value: unknown, name: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(`${name} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateJsonValue(entry, `${name}[${String(index)}]`),
    );
    return;
  }
  const record = requireRecord(value, name);
  for (const [key, entry] of Object.entries(record))
    validateJsonValue(entry, `${name}.${key}`);
}

function requireExactlyOneShape(
  item: Record<string, unknown>,
  leftKeys: readonly string[],
  rightKeys: readonly string[],
  name: string,
): void {
  const left = leftKeys.every((key) => hasOwn(item, key));
  const right = rightKeys.every((key) => hasOwn(item, key));
  if (left === right)
    throw new Error(`${name} must use exactly one supported shape`);
  rejectPresent(item, left ? rightKeys : leftKeys, name);
}

function rejectPresent(
  item: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  if (keys.some((key) => hasOwn(item, key))) {
    throw new Error(`${name} mixes incompatible canonical shapes`);
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function unreachableItemType(value: never): never {
  throw new Error(`Unknown canonical Item type: ${String(value)}`);
}

function validateThreadMessageSender(value: unknown, label: string): void {
  const sender = requireRecord(value, label);
  requireOptionalNonEmptyString(sender.threadName, `${label}.threadName`);
  for (const field of ["threadId", "toolCallId", "callId"])
    requireNonEmptyString(sender[field], `${label}.${field}`);
  if (sender.deviceId === undefined)
    requireNonEmptyString(sender.turnId, `${label}.turnId`);
  else {
    requireNonEmptyString(sender.deviceId, `${label}.deviceId`);
    if (sender.turnId !== undefined)
      throw new Error("Remote sender cannot assert a local Turn identity");
  }
}
