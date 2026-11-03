/** Pure synthetic timeline contracts. These are not native latency evidence. */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  summarizeSendTimeline,
  budget,
} = require("./summarize-send-timeline.cjs");
function fixture() {
  const profile = {
    mainPid: 1,
    rendererPid: 2,
    bufferUsage: { percentage: 0.1 },
    backgroundThrottling: true,
  };
  const samples = [0, 1, 2].map((index) => ({
    clockDomain: "renderer",
    clickMs: 100 + index * 100,
    feedbackGeometryCompleteMs: 110 + index * 100,
    nextFrameEntryMs: 120 + index * 100,
    feedbackSubsequentFrameMs: 130 + index * 100,
    visibilitySnapshots: [
      {
        phase: "click",
        atMs: 100 + index * 100,
        visibilityState: "visible",
        hasFocus: true,
      },
    ],
  }));
  const trace = {
    traceEvents: [
      {
        ph: "M",
        pid: 1,
        tid: 11,
        name: "thread_name",
        args: { name: "CrBrowserMain" },
      },
      {
        ph: "M",
        pid: 2,
        tid: 22,
        name: "thread_name",
        args: { name: "CrRendererMain" },
      },
      ...[0, 1, 2].flatMap((index) =>
        [
          "native-click",
          "geometry-complete",
          "next-frame-entry",
          "next-frame-geometry",
        ].map((phase, i) => ({
          ph: "I",
          pid: 2,
          tid: 22,
          name: `zen-send-${index}-${phase}`,
          ts: (100 + index * 100 + i * 10) * 1000,
        })),
      ),
    ],
  };
  return { trace, profile, samples };
}
test("nested spans are clipped and exclusive; recorded wall time is not CPU or idle", () => {
  const result = budget(
    [
      { name: "RunMicrotasks", ts: 0, dur: 15000 },
      { name: "Layout", ts: 2000, dur: 8000 },
      { name: "GC", ts: 4000, dur: 2000 },
      { name: "Paint", ts: 12000, dur: 6000 },
    ],
    1000,
    20000,
  );
  assert.deepEqual(result, {
    durationMs: 19,
    exclusiveWallMs: {
      GC: 2,
      Layout: 6,
      Style: 0,
      PrePaint: 0,
      Paint: 6,
      JS: 3,
      Other: 0,
    },
    uncoveredByRecordedSpansMs: 2,
  });
});
test("only whitelisted phase counts and states survive; CPU deltas and arbitrary text do not", () => {
  const f = fixture();
  f.trace.traceEvents.push({
    ph: "X",
    pid: 2,
    tid: 22,
    name: "private raw label",
    ts: 110000,
    dur: 3000,
    args: { url: "/Users/private/raw", credential: "synthetic-private-text" },
    tdur: -9,
  });
  f.samples[0].nonce = "synthetic-private-text";
  const result = summarizeSendTimeline(f.trace, f.profile, f.samples);
  assert.equal(result.acceptance, false);
  assert.equal(result.cpuSampling, false);
  assert.equal(
    result.samples[0].geometryToNextFrameEntry.exclusiveWallMs.Other,
    3,
  );
  assert.equal(result.samples[0].recordToTraceClockOffsetSpreadMs, 0);
  assert.equal(result.samples[0].visibility[0].relativeToClickMs, 0);
  const serialized = JSON.stringify(result);
  for (const value of [
    "private raw label",
    "/Users/private/raw",
    "synthetic-private-text",
    "tdur",
  ])
    assert.equal(serialized.includes(value), false);
});
const invalid = {
  "missing marker": (f) => f.trace.traceEvents.pop(),
  "duplicate marker": (f) => f.trace.traceEvents.push(f.trace.traceEvents[2]),
  "cross-phase duplicate marker": (f) =>
    f.trace.traceEvents.push({ ...f.trace.traceEvents[2], ph: "R" }),
  "unknown marker phase": (f) => {
    f.trace.traceEvents[2].ph = "X";
  },
  "wrong renderer PID": (f) => (f.profile.rendererPid = 99),
  "wrong marker thread": (f) => (f.trace.traceEvents[2].tid = 23),
  "reversed marker clock": (f) => (f.trace.traceEvents[3].ts = 1),
  "negative X duration": (f) =>
    f.trace.traceEvents.push({
      ph: "X",
      pid: 2,
      tid: 22,
      name: "Layout",
      ts: 110000,
      dur: -1,
    }),
  "CPU sample profile": (f) =>
    f.trace.traceEvents.push({ name: "ProfileChunk" }),
  "full buffer": (f) => (f.profile.bufferUsage.percentage = 1),
  "unknown focus state": (f) =>
    (f.samples[0].visibilitySnapshots[0].phase = "private raw text"),
  "excessive focus history": (f) =>
    (f.samples[0].visibilitySnapshots = Array(65).fill(
      f.samples[0].visibilitySnapshots[0],
    )),
};
for (const [name, mutate] of Object.entries(invalid))
  test(name + " fails closed with a fixed nonleaking error", () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => summarizeSendTimeline(f.trace, f.profile, f.samples), {
      message: "Invalid private timeline input",
    });
  });

