import type {
  AgenticContextCompactionItem,
  CanonicalItem,
  ContextCompactionItem,
  ToolCallItem,
  ToolResultItem,
} from "./item.js";
import type { ModelTool } from "./model.js";

export const CONTEXT_COMPACTION_ALGORITHM_VERSION = "zen.context-compaction.v3";
export const AGENTIC_CONTEXT_COMPACTION_ALGORITHM_VERSION =
  "zen.context-compaction.agentic.v2";
export const AGENTIC_CONTEXT_COMPACTION_TOOL_NAME = "compact_context";
export const AGENTIC_CONTEXT_COMPACTION_RETENTION_GUIDANCE =
  "Save detailed memory to files and put the paths and next steps in text. Omit retention for summary-only context, or choose recentItemCount and/or recentUserMessageCount/recentFinalMessageCount/recentAgentMessageCount; counts are combined without duplicates. Alternatively use tokenBudget alone to keep the newest complete context that fits that estimated retained-history token allowance. Do not combine tokenBudget with counts. Complete tool call/result groups may add Items; explicit counts must fit the remaining model capacity or the call fails without reset.";
export const AGENTIC_CONTEXT_COMPACTION_TOOL: ModelTool = Object.freeze({
  name: AGENTIC_CONTEXT_COMPACTION_TOOL_NAME,
  description: `Replace this active Turn's working context with your exact continuation text and optional coarse retention. ${AGENTIC_CONTEXT_COMPACTION_RETENTION_GUIDANCE} A bounded original Thread reference is included by default. Call alone as a top-level tool.`,
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      text: Object.freeze({
        type: "string",
        description:
          "Exact continuation text. Save detailed memory to files first; include their paths, the goal and next steps here so details can be read on demand.",
      }),
      retention: Object.freeze({
        type: "object",
        description:
          "Choose recent counts (combined without duplicates) OR tokenBudget alone. Omitted retention keeps only the continuation text. Counts refer to currently eligible context, not individual Item IDs. Tool-response groups remain complete.",
        properties: Object.freeze({
          recentItemCount: {
            type: "integer",
            minimum: 0,
            description:
              "Newest model-context Items, including top-level tool calls/results; complete tool groups may add Items.",
          },
          recentUserMessageCount: {
            type: "integer",
            minimum: 0,
            description: "Newest user messages.",
          },
          recentFinalMessageCount: {
            type: "integer",
            minimum: 0,
            description:
              "Newest final assistant messages from successfully completed Turns.",
          },
          recentAgentMessageCount: {
            type: "integer",
            minimum: 0,
            description:
              "Newest complete assistant messages, including final messages and messages accompanying tool calls.",
          },
          tokenBudget: {
            type: "integer",
            minimum: 0,
            description:
              "Use alone: estimated tokens for the newest complete retained history, excluding continuation text, tools and instructions. Capped by remaining model capacity; may retain less than requested.",
          },
        }),
        additionalProperties: false,
      }),
      includeOriginalReference: Object.freeze({
        type: "boolean",
        description:
          "Include a bounded original Thread locator (default true).",
      }),
    }),
    required: Object.freeze(["text"]),
    additionalProperties: false,
  }),
});

export interface AgenticCompactionRetention {
  recentItemCount?: number;
  recentUserMessageCount?: number;
  recentFinalMessageCount?: number;
  recentAgentMessageCount?: number;
  tokenBudget?: number;
}

