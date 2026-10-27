import { traceClock } from "../trace.js";
import { inspect } from "node:util";
import type { ModelRequest, ModelRequestObservation } from "../model.js";
import type {
  ModelDispatchRevocationReason,
  ModelTransportError,
  ModelTransportHooks,
  ModelTransportObservation,
  ModelTransportObserver,
} from "./transport-types.js";
export type { ModelTransportObservation } from "./transport-types.js";

/** A terminal parser fact; never a wire field or permission to do more work. */
export const MODEL_RESPONSE_TERMINAL = Symbol("model-response-terminal");

export class ModelDispatchRevokedError extends Error {
  readonly modelRecoveryBlocked = true;
  readonly retryable = false;
  readonly reason: ModelDispatchRevocationReason;
  readonly preparedRequestCaptured: boolean;
  // Do not use native `cause`: admission retries inspect cause.code, and must
  // never mistake an authorization assertion failure for a transient network error.
  readonly originalError: unknown;
  constructor(
    reason: ModelDispatchRevocationReason = "provider_revoked",
    options: { preparedRequestCaptured?: boolean; cause?: unknown } = {},
  ) {
    super(`Model dispatch blocked: ${reason}`);
    this.name = "ModelDispatchRevokedError";
    this.reason = reason;
    this.preparedRequestCaptured = options.preparedRequestCaptured ?? false;
    this.originalError = options.cause;
  }
}

const captureOwners = new WeakMap<ModelTransportObserver, object>();
interface ActiveDrain {
  cancel(): Promise<void>;
  done: Promise<void>;
}
const activeDrains = new Map<object, Set<ActiveDrain>>();
export function setModelTransportCaptureOwner(
  observer: ModelTransportObserver,
  owner: object,
): void {
  captureOwners.set(observer, owner);
}
/** Call after stopping new samples; joins only this owner's passive body drains. */
export async function closeModelTransportCaptures(
  owner: object,
): Promise<void> {
  await Promise.all(
    [...(activeDrains.get(owner) ?? [])].map(async (drain) => {
      await drain.cancel();
      await drain.done;
    }),
  );
}

/** Preserve local request text verbatim. No body-field or secret-value redaction. */
export async function observeRequestBody(
  request: ModelRequest,
  body: string,
  format: ModelRequestObservation["format"],
  provider: string,
  transportAttempt: number,
  _legacySecrets: readonly string[] = [],
): Promise<void> {
  try {
    await request.onRequest?.({
      format,
      body,
      originalBytes: Buffer.byteLength(body, "utf8"),
      redacted: false,
      transportAttempt,
      provider,
      model: request.model,
    });
  } catch {
    console.error("Model request observation failed; capture is incomplete");
  }
}

