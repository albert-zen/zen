import assert from "node:assert/strict";
import test from "node:test";

import { AppServerError, ZenAppServer } from "../src/app-server.js";
import { validateContextCompactionItem } from "../src/context-compaction.js";
import type {
  CanonicalItem,
  ContextCompactionItem,
  ThreadMetadataItem,
} from "../src/item.js";
import { InMemoryThreadJournal, type ThreadJournal } from "../src/journal.js";
import { StaticModelCatalog, type ModelCatalog } from "../src/model-catalog.js";
import {
  compileModelMessages,
  type ModelAdapter,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest,
} from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { projectThread } from "../src/protocol/codex/mapper.js";
import { AgentRuntime, type RunTurnOptions } from "../src/runtime.js";
import { Thread } from "../src/thread.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ShellToolExecutor } from "../src/tool.js";

const SUMMARY_MARKER = "ZEN_CONTEXT_COMPACTION_V1";

test("manually compacts long history without changing the complete transcript", async () => {
  const requests: ModelRequest[] = [];
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(cloneRequest(request));
      const latest = request.messages.at(-1);
      if (
        latest?.role === "user" &&
        "text" in latest &&
        latest.text.includes(SUMMARY_MARKER)
      ) {
        yield { type: "text_delta", delta: "summary bytes\nkept verbatim" };
        yield { type: "usage", inputTokens: 101, outputTokens: 7 };
        return;
      }
      yield { type: "text_delta", delta: `answer-${String(requests.length)}` };
    },
  };
  const journal = new InMemoryThreadJournal();
  const server = createServer({ journal, model });
  const thread = await server.startThread();
  for (const input of ["first", "second", "third"]) {
    await (
      await server.startTurn(thread.id, input)
    ).done;
  }

  const before = await server.readThread(thread.id);
  const beforeBytes = before.items.map((item) => JSON.stringify(item));
  const result = await server.compactThread(thread.id);
  const compacted = await server.readThread(thread.id);

  assert.deepEqual(
    compacted.items
      .slice(0, before.items.length)
      .map((item) => JSON.stringify(item)),
    beforeBytes,
  );
  const item = compacted.items.at(-1);
  assert(item?.type === "context_compaction");
  assert.equal(result.compactionItemId, item.id);
  assert.equal(item.coveredThroughItemId, before.items.at(-1)?.id);
  assert.equal(item.summary, "summary bytes\nkept verbatim");
  assert.equal(item.algorithmVersion, "zen.context-compaction.v1");
  assert.deepEqual(item.tokenUsage, { inputTokens: 101, outputTokens: 7 });
  assert.deepEqual(
    item.retainedItemIds,
    before.turns.at(-1)?.items.map(({ id }) => id),
  );
  assert.deepEqual(
    {
      providerProfileId: item.providerProfileId,
      modelId: item.modelId,
      reasoningEffort: item.reasoningEffort,
    },
    {
      providerProfileId: "recording",
      modelId: "recording-model",
      reasoningEffort: "medium",
    },
  );

  const summaryRequest = requests.at(-1);
  assert(summaryRequest !== undefined);
  assert.equal(summaryRequest.sessionId, undefined);
  assert.deepEqual(summaryRequest.tools, []);
  assert.equal(summaryRequest.model, "recording-model");
  assert.equal(summaryRequest.reasoningEffort, "medium");

  await (
    await server.startTurn(thread.id, "after compaction")
  ).done;
  const postCompactionRequest = requests.at(-1);
  assert(postCompactionRequest !== undefined);
  assert.deepEqual(postCompactionRequest.messages, [
    { role: "user", content: [{ type: "text", text: "third" }] },
    { role: "assistant", text: "answer-3" },
    {
      role: "user",
      text: "[Zen compacted context]\nsummary bytes\nkept verbatim",
    },
    {
      role: "user",
      content: [{ type: "text", text: "after compaction" }],
    },
  ]);

  const transcript = projectThread(await server.readThread(thread.id), {
    includeTurns: true,
  });
  assert.equal(transcript.turns.length, 4);
  assert.deepEqual(
    transcript.turns.flatMap((turn) => turn.items).map((entry) => entry.type),
    [
      "userMessage",
      "agentMessage",
      "userMessage",
      "agentMessage",
      "userMessage",
      "agentMessage",
      "userMessage",
      "agentMessage",
    ],
  );
});

