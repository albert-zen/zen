import type { CanonicalItem, ModelUsageItem } from "./item.js";
import type { ModelMessage } from "./model.js";

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
  context: ModelContextUsageProjection;
}

export interface ModelContextUsageProjection {
  inputTokens: number | null;
  inputTokenSource: "provider" | "estimated" | null;
  contextWindow: number | null;
  ratio: number | null;
}

export function projectModelUsage(
  items: readonly CanonicalItem[],
  options: {
    contextWindow?: number | null;
    estimatedInputTokens?: number;
  } = {},
): ModelUsageProjection {
  const latestByResponse = new Map<string, ModelUsageItem>();
  let latestUsage: { item: ModelUsageItem; index: number } | undefined;
  let latestCompactionIndex = -1;
  for (const [index, item] of items.entries()) {
    if (item.type === "model_usage") {
      latestByResponse.set(item.modelResponseId, item);
      latestUsage = { item, index };
    } else if (item.type === "context_compaction") {
      latestCompactionIndex = index;
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
    context: contextProjection({
      contextWindow: options.contextWindow ?? null,
      ...(options.estimatedInputTokens === undefined
        ? {}
        : { estimatedInputTokens: options.estimatedInputTokens }),
      latestCompactionIndex,
      ...(latestUsage === undefined ? {} : { latestUsage }),
    }),
  };
}

export function estimateModelMessageInputTokens(
  messages: readonly ModelMessage[],
): number {
  return messages.reduce(
    (total, message) => add(total, estimateModelMessage(message)),
    0,
  );
}

export function isModelUsageProjection(
  value: unknown,
): value is ModelUsageProjection {
  if (
    !isRecord(value) ||
    !isAggregate(value.thread) ||
    !isRecord(value.turns) ||
    !isContextProjection(value.context)
  )
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

function contextProjection(options: {
  contextWindow: number | null;
  estimatedInputTokens?: number;
  latestCompactionIndex: number;
  latestUsage?: { item: ModelUsageItem; index: number };
}): ModelContextUsageProjection {
  const canUseProviderUsage =
    options.latestUsage !== undefined &&
    options.latestUsage.index > options.latestCompactionIndex;
  const estimatedInputTokens = options.estimatedInputTokens;
  const providerInputTokens = canUseProviderUsage
    ? options.latestUsage?.item.inputTokens
    : undefined;
  const inputTokens = providerInputTokens ?? estimatedInputTokens;
  const source: ModelContextUsageProjection["inputTokenSource"] =
    inputTokens === undefined
      ? null
      : canUseProviderUsage
        ? "provider"
        : "estimated";
  const normalizedInput = inputTokens ?? null;
  return {
    inputTokens: normalizedInput,
    inputTokenSource: source,
    contextWindow: options.contextWindow,
    ratio:
      normalizedInput === null || options.contextWindow === null
        ? null
        : normalizedInput / options.contextWindow,
  };
}

function isContextProjection(
  value: unknown,
): value is ModelContextUsageProjection {
  if (!isRecord(value)) return false;
  return (
    (value.inputTokens === null || isCount(value.inputTokens)) &&
    (value.inputTokenSource === null ||
      value.inputTokenSource === "provider" ||
      value.inputTokenSource === "estimated") &&
    (value.contextWindow === null || isPositiveCount(value.contextWindow)) &&
    (value.ratio === null ||
      (typeof value.ratio === "number" &&
        Number.isFinite(value.ratio) &&
        value.ratio >= 0))
  );
}

function isPositiveCount(value: unknown): value is number {
  return isCount(value) && value > 0;
}

function estimateModelMessage(message: ModelMessage): number {
  switch (message.role) {
    case "assistant":
      return estimateText((message.text ?? "") + toolCallsText(message));
    case "reasoning":
      return estimateText(
        `${message.reasoningContent}\n${message.summary ?? ""}`,
      );
    case "tool":
      return estimateText(`${message.callId}\n${message.text}`);
    case "user":
      return "content" in message
        ? estimateText(
            message.content
              .map((part) =>
                part.type === "text"
                  ? part.text
                  : `[image:${part.attachment.mediaType}:${part.attachment.byteLength}]`,
              )
              .join("\n"),
          )
        : estimateText(message.text);
  }
}

function toolCallsText(message: ModelMessage): string {
  return "toolCalls" in message ? JSON.stringify(message.toolCalls) : "";
}

function estimateText(text: string): number {
  return Math.ceil(text.length / 4) + 4;
}

function add(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new Error("Model usage total exceeded the safe integer range");
  }
  return sum;
}
