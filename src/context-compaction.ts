import type {
  CanonicalItem,
  ContextCompactionItem,
  ToolCallItem,
  ToolResultItem,
} from "./item.js";

export const CONTEXT_COMPACTION_ALGORITHM_VERSION = "zen.context-compaction.v2";
export const CONTEXT_COMPACTION_SUMMARY_MARKER = "ZEN_CONTEXT_COMPACTION_V1";
export const CONTEXT_COMPACTION_SUMMARY_PREFIX = "[Zen compacted context]\n";

export const CONTEXT_COMPACTION_SUMMARY_INSTRUCTION = `${CONTEXT_COMPACTION_SUMMARY_MARKER}
Summarize the conversation context above for a provider-neutral agent continuation.
Preserve concrete user goals, decisions, constraints, unfinished work, exact identifiers,
and tool outcomes that affect future work. Do not call tools. Return only the summary.`;

export interface ContextCompactionConfig {
  summaryInstruction?: string;
  triggerPercent?: number;
  targetPercent?: number;
  retention?: {
    mode?: "budget" | "recent-items" | "selected-items";
    recentItemCount?: number;
    preserveUserMessages?: boolean;
    finalMessages?: "none" | "all" | "recent";
    finalMessageCount?: number;
  };
}

export interface ResolvedContextCompactionConfig {
  summaryInstruction: string;
  triggerPercent: number;
  targetPercent: number;
  retention: {
    mode: "budget" | "recent-items" | "selected-items";
    recentItemCount: number;
    preserveUserMessages: boolean;
    finalMessages: "none" | "all" | "recent";
    finalMessageCount: number;
  };
}

export interface CompactionBoundary {
  item: Extract<CanonicalItem, { type: "turn_completed" }>;
  index: number;
  retainedItemIds: string[];
}

export interface BoundedCompactionBoundaryOptions {
  retainedTokenBudget: number;
  estimateRetainedTokens: (items: readonly CanonicalItem[]) => number;
  retention?: ResolvedContextCompactionConfig["retention"];
}

export function normalizeContextCompactionConfig(
  config: ContextCompactionConfig = {},
): ResolvedContextCompactionConfig {
  requirePlainObject(config, "config");
  requireKnownKeys(config, "config", [
    "summaryInstruction",
    "triggerPercent",
    "targetPercent",
    "retention",
  ]);
  const summaryInstruction =
    config.summaryInstruction ?? CONTEXT_COMPACTION_SUMMARY_INSTRUCTION;
  requireNonEmpty(summaryInstruction, "summaryInstruction", true);
  const triggerPercent = config.triggerPercent ?? 80;
  requirePercentage(triggerPercent, "triggerPercent");
  const targetPercent = config.targetPercent ?? 80;
  requirePercentage(targetPercent, "targetPercent");
  if (targetPercent > triggerPercent) {
    throw new Error(
      "Context compaction targetPercent must not exceed triggerPercent",
    );
  }
  const retention = config.retention ?? {};
  requirePlainObject(retention, "retention");
  requireKnownKeys(retention, "retention", [
    "mode",
    "recentItemCount",
    "preserveUserMessages",
    "finalMessages",
    "finalMessageCount",
  ]);
  const mode = retention.mode ?? "budget";
  if (!["budget", "recent-items", "selected-items"].includes(mode)) {
    throw new Error("Context compaction retention.mode is invalid");
  }
  const recentItemCount = retention.recentItemCount ?? 20;
  requirePositiveInteger(recentItemCount, "retention.recentItemCount");
  const preserveUserMessages = retention.preserveUserMessages ?? false;
  if (typeof preserveUserMessages !== "boolean") {
    throw new Error(
      "Context compaction retention.preserveUserMessages must be a boolean",
    );
  }
  const finalMessages = retention.finalMessages ?? "none";
  if (!["none", "all", "recent"].includes(finalMessages)) {
    throw new Error("Context compaction retention.finalMessages is invalid");
  }
  const finalMessageCount = retention.finalMessageCount ?? 10;
  requirePositiveInteger(finalMessageCount, "retention.finalMessageCount");
  return {
    summaryInstruction,
    triggerPercent,
    targetPercent,
    retention: {
      mode,
      recentItemCount,
      preserveUserMessages,
      finalMessages,
      finalMessageCount,
    },
  };
}