test("automatically compacts exactly at 80% using the highest Provider usage sample", async () => {
  const requests: ModelRequest[] = [];
  let normalSamples = 0;
  let summaryCalls = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(cloneRequest(request));
      if (isSummaryRequest(request)) {
        summaryCalls += 1;
        yield { type: "text_delta", delta: "automatic summary" };
        yield { type: "usage", inputTokens: 12, outputTokens: 3 };
        return;
      }
      normalSamples += 1;
      if (normalSamples === 1) {
        yield {
          type: "tool_call",
          callId: "round-one",
          name: "shell",
          arguments: { command: "printf tool-bytes" },
        };
        yield { type: "usage", inputTokens: 80, outputTokens: 4 };
        return;
      }
      yield {
        type: "reasoning",
        reasoningContent: "reasoning bytes",
        summary: "reasoning bytes",
        contentVisibility: "public",
      };
      yield { type: "text_delta", delta: "answer bytes" };
      yield { type: "usage", inputTokens: 79, outputTokens: 5 };
    },
  };
  const journal = new InMemoryThreadJournal();
  const server = createServer({
    journal,
    model,
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow: 100 },
    ]),
  });
  const thread = await server.startThread();
  const handle = await server.startTurn(thread.id, "compact me");
  await handle.done;

  const completed = await server.readThread(thread.id);
  assert.equal(summaryCalls, 1);
  assert.deepEqual(
    completed.items.map((item) => item.type),
    [
      "thread_metadata",
      "turn_started",
      "user_message",
      "model_usage",
      "tool_call",
      "tool_result",
      "reasoning",
      "model_usage",
      "agent_message",
      "turn_completed",
      "context_compaction",
    ],
  );
  assert.equal(
    completed.items.filter((item) => item.type === "context_compaction").length,
    1,
  );
  const originalTrace = completed.items.slice(0, -1);
  assert.equal(JSON.stringify(originalTrace).includes("tool-bytes"), true);
  assert.equal(JSON.stringify(originalTrace).includes("reasoning bytes"), true);
  assert.equal(JSON.stringify(originalTrace).includes("answer bytes"), true);

  const restarted = createServer({
    journal,
    model,
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow: 100 },
    ]),
  });
  const afterRestart = await restarted.readThread(thread.id);
  assert.equal(
    JSON.stringify(compileModelMessages(afterRestart.items)),
    JSON.stringify(compileModelMessages(completed.items)),
  );
  assert.equal(
    JSON.stringify(projectThread(afterRestart, { includeTurns: true })),
    JSON.stringify(projectThread(completed, { includeTurns: true })),
  );
  assert.equal(requests.length, 3);
  assert(
    requests[2]?.messages.some(
      (message) =>
        message.role === "reasoning" &&
        message.reasoningContent === "reasoning bytes" &&
        message.contentVisibility === "public",
    ),
  );
});

test("automatic compaction does not guess below threshold, without usage, or with an unknown window", async (t) => {
  const cases = [
    {
      name: "below threshold",
      contextWindow: 100,
      usage: { inputTokens: 79, outputTokens: 1 },
    },
    { name: "absent usage", contextWindow: 100, usage: undefined },
    {
      name: "invalid usage",
      contextWindow: 100,
      usage: { inputTokens: -1, outputTokens: 1 },
    },
    {
      name: "partially invalid usage",
      contextWindow: 100,
      usage: { inputTokens: 80, outputTokens: -1 },
    },
    {
      name: "unknown window",
      contextWindow: null,
      usage: { inputTokens: 80, outputTokens: 1 },
    },
  ] as const;
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let summaryCalls = 0;
      const model: ModelAdapter = {
        provider: "recording",
        async *stream(request): AsyncIterable<ModelEvent> {
          if (isSummaryRequest(request)) {
            summaryCalls += 1;
            yield { type: "text_delta", delta: "must not happen" };
            return;
          }
          yield { type: "text_delta", delta: "answer" };
          if (scenario.usage !== undefined) {
            yield { type: "usage", ...scenario.usage };
          }
        },
      };
      const server = createServer({
        journal: new InMemoryThreadJournal(),
        model,
        modelCatalog: new StaticModelCatalog([
          {
            id: "recording-model",
            isDefault: true,
            contextWindow: scenario.contextWindow,
          },
        ]),
      });
      const thread = await server.startThread();
      await (
        await server.startTurn(thread.id, "one")
      ).done;
      const snapshot = await server.readThread(thread.id);
      assert.equal(summaryCalls, 0);
      assert.equal(
        snapshot.items.some((item) => item.type === "context_compaction"),
        false,
      );
    });
  }
});

