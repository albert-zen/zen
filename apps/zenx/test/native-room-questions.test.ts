import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import {
  NativeRoomQuestionService,
  subscribeRoomQuestionInvalidations,
} from "../src/main/native-room-question-service.js";
import {
  validateNativeRoomQuestionRequest,
  nativeRoomQuestionFailure,
  unwrapNativeRoomQuestionReply,
} from "../src/native-room-questions.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "native-room-question-api-"),
  );
  const service = await createBundledAutomationPluginService({
    userDataDirectory: directory,
    appServer: {
      onNotification: () => () => {},
      request: async () => {
        throw Error("Must not invent Thread delivery");
      },
    } as never,
  });
  await service.startPlugin("zenx-rooms", {} as never);
  const room = await service.createRoom({
    name: "Synthetic native Room",
    members: [{ threadId: "author", name: "Author" }],
  });
  const other = await service.createRoom({
    name: "Other Room",
    members: [{ threadId: "author", name: "Author" }],
  });
  const question = await service.publishRoomQuestion(
    room.id,
    { threadId: "author", callItemId: "original-call" },
    { questions: [{ id: "scope", prompt: "Synthetic Room-owned question" }] },
    async () => {},
  );
  let current: typeof service | undefined = service;
  const api = new NativeRoomQuestionService(() => current);
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    service,
    room,
    other,
    question,
    api,
    replace() {
      current = undefined;
    },
  };
}

test("native Room API resolves resources after author removal and returns only ordinary Room receipts", async (t) => {
  const f = await fixture(t);
  await f.service.removeRoomMember(f.room.id, "author");
  const page = await f.api.request(
    { method: "list", roomId: f.room.id },
    async () => {},
  );
  assert.ok("questions" in page);
  assert.equal(page.openCount, 1);
  const result = await f.api.request(
    {
      method: "respond",
      params: {
        roomId: f.room.id,
        questionId: f.question.id,
        expectedRevision: 1,
        clientId: "stable-human-id",
        outcome: "answer",
        answers: [
          { questionId: "scope", optionIds: [], text: "Native Room answer" },
        ],
      },
    },
    async () => {},
  );
  assert.ok(result && "response" in result);
  assert.equal(result.response.status, "saved");
  assert.equal("turnId" in result, false);
  const read = await f.api.request(
    {
      method: "read-response",
      roomId: f.room.id,
      questionId: f.question.id,
      clientId: "stable-human-id",
    },
    async () => {},
  );
  assert.deepEqual(read, result);
  const other = await f.api.request(
    { method: "list", roomId: f.other.id },
    async () => {},
  );
  assert.ok("questions" in other);
  assert.equal(other.openCount, 0);
});

test("native Room API validates exact Room DTOs and never accepts private Thread or owner arguments", () => {
  for (const value of [
    { method: "list", roomId: "room", threadId: "private" },
    {
      method: "list",
      owner: { kind: "room", id: "room" },
      params: { threadId: "private" },
    },
    {
      method: "read",
      roomId: "room",
      questionId: "q",
      defaultThreadId: "private",
    },
    {
      method: "list",
      roomId: "room",
      options: { expectedWorkspaceRevision: -1 },
    },
    {
      method: "respond",
      params: {
        roomId: "room",
        questionId: "q",
        expectedRevision: 1,
        clientId: "id",
        outcome: "cancel",
        answers: [],
      },
    },
  ])
    assert.throws(() => validateNativeRoomQuestionRequest(value));
  assert.deepEqual(
    validateNativeRoomQuestionRequest({
      method: "list",
      roomId: "room",
      options: { expectedWorkspaceRevision: 0, includeClosed: true },
    }),
    {
      method: "list",
      roomId: "room",
      options: { expectedWorkspaceRevision: 0, includeClosed: true },
    },
  );
});

test("native Room document denial prevents commit and uncertain reply does not enable a new send", async (t) => {
  const f = await fixture(t);
  const input = {
    method: "respond" as const,
    params: {
      roomId: f.room.id,
      questionId: f.question.id,
      expectedRevision: 1,
      clientId: "one-native-id",
      outcome: "cancel" as const,
    },
  };
  await assert.rejects(
    f.api.request(input, async () => {
      throw Error("Synthetic document replaced");
    }),
    /document replaced/,
  );
  assert.equal(
    (await f.service.readRoomQuestion(f.room.id, f.question.id))!.state,
    "open",
  );
  const invalid = nativeRoomQuestionFailure(
    Object.assign(Error("Invalid input"), {
      code: "room_question_invalid_request",
    }),
  );
  assert.throws(
    () => unwrapNativeRoomQuestionReply(invalid),
    (error: any) =>
      error.roomQuestionRejected === true &&
      error.roomQuestionUnknown === false,
  );
  const unknown = nativeRoomQuestionFailure(
    Error("Receipt lost after possible commit"),
  );
  assert.throws(
    () => unwrapNativeRoomQuestionReply(unknown),
    (error: any) =>
      error.roomQuestionUnknown === true &&
      error.roomQuestionRejected === false,
  );
});

