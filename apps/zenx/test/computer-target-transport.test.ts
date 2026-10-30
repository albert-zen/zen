import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NativeComputerTargetTransport } from "../src/main/capabilities/computer-target-transport.js";

test("transport cancellation destroys binding process without replay, then allows explicit reselection", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-target-transport-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fixture.cjs");
  await writeFile(
    executable,
    `#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin});\nrl.on('line',line=>{const r=JSON.parse(line);if(r.operation==='select') console.log(JSON.stringify({result:{pid:process.pid}}));});\n`,
    { mode: 0o700 },
  );
  const transport = new NativeComputerTargetTransport(async () => executable);
  t.after(() => transport.close());
  const signal = new AbortController().signal;
  const before = (await transport.request({ operation: "select" }, signal)) as {
    pid: number;
  };
  const controller = new AbortController();
  const pending = transport.request(
    { operation: "key" },
    controller.signal,
    () => {
      throw new Error("broken presentation");
    },
  );
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /outcome unknown/);
  assert.throws(() => process.kill(before.pid, 0), { code: "ESRCH" });
  await assert.rejects(
    transport.request({ operation: "key" }, signal),
    /no input dispatched/,
  );
  const after = (await transport.request({ operation: "select" }, signal)) as {
    pid: number;
  };
  assert.notEqual(before.pid, after.pid);
});

test("transport shutdown during executable preparation cannot start a helper", async () => {
  let release!: (value: string) => void;
  let entered!: () => void;
  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const executable = new Promise<string>((resolve) => {
    release = resolve;
  });
  const transport = new NativeComputerTargetTransport(async () => {
    entered();
    return executable;
  });
  const request = transport.request(
    { operation: "select" },
    new AbortController().signal,
  );
  const rejected = assert.rejects(request, /session is closed/);
  await preparing;
  await transport.close();
  release(process.execPath);
  await rejected;
});

for (const response of ["not-json", "null", "{}", '{"result":{}}'])
  test(`invalid native receipt ${response} settles only after child closure`, async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-target-invalid-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "fixture.cjs");
    await writeFile(
      executable,
      `#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin});\nrl.on('line',line=>{const r=JSON.parse(line);console.log(r.operation==='select'?JSON.stringify({result:{pid:process.pid}}):${JSON.stringify(response)});});\n`,
      { mode: 0o700 },
    );
    const transport = new NativeComputerTargetTransport(async () => executable);
    t.after(() => transport.close());
    const signal = new AbortController().signal;
    const selected = (await transport.request(
      { operation: "select" },
      signal,
    )) as { pid: number };
    await assert.rejects(
      transport.request({ operation: "key" }, signal),
      /Invalid native target response.*outcome unknown/,
    );
    assert.throws(() => process.kill(selected.pid, 0), { code: "ESRCH" });
    await assert.rejects(
      transport.request({ operation: "key" }, signal),
      /no input dispatched/,
    );
    const reselected = (await transport.request(
      { operation: "select" },
      signal,
    )) as { pid: number };
    assert.notEqual(selected.pid, reselected.pid);
  });

