import assert from "node:assert/strict";
import test from "node:test";

import type { Thread } from "../src/protocol-client/index.js";
import {
  applyThreadNotification,
  deriveInboxSections,
  deriveProjectGroups,
  readSidebarMode,
  threadPreview,
  threadTitle,
  writeSidebarMode,
} from "../src/renderer/src/thread-list.js";

test("persists the selected sidebar mode and defaults invalid values to projects", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  assert.equal(readSidebarMode(storage), "projects");
  writeSidebarMode(storage, "inbox");
  assert.equal(readSidebarMode(storage), "inbox");
  values.set("zenx-sidebar-mode", "unexpected");
  assert.equal(readSidebarMode(storage), "projects");
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
      ["watching", []],
      ["settled", ["newer", "older"]],
    ],
  );
  assert.match(threadTitle(unavailable), /Unavailable thread/u);
});

test("moves active approval threads to Needs you without duplicating them", () => {
  const pending = makeThread("pending", 40, {
    type: "active",
    activeFlags: [],
  });
  const active = makeThread("active", 30, {
    type: "active",
    activeFlags: [],
  });
  const sections = deriveInboxSections(
    [active, pending],
    new Set([pending.id]),
  );
  assert.deepEqual(
    sections.map((section) => section.threads.map((thread) => thread.id)),
    [["pending"], ["active"], [], []],
  );
});

test("projects idle threads with triggers as Watching instead of Completed", () => {
  const watching = makeThread("watching", 20, { type: "idle" });
  const sections = deriveInboxSections(
    [watching],
    new Set(),
    new Set([watching.id]),
  );
  assert.deepEqual(
    sections.map((section) => section.threads.map((thread) => thread.id)),
    [[], [], ["watching"], []],
  );
});

test("presents trigger-first Threads as system relays instead of raw user titles", () => {
  const thread = makeThread("relay", 20, { type: "idle" });
  const wakeup = [
    "[ZenX trigger wakeup]",
    "Trigger ID: trigger-a",
    "Source Thread: source-thread-123",
    "Source Turn: source-turn-456",
  ].join("\n");
  thread.name = wakeup;
  thread.preview = wakeup;
  assert.equal(threadTitle(thread), "Relay from source-t");
  assert.equal(
    threadPreview(thread),
    "Relay from source-t · system-level wakeup",
  );
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
  const previewed = applyThreadNotification(
    active,
    "item/completed",
    {
      threadId: idle.id,
      turnId: "turn",
      item: {
        type: "userMessage",
        id: "message",
        clientId: null,
        content: [{ type: "text", text: "Newest prompt", text_elements: [] }],
      },
      completedAtMs: 35_000,
    },
    35,
  );
  assert.equal(previewed[0]?.preview, "Newest prompt");
  const settled = applyThreadNotification(
    previewed,
    "turn/completed",
    { threadId: idle.id, turn: makeTurn("turn", "completed") },
    40,
  );
  assert.equal(settled[0]?.status.type, "idle");
  assert.equal(settled[1]?.status.type, "systemError");
});

test("removes archived Threads from the active renderer projection", () => {
  const first = makeThread("first", 20, { type: "idle" });
  const archived = makeThread("archived", 10, { type: "idle" });
  assert.deepEqual(
    applyThreadNotification([first, archived], "thread/archived", {
      threadId: archived.id,
    }).map((thread) => thread.id),
    ["first"],
  );
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
