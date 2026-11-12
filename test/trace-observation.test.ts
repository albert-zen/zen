import assert from "node:assert/strict";
import test from "node:test";
import { observeTraceSpan } from "../src/trace-observation.js";
import type { RuntimeTrace, TraceEvent } from "../src/trace.js";
function sink() {
  const events: TraceEvent[] = [];
  const trace: RuntimeTrace = {
    async record(event) {
      events.push(event);
      return {
        durability: "durable",
        recordId: String(events.length),
        sequence: events.length,
        sync: "file",
      };
    },
  };
  return { trace, events };
}
const context = {
  threadId: "synthetic-thread",
  turnId: "synthetic-turn",
  sampleId: "synthetic-sample",
};
test("preparation and nested compilation have paired exact sample/span identity", async () => {
  const { trace, events } = sink();
  const value = await observeTraceSpan(
    trace,
    context,
    "context_preparation",
    async () =>
      await observeTraceSpan(trace, context, "context_compile", () => ({
        selected: ["item"],
      })),
    { clientIds: ["client"] },
  );
  assert.deepEqual(value, { selected: ["item"] });
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "context_preparation_started",
      "context_compile_started",
      "context_compile_finished",
      "context_preparation_finished",
    ],
  );
  const data = events.map((e) => e.data as Record<string, unknown>);
  assert.equal(data[0]!.spanId, data[3]!.spanId);
  assert.equal(data[1]!.spanId, data[2]!.spanId);
  assert.notEqual(data[0]!.spanId, data[1]!.spanId);
  assert(events.every((e) => e.sampleId === context.sampleId));
  assert.equal(data[2]!.outcome, "completed");
  assert.match(String(data[2]!.elapsedNs), /^\d+$/);
});
test("compile failure and cancellation close their span without replacing the error", async () => {
  for (const cancelled of [false, true]) {
    const { trace, events } = sink();
    const controller = new AbortController();
    const error = new Error("synthetic compile failure");
    await assert.rejects(
      observeTraceSpan(
        trace,
        context,
        "context_compile",
        () => {
          if (cancelled) controller.abort();
          throw error;
        },
        {},
        controller.signal,
      ),
      (e) => e === error,
    );
    assert.equal(
      (events[1]!.data as { outcome: string }).outcome,
      cancelled ? "cancelled" : "failed",
    );
  }
});
test("broken observation preserves both successful and failed operation outcomes", async () => {
  const trace: RuntimeTrace = {
    record: async () => {
      throw new Error("synthetic disk failure");
    },
  };
  const original = console.error;
  const warnings: unknown[] = [];
  console.error = (...args) => warnings.push(args);
  try {
    assert.equal(
      await observeTraceSpan(trace, context, "context_compile", () => 42),
      42,
    );
    const error = new Error("compile");
    await assert.rejects(
      observeTraceSpan(trace, context, "context_compile", () => {
        throw error;
      }),
      (e) => e === error,
    );
    assert.equal(warnings.length, 1);
  } finally {
    console.error = original;
  }
});
