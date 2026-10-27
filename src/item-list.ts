import { bindModelMediaOrigin } from "./model-media-origin.js";
import {
  validateUserInput,
  validateOpaqueReplayProvenance,
  type OpaqueReasoningReplayProvenance,
  textFromUserInput,
  type JsonValue,
  type UserInput,
} from "./item.js";
import { classifyContext, type ModelMessage, type ModelTool } from "./model.js";

/** The writable conversation format. Runtime events are deliberately not a variant. */
export type ContextSourceKind =
  | "user_message"
  | "host_message"
  | "thread_message"
  | "agent_message"
  | "thread_instruction"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "context_compaction"
  | "failure"
  | "workspace_instructions"
  | "permission_instruction"
  | "model_instructions"
  | "tool_definitions"
  | "context_notice"
  | "auxiliary_input"
  | "media_unavailable";
export interface ContextSource {
  kind: ContextSourceKind;
  /** Legacy compatibility ordinal, not an execution revision or a model-visible ID. */
  sequence: number;
  metadata?: Record<string, JsonValue>;
}
interface ContextBase {
  id: string;
  threadId: string;
  turnId?: string;
  createdAt: string;
  source: ContextSource;
}
export type ContextItem = ContextBase &
  (
    | {
        kind: "message";
        role: "system" | "developer" | "user" | "assistant";
        content: { text: string; parts: UserInput };
      }
    | {
        kind: "tool_call";
        role: "assistant";
        content: {
          callId: string;
          name: string;
          arguments: Record<string, unknown>;
        };
      }
    | {
        kind: "tool_result";
        role: "tool";
        content: {
          callId: string;
          text: string;
          exitCode: number | null;
          parts?: UserInput;
        };
      }
    | {
        kind: "reasoning";
        role: "assistant";
        content: {
          text: string;
          summary?: string;
          visibility: "public" | "opaque";
          providerItemId?: string;
          opaqueReplayProvenance?: OpaqueReasoningReplayProvenance;
        };
      }
    | {
        kind: "selection";
        role: "user";
        content: {
          text: string;
          coveredThroughItemId: string;
          coveredSequence: number;
          retainedItemIds: string[];
          excludedItemIds?: string[];
          excludedCallIds?: string[];
        };
      }
    | { kind: "tools"; role: "developer"; content: { tools: ModelTool[] } }
  );
export interface CompiledItemList {
  messages: ModelMessage[];
  tools: ModelTool[];
  /** Exact immutable input membership evidence; not inserted into the prompt. */
  selectedItemIds: string[];
}

const sourceKinds: readonly ContextSourceKind[] = [
  "user_message",
  "host_message",
  "thread_message",
  "agent_message",
  "thread_instruction",
  "tool_call",
  "tool_result",
  "reasoning",
  "context_compaction",
  "failure",
  "workspace_instructions",
  "permission_instruction",
  "model_instructions",
  "tool_definitions",
  "context_notice",
  "auxiliary_input",
  "media_unavailable",
];
const metadataKeys = new Set([
  "clientId",
  "deliveryAfter",
  "mode",
  "messageType",
  "sender",
  "source",
  "sourceId",
  "inputShape",
  "bodyStart",
  "callId",
  "modelResponseId",
  "parentCallId",
  "imported",
  "executionStatus",
  "selection",
  "algorithmVersion",
  "provenance",
  "sourceModelResponseId",
  "includeOriginalReference",
  "referenceBindings",
  "queuedAdmission",
  "onlySampleId",
  "category",
  "generatedReference",
  "reasoningSummaryOnly",
  "mediaOccurrence",
  "originalModelContentLength",
  "omittedMedia",
  "summaryOffset",
  "summaryLength",
  "historicalSnapshot",
]);

