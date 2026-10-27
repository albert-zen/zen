import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTraceStore } from "../../../src/trace.js";
import {
  emptySidebarState,
  applySidebarPatch,
} from "../src/thread-sidebar-state.js";
import {
  ThreadSidebarStore,
  sidebarOwnerFile,
  sidebarTracePartition,
} from "../src/main/thread-sidebar-store.js";
const owner = { kind: "thread" as const, id: "synthetic" };
const request = { owner, expectedRevision: 0, patch: { open: true } };

test("durable sidebar facts recover without cache and ignore corrupt/stale cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sidebar-log-"));
  try {
    const trace = new FileTraceStore(join(directory, "trace"));
    const store = new ThreadSidebarStore(directory, undefined, trace);
    const changed = await store.update(request, undefined, { kind: "ui" });
    const history = await trace.read(sidebarTracePartition(owner));
    assert.equal(history.records.length, 1);
    assert.equal(history.records[0]!.type, "sidebar_state_changed");
    assert.deepEqual(history.records[0]!.data, {
      fromRevision: 0,
      patch: { open: true },
      state: changed.state,
      source: { kind: "ui" },
    });
    await rm(sidebarOwnerFile(directory, owner));
    assert.deepEqual(
      await new ThreadSidebarStore(directory).read(owner),
      changed.state,
    );
    await writeFile(sidebarOwnerFile(directory, owner), "corrupt cache");
    assert.deepEqual(
      await new ThreadSidebarStore(directory).read(owner),
      changed.state,
    );
    assert.equal(
      JSON.parse(await readFile(sidebarOwnerFile(directory, owner), "utf8"))
        .format,
      "trace-sidebar-cache",
    );
    assert.equal(
      (await trace.read(sidebarTracePartition(owner))).records.length,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy sidebar snapshot seeds exactly one attributed fact, never historical activation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sidebar-legacy-"));
  try {
    const old = applySidebarPatch(emptySidebarState(owner), {
      open: true,
      tabs: [{ kind: "terminal" }],
      selectedTab: "terminal",
    });
    old.revision = 9;
    const bytes = JSON.stringify(old);
    await writeFile(sidebarOwnerFile(directory, owner), bytes);
    assert.deepEqual(await new ThreadSidebarStore(directory).read(owner), old);
    const trace = new FileTraceStore(join(directory, "trace"));
    const first = await trace.read(sidebarTracePartition(owner));
    assert.equal(first.records.length, 1);
    assert.equal(first.records[0]!.type, "sidebar_state_imported");
    assert.deepEqual(first.records[0]!.data, {
      source: "legacy-sidebar-snapshot",
      historicalActivation: "unavailable",
      state: old,
    });
    assert.equal(
      Buffer.from(
        await trace.readArtifact(first.records[0]!.artifacts[0]!.ref),
      ).toString(),
      bytes,
    );
    const resumed = new ThreadSidebarStore(directory);
    assert.deepEqual(await resumed.read(owner), old);
    assert.equal(
      (
        await resumed.update({
          owner,
          expectedRevision: 9,
          patch: { open: false },
        })
      ).state.revision,
      10,
    );
    assert.equal(
      (await trace.read(sidebarTracePartition(owner))).records.filter(
        (r) => r.type === "sidebar_state_imported",
      ).length,
      1,
    );
    await rm(join(directory, "trace"), { recursive: true });
    await assert.rejects(
      new ThreadSidebarStore(directory).read(owner),
      /cache cannot restore authority/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed legacy import does not publish state or replace its source snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sidebar-import-fail-"));
  try {
    const bytes = JSON.stringify(
      applySidebarPatch(emptySidebarState(owner), { open: true }),
    );
    await writeFile(sidebarOwnerFile(directory, owner), bytes);
    const trace = new FileTraceStore(join(directory, "trace"));
    const store = new ThreadSidebarStore(directory, undefined, {
      read: trace.read.bind(trace),
      record: async () => ({
        durability: "degraded",
        error: "fixture disk full",
      }),
    });
    await assert.rejects(store.read(owner), /durability is unconfirmed/);
    assert.equal(
      await readFile(sidebarOwnerFile(directory, owner), "utf8"),
      bytes,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cache write failure cannot undo the durable fact or its notification", async (t) => {
  const warning = t.mock.method(console, "warn", () => {});
  const directory = await mkdtemp(join(tmpdir(), "sidebar-cache-fail-"));
  try {
    const store = new ThreadSidebarStore(directory, async () => {
      throw Error("fixture cache unavailable");
    });
    let notifications = 0;
    store.onChanged(() => {
      notifications++;
    });
    assert.equal((await store.update(request)).applied, true);
    assert.equal(notifications, 1);
    assert.equal(warning.mock.callCount(), 1);
    assert.equal(
      (await new ThreadSidebarStore(directory).read(owner)).revision,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ambiguous append invalidates cached state; next CAS reconciles log without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sidebar-uncertain-"));
  try {
    const trace = new FileTraceStore(join(directory, "trace"));
    let records = 0;
    const store = new ThreadSidebarStore(directory, undefined, {
      read: trace.read.bind(trace),
      record: async (event) => {
        records++;
        await trace.record(event);
        return {
          durability: "degraded",
          error: "synthetic lost durability acknowledgement",
        };
      },
    });
    let notifications = 0;
    store.onChanged(() => {
      notifications++;
    });
    await assert.rejects(store.update(request), /durability is unconfirmed/);
    assert.equal(notifications, 0);
    const retry = await store.update(request);
    assert.equal(retry.applied, false);
    assert.equal(retry.state.revision, 1);
    assert.equal(records, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid revision chain refuses cache fallback and does not accept another mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sidebar-invalid-"));
  try {
    const trace = new FileTraceStore(join(directory, "trace"));
    await new ThreadSidebarStore(directory).update(request);
    await trace.record({
      threadId: sidebarTracePartition(owner),
      type: "sidebar_state_changed",
      data: {
        fromRevision: 9,
        patch: { open: false },
        state: { ...emptySidebarState(owner), revision: 10 },
      },
    });
    const store = new ThreadSidebarStore(directory);
    await assert.rejects(store.read(owner), /revision chain/);
    await assert.rejects(
      store.update({ ...request, expectedRevision: 1 }),
      /revision chain/,
    );
    assert.equal(
      (await trace.read(sidebarTracePartition(owner))).records.length,
      2,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sidebar shutdown drains accepted writes, fences new updates and flushes trace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sidebar-close-"));
  try {
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const trace = new FileTraceStore(join(directory, "trace"));
    let flushed = false;
    const store = new ThreadSidebarStore(directory, undefined, {
      read: trace.read.bind(trace),
      record: async (event) => {
        started();
        await gate;
        return trace.record(event);
      },
      flush: async () => {
        await trace.flush();
        flushed = true;
      },
    });
    const update = store.update(request);
    await began;
    const close = store.close();
    assert.equal(flushed, false);
    await assert.rejects(store.update(request), /closed/);
    release();
    assert.equal((await update).applied, true);
    await close;
    assert.equal(flushed, true);
    assert.equal(
      (await new ThreadSidebarStore(directory).read(owner)).revision,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
