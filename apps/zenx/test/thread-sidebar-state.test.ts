import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileTraceStore } from "../../../src/trace.js";
import { ThreadSidebarStore } from "../src/main/thread-sidebar-store.js";
import {
  emptySidebarState,
  applySidebarPatch,
  parseSidebarUpdate,
  sidebarTabId,
} from "../src/thread-sidebar-state.js";
import { ThreadSidebarController } from "../src/renderer/src/thread-sidebar-controller.js";
import { WorkspaceFileDrafts } from "../src/renderer/src/workspace-file-drafts.js";

test("typed owner isolation, CAS, restart durability and defensive copies", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sidebar-"));
  try {
    const store = new ThreadSidebarStore(dir);
    const owner = { kind: "thread" as const, id: "same" };
    const room = { kind: "room" as const, id: "same" };
    assert.equal((await store.read(owner)).revision, 0);
    assert.deepEqual(await readdir(dir), []);
    const updates = await Promise.all(
      [true, false].map((open) =>
        store.update({ owner, expectedRevision: 0, patch: { open } }),
      ),
    );
    assert.equal(updates.filter((x) => x.applied).length, 1);
    assert.equal((await store.read(room)).revision, 0);
    const restored = await new ThreadSidebarStore(dir).read(owner);
    assert.equal(restored.open, true);
    assert.equal(restored.revision, 1);
    restored.open = false;
    assert.equal((await store.read(owner)).open, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("failed durable fact does not notify or advance state; queue recovers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sidebar-"));
  let fail = true;
  let events = 0;
  try {
    const trace = new FileTraceStore(path.join(dir, "trace"));
    const store = new ThreadSidebarStore(dir, undefined, {
      read: trace.read.bind(trace),
      record: async (event) => {
        if (fail) throw Error("disk full");
        return trace.record(event);
      },
    });
    store.onChanged(() => events++);
    await assert.rejects(
      store.update({
        owner: "a" as never,
        expectedRevision: 0,
        patch: { open: true },
      }),
      /durability is unconfirmed/,
    );
    assert.equal(events, 0);
    assert.equal((await store.read("a")).revision, 0);
    fail = false;
    assert.equal(
      (
        await store.update({
          owner: { kind: "thread", id: "a" },
          expectedRevision: 0,
          patch: { open: true },
        })
      ).applied,
      true,
    );
    assert.equal(events, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("schema rejects traversal, unknown fields, duplicate tabs and nonexistent selected IDs", () => {
  const owner = { kind: "thread" as const, id: "a" };
  for (const path of ["../x", "/x", "a//b", "C:/x", "a\\b"])
    assert.throws(() =>
      parseSidebarUpdate({
        owner,
        expectedRevision: 0,
        patch: { tabs: [{ kind: "file", path }] },
      }),
    );
  assert.throws(() =>
    parseSidebarUpdate({ owner, expectedRevision: 0, patch: { focus: true } }),
  );
  assert.throws(() =>
    parseSidebarUpdate({
      owner,
      expectedRevision: 0,
      patch: { tabs: [{ kind: "terminal" }, { kind: "terminal" }] },
    }),
  );
  assert.throws(() =>
    applySidebarPatch(emptySidebarState(owner), { selectedTab: "file:no" }),
  );
  assert.notEqual(
    sidebarTabId({ kind: "file", path: "README.md", resourceThreadId: "a" }),
    sidebarTabId({ kind: "file", path: "README.md", resourceThreadId: "b" }),
  );
});
test("controller applies background owner without changing another and ignores stale snapshots", async () => {
  const controller = new ThreadSidebarController();
  await controller.select("b", "terminal");
  const before = controller.get("b");
  controller.accept(
    applySidebarPatch(emptySidebarState("a"), {
      open: true,
      tabs: [{ kind: "file", path: "README.md" }],
      selectedTab: "file:README.md",
    }),
  );
  assert.equal(controller.get("b"), before);
  controller.accept(emptySidebarState("a"));
  assert.equal(controller.get("a")?.revision, 1);
  await controller.remove("a", "file:README.md");
  assert.deepEqual(controller.get("a")?.tabs, []);
  assert.equal(controller.get("b"), before);
});
test("successful dirty close removes persisted descriptor; failure retains it", async () => {
  const controller = new ThreadSidebarController();
  await controller.select("a", "file:README.md");
  await controller.select("b", "terminal");
  const drafts = new WorkspaceFileDrafts();
  drafts.set("a", {
    base: { path: "README.md", text: "old", revision: "1" },
    text: "new",
  });
  drafts.closeAfterSave(
    "a",
    async (text) => ({
      status: "saved",
      file: { path: "README.md", text, revision: "2" },
    }),
    () => {
      void controller.remove("a", "file:README.md");
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(drafts.snapshot().has("a"), false);
  assert.deepEqual(controller.get("a")?.tabs, []);
  assert.equal(controller.get("b")?.selectedTab, "terminal");
  await controller.select("a", "file:README.md");
  drafts.set("a", {
    base: { path: "README.md", text: "old", revision: "1" },
    text: "new",
  });
  drafts.closeAfterSave(
    "a",
    async () => {
      throw Error("disk full");
    },
    () => {
      void controller.remove("a", "file:README.md");
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(drafts.snapshot().get("a")?.error, "disk full");
  assert.equal(controller.get("a")?.tabs.length, 1);
});

test("queued own mutation cannot rebase an explicitly stale whole-list edit", async () => {
  const controller = new ThreadSidebarController();
  controller.accept(
    applySidebarPatch(emptySidebarState("a"), {
      tabs: [{ kind: "file", path: "agent-new.md" }],
    }),
  );
  await Promise.all([
    controller.edit("a", () => ({ open: true })),
    controller.edit("a", () => ({ tabs: [] }), 0),
  ]);
  assert.equal(controller.get("a")?.tabs.length, 1);
});

test("resource-like legal filenames retain their exact owner and path through IDs", async () => {
  const { sidebarTabFromId } = await import("../src/thread-sidebar-state.js");
  for (const path of [
    "@other:README.md",
    "%40README.md",
    "folder/%25name.md",
  ]) {
    for (const resourceThreadId of [undefined, "member:one"]) {
      const tab = {
        kind: "file" as const,
        path,
        ...(resourceThreadId ? { resourceThreadId } : {}),
      };
      assert.deepEqual(sidebarTabFromId(sidebarTabId(tab)), tab);
    }
  }
});
test("Room launcher canonicalizes its selected member-bound descriptor without duplicates", async () => {
  const { roomSidebarPatch } =
    await import("../src/renderer/src/use-thread-sidebar.js");
  const current = emptySidebarState({ kind: "room", id: "r" });
  const patch = roomSidebarPatch(
    undefined,
    { member: "a", tabs: [], selected: "plugin:fixture:panel" },
    current,
  );
  const next = applySidebarPatch(current, patch);
  assert.equal(next.selectedTab, "plugin:@a:fixture:panel");
  assert.equal(next.tabs.length, 1);
});