export function latestCompaction(
  items: readonly CanonicalItem[],
): ContextCompactionItem | undefined {
  return [...items]
    .reverse()
    .find(
      (item): item is ContextCompactionItem =>
        item.type === "context_compaction",
    );
}

export function latestEligibleCompactionBoundary(
  items: readonly CanonicalItem[],
): CompactionBoundary | undefined {
  const openTurns = new Set<string>();
  for (const item of items) {
    if (item.type === "turn_started") {
      openTurns.add(item.turnId);
    } else if (item.type === "turn_completed" || item.type === "turn_aborted") {
      openTurns.delete(item.turnId);
    }
  }
  if (openTurns.size > 0) {
    throw new Error("Thread has an incomplete Turn");
  }

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type !== "turn_completed") continue;
    return {
      item,
      index,
      retainedItemIds: items
        .slice(0, index + 1)
        .filter((candidate) => candidate.turnId === item.turnId)
        .map((candidate) => candidate.id),
    };
  }
  return undefined;
}

export function boundedCompactionBoundary(
  items: readonly CanonicalItem[],
  options: BoundedCompactionBoundaryOptions,
): CompactionBoundary | undefined {
  if (
    !Number.isSafeInteger(options.retainedTokenBudget) ||
    options.retainedTokenBudget < 0
  ) {
    throw new Error(
      "Context compaction retained token budget must be a non-negative integer",
    );
  }
  const boundary = latestEligibleCompactionBoundary(items);
  if (boundary === undefined) return undefined;

  const coveredItems = items.slice(0, boundary.index + 1);
  const turnItems = coveredItems.filter(
    (candidate) => candidate.turnId === boundary.item.turnId,
  );
  validateRetainedToolClosure(coveredItems, new Set(boundary.retainedItemIds));

  const retention =
    options.retention ?? normalizeContextCompactionConfig().retention;
  const pinned = expandRetainedToolClosure(
    coveredItems,
    explicitlyRetainedIds(coveredItems, retention),
  );

  if (retention.mode !== "budget") {
    const selected = new Set(pinned);
    if (retention.mode === "recent-items") {
      const candidates = recentItemCandidates(coveredItems);
      for (const candidate of candidates.slice(-retention.recentItemCount)) {
        selected.add(candidate.id);
      }
    }
    const retained = expandRetainedToolClosure(coveredItems, selected);
    const retainedItems = itemsInCanonicalOrder(coveredItems, retained);
    validateRetainedToolClosure(coveredItems, retained);
    if (
      options.estimateRetainedTokens(retainedItems) >
      options.retainedTokenBudget
    ) {
      throw new Error(
        "Context compaction could not produce a bounded projection",
      );
    }
    return {
      ...boundary,
      retainedItemIds: retainedItems.map((candidate) => candidate.id),
    };
  }

  for (let suffixStart = 0; suffixStart <= turnItems.length; suffixStart += 1) {
    const retained = new Set(pinned);
    for (const candidate of turnItems.filter(
      (candidate, index) =>
        index >= suffixStart || !projectsIntoModelContext(candidate),
    )) {
      retained.add(candidate.id);
    }
    try {
      validateRetainedToolClosure(coveredItems, retained);
    } catch {
      continue;
    }
    const retainedItems = itemsInCanonicalOrder(coveredItems, retained);
    if (
      options.estimateRetainedTokens(retainedItems) <=
      options.retainedTokenBudget
    ) {
      return {
        ...boundary,
        retainedItemIds: retainedItems.map((candidate) => candidate.id),
      };
    }
  }

  throw new Error("Context compaction could not produce a bounded projection");
}

export function contextCompactionTokenBudget(
  contextWindow: number,
  percent = 80,
): number {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error("Context window must be a positive integer");
  }
  requirePercentage(percent, "percent");
  const quotient = Math.floor(contextWindow / 100);
  const remainder = contextWindow % 100;
  return quotient * percent + Math.ceil((remainder * percent) / 100);
}