test("automatic compaction freezes admitted selection across a concurrent settings update", async () => {
  const normalStarted = deferred<void>();
  const releaseNormal = deferred<void>();
  const summaryStarted = deferred<void>();
  const releaseSummary = deferred<void>();
  const summarySelections: Array<{
    model: string;
    reasoningEffort: string;
  }> = [];
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        summarySelections.push({
          model: request.model,
          reasoningEffort: request.reasoningEffort,
        });
        summaryStarted.resolve();
        await releaseSummary.promise;
        yield { type: "text_delta", delta: "frozen automatic summary" };
        return;
      }
      if (request.model === "recording-model") {
        yield { type: "usage", inputTokens: 80, outputTokens: 1 };
        normalStarted.resolve();
        await releaseNormal.promise;
      }
      yield { type: "text_delta", delta: "answer" };
    },
  };
  const catalog = new StaticModelCatalog([
    { id: "recording-model", isDefault: true, contextWindow: 100 },
    { id: "other-model", contextWindow: 1_000 },
  ]);
  const server = createServer({
    journal: new InMemoryThreadJournal(),
    model,
    modelCatalog: catalog,
  });
  const thread = await server.startThread();
  const handle = await server.startTurn(thread.id, "one");
  await normalStarted.promise;
  const updated = await server.updateThreadSettings(thread.id, {
    model: "other-model",
  });
  assert.equal(updated.modelId, "other-model");
  releaseNormal.resolve();
  await summaryStarted.promise;
  let handleSettled = false;
  void handle.done.then(() => {
    handleSettled = true;
  });
  await Promise.resolve();
  assert.equal(handleSettled, false);
  releaseSummary.resolve();
  await handle.done;

  const snapshot = await server.readThread(thread.id);
  const compacted = snapshot.items.find(
    (item) => item.type === "context_compaction",
  );
  assert(compacted?.type === "context_compaction");
  assert.deepEqual(summarySelections, [
    { model: "recording-model", reasoningEffort: "medium" },
  ]);
  assert.equal(compacted.providerProfileId, "recording");
  assert.equal(compacted.modelId, "recording-model");
  assert.equal(compacted.reasoningEffort, "medium");
});

test("automatic compaction failure does not fail a completed Turn", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...arguments_: unknown[]) => {
    warnings.push(String(arguments_[0]));
  });
  let normalCalls = 0;
  let summaryCalls = 0;
  const journal = new InMemoryThreadJournal();
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        summaryCalls += 1;
        throw new Error("summary provider unavailable");
      }
      normalCalls += 1;
      yield { type: "text_delta", delta: `answer-${String(normalCalls)}` };
      yield { type: "usage", inputTokens: 80, outputTokens: 1 };
    },
  };
  const server = createServer({
    journal,
    model,
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow: 100 },
    ]),
  });
  const thread = await server.startThread();

  const first = await server.startTurn(thread.id, "one");
  await first.done;
  let snapshot = await server.readThread(thread.id);
  assert.equal(summaryCalls, 1);
  assert.equal(snapshot.turns[0]?.status, "completed");
  assert.equal(
    snapshot.items.filter((item) => item.type === "turn_completed").length,
    1,
  );
  assert.equal(
    snapshot.items.some((item) => item.type === "context_compaction"),
    false,
  );

  const second = await server.startTurn(thread.id, "two");
  await second.done;
  snapshot = await server.readThread(thread.id);
  assert.equal(summaryCalls, 2);
  assert.equal(snapshot.turns[1]?.status, "completed");
  assert.equal(
    snapshot.items.filter((item) => item.type === "turn_completed").length,
    2,
  );
  assert.equal(
    snapshot.items.some((item) => item.type === "context_compaction"),
    false,
  );

  const persistenceBacking = new InMemoryThreadJournal();
  const persistenceJournal: ThreadJournal = {
    append: async (item) => {
      if (item.type === "context_compaction") {
        throw new Error("journal unavailable");
      }
      await persistenceBacking.append(item);
    },
    listThreadIds: async () => await persistenceBacking.listThreadIds(),
    read: async (threadId) => await persistenceBacking.read(threadId),
  };
  let persistenceSummaryCalls = 0;
  const persistenceModel: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        persistenceSummaryCalls += 1;
        yield { type: "text_delta", delta: "summary" };
        return;
      }
      yield { type: "text_delta", delta: "answer" };
      yield { type: "usage", inputTokens: 80, outputTokens: 1 };
    },
  };
  const persistence = createServer({
    journal: persistenceJournal,
    model: persistenceModel,
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow: 100 },
    ]),
  });
  const persistenceThread = await persistence.startThread();
  const persistenceHandle = await persistence.startTurn(
    persistenceThread.id,
    "persist",
  );
  await persistenceHandle.done;
  assert.equal(persistenceSummaryCalls, 1);
  assert.equal(
    (await persistence.readThread(persistenceThread.id)).turns[0]?.status,
    "completed",
  );
  assert.equal(
    (await persistenceBacking.read(persistenceThread.id)).some(
      (item) => item.type === "context_compaction",
    ),
    false,
  );
  assert.equal(warnings.length, 3);
  assert(
    warnings.every((warning) =>
      warning.startsWith("Could not automatically compact completed Turn"),
    ),
  );
});

