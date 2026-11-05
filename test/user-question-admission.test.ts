import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ZenAppServer, type AppServerEvent } from "../src/app-server.js";
import { DomainThreadJournal } from "../src/domain-journal.js";
import { FileTraceStore } from "../src/trace.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { AgentRuntime } from "../src/runtime.js";
import { ToolEnvironment } from "../src/tool.js";
import { AskUserQuestionToolRuntime } from "../src/user-question-tool.js";
import { ASK_USER_QUESTION_NAME } from "../src/user-question.js";
import { readUserQuestions } from "../src/user-question-state.js";
import { pendingSteerMessages } from "../src/steer-recall.js";
import { ThreadRecencyProjection } from "../src/thread-recency.js";
import type { ModelAdapter, ModelRequest } from "../src/model.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import {
  NATIVE_QUESTION_RESPOND_METHOD,
  NATIVE_QUESTION_LIST_METHOD,
  NATIVE_QUESTION_READ_METHOD,
} from "../src/protocol/native/wire.js";
import type { JsonRpcMessage } from "../src/protocol/codex/wire.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function fixture(
  t: TestContext,
  options: {
    pause?: boolean;
    failPausedModel?: boolean;
    questionCount?: number;
  } = {},
) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-question-admission-"),
  );
  const metadata = new InMemoryThreadMetadataStore();
  const trace = new FileTraceStore(path.join(directory, "trace"));
  const journal = new DomainThreadJournal({
    directory: path.join(directory, "threads"),
    trace,
    metadata,
  });
  const entered = deferred();
  const release = deferred();
  const requests: ModelRequest[] = [];
  const model: ModelAdapter = {
    provider: "question-test",
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        for (let i = 0; i < (options.questionCount ?? 1); i++)
          yield {
            type: "tool_call",
            callId: `provider-question-${i}`,
            name: ASK_USER_QUESTION_NAME,
            arguments: {
              questions: [
                {
                  id: "scope",
                  prompt: "Which scope?",
                  options: [{ id: "small", label: "Small" }],
                },
              ],
              answerTemplate: "Scope: {{scope}}",
            },
          };
      } else {
        if (requests.length === 2 && options.pause) {
          entered.resolve();
          await release.promise;
          if (options.failPausedModel)
            throw new Error("synthetic model failure");
        }
        yield { type: "text_delta", delta: "done" };
      }
    },
  };
  const server = new ZenAppServer({
    journal,
    threadMetadata: metadata,
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({
        bundles: [
          {
            identity: { kind: "builtin", id: "user-question" },
            tools: [new AskUserQuestionToolRuntime()],
          },
        ],
      }),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          { id: "fake", isDefault: true, contextWindow: 32768 },
        ]),
      },
    ]),
    defaults: {
      cwd: directory,
      providerProfileId: model.provider,
      modelId: "fake",
      reasoningEffort: "medium",
      sandbox: "read-only",
      approvalPolicy: "never",
    },
  });
  t.after(async () => {
    release.resolve();
    await server.closeRuntimeConfiguration();
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  });
  const events: AppServerEvent[] = [];
  server.subscribe((event) => events.push(event));
  const thread = await server.startThread();
  const initial = await server.startTurn(thread.id, "Please ask", {
    clientId: "initial",
    clientTimezone: "UTC",
  });
  if (options.pause) await entered.promise;
  else await initial.done;
  const question = (await server.readThread(thread.id)).userQuestions![0]!;
  assert.equal(question.state, "open");
  const answer = (clientId: string, text?: string) =>
    server.respondToUserQuestion(
      thread.id,
      {
        questionCallItemId: question.request.callItemId,
        clientId,
        outcome: "answer",
        answers: [
          {
            questionId: "scope",
            optionIds: ["small"],
            ...(text === undefined ? {} : { text }),
          },
        ],
      },
      { clientTimezone: "UTC" },
    );
  const snapshot = () => server.readThread(thread.id);
  return {
    server,
    journal,
    directory,
    metadata,
    thread,
    initial,
    question,
    answer,
    snapshot,
    read: (clientId: string) =>
      server.readUserQuestion(thread.id, question.request.callItemId, clientId),
    release,
    requests,
    events,
  };
}