for (const killMode of ["false", "throw", "error", "true"] as const) {
  for (const failure of [
    "abort",
    "malformed",
    "missing-receipt",
    "child-error",
    "pipe-error",
    "overflow",
    "close",
    "timeout",
  ] as const) {
    test(`native ${failure}, kill=${killMode}: activity remains stopping through exit and late reply until close`, async (t) => {
      const { EventEmitter } = await import("node:events");
      const { PassThrough } = await import("node:stream");
      const { ForegroundActivity } =
        await import("../src/main/foreground-activity.js");
      let writes = 0,
        kills = 0,
        stopping = 0;
      const child =
        new EventEmitter() as import("node:child_process").ChildProcessWithoutNullStreams;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.stdin.on("data", (chunk: Buffer) => {
        writes++;
        if (JSON.parse(chunk.toString()).operation === "select")
          queueMicrotask(() =>
            child.stdout.emit("data", '{"result":{"selected":true}}\n'),
          );
      });
      child.kill = () => {
        kills++;
        if (killMode === "throw") throw new Error("synthetic kill failure");
        if (killMode === "error")
          child.emit("error", new Error("synthetic kill error"));
        return killMode === "true";
      };
      const transport = new NativeComputerTargetTransport(
        async () => "/synthetic",
        (() => child) as unknown as typeof import("node:child_process").spawn,
      );
      t.after(() => child.emit("close", 1));
      const controller = new AbortController();
      await transport.request({ operation: "select" }, controller.signal);
      const activity = new ForegroundActivity({
        presenter: { update: async () => {}, close() {} },
        agentName: () => "Synthetic",
        report() {},
      });
      if (failure === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
      const operation = activity.run(
        {
          callId: "native-lifecycle",
          name: "synthetic",
          arguments: {},
          cwd: "/synthetic",
          signal: controller.signal,
        },
        (signal, onStopping) =>
          transport.request({ operation: "key" }, signal, () => {
            stopping++;
            onStopping?.();
          }),
      );
      const rejected = assert.rejects(operation, /outcome unknown/);
      let settled = false;
      void operation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(writes, 2);
      let closing: Promise<void> | undefined;
      if (failure === "abort") controller.abort();
      if (failure === "malformed") child.stdout.emit("data", "not-json\n");
      if (failure === "missing-receipt")
        child.stdout.emit("data", '{"result":{}}\n');
      if (failure === "child-error")
        child.emit("error", new Error("fixture native failure"));
      if (failure === "pipe-error")
        child.stdin.emit("error", new Error("fixture pipe failure"));
      if (failure === "overflow") child.stdout.emit("data", "x".repeat(65537));
      if (failure === "close") closing = transport.close();
      if (failure === "timeout") t.mock.timers.tick(10_000);
      assert.equal(activity.snapshot.activities.length, 1);
      assert.equal(activity.snapshot.activities[0]?.stopping, true);
      assert.equal(stopping, 1);
      assert.equal(kills, 1);
      child.emit("exit", 1);
      child.stdout.emit(
        "data",
        JSON.stringify({
          result: { dispatch: "posted", applicationEffect: "unverified" },
        }) + "\n",
      );
      child.emit("error", new Error("later native error"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      assert.equal(activity.snapshot.activities.length, 1);
      assert.equal(writes, 2, "no replacement/replay while stopping");
      assert.equal(kills, 1, "no termination retry");
      assert.equal(stopping, 1);
      child.emit("close", 1);
      await rejected;
      await closing;
      assert.equal(activity.snapshot.activities.length, 0);
      await transport.close();
      assert.equal(kills, 1);
    });
  }
}

for (const operation of [
  "backgroundClick",
  "backgroundType",
  "backgroundKeyPress",
])
  test(`background ${operation} abort waits for owned release and close without replay`, async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-background-release-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "fixture.cjs"),
      released = path.join(directory, "released");
    await writeFile(
      executable,
      `#!${process.execPath}
const fs=require('node:fs');let down=false;
process.on('SIGTERM',()=>{setTimeout(()=>{if(down) fs.writeFileSync(${JSON.stringify(released)},'up');process.exit(0)},50)});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.operation==='select') console.log(JSON.stringify({result:{pid:process.pid}}));else {down=true; console.log(JSON.stringify({phase:'backgroundPairStarted'}));}});
`,
      { mode: 0o700 },
    );
    const transport = new NativeComputerTargetTransport(async () => executable);
    t.after(() => transport.close());
    await transport.request(
      { operation: "select" },
      new AbortController().signal,
    );
    const controller = new AbortController();
    const pending = transport.request({ operation }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, /outcome unknown/);
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(released, "utf8"), "up");
    await assert.rejects(
      transport.request({ operation }, new AbortController().signal),
      /no input dispatched/,
    );
  });

test("background cleanup grace expiry blocks further background input even after explicit reselection", async (t) => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const signals: string[] = [];
  const child =
    new EventEmitter() as import("node:child_process").ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.on("data", (chunk) => {
    if (JSON.parse(chunk.toString()).operation === "select")
      queueMicrotask(() =>
        child.stdout.emit("data", '{"result":{"selected":true}}\n'),
      );
  });
  child.kill = ((signal: string) => {
    signals.push(signal);
    return true;
  }) as typeof child.kill;
  const transport = new NativeComputerTargetTransport(
    async () => "/synthetic",
    (() => child) as unknown as typeof import("node:child_process").spawn,
  );
  const controller = new AbortController();
  await transport.request({ operation: "select" }, controller.signal);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = transport.request(
    { operation: "backgroundClick" },
    controller.signal,
  );
  const rejection = assert.rejects(pending, /outcome unknown/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  child.stdout.emit("data", '{"phase":"backgroundPairStarted"}\n');
  controller.abort();
  assert.deepEqual(signals, ["SIGTERM"]);
  t.mock.timers.tick(1_999);
  assert.deepEqual(signals, ["SIGTERM"]);
  t.mock.timers.tick(1);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  child.emit("close", 1);
  await rejection;
  await transport.request(
    { operation: "select" },
    new AbortController().signal,
  );
  await assert.rejects(
    transport.request(
      { operation: "backgroundClick" },
      new AbortController().signal,
    ),
    /release is unknown.*no input dispatched/,
  );
  child.emit("close", 0);
  await transport.close();
});

