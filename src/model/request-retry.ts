import { setTimeout as delay } from "node:timers/promises";

/** Request admission only: never consumes or replays a successful model stream. */
export interface ModelRequestRetryOptions {
  random?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export async function fetchModelResponse(
  request: () => Promise<Response>,
  signal: AbortSignal,
  options: ModelRequestRetryOptions = {},
): Promise<Response> {
  const sleep =
    options.sleep ??
    (async (ms, abortSignal) => {
      await delay(ms, undefined, { signal: abortSignal });
    });
  const random = options.random ?? Math.random;
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let response: Response | undefined;
    let failure: unknown;
    try {
      response = await request();
    } catch (error) {
      signal.throwIfAborted();
      if (!isTransientTransportError(error)) throw error;
      failure = error;
    }
    if (
      response !== undefined &&
      ![408, 429, 500, 502, 503, 504].includes(response.status)
    )
      return response;
    if (attempt === 3) {
      if (response !== undefined) return response;
      throw failure;
    }
    const retryAfter = response?.headers.get("retry-after");
    const advertisedDelay =
      retryAfter === null || retryAfter === undefined
        ? 0
        : retryAfterMilliseconds(retryAfter);
    const milliseconds = Math.max(
      advertisedDelay,
      Math.round(1000 * 2 ** attempt * (1 + random())),
    );
    // Respect a long server cooldown by returning the failure, never retrying early.
    if (waited + milliseconds > 120_000) {
      if (response !== undefined) return response;
      throw failure;
    }
    await response?.body?.cancel().catch(() => undefined);
    signal.throwIfAborted();
    console.warn("Model request retry", {
      attempt: attempt + 2,
      maxAttempts: 4,
      delayMs: milliseconds,
      reason: response?.status ?? "transport",
    });
    await sleep(milliseconds, signal);
    waited += milliseconds;
  }
}

function retryAfterMilliseconds(value: string): number {
  if (/^\d+(?:\.\d+)?$/u.test(value.trim())) return Number(value) * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

function isTransientTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = error.cause as { code?: string } | undefined;
  if (cause?.code !== undefined) {
    return [
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENOTFOUND",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(cause.code);
  }
  return (
    error instanceof TypeError &&
    /fetch failed|network|load failed/iu.test(error.message)
  );
}
