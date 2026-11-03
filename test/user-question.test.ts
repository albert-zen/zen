import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  matchesUserQuestionReplyBody,
  renderUserQuestionAnswer,
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
import { isNativeThreadSummary } from "../src/thread-summary.js";
import { Thread } from "../src/thread.js";

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

test("questions and choices need no template; the normalized fallback is stable, client-compatible and literal", () => {
  const input = {
    questions: [
      {
        id: "scope",
        prompt: "Keep literal {{note}} in this question?",
        options: [{ id: "small", label: "Small {{scope}}" }],
      },
      { id: "note", prompt: "Any note?" },
    ],
  };
  const parsed = parseUserQuestionSpecification(input);
  assert.deepEqual(parsed, {
    ...input,
    answerTemplate: "scope: {{scope}}\n\nnote: {{note}}",
  });
  assert.deepEqual(
    parseUserQuestionSpecification(parsed),
    parsed,
    "native readers retain the established required-template projection shape",
  );
  assert.equal(
    Object.hasOwn(input, "answerTemplate"),
    false,
    "normalization never rewrites the model's call arguments",
  );
  assert.equal(
    renderUserQuestionAnswer(parsed, [
      {
        questionId: "note",
        optionIds: [],
        text: "Literal {{scope}} remains text",
      },
      { questionId: "scope", optionIds: ["small"] },
    ]),
    "scope: Small {{scope}}\n\nnote: Literal {{scope}} remains text",
  );
  assert.deepEqual(
    new AskUserQuestionToolRuntime().specification.inputSchema.required,
    ["questions"],
  );
});

test("explicit templates keep their exact prior bytes and invalid explicit templates still fail", () => {
  assert.deepEqual(
    parseUserQuestionSpecification(specification),
    specification,
  );
  assert.equal(
    renderUserQuestionReply(specification, reply, "q7"),
    "Reply to question scope (q7):\nScope: Small",
  );
  for (const answerTemplate of [null, "", "{{scope}} {{scope}}", "{{missing}}"])
    assert.throws(() =>
      parseUserQuestionSpecification({ ...specification, answerTemplate }),
    );
});

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
    const summary = await host.readThreadSummary(thread.id);
    assert.ok(summary.status !== "systemError");
    assert.deepEqual(summary.userQuestionSummary, {
      openCount: 1,
      latestPublishedAt: question.createdAt,
    });
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
    const forkSummary = await host.readThreadSummary(fork.id);
    assert.ok(forkSummary.status !== "systemError");
    assert.deepEqual(forkSummary.userQuestionSummary, { openCount: 0 });
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
    const summary = await host.readThreadSummary(thread.id);
    assert.ok(summary.status !== "systemError");
    assert.deepEqual(summary.userQuestionSummary, { openCount: 0 });
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
    const summary = await host.readThreadSummary(fork.id);
    assert.ok(summary.status !== "systemError");
    assert.deepEqual(summary.userQuestionSummary, {
      openCount: 1,
      latestPublishedAt: question.createdAt,
    });
    assert.deepEqual(
      snapshot.userQuestions,
      readUserQuestions(fork.id, snapshot.itemList!, snapshot.items),
    );
    await host.closeHostResources();
    host = createHostedAppServer(options);
    assert.deepEqual(await host.readThreadSummary(fork.id), summary);
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

test("Ask summary rebuilds from real persisted semantic sources, never missing or forged JSON cache", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zen-question-summary-rebuild-"),
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
    const thread = await host.startThread();
    await (
      await host.startTurn(
        thread.id,
        `!tool ${ASK_USER_QUESTION_NAME} ${JSON.stringify(specification)}`,
      )
    ).done;
    const question = (await host.readThread(thread.id)).userQuestions![0]!;
    const response = await host.respondToUserQuestion(thread.id, {
      questionCallItemId: question.request.callItemId,
      clientId: "close-before-reload",
      outcome: "cancel",
    });
    await response.turn.done;
    const expected = await host.readThreadSummary(thread.id);
    assert.ok(expected.status !== "systemError");
    assert.deepEqual(expected.userQuestionSummary, {
      openCount: 0,
      latestPublishedAt: question.createdAt,
    });
    assert.equal(isNativeThreadSummary(expected), true);
    for (const invalid of [
      { openCount: -1 },
      { openCount: 0.5 },
      { openCount: Number.MAX_SAFE_INTEGER + 1 },
      { openCount: "1" },
      { latestPublishedAt: question.createdAt },
      { openCount: 0, latestPublishedAt: "unknown" },
    ])
      assert.equal(
        isNativeThreadSummary({ ...expected, userQuestionSummary: invalid }),
        false,
      );
    assert.equal(
      isNativeThreadSummary({ ...expected, userQuestionSummary: undefined }),
      true,
    );
    for (const cache of [
      undefined,
      "not json",
      JSON.stringify({
        version: 1,
        summaries: [
          {
            ...expected,
            userQuestionSummary: {
              openCount: 999,
              latestPublishedAt: "2099-01-01T00:00:00.000Z",
            },
            recentActivityAt: "2099-01-01T00:00:00.000Z",
          },
        ],
      }),
    ]) {
      await host.flushThreadSummaryProjection();
      await host.closeHostResources();
      const filename = path.join(root, "thread-summaries.json");
      if (cache === undefined) await rm(filename, { force: true });
      else await writeFile(filename, cache);
      host = createHostedAppServer({
        ...options,
        experimentalUserQuestions: false,
      });
      assert.deepEqual(await host.readThreadSummary(thread.id), expected);
    }
  } finally {
    await host.closeHostResources();
    await rm(root, { recursive: true, force: true });
  }
});