test("native Room service replacement after possible save returns unknown and readback preserves identity", async (t) => {
  const f = await fixture(t);
  let replaceAfterSave = false;
  const proxy = Object.create(f.service) as typeof f.service;
  proxy.respondRoomQuestion = async (input, admit) => {
    const result = await f.service.respondRoomQuestion(input, admit);
    if (replaceAfterSave) current = undefined;
    return result;
  };
  let current: typeof f.service | undefined = proxy;
  // Class methods use private state, so forward only the methods the native port uses.
  proxy.roomsAvailable = () => f.service.roomsAvailable();
  proxy.snapshot = () => f.service.snapshot();
  const api = new NativeRoomQuestionService(() => current);
  replaceAfterSave = true;
  await assert.rejects(
    api.request(
      {
        method: "respond",
        params: {
          roomId: f.room.id,
          questionId: f.question.id,
          expectedRevision: 1,
          clientId: "lost-native-ack",
          outcome: "cancel",
        },
      },
      async () => {},
    ),
    /unknown|may have committed/,
  );
  const read = await f.service.readRoomQuestionResponse(
    f.room.id,
    f.question.id,
    "lost-native-ack",
  );
  assert.equal(read.response.status, "saved");
  assert.equal(read.question!.state, "cancelled");
});

test("native document replacement after a saved response is unknown and never unsaves the Room receipt", async (t) => {
  const f = await fixture(t);
  let valid = true;
  const proxy = {
    roomsAvailable: () => f.service.roomsAvailable(),
    snapshot: () => f.service.snapshot(),
    roomQuestions: f.service.roomQuestions.bind(f.service),
    readRoomQuestion: f.service.readRoomQuestion.bind(f.service),
    readRoomQuestionResponse: f.service.readRoomQuestionResponse.bind(
      f.service,
    ),
    respondRoomQuestion: async (
      ...args: Parameters<typeof f.service.respondRoomQuestion>
    ) => {
      const result = await f.service.respondRoomQuestion(...args);
      valid = false;
      return result;
    },
  };
  const api = new NativeRoomQuestionService(() => proxy);
  const input = {
    method: "respond" as const,
    params: {
      roomId: f.room.id,
      questionId: f.question.id,
      expectedRevision: 1,
      clientId: "same-original-client-id",
      outcome: "cancel" as const,
    },
  };
  await assert.rejects(
    api.request(input, async () => {
      if (!valid) throw Error("Native document was replaced");
    }),
    /document was replaced/,
  );
  const read = await f.service.readRoomQuestionResponse(
    f.room.id,
    f.question.id,
    "same-original-client-id",
  );
  assert.equal(read.response.status, "saved");
  assert.equal(read.question!.state, "cancelled");
  assert.equal(
    nativeRoomQuestionFailure(Error("Native document was replaced")).outcome,
    "unknown",
  );
});

test("model publication/edit/withdraw and human resolution invalidate only the same Room journal source", async (t) => {
  const f = await fixture(t);
  const invalidations: string[] = [];
  const unsubscribe = subscribeRoomQuestionInvalidations(f.service, (id) =>
    invalidations.push(id),
  );
  t.after(unsubscribe);
  const updated = await f.service.updateRoomQuestion(
    {
      roomId: f.room.id,
      questionId: f.question.id,
      expectedRevision: 1,
      specification: {
        questions: [{ id: "scope", prompt: "Revised synthetic question" }],
        answerTemplate: "{{scope}}",
      },
    },
    "author",
    async () => {},
  );
  const second = await f.service.publishRoomQuestion(
    f.room.id,
    { threadId: "author", callItemId: "second-runtime-call" },
    { questions: [{ id: "second", prompt: "Second Room-owned question" }] },
    async () => {},
  );
  await f.service.withdrawRoomQuestion(
    {
      roomId: f.room.id,
      questionId: second.id,
      expectedRevision: second.revision,
    },
    "author",
    async () => {},
  );
  await f.api.request(
    {
      method: "respond",
      params: {
        roomId: f.room.id,
        questionId: updated.id,
        expectedRevision: updated.revision,
        clientId: "journal-invalidation-response",
        outcome: "cancel",
      },
    },
    async () => {},
  );
  await f.api.request({ method: "list", roomId: f.other.id }, async () => {});
  assert.deepEqual(invalidations, [f.room.id, f.room.id, f.room.id, f.room.id]);
  await f.service.deleteRoom(f.room.id);
  assert.deepEqual(invalidations, [
    f.room.id,
    f.room.id,
    f.room.id,
    f.room.id,
    f.room.id,
  ]);
});

test("first mutation deleting a persisted Room invalidates it after startup summary admission was unavailable", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "native-room-delete-invalidation-"),
  );
  const options = {
    userDataDirectory: directory,
    appServer: {
      onNotification: () => () => {},
      request: async () => {
        throw Error("No Thread execution");
      },
    } as never,
  };
  let service = await createBundledAutomationPluginService(options);
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  await service.startPlugin("zenx-rooms", {} as never);
  const room = await service.createRoom({
    name: "Persisted synthetic Room",
    members: [{ threadId: "synthetic-author", name: "Author" }],
  });
  await service.close();
  service = await createBundledAutomationPluginService(options);
  const invalidations: string[] = [];
  const unsubscribe = subscribeRoomQuestionInvalidations(service, (id) =>
    invalidations.push(id),
  );
  t.after(unsubscribe);
  await service.startPlugin("zenx-rooms", {} as never);
  invalidations.length = 0;
  await service.deleteRoom(room.id);
  assert.deepEqual(invalidations, [room.id]);
});
