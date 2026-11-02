// Pure, bounded diagnostic projection. Raw names, arguments, paths and samples
// never leave this module; the existing credential gate must run before export.
const valid = (condition) => {
  if (!condition) throw new Error("Invalid private timeline input");
};
const finite = (value) => Number.isFinite(value) && value >= 0;
const classes = ["GC", "Layout", "Style", "PrePaint", "Paint", "JS", "Other"];
function category(name) {
  if (/GC|GarbageCollect/.test(name)) return 0;
  if (name === "Layout") return 1;
  if (/^(UpdateLayoutTree|RecalculateStyles)$/.test(name)) return 2;
  if (name === "PrePaint") return 3;
  if (/^(Paint|PaintImage|CompositeLayers)$/.test(name)) return 4;
  if (
    /^(FunctionCall|RunMicrotasks|EvaluateScript|EventDispatch|FireAnimationFrame|TimerFire)$/.test(
      name,
    )
  )
    return 5;
  return 6;
}
function budget(events, start, end) {
  valid(finite(start) && finite(end) && end >= start);
  const changes = [];
  for (const e of events) {
    valid(finite(e.ts) && finite(e.dur));
    const a = Math.max(start, e.ts),
      b = Math.min(end, e.ts + e.dur);
    if (b > a)
      changes.push([a, category(e.name), 1], [b, category(e.name), -1]);
  }
  changes.sort((a, b) => a[0] - b[0]);
  const active = classes.map(() => 0),
    totals = classes.map(() => 0);
  let cursor = start,
    uncovered = 0;
  for (const [at, kind, delta] of [...changes, [end, 0, 0]]) {
    const selected = active.findIndex((count) => count > 0);
    if (selected < 0) uncovered += at - cursor;
    else totals[selected] += at - cursor;
    active[kind] += delta;
    cursor = at;
  }
  return {
    durationMs: (end - start) / 1000,
    exclusiveWallMs: Object.fromEntries(
      classes.map((name, i) => [name, totals[i] / 1000]),
    ),
    uncoveredByRecordedSpansMs: uncovered / 1000,
  };
}
function summarizeSendTimeline(trace, profile, samples) {
  valid(Array.isArray(trace.traceEvents) && samples?.length === 3);
  valid(
    finite(profile.bufferUsage?.percentage) &&
      profile.bufferUsage.percentage < 1,
  );
  const events = trace.traceEvents;
  valid(
    !events.some((e) => /^(Profile|ProfileChunk|CpuProfile)$/.test(e.name)),
  );
  const tid = (pid, name) => {
    valid(Number.isInteger(pid) && pid > 0);
    const ids = new Set(
      events
        .filter(
          (e) =>
            e.ph === "M" &&
            e.pid === pid &&
            e.name === "thread_name" &&
            e.args?.name === name,
        )
        .map((e) => e.tid),
    );
    valid(ids.size === 1 && Number.isInteger([...ids][0]) && [...ids][0] > 0);
    return [...ids][0];
  };
  const rendererTid = tid(profile.rendererPid, "CrRendererMain"),
    mainTid = tid(profile.mainPid, "CrBrowserMain");
  const xs = (pid, thread) =>
    events.filter((e) => e.pid === pid && e.tid === thread && e.ph === "X");
  const renderer = xs(profile.rendererPid, rendererTid),
    main = xs(profile.mainPid, mainTid);
  const markNames = [
    "native-click",
    "geometry-complete",
    "next-frame-entry",
    "next-frame-geometry",
  ];
  const recordNames = [
    "clickMs",
    "feedbackGeometryCompleteMs",
    "nextFrameEntryMs",
    "feedbackSubsequentFrameMs",
  ];
  const phases = new Set([
    "installed",
    "click",
    "first-geometry",
    "next-frame-entry",
    "next-frame-geometry",
    "window-focus",
    "window-blur",
    "visibilitychange",
  ]);
  const projected = samples.map((sample, index) => {
    valid(sample.clockDomain === "renderer");
    const marks = markNames.map((name) => {
      const found = events.filter(
        (e) =>
          e.name === `zen-send-${index}-${name}` && ["I", "R"].includes(e.ph),
      );
      valid(
        found.length === 1 &&
          found[0].pid === profile.rendererPid &&
          found[0].tid === rendererTid &&
          finite(found[0].ts),
      );
      return found[0].ts;
    });
    valid(marks.every((at, i) => i === 0 || at >= marks[i - 1]));
    const offsets = marks.map((at, i) => {
      valid(finite(sample[recordNames[i]]));
      return at / 1000 - sample[recordNames[i]];
    });
    const visibility = (sample.visibilitySnapshots ?? []).map((entry) => {
      valid(
        phases.has(entry.phase) &&
          ["visible", "hidden"].includes(entry.visibilityState) &&
          typeof entry.hasFocus === "boolean" &&
          finite(entry.atMs),
      );
      return {
        phase: entry.phase,
        relativeToClickMs: entry.atMs - sample.clickMs,
        visibilityState: entry.visibilityState,
        hasFocus: entry.hasFocus,
      };
    });
    valid(visibility.length <= 64);
    return {
      index,
      tracePhaseRelativeMs: marks.map((at) => (at - marks[0]) / 1000),
      recordToTraceClockOffsetSpreadMs:
        Math.max(...offsets) - Math.min(...offsets),
      clickToGeometry: budget(renderer, marks[0], marks[1]),
      geometryToNextFrameEntry: budget(renderer, marks[1], marks[2]),
      nextFrameEntryToGeometry: budget(renderer, marks[2], marks[3]),
      mainGeometryToNextFrameEntry: budget(main, marks[1], marks[2]),
      checkCallbackGapWallMs: budget(
        renderer.filter(
          (e) =>
            e.name === "FunctionCall" && e.args?.data?.functionName === "check",
        ),
        marks[1],
        marks[2],
      ).exclusiveWallMs.JS,
      visibility,
    };
  });
  return {
    diagnosticOnly: true,
    acceptance: false,
    cpuSampling: false,
    bufferUsageFraction: profile.bufferUsage.percentage,
    backgroundThrottling:
      typeof profile.backgroundThrottling === "boolean"
        ? profile.backgroundThrottling
        : null,
    rendererPid: profile.rendererPid,
    rendererTid,
    mainPid: profile.mainPid,
    mainTid,
    clock:
      "Trace microseconds; each sample uses renderer marks. Offset spread reports comparison to renderer performance.now; no cross-process performance.now subtraction.",
    accounting:
      "Exclusive clipped wall intervals, priority GC > Layout > Style > PrePaint > Paint > JS > Other. Parent/child spans never added. Wall spans can contain off-CPU time; uncovered is not proven idle. Main spans and check callback subset must not be added to renderer totals.",
    visibilityMeaning:
      "Passive document focus/visibility snapshots; no occlusion or physical scanout telemetry. Subsequent rAF is a confirmation bound, not first presentation time.",
    samples: projected,
  };
}
module.exports = { summarizeSendTimeline, budget };
