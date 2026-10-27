import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileTraceStore } from "../../../src/trace.js";
import { createToolTraceCapture } from "../../../src/trace-tool.js";
import { withNativeComputerTrace } from "../src/main/capabilities/computer-native-trace.js";
import {
  ComputerZenXCapabilityPackage,
  type ZenXComputerBackend,
} from "../src/main/capabilities/computer-provider.js";
import { NativeComputerTargetTransport } from "../src/main/capabilities/computer-target-transport.js";

test("serialized native diagnostics persist to their own harness calls, never raw stderr", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-trace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fixture.cjs");
  await writeFile(
    executable,
    `#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);if(r.operation==='select'){console.log('{"result":{}}');return;}process.stderr.write('private title secret\\n');const frame=JSON.stringify({phase:'diagnostic',diagnostic:{kind:'native-capture-progress',stage:'sls-returned',monotonicNs:'123',mainThread:true,secret:'hidden',requestId:r.diagnosticRequestId}})+'\\n';process.stdout.write(frame.slice(0,30));setTimeout(()=>{process.stdout.write(frame.slice(30));console.log(JSON.stringify({phase:'diagnostic',diagnostic:{kind:'native-capture-progress',stage:'completed',monotonicNs:'124',mainThread:false,requestId:r.diagnosticRequestId}}));console.log(JSON.stringify({result:{ok:true}}));},10);});`,
    { mode: 0o700 },
  );
  const transport = new NativeComputerTargetTransport(async () => executable);
  t.after(() => transport.close());
  const trace = new FileTraceStore(path.join(directory, "trace"));
  await transport.request(
    { operation: "select" },
    new AbortController().signal,
  );
  const service = new ComputerZenXCapabilityPackage({
    listWindows: async (_query: unknown, signal: AbortSignal) =>
      transport.request({ operation: "capture" }, signal),
  } as unknown as ZenXComputerBackend);
  const sinks = ["a", "b"].map((callId) =>
    createToolTraceCapture(trace, {
      threadId: "thread",
      callId,
      toolCallItemId: `item-${callId}`,
    }),
  );
  await Promise.all(
    sinks.map((sink, index) =>
      service.invoke("computer_list_windows", {
        name: "computer_list_windows",
        callId: ["a", "b"][index]!,
        threadId: "thread",
        cwd: directory,
        arguments: {},
        signal: new AbortController().signal,
        traceOutput: sink,
      }),
    ),
  );
  const { records } = await new FileTraceStore(
    path.join(directory, "trace"),
  ).read("thread");
  for (const callId of ["a", "b"]) {
    const selected = records.filter((r) => (r.data as any)?.callId === callId);
    assert.ok(
      selected.every(
        (r) => (r.data as any)?.toolCallItemId === `item-${callId}`,
      ),
    );
    const chunks = await Promise.all(
      selected.flatMap((r) =>
        r.artifacts.map((a) => trace.readArtifact(a.ref)),
      ),
    );
    const text = Buffer.concat(chunks).toString();
    assert.match(text, /sls-returned/);
    assert.ok(text.indexOf("sls-returned") < text.indexOf("completed"));
    assert.ok(text.indexOf("completed") < text.indexOf('"event":"terminal"'));
    assert.doesNotMatch(text, /private title|secret|hidden/);
    assert.equal(
      selected.filter((r) => r.type === "tool_output_end").length,
      1,
    );
    assert.equal(
      (selected.find((r) => r.type === "tool_output_end")?.data as any)
        ?.completeness,
      "complete",
    );
    assert.equal(sinks[0]!.hasObservedResult(), false);
  }
});

