import assert from "node:assert/strict";
import test from "node:test";
import {
  referenceMessage,
  parseSentReferenceMessage,
} from "../src/renderer/src/reference-draft.js";
import { applyNativeThreadEvent } from "../src/renderer/src/thread-view-state.js";
import { runtimeThread } from "./fixtures/agent-runtime-data.js";
const quotes = [
  {
    kind: "message" as const,
    name: "ZenX",
    cwd: "/project",
    threadId: "thread-a",
    id: "source-1",
    excerpt: '  const value = "原文";\n\tkeep(value);  ',
  },
  {
    kind: "message" as const,
    name: "ZenX",
    cwd: "/project",
    threadId: "thread-a",
    id: "source-2",
    excerpt: "第二段\n\nexact punctuation !",
  },
];
test("bound sent quotes retain exact text/source once, without changing ordinary sends", () => {
  const plain =
    'An ordinary [Message quote; excerpt: "looks similar"]\n[zenx-quoted-message:v1]';
  assert.equal(referenceMessage(plain, [], "client-a"), plain);
  const sent = referenceMessage("What about both?", quotes, "client-a");
  const view = parseSentReferenceMessage(sent, "client-a");
  assert.equal(view.text, "What about both?");
  assert.deepEqual(
    view.quotes,
    quotes.map(({ threadId, id, excerpt }) => ({ threadId, id, excerpt })),
  );
  assert.equal(
    sent.split(JSON.stringify(quotes[0]!.excerpt)).length - 1,
    1,
    "excerpt must not be serialized twice",
  );
  assert.equal(
    referenceMessage("What about both?", quotes, "client-a"),
    sent,
    "same retry identity yields same exact payload",
  );
});
test("malformed, partial, mismatched and missing-ID data remain complete ordinary text", () => {
  const sent = referenceMessage("Question", quotes, "client-a");
  for (const [text, id] of [
    [sent, "other"],
    [sent, null],
    [sent, undefined],
    [sent.slice(0, -1), "client-a"],
    ["prefix\n" + sent, "client-a"],
    [sent + "\nuser suffix", "client-a"],
  ] as const) {
    assert.deepEqual(parseSentReferenceMessage(text, id), { text, quotes: [] });
  }
});
test("canonical queue admission/recovery retains the bound client ID and payload", () => {
  const sent = referenceMessage("Follow up", quotes, "client-a");
  const input = [{ type: "text" as const, text: sent }];
  let thread = runtimeThread([], "inProgress", "thread-a");
  thread = applyNativeThreadEvent(thread, {
    type: "item_completed",
    item: {
      type: "user_message_queued",
      id: "queue-a",
      threadId: "thread-a",
      createdAt: "2026-10-20T08:00:00Z",
      clientId: "client-a",
      input,
    },
  });
  assert.equal(thread.queuedMessages?.[0]?.text, sent);
  thread = applyNativeThreadEvent(thread, {
    type: "item_completed",
    item: {
      type: "user_message",
      id: "sent-a",
      threadId: "thread-a",
      turnId: "runtime-turn",
      createdAt: "2026-10-20T08:00:01Z",
      clientId: "client-a",
      content: input,
    },
  });
  const message = thread.turns
    .flatMap((turn) => turn.items)
    .find((item) => item.id === "sent-a");
  assert.ok(message?.type === "userMessage");
  assert.equal(message.clientId, "client-a");
  assert.deepEqual(
    parseSentReferenceMessage(
      message.content.map((part) => part.text).join("\n"),
      message.clientId,
    ).quotes,
    quotes.map(({ threadId, id, excerpt }) => ({ threadId, id, excerpt })),
  );
  assert.equal(thread.queuedMessages?.length, 0);
});
