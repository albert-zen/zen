import assert from "node:assert/strict";
import test from "node:test";
import { pendingQueuedMessages } from "../src/input-queue.js";
import { selectThreadHistoryWindow } from "../src/thread-history-window.js";
import type { CanonicalItem } from "../src/item.js";

import { historyWindowFixture as fixture } from "./thread-history-window-fixture.js";

test("history windows use stable exclusive Turn cursors and preserve every original item", () => {
  const items = fixture(41);
  const newest = selectThreadHistoryWindow("thread", items);
  assert.equal(newest.turnIds.size, 20);
  assert.equal([...newest.turnIds][0], "turn-21");
  const older = selectThreadHistoryWindow("thread", items, {
    before: newest.history.before!,
  });
  const afterAppend = selectThreadHistoryWindow("thread", fixture(45), {
    before: newest.history.before!,
  });
  assert.deepEqual(older, afterAppend);
  assert.equal([...older.turnIds][0], "turn-1");
  const oldest = selectThreadHistoryWindow("thread", items, {
    before: older.history.before!,
  });
  assert.equal(oldest.history.before, null);
  const recovered = [...oldest.items, ...older.items, ...newest.items];
  const unique = [
    ...new Map(recovered.map((item) => [item.id, item])).values(),
  ];
  assert.deepEqual(unique, items);
});

test("history cursor rejects a different Thread or missing boundary instead of skipping data", () => {
  const items = fixture(25);
  const first = selectThreadHistoryWindow("thread", items);
  assert.throws(
    () =>
      selectThreadHistoryWindow("other", items, {
        before: first.history.before!,
      }),
    /cursor/iu,
  );
  assert.throws(
    () =>
      selectThreadHistoryWindow("thread", fixture(2), {
        before: first.history.before!,
      }),
    /cursor/iu,
  );
  assert.throws(
    () => selectThreadHistoryWindow("thread", items, { before: "bad" }),
    /cursor/iu,
  );
  assert.throws(
    () => selectThreadHistoryWindow("thread", items, { limit: 0 }),
    /limit/iu,
  );
});

test("initial pure text history stays bounded as durable history grows", () => {
  const small = selectThreadHistoryWindow("thread", fixture(256));
  const large = selectThreadHistoryWindow("thread", fixture(1200));
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  assert(bytes(large) < 500 * 1024);
  assert(bytes(large) <= bytes(small) * 1.25);
});

test("pending queues keep original anchors and complete edit chains outside the visible Turns", () => {
  const items = fixture(45);
  const fact = { threadId: "thread", createdAt: "2026-01-01T00:00:00Z" };
  items.splice(
    1,
    0,
    {
      ...fact,
      id: "pending",
      type: "user_message_queued",
      clientId: "pending-client",
      input: [{ type: "text", text: "old draft" }],
    },
    {
      ...fact,
      id: "settled",
      type: "user_message_queued",
      clientId: "settled-client",
      input: [{ type: "text", text: "settled draft" }],
    },
    {
      ...fact,
      id: "cancel",
      type: "user_message_queue_cancelled",
      queuedItemId: "settled",
      clientId: "settled-client",
    },
    {
      ...fact,
      id: "edit",
      type: "user_message_queue_edited",
      queuedItemId: "pending",
      clientId: "pending-client",
      revision: 1,
      editId: "edit-request",
      input: [{ type: "text", text: "new draft" }],
    },
  );
  const window = selectThreadHistoryWindow("thread", items);
  assert(window.items.some((item) => item.id === "pending"));
  assert(window.items.some((item) => item.id === "edit"));
  assert(!window.items.some((item) => item.id === "settled"));
  assert.deepEqual(
    pendingQueuedMessages(window.items),
    pendingQueuedMessages(items),
  );
});

test("a single large tool result is exact, explicitly outside the ordinary text window byte target", () => {
  const items = fixture(1);
  const output = "large-tool-result\n".repeat(262144);
  items.splice(
    3,
    0,
    {
      type: "tool_call",
      id: "call-item",
      threadId: "thread",
      turnId: "turn-0",
      createdAt: "2026-01-01T00:00:00Z",
      callId: "call",
      name: "shell",
      arguments: { command: "synthetic" },
    },
    {
      type: "tool_result",
      id: "result-item",
      threadId: "thread",
      turnId: "turn-0",
      createdAt: "2026-01-01T00:00:00Z",
      callId: "call",
      output,
      exitCode: 0,
    },
  );
  const window = selectThreadHistoryWindow("thread", items);
  const result = window.items.find((item) => item.type === "tool_result");
  assert.equal(result?.type === "tool_result" && result.output, output);
  assert.equal(Buffer.byteLength(output), 4718592);
  console.log(
    "single tool result exact bytes",
    Buffer.byteLength(output),
    "window JSON",
    Buffer.byteLength(JSON.stringify(window)),
  );
});

test("an answer in the visible window retains its exact original question outside the page", () => {
  const items = fixture(45);
  const call: CanonicalItem = {
    type: "tool_call",
    id: "old-question",
    threadId: "thread",
    turnId: "turn-0",
    createdAt: "2026-01-01T00:00:00Z",
    callId: "question-rpc",
    name: "ask_user_question",
    arguments: {
      questions: [
        {
          id: "question",
          prompt: "Which option?",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      ],
    },
  };
  items.splice(3, 0, call);
  const reply = items.find((item) => item.id === "user-44")!;
  assert.equal(reply.type, "user_message");
  if (reply.type === "user_message")
    reply.questionReply = {
      version: 1,
      request: { threadId: "thread", callItemId: "old-question" },
      outcome: "answer",
      answers: [{ questionId: "question", optionIds: ["b"] }],
    };
  const window = selectThreadHistoryWindow("thread", items);
  assert.deepEqual(
    window.items.find((item) => item.id === "old-question"),
    call,
  );
  assert.equal(
    window.turnIds.has("turn-0"),
    false,
    "Support facts do not materialize an old transcript Turn",
  );
});
