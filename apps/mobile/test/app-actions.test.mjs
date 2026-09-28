import { test } from "node:test";
import assert from "node:assert/strict";
import { createAppActions } from "../src/app-actions.mjs";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const view = () => {
  let host = "a",
    workspace = "w",
    thread = "a",
    draft = "",
    code = "code-a",
    pairState = null;
  const pairCalls = [],
    sendCalls = [];
  let pair = deferred(),
    send = deferred();
  const session = {
    get: () => ({ host, workspace, thread }),
    selectHost: (x) => {
      host = x;
    },
    selectWorkspace: (x) => {
      workspace = x;
    },
    openThread: (x) => {
      thread = x;
    },
    command: (_k, p) => {
      sendCalls.push(p);
      return send.promise;
    },
  };
  const actions = createAppActions(
    session,
    {
      pair: (h, c) => {
        pairCalls.push([h, c]);
        return pair.promise;
      },
    },
    {
      getDraft: () => draft,
      setDraft: (v) => {
        draft = v;
      },
      getPairCode: () => code,
      setPairCode: (v) => {
        code = v;
      },
      setPairState: (v) => {
        pairState = v;
      },
    },
  );
  return {
    actions,
    session,
    pairCalls,
    sendCalls,
    get: () => ({ host, thread, draft, code, pairState }),
    setDraft: (v) => {
      actions.editDraft(v); // the same onChangeText path wired in App.tsx
    },
    setCode: (v) => {
      code = v;
    },
    getPair: () => pair,
    setPair: (v) => {
      pair = v;
    },
    getSend: () => send,
    setSend: (v) => {
      send = v;
    },
  };
};
test("App pair handler fences old Host resolve/reject, pair code and state", async () => {
  const a = view(),
    old = a.actions.pair();
  a.actions.selectHost("b");
  a.setCode("code-b");
  a.getPair().resolve();
  await old;
  assert.deepEqual(a.get(), {
    host: "b",
    thread: "a",
    draft: "",
    code: "code-b",
    pairState: null,
  });
  a.setPair(deferred());
  const pending = a.actions.pair();
  a.actions.selectHost("a");
  a.setCode("code-a2");
  a.getPair().reject(Error("old b error"));
  await pending;
  assert.equal(a.get().pairState, null);
  assert.equal(a.get().code, "code-a2");
});
test("App Thread switch clears draft and late accepted only clears original unchanged draft", async () => {
  const a = view();
  a.setDraft("A text");
  a.actions.openThread("b");
  assert.equal(a.get().draft, "");
  a.setDraft("B text");
  const b = a.actions.send();
  assert.deepEqual(a.sendCalls, [{ threadId: "b", text: "B text" }]);
  a.setDraft("new B text");
  a.getSend().resolve({ accepted: true, turnId: "turn-b" });
  await b;
  assert.equal(a.get().draft, "new B text");
  a.setSend(deferred());
  const b2 = a.actions.send();
  a.actions.openThread("a");
  a.setDraft("new A");
  a.getSend().resolve({ accepted: true, turnId: "turn-b2" });
  await b2;
  assert.equal(a.get().draft, "new A");
  a.setSend(deferred());
  const aSend = a.actions.send();
  a.getSend().resolve({ accepted: true, turnId: "turn-a" });
  await aSend;
  assert.equal(a.get().draft, "");
});
test("pair completion preserves newly edited code on same Host", async () => {
  const a = view();
  const pair = a.actions.pair();
  a.setCode("next-new-code");
  a.getPair().resolve();
  await pair;
  assert.equal(a.get().code, "next-new-code");
  assert.match(a.get().pairState, /Paired/);
});
test("App reconnect to the same Host supersedes an older pair operation", async () => {
  const a = view();
  const pair = a.actions.pair();
  a.actions.selectHost("a");
  a.setCode("fresh-code");
  a.getPair().resolve();
  await pair;
  assert.equal(a.get().code, "fresh-code");
  assert.equal(a.get().pairState, null);
});

