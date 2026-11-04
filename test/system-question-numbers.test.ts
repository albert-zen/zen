import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import {
  parseUserQuestionSpecification,
  renderUserQuestionAnswer,
} from "../src/user-question.js";
import { contextItemsFromLegacy, type ContextItem } from "../src/item-list.js";
import { compileItemList } from "../src/item-list.js";
import { userQuestionModelProjection } from "../src/user-question-model.js";

function options(directory: string) {
  return {
    cwd: directory,
    dataDirectory: directory,
    model: "fake",
    provider: { type: "fake" as const },
    approvalPolicy: "never" as const,
    toolPresentation: "direct" as const,
  };
}

test("real Host assigns individual consecutive question numbers without authored IDs and projects exact replies", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-system-question-numbers-"),
  );
  let host = createHostedAppServer(options(directory));
  try {
    const thread = await host.startThread();
    const specifications = [
      {
        questions: [
          { prompt: "First scope?", options: [{ label: "Small" }] },
          { prompt: "Second scope?" },
        ],
      },
      { questions: [{ prompt: "Third scope?" }] },
    ];
    for (const specification of specifications)
      await (
        await host.startTurn(
          thread.id,
          `!tool ask_user_question ${JSON.stringify(specification)}`,
        )
      ).done;
    const questions = (await host.listUserQuestions(thread.id)).questions;
    assert.equal(
      questions.length,
      2,
      "numbering and binding keys are system supplied",
    );
    const before = await host.readThread(thread.id);
    const bytes = JSON.stringify(before.itemList);
    const messages = compileItemList(before.itemList!).messages;
    const receipts = messages.filter((message) => message.role === "tool");
    assert.equal(receipts.length, 2);
    assert.deepEqual(
      receipts.map((receipt) =>
        JSON.parse(receipt.text.slice(receipt.text.indexOf("{"))).questions.map(
          (question: { id: string }) => question.id,
        ),
      ),
      [["Q1", "Q2"], ["Q3"]],
    );
    for (const receipt of receipts) {
      assert.equal(receipt.text.includes(thread.id), false);
      for (const question of questions)
        assert.equal(receipt.text.includes(question.request.callItemId), false);
    }
    assert.equal(
      JSON.stringify(before.itemList),
      bytes,
      "model projection never rewrites stored semantic bytes",
    );
    const literal =
      "Literal UUID 12345678-1234-1234-1234-123456789abc and {{question_1}}";
    await (
      await host.respondToUserQuestion(thread.id, {
        questionCallItemId: questions[1]!.request.callItemId,
        clientId: "answer-third",
        outcome: "answer",
        answers: [
          {
            questionId: questions[1]!.specification.questions[0]!.id,
            optionIds: [],
            text: literal,
          },
        ],
      })
    ).turn.done;
    await (
      await host.respondToUserQuestion(thread.id, {
        questionCallItemId: questions[0]!.request.callItemId,
        clientId: "cancel-first-batch",
        outcome: "cancel",
      })
    ).turn.done;
    const answered = await host.readThread(thread.id);
    const projected = compileItemList(answered.itemList!).messages;
    const userText = projected.flatMap((message) =>
      message.role === "user"
        ? "content" in message
          ? message.content.flatMap((part) =>
              part.type === "text" ? [part.text] : [],
            )
          : [message.text]
        : [],
    );
    assert.ok(userText.includes(`Reply to Q3:\n${literal}`));
    assert.ok(userText.includes("I chose not to answer Q1, Q2."));
    await host.closeHostResources();
    host = createHostedAppServer(options(directory));
    const cold = await host.readThread(thread.id);
    assert.deepEqual(compileItemList(cold.itemList!).messages, projected);
    assert.equal(
      (
        await host.readUserQuestion(
          thread.id,
          questions[1]!.request.callItemId,
          "answer-third",
        )
      ).response.status,
      "claimed",
    );
  } finally {
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  }
});

test("omitted local bindings reserve explicit siblings and preserve explicit templates and option order", () => {
  const specification = parseUserQuestionSpecification({
    questions: [
      {
        prompt: "Generated?",
        options: [
          { label: "Generated option" },
          { id: "option_1", label: "Explicit option" },
        ],
        multiSelect: true,
      },
      { id: "question_1", prompt: "Explicit?" },
    ],
    answerTemplate: "Generated: {{question_2}}\nExplicit: {{question_1}}",
  });
  assert.deepEqual(
    specification.questions.map((question) => question.id),
    ["question_2", "question_1"],
  );
  assert.deepEqual(
    specification.questions[0]!.options!.map((option) => option.id),
    ["option_2", "option_1"],
  );
  assert.equal(
    renderUserQuestionAnswer(specification, [
      {
        questionId: "question_1",
        optionIds: [],
        text: "Literal {{question_2}} 12345678-1234-1234-1234-123456789abc",
      },
      { questionId: "question_2", optionIds: ["option_1", "option_2"] },
    ]),
    "Generated: Generated option\nExplicit option\nExplicit: Literal {{question_2}} 12345678-1234-1234-1234-123456789abc",
  );
});

