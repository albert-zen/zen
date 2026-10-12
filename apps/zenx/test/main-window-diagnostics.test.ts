import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrowserWindow } from "electron";
import { attachMainWindowDiagnostics } from "../src/main/main-window-diagnostics.js";
import {
  OperationalDiagnosticLog,
  normalizeOperationalDiagnostic,
  type MainWindowEvent,
} from "../src/main/operational-diagnostic-log.js";

function fakeWindow(id: number) {
  const window = new EventEmitter() as EventEmitter & {
    id: number;
    webContents: EventEmitter;
  };
  window.id = id;
  window.webContents = new EventEmitter();
  return window;
}

test("only main window faults are recorded, with a bounded field whitelist", async () => {
  const window = fakeWindow(17);
  const events: MainWindowEvent[] = [];
  attachMainWindowDiagnostics(
    window as unknown as BrowserWindow,
    {
      recordMainWindowEvent: async (event) => {
        events.push(event);
      },
    },
    () => false,
  );
  const web = window.webContents;
  web.emit(
    "did-fail-load",
    {},
    -105,
    "password=topsecret",
    "https://secret/path",
    false,
  );
  web.emit("did-fail-load", {}, -3, "aborted", "https://secret/path", true);
  web.emit(
    "did-fail-load",
    {},
    -105,
    "password=topsecret",
    "https://secret/path",
    true,
  );
  web.emit("unresponsive");
  web.emit("unresponsive");
  web.emit("responsive");
  web.emit("responsive");
  web.emit(
    "render-process-gone",
    {},
    { reason: "oom", exitCode: 137, private: "secret" },
  );
  assert.deepEqual(
    events.map((e) => e.status),
    ["load-failed", "unresponsive", "responsive", "renderer-gone"],
  );
  const projected = events.map((event) =>
    normalizeOperationalDiagnostic(event),
  );
  assert.equal(projected[0]?.event, "main-window");
  assert.equal(JSON.stringify(projected).includes("secret"), false);
  assert.equal(JSON.stringify(projected).includes("https:"), false);
  assert.ok(
    projected.every(
      (e) =>
        e?.event === "main-window" &&
        e.windowId === 17 &&
        e.mainPid === process.pid,
    ),
  );
});

test("unknown renderer reasons and unexpected numbers cannot leak arbitrary input", () => {
  const record = normalizeOperationalDiagnostic({
    event: "main-window",
    status: "renderer-gone",
    reason: "token=secret /Users/path",
    exitCode: "token=secret",
    windowId: "private",
    mainPid: -1,
    url: "private",
  });
  assert.deepEqual(Object.keys(record ?? {}).sort(), [
    "event",
    "reason",
    "status",
    "timestamp",
  ]);
  assert.equal(
    record?.event === "main-window" &&
      record.status === "renderer-gone" &&
      record.reason,
    "other",
  );
  assert.equal(
    normalizeOperationalDiagnostic({
      event: "main-window",
      status: "load-failed",
      errorCode: "private",
    }),
    null,
  );
  assert.equal(
    normalizeOperationalDiagnostic({
      event: "main-window",
      status: "load-failed",
      errorCode: -3,
    }),
    null,
  );
  assert.equal(
    normalizeOperationalDiagnostic({ event: "main-window", status: "private" }),
    null,
  );
  assert.equal(
    JSON.stringify(
      normalizeOperationalDiagnostic({
        event: "main-window",
        status: "unresponsive",
        title: "private",
      }),
    ).includes("private"),
    false,
  );
});

test("closing windows detach only their listeners; quit and normal exit do not report faults", async () => {
  const first = fakeWindow(1),
    second = fakeWindow(2);
  const observed: MainWindowEvent[] = [];
  let quitting = false;
  const log = {
    recordMainWindowEvent: async (event: MainWindowEvent) => {
      observed.push(event);
    },
  };
  attachMainWindowDiagnostics(
    first as unknown as BrowserWindow,
    log,
    () => quitting,
  );
  attachMainWindowDiagnostics(
    second as unknown as BrowserWindow,
    log,
    () => quitting,
  );
  first.webContents.emit(
    "render-process-gone",
    {},
    { reason: "clean-exit", exitCode: 0 },
  );
  first.emit("closed");
  assert.equal(first.webContents.listenerCount("render-process-gone"), 0);
  assert.equal(first.webContents.listenerCount("unresponsive"), 0);
  assert.equal(first.webContents.listenerCount("responsive"), 0);
  assert.equal(first.webContents.listenerCount("did-fail-load"), 0);
  first.webContents.emit(
    "render-process-gone",
    {},
    { reason: "crashed", exitCode: 1 },
  );
  second.webContents.emit(
    "render-process-gone",
    {},
    { reason: "crashed", exitCode: 1 },
  );
  quitting = true;
  second.webContents.emit(
    "render-process-gone",
    {},
    { reason: "crashed", exitCode: 2 },
  );
  second.webContents.emit("unresponsive");
  assert.deepEqual(
    observed.map((e) => [e.windowId, e.status]),
    [[2, "renderer-gone"]],
  );
});

test("diagnostic failures cannot throw into Electron handlers or affect later events", async () => {
  const window = fakeWindow(3);
  let count = 0;
  attachMainWindowDiagnostics(
    window as unknown as BrowserWindow,
    {
      recordMainWindowEvent: () => {
        count++;
        if (count === 1) throw new Error("storage failed");
        return Promise.reject(new Error("storage failed async"));
      },
    },
    () => false,
  );
  assert.doesNotThrow(() => {
    window.webContents.emit("unresponsive");
    window.webContents.emit("responsive");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(count, 2);
});

test("simulated Electron event is persisted through the real bounded diagnostic sink", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-main-window-events-"),
  );
  try {
    const window = fakeWindow(23);
    const log = new OperationalDiagnosticLog(root);
    attachMainWindowDiagnostics(
      window as unknown as BrowserWindow,
      log,
      () => false,
    );
    window.webContents.emit(
      "render-process-gone",
      {},
      {
        reason: "token=private",
        exitCode: 999_999,
        description: "https://private.example",
      },
    );
    window.webContents.emit(
      "did-fail-load",
      {},
      -105,
      "private error",
      "file:///Users/private",
      true,
    );
    const file = path.join(root, "diagnostics", "operations.jsonl");
    // The existing log serializes writes; a final sentinel joins the two prior event writes.
    await log.recordMainWindowEvent({
      event: "main-window",
      status: "responsive",
    });
    const content = await readFile(file, "utf8");
    const entries = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      entries.map((e) => [e.event, e.status]),
      [
        ["main-window", "renderer-gone"],
        ["main-window", "load-failed"],
        ["main-window", "responsive"],
      ],
    );
    assert.equal(entries[0]?.reason, "other");
    assert.equal(entries[0]?.exitCode, undefined);
    assert.equal(entries[1]?.errorCode, -105);
    assert.equal(content.includes("private"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