function projectsIntoModelContext(item: CanonicalItem): boolean {
  return (
    item.type === "user_message" ||
    item.type === "agent_message" ||
    item.type === "tool_call" ||
    item.type === "tool_result" ||
    item.type === "failure" ||
    (item.type === "reasoning" && item.incomplete !== true)
  );
}

function recentItemCandidates(
  coveredItems: readonly CanonicalItem[],
): CanonicalItem[] {
  const nestedCalls = new Set(
    coveredItems
      .filter(
        (item): item is ToolCallItem =>
          item.type === "tool_call" && item.parentCallId !== undefined,
      )
      .map((item) => `${item.turnId}\0${item.callId}`),
  );
  return coveredItems.filter((item) => {
    if (!projectsIntoModelContext(item)) return false;
    if (item.type === "tool_call") return item.parentCallId === undefined;
    if (item.type === "tool_result") {
      return !nestedCalls.has(`${item.turnId}\0${item.callId}`);
    }
    return true;
  });
}

function explicitlyRetainedIds(
  coveredItems: readonly CanonicalItem[],
  retention: ResolvedContextCompactionConfig["retention"],
): Set<string> {
  const retained = new Set<string>();
  if (retention.preserveUserMessages) {
    for (const item of coveredItems) {
      if (item.type === "user_message") retained.add(item.id);
    }
  }
  if (retention.finalMessages !== "none") {
    const finals = successfulFinalMessages(coveredItems);
    const selected =
      retention.finalMessages === "all"
        ? finals
        : finals.slice(-retention.finalMessageCount);
    for (const item of selected) retained.add(item.id);
  }
  return retained;
}

function successfulFinalMessages(
  coveredItems: readonly CanonicalItem[],
): Extract<CanonicalItem, { type: "agent_message" }>[] {
  const finalByTurn = new Map<
    string,
    Extract<CanonicalItem, { type: "agent_message" }>
  >();
  const finals: Extract<CanonicalItem, { type: "agent_message" }>[] = [];
  for (const item of coveredItems) {
    if (item.type === "agent_message") {
      finalByTurn.set(item.turnId, item);
    } else if (item.type === "turn_completed") {
      if (item.status === "completed") {
        const final = finalByTurn.get(item.turnId);
        if (final !== undefined) finals.push(final);
      }
      finalByTurn.delete(item.turnId);
    } else if (item.type === "turn_aborted") {
      finalByTurn.delete(item.turnId);
    }
  }
  return finals;
}

function expandRetainedToolClosure(
  coveredItems: readonly CanonicalItem[],
  initial: ReadonlySet<string>,
): Set<string> {
  const retained = new Set(initial);
  const calls = coveredItems.filter(
    (item): item is ToolCallItem => item.type === "tool_call",
  );
  const itemIds = new Set(coveredItems.map((item) => item.id));
  const callByIdentity = new Map(
    calls.map((call) => [`${call.turnId}\0${call.callId}`, call]),
  );
  const related = new Map<string, Set<string>>();
  const connect = (left: string, right: string) => {
    if (!itemIds.has(left) || !itemIds.has(right)) return;
    const leftRelations = related.get(left) ?? new Set<string>();
    leftRelations.add(right);
    related.set(left, leftRelations);
    const rightRelations = related.get(right) ?? new Set<string>();
    rightRelations.add(left);
    related.set(right, rightRelations);
  };
  for (const call of calls) {
    if (call.modelResponseId !== undefined) {
      connect(call.id, call.modelResponseId);
    }
    if (call.parentCallId !== undefined) {
      const parent = callByIdentity.get(`${call.turnId}\0${call.parentCallId}`);
      if (parent !== undefined) connect(call.id, parent.id);
    }
  }
  for (const result of coveredItems) {
    if (result.type !== "tool_result") continue;
    const call = callByIdentity.get(`${result.turnId}\0${result.callId}`);
    if (call !== undefined) connect(call.id, result.id);
  }

  const pending = [...retained];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined) continue;
    for (const relatedId of related.get(id) ?? []) {
      if (retained.has(relatedId)) continue;
      retained.add(relatedId);
      pending.push(relatedId);
    }
  }
  return retained;
}

