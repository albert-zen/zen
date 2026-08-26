import type { AttachmentRef } from "./attachment.js";

export type ItemType =
  | "thread_metadata"
  | "thread_configuration_changed"
  | "context_compaction"
  | "turn_started"
  | "turn_completed"
  | "turn_aborted"
  | "turn_replacement_requested"
  | "user_message"
  | "agent_message"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "failure";

export interface ItemBase {
  id: string;
  threadId: string;
  turnId?: string;
  createdAt: string;
  type: ItemType;
}

interface ThreadMetadataItemBase extends ItemBase {
  type: "thread_metadata";
  cwd: string;
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
  reasoningEffort: string;
}

export type ThreadMetadataItem =
  LegacyThreadMetadataItem | ProviderThreadMetadataItem;

export interface CanonicalProviderSelection {
  providerProfileId: string;
  modelId: string;
  reasoningEffort: string;
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

export type ThreadConfigurationChangedItem =
  LegacyThreadConfigurationChangedItem | ProviderThreadConfigurationChangedItem;

export interface TurnStartedItem extends ItemBase {
  type: "turn_started";
  turnId: string;
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
}

export interface ImageUserInputPart {
  type: "image";
  attachment: AttachmentRef;
}

export type UserInputPart = TextUserInputPart | ImageUserInputPart;
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

export interface AgentMessageItem extends ItemBase {
  type: "agent_message";
  turnId: string;
  text: string;
}

export interface ReasoningItem extends ItemBase {
  type: "reasoning";
  turnId: string;
  summary: string;
  /** Provider replay fields; absent on legacy or summary-only reasoning. */
  providerItemId?: string;
  encryptedContent?: string;
  providerSummary?: Array<{ type: "summary_text"; text: string }>;
}

export interface ToolCallItem extends ItemBase {
  type: "tool_call";
  turnId: string;
  callId: string;
  /** Stable id of the model response that produced this call. */
  modelResponseId?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultItem extends ItemBase {
  type: "tool_result";
  turnId: string;
  callId: string;
  output: string;
  exitCode: number;
  /** Optional provider-neutral data for product rendering; absent on legacy Items. */
  contentType?: string;
  structuredContent?: JsonValue;
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

export interface ContextCompactionItem extends ItemBase {
  type: "context_compaction";
  coveredThroughItemId: string;
  summary: string;
  retainedItemIds: string[];
  providerProfileId: string;
  modelId: string;
  reasoningEffort: string;
  algorithmVersion: string;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export type CanonicalItem =
  | ThreadMetadataItem
  | ThreadConfigurationChangedItem
  | ContextCompactionItem
  | TurnStartedItem
  | TurnCompletedItem
  | TurnAbortedItem
  | TurnReplacementRequestedItem
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | ToolCallItem
  | ToolResultItem
  | FailureItem;

export type SandboxMode = "danger-full-access";
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
      throw new Error("Image input must contain an AttachmentRef");
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
        candidate.type === "image" &&
        part.attachment.sha256 === candidate.attachment.sha256 &&
        part.attachment.mediaType === candidate.attachment.mediaType &&
        part.attachment.byteLength === candidate.attachment.byteLength &&
        part.attachment.width === candidate.attachment.width &&
        part.attachment.height === candidate.attachment.height
      );
    })
  );
}