test("idle answer uses ordinary start, preserves model-semantic binding, and rejects a second client", async (t) => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([
    f.answer("answer-a"),
    f.answer("answer-b"),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  const accepted = outcomes.find((outcome) => outcome.status === "fulfilled")!;
  assert.equal(accepted.status, "fulfilled");
  await accepted.value.turn.done;
  const snapshot = await f.snapshot();
  assert.equal(snapshot.userQuestions!.length, 0);
  const reconciled = await f.read(accepted.value.question.response!.clientId);
  assert.equal(reconciled.question!.state, "answered");
  assert.equal(reconciled.response.status, "claimed");
  assert.equal(
    snapshot.items.filter((item) => item.type === "user_message_queued").length,
    0,
    "idle answers never invent next-Turn queueing",
  );
  const answer = snapshot.itemList!.filter(
    (item) =>
      item.kind === "message" &&
      item.role === "user" &&
      item.source.metadata?.questionReply !== undefined,
  );
  assert.equal(answer.length, 1);
  assert.ok(
    f.requests
      .at(-1)!
      .messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message).includes("Scope: Small"),
      ),
  );
  const clientId = reconciled.question!.response!.clientId;
  const duplicate = await f.answer(clientId);
  assert.equal(duplicate.turn.id, accepted.value.turn.id);
  await assert.rejects(f.answer(clientId, "different"), {
    code: "idempotency_conflict",
  });
  await f.journal.close();
  const cold = new DomainThreadJournal({
    directory: path.join(f.directory, "threads"),
    trace: new FileTraceStore(path.join(f.directory, "trace")),
    metadata: f.metadata,
  });
  try {
    assert.equal(
      readUserQuestions(
        f.thread.id,
        await cold.readItemList(f.thread.id),
        await cold.read(f.thread.id),
      )[0]!.state,
      "answered",
    );
  } finally {
    await cold.close();
  }
});

test("active answer stays pending; atomic recall reopens and old intent cannot revive", async (t) => {
  const f = await fixture(t, { pause: true });
  const answer = await f.answer("answer-a");
  assert.equal(answer.question.state, "answer-pending");
  assert.equal(answer.turn.admission?.state, "queued");
  await assert.rejects(f.answer("answer-b"), {
    code: "question_response_pending",
  });
  const before = await f.snapshot();
  assert.equal(
    before.itemList!.filter(
      (item) => item.source.metadata?.questionReply !== undefined,
    ).length,
    0,
  );
  const pending = pendingSteerMessages(before.items);
  const target = {
    queuedItemId: pending[0]!.id,
    clientId: pending[0]!.clientId,
    expectedRevision: pending[0]!.revision,
  };
  await assert.rejects(
    f.server.editQueuedMessage(
      f.thread.id,
      { ...target, editId: "edit-answer" },
      [{ type: "text", text: "edited" }],
    ),
    { code: "question_response_edit_unsupported" },
  );
  await f.server.recallSteerMessages(f.thread.id, {
    recallId: "recall-answer",
    targets: [target],
  });
  assert.equal((await f.snapshot()).userQuestions![0]!.state, "open");
  await assert.rejects(f.answer("answer-a"), { code: "queue_id_cancelled" });
  await f.answer("answer-b");
  f.release.resolve();
  await f.initial.done;
  const after = await f.snapshot();
  assert.equal(after.userQuestions!.length, 0);
  assert.equal((await f.read("answer-b")).question!.state, "answered");
  assert.equal((await f.read("answer-a")).response.status, "withdrawn");
  assert.equal(
    after.itemList!.filter(
      (item) => item.source.metadata?.questionReply !== undefined,
    ).length,
    1,
  );
  await assert.rejects(
    f.server.recallSteerMessages(f.thread.id, {
      recallId: "late-recall",
      targets: [target],
    }),
    { code: "steer_recall_conflict" },
  );
});