function itemsInCanonicalOrder(
  coveredItems: readonly CanonicalItem[],
  retained: ReadonlySet<string>,
): CanonicalItem[] {
  return coveredItems.filter((item) => retained.has(item.id));
}

export function validateContextCompactionItem(
  items: readonly CanonicalItem[],
  item: ContextCompactionItem,
): void {
  const runtimeItem = item as unknown as Record<string, unknown>;
  requireNonEmpty(runtimeItem.id as string, "id");
  if (runtimeItem.type !== "context_compaction") {
    throw new Error("Context compaction type must be context_compaction");
  }
  if ("turnId" in runtimeItem) {
    throw new Error("Context compaction must not belong to a Turn");
  }
  if (!Array.isArray(runtimeItem.retainedItemIds)) {
    throw new Error("Context compaction retainedItemIds must be an array");
  }
  if (
    typeof runtimeItem.tokenUsage !== "object" ||
    runtimeItem.tokenUsage === null ||
    Array.isArray(runtimeItem.tokenUsage)
  ) {
    throw new Error("Context compaction tokenUsage must be an object");
  }

  requireNonEmpty(item.coveredThroughItemId, "coveredThroughItemId");
  requireNonEmpty(item.summary, "summary", true);
  requireNonEmpty(item.providerProfileId, "providerProfileId");
  requireNonEmpty(item.modelId, "modelId");
  if (item.reasoningEffort !== null) {
    requireNonEmpty(item.reasoningEffort, "reasoningEffort");
  }
  requireNonEmpty(item.algorithmVersion, "algorithmVersion");
  requireTokenCount(item.tokenUsage.inputTokens, "inputTokens");
  requireTokenCount(item.tokenUsage.outputTokens, "outputTokens");

  const boundaryIndex = items.findIndex(
    (candidate) => candidate.id === item.coveredThroughItemId,
  );
  if (boundaryIndex < 0) {
    throw new Error(
      `Context compaction boundary does not exist: ${item.coveredThroughItemId}`,
    );
  }
  const boundary = items[boundaryIndex];
  if (boundary?.type !== "turn_completed") {
    throw new Error(
      "Context compaction boundary must be a turn_completed Item",
    );
  }
  const latestBoundary = latestEligibleCompactionBoundary(items);
  if (latestBoundary?.item.id !== item.coveredThroughItemId) {
    throw new Error(
      "Context compaction boundary must be the latest eligible completed Turn",
    );
  }

  const previous = latestCompaction(items);
  if (previous !== undefined) {
    const previousBoundaryIndex = items.findIndex(
      (candidate) => candidate.id === previous.coveredThroughItemId,
    );
    if (boundaryIndex <= previousBoundaryIndex) {
      throw new Error(
        "Context compaction boundary must advance beyond the effective boundary",
      );
    }
  }

  const retained = new Set<string>();
  let previousIndex = -1;
  for (const retainedId of item.retainedItemIds) {
    requireNonEmpty(retainedId, "retainedItemIds entry");
    if (retained.has(retainedId)) {
      throw new Error(`Duplicate retained Item id: ${retainedId}`);
    }
    retained.add(retainedId);
    const index = items.findIndex((candidate) => candidate.id === retainedId);
    if (index < 0) {
      throw new Error(`Retained Item does not exist: ${retainedId}`);
    }
    if (index > boundaryIndex) {
      throw new Error(
        `Retained Item is after the compaction boundary: ${retainedId}`,
      );
    }
    if (index <= previousIndex) {
      throw new Error("Retained Item ids must follow stable canonical order");
    }
    previousIndex = index;
  }

  validateRetainedToolClosure(items.slice(0, boundaryIndex + 1), retained);
}

