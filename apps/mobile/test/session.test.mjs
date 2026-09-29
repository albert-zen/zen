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