/** Current tool arguments only; old committed selections replay their exact retained IDs. */
export function normalizeAgenticCompactionRetention(
  value: unknown,
): AgenticCompactionRetention {
  if (value === undefined) return {};
  requirePlainObject(value, "retention");
  const supplied = value as Record<string, unknown>;
  const keys = [
    "recentItemCount",
    "recentUserMessageCount",
    "recentFinalMessageCount",
    "recentAgentMessageCount",
    "tokenBudget",
  ];
  if (Object.keys(supplied).some((key) => !keys.includes(key)))
    throw new Error(
      "Use recent Item/message counts or tokenBudget; individual Item references, ranges and legacy retention options are no longer accepted by compact_context",
    );
  for (const [key, count] of Object.entries(supplied))
    requireNonNegativeInteger(count as number, `retention.${key}`);
  if (supplied.tokenBudget !== undefined && Object.keys(supplied).length !== 1)
    throw new Error(
      "Choose tokenBudget alone OR recent Item/message counts, not both",
    );
  return { ...supplied } as AgenticCompactionRetention;
}

export const CONTEXT_COMPACTION_SUMMARY_MARKER = "ZEN_CONTEXT_COMPACTION_V1";
export const CONTEXT_COMPACTION_SUMMARY_PREFIX = "[Zen compacted context]\n";

export const CONTEXT_COMPACTION_SUMMARY_INSTRUCTION = `${CONTEXT_COMPACTION_SUMMARY_MARKER}
Summarize the conversation context above for a provider-neutral agent continuation.
Preserve concrete user goals, decisions, constraints, unfinished work, exact identifiers,
and tool outcomes that affect future work. Do not call tools. Return only the summary.`;

export interface ContextCompactionConfig {
  includeOriginalReference?: boolean;
  agenticEnabled?: boolean;
  summaryInstruction?: string;
  triggerPercent?: number;
  targetPercent?: number;
  retention?: {
    mode?: "budget" | "recent-items" | "selected-items";
    recentItemCount?: number;
    preserveUserMessages?: boolean;
    finalMessages?: "none" | "all" | "recent";
    finalMessageCount?: number;
    recentTurnCount?: number;
    itemIds?: string[];
    itemRanges?: { fromItemId: string; toItemId: string }[];
  };
}

export interface ResolvedContextCompactionConfig {
  includeOriginalReference: boolean;
  agenticEnabled: boolean;
  summaryInstruction: string;
  triggerPercent: number;
  targetPercent: number;
  retention: {
    mode: "budget" | "recent-items" | "selected-items";
    recentItemCount: number;
    preserveUserMessages: boolean;
    finalMessages: "none" | "all" | "recent";
    finalMessageCount: number;
    recentTurnCount: number;
    itemIds: string[];
    itemRanges: { fromItemId: string; toItemId: string }[];
  };
}

export interface CompactionBoundary {
  item: CanonicalItem;
  index: number;
  retainedItemIds: string[];
}

export interface BoundedCompactionBoundaryOptions {
  retainedTokenBudget: number;
  estimateRetainedTokens: (items: readonly CanonicalItem[]) => number;
  retention?: ResolvedContextCompactionConfig["retention"];
  allowOpenTurns?: boolean;
}

