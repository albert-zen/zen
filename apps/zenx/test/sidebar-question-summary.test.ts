import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ZenAppServer, type AppServerEvent } from "../../../src/app-server.js";
import { DomainThreadJournal } from "../../../src/domain-journal.js";
import { FileTraceStore } from "../../../src/trace.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { ToolEnvironment, type ToolRuntime } from "../../../src/tool.js";
import { AskUserQuestionToolRuntime } from "../../../src/user-question-tool.js";
import { ASK_USER_QUESTION_NAME } from "../../../src/user-question.js";
import type { ModelAdapter } from "../../../src/model.js";
import {
  isNativeThreadSummary,
  type NativeThreadSummary,
} from "../../../src/thread-summary.js";
import {
  deriveRecentThreads,
  deriveProjectGroups,
  derivePinnedThreads,
} from "../src/renderer/src/thread-list.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("real native publication, pending answer and recall feed the unchanged automatic and manual sidebar orders", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-sidebar-question-"),
  );
  const metadata = new InMemoryThreadMetadataStore();
  const journal = new DomainThreadJournal({
    directory: path.join(directory, "threads"),
    trace: new FileTraceStore(path.join(directory, "trace")),
    metadata,
  });
  let second = 1;
  const now = () => new Date(Date.UTC(2026, 10, 2, 0, 0, second)).toISOString();
  const started = deferred();
  const ordinary = deferred();
  const beforeAsk = deferred();
  const publish = deferred();
  const afterAsk = deferred();
  const noise = deferred();
  const afterNoise = deferred();
  const finish = deferred();
  let sample = 0;
  const model: ModelAdapter = {
    provider: "synthetic-sidebar",
    async *stream() {
      sample += 1;
      if (sample === 1) {
        started.resolve();
        await ordinary.promise;
        yield {
          type: "tool_call",
          callId: "ordinary-before",
          name: "synthetic_noop",
          arguments: {},
        };
      } else if (sample === 2) {
        beforeAsk.resolve();
        await publish.promise;
        yield {
          type: "tool_call",
          callId: "question",
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
      } else if (sample === 3) {
        afterAsk.resolve();
        await noise.promise;
        yield { type: "text_delta", delta: "Independent work continues." };
        yield {
          type: "tool_call",
          callId: "ordinary-after",
          name: "synthetic_noop",
          arguments: {},
        };
      } else {
        afterNoise.resolve();
        await finish.promise;
        yield { type: "text_delta", delta: "Done." };
      }
    },
  };
  const noopTool: ToolRuntime = {
    name: "synthetic_noop",
    specification: {
      name: "synthetic_noop",
      description: "Synthetic no-op",
      inputSchema: { type: "object", properties: {} },
    },
    async execute() {
      return { output: "Synthetic observation", exitCode: 0 };
    },
  };
  const server = new ZenAppServer({
    journal,
    threadMetadata: metadata,
    now,
    runtime: new AgentRuntime({
      now,
      toolEnvironment: new ToolEnvironment({
        bundles: [
          {
            identity: { kind: "builtin", id: "synthetic-sidebar" },
            tools: [new AskUserQuestionToolRuntime(), noopTool],
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
  const events: AppServerEvent[] = [];
  server.subscribe((event) => events.push(event));
  t.after(async () => {
    ordinary.resolve();
    publish.resolve();
    noise.resolve();
    finish.resolve();
    await server.closeRuntimeConfiguration();
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  });
  const a = await server.startThread();
  const running = await server.startTurn(a.id, "Please ask", {
    clientId: "initial",
  });
  await started.promise;
  second = 2;
  const b = await server.startThread();
  const records = async (ids = [a.id, b.id]) =>
    Promise.all(
      ids.map(async (id) => {
        const summary = await server.readThreadSummary(id);
        assert.ok(isNativeThreadSummary(summary));
        assert.notEqual(summary.status, "systemError");
        if (summary.status === "systemError") throw Error(summary.error);
        return summary;
      }),
    );
  const ids = (entries: readonly NativeThreadSummary[]) =>
    entries.map((entry) => entry.threadId);
  const projection = {
    projects: [
      {
        key: directory,
        workspace: directory,
        configured: true,
        isDefault: true,
        threadIds: [a.id, b.id],
      },
    ],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  };
  const pinned = [b.id, a.id];
  const manual = {
    projectKeys: [directory],
    threadIdsByProject: { [directory]: pinned },
  };
  const checkOrders = async (expected: string[]) => {
    const summaries = await records();
    assert.deepEqual(ids(deriveRecentThreads(summaries)), expected);
    assert.deepEqual(
      ids(deriveProjectGroups(summaries, projection)[0]!.threads),
      expected,
    );
    assert.deepEqual(ids(derivePinnedThreads(summaries, pinned)), pinned);
    assert.deepEqual(
      ids(deriveProjectGroups(summaries, projection, manual)[0]!.threads),
      pinned,
    );
  };
  await checkOrders([b.id, a.id]);
  second = 3;
  ordinary.resolve();
  await beforeAsk.promise;
  await checkOrders([b.id, a.id]);
  assert.deepEqual((await records())[0]!.userQuestionSummary, { openCount: 0 });
  second = 4;
  publish.resolve();
  await afterAsk.promise;
  const question = (await server.readThread(a.id)).userQuestions![0]!;
  const open = (await records())[0]!;
  assert.deepEqual(open.userQuestionSummary, {
    openCount: 1,
    latestPublishedAt: now(),
  });
  assert.equal(open.recentActivityAt, question.createdAt);
  assert.equal(
    open.lastTurnEnd,
    undefined,
    "promotion happens before model completion",
  );
  await checkOrders([a.id, b.id]);
  const tie = await server.startThread();
  assert.deepEqual(
    ids(deriveRecentThreads(await records([a.id, tie.id]))),
    [a.id, tie.id].sort((x, y) => x.localeCompare(y)),
  );
  second = 5;
  noise.resolve();
  await afterNoise.promise;
  assert.ok(events.some((event) => event.type === "item_delta"));
  assert.equal((await records())[0]!.recentActivityAt, open.recentActivityAt);
  await checkOrders([a.id, b.id]);
  second = 6;
  const answer = await server.respondToUserQuestion(a.id, {
    questionCallItemId: question.request.callItemId,
    clientId: "answer",
    outcome: "answer",
    answers: [{ questionId: "scope", optionIds: ["small"] }],
  });
  const received = (await records())[0]!;
  assert.deepEqual(received.userQuestionSummary, {
    openCount: 0,
    latestPublishedAt: question.createdAt,
  });
  assert.equal(
    received.recentActivityAt,
    now(),
    "one ordinary human receipt still promotes",
  );
  assert.equal(
    (await server.readUserQuestion(a.id, question.request.callItemId, "answer"))
      .response.status,
    "pending",
  );
  assert.equal(
    (await server.readThread(a.id)).userQuestions![0]!.state,
    "answer-pending",
    "zero open does not mean answered",
  );
  await checkOrders([a.id, b.id]);
  second = 7;
  const newer = await server.startThread();
  assert.deepEqual(ids(deriveRecentThreads(await records([a.id, newer.id]))), [
    newer.id,
    a.id,
  ]);
  second = 8;
  await server.recallSteerMessages(a.id, {
    recallId: "recall",
    targets: [
      {
        queuedItemId: answer.turn.admission!.queuedItemId!,
        clientId: "answer",
        expectedRevision: 0,
      },
    ],
  });
  const reopened = (await records())[0]!;
  assert.deepEqual(reopened.userQuestionSummary, open.userQuestionSummary);
  assert.equal(reopened.recentActivityAt, received.recentActivityAt);
  assert.equal(
    (await server.readThread(a.id)).userQuestions![0]!.state,
    "open",
  );
  assert.deepEqual(
    ids(deriveRecentThreads(await records([a.id, newer.id]))),
    [newer.id, a.id],
    "recall must not promote over later activity",
  );
  await checkOrders([a.id, b.id]);
  assert.deepEqual(pinned, [b.id, a.id]);
  finish.resolve();
  await running.done;
});
