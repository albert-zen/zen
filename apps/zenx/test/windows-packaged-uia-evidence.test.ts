import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWindowsPackagedUiaFocusEvidence,
  type WindowsPackagedUiaFocusEvidence,
} from "../src/main/windows-packaged-uia-evidence.js";

const expected = { targetPid: 101, guardPid: 202, guardHwnd: "700" };
function evidence(): WindowsPackagedUiaFocusEvidence {
  return {
    guardPid: 202,
    targetPid: 101,
    hookInstalled: true,
    samples: 80,
    eventCount: 0,
    focusChanges: 0,
    pointerChanges: 0,
    overflow: false,
    elapsedMs: 500,
    foregroundTransitions: [
      { source: "initial", elapsedMs: 0, hwnd: "700", pid: 202, kind: "guard" },
    ],
  };
}

test("accepts complete independent-process native focus evidence", () => {
  assertWindowsPackagedUiaFocusEvidence(evidence(), expected);
});

test("rejects same-process guard, unavailable hook, empty sampling and truncated events", () => {
  for (const patch of [
    { targetPid: 202 },
    { hookInstalled: false },
    { samples: 0 },
    { overflow: true },
    { foregroundTransitions: [] },
    { eventCount: 1 },
  ]) {
    assert.throws(() =>
      assertWindowsPackagedUiaFocusEvidence(
        { ...evidence(), ...patch },
        expected,
      ),
    );
  }
});

test("rejects transient target activation even if sampling and final foreground look unchanged", () => {
  const report = evidence();
  report.eventCount = 2;
  report.foregroundTransitions.push(
    {
      source: "EVENT_SYSTEM_FOREGROUND",
      elapsedMs: 2,
      hwnd: "800",
      pid: 101,
      kind: "target",
    },
    {
      source: "EVENT_SYSTEM_FOREGROUND",
      elapsedMs: 3,
      hwnd: "700",
      pid: 202,
      kind: "guard",
    },
  );
  assert.throws(() => assertWindowsPackagedUiaFocusEvidence(report, expected));
});

test("rejects unrelated activation, pointer movement, and contradictory guard identities", () => {
  for (const mutate of [
    (report: WindowsPackagedUiaFocusEvidence) => {
      report.focusChanges = 1;
    },
    (report: WindowsPackagedUiaFocusEvidence) => {
      report.pointerChanges = 1;
    },
    (report: WindowsPackagedUiaFocusEvidence) => {
      report.foregroundTransitions[0]!.pid = 303;
    },
    (report: WindowsPackagedUiaFocusEvidence) => {
      report.foregroundTransitions[0]!.hwnd = "999";
    },
    (report: WindowsPackagedUiaFocusEvidence) => {
      report.foregroundTransitions[0]!.kind = "other";
    },
  ]) {
    const report = evidence();
    mutate(report);
    assert.throws(() =>
      assertWindowsPackagedUiaFocusEvidence(report, expected),
    );
  }
});
