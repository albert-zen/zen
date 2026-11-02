import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalItem } from "../src/item.js";
import { contextItemsFromLegacy, type ContextItem } from "../src/item-list.js";
import { Thread } from "../src/thread.js";
import {
  ThreadUserQuestionProjection,
  readUserQuestions,
} from "../src/user-question-state.js";
import {
  ASK_USER_QUESTION_NAME,
  USER_QUESTION_PUBLICATION_KIND,
  renderUserQuestionReply,
  type UserQuestionReply,
} from "../src/user-question.js";

const threadId = "cost-thread";
const createdAt = "2026-11-02T00:00:00.000Z";
const base = { threadId, createdAt };
const specification = {
  questions: [{ id: "scope", prompt: "Which scope?" }],
  answerTemplate: "{{scope}}",
};
function history() {
  const facts: CanonicalItem[] = [
    {
      ...base,
      id: "metadata",
      type: "thread_metadata",
      cwd: "/synthetic",
      provider: "fake",
      model: "fake",
      sandbox: "read-only",
      approvalPolicy: "always",
    },
  ];
  const contexts: ContextItem[] = [];
  for (let i = 0; i < 5000; i++) {
    const fact: CanonicalItem = {
      ...base,
      id: `ordinary-${i}`,
      turnId: "turn",
      type: "user_message",
      text: `Synthetic ordinary history ${i}`,
    };
    contexts.push(...contextItemsFromLegacy(fact, [], facts.length));
    facts.push(fact);
  }
  return { facts, contexts };
}

test("actual Thread folds question discriminators in existing decode/append and never scans no-Ask snapshots", (t) => {
  const { facts, contexts } = history();
  let entries = 0;
  let parses = 0;
  let observed = 0;
  for (const method of ["observeFact", "observeContext"] as const) {
    const original = ThreadUserQuestionProjection.prototype[method];
    t.mock.method(
      ThreadUserQuestionProjection.prototype,
      method,
      function (
        this: ThreadUserQuestionProjection,
        ...args: Parameters<typeof original>
      ) {
        observed++;
        // The overloads differ only by the fact-position argument.
        Reflect.apply(original, this, args);
      },
    );
  }
  const parse = JSON.parse;
  t.mock.method(JSON, "parse", (...args: Parameters<typeof JSON.parse>) => {
    parses++;
    return parse(...args);
  });
  const counted = <T>(array: readonly T[]) =>
    new Proxy(array, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) entries++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
  for (const method of ["read", "page", "get"] as const) {
    const original = ThreadUserQuestionProjection.prototype[method];
    t.mock.method(
      ThreadUserQuestionProjection.prototype,
      method,
      function (
        this: ThreadUserQuestionProjection,
        ...args: Parameters<typeof original>
      ) {
        const [id, semantic, observed, ...rest] = args;
        return Reflect.apply(original, this, [
          id,
          counted(semantic),
          counted(observed),
          ...rest,
        ]);
      },
    );
  }
  const thread = new Thread(threadId, facts, contexts);
  assert.equal(observed, facts.length + contexts.length);
  assert.equal(thread.userQuestions.length, 0);
  const coldEntries = entries;
  assert.equal(coldEntries, 0);
  assert.equal(parses, 0);
  entries = 0;
  observed = 0;
  for (let i = 0; i < 100; i++) {
    assert.equal(thread.userQuestions.length, 0);
    assert.equal(thread.userQuestionPage().questions.length, 0);
    assert.equal(thread.userQuestion("missing"), undefined);
    assert.equal(thread.takeUserQuestionAttentionInvalidation(), false);
  }
  assert.equal(entries, 0);
  assert.equal(parses, 0);
  thread.append({
    ...base,
    id: "next-user",
    turnId: "turn",
    type: "user_message",
    text: "Next ordinary message",
  });
  assert.equal(thread.userQuestions.length, 0);
  assert.equal(entries, 0);
  assert.equal(observed, 2);
  assert.equal(parses, 0);
  t.diagnostic(
    JSON.stringify({
      history: 5000,
      existingDecodeDiscriminators: facts.length + contexts.length,
      coldSnapshotHistoryVisits: coldEntries,
      noAskEnvelopeParses: parses,
      repeated100ReadsVisits: 0,
      ordinaryAppendDiscriminators: observed,
      ordinaryAppendSnapshotVisits: entries,
    }),
  );
});