/** Strict at the writer boundary: unknown runtime variants/fields cannot leak into ItemList. */
export function decodeContextItem(value: unknown): ContextItem {
  const item = record(value, "ContextItem");
  keys(
    item,
    [
      "id",
      "threadId",
      "turnId",
      "createdAt",
      "kind",
      "role",
      "content",
      "source",
    ],
    "ContextItem",
  );
  for (const name of ["id", "threadId", "createdAt"])
    string(item[name], name, false);
  if (item.turnId !== undefined) string(item.turnId, "turnId", false);
  const source = record(item.source, "source");
  keys(source, ["kind", "sequence", "metadata"], "source");
  if (!sourceKinds.includes(source.kind as ContextSourceKind))
    throw new Error("Unknown semantic source kind");
  if (!Number.isSafeInteger(source.sequence) || Number(source.sequence) < 0)
    throw new Error("Invalid semantic source sequence");
  if (source.metadata !== undefined) {
    const metadata = record(source.metadata, "source.metadata");
    for (const key of Object.keys(metadata))
      if (!metadataKeys.has(key))
        throw new Error(`Nonsemantic source metadata: ${key}`);
    if (
      metadata.historicalSnapshot !== undefined &&
      (metadata.historicalSnapshot !== true || item.kind !== "tool_result")
    )
      throw Error("Invalid historical snapshot receipt metadata");
    for (const field of ["summaryOffset", "summaryLength"])
      if (
        metadata[field] !== undefined &&
        (!Number.isSafeInteger(metadata[field]) || Number(metadata[field]) < 0)
      )
        throw Error(`Invalid ${field}`);
    if (metadata.omittedMedia !== undefined) {
      if (!Array.isArray(metadata.omittedMedia))
        throw Error("Invalid semantic media selection");
      for (const raw of metadata.omittedMedia) {
        const entry = record(raw, "omittedMedia");
        keys(entry, ["itemId", "field", "partIndex", "sha256"], "omittedMedia");
        string(entry.itemId, "itemId", false);
        if (entry.field !== "content" && entry.field !== "modelContent")
          throw Error("Invalid media field");
        if (
          !Number.isSafeInteger(entry.partIndex) ||
          Number(entry.partIndex) < 0 ||
          typeof entry.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.sha256)
        )
          throw Error("Invalid media occurrence");
      }
    }
    if (
      metadata.originalModelContentLength !== undefined &&
      metadata.originalModelContentLength !== null &&
      (!Number.isSafeInteger(metadata.originalModelContentLength) ||
        Number(metadata.originalModelContentLength) < 0)
    )
      throw Error("Invalid original media part count");
    if (metadata.mediaOccurrence !== undefined) {
      if (!Array.isArray(metadata.mediaOccurrence))
        throw Error("Invalid media provenance");
      for (const value of metadata.mediaOccurrence) {
        if (value === null) continue;
        const entry = record(value, "mediaOccurrence");
        keys(
          entry,
          ["itemId", "field", "partIndex", "sha256"],
          "mediaOccurrence",
        );
        string(entry.itemId, "itemId", false);
        if (entry.field !== "content" && entry.field !== "modelContent")
          throw Error("Invalid media provenance field");
        if (
          !Number.isSafeInteger(entry.partIndex) ||
          Number(entry.partIndex) < 0 ||
          typeof entry.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.sha256)
        )
          throw Error("Invalid media provenance address");
      }
    }
    json(metadata, "source.metadata");
  }
  const content = record(item.content, "content");
  switch (item.kind) {
    case "message": {
      keys(content, ["text", "parts"], "message.content");
      if (
        !["system", "developer", "user", "assistant"].includes(
          String(item.role),
        )
      )
        throw new Error("Invalid message role");
      string(content.text, "content.text");
      parts(content.parts, "content.parts");
      if (textFromUserInput(content.parts as UserInput) !== content.text)
        throw new Error("content.text must exactly match stored text parts");
      if (
        ["user_message", "host_message", "thread_message"].includes(
          String(source.kind),
        ) &&
        item.role !== "user"
      )
        throw new Error("Untrusted input must retain user role");
      if (source.kind === "agent_message" && item.role !== "assistant")
        throw new Error("Observed assistant text must retain assistant role");
      break;
    }
    case "tool_call":
      keys(content, ["callId", "name", "arguments"], "tool_call.content");
      if (item.role !== "assistant" || source.kind !== "tool_call")
        throw new Error("Invalid tool-call role/source");
      string(content.callId, "callId", false);
      string(content.name, "name", false);
      json(record(content.arguments, "arguments"), "arguments");
      break;
    case "tool_result":
      keys(
        content,
        ["callId", "text", "exitCode", "parts"],
        "tool_result.content",
      );
      if (item.role !== "tool" || source.kind !== "tool_result")
        throw new Error("Invalid tool-result role/source");
      string(content.callId, "callId", false);
      string(content.text, "text");
      if (content.exitCode !== null && !Number.isSafeInteger(content.exitCode))
        throw new Error("Invalid tool outcome");
      if (content.parts !== undefined)
        parts(content.parts, "tool_result.parts");
      break;
    case "reasoning":
      keys(
        content,
        [
          "text",
          "summary",
          "visibility",
          "providerItemId",
          "opaqueReplayProvenance",
        ],
        "reasoning.content",
      );
      if (item.role !== "assistant" || source.kind !== "reasoning")
        throw new Error("Invalid reasoning role/source");
      string(content.text, "reasoning.text");
      if (content.summary !== undefined)
        string(content.summary, "reasoning.summary");
      if (content.opaqueReplayProvenance !== undefined) {
        if (content.visibility !== "opaque")
          throw new Error("Replay provenance requires opaque content");
        validateOpaqueReplayProvenance(content.opaqueReplayProvenance);
      }
      if (content.providerItemId !== undefined)
        string(content.providerItemId, "reasoning.providerItemId", false);
      if (!["public", "opaque"].includes(String(content.visibility)))
        throw new Error("Invalid reasoning visibility");
      break;
    case "selection":
      keys(
        content,
        [
          "text",
          "coveredThroughItemId",
          "coveredSequence",
          "retainedItemIds",
          "excludedItemIds",
          "excludedCallIds",
        ],
        "selection.content",
      );
      if (item.role !== "user" || source.kind !== "context_compaction")
        throw new Error("Invalid selection role/source");
      string(content.text, "selection.text");
      string(
        content.coveredThroughItemId,
        "selection.coveredThroughItemId",
        false,
      );
      if (
        !Number.isSafeInteger(content.coveredSequence) ||
        Number(content.coveredSequence) < 0
      )
        throw new Error("Invalid covered sequence");
      if (
        !Array.isArray(content.retainedItemIds) ||
        content.retainedItemIds.some((id) => typeof id !== "string" || !id) ||
        new Set(content.retainedItemIds).size !== content.retainedItemIds.length
      )
        throw new Error("Invalid retained semantic IDs");
      for (const field of ["excludedItemIds", "excludedCallIds"]) {
        const values = content[field];
        if (
          values !== undefined &&
          (!Array.isArray(values) ||
            values.some((id) => typeof id !== "string" || !id) ||
            new Set(values).size !== values.length)
        )
          throw Error(`Invalid ${field}`);
      }
      break;
    case "tools":
      keys(content, ["tools"], "tools.content");
      if (
        item.role !== "developer" ||
        source.kind !== "tool_definitions" ||
        !Array.isArray(content.tools)
      )
        throw new Error("Invalid tools declaration");
      for (const value of content.tools) {
        const tool = record(value, "tool");
        keys(tool, ["name", "description", "inputSchema", "rawSource"], "tool");
        string(tool.name, "tool.name", false);
        string(tool.description, "tool.description");
        json(record(tool.inputSchema, "tool.inputSchema"), "tool.inputSchema");
        if (tool.rawSource !== undefined) {
          const raw = record(tool.rawSource, "rawSource");
          keys(raw, ["language", "argument"], "rawSource");
          if (raw.language !== "javascript" || raw.argument !== "code")
            throw new Error("Invalid rawSource");
        }
      }
      break;
    default:
      throw new Error(`Not a semantic Item kind: ${String(item.kind)}`);
  }
  return structuredClone(value) as ContextItem;
}

