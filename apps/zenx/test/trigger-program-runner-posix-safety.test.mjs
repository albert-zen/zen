import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Every signal and spawn reference in the production module is replaced before
// evaluation. These tests cannot send signals to the test runner or the host.
const source = readFileSync(
  new URL("../src/main/trigger-program-runner.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(`${source}\nexport { sendPosixSignal };`, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const root = {
  pid: 20001,
  parentPid: 10001,
  processGroupId: 20001,
  sessionId: 20001,
  startTime: "Fri Oct 16 01:00:00 2026",
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(capture, options = {}) {
  const calls = [];
  let completed = false;
  let captures = 0;
  const child = Object.assign(new EventEmitter(), {
    pid: root.pid,
    exitCode: options.exitCode ?? null,
    signalCode: options.signalCode ?? null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: (signal) => {
      calls.push({ kind: "child", signal, afterCompletion: completed });
      return true;
    },
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    Buffer,
    DOMException,
    setTimeout: options.clock?.setTimeout ?? setTimeout,
    clearTimeout: options.clock?.clearTimeout ?? clearTimeout,
    ...(options.clock ? { Date: { now: options.clock.now } } : {}),
    process: {
      pid: root.parentPid,
      platform: options.platform ?? "linux",
      env: {},
      cwd: () => "/mock",
      kill: (pid, signal) => {
        calls.push({
          kind: "process",
          pid,
          signal,
          afterCompletion: completed,
        });
        options.onSignal?.(pid, signal, child);
        return true;
      },
    },
    require: (name) => {
      if (name === "node:child_process") return { spawn: () => child };
      if (name === "./trigger-limits.js")
        return { MAX_PROGRAM_TIMEOUT_MS: 60_000 };
      if (name === "./owned-child-process.js")
        return {
          observeOwnedChild: () => {
            throw new Error("Unexpected helper");
          },
        };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  const runner = new module.exports.ZenXTriggerProgramRunner({
    captureProcessTable: async () => ({
      entries: await capture(++captures, child),
    }),
    terminateProcessIdentity: () => {
      throw new Error("Unexpected Windows termination");
    },
  });
  return {
    calls,
    child,
    signal: module.exports.sendPosixSignal,
    run: async () => {
      const result = await runner.run(
        { command: "mock-only", timeoutMs: 1 },
        { invocationId: "safety", stage: "action", event: {} },
        new AbortController().signal,
      );
      completed = true;
      return result;
    },
  };
}

test("POSIX signal boundary rejects zero, broadcast, and invalid IDs", () => {
  const f = fixture(() => []);
  for (const id of [
    0,
    -0,
    -1,
    -42,
    NaN,
    Infinity,
    2.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(f.signal(id, "SIGKILL").ok, false);
    assert.equal(f.signal(id, "SIGKILL", undefined, true).ok, false);
  }
  assert.equal(f.signal(1, "SIGKILL", undefined, true).ok, false);
  assert.equal(
    f.signal(20001, "SIGKILL", { isActive: () => false, deadline: Infinity })
      .ok,
    false,
  );
  assert.equal(
    f.signal(20001, "SIGKILL", { isActive: () => true, deadline: 0 }).ok,
    false,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.signal(20001, "SIGTERM", undefined, true).ok, true);
  assert.deepEqual(
    f.calls.map(({ pid }) => pid),
    [-20001],
  );
});

test("POSIX valid owned root and descendant cleanup still reaches quiescence", async () => {
  const descendant = { ...root, pid: 20002, parentPid: root.pid };
  const f = fixture((n) => (n <= 2 ? [root, descendant] : []));
  const result = await f.run();
  assert.equal(result.status, "timed_out");
  assert.doesNotMatch(result.error, /containment/u);
  assert(
    f.calls.some((call) => call.pid === -root.pid && call.signal === "SIGTERM"),
  );
  assert(
    f.calls.some(
      (call) => call.pid === descendant.pid && call.signal === "SIGKILL",
    ),
  );
});

test("POSIX initial capture rejects an already-exited root generation", async () => {
  for (const state of [{ exitCode: 0 }, { signalCode: "SIGTERM" }]) {
    const replacement = { ...root, parentPid: 40004, processGroupId: 40004 };
    const f = fixture(() => [replacement], state);
    await f.run();
    assert.equal(f.calls.length, 0);
    assert.equal(f.child.listenerCount("exit"), 0);
  }
});

test("POSIX initial capture detects root exit while the table is pending", async () => {
  const f = fixture((n, child) => {
    if (n === 1) {
      child.exitCode = 0;
      child.emit("exit", 0, null);
    }
    return [{ ...root, parentPid: 40004, processGroupId: 40004 }];
  });
  await f.run();
  assert.equal(f.calls.length, 0);
  assert.equal(f.child.listenerCount("exit"), 0);
});

test("POSIX initial capture rejects mismatched owner, group, or Linux session", async () => {
  for (const changed of [
    { parentPid: 40004 },
    { processGroupId: 40004 },
    { sessionId: 40004 },
    { processGroupId: 0 },
  ]) {
    const f = fixture(() => [{ ...root, ...changed }]);
    const result = await f.run();
    assert.match(result.error, /containment was not proven/u);
    assert(!f.calls.some((call) => call.signal === "SIGKILL"));
    assert(
      !f.calls.some((call) => call.pid === -40004 || Object.is(call.pid, -0)),
    );
  }
});

test("POSIX slow successful tables cannot signal after settlement", async () => {
  const f = fixture(async () => {
    await pause(700);
    return [root];
  });
  const result = await f.run();
  assert.match(result.error, /deadline expired/u);
  const callsAtSettlement = f.calls.length;
  await pause(600);
  assert.equal(f.calls.length, callsAtSettlement);
  assert(!f.calls.some((call) => call.afterCompletion));
});

test("POSIX delayed capture failure cannot signal via soft fallback", async () => {
  const f = fixture(async () => {
    await pause(1800);
    throw new Error("delayed discovery failure");
  });
  const result = await f.run();
  assert.match(result.error, /deadline expired/u);
  await pause(200);
  assert.equal(f.calls.length, 0);
});

test("POSIX verifier checks its own deadline after capture even before outer settlement", async () => {
  const f = fixture(async (n) => {
    if (n === 2) await pause(950);
    return [root];
  });
  const result = await f.run();
  assert.match(result.error, /scope expired/u);
  assert(!f.calls.some((call) => call.signal === "SIGKILL"));
});

// Drive the VM's wall clock and timers separately: a timer callback can reach
// the preflight guard just before Date.now crosses the absolute deadline.
function deadlineClock() {
  let now = 0;
  let nextId = 0;
  let reads = [];
  const timers = new Map();
  const scheduled = [];
  return {
    scheduled,
    timers,
    now: () => {
      if (reads.length) now = reads.shift();
      return now;
    },
    setTimeout: (callback, milliseconds) => {
      const timer = { callback, milliseconds, due: now + milliseconds };
      const id = ++nextId;
      scheduled.push(timer);
      timers.set(id, timer);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    fire: async (expectedDelay, clockReads = []) => {
      const [id, timer] = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
      assert.equal(timer.milliseconds, expectedDelay);
      timers.delete(id);
      now = timer.due;
      reads = [...clockReads];
      timer.callback();
      // Flush all promise continuations without advancing the VM timers.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(reads.length, 0, "Expected deadline guards were reached");
    },
  };
}

// This preflight runs before the ordinary containment withDeadline call.
for (const ordering of ["preflight", "forced-entry"]) {
  test(`POSIX exited-child preflight shares the force budget (${ordering} guard)`, async () => {
    const clock = deadlineClock();
    let captures = 0;
    let releaseCapture;
    const f = fixture(
      () => {
        captures++;
        return new Promise((resolve) => {
          releaseCapture = resolve;
        });
      },
      { exitCode: 0, clock },
    );
    let settled = false;
    const running = f.run().then((result) => {
      settled = true;
      return result;
    });
    await clock.fire(1); // Program timeout; initial ownership is unavailable.
    assert.equal(captures, 0);
    assert.equal(settled, false);
    await clock.fire(250); // TERM grace ends; the single force budget begins.
    assert.equal(captures, 1);
    assert.equal(settled, false);
    // At the boundary, either the preflight guard wins, or its remaining-budget
    // read precedes the forced-entry guard observing the very same deadline.
    await clock.fire(
      1500,
      ordering === "forced-entry" ? [1750, 1750, 1751] : [],
    );
    assert.equal(settled, true, "No second force budget may be needed");
    const result = await running;
    assert.equal(result.status, "timed_out");
    const initial =
      "Program timed out after 1ms; process-tree containment was not proven: ";
    assert.equal(
      result.error,
      ordering === "preflight"
        ? initial + "bounded process-tree termination deadline expired"
        : initial +
            "process-tree snapshot unavailable: the owned root exited before its process identity was captured; containment was not proven; containment was not proven; process-tree termination scope expired; containment was not proven",
    );
    assert.deepEqual(
      clock.scheduled.map(({ due }) => due),
      ordering === "preflight" ? [1, 251, 1751] : [1, 251, 1751, 1751],
      "Preflight and containment must share one absolute force deadline",
    );
    assert.equal(clock.timers.size, 0);
    assert.equal(f.child.listenerCount("exit"), 0);
    assert.equal(f.calls.length, 0);
    releaseCapture([]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(captures, 1);
    assert.equal(
      f.calls.length,
      0,
      "Late capture must not signal after settlement",
    );
    assert.equal(clock.timers.size, 0);
  });
}

function exitRoot(child) {
  child.exitCode = 0;
  child.emit("exit", 0, null);
}
const childIdentity = { ...root, pid: 20002, parentPid: root.pid };

test("POSIX never broadcasts to a descendant's old or current group", async () => {
  const original = { ...childIdentity, processGroupId: 30003 };
  const moved = { ...original, processGroupId: 40004 };
  const f = fixture((n) =>
    n === 1 ? [root, original] : n === 2 ? [root, moved] : [],
  );
  const result = await f.run();
  assert.match(result.error, /outside the owned root group/u);
  assert(!f.calls.some((c) => c.pid === -30003 || c.pid === -40004));
  assert(
    f.calls.some((c) => c.pid === childIdentity.pid && c.signal === "SIGKILL"),
  );
});

test("POSIX cleanup of captured reparented descendants does not become unknown merely because root exits", async () => {
  const f = fixture((n, child) => {
    if (n === 1) return [root, childIdentity];
    if (n === 2) {
      exitRoot(child);
      return [{ ...childIdentity, parentPid: 1 }];
    }
    return [];
  });
  const result = await f.run();
  assert.doesNotMatch(result.error, /containment/u);
  assert(
    f.calls.some((c) => c.pid === childIdentity.pid && c.signal === "SIGKILL"),
  );
  assert(
    !f.calls.some(
      (c) => c.signal === "SIGKILL" && (c.pid === root.pid || c.pid < 0),
    ),
  );
});

test("POSIX observed root exit forbids positive and negative root signals despite equal replacement lstart", async () => {
  const f = fixture((n, child) => {
    if (n === 1) return [root, childIdentity];
    if (n === 2) {
      exitRoot(child);
      return [
        { ...root, parentPid: 40004, processGroupId: 40004 },
        childIdentity,
      ];
    }
    return [];
  });
  await f.run();
  assert(
    !f.calls.some(
      (c) => c.signal === "SIGKILL" && (c.pid === root.pid || c.pid < 0),
    ),
  );
  assert(f.calls.some((c) => c.pid === childIdentity.pid));
});

test("POSIX root exit during group dispatch prevents a subsequent root PID signal", async () => {
  const f = fixture((n) => (n <= 2 ? [root, childIdentity] : []), {
    onSignal: (pid, signal, child) => {
      if (pid === -root.pid && signal === "SIGKILL") exitRoot(child);
    },
  });
  await f.run();
  assert(f.calls.some((c) => c.pid === -root.pid && c.signal === "SIGKILL"));
  assert(!f.calls.some((c) => c.pid === root.pid));
});

test("POSIX untracked original-group members after root exit stay unknown and are never adopted", async () => {
  const stranger = { ...root, pid: 20003, parentPid: 1 };
  const f = fixture((n, child) => {
    if (n === 1) return [root, childIdentity];
    if (n === 2) {
      exitRoot(child);
      return [childIdentity, stranger];
    }
    return [];
  });
  const result = await f.run();
  assert.match(result.error, /untracked members/u);
  assert(!f.calls.some((c) => c.pid === stranger.pid));
  assert(!f.calls.some((c) => c.signal === "SIGKILL" && c.pid < 0));
});

test("POSIX a new child of an absent tracked parent does not expand positive PID targets", async () => {
  const newcomer = {
    ...childIdentity,
    pid: 20003,
    parentPid: childIdentity.pid,
    processGroupId: 30003,
  };
  const f = fixture((n) =>
    n === 1 ? [root, childIdentity] : n === 2 ? [root, newcomer] : [],
  );
  const result = await f.run();
  assert.match(result.error, /matching live parent/u);
  assert(!f.calls.some((c) => c.pid === newcomer.pid || c.pid === -30003));
});

test("POSIX late child of a matching live parent remains eligible for cleanup", async () => {
  const newcomer = {
    ...childIdentity,
    pid: 20003,
    parentPid: childIdentity.pid,
  };
  const f = fixture((n) =>
    n === 1
      ? [root, childIdentity]
      : n === 2
        ? [root, childIdentity, newcomer]
        : [],
  );
  const result = await f.run();
  assert.doesNotMatch(result.error, /containment/u);
  assert(f.calls.some((c) => c.pid === newcomer.pid && c.signal === "SIGKILL"));
});

test("POSIX missing initial ownership is not repaired by an empty later table", async () => {
  const f = fixture(() => [], { exitCode: 0 });
  const result = await f.run();
  assert.match(result.error, /containment/u);
  assert.equal(f.calls.length, 0);
});

test("POSIX failed initial discovery signals only the exact owned child, never a guessed group", async () => {
  const f = fixture(() => {
    throw new Error("discovery unavailable");
  });
  const result = await f.run();
  assert.match(result.error, /containment/u);
  assert(f.calls.some((c) => c.kind === "child" && c.signal === "SIGTERM"));
  assert(!f.calls.some((c) => c.kind === "process"));
});

test("POSIX cooperative root exit and an absent tracked tree preserve the normal result", async () => {
  const f = fixture((n) => (n === 1 ? [root, childIdentity] : []), {
    onSignal: (_pid, signal, child) => {
      if (signal === "SIGTERM") exitRoot(child);
    },
  });
  const result = await f.run();
  assert.doesNotMatch(result.error, /containment/u);
  assert(!f.calls.some((c) => c.signal === "SIGKILL"));
});

test("POSIX migration uncertainty remains after the observed descendant disappears", async () => {
  const f = fixture((n) =>
    n === 1
      ? [root, childIdentity]
      : n === 2
        ? [root, { ...childIdentity, processGroupId: 30003, sessionId: 30003 }]
        : [],
  );
  const result = await f.run();
  assert.match(result.error, /moved outside/u);
  assert(!f.calls.some((c) => c.pid === -30003));
  assert(f.calls.some((c) => c.pid === childIdentity.pid));
});

test("POSIX never admits a new child of a reused captured parent", async () => {
  const newcomer = {
    ...childIdentity,
    pid: 20003,
    parentPid: childIdentity.pid,
  };
  const f = fixture((n) =>
    n === 1
      ? [root, childIdentity]
      : [root, { ...childIdentity, startTime: "replacement" }, newcomer],
  );
  const result = await f.run();
  assert.match(result.error, /identity changed/u);
  assert(!f.calls.some((c) => c.signal === "SIGKILL"));
});

test("Darwin retains only the live bound root group without requiring a Linux SID", async () => {
  const darwinRoot = { ...root, sessionId: null };
  const f = fixture((n) => (n <= 2 ? [darwinRoot] : []), {
    platform: "darwin",
  });
  const result = await f.run();
  assert.doesNotMatch(result.error, /containment/u);
  assert(f.calls.some((c) => c.pid === -root.pid && c.signal === "SIGKILL"));
});

test("POSIX a persistent same-second root replacement cannot count as proven absence", async () => {
  const f = fixture((n, child) => {
    if (n === 2) exitRoot(child);
    return [root];
  });
  const result = await f.run();
  assert.match(result.error, /containment/u);
  assert(!f.calls.some((c) => c.signal === "SIGKILL"));
});

test("POSIX a stale root row crossing exit can disappear without a false containment failure", async () => {
  const f = fixture((n, child) => {
    if (n === 2) exitRoot(child);
    return n <= 2 ? [root] : [];
  });
  const result = await f.run();
  assert.doesNotMatch(result.error, /containment/u);
  assert(!f.calls.some((c) => c.signal === "SIGKILL"));
});
