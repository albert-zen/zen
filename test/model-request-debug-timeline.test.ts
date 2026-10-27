import assert from "node:assert/strict";
import test from "node:test";
import type { TraceRecord, TraceClock, TraceReader } from "../src/trace.js";
import { ModelRequestDebugStore } from "../apps/cli/src/model-request-debug.js";
import {
  buildTraceTimeline,
  relatedTimelineRecords,
  clockElapsed,
} from "../apps/cli/src/trace-timeline.js";
const clock = (ms: number, domain = "host"): TraceClock => ({
  domain,
  monotonicNs: String(ms * 1e6),
  wallTime: `2026-01-01T00:00:00.${String(ms).padStart(3, "0")}Z`,
});
function fixture() {
  const records: TraceRecord[] = [];
  const add = (
    type: string,
    ms: number,
    data: unknown = {},
    sampleId: string | null = "sample",
  ): TraceRecord => {
    const r: TraceRecord = {
      id: `r${records.length}`,
      sequence: records.length,
      threadId: "thread",
      type,
      clock: clock(ms),
      data,
      artifacts: [],
      ...(sampleId === null ? {} : { sampleId }),
    };
    records.push(r);
    return r;
  };
  return { records, add };
}
const stage = (timeline: ReturnType<typeof buildTraceTimeline>, name: string) =>
  timeline.stages.find((p) => p.stage === name)!;
