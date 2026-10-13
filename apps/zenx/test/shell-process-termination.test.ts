import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import test from "node:test";
import {
  createWindowsShellTerminator,
  WINDOWS_SHELL_SHUTDOWN_WAIT_MS,
} from "../src/main/shell-process-termination.js";
import type {
  WindowsProcessIdentity,
  WindowsProcessOperations,
} from "../src/main/trigger-program-runner.js";
import {
  ShellToolRuntime,
  ToolEnvironment,
  type ToolInvocation,
} from "../../../src/tool.js";

function identity(
  pid: number,
  parentPid: number,
  startTime: string | null,
): WindowsProcessIdentity {
  return { pid, parentPid, startTime, processGroupId: null, sessionId: null };
}

const root = identity(101, process.pid, "100");
const server = identity(102, root.pid, "110");

function fixture(initial: WindowsProcessIdentity[] = [root, server]) {
  // No OS processes are spawned. The adapter receives a synthetic owned handle.
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: root.pid });
  let entries = structuredClone(initial);
  let captures = 0;
  const killed: WindowsProcessIdentity[] = [];
  const operations: WindowsProcessOperations = {
    captureProcessTable: async () => {
      captures += 1;
      return { entries: structuredClone(entries) };
    },
    terminateProcessIdentity: async (expected) => {
      killed.push({ ...expected });
      entries = entries.filter(
        (entry) =>
          entry.pid !== expected.pid || entry.startTime !== expected.startTime,
      );
      return { ok: true, error: "" };
    },
  };
  return {
    child,
    killed,
    operations,
    setEntries(value: WindowsProcessIdentity[]) {
      entries = structuredClone(value);
    },
    entries: () => structuredClone(entries),
    captures: () => captures,
    track: () => createWindowsShellTerminator(operations)(child),
  };
}

test("Windows Shell starts ownership capture at launch and stops captured server descendants first", async () => {
  const grandchild = identity(103, server.pid, "120");
  const f = fixture([root, server, grandchild]);
  const controller = f.track();
  assert.equal(f.captures(), 1);
  const result = await controller.terminate();
  assert.deepEqual(result, { ok: true, error: "" });
  assert.deepEqual(
    f.killed.map((entry) => entry.pid),
    [103, 102, 101],
  );
  assert.equal(f.captures(), 6); // launch, three pre-kill, two independent absent
  assert.deepEqual(f.entries(), []);
});

test("Windows Shell reuses one cancellation operation for concurrent and repeated Stop", async () => {
  const f = fixture();
  const controller = f.track();
  const first = controller.terminate();
  assert.equal(controller.terminate(), first);
  assert.equal((await first).ok, true);
  assert.equal(controller.terminate(), first);
  assert.equal(f.killed.length, 2);
});

for (const kind of ["absent", "unknown", "wrong-parent"] as const) {
  test(`Windows Shell fails closed on ${kind} initial root identity`, async () => {
    const f = fixture(
      kind === "absent"
        ? []
        : [
            {
              ...root,
              ...(kind === "unknown"
                ? { startTime: null }
                : { parentPid: process.pid + 1 }),
            },
          ],
    );
    const result = await f.track().terminate();
    assert.equal(result.ok, false);
    assert.match(result.error, /foreground/u);
    assert.deepEqual(f.killed, []);
  });
}

test("Windows Shell does not capture an already exited foreground by its stale PID", async () => {
  const f = fixture();
  Object.defineProperty(f.child, "exitCode", { value: 0 });
  const result = await f.track().terminate();
  assert.equal(result.ok, false);
  assert.equal(f.captures(), 0);
  assert.deepEqual(f.killed, []);
});

test("Windows Shell rejects root exit while launch identity capture is pending", async () => {
  const f = fixture();
  const controller = f.track();
  Object.defineProperty(f.child, "signalCode", { value: "SIGTERM" });
  f.child.emit("exit", null, "SIGTERM");
  const result = await controller.terminate();
  assert.equal(result.ok, false);
  assert.match(result.error, /exited during identity capture/u);
  assert.deepEqual(f.killed, []);
});

