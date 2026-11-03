import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AutomationTransactionStore,
  type AutomationRoomEvent,
} from "../src/main/automation-transaction-store.js";
import {
  readAutomationProjection,
  automationTransactionForSnapshot,
} from "../src/main/automation-transaction-adapter.js";
import {
  ZenXTriggerService,
  type ZenXTriggerStorePort,
} from "../src/main/trigger-service.js";
import type { TriggerSnapshot } from "../src/main/trigger-types.js";
import type { RoomQuestion } from "../src/room-questions.js";
const admit = async () => {};
const content = {
  questions: [
    {
      id: "scope",
      prompt: "Synthetic workspace choice",
      options: [
        { id: "small", label: "Small" },
        { id: "large", label: "Large" },
      ],
    },
  ],
};
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "room-question-service-"),
  );
  const options = { directory, assertWriterLease: () => {} };
  let journal = await AutomationTransactionStore.create(options, {
    triggers: [],
    history: [],
    rooms: [],
  });
  let failNext = false;
  const dispatched: string[] = [];
  const store: ZenXTriggerStorePort = {
    get roomHistory() {
      return journal;
    },
    read: () => readAutomationProjection(journal),
    write: async (
      snapshot: TriggerSnapshot,
      events: readonly AutomationRoomEvent[] = [],
    ) => {
      if (failNext) {
        failNext = false;
        throw Error("Synthetic precommit failure");
      }
      await journal.append(
        automationTransactionForSnapshot(journal, snapshot, events),
      );
    },
  };
  const manager: any = {
    onNotification: () => () => {},
    request: async (method: string, params: any) => {
      assert.equal(method, "zen/turn/wake");
      dispatched.push(params.threadId);
      return { mode: "start", turnId: randomUUID() };
    },
  };
  let service = new ZenXTriggerService(manager, store);
  await service.start();
  const room = await service.createRoom({
    name: "Workspace",
    members: [
      { threadId: "member-a", name: "A" },
      { threadId: "member-b", name: "B" },
    ],
  });
  const other = await service.createRoom({
    name: "Other workspace",
    members: [{ threadId: "member-a", name: "A" }],
  });
  let calls = 0;
  t.after(async () => {
    await service.close();
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get service() {
      return service;
    },
    get journal() {
      return journal;
    },
    room,
    other,
    dispatched,
    async publish(threadId = "member-a", roomId = room.id) {
      return service.publishRoomQuestion(
        roomId,
        { threadId, callItemId: `synthetic-call-${++calls}` },
        content,
        admit,
      );
    },
    async restart() {
      await service.close();
      const generation = journal.generation;
      await journal.close();
      journal = await AutomationTransactionStore.open(options, generation);
      service = new ZenXTriggerService(manager, store);
      await service.start();
    },
    fail() {
      failNext = true;
    },
  };
}
const response = (
  question: RoomQuestion,
  clientId: string,
  outcome: "answer" | "cancel" = "answer",
) => ({
  roomId: question.roomId,
  questionId: question.id,
  expectedRevision: question.revision,
  clientId,
  outcome,
  ...(outcome === "answer"
    ? {
        answers: [
          {
            questionId: "scope",
            optionIds: ["small"],
            text: "Later workspace answer",
          },
        ],
      }
    : {}),
});

test("multiple members publish independent Room resources; partial answers/cancels keep one exact openCount until none", async (t) => {
  const f = await fixture(t);
  const a = await f.publish(),
    b = await f.publish("member-b"),
    c = await f.publish("member-a", f.other.id);
  assert.equal(a.specification.answerTemplate, "scope: {{scope}}");
  assert.equal(f.service.roomQuestionSummary(f.room.id).openCount, 2);
  const first = await f.service.respondRoomQuestion(
    response(a, "stable-a"),
    admit,
  );
  assert.equal(first.response.status, "saved");
  assert.equal(first.question!.state, "answered");
  assert.equal(first.delivery!.state, "saved");
  assert.equal("turnId" in first, false);
  assert.equal(f.service.roomQuestionSummary(f.room.id).openCount, 1);
  assert.equal(
    f.dispatched.length,
    0,
    "ordinary Room reply without mentions must not invent broadcast",
  );
  await f.service.respondRoomQuestion(response(b, "stable-b", "cancel"), admit);
  assert.equal(f.service.roomQuestionSummary(f.room.id).openCount, 0);
  assert.equal(f.service.roomQuestionSummary(f.other.id).openCount, 1);
  assert.equal(
    (await f.service.readRoomQuestion(f.other.id, c.id))!.state,
    "open",
  );
  const before = await f.service.roomQuestions(f.room.id, {
    includeClosed: true,
  });
  await f.restart();
  assert.deepEqual(
    await f.service.roomQuestions(f.room.id, { includeClosed: true }),
    before,
  );
});

test("author removal retains workspace questions, rejects new member writes, and never fabricates a private Thread reply", async (t) => {
  const f = await fixture(t);
  const q = await f.publish();
  await f.service.removeRoomMember(f.room.id, "member-a");
  assert.equal(f.service.roomQuestionSummary(f.room.id).openCount, 1);
  assert.equal(
    (await f.service.roomQuestions(f.room.id)).questions[0]!.id,
    q.id,
  );
  await assert.rejects(f.publish(), /current Room workspace member/);
  await assert.rejects(
    f.service.updateRoomQuestion(
      {
        roomId: q.roomId,
        questionId: q.id,
        expectedRevision: q.revision,
        specification: content,
      },
      "member-a",
      admit,
    ),
    /current Room workspace member/,
  );
  await assert.rejects(
    f.service.roomQuestionsAsMember(q.roomId, "member-a", {}, admit),
    /current Room workspace member/,
  );
  const saved = await f.service.respondRoomQuestion(
    response(q, "after-removal"),
    admit,
  );
  assert.equal(saved.question!.origin.threadId, "member-a");
  assert.equal(saved.response.status, "saved");
  assert.deepEqual(saved.delivery!.mentions, []);
  assert.equal(f.dispatched.length, 0);
  assert.equal("admission" in saved, false);
});