test("automatic compaction ignores failed and interrupted Turns despite high usage", async () => {
  let summaryCalls = 0;
  const failing: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        summaryCalls += 1;
        yield { type: "text_delta", delta: "must not happen" };
        return;
      }
      yield { type: "usage", inputTokens: 80, outputTokens: 1 };
      throw new Error("model failed");
    },
  };
  const catalog = new StaticModelCatalog([
    { id: "recording-model", isDefault: true, contextWindow: 100 },
  ]);
  const failed = createServer({
    journal: new InMemoryThreadJournal(),
    model: failing,
    modelCatalog: catalog,
  });
  const failedThread = await failed.startThread();
  await (
    await failed.startTurn(failedThread.id, "fail")
  ).done;
  let snapshot = await failed.readThread(failedThread.id);
  assert.equal(snapshot.turns.at(-1)?.status, "failed");
  assert.equal(
    snapshot.items.some((item) => item.type === "context_compaction"),
    false,
  );

  const started = deferred<void>();
  const blocking: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        summaryCalls += 1;
        yield { type: "text_delta", delta: "must not happen" };
        return;
      }
      yield { type: "usage", inputTokens: 80, outputTokens: 1 };
      started.resolve();
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      request.signal.throwIfAborted();
    },
  };
  const interrupted = createServer({
    journal: new InMemoryThreadJournal(),
    model: blocking,
    modelCatalog: catalog,
  });
  const interruptedThread = await interrupted.startThread();
  const handle = await interrupted.startTurn(interruptedThread.id, "stop");
  await started.promise;
  await interrupted.interruptTurn(interruptedThread.id, handle.id);
  await handle.done;
  snapshot = await interrupted.readThread(interruptedThread.id);
  assert.equal(snapshot.turns.at(-1)?.status, "interrupted");
  assert.equal(
    snapshot.items.some((item) => item.type === "context_compaction"),
    false,
  );
  assert.equal(summaryCalls, 0);
});

test("validates compaction boundaries, retained order, and complete tool lifecycles", () => {
  const items = canonicalToolHistory();
  const valid = contextCompactionItem(items);
  const thread = new Thread("thread", items);
  thread.append(valid);

  assert.throws(
    () =>
      new Thread("thread", items).append({
        ...valid,
        id: "mid-tool",
        coveredThroughItemId: "call-1",
      }),
    /boundary must be a turn_completed Item/u,
  );
  assert.throws(
    () =>
      new Thread("thread", items).append({
        ...valid,
        id: "duplicates",
        retainedItemIds: ["call-1", "call-1"],
      }),
    /Duplicate retained Item id/u,
  );
  assert.throws(
    () =>
      new Thread("thread", items).append({
        ...valid,
        id: "unstable-order",
        retainedItemIds: ["result-1", "call-1"],
      }),
    /stable canonical order/u,
  );
  assert.throws(
    () =>
      new Thread("thread", items).append({
        ...valid,
        id: "missing-ref",
        retainedItemIds: ["missing"],
      }),
    /does not exist/u,
  );
  assert.throws(
    () =>
      new Thread("thread", items).append({
        ...valid,
        id: "partial-call-set",
        retainedItemIds: ["response", "call-1", "result-1"],
      }),
    /tool response is incomplete/u,
  );
  assert.throws(
    () =>
      new Thread("thread", items).append({
        ...valid,
        id: "missing-result",
        retainedItemIds: ["response", "call-1", "call-2", "result-1"],
      }),
    /tool lifecycle is incomplete/u,
  );
  assert.throws(() => {
    const brokenHistory = items.filter((item) => item.id !== "result-2");
    new Thread("thread", brokenHistory).append(
      contextCompactionItem(brokenHistory),
    );
  }, /exactly one result/u);

  const configurationAfterBoundary: CanonicalItem = {
    id: "changed-after-boundary",
    threadId: "thread",
    createdAt: "2026-01-01T00:00:01.000Z",
    type: "thread_configuration_changed",
    selection: {
      from: {
        providerProfileId: "recording",
        modelId: "recording-model",
        reasoningEffort: "medium",
      },
      to: {
        providerProfileId: "recording",
        modelId: "other-model",
        reasoningEffort: "medium",
      },
    },
  };
  assert.throws(
    () =>
      new Thread("thread", [...items, configurationAfterBoundary]).append({
        ...valid,
        id: "after-boundary",
        modelId: "other-model",
        retainedItemIds: ["changed-after-boundary"],
      }),
    /after the compaction boundary/u,
  );
});

