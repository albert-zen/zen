import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  NativeInformationService,
  type NativeInformationRoom,
} from "../src/main/native-information-service.js";
import { captureNativeInformationDocument } from "../src/main/native-information-document.js";
import { ThreadSidebarStore } from "../src/main/thread-sidebar-store.js";
import {
  emptySidebarState,
  type ThreadSidebarPort,
} from "../src/thread-sidebar-state.js";
import type { NativeInformationSnapshot } from "../src/native-information.js";

const thread = { kind: "thread" as const, id: "synthetic-thread-a" };
const room = { kind: "room" as const, id: "synthetic-room" };
const other = "synthetic-thread-b";
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "native-information-"));
  const store = new ThreadSidebarStore(directory);
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  let rooms: NativeInformationRoom[] = [
    {
      id: room.id,
      assistant: { threadId: thread.id },
      members: [
        { threadId: thread.id, name: "A" },
        { threadId: other, name: "B" },
      ],
    },
  ];
  let beforeUpdate: (() => void | Promise<void>) | undefined;
  let duringThreadRead: (() => void | Promise<void>) | undefined;
  const known = new Set([thread.id, other]);
  const reads: string[] = [];
  let updates = 0;
  let ids = 0;
  const port: ThreadSidebarPort = {
    read: store.read.bind(store),
    async update(...args) {
      updates++;
      await beforeUpdate?.();
      return store.update(...args);
    },
  };
  const native = new NativeInformationService({
    sidebar: port,
    rooms: () => rooms,
    async assertThreadExists(id) {
      reads.push(id);
      await duringThreadRead?.();
      if (!known.has(id)) throw Error("Unknown real Thread");
    },
    newId: () => `synthetic-instance-${++ids}`,
  });
  // Synthetic trusted entry point. Production must supply its document lease.
  const service = {
    read: (
      input: Parameters<NativeInformationService["read"]>[0],
      admit = () => {},
    ) => native.read(input, admit),
    update: (input: unknown, admit = () => {}) => native.update(input, admit),
    readSidebar: native.readSidebar.bind(native),
    updateSidebar: native.updateSidebar.bind(native),
  };
  const update = (
    snapshot: NativeInformationSnapshot,
    operations: unknown[],
    extra = {},
  ) =>
    service.update({
      owner: snapshot.owner,
      expectedRevision: snapshot.revision,
      basis: snapshot.basis,
      operations,
      ...extra,
    });
  return {
    service,
    store,
    known,
    reads,
    update,
    setRooms(value: NativeInformationRoom[]) {
      rooms = value;
    },
    getRooms: () => rooms,
    beforeUpdate(fn: typeof beforeUpdate) {
      beforeUpdate = fn;
    },
    duringThreadRead(fn: typeof duringThreadRead) {
      duringThreadRead = fn;
    },
    updates: () => updates,
  };
}

test("native read verifies real owners without saving defaults, provider reads, or PAW owner invention", async (t) => {
  const f = await fixture(t);
  const value = await f.service.read(thread);
  assert.equal(value.revision, 0);
  assert.equal((await f.store.read(thread)).informationLayout, undefined);
  assert.ok(f.reads.includes(thread.id));
  assert.equal((await f.service.read(room)).owner.kind, "room");
  await assert.rejects(
    f.service.read({ kind: "thread", id: "forged" }),
    /Unknown real Thread/,
  );
  await assert.rejects(
    f.service.read({ kind: "room", id: "forged" }),
    /Room.*unavailable/,
  );
  await assert.rejects(
    f.service.read({ kind: "paw", id: room.id } as never),
    /Invalid sidebar owner/,
  );
});