test("model revision CAS, human revision fence and explicit withdrawal share the same Room projection", async (t) => {
  const f = await fixture(t);
  const original = await f.publish();
  const changed = await f.service.updateRoomQuestion(
    {
      roomId: original.roomId,
      questionId: original.id,
      expectedRevision: 1,
      specification: {
        questions: [
          { id: "scope", prompt: "Revised by another current member" },
        ],
      },
    },
    "member-b",
    admit,
  );
  assert.equal(changed.revision, 2);
  assert.deepEqual(changed.origin, original.origin);
  await assert.rejects(
    f.service.respondRoomQuestion(response(original, "stale-answer"), admit),
    /changed/,
  );
  await assert.rejects(
    f.service.updateRoomQuestion(
      {
        roomId: original.roomId,
        questionId: original.id,
        expectedRevision: 1,
        specification: content,
      },
      "member-b",
      admit,
    ),
    /changed/,
  );
  await f.service.withdrawRoomQuestion(
    { roomId: changed.roomId, questionId: changed.id, expectedRevision: 2 },
    "member-b",
    admit,
  );
  assert.equal(f.service.roomQuestionSummary(original.roomId).openCount, 0);
  assert.equal(
    (await f.service.readRoomQuestion(original.roomId, original.id))!.state,
    "withdrawn",
  );
  assert.equal(
    f.service.snapshot().rooms.find((r) => r.id === original.roomId)!
      .messageCount,
    0,
    "model withdrawal is not a fake human message",
  );
});

test("stable response identity survives lost UI ACK/restart without duplicate message or automatic replay", async (t) => {
  const f = await fixture(t);
  const q = await f.publish();
  const input = response(q, "lost-ack-client");
  const saved = await f.service.respondRoomQuestion(input, admit);
  const messageId = saved.response.messageId;
  const position = f.journal.position;
  // Simulated loss is outside the committed service; no inferred retry authority.
  const read = await f.service.readRoomQuestionResponse(
    q.roomId,
    q.id,
    input.clientId,
  );
  assert.equal(read.response.status, "saved");
  assert.equal(read.response.messageId, messageId);
  assert.deepEqual(f.journal.position, position);
  await f.restart();
  const duplicate = await f.service.respondRoomQuestion(input, admit);
  assert.equal(duplicate.response.messageId, messageId);
  assert.equal(
    f.service.snapshot().rooms.find((r) => r.id === q.roomId)!.messageCount,
    1,
  );
  assert.equal(f.dispatched.length, 0);
  await assert.rejects(
    f.service.respondRoomQuestion(
      { ...input, answers: [{ questionId: "scope", optionIds: ["large"] }] },
      admit,
    ),
    /different input/,
  );
  const absent = await f.service.readRoomQuestionResponse(
    q.roomId,
    q.id,
    "other-client",
  );
  assert.equal(absent.response.status, "conflict");
});

test("denied document, precommit failure and wrong Room never partially resolve a workspace question", async (t) => {
  const f = await fixture(t);
  const q = await f.publish();
  const input = response(q, "no-partial");
  await assert.rejects(
    f.service.respondRoomQuestion({ ...input, roomId: f.other.id }, admit),
    /not found/,
  );
  await assert.rejects(
    f.service.respondRoomQuestion(input, async () => {
      throw Error("Synthetic current document revoked");
    }),
    /revoked/,
  );
  assert.equal(
    (await f.service.readRoomQuestion(q.roomId, q.id))!.state,
    "open",
  );
  assert.equal(
    f.service.snapshot().rooms.find((r) => r.id === q.roomId)!.messageCount,
    0,
  );
  f.fail();
  await assert.rejects(
    f.service.respondRoomQuestion(input, admit),
    /precommit failure/,
  );
  assert.equal(
    (await f.service.readRoomQuestionResponse(q.roomId, q.id, input.clientId))
      .response.status,
    "not-found",
  );
  assert.equal(f.service.roomQuestionSummary(q.roomId).openCount, 1);
  assert.equal(f.dispatched.length, 0);
});

test("publication source identity binds its original content even after a later workspace edit", async (t) => {
  const f = await fixture(t);
  const q = await f.publish();
  const duplicate = await f.service.publishRoomQuestion(
    q.roomId,
    q.origin,
    content,
    admit,
  );
  assert.equal(duplicate.id, q.id);
  assert.equal(f.service.roomQuestionSummary(q.roomId).openCount, 1);
  await f.service.updateRoomQuestion(
    {
      roomId: q.roomId,
      questionId: q.id,
      expectedRevision: 1,
      specification: {
        questions: [
          { id: "scope", prompt: "Later editable workspace content" },
        ],
      },
    },
    "member-b",
    admit,
  );
  const retry = await f.service.publishRoomQuestion(
    q.roomId,
    q.origin,
    content,
    admit,
  );
  assert.equal(retry.id, q.id);
  assert.equal(retry.revision, 2);
  await assert.rejects(
    f.service.publishRoomQuestion(
      q.roomId,
      q.origin,
      { questions: [{ id: "scope", prompt: "Rebound same call" }] },
      admit,
    ),
    /different content/,
  );
  assert.equal(f.service.roomQuestionSummary(q.roomId).totalQuestions, 1);
});
