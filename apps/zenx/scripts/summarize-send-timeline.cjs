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
// Select outer task envelopes before clipping, including duplicate instrumentation names.
// Only complete thread CPU endpoints are usable. Never prorate a thread CPU duration.
function outerTasks(events) {
  const taskNames = /^(RunTask|ThreadControllerImpl::RunTask|TaskQueueManager::ProcessTaskFromWorkQueue|ThreadControllerWithMessagePumpImpl::DoWork)$/;
  const candidates=events.filter(e=>taskNames.test(e.name));
  candidates.forEach(e=>valid(finite(e.ts)&&finite(e.dur)));
  candidates.sort((a,b)=>a.ts-b.ts||b.dur-a.dur);
  const outer=[];
  for(const event of candidates){
    const previous=outer.at(-1);
    if(previous && event.ts>=previous.ts && event.ts+event.dur<=previous.ts+previous.dur)continue;
    outer.push(event);
  }
  return outer;
}
function wholeTaskCpuMs(event) {
  return finite(event.tts)&&finite(event.tdur)&&event.tdur<=event.dur ? event.tdur/1000 : null;
}
function longTasks(events,start,end) {
  return outerTasks(events).filter(e=>e.dur>=50000&&e.ts<end&&e.ts+e.dur>start)
    .sort((a,b)=>b.dur-a.dur||a.ts-b.ts).slice(0,8).map(e=>({
      startRelativeMs:(e.ts-start)/1000,
      wholeTaskWallMs:e.dur/1000,
      clippedWallMs:(Math.min(end,e.ts+e.dur)-Math.max(start,e.ts))/1000,
      wholeTaskCpuMs:wholeTaskCpuMs(e),
      clipped:e.ts<start||e.ts+e.dur>end,
      attribution:budget(events,Math.max(start,e.ts),Math.min(end,e.ts+e.dur)),
    }));
}
function ownBundleCallsites(events,start,end,bundles) {
  valid(Array.isArray(bundles)&&bundles.length<=256);
  for(const b of bundles)valid(typeof b.url==="string"&&/^[a-f0-9]{64}$/.test(b.sha256));
  const grouped=new Map();
  for(const e of events){
    if(e.name!=="FunctionCall"||e.ts>=end||e.ts+e.dur<=start)continue;
    const d=e.args?.data, bundleIndex=bundles.findIndex(b=>b.url===d?.url);
    if(bundleIndex<0||!Number.isSafeInteger(d.lineNumber)||d.lineNumber<0||!Number.isSafeInteger(d.columnNumber)||d.columnNumber<0)continue;
    const key=[bundleIndex,d.lineNumber,d.columnNumber].join(":");
    if(!grouped.has(key))grouped.set(key,{bundleIndex,line:d.lineNumber,column:d.columnNumber,events:[]});
    grouped.get(key).events.push(e);
  }
  return [...grouped.values()].map(g=>({bundleIndex:g.bundleIndex,bundleSha256:bundles[g.bundleIndex].sha256,line:g.line,column:g.column,
    recordedWallMs:budget(g.events,start,end).exclusiveWallMs.JS,eventCount:g.events.length}))
    .sort((a,b)=>b.recordedWallMs-a.recordedWallMs).slice(0,8);
}
function knownLoss(value) {
  if(!value||typeof value!=="object")return false;
  for(const [key,entry] of Object.entries(value)){
    if(/^(data_loss|data_loss_count|trace_buffer_overflow|buffer_overflow|events_lost|dropped_events)$/i.test(key)&&entry!==false&&entry!==0&&entry!==null)return true;
    if(knownLoss(entry))return true;
  }
  return false;
}
function summarizeSendTimeline(trace, profile, samples) {
  valid(Array.isArray(trace.traceEvents) && samples?.length === 3);
  valid(
    finite(profile.bufferUsage?.percentage) &&
      profile.bufferUsage.percentage < 1,
  );
  const events = trace.traceEvents;
  const firstGap=profile.schemaVersion===3;
  valid(!knownLoss(trace.metadata));
  valid(!events.some(e=>/^(TraceBufferOverflow|TracingBufferOverflow|TraceEventBufferOverflow|DataLoss)$/.test(e.name)||knownLoss(e.args?.stats)));
  if(firstGap){
    valid(profile.diagnosticOnly===true&&profile.acceptance===false&&profile.traceStopped===true);
    valid(finite(profile.durationMs)&&profile.durationMs<=120000&&profile.deadlineExceeded!==true);
  }
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
    const names=firstGap?[markNames[0],"first-pending-dom-observed",...markNames.slice(1)]:markNames;
    const records=firstGap?[recordNames[0],"pendingDomMs",...recordNames.slice(1)]:recordNames;
    const marks = names.map((name) => {
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
      valid(finite(sample[records[i]]));
      return at / 1000 - sample[records[i]];
    });
    const spread=Math.max(...offsets)-Math.min(...offsets);
    if(firstGap)valid(spread<=5);
    const geometryIndex=firstGap?2:1;
    const geometry=marks[geometryIndex], nextEntry=marks[geometryIndex+1], nextGeometry=marks[geometryIndex+2];
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
      recordToTraceClockOffsetSpreadMs:spread,
      clickToGeometry: budget(renderer, marks[0], geometry),
      geometryToNextFrameEntry: budget(renderer, geometry, nextEntry),
      nextFrameEntryToGeometry: budget(renderer, nextEntry, nextGeometry),
      mainGeometryToNextFrameEntry: budget(main, geometry, nextEntry),
      checkCallbackGapWallMs: budget(
        renderer.filter(
          (e) =>
            e.name === "FunctionCall" && e.args?.data?.functionName === "check",
        ),
        geometry,
        nextEntry,
      ).exclusiveWallMs.JS,
      visibility,
      ...(firstGap?{
        clickToFirstPendingDom:budget(renderer,marks[0],marks[1]),
        firstPendingDomToGeometry:budget(renderer,marks[1],geometry),
        clickToStrictGeometry:budget(renderer,marks[0],nextGeometry),
        firstGapLongTasks:longTasks(renderer,marks[0],marks[1]),
        firstGapOwnBundleCallsites:ownBundleCallsites(renderer,marks[0],marks[1],profile.ownBundles??[]),
        originalTimingColumns:Object.fromEntries([
          "firstVisibleFeedbackMs","clickToPendingDomMs","clickToPendingVisibleFrameMs","clickToBubbleDomMs","clickToVisibleFrameMs","clickToClearFrameMs","clickToCanonicalNotificationMs","clickToFeedbackGeometryCompleteMs","clickToFeedbackSubsequentFrameMs","clickToClearGeometryCompleteMs","clickToClearSubsequentFrameMs","feedbackTargetMs"
        ].map(key=>{valid(finite(sample[key]));return [key,sample[key]];})),
      }:{}) ,
    };
  });
  return {
    schemaVersion:firstGap?3:2,
    ...(firstGap?{traceDurationMs:profile.durationMs,knownLossDetected:false,firstPendingDomMeaning:"First observer match of connected pending DOM; not the mutation time, paint or physical presentation",longTaskCpuMeaning:"Whole outer task thread CPU when both tts and tdur are valid; no clipping proration; null is unavailable",callsiteMeaning:"At most eight numeric locations in exact packaged renderer bundles; overlapping callsites are not additive"}:{}),
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
module.exports = { summarizeSendTimeline, budget, outerTasks, wholeTaskCpuMs, longTasks, ownBundleCallsites };