test("empty Room has no invented Thread defaults or member admission", async (t) => {
  const f = await fixture(t);
  f.setRooms([
    { id: room.id, assistant: { threadId: "stale-assistant" }, members: [] },
  ]);
  const value = await f.service.read(room);
  assert.deepEqual(value.members, []);
  assert.equal(value.resourceThreadId, undefined);
  assert.deepEqual(
    value.layout.widgets.map((widget) => widget.type),
    ["room-members", "board"],
  );
  await assert.rejects(
    f.update(value, [{ op: "add", type: "shell" }]),
    /Choose a current Room member/,
  );
  const ownerOnly = await f.update(value, [{ op: "add", type: "board" }]);
  assert.equal(ownerOnly.applied, true);
  assert.ok(
    ownerOnly.layout.widgets.every((widget) => widget.binding.kind === "owner"),
  );
});

test("native adds mint identities and checked bindings; current-member edits exceed Agent caller authority only here", async (t) => {
  const f = await fixture(t);
  const value = await f.service.read(room);
  const added = await f.update(
    value,
    [{ op: "add", type: "triggers", config: { filter: "timer" } }],
    { resourceThreadId: other },
  );
  const widget = added.layout.widgets.at(-1)!;
  assert.equal(widget.id, "synthetic-instance-1");
  assert.deepEqual(widget.binding, { kind: "member", resourceThreadId: other });
  const changed = await f.update(
    added,
    [{ op: "set", id: widget.id, config: { showPaused: false } }],
    { resourceThreadId: thread.id },
  );
  assert.equal(changed.applied, true);
  const result = changed.layout.widgets.at(-1)!;
  assert.deepEqual(result.binding, widget.binding);
  assert.deepEqual(result.config, { filter: "timer", showPaused: false });
});

test("native rejects forged identities/bindings/full replacement/default input and keeps old sidebar channel closed", async (t) => {
  const f = await fixture(t);
  const value = await f.service.read(room);
  for (const operations of [
    [
      {
        op: "add",
        type: "shell",
        binding: { kind: "member", resourceThreadId: "forged" },
      },
    ],
    [{ op: "add", type: "shell", id: "forged" }],
    [{ op: "add", widget: value.layout.widgets[0], before: null }],
    [{ op: "reset", defaults: value.layout }],
    [
      {
        op: "set",
        id: value.layout.widgets[0]!.id,
        binding: { kind: "owner" },
      },
    ],
  ])
    await assert.rejects(f.update(value, operations));
  await assert.rejects(
    f.update(value, [{ op: "add", type: "shell" }], {
      resourceThreadId: "forged",
    }),
    /current member/,
  );
  await assert.rejects(
    f.service.update({
      owner: room,
      expectedRevision: 0,
      basis: value.basis,
      operations: [{ op: "reset" }],
      layout: value.layout,
    }),
    /Unknown native/,
  );
  for (const informationLayout of [
    value.layout,
    { operations: [{ op: "remove", id: value.layout.widgets[0]!.id }] },
    undefined,
  ])
    await assert.rejects(
      f.service.updateSidebar(
        { owner: room, expectedRevision: 0, patch: { informationLayout } },
        () => {},
      ),
      /native operation API/,
    );
  assert.equal(f.updates(), 0);
});

test("CAS conflict returns exact current layout without retry or mutation of submitted draft", async (t) => {
  const f = await fixture(t);
  const value = await f.service.read(thread);
  const draft = [
    { op: "set", id: value.layout.widgets[0]!.id, visible: false },
  ];
  const first = await f.update(value, [{ op: "add", type: "board" }]);
  const conflict = await f.update(value, draft);
  assert.equal(conflict.applied, false);
  assert.deepEqual(conflict.layout, first.layout);
  assert.deepEqual(draft, [
    { op: "set", id: value.layout.widgets[0]!.id, visible: false },
  ]);
  assert.equal(f.updates(), 1);
  const reapplied = await f.update(conflict, draft);
  assert.equal(reapplied.applied, true);
});