function validateRetainedToolClosure(
  coveredItems: readonly CanonicalItem[],
  retained: ReadonlySet<string>,
): void {
  const calls = coveredItems.filter(
    (candidate): candidate is ToolCallItem => candidate.type === "tool_call",
  );
  const callsByIdentity = new Map(
    calls.map((call) => [`${call.turnId}\0${call.callId}`, call]),
  );
  for (const call of calls) {
    const matchingResults = coveredItems.filter(
      (candidate) =>
        candidate.type === "tool_result" &&
        candidate.turnId === call.turnId &&
        candidate.callId === call.callId,
    );
    if (matchingResults.length !== 1) {
      throw new Error(
        `Covered tool lifecycle must contain exactly one result for call ${call.callId}`,
      );
    }
    const callRetained = retained.has(call.id);
    const retainedResults = matchingResults.filter((result) =>
      retained.has(result.id),
    );
    if (
      (callRetained && retainedResults.length !== matchingResults.length) ||
      (!callRetained && retainedResults.length > 0)
    ) {
      throw new Error(
        `Retained tool lifecycle is incomplete for call ${call.callId}`,
      );
    }

    if (call.modelResponseId === undefined) continue;
    const responseCalls = calls.filter(
      (candidate) =>
        candidate.turnId === call.turnId &&
        candidate.modelResponseId === call.modelResponseId,
    );
    const responseMessage = coveredItems.find(
      (candidate) =>
        candidate.type === "agent_message" &&
        candidate.turnId === call.turnId &&
        candidate.id === call.modelResponseId,
    );
    const responsePartiallyRetained =
      responseCalls.some((candidate) => retained.has(candidate.id)) ||
      (responseMessage !== undefined && retained.has(responseMessage.id));
    if (
      responsePartiallyRetained &&
      (responseCalls.some((candidate) => !retained.has(candidate.id)) ||
        (responseMessage !== undefined && !retained.has(responseMessage.id)))
    ) {
      throw new Error(
        `Retained model tool response is incomplete: ${call.modelResponseId}`,
      );
    }
  }

  for (const result of coveredItems.filter(
    (candidate): candidate is ToolResultItem =>
      candidate.type === "tool_result",
  )) {
    const matchingCalls = calls.filter(
      (call) => call.turnId === result.turnId && call.callId === result.callId,
    );
    if (matchingCalls.length !== 1) {
      throw new Error(
        `Covered tool result must have exactly one call: ${result.callId}`,
      );
    }
    if (!retained.has(result.id)) continue;
    if (!matchingCalls.some((call) => retained.has(call.id))) {
      throw new Error(
        `Retained tool result has no retained call: ${result.callId}`,
      );
    }
  }

  for (const call of calls) {
    if (call.parentCallId === undefined) continue;
    const parent = callsByIdentity.get(`${call.turnId}\0${call.parentCallId}`);
    if (parent === undefined) {
      throw new Error(`Nested tool call has no covered parent: ${call.callId}`);
    }
    if (retained.has(call.id) !== retained.has(parent.id)) {
      throw new Error(
        `Retained nested tool lifecycle is incomplete for call ${call.callId}`,
      );
    }
  }
}

function requireNonEmpty(
  value: string,
  name: string,
  allowSurroundingWhitespace = false,
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (!allowSurroundingWhitespace && value.trim() !== value) ||
    value.trim().length === 0
  ) {
    throw new Error(`Context compaction ${name} must be non-empty`);
  }
}

function requireTokenCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Context compaction ${name} must be a non-negative integer`,
    );
  }
}

function requirePercentage(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error(
      `Context compaction ${name} must be an integer from 1 through 100`,
    );
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Context compaction ${name} must be a positive integer`);
  }
}

function requirePlainObject(
  value: unknown,
  name: string,
): asserts value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Context compaction ${name} must be an object`);
  }
}

function requireKnownKeys(
  value: object,
  name: string,
  knownKeys: readonly string[],
): void {
  const unknown = Object.keys(value).find((key) => !knownKeys.includes(key));
  if (unknown !== undefined) {
    throw new Error(
      `Context compaction ${name} contains unknown field ${unknown}`,
    );
  }
}
