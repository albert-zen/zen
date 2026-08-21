import type {
  CanonicalItem,
  ContextCompactionItem,
  ToolCallItem,
  ToolResultItem,
} from "./item.js";

export const CONTEXT_COMPACTION_ALGORITHM_VERSION = "zen.context-compaction.v1";
export const CONTEXT_COMPACTION_SUMMARY_MARKER = "ZEN_CONTEXT_COMPACTION_V1";
export const CONTEXT_COMPACTION_SUMMARY_PREFIX = "[Zen compacted context]\n";

export const CONTEXT_COMPACTION_SUMMARY_INSTRUCTION = `${CONTEXT_COMPACTION_SUMMARY_MARKER}
Summarize the conversation context above for a provider-neutral agent continuation.
Preserve concrete user goals, decisions, constraints, unfinished work, exact identifiers,
and tool outcomes that affect future work. Do not call tools. Return only the summary.`;

export interface CompactionBoundary {
  item: Extract<CanonicalItem, { type: "turn_completed" }>;
  index: number;
  retainedItemIds: string[];
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
  requireNonEmpty(item.reasoningEffort, "reasoningEffort");
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
