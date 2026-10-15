import assert from "node:assert/strict";
import test from "node:test";
import { validateNativeProbeReport } from "../src/main/windows-foreground-input-probe.js";

const report = () => ({
  kind: "windows-os-routed-input" as const,
  guardPid: 123,
  samples: 60,
  sampledFocusChanges: 0,
  foregroundEvents: [],
  injectedClicks: 3,
  guardMouseDown: 2,
  guardMouseUp: 2,
  phase: "stop" as const,
});

test("native input evidence requires positive control, edge delivery and one Stop click", () => {
  assert.doesNotThrow(() => validateNativeProbeReport(report(), "stop"));
  for (const patch of [
    { injectedClicks: 2 },
    { injectedClicks: 4 },
    { guardMouseDown: 1 },
    { guardMouseUp: 3 },
    { samples: 0 },
    { sampledFocusChanges: 1 },
    { foregroundEvents: [456] },
    { phase: "edge" },
  ]) {
    assert.throws(() =>
      validateNativeProbeReport({ ...report(), ...patch }, "stop"),
    );
  }
});

test("native probe checks each epoch instead of accepting an eventual good final state", () => {
  assert.doesNotThrow(() =>
    validateNativeProbeReport(
      {
        ...report(),
        phase: "ready",
        injectedClicks: 1,
        guardMouseDown: 1,
        guardMouseUp: 1,
      },
      "ready",
    ),
  );
  assert.doesNotThrow(() =>
    validateNativeProbeReport(
      { ...report(), phase: "edge", injectedClicks: 2 },
      "edge",
    ),
  );
  assert.throws(() =>
    validateNativeProbeReport(
      {
        ...report(),
        phase: "edge",
        injectedClicks: 2,
        foregroundEvents: [123, 456, 123],
      },
      "edge",
    ),
  );
  assert.throws(() =>
    validateNativeProbeReport(
      {
        ...report(),
        phase: "ready",
        injectedClicks: 1,
        guardMouseDown: 1,
        guardMouseUp: 1,
        sampledFocusChanges: 1,
      },
      "ready",
    ),
  );
});