export function normalizeContextCompactionConfig(
  config: ContextCompactionConfig = {},
): ResolvedContextCompactionConfig {
  requirePlainObject(config, "config");
  requireKnownKeys(config, "config", [
    "agenticEnabled",
    "includeOriginalReference",
    "summaryInstruction",
    "triggerPercent",
    "targetPercent",
    "retention",
  ]);
  const includeOriginalReference = config.includeOriginalReference ?? true;
  if (typeof includeOriginalReference !== "boolean")
    throw new Error(
      "Context compaction includeOriginalReference must be a boolean",
    );
  const agenticEnabled = config.agenticEnabled ?? false;
  if (typeof agenticEnabled !== "boolean") {
    throw new Error("Context compaction agenticEnabled must be a boolean");
  }
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
    "recentTurnCount",
    "itemIds",
    "itemRanges",
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
  const recentTurnCount = retention.recentTurnCount ?? 0;
  requireNonNegativeInteger(recentTurnCount, "retention.recentTurnCount");
  const itemIds = retention.itemIds ?? [];
  if (
    !Array.isArray(itemIds) ||
    itemIds.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new Error(
      "Context compaction retention.itemIds must be non-empty strings",
    );
  }
  const itemRanges = retention.itemRanges ?? [];
  if (
    !Array.isArray(itemRanges) ||
    itemRanges.some(
      (range) =>
        typeof range !== "object" ||
        range === null ||
        Array.isArray(range) ||
        Object.keys(range).some(
          (key) => !["fromItemId", "toItemId"].includes(key),
        ) ||
        typeof range.fromItemId !== "string" ||
        !range.fromItemId.trim() ||
        typeof range.toItemId !== "string" ||
        !range.toItemId.trim(),
    )
  )
    throw new Error(
      "Context compaction retention.itemRanges must have fromItemId and toItemId",
    );
  return {
    agenticEnabled,
    includeOriginalReference,
    summaryInstruction,
    triggerPercent,
    targetPercent,
    retention: {
      mode,
      recentItemCount,
      preserveUserMessages,
      finalMessages,
      finalMessageCount,
      recentTurnCount,
      itemIds: [...itemIds],
      itemRanges: itemRanges.map((range) => ({ ...range })),
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

export function isAgenticContextCompaction(
  item: ContextCompactionItem,
): item is AgenticContextCompactionItem {
  return item.provenance === "agentic";
}

/**
 * Return canonical Items that remain eligible for future retention after the
 * latest agent-authored reset. The reset summary itself is projected
 * separately and therefore has no canonical retained Item.
 */
export function itemsAfterLatestAgenticCompaction(
  items: readonly CanonicalItem[],
): readonly CanonicalItem[] {
  const compactionIndex = items.findLastIndex(
    (item) =>
      item.type === "context_compaction" && isAgenticContextCompaction(item),
  );
  const compaction = items[compactionIndex];
  if (
    compactionIndex < 0 ||
    compaction?.type !== "context_compaction" ||
    !isAgenticContextCompaction(compaction)
  ) {
    return items;
  }
  const boundaryIndex = items.findIndex(
    (item) => item.id === compaction.coveredThroughItemId,
  );
  if (boundaryIndex < 0) return items;
  const sourceCallIds = new Set(
    items
      .slice(boundaryIndex + 1)
      .filter(
        (item): item is ToolCallItem =>
          item.type === "tool_call" &&
          item.turnId === compaction.turnId &&
          item.modelResponseId === compaction.sourceModelResponseId,
      )
      .map((item) => item.callId),
  );
  return items.slice(boundaryIndex + 1).filter((item, offset) => {
    const index = boundaryIndex + 1 + offset;
    if (item.type === "context_compaction") return false;
    if (
      index < compactionIndex &&
      item.type === "reasoning" &&
      item.turnId === compaction.turnId
    ) {
      return false;
    }
    if (
      item.type === "agent_message" &&
      item.turnId === compaction.turnId &&
      item.id === compaction.sourceModelResponseId
    ) {
      return false;
    }
    if (
      item.type === "tool_call" &&
      item.turnId === compaction.turnId &&
      item.modelResponseId === compaction.sourceModelResponseId
    ) {
      return false;
    }
    if (
      item.type === "tool_result" &&
      item.turnId === compaction.turnId &&
      sourceCallIds.has(item.callId)
    ) {
      return false;
    }
    return true;
  });
}

/** Current retention eligibility, unlike the compiler's post-reset suffix. */
function agenticRetentionCandidates(
  items: readonly CanonicalItem[],
): readonly CanonicalItem[] {
  const suffix = itemsAfterLatestAgenticCompaction(items);
  const reset = items.findLast(
    (item) =>
      item.type === "context_compaction" && isAgenticContextCompaction(item),
  );
  if (reset?.type !== "context_compaction") return suffix;
  const eligible = new Set([
    ...suffix.map((item) => item.id),
    ...reset.retainedItemIds,
  ]);
  return items.filter((item) => eligible.has(item.id));
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
    if (item?.type !== "turn_completed" || item.status !== "completed")
      continue;
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

/**
 * Return the newest completed Turn boundary while an unrelated Turn remains
 * active. Active-Turn host compaction summarizes history up to this boundary
 * and leaves the current Turn items in the projected suffix.
 */
export function latestCompletedCompactionBoundary(
  items: readonly CanonicalItem[],
): CompactionBoundary | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type !== "turn_completed" || item.status !== "completed")
      continue;
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
  const boundary = options.allowOpenTurns
    ? latestCompletedCompactionBoundary(items)
    : latestEligibleCompactionBoundary(items);
  if (boundary === undefined) return undefined;

  return planCompactionRetention(items, boundary, options);
}

/** Shared deterministic retention plan for generated and active-Turn compaction. */
export function planCompactionRetention(
  items: readonly CanonicalItem[],
  boundary: CompactionBoundary,
  options: BoundedCompactionBoundaryOptions,
): CompactionBoundary {
  const coveredItems = items.slice(0, boundary.index + 1);
  const retainableItems = itemsAfterLatestAgenticCompaction(coveredItems);
  const turnItems = retainableItems.filter(
    (candidate) => candidate.turnId === boundary.item.turnId,
  );
  validateRetainedToolClosure(
    retainableItems,
    new Set(boundary.retainedItemIds),
  );

  const retention =
    options.retention ?? normalizeContextCompactionConfig().retention;
  const pinned = expandRetainedToolClosure(
    retainableItems,
    explicitlyRetainedIds(retainableItems, coveredItems, retention),
  );

  if (retention.mode !== "budget") {
    const selected = new Set(pinned);
    if (retention.mode === "recent-items") {
      const candidates = recentItemCandidates(retainableItems);
      for (const candidate of candidates.slice(-retention.recentItemCount)) {
        selected.add(candidate.id);
      }
    }
    const retained = expandRetainedToolClosure(retainableItems, selected);
    const retainedItems = itemsInCanonicalOrder(retainableItems, retained);
    validateRetainedToolClosure(retainableItems, retained);
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
      validateRetainedToolClosure(retainableItems, retained);
    } catch {
      continue;
    }
    const retainedItems = itemsInCanonicalOrder(retainableItems, retained);
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

/** Agent-authored retention selects coarse current-history groups, never model-facing IDs. */
export function planAgenticCompactionRetention(
  items: readonly CanonicalItem[],
  boundary: CompactionBoundary,
  options: {
    retainedTokenBudget: number;
    estimateRetainedTokens: (items: readonly CanonicalItem[]) => number;
    retention: AgenticCompactionRetention;
  },
): CompactionBoundary {
  const covered = items.slice(0, boundary.index + 1);
  const eligible = agenticRetentionCandidates(covered);
  const retention = options.retention;
  const candidates = recentItemCandidates(eligible);
  const budget = Math.min(
    options.retainedTokenBudget,
    retention.tokenBudget ?? options.retainedTokenBudget,
  );
  const plan = (ids: ReadonlySet<string>) => {
    const closed = expandRetainedToolClosure(eligible, ids);
    validateRetainedToolClosure(eligible, closed);
    const retained = itemsInCanonicalOrder(eligible, closed);
    return options.estimateRetainedTokens(retained) <= budget
      ? { ...boundary, retainedItemIds: retained.map((item) => item.id) }
      : undefined;
  };
  if (retention.tokenBudget !== undefined) {
    for (let start = 0; start <= candidates.length; start++) {
      const result = plan(
        new Set(candidates.slice(start).map((item) => item.id)),
      );
      if (result !== undefined) return result;
    }
  } else {
    const selected = new Set<string>();
    const take = (
      items: readonly CanonicalItem[],
      count: number | undefined,
    ) => {
      if (count !== undefined && count > 0)
        for (const item of items.slice(-count)) selected.add(item.id);
    };
    take(candidates, retention.recentItemCount);
    take(
      eligible.filter((item) => item.type === "user_message"),
      retention.recentUserMessageCount,
    );
    // Completion records may have been omitted by a prior reset; classify using
    // the original covered facts, then intersect the currently eligible messages.
    const eligibleIds = new Set(eligible.map((item) => item.id));
    take(
      successfulFinalMessages(covered).filter((item) =>
        eligibleIds.has(item.id),
      ),
      retention.recentFinalMessageCount,
    );
    take(
      eligible.filter(
        (item) => item.type === "agent_message" && item.incomplete !== true,
      ),
      retention.recentAgentMessageCount,
    );
    const result = plan(selected);
    if (result !== undefined) return result;
  }
  throw new Error(
    "Requested retained context and complete tool groups exceed the remaining model capacity; choose smaller counts or tokenBudget alone",
  );
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
    item.type === "host_message" ||
    item.type === "thread_message" ||
    item.type === "thread_instruction" ||
    (item.type === "agent_message" && item.incomplete !== true) ||
    item.type === "tool_call" ||
    item.type === "tool_result" ||
    item.type === "failure"
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
    // Repair prompts consume tokens, but do not displace recent conversation slots.
    if (item.type === "failure" && item.recovery !== undefined) return false;
    if (item.type === "tool_call") return item.parentCallId === undefined;
    if (item.type === "tool_result") {
      return !nestedCalls.has(`${item.turnId}\0${item.callId}`);
    }
    return true;
  });
}

function explicitlyRetainedIds(
  retainableItems: readonly CanonicalItem[],
  coveredItems: readonly CanonicalItem[],
  retention: ResolvedContextCompactionConfig["retention"],
): Set<string> {
  const retained = new Set<string>();
  const byId = new Map(retainableItems.map((item) => [item.id, item]));
  for (const range of retention.itemRanges) {
    const from = retainableItems.findIndex(
      (item) => item.id === range.fromItemId,
    );
    const to = retainableItems.findIndex((item) => item.id === range.toItemId);
    const fullFrom = coveredItems.findIndex(
      (item) => item.id === range.fromItemId,
    );
    const fullTo = coveredItems.findIndex((item) => item.id === range.toItemId);
    if (
      from < 0 ||
      to < from ||
      fullFrom < 0 ||
      fullTo < fullFrom ||
      coveredItems
        .slice(fullFrom, fullTo + 1)
        .some(
          (item) =>
            item.threadId !== retainableItems[from]?.threadId ||
            (!isStructuralCompactionItem(item) &&
              (!projectsIntoModelContext(item) || !byId.has(item.id))),
        )
    ) {
      throw new Error(
        "Invalid compaction retention Item range: contains unavailable content; select eligible Item IDs, a category, or recent Turns",
      );
    }
    for (const item of retainableItems.slice(from, to + 1)) {
      if (projectsIntoModelContext(item)) retained.add(item.id);
    }
  }
  for (const id of retention.itemIds) {
    const item = byId.get(id);
    if (item === undefined || !projectsIntoModelContext(item)) {
      throw new Error("Item is not eligible for compaction retention");
    }
    retained.add(id);
  }
  if (retention.recentTurnCount > 0) {
    // Resolve Turn identity from the full covered journal. The previous
    // agentic reset may have removed turn_started from retainableItems.
    const started = coveredItems.filter((item) => item.type === "turn_started");
    const turns = new Set(
      started.slice(-retention.recentTurnCount).map((item) => item.turnId),
    );
    for (const item of retainableItems) {
      if (
        item.turnId !== undefined &&
        turns.has(item.turnId) &&
        projectsIntoModelContext(item)
      )
        retained.add(item.id);
    }
  }
  if (retention.preserveUserMessages) {
    for (const item of retainableItems) {
      if (item.type === "user_message") retained.add(item.id);
    }
  }
  if (retention.finalMessages !== "none") {
    const finals = successfulFinalMessages(retainableItems);
    const selected =
      retention.finalMessages === "all"
        ? finals
        : finals.slice(-retention.finalMessageCount);
    for (const item of selected) retained.add(item.id);
  }
  return retained;
}

/** Non-projecting journal control Items can anchor a range, not enter model context. */
function isStructuralCompactionItem(item: CanonicalItem): boolean {
  return (
    item.type === "turn_started" ||
    item.type === "turn_completed" ||
    item.type === "turn_aborted" ||
    item.type === "turn_replacement_requested" ||
    item.type === "thread_metadata" ||
    item.type === "thread_forked" ||
    item.type === "thread_deleted" ||
    item.type === "thread_restored" ||
    item.type === "thread_configuration_changed" ||
    item.type === "context_compaction" ||
    item.type === "model_usage" ||
    item.type === "code_state"
  );
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
        if (final !== undefined && final.incomplete !== true)
          finals.push(final);
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
  if (!Array.isArray(runtimeItem.retainedItemIds)) {
    throw new Error("Context compaction retainedItemIds must be an array");
  }

  requireNonEmpty(item.coveredThroughItemId, "coveredThroughItemId");
  requireNonEmpty(item.summary, "summary", true);
  requireNonEmpty(item.algorithmVersion, "algorithmVersion");

  if (isAgenticContextCompaction(item)) {
    validateAgenticContextCompactionItem(items, item);
    return;
  }
  if ("turnId" in runtimeItem) {
    throw new Error(
      "Provider-generated context compaction must not belong to a Turn",
    );
  }
  if (
    typeof runtimeItem.tokenUsage !== "object" ||
    runtimeItem.tokenUsage === null ||
    Array.isArray(runtimeItem.tokenUsage)
  ) {
    throw new Error("Context compaction tokenUsage must be an object");
  }
  requireNonEmpty(item.providerProfileId, "providerProfileId");
  requireNonEmpty(item.modelId, "modelId");
  if (item.reasoningEffort !== null) {
    requireNonEmpty(item.reasoningEffort, "reasoningEffort");
  }
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
  const latestBoundary = latestCompletedCompactionBoundary(items);
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
  const retainableIds = new Set(
    itemsAfterLatestAgenticCompaction(items.slice(0, boundaryIndex + 1)).map(
      (candidate) => candidate.id,
    ),
  );
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
    if (!retainableIds.has(retainedId)) {
      throw new Error(
        `Retained Item precedes the latest agentic compaction: ${retainedId}`,
      );
    }
    if (index <= previousIndex) {
      throw new Error("Retained Item ids must follow stable canonical order");
    }
    previousIndex = index;
  }

  validateRetainedToolClosure(
    itemsAfterLatestAgenticCompaction(items.slice(0, boundaryIndex + 1)),
    retained,
  );
}