test("long-history Ask projection invalidates only relevant commits and equals cold reconstruction", (t) => {
  const { facts, contexts } = history();
  const thread = new Thread(threadId, facts, contexts);
  assert.equal(thread.userQuestions.length, 0);
  const call: CanonicalItem = {
    ...base,
    id: "ask-call",
    turnId: "turn",
    type: "tool_call",
    callId: "ask-provider",
    name: ASK_USER_QUESTION_NAME,
    arguments: specification,
  };
  thread.append(call);
  thread.append({
    ...base,
    id: "ask-result",
    turnId: "turn",
    type: "tool_result",
    callId: "ask-provider",
    exitCode: 0,
    executionStatus: "completed",
    output: JSON.stringify({
      kind: USER_QUESTION_PUBLICATION_KIND,
      version: 1,
      request: { threadId, callItemId: call.id },
    }),
  });
  const parse = JSON.parse;
  let parses = 0;
  t.mock.method(JSON, "parse", (...args: Parameters<typeof JSON.parse>) => {
    parses++;
    return parse(...args);
  });
  assert.equal(thread.userQuestions[0]!.state, "open");
  assert.equal(parses, 1);
  parses = 0;
  for (let i = 0; i < 50; i++) {
    thread.append({
      ...base,
      id: `other-call-${i}`,
      turnId: "turn",
      type: "tool_call",
      callId: `other-provider-${i}`,
      name: "other_tool",
      arguments: {},
    });
    thread.append({
      ...base,
      id: `other-result-${i}`,
      turnId: "turn",
      type: "tool_result",
      callId: `other-provider-${i}`,
      exitCode: 0,
      executionStatus: "completed",
      output: "ordinary output",
    });
    assert.equal(thread.userQuestions[0]!.state, "open");
  }
  assert.equal(
    parses,
    0,
    "ordinary tool results do not reparse prior Ask receipts",
  );
  const reply: UserQuestionReply = {
    version: 1,
    request: { threadId, callItemId: call.id },
    outcome: "answer",
    answers: [{ questionId: "scope", optionIds: [], text: "Small" }],
  };
  thread.append({
    ...base,
    id: "pending-answer",
    type: "user_message_queued",
    clientId: "answer-client",
    deliveryMode: "steer",
    expectedTurnId: "turn",
    questionReply: reply,
    input: [
      { type: "text", text: renderUserQuestionReply(specification, reply) },
    ],
  });
  assert.equal(thread.userQuestions[0]!.state, "answer-pending");
  assert.equal(parses, 1);
  thread.append({
    ...base,
    id: "recall",
    type: "user_message_steer_recalled",
    recallId: "recall-client",
    targets: [
      {
        queuedItemId: "pending-answer",
        clientId: "answer-client",
        expectedRevision: 0,
      },
    ],
  });
  assert.equal(thread.userQuestions[0]!.state, "open");
  assert.equal(parses, 2);
  assert.deepEqual(
    thread.userQuestions,
    readUserQuestions(threadId, thread.itemList, thread.items),
  );
  assert.deepEqual(
    thread.userQuestions,
    new Thread(threadId, thread.items, thread.itemList).userQuestions,
  );
  const mutable = thread.userQuestions;
  mutable[0]!.specification.questions[0]!.prompt = "Mutated caller copy";
  assert.equal(
    thread.userQuestions[0]!.specification.questions[0]!.prompt,
    "Which scope?",
  );
  t.diagnostic(
    JSON.stringify({
      history: 5000,
      irrelevantToolCommits: 100,
      irrelevantCommitEnvelopeParses: 0,
      pendingAndRecallRebuildParses: 2,
      coldEqualsIncremental: true,
    }),
  );
});

