import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createHostedAppServer,
  type ZenHostOptions,
} from "../apps/cli/src/host.js";
import { ToolEnvironment } from "../src/tool.js";
import { AskUserQuestionToolRuntime } from "../src/user-question-tool.js";
import { ASK_USER_QUESTION_NAME } from "../src/user-question.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import type { JsonRpcMessage } from "../src/protocol/codex/wire.js";
import {
  NATIVE_QUESTION_LIST_METHOD,
  NATIVE_QUESTION_READ_METHOD,
  NATIVE_QUESTION_RESPOND_METHOD,
  type NativeQuestionReadResult,
} from "../src/protocol/native/wire.js";

const specification = {
  questions: [{ id: "scope", prompt: "Which scope?" }],
  answerTemplate: "Scope: {{scope}}",
};
const ask = `!tool ${ASK_USER_QUESTION_NAME} ${JSON.stringify(specification)}`;

function options(directory: string): ZenHostOptions {
  return {
    cwd: directory,
    dataDirectory: directory,
    model: "fake",
    provider: { type: "fake" },
    approvalPolicy: "never",
    toolPresentation: "direct",
  };
}

test("Host defaults Ask on in every model presentation and preserves explicit embedding opt-out", async (t) => {
  for (const toolPresentation of ["direct", "code", "both"] as const)
    for (const enabled of [undefined, false, true])
      await t.test(`${toolPresentation}: ${String(enabled)}`, async () => {
        const directory = await mkdtemp(
          path.join(os.tmpdir(), "zen-question-gate-"),
        );
        const host = createHostedAppServer({
          ...options(directory),
          toolPresentation,
          ...(enabled === undefined
            ? {}
            : { experimentalUserQuestions: enabled }),
        });
        try {
          const thread = await host.startThread();
          await (
            await host.startTurn(thread.id, ask)
          ).done;
          const snapshot = await host.readThread(thread.id);
          const definitions = snapshot.itemList!.filter(
            (item) => item.kind === "tools",
          );
          assert.ok(definitions.length > 0, "inspect actual semantic catalog");
          for (const item of definitions)
            assert.equal(
              item.content.tools.some(
                (tool) => tool.name === ASK_USER_QUESTION_NAME,
              ),
              enabled !== false,
            );
          assert.equal(
            snapshot.userQuestions!.length,
            enabled !== false ? 1 : 0,
          );
          if (enabled === false) {
            await (
              await host.startTurn(
                thread.id,
                `!tool ${ASK_USER_QUESTION_NAME} ${JSON.stringify({ ...specification, experimentalUserQuestions: true })}`,
              )
            ).done;
            assert.deepEqual(
              (await host.readThread(thread.id)).userQuestions,
              [],
            );
          }
        } finally {
          await host.closeHostResources();
          await rm(directory, { recursive: true, force: true });
        }
      });
});