test("real DomainJournal missing-call compilation repair keeps result-before-call Ask visible and answerable", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zen-question-call-repair-"),
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
    const thread = await host.startThread();
    await (
      await host.startTurn(
        thread.id,
        `!tool ${ASK_USER_QUESTION_NAME} ${JSON.stringify(specification)}`,
      )
    ).done;
    const before = await host.readThread(thread.id);
    const question = before.userQuestions![0]!;
    const missingCall = before.itemList!.find(
      (item) => item.id === question.request.callItemId,
    )!;
    const partial = new Thread(
      thread.id,
      before.items,
      before.itemList!.filter((item) => item.id !== missingCall.id),
    );
    assert.deepEqual(partial.userQuestionSummary, { openCount: 0 });
    assert.deepEqual(partial.userQuestions, []);
    assert.equal(partial.takeUserQuestionAttentionInvalidation(), false);
    partial.appendContext(missingCall);
    assert.deepEqual(
      partial.userQuestions,
      [question],
      "a late repaired call invalidates even after the missing-call projection was read",
    );
    assert.equal(partial.takeUserQuestionAttentionInvalidation(), true);
    const expected = await host.readThreadSummary(thread.id);
    await host.flushThreadSummaryProjection();
    await host.closeHostResources();
    // Synthetic loss of one compiled artifact; immutable original Trace stays intact.
    const filename = path.join(root, "threads", "items", `${thread.id}.jsonl`);
    const encoded = (await readFile(filename, "utf8")).trim().split("\n");
    const kept = encoded.filter(
      (line) =>
        (JSON.parse(line) as { id: string }).id !== question.request.callItemId,
    );
    assert.equal(kept.length, encoded.length - 1);
    await writeFile(filename, `${kept.join("\n")}\n`);
    host = createHostedAppServer(options);
    const repaired = await host.readThread(thread.id);
    assert.ok(
      repaired.itemList!.findIndex(
        (item) => item.id === question.request.callItemId,
      ) >
        repaired.itemList!.findIndex(
          (item) => item.id === question.resultItemId,
        ),
      "actual append-only compiler recovery appends the missing call after its result",
    );
    assert.deepEqual(
      readUserQuestions(thread.id, repaired.itemList!, repaired.items),
      [question],
    );
    assert.deepEqual(repaired.userQuestions, [question]);
    assert.deepEqual(await host.readThreadSummary(thread.id), expected);
    const response = await host.respondToUserQuestion(thread.id, {
      questionCallItemId: question.request.callItemId,
      clientId: "answer-after-compilation-repair",
      outcome: "cancel",
    });
    await response.turn.done;
    const closed = await host.readThreadSummary(thread.id);
    assert.ok(closed.status !== "systemError");
    assert.deepEqual(closed.userQuestionSummary, {
      openCount: 0,
      latestPublishedAt: question.createdAt,
    });
  } finally {
    await host.closeHostResources();
    await rm(root, { recursive: true, force: true });
  }
});

test("reply keys preserve authored order and a separate compact request identity", () => {
  const spec = parseUserQuestionSpecification({
    questions: [
      { id: "scope", prompt: "Which scope?" },
      { id: "note", prompt: "Any note?" },
    ],
  });
  const answer = {
    ...reply,
    answers: [
      { questionId: "note", optionIds: [], text: "later" },
      { questionId: "scope", optionIds: [], text: "small" },
    ],
  };
  assert.equal(
    renderUserQuestionReply(spec, answer, "q8"),
    "Reply to questions scope, note (q8):\nscope: small\n\nnote: later",
  );
  assert.equal(
    renderUserQuestionReply(
      spec,
      { version: 1, request: reply.request, outcome: "cancel" },
      "q8",
    ),
    "I chose not to answer questions scope, note (q8).",
  );
  for (const text of [
    "Reply to question call-a:\nScope: Small",
    "Reply to question scope:\nScope: Small",
    "Reply to question scope (q7):\nScope: Small",
  ])
    assert.equal(
      matchesUserQuestionReplyBody(specification, reply, text, "q7"),
      true,
    );
  assert.equal(
    matchesUserQuestionReplyBody(
      specification,
      reply,
      "Reply to question scope (q8):\nScope: Small",
      "q7",
    ),
    false,
  );
  assert.equal(
    matchesUserQuestionReplyBody(
      specification,
      reply,
      "Reply to question scope:\nScope: Large",
      "q7",
    ),
    false,
  );
});