/** Selection only. All model-visible strings already exist in durable content. */
export function compileItemList(
  items: readonly ContextItem[],
  options: {
    sampleId?: string;
    selection?: { providerProfileId: string; modelId: string };
    inputModalities?: readonly string[] | null;
  } = {},
): CompiledItemList {
  const validated = items.map(decodeContextItem);
  if (new Set(validated.map((item) => item.id)).size !== validated.length)
    throw new Error("Duplicate semantic Item identity");
  if (new Set(validated.map((item) => item.threadId)).size > 1)
    throw new Error("Mixed Thread ItemList");
  const selection = validated.findLast((item) => item.kind === "selection");
  let selected = validated;
  if (selection?.kind === "selection") {
    const retained = new Set(selection.content.retainedItemIds);
    for (const id of retained)
      if (!validated.some((item) => item.id === id))
        throw new Error(`Retained context Item does not exist: ${id}`);
    // A legacy covered boundary may itself be a nonsemantic event. Its verified
    // ordinal is captured by the encoder, not inferred from a missing Trace.
    if (selection.content.coveredSequence >= selection.source.sequence)
      throw new Error("Invalid context selection boundary");
    selected = validated.filter(
      (item) =>
        item === selection ||
        retained.has(item.id) ||
        item.source.sequence > selection.content.coveredSequence ||
        ["system", "developer"].includes(item.role),
    );
    selected = selected.filter(
      (item) => item.kind !== "selection" || item === selection,
    );
    // The replacement summary introduces retained/suffix conversation content,
    // even when an unseen user steer was admitted before the reset fact.
    selected = [
      ...selected.filter(
        (item) => item.role === "system" || item.role === "developer",
      ),
      selection,
      ...selected.filter(
        (item) =>
          item !== selection &&
          item.role !== "system" &&
          item.role !== "developer",
      ),
    ];
  }
  // Agent-authored resets also omit their own source response and receipt.
  // These immutable selections remain in force after later compactions; they
  // never remove raw facts or change an already observed sample.
  for (const reset of validated) {
    if (reset.kind !== "selection") continue;
    const excluded = new Set(reset.content.excludedItemIds ?? []);
    const calls = new Set(reset.content.excludedCallIds ?? []);
    selected = selected.filter(
      (item) =>
        !excluded.has(item.id) &&
        !(
          item.turnId === reset.turnId &&
          (item.kind === "tool_call" || item.kind === "tool_result") &&
          calls.has(item.content.callId)
        ),
    );
  }
  selected = selected.filter(
    (item) =>
      item.source.metadata?.onlySampleId === undefined ||
      item.source.metadata.onlySampleId === options.sampleId,
  );
  const replaceableSources = new Set([
    "workspace_instructions",
    "permission_instruction",
    "model_instructions",
    "tool_definitions",
  ]);
  const latestSources = new Map<string, ContextItem>();
  for (const item of selected)
    if (replaceableSources.has(item.source.kind))
      latestSources.set(item.source.kind, item);
  selected = selected.filter(
    (item) =>
      !replaceableSources.has(item.source.kind) ||
      latestSources.get(item.source.kind) === item,
  );
  const callKey = (
    item: Extract<ContextItem, { kind: "tool_call" | "tool_result" }>,
  ) => `${item.turnId}\0${item.content.callId}`;
  const allCalls = new Set(
    validated.flatMap((item) =>
      item.kind === "tool_call" ? [callKey(item)] : [],
    ),
  );
  const selectedCalls = new Set(
    selected.flatMap((item) =>
      item.kind === "tool_call" ? [callKey(item)] : [],
    ),
  );
  // A fork closure follows the selection of its historical call, even if the
  // closure fact itself was appended after the selected compaction boundary.
  selected = selected.filter(
    (item) =>
      item.kind !== "tool_result" ||
      item.source.metadata?.historicalSnapshot !== true ||
      !allCalls.has(callKey(item)) ||
      selectedCalls.has(callKey(item)),
  );
  selected = orderSteeredContext(orderSnapshotReceipts(selected));
  const selectedItemIds: string[] = [];
  const supportedMedia = new Set(
    options.inputModalities ?? ["text", "image", "audio"],
  );
  const occurrenceKey = (value: unknown) => {
    const entry = value as {
      itemId: string;
      field: string;
      partIndex: number;
      sha256: string;
    };
    return JSON.stringify([
      entry.itemId,
      entry.field,
      entry.partIndex,
      entry.sha256,
    ]);
  };
  const omitted = new Set(
    selected.flatMap((item) =>
      Array.isArray(item.source.metadata?.omittedMedia)
        ? item.source.metadata.omittedMedia.map(occurrenceKey)
        : [],
    ),
  );
  const projectParts = (item: ContextItem, content: UserInput): UserInput =>
    content.flatMap<UserInput[number]>((part, index) => {
      if (part.type === "text") return [structuredClone(part)];
      const origin = ((Array.isArray(item.source.metadata?.mediaOccurrence)
        ? item.source.metadata.mediaOccurrence[index]
        : undefined) as
        import("./item.js").RecoveryMediaOccurrence | undefined) ?? {
        itemId: item.id,
        field:
          item.kind === "tool_result"
            ? ("modelContent" as const)
            : ("content" as const),
        partIndex:
          index -
          (item.kind === "message" &&
          typeof item.source.metadata?.bodyStart === "number"
            ? item.source.metadata.bodyStart
            : 0),
        sha256: part.attachment.sha256,
      };
      if (!supportedMedia.has(part.type) || omitted.has(occurrenceKey(origin)))
        return [];
      const projected = structuredClone(part);
      bindModelMediaOrigin(projected, origin);
      return [projected];
    });
  const messages: ModelMessage[] = [];
  let tools: ModelTool[] = [];
  for (const item of selected) {
    switch (item.kind) {
      case "message":
        if (item.role === "user")
          messages.push({
            role: "user",
            content: projectParts(item, item.content.parts),
          });
        else if (item.role === "assistant")
          messages.push({ role: "assistant", text: item.content.text });
        else messages.push({ role: item.role, text: item.content.text });
        break;
      case "tool_call": {
        const previous = messages.at(-1);
        const call = { ...item.content };
        const imported = item.source.metadata?.imported;
        if (imported !== undefined) Object.assign(call, { imported });
        if (previous?.role === "assistant" && "toolCalls" in previous)
          previous.toolCalls.push(call);
        else messages.push({ role: "assistant", toolCalls: [call] });
        break;
      }
      case "tool_result":
        messages.push({
          role: "tool",
          callId: item.content.callId,
          text: item.content.text,
          exitCode: item.content.exitCode,
          ...(item.content.parts === undefined
            ? {}
            : {
                modelContent: projectParts(item, item.content.parts),
              }),
        });
        break;
      case "reasoning": {
        const producing = item.source.metadata?.selection;
        if (
          item.content.visibility === "opaque" &&
          (options.selection === undefined ||
            producing === null ||
            typeof producing !== "object" ||
            Array.isArray(producing) ||
            !("providerProfileId" in producing) ||
            producing.providerProfileId !==
              options.selection.providerProfileId ||
            !("modelId" in producing) ||
            producing.modelId !== options.selection.modelId)
        )
          continue;
        messages.push({
          role: "reasoning",
          reasoningContent: item.content.text,
          contentVisibility: item.content.visibility,
          ...(item.content.summary === undefined
            ? {}
            : { summary: item.content.summary }),
          ...(item.content.opaqueReplayProvenance === undefined
            ? {}
            : { opaqueReplayProvenance: item.content.opaqueReplayProvenance }),
          ...(item.content.providerItemId === undefined
            ? {}
            : { providerItemId: item.content.providerItemId }),
        });
        break;
      }
      case "selection":
        messages.push({ role: "user", text: item.content.text });
        break;
      case "tools":
        tools = structuredClone(item.content.tools);
        break;
    }
    if (item.kind === "message") {
      const message = messages.at(-1)!;
      if (
        item.role === "system" ||
        item.role === "developer" ||
        item.source.kind === "workspace_instructions" ||
        item.source.kind === "permission_instruction"
      )
        classifyContext(message, "instructions");
      else if (item.source.kind === "host_message")
        classifyContext(
          message,
          item.source.metadata?.source === "bootstrap"
            ? "instructions"
            : "pluginContext",
        );
    }
    selectedItemIds.push(item.id);
  }
  return { messages, tools, selectedItemIds };
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error(`${label} has unknown field ${key}`);
}
function string(
  value: unknown,
  label: string,
  empty = true,
): asserts value is string {
  if (typeof value !== "string" || (!empty && !value))
    throw new Error(`${label} must be ${empty ? "a string" : "nonempty"}`);
}
function json(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || seen.has(value))
    throw new Error(`${label} must be finite acyclic JSON`);
  seen.add(value);
  if (Array.isArray(value)) for (const entry of value) json(entry, label, seen);
  else
    for (const entry of Object.values(record(value, label)))
      json(entry, label, seen);
  seen.delete(value);
}
function parts(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const part of value) {
    const p = record(part, label);
    keys(
      p,
      p.type === "text"
        ? ["type", "text", "skillSource"]
        : ["type", "attachment"],
      label,
    );
    // Empty observed assistant/tool text is real content, not invalid user ingress.
    if (p.type === "text" && p.text === "") {
      if (p.skillSource !== undefined)
        validateUserInput([{ ...p, text: "validation" }], label);
    } else validateUserInput([p], label);
  }
}
export {
  contextItemsFromLegacy,
  legacyItemFromContext,
  contextAnnotationFromLegacy,
} from "./item-list-legacy.js";