test("actual native summary counts only open requests and never re-dates publication on answer or recall", async (t) => {
  const f = await fixture(t, { pause: true });
  const summary = async () => {
    const value = await f.server.readThreadSummary(f.thread.id);
    assert.notEqual(value.status, "systemError");
    if (value.status === "systemError") throw new Error(value.error);
    return value;
  };
  const open = await summary();
  const publishedId = (await f.server.listUserQuestions(f.thread.id))
    .latestPublishedQuestionId;
  assert.equal(publishedId, f.question.request.callItemId);
  assert.equal(open.status, "active");
  assert.deepEqual(open.userQuestionSummary, {
    openCount: 1,
    latestPublishedAt: f.question.createdAt,
  });
  assert.equal(open.recentActivityAt, f.question.createdAt);
  assert.equal(
    open.lastTurnEnd,
    undefined,
    "publication does not wait for final answer",
  );
  const answer = await f.answer("summary-answer");
  const pending = (await f.snapshot()).items.find(
    (item) => item.id === answer.turn.admission!.queuedItemId,
  )!;
  const received = await summary();
  assert.equal(
    (await f.server.listUserQuestions(f.thread.id)).latestPublishedQuestionId,
    publishedId,
    "answer admission is not a new publication",
  );
  assert.deepEqual(received.userQuestionSummary, {
    openCount: 0,
    latestPublishedAt: f.question.createdAt,
  });
  assert.equal(received.recentActivityAt, pending.createdAt);
  assert.equal((await f.read("summary-answer")).response.status, "pending");
  await f.answer("summary-answer");
  assert.deepEqual(
    (await summary()).userQuestionSummary,
    received.userQuestionSummary,
  );
  const target = {
    queuedItemId: pending.id,
    clientId: "summary-answer",
    expectedRevision: 0,
  };
  await assert.rejects(
    f.server.recallSteerMessages(f.thread.id, {
      recallId: "stale-summary-recall",
      targets: [{ ...target, expectedRevision: 99 }],
    }),
    { code: "steer_recall_conflict" },
  );
  assert.deepEqual(await summary(), received);
  await f.server.recallSteerMessages(f.thread.id, {
    recallId: "summary-recall",
    targets: [target],
  });
  const reopened = await summary();
  assert.equal(
    (await f.server.listUserQuestions(f.thread.id)).latestPublishedQuestionId,
    publishedId,
    "recall cannot mint a new publication identity",
  );
  assert.deepEqual(reopened.userQuestionSummary, open.userQuestionSummary);
  assert.equal(reopened.recentActivityAt, received.recentActivityAt);
  await f.server.respondToUserQuestion(f.thread.id, {
    questionCallItemId: f.question.request.callItemId,
    clientId: "summary-cancel",
    outcome: "cancel",
  });
  assert.equal((await summary()).userQuestionSummary!.openCount, 0);
  assert.equal((await f.read("summary-cancel")).response.status, "pending");
  f.release.resolve();
  await f.initial.done;
  const closed = await summary();
  assert.deepEqual(closed.userQuestionSummary, received.userQuestionSummary);
  assert.equal((await f.read("summary-cancel")).response.status, "claimed");
  assert.equal(
    closed.recentActivityAt,
    new ThreadRecencyProjection().read((await f.snapshot()).items),
    "after publication, real human receipt/final answer retain ordinary ordering",
  );
});

test("native summary covers all pending pages and retains accepted time after every request closes", async (t) => {
  const f = await fixture(t, { questionCount: 35 });
  const first = await f.server.listUserQuestions(f.thread.id);
  const second = await f.server.listUserQuestions(f.thread.id, first.nextAfter);
  const questions = [...first.questions, ...second.questions];
  const latestPublishedAt = questions
    .map((q) => q.createdAt)
    .sort()
    .at(-1)!;
  const read = async () => {
    const summary = await f.server.readThreadSummary(f.thread.id);
    assert.notEqual(summary.status, "systemError");
    return summary.status === "systemError"
      ? undefined
      : summary.userQuestionSummary;
  };
  assert.deepEqual(await read(), { openCount: 35, latestPublishedAt });
  for (let i = 0; i < questions.length; i++) {
    const response = await f.server.respondToUserQuestion(f.thread.id, {
      questionCallItemId: questions[i]!.request.callItemId,
      clientId: `summary-close-${i}`,
      outcome: "cancel",
    });
    await response.turn.done;
    assert.deepEqual(await read(), { openCount: 34 - i, latestPublishedAt });
  }
  assert.equal((await f.snapshot()).userQuestions!.length, 0);
});

test("held answer after an interrupted Turn is claimed only by explicit ordinary successor", async (t) => {
  const f = await fixture(t, { pause: true, failPausedModel: true });
  await f.answer("held-answer");
  const interrupted = f.server.interruptTurn(f.thread.id, f.initial.id);
  f.release.resolve();
  await interrupted;
  await f.initial.done;
  assert.equal((await f.snapshot()).userQuestions![0]!.state, "answer-pending");
  assert.equal(f.requests.length, 2);
  await (
    await f.server.sendMessage(f.thread.id, "Continue explicitly", {
      clientId: "explicit-successor",
      recallableSteer: true,
    })
  ).done;
  assert.equal((await f.read("held-answer")).question!.state, "answered");
  assert.ok(
    f.requests[2]!.messages.some(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message).includes("Scope: Small"),
    ),
  );
});