test("Chrome instant user-timing marks and legacy R marks identify the same ordered windows", () => {
  const f = fixture();
  assert.equal(f.trace.traceEvents[2].ph, "I");
  const current = summarizeSendTimeline(f.trace, f.profile, f.samples);
  for (const event of f.trace.traceEvents) if (event.ph === "I") event.ph = "R";
  assert.deepEqual(
    summarizeSendTimeline(f.trace, f.profile, f.samples),
    current,
  );
});

test("launcher failure reporting permits fixed phase/reason enums only", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const source = fs.readFileSync(
    path.join(__dirname, "launch-recall-send-profile.mjs"),
    "utf8",
  );
  const code = source.slice(
    source.indexOf("function safeDiagnosticFailure("),
    source.indexOf("let cleanupSafe = false;"),
  );
  const context = vm.createContext({});
  vm.runInContext(code, context);
  const report = (value) =>
    JSON.parse(JSON.stringify(context.safeDiagnosticFailure(value)));
  assert.deepEqual(
    report({
      diagnosticFailure: {
        stage: "timeline-summary",
        reasonCodes: [
          "timeline-contract-invalid",
          "/Users/private/token",
          { secret: "not allowed" },
        ],
      },
      error: "raw error",
    }),
    { stage: "timeline-summary", reasonCodes: ["timeline-contract-invalid"] },
  );
  assert.deepEqual(
    report({
      diagnosticFailure: {
        stage: "/Users/private/token",
        reasonCodes: "secret",
      },
    }),
    { stage: "unclassified", reasonCodes: [] },
  );
});

test("explicit first-trace schema3 projects one complete sample without weakening legacy count", () => {
  const f = fixture();
  Object.assign(f.profile, {
    schemaVersion: 3,
    diagnosticOnly: true,
    acceptance: false,
    traceStopped: true,
    durationMs: 50,
    traceSampleLimit: 1,
    invalidationTracking: true,
  });
  const samples = f.samples.slice(0, 1);
  samples[0].pendingDomMs = 105;
  for (const key of [
    "firstVisibleFeedbackMs",
    "clickToPendingDomMs",
    "clickToPendingVisibleFrameMs",
    "clickToBubbleDomMs",
    "clickToVisibleFrameMs",
    "clickToClearFrameMs",
    "clickToCanonicalNotificationMs",
    "clickToFeedbackGeometryCompleteMs",
    "clickToFeedbackSubsequentFrameMs",
    "clickToClearGeometryCompleteMs",
    "clickToClearSubsequentFrameMs",
    "feedbackTargetMs",
  ])
    samples[0][key] = 1;
  f.trace.traceEvents = f.trace.traceEvents.filter(
    (event) => event.ph === "M" || event.name.startsWith("zen-send-0-"),
  );
  f.trace.traceEvents.push({
    ph: "I",
    pid: 2,
    tid: 22,
    name: "zen-send-0-first-pending-dom-observed",
    ts: 105000,
  });
  const result = summarizeSendTimeline(f.trace, f.profile, samples);
  assert.equal(result.tracedSampleCount, 1);
  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].firstGapInvalidations.eventCount, 0);
  assert.throws(() => summarizeSendTimeline(f.trace, f.profile, f.samples));
  f.profile.traceSampleLimit = 2;
  assert.throws(() => summarizeSendTimeline(f.trace, f.profile, samples));
  delete f.profile.traceSampleLimit;
  assert.throws(() => summarizeSendTimeline(f.trace, f.profile, samples));
});