test("first-edit and saved reset basis fence actual PAW assistant changes", async (t) => {
  const f = await fixture(t);
  const before = await f.service.read(room);
  f.getRooms()[0]!.assistant = { threadId: other };
  const conflict = await f.update(before, [{ op: "reset" }]);
  assert.equal(conflict.applied, false);
  assert.equal(conflict.resourceThreadId, other);
  const saved = await f.update(conflict, [{ op: "reset" }]);
  f.getRooms()[0]!.assistant = { threadId: thread.id };
  assert.equal((await f.update(saved, [{ op: "reset" }])).applied, false);
});

test("member removal while queued rejects new binding without any commit", async (t) => {
  const f = await fixture(t);
  const value = await f.service.read(room);
  f.beforeUpdate(() => {
    f.getRooms()[0]!.members = [{ threadId: thread.id }];
  });
  await assert.rejects(
    f.update(value, [{ op: "add", type: "shell" }], {
      resourceThreadId: other,
    }),
    /current member/,
  );
  assert.equal((await f.store.read(room)).revision, 0);
});

test("post-await owner/document/default revocation is checked inside the owner queue", async (t) => {
  const f = await fixture(t);
  const value = await f.service.read(room);
  f.beforeUpdate(() => {
    f.duringThreadRead(() => {
      f.getRooms()[0]!.members = [];
    });
  });
  await assert.rejects(
    f.update(value, [{ op: "add", type: "shell" }], {
      resourceThreadId: other,
    }),
    /current member/,
  );
  assert.equal((await f.store.read(room)).revision, 0);
  f.duringThreadRead(undefined);
  f.setRooms([
    {
      id: room.id,
      assistant: { threadId: thread.id },
      members: [{ threadId: thread.id }],
    },
  ]);
  f.beforeUpdate(() => {
    f.getRooms()[0]!.assistant = undefined;
  });
  await assert.rejects(
    f.update(value, [{ op: "remove", id: value.layout.widgets[0]!.id }]),
    /default binding changed/,
  );
  assert.equal((await f.store.read(room)).revision, 0);
});

test("orphan placements can be moved/hidden/removed/reset but never re-shown, configured, or rebound", async (t) => {
  const f = await fixture(t);
  const original = await f.service.read(room);
  const added = await f.update(original, [{ op: "add", type: "shell" }], {
    resourceThreadId: other,
  });
  const id = added.layout.widgets.at(-1)!.id;
  f.getRooms()[0]!.members = [{ threadId: thread.id }];
  const current = await f.service.read(room);
  const hidden = await f.update(
    current,
    [{ op: "set", id, visible: false, collapsed: true }],
    { resourceThreadId: other },
  );
  assert.equal(hidden.applied, true);
  await assert.rejects(
    f.update(hidden, [{ op: "set", id, visible: true }]),
    /current member/,
  );
  await assert.rejects(
    f.update(hidden, [{ op: "set", id, config: {} }]),
    /current member/,
  );
  const reset = await f.update(hidden, [{ op: "reset" }]);
  assert.equal(
    reset.layout.widgets.find((widget) => widget.id === id)!.visible,
    false,
  );
  const removed = await f.update(reset, [{ op: "remove", id }]);
  assert.equal(removed.applied, true);
  assert.equal(
    removed.layout.widgets.some((widget) => widget.id === id),
    false,
  );
});

