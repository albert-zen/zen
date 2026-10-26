import assert from "node:assert/strict";

/** Only fixed numeric fixture fields can leave the private stderr tail. */
export function windowsUiaTargetDiagnostics(stderr: string) {
  const fields = [
    "elapsedMs",
    "ticks",
    "lastTickMs",
    "getObjectEntered",
    "getObjectExited",
    "lastEnterMs",
    "lastExitMs",
    "objectKind",
  ] as const;
  const snapshots: Record<(typeof fields)[number], number>[] = [];
  for (const line of stderr.slice(-16_384).split(/\r?\n/u)) {
    if (!line.startsWith("ZENX_UIA_TARGET_DIAGNOSTIC ") || line.length > 1024)
      continue;
    try {
      const value = JSON.parse(
        line.slice("ZENX_UIA_TARGET_DIAGNOSTIC ".length),
      );
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      if (
        !fields.every(
          (field) =>
            Number.isSafeInteger(value[field]) &&
            value[field] >=
              (field === "objectKind"
                ? -25
                : field.startsWith("last")
                  ? -1
                  : 0) &&
            value[field] <= 1_000_000_000,
        )
      )
        continue;
      if (![-25, -4, 0].includes(value.objectKind)) continue;
      snapshots.push(
        Object.fromEntries(
          fields.map((field) => [field, value[field]]),
        ) as Record<(typeof fields)[number], number>,
      );
    } catch {
      /* A partial/invalid diagnostic is not native success evidence. */
    }
  }
  return snapshots.slice(-24);
}

export interface WindowsPackagedUiaFocusEvidence {
  guardPid: number;
  targetPid: number;
  hookInstalled: boolean;
  samples: number;
  eventCount: number;
  focusChanges: number;
  pointerChanges: number;
  overflow: boolean;
  elapsedMs: number;
  foregroundTransitions: Array<{
    source: "initial" | "sample" | "EVENT_SYSTEM_FOREGROUND";
    elapsedMs: number;
    hwnd: string;
    pid: number;
    kind: "guard" | "target" | "none" | "other";
  }>;
}

/** Fails closed on missing, truncated, or contradictory native evidence. */
export function assertWindowsPackagedUiaFocusEvidence(
  report: WindowsPackagedUiaFocusEvidence,
  expected: { targetPid: number; guardPid: number; guardHwnd: string },
): void {
  assert.equal(report.targetPid, expected.targetPid);
  assert.equal(report.guardPid, expected.guardPid);
  assert.notEqual(
    report.targetPid,
    report.guardPid,
    "guard must be a separate process",
  );
  assert.equal(report.hookInstalled, true, "WinEvent hook must be installed");
  assert.equal(
    report.overflow,
    false,
    "foreground event evidence must not be truncated",
  );
  assert.ok(Number.isSafeInteger(report.samples) && report.samples >= 2);
  assert.ok(Number.isSafeInteger(report.elapsedMs) && report.elapsedMs >= 200);
  assert.equal(
    report.focusChanges,
    0,
    "target or unrelated window gained foreground",
  );
  assert.equal(
    report.pointerChanges,
    0,
    "native operation moved the user pointer",
  );
  assert.ok(
    report.foregroundTransitions.length > 0,
    "initial foreground evidence missing",
  );
  assert.equal(report.foregroundTransitions[0]?.source, "initial");
  assert.equal(
    report.foregroundTransitions.filter(
      ({ source }) => source === "EVENT_SYSTEM_FOREGROUND",
    ).length,
    report.eventCount,
    "every observed WinEvent must remain in the report",
  );
  for (const transition of report.foregroundTransitions) {
    assert.equal(transition.kind, "guard");
    assert.equal(transition.pid, expected.guardPid);
    assert.equal(transition.hwnd, expected.guardHwnd);
    assert.ok(
      transition.elapsedMs >= 0 && transition.elapsedMs <= report.elapsedMs,
    );
  }
}

/** Bounded numeric diagnostics for this disposable fixture's synthetic text only. */
export function describeWindowsFixtureTextMismatch(
  actual: string,
  expected: string,
) {
  let offset = 0;
  while (
    offset < actual.length &&
    offset < expected.length &&
    actual.charCodeAt(offset) === expected.charCodeAt(offset)
  )
    offset++;
  return {
    actualLength: actual.length,
    expectedLength: expected.length,
    firstDifferentUtf16Offset: offset,
    actualCodeUnit: offset < actual.length ? actual.charCodeAt(offset) : null,
    expectedCodeUnit:
      offset < expected.length ? expected.charCodeAt(offset) : null,
  };
}
