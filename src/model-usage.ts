import type { CanonicalItem, ModelUsageItem } from "./item.js";

export interface ModelUsageAggregate {
  responseCount: number;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
  /** Token-weighted rate over only responses that report cached input. */
  cacheHitRate?: number;
}

export interface ModelUsageProjection {
  thread: ModelUsageAggregate;
  turns: Readonly<Record<string, ModelUsageAggregate>>;
}

export function projectModelUsage(
  items: readonly CanonicalItem[],
): ModelUsageProjection {
  const latestByResponse = new Map<string, ModelUsageItem>();
  for (const item of items) {
    if (item.type === "model_usage") {
      latestByResponse.set(item.modelResponseId, item);
    }
  }

  const byTurn = new Map<string, ModelUsageItem[]>();
  for (const item of latestByResponse.values()) {
    const usages = byTurn.get(item.turnId) ?? [];
    usages.push(item);
    byTurn.set(item.turnId, usages);
  }
  return {
    thread: aggregate([...latestByResponse.values()]),
    turns: Object.fromEntries(
      [...byTurn].map(([turnId, usages]) => [turnId, aggregate(usages)]),
    ),
  };
}

export function isModelUsageProjection(
  value: unknown,
): value is ModelUsageProjection {
  if (!isRecord(value) || !isAggregate(value.thread) || !isRecord(value.turns))
    return false;
  return Object.values(value.turns).every(isAggregate);
}

function isAggregate(value: unknown): value is ModelUsageAggregate {
  if (!isRecord(value)) return false;
  const inputTokens = value.inputTokens;
  const cachedInputTokens = value.cachedInputTokens;
  const outputTokens = value.outputTokens;
  const reasoningOutputTokens = value.reasoningOutputTokens;
  return (
    isCount(value.responseCount) &&
    isCount(inputTokens) &&
    isCount(outputTokens) &&
    (cachedInputTokens === undefined ||
      (isCount(cachedInputTokens) && cachedInputTokens <= inputTokens)) &&
    (reasoningOutputTokens === undefined ||
      (isCount(reasoningOutputTokens) &&
        reasoningOutputTokens <= outputTokens)) &&
    (value.cacheHitRate === undefined ||
      (typeof value.cacheHitRate === "number" &&
        Number.isFinite(value.cacheHitRate) &&
        value.cacheHitRate >= 0 &&
        value.cacheHitRate <= 1))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function aggregate(usages: readonly ModelUsageItem[]): ModelUsageAggregate {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let cacheEligibleInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let cacheReported = false;
  let reasoningReported = false;
  for (const usage of usages) {
    inputTokens = add(inputTokens, usage.inputTokens);
    outputTokens = add(outputTokens, usage.outputTokens);
    if (usage.cachedInputTokens !== undefined) {
      cacheReported = true;
      cachedInputTokens = add(cachedInputTokens, usage.cachedInputTokens);
      cacheEligibleInputTokens = add(
        cacheEligibleInputTokens,
        usage.inputTokens,
      );
    }
    if (usage.reasoningOutputTokens !== undefined) {
      reasoningReported = true;
      reasoningOutputTokens = add(
        reasoningOutputTokens,
        usage.reasoningOutputTokens,
      );
    }
  }
  return {
    responseCount: usages.length,
    inputTokens,
    ...(cacheReported ? { cachedInputTokens } : {}),
    outputTokens,
    ...(reasoningReported ? { reasoningOutputTokens } : {}),
    ...(cacheReported && cacheEligibleInputTokens > 0
      ? { cacheHitRate: cachedInputTokens / cacheEligibleInputTokens }
      : {}),
  };
}

function add(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new Error("Model usage total exceeded the safe integer range");
  }
  return sum;
}