test("Windows Shell never kills a reused root generation", async () => {
  const f = fixture([root]);
  const controller = f.track();
  await Promise.resolve();
  f.setEntries([{ ...root, startTime: "200" }]);
  const result = await controller.terminate();
  assert.equal(result.ok, false);
  assert.match(result.error, /changed or unknown identity/u);
  assert.deepEqual(f.killed, []);
});

test("Windows Shell can stop an already captured child after its foreground exits", async () => {
  const f = fixture();
  const controller = f.track();
  await Promise.resolve();
  Object.defineProperty(f.child, "exitCode", { value: 0 });
  f.setEntries([server]);
  assert.equal((await controller.terminate()).ok, true);
  assert.deepEqual(
    f.killed.map((entry) => entry.pid),
    [server.pid],
  );
});

for (const kind of ["absent", "reused"] as const) {
  test(`Windows Shell does not adopt newly observed children under ${kind} known parents`, async () => {
    const f = fixture();
    const controller = f.track();
    await Promise.resolve();
    f.setEntries([
      root,
      ...(kind === "reused" ? [{ ...server, startTime: "200" }] : []),
      identity(103, server.pid, "250"),
    ]);
    const result = await controller.terminate();
    assert.equal(result.ok, false);
    assert.match(
      result.error,
      /ambiguous ancestry|changed or unknown identity/u,
    );
    assert.deepEqual(f.killed, []);
  });
}

test("Windows Shell excludes an older unrelated child with a recycled parent PID", async () => {
  const older = identity(103, root.pid, "50");
  const f = fixture([root, older]);
  const result = await f.track().terminate();
  assert.equal(result.ok, true);
  assert.deepEqual(
    f.killed.map((entry) => entry.pid),
    [root.pid],
  );
  assert.deepEqual(f.entries(), [older]);
});

test("Windows Shell fails closed for an unknown descendant identity", async () => {
  const f = fixture([root, { ...server, startTime: null }]);
  const result = await f.track().terminate();
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown creation time/u);
  assert.deepEqual(f.killed, []);
});

test("Windows Shell reports denied termination instead of confirmed Stop", async () => {
  const f = fixture();
  f.operations.terminateProcessIdentity = async () => ({
    ok: false,
    error: "access denied",
  });
  const result = await f.track().terminate();
  assert.equal(result.ok, false);
  assert.match(result.error, /access denied/u);
});

test("Windows Shell refreshes ancestry to capture a child born before the parent kill", async () => {
  const f = fixture();
  const terminate = f.operations.terminateProcessIdentity;
  const lateChild = identity(103, root.pid, "120");
  f.operations.terminateProcessIdentity = async (expected) => {
    const result = await terminate(expected);
    if (expected.pid === server.pid) f.setEntries([root, lateChild]);
    return result;
  };
  const result = await f.track().terminate();
  assert.equal(result.ok, true);
  assert.deepEqual(
    f.killed.map((entry) => entry.pid),
    [server.pid, lateChild.pid, root.pid],
  );
});

test("Windows Shell reports a snapshot-boundary child after parent exit without killing it", async () => {
  const f = fixture([root]);
  const terminate = f.operations.terminateProcessIdentity;
  const ambiguousChild = identity(103, root.pid, "120");
  f.operations.terminateProcessIdentity = async (expected) => {
    const result = await terminate(expected);
    f.setEntries([ambiguousChild]);
    return result;
  };
  const result = await f.track().terminate();
  assert.equal(result.ok, false);
  assert.match(result.error, /ambiguous ancestry/u);
  assert.deepEqual(
    f.killed.map((entry) => entry.pid),
    [root.pid],
  );
  assert.deepEqual(f.entries(), [ambiguousChild]);
});

test("Windows Shell bounds unsuccessful termination passes and operation count", async () => {
  const f = fixture([root]);
  f.operations.terminateProcessIdentity = async (expected) => {
    f.killed.push({ ...expected });
    return { ok: true, error: "" };
  };
  const result = await f.track().terminate();
  assert.equal(result.ok, false);
  assert.match(result.error, /bounded/u);
  assert(f.captures() <= 33);
  assert(f.killed.length <= 32);
});

test("Windows Shell bounds captured tree size without killing unverified processes", async () => {
  const f = fixture([
    root,
    ...Array.from({ length: 128 }, (_, index) =>
      identity(200 + index, root.pid, "120"),
    ),
  ]);
  const result = await f.track().terminate();
  assert.equal(result.ok, false);
  assert.match(result.error, /tracked-process limit/u);
  assert.deepEqual(f.killed, []);
});