// This real Node child verifies the client handshake/settlement only. It does not
// stand in for Windows compilation, SendInput, or native focus evidence.
const childSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const directory = process.argv[1];
const mode = process.argv[2];
const foreign = mode === 'foreign' || mode === 'foreign-error';
const has = name => fs.existsSync(path.join(directory, name));
const save = (name, phase, injectedClicks, guardMouseDown, guardMouseUp, injectedEscapeEvents) => {
  const p = path.join(directory, name);
  fs.writeFileSync(p + '.tmp', JSON.stringify({ kind:'windows-os-routed-input', phase, guardPid:foreign ? 1 : process.pid, samples:20, sampledFocusChanges:0, foregroundEvents:[], injectedClicks, guardMouseDown, guardMouseUp, injectedEscapeEvents }));
  fs.renameSync(p + '.tmp', p);
};
save('ready.json','ready',1,1,1);
let stage = 0;
const timer = setInterval(() => {
  if (has('close')) {
    clearInterval(timer);
    setTimeout(() => {
      if (mode === 'errorfile' || mode === 'foreign-error') fs.writeFileSync(path.join(directory,'error.json'), JSON.stringify({error:'late native shutdown failure'}));
      if (mode === 'signal') process.kill(process.pid,'SIGTERM');
      else process.exit(mode === 'exit42' || mode === 'foreign-error' ? 42 : 0);
    },80);
    return;
  }
  if (stage === 0 && has('edge')) { save('edge.json','edge',2,2,2); stage++; }
  if (stage === 1 && has('stop.json')) {
    const command=JSON.parse(fs.readFileSync(path.join(directory,'stop.json'),'utf8'));
    if (command.x !== 15 || command.y !== 20 || command.handle !== '55' || command.pid !== process.ppid) process.exit(5);
    save('stop-result.json','stop',3,2,2); stage++;
  }
  if (stage === 2 && has('escape')) { save('escape-result.json','escape',3,2,2,2); stage = 4; }
  if (stage === 4 && has('finish')) { save('final.json','escape',3,2,2,2); stage++; }
  if (stage === 2 && has('finish')) { save('final.json','stop',3,2,2); stage++; }
},5);
`;

test("owned subprocess handshake verifies identity, atomic Stop command and true close", async () => {
  const { spawn } = await import("node:child_process");
  const { access } = await import("node:fs/promises");
  const { startWindowsForegroundInputProbe } =
    await import("../src/main/windows-foreground-input-probe.js");
  let childClosed = false;
  let directory = "";
  const probe = await startWindowsForegroundInputProbe({
    platform: "win32",
    spawnGuard(_script, location) {
      directory = location;
      const child = spawn(process.execPath, ["-e", childSource, location], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.once("close", () => {
        childClosed = true;
      });
      return child;
    },
  });
  try {
    assert.equal(probe.ready.phase, "ready");
    assert.equal((await probe.clickEdge()).guardMouseUp, 2);
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(55n);
    assert.equal(
      (await probe.clickStop({ x: 15, y: 20 }, handle)).injectedClicks,
      3,
    );
    assert.equal((await probe.finish()).phase, "stop");
  } finally {
    await probe.close();
  }
  assert.equal(childClosed, true);
  await assert.rejects(access(directory));
});

test("a report from a different PID is rejected and the owned child is still joined", async () => {
  const { spawn } = await import("node:child_process");
  const { startWindowsForegroundInputProbe } =
    await import("../src/main/windows-foreground-input-probe.js");
  let childClosed = false;
  await assert.rejects(
    startWindowsForegroundInputProbe({
      platform: "win32",
      spawnGuard(_script, location) {
        const child = spawn(
          process.execPath,
          ["-e", childSource, location, "foreign"],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        child.once("close", () => {
          childClosed = true;
        });
        return child;
      },
    }),
    /exact external guard process/,
  );
  assert.equal(childClosed, true);
});

for (const mode of ["exit42", "signal", "errorfile"]) {
  test(`late ${mode} cannot turn final reports into cleanup success`, async () => {
    const { spawn } = await import("node:child_process");
    const { access, rm } = await import("node:fs/promises");
    const { startWindowsForegroundInputProbe } =
      await import("../src/main/windows-foreground-input-probe.js");
    let directory = "";
    let childClosed = false;
    const probe = await startWindowsForegroundInputProbe({
      platform: "win32",
      spawnGuard(_script, location) {
        directory = location;
        const child = spawn(
          process.execPath,
          ["-e", childSource, location, mode],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        child.once("close", () => {
          childClosed = true;
        });
        return child;
      },
    });
    await probe.clickEdge();
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(55n);
    await probe.clickStop({ x: 15, y: 20 }, handle);
    await probe.finish();
    try {
      await assert.rejects(
        probe.close(),
        mode === "errorfile" ? /late native shutdown failure/ : /code=|signal=/,
      );
      assert.equal(childClosed, true);
      await access(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("startup failure and terminal cleanup failure both remain in the causal report", async () => {
  const { spawn } = await import("node:child_process");
  const { access, rm } = await import("node:fs/promises");
  const { startWindowsForegroundInputProbe } =
    await import("../src/main/windows-foreground-input-probe.js");
  let directory = "";
  try {
    await assert.rejects(
      startWindowsForegroundInputProbe({
        platform: "win32",
        spawnGuard(_script, location) {
          directory = location;
          return spawn(
            process.execPath,
            ["-e", childSource, location, "foreign-error"],
            { stdio: ["ignore", "ignore", "pipe"] },
          );
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(String(error.cause), /exact external guard process/);
        assert.ok(error.errors.some((cause) => /code=42/.test(String(cause))));
        assert.ok(
          error.errors.some((cause) =>
            /late native shutdown failure/.test(String(cause)),
          ),
        );
        return true;
      },
    );
    await access(directory);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test("Escape evidence requires exactly one OS-routed down/up pair", () => {
  assert.doesNotThrow(() =>
    validateNativeProbeReport(
      { ...report(), phase: "escape", injectedEscapeEvents: 2 },
      "escape",
    ),
  );
  for (const injectedEscapeEvents of [undefined, 0, 1, 4])
    assert.throws(() =>
      validateNativeProbeReport(
        { ...report(), phase: "escape", injectedEscapeEvents },
        "escape",
      ),
    );
});

test("Escape client handshake retains the exact guard identity through final settlement", async () => {
  const { spawn } = await import("node:child_process");
  const { startWindowsForegroundInputProbe } =
    await import("../src/main/windows-foreground-input-probe.js");
  const probe = await startWindowsForegroundInputProbe({
    platform: "win32",
    spawnGuard(_script, location) {
      return spawn(process.execPath, ["-e", childSource, location], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    },
  });
  try {
    await probe.clickEdge();
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(55n);
    await probe.clickStop({ x: 15, y: 20 }, handle);
    assert.equal((await probe.pressEscape()).injectedEscapeEvents, 2);
    assert.equal((await probe.finish()).phase, "escape");
  } finally {
    await probe.close();
  }
});
