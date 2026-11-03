import { ModelReferenceRegistry } from "../../../src/model-references.js";
import { invokeModelToolFacade } from "../src/main/capabilities/model-tool-facade.js";
import { createZenXRoomsProfileLoader } from "../src/main/rooms-profile-loader.js";
import { createZenXTrustedPlugin } from "../../../packages/zenx-rooms-plugin/src/runtime.js";
import type { ZenXAutomationControlPort } from "../src/main/capabilities/automation-control-package.js";
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
  let unavailable = false;
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
      if (unavailable) throw Error("Synthetic target Thread unavailable");
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
    unavailable() {
      unavailable = true;
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

test("trusted Room model read/edit/withdraw derives caller from active Host scope and list count shares the journal", async (t) => {
  const f = await fixture(t);
  const questions = await Promise.all(
    Array.from({ length: 5 }, () => f.publish()),
  );
  let captured: any;
  const loader = createZenXRoomsProfileLoader(
    () => f.service as unknown as ZenXAutomationControlPort,
  );
  const runtime = loader({
    createZenXTrustedPlugin: (port: any) => {
      captured = port;
      return createZenXTrustedPlugin(port);
    },
  });
  const invoke = (
    name: string,
    args: Record<string, unknown>,
    threadId = "member-a",
    ui = false,
  ) =>
    runtime.invoke(name, {
      callId: randomUUID(),
      threadId,
      cwd: directoryForInvocation(),
      signal: new AbortController().signal,
      arguments: ui ? { input: args } : args,
      ...(ui ? { trustedPluginUi: true as const } : {}),
    });
  function directoryForInvocation() {
    return "/synthetic-room-model";
  }
  const first: any = await invoke("zenx_rooms_questions", {
    roomId: f.room.id,
  });
  assert.equal(
    first.questions.length,
    4,
    "model reads bounded complete resources before the 1 MiB transport limit",
  );
  assert.equal(first.openCount, 5);
  assert.ok(first.nextAfter);
  const updated: any = await invoke(
    "zenx_rooms_update_question",
    {
      roomId: f.room.id,
      questionId: questions[0]!.id,
      expectedRevision: 1,
      specification: {
        questions: [{ id: "scope", prompt: "Updated by actual member B" }],
      },
    },
    "member-b",
  );
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.origin, questions[0]!.origin);
  await assert.rejects(
    invoke(
      "zenx_rooms_update_question",
      {
        roomId: f.room.id,
        questionId: updated.id,
        expectedRevision: 2,
        specification: content,
        callerThreadId: "member-a",
      },
      "foreign",
    ),
    /Unknown/,
  );
  await assert.rejects(
    invoke("zenx_rooms_questions", { roomId: f.room.id }, "foreign"),
    /current Room workspace member/,
  );
  assert.throws(
    () =>
      captured.modelUpdateRoomQuestion({
        roomId: f.room.id,
        questionId: updated.id,
        expectedRevision: 2,
        specification: content,
      }),
    /not active/,
  );
  await f.service.removeRoomMember(f.room.id, "member-a");
  await assert.rejects(
    invoke("zenx_rooms_questions", { roomId: f.room.id }, "member-a"),
    /current Room workspace member/,
  );
  const list: any = await invoke("zenx_rooms_list", {}, "member-b", true);
  assert.equal(
    list.rooms.find((room: any) => room.id === f.room.id).questionSummary
      .openCount,
    5,
  );
  await invoke(
    "zenx_rooms_withdraw_question",
    { roomId: f.room.id, questionId: updated.id, expectedRevision: 2 },
    "member-b",
  );
  const after: any = await invoke("zenx_rooms_list", {}, "member-b", true);
  assert.equal(
    after.rooms.find((room: any) => room.id === f.room.id).questionSummary
      .openCount,
    4,
  );
  assert.equal((await f.service.roomQuestions(f.room.id)).openCount, 4);
});

test("answer delivery uses ordinary Room mentions and PAW rules, with truthful unavailable target receipts", async (t) => {
  const f = await fixture(t);
  await f.service.create({
    threadId: "member-a",
    kind: "roomMention",
    roomId: f.room.id,
    mention: "A",
    label: "A replies",
    prompt: "Synthetic Room mention",
  });
  const q = await f.publish();
  const sent = await f.service.respondRoomQuestion(
    {
      ...response(q, "mentioned-origin"),
      answers: [
        { questionId: "scope", optionIds: [], text: "@A the answer is stored" },
      ],
    },
    admit,
  );
  assert.equal(sent.response.status, "saved");
  assert.deepEqual(f.dispatched, ["member-a"]);
  assert.equal(sent.delivery!.mentions[0]!.threadId, "member-a");
  const before = f.dispatched.length;
  const another = await f.publish();
  await f.service.removeRoomMember(f.room.id, "member-a");
  const removed = await f.service.respondRoomQuestion(
    {
      ...response(another, "removed-origin"),
      answers: [
        { questionId: "scope", optionIds: [], text: "@A retained Room answer" },
      ],
    },
    admit,
  );
  assert.equal(removed.response.status, "saved");
  assert.deepEqual(removed.delivery!.mentions, []);
  assert.equal(
    f.dispatched.length,
    before,
    "removed source cannot regain Room delivery from a question reply",
  );
  const paw = await f.service.createAssistantRoom({
    name: "Independent PAW workspace",
    members: [{ threadId: "member-b", name: "B" }],
  });
  const pq = await f.service.publishRoomQuestion(
    paw.id,
    { threadId: "member-b", callItemId: "paw-ask" },
    content,
    admit,
  );
  f.unavailable();
  const absent = await f.service.respondRoomQuestion(
    response(pq, "missing-paw-target"),
    admit,
  );
  assert.equal(
    absent.response.status,
    "saved",
    "Room question and human message remain durable even if ordinary delivery fails",
  );
  assert.equal(absent.question!.state, "answered");
  assert.equal(absent.delivery!.mentions[0]!.threadId, "member-b");
  assert.ok(
    absent.delivery!.mentions[0]!.deliveries.every(
      (delivery) =>
        delivery.status === "failed" ||
        delivery.status === "unknown" ||
        delivery.status === "unconfigured",
    ),
  );
  assert.equal("turnId" in absent, false);
  assert.equal("admission" in absent, false);
});

