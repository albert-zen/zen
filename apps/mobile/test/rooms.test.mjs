import assert from "node:assert/strict";
import { test } from "node:test";
import { createSession } from "../src/session.mjs";
import { createAppActions } from "../src/app-actions.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function app(overrides = {}) {
  let observer,
    draft = "",
    pairCode = "",
    pairState = null;
  const roomPosts = [],
    reads = [];
  const transport = {
    snapshot: async (host) => ({
      workspaces: [{ id: "w", name: "Workspace" }],
      threads: [{ id: "thread", title: "Thread", status: "idle" }],
      supportsRooms: true,
      rooms: [{ id: "room", name: `${host} Assistant`, threadId: "thread" }],
    }),
    subscribe: (_host, _workspace, callback) => {
      observer = callback;
      return () => {};
    },
    read: async () => [],
    clearThread() {},
    disconnect() {},
    command: async () => ({ accepted: true }),
    readRoom: async (host, workspace, room) => {
      reads.push([host, workspace, room]);
      return {
        room: {
          id: room,
          name: "Assistant",
          threadId: "thread",
          operationEpoch: "epoch",
        },
        messages: [
          {
            id: host,
            kind: "agent",
            author: "Assistant",
            text: `${host} deliberate reply`,
            createdAt: 1,
          },
        ],
      };
    },
    postRoom: async (host, workspace, room, text) => {
      roomPosts.push([host, workspace, room, text]);
      return {
        messageId: "message",
        threadId: "thread",
        clientId: "epoch:exact-operation",
      };
    },
    ...overrides,
  };
  const session = createSession(transport, () => {});
  const actions = createAppActions(
    session,
    { pair: async () => {} },
    {
      getDraft: () => draft,
      setDraft: (value) => {
        draft = value;
      },
      getPairCode: () => pairCode,
      setPairCode: (value) => {
        pairCode = value;
      },
      setPairState: (value) => {
        pairState = value;
      },
    },
  );
  actions.selectHost("host-a");
  await tick();
  actions.selectWorkspace("w");
  await tick();
  return {
    session,
    actions,
    transport,
    roomPosts,
    reads,
    event: (value) => observer(value),
    draft: () => draft,
    pairState: () => pairState,
  };
}

test("Rooms show deliberate posts, coalesce reads and never invent a reply from Turn completion", async () => {
  const a = await app();
  a.actions.openRoom("room");
  await tick();
  assert.equal(a.session.get().roomReady, true);
  assert.equal(a.session.get().roomMessages[0].text, "host-a deliberate reply");
  a.event({
    type: "snapshot",
    threads: [],
    items: {},
    turns: { thread: [{ id: "turn", status: "completed" }] },
  });
  assert.equal(a.session.get().roomMessages.length, 1);
  const before = a.reads.length;
  a.event({ type: "room", roomId: "other" });
  await tick();
  assert.equal(a.reads.length, before);
  a.event({ type: "room", roomId: "room" });
  await tick();
  assert.equal(a.reads.length, before + 1);
  a.actions.editDraft("hello assistant");
  await a.actions.postRoom();
  await tick();
  assert.equal(a.draft(), "");
  assert.deepEqual(a.roomPosts, [["host-a", "w", "room", "hello assistant"]]);
  assert.equal(a.session.get().lastRequest.messageId, "message");
  assert.equal(
    a.session.get().lastRequest.turnId,
    null,
    "Room receipt does not imply Turn admission",
  );
  a.session.dispose();
});

test("late Room body/receipt and equal new draft cannot cross device or view selection", async () => {
  const body = deferred(),
    receipt = deferred();
  let first = true;
  const a = await app({
    readRoom: async (host) =>
      first
        ? ((first = false), body.promise)
        : {
            room: { id: "room", threadId: "thread", operationEpoch: "epoch" },
            messages: [{ id: host, text: `${host} only` }],
          },
    postRoom: () => receipt.promise,
  });
  a.actions.openRoom("room");
  a.actions.selectHost("host-b");
  await tick();
  a.actions.selectWorkspace("w");
  await tick();
  a.actions.openRoom("room");
  await tick();
  body.resolve({
    room: { id: "room" },
    messages: [{ id: "old", text: "host-a stale" }],
  });
  await tick();
  assert.equal(a.session.get().roomMessages[0].text, "host-b only");
  a.actions.editDraft("X");
  const post = a.actions.postRoom();
  a.actions.openThread("thread");
  await tick();
  a.actions.openRoom("room");
  await tick();
  a.actions.editDraft("X");
  receipt.resolve({
    messageId: "old-post",
    threadId: "thread",
    clientId: "epoch:old",
  });
  await post;
  assert.equal(a.draft(), "X");
  assert.equal(a.session.get().command, "accepted");
  a.session.dispose();
});