/** A copied non-executed closure belongs to its original call batch, not the fork tail. */
function orderSnapshotReceipts(
  items: readonly ContextItem[],
): readonly ContextItem[] {
  type Receipt = Extract<ContextItem, { kind: "tool_result" }>;
  const receipts = items.filter(
    (item): item is Receipt =>
      item.kind === "tool_result" &&
      item.source.metadata?.historicalSnapshot === true,
  );
  if (receipts.length === 0) return items;
  const ids = new Set(receipts.map((item) => item.id));
  const base = items.filter((item) => !ids.has(item.id));
  const key = (
    item: Extract<ContextItem, { kind: "tool_call" | "tool_result" }>,
  ) => `${item.turnId}\0${item.content.callId}`;
  const groups = new Map<string, { anchor: number; receipts: Receipt[] }>();
  for (let index = 0; index < base.length; index++) {
    if (base[index]?.kind !== "tool_call") continue;
    const group = { anchor: index, receipts: [] as Receipt[] };
    while (base[index]?.kind === "tool_call") {
      const call = base[index]!;
      if (call.kind === "tool_call") groups.set(key(call), group);
      group.anchor = index++;
    }
    index--;
  }
  for (const [index, item] of base.entries()) {
    if (item.kind !== "tool_result") continue;
    const group = groups.get(key(item));
    if (group) group.anchor = Math.max(group.anchor, index);
  }
  for (const receipt of receipts) {
    const group = groups.get(key(receipt));
    // Never drop a persisted receipt whose original call is outside this selection.
    if (!group) return items;
    group.receipts.push(receipt);
  }
  const insertions = new Map<number, Receipt[]>();
  for (const group of new Set(groups.values()))
    if (group.receipts.length)
      insertions.set(group.anchor, [
        ...(insertions.get(group.anchor) ?? []),
        ...group.receipts,
      ]);
  return base.flatMap((item, index) => [
    item,
    ...(insertions.get(index) ?? []),
  ]);
}