for (const mode of ["abort", "timeout"] as const) {
  test(`${mode} retains last capture stage and actual child close as incomplete Trace`, async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "native-trace-stop-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "fixture.cjs");
    await writeFile(
      executable,
      `#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);if(r.operation==='select') console.log('{"result":{}}');else process.stderr.write('{"kind":"native-capture-progress","stage":"sls-before","monotonicNs":"456","mainThread":false,"requestId":'+JSON.stringify(r.diagnosticRequestId)+'}\\n');});`,
      { mode: 0o700 },
    );
    const transport = new NativeComputerTargetTransport(async () => executable);
    t.after(() => transport.close());
    await transport.request(
      { operation: "select" },
      new AbortController().signal,
    );
    const trace = new FileTraceStore(path.join(directory, "trace"));
    const sink = createToolTraceCapture(trace, {
      threadId: "thread",
      callId: mode,
      toolCallItemId: "item",
    });
    const controller = new AbortController();
    if (mode === "abort") setTimeout(() => controller.abort(), 150);
    await assert.rejects(
      withNativeComputerTrace(sink, () =>
        transport.request({ operation: "capture" }, controller.signal),
      ),
      /outcome unknown/,
    );
    const { records } = await trace.read("thread");
    const text = Buffer.concat(
      await Promise.all(
        records.flatMap((r) =>
          r.artifacts.map((a) => trace.readArtifact(a.ref)),
        ),
      ),
    ).toString();
    assert.match(text, /sls-before/);
    assert.match(text, /cancel-requested/);
    assert.match(text, /child-close/);
    assert.equal(
      (records.find((r) => r.type === "tool_output_end")?.data as any)
        ?.completeness,
      "incomplete",
    );
    assert.equal(sink.hasObservedResult(), false);
  });
}

test("Trace sink exceptions cannot change action value or cancellation settlement", async () => {
  const broken = {
    write() {
      throw new Error("Trace offline");
    },
    end() {
      throw new Error("Trace offline");
    },
    flush() {
      throw new Error("Trace offline");
    },
  } as any;
  const { nativeComputerRequestDiagnostics } =
    await import("../src/main/capabilities/computer-native-trace.js");
  let effects = 0;
  assert.equal(
    await withNativeComputerTrace(broken, async () => {
      nativeComputerRequestDiagnostics()!.event("dispatch");
      effects++;
      return "posted";
    }),
    "posted",
  );
  await assert.rejects(
    withNativeComputerTrace(broken, async () => {
      nativeComputerRequestDiagnostics()!.event("background-settled", {
        release: "posted",
      });
      throw new Error("original unknown");
    }),
    /original unknown/,
  );
  assert.equal(effects, 1);
});

test("late old IDs, missing IDs and torn old markers cannot contaminate next owner", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-trace-late-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fixture.cjs");
  await writeFile(
    executable,
    `#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin});let old;rl.on('line',line=>{const r=JSON.parse(line);if(r.operation==='select'){if('diagnosticRequestId' in r)process.exit(8);console.log('{"result":{}}');return;}if(old){process.stdout.write(JSON.stringify({phase:'diagnostic',diagnostic:{kind:'native-capture-progress',stage:'sls-returned',monotonicNs:'1',mainThread:false,requestId:old}})+'\\n');process.stderr.write('old-torn-tail"}\\n');process.stderr.write(JSON.stringify({kind:'native-capture-progress',stage:'sls-returned',monotonicNs:'1',mainThread:false,requestId:old})+'\\n');process.stderr.write(JSON.stringify({kind:'native-capture-progress',stage:'callback-entered',monotonicNs:'2',mainThread:false})+'\\n');}process.stderr.write(JSON.stringify({kind:'native-capture-progress',stage:'metadata-ready',monotonicNs:'3',mainThread:true,requestId:r.diagnosticRequestId})+'\\n');setTimeout(()=>{process.stderr.write('{"kind":"native-capture-progress","stage":"');console.log('{"result":{}}');old=r.diagnosticRequestId;},20);});`,
    { mode: 0o700 },
  );
  const transport = new NativeComputerTargetTransport(async () => executable);
  t.after(() => transport.close());
  const signal = new AbortController().signal;
  await transport.request({ operation: "select" }, signal);
  const trace = new FileTraceStore(path.join(directory, "trace"));
  for (const callId of ["first", "second"]) {
    const sink = createToolTraceCapture(trace, { threadId: "thread", callId });
    await withNativeComputerTrace(sink, () =>
      transport.request({ operation: "capture" }, signal),
    );
  }
  const { records } = await trace.read("thread");
  const second = records.filter((r) => (r.data as any)?.callId === "second");
  const text = Buffer.concat(
    await Promise.all(
      second.flatMap((r) => r.artifacts.map((a) => trace.readArtifact(a.ref))),
    ),
  ).toString();
  assert.match(text, /metadata-ready/);
  assert.match(text, /uncorrelated-marker-dropped/);
  assert.doesNotMatch(text, /sls-returned|callback-entered|old-torn-tail/);
});