test("Ask startup configuration uses existing pending restart; omitted and true are equivalent", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-question-config-"),
  );
  const base = options(directory);
  const host = createHostedAppServer(base);
  try {
    const unchanged = await host.prepareConfiguration(
      { ...base, experimentalUserQuestions: true },
      1,
    );
    assert.deepEqual(host.publishConfiguration(unchanged).pendingRestart, []);
    const disable = await host.prepareConfiguration(
      { ...base, experimentalUserQuestions: false },
      2,
    );
    assert.deepEqual(host.publishConfiguration(disable).pendingRestart, [
      "experimentalUserQuestions",
    ]);
    const thread = await host.startThread();
    await (
      await host.startTurn(thread.id, ask)
    ).done;
    assert.equal(
      (await host.readThread(thread.id)).userQuestions!.length,
      1,
      "saving an opt-out never mutates the running tool environment",
    );
    const revert = await host.prepareConfiguration(base, 3);
    assert.deepEqual(host.publishConfiguration(revert).pendingRestart, []);
  } finally {
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host reserves Ask's builtin name even while publication is disabled", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-question-reserved-"),
  );
  const toolEnvironment = new ToolEnvironment({
    runtimes: [new AskUserQuestionToolRuntime()],
  });
  try {
    assert.throws(
      () =>
        createHostedAppServer({
          ...options(directory),
          experimentalUserQuestions: false,
          toolEnvironment,
        }),
      /Tool name ask_user_question is reserved for the builtin runtime/,
    );
  } finally {
    await toolEnvironment.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("default-on asynchronous Ask survives completed independent work and Host restart for a later exact answer", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-question-async-"),
  );
  const base = options(directory);
  const withoutTemplate = { questions: specification.questions };
  const templateFreeAsk = `!tool ${ASK_USER_QUESTION_NAME} ${JSON.stringify(withoutTemplate)}`;
  let host = createHostedAppServer(base);
  try {
    const thread = await host.startThread();
    const turn = await host.startTurn(thread.id, templateFreeAsk);
    await turn.done;
    const question = (await host.listUserQuestions(thread.id)).questions[0]!;
    assert.equal(question.specification.answerTemplate, "scope: {{scope}}");
    const originalCall = (await host.readThread(thread.id)).itemList!.find(
      (item) =>
        item.id === question.request.callItemId && item.kind === "tool_call",
    );
    assert.ok(originalCall?.kind === "tool_call");
    assert.deepEqual(
      originalCall.content.arguments,
      withoutTemplate,
      "semantic call arguments remain exactly what the model authored",
    );
    assert.equal(
      question.state,
      "open",
      "completing the tool's Turn never cancels its question",
    );
    await (
      await host.startTurn(thread.id, "Continue independent synthetic work")
    ).done;
    assert.equal(
      (await host.listUserQuestions(thread.id)).questions[0]!.state,
      "open",
    );
    const summary = await host.readThreadSummary(thread.id);
    assert.equal(summary.status, "idle");
    assert.equal(summary.userQuestionSummary?.openCount, 1);
    await host.closeHostResources();
    host = createHostedAppServer(base);
    assert.deepEqual(
      (await host.listUserQuestions(thread.id)).questions,
      [question],
      "a cold Host derives the same pending request without a replay",
    );
    const response = await host.respondToUserQuestion(thread.id, {
      questionCallItemId: question.request.callItemId,
      clientId: "late-async-question-answer",
      outcome: "answer",
      answers: [
        { questionId: "scope", optionIds: [], text: "Small, answered later" },
      ],
    });
    await response.turn.done;
    const read = await host.readUserQuestion(
      thread.id,
      question.request.callItemId,
      "late-async-question-answer",
    );
    assert.equal(read.response.status, "claimed");
    assert.equal(read.question?.state, "answered");
    const semanticReplies = (await host.readThread(thread.id)).itemList!.filter(
      (item) =>
        item.role === "user" &&
        item.source.metadata?.questionReply !== undefined,
    );
    assert.equal(
      semanticReplies.length,
      1,
      "the later answer is one ordinary durable human input",
    );
    const answerInput = semanticReplies[0]!;
    assert.ok(answerInput.kind === "message");
    assert.deepEqual(answerInput.content.parts.at(-1), {
      type: "text",
      text: `Reply to question ${question.request.callItemId}:\nscope: Small, answered later`,
    });
    const answered = await host.readThreadSummary(thread.id);
    assert.equal(
      answered.status === "systemError"
        ? undefined
        : answered.userQuestionSummary?.openCount,
      0,
    );
    const cancelThread = await host.startThread();
    await (
      await host.startTurn(cancelThread.id, templateFreeAsk)
    ).done;
    const cancelQuestion = (await host.listUserQuestions(cancelThread.id))
      .questions[0]!;
    const cancelled = await host.respondToUserQuestion(cancelThread.id, {
      questionCallItemId: cancelQuestion.request.callItemId,
      clientId: "template-free-cancel",
      outcome: "cancel",
    });
    await cancelled.turn.done;
    const cancelRead = await host.readUserQuestion(
      cancelThread.id,
      cancelQuestion.request.callItemId,
      "template-free-cancel",
    );
    assert.equal(cancelRead.response.status, "claimed");
    assert.equal(cancelRead.question?.state, "cancelled");
  } finally {
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disabling publication after reload preserves native list/read/respond for an existing question", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-question-disabled-"),
  );
  const base = options(directory);
  let host = createHostedAppServer({
    ...base,
    experimentalUserQuestions: true,
  });
  let connection: NativeConnection | undefined;
  let projection: NativeRecoveryProjection | undefined;
  try {
    const thread = await host.startThread();
    await (
      await host.startTurn(thread.id, ask)
    ).done;
    const question = (await host.readThread(thread.id)).userQuestions![0]!;
    await host.closeHostResources();
    host = createHostedAppServer({ ...base, experimentalUserQuestions: false });
    projection = new NativeRecoveryProjection(host);
    const replies: JsonRpcMessage[] = [];
    connection = new NativeConnection({
      appServer: host,
      projection,
      send: (message) => replies.push(message),
    });
    const request = async (id: number, method: string, params: unknown) => {
      await connection!.receive({ id, method, params });
      const reply = replies.find((reply) => "id" in reply && reply.id === id);
      assert.ok(reply && "result" in reply, JSON.stringify(replies));
      return reply.result;
    };
    await request(1, "zen/initialize", {});
    assert.deepEqual(
      await request(2, NATIVE_QUESTION_LIST_METHOD, { threadId: thread.id }),
      { questions: [question], totalPending: 1 },
    );
    const identity = {
      threadId: thread.id,
      questionCallItemId: question.request.callItemId,
      clientUserMessageId: "existing-question-answer",
    };
    const before = (await request(
      3,
      NATIVE_QUESTION_READ_METHOD,
      identity,
    )) as NativeQuestionReadResult;
    assert.equal(before.question!.state, "open");
    assert.equal(before.response.status, "not-found");
    await request(4, NATIVE_QUESTION_RESPOND_METHOD, {
      ...identity,
      outcome: "answer",
      answers: [{ questionId: "scope", optionIds: [], text: "Small" }],
    });
    const after = (await request(
      5,
      NATIVE_QUESTION_READ_METHOD,
      identity,
    )) as NativeQuestionReadResult;
    assert.equal(after.question!.state, "answered");
    assert.equal(after.response.status, "claimed");
    assert.ok(
      (await host.readThread(thread.id)).itemList!.some(
        (item) =>
          item.role === "user" &&
          item.source.metadata?.clientId === identity.clientUserMessageId &&
          item.source.metadata.questionReply !== undefined,
      ),
    );
  } finally {
    connection?.close();
    projection?.close();
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  }
});
