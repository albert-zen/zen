import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { AskUserQuestionToolRuntime } from "../src/user-question-tool.js";
import {
  ASK_USER_QUESTION_NAME,
  parseUserQuestionReply,
  parseUserQuestionSpecification,
  normalizeUserQuestionReply,
  renderUserQuestionReply,
} from "../src/user-question.js";
import {
  buildToolPresentation,
  createRunCodeModelTool,
} from "../src/tool-presentation.js";
import {
  contextItemsFromLegacy,
  decodeContextItem,
  legacyItemFromContext,
} from "../src/item-list.js";
import { decodeCanonicalItem } from "../src/item.js";
import { parseCodexRollout } from "../src/protocol/codex/rollout-import.js";
import { readUserQuestions } from "../src/user-question-state.js";

const specification = {
  questions: [
    {
      id: "scope",
      prompt: "Which scope?",
      options: [{ id: "small", label: "Small" }],
    },
  ],
  answerTemplate: "Scope: {{scope}}",
};
const reply = {
  version: 1 as const,
  request: { threadId: "thread-a", callItemId: "call-a" },
  outcome: "answer" as const,
  answers: [{ questionId: "scope", optionIds: ["small"] }],
};

test("strict reply provenance survives the actual semantic decoder and compatibility read round trip", () => {
  const fact = decodeCanonicalItem({
    id: "answer",
    threadId: "thread-a",
    turnId: "turn",
    createdAt: "2026-11-02T00:00:00.000Z",
    type: "user_message",
    clientId: "client-a",
    questionReply: reply,
    text: renderUserQuestionReply(specification, reply),
  });
  const context = contextItemsFromLegacy(fact)[0]!;
  assert.deepEqual(context.source.metadata?.questionReply, reply);
  const restored = legacyItemFromContext(decodeContextItem(context));
  assert.equal(restored?.type, "user_message");
  assert.deepEqual(
    restored?.type === "user_message" ? restored.questionReply : undefined,
    reply,
  );
  assert.throws(
    () => decodeContextItem({ ...context, role: "assistant" }),
    /semantic human input/,
  );
  assert.throws(
    () => parseUserQuestionReply({ ...reply, caller: "trusted" }),
    /unknown fields/,
  );
  assert.throws(
    () =>
      parseUserQuestionReply({
        ...reply,
        request: { ...reply.request, role: "user" },
      }),
    /unknown fields/,
  );
  assert.throws(
    () =>
      normalizeUserQuestionReply(specification, {
        ...reply,
        answers: [{ questionId: "scope", optionIds: ["foreign"] }],
      }),
    /unknown selected option/,
  );
  assert.throws(
    () =>
      parseUserQuestionSpecification({
        ...specification,
        answerTemplate: "{{scope}} {{scope}}",
      }),
    /repeated/,
  );
});

test("Ask stays a direct model tool in all presentations and cannot publish through code nesting", async () => {
  const tool = new AskUserQuestionToolRuntime();
  for (const mode of ["direct", "code", "both"] as const) {
    const presentation = buildToolPresentation(
      [tool.specification, createRunCodeModelTool()],
      mode,
    );
    assert.ok(presentation.modelToolNames.has(ASK_USER_QUESTION_NAME));
    assert.equal(
      presentation.nestedToolNames.has(ASK_USER_QUESTION_NAME),
      false,
    );
    assert.equal(
      presentation.codeTools.some(
        (tool) => tool.name === ASK_USER_QUESTION_NAME,
      ),
      false,
    );
  }
  await assert.rejects(
    tool.execute({
      name: tool.name,
      callId: "provider-call",
      canonicalToolCallId: "call-a",
      threadId: "thread-a",
      arguments: specification,
      cwd: "/synthetic",
      signal: new AbortController().signal,
      outputAudience: "program",
    }),
    /direct native model call/,
  );
});

