import assert from "node:assert/strict";
import test from "node:test";
import {
  createRoomQuestionStore,
  type RoomQuestionTransport,
} from "../src/renderer/src/room-question-state.js";
import type {
  RoomQuestion,
  RoomQuestionResponseInput,
  RoomQuestionResponseReadback,
  RoomQuestionWorkspace,
} from "../src/room-questions.js";
function question(roomId = "a", id = "same"): RoomQuestion {
  return {
    roomId,
    id,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    origin: { threadId: "former-member", callItemId: "same-private-call" },
    state: "open",
    specification: {
      questions: [
        {
          id: "q",
          prompt: "Synthetic Room question",
          options: [{ id: "yes", label: "Yes" }],
        },
      ],
      answerTemplate: "{{q}}",
    },
  };
}
function page(
  roomId: string,
  questions: RoomQuestion[],
  revision = 1,
): RoomQuestionWorkspace {
  return {
    roomId,
    questions,
    revision,
    openCount: questions.filter((q) => q.state === "open").length,
    totalQuestions: questions.length,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function fixture(roomId = "a") {
  let questions = [question(roomId), question(roomId, "second")],
    revision = 1;
  const writes: RoomQuestionResponseInput[] = [];
  const receipts = new Map<string, RoomQuestionResponseReadback>();
  const transport: RoomQuestionTransport = {
    list: async () =>
      page(
        roomId,
        questions.filter((q) => q.state === "open"),
        revision,
      ),
    respond: async (input) => {
      writes.push(structuredClone(input));
      const old = receipts.get(input.clientId);
      if (old) return old;
      const q = questions.find((q) => q.id === input.questionId)!;
      assert.equal(q.roomId, input.roomId);
      if (q.revision !== input.expectedRevision)
        throw Object.assign(Error("Revision changed"), {
          roomQuestionRejected: true,
        });
      const next: RoomQuestion = {
        ...q,
        revision: q.revision + 1,
        updatedAt: ++revision,
        state: input.outcome === "answer" ? "answered" : "cancelled",
        response: {
          clientId: input.clientId,
          questionRevision: q.revision,
          outcome: input.outcome,
          ...(input.answers ? { answers: input.answers } : {}),
          messageId: "message-" + input.clientId,
          operationId: "operation-" + input.clientId,
          receivedAt: revision,
        },
      };
      questions = questions.map((q) => (q.id === next.id ? next : q));
      const receipt: RoomQuestionResponseReadback = {
        question: next,
        response: { clientId: input.clientId, status: "saved" },
      };
      receipts.set(input.clientId, receipt);
      return receipt;
    },
    readResponse: async (_room, _id, clientId) =>
      receipts.get(clientId) ?? {
        question: questions[0]!,
        response: { clientId, status: "not-found" },
      },
  };
  let serial = 0;
  const store = createRoomQuestionStore(
    roomId,
    transport,
    () => roomId + "-" + ++serial,
  );
  return {
    store,
    transport,
    writes,
    questions: () => questions,
    revise() {
      questions = questions.map((q) => ({
        ...q,
        revision: q.revision + 1,
        updatedAt: ++revision,
      }));
    },
  };
}
test("equal authored IDs/provenance in distinct Room workspaces retain independent drafts", async () => {
  const a = fixture(),
    b = fixture("b");
  await Promise.all([a.store.refresh(), b.store.refresh()]);
  a.store.edit("same", "q", { text: "Room A only" });
  assert.equal(b.store.get().cards.same!.draft.answers[0]!.text, undefined);
  assert.equal(a.store.get().openCount, 2);
  assert.equal(a.writes.length, 0);
});
test("answer/cancel preserve Asking until every independent Room question is closed", async () => {
  const f = fixture();
  await f.store.refresh();
  f.store.edit("same", "q", { optionIds: ["yes"] });
  await f.store.respond("same", "answer");
  await f.store.refresh();
  assert.equal(f.store.get().openCount, 1);
  assert.deepEqual(f.store.get().ids, ["second"]);
  await f.store.respond("second", "cancel");
  await f.store.refresh();
  assert.equal(f.store.get().openCount, 0);
  assert.deepEqual(
    f.writes.map((w) => w.outcome),
    ["answer", "cancel"],
  );
});
test("lost committed response recovers by exact Room/client readback with no second write", async () => {
  const f = fixture();
  await f.store.refresh();
  const actual = f.transport.respond;
  f.transport.respond = async (input) => {
    await actual(input);
    throw Error("Lost reply");
  };
  await f.store.respond("same", "cancel");
  assert.equal(f.store.get().cards.same!.attempt?.phase, "unknown");
  await f.store.respond("same", "cancel");
  assert.equal(f.writes.length, 1);
  await f.store.check("same");
  assert.equal(f.writes.length, 1);
  assert.equal(f.store.get().cards.same!.attempt, undefined);
  assert.equal(f.questions()[0]!.state, "cancelled");
});
test("unknown absent response requires readback and explicit reapply of the same immutable request", async () => {
  const f = fixture();
  await f.store.refresh();
  const actual = f.transport.respond;
  let fail = true;
  f.transport.respond = async (input) => {
    if (fail) {
      fail = false;
      f.writes.push(structuredClone(input));
      throw Error("No receipt");
    }
    return actual(input);
  };
  await f.store.respond("same", "cancel");
  const original = f.store.get().cards.same!.attempt!.request;
  await f.store.refresh();
  assert.equal(f.store.get().cards.same!.attempt?.phase, "unknown");
  await f.store.check("same");
  assert.equal(f.store.get().cards.same!.attempt?.phase, "reviewed");
  assert.equal(f.writes.length, 1);
  await f.store.reapply("same");
  assert.equal(f.writes.length, 2);
  assert.deepEqual(f.writes[1], original);
});
test("pre-write reads cannot clear a later unknown write or authorize its reapply", async () => {
  const f = fixture();
  await f.store.refresh();
  const gate = deferred<RoomQuestionWorkspace>();
  f.transport.list = async () => gate.promise;
  const stale = f.store.refresh();
  f.transport.respond = async () => {
    throw Error("Unconfirmed");
  };
  await f.store.respond("same", "cancel");
  gate.resolve(page("a", [question()]));
  await stale;
  assert.equal(f.store.get().cards.same!.attempt?.phase, "unknown");
  assert.match(f.store.get().cards.same!.attempt!.error!, /Unconfirmed/);
  assert.equal(f.store.get().loading, false);
});
test("question revision changes preserve drafts but need explicit review before a new answer", async () => {
  const f = fixture();
  await f.store.refresh();
  f.store.edit("same", "q", { optionIds: ["yes"], text: "Keep this" });
  f.revise();
  await f.store.refresh();
  await f.store.respond("same", "answer");
  assert.equal(f.writes.length, 0);
  assert.equal(f.store.get().cards.same!.draft.questionRevision, 1);
  f.store.review("same");
  assert.equal(f.store.get().cards.same!.draft.answers[0]!.text, "Keep this");
  await f.store.respond("same", "answer");
  assert.equal(f.writes[0]!.expectedRevision, 2);
});
test("foreign Room workspace receipts are rejected before publishing any cards", async () => {
  const f = fixture();
  f.transport.list = async () => page("b", [question("b")]);
  await f.store.refresh();
  assert.deepEqual(f.store.get().ids, []);
  assert.match(f.store.get().error!, /Room workspace/);
});

test("a newer workspace read fences an older not-found response observation", async () => {
  const f = fixture();
  await f.store.refresh();
  f.transport.respond = async () => {
    throw Error("Unconfirmed");
  };
  await f.store.respond("same", "cancel");
  const gate = deferred<RoomQuestionResponseReadback>();
  f.transport.readResponse = async () => gate.promise;
  const checking = f.store.check("same");
  f.revise();
  await f.store.refresh();
  gate.resolve({
    question: question(),
    response: { clientId: "a-1", status: "not-found" },
  });
  await checking;
  assert.equal(f.store.get().cards.same!.question.revision, 2);
  assert.equal(f.store.get().cards.same!.attempt?.phase, "unknown");
});

test("a response check started during refresh cannot roll a newer question back", async () => {
  const f = fixture();
  await f.store.refresh();
  f.transport.respond = async () => {
    throw Error("Unconfirmed");
  };
  await f.store.respond("same", "cancel");
  const list = deferred<RoomQuestionWorkspace>();
  const read = deferred<RoomQuestionResponseReadback>();
  f.transport.list = async () => list.promise;
  f.transport.readResponse = async () => read.promise;
  const refreshing = f.store.refresh();
  const checking = f.store.check("same");
  f.revise();
  list.resolve(page("a", f.questions(), 3));
  await refreshing;
  read.resolve({
    question: question(),
    response: { clientId: "a-1", status: "not-found" },
  });
  await checking;
  assert.equal(f.store.get().cards.same!.question.revision, 2);
  assert.equal(f.store.get().cards.same!.attempt?.phase, "unknown");
});

test("a newer current question retires reviewed recovery instead of enabling stale reapply", async () => {
  const f = fixture();
  await f.store.refresh();
  f.transport.respond = async (input) => {
    f.writes.push(input);
    throw Error("Unconfirmed");
  };
  await f.store.respond("same", "cancel");
  await f.store.check("same");
  assert.equal(f.store.get().cards.same!.attempt?.phase, "reviewed");
  f.revise();
  await f.store.refresh();
  await f.store.reapply("same");
  assert.equal(f.writes.length, 1);
  assert.equal(f.store.get().cards.same!.attempt?.phase, "rejected");
});

test("disconnect fences pending response observations while retaining the original request", async () => {
  const f = fixture();
  await f.store.refresh();
  f.transport.respond = async () => {
    throw Error("Unconfirmed");
  };
  await f.store.respond("same", "cancel");
  const original = f.store.get().cards.same!.attempt!.request;
  const gate = deferred<RoomQuestionResponseReadback>();
  f.transport.readResponse = async () => gate.promise;
  const checking = f.store.check("same");
  f.store.disconnect();
  gate.resolve({
    question: question(),
    response: { clientId: "a-1", status: "not-found" },
  });
  await checking;
  assert.equal(f.store.get().cards.same!.attempt?.phase, "unknown");
  assert.deepEqual(f.store.get().cards.same!.attempt!.request, original);
});

test("a later explicit response check retires an earlier check", async () => {
  const f = fixture();
  await f.store.refresh();
  f.transport.respond = async () => {
    throw Error("Unconfirmed");
  };
  await f.store.respond("same", "cancel");
  const older = deferred<RoomQuestionResponseReadback>();
  const newer = deferred<RoomQuestionResponseReadback>();
  let calls = 0;
  f.transport.readResponse = async () =>
    ++calls === 1 ? older.promise : newer.promise;
  const first = f.store.check("same");
  const second = f.store.check("same");
  older.resolve({
    question: question(),
    response: { clientId: "a-1", status: "not-found" },
  });
  await first;
  assert.equal(f.store.get().cards.same!.attempt?.phase, "unknown");
  newer.resolve({
    question: question(),
    response: { clientId: "a-1", status: "not-found" },
  });
  await second;
  assert.equal(f.store.get().cards.same!.attempt?.phase, "reviewed");
});

test("disconnect leaves an in-flight write unknown until a fresh explicit readback", async () => {
  const f = fixture();
  await f.store.refresh();
  const actual = f.transport.respond;
  const gate = deferred<void>();
  f.transport.respond = async (input) => {
    const receipt = await actual(input);
    await gate.promise;
    return receipt;
  };
  const sending = f.store.respond("same", "cancel");
  const original = f.store.get().cards.same!.attempt!.request;
  f.store.disconnect();
  gate.resolve();
  await sending;
  assert.equal(f.store.get().cards.same!.attempt?.phase, "unknown");
  assert.deepEqual(f.store.get().cards.same!.attempt!.request, original);
  await f.store.refresh();
  await f.store.check("same");
  assert.equal(f.store.get().cards.same!.attempt, undefined);
  assert.equal(f.writes.length, 1);
});