test("rejects malformed compaction identity and containers before persistence", async (t) => {
  const malformedCases: Array<{
    name: string;
    override: Record<string, unknown>;
    message: RegExp;
  }> = [
    {
      name: "empty stable identity",
      override: { id: "" },
      message: /id must be non-empty/u,
    },
    {
      name: "non-array retained ids",
      override: { retainedItemIds: "started" },
      message: /retainedItemIds must be an array/u,
    },
    {
      name: "unexpected Turn membership",
      override: { turnId: "turn" },
      message: /must not belong to a Turn/u,
    },
    {
      name: "null token usage",
      override: { tokenUsage: null },
      message: /tokenUsage must be an object/u,
    },
    {
      name: "array token usage",
      override: { tokenUsage: [] },
      message: /tokenUsage must be an object/u,
    },
  ];
  for (const malformed of malformedCases) {
    await t.test(malformed.name, async () => {
      const journal = new InMemoryThreadJournal();
      const runtime = new MalformedCompactionRuntime(malformed.override);
      const server = createServer({ journal, model: echoModel(), runtime });
      const thread = await server.startThread();
      await assert.rejects(
        server.startTurn(thread.id, "must not persist"),
        malformed.message,
      );
      assert.deepEqual(
        (await journal.read(thread.id)).map((item) => item.type),
        ["thread_metadata"],
      );
    });
  }

  assert.throws(
    () =>
      validateContextCompactionItem([], {
        ...malformedCompactionShape(),
        type: "failure",
      } as unknown as ContextCompactionItem),
    /type must be context_compaction/u,
  );
});

test("rejects active, incomplete, empty, and duplicate boundaries before mutation", async () => {
  const emptyJournal = new InMemoryThreadJournal();
  const empty = createServer({ journal: emptyJournal, model: echoModel() });
  const emptyThread = await empty.startThread();
  await expectAppServerCode(
    empty.compactThread(emptyThread.id),
    "compaction_not_available",
  );
  assert.equal((await emptyJournal.read(emptyThread.id)).length, 1);

  const incompleteJournal = new InMemoryThreadJournal();
  for (const item of canonicalIncompleteHistory()) {
    await incompleteJournal.append(item);
  }
  const incomplete = createServer({
    journal: incompleteJournal,
    model: echoModel(),
  });
  await expectAppServerCode(
    incomplete.compactThread("thread"),
    "compaction_incomplete_turn",
  );
  assert.deepEqual(
    await incompleteJournal.read("thread"),
    canonicalIncompleteHistory(),
  );

  const modelStarted = deferred<void>();
  const blocking: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      modelStarted.resolve();
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      request.signal.throwIfAborted();
    },
  };
  const active = createServer({
    journal: new InMemoryThreadJournal(),
    model: blocking,
  });
  const activeThread = await active.startThread();
  const handle = await active.startTurn(activeThread.id, "wait");
  await modelStarted.promise;
  await expectAppServerCode(
    active.compactThread(activeThread.id),
    "thread_busy",
  );
  await active.interruptTurn(activeThread.id, handle.id);
  await handle.done;

  const duplicate = createServer({
    journal: new InMemoryThreadJournal(),
    model: summaryModel(),
  });
  const duplicateThread = await duplicate.startThread();
  await (
    await duplicate.startTurn(duplicateThread.id, "one")
  ).done;
  await duplicate.compactThread(duplicateThread.id);
  const beforeDuplicate = await duplicate.readThread(duplicateThread.id);
  await expectAppServerCode(
    duplicate.compactThread(duplicateThread.id),
    "compaction_not_available",
  );
  assert.deepEqual(
    (await duplicate.readThread(duplicateThread.id)).items,
    beforeDuplicate.items,
  );
});

