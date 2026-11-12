import assert from "node:assert/strict";
import test from "node:test";
import {
  waitForWindowsShellReadiness,
  WINDOWS_SHELL_CONTROL_MS,
  WINDOWS_SHELL_READINESS_MS,
} from "./fixtures/windows-shell-readiness.js";

function clock(initial = 0) {
  let value = initial;
  return {
    now: () => value,
    sleep: async (ms: number) => {
      value += ms;
    },
    advance: (ms: number) => {
      value += ms;
    },
  };
}
const prompt = "\x1b[?9001h\x1b[?1004hPS C:\\fixture> ";
const session = { taskId: "original" };
const create = async () => session;
const observation = (
  output: string,
  inputAvailable = true,
  status = "running",
) => ({ inputAvailable, status, output });

test("the observed seventeen-second cold startup retains its original session", async () => {
  const time = clock();
  let creates = 0;
  const result = await waitForWindowsShellReadiness(
    async () => {
      creates++;
      time.advance(171);
      return session;
    },
    async (original) => {
      assert.equal(original, session);
      return observation(
        time.now() >= 17033 ? prompt : "\x1b[?9001h\x1b[?1004h",
      );
    },
    time,
  );
  assert.equal(result.session, session);
  assert.equal(result.elapsedMs, 17041);
  assert.equal(creates, 1);
  assert.equal(WINDOWS_SHELL_CONTROL_MS, 5000);
  assert.equal(WINDOWS_SHELL_READINESS_MS, 20000);
});

test("a control handle or console output alone never establishes readiness", async () => {
  for (const output of ["", "\x1b[?9001h\x1b[?1004h"]) {
    const time = clock();
    await assert.rejects(
      waitForWindowsShellReadiness(
        create,
        async () => observation(output),
        time,
      ),
      /"phase":"PowerShell prompt".*"elapsedMs":20000/,
    );
    assert.equal(time.now(), 20000);
  }
});

test("a prompt cannot extend the deadline when input control never registers", async () => {
  const time = clock();
  await assert.rejects(
    waitForWindowsShellReadiness(
      create,
      async () => observation(prompt, false),
      time,
    ),
    /"phase":"creation\/control".*"elapsedMs":5000/,
  );
  assert.equal(time.now(), 5000);
});

test("late creation and late control registration fail within the creation phase", async () => {
  for (const lateCreate of [true, false]) {
    const time = clock();
    await assert.rejects(
      waitForWindowsShellReadiness(
        async () => {
          if (lateCreate) time.advance(5000);
          return session;
        },
        async () => {
          assert.equal(lateCreate, false, "late creation must not be read");
          time.advance(5000);
          return observation(prompt);
        },
        time,
      ),
      /"phase":"creation\/control".*"elapsedMs":5000/,
    );
  }
});

test("the prompt deadline includes creation and never resets with output", async () => {
  const time = clock();
  await assert.rejects(
    waitForWindowsShellReadiness(
      async () => {
        time.advance(4000);
        return session;
      },
      async () => observation(`progress ${time.now()}`),
      time,
    ),
    /"phase":"PowerShell prompt".*"elapsedMs":20000/,
  );
  assert.equal(time.now(), 20000);
});

test("a prompt read completing at the absolute deadline remains a failure", async () => {
  const time = clock();
  let reads = 0;
  await assert.rejects(
    waitForWindowsShellReadiness(
      create,
      async () => {
        if (++reads === 1) return observation("");
        time.advance(20000 - time.now());
        return observation(prompt);
      },
      time,
    ),
    /"phase":"PowerShell prompt".*"elapsedMs":20000/,
  );
  assert.equal(reads, 2);
});

test("exit or cancellation before readiness fails immediately, even with retained prompt bytes", async () => {
  for (const status of [
    "completed",
    "failed",
    "timed_out",
    "cancel_requested",
    "cancellation_unconfirmed",
    "cancelled",
  ]) {
    const time = clock();
    await assert.rejects(
      waitForWindowsShellReadiness(
        create,
        async () => observation(prompt, true, status),
        time,
      ),
      /Windows Shell stopped before readiness/,
    );
    assert.equal(time.now(), 0);
  }
});

test("creation and read errors propagate unchanged without retry", async () => {
  for (const stage of ["create", "read"]) {
    const failure = new Error(stage);
    let creates = 0,
      reads = 0;
    await assert.rejects(
      waitForWindowsShellReadiness(
        async () => {
          creates++;
          if (stage === "create") throw failure;
          return session;
        },
        async () => {
          reads++;
          throw failure;
        },
      ),
      (error) => error === failure,
    );
    assert.equal(creates, 1);
    assert.equal(reads, stage === "create" ? 0 : 1);
  }
});

test("a pending creation has a hard bound and a late rejection remains observed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let rejectCreate!: (error: Error) => void;
  const pending = new Promise<typeof session>((_, reject) => {
    rejectCreate = reject;
  });
  let reads = 0;
  const rejected = assert.rejects(
    waitForWindowsShellReadiness(
      () => pending,
      async () => {
        reads++;
        return observation(prompt);
      },
      { now: Date.now },
    ),
    /"phase":"creation\/control".*"elapsedMs":5000/,
  );
  t.mock.timers.tick(5000);
  await rejected;
  rejectCreate(new Error("late creation failure"));
  await Promise.resolve();
  assert.equal(reads, 0);
});

test("a pending prompt read is bounded and late success cannot become readiness", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let resolveRead!: (value: ReturnType<typeof observation>) => void;
  const pending = new Promise<ReturnType<typeof observation>>((resolve) => {
    resolveRead = resolve;
  });
  let signalRead!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    signalRead = resolve;
  });
  let reads = 0;
  const rejected = assert.rejects(
    waitForWindowsShellReadiness(
      create,
      async () => {
        if (++reads === 1) return observation("");
        signalRead();
        return pending;
      },
      { now: Date.now, sleep: async () => {} },
    ),
    /"phase":"PowerShell prompt".*"elapsedMs":20000/,
  );
  await readStarted;
  t.mock.timers.tick(20000);
  await rejected;
  resolveRead(observation(prompt));
  await Promise.resolve();
  assert.equal(reads, 2);
});
