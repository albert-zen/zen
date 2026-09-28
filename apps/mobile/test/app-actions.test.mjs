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
      draft = v;
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
