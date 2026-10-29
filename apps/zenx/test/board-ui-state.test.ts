import "./dom-primitives.js";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { BoardSurface } from "../src/renderer/src/board-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";
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

test("an event receipt retires earlier polls, including their late failures", async () => {
  const current = state();
  let reads = 0;
  const pendingRead = deferred<BoardSnapshot>();
  const session = new BoardUiSession(current.document.owner, async (input) => {
    if (input.operation === "read")
      return ++reads === 1 ? current : pendingRead.promise;
    return { snapshot: current, outcomes: [], navigation: [] };
  });
  await session.refresh();
  const read = session.refresh();
  await session.run("action");
  pendingRead.reject(new Error("Obsolete read failed"));
  await read;
  assert.equal(session.error, null);
  assert.equal(session.errorDetail, null);
  assert.ok(session.result);
});

test("an event never replaces a newer local edit even if its receipt has an equal draft revision", async () => {
  const current = state();
  const pending = deferred<unknown>();
  const session = new BoardUiSession(current.document.owner, async (input) => {
    if (input.operation === "read") return current;
    if (input.operation === "draft")
      return { ...current, draftRevision: 1, values: input.values };
    return pending.promise;
  });
  await session.refresh();
  const action = session.run("action");
  await Promise.resolve();
  session.edit({ answer: "new typing" });
  await session.flush();
  pending.resolve({
    snapshot: {
      ...current,
      draftRevision: 1,
      values: { answer: "older action values" },
    },
    outcomes: [],
    navigation: [],
  });
  await action;
  assert.equal(session.values.answer, "new typing");
});

test("owner-readable diagnostics are transient and clear on read, save and action recovery", async () => {
  const current = state();
  const calls: Array<Record<string, unknown>> = [];
  let failure: "read" | "draft" | "event" | null = "read";
  const raw = new Error("Stable summary", {
    cause: new Error("Private local cause"),
  });
  const session = new BoardUiSession(current.document.owner, async (input) => {
    calls.push(input);
    if (input.operation === failure) {
      if (failure === "event")
        return {
          snapshot: current,
          outcomes: [],
          navigation: [],
          error: "Action stopped",
          errorDetail: "Host's exact bounded local diagnostic",
        };
      throw raw;
    }
    if (input.operation === "read") return current;
    if (input.operation === "draft")
      return { ...current, values: input.values };
    return { snapshot: current, outcomes: [], navigation: [] };
  });
  await session.refresh();
  assert.equal(session.error, "Stable summary");
  assert.match(session.errorDetail ?? "", /Private local cause/);
  failure = null;
  await session.refresh();
  assert.equal(session.errorDetail, null);
  failure = "draft";
  session.edit({ answer: "keep me" });
  await assert.rejects(session.flush());
  assert.match(session.errorDetail ?? "", /Private local cause/);
  failure = null;
  await session.flush();
  assert.equal(session.errorDetail, null);
  failure = "event";
  await session.run("action");
  assert.equal(session.errorDetail, "Host's exact bounded local diagnostic");
  failure = null;
  await session.run("action");
  assert.equal(session.error, null);
  assert.equal(session.errorDetail, null);
  assert.ok(calls.every((call) => !("errorDetail" in call)));
  assert.ok(
    calls.every(
      (call) => !JSON.stringify(call).includes("Private local cause"),
    ),
  );
});

