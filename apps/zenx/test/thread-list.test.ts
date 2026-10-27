import assert from "node:assert/strict";
import test from "node:test";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import {
  deriveInboxSections,
  deriveSidebarThreads,
  derivePinnedThreads,
  deriveProjectGroups,
  movePinnedThreadIds,
  moveSidebarProject,
  moveSidebarThread,
  readSidebarMode,
  lastUsedProjectWorkspace,
  threadModelIdentity,
  threadPreview,
  threadEditTitle,
  threadTitle,
  writeSidebarMode,
} from "../src/renderer/src/thread-list.js";
import type { ZenXSidebarOrder } from "../src/main/host-profile.js";

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
      ["needs", ["active", "broken"]],
      ["active", []],
      ["watching", ["watching"]],
      ["settled", ["settled"]],
    ],
  );
});

test("default inbox and project order ignore mid-Turn items and use stable ties", () => {
  const a = {
    ...summary("a", "idle", 90),
    turnSortAt: new Date(20_000).toISOString(),
  };
  const b = {
    ...summary("b", "idle", 40),
    turnSortAt: new Date(30_000).toISOString(),
  };
  const ids = (entries: NativeThreadSummary[]) =>
    deriveInboxSections(entries)
      .find((section) => section.key === "settled")!
      .threads.map((thread) => thread.threadId);
  assert.deepEqual(ids([a, b]), ["b", "a"]);
  assert.deepEqual(
    ids([{ ...a, updatedAt: new Date(200_000).toISOString() }, b]),
    ["b", "a"],
  );
  assert.deepEqual(ids([{ ...a, turnSortAt: b.turnSortAt }, b]), ["a", "b"]);
  const projection = {
    projects: [project("/work/zen", ["a", "b"])],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  };
  assert.deepEqual(
    deriveProjectGroups([a, b], projection)[0]?.threads.map(
      (thread) => thread.threadId,
    ),
    ["b", "a"],
  );
  assert.deepEqual(
    deriveProjectGroups([a, b], projection, {
      projectKeys: [],
      threadIdsByProject: { "/work/zen": ["a", "b"] },
    })[0]?.threads.map((thread) => thread.threadId),
    ["a", "b"],
  );
});