/** Observe one actual attempt without cloning the response or reserializing input. */
export async function fetchObservedModelResponse(options: {
  request: ModelRequest & ModelTransportHooks;
  fetch: typeof globalThis.fetch;
  url: string;
  init: RequestInit;
  format: ModelRequestObservation["format"];
  provider: string;
  transportAttempt: number;
}): Promise<Response> {
  const { request, transportAttempt, url, provider, format, fetch } = options;
  const model = request.model;
  // Freeze the submitted shape before observers can run. The original body
  // value is passed unchanged; unsupported BodyInit values are never encoded.
  const init: RequestInit = { ...options.init };
  const assertDispatchAllowed = request.assertDispatchAllowed;
  const observer = request.onTransport;
  const emit = async (event: ModelTransportObservation): Promise<void> => {
    try {
      await observer?.(event);
    } catch {
      console.error(
        "Model transport observation failed; capture is incomplete",
      );
    }
  };
  const check = (preparedRequestCaptured: boolean): void => {
    request.signal.throwIfAborted();
    init.signal?.throwIfAborted();
    try {
      const result: unknown = assertDispatchAllowed?.();
      if (
        result !== undefined &&
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        "then" in result &&
        typeof result.then === "function"
      ) {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error("Model dispatch assertions must be synchronous");
      }
    } catch (error) {
      throw new ModelDispatchRevokedError(
        error instanceof ModelDispatchRevokedError
          ? error.reason
          : "provider_revoked",
        { preparedRequestCaptured, cause: error },
      );
    }
  };
  const blocked = async (
    error: unknown,
    preparedRequestCaptured: boolean,
  ): Promise<void> => {
    await emit({
      type: "dispatch_blocked",
      captureLayer: "fetch-request-input",
      transportAttempt,
      reason:
        error instanceof ModelDispatchRevokedError
          ? error.reason
          : "request_aborted",
      preparedRequestCaptured,
      error: describeError(error),
    });
  };
  try {
    check(false);
  } catch (error) {
    await blocked(error, false);
    throw error;
  }

  const transportHeaders = new Headers(init.headers);
  init.headers = transportHeaders;
  const headers: Array<[string, string]> = [];
  const omittedHeaders: string[] = [];
  for (const [key, value] of transportHeaders) {
    if (/^(?:authorization|proxy-authorization|x-api-key|api-key)$/iu.test(key))
      omittedHeaders.push(key);
    else headers.push([key, value]);
  }
  const bodyKnown = typeof init.body === "string" || init.body == null;
  if (typeof init.body === "string")
    await observeRequestBody(
      { ...request, model },
      init.body,
      format,
      provider,
      transportAttempt,
    );
  await emit({
    type: "request",
    captureLayer: "fetch-request-input",
    transportAttempt,
    url: url,
    method: init.method ?? "GET",
    headers,
    omittedHeaders,
    ...(bodyKnown
      ? {
          body: Buffer.from(
            typeof init.body === "string" ? init.body : "",
            "utf8",
          ),
        }
      : {}),
    completeness: bodyKnown ? "complete" : "unavailable",
    format: format,
    provider: provider,
    model,
  });
  if (!bodyKnown)
    await emit({
      type: "capture_gap",
      captureLayer: "fetch-request-input",
      transportAttempt,
      reason: "unsupported_body_type",
      bodyType: typeof init.body,
      offset: 0,
    });

  // Critical fence: no awaited observer, hook, microtask or Promise wrapper may
  // occur between this synchronous authorization check and the actual fetch.
  try {
    check(bodyKnown);
  } catch (error) {
    await blocked(error, bodyKnown);
    throw error;
  }
  let pending: Promise<Response>;
  const invocationClock = traceClock();
  try {
    pending = fetch(url, init);
  } catch (error) {
    await emit({
      type: "request_dispatched",
      observedClock: invocationClock,
      captureLayer: "fetch-invocation",
      transportAttempt,
    });
    await emit({
      type: "transport_error",
      captureLayer: "fetch-request-input",
      transportAttempt,
      offset: 0,
      error: describeError(error),
    });
    throw error;
  }
  // Install rejection handling before any asynchronous disk observation.
  const settled = pending.then(
    (response) => ({ response, receivedClock: traceClock() }),
    (error: unknown) => ({ error }),
  );
  await emit({
    type: "request_dispatched",
    observedClock: invocationClock,
    captureLayer: "fetch-invocation",
    transportAttempt,
  });
  const outcome = await settled;
  if ("error" in outcome) {
    await emit({
      type: "transport_error",
      captureLayer: "fetch-request-input",
      transportAttempt,
      offset: 0,
      error: describeError(outcome.error),
    });
    throw outcome.error;
  }
  const response = outcome.response;
  await emit({
    type: "response_headers",
    observedClock: outcome.receivedClock,
    captureLayer: "fetch-response-body",
    transportAttempt,
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers],
  });
  if (observer === undefined) return response;

  let chunks = 0,
    bytes = 0,
    ended = false;
  let interruptedReason: string | undefined;
  const signal = init.signal ?? request.signal;
  const finish = async (
    completeness: "complete" | "interrupted",
    reason?: string,
  ): Promise<void> => {
    if (ended) return;
    ended = true;
    await emit({
      type: "response_end",
      captureLayer: "fetch-response-body",
      transportAttempt,
      completeness,
      ...(reason === undefined ? {} : { reason }),
      chunks,
      bytes,
      offset: bytes,
    });
  };
  if (response.body === null) {
    await finish("complete");
    return response;
  }
  const reader = response.body.getReader();
  let released = false;
  const abort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  const release = (): void => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const read = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    const result = await reader.read();
    if (result.done) {
      const reason =
        interruptedReason ?? (signal.aborted ? "request_aborted" : undefined);
      await finish(reason === undefined ? "complete" : "interrupted", reason);
    } else {
      const offset = bytes;
      chunks += 1;
      bytes += result.value.byteLength;
      await emit({
        type: "response_chunk",
        captureLayer: "fetch-response-body",
        transportAttempt,
        index: chunks,
        offset,
        bytes: Uint8Array.from(result.value),
      });
    }
    return result;
  };
  const failed = async (error: unknown): Promise<void> => {
    await emit({
      type: "transport_error",
      captureLayer: "fetch-response-body",
      transportAttempt,
      offset: bytes,
      error: describeError(error),
    });
    await finish(
      "interrupted",
      interruptedReason ??
        (signal.aborted ? "request_aborted" : "body_read_failed"),
    );
  };
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await read();
          if (result.done) {
            controller.close();
            release();
          } else controller.enqueue(result.value);
        } catch (error) {
          await failed(error);
          controller.error(error);
          release();
        }
      },
      async cancel(reason) {
        if (reason === MODEL_RESPONSE_TERMINAL && !signal.aborted) {
          const owner = captureOwners.get(observer) ?? observer;
          const active = activeDrains.get(owner) ?? new Set<ActiveDrain>();
          activeDrains.set(owner, active);
          let done!: () => void;
          const drain: ActiveDrain = {
            async cancel() {
              interruptedReason = "host_shutdown";
              await reader.cancel("host_shutdown").catch(() => undefined);
            },
            done: new Promise<void>((resolve) => {
              done = resolve;
            }),
          };
          active.add(drain);
          await emit({
            type: "response_drain_started",
            captureLayer: "fetch-response-body",
            transportAttempt,
            reason: "provider_terminal_marker",
            offset: bytes,
          });
          void (async () => {
            try {
              while (!(await read()).done) {
                if (signal.aborted || interruptedReason !== undefined) break;
              }
              if (!ended)
                await finish(
                  "interrupted",
                  interruptedReason ?? "request_aborted",
                );
            } catch (error) {
              await failed(error);
            } finally {
              release();
              active.delete(drain);
              if (active.size === 0) activeDrains.delete(owner);
              done();
            }
          })();
          return;
        }
        try {
          // Error/retry/401 bodies must not disappear because their model-facing
          // error envelope was bounded or the retry layer discarded the response.
          if (!response.ok && !signal.aborted) {
            while (!(await read()).done) {
              if (signal.aborted) break;
            }
          }
          if (!ended) {
            await reader.cancel(reason);
            await finish(
              "interrupted",
              signal.aborted
                ? "request_aborted"
                : "consumer_cancelled_before_transport_eof",
            );
          }
        } catch (error) {
          await failed(error);
        } finally {
          release();
        }
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function describeError(error: unknown): ModelTransportError {
  try {
    const details = inspect(error, {
      depth: null,
      maxArrayLength: null,
      maxStringLength: null,
      customInspect: false,
      getters: false,
    });
    return error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          ...(error.stack === undefined ? {} : { stack: error.stack }),
          details,
        }
      : { name: "Error", message: String(error), details };
  } catch {
    return {
      name: "UninspectableThrownValue",
      message: "The thrown transport value could not be inspected",
      details:
        "Error capture is incomplete; the original thrown value still propagates",
    };
  }
}
