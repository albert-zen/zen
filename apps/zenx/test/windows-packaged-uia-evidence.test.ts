import assert from "node:assert/strict";
import test from "node:test";
import { WINDOWS_PACKAGED_UIA_FIXTURE } from "../src/main/windows-packaged-uia-fixture.js";
import * as fixtureEvidence from "../src/main/windows-packaged-uia-evidence.js";

import {
  assertWindowsPackagedUiaFocusEvidence,
  windowsUiaTargetDiagnostics,
  type WindowsPackagedUiaFocusEvidence,
} from "../src/main/windows-packaged-uia-evidence.js";

test("failure diagnostics retain only bounded fixed numeric fields, never raw fixture text", () => {
  const snapshot = {
    elapsedMs: 1000,
    ticks: 60,
    lastTickMs: 999,
    getObjectEntered: 1,
    getObjectExited: 0,
    lastEnterMs: 990,
    lastExitMs: -1,
    objectKind: -25,
    privateText: "must never leave the private fixture stderr",
  };
  const line = (value: unknown) =>
    `ZENX_UIA_TARGET_DIAGNOSTIC ${JSON.stringify(value)}\n`;
  const [result] = windowsUiaTargetDiagnostics(
    "private exception text\n" + line(snapshot),
  );
  assert.ok(result);
  assert.equal(result.objectKind, -25);
  assert.equal("privateText" in result, false);
  assert.deepEqual(
    windowsUiaTargetDiagnostics(line({ ...snapshot, objectKind: 1234 })),
    [],
  );
  assert.deepEqual(
    windowsUiaTargetDiagnostics(line({ ...snapshot, ticks: -1 })),
    [],
  );
  assert.deepEqual(
    windowsUiaTargetDiagnostics(line({ ...snapshot, elapsedMs: "secret" })),
    [],
  );
  assert.deepEqual(
    windowsUiaTargetDiagnostics(line({ ...snapshot, lastExitMs: null })),
    [],
  );
  assert.deepEqual(
    windowsUiaTargetDiagnostics("ZENX_UIA_TARGET_DIAGNOSTIC {partial"),
    [],
  );
  assert.equal(
    windowsUiaTargetDiagnostics(line(snapshot).repeat(1000)).length,
    24,
  );
});

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

test("native target effect observer reads actual multiline text on its UI timer", () => {
  const target = WINDOWS_PACKAGED_UIA_FIXTURE.slice(
    WINDOWS_PACKAGED_UIA_FIXTURE.indexOf("static void Target("),
    WINDOWS_PACKAGED_UIA_FIXTURE.indexOf("[StructLayout"),
  );
  assert.match(WINDOWS_PACKAGED_UIA_FIXTURE, /editor\.Multiline = true;/u);
  assert.match(target, /string observedEditorValue = null;/u);
  assert.match(
    target,
    /timer\.Tick \+= delegate \{\s*string currentEditorValue = editor\.Text;/u,
  );
  assert.match(
    target,
    /!string\.Equals\(observedEditorValue, currentEditorValue, StringComparison\.Ordinal\)/u,
  );
  assert.match(
    target,
    /Write\("editor-value", currentEditorValue\);\s*updateDraft\(currentEditorValue\);\s*observedEditorValue = currentEditorValue;/u,
  );
  assert.match(target, /draftStatus\.AccessibleName = draftStatus\.Text;/u);
  assert.match(target, /appliedStatus\.AccessibleName = appliedStatus\.Text;/u);
  assert.match(target, /editor\.ValueChanged = updateDraft;/u);
  assert.doesNotMatch(
    WINDOWS_PACKAGED_UIA_FIXTURE,
    /TextChanged \+=|Write\("editor-value", ""\)/u,
  );
  assert.match(
    WINDOWS_PACKAGED_UIA_FIXTURE,
    /File\.WriteAllText\(temporary, value, new UTF8Encoding\(false\)\)/u,
  );
});

test("synthetic effect mismatch diagnostics remain numeric and preserve exact differences", () => {
  assert.deepEqual(
    fixtureEvidence.describeWindowsFixtureTextMismatch("\r\n", "\n"),
    {
      actualLength: 2,
      expectedLength: 1,
      firstDifferentUtf16Offset: 0,
      actualCodeUnit: 13,
      expectedCodeUnit: 10,
    },
  );
  assert.deepEqual(
    fixtureEvidence.describeWindowsFixtureTextMismatch("", "中文 😀"),
    {
      actualLength: 0,
      expectedLength: 5,
      firstDifferentUtf16Offset: 0,
      actualCodeUnit: null,
      expectedCodeUnit: 20013,
    },
  );
  assert.deepEqual(
    fixtureEvidence.describeWindowsFixtureTextMismatch("\ufeffx", "x"),
    {
      actualLength: 2,
      expectedLength: 1,
      firstDifferentUtf16Offset: 0,
      actualCodeUnit: 65279,
      expectedCodeUnit: 120,
    },
  );
});