test("projects local Pins in persisted order while filtering archived and missing Threads", () => {
  const first = summary("first", "idle", 20);
  const second = summary("second", "idle", 30);
  const archived = { ...summary("archived", "idle", 40), archived: true };
  assert.deepEqual(
    derivePinnedThreads(
      [first, second, archived],
      ["second", "missing", "archived", "first"],
    ).map((thread) => thread.threadId),
    ["second", "first"],
  );
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

test("reconciles persisted Project and per-Project Thread preferences with current stable order", () => {
  const preference: ZenXSidebarOrder = {
    projectKeys: ["/removed", "/work/b"],
    threadIdsByProject: {
      "/work/b": ["removed-thread", "b-old"],
    },
  };
  const projection = {
    projects: [
      project("/work/a", ["a-new"]),
      project("/work/b", ["b-new", "b-old"]),
      project("/work/c", ["c-new"]),
    ],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  };

  const groups = deriveProjectGroups(
    [
      summary("a-new", "idle", 40, "/work/a"),
      summary("b-new", "idle", 30, "/work/b"),
      summary("b-old", "idle", 20, "/work/b"),
      summary("c-new", "idle", 10, "/work/c"),
    ],
    projection,
    preference,
  );

  assert.deepEqual(
    groups.map((group) => [
      group.key,
      group.threads.map((thread) => thread.threadId),
    ]),
    [
      ["/work/b", ["b-old", "b-new"]],
      ["/work/a", ["a-new"]],
      ["/work/c", ["c-new"]],
    ],
  );
});

test("moves Threads only inside their owning Project without changing membership", () => {
  const projection = {
    projects: [project("/work/a", ["a-1", "a-2"]), project("/work/b", ["b-1"])],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  };
  const threads = [
    summary("a-1", "active", 30, "/work/a"),
    summary("a-2", "idle", 20, "/work/a"),
    summary("b-1", "idle", 10, "/work/b"),
  ];
  const initial: ZenXSidebarOrder = {
    projectKeys: [],
    threadIdsByProject: {},
  };

  const rejected = moveSidebarThread(
    initial,
    threads,
    projection,
    "/work/a",
    "a-1",
    "/work/b",
    "b-1",
    "before",
  );
  assert.equal(rejected, initial);

  const moved = moveSidebarThread(
    initial,
    threads,
    projection,
    "/work/a",
    "a-2",
    "/work/a",
    "a-1",
    "before",
  );
  assert.deepEqual(moved.threadIdsByProject, {
    "/work/a": ["a-2", "a-1"],
  });
  assert.equal(threads[0]!.status, "active");
  assert.equal(threads[0]!.currentMetadata.cwd, "/work/a");
});

test("moves Threads inside the Pinned section by permuting the pinned preference", () => {
  const pinned = ["p-1", "p-2", "p-3"];
  assert.deepEqual(
    [...movePinnedThreadIds(pinned, "p-3", "p-2", "before")],
    ["p-1", "p-3", "p-2"],
  );
  assert.deepEqual(
    [...movePinnedThreadIds(pinned, "p-1", "p-3", "after")],
    ["p-2", "p-3", "p-1"],
  );
  // No-ops: same row, or a row that is not pinned anymore.
  assert.equal(movePinnedThreadIds(pinned, "p-2", "p-2", "before"), pinned);
  assert.equal(movePinnedThreadIds(pinned, "gone", "p-2", "before"), pinned);
  assert.equal(movePinnedThreadIds(pinned, "p-2", "gone", "after"), pinned);
});

test("moves Projects globally while retaining per-Project Thread preferences", () => {
  const projection = {
    projects: [project("/work/a", []), project("/work/b", [])],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  };
  const initial: ZenXSidebarOrder = {
    projectKeys: [],
    threadIdsByProject: { "/work/a": ["a-2", "a-1"] },
  };
  assert.deepEqual(
    moveSidebarProject(initial, projection, "/work/b", "/work/a", "before"),
    {
      projectKeys: ["/work/b", "/work/a"],
      threadIdsByProject: initial.threadIdsByProject,
    },
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

test("resolves last-used Project only from an explicit configured projection", () => {
  const empty = {
    projects: [],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  };
  assert.equal(lastUsedProjectWorkspace(empty), null);
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
  assert.equal(lastUsedProjectWorkspace(configured), null);
  assert.equal(
    lastUsedProjectWorkspace({
      ...configured,
      lastUsedWorkspace: "/work/selected",
    }),
    "/work/selected",
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

test("keeps the Thread's own name when only its first message is a wakeup", () => {
  const wakeup = [
    "[ZenX trigger wakeup]",
    "Trigger ID: trigger-a",
    "Reason: Room #PAW mention from You: hi",
    "Source Room: 63c6c01d-5989-4d55-bf78-03e714189d3e",
  ].join("\n");
  const named = summary("paw", "idle", 20);
  named.name = "PAW";
  named.preview = wakeup;
  assert.equal(threadTitle(named), "PAW");
});

test("falls back to the first-message preview for an unnamed wakeup Thread", () => {
  const wakeup = [
    "[ZenX trigger wakeup]",
    "Trigger ID: trigger-a",
    "Source Room: 63c6c01d-5989-4d55-bf78-03e714189d3e",
  ].join("\n");
  const value = summary("paw", "idle", 20);
  value.preview = wakeup;
  assert.equal(threadTitle(value), wakeup);
});

test("a rename editor starts from the exact name, never from machine text", () => {
  const wakeup = [
    "[ZenX trigger wakeup]",
    "Trigger ID: trigger-a",
    "Source Room: 63c6c01d-5989-4d55-bf78-03e714189d3e",
  ].join("\n");
  const named = summary("paw", "idle", 20);
  named.name = "PAW";
  named.preview = wakeup;
  assert.equal(threadEditTitle(named), "PAW");

  // A legacy name that is the raw prompt displays as a disclosure label but
  // must still be edited as the exact value it holds.
  const legacy = summary("legacy", "idle", 20);
  legacy.name = wakeup;
  assert.equal(threadTitle(legacy), "Room wakeup · 63c6c01d");
  assert.equal(threadEditTitle(legacy), wakeup);

  // An unnamed wakeup Thread offers no name to save; its provisional title is
  // machine text, not a title a user should commit unchanged.
  const unnamed = summary("unnamed", "idle", 20);
  unnamed.preview = wakeup;
  assert.equal(threadEditTitle(unnamed), "");

  const provisional = summary("plain", "idle", 20);
  provisional.preview = "帮我看看构建";
  assert.equal(threadEditTitle(provisional), "帮我看看构建");

  const empty = summary("empty", "idle", 20);
  empty.preview = "";
  assert.equal(threadEditTitle(empty), "");
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
  const deepseek = summary("deepseek", "idle", 20);
  deepseek.currentMetadata.model = "deepseek-chat";
  deepseek.currentMetadata.provider = "deepseek";
  assert.equal(threadModelIdentity(deepseek)?.providerKind, "deepseek");
  const qwen = summary("qwen", "idle", 20);
  qwen.currentMetadata.model = "qwen-max";
  qwen.currentMetadata.provider = "qwen";
  assert.equal(threadModelIdentity(qwen)?.providerKind, "qwen");
  for (const [provider, model, expected] of [
    ["siliconflow", "Qwen2.5-72B", "siliconflow"],
    ["dashscope", "qwen-max", "dashscope"],
    ["moonshot", "kimi-k2", "moonshot"],
    ["zhipu", "glm-4.5", "zhipu"],
  ] as const) {
    const known = summary(provider, "idle", 20);
    known.currentMetadata.model = model;
    known.currentMetadata.provider = provider;
    assert.equal(threadModelIdentity(known)?.providerKind, expected);
  }
  const unknown = summary("unknown", "idle", 20);
  unknown.currentMetadata.model = "custom-model";
  unknown.currentMetadata.provider = "private-provider";
  assert.equal(threadModelIdentity(unknown)?.providerKind, "generic");
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

function project(key: string, threadIds: string[]) {
  return {
    key,
    workspace: key,
    configured: true,
    isDefault: false,
    threadIds,
  };
}

test("per-Thread Sidebar visibility is independent for siblings, nested children, Pins and ordinary forks", () => {
  const parent = summary("parent", "idle", 10);
  const child = { ...summary("child", "active", 20), parentThreadId: "parent" };
  const sibling = {
    ...summary("sibling", "idle", 30),
    parentThreadId: "parent",
  };
  const nested = { ...summary("nested", "idle", 40), parentThreadId: "child" };
  const fork = { ...summary("fork", "idle", 50), forkedFromThreadId: "child" };
  const threads = [parent, child, sibling, nested, fork];
  const ids = (visible: string[]) =>
    deriveSidebarThreads(threads, visible).map((entry) => entry.threadId);
  assert.deepEqual(ids([]), ["parent", "fork"]);
  assert.deepEqual(ids(["nested", "missing"]), ["parent", "nested", "fork"]);
  assert.deepEqual(ids(["child", "sibling"]), [
    "parent",
    "child",
    "sibling",
    "fork",
  ]);
  const pins = ["sibling", "parent", "child"];
  const pinned = (visible: string[]) =>
    derivePinnedThreads(deriveSidebarThreads(threads, visible), pins).map(
      (entry) => entry.threadId,
    );
  assert.deepEqual(pinned([]), ["parent"]);
  assert.deepEqual(pinned(["child"]), ["parent", "child"]);
  assert.deepEqual(pinned(["nested"]), ["parent"], "showing does not pin");
  assert.deepEqual(pinned(["child", "sibling"]), [
    "sibling",
    "parent",
    "child",
  ]);
  assert.deepEqual(
    pins,
    ["sibling", "parent", "child"],
    "hiding never clears Pin order",
  );
  assert.equal(nested.parentThreadId, "child");
  assert.equal(threads.length, 5);
});

test("projectless Threads share one visible group while their real cwd stays in native metadata", () => {
  const a = summary("a", "idle", 10),
    b = summary("b", "active", 20);
  const groups = deriveProjectGroups([a, b], {
    projects: [],
    projectlessThreadIds: ["a", "b"],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.label, "No project");
  assert.equal(groups[0]!.workspace, null);
  assert.equal(groups[0]!.configured, false);
  assert.deepEqual(
    groups[0]!.threads.map((t) => t.threadId),
    ["b", "a"],
  );
  assert.deepEqual(
    groups[0]!.threads.map((t) =>
      t.status === "systemError" ? null : t.currentMetadata.cwd,
    ),
    [b.currentMetadata.cwd, a.currentMetadata.cwd],
  );
});