for (const outcome of [
  "success",
  "failure-before-write",
  "unknown-after-write",
] as const) {
  test(`initial answer commit ${outcome}: concurrent second client never falls back or double-admits`, async (t) => {
    const f = await fixture(t);
    const entered = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    const append = f.journal.append.bind(f.journal);
    let intercepted = false;
    f.journal.append = async (item) => {
      if (
        !intercepted &&
        item.type === "user_message" &&
        item.questionReply !== undefined
      ) {
        intercepted = true;
        entered.resolve();
        await release.promise;
        if (outcome === "failure-before-write")
          throw new Error("synthetic initial append failure");
        const receipt = await append(item);
        if (outcome === "unknown-after-write")
          throw new Error("synthetic ACK lost after durable initial input");
        return receipt;
      }
      return await append(item);
    };
    const first = f.answer("first-answer");
    const firstObserved = first.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    await entered.promise;
    let secondSettled = false;
    const second = f.answer("second-answer").then(
      (value) => {
        secondSettled = true;
        return { ok: true as const, value };
      },
      (error) => {
        secondSettled = true;
        return { ok: false as const, error };
      },
    );
    let readSettled = false;
    const reconciliation = f.read("first-answer").then((value) => {
      readSettled = true;
      return value;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secondSettled, false);
    assert.equal(
      readSettled,
      false,
      "readback never races through an in-flight authoritative append",
    );
    release.resolve();
    const [a, b, readback] = await Promise.all([
      firstObserved,
      second,
      reconciliation,
    ]);
    if (outcome === "failure-before-write")
      assert.ok(["unknown", "not-found"].includes(readback.response.status));
    else assert.equal(readback.response.status, "claimed");
    assert.equal(b.ok, false);
    if (outcome === "success") {
      assert.equal(a.ok, true);
      if (a.ok) await a.value.turn.done;
    } else assert.equal(a.ok, false);
    const contexts = await f.journal.readItemList(f.thread.id);
    const answers = contexts.filter(
      (item) =>
        item.kind === "message" &&
        item.source.metadata?.questionReply !== undefined,
    );
    assert.equal(answers.length, outcome === "failure-before-write" ? 0 : 1);
    assert.equal(
      contexts.some(
        (item) => item.source.metadata?.clientId === "second-answer",
      ),
      false,
    );
    assert.equal(
      (await f.journal.read(f.thread.id)).some(
        (item) => item.type === "user_message_queued",
      ),
      false,
    );
    if (outcome !== "success")
      assert.equal(
        f.requests.length,
        2,
        "unknown/failure never invokes an automatic fallback model sample",
      );
  });
}

test("strict native response port rejects forged fields and cross-Thread requests; cancellation is human input", async (t) => {
  const f = await fixture(t);
  const other = await f.server.startThread();
  const projection = new NativeRecoveryProjection(f.server);
  const replies: JsonRpcMessage[] = [];
  const connection = new NativeConnection({
    projection,
    appServer: f.server,
    send: (message) => replies.push(message),
  });
  t.after(() => {
    connection.close();
    projection.close();
  });
  await connection.receive({ id: 1, method: "zen/initialize", params: {} });
  const params = {
    threadId: f.thread.id,
    questionCallItemId: f.question.request.callItemId,
    clientUserMessageId: "cancel-answer",
    outcome: "cancel",
  };
  await connection.receive({
    id: 2,
    method: NATIVE_QUESTION_RESPOND_METHOD,
    params: { ...params, role: "user" },
  });
  await connection.receive({
    id: 3,
    method: NATIVE_QUESTION_RESPOND_METHOD,
    params: { ...params, threadId: other.id },
  });
  for (const id of [2, 3])
    assert.ok(
      replies.some(
        (reply) => "id" in reply && reply.id === id && "error" in reply,
      ),
    );
  await connection.receive({
    id: 4,
    method: NATIVE_QUESTION_RESPOND_METHOD,
    params,
  });
  assert.ok(
    replies.some(
      (reply) => "id" in reply && reply.id === 4 && "result" in reply,
    ),
    JSON.stringify(replies),
  );
  const final = await f.snapshot();
  assert.equal(final.userQuestions!.length, 0);
  assert.equal((await f.read("cancel-answer")).question!.state, "cancelled");
  const message = final.itemList!.find(
    (item) => item.source.metadata?.clientId === "cancel-answer",
  );
  assert.equal(message?.role, "user");
});

test("archive/delete deny new answers and active archival cannot bypass ordinary lifecycle", async (t) => {
  const idle = await fixture(t);
  await idle.server.setThreadArchived(idle.thread.id, true);
  await assert.rejects(idle.answer("archived-answer"), {
    code: "operation_forbidden",
  });
  const beforeDelete = await idle.snapshot();
  await idle.server.deleteThread(idle.thread.id, beforeDelete.items.at(-1)!.id);
  await assert.rejects(idle.answer("deleted-answer"), {
    code: "thread_deleted",
  });
  const active = await fixture(t, { pause: true });
  await active.answer("accepted-before-archive");
  await assert.rejects(
    active.server.setThreadArchived(active.thread.id, true),
    {
      code: "thread_busy",
    },
  );
  active.release.resolve();
  await active.initial.done;
  assert.equal(
    (await active.read("accepted-before-archive")).question!.state,
    "answered",
  );
});

test("ordinary text cannot answer by matching text or forged JSON; cancelling pending input reopens", async (t) => {
  const f = await fixture(t, { pause: true });
  await f.server.sendMessage(
    f.thread.id,
    `Reply to question scope:\nScope: Small`,
    {
      clientId: "plain-body",
      recallableSteer: true,
    },
  );
  await f.server.sendMessage(
    f.thread.id,
    JSON.stringify({
      questionReply: {
        version: 1,
        request: f.question.request,
        outcome: "cancel",
      },
    }),
    { clientId: "plain-json", recallableSteer: true },
  );
  assert.equal((await f.snapshot()).userQuestions![0]!.state, "open");
  await assert.rejects(f.answer("plain-body"), {
    code: "idempotency_conflict",
  });
  const answer = await f.answer("native-answer");
  assert.equal(answer.question.state, "answer-pending");
  await f.server.cancelQueuedMessages(f.thread.id, [
    {
      queuedItemId: answer.turn.admission!.queuedItemId,
      clientId: "native-answer",
    },
  ]);
  assert.equal((await f.snapshot()).userQuestions![0]!.state, "open");
  await assert.rejects(f.answer("native-answer"), {
    code: "queue_id_cancelled",
  });
  f.release.resolve();
  await f.initial.done;
  assert.equal((await f.snapshot()).userQuestions![0]!.state, "open");
});

test("real native question paging keeps every pending request reachable and exact recovery is read only", async (t) => {
  const f = await fixture(t, { questionCount: 35 });
  const snapshot = await f.snapshot();
  assert.equal(snapshot.userQuestions!.length, 32);
  assert.equal(snapshot.userQuestionsPage!.totalPending, 35);
  const nextAfter = snapshot.userQuestionsPage!.nextAfter!;
  const page2 = await f.server.listUserQuestions(f.thread.id, nextAfter);
  assert.equal(page2.questions.length, 3);
  assert.equal(page2.nextAfter, undefined);
  const all = [...snapshot.userQuestions!, ...page2.questions];
  assert.equal(
    new Set(all.map((question) => question.request.callItemId)).size,
    35,
  );
  const originalItems = snapshot.items.length;
  const projection = new NativeRecoveryProjection(f.server);
  const replies: JsonRpcMessage[] = [];
  const connection = new NativeConnection({
    projection,
    appServer: f.server,
    send: (message) => replies.push(message),
  });
  t.after(() => {
    connection.close();
    projection.close();
  });
  await connection.receive({
    id: 1,
    method: NATIVE_QUESTION_LIST_METHOD,
    params: { threadId: f.thread.id },
  });
  assert.ok(
    replies.some(
      (reply) => "id" in reply && reply.id === 1 && "error" in reply,
    ),
  );
  await connection.receive({ id: 2, method: "zen/initialize", params: {} });
  await connection.receive({
    id: 3,
    method: NATIVE_QUESTION_LIST_METHOD,
    params: { threadId: f.thread.id, afterQuestionCallItemId: nextAfter },
  });
  await connection.receive({
    id: 4,
    method: NATIVE_QUESTION_READ_METHOD,
    params: {
      threadId: f.thread.id,
      questionCallItemId: page2.questions[2]!.request.callItemId,
      clientUserMessageId: "never-sent",
    },
  });
  const pageReply = replies.find((reply) => "id" in reply && reply.id === 3)!;
  assert.ok("result" in pageReply);
  assert.deepEqual(pageReply.result, page2);
  const exactReply = replies.find((reply) => "id" in reply && reply.id === 4)!;
  assert.ok("result" in exactReply);
  const exact = exactReply.result as Awaited<
    ReturnType<typeof f.server.readUserQuestion>
  >;
  assert.equal(
    exact.question!.request.callItemId,
    page2.questions[2]!.request.callItemId,
  );
  assert.equal(exact.response.status, "not-found");
  assert.equal((await f.snapshot()).items.length, originalItems);
  const changes = () =>
    f.events.filter(
      (event) => event.type === "user_question_attention_invalidated",
    );
  assert.equal(changes().length, 35);
  assert.ok(changes().every((event) => JSON.stringify(event).length < 160));
  const answer = await f.answer("answer-first");
  await answer.turn.done;
  assert.equal(
    changes().length,
    36,
    "normal model events do not invalidate attention",
  );
  assert.equal((await f.snapshot()).userQuestionsPage!.totalPending, 34);
  assert.equal((await f.read("answer-first")).response.status, "claimed");
  const claimedCursor = await f.server.listUserQuestions(
    f.thread.id,
    f.question.request.callItemId,
  );
  assert.equal(
    claimedCursor.questions.length,
    32,
    "answered cursor still continues in publication order",
  );
  await assert.rejects(
    f.server.listUserQuestions(f.thread.id, "foreign-cursor"),
    { code: "invalid_request" },
  );
});

test("parallel Ask calls with duplicate local keys expose stable numbers and out-of-order native replies in actual model requests", async (t) => {
  const f = await fixture(t, { pause: true, questionCount: 2 });
  const questions = (await f.snapshot()).userQuestions!;
  assert.equal(questions.length, 2);
  assert.equal(questions[0]!.specification.questions[0]!.id, "scope");
  assert.equal(questions[1]!.specification.questions[0]!.id, "scope");
  const toolResults = f.requests[1]!.messages.filter(
    (message) => message.role === "tool",
  );
  assert.deepEqual(
    toolResults.map((message) =>
      JSON.parse(message.text.slice(message.text.indexOf("{"))).questions.map(
        (question: { id: string }) => question.id,
      ),
    ),
    [["Q1"], ["Q2"]],
  );
  for (const message of toolResults) {
    assert.ok(!message.text.includes(f.thread.id));
    for (const question of questions)
      assert.ok(!message.text.includes(question.request.callItemId));
  }
  await f.server.sendMessage(f.thread.id, "I chose not to answer Q2.", {
    clientId: "ordinary-number-text",
    recallableSteer: true,
  });
  assert.ok(
    (await f.snapshot()).userQuestions!.every(
      (question) => question.state === "open",
    ),
    "a display number in ordinary text cannot answer either request",
  );
  const second = await f.server.respondToUserQuestion(f.thread.id, {
    questionCallItemId: questions[1]!.request.callItemId,
    clientId: "second-cancel-first",
    outcome: "cancel",
  });
  const first = await f.answer("first-answer-second");
  assert.equal(second.question.state, "cancel-pending");
  assert.equal(first.question.state, "answer-pending");
  f.release.resolve();
  await f.initial.done;
  await Promise.all([first.turn.done, second.turn.done]);
  const finalRequest = f.requests.at(-1)!;
  const users = finalRequest.messages
    .filter((message) => message.role === "user")
    .map((message) => JSON.stringify(message));
  assert.ok(
    users.some((message) => message.includes("Reply to Q1:\\nScope: Small")),
  );
  assert.ok(
    users.some((message) => message.includes("I chose not to answer Q2.")),
  );
  for (const question of questions) {
    assert.ok(
      !JSON.stringify(finalRequest.messages).includes(
        question.request.callItemId,
      ),
      "internal request IDs must not enter model-visible question structures",
    );
  }
  assert.equal(
    (
      await f.server.readUserQuestion(
        f.thread.id,
        questions[1]!.request.callItemId,
        "second-cancel-first",
      )
    ).question!.state,
    "cancelled",
  );
  assert.equal(
    (await f.read("first-answer-second")).question!.state,
    "answered",
  );
});