test("generation, abort, invalid summary, and journal failures append no compaction and never retry", async (t) => {
  const scenarios: Array<{
    name: string;
    code: string;
    summaryEvents: () => AsyncIterable<ModelEvent>;
  }> = [
    {
      name: "generation failure",
      code: "compaction_generation_failed",
      summaryEvents: async function* () {
        throw new Error("provider unavailable");
      },
    },
    {
      name: "empty summary",
      code: "compaction_invalid_summary",
      summaryEvents: async function* () {
        yield { type: "text_delta", delta: "   " };
      },
    },
    {
      name: "tool call summary",
      code: "compaction_invalid_summary",
      summaryEvents: async function* () {
        yield {
          type: "tool_call",
          callId: "forbidden",
          name: "shell",
          arguments: {},
        };
      },
    },
    {
      name: "invalid usage",
      code: "compaction_invalid_summary",
      summaryEvents: async function* () {
        yield { type: "text_delta", delta: "summary" };
        yield { type: "usage", inputTokens: -1, outputTokens: 1 };
      },
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let summaryCalls = 0;
      const model: ModelAdapter = {
        provider: "recording",
        async *stream(request): AsyncIterable<ModelEvent> {
          if (isSummaryRequest(request)) {
            summaryCalls += 1;
            yield* scenario.summaryEvents();
            return;
          }
          yield { type: "text_delta", delta: "answer" };
        },
      };
      const journal = new InMemoryThreadJournal();
      const server = createServer({ journal, model });
      const thread = await server.startThread();
      await (
        await server.startTurn(thread.id, "one")
      ).done;
      const before = await journal.read(thread.id);
      await expectAppServerCode(server.compactThread(thread.id), scenario.code);
      assert.equal(summaryCalls, 1);
      assert.deepEqual(await journal.read(thread.id), before);
    });
  }

  const summaryStarted = deferred<void>();
  let abortCalls = 0;
  const abortingModel: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (!isSummaryRequest(request)) {
        yield { type: "text_delta", delta: "answer" };
        return;
      }
      abortCalls += 1;
      summaryStarted.resolve();
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      request.signal.throwIfAborted();
    },
  };
  const abortJournal = new InMemoryThreadJournal();
  const aborting = createServer({
    journal: abortJournal,
    model: abortingModel,
  });
  const abortThread = await aborting.startThread();
  await (
    await aborting.startTurn(abortThread.id, "one")
  ).done;
  const beforeAbort = await abortJournal.read(abortThread.id);
  const controller = new AbortController();
  const compaction = aborting.compactThread(abortThread.id, {
    signal: controller.signal,
  });
  await summaryStarted.promise;
  controller.abort(new DOMException("stop", "AbortError"));
  await expectAppServerCode(compaction, "compaction_aborted");
  assert.equal(abortCalls, 1);
  assert.deepEqual(await abortJournal.read(abortThread.id), beforeAbort);

  const backing = new InMemoryThreadJournal();
  const failingJournal: ThreadJournal = {
    append: async (item) => {
      if (item.type === "context_compaction") {
        throw new Error("journal unavailable");
      }
      await backing.append(item);
    },
    listThreadIds: async () => await backing.listThreadIds(),
    read: async (threadId) => await backing.read(threadId),
  };
  let persistenceSummaryCalls = 0;
  const persistenceModel = summaryModel(() => {
    persistenceSummaryCalls += 1;
  });
  const persistence = createServer({
    journal: failingJournal,
    model: persistenceModel,
  });
  const persistenceThread = await persistence.startThread();
  await (
    await persistence.startTurn(persistenceThread.id, "one")
  ).done;
  const beforePersistence = await backing.read(persistenceThread.id);
  await expectAppServerCode(
    persistence.compactThread(persistenceThread.id),
    "compaction_persistence_failed",
  );
  assert.equal(persistenceSummaryCalls, 1);
  assert.deepEqual(await backing.read(persistenceThread.id), beforePersistence);
});