function validateAgenticContextCompactionItem(
  items: readonly CanonicalItem[],
  item: AgenticContextCompactionItem,
): void {
  requireNonEmpty(item.turnId, "turnId");
  requireNonEmpty(item.callId, "callId");
  requireNonEmpty(item.sourceModelResponseId, "sourceModelResponseId");

  const boundaryIndex = items.findIndex(
    (candidate) => candidate.id === item.coveredThroughItemId,
  );
  if (boundaryIndex < 0) {
    throw new Error(
      `Context compaction boundary does not exist: ${item.coveredThroughItemId}`,
    );
  }
  if (items[boundaryIndex]?.turnId !== item.turnId) {
    throw new Error(
      "Agentic context compaction boundary must belong to its Turn",
    );
  }
  const callIndexes = items.flatMap((candidate, index) =>
    candidate.type === "tool_call" &&
    candidate.turnId === item.turnId &&
    candidate.callId === item.callId
      ? [index]
      : [],
  );
  if (callIndexes.length !== 1) {
    throw new Error(
      "Agentic context compaction requires exactly one source tool call",
    );
  }
  const callIndex = callIndexes[0]!;
  const call = items[callIndex];
  if (
    call?.type !== "tool_call" ||
    call.name !== AGENTIC_CONTEXT_COMPACTION_TOOL_NAME ||
    call.parentCallId !== undefined ||
    call.modelResponseId !== item.sourceModelResponseId
  ) {
    throw new Error(
      "Agentic context compaction must reference one top-level compact_context call",
    );
  }
  if (callIndex <= boundaryIndex) {
    throw new Error(
      "Agentic context compaction source call must follow its sample boundary",
    );
  }
  const sourceCalls = items
    .slice(boundaryIndex + 1)
    .filter(
      (candidate): candidate is ToolCallItem =>
        candidate.type === "tool_call" &&
        candidate.turnId === item.turnId &&
        candidate.modelResponseId === item.sourceModelResponseId,
    );
  if (sourceCalls.length !== 1 || sourceCalls[0]?.id !== call.id) {
    throw new Error(
      "Agentic context compaction source model response must contain only its standalone call",
    );
  }
  if (
    items.some(
      (candidate) =>
        candidate.type === "tool_result" &&
        candidate.turnId === item.turnId &&
        candidate.callId === item.callId,
    )
  ) {
    throw new Error(
      "Agentic context compaction must commit before its source tool result",
    );
  }
  if (
    items.some(
      (candidate) =>
        candidate.turnId === item.turnId &&
        (candidate.type === "turn_completed" ||
          candidate.type === "turn_aborted"),
    )
  ) {
    throw new Error("Agentic context compaction requires an active Turn");
  }
  const retainable = agenticRetentionCandidates(
    items.slice(0, boundaryIndex + 1),
  );
  const available = new Set(retainable.map((candidate) => candidate.id));
  let lastIndex = -1;
  for (const id of item.retainedItemIds) {
    const index = items.findIndex((candidate) => candidate.id === id);
    if (
      !available.has(id) ||
      index <= lastIndex ||
      items[index]?.type === "reasoning"
    ) {
      throw new Error(
        `Agentic compaction retained Item is invalid or out of order: ${id}`,
      );
    }
    lastIndex = index;
  }
  validateRetainedToolClosure(retainable, new Set(item.retainedItemIds));
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

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Context compaction ${name} must be a non-negative integer`,
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

/** Stable logical locator; reading it requires the same authorized Thread API as ordinary history. */
export function originalItemListReference(
  threadId: string,
  cutoffId: string,
): string {
  return `zen-thread://${encodeURIComponent(threadId)}/items?through=${encodeURIComponent(cutoffId)}`;
}
export function originalHistoryBoundary(
  items: readonly CanonicalItem[],
  throughItemId: string,
): number {
  const boundary = items.findIndex((item) => item.id === throughItemId);
  if (
    boundary < 0 ||
    !items.some(
      (item, index) =>
        index > boundary &&
        item.type === "context_compaction" &&
        item.coveredThroughItemId === throughItemId &&
        item.includeOriginalReference === true,
    )
  ) {
    throw new Error(
      "Original ItemList reference is not enabled for this boundary",
    );
  }
  return boundary;
}

export function originalItemListReferenceText(
  threadId: string,
  throughItemId: string,
): string {
  return `\n[Original ItemList: ${originalItemListReference(threadId, throughItemId)}; logical reference, not a filesystem path. Read only through an available authorized history reader; do not infer hidden content]`;
}

export function compactionSummaryText(item: ContextCompactionItem): string {
  return `${CONTEXT_COMPACTION_SUMMARY_PREFIX}${item.summary}${item.includeOriginalReference !== true ? "" : originalItemListReferenceText(item.threadId, item.coveredThroughItemId)}`;
}
