import assert from "node:assert/strict";
import test from "node:test";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import {
  deriveInboxSections,
  deriveProjectGroups,
  readSidebarMode,
  threadModelIdentity,
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

test("derives inbox groups from native summary status", () => {
  const unavailable = broken("broken");
  const active = summary("active", "active", 20);
  const watching = summary("watching", "idle", 30);
  const settled = summary("settled", "idle", 40);
  const sections = deriveInboxSections(
    [unavailable, active, watching, settled],
    new Set(["active"]),
    new Set(["watching"]),
  );
  assert.deepEqual(
    sections.map((section) => [
      section.key,
      section.threads.map((thread) => thread.threadId),
    ]),
    [
      ["needs", ["broken", "active"]],
      ["active", []],
      ["watching", ["watching"]],
      ["settled", ["settled"]],
    ],
  );
});

test("groups native summaries only by current cwd", () => {
  const groups = deriveProjectGroups([
    summary("zen-a", "idle", 20, "/work/zen"),
    summary("zen-b", "idle", 10, "/tmp/zen"),
    summary("imzen", "idle", 30, "/work/imzen"),
    broken("broken"),
  ]);
  assert.deepEqual(
    groups.map((group) => [
      group.label,
      group.threads.map((thread) => thread.threadId),
    ]),
    [
      ["imzen", ["imzen"]],
      ["zen", ["zen-a"]],
      ["zen", ["zen-b"]],
      ["Unavailable journals", ["broken"]],
    ],
  );
});

test("presents trigger wakeups without leaking raw system prompts", () => {
  const wakeup = [
    "[ZenX trigger wakeup]",
    "Trigger ID: trigger-a",
    "Source Thread: source-thread-123",
  ].join("\n");
  const value = summary("relay", "idle", 20);
  value.name = wakeup;
  value.preview = wakeup;
  assert.equal(threadTitle(value), "Relay from source-t");
  assert.equal(
    threadPreview(value),
    "Relay from source-t · system-level wakeup",
  );
});

test("shows only logo category and friendly model identity", () => {
  const openai = summary("openai", "idle", 20);
  openai.currentMetadata.model = "gpt-5.6-sol";
  openai.currentMetadata.provider = "internal-openai-subscription-id";
  assert.deepEqual(threadModelIdentity(openai), {
    label: "GPT-5.6-sol",
    providerKind: "openai",
  });
  const demo = summary("demo", "idle", 20);
  demo.currentMetadata.model = "fake";
  demo.currentMetadata.provider = "fake";
  assert.deepEqual(threadModelIdentity(demo), {
    label: "Local demo",
    providerKind: "local",
  });
});

function summary(
  threadId: string,
  status: "idle" | "active",
  updated: number,
  cwd = "/work/zen",
): Extract<NativeThreadSummary, { status: "idle" | "active" }> {
  return {
    threadId,
    currentMetadata: {
      model: "gpt-5.6-terra",
      provider: "openai",
      cwd,
      sandbox: "danger-full-access",
      approvalPolicy: "always",
    },
    archived: false,
    createdAt: new Date((updated - 1) * 1_000).toISOString(),
    updatedAt: new Date(updated * 1_000).toISOString(),
    preview: `${threadId} preview`,
    status,
  };
}

function broken(threadId: string): NativeThreadSummary {
  return {
    threadId,
    archived: false,
    createdAt: null,
    updatedAt: null,
    preview: "",
    status: "systemError",
    error: "journal failed",
  };
}