test("timeline links reported activation to independent Host receipt and exact sample without subtracting clocks", () => {
  const { records, add } = fixture();
  const clientObservation = {
    requestId: "activation",
    action: "send",
    clock: clock(900, "renderer"),
  };
  add(
    "client_request_received",
    1,
    {
      requestId: "request",
      clientId: "client",
      clientObservation,
      hostReceived: clock(0),
    },
    null,
  );
  add(
    "client_request_finished",
    3,
    { requestId: "request", outcome: "accepted", result: { turnId: "turn" } },
    null,
  );
  add("context_preparation_started", 4, {
    spanId: "preparation",
    clientIds: ["client"],
  });
  add("context_compile_started", 6, { spanId: "compile" });
  add("context_compile_finished", 9, {
    spanId: "compile",
    outcome: "completed",
  });
  add("context_preparation_finished", 11, {
    spanId: "preparation",
    outcome: "completed",
  });
  add("model_sample_started", 12);
  const selected = add("model_request", 13, { transportAttempt: 1 });
  add("model_request_dispatched", 20, {
    transportAttempt: 1,
    observedClock: clock(14),
  });
  add("model_response_headers", 23, {
    transportAttempt: 1,
    observedClock: clock(17),
  });
  const chunk = add("model_response_chunk", 24, { transportAttempt: 1 });
  chunk.artifacts = [
    {
      name: "response_body",
      ref: { sha256: "a".repeat(64), byteLength: 3, mediaType: "text/plain" },
    },
  ];
  add("model_event", 25, {
    transportAttempt: 1,
    exposedText: false,
    exposedReasoning: false,
  });
  add("model_event", 26, { transportAttempt: 1, exposedReasoning: true });
  add("model_event", 27, { transportAttempt: 1, exposedSummary: true });
  add("model_event", 28, { transportAttempt: 1, exposedText: true });
  add("model_sample_finished", 29, { outcome: "completed" });
  const related = relatedTimelineRecords(selected, records),
    timeline = buildTraceTimeline(selected, related);
  assert.equal(timeline.inputs.length, 1);
  assert.equal(timeline.inputs[0]!.activation!.domain, "renderer");
  assert.equal(timeline.inputs[0]!.received!.monotonicNs, "0");
  assert.equal(
    clockElapsed(
      timeline.inputs[0]!.activation!,
      timeline.inputs[0]!.received!,
    ),
    null,
  );
  assert.equal(stage(timeline, "context_compile_finished").elapsedMs, 3);
  assert.equal(
    stage(timeline, "fetch_invoked").clock!.monotonicNs,
    String(14e6),
  );
  assert.equal(stage(timeline, "response_headers").elapsedMs, 3);
  assert.equal(stage(timeline, "first_exposed_reasoning").elapsedMs, 12);
  assert.equal(stage(timeline, "first_exposed_summary").elapsedMs, 13);
  assert.equal(stage(timeline, "first_exposed_text").elapsedMs, 14);
  assert.equal(stage(timeline, "model_sample_finished").outcome, "completed");
  assert.equal(stage(timeline, "raw_eof").clock, null);
});
test("a failed earlier attempt cannot donate first content or EOF to prepared-but-blocked retry", () => {
  const { records, add } = fixture();
  add("model_request_dispatched", 1, { transportAttempt: 1 });
  add("model_event", 2, { transportAttempt: 1, exposedText: true });
  add("model_response_end", 3, {
    transportAttempt: 1,
    completeness: "complete",
  });
  const selected = add("model_request", 4, { transportAttempt: 2 });
  add("model_dispatch_blocked", 5, { transportAttempt: 2 });
  const timeline = buildTraceTimeline(selected, records);
  for (const name of ["fetch_invoked", "first_exposed_text", "raw_eof"])
    assert.equal(stage(timeline, name).clock, null);
  assert.equal(
    stage(timeline, "request_prepared").clock!.monotonicNs,
    String(4e6),
  );
});
test("unmatched span end, old events without nonempty evidence and different clock intervals stay unknown", () => {
  const { records, add } = fixture();
  add("context_compile_started", 1, { spanId: "first" });
  add("context_compile_finished", 2, { spanId: "other", outcome: "completed" });
  const selected = add("model_request", 3, { transportAttempt: 1 });
  add("model_request_dispatched", 4, { transportAttempt: 1 });
  const headers = add("model_response_headers", 5, { transportAttempt: 1 });
  headers.clock = clock(8, "other-host");
  add("model_event", 6, { eventType: "text_delta" });
  const timeline = buildTraceTimeline(selected, records);
  assert.equal(stage(timeline, "context_compile_finished").clock, null);
  assert.equal(stage(timeline, "first_exposed_text").clock, null);
  assert.equal(stage(timeline, "response_headers").elapsedMs, null);
  assert.equal(clockElapsed(clock(10), clock(1)), null);
});
test("reader exposes failed preparation without a model request, and standalone click without Host admission", async () => {
  const { records, add } = fixture();
  const preparation = add("context_preparation_started", 1, { spanId: "prep" });
  add("context_preparation_finished", 2, { spanId: "prep", outcome: "failed" });
  const activation = add(
    "client_send_activated",
    3,
    {
      clientObservation: {
        requestId: "click",
        action: "send",
        clock: clock(1, "ui"),
      },
    },
    null,
  );
  const reader: TraceReader = {
    read: async () => ({ records, completeness: "complete", issues: [] }),
    readArtifact: async () => {
      throw new Error("No artifacts");
    },
  };
  const store = new ModelRequestDebugStore(reader);
  const index = await store.control({ action: "list", threadId: "thread" });
  assert.deepEqual(
    index.records?.map((r) => r.type),
    ["context_preparation_started"],
  );
  const page = (
    await store.control({
      action: "read",
      threadId: "thread",
      id: preparation.id,
      view: "timeline",
    })
  ).page!;
  assert.equal(
    stage(page.timeline!, "context_preparation_finished").outcome,
    "failed",
  );
  assert.equal(stage(page.timeline!, "model_sample_started").clock, null);
  const click = buildTraceTimeline(
    activation,
    relatedTimelineRecords(activation, records),
  );
  assert.equal(click.inputs[0]!.received, null);
  assert.equal(click.inputs[0]!.outcome, "unknown");
  assert(click.stages.every((p) => p.clock === null));
});

test("attempt summary and timeline use the same actual invocation clock, not delayed Trace append", async () => {
  const { records, add } = fixture();
  const request = add("model_request", 10, { transportAttempt: 1 });
  add("model_request_dispatched", 20, {
    transportAttempt: 1,
    observedClock: clock(14),
  });
  add("model_response_end", 40, {
    transportAttempt: 1,
    completeness: "complete",
  });
  const store = new ModelRequestDebugStore({
    read: async () => ({ records, completeness: "complete", issues: [] }),
    readArtifact: async () => {
      throw Error("No artifacts");
    },
  });
  const listed = await store.control({ action: "list", threadId: "thread" });
  const page = (
    await store.control({
      action: "read",
      threadId: "thread",
      id: request.id,
      view: "timeline",
    })
  ).page!;
  assert.equal(listed.records![0]!.attemptDurationMs, 26);
  assert.equal(
    listed.records![0]!.attemptDurationMs,
    stage(page.timeline!, "raw_eof").elapsedMs,
  );
  (records[1]!.data as { observedClock: TraceClock }).observedClock = clock(
    14,
    "other-host",
  );
  const otherDomain = await store.control({
    action: "list",
    threadId: "thread",
  });
  assert.equal(otherDomain.records![0]!.attemptDurationMs, null);
});