test("Windows Shell reports failed launch discovery without an unhandled rejection", async () => {
  const f = fixture();
  f.operations.captureProcessTable = async () => {
    throw new Error("WMI unavailable");
  };
  const controller = f.track();
  await Promise.resolve();
  const result = await controller.terminate();
  assert.equal(result.ok, false);
  assert.match(result.error, /WMI unavailable/u);
  assert.deepEqual(f.killed, []);
});

test("Windows Shell's overall Stop budget includes pending launch ownership", async () => {
  const f = fixture([root]);
  let now = 0;
  let captures = 0;
  let release!: () => void;
  f.operations.captureProcessTable = async () => {
    captures += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { entries: [root] };
  };
  const controller = createWindowsShellTerminator(f.operations, {
    now: () => now,
  })(f.child);
  const stopped = controller.terminate();
  now = 30_001;
  release();
  const result = await stopped;
  assert.equal(result.ok, false);
  assert.match(result.error, /budget was exhausted/u);
  assert.equal(captures, 1);
  assert.deepEqual(f.killed, []);
});

test("Windows Shell dispatches no kill or later capture after an in-flight observation consumes the Stop budget", async () => {
  const f = fixture([root]);
  let now = 0;
  let captures = 0;
  f.operations.captureProcessTable = async () => {
    captures += 1;
    if (captures === 2) now = 30_001;
    return { entries: [root] };
  };
  const controller = createWindowsShellTerminator(f.operations, {
    now: () => now,
  })(f.child);
  const result = await controller.terminate();
  assert.equal(result.ok, false);
  assert.match(result.error, /budget expired/u);
  assert.equal(captures, 2);
  assert.deepEqual(f.killed, []);
});

test("Windows Shell exposes its actual pending launch observer for normal-completion ownership", async () => {
  const f = fixture([root]);
  let release!: () => void;
  f.operations.captureProcessTable = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { entries: [root] };
  };
  const controller = f.track();
  let ready = false;
  void controller.ready.then(() => {
    ready = true;
  });
  await Promise.resolve();
  assert.equal(ready, false);
  release();
  await controller.ready;
  assert.equal(ready, true);
  assert.deepEqual(f.killed, []);
});

test("Windows Shell retains a never-settling launch helper instead of claiming deadline cleanup", async () => {
  const f = fixture([root]);
  let now = 0;
  let captures = 0;
  f.operations.captureProcessTable = () => {
    captures += 1;
    return new Promise(() => undefined);
  };
  const controller = createWindowsShellTerminator(f.operations, {
    now: () => now,
  })(f.child);
  let ready = false;
  let stopped = false;
  void controller.ready.then(() => {
    ready = true;
  });
  void controller.terminate().then(() => {
    stopped = true;
  });
  now = WINDOWS_SHELL_SHUTDOWN_WAIT_MS + 1;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ready, false);
  assert.equal(stopped, false);
  assert.equal(captures, 1);
  assert.deepEqual(f.killed, []);
});

test("Windows Shell retains an in-flight kill across the caller deadline and dispatches nothing else", async () => {
  const f = fixture([root]);
  let now = 0;
  let started!: () => void;
  const killStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.operations.terminateProcessIdentity = (expected) => {
    f.killed.push({ ...expected });
    started();
    return new Promise(() => undefined);
  };
  const controller = createWindowsShellTerminator(f.operations, {
    now: () => now,
  })(f.child);
  let stopped = false;
  void controller.terminate().then(() => {
    stopped = true;
  });
  await killStarted;
  now = WINDOWS_SHELL_SHUTDOWN_WAIT_MS + 1;
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(f.captures(), 2);
  assert.equal(f.killed.length, 1);
});

function shellInvocation(
  command: string,
  waitForCompletion = false,
): ToolInvocation {
  return {
    callId: "owned-shell-cleanup",
    name: "shell",
    arguments: { command },
    cwd: process.cwd(),
    threadId: "owned-shell-cleanup",
    signal: new AbortController().signal,
    ...(waitForCompletion ? { task: { waitForCompletion: true } } : {}),
  };
}

