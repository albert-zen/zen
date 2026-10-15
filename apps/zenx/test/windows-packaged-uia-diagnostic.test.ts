import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PackagedUiaDiagnostic } from "../src/main/windows-packaged-uia-diagnostic.js";

test("failure receipts retain only bounded labels, never input or UI contents", () => {
  const d = new PackagedUiaDiagnostic("unused");
  d.receipt(
    1,
    JSON.stringify({
      operation: "inspect",
      outcome: "not_dispatched",
      error: "provider_error_inspect_element_com_h80131505",
      root: { name: "SECRET" },
      controls: ["SECRET"],
      value: "SECRET",
    }),
  );
  assert.equal(
    d.events[0]?.error,
    "provider_error_inspect_element_com_h80131505",
  );
  d.receipt(
    2,
    JSON.stringify({
      operation: "SECRET",
      outcome: "SECRET",
      error: "provider_error_SECRET_com_h80131505",
    }),
  );
  assert.equal(d.events[1]?.error, "redacted");
  assert.ok(!JSON.stringify(d.events).includes("SECRET"));
  d.receipt(3, "bad JSON");
  assert.equal(d.errors, 1);
});

test("bounded ring retains startup and final cleanup with explicit loss count", () => {
  const d = new PackagedUiaDiagnostic("unused");
  for (let i = 0; i < 300; i++) d.record("call", { i });
  d.record("cleanup-complete");
  assert.equal(d.events.length, 256);
  assert.equal(d.events[0]?.i, 0);
  assert.equal(d.events.at(-1)?.kind, "cleanup-complete");
  assert.equal(d.dropped, 45);
});

test("incomplete cleanup evidence persists; successful runs retain nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uia-diag-test-"));
  try {
    const d = new PackagedUiaDiagnostic(dir);
    await d.finish(false);
    await assert.rejects(
      readFile(path.join(dir, "packaged-uia-diagnostic.json")),
      { code: "ENOENT" },
    );
    d.owner("target", 123, "456");
    await d.heartbeat(dir, "before-inspect");
    await writeFile(
      path.join(dir, "target-heartbeat.json"),
      JSON.stringify({
        sequence: 4,
        elapsedMs: 750,
        utcMs: Date.now(),
        secret: "SECRET",
      }),
    );
    await d.heartbeat(dir, "before-cleanup");
    d.record("smoke-settled", { completed: false });
    d.record("cleanup-start");
    await d.finish();
    const raw = await readFile(
      path.join(dir, "packaged-uia-diagnostic.json"),
      "utf8",
    );
    const report = JSON.parse(raw);
    assert.ok(!raw.includes("SECRET"));
    assert.ok(
      report.events.some(
        (e: { kind: string }) => e.kind === "heartbeat-unavailable",
      ),
    );
    assert.ok(
      report.events.some((e: { kind: string }) => e.kind === "heartbeat"),
    );
    assert.ok(
      !report.events.some(
        (e: { kind: string }) => e.kind === "cleanup-complete",
      ),
    );
    await writeFile(path.join(dir, "target-heartbeat.json"), "x".repeat(2048));
    await d.heartbeat(dir, "before-cleanup");
    assert.equal(d.events.at(-1)?.kind, "heartbeat-unavailable");
    await new PackagedUiaDiagnostic(
      path.join(dir, "target-heartbeat.json", "bad"),
    ).finish();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disabled diagnostics do not read, persist or retain events", async () => {
  const d = new PackagedUiaDiagnostic(undefined);
  d.record("call");
  d.receipt(1, "invalid");
  await d.heartbeat("missing", "before-cleanup");
  await d.finish();
  assert.deepEqual(d.events, []);
  assert.equal(d.errors, 0);
});

test("smoke preserves cleanup startup before awaiting boundary diagnostics", async () => {
  const source = await readFile(
    new URL("../src/main/windows-packaged-uia-smoke.ts", import.meta.url),
    "utf8",
  );
  const cleanup = source.slice(
    source.indexOf('evidence.record("smoke-settled"'),
  );
  const ordered = [
    "const heartbeat = evidence.heartbeat",
    "clearTimeout(timeout)",
    "controller.abort(",
    'path.join(directory, "release-value")',
    'path.join(directory, "quit")',
    "await computer?.close()",
    "await rm(directory",
    "cleanupCompleted = true",
    "await heartbeat",
    "await evidence.finish(!completed || !cleanupCompleted)",
  ];
  let last = -1;
  for (const token of ordered) {
    const next = cleanup.indexOf(token);
    assert.ok(next > last, `cleanup ordering: ${token}`);
    last = next;
  }
  assert.ok(
    !cleanup
      .slice(0, cleanup.indexOf("clearTimeout(timeout)"))
      .includes("await "),
  );
});