test("old sidebar presentation/resources retain behavior and cannot forge another owner's resource", async (t) => {
  const f = await fixture(t);
  const result = await f.service.updateSidebar(
    {
      owner: room,
      expectedRevision: 0,
      patch: {
        open: true,
        resourceThreadId: other,
        tabs: [{ kind: "terminal", resourceThreadId: other }],
        selectedTab: `terminal:@${other}`,
      },
    },
    () => {},
  );
  assert.equal(result.applied, true);
  assert.equal(result.state.open, true);
  assert.deepEqual(result.state.tabs, [
    { kind: "terminal", resourceThreadId: other },
  ]);
  await assert.rejects(
    f.service.updateSidebar(
      {
        owner: thread,
        expectedRevision: 0,
        patch: { resourceThreadId: other },
      },
      () => {},
    ),
    /current member/,
  );
  await assert.rejects(
    f.service.updateSidebar(
      {
        owner: room,
        expectedRevision: 1,
        patch: { tabs: [{ kind: "terminal", resourceThreadId: "forged" }] },
      },
      () => {},
    ),
    /current member/,
  );
  const sideChat = await f.service.updateSidebar(
    {
      owner: thread,
      expectedRevision: 0,
      patch: {
        tabs: [{ kind: "thread", threadId: other }],
        selectedTab: `thread:${other}`,
      },
    },
    () => {},
  );
  assert.equal(sideChat.applied, true);
  f.getRooms()[0]!.members = [];
  assert.equal(
    (
      await f.service.updateSidebar(
        {
          owner: room,
          expectedRevision: 1,
          patch: { open: false, tabs: result.state.tabs },
        },
        () => {},
      )
    ).applied,
    true,
  );
});

test("unknown write outcome is propagated once with no automatic replay", async () => {
  let writes = 0;
  const service = new NativeInformationService({
    sidebar: {
      read: async () => emptySidebarState(thread),
      update: async () => {
        writes++;
        throw Error("durability unconfirmed");
      },
    },
    rooms: () => [],
    assertThreadExists: async () => {},
  });
  const value = await service.read(thread, () => {});
  await assert.rejects(
    service.update(
      {
        owner: thread,
        expectedRevision: 0,
        basis: value.basis,
        operations: [{ op: "reset" }],
      },
      () => {},
    ),
    /durability unconfirmed/,
  );
  assert.equal(writes, 1);
});

test("trusted current main document required, including same-URL reload and post-read navigation", async (t) => {
  const rendererUrl = "file:///synthetic/renderer/index.html";
  for (const override of [
    { ownedWindow: false },
    { mainFrame: false },
    { url: "https://foreign.test" },
    { url: `${rendererUrl}?forged=1` },
    { destroyed: true },
  ]) {
    assert.throws(
      () =>
        captureNativeInformationDocument({
          rendererUrl,
          sender: () => ({
            ownedWindow: true,
            mainFrame: true,
            url: rendererUrl,
            document: {},
            destroyed: false,
            ...override,
          }),
          onDocumentNavigation: () => () => {},
        }),
      /trusted ZenX main document/,
    );
  }
  const f = await fixture(t);
  let invalidate = () => {};
  let unsubscribed = false;
  let document = {};
  const guard = captureNativeInformationDocument({
    rendererUrl,
    sender: () => ({
      ownedWindow: true,
      mainFrame: true,
      url: `${rendererUrl}#main`,
      document,
      destroyed: false,
    }),
    onDocumentNavigation: (callback) => {
      invalidate = callback;
      return () => {
        unsubscribed = true;
      };
    },
  });
  guard.admit();
  const snapshot = await f.service.read(thread, guard.admit);
  f.beforeUpdate(() => {
    invalidate();
  });
  await assert.rejects(
    f.service.update(
      {
        owner: thread,
        expectedRevision: 0,
        basis: snapshot.basis,
        operations: [{ op: "reset" }],
      },
      guard.admit,
    ),
    /trusted ZenX main document/,
  );
  assert.equal((await f.store.read(thread)).revision, 0);
  guard.close();
  assert.equal(unsubscribed, true);
  assert.throws(guard.admit, /trusted ZenX main document/);
  const replaced = captureNativeInformationDocument({
    rendererUrl,
    sender: () => ({
      ownedWindow: true,
      mainFrame: true,
      url: rendererUrl,
      document,
      destroyed: false,
    }),
    onDocumentNavigation: () => () => {},
  });
  document = {};
  assert.throws(replaced.admit, /trusted ZenX main document/);
  replaced.close();
});
