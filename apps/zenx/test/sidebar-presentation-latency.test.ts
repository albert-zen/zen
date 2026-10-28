import assert from "node:assert/strict";
import test from "node:test";
import { ThreadSidebarController } from "../src/renderer/src/thread-sidebar-controller.js";
import {
  emptySidebarState,
  applySidebarPatch,
  type ThreadSidebarApi,
} from "../src/thread-sidebar-state.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const gate = deferred();
  let stored = emptySidebarState("a");
  const api = {
    read: async () => stored,
    update: async (request) => {
      await gate.promise;
      stored = applySidebarPatch(stored, request.patch);
      return { applied: true, state: stored };
    },
    onChanged: () => () => {},
  } satisfies ThreadSidebarApi;
  const controller = new ThreadSidebarController(api);
  controller.accept(stored);
  return { controller, gate, api };
}

test("opening and fullscreen paint before disk acknowledgement without advancing authority", async () => {
  const { controller, gate } = fixture();
  const update = controller.edit("a", () => ({ open: true, fullscreen: true }));
  assert.equal(controller.snapshot()["thread:a"]?.open, true);
  assert.equal(controller.snapshot()["thread:a"]?.fullscreen, true);
  assert.equal(controller.get("a")?.open, false);
  assert.equal(controller.snapshot()["thread:a"]?.revision, 0);
  gate.resolve();
  await update;
  assert.equal(controller.get("a")?.open, true);
  assert.equal(controller.get("a")?.revision, 1);
});
test("rapid open close open retains newest visual intent while earlier facts settle", async () => {
  const { controller, gate } = fixture();
  const updates = [true, false, true].map((open) =>
    controller.edit("a", () => ({ open })),
  );
  assert.equal(controller.snapshot()["thread:a"]?.open, true);
  gate.resolve();
  await Promise.all(updates);
  assert.equal(controller.get("a")?.revision, 3);
  assert.equal(controller.snapshot()["thread:a"]?.open, true);
});
test("failed presentation write rolls back and exposes actual error, never optimistic authority", async () => {
  const { controller, gate, api } = fixture();
  api.update = async () => {
    await gate.promise;
    throw Error("fixture disk unavailable");
  };
  const update = controller.edit("a", () => ({ open: true }));
  assert.equal(controller.snapshot()["thread:a"]?.open, true);
  gate.resolve();
  await update;
  assert.equal(controller.snapshot()["thread:a"]?.open, false);
  assert.equal(controller.get("a")?.revision, 0);
  assert.match(controller.error()!, /fixture disk unavailable/);
});
test("resource changes and explicit stale presentation edits are not optimistically accepted", async () => {
  const { controller, gate } = fixture();
  const update = controller.edit("a", () => ({
    tabs: [{ kind: "terminal" }],
    selectedTab: "terminal",
    open: true,
  }));
  assert.equal(controller.snapshot()["thread:a"]?.open, false);
  gate.resolve();
  await update;
  await controller.edit("a", () => ({ open: false }), 0);
  assert.equal(controller.snapshot()["thread:a"]?.open, true);
  assert.match(controller.error()!, /changed elsewhere/);
});

test("slow real Trace and snapshot writes do not block visual open or close", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { FileTraceStore } = await import("../../../src/trace.js");
  const { ThreadSidebarStore } =
    await import("../src/main/thread-sidebar-store.js");
  const directory = await mkdtemp(join(tmpdir(), "sidebar-latency-"));
  const traceGate = deferred(),
    cacheGate = deferred();
  const traceStarted = deferred(),
    cacheStarted = deferred();
  const trace = new FileTraceStore(join(directory, "trace"));
  const store = new ThreadSidebarStore(
    directory,
    async (file, bytes) => {
      cacheStarted.resolve();
      await cacheGate.promise;
      await writeFile(file, bytes);
    },
    {
      read: trace.read.bind(trace),
      record: async (event) => {
        traceStarted.resolve();
        await traceGate.promise;
        return trace.record(event);
      },
    },
  );
  const controller = new ThreadSidebarController({
    read: store.read.bind(store),
    update: store.update.bind(store),
    onChanged: store.onChanged.bind(store),
  });
  try {
    await controller.load("a");
    const pending = controller.edit("a", () => ({ open: true }));
    await traceStarted.promise;
    assert.equal(controller.snapshot()["thread:a"]!.open, true);
    assert.equal(controller.get("a")!.open, false);
    traceGate.resolve();
    await cacheStarted.promise;
    assert.equal(controller.snapshot()["thread:a"]!.open, true);
    assert.equal(controller.get("a")!.revision, 0);
    cacheGate.resolve();
    await pending;
    assert.equal(controller.get("a")!.revision, 1);
    assert.equal(
      (await new ThreadSidebarStore(directory).read("a")).open,
      true,
    );
    const close = controller.edit("a", () => ({ open: false }));
    assert.equal(controller.snapshot()["thread:a"]!.open, false);
    await close;
    assert.equal(
      (await new ThreadSidebarStore(directory).read("a")).open,
      false,
    );
  } finally {
    traceGate.resolve();
    cacheGate.resolve();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pending foreground presentation stays isolated among many loaded owners", async () => {
  const { controller, gate } = fixture();
  for (let i = 0; i < 2000; i++)
    controller.accept(emptySidebarState(`synthetic-${i}`));
  const pending = controller.edit("a", () => ({ open: true }));
  assert.equal(controller.snapshot()["thread:a"]!.open, true);
  assert.equal(controller.snapshot()["thread:synthetic-1999"]!.open, false);
  const remote = applySidebarPatch(emptySidebarState("synthetic-3"), {
    fullscreen: true,
  });
  controller.accept(remote);
  assert.equal(controller.snapshot()["thread:a"]!.open, true);
  assert.equal(controller.snapshot()["thread:synthetic-3"]!.fullscreen, true);
  gate.resolve();
  await pending;
});

test("cold open paints while historical sidebar recovery is still pending", async () => {
  const readGate = deferred();
  const stored = applySidebarPatch(emptySidebarState("cold"), {
    tabs: [{ kind: "terminal" }],
    selectedTab: "terminal",
  });
  const controller = new ThreadSidebarController({
    read: async () => {
      await readGate.promise;
      return stored;
    },
    update: async (request) => ({
      applied: true,
      state: applySidebarPatch(stored, request.patch),
    }),
    onChanged: () => () => {},
  });
  const pending = controller.edit("cold", () => ({ open: true }));
  assert.equal(controller.snapshot()["thread:cold"]!.open, true);
  assert.equal(controller.get("cold"), undefined);
  readGate.resolve();
  await pending;
  assert.equal(controller.get("cold")!.selectedTab, "terminal");
  assert.equal(controller.snapshot()["thread:cold"]!.open, true);
  assert.equal(controller.get("cold")!.revision, 2);
});

test("preview validation does not turn an async edit failure into an uncaught click exception", async () => {
  const controller = new ThreadSidebarController();
  await controller.edit("a", () => {
    throw Error("invalid synthetic edit");
  });
  assert.match(controller.error()!, /invalid synthetic edit/);
  assert.equal(controller.get("a"), undefined);
});