test("unknown Room post remains scoped and cannot replay until explicit reconnect and canonical read", async () => {
  let posts = 0;
  const a = await app({
    postRoom: async () => {
      posts++;
      throw Object.assign(Error("socket lost"), {
        clientId: "epoch:exact-operation",
      });
    },
  });
  a.actions.openRoom("room");
  await tick();
  a.actions.editDraft("hello");
  await a.actions.postRoom();
  assert.equal(a.session.get().command, "uncertain");
  await a.actions.postRoom();
  assert.equal(posts, 1);
  a.actions.openThread("thread");
  await tick();
  assert.equal(a.session.get().command, null);
  a.actions.openRoom("room");
  await tick();
  assert.equal(
    a.session.get().command,
    "uncertain",
    "same-connection polls do not release unknown delivery",
  );
  a.actions.selectHost("host-a");
  await tick();
  a.actions.selectWorkspace("w");
  await tick();
  a.actions.openRoom("room");
  await tick();
  assert.equal(a.session.get().command, null);
  assert.equal(posts, 1, "reconnect/read never posts automatically");
  a.session.dispose();
});

test("Room read must complete before posting and failed polls disable further posts", async () => {
  const pending = deferred();
  let succeed = true;
  const a = await app({
    readRoom: () =>
      succeed ? pending.promise : Promise.reject(Error("read failed")),
  });
  a.actions.openRoom("room");
  a.actions.editDraft("hello");
  await a.actions.postRoom();
  assert.equal(a.roomPosts.length, 0);
  pending.resolve({ room: { id: "room" }, messages: [] });
  await tick();
  assert.equal(a.session.get().roomReady, true);
  succeed = false;
  await a.session.refreshRoom();
  assert.equal(a.session.get().roomReady, false);
  await a.actions.postRoom();
  assert.equal(a.roomPosts.length, 0);
  a.event({ type: "offline" });
  assert.deepEqual(a.session.get().roomMessages, []);
  assert.equal(a.session.get().roomReady, false);
  a.session.dispose();
});

test("create-and-open uses exact admitted target/model and ignores superseded creation", async () => {
  const created = deferred();
  const commands = [];
  const a = await app({
    command: (...args) => {
      commands.push(args);
      return created.promise;
    },
  });
  const work = a.actions.createThread({
    model: "provider/model",
    effort: "high",
  });
  assert.deepEqual(commands[0], [
    "host-a",
    "w",
    "create",
    { model: "provider/model", effort: "high" },
  ]);
  created.resolve({ accepted: true, threadId: "created-thread" });
  await work;
  await tick();
  assert.equal(a.session.get().thread, "created-thread");
  assert.equal(a.session.get().room, null);
  const old = deferred();
  a.transport.command = () => old.promise;
  const superseded = a.actions.createThread();
  a.actions.selectHost("host-b");
  await tick();
  old.resolve({ accepted: true, threadId: "old-host-thread" });
  await superseded;
  assert.equal(a.session.get().host, "host-b");
  assert.equal(a.session.get().thread, null);
  a.session.dispose();
});

test("begin pairing clears public Host view before the network pair is started", async () => {
  const a = await app();
  a.actions.openRoom("room");
  await tick();
  a.actions.editDraft("old draft");
  a.session.preparePair();
  assert.equal(a.session.get().host, "host-a");
  assert.equal(a.session.get().status, "pairing");
  assert.deepEqual(a.session.get().roomMessages, []);
  assert.deepEqual(a.session.get().workspaces, []);
  a.session.pairFailed(Error("wrong code"));
  assert.equal(a.session.get().status, "offline");
  a.session.dispose();
});

test("explicit reconnect restores selected Room or Thread and preserves new text without replay", async () => {
  const a = await app();
  a.actions.openRoom("room");
  await tick();
  a.actions.editDraft("unsent room draft");
  a.event({ type: "offline" });
  await a.actions.reconnect();
  await tick();
  assert.equal(a.session.get().host, "host-a");
  assert.equal(a.session.get().workspace, "w");
  assert.equal(a.session.get().room, "room");
  assert.equal(a.session.get().roomReady, true);
  assert.equal(a.draft(), "unsent room draft");
  assert.equal(a.roomPosts.length, 0);
  a.actions.openThread("thread");
  await tick();
  a.actions.editDraft("unsent thread draft");
  a.event({ type: "offline" });
  await a.actions.reconnect();
  await tick();
  assert.equal(a.session.get().thread, "thread");
  assert.equal(a.session.get().room, null);
  assert.equal(a.draft(), "unsent thread draft");
  a.session.dispose();
});
