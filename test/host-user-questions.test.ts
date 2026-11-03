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
import { decodeCanonicalItem } from "../src/item.js";
import { DomainThreadJournal } from "../src/domain-journal.js";
import { FileTraceStore } from "../src/trace.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { compileItemList } from "../src/item-list.js";
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
      text: `Reply to question scope (${question.requestRef}):\nscope: Small, answered later`,
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
      {
        questions: [question],
        totalPending: 1,
        latestPublishedQuestionId: question.request.callItemId,
      },
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

test("real Host keeps duplicate question keys distinct across out-of-order replies and replay", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-question-short-refs-"),
  );
  const base = options(directory);
  let host = createHostedAppServer(base);
  try {
    const thread = await host.startThread();
    for (const prompt of ["Which project scope?", "Which deployment scope?"])
      await (
        await host.startTurn(
          thread.id,
          `!tool ${ASK_USER_QUESTION_NAME} ${JSON.stringify({ questions: [{ id: "scope", prompt }] })}`,
        )
      ).done;
    const questions = (await host.listUserQuestions(thread.id)).questions;
    assert.equal(questions.length, 2);
    const before = await host.readThread(thread.id);
    const refs = questions.map((question) => {
      const call = before.itemList!.find(
        (item) => item.id === question.request.callItemId,
      )!;
      const result = before.itemList!.find(
        (item) => item.id === question.resultItemId,
      )!;
      assert.ok(result.kind === "tool_result");
      const envelope = JSON.parse(
        result.content.text.slice(Number(result.source.metadata?.bodyStart)),
      );
      assert.equal(envelope.requestRef, `q${call.source.sequence}`);
      return envelope.requestRef as string;
    });
    assert.notEqual(refs[0], refs[1]);
    await host.closeHostResources();
    host = createHostedAppServer(base);
    // The later question is cancelled first; both prompts deliberately reuse scope.
    for (const index of [1, 0]) {
      const result = await host.respondToUserQuestion(thread.id, {
        questionCallItemId: questions[index]!.request.callItemId,
        clientId: `cancel-${index}`,
        outcome: "cancel",
      });
      await result.turn.done;
    }
    const answered = await host.readThread(thread.id);
    const expected = [1, 0].map(
      (index) => `I chose not to answer question scope (${refs[index]}).`,
    );
    const bodies = answered.itemList!.flatMap((item) =>
      item.kind === "message" && item.source.metadata?.questionReply
        ? [item.content.parts.at(-1)]
        : [],
    );
    assert.deepEqual(
      bodies,
      expected.map((text) => ({ type: "text", text })),
    );
    const modelMessages = compileItemList(answered.itemList!).messages;
    for (const text of expected)
      assert.ok(
        modelMessages.some(
          (message) =>
            message.role === "user" &&
            "content" in message &&
            message.content.some(
              (part) => part.type === "text" && part.text === text,
            ),
        ),
      );
    for (const question of questions)
      assert.equal(
        JSON.stringify(
          modelMessages.filter((message) => message.role === "user"),
        ).includes(question.request.callItemId),
        false,
      );
    await host.closeHostResources();
    host = createHostedAppServer(base);
    for (const index of [1, 0]) {
      const read = await host.readUserQuestion(
        thread.id,
        questions[index]!.request.callItemId,
        `cancel-${index}`,
      );
      assert.equal(read.question?.state, "cancelled");
      assert.equal(read.response.status, "claimed");
      const retry = await host.respondToUserQuestion(thread.id, {
        questionCallItemId: questions[index]!.request.callItemId,
        clientId: `cancel-${index}`,
        outcome: "cancel",
      });
      await retry.turn.done;
    }
    const replayed = await host.readThread(thread.id);
    assert.deepEqual(
      replayed.itemList,
      answered.itemList,
      "replay and exact retries never rewrite semantic bytes",
    );
    const fork = await host.forkThread({
      sourceThreadId: thread.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    });
    assert.deepEqual(
      fork.userQuestions,
      [],
      "a fork never inherits native response authority",
    );
    await (
      await host.startTurn(fork.id, ask)
    ).done;
    const forkQuestion = (await host.listUserQuestions(fork.id)).questions[0]!;
    assert.ok(forkQuestion.requestRef);
    assert.equal(
      refs.includes(forkQuestion.requestRef),
      false,
      "new fork calls follow the copied source-sequence prefix without reusing a ref",
    );
    const forkSnapshot = await host.readThread(fork.id);
    const forkCall = forkSnapshot.itemList!.find(
      (item) => item.id === forkQuestion.request.callItemId,
    )!;
    assert.equal(forkQuestion.requestRef, `q${forkCall.source.sequence}`);
    const forkReply = await host.respondToUserQuestion(fork.id, {
      questionCallItemId: forkQuestion.request.callItemId,
      clientId: "fork-cancel",
      outcome: "cancel",
    });
    await forkReply.turn.done;
    assert.equal(
      (
        await host.readUserQuestion(
          fork.id,
          forkQuestion.request.callItemId,
          "fork-cancel",
        )
      ).response.status,
      "claimed",
    );
  } finally {
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cold Host accepts original and key-only reply bytes without reopening or rewriting completed requests", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zen-question-legacy-replies-"),
  );
  let host = createHostedAppServer(options(path.join(root, "source")));
  try {
    const thread = await host.startThread();
    for (let i = 0; i < 2; i++)
      await (
        await host.startTurn(thread.id, ask)
      ).done;
    const questions = (await host.listUserQuestions(thread.id)).questions;
    for (const i of [0, 1])
      await (
        await host.respondToUserQuestion(thread.id, {
          questionCallItemId: questions[i]!.request.callItemId,
          clientId: `legacy-${i}`,
          ...(i === 0
            ? {
                outcome: "answer" as const,
                answers: [
                  { questionId: "scope", optionIds: [], text: "Small" },
                ],
              }
            : { outcome: "cancel" as const }),
        })
      ).turn.done;
    const original = await host.readThread(thread.id);
    await host.closeHostResources();
    for (const format of ["original", "key-only"] as const) {
      const directory = path.join(root, format);
      const facts = original.items.map((item) => {
        if (item.type === "tool_result") {
          try {
            const envelope = JSON.parse(item.output);
            if (envelope.kind === "zen.user-question.published") {
              delete envelope.requestRef;
              envelope.version = 1;
              return { ...item, output: JSON.stringify(envelope) };
            }
          } catch {
            /* Not a publication receipt. */
          }
        }
        if (item.type === "user_message" && item.questionReply) {
          const subject = `question ${format === "original" ? item.questionReply.request.callItemId : "scope"}`;
          const body =
            item.questionReply.outcome === "cancel"
              ? `I chose not to answer ${subject}.`
              : `Reply to ${subject}:\nScope: Small`;
          const legacy: Record<string, unknown> = {
            ...item,
            content: [{ type: "text" as const, text: body }],
          };
          delete legacy.text;
          return decodeCanonicalItem(legacy);
        }
        return item;
      });
      // Seed a separate synthetic pre-upgrade journal. No existing history is modified.
      const journal = new DomainThreadJournal({
        directory: path.join(directory, "threads"),
        trace: new FileTraceStore(path.join(directory, "trace")),
        metadata: new InMemoryThreadMetadataStore(),
      });
      await journal.create(facts);
      await journal.close();
      host = createHostedAppServer(options(directory));
      const before = await host.readThread(thread.id);
      for (const i of [0, 1]) {
        const read = await host.readUserQuestion(
          thread.id,
          questions[i]!.request.callItemId,
          `legacy-${i}`,
        );
        assert.equal(
          read.question?.state,
          i === 0 ? "answered" : "cancelled",
          format,
        );
        assert.equal(read.response.status, "claimed", format);
        const response = await host.respondToUserQuestion(thread.id, {
          questionCallItemId: questions[i]!.request.callItemId,
          clientId: `legacy-${i}`,
          ...(i === 0
            ? {
                outcome: "answer" as const,
                answers: [
                  { questionId: "scope", optionIds: [], text: "Small" },
                ],
              }
            : { outcome: "cancel" as const }),
        });
        await response.turn.done;
      }
      assert.deepEqual(
        (await host.readThread(thread.id)).itemList,
        before.itemList,
        `${format} retries retain exact historical bodies`,
      );
      await host.closeHostResources();
    }
  } finally {
    await host.closeHostResources();
    await rm(root, { recursive: true, force: true });
  }
});