test("later compaction supersedes projection deterministically and restart is byte-equivalent", async () => {
  const journal = new InMemoryThreadJournal();
  let summaryCalls = 0;
  const model = summaryModel(() => {
    summaryCalls += 1;
  });
  const first = createServer({ journal, model });
  const thread = await first.startThread();
  await (
    await first.startTurn(thread.id, "first")
  ).done;
  await (
    await first.startTurn(thread.id, "second")
  ).done;
  await first.compactThread(thread.id);
  assert.equal(summaryCalls, 1);
  await expectAppServerCode(
    first.compactThread(thread.id),
    "compaction_not_available",
  );
  assert.equal(summaryCalls, 1);

  await (
    await first.startTurn(thread.id, "third")
  ).done;
  await first.compactThread(thread.id);
  assert.equal(summaryCalls, 2);
  const beforeRestart = await first.readThread(thread.id);
  const projectedBefore = compileModelMessages(beforeRestart.items);
  assert.deepEqual(projectedBefore, [
    { role: "user", content: [{ type: "text", text: "third" }] },
    { role: "assistant", text: "answer" },
    { role: "user", text: "[Zen compacted context]\nsummary-2" },
  ]);

  const restarted = createServer({ journal, model });
  const afterRestart = await restarted.readThread(thread.id);
  const projectedAfter = compileModelMessages(afterRestart.items);
  assert.equal(JSON.stringify(projectedAfter), JSON.stringify(projectedBefore));
  assert.equal(
    projectThread(afterRestart, { includeTurns: true }).turns.length,
    3,
  );

  const legacy = canonicalToolHistory();
  assert.deepEqual(
    compileModelMessages(legacy),
    compileModelMessages(structuredClone(legacy)),
  );
});

test("freezes the admitted Provider selection while a settings update waits", async () => {
  const summaryStarted = deferred<void>();
  const releaseSummary = deferred<void>();
  const summarySelections: Array<{
    model: string;
    reasoningEffort: string;
  }> = [];
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        summarySelections.push({
          model: request.model,
          reasoningEffort: request.reasoningEffort,
        });
        summaryStarted.resolve();
        await releaseSummary.promise;
        yield { type: "text_delta", delta: "frozen summary" };
        return;
      }
      yield { type: "text_delta", delta: "answer" };
    },
  };
  const server = createServer({
    journal: new InMemoryThreadJournal(),
    model,
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true },
      { id: "other-model" },
    ]),
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "one")
  ).done;

  const compaction = server.compactThread(thread.id);
  await summaryStarted.promise;
  let updateResolved = false;
  const update = server
    .updateThreadSettings(thread.id, { model: "other-model" })
    .then((snapshot) => {
      updateResolved = true;
      return snapshot;
    });
  await Promise.resolve();
  assert.equal(updateResolved, false);
  releaseSummary.resolve();
  await compaction;
  const updated = await update;
  assert.equal(updated.modelId, "other-model");
  assert.deepEqual(summarySelections, [
    { model: "recording-model", reasoningEffort: "medium" },
  ]);
  const compacted = updated.items.find(
    (item) => item.type === "context_compaction",
  );
  assert(compacted?.type === "context_compaction");
  assert.equal(compacted.modelId, "recording-model");
  assert.equal(compacted.providerProfileId, "recording");
  assert.equal(compacted.reasoningEffort, "medium");
});

