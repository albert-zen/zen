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

test("Host defaults Ask off in every model presentation; only explicit owner opt-in publishes", async (t) => {
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
              enabled === true,
            );
          assert.equal(snapshot.userQuestions!.length, enabled ? 1 : 0);
          if (!enabled) {
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

test("Ask startup configuration uses existing pending restart; omitted and false are equivalent", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-question-config-"),
  );
  const base = options(directory);
  const host = createHostedAppServer(base);
  try {
    const unchanged = await host.prepareConfiguration(
      { ...base, experimentalUserQuestions: false },
      1,
    );
    assert.deepEqual(host.publishConfiguration(unchanged).pendingRestart, []);
    const enable = await host.prepareConfiguration(
      { ...base, experimentalUserQuestions: true },
      2,
    );
    assert.deepEqual(host.publishConfiguration(enable).pendingRestart, [
      "experimentalUserQuestions",
    ]);
    const thread = await host.startThread();
    await (
      await host.startTurn(thread.id, ask)
    ).done;
    assert.deepEqual((await host.readThread(thread.id)).userQuestions, []);
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
      () => createHostedAppServer({ ...options(directory), toolEnvironment }),
      /Tool name ask_user_question is reserved for the builtin runtime/,
    );
  } finally {
    await toolEnvironment.close();
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
    host = createHostedAppServer(base);
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
