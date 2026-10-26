import assert from "node:assert/strict";
import childProcess, {
  ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import {
  ZenXTriggerProgramRunner,
  type WindowsProcessIdentity,
  type WindowsProcessTableSnapshot,
} from "../src/main/trigger-program-runner.js";

// Each test runs the production runner with synthetic Windows observations and
// a fake owned ChildProcess. No real PID is reused or terminated by this suite.
function fixture(t: TestContext) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  const child = Object.assign(new ChildProcess(), {
    pid: 101,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as ChildProcessWithoutNullStreams;
  const root: WindowsProcessIdentity = {
    pid: child.pid!,
    parentPid: process.pid,
    startTime: "100",
    processGroupId: null,
    sessionId: null,
  };
  const kills: WindowsProcessIdentity[] = [];
  const exit = (signal: NodeJS.Signals | null = null, close = false): void => {
    Object.assign(child, {
      exitCode: signal === null ? 0 : null,
      signalCode: signal,
    });
    child.emit("exit", child.exitCode, child.signalCode);
    if (close) child.emit("close", child.exitCode, child.signalCode);
  };
  t.mock.method(childProcess, "spawn", () => child);
  t.mock.method(child, "kill", () => {
    if (child.exitCode === null && child.signalCode === null) exit(null, true);
    return true;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  });
  const run = (
    capture: () => Promise<WindowsProcessTableSnapshot>,
    beforeAbort?: () => void,
  ) => {
    const runner = new ZenXTriggerProgramRunner({
      captureProcessTable: capture,
      terminateProcessIdentity: async (identity) => {
        kills.push(identity);
        return { ok: true, error: "" };
      },
    });
    const abort = new AbortController();
    const result = runner.run(
      { command: "synthetic-windows-trigger", timeoutMs: 5_000 },
      { invocationId: "ownership-fixture", stage: "action", event: {} },
      abort.signal,
    );
    beforeAbort?.();
    abort.abort(new Error("fixture cancellation"));
    return result;
  };
  return { child, root, kills, exit, run };
}

for (const signal of [null, "SIGTERM"] as const) {
  for (const timing of ["before", "during"] as const) {
    test(`Windows runner rejects a replacement root when the owned child exits ${timing} capture (${signal ?? "code"}), with stdio still open`, async (t) => {
      const f = fixture(t);
      const replacement = { ...f.root, startTime: "400" };
      const actual = await f.run(
        async () => {
          await Promise.resolve();
          if (timing === "during") f.exit(signal);
          return { entries: [replacement] };
        },
        timing === "before" ? () => f.exit(signal) : undefined,
      );
      assert.equal(f.kills.length, 0);
      assert.equal(actual.status, "cancelled");
      assert.match(
        actual.error ?? "",
        /owned root exited.*containment was not proven/u,
      );
      assert.deepEqual(f.kills, []);
    });
  }
}

test("Windows runner retains root-exit ambiguity after close and later empty snapshots", async (t) => {
  const f = fixture(t);
  let captures = 0;
  const actual = await f.run(async () => {
    captures += 1;
    if (captures === 1) {
      await Promise.resolve();
      f.exit(null, true);
      return { entries: [{ ...f.root, startTime: "400" }] };
    }
    return { entries: [] };
  });
  assert.equal(actual.status, "cancelled");
  assert.match(
    actual.error ?? "",
    /owned root exited.*containment was not proven/u,
  );
  assert.deepEqual(f.kills, []);
});

test("Windows runner rejects a root whose parent relationship does not match its owned child", async (t) => {
  const f = fixture(t);
  const actual = await f.run(async () => ({
    entries: [{ ...f.root, parentPid: process.pid + 1 }],
  }));
  assert.equal(actual.status, "cancelled");
  assert.match(
    actual.error ?? "",
    /parent relationship.*containment was not proven/u,
  );
  assert.deepEqual(f.kills, []);
});

for (const nested of [false, true]) {
  test(`Windows runner rejects an old orphan during initial ${nested ? "nested" : "root"} capture`, async (t) => {
    const f = fixture(t);
    const parent = {
      ...f.root,
      pid: 202,
      parentPid: f.root.pid,
      startTime: "400",
    };
    const orphan = {
      ...f.root,
      pid: 303,
      parentPid: nested ? parent.pid : f.root.pid,
      startTime: nested ? "250" : "50",
    };
    const actual = await f.run(async () => ({
      entries: [f.root, ...(nested ? [parent] : []), orphan],
    }));
    assert.equal(actual.status, "cancelled");
    assert.match(
      actual.error ?? "",
      /predates parent.*containment was not proven/u,
    );
    assert.deepEqual(f.kills, []);
  });
}

for (const tickDifference of [-10n, 0n, 10n]) {
  test(`Windows runner preserves creation-tick order at a ${String(tickDifference)} tick difference beyond Number precision`, async (t) => {
    const f = fixture(t);
    f.root.startTime = "639286200000000000";
    const descendant = {
      ...f.root,
      pid: 303,
      parentPid: f.root.pid,
      startTime: String(BigInt(f.root.startTime) + tickDifference),
    };
    // CIM has microsecond (10-tick) precision. At contemporary .NET dates,
    // Number conversion would erase this difference; decimal strings do not.
    assert.equal(Number(descendant.startTime), Number(f.root.startTime));
    let captures = 0;
    const actual = await f.run(async () => {
      captures += 1;
      return {
        entries:
          captures === 1
            ? [descendant, f.root]
            : captures === 2
              ? [descendant]
              : [],
      };
    });
    assert.equal(actual.status, "cancelled");
    if (tickDifference < 0n) {
      // A real child born after a backward wall-clock adjustment and an old
      // orphan with this recycled PPID have identical snapshot evidence.
      // Neither can be silently discarded or adopted as a verified child.
      assert.match(
        actual.error ?? "",
        /PID 303 predates parent PID 101 \(creation ticks 639286199999999990 < 639286200000000000\); containment was not proven/u,
      );
      assert.deepEqual(f.kills, []);
    } else {
      assert.equal(actual.error, "fixture cancellation");
      assert.deepEqual(f.kills, [descendant]);
    }
  });
}

test("Windows runner rejects newly observed descendants after the root exits", async (t) => {
  const f = fixture(t);
  let captures = 0;
  const actual = await f.run(async () => {
    captures += 1;
    return {
      entries:
        captures === 1
          ? [f.root]
          : [{ ...f.root, pid: 303, parentPid: f.root.pid, startTime: "250" }],
    };
  });
  assert.equal(actual.status, "cancelled");
  assert.match(
    actual.error ?? "",
    /parent.*identity.*containment was not proven/u,
  );
  assert.deepEqual(f.kills, []);
});

test("Windows runner still terminates a descendant captured before its root exits", async (t) => {
  const f = fixture(t);
  const descendant = {
    ...f.root,
    pid: 303,
    parentPid: f.root.pid,
    startTime: "200",
  };
  let captures = 0;
  const actual = await f.run(async () => {
    captures += 1;
    return {
      entries:
        captures === 1
          ? [descendant, f.root]
          : captures === 2
            ? [descendant]
            : [],
    };
  });
  assert.equal(actual.status, "cancelled");
  assert.equal(actual.error, "fixture cancellation");
  assert.deepEqual(f.kills, [descendant]);
});
