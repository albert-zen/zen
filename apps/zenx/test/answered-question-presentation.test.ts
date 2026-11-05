import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalItem } from "../../../src/item.js";
import {
  renderUserQuestionReply,
  parseUserQuestionSpecification,
  type UserQuestionReply,
} from "../../../src/user-question.js";
import {
  indexAnsweredQuestions,
  type AnsweredQuestionPresentation,
} from "../src/renderer/src/answered-question-presentation.js";

const specification = parseUserQuestionSpecification({
  questions: [
    {
      id: "scope",
      prompt: "Which updates should I prepare?",
      multiSelect: true,
      options: [
        { id: "brief", label: "Short summary", description: "Key points only" },
        { id: "full", label: "Full report" },
      ],
    },
    { id: "note", prompt: "Anything else?" },
  ],
});
const reply: UserQuestionReply = {
  version: 1,
  request: { threadId: "thread-a", callItemId: "call-a" },
  outcome: "answer",
  answers: [
    {
      questionId: "scope",
      optionIds: ["full", "brief"],
      text: "Keep the examples.",
    },
    {
      questionId: "note",
      optionIds: [],
      text: "Literal **text**\nSecond line",
    },
  ],
};
const base = {
  threadId: "thread-a",
  turnId: "turn-a",
  createdAt: "2026-11-05T00:00:00Z",
};
const call: CanonicalItem = {
  ...base,
  type: "tool_call",
  id: "call-a",
  callId: "rpc-a",
  name: "ask_user_question",
  arguments: specification as unknown as Record<string, unknown>,
};
const message: Extract<CanonicalItem, { type: "user_message" }> = {
  ...base,
  type: "user_message",
  id: "answer-a",
  questionReply: reply,
  text: renderUserQuestionReply(specification, reply),
};

test("native answers show all selected labels in authored order and exact free text", () => {
  const items = [call, message];
  const before = JSON.stringify(items);
  const view = indexAnsweredQuestions(items).get(message.id)!;
  assert.deepEqual(
    view.questions?.map(({ selectedLabels, text }) => ({
      selectedLabels,
      text,
    })),
    [
      {
        selectedLabels: ["Short summary", "Full report"],
        text: "Keep the examples.",
      },
      { selectedLabels: [], text: "Literal **text**\nSecond line" },
    ],
  );
  assert.equal(
    view.questions?.[0]?.question.options?.[0]?.description,
    "Key points only",
  );
  assert.equal(JSON.stringify(items), before);
});
test("authored short ID reply header is accepted without UUID matching", () => {
  const text = message.text!.replace(
    "Reply to question call-a:",
    "Reply to questions scope, note:",
  );
  assert.ok(
    indexAnsweredQuestions([call, { ...message, text }]).get(message.id)
      ?.questions,
  );
});
test("missing, ambiguous, malformed or mismatched original preserves recorded answer", () => {
  for (const calls of [
    [],
    [call, call],
    [{ ...call, arguments: { questions: [] } }],
    [{ ...call, threadId: "other-thread" }],
  ]) {
    const view: AnsweredQuestionPresentation = indexAnsweredQuestions([
      ...calls,
      message,
    ]).get(message.id)!;
    assert.equal(view.questions, undefined);
    assert.equal(
      view.fallbackText,
      message.text!.split("\n").slice(1).join("\n"),
    );
  }
  const changed = { ...message, text: "The recorded answer differs" };
  assert.deepEqual(indexAnsweredQuestions([call, changed]).get(message.id), {
    fallbackText: changed.text,
  });
});
test("ordinary lookalike text, cancellation and cross-thread metadata are not reinterpreted", () => {
  for (const input of [
    { ...message, questionReply: undefined },
    {
      ...message,
      questionReply: {
        ...reply,
        request: { ...reply.request, threadId: "other" },
      },
    },
    {
      ...message,
      questionReply: {
        version: 1 as const,
        request: reply.request,
        outcome: "cancel" as const,
      },
    },
  ]) {
    assert.equal(indexAnsweredQuestions([call, input]).size, 0);
  }
});
test("unknown selected option never invents a label or drops recorded content", () => {
  const invalid = {
    ...message,
    questionReply: {
      ...reply,
      outcome: "answer" as const,
      answers: [{ questionId: "scope", optionIds: ["gone"] }],
    },
  };
  assert.equal(
    indexAnsweredQuestions([call, invalid]).get(message.id)?.questions,
    undefined,
  );
});

test("transcript search indexes literal displayed answers without hidden reply headers or bindings", async () => {
  const { indexTurnFindText, searchTranscript } =
    await import("../src/renderer/src/transcript-find-index.js");
  const item = {
    type: "userMessage",
    id: message.id,
    clientId: null,
    content: [{ type: "text", text: message.text!, text_elements: [] }],
  } as const;
  const turn = {
    id: "turn-a",
    status: "completed",
    items: [item],
  } as unknown as import("../src/protocol-client/index.js").Turn;
  const canonical = {
    inputs: new Map([[message.id, message]]),
    answeredQuestions: indexAnsweredQuestions([call, message]),
  } as unknown as import("../src/renderer/src/turn-canonical-presentation.js").TurnCanonicalPresentation;
  const entries = indexTurnFindText(turn, canonical);
  assert.deepEqual(entries[0]?.blocks, [
    "Short summary · Full report",
    "Keep the examples.",
    "Literal **text** Second line",
  ]);
  assert.equal(searchTranscript(entries, "summary · Full").length, 1);
  assert.equal(
    searchTranscript(entries, "Short summary · Full report").length,
    1,
  );
  assert.equal(searchTranscript(entries, "**text**").length, 1);
  assert.equal(searchTranscript(entries, "call-a").length, 0);
  assert.equal(searchTranscript(entries, "scope:").length, 0);
});