test("complete publication append order is stable across late-call repair, duplicates and failed calls", () => {
  const call = (id: string, sequence: number, valid = true) =>
    contextItemsFromLegacy(
      {
        id,
        threadId: "synthetic-thread",
        turnId: "turn",
        createdAt: "2026-11-04T00:00:00.000Z",
        type: "tool_call",
        callId: id,
        name: "ask_user_question",
        arguments: { questions: valid ? [{ prompt: id }] : [] },
      },
      [],
      sequence,
    )[0]!;
  const receipt = (
    id: string,
    callId: string,
    sequence: number,
    exitCode = 0,
  ) =>
    contextItemsFromLegacy(
      {
        id,
        threadId: "synthetic-thread",
        turnId: "turn",
        createdAt: "2026-11-04T00:00:00.000Z",
        type: "tool_result",
        callId,
        exitCode,
        executionStatus: "completed",
        output:
          exitCode === 0
            ? JSON.stringify({
                kind: "zen.user-question.published",
                version: 1,
                request: { threadId: "synthetic-thread", callItemId: callId },
              })
            : "Question publication failed",
      },
      [],
      sequence,
    )[0]!;
  const results = (contexts: ContextItem[]) =>
    compileItemList(contexts).messages.flatMap((message) =>
      message.role === "tool" && message.text.includes('"questions"')
        ? [
            JSON.parse(
              message.text.slice(message.text.indexOf("{")),
            ).questions.map((q: { id: string }) => q.id),
          ]
        : [],
    );
  const first = [
    receipt("result-late-call", "late-call", 2),
    call("second-call", 19),
    receipt("result-second", "second-call", 31),
  ];
  assert.deepEqual(results(first.slice(1)), [["Q1"]]);
  assert.throws(
    () => results(first),
    /Cannot safely display user question publication.*source call/,
    "an orphan machine receipt stops compilation until its actual call is repaired",
  );
  const repaired = [...first, call("late-call", 1)];
  assert.deepEqual(results(repaired), [["Q2"], ["Q1"]]);
  assert.throws(
    () =>
      results([
        ...repaired,
        call("corrupt", 32, false),
        receipt("corrupt-result", "corrupt", 33),
      ]),
    /Cannot safely display user question publication.*specification is invalid/,
    "a corrupt successful machine publication cannot fall back to private-ID text",
  );
  assert.deepEqual(
    results([
      ...repaired,
      receipt("duplicate-second", "second-call", 32),
      call("failed", 33),
      receipt("failed-result", "failed", 34, 1),
      call("invalid", 35, false),
      receipt("invalid-result", "invalid", 36, 1),
      call("final", 37),
      receipt("final-result", "final", 38),
    ]),
    [["Q2"], ["Q1"], ["Q1"], ["Q3"]],
  );
});

test("question display visits full input once and never skips orphan machine guards", () => {
  const base = {
    threadId: "cost-thread",
    turnId: "cost-turn",
    createdAt: "2026-11-04T00:00:00.000Z",
  };
  const ordinary = Array.from({ length: 5000 }, (_, sequence): ContextItem => ({
    ...base,
    id: `ordinary-${sequence}`,
    kind: "message",
    role: "user",
    source: { kind: "user_message", sequence },
    content: { text: "ordinary", parts: [{ type: "text", text: "ordinary" }] },
  }));
  const call = contextItemsFromLegacy(
    {
      ...base,
      id: "cost-call",
      type: "tool_call",
      callId: "provider-call",
      name: "ask_user_question",
      arguments: { questions: [{ prompt: "Which?" }] },
    },
    [],
    5000,
  )[0]!;
  assert.ok(call.kind === "tool_call");
  const request = { threadId: base.threadId, callItemId: call.id };
  const receipt = contextItemsFromLegacy(
    {
      ...base,
      id: "cost-result",
      type: "tool_result",
      callId: "provider-call",
      exitCode: 0,
      executionStatus: "completed",
      output: JSON.stringify({
        kind: "zen.user-question.published",
        version: 1,
        request,
      }),
    },
    [],
    5001,
  )[0]!;
  const measure = (items: ContextItem[]) => {
    let reads = 0,
      parses = 0,
      error: unknown,
      size = 0;
    const input = new Proxy(items, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/u.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const originalParse = JSON.parse;
    JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
      parses++;
      return originalParse(...args);
    };
    try {
      size = userQuestionModelProjection(input).size;
    } catch (caught) {
      error = caught;
    } finally {
      JSON.parse = originalParse;
    }
    return { reads, parses, size, error };
  };
  assert.deepEqual(measure(ordinary), {
    reads: 5000,
    parses: 0,
    size: 0,
    error: undefined,
  });
  assert.deepEqual(measure([...ordinary, call, receipt]), {
    reads: 5002,
    parses: 1,
    size: 1,
    error: undefined,
  });
  const nonAsk = {
    ...call,
    content: { ...call.content, name: "ordinary_tool" },
  };
  assert.deepEqual(measure([...ordinary, nonAsk, receipt]), {
    reads: 5002,
    parses: 0,
    size: 0,
    error: undefined,
  });
  const orphanReceipt = measure([receipt]);
  assert.equal(orphanReceipt.reads, 1);
  assert.equal(orphanReceipt.parses, 1);
  assert.match(
    String(orphanReceipt.error),
    /Cannot safely display user question/,
  );
  const cancel = contextItemsFromLegacy(
    {
      ...base,
      id: "orphan-cancel",
      type: "user_message",
      clientId: "orphan-client",
      text: `I chose not to answer question ${call.id}.`,
      questionReply: { version: 1, request, outcome: "cancel" },
    },
    [],
    5002,
  )[0]!;
  const orphanCancel = measure([cancel]);
  assert.equal(orphanCancel.reads, 1);
  assert.equal(orphanCancel.parses, 0);
  assert.match(
    String(orphanCancel.error),
    /cancelled request publication is unavailable/,
  );
});