/** Select original persisted user contents after their observed assistant/tool boundary. */
function orderSteeredContext(items: readonly ContextItem[]): ContextItem[] {
  const normal: Array<{ item: ContextItem; index: number }> = [];
  const pending: Array<{ item: ContextItem; index: number; anchor: string }> =
    [];
  for (const [index, item] of items.entries()) {
    const anchor = item.source.metadata?.deliveryAfter;
    if (
      item.kind === "message" &&
      item.role === "user" &&
      typeof anchor === "string"
    )
      pending.push({ item, index, anchor });
    else normal.push({ item, index });
  }
  if (pending.length === 0) return [...items];
  const boundaries = new Map<string, number>();
  const calls = new Map<string, string>();
  for (const [index, { item }] of normal.entries()) {
    boundaries.set(item.id, index);
    if (item.kind === "tool_call") {
      const response = item.source.metadata?.modelResponseId;
      if (typeof response === "string") {
        boundaries.set(response, index);
        calls.set(`${item.turnId}\0${item.content.callId}`, response);
      }
    }
    if (item.kind === "tool_result") {
      const response = calls.get(`${item.turnId}\0${item.content.callId}`);
      if (response !== undefined) boundaries.set(response, index);
    }
  }
  const after = new Map<number, ContextItem[]>();
  const before = new Map<number, ContextItem[]>();
  for (const entry of pending) {
    const position = boundaries.get(entry.anchor);
    const target =
      position === undefined
        ? normal.findIndex((item) => item.index > entry.index)
        : position;
    const map = position === undefined ? before : after;
    const key = target < 0 ? normal.length : target;
    const values = map.get(key) ?? [];
    values.push(entry.item);
    map.set(key, values);
  }
  return normal
    .flatMap(({ item }, index) => [
      ...(before.get(index) ?? []),
      item,
      ...(after.get(index) ?? []),
    ])
    .concat(before.get(normal.length) ?? []);
}