test("early fork of long imported history clears the old import cutoff for a new local Ask", () => {
  const metadata: CanonicalItem = {
    ...base,
    id: "import-metadata",
    type: "thread_metadata",
    cwd: "/synthetic",
    provider: "fake",
    model: "fake",
    sandbox: "read-only",
    approvalPolicy: "always",
    importedFrom: {
      format: "synthetic",
      sourceId: "source",
      sourceVersion: "1",
      sourceCwd: "/synthetic",
      sha256: "a".repeat(64),
      exclusions: [],
      historyItemCount: 5000,
    },
  };
  const thread = new Thread(threadId, [
    metadata,
    {
      ...base,
      id: "early-fork",
      type: "thread_forked",
      sourceThreadId: "parent",
      sourceBoundaryItemId: "early",
      workspace: "same-directory",
    },
  ]);
  thread.append({
    ...base,
    id: "local-call",
    turnId: "local-turn",
    type: "tool_call",
    callId: "local-provider",
    name: ASK_USER_QUESTION_NAME,
    arguments: specification,
  });
  thread.append({
    ...base,
    id: "local-result",
    turnId: "local-turn",
    type: "tool_result",
    callId: "local-provider",
    exitCode: 0,
    executionStatus: "completed",
    output: JSON.stringify({
      kind: USER_QUESTION_PUBLICATION_KIND,
      version: 1,
      request: { threadId, callItemId: "local-call" },
    }),
  });
  assert.equal(thread.userQuestions[0]!.state, "open");
  assert.deepEqual(
    thread.userQuestions,
    readUserQuestions(threadId, thread.itemList, thread.items),
  );
  assert.deepEqual(
    thread.userQuestions,
    new Thread(threadId, thread.items, thread.itemList).userQuestions,
  );
});

test("late earlier-call publication invalidates non-atomic page traversal rather than hiding a request", () => {
  const { facts } = history();
  const thread = new Thread(threadId, facts.slice(0, 1), []);
  for (let i = 0; i < 35; i++)
    thread.append({
      ...base,
      id: `call-${i}`,
      turnId: "turn",
      type: "tool_call",
      callId: `provider-${i}`,
      name: ASK_USER_QUESTION_NAME,
      arguments: specification,
    });
  const complete = (index: number) =>
    thread.append({
      ...base,
      id: `result-${index}`,
      turnId: "turn",
      type: "tool_result",
      callId: `provider-${index}`,
      exitCode: 0,
      executionStatus: "completed",
      output: JSON.stringify({
        kind: USER_QUESTION_PUBLICATION_KIND,
        version: 1,
        request: { threadId, callItemId: `call-${index}` },
      }),
    });
  for (let i = 1; i < 35; i++) complete(i);
  const before = thread.userQuestionPage();
  assert.equal(before.questions[0]!.request.callItemId, "call-1");
  assert.equal(thread.takeUserQuestionAttentionInvalidation(), true);
  complete(0);
  assert.equal(thread.takeUserQuestionAttentionInvalidation(), true);
  assert.equal(thread.userQuestion("call-0")!.state, "open");
  // A cursor is not a snapshot token. The invalidation makes the client restart.
  assert.equal(
    thread
      .userQuestionPage(before.nextAfter!)
      .questions.some((q) => q.request.callItemId === "call-0"),
    false,
  );
  const restarted = thread.userQuestionPage();
  assert.equal(restarted.questions[0]!.request.callItemId, "call-0");
  assert.equal(
    new Set(
      [
        ...restarted.questions,
        ...thread.userQuestionPage(restarted.nextAfter!).questions,
      ].map((q) => q.request.callItemId),
    ).size,
    35,
  );
});