test("real Host builtin publishes from semantic call/result and restores locally without activating a fork", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-native-question-"));
  const options = {
    cwd: root,
    dataDirectory: root,
    model: "fake",
    provider: { type: "fake" as const },
    approvalPolicy: "never" as const,
    toolPresentation: "direct" as const,
    experimentalUserQuestions: true,
  };
  let host = createHostedAppServer(options);
  try {
    const thread = await host.startThread();
    await (
      await host.startTurn(
        thread.id,
        `!tool ${ASK_USER_QUESTION_NAME} ${JSON.stringify(specification)}`,
      )
    ).done;
    const snapshot = await host.readThread(thread.id);
    assert.equal(
      snapshot.userQuestions!.length,
      1,
      JSON.stringify(snapshot.items),
    );
    const question = snapshot.userQuestions![0]!;
    assert.equal(question.state, "open");
    assert.deepEqual(question.specification, specification);
    assert.ok(
      snapshot.itemList!.some(
        (item) =>
          item.id === question.request.callItemId && item.kind === "tool_call",
      ),
    );
    assert.ok(
      snapshot.itemList!.some(
        (item) =>
          item.id === question.resultItemId &&
          item.kind === "tool_result" &&
          item.content.text.includes(question.request.callItemId),
      ),
    );
    const fork = await host.forkThread({
      sourceThreadId: thread.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    });
    assert.deepEqual(fork.userQuestions, []);
    await host.closeHostResources();
    host = createHostedAppServer(options);
    assert.deepEqual(
      (await host.readThread(thread.id)).userQuestions,
      snapshot.userQuestions,
    );
  } finally {
    await host.closeHostResources();
    await rm(root, { recursive: true, force: true });
  }
});

test("real Host failed question tool result does not publish", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zen-native-question-failed-"),
  );
  const host = createHostedAppServer({
    cwd: root,
    dataDirectory: root,
    model: "fake",
    provider: { type: "fake" },
    approvalPolicy: "never",
    toolPresentation: "direct",
    experimentalUserQuestions: true,
  });
  try {
    const thread = await host.startThread();
    await (
      await host.startTurn(
        thread.id,
        `!tool ${ASK_USER_QUESTION_NAME} ${JSON.stringify({ questions: [], answerTemplate: "invalid" })}`,
      )
    ).done;
    const snapshot = await host.readThread(thread.id);
    assert.ok(
      snapshot.itemList!.some(
        (item) =>
          item.kind === "tool_call" &&
          item.content.name === ASK_USER_QUESTION_NAME,
      ),
    );
    assert.ok(
      snapshot.itemList!.some(
        (item) => item.kind === "tool_result" && item.content.exitCode !== 0,
      ),
    );
    assert.deepEqual(snapshot.userQuestions, []);
  } finally {
    await host.closeHostResources();
    await rm(root, { recursive: true, force: true });
  }
});

test("actual Host early import-fork can publish and answer new local questions after reload", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zen-question-import-fork-"),
  );
  const options = {
    cwd: root,
    dataDirectory: root,
    model: "fake",
    provider: { type: "fake" as const },
    approvalPolicy: "never" as const,
    toolPresentation: "direct" as const,
    experimentalUserQuestions: true,
  };
  let host = createHostedAppServer(options);
  try {
    const timestamp = "2026-11-02T00:00:00.000Z";
    const row = (type: string, payload: unknown) =>
      JSON.stringify({ timestamp, type, payload });
    const rows = [
      row("session_meta", {
        id: "synthetic-import",
        cwd: root,
        cli_version: "0.146.0",
        timestamp,
      }),
    ];
    for (let i = 0; i < 40; i++)
      for (const role of ["user", "assistant"])
        rows.push(
          row("response_item", {
            type: "message",
            role,
            content: [
              {
                type: role === "user" ? "input_text" : "output_text",
                text: `Synthetic history ${i} ${role}`,
              },
            ],
          }),
        );
    const imported = await host.importThread(
      parseCodexRollout(rows.join("\n") + "\n"),
      { cwd: root },
    );
    const earlier = imported.thread.items.find(
      (item) => item.type === "agent_message",
    )!;
    const fork = await host.forkThread({
      sourceThreadId: imported.thread.id,
      through: { type: "item", itemId: earlier.id },
      workspace: { type: "same-directory" },
    });
    assert.equal(fork.userQuestions!.length, 0);
    await (
      await host.startTurn(
        fork.id,
        `!tool ${ASK_USER_QUESTION_NAME} ${JSON.stringify(specification)}`,
      )
    ).done;
    const snapshot = await host.readThread(fork.id);
    const question = snapshot.userQuestions![0]!;
    assert.equal(question.state, "open");
    assert.deepEqual(
      snapshot.userQuestions,
      readUserQuestions(fork.id, snapshot.itemList!, snapshot.items),
    );
    await host.closeHostResources();
    host = createHostedAppServer(options);
    assert.deepEqual(
      (await host.readThread(fork.id)).userQuestions,
      snapshot.userQuestions,
    );
    const response = await host.respondToUserQuestion(fork.id, {
      questionCallItemId: question.request.callItemId,
      clientId: "local-answer",
      outcome: "cancel",
    });
    await response.turn.done;
    assert.equal(
      (
        await host.readUserQuestion(
          fork.id,
          question.request.callItemId,
          "local-answer",
        )
      ).response.status,
      "claimed",
    );
  } finally {
    await host.closeHostResources();
    await rm(root, { recursive: true, force: true });
  }
});