// Uses the same handlers as App.tsx (including onChangeText=actions.editDraft),
// backed by the real session rather than a supplied/synthetic "correct" epoch.
import { createSession } from "../src/session.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function connectedApp() {
  let draft = "",
    pairCode = "",
    pairState = null;
  const requests = [];
  const transport = {
    snapshot: async () => ({
      workspaces: [{ id: "w" }],
      threads: [{ id: "a" }, { id: "b" }],
    }),
    subscribe: () => () => {},
    read: async () => [],
    command: (h, w, kind, payload) => {
      const pending = deferred();
      requests.push({ h, w, kind, payload, pending });
      return pending.promise;
    },
    disconnect() {},
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
  actions.selectHost("h");
  await tick();
  actions.selectWorkspace("w");
  await tick();
  actions.openThread("a");
  await tick();
  return {
    session,
    actions,
    requests,
    getDraft: () => draft,
    sendDisabled: () =>
      session.get().command === "pending" ||
      session.get().command === "uncertain",
  };
}
test("A→B→A same/different new drafts survive old accepted; settled command enables Send", async () => {
  for (const changed of ["X", "different"]) {
    const { session, actions, requests, getDraft, sendDisabled } =
      await connectedApp();
    actions.editDraft("X");
    const old = actions.send();
    assert.equal(requests.length, 1);
    actions.openThread("b");
    await tick();
    assert.equal(session.get().command, null);
    actions.openThread("a");
    await tick();
    actions.editDraft(changed);
    assert.equal(sendDisabled(), true);
    requests[0].pending.resolve({ accepted: true, turnId: "old-turn" });
    await old;
    assert.equal(getDraft(), changed);
    assert.equal(session.get().command, "accepted");
    assert.equal(sendDisabled(), false);
    assert.equal(requests.length, 1, "never auto-resend");
    const newer = actions.send();
    assert.equal(requests.length, 2);
    requests[1].pending.resolve({ accepted: true, turnId: "new-turn" });
    await newer;
    assert.equal(
      getDraft(),
      "",
      "the unchanged new submission alone clears its draft",
    );
  }
});
test("X→Y→X in one Thread is a new composition, while untouched original clears", async () => {
  const { session, actions, requests, getDraft } = await connectedApp();
  actions.editDraft("X");
  const old = actions.send();
  actions.editDraft("Y");
  actions.editDraft("X");
  requests[0].pending.resolve({ accepted: true, turnId: "old" });
  await old;
  assert.equal(getDraft(), "X");
  assert.equal(session.get().command, "accepted");
  const fresh = actions.send();
  requests[1].pending.resolve({ accepted: true, turnId: "fresh" });
  await fresh;
  assert.equal(getDraft(), "");
  actions.editDraft("untouched");
  const untouched = actions.send();
  requests[2].pending.resolve({ accepted: true, turnId: "untouched-turn" });
  await untouched;
  assert.equal(getDraft(), "");
});
test("revisited A definitive rejection releases pending but retains new draft; unknown remains fenced", async () => {
  const rejected = await connectedApp();
  rejected.actions.editDraft("X");
  const old = rejected.actions.send();
  rejected.actions.openThread("b");
  await tick();
  rejected.actions.openThread("a");
  await tick();
  rejected.actions.editDraft("X");
  rejected.requests[0].pending.reject(
    Object.assign(Error("Host thread_busy"), { confirmedRejection: true }),
  );
  await old;
  assert.equal(rejected.session.get().command, null);
  assert.equal(rejected.sendDisabled(), false);
  assert.equal(rejected.getDraft(), "X");
  assert.match(rejected.session.get().error, /thread_busy/);
  const unknown = await connectedApp();
  unknown.actions.editDraft("X");
  const ambiguous = unknown.actions.send();
  unknown.actions.openThread("b");
  await tick();
  assert.equal(unknown.sendDisabled(), false);
  unknown.actions.openThread("a");
  await tick();
  unknown.actions.editDraft("X");
  unknown.requests[0].pending.reject(Error("lost socket"));
  await ambiguous;
  assert.equal(unknown.session.get().command, "uncertain");
  assert.equal(unknown.sendDisabled(), true);
  assert.equal(unknown.getDraft(), "X");
  await unknown.actions.send();
  assert.equal(
    unknown.requests.length,
    1,
    "unknown original cannot be dispatched again",
  );
  unknown.actions.openThread("b");
  await tick();
  assert.equal(unknown.sendDisabled(), false);
});
test("unchanged draft clears on admission even while optional summary refresh is slow", async () => {
  const summary = deferred();
  let reads = 0,
    draft = "";
  const session = createSession(
    {
      snapshot: () =>
        ++reads === 3
          ? summary.promise
          : Promise.resolve({ workspaces: [], threads: [] }),
      subscribe: () => () => {},
      read: async () => [],
      command: async () => ({ accepted: true, turnId: "admitted" }),
    },
    () => {},
  );
  const actions = createAppActions(
    session,
    { pair: async () => {} },
    {
      getDraft: () => draft,
      setDraft: (v) => {
        draft = v;
      },
      getPairCode: () => "",
      setPairCode: () => {},
      setPairState: () => {},
    },
  );
  actions.selectHost("h");
  await tick();
  actions.selectWorkspace("w");
  await tick();
  actions.openThread("a");
  await tick();
  actions.editDraft("X");
  await actions.send();
  assert.equal(reads, 3);
  assert.equal(draft, "");
  assert.equal(session.get().command, "accepted");
  summary.resolve({ workspaces: [], threads: [] });
  await tick();
});
test("App workspace roundtrip and pair-driven selection invalidate old drafts", async () => {
  const a = await connectedApp();
  a.actions.editDraft("X");
  const old = a.actions.send();
  a.actions.selectWorkspace("elsewhere");
  await tick();
  a.actions.selectWorkspace("w");
  await tick();
  a.actions.openThread("a");
  await tick();
  a.actions.editDraft("X");
  a.requests[0].pending.resolve({ accepted: true, turnId: "old" });
  await old;
  assert.equal(a.getDraft(), "X");
  // A real workspace reset disconnects the socket; this fake delayed reply
  // cannot confirm delivery for the new connection's view.
  const mock = view();
  mock.actions.editDraft("old draft");
  const pairing = mock.actions.pair();
  mock.getPair().resolve();
  await pairing;
  assert.equal(mock.get().draft, "");
});
