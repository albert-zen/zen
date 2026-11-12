import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Display, Screen } from "electron";
import { observeForegroundDisplaySmoke } from "../src/main/foreground-display-smoke-diagnostics.js";

function display(id = 1): Display {
  return {
    id,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 24, width: 1440, height: 876 },
    scaleFactor: 2,
    rotation: 0,
    label: "synthetic-private-label-not-for-logs",
  } as Display;
}

function fixture(displays = [display()]) {
  let time = 100;
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => displays,
  });
  const diagnostics = observeForegroundDisplaySmoke(
    screen as unknown as Screen,
    () => time++,
  );
  return { screen, diagnostics };
}

test("display diagnostics copy only bounded numeric descriptors and known metric names", () => {
  const { screen, diagnostics } = fixture();
  diagnostics.mark("overlay-create");
  const changed = display();
  changed.workArea.y = 0;
  for (const event of [
    "display-added",
    "display-removed",
    "display-metrics-changed",
  ])
    screen.emit(event, { privatePayload: "do-not-record" }, changed, [
      "workArea",
      "scaleFactor",
      "workArea",
      "private-unknown-metric",
    ]);
  changed.workArea.y = 999;
  const report = diagnostics.close();
  assert.deepEqual(
    report.records.map((entry) => entry.kind),
    [
      "phase",
      "phase",
      "display-added",
      "display-removed",
      "display-metrics-changed",
    ],
  );
  assert.deepEqual(report.records.at(-1), {
    phase: "overlay-create",
    elapsedMs: 5,
    kind: "display-metrics-changed",
    display: {
      id: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 0, width: 1440, height: 876 },
      scaleFactor: 2,
      rotation: 0,
    },
    changedMetrics: ["workArea", "scaleFactor"],
    unknownMetricsCount: 1,
  });
  assert.doesNotMatch(JSON.stringify(report), /private|do-not-record|999/u);
});

test("display diagnostics retain the first and last bounded records and at most four displays", () => {
  const { screen, diagnostics } = fixture(
    Array.from({ length: 20 }, (_, index) => display(index)),
  );
  for (let index = 0; index < 100; index++)
    screen.emit("display-added", {}, display(index));
  const report = diagnostics.close();
  assert.equal(report.records.length, 32);
  assert.equal(report.droppedRecords, 69);
  assert.equal((report.records[0]?.displays as unknown[]).length, 4);
  assert.equal(report.records[0]?.omittedDisplays, 16);
  assert.equal((report.records[15]?.display as { id: number }).id, 14);
  assert.equal((report.records[16]?.display as { id: number }).id, 84);
  assert.equal((report.records.at(-1)?.display as { id: number }).id, 99);
  assert(JSON.stringify(report).length < 16_384);
});

test("close removes only diagnostic listeners and is idempotent after a failed fixture", () => {
  const { screen, diagnostics } = fixture();
  let originalCalls = 0;
  const original = () => originalCalls++;
  screen.on("display-added", original);
  const failure = new Error("original fixture failure");
  let report;
  assert.throws(
    () => {
      try {
        throw failure;
      } finally {
        report = diagnostics.close();
      }
    },
    (error) => error === failure,
  );
  const before = JSON.stringify(report);
  screen.emit("display-added", {}, display());
  diagnostics.mark("cleanup-finished");
  assert.equal(JSON.stringify(diagnostics.close()), before);
  assert.deepEqual(screen.listeners("display-added"), [original]);
  assert.equal(screen.listenerCount("display-removed"), 0);
  assert.equal(screen.listenerCount("display-metrics-changed"), 0);
  assert.equal(originalCalls, 1);
});

test("diagnostic read failures cannot prevent the original synchronous display cancellation", () => {
  const { screen, diagnostics } = fixture();
  let revoked = false;
  screen.on("display-metrics-changed", () => {
    revoked = true;
  });
  const unreadable = Object.defineProperty({}, "bounds", {
    get() {
      throw new Error("read failure");
    },
  });
  assert.doesNotThrow(() =>
    screen.emit("display-metrics-changed", {}, unreadable, ["bounds"]),
  );
  assert.equal(revoked, true);
  screen.getAllDisplays = () => {
    throw new Error("snapshot failure");
  };
  assert.doesNotThrow(() => diagnostics.mark("cleanup-start"));
  assert.equal(diagnostics.close().diagnosticErrors, 2);
});

test("smoke diagnostics surround window setup and close in finally without changing the display guard", async () => {
  const smoke = await readFile(
    new URL("../src/main/foreground-activity-smoke.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    smoke,
    /finally \{\s+diagnostics\.mark\("verification-finished"\);\s+console\.log\([\s\S]*?JSON\.stringify\(diagnostics\.close\(\)\)/u,
  );
  for (const phase of [
    "fixture-create",
    "fixture-shown",
    "fixture-focus-requested",
    "activity-requested",
    "overlay-create",
    "overlay-created",
    "cleanup-start",
    "cleanup-finished",
  ])
    assert(smoke.includes(`mark("${phase}")`));
  const diagnostic = await readFile(
    new URL(
      "../src/main/foreground-display-smoke-diagnostics.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(
    diagnostic,
    /setTimeout|setInterval|\.emit\(|onUnavailable|preventDefault|capturePage|captureScreen/u,
  );
});
