import { extractChatGptAccountId } from "../../../../src/model/openai-subscription.js";

export interface SubscriptionQuotaWindow {
  usedPercent: number | null;
  windowDurationSeconds: number | null;
  /** Unix seconds, not milliseconds. */
  resetsAt: number | null;
}
export interface SubscriptionQuotaLimit {
  id: string;
  name: string | null;
  primary: SubscriptionQuotaWindow | null;
  secondary: SubscriptionQuotaWindow | null;
}
export interface SubscriptionUsage {
  accountId: string;
  fetchedAt: number;
  planType: string | null;
  limits: SubscriptionQuotaLimit[];
}
export class SubscriptionQuotaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SubscriptionQuotaError";
  }
}

/** Read-only ChatGPT subscription projection. Never forwards a raw response. */
export async function readSubscriptionUsage(options: {
  accessToken: string;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): Promise<SubscriptionUsage> {
  try {
    const accountId = extractChatGptAccountId(options.accessToken);
    const response = await (options.fetch ?? globalThis.fetch)(
      "https://chatgpt.com/backend-api/wham/usage",
      {
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${options.accessToken}`,
          "ChatGPT-Account-Id": accountId,
          Accept: "application/json",
        },
        signal: options.signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new SubscriptionQuotaError(
        response.status === 401
          ? "Quota authentication expired. Sign in again."
          : `Quota query failed (HTTP ${response.status}). Try refreshing.`,
        response.status,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new SubscriptionQuotaError("Quota response is empty.");
    let text = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 1024 * 1024) {
          await reader.cancel();
          throw new SubscriptionQuotaError("Quota response is too large.");
        }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    options.signal.throwIfAborted();
    const body = object(JSON.parse(text));
    if (
      !body ||
      !(
        "rate_limit" in body ||
        "additional_rate_limits" in body ||
        "plan_type" in body
      )
    )
      throw new SubscriptionQuotaError("Quota response could not be read.");
    if (body.account_id != null && body.account_id !== accountId)
      throw new SubscriptionQuotaError(
        "Quota account changed. Refresh to try again.",
      );
    const limits: SubscriptionQuotaLimit[] = [
      limit("codex", "Codex", body.rate_limit),
    ];
    if (body.code_review_rate_limit != null)
      limits.push(
        limit("code-review", "Code review", body.code_review_rate_limit),
      );
    if (Array.isArray(body.additional_rate_limits)) {
      if (body.additional_rate_limits.length > 64)
        throw new SubscriptionQuotaError(
          "Quota response contains too many limits.",
        );
      for (const [index, value] of body.additional_rate_limits.entries()) {
        const item = object(value);
        if (!item) continue;
        limits.push(
          limit(
            label(item.metered_feature) ?? `additional-${index}`,
            label(item.limit_name),
            item.rate_limit,
          ),
        );
      }
    }
    return {
      accountId,
      fetchedAt: Date.now(),
      planType: label(body.plan_type),
      limits,
    };
  } catch (error) {
    if (error instanceof SubscriptionQuotaError) throw error;
    throw new SubscriptionQuotaError(
      options.signal.aborted
        ? "Quota query timed out or was cancelled. Try refreshing."
        : "Quota query failed. Check your connection and try refreshing.",
    );
  }
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function label(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 160
    ? value
    : null;
}
function positive(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= maximum
    ? value
    : null;
}
function window(value: unknown): SubscriptionQuotaWindow | null {
  const item = object(value);
  if (!item) return null;
  const duration = positive(item.limit_window_seconds);
  return {
    usedPercent: positive(item.used_percent),
    windowDurationSeconds: duration === 0 ? null : duration,
    resetsAt: positive(item.reset_at, 8_640_000_000_000),
  };
}
function limit(
  id: string,
  name: string | null,
  value: unknown,
): SubscriptionQuotaLimit {
  const item = object(value);
  return {
    id,
    name,
    primary: window(item?.primary_window),
    secondary: window(item?.secondary_window),
  };
}
