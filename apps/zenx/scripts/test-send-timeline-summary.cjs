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


// Reconstructed packaged first-gap v3 contracts. All timings below are synthetic.
const {outerTasks,wholeTaskCpuMs,longTasks,ownBundleCallsites}=require('./summarize-send-timeline.cjs');
function packagedFixture(){
  const f=fixture();
  Object.assign(f.profile,{schemaVersion:3,diagnosticOnly:true,acceptance:false,traceStopped:true,durationMs:1000,ownBundles:[]});
  const columns=["firstVisibleFeedbackMs","clickToPendingDomMs","clickToPendingVisibleFrameMs","clickToBubbleDomMs","clickToVisibleFrameMs","clickToClearFrameMs","clickToCanonicalNotificationMs","clickToFeedbackGeometryCompleteMs","clickToFeedbackSubsequentFrameMs","clickToClearGeometryCompleteMs","clickToClearSubsequentFrameMs","feedbackTargetMs"];
  f.samples.forEach((s,index)=>{
    s.pendingDomMs=s.clickMs+5;
    for(const key of columns)s[key]=key==='feedbackTargetMs'?200:10;
    f.trace.traceEvents.push({ph:'I',pid:2,tid:22,name:`zen-send-${index}-first-pending-dom-observed`,ts:s.pendingDomMs*1000});
  });
  return f;
}
test('first pending DOM splits click to geometry without changing original columns',()=>{
  const f=packagedFixture(),s=summarizeSendTimeline(f.trace,f.profile,f.samples);
  assert.equal(s.schemaVersion,3);
  assert.deepEqual(s.samples[0].tracePhaseRelativeMs,[0,5,10,20,30]);
  assert.equal(s.samples[0].clickToFirstPendingDom.durationMs,5);
  assert.equal(s.samples[0].firstPendingDomToGeometry.durationMs,5);
  assert.equal(s.samples[0].clickToStrictGeometry.durationMs,30);
  assert.equal(s.samples[0].originalTimingColumns.feedbackTargetMs,200);
  assert.equal(s.acceptance,false);
});
for(const [label,change]of Object.entries({
  'missing first-pending mark':f=>f.trace.traceEvents.pop(),
  'duplicate first-pending mark':f=>f.trace.traceEvents.push({...f.trace.traceEvents.at(-1)}),
  'wrong first-pending PID':f=>f.trace.traceEvents.at(-1).pid=3,
  'wrong first-pending TID':f=>f.trace.traceEvents.at(-1).tid=33,
  'missing first-pending record':f=>delete f.samples[0].pendingDomMs,
  'first-pending after geometry':f=>f.trace.traceEvents.at(-1).ts+=10000,
  'large trace-clock mismatch':f=>f.samples[0].pendingDomMs+=7,
  'missing trace duration':f=>delete f.profile.durationMs,
  'duration beyond 120 seconds':f=>f.profile.durationMs=120001,
  'deadline exceeded':f=>f.profile.deadlineExceeded=true,
  'trace not stopped':f=>f.profile.traceStopped=false,
  'acceptance claimed':f=>f.profile.acceptance=true,
  'known loss event':f=>f.trace.traceEvents.push({name:'TraceBufferOverflow'}),
  'known loss metadata':f=>f.trace.metadata={stats:{dropped_events:1}},
  'known loss event stats':f=>f.trace.traceEvents.push({args:{stats:{data_loss:true}}}),
  'missing original timing':f=>delete f.samples[0].clickToClearFrameMs,
  'raw text in timing':f=>f.samples[0].clickToClearFrameMs='/Users/private/token',
})){test(label+' rejects packaged attribution',()=>{const f=packagedFixture();change(f);assert.throws(()=>summarizeSendTimeline(f.trace,f.profile,f.samples),{message:'Invalid private timeline input'});});}
test('outer tasks deduplicate aliases and nested spans BEFORE clipped long-task selection',()=>{
  const e=[{name:'RunTask',ts:0,dur:100000,tts:10,tdur:80000},{name:'ThreadControllerImpl::RunTask',ts:0,dur:100000},{name:'RunTask',ts:10000,dur:70000},{name:'FunctionCall',ts:20000,dur:50000}];
  assert.equal(outerTasks(e).length,1);
  const tasks=longTasks(e,25000,75000);
  assert.equal(tasks.length,1);
  assert.equal(tasks[0].wholeTaskWallMs,100);
  assert.equal(tasks[0].clippedWallMs,50);
  assert.equal(tasks[0].wholeTaskCpuMs,80); // NOT 40: no wall-clock proration.
  assert.equal(tasks[0].clipped,true);
});
test('task threshold inclusive at 50ms and export bounded to eight',()=>{
  const e=Array.from({length:12},(_,i)=>({name:'RunTask',ts:i*100000,dur:i?50000:49999}));
  assert.equal(longTasks(e,0,1200000).length,8);
  assert.equal(longTasks(e,0,100000).length,0);
  assert.equal(longTasks(e,100000,200000)[0].wholeTaskWallMs,50);
});
test('missing invalid or incomplete CPU endpoints stay null rather than zero or wall proxy',()=>{
  for(const e of [{dur:100},{dur:100,tdur:10},{dur:100,tts:1},{dur:100,tts:-1,tdur:10},{dur:100,tts:0,tdur:-1},{dur:100,tts:0,tdur:101},{dur:100,tts:0,tdur:NaN}])assert.equal(wholeTaskCpuMs(e),null);
  assert.equal(wholeTaskCpuMs({dur:100,tts:0,tdur:0}),0);
});
test('callsites export exact own-bundle hashes and numeric locations only, max eight',()=>{
  const bundles=[{url:'file:///fixture/assets/a.js',sha256:'a'.repeat(64)}];
  const e=Array.from({length:12},(_,i)=>({name:'FunctionCall',ts:0,dur:10000,args:{data:{url:bundles[0].url,lineNumber:i,columnNumber:3,functionName:'privateFunction',privateArg:'secret'}}}));
  e.push({...e[0],args:{data:{url:'file:///Users/private/other.js',lineNumber:0,columnNumber:0}}});
  const result=ownBundleCallsites(e,0,10000,bundles);
  assert.equal(result.length,8);
  assert.equal(result[0].recordedWallMs,10);
  const serialized=JSON.stringify(result);
  for(const value of ['file:','privateFunction','secret','args','url'])assert.equal(serialized.includes(value),false);
  assert.equal(result[0].bundleSha256,'a'.repeat(64));
});
test('same callsite nested spans are unioned not summed',()=>{
 const data={url:'file:///fixture.js',lineNumber:1,columnNumber:2}, bundles=[{url:data.url,sha256:'b'.repeat(64)}];
 const result=ownBundleCallsites([{name:'FunctionCall',ts:0,dur:10000,args:{data}},{name:'FunctionCall',ts:1000,dur:4000,args:{data}}],0,10000,bundles);
 assert.equal(result[0].recordedWallMs,10);assert.equal(result[0].eventCount,2);
});
test('capture starts trace before seed selection and stops before final projection',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const s=fs.readFileSync(path.join(__dirname,'capture-recall-send-profile.cjs'),'utf8');
 const run=s.slice(s.indexOf('async function run()'));
 assert(run.indexOf('await networkReady')<run.indexOf('contentTracing.startRecording'));
 assert(run.indexOf('contentTracing.startRecording')<run.indexOf('await click(threadTarget'));
 assert(run.indexOf('await stopOwnedTrace();')<run.indexOf('phase:"final-projection-read"'));
 assert.equal((s.match(/contentTracing\.startRecording\(/g)||[]).length,2); // Invocation plus fixed API label.
 assert(s.includes('trace_buffer_size_in_kb:131072'));
 assert(s.includes('},120000)'));
 assert(s.includes('await pause(500)'));
 assert(s.includes('sample.feedbackTargetMs=200'));
});
test('workflow and packaged source guards bind exactly one fixed run',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const s=fs.readFileSync(path.join(__dirname,'launch-recall-send-profile.mjs'),'utf8');
 assert(s.includes('assert.equal(count,5000)'));
 assert(s.includes('9188f8e915f25ae4d693fae43ad5b8350282a87f'));
 assert(s.includes('dcd68b25656bf34e059382c2b461bd87a9355ceb'));
 assert(s.includes('packaged.executable'));
 assert(s.includes('"--verify", "--deep", "--strict"'));
 assert(s.includes('assert.equal(result.samples.length,3)'));
 assert(s.includes('await verifyLongThread('));
});


test('normal packaging allows only the exact provider digest substitution across main JS',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const s=fs.readFileSync(path.join(__dirname,'launch-recall-send-profile.mjs'),'utf8');
 const code=s.slice(s.indexOf('function verifyMainPackaging('),s.indexOf('const mainFiles='));
 const context=vm.createContext({assert});vm.runInContext(code,context);
 const built='before __ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__ after __ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__',digest='a'.repeat(64);
 context.verifyMainPackaging(built,built.replaceAll('__ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__',digest),digest);
 context.verifyMainPackaging('unchanged','unchanged',digest);
 assert.throws(()=>context.verifyMainPackaging(built,built.replaceAll('__ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__',digest)+' modified',digest));
 assert.throws(()=>context.verifyMainPackaging(built,built.replaceAll('__ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__','b'.repeat(64)),digest));
 assert.throws(()=>context.verifyMainPackaging('unchanged','unchanged','bad'));
});
