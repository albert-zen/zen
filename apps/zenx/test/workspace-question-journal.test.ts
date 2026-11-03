import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AutomationTransactionStore,
  fingerprintOperationBody,
} from "../src/main/automation-transaction-store.js";
import {
  canonicalRoomQuestion,
  roomQuestionResponseText,
  type RoomQuestion,
} from "../src/room-questions.js";
const room = (id: string) => ({
  id,
  name: id,
  members: [
    { threadId: "member-a", name: "A" },
    { threadId: "member-b", name: "B" },
  ],
  createdAt: 1,
  messageCount: 0,
});
const question = (
  roomId: string,
  id: string,
  threadId = "member-a",
): RoomQuestion =>
  canonicalRoomQuestion({
    roomId,
    id,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    origin: { threadId, callItemId: `call-${id}` },
    specification: {
      questions: [{ id: "q", prompt: "Synthetic Room workspace question" }],
    },
    state: "open",
  });
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "room-workspace-question-"),
  );
  const options = { directory, assertWriterLease: () => {} };
  let journal = await AutomationTransactionStore.create(options, {
    triggers: [],
    history: [],
    rooms: [room("room-a"), room("room-b")],
  });
  t.after(async () => {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get journal() {
      return journal;
    },
    async restart() {
      const generation = journal.generation;
      await journal.close();
      journal = await AutomationTransactionStore.open(options, generation);
    },
  };
}
test("Room workspace owns questions independently of participant Threads and survives removal/restart", async (t) => {
  const f = await fixture(t);
  const a = question("room-a", "a"),
    b = question("room-a", "b", "member-b"),
    other = question("room-b", "other");
  await f.journal.append({
    metadata: f.journal.metadata(),
    roomEvents: [
      { type: "question", question: a },
      { type: "question", question: b },
      { type: "question", question: other },
    ],
  });
  assert.deepEqual(f.journal.roomQuestionSummary("room-a"), {
    revision: 2,
    openCount: 2,
    totalQuestions: 2,
  });
  assert.equal(
    (await f.journal.readRoomQuestions("room-b")).questions[0]!.id,
    "other",
  );
  const metadata = f.journal.metadata();
  metadata.rooms[0]!.members = [];
  await f.journal.append({ metadata, roomEvents: [] });
  assert.equal(
    (await f.journal.readRoomQuestions("room-a")).openCount,
    2,
    "removing participants never deletes workspace resources",
  );
  await assert.rejects(
    f.journal.append({
      metadata: f.journal.metadata(),
      roomEvents: [
        {
          type: "question",
          question: question("room-a", "removed-new-publication"),
        },
      ],
    }),
    /current workspace member/,
  );
  const before = await f.journal.readRoomQuestions("room-a");
  await f.restart();
  assert.deepEqual(await f.journal.readRoomQuestions("room-a"), before);
  const deleted = f.journal.metadata();
  deleted.rooms = deleted.rooms.filter((r) => r.id !== "room-a");
  await f.journal.append({ metadata: deleted, roomEvents: [] });
  await assert.rejects(f.journal.readRoomQuestions("room-a"), /unavailable/);
});
test("revision, immutable origin, owner, terminal and response atomicity are enforced by the Room journal", async (t) => {
  const f = await fixture(t);
  const original = question("room-a", "a");
  await f.journal.append({
    metadata: f.journal.metadata(),
    roomEvents: [{ type: "question", question: original }],
  });
  const update = {
    ...original,
    revision: 2,
    updatedAt: 2,
    specification: {
      questions: [{ id: "q", prompt: "Revised synthetic question" }],
      answerTemplate: "{{q}}",
    },
  };
  await f.journal.append({
    metadata: f.journal.metadata(),
    roomEvents: [{ type: "question", question: update }],
  });
  for (const invalid of [
    update,
    {
      ...update,
      revision: 3,
      origin: { threadId: "other", callItemId: "changed" },
    },
    { ...original, id: "other-id" },
  ])
    await assert.rejects(
      f.journal.append({
        metadata: f.journal.metadata(),
        roomEvents: [{ type: "question", question: invalid }],
      }),
      /revision|ownership|fresh|origin/,
    );
  const messageId = randomUUID(),
    operationId = `${randomUUID()}:${randomUUID()}`;
  const answered: RoomQuestion = {
    ...update,
    revision: 3,
    updatedAt: 3,
    state: "answered",
    response: {
      clientId: "stable-human-response",
      questionRevision: 2,
      outcome: "answer",
      answers: [{ questionId: "q", optionIds: [], text: "Room-owned answer" }],
      messageId,
      operationId,
      receivedAt: 3,
    },
  };
  await assert.rejects(
    f.journal.append({
      metadata: f.journal.metadata(),
      roomEvents: [{ type: "question", question: answered }],
    }),
    /same transaction/,
  );
  const text = roomQuestionResponseText(answered, answered.response!);
  const metadata = f.journal.metadata();
  metadata.rooms[0]!.messageCount = 1;
  metadata.rooms[0]!.operations = [
    {
      id: operationId,
      createdAt: 3,
      acknowledged: false,
      messageId,
      mentions: [],
      bodyRef: {
        kind: "message",
        id: messageId,
        sha256: fingerprintOperationBody({ text }),
      },
    },
  ];
  const wrongMetadata = structuredClone(metadata);
  const wrongText = "Unrelated human Room message";
  wrongMetadata.rooms[0]!.operations![0]!.bodyRef.sha256 =
    fingerprintOperationBody({ text: wrongText });
  await assert.rejects(
    f.journal.append({
      metadata: wrongMetadata,
      roomEvents: [
        { type: "question", question: answered },
        {
          type: "message",
          message: {
            id: messageId,
            roomId: "room-a",
            author: "You",
            text: wrongText,
            createdAt: 3,
            kind: "human",
            originThreadId: null,
            originTurnId: null,
          },
        },
      ],
    }),
    /same transaction/,
  );
  await f.journal.append({
    metadata,
    roomEvents: [
      { type: "question", question: answered },
      {
        type: "message",
        message: {
          id: messageId,
          roomId: "room-a",
          author: "You",
          text,
          createdAt: 3,
          kind: "human",
          originThreadId: null,
          originTurnId: null,
        },
      },
    ],
  });
  assert.equal((await f.journal.readRoomQuestions("room-a")).openCount, 0);
  assert.equal(
    (await f.journal.readRoomQuestion("room-a", "a"))!.response!.messageId,
    messageId,
  );
  assert.equal(
    (await f.journal.readRoomPage("room-a")).messages[0]!.id,
    messageId,
  );
  await assert.rejects(
    f.journal.append({
      metadata: f.journal.metadata(),
      roomEvents: [
        { type: "question", question: { ...answered, revision: 4 } },
      ],
    }),
    /terminal/,
  );
  await f.restart();
  assert.equal(
    (await f.journal.readRoomQuestion("room-a", "a"))!.response!.clientId,
    "stable-human-response",
  );
});
test("Room owner filtering precedes pagination and openCount does not borrow private or other Room questions", async (t) => {
  const f = await fixture(t);
  const questions = Array.from({ length: 40 }, (_, i) =>
    question("room-a", `q-${i}`),
  );
  await f.journal.append({
    metadata: f.journal.metadata(),
    roomEvents: [
      ...questions.map((q) => ({ type: "question" as const, question: q })),
      { type: "question", question: question("room-b", "other") },
    ],
  });
  const first = await f.journal.readRoomQuestions("room-a");
  assert.equal(first.questions.length, 32);
  assert.equal(first.openCount, 40);
  const last = await f.journal.readRoomQuestions("room-a", {
    afterQuestionId: first.nextAfter,
    expectedWorkspaceRevision: first.revision,
  });
  assert.equal(last.questions.length, 8);
  assert.equal(last.nextAfter, undefined);
  const withdrawn = {
    ...questions[0]!,
    revision: 2,
    updatedAt: 2,
    state: "withdrawn" as const,
  };
  await f.journal.append({
    metadata: f.journal.metadata(),
    roomEvents: [{ type: "question", question: withdrawn }],
  });
  await assert.rejects(
    f.journal.readRoomQuestions("room-a", {
      afterQuestionId: first.nextAfter,
      expectedWorkspaceRevision: first.revision,
    }),
    /changed/,
  );
  assert.equal((await f.journal.readRoomQuestions("room-a")).openCount, 39);
  assert.equal(f.journal.roomQuestionSummary("room-b").openCount, 1);
});
