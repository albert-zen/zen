import { randomUUID } from "node:crypto";
import type { RuntimeTrace, TraceEvent, TraceReceipt } from "./trace.js";

const degraded = new WeakSet<RuntimeTrace>();
/** Passive timing evidence; a failed observer cannot change the operation. */
export async function recordTraceObservation(
  trace: RuntimeTrace | undefined,
  event: TraceEvent,
): Promise<TraceReceipt | undefined> {
  if (trace === undefined) return;
  try {
    const receipt = await trace.record(event);
    if (receipt.durability === "durable") degraded.delete(trace);
    else warn(trace, receipt.error);
    return receipt;
  } catch (error) {
    warn(trace, error);
  }
}

/** A local clock span, not execution authority, including local capture overhead. */
export async function observeTraceSpan<T>(
  trace: RuntimeTrace | undefined,
  context: Pick<TraceEvent, "threadId" | "turnId" | "sampleId">,
  stage: "context_preparation" | "context_materialize" | "context_compile",
  operation: () => T | Promise<T>,
  facts: Readonly<Record<string, unknown>> = {},
  signal?: AbortSignal,
): Promise<T> {
  if (trace === undefined) return await operation();
  const spanId = randomUUID();
  const started = process.hrtime.bigint();
  await recordTraceObservation(trace, {
    ...context,
    type: `${stage}_started`,
    data: {
      ...facts,
      spanId,
      timingScope: "host-including-local-capture",
    },
  });
  let outcome = "completed";
  let failure: unknown;
  try {
    return await operation();
  } catch (error) {
    outcome = signal?.aborted ? "cancelled" : "failed";
    failure = error;
    throw error;
  } finally {
    await recordTraceObservation(trace, {
      ...context,
      type: `${stage}_finished`,
      data: {
        spanId,
        outcome,
        elapsedNs: (process.hrtime.bigint() - started).toString(),
        timingScope: "host-including-local-capture",
        ...(failure === undefined
          ? {}
          : {
              error:
                failure instanceof Error
                  ? { name: failure.name, message: failure.message }
                  : { name: "Error", message: String(failure) },
            }),
      },
    });
  }
}
function warn(trace: RuntimeTrace, error: unknown) {
  if (degraded.has(trace)) return;
  degraded.add(trace);
  console.error(
    "Trace observation degraded; repeated warnings suppressed until recovery",
    error,
  );
}
