import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  type AttachmentRef,
} from "./attachment.js";

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
  | "model_usage"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "failure";

const CANONICAL_ITEM_TYPES = {
  thread_metadata: true,
  thread_configuration_changed: true,
  context_compaction: true,
  turn_started: true,
  turn_completed: true,
  turn_aborted: true,
  turn_replacement_requested: true,
  user_message: true,
  agent_message: true,
  model_usage: true,
  reasoning: true,
  tool_call: true,
  tool_result: true,
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
  /** null preserves an intentional request for the Provider's text default. */
  reasoningEffort: string | null;
}

export type ThreadMetadataItem =
  LegacyThreadMetadataItem | ProviderThreadMetadataItem;

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
}

export interface ToolResultItem extends ItemBase {
  type: "tool_result";
  turnId: string;
  callId: string;
  output: string;
  exitCode: number;
  /** Runtime-owned execution fact; absent on legacy Items. */
  executionStatus?: "completed" | "failed" | "declined";
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
  reasoningEffort: string | null;
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
  | ModelUsageItem
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

  switch (type) {
    case "thread_metadata":
      requireNoTurnId(item);
      requireNonEmptyString(item.cwd, "thread_metadata.cwd");
      requireEnum(
        item.sandbox,
        ["danger-full-access"],
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
    case "thread_configuration_changed":
      requireNoTurnId(item);
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
      requireNoTurnId(item);
      for (const key of [
        "coveredThroughItemId",
        "summary",
        "providerProfileId",
        "modelId",
        "reasoningEffort",
        "algorithmVersion",
      ]) {
        if (key === "reasoningEffort") {
          requireReasoningEffort(item[key], `context_compaction.${key}`);
        } else {
          requireNonEmptyString(item[key], `context_compaction.${key}`);
        }
      }
      requireStringArray(
        item.retainedItemIds,
        "context_compaction.retainedItemIds",
      );
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
      requireTurnId(item, type);
      requireNonEmptyString(item.successorTurnId, `${type}.successorTurnId`);
      requireNonEmptyString(item.clientId, `${type}.clientId`);
      requireExactlyOneShape(item, ["text"], ["input"], type);
      if (hasOwn(item, "text"))
        requireNonEmptyString(item.text, `${type}.text`);
      else validateUserInput(item.input, `${type}.input`);
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
        rejectPresent(item, ["contentVisibility", "providerItemId"], type);
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
      break;
    case "tool_result": {
      requireTurnId(item, type);
      requireNonEmptyString(item.callId, `${type}.callId`);
      requireString(item.output, `${type}.output`);
      requireSafeInteger(item.exitCode, `${type}.exitCode`);
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
      break;
    }
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

function validateUserInput(value: unknown, name: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  for (const [index, rawPart] of value.entries()) {
    const part = requireRecord(rawPart, `${name}[${String(index)}]`);
    if (part.type === "text") {
      requireNonEmptyString(part.text, `${name}[${String(index)}].text`);
    } else if (part.type === "image") {
      validateAttachmentRef(
        part.attachment,
        `${name}[${String(index)}].attachment`,
      );
    } else {
      throw new Error(`${name}[${String(index)}] has an unsupported type`);
    }
  }
}

function validateAttachmentRef(value: unknown, name: string): void {
  const ref = requireRecord(value, name);
  requireEnum(ref.type, ["attachment"], `${name}.type`);
  const sha256 = requireNonEmptyString(ref.sha256, `${name}.sha256`);
  if (!/^[a-f0-9]{64}$/u.test(sha256))
    throw new Error(`${name}.sha256 is invalid`);
  requireEnum(
    ref.mediaType,
    ["image/png", "image/jpeg", "image/gif", "image/webp"],
    `${name}.mediaType`,
  );
  requireSafeInteger(ref.byteLength, `${name}.byteLength`);
  if (
    (ref.byteLength as number) <= 0 ||
    (ref.byteLength as number) > MAX_IMAGE_BYTES
  ) {
    throw new Error(`${name}.byteLength is outside the supported range`);
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
