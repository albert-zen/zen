import assert from "node:assert/strict";
import test from "node:test";
import {
  createUserQuestionStore,
  type QuestionTransport,
} from "../src/renderer/src/user-question-state.js";
import type {
  UserQuestionState,
  UserQuestionPage,
} from "../../../src/user-question-state.js";
import type { NativeQuestionRespondResult } from "../../../src/protocol/native/wire.js";
import { questionNativeFixture } from "./user-question-native-fixture.js";

function question(id: string): UserQuestionState {
  return {
    request: { threadId: "t", callItemId: id },
    resultItemId: `${id}-result`,
    createdAt: "2026-11-02T00:00:00Z",
    state: "open",
    specification: {
      questions: [
        {
          id: "q",
          prompt: "Synthetic question",
          options: [{ id: "a", label: "A" }],
        },
      ],
      answerTemplate: "{{q}}",
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected mutation/read");
};

test("bounded attention pagination discards an invalidated traversal without dropping drafts or later invalidation", async () => {
  const oldMore = deferred<UserQuestionPage>(),
    oldFirst = deferred<UserQuestionPage>();
  let first = 0,
    more = 0;
  const store = createUserQuestionStore({
    list: async (params) => {
      if (params.afterQuestionCallItemId) {
        more++;
        return oldMore.promise;
      }
      first++;
      if (first === 2) return oldFirst.promise;
      const questions = Array.from({ length: 32 }, (_, i) =>
        question(`${first >= 3 ? "new-" : ""}${i}`),
      );
      return {
        questions,
        totalPending: 33,
        nextAfter: questions.at(-1)!.request.callItemId,
      };
    },
    read: unexpected,
    respond: unexpected,
  });
  const unmount = store.mount("t");
  await store.refresh("t");
  store.edit("t", "0", [
    { questionId: "q", optionIds: ["a"], text: "local draft" },
  ]);
  const loadingMore = store.loadMore("t");
  store.invalidate("t");
  await Promise.resolve();
  store.invalidate("t");
  oldFirst.resolve({ questions: [question("stale")], totalPending: 1 });
  await store.refresh("t");
  oldMore.resolve({ questions: [question("33")], totalPending: 33 });
  await loadingMore;
  assert.equal(first, 3);
  assert.equal(more, 1);
  assert.equal(store.get("t").ids.length, 32);
  assert.ok(store.get("t").ids.every((id) => id.startsWith("new-")));
  assert.equal(
    store.get("t").cards["0"]!.draft.answers[0]!.text,
    "local draft",
  );
  unmount();
});

test("unknown response remains read-only and not-found never licenses resending; late replies do not overwrite edited drafts", async () => {
  const response = deferred<NativeQuestionRespondResult>();
  let writes = 0,
    reads = 0;
  const q = question("ask");
  const store = createUserQuestionStore(
    {
      list: async () => ({ questions: [q], totalPending: 1 }),
      read: async (p) => {
        reads++;
        return {
          question: q,
          response: { clientId: p.clientUserMessageId, status: "not-found" },
        };
      },
      respond: async () => {
        writes++;
        return response.promise;
      },
    },
    () => "original-client",
  );
  await store.refresh("t");
  store.edit("t", "ask", [{ questionId: "q", optionIds: ["a"] }]);
  const write = store.respond("t", "ask", "answer");
  await store.respond("t", "ask", "answer");
  store.edit("t", "ask", [
    { questionId: "q", optionIds: [], text: "new draft" },
  ]);
  await store.check("t", "ask");
  response.reject(new Error("lost response"));
  await write;
  assert.equal(store.get("t").cards.ask!.attempt!.phase, "unknown");
  await store.respond("t", "ask", "answer");
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.equal(
    store.get("t").cards.ask!.attempt!.request.clientUserMessageId,
    "original-client",
  );
  assert.equal(store.get("t").cards.ask!.draft.answers[0]!.text, "new draft");
});

test("a newer exact withdrawn read beats a delayed successful original response", async () => {
  const response = deferred<NativeQuestionRespondResult>(),
    q = question("ask");
  const reply = {
    version: 1 as const,
    request: q.request,
    outcome: "answer" as const,
    answers: [{ questionId: "q", optionIds: ["a"] }],
  };
  const store = createUserQuestionStore(
    {
      list: async () => ({ questions: [q], totalPending: 1 }),
      read: async (p) => ({
        question: q,
        response: {
          clientId: p.clientUserMessageId,
          status: "withdrawn",
          reply,
        },
      }),
      respond: async () => response.promise,
    },
    () => "c",
  );
  await store.refresh("t");
  store.edit("t", "ask", reply.answers);
  const write = store.respond("t", "ask", "answer");
  await store.check("t", "ask");
  response.resolve({
    turnId: "old",
    question: {
      ...q,
      state: "answer-pending",
      response: { clientId: "c", itemId: "queued", reply },
    },
  });
  await write;
  assert.equal(store.get("t").cards.ask!.attempt!.phase, "withdrawn");
  assert.equal(store.get("t").cards.ask!.question.state, "open");
});

test("real Host/native admission races two desktop drafts without duplicate semantic human input; reload lists canonical state", async () => {
  const f = await questionNativeFixture();
  try {
    const thread = await f.host.startThread();
    const q = await f.publish(thread.id);
    const stores = [
      createUserQuestionStore(f.transport, () => "client-one"),
      createUserQuestionStore(f.transport, () => "client-two"),
    ];
    for (const store of stores) {
      await store.refresh(thread.id);
      store.edit(thread.id, q.request.callItemId, [
        {
          questionId: "scope",
          optionIds: ["small"],
          text: "Synthetic free text",
        },
      ]);
    }
    await Promise.all(
      stores.map((s) => s.respond(thread.id, q.request.callItemId, "answer")),
    );
    const snapshot = await f.host.readThread(thread.id);
    const replies = snapshot.itemList!.filter(
      (item) =>
        item.role === "user" &&
        item.source.metadata?.questionReply !== undefined,
    );
    assert.equal(replies.length, 1);
    assert.equal(
      stores.filter(
        (s) =>
          s.get(thread.id).cards[q.request.callItemId]!.attempt!.phase ===
          "rejected",
      ).length,
      1,
    );
    const reloaded = createUserQuestionStore(f.transport);
    await reloaded.refresh(thread.id);
    assert.equal(reloaded.get(thread.id).ids.length, 0);
    const other = await f.host.startThread();
    const cancel = await f.publish(other.id);
    const cancelling = createUserQuestionStore(
      f.transport,
      () => "cancel-client",
    );
    await cancelling.refresh(other.id);
    await cancelling.respond(other.id, cancel.request.callItemId, "cancel");
    const cancelled = await f.host.readUserQuestion(
      other.id,
      cancel.request.callItemId,
      "cancel-client",
    );
    assert.equal(cancelled.response.status, "claimed");
    assert.equal(cancelled.response.reply?.outcome, "cancel");
  } finally {
    await f.close();
  }
});

test("a real admitted response followed by a failing Host read stays unknown through native error serialization and reconciles only the original intent", async () => {
  const f = await questionNativeFixture();
  try {
    const thread = await f.host.startThread();
    const q = await f.publish(thread.id);
    const respond = f.host.respondToUserQuestion.bind(f.host);
    let writes = 0;
    // Fault-inject the post-admission read stage, not the admission itself. This
    // models a readback failure; it does not claim to reproduce an eviction race.
    f.host.respondToUserQuestion = async (...args) => {
      writes++;
      const admitted = await respond(...args);
      await f.host.readThread("synthetic-missing-post-admission-readback");
      return admitted;
    };
    const store = createUserQuestionStore(
      f.transport,
      () => "post-read-failure",
    );
    await store.refresh(thread.id);
    store.edit(thread.id, q.request.callItemId, [
      { questionId: "scope", optionIds: ["small"] },
    ]);
    await store.respond(thread.id, q.request.callItemId, "answer");
    const before = store.get(thread.id).cards[q.request.callItemId]!;
    assert.equal(before.attempt!.phase, "unknown");
    assert.match(before.attempt!.detail!, /thread_not_found/);
    assert.equal(
      (
        await f.host.readUserQuestion(
          thread.id,
          q.request.callItemId,
          "post-read-failure",
        )
      ).response.status,
      "claimed",
    );
    await store.respond(thread.id, q.request.callItemId, "answer");
    assert.equal(writes, 1, "unknown cannot trigger another mutation");
    await store.check(thread.id, q.request.callItemId);
    assert.equal(
      store.get(thread.id).cards[q.request.callItemId]!.attempt!.phase,
      "claimed",
    );
    assert.equal(writes, 1);
    const inputs = (await f.host.readThread(thread.id)).itemList!.filter(
      (item) =>
        item.role === "user" &&
        item.source.metadata?.clientId === "post-read-failure",
    );
    assert.equal(inputs.length, 1);
  } finally {
    await f.close();
  }
});

for (const late of ["ack", "check"] as const) {
  test(`disconnect fences a late ${late} behind fresh canonical state without dropping intent or draft`, async () => {
    const q = question("ask");
    const reply = {
      version: 1 as const,
      request: q.request,
      outcome: "answer" as const,
      answers: [{ questionId: "q", optionIds: ["a"] }],
    };
    const oldQuestion: UserQuestionState = {
      ...q,
      state: "answer-pending",
      response: { clientId: "original", itemId: "queued", reply },
    };
    const ack = deferred<NativeQuestionRespondResult>();
    const read = deferred<Awaited<ReturnType<QuestionTransport["read"]>>>();
    let current = q;
    let lists = 0;
    const store = createUserQuestionStore(
      {
        list: async () => {
          lists++;
          return { questions: [current], totalPending: 1 };
        },
        respond: async () => ack.promise,
        read: async () => read.promise,
      },
      () => "original",
    );
    const close = store.mount("t");
    await store.refresh("t");
    store.edit("t", "ask", reply.answers);
    const pendingAck = store.respond("t", "ask", "answer");
    const pendingRead =
      late === "check" ? store.check("t", "ask") : Promise.resolve();
    store.edit("t", "ask", [
      { questionId: "q", optionIds: [], text: "newer local draft" },
    ]);
    const before = store.get("t").cards.ask!;
    store.disconnect();
    current = { ...oldQuestion, state: "answered" };
    await store.refresh("t");
    const listsBeforeLateResults = lists;
    ack.resolve({ turnId: "old-turn", question: oldQuestion });
    read.resolve({
      question: oldQuestion,
      response: { clientId: "original", status: "pending", reply },
    });
    await Promise.all([pendingAck, pendingRead]);
    const after = store.get("t").cards.ask!;
    assert.equal(after.question.state, "answered");
    assert.equal(after.attempt!.phase, "unknown");
    assert.equal(after.attempt!.request, before.attempt!.request);
    assert.equal(after.draft, before.draft);
    assert.equal(
      lists,
      listsBeforeLateResults,
      "fenced results never trigger another list",
    );
    close();
  });
}

test("close/reopen starts a new traversal even when the refreshed cursor is unchanged", async () => {
  const oldMore = deferred<UserQuestionPage>();
  const store = createUserQuestionStore({
    list: async (p) =>
      p.afterQuestionCallItemId
        ? oldMore.promise
        : {
            questions: [question("first")],
            totalPending: 2,
            nextAfter: "first",
          },
    read: unexpected,
    respond: unexpected,
  });
  const close = store.mount("t");
  await store.refresh("t");
  const more = store.loadMore("t");
  close();
  const closeAgain = store.mount("t");
  await store.refresh("t");
  oldMore.resolve({ questions: [question("old-traversal")], totalPending: 2 });
  await more;
  assert.deepEqual(store.get("t").ids, ["first"]);
  assert.equal(store.get("t").nextAfter, "first");
  closeAgain();
});
