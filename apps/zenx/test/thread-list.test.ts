import assert from "node:assert/strict";
import test from "node:test";

import type { Thread } from "../src/protocol-client/index.js";
import {
  applyThreadNotification,
  deriveInboxSections,
  deriveProjectGroups,
  readSidebarMode,
  threadTitle,
  writeSidebarMode,
} from "../src/renderer/src/thread-list.js";

test("persists the selected sidebar mode and defaults invalid values to inbox", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  assert.equal(readSidebarMode(storage), "inbox");
  writeSidebarMode(storage, "projects");
  assert.equal(readSidebarMode(storage), "projects");
  values.set("zenx-sidebar-mode", "unexpected");
  assert.equal(readSidebarMode(storage), "inbox");
});

test("derives recency-first inbox groups and preserves system errors", () => {
  const unavailable = makeThread("broken", 30, { type: "systemError" });
  const active = makeThread("active", 20, {
    type: "active",
    activeFlags: [],
  });
  const older = makeThread("older", 10, { type: "idle" });
  const newer = makeThread("newer", 40, { type: "idle" });
  const sections = deriveInboxSections([older, unavailable, active, newer]);
  assert.deepEqual(
    sections.map((section) => [
      section.key,
      section.threads.map((thread) => thread.id),
    ]),
    [
      ["needs", ["broken"]],
      ["active", ["active"]],
      ["settled", ["newer", "older"]],
    ],
  );
  assert.match(threadTitle(unavailable), /Unavailable thread/u);
});

test("derives project groups only from cwd and isolates unavailable journals", () => {
  const zen = makeThread("zen", 20, { type: "idle" }, "/work/zen");
  const nested = makeThread("nested", 10, { type: "idle" }, "/tmp/zen");
  const imzen = makeThread("imzen", 30, { type: "idle" }, "/work/imzen");
  const unavailable = makeThread("broken", 40, { type: "systemError" }, "");
  const groups = deriveProjectGroups([zen, nested, imzen, unavailable]);
  assert.deepEqual(
    groups.map((group) => [
      group.label,
      group.threads.map((thread) => thread.id),
    ]),
    [
      ["imzen", ["imzen"]],
      ["zen", ["zen"]],
      ["zen", ["nested"]],
      ["Unavailable journals", ["broken"]],
    ],
  );
});

test("applies name and turn lifecycle notifications without altering errors", () => {
  const idle = makeThread("thread", 10, { type: "idle" });
  const broken = makeThread("broken", 10, { type: "systemError" });
  const named = applyThreadNotification(
    [idle, broken],
    "thread/name/updated",
    { threadId: idle.id, threadName: "Renamed" },
    20,
  );
  assert.equal(named[0]?.name, "Renamed");
  const active = applyThreadNotification(
    named,
    "turn/started",
    { threadId: idle.id, turn: makeTurn("turn", "inProgress") },
    30,
  );
  assert.equal(active[0]?.status.type, "active");
  const settled = applyThreadNotification(
    active,
    "turn/completed",
    { threadId: idle.id, turn: makeTurn("turn", "completed") },
    40,
  );
  assert.equal(settled[0]?.status.type, "idle");
  assert.equal(settled[1]?.status.type, "systemError");
});

function makeThread(
  id: string,
  updatedAt: number,
  status: Thread["status"],
  cwd = "/work/zen",
): Thread {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: status.type === "systemError" ? "" : `${id} preview`,
    ephemeral: false,
    isPinned: false,
    modelProvider: status.type === "systemError" ? "" : "fake",
    createdAt: updatedAt - 1,
    updatedAt,
    recencyAt: null,
    status,
    path: null,
    cwd,
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function makeTurn(id: string, status: "inProgress" | "completed") {
  return {
    id,
    items: [],
    itemsView: "full" as const,
    status,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}