function createServer(options: {
  journal: ThreadJournal;
  model: ModelAdapter;
  modelCatalog?: ModelCatalog;
  runtime?: AgentRuntime;
}): ZenAppServer {
  const modelCatalog =
    options.modelCatalog ??
    new StaticModelCatalog([{ id: "recording-model", isDefault: true }]);
  return new ZenAppServer({
    journal: options.journal,
    runtime:
      options.runtime ?? new AgentRuntime({ tools: new ShellToolExecutor() }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: options.model.provider,
        adapter: options.model,
        modelCatalog,
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: options.model.provider,
      modelId: modelCatalog.defaultModel().id,
      reasoningEffort:
        modelCatalog.defaultModel().defaultReasoningEffort ?? "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}

class MalformedCompactionRuntime extends AgentRuntime {
  readonly #override: Record<string, unknown>;

  constructor(override: Record<string, unknown>) {
    super({ tools: new ShellToolExecutor() });
    this.#override = override;
  }

  override async runTurn(options: RunTurnOptions): Promise<void> {
    await options.commit({
      ...malformedCompactionShape(),
      ...this.#override,
      threadId: options.thread.id,
    } as unknown as CanonicalItem);
  }
}

function malformedCompactionShape(): Record<string, unknown> {
  return {
    id: "malformed-compaction",
    threadId: "thread",
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "context_compaction",
    coveredThroughItemId: "missing-boundary",
    summary: "summary",
    retainedItemIds: [],
    providerProfileId: "recording",
    modelId: "recording-model",
    reasoningEffort: "medium",
    algorithmVersion: "zen.context-compaction.v1",
    tokenUsage: { inputTokens: 1, outputTokens: 1 },
  };
}

function cloneRequest(request: ModelRequest): ModelRequest {
  return {
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    messages: structuredClone(request.messages),
    tools: structuredClone(request.tools),
    signal: request.signal,
    ...(request.sessionId === undefined
      ? {}
      : { sessionId: request.sessionId }),
  };
}

function canonicalMetadata(): ThreadMetadataItem {
  return {
    id: "metadata",
    threadId: "thread",
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "thread_metadata",
    cwd: "/workspace",
    providerProfileId: "recording",
    modelId: "recording-model",
    reasoningEffort: "medium",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  };
}

function canonicalIncompleteHistory(): CanonicalItem[] {
  return [
    canonicalMetadata(),
    {
      id: "started",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-01-01T00:00:00.001Z",
      type: "turn_started",
      selection: {
        providerProfileId: "recording",
        modelId: "recording-model",
        reasoningEffort: "medium",
      },
    },
    {
      id: "user",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-01-01T00:00:00.002Z",
      type: "user_message",
      content: [{ type: "text", text: "unfinished" }],
    },
  ];
}

function canonicalToolHistory(): CanonicalItem[] {
  return [
    canonicalMetadata(),
    {
      id: "started",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-01-01T00:00:00.001Z",
      type: "turn_started",
      selection: {
        providerProfileId: "recording",
        modelId: "recording-model",
        reasoningEffort: "medium",
      },
    },
    {
      id: "user",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-01-01T00:00:00.002Z",
      type: "user_message",
      content: [{ type: "text", text: "use tools" }],
    },
    {
      id: "response",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-01-01T00:00:00.003Z",
      type: "agent_message",
      text: "calling both",
    },
    {
      id: "call-1",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-01-01T00:00:00.004Z",
      type: "tool_call",
      callId: "one",
      modelResponseId: "response",
      name: "shell",
      arguments: { command: "printf one" },
    },
    {
      id: "call-2",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-01-01T00:00:00.005Z",
      type: "tool_call",
      callId: "two",
      modelResponseId: "response",
      name: "shell",
      arguments: { command: "printf two" },
    },
    {
      id: "result-1",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-01-01T00:00:00.006Z",
      type: "tool_result",
      callId: "one",
      output: "one",
      exitCode: 0,
    },
    {
      id: "result-2",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-01-01T00:00:00.007Z",
      type: "tool_result",
      callId: "two",
      output: "two",
      exitCode: 0,
    },
    {
      id: "final",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-01-01T00:00:00.008Z",
      type: "agent_message",
      text: "done",
    },
    {
      id: "completed",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-01-01T00:00:00.009Z",
      type: "turn_completed",
      status: "completed",
    },
  ];
}

function contextCompactionItem(
  items: readonly CanonicalItem[],
): ContextCompactionItem {
  return {
    id: "compaction",
    threadId: "thread",
    createdAt: "2026-01-01T00:00:01.000Z",
    type: "context_compaction",
    coveredThroughItemId: "completed",
    summary: "summary",
    retainedItemIds: items
      .filter((item) => item.turnId === "turn")
      .map((item) => item.id),
    providerProfileId: "recording",
    modelId: "recording-model",
    reasoningEffort: "medium",
    algorithmVersion: "zen.context-compaction.v1",
    tokenUsage: { inputTokens: 1, outputTokens: 1 },
  };
}

function echoModel(): ModelAdapter {
  return {
    provider: "recording",
    async *stream(): AsyncIterable<ModelEvent> {
      yield { type: "text_delta", delta: "answer" };
    },
  };
}

function summaryModel(onSummary?: () => void): ModelAdapter {
  let summaries = 0;
  return {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        summaries += 1;
        onSummary?.();
        yield { type: "text_delta", delta: `summary-${String(summaries)}` };
        return;
      }
      yield { type: "text_delta", delta: "answer" };
    },
  };
}

function isSummaryRequest(request: Pick<ModelRequest, "messages">): boolean {
  const latest = request.messages.at(-1);
  return (
    latest?.role === "user" &&
    "text" in latest &&
    latest.text.includes(SUMMARY_MARKER)
  );
}

async function expectAppServerCode(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert(error instanceof AppServerError);
    assert.equal(error.code, code);
    return true;
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