test("broken Trace cannot prevent actual owned child release and close", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "native-trace-release-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = path.join(directory, "released");
  const executable = path.join(directory, "fixture.cjs");
  await writeFile(
    executable,
    `#!${process.execPath}\nlet down=false;process.on('SIGTERM',()=>{if(down){require('node:fs').writeFileSync(${JSON.stringify(release)},'up');console.log('{"phase":"backgroundSettled","release":"posted"}');}setTimeout(()=>process.exit(0),10);});require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.operation==='select')console.log('{"result":{}}');else{down=true;console.log('{"phase":"backgroundPairStarted"}');}});`,
    { mode: 0o700 },
  );
  const transport = new NativeComputerTargetTransport(async () => executable);
  t.after(() => transport.close());
  await transport.request(
    { operation: "select" },
    new AbortController().signal,
  );
  const broken = {
    write: async () => {
      throw Error("offline");
    },
    end: async () => {
      throw Error("offline");
    },
    flush: async () => {
      throw Error("offline");
    },
  } as any;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(
    withNativeComputerTrace(broken, () =>
      transport.request({ operation: "backgroundClick" }, controller.signal),
    ),
    /outcome unknown/,
  );
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(release, "utf8"), "up");
});

test("diagnostic byte budget ends incomplete without changing operation result", async () => {
  const { nativeComputerRequestDiagnostics } =
    await import("../src/main/capabilities/computer-native-trace.js");
  let bytes = 0;
  let complete: boolean | undefined;
  const sink = {
    write: async (_source: string, line: string) => {
      bytes += Buffer.byteLength(line);
    },
    end: async (_source: string, value: boolean) => {
      complete = value;
    },
    flush: async () => {},
  } as any;
  assert.equal(
    await withNativeComputerTrace(sink, async () => {
      const span = nativeComputerRequestDiagnostics()!;
      for (let i = 0; i < 2000; i++) span.event("dispatch");
      return 42;
    }),
    42,
  );
  assert.ok(bytes <= 32768);
  assert.equal(complete, false);
});

for (const mode of [
  "plan-only",
  "wrong-id",
  "invalid-marker",
  "spoof-release",
  "unknown-phase",
] as const) {
  test(`stdout diagnostic ${mode} never grants completion or release authority`, async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "native-trace-phase-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "fixture.cjs");
    await writeFile(
      executable,
      `#!${process.execPath}\nrequire('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.operation==='select'){console.log('{"result":{}}');return;}const mode=${JSON.stringify(mode)};const diagnostic={kind:'native-capture-progress',stage:mode==='plan-only'?'plan-ready':mode==='invalid-marker'?'private-invalid':'completed',monotonicNs:'77',mainThread:true,requestId:mode==='wrong-id'?'old-id':r.diagnosticRequestId};console.log(JSON.stringify({phase:mode==='unknown-phase'?'unknown':'diagnostic',diagnostic,release:'posted',result:{dispatch:'posted',effect:'unverified',release:'posted'}}));console.log(JSON.stringify({result:{dispatch:'posted',effect:'unverified',release:'posted'}}));});`,
      { mode: 0o700 },
    );
    const transport = new NativeComputerTargetTransport(async () => executable);
    t.after(() => transport.close());
    const signal = new AbortController().signal;
    await transport.request({ operation: "select" }, signal);
    const trace = new FileTraceStore(path.join(directory, "trace"));
    const sink = createToolTraceCapture(trace, {
      threadId: "thread",
      callId: mode,
    });
    const operation = withNativeComputerTrace(sink, () =>
      transport.request(
        { operation: mode === "spoof-release" ? "backgroundClick" : "capture" },
        signal,
      ),
    );
    if (mode === "spoof-release" || mode === "unknown-phase")
      await assert.rejects(operation, /outcome unknown/);
    else await operation;
    const { records } = await trace.read("thread");
    assert.equal(
      (records.find((r) => r.type === "tool_output_end")?.data as any)
        ?.completeness,
      "incomplete",
    );
    const text = Buffer.concat(
      await Promise.all(
        records.flatMap((r) =>
          r.artifacts.map((a) => trace.readArtifact(a.ref)),
        ),
      ),
    ).toString();
    assert.doesNotMatch(text, /background-settled|private-invalid/);
    assert.equal(sink.hasObservedResult(), false);
  });
}