function ownedShellFixture(
  onCapture: (capture: number) => Promise<void>,
  ownedCleanupWaitMs: number,
) {
  let child: ChildProcess | undefined;
  let captures = 0;
  let kills = 0;
  let observedClose = false;
  let close!: () => void;
  const childClosed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const operations: WindowsProcessOperations = {
    async captureProcessTable() {
      captures += 1;
      await onCapture(captures);
      assert(child?.pid !== undefined);
      return {
        entries:
          child.exitCode === null && child.signalCode === null
            ? [identity(child.pid, process.pid, "100")]
            : [],
      };
    },
    async terminateProcessIdentity(expected) {
      assert(child?.pid !== undefined);
      assert.equal(expected.pid, child.pid);
      kills += 1;
      child.kill("SIGKILL"); // The exact owned ChildProcess handle, never PID lookup.
      await childClosed;
      return { ok: true, error: "" };
    },
  };
  const track = createWindowsShellTerminator(operations);
  const tools = new ToolEnvironment({
    runtimes: [
      new ShellToolRuntime({
        ownedCleanupWaitMs,
        trackProcess(owned) {
          child = owned;
          child.once("close", () => {
            observedClose = true;
            close();
          });
          return track(child);
        },
      }),
    ],
    taskOptions: { yieldTimeMs: 1, shutdownWaitMs: 500 },
  });
  return {
    tools,
    childClosed,
    captures: () => captures,
    kills: () => kills,
    async cleanup() {
      if (child !== undefined && !observedClose) {
        child.kill("SIGKILL");
        await childClosed;
      }
      await tools.close().catch(() => undefined);
    },
  };
}

// A bounded test owns the shell itself; there are no descendants or real services.
const waitingShellCommand =
  process.platform === "win32"
    ? "for /L %i in (1,0,2) do @rem"
    : "while :; do :; done";

test("Shell environment close joins gated ownership cleanup beyond the old 500ms grace", async () => {
  let release!: () => void;
  let captured!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const secondCapture = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const f = ownedShellFixture(async (capture) => {
    if (capture === 2) {
      captured();
      await gate;
    }
  }, 2_000);
  try {
    await f.tools.execute(
      f.tools.prepare(shellInvocation(waitingShellCommand)),
    );
    const closing = f.tools.close();
    let settled = false;
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await secondCapture;
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(settled, false);
    assert.equal(f.tools.taskManager.activeTaskCount, 1);
    assert.equal(f.kills(), 0);
    release();
    await closing;
    assert.equal(f.kills(), 1);
    assert.equal(f.tools.taskManager.activeTaskCount, 0);
    await f.childClosed;
  } finally {
    release();
    await f.cleanup();
  }
});

test("Fast Shell completion remains owned until its initial observer settles", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = ownedShellFixture(async (capture) => {
    if (capture === 1) await gate;
  }, 2_000);
  try {
    let settled = false;
    const result = f.tools.execute(
      f.tools.prepare(shellInvocation("exit 0", true)),
    );
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await f.childClosed;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(settled, false);
    assert.equal(f.tools.taskManager.activeTaskCount, 1);
    assert.equal(f.captures(), 1);
    release();
    assert.equal((await result).exitCode, 0);
    assert.equal(f.tools.taskManager.activeTaskCount, 0);
    const started = performance.now();
    await f.tools.close();
    assert(
      performance.now() - started < 500,
      "normal completed-task close should not spend cleanup grace",
    );
    assert.equal(f.captures(), 1);
    assert.equal(f.kills(), 0);
  } finally {
    release();
    await f.cleanup();
  }
});

test("Shell environment close reports a never-settling cleanup at its configured deadline", async () => {
  const f = ownedShellFixture(async (capture) => {
    if (capture === 2) await new Promise(() => undefined);
  }, 50);
  try {
    await f.tools.execute(
      f.tools.prepare(shellInvocation(waitingShellCommand)),
    );
    const started = performance.now();
    await assert.rejects(f.tools.close(), /Host tool cleanup is unconfirmed/u);
    assert(
      performance.now() - started >= 40,
      "close must give cleanup the configured opportunity to settle",
    );
    assert.equal(f.kills(), 0);
    assert.equal(f.captures(), 2);
  } finally {
    await f.cleanup();
  }
});