test("Board error details are collapsed plain text, clear after recovery, and never cross owners", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const snapshots = new Map<string, BoardSnapshot>();
  for (const threadId of ["details-a", "details-b"]) {
    const snapshot = state();
    snapshot.document.owner = { kind: "thread", threadId };
    snapshot.document.blocks = [
      { id: "action", kind: "action", label: "Run fixture", event: "action" },
    ];
    snapshots.set(threadId, snapshot);
  }
  let failed = true;
  let pending: ReturnType<typeof deferred<unknown>> | null = null;
  const rawDetail = '<img src=x onerror="throw 1"> exact local failure';
  let navigations = 0;
  const sdk = (threadId: string): PluginUiSdkV1 => ({
    version: 1,
    pluginId: "zenx-board",
    theme: "light",
    context: {
      owner: { kind: "thread", threadId },
      admissionId: "error-render-regression",
    },
    navigation: {
      navigate: () => {
        navigations++;
      },
    },
    handles: { read: async () => null },
    commands: {
      execute: async (_command, input) => {
        const request = input as {
          operation: string;
          owner: { threadId: string };
        };
        const snapshot = snapshots.get(request.owner.threadId)!;
        if (request.operation === "read") return snapshot;
        if (pending) return pending.promise;
        return {
          snapshot,
          outcomes: [],
          navigation: ["receipt-not-an-app-route"],
          ...(failed
            ? { error: "Fixture stopped", errorDetail: rawDetail }
            : {}),
        };
      },
    },
  });
  try {
    await act(async () =>
      root.render(React.createElement(BoardSurface, { sdk: sdk("details-a") })),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".board-action")!.click(),
    );
    const details = document.querySelector<HTMLDetailsElement>(
      ".board-error details",
    )!;
    assert.ok(details);
    assert.equal(details.open, false);
    assert.equal(details.querySelector("pre")?.textContent, rawDetail);
    assert.equal(details.querySelector("pre")?.getAttribute("tabindex"), "0");
    assert.equal(details.querySelector("img"), null);
    failed = false;
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".board-action")!.click(),
    );
    assert.equal(document.querySelector(".board-error"), null);
    assert.equal(
      navigations,
      0,
      "Host navigation receipts never become app routes",
    );
    pending = deferred<unknown>();
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".board-action")!.click(),
    );
    await act(async () =>
      root.render(React.createElement(BoardSurface, { sdk: sdk("details-b") })),
    );
    await act(async () =>
      pending!.resolve({
        snapshot: snapshots.get("details-a"),
        outcomes: [],
        navigation: [],
        error: "Only owner A sees this",
        errorDetail: rawDetail,
      }),
    );
    assert.equal(document.querySelector(".board-error"), null);
    assert.ok(!document.body.textContent?.includes(rawDetail));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("failed discard keeps visible fields dirty and cannot submit older saved values", async () => {
  let saved = state();
  let failSave = true;
  let failRead = false;
  const submitted: unknown[] = [];
  const session = new BoardUiSession(saved.document.owner, async (input) => {
    if (input.operation === "read") {
      if (failRead) throw new Error("Discard read failed");
      return structuredClone(saved);
    }
    if (input.operation === "draft") {
      if (failSave) throw new Error("Draft save failed");
      saved = {
        ...saved,
        draftRevision: saved.draftRevision + 1,
        values: input.values as BoardSnapshot["values"],
      };
      return structuredClone(saved);
    }
    submitted.push(structuredClone(saved.values));
    return { snapshot: saved, outcomes: [{ kind: "submit" }], navigation: [] };
  });
  await session.refresh();
  session.edit({ answer: "visible-unsaved" });
  await assert.rejects(session.flush(), /Draft save failed/);
  failRead = true;
  await assert.rejects(session.discardLocalDraft(), /Discard read failed/);
  assert.equal(session.values.answer, "visible-unsaved");
  assert.equal(session.dirty, true);
  await assert.rejects(session.run("submit"), /Draft save failed/);
  assert.deepEqual(submitted, []);
  failSave = false;
  await session.run("submit");
  assert.deepEqual(submitted, [{ answer: "visible-unsaved" }]);
  assert.equal(session.values.answer, "visible-unsaved");
});

test("discard waits for confirmed replacement and never clears newer typing", async () => {
  const saved = state();
  let pendingRead: ReturnType<typeof deferred<BoardSnapshot>> | null = null;
  const session = new BoardUiSession(saved.document.owner, async (input) => {
    if (input.operation === "read")
      return pendingRead?.promise ?? structuredClone(saved);
    throw new Error("Do not save from discard");
  });
  await session.refresh();
  session.edit({ answer: "first local edit" });
  pendingRead = deferred<BoardSnapshot>();
  const discard = session.discardLocalDraft();
  await Promise.resolve();
  assert.equal(session.dirty, true);
  assert.equal(session.values.answer, "first local edit");
  session.edit({ answer: "newer local edit" });
  pendingRead.resolve(saved);
  await assert.rejects(discard, /Newer local typing was preserved/);
  assert.equal(session.values.answer, "newer local edit");
  assert.equal(session.dirty, true);
  pendingRead = null;
  await session.discardLocalDraft();
  assert.equal(session.values.answer, "old");
  assert.equal(session.dirty, false);
  assert.equal(session.error, null);
});
