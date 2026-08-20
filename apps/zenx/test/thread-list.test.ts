import assert from "node:assert/strict";
import test from "node:test";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import {
  deriveInboxSections,
  derivePinnedThreads,
  deriveProjectGroups,
  readThreadScope,
  projectThreadStartParams,
  readSidebarMode,
  startProjectThread,
  lastUsedProjectWorkspace,
  threadModelIdentity,
  threadPreview,
  threadTitle,
  writeThreadScope,
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

test("persists Active or Archived without accepting unknown Thread scopes", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  assert.equal(readThreadScope(storage), "active");
  writeThreadScope(storage, "archived");
  assert.equal(readThreadScope(storage), "archived");
  values.set("zenx-thread-scope", "deleted");
  assert.equal(readThreadScope(storage), "active");
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
      ["needs", ["active", "broken"]],
      ["active", []],
      ["watching", ["watching"]],
      ["settled", ["settled"]],
    ],
  );
});

test("derives pinned navigation by recency while ignoring stale and duplicate ids", () => {
  const older = summary("older", "idle", 20);
  const newer = summary("newer", "idle", 40);
  const inboxBefore = deriveInboxSections([older, newer]);
  const pinned = derivePinnedThreads(
    [older, newer],
    ["older", "missing", "newer", "older"],
  );
  assert.deepEqual(
    pinned.map((thread) => thread.threadId),
    ["newer", "older"],
  );
  assert.deepEqual(deriveInboxSections([older, newer]), inboxBefore);
  const groups = deriveProjectGroups(
    [older, newer],
    {
      projects: [
        {
          key: "/work/zen",
          workspace: "/work/zen",
          configured: true,
          isDefault: true,
          threadIds: ["older", "newer"],
        },
      ],
      unavailableThreadIds: [],
      lastUsedWorkspace: null,
    },
    new Set(pinned.map((thread) => thread.threadId)),
  );
  assert.deepEqual(groups[0]?.threads, []);
});

test("groups native summaries only by current cwd", () => {
  const groups = deriveProjectGroups(
    [
      summary("zen-a", "idle", 20, "/work/zen"),
      summary("zen-b", "idle", 10, "/tmp/zen"),
      summary("imzen", "idle", 30, "/work/imzen"),
      broken("broken"),
    ],
    {
      projects: [
        {
          key: "/work/zen",
          workspace: "/work/zen",
          configured: true,
          isDefault: true,
          threadIds: ["zen-a"],
        },
        {
          key: "/tmp/zen",
          workspace: "/tmp/zen",
          configured: false,
          isDefault: false,
          threadIds: ["zen-b"],
        },
        {
          key: "/work/imzen",
          workspace: "/work/imzen",
          configured: true,
          isDefault: false,
          threadIds: ["imzen"],
        },
      ],
      unavailableThreadIds: ["broken"],
      lastUsedWorkspace: "/work/zen",
    },
  );
  assert.deepEqual(
    groups.map((group) => [
      group.label,
      group.threads.map((thread) => thread.threadId),
    ]),
    [
      ["imzen", ["imzen"]],
      ["zen", ["zen-b"]],
      ["zen", ["zen-a"]],
      ["Unavailable journals", ["broken"]],
    ],
  );
});

test("keeps a configured project visible when it has no threads", () => {
  const groups = deriveProjectGroups([], {
    projects: [
      {
        key: "/work/empty",
        workspace: "/work/empty",
        configured: true,
        isDefault: true,
        threadIds: [],
      },
    ],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  });
  assert.deepEqual(
    groups.map(({ label, threads }) => [label, threads]),
    [["empty", []]],
  );
});

test("blocks no-project Thread creation and binds creation after Add project", () => {
  const empty = {
    projects: [],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  };
  assert.equal(lastUsedProjectWorkspace(empty), null);
  assert.throws(
    () => projectThreadStartParams(lastUsedProjectWorkspace(empty)),
    /Add a Project/u,
  );
  const configured = {
    projects: [
      {
        key: "/work/selected",
        workspace: "/work/selected",
        configured: true,
        isDefault: true,
        threadIds: [],
      },
    ],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  };
  assert.deepEqual(
    projectThreadStartParams(configured.projects[0]!.workspace),
    { cwd: "/work/selected" },
  );
  assert.equal(lastUsedProjectWorkspace(configured), null);
  assert.equal(
    lastUsedProjectWorkspace({
      ...configured,
      lastUsedWorkspace: "/work/selected",
    }),
    "/work/selected",
  );
});

test("records last-used only after Project Thread creation succeeds", async () => {
  const remembered: string[] = [];
  await assert.rejects(
    startProjectThread(
      "/work/failing",
      async () => {
        throw new Error("start failed");
      },
      (workspace) => remembered.push(workspace),
    ),
    /start failed/u,
  );
  assert.equal(remembered.length, 0);

  const result = await startProjectThread(
    "/work/created",
    async (params) => ({ id: "thread-created", ...params }),
    (workspace) => remembered.push(workspace),
  );
  assert.deepEqual(result, {
    id: "thread-created",
    cwd: "/work/created",
  });
  assert.deepEqual(remembered, ["/work/created"]);
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