test("full valid answers remain in the Room resource when ordinary Room message size needs a bounded reference", async (t) => {
  const f = await fixture(t);
  const q = await f.publish();
  const answer = "x".repeat(8192);
  const result = await f.service.respondRoomQuestion(
    {
      ...response(q, "full-room-answer"),
      answers: [{ questionId: "scope", optionIds: [], text: answer }],
    },
    admit,
  );
  assert.equal(result.question!.response!.answers![0]!.text, answer);
  const message = await f.service.readRoomMessage(
    q.roomId,
    result.response.messageId!,
  );
  assert.match(
    message!.message.text,
    /Read that Room question for the full answer/,
  );
  assert.ok(Buffer.byteLength(message!.message.text) <= 8000);
  const model = await f.service.roomQuestionsAsMember(
    q.roomId,
    "member-b",
    { includeClosed: true },
    admit,
  );
  assert.equal(model.questions[0]!.response!.answers![0]!.text, answer);
});

test("normal model scoped refs read and mutate the actual Room journal with immutable paging and live membership", async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 5 }, () => f.publish()));
  let runtime = createZenXRoomsProfileLoader(
    () => f.service as unknown as ZenXAutomationControlPort,
  )({ createZenXTrustedPlugin });
  const references = new ModelReferenceRegistry();
  let epoch = "synthetic-epoch-before-restart";
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await invokeModelToolFacade({
      epoch,
      references,
      invocation: {
        name,
        callId: randomUUID(),
        threadId: "member-a",
        cwd: "/synthetic-scoped-room-model",
        signal: new AbortController().signal,
        arguments: args,
      },
      dispatch: async (invocation) => ({
        output: JSON.stringify(await runtime.invoke(name, invocation)),
        exitCode: 0,
      }),
    });
    return JSON.parse(result.output);
  };
  const listing = await call("zenx_rooms_list", {});
  const room = listing.rooms.find((room: any) => room.name === "Workspace");
  assert.equal(room.questionSummary.openCount, 5);
  assert.equal(room.id, undefined);
  const first = await call("zenx_rooms_questions", { room: room.ref });
  assert.equal(first.questions.length, 4);
  const next = await call("zenx_rooms_questions", { page: first.next });
  assert.equal(next.questions.length, 1);
  assert.equal(first.questions[0].id, undefined);
  const changed = await call("zenx_rooms_update_question", {
    question: first.questions[0].ref,
    specification: {
      questions: [{ id: "r1", prompt: "Literal r999 and {{r1}}" }],
    },
  });
  assert.equal(
    changed.specification.questions[0].prompt,
    "Literal r999 and {{r1}}",
  );
  assert.notEqual(changed.ref, first.questions[0].ref);
  await assert.rejects(
    call("zenx_rooms_withdraw_question", { question: first.questions[0].ref }),
    /Room question changed; read before withdrawing/,
  );
  await assert.rejects(
    call("zenx_rooms_questions", { page: first.next }),
    /revision|changed/i,
  );
  await f.restart();
  runtime = createZenXRoomsProfileLoader(
    () => f.service as unknown as ZenXAutomationControlPort,
  )({ createZenXTrustedPlugin });
  epoch = "synthetic-epoch-after-restart";
  await assert.rejects(
    call("zenx_rooms_withdraw_question", { question: changed.ref }),
    /unavailable or retired/,
  );
  const fresh = await call("zenx_rooms_questions", { room: room.ref });
  const edited = fresh.questions.find(
    (question: any) => question.specification.questions[0].id === "r1",
  );
  assert.ok(edited);
  await call("zenx_rooms_withdraw_question", { question: edited.ref });
  assert.equal(f.service.roomQuestionSummary(f.room.id).openCount, 4);
  await f.service.removeRoomMember(f.room.id, "member-a");
  await assert.rejects(
    call("zenx_rooms_questions", { room: room.ref }),
    /current Room workspace member/,
  );
  const independent = await f.service.roomQuestions(f.room.id);
  assert.equal(independent.openCount, 4);
  assert.equal(
    independent.questions.every((question) => question.roomId === f.room.id),
    true,
  );
});
