import assert from "node:assert/strict";
import test from "node:test";
import {
  waitForWindowsShellReadiness,
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

test("cold startup may cross the action budget but must reach a real prompt", async () => {
  const time = clock();
  const elapsed = await waitForWindowsShellReadiness(
    async () => ({
      inputAvailable: true,
      status: "running",
      output: time.now() >= 6030 ? prompt : "\x1b[?9001h\x1b[?1004h",
    }),
    0,
    time,
  );
  assert.equal(elapsed, 6030);
  assert.equal(WINDOWS_SHELL_READINESS_MS, 10000);
});

test("a control handle or prompt alone cannot establish interactive readiness", async () => {
  for (const observation of [
    {
      inputAvailable: true,
      status: "running",
      output: "\x1b[?9001h\x1b[?1004h",
    },
    { inputAvailable: false, status: "running", output: prompt },
  ]) {
    const time = clock();
    await assert.rejects(
      waitForWindowsShellReadiness(async () => observation, 0, time),
      /Timed out waiting for Windows Shell readiness/,
    );
    assert.equal(time.now(), 10000);
  }
});

test("startup includes elapsed creation time and cannot accept a late read", async () => {
  const time = clock(9900);
  let reads = 0;
  await assert.rejects(
    waitForWindowsShellReadiness(
      async () => {
        reads++;
        time.advance(101);
        return { inputAvailable: true, status: "running", output: prompt };
      },
      0,
      time,
    ),
    /"elapsedMs":10001/,
  );
  assert.equal(reads, 1);
  await assert.rejects(
    waitForWindowsShellReadiness(
      async () => {
        throw new Error("expired startup must not read");
      },
      0,
      time,
    ),
    /Timed out waiting for Windows Shell readiness/,
  );
});
