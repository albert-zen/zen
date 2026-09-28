import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../src/session.mjs";
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("switching devices and workspaces discards stale snapshots, subscriptions and thread data", async () => {
  const first = deferred(),
    callbacks = [],
    removed = [];
  const transport = {
    snapshot: (h, w) =>
      h === "a" && !w
        ? first.promise
        : Promise.resolve({
            workspaces: [{ id: "w" }],
            threads: [{ id: h + ":" + w }],
          }),
    subscribe: (h, w, cb) => {
      callbacks.push(cb);
      return () => removed.push(h + ":" + w);
    },
    read: async () => [],
    command: async () => ({ accepted: true }),
  };
  const session = createSession(transport, () => {});
  session.selectHost("a");
  session.selectHost("b");
  await tick();
  first.resolve({ workspaces: [{ id: "old" }], threads: [{ id: "old" }] });
  await tick();
  assert.deepEqual(session.get().workspaces, [{ id: "w" }]);
  session.selectWorkspace("w");
  await tick();
  assert.deepEqual(removed, ["b:null"]);
  callbacks[0]({ type: "offline" });
  assert.equal(session.get().status, "connected");
  assert.equal(session.get().thread, null);
  assert.deepEqual(session.get().items, []);
});
test("uncertain delivery never becomes accepted or auto-retried", async () => {
  let calls = 0;
  const transport = {
    snapshot: async () => ({ workspaces: [], threads: [] }),
    subscribe: () => () => {},
    read: async () => [],
    command: async () => {
      calls++;
      throw Error("timeout");
    },
  };
  const session = createSession(transport, () => {});
  session.selectHost("a");
  await tick();
  session.selectWorkspace("w");
  await tick();
  await session.command("send", { text: "hello" });
  assert.equal(session.get().command, "uncertain");
  assert.match(session.get().error, /Do not retry/);
  assert.equal(calls, 1);
  await session.command("send", { text: "hello" });
  assert.equal(
    calls,
    1,
    "uncertain delivery cannot get a second clientId by a second tap",
  );
});
test("late command acknowledgement cannot cross host boundary", async () => {
  const pending = deferred();
  const transport = {
    snapshot: async () => ({ workspaces: [], threads: [] }),
    subscribe: () => () => {},
    read: async () => [],
    command: () => pending.promise,
  };
  const session = createSession(transport, () => {});
  session.selectHost("a");
  await tick();
  session.selectWorkspace("w");
  await tick();
  const result = session.command("send", {});
  session.selectHost("b");
  pending.resolve({ accepted: true });
  await result;
  assert.equal(session.get().host, "b");
  assert.equal(session.get().command, null);
});
test("stale read and repeat refresh never resurrect old items or duplicate subscriptions", async () => {
  const read = deferred();
  let active = 0;
  const transport = {
    snapshot: async () => ({
      workspaces: [{ id: "w" }],
      threads: [{ id: "t" }],
    }),
    subscribe: () => {
      active++;
      return () => {
        active--;
      };
    },
    read: () => read.promise,
    command: async () => ({ accepted: true }),
  };
  const session = createSession(transport, () => {});
  session.selectHost("a");
  await tick();
  session.selectWorkspace("w");
  await tick();
  session.openThread("t");
  await session.command("create", {});
  assert.equal(active, 1);
  session.selectWorkspace("other");
  read.resolve([{ id: "old" }]);
  await tick();
  assert.deepEqual(session.get().items, []);
  assert.equal(active, 1);
});
test("explicit Host rejection is distinct from unknown network delivery", async () => {
  const transport = {
    snapshot: async () => ({ workspaces: [], threads: [] }),
    subscribe: () => () => {},
    read: async () => [],
    command: async () => {
      throw Object.assign(Error("Host operation_forbidden"), {
        confirmedRejection: true,
      });
    },
  };
  const session = createSession(transport, () => {});
  session.selectHost("a");
  await tick();
  session.selectWorkspace("w");
  await tick();
  await session.command("send", { text: "x" });
  assert.equal(session.get().command, null);
  assert.match(session.get().error, /operation_forbidden/);
});
test("Host reset clears visible Thread and never turns unknown send into a confirmed retry", async () => {
  let observer;
  let calls = 0;
  const transport = {
    snapshot: async () => ({
      workspaces: [{ id: "w" }],
      threads: [{ id: "t" }],
    }),
    subscribe: (_h, _w, cb) => {
      observer = cb;
      return () => {};
    },
    read: async () => [{ id: "old", text: "old" }],
    command: async () => {
      calls++;
      throw Error("socket died");
    },
  };
  const session = createSession(transport, () => {});
  session.selectHost("a");
  await tick();
  session.selectWorkspace("w");
  await tick();
  session.openThread("t");
  await tick();
  assert.equal(session.get().items[0].text, "old");
  await session.command("send", { threadId: "t", text: "hello" });
  observer({ type: "resync" });
  assert.deepEqual(session.get().items, []);
  assert.equal(session.get().command, "uncertain");
  await session.command("send", { threadId: "t", text: "hello" });
  assert.equal(calls, 1);
});
test("revoke and ordinary disconnect clear projection without losing unknown send fence", async () => {
  let observer,
    calls = 0;
  const transport = {
    snapshot: async () => ({ workspaces: [], threads: [] }),
    subscribe: (_h, _w, cb) => {
      observer = cb;
      return () => {};
    },
    read: async () => [{ id: "secret", text: "body" }],
    command: async () => {
      calls++;
      throw Error("lost ack");
    },
    disconnect() {},
  };
  const s = createSession(transport, () => {});
  s.selectHost("h");
  await tick();
  s.selectWorkspace("w");
  await tick();
  s.openThread("a");
  await tick();
  await s.command("send", { threadId: "a", text: "x" });
  assert.equal(s.get().command, "uncertain");
  observer({ type: "offline", revoked: true });
  assert.deepEqual(s.get().items, []);
  assert.deepEqual(s.get().turns, []);
  assert.match(s.get().error, /revoked/);
  s.openThread("a");
  await tick();
  await s.command("send", { threadId: "a", text: "x" });
  assert.equal(calls, 1, "same connection must not clear unknown fence");
  s.selectHost("h");
  await tick();
  s.selectWorkspace("w");
  await tick();
  s.openThread("a");
  await tick();
  assert.equal(
    s.get().command,
    null,
    "explicit reconnect + full canonical read releases fence",
  );
  await s.command("send", { threadId: "a", text: "new" });
  assert.equal(calls, 2);
  observer({ type: "offline" });
  assert.deepEqual(s.get().items, []);
  assert.match(s.get().error, /Disconnected/);
});
test("same-workspace A late ack/reject and read errors cannot change B; A unknown stays fenced", async () => {
  const readA = deferred(),
    cmdA = deferred();
  let calls = [];
  const transport = {
    snapshot: async () => ({ workspaces: [], threads: [] }),
    subscribe: () => () => {},
    read: (_h, _w, id) =>
      id === "a" ? readA.promise : Promise.resolve([{ id: "b", text: "B" }]),
    command: (_h, _w, _k, p) => {
      calls.push(p.threadId);
      return p.threadId === "a"
        ? cmdA.promise
        : Promise.resolve({ accepted: true, turnId: "b-turn" });
    },
  };
  const s = createSession(transport, () => {});
  s.selectHost("h");
  await tick();
  s.selectWorkspace("w");
  await tick();
  s.openThread("a");
  const old = s.command("send", { threadId: "a", text: "A" });
  s.openThread("b");
  await tick();
  assert.deepEqual(s.get().items, [{ id: "b", text: "B" }]);
  assert.equal(s.get().command, null);
  await s.command("send", { threadId: "b", text: "B" });
  assert.equal(s.get().lastRequest.turnId, "b-turn");
  readA.reject(Error("old page failed"));
  cmdA.reject(Error("unknown delivery"));
  await old;
  await tick();
  assert.equal(s.get().thread, "b");
  assert.equal(s.get().lastRequest.turnId, "b-turn");
  assert.deepEqual(s.get().items, [{ id: "b", text: "B" }]);
  s.openThread("a");
  await tick();
  assert.equal(s.get().command, "uncertain");
  await s.command("send", { threadId: "a", text: "A again" });
  assert.deepEqual(calls, ["a", "b"]);
});
test("same Thread old read and old ack never overwrite a new read or canonical failed status", async () => {
  const slow = deferred(),
    ack = deferred();
  let reads = 0,
    observer;
  const transport = {
    snapshot: async () => ({ workspaces: [], threads: [] }),
    subscribe: (_h, _w, cb) => {
      observer = cb;
      return () => {};
    },
    read: () =>
      ++reads === 1
        ? slow.promise
        : Promise.resolve([{ id: "new", text: "new" }]),
    command: () => ack.promise,
  };
  const s = createSession(transport, () => {});
  s.selectHost("h");
  await tick();
  s.selectWorkspace("w");
  await tick();
  s.openThread("a");
  const send = s.command("send", { threadId: "a", text: "x" });
  s.openThread("a");
  await tick();
  observer({
    type: "snapshot",
    threads: [],
    items: { a: [{ id: "new", text: "new" }] },
    turns: { a: [{ id: "turn-x", status: "failed" }] },
  });
  slow.resolve([{ id: "old", text: "old" }]);
  ack.resolve({ accepted: true, turnId: "turn-x" });
  await send;
  await tick();
  assert.deepEqual(s.get().items, [{ id: "new", text: "new" }]);
  assert.deepEqual(s.get().turns, [{ id: "turn-x", status: "failed" }]);
  assert.equal(s.get().lastRequest, null);
});
test("canonical live and recovered Turn outcomes override request admission without guessing from thread idle", async () => {
  let observer;
  const ack = deferred();
  const transport = {
    snapshot: async () => ({
      workspaces: [],
      threads: [{ id: "a", status: "idle" }],
    }),
    subscribe: (_h, _w, cb) => {
      observer = cb;
      return () => {};
    },
    read: async () => [{ id: "user", text: "ask" }],
    command: () => ack.promise,
  };
  const s = createSession(transport, () => {});
  s.selectHost("h");
  await tick();
  s.selectWorkspace("w");
  await tick();
  s.openThread("a");
  await tick();
  const send = s.command("send", { threadId: "a", text: "ask" });
  observer({
    type: "snapshot",
    threads: [{ id: "a", status: "idle" }],
    items: { a: [{ id: "user", text: "ask" }] },
    turns: { a: [{ id: "turn-f", status: "failed" }] },
  });
  ack.resolve({ accepted: true, turnId: "turn-f" });
  await send;
  assert.equal(s.get().command, "accepted");
  assert.deepEqual(s.get().lastRequest, { kind: "send", turnId: "turn-f" });
  assert.equal(s.get().turns[0].status, "failed");
  observer({
    type: "snapshot",
    threads: [{ id: "a", status: "idle" }],
    items: { a: [{ id: "done", text: "done" }] },
    turns: {
      a: [
        { id: "turn-f", status: "failed" },
        { id: "turn-c", status: "completed" },
        { id: "turn-i", status: "interrupted" },
      ],
    },
  });
  assert.deepEqual(
    s.get().turns.map((t) => t.status),
    ["failed", "completed", "interrupted"],
  );
});
test("late workspace refresh after disconnect cannot re-expose stale public view", async () => {
  let observer;
  const late = deferred();
  let calls = 0;
  const transport = {
    snapshot: () =>
      ++calls === 3
        ? late.promise
        : Promise.resolve({ workspaces: [], threads: [] }),
    subscribe: (_h, _w, cb) => {
      observer = cb;
      return () => {};
    },
    read: async () => [{ id: "secret", text: "old" }],
    command: async () => ({ accepted: true, turnId: "t" }),
  };
  const s = createSession(transport, () => {});
  s.selectHost("h");
  await tick();
  s.selectWorkspace("w");
  await tick();
  s.openThread("a");
  await tick();
  const send = s.command("send", { threadId: "a", text: "x" });
  await tick();
  observer({ type: "offline", revoked: true });
  late.resolve({ workspaces: [], threads: [{ id: "a", status: "idle" }] });
  await send;
  assert.equal(s.get().status, "offline");
  assert.deepEqual(s.get().items, []);
  assert.deepEqual(s.get().turns, []);
});
test("A late admission cannot refresh or re-subscribe B workspace view", async () => {
  const a = deferred();
  let snapshots = 0,
    subscriptions = 0;
  const tr = {
    snapshot: async () => {
      snapshots++;
      return { workspaces: [], threads: [] };
    },
    subscribe: () => {
      subscriptions++;
      return () => {};
    },
    read: async () => [],
    command: (_h, _w, _k, p) =>
      p.threadId === "a" ? a.promise : Promise.resolve({ accepted: false }),
  };
  const s = createSession(tr, () => {});
  s.selectHost("h");
  await tick();
  s.selectWorkspace("w");
  await tick();
  s.openThread("a");
  await tick();
  const late = s.command("send", { threadId: "a", text: "a" });
  s.openThread("b");
  await tick();
  const before = [snapshots, subscriptions];
  a.resolve({ accepted: true, turnId: "a-turn" });
  await late;
  assert.deepEqual([snapshots, subscriptions], before);
  assert.equal(s.get().thread, "b");
  assert.equal(s.get().lastRequest, null);
});