test("pairStarted then error without settled cannot clear release uncertainty by reselection", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-background-truncated-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fixture.cjs");
  await writeFile(
    executable,
    `#!${process.execPath}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.operation==='select') console.log(JSON.stringify({result:{pid:process.pid}}));else {console.log(JSON.stringify({phase:'backgroundPairStarted'}));console.log(JSON.stringify({error:'truncated release'}));}});
`,
    { mode: 0o700 },
  );
  const transport = new NativeComputerTargetTransport(async () => executable);
  t.after(() => transport.close());
  const signal = new AbortController().signal;
  await transport.request({ operation: "select" }, signal);
  await assert.rejects(
    transport.request({ operation: "backgroundClick" }, signal),
    /outcome unknown/,
  );
  await transport.request({ operation: "select" }, signal);
  await assert.rejects(
    transport.request({ operation: "backgroundClick" }, signal),
    /release is unknown.*no input dispatched/,
  );
});

for (const settled of [true, false])
  test(`drag abort waits for release and process close; settlement=${settled}`, async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-drag-release-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "fixture.cjs"),
      released = path.join(directory, "released");
    await writeFile(
      executable,
      `#!${process.execPath}
const fs = require('node:fs'); let down = false;
process.on('SIGTERM', () => { setTimeout(() => {
  if (down) fs.writeFileSync(${JSON.stringify(released)}, 'up');
  if (${settled}) fs.writeSync(1, JSON.stringify({phase:'foregroundDragSettled',release:'posted'})+'\\n');
  process.exit(0);
}, 30); });
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const r=JSON.parse(line);
  if (r.operation==='select') console.log(JSON.stringify({result:{pid:process.pid}}));
  else { down=true; fs.writeFileSync(${JSON.stringify(released)},'down'); }
});
`,
      { mode: 0o700 },
    );
    const transport = new NativeComputerTargetTransport(async () => executable);
    t.after(() => transport.close());
    const signal = new AbortController().signal;
    await transport.request({ operation: "select" }, signal);
    const controller = new AbortController();
    const pending = transport.request({ operation: "drag" }, controller.signal);
    const rejection = assert.rejects(pending, /outcome unknown/);
    const { readFile } = await import("node:fs/promises");
    const deadline = Date.now() + 2000;
    while ((await readFile(released, "utf8").catch(() => "")) !== "down") {
      assert.ok(Date.now() < deadline, "owned helper did not receive drag");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    await rejection;
    assert.equal(
      await readFile(released, "utf8"),
      "up",
      "SIGTERM permits cleanup before close",
    );
    await transport.request({ operation: "select" }, signal);
    if (!settled)
      await assert.rejects(
        transport.request({ operation: "drag" }, signal),
        /release is unknown.*no input dispatched/,
      );
  });

for (const release of ["posted", "unknown"])
  test(`drag transport requires explicit known settlement (${release})`, async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-drag-settle-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "fixture.cjs");
    await writeFile(
      executable,
      `#!${process.execPath}
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const r=JSON.parse(line);
  if(r.operation==='select') console.log(JSON.stringify({result:{pid:process.pid}}));
  else {
    console.log(JSON.stringify({phase:'foregroundDragSettled',release:${JSON.stringify(release)}}));
    console.log(JSON.stringify({result:{dispatch:'posted',applicationEffect:'unverified',release:${JSON.stringify(release)}}}));
  }
});
`,
      { mode: 0o700 },
    );
    const transport = new NativeComputerTargetTransport(async () => executable);
    t.after(() => transport.close());
    const signal = new AbortController().signal;
    await transport.request({ operation: "select" }, signal);
    if (release === "posted") {
      assert.deepEqual(await transport.request({ operation: "drag" }, signal), {
        dispatch: "posted",
        applicationEffect: "unverified",
        release: "posted",
      });
    } else {
      await assert.rejects(
        transport.request({ operation: "drag" }, signal),
        /outcome unknown/,
      );
      await transport.request({ operation: "select" }, signal);
      await assert.rejects(
        transport.request({ operation: "drag" }, signal),
        /release is unknown.*no input dispatched/,
      );
    }
  });

test("a later target selection cannot enter while native activation is settling", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-target-serialized-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fixture.cjs");
  await writeFile(
    executable,
    `#!${process.execPath}
const rl=require('node:readline').createInterface({input:process.stdin});
let settling=false, selections=0;
rl.on('line',line=>{
  const r=JSON.parse(line);
  if(r.operation==='select') {
    console.log(JSON.stringify(settling ? {error:'selection reentered pending native input'} : {result:{selections:++selections}}));
  } else {
    settling=true;
    setTimeout(()=>{settling=false; console.log(JSON.stringify({result:{dispatch:'posted',applicationEffect:'unverified'}}));},40);
  }
});
`,
    { mode: 0o700 },
  );
  const transport = new NativeComputerTargetTransport(async () => executable);
  t.after(() => transport.close());
  const signal = new AbortController().signal;
  await transport.request({ operation: "select" }, signal);
  const input = transport.request({ operation: "key" }, signal);
  const next = transport.request({ operation: "select" }, signal);
  assert.deepEqual(await input, {
    dispatch: "posted",
    applicationEffect: "unverified",
  });
  assert.deepEqual(await next, { selections: 2 });
});
