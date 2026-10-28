import assert from "node:assert/strict";
import test from "node:test";
import { BoardUiSession } from "../src/renderer/src/board-ui-state.js";
import type { BoardSnapshot } from "../../../packages/zenx-board-plugin/src/board.js";
const state = (): BoardSnapshot => ({
  revision: 1,
  draftRevision: 0,
  pinned: false,
  values: { answer: "old" },
  document: {
    id: "test",
    title: "Test",
    summary: "Synthetic",
    owner: { kind: "thread", threadId: "thread-a" },
    blocks: [],
    events: [],
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
test("agent document refresh preserves unsent fields; save does not erase edits typed while waiting", async () => {
  let current = state();
  const pending = deferred<BoardSnapshot>();
  let saveCount = 0;
  const session = new BoardUiSession(current.document.owner, async (input) => {
    if (input.operation === "read") return structuredClone(current);
    if (input.operation === "draft") {
      saveCount++;
      return saveCount === 1
        ? pending.promise
        : { ...current, draftRevision: 2, values: input.values };
    }
    throw new Error("unused");
  });
  await session.refresh();
  session.edit({ answer: "draft" });
  current = {
    ...current,
    revision: 2,
    document: { ...current.document, title: "Agent updated" },
  };
  await session.refresh();
  assert.equal(session.values.answer, "draft");
  assert.equal(session.snapshot?.revision, 2);
  const save = session.flush();
  session.edit({ answer: "newer typing" });
  pending.resolve({
    ...current,
    draftRevision: 1,
    values: { answer: "draft" },
  });
  await save;
  assert.equal(session.values.answer, "newer typing");
  assert.equal(session.dirty, true);
  await session.flush();
  assert.equal(session.values.answer, "newer typing");
  assert.equal(session.dirty, false);
});
test("failed saves retain the exact unsent draft and never dispatch an event", async () => {
  const calls: unknown[] = [];
  const current = state();
  const session = new BoardUiSession(current.document.owner, async (input) => {
    if (input.operation === "read") return current;
    calls.push(input);
    throw new Error("disk write failed");
  });
  await session.refresh();
  session.edit({ answer: "keep me" });
  await assert.rejects(session.run("submit"), /disk write failed/);
  assert.equal(session.values.answer, "keep me");
  assert.equal(session.dirty, true);
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as any).operation, "draft");
});
test("duplicate clicks while admission is pending dispatch once, preserve chat-independent state", async () => {
  const pending = deferred<unknown>();
  let count = 0;
  const current = state();
  const session = new BoardUiSession(current.document.owner, async (input) => {
    if (input.operation === "read") return current;
    count++;
    return pending.promise;
  });
  await session.refresh();
  const action = session.run("send", {
    composed: "arbitrary custom composition",
  });
  await assert.rejects(session.run("send"), /already running/);
  pending.resolve({
    snapshot: current,
    outcomes: [{ kind: "submit", result: { admission: "accepted" } }],
    navigation: [],
  });
  await action;
  assert.equal(count, 1);
  assert.equal(session.values.answer, "old");
  assert.equal(session.values.composed, undefined);
});
test("another window's draft is not silently adopted over a dirty local field", async () => {
  let current = state();
  const session = new BoardUiSession(current.document.owner, async (input) => {
    if (input.operation !== "read") throw new Error("conflict");
    return structuredClone(current);
  });
  await session.refresh();
  session.edit({ answer: "local" });
  current = { ...current, draftRevision: 1, values: { answer: "remote" } };
  await session.refresh();
  assert.equal(session.values.answer, "local");
  assert.match(session.error ?? "", /another view/);
  // Dispose the pending debounce through an explicit failed save; no ambient retry loop.
  await assert.rejects(session.flush(), /conflict/);
});

test("late action receipt never overwrites fields saved while a script was running", async () => {
  let current = state();
  const pending = deferred<unknown>();
  const session = new BoardUiSession(current.document.owner, async (input) => {
    if (input.operation === "read") return structuredClone(current);
    if (input.operation === "draft") {
      current = {
        ...current,
        draftRevision: 1,
        values: input.values as BoardSnapshot["values"],
      };
      return structuredClone(current);
    }
    return pending.promise;
  });
  await session.refresh();
  const action = session.run("script");
  await Promise.resolve();
  session.edit({ answer: "typed while running" });
  await session.flush();
  pending.resolve({
    snapshot: state(),
    outcomes: [{ kind: "script" }],
    navigation: [],
  });
  await action;
  assert.equal(session.values.answer, "typed while running");
  assert.equal(session.snapshot?.draftRevision, 1);
});

test("a click never rebinds to actions replaced while its draft is saving", async () => {
  const current = state();
  const calls: Array<Record<string, unknown>> = [];
  const session = new BoardUiSession(current.document.owner, async (input) => {
    calls.push(input);
    if (input.operation === "read") return current;
    if (input.operation === "draft")
      return {
        ...current,
        revision: 2,
        draftRevision: 1,
        values: input.values,
      };
    throw new Error("event must not dispatch");
  });
  await session.refresh();
  session.edit({ answer: "save this" });
  await assert.rejects(session.run("send"), /Board changed while saving/);
  assert.equal(calls.filter((call) => call.operation === "event").length, 0);
  assert.equal(session.values.answer, "save this");
});
test("a read begun before a successful save cannot roll the saved draft backward", async () => {
  const current = state();
  let reads = 0;
  const oldRead = deferred<BoardSnapshot>();
  const session = new BoardUiSession(current.document.owner, async (input) => {
    if (input.operation === "read")
      return ++reads === 1 ? current : oldRead.promise;
    return { ...current, draftRevision: 1, values: input.values };
  });
  await session.refresh();
  const refresh = session.refresh();
  session.edit({ answer: "keep this" });
  await session.flush();
  oldRead.resolve(current);
  await refresh;
  assert.equal(session.values.answer, "keep this");
  assert.equal(session.snapshot?.draftRevision, 1);
});

test("a successful refresh clears a recovered read error; successful retry clears failed action state", async () => {
  let failRead = true;
  let failAction = true;
  const current = state();
  const session = new BoardUiSession(current.document.owner, async (input) => {
    if (input.operation === "read") {
      if (failRead) throw new Error("Temporary read failure");
      return current;
    }
    if (failAction) throw new Error("Temporary action failure");
    return {
      snapshot: current,
      outcomes: [{ kind: "submit" }],
      navigation: [],
    };
  });
  await session.refresh();
  assert.match(session.error ?? "", /Temporary read failure/);
  failRead = false;
  await session.refresh();
  assert.equal(session.error, null);
  await assert.rejects(session.run("send"), /Temporary action failure/);
  failAction = false;
  await session.run("send");
  assert.equal(session.error, null);
  assert.equal(session.result?.outcomes.length, 1);
});
