import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ModelTool } from "../../../src/model.js";
import { ModelReferenceRegistry } from "../../../src/model-references.js";
import {
  decodeRoomArguments,
  projectRoomResult,
  roomModelDefinition,
} from "../src/main/capabilities/model-room-facade.js";
import {
  hasModelToolFacade,
  isModelCallableTool,
} from "../src/main/capabilities/model-tool-facade.js";
const manifest = JSON.parse(
  await readFile(
    new URL(
      "../../../packages/zenx-rooms-plugin/zenx.plugin.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const epoch = "synthetic-host-generation";
const owner = "synthetic-member";
const rawRoom = "RAW-independent-room";
const rawQuestion = "RAW-room-question";
const specification = {
  questions: [{ id: "r1", prompt: "Literal r1 and {{r1}} stay unchanged" }],
  answerTemplate: "Selected {{r1}}",
};
function fixture() {
  const registry = new ModelReferenceRegistry();
  const refs = registry.scope(owner);
  const room = refs.bind("rooms", "room", { id: rawRoom });
  const question = {
    roomId: rawRoom,
    id: rawQuestion,
    revision: 2,
    createdAt: 1,
    updatedAt: 2,
    origin: { threadId: "RAW-origin-thread", callItemId: "RAW-call" },
    specification,
    state: "open",
  };
  return { registry, refs, room, question };
}
test("normal Room question tools expose scoped owner, question snapshots and bounded page references", () => {
  for (const name of [
    "zenx_rooms_questions",
    "zenx_rooms_update_question",
    "zenx_rooms_withdraw_question",
  ]) {
    assert.equal(hasModelToolFacade(name), true);
    assert.equal(isModelCallableTool({ name }), true);
    const source = manifest.tools.find((tool: ModelTool) => tool.name === name);
    const original = structuredClone(source);
    const tool = roomModelDefinition(source);
    assert.deepEqual(
      source,
      original,
      "model projection does not mutate native/UI schema",
    );
    const fields = tool.inputSchema.properties!;
    for (const field of [
      "roomId",
      "questionId",
      "expectedRevision",
      "afterQuestionId",
      "expectedWorkspaceRevision",
    ])
      assert.equal(field in fields, false);
    if (name === "zenx_rooms_questions") {
      assert.ok(fields.room);
      assert.ok(fields.page);
      assert.equal((fields.limit as any).maximum, 4);
    } else {
      assert.equal("room" in fields, false);
      assert.ok(fields.question);
      assert.ok(tool.inputSchema.required?.includes("question"));
    }
  }
});
test("Room question projection preserves literal specification and answer but hides native routing and receipt identifiers", () => {
  const f = fixture();
  const result: any = projectRoomResult(
    "zenx_rooms_questions",
    {
      roomId: rawRoom,
      revision: 10,
      openCount: 2,
      totalQuestions: 7,
      questions: [
        f.question,
        {
          ...f.question,
          id: "RAW-resolved-question",
          revision: 3,
          state: "answered",
          response: {
            clientId: "RAW-human-client",
            questionRevision: 2,
            outcome: "answer",
            answers: [
              { questionId: "r1", text: "Literal r999", optionIds: [] },
            ],
            messageId: "RAW-human-message",
            operationId: "RAW-room-operation",
            receivedAt: 3,
          },
        },
      ],
      nextAfter: "RAW-resolved-question",
    },
    { roomId: rawRoom, includeClosed: true },
    f.refs,
    epoch,
  );
  assert.equal(result.room, f.room);
  assert.equal(result.openCount, 2);
  assert.equal(result.totalQuestions, 7);
  assert.deepEqual(result.questions[0].specification, specification);
  assert.equal(result.questions[1].response.answers[0].text, "Literal r999");
  assert.deepEqual(
    f.refs.resolve(result.questions[0].ref, "rooms", "question", epoch),
    { roomId: rawRoom, id: rawQuestion, revision: 2 },
  );
  assert.deepEqual(
    f.refs.resolve(result.questions[1].response.message, "rooms", "message"),
    { roomId: rawRoom, id: "RAW-human-message" },
  );
  assert.equal(JSON.stringify(result).includes("RAW-"), false);
  assert.deepEqual(
    decodeRoomArguments(
      "zenx_rooms_questions",
      { page: result.next },
      f.refs,
      epoch,
    ),
    {
      roomId: rawRoom,
      afterQuestionId: "RAW-resolved-question",
      expectedWorkspaceRevision: 10,
      includeClosed: true,
    },
  );
  const other = f.refs.bind("rooms", "room", { id: "RAW-other-room" });
  for (const input of [
    { page: result.next, room: other },
    { page: result.next, includeClosed: false },
    { room: f.room, afterQuestionId: rawQuestion },
    { room: f.room, expectedWorkspaceRevision: 10 },
    { roomId: rawRoom },
  ])
    assert.throws(() =>
      decodeRoomArguments("zenx_rooms_questions", input, f.refs, epoch),
    );
  assert.throws(
    () =>
      decodeRoomArguments(
        "zenx_rooms_questions",
        { page: result.next },
        f.refs,
        "new-generation",
      ),
    /unavailable or retired/,
  );
});
test("question snapshot binds one Room and exact revision; foreign owner, wrong kind, stale generation and raw overrides cannot dispatch", () => {
  const f = fixture();
  const projected = projectRoomResult(
    "zenx_rooms_update_question",
    f.question,
    {},
    f.refs,
    epoch,
  );
  const input = { question: projected.ref, specification };
  assert.deepEqual(
    decodeRoomArguments("zenx_rooms_update_question", input, f.refs, epoch),
    {
      roomId: rawRoom,
      questionId: rawQuestion,
      expectedRevision: 2,
      specification,
    },
  );
  assert.deepEqual(
    decodeRoomArguments(
      "zenx_rooms_withdraw_question",
      { question: projected.ref },
      f.refs,
      epoch,
    ),
    { roomId: rawRoom, questionId: rawQuestion, expectedRevision: 2 },
  );
  const second = projectRoomResult(
    "zenx_rooms_update_question",
    { ...f.question, revision: 3 },
    {},
    f.refs,
    epoch,
  );
  assert.notEqual(second.ref, projected.ref);
  for (const extra of [
    { room: f.room },
    { roomId: rawRoom },
    { questionId: rawQuestion },
    { expectedRevision: 3 },
  ])
    assert.throws(() =>
      decodeRoomArguments(
        "zenx_rooms_update_question",
        { ...input, ...extra },
        f.refs,
        epoch,
      ),
    );
  assert.throws(
    () =>
      decodeRoomArguments(
        "zenx_rooms_update_question",
        { ...input, question: f.room },
        f.refs,
        epoch,
      ),
    /unavailable or retired/,
  );
  assert.throws(
    () =>
      decodeRoomArguments(
        "zenx_rooms_update_question",
        input,
        f.refs,
        "new-generation",
      ),
    /unavailable or retired/,
  );
  const foreign = new ModelReferenceRegistry().scope(
    "foreign-member",
    f.refs.newBindings,
  );
  assert.throws(
    () =>
      decodeRoomArguments("zenx_rooms_update_question", input, foreign, epoch),
    /unavailable or retired/,
  );
});
test("Room list Asking summary is projected from the workspace read without member Thread counters", () => {
  const f = fixture();
  const summary = { revision: 5, openCount: 2, totalQuestions: 8 };
  const result: any = projectRoomResult(
    "zenx_rooms_list",
    {
      rooms: [
        {
          id: rawRoom,
          name: "Room",
          members: [],
          createdAt: 1,
          questionSummary: summary,
        },
      ],
    },
    {},
    f.refs,
    epoch,
  );
  assert.deepEqual(result.rooms[0].questionSummary, summary);
  assert.equal(result.rooms[0].ref, f.room);
});
