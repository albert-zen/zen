import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import type { ModelAdapter, ModelRequest } from "./model.js";
import type { ModelTransportObservation } from "./model/transport-types.js";
import {
  closeModelTransportCaptures,
  setModelTransportCaptureOwner,
} from "./model/request-observation.js";
import {
  recordTraceJson,
  type RuntimeTrace,
  type TraceEvent,
} from "./trace.js";
const wrapperMetadata = new WeakMap<
  ModelAdapter,
  { source: ModelAdapter; trace: RuntimeTrace }
>();
const wrappers = new WeakMap<
  ModelAdapter,
  WeakMap<RuntimeTrace, ModelAdapter>
>();
const warned = new WeakSet<RuntimeTrace>();
/** Passive evidence capture owned by Host/Trace, never by an opt-in reader. */
export function observeModelWithTrace(
  adapter: ModelAdapter,
  trace: RuntimeTrace,
): ModelAdapter {
  const prior = wrapperMetadata.get(adapter);
  if (prior?.trace === trace) return adapter;
  if (prior) adapter = prior.source;
  let byTrace = wrappers.get(adapter);
  if (!byTrace) {
    byTrace = new WeakMap();
    wrappers.set(adapter, byTrace);
  }
  const existing = byTrace.get(trace);
  if (existing) return existing;
  const wrapped: ModelAdapter = {
    provider: adapter.provider,
    ...(adapter.contextInstructions === undefined
      ? {}
      : { contextInstructions: adapter.contextInstructions }),
    ...(adapter.requestPayloadFormat === undefined
      ? {}
      : { requestPayloadFormat: adapter.requestPayloadFormat }),
    async *stream(request) {
      const context = {
        threadId:
          request.debugContext?.threadId ?? request.sessionId ?? "unattributed",
        turnId: request.debugContext?.turnId ?? null,
        sampleId: request.debugContext?.sampleId ?? randomUUID(),
      };
      const started = process.hrtime.bigint();
      await safeRecord(trace, {
        ...context,
        type: "model_sample_started",
        data: {
          provider: adapter.provider,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          ...(request.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: request.maxOutputTokens }),
          purpose: request.debugContext?.purpose ?? "unknown",
          sampleAttempt: request.debugContext?.sampleAttempt ?? 1,
          contextBoundaryItemId:
            request.debugContext?.contextBoundaryItemId ?? null,
          toolCount: request.tools.length,
          ...(request.debugContext?.configuration === undefined
            ? {}
            : { configuration: request.debugContext.configuration }),
          ...(request.debugContext?.selectedItemIds === undefined
            ? {}
            : { selectedItemIds: request.debugContext.selectedItemIds }),
          captureLayer: "model-adapter",
          transportCapture:
            adapter.requestPayloadFormat === undefined
              ? "unavailable"
              : "fetch",
          timingScope:
            "client-sample-including-local-capture-and-provider-work",
        },
      });
      if (adapter.requestPayloadFormat === undefined)
        await recordTraceJson(
          trace,
          {
            ...context,
            type: "model_input",
            data: {
              captureLayer: "model-adapter-input",
              exactTransport: false,
              provider: adapter.provider,
              model: request.model,
            },
          },
          "model_input",
          {
            model: request.model,
            reasoningEffort: request.reasoningEffort,
            ...(request.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: request.maxOutputTokens }),
            messages: request.messages,
            tools: request.tools,
          },
          "model-adapter-input",
        );
      let transportAttempt: number | undefined;
      const observed: ModelRequest = {
        ...request,
        onTransport: async (event) => {
          if (event.type === "request_dispatched")
            transportAttempt = event.transportAttempt;
          await recordModelTransport(trace, context, event);
          if (request.onTransport)
            try {
              await request.onTransport(event);
            } catch (error) {
              await safeRecord(trace, {
                ...context,
                type: "trace_observer_error",
                data: errorDetails(error),
              });
            }
        },
      };
      setModelTransportCaptureOwner(observed.onTransport!, trace);
      let outcome: "completed" | "failed" | "cancelled" | "consumer_cancelled" =
          "consumer_cancelled",
        failure: unknown;
      try {
        for await (const event of adapter.stream(observed)) {
          await recordTraceJson(
            trace,
            {
              ...context,
              type: "model_event",
              data: {
                eventType: event.type,
                ...(transportAttempt === undefined ? {} : { transportAttempt }),
                exposedText:
                  event.type === "text_delta" && event.delta.length > 0,
                exposedReasoning:
                  (event.type === "reasoning_content_delta" &&
                    event.delta.length > 0) ||
                  (event.type === "reasoning" &&
                    event.contentVisibility === "public" &&
                    event.reasoningContent.length > 0),
                exposedSummary:
                  (event.type === "reasoning_summary_delta" &&
                    event.delta.length > 0) ||
                  (event.type === "reasoning" &&
                    (event.summary?.length ?? 0) > 0),
                captureLayer: "model-adapter-event",
              },
            },
            "model_event",
            event,
            "model-adapter-event",
          );
          yield event;
        }
        outcome = "completed";
      } catch (error) {
        failure = error;
        outcome = request.signal.aborted ? "cancelled" : "failed";
        throw error;
      } finally {
        await safeRecord(trace, {
          ...context,
          type: "model_sample_finished",
          data: {
            outcome,
            elapsedNs: (process.hrtime.bigint() - started).toString(),
            timingScope:
              "client-sample-including-local-capture-and-provider-work",
            ...(failure === undefined ? {} : { error: errorDetails(failure) }),
          },
        });
      }
    },
  };
  byTrace.set(trace, wrapped);
  wrapperMetadata.set(wrapped, { source: adapter, trace });
  return wrapped;
}
export async function closeModelTrace(trace: RuntimeTrace): Promise<void> {
  await closeModelTransportCaptures(trace);
}
export async function recordModelTransport(
  trace: RuntimeTrace,
  context: Pick<TraceEvent, "threadId" | "turnId" | "sampleId">,
  event: ModelTransportObservation,
): Promise<void> {
  if (event.type === "request") {
    const { body, type: _type, ...data } = event;
    await safeRecord(trace, {
      ...context,
      type: "model_request",
      data,
      ...(body === undefined
        ? {}
        : {
            artifacts: [
              {
                name: "request_body",
                bytes: body,
                mediaType: "application/json",
                captureLayer: event.captureLayer,
              },
            ],
          }),
    });
  } else if (event.type === "response_chunk") {
    const { bytes, type: _type, ...data } = event;
    await safeRecord(trace, {
      ...context,
      type: "model_response_chunk",
      data,
      artifacts: [
        {
          name: "response_body",
          bytes,
          mediaType: "application/octet-stream",
          captureLayer: event.captureLayer,
        },
      ],
    });
  } else {
    const { type, ...data } = event;
    await safeRecord(trace, { ...context, type: `model_${type}`, data });
  }
}
async function safeRecord(
  trace: RuntimeTrace,
  event: TraceEvent,
): Promise<void> {
  try {
    const receipt = await trace.record(event);
    if (receipt.durability === "durable") warned.delete(trace);
    else warn(trace, receipt.error);
  } catch (error) {
    warn(trace, errorDetails(error));
  }
}
function warn(trace: RuntimeTrace, error: unknown): void {
  if (warned.has(trace)) return;
  warned.add(trace);
  console.error(
    "Trace capture degraded; repeated warnings suppressed until recovery",
    error,
  );
}
function errorDetails(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        ...(error.stack === undefined ? {} : { stack: error.stack }),
        details: inspect(error, {
          depth: null,
          maxArrayLength: null,
          maxStringLength: null,
          breakLength: Infinity,
        }),
      }
    : {
        name: "Error",
        message: String(error),
        details: inspect(error, {
          depth: null,
          maxArrayLength: null,
          maxStringLength: null,
        }),
      };
}
