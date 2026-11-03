import assert from "node:assert/strict";
import test from "node:test";
import { ZenXBoardCapabilityPackage } from "../src/main/capabilities/board-package.js";
import {
  boardModelDefinition,
  decodeBoardArguments,
  projectBoardResult,
} from "../src/main/capabilities/model-board-facade.js";
import {
  BoardUiSession,
  boardUiSessionKey,
} from "../src/renderer/src/board-ui-state.js";
import { ModelReferenceRegistry } from "../../../src/model-references.js";
import type {
  BoardDocument,
  BoardOwner,
} from "../../../packages/zenx-board-plugin/src/board.js";
import { boardDocumentKey } from "../../../packages/zenx-board-plugin/src/board.js";

const thread: BoardOwner = { kind: "thread", threadId: "synthetic-thread" };
const room: BoardOwner = {
  kind: "room",
  roomId: "synthetic-room",
  threadId: thread.threadId,
};
const first = "board:11111111-1111-4111-8111-111111111111";
const second = "board:22222222-2222-4222-8222-222222222222";
const epoch = "synthetic-epoch";
function document(owner = thread, title = "Synthetic Board"): BoardDocument {
  return {
    // Authored body identity is deliberately the same across independent documents.
    id: "plan",
    title,
    summary: "Synthetic independent document fixture",
    owner,
    blocks: [{ id: "field", kind: "field", field: "choice", label: "Choice" }],
    initialValues: { choice: "initial" },
    events: [
      {
        id: "set",
        label: "Set locally",
        actions: [{ kind: "set", values: { choice: "event" } }],
      },
      {
        id: "run",
        label: "Run",
        actions: [{ kind: "script", command: "echo synthetic" }],
      },
    ],
  };
}
function fixture() {
  let stored: Record<string, unknown> = {};
  let writes = 0;
  const storage = {
    version: 1,
    get: async () => structuredClone(stored),
    set: async (value: unknown) => {
      writes++;
      stored = structuredClone(value) as Record<string, unknown>;
    },
  };
  const service = new ZenXBoardCapabilityPackage({
    readResourceOwner: async (value) => value,
    readOwner: async (owner) => owner,
    deliver: async () => ({ status: "accepted" }),
    execute: async () => ({ exitCode: 0, output: "synthetic" }),
    navigate: async () => {},
  });
  service.start({ storage });
  const invoke = (
    name: string,
    args: Record<string, unknown>,
    ui = false,
    threadId = thread.threadId,
  ) =>
    service.invoke(name, {
      name,
      callId: "synthetic-call",
      cwd: "/synthetic",
      arguments: ui ? { input: args } : args,
      threadId,
      signal: new AbortController().signal,
      ...(ui ? { trustedPluginUi: true as const } : {}),
    }) as Promise<any>;
  return {
    service,
    storage,
    invoke,
    writes: () => writes,
    put: (
      instanceKey: string | undefined,
      owner = thread,
      title?: string,
      expectedRevision = 0,
    ) =>
      invoke("zenx_board_put", {
        instanceKey,
        document: document(owner, title),
        expectedRevision,
      }),
    read: (instanceKey: string | undefined, owner = thread) =>
      invoke("zenx_board_read", { instanceKey, owner, view: "document" }),
    ui: (
      instanceKey: string | undefined,
      operation: string,
      args: Record<string, unknown> = {},
      owner: unknown = thread,
    ) =>
      invoke("zenx_board_ui", { instanceKey, operation, owner, ...args }, true),
  };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("independent Thread documents share authored IDs but isolate bodies, CAS, drafts and local events", async () => {
  const f = fixture();
  const absent = await f.read(first);
  assert.equal(absent.exists, false);
  assert.equal(absent.contentSnapshot.instanceKey, first);
  assert.equal(f.writes(), 0);
  const created = await Promise.all([
    f.put(first, thread, "First"),
    f.put(second, thread, "Second"),
  ]);
  assert.deepEqual(
    created.map((result) => result.applied),
    [true, true],
  );
  await f.ui(first, "draft", {
    values: { choice: "first draft" },
    expectedDraftRevision: 0,
  });
  await f.ui(second, "event", {
    eventId: "set",
    revision: 1,
    draftRevision: 0,
  });
  const a = await f.read(first);
  const b = await f.read(second);
  assert.equal(a.document.id, b.document.id);
  assert.equal(a.document.title, "First");
  assert.equal(b.document.title, "Second");
  assert.equal(a.instanceKey, first);
  assert.equal(b.instanceKey, second);
  assert.equal(a.values.choice, "first draft");
  assert.equal(b.values.choice, "event");
  assert.equal(a.draftRevision, 1);
  assert.equal(b.draftRevision, 1);
  assert.equal((await f.put(first, thread, "Replacement", 1)).applied, true);
  assert.equal((await f.put(second, thread, "Stale", 0)).applied, false);
  assert.equal((await f.read(second)).document.title, "Second");
  assert.equal((await f.read(first)).values.choice, "first draft");
  assert.equal(await f.ui(undefined, "read"), null);
});

test("omitted and explicit default addresses retain legacy storage and API shapes", async () => {
  const f = fixture();
  await f.invoke("zenx_board_put", {
    document: document(),
    expectedRevision: 0,
  });
  assert.deepEqual(Object.keys((await f.storage.get()).boards as object), [
    `thread:${thread.threadId}`,
  ]);
  const legacy = await f.invoke("zenx_board_read", { view: "document" });
  assert.deepEqual(await f.read("default"), legacy);
  assert.equal("instanceKey" in legacy, false);
  assert.equal("instanceKey" in legacy.contentSnapshot, false);
  assert.equal(
    (await f.put("default", thread, "Default replacement", 1)).applied,
    true,
  );
  await f.put(first);
  assert.equal((await f.read("default")).document.title, "Default replacement");
  assert.equal((await f.read(first)).revision, 1);
});

test("same instanceKey is isolated across Thread and Room owners and cannot cross calling Threads", async () => {
  const f = fixture();
  await f.put(first, thread, "Thread");
  await f.put(first, room, "Room");
  assert.equal((await f.read(first)).document.title, "Thread");
  assert.equal((await f.read(first, room)).document.title, "Room");
  await assert.rejects(
    f.invoke(
      "zenx_board_read",
      { owner: thread, instanceKey: first },
      false,
      "other-thread",
    ),
    /calling Thread/,
  );
  await assert.rejects(
    f.invoke(
      "zenx_board_put",
      { document: document(thread), instanceKey: first, expectedRevision: 1 },
      false,
      "other-thread",
    ),
    /calling Thread/,
  );
  const otherOwner = { kind: "thread", threadId: "other-thread" };
  assert.equal(
    (
      await f.invoke(
        "zenx_board_read",
        { instanceKey: first, owner: otherOwner },
        false,
        "other-thread",
      )
    ).exists,
    false,
  );
});

test("legacy Room creator metadata is decoded without rewriting product state", async () => {
  const f = fixture();
  const key = boardDocumentKey(room, first);
  await f.storage.set({
    boards: {
      [key]: {
        instanceKey: first,
        document: document(room, "Legacy workspace body"),
        revision: 7,
        draftRevision: 3,
        values: { choice: "unsent" },
        pinned: true,
      },
    },
  });
  const writes = f.writes();
  const other = { ...room, threadId: "other-thread" };
  const result = await f.invoke(
    "zenx_board_read",
    { owner: other, view: "document", instanceKey: first },
    false,
    other.threadId,
  );
  assert.deepEqual(result.document.owner, {
    kind: "room",
    roomId: room.roomId,
  });
  assert.equal(result.revision, 7);
  assert.equal(result.draftRevision, 3);
  assert.equal(result.values.choice, "unsent");
  assert.equal(result.pinned, true);
  assert.equal(f.writes(), writes);
  const persisted = (await f.storage.get()) as any;
  assert.equal(
    persisted.boards[key].document.owner.threadId,
    room.threadId,
    "Pure reads do not migrate or re-author the legacy resource",
  );
});

test("Room resource UI is independent of author membership and execution is explicitly admitted", async () => {
  const f = fixture();
  const other = { ...room, threadId: "other-thread" };
  await f.put(first, room, "First member");
  await f.invoke(
    "zenx_board_put",
    {
      instanceKey: second,
      document: document(other, "Second member"),
      expectedRevision: 0,
    },
    false,
    other.threadId,
  );
  const roomOnly = { kind: "room" as const, roomId: room.roomId };
  let memberRemoved = false;
  let workspaceRemoved = false;
  f.service.host.readOwner = async (owner) => {
    if (memberRemoved) throw Error("Synthetic member removed");
    return owner;
  };
  f.service.host.readResourceOwner = async (owner) => {
    if (workspaceRemoved) throw Error("Synthetic workspace removed");
    assert.deepEqual(owner, roomOnly);
    return owner;
  };
  const value = await f.ui(second, "read", {}, roomOnly);
  assert.deepEqual(value.document.owner, roomOnly);
  assert.equal((await f.read(second, room)).document.title, "Second member");
  let executor: BoardOwner | undefined;
  f.service.host.execute = async (owner) => {
    executor = owner;
    return { exitCode: 0, output: "synthetic" };
  };
  await assert.rejects(
    f.ui(
      second,
      "event",
      { eventId: "run", revision: 1, draftRevision: 0 },
      roomOnly,
    ),
    /explicit current Room member/,
  );
  await f.ui(
    second,
    "event",
    {
      eventId: "run",
      revision: 1,
      draftRevision: 0,
      executionThreadId: other.threadId,
    },
    roomOnly,
  );
  assert.deepEqual(executor, other);
  memberRemoved = true;
  assert.deepEqual(
    (await f.ui(second, "read", {}, roomOnly)).document.owner,
    roomOnly,
  );
  await f.ui(
    second,
    "draft",
    { values: { choice: "workspace draft" }, expectedDraftRevision: 0 },
    roomOnly,
  );
  await assert.rejects(
    f.ui(
      second,
      "event",
      {
        eventId: "run",
        revision: 1,
        draftRevision: 1,
        executionThreadId: other.threadId,
      },
      roomOnly,
    ),
    /member removed/,
  );
  workspaceRemoved = true;
  await assert.rejects(f.ui(second, "read", {}, roomOnly), /workspace removed/);
});

test("invalid document addresses fail before reading owner or product storage", async () => {
  const f = fixture();
  let ownerChecks = 0;
  f.service.host.readOwner = async (owner) => {
    ownerChecks++;
    return owner;
  };
  for (const instanceKey of [
    null,
    1,
    "",
    " ",
    "../other",
    "__proto__",
    "constructor",
    "prototype",
    "a".repeat(129),
  ]) {
    await assert.rejects(f.invoke("zenx_board_read", { instanceKey }));
    await assert.rejects(
      f.invoke("zenx_board_put", {
        instanceKey,
        document: document(),
        expectedRevision: 0,
      }),
    );
    await assert.rejects(f.ui(instanceKey as string, "read"));
  }
  assert.equal(ownerChecks, 0);
  assert.equal(f.writes(), 0);
});

test("independent actions do not lock or cancel sibling documents; same-document replacement does", async () => {
  const f = fixture();
  await f.put(first);
  await f.put(second);
  const entered = gate();
  const blocked = gate();
  let signal: AbortSignal | undefined;
  f.service.host.execute = async (_owner, _action, currentSignal) => {
    signal = currentSignal;
    entered.release();
    await blocked.promise;
    currentSignal.throwIfAborted();
    return { exitCode: 0, output: "synthetic" };
  };
  const running = f.ui(first, "event", {
    eventId: "run",
    revision: 1,
    draftRevision: 0,
  });
  await entered.promise;
  await f.ui(second, "event", {
    eventId: "set",
    revision: 1,
    draftRevision: 0,
  });
  await f.ui(second, "navigate", {
    target: { kind: "url", url: "https://example.test/synthetic" },
    revision: 1,
  });
  await f.put(second, thread, "Sibling replacement", 1);
  assert.equal(signal!.aborted, false);
  await assert.rejects(
    f.ui(first, "event", { eventId: "set", revision: 1, draftRevision: 0 }),
    /already running/,
  );
  await f.put(first, thread, "Own replacement", 1);
  assert.equal(signal!.aborted, true);
  blocked.release();
  assert.match((await running).error, /document changed/);
  assert.equal((await f.read(second)).values.choice, "event");
});

test("Room UI checks live workspace again after a delayed storage read", async () => {
  const f = fixture();
  await f.put(first, room);
  const entered = gate();
  const blocked = gate();
  let removed = false;
  f.service.host.readResourceOwner = async (owner) => {
    if (removed) throw Error("Synthetic workspace removed");
    return owner;
  };
  f.service.start({
    storage: {
      ...f.storage,
      get: async () => {
        entered.release();
        await blocked.promise;
        return f.storage.get();
      },
    },
  });
  const draft = f.ui(
    first,
    "draft",
    { values: { choice: "revoked" }, expectedDraftRevision: 0 },
    room,
  );
  await entered.promise;
  removed = true;
  blocked.release();
  await assert.rejects(draft, /workspace removed/);
  assert.equal(f.writes(), 1);
});

function modelFixture() {
  const refs = new ModelReferenceRegistry().scope(thread.threadId);
  return {
    refs,
    decode: (
      name: string,
      args: Record<string, unknown>,
      capabilityEpoch = epoch,
    ) => decodeBoardArguments(name, args, refs, capabilityEpoch),
    project: (result: Record<string, unknown>) =>
      projectBoardResult(result, refs, epoch, {
        output: JSON.stringify(result),
        exitCode: 0,
      }),
  };
}

test("model read and opaque snapshots bind exact independent document; put cannot retarget", async () => {
  const f = fixture();
  const model = modelFixture();
  assert.deepEqual(
    model.decode("zenx_board_read", { instanceKey: first, view: "document" }),
    { instanceKey: first, view: "document", owner: thread },
  );
  const absent = model.project(await f.read(first));
  const body: Partial<BoardDocument> = document();
  delete body.owner;
  const decoded = model.decode("zenx_board_put", {
    snapshot: absent.snapshot,
    document: body,
  });
  assert.equal(decoded.instanceKey, first);
  assert.equal(decoded.expectedRevision, 0);
  await f.invoke("zenx_board_put", decoded);
  assert.equal((await f.read(second)).exists, false);
  const full = model.project(await f.read(first));
  assert.equal(full.instanceKey, first);
  for (const args of [
    { snapshot: full.snapshot, document: body, instanceKey: second },
    { snapshot: full.snapshot, document: { ...body, instanceKey: second } },
  ]) {
    await assert.rejects(async () =>
      f.invoke("zenx_board_put", model.decode("zenx_board_put", args)),
    );
  }
  assert.throws(() =>
    model.decode(
      "zenx_board_put",
      { snapshot: full.snapshot, document: body },
      "new-epoch",
    ),
  );
  const changedId = { ...body, id: "changedContentIdentity" };
  delete (changedId as Partial<BoardDocument>).owner;
  const replacement = model.decode("zenx_board_put", {
    snapshot: full.snapshot,
    document: changedId,
  });
  assert.equal(replacement.instanceKey, first);
  assert.equal((await f.invoke("zenx_board_put", replacement)).applied, true);
  assert.equal((await f.read(first)).document.id, "changedContentIdentity");
  assert.equal((await f.read(second)).exists, false);
});

test("model cannot reuse foreign, compact, conflict or mismatched-address snapshots", async () => {
  const f = fixture();
  const model = modelFixture();
  await f.put(first);
  const compact = model.project(
    await f.invoke("zenx_board_read", { instanceKey: first }),
  );
  const conflict = model.project(await f.put(first));
  for (const value of [compact, conflict])
    assert.throws(
      () =>
        model.decode("zenx_board_put", {
          snapshot: value.snapshot,
          document: document(),
        }),
      /view:document/,
    );
  const full = model.project(await f.read(first));
  const foreign = new ModelReferenceRegistry().scope(
    "foreign-thread",
    model.refs.newBindings,
  );
  assert.throws(() =>
    decodeBoardArguments(
      "zenx_board_put",
      { snapshot: full.snapshot, document: document() },
      foreign,
      epoch,
    ),
  );
  const inconsistent = await f.read(first);
  inconsistent.instanceKey = second;
  assert.throws(() => model.project(inconsistent), /address|instance|snapshot/);
});

test("model schema exposes read instance address but put uses only snapshot and authored document", () => {
  const source = (name: string) => ({
    name,
    description: "Synthetic",
    inputSchema: { type: "object" as const },
  });
  const read = boardModelDefinition(source("zenx_board_read"))
    .inputSchema as any;
  const put = boardModelDefinition(source("zenx_board_put")).inputSchema as any;
  assert.equal(read.properties.instanceKey.type, "string");
  assert.equal(read.properties.instanceKey.maxLength, 128);
  assert.equal("instanceKey" in put.properties, false);
  assert.equal("instanceKey" in put.properties.document.properties, false);
});

test("renderer sessions route every draft, action, pin and read to their exact independent address", async () => {
  const f = fixture();
  await f.put(first);
  await f.put(second);
  const calls: Record<string, unknown>[] = [];
  const session = (instanceKey: string) =>
    new BoardUiSession(
      thread,
      async (input) => {
        calls.push(input);
        return f.invoke("zenx_board_ui", input, true);
      },
      instanceKey,
    );
  const a = session(first);
  const b = session(second);
  await Promise.all([a.refresh(), b.refresh()]);
  a.edit({ choice: "first local" });
  b.edit({ choice: "second local" });
  await Promise.all([a.flush(), b.flush()]);
  await a.run("set");
  await b.pin(true);
  await b.discardLocalDraft();
  assert.equal(a.values.choice, "event");
  assert.equal(b.values.choice, "second local");
  assert.equal((await f.read(first)).pinned, false);
  assert.equal((await f.read(second)).pinned, true);
  assert.ok(
    calls.every(
      (input) => input.instanceKey === first || input.instanceKey === second,
    ),
  );
  assert.notEqual(
    boardUiSessionKey(thread, first, "same-admission"),
    boardUiSessionKey(thread, second, "same-admission"),
  );
  assert.notEqual(
    boardUiSessionKey(thread, first, "same-admission"),
    boardUiSessionKey(thread, first, "new-admission"),
  );
  assert.equal(
    boardUiSessionKey(thread, undefined),
    boardUiSessionKey(thread, "default"),
  );
});

test("renderer refuses sibling document receipts even when authored IDs and revisions match", async () => {
  const f = fixture();
  await f.put(first);
  await f.put(second);
  let wrong = false;
  let actions = 0;
  const a = new BoardUiSession(
    thread,
    async (input) => {
      if (input.operation === "event") actions++;
      if (input.operation === "read")
        return f.ui(wrong ? second : first, "read");
      return f.invoke("zenx_board_ui", { ...input, instanceKey: second }, true);
    },
    first,
  );
  await a.refresh();
  a.edit({ choice: "keep exact local draft" });
  await assert.rejects(a.run("set"), /different document/);
  assert.equal(actions, 0);
  assert.equal(a.dirty, true);
  assert.equal(a.values.choice, "keep exact local draft");
  wrong = true;
  await a.refresh();
  assert.match(a.error!, /different document/);
  assert.equal(a.snapshot?.instanceKey, first);
});

test("an unconfirmed independent save is not automatically replayed", async () => {
  const f = fixture();
  await f.put(first);
  let attempts = 0;
  const a = new BoardUiSession(
    thread,
    async (input) => {
      if (input.operation === "read") return f.ui(first, "read");
      attempts++;
      throw Error("Synthetic unconfirmed storage outcome");
    },
    first,
  );
  await a.refresh();
  a.edit({ choice: "retained" });
  await assert.rejects(a.flush(), /unconfirmed/);
  await a.refresh();
  assert.equal(attempts, 1);
  assert.equal(a.dirty, true);
  assert.equal(a.values.choice, "retained");
});
