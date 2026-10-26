import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ThreadSidebarStore,
  sidebarOwnerFile,
} from "../src/main/thread-sidebar-store.js";
import {
  resolveSidebarScope,
  bindSidebarResources,
} from "../src/main/sidebar-tool-scope.js";
import {
  emptySidebarState,
  applySidebarPatch,
} from "../src/thread-sidebar-state.js";
const room = {
  id: "r",
  name: "R",
  assistant: { threadId: "a" },
  members: [{ threadId: "a" }, { threadId: "b" }],
};
test("trusted scope defaults only dedicated PAW; ordinary membership stays private", () => {
  assert.deepEqual(resolveSidebarScope("a", undefined, [room]).effectiveScope, {
    kind: "room",
    id: "r",
  });
  assert.deepEqual(resolveSidebarScope("b", undefined, [room]).effectiveScope, {
    kind: "thread",
    id: "b",
  });
  assert.throws(() =>
    resolveSidebarScope("a", undefined, [room, { ...room, id: "r2" }]),
  );
  assert.throws(() =>
    resolveSidebarScope("b", { kind: "thread", id: "a" }, [room]),
  );
  assert.throws(() =>
    resolveSidebarScope("z", { kind: "room", id: "r" }, [room]),
  );
});
test("binds caller and forbids inventing foreign resource while preserving existing", () => {
  const state = emptySidebarState({ kind: "room", id: "r" });
  const bound = bindSidebarResources([{ kind: "file", path: "x" }], state, "a");
  assert.equal(bound[0]!.resourceThreadId, "a");
  assert.throws(() =>
    bindSidebarResources(
      [{ kind: "file", path: "x", resourceThreadId: "b" }],
      state,
      "a",
    ),
  );
  const foreign = { kind: "file" as const, path: "x", resourceThreadId: "b" };
  assert.deepEqual(
    bindSidebarResources([foreign], { ...state, tabs: [foreign] }, "a"),
    [foreign],
  );
});
test("CAS persistence and separate typed owner identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sidebar-review-"));
  try {
    const store = new ThreadSidebarStore(dir);
    const [a, b] = await Promise.all([
      store.update({
        owner: { kind: "thread", id: "x" },
        expectedRevision: 0,
        patch: { open: true },
      }),
      store.update({
        owner: { kind: "thread", id: "x" },
        expectedRevision: 0,
        patch: { fullscreen: true },
      }),
    ]);
    assert.equal(a.applied, true);
    assert.equal(b.applied, false);
    assert.equal(b.state.fullscreen, false);
    assert.equal((await store.read({ kind: "room", id: "x" })).revision, 0);
    assert.equal((await new ThreadSidebarStore(dir).read("x")).open, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("failed persistence does not notify/commit, queue recovers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sidebar-review-"));
  let fail = true;
  let notifications = 0;
  const store = new ThreadSidebarStore(dir, async (file, data) => {
    if (fail) throw Error("disk");
    await writeFile(file, data);
  });
  store.onChanged(() => notifications++);
  try {
    await assert.rejects(
      store.update({
        owner: { kind: "thread", id: "a" },
        expectedRevision: 0,
        patch: { open: true },
      }),
    );
    assert.equal(notifications, 0);
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
    assert.equal(notifications, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("admission checked after queued write; other owner is independent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sidebar-review-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const began = new Promise<void>((resolve) => (started = resolve));
  const store = new ThreadSidebarStore(dir, async (file, data) => {
    if (file.startsWith(sidebarOwnerFile(dir, "a"))) {
      started();
      await gate;
    }
    await writeFile(file, data);
  });
  try {
    const first = store.update({
      owner: { kind: "thread", id: "a" },
      expectedRevision: 0,
      patch: { open: true },
    });
    await began;
    let member = true;
    const second = store.update(
      {
        owner: { kind: "thread", id: "a" },
        expectedRevision: 1,
        patch: { fullscreen: true },
      },
      () => {
        if (!member) throw Error("revoked");
      },
    );
    member = false;
    assert.equal(
      (
        await store.update({
          owner: { kind: "thread", id: "b" },
          expectedRevision: 0,
          patch: { open: true },
        })
      ).applied,
      true,
    );
    release();
    await first;
    await assert.rejects(second, /revoked/);
    assert.equal((await store.read("a")).fullscreen, false);
  } finally {
    release();
    await rm(dir, { recursive: true, force: true });
  }
});

test("self-control uses trusted invocation scope and reports CAS conflicts without visibility claims", async () => {
  const { ZenXSelfControlCapabilityPackage } =
    await import("../src/main/capabilities/self-control-package.js");
  const dir = await mkdtemp(join(tmpdir(), "sidebar-tool-"));
  try {
    const store = new ThreadSidebarStore(dir);
    const service = new ZenXSelfControlCapabilityPackage({
      sidebar: store,
      sidebarRooms: () => [room],
      appServer: { request: async () => ({ thread: { id: "a" } }) } as never,
    });
    const invoke = (
      name: string,
      args: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) =>
      service.invoke(name, {
        name,
        callId: "fixture",
        arguments: args,
        cwd: dir,
        signal: new AbortController().signal,
        threadId: "a",
        ...extra,
      });
    const read = (await invoke("zenx_self_control_sidebar_read", {})) as {
      visibility: string;
      effectiveScope: unknown;
    };
    assert.equal(read.visibility, "not-observed");
    assert.deepEqual(read.effectiveScope, { kind: "room", id: "r" });
    const updated = (await invoke("zenx_self_control_sidebar_update", {
      expectedRevision: 0,
      patch: {
        tabs: [{ kind: "file", path: "README.md" }],
        selectedTab: "file:README.md",
        open: true,
      },
    })) as { applied: boolean; state: { selectedTab: string } };
    assert.equal(updated.applied, true);
    assert.equal(updated.state.selectedTab, "file:@a:README.md");
    const stale = (await invoke("zenx_self_control_sidebar_update", {
      expectedRevision: 0,
      patch: { open: false },
    })) as { applied: boolean };
    assert.equal(stale.applied, false);
    assert.equal((await store.read({ kind: "thread", id: "a" })).revision, 0);
    await assert.rejects(
      invoke("zenx_self_control_sidebar_read", {
        scope: { kind: "thread", id: "b" },
      }),
    );
    await assert.rejects(
      invoke("zenx_self_control_sidebar_read", {}, { threadId: undefined }),
    );
    await assert.rejects(
      invoke("zenx_self_control_sidebar_read", {}, { trustedPluginUi: {} }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
