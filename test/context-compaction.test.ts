import assert from "node:assert/strict";
import test from "node:test";

import { AppServerError, ZenAppServer } from "../src/app-server.js";
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
import { AgentRuntime } from "../src/runtime.js";
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
}): ZenAppServer {
  const modelCatalog =
    options.modelCatalog ??
    new StaticModelCatalog([{ id: "recording-model", isDefault: true }]);
  return new ZenAppServer({
    journal: options.journal,
    runtime: new AgentRuntime({ tools: new ShellToolExecutor() }),
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
