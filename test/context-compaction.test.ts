import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";

import {
  AppServerError,
  ZenAppServer,
  type AppServerEvent,
} from "../src/app-server.js";
import {
  boundedCompactionBoundary,
  normalizeContextCompactionConfig,
  planCompactionRetention,
  validateContextCompactionItem,
  type ContextCompactionConfig,
} from "../src/context-compaction.js";
import type {
  CanonicalItem,
  ContextCompactionItem,
  ProviderGeneratedContextCompactionItem,
  ThreadMetadataItem,
} from "../src/item.js";
import {
  InMemoryThreadJournal,
  ThreadJournalAppendOutcomeUnknownError,
  type ThreadJournal,
} from "../src/journal.js";
import { StaticModelCatalog, type ModelCatalog } from "../src/model-catalog.js";
import { estimateModelMessageInputTokens } from "../src/model-usage.js";
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
import { ShellToolRuntime, ToolEnvironment } from "../src/tool.js";

const SUMMARY_MARKER = "ZEN_CONTEXT_COMPACTION_V1";

test("R1 regression: second reset selects admitted late steer by full-journal Turn identity", () => {
  const base = {
    threadId: "private",
    turnId: "active",
    createdAt: "2026-01-01T00:00:00Z",
  };
  const items = [
    { ...base, id: "start", type: "turn_started" },
    { ...base, id: "first", type: "user_message", text: "old covered input" },
    {
      ...base,
      id: "first-reset",
      type: "context_compaction",
      provenance: "agentic",
      coveredThroughItemId: "first",
      sourceModelResponseId: "first-response",
    },
    { ...base, id: "late", type: "user_message", text: "admitted steer" },
  ] as CanonicalItem[];
  const planned = planCompactionRetention(
    items,
    {
      item: items[3]!,
      index: 3,
      retainedItemIds: [],
    },
    {
      retention: normalizeContextCompactionConfig({
        retention: { mode: "selected-items", recentTurnCount: 1 },
      }).retention,
      retainedTokenBudget: 100,
      estimateRetainedTokens: (retained) => retained.length,
    },
  );
  assert.deepEqual(planned.retainedItemIds, ["late"]);
});

test("R1 regression: explicit ranges reject internal queued and hidden content without disclosure", () => {
  const base = {
    threadId: "private",
    turnId: "turn",
    createdAt: "2026-01-01T00:00:00Z",
  };
  const first = {
    ...base,
    id: "first",
    type: "user_message",
    text: "first",
  } as CanonicalItem;
  const last = {
    ...base,
    id: "last",
    type: "user_message",
    text: "last",
  } as CanonicalItem;
  const hidden = {
    ...base,
    id: "hidden",
    type: "reasoning",
    reasoningContent: "PRIVATE_NOT_FOR_OUTPUT",
    contentVisibility: "opaque",
  } as CanonicalItem;
  const queued = {
    ...base,
    id: "queued",
    type: "user_message_queued",
    clientId: "queued-client",
    input: [{ type: "text", text: "UNDELIVERED_NOT_FOR_OUTPUT" }],
  } as CanonicalItem;
  const range = normalizeContextCompactionConfig({
    retention: {
      mode: "selected-items",
      itemRanges: [{ fromItemId: "first", toItemId: "last" }],
    },
  }).retention;
  for (const unsafe of [hidden, queued]) {
    const items = [first, unsafe, last];
    assert.throws(
      () =>
        planCompactionRetention(
          items,
          {
            item: last,
            index: 2,
            retainedItemIds: [],
          },
          {
            retention: range,
            retainedTokenBudget: 100,
            estimateRetainedTokens: (retained) => retained.length,
          },
        ),
      (error: unknown) =>
        error instanceof Error &&
        /range/u.test(error.message) &&
        !/PRIVATE_NOT_FOR_OUTPUT|UNDELIVERED_NOT_FOR_OUTPUT/u.test(
          error.message,
        ),
    );
  }
});

test("R1 regression: strict ranges allow structural anchors and reject invalid selections", () => {
  const base = {
    threadId: "private",
    turnId: "turn",
    createdAt: "2026-01-01T00:00:00Z",
  };
  const first = {
    ...base,
    id: "first",
    type: "user_message",
    text: "first",
  } as CanonicalItem;
  const last = {
    ...base,
    id: "last",
    type: "user_message",
    text: "last",
  } as CanonicalItem;
  const structural = {
    ...base,
    id: "usage",
    type: "model_usage",
  } as CanonicalItem;
  const safe = [first, structural, last];
  const range = normalizeContextCompactionConfig({
    retention: {
      mode: "selected-items",
      itemRanges: [{ fromItemId: "first", toItemId: "last" }],
    },
  }).retention;
  const plan = (
    items: CanonicalItem[],
    retention: typeof range,
    budget = 100,
  ) =>
    planCompactionRetention(
      items,
      {
        item: items.at(-1)!,
        index: items.length - 1,
        retainedItemIds: [],
      },
      {
        retention,
        retainedTokenBudget: budget,
        estimateRetainedTokens: (retained) => retained.length,
      },
    );
  assert.deepEqual(plan(safe, range).retainedItemIds, ["first", "last"]);
  const repeated = normalizeContextCompactionConfig({
    retention: {
      mode: "selected-items",
      itemRanges: [
        { fromItemId: "first", toItemId: "last" },
        { fromItemId: "first", toItemId: "last" },
      ],
    },
  }).retention;
  assert.deepEqual(plan(safe, repeated).retainedItemIds, ["first", "last"]);
  const other = {
    ...last,
    id: "other-thread",
    threadId: "elsewhere",
  } as CanonicalItem;
  for (const invalid of [
    { fromItemId: "last", toItemId: "first" },
    { fromItemId: "missing", toItemId: "last" },
    { fromItemId: "first", toItemId: "other-thread" },
  ]) {
    assert.throws(
      () =>
        plan(
          [...safe, other],
          normalizeContextCompactionConfig({
            retention: {
              mode: "selected-items",
              itemRanges: [invalid],
            },
          }).retention,
        ),
      /range/u,
    );
  }
  for (const type of ["reasoning", "user_message_queued"] as const) {
    const unsafe = { ...base, id: "unsafe", type } as CanonicalItem;
    assert.throws(
      () =>
        plan(
          [first, unsafe, last],
          normalizeContextCompactionConfig({
            retention: {
              mode: "selected-items",
              itemIds: ["unsafe"],
            },
          }).retention,
        ),
      /not eligible/u,
    );
    assert.throws(
      () =>
        plan(
          [unsafe, first, last],
          normalizeContextCompactionConfig({
            retention: {
              mode: "selected-items",
              itemRanges: [{ fromItemId: "unsafe", toItemId: "last" }],
            },
          }).retention,
        ),
      /range/u,
    );
  }
  assert.throws(() => plan(safe, range, 1), /bounded projection/u);
});

test("R1 regression: a source trace excluded by the previous reset cannot disappear inside an explicit range", () => {
  const base = {
    threadId: "private",
    turnId: "same-turn",
    createdAt: "2026-01-01T00:00:00Z",
  };
  const covered = [
    { ...base, id: "first", type: "user_message", text: "covered" },
    {
      ...base,
      id: "first-reset",
      type: "context_compaction",
      provenance: "agentic",
      coveredThroughItemId: "first",
      sourceModelResponseId: "source-response",
    },
    { ...base, id: "left", type: "user_message", text: "left" },
    {
      ...base,
      id: "excluded",
      type: "tool_call",
      callId: "reset-call",
      name: "compact_context",
      modelResponseId: "source-response",
      arguments: {},
    },
    { ...base, id: "right", type: "user_message", text: "right" },
  ] as CanonicalItem[];
  assert.throws(
    () =>
      planCompactionRetention(
        covered,
        {
          item: covered.at(-1)!,
          index: covered.length - 1,
          retainedItemIds: [],
        },
        {
          retention: normalizeContextCompactionConfig({
            retention: {
              mode: "selected-items",
              itemRanges: [{ fromItemId: "left", toItemId: "right" }],
            },
          }).retention,
          retainedTokenBudget: 100,
          estimateRetainedTokens: (retained) => retained.length,
        },
      ),
    /range/u,
  );
});

test("R1 Host: forbidden hidden range cannot append a fake successful reset", async () => {
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        yield { type: "text_delta", delta: "summary not a reset" };
        return;
      }
      yield {
        type: "reasoning",
        reasoningContent: "PRIVATE_NOT_FOR_OUTPUT",
        contentVisibility: "opaque",
      };
      yield { type: "text_delta", delta: "final response" };
    },
  };
  const journal = new InMemoryThreadJournal();
  const server = createServer({ journal, model });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "public input")
  ).done;
  const before = await journal.read(thread.id);
  const start = before.find((item) => item.type === "user_message");
  const end = before.find((item) => item.type === "agent_message");
  assert(start?.type === "user_message" && end?.type === "agent_message");
  await assert.rejects(
    server.compactThread(thread.id, {
      retention: {
        mode: "selected-items",
        itemRanges: [{ fromItemId: start.id, toItemId: end.id }],
      },
    }),
    (error: unknown) =>
      error instanceof AppServerError &&
      error.code === "compaction_budget_exceeded" &&
      !error.message.includes("PRIVATE_NOT_FOR_OUTPUT"),
  );
  assert.deepEqual(await journal.read(thread.id), before);
  assert.equal(
    (await server.readThread(thread.id)).items.some(
      (item) => item.type === "context_compaction",
    ),
    false,
  );
});

test("agentic compaction replaces the active context and replays identically", async () => {
  const requests: ModelRequest[] = [];
  let normalSamples = 0;
  let generatedSummaries = 0;
  const source = "  exact agent-owned continuation\nwith paths /tmp/a kept  ";
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(cloneRequest(request));
      if (isSummaryRequest(request)) {
        generatedSummaries += 1;
        yield { type: "text_delta", delta: "unexpected generated summary" };
        return;
      }
      normalSamples += 1;
      if (normalSamples === 1) {
        yield {
          type: "reasoning",
          reasoningContent: "discarded working reasoning",
          summary: "discarded reasoning summary",
          contentVisibility: "public",
        };
        yield { type: "text_delta", delta: "discarded pre-tool text" };
        yield {
          type: "tool_call",
          callId: "compact-call",
          name: "compact_context",
          arguments: { text: source, includeOriginalReference: false },
        };
        yield { type: "usage", inputTokens: 900, outputTokens: 20 };
        return;
      }
      yield { type: "text_delta", delta: "continued in the same Turn" };
      yield { type: "usage", inputTokens: 30, outputTokens: 8 };
    },
  };
  const journal = new InMemoryThreadJournal();
  const server = createServer({
    journal,
    model,
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow: 1_000 },
    ]),
    contextCompaction: { agenticEnabled: true },
  });
  const thread = await server.startThread();

  await (
    await server.startTurn(thread.id, "old context that must be replaced")
  ).done;

  assert.equal(normalSamples, 2);
  assert.equal(generatedSummaries, 0);
  assert(requests[0]?.tools.some((tool) => tool.name === "compact_context"));
  assert.deepEqual(requests[1]?.messages, [
    { role: "user", text: `[Zen compacted context]\n${source}` },
  ]);
  const snapshot = await server.readThread(thread.id);
  const compaction = snapshot.items.find(
    (item) =>
      item.type === "context_compaction" && item.provenance === "agentic",
  );
  assert(compaction !== undefined);
  assert.equal(compaction.initiator, "agent");
  assert.equal(compaction.summary, source);
  assert.equal(compaction.turnId, snapshot.turns[0]?.id);
  assert.equal(compaction.callId, "compact-call");
  assert.deepEqual(compaction.retainedItemIds, []);
  assert.equal("tokenUsage" in compaction, false);
  assert.equal("providerProfileId" in compaction, false);
  assert.equal(
    snapshot.items.filter(
      (item) => item.type === "tool_call" && item.callId === "compact-call",
    ).length,
    1,
  );
  assert.equal(
    snapshot.items.filter(
      (item) => item.type === "tool_result" && item.callId === "compact-call",
    ).length,
    1,
  );
  assert(
    snapshot.items.some(
      (item) =>
        item.type === "agent_message" &&
        item.text === "discarded pre-tool text",
    ),
  );
  assert.deepEqual(compileModelMessages(snapshot.items), [
    { role: "user", text: `[Zen compacted context]\n${source}` },
    { role: "assistant", text: "continued in the same Turn" },
  ]);

  const restarted = createServer({ journal, model });
  assert.deepEqual(
    compileModelMessages((await restarted.readThread(thread.id)).items),
    compileModelMessages(snapshot.items),
  );
});

test("agentic tool shares canonical retention planning and defaults to bounded original reference", async () => {
  const requests: ModelRequest[] = [];
  let samples = 0;
  let firstUserId = "";
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(cloneRequest(request));
      samples += 1;
      if (samples === 2) {
        yield {
          type: "tool_call",
          callId: "structured-reset",
          name: "compact_context",
          arguments: {
            text: "handwritten summary",
            retention: {
              itemIds: [firstUserId, firstUserId],
              preserveUserMessages: true,
              recentTurnCount: 1,
            },
          },
        };
        return;
      }
      yield { type: "text_delta", delta: "answer" };
    },
  };
  const journal = new InMemoryThreadJournal();
  const server = createServer({
    journal,
    model,
    contextCompaction: { agenticEnabled: true },
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "first user input")
  ).done;
  const prior = await server.readThread(thread.id);
  firstUserId = prior.items.find((item) => item.type === "user_message")!.id;
  await (
    await server.startTurn(thread.id, "second user input")
  ).done;
  const snapshot = await server.readThread(thread.id);
  const compaction = snapshot.items.find(
    (item) =>
      item.type === "context_compaction" && item.provenance === "agentic",
  );
  assert(compaction?.type === "context_compaction");
  assert.equal(compaction.includeOriginalReference, true);
  assert.deepEqual(
    compaction.retainedItemIds.filter((id) => id === firstUserId),
    [firstUserId],
  );
  assert(
    requests[2]?.messages.some(
      (message) =>
        message.role === "user" &&
        "text" in message &&
        message.text.includes(
          `zen-thread://${thread.id}/items?through=${compaction.coveredThroughItemId}`,
        ),
    ),
  );
  assert(
    requests[2]?.messages.some(
      (message) =>
        message.role === "user" &&
        "content" in message &&
        JSON.stringify(message.content).includes("first user input"),
    ),
  );
  assert.deepEqual(
    compileModelMessages(
      (await createServer({ journal, model }).readThread(thread.id)).items,
    ),
    compileModelMessages(snapshot.items),
  );
  assert.equal(requests.some(isSummaryRequest), false);
});

test("agentic compaction preserves user steering unseen by its model sample", async () => {
  const firstSampleStarted = deferred<void>();
  const releaseFirstSample = deferred<void>();
  const requests: ModelRequest[] = [];
  let samples = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(cloneRequest(request));
      samples += 1;
      if (samples === 1) {
        firstSampleStarted.resolve();
        await releaseFirstSample.promise;
        yield {
          type: "tool_call",
          callId: "steered-compact",
          name: "compact_context",
          arguments: { text: "continuation", includeOriginalReference: false },
        };
        return;
      }
      yield { type: "text_delta", delta: "done" };
    },
  };
  const server = createServer({
    journal: new InMemoryThreadJournal(),
    model,
    contextCompaction: { agenticEnabled: true },
  });
  const thread = await server.startThread();
  const handle = await server.startTurn(thread.id, "initial request");
  await firstSampleStarted.promise;
  await server.steerTurn(thread.id, handle.id, "new instruction", {
    clientId: "agentic-steer",
  });
  releaseFirstSample.resolve();
  await handle.done;

  assert.deepEqual(requests[1]?.messages, [
    { role: "user", text: "[Zen compacted context]\ncontinuation" },
    {
      role: "user",
      content: [{ type: "text", text: "new instruction" }],
    },
  ]);
});

test("R1 Runtime/Host: second reset retains pre-sample steer, not after-sample input", async () => {
  const firstSampling = deferred<void>();
  const releaseFirst = deferred<void>();
  const secondSampling = deferred<void>();
  const releaseSecond = deferred<void>();
  const requests: ModelRequest[] = [];
  let samples = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(cloneRequest(request));
      samples += 1;
      if (samples === 1) {
        firstSampling.resolve();
        await releaseFirst.promise;
        yield {
          type: "tool_call",
          callId: "first-reset",
          name: "compact_context",
          arguments: { text: "first summary", includeOriginalReference: false },
        };
      } else if (samples === 2) {
        secondSampling.resolve();
        await releaseSecond.promise;
        yield {
          type: "tool_call",
          callId: "second-reset",
          name: "compact_context",
          arguments: {
            text: "second summary",
            includeOriginalReference: false,
            retention: { recentTurnCount: 1 },
          },
        };
      } else {
        yield { type: "text_delta", delta: "final reply" };
      }
    },
  };
  const journal = new InMemoryThreadJournal();
  const server = createServer({
    journal,
    model,
    contextCompaction: { agenticEnabled: true },
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "covered before first reset");
  await firstSampling.promise;
  await server.steerTurn(thread.id, turn.id, "admitted before second sample", {
    clientId: "late-before",
  });
  releaseFirst.resolve();
  await secondSampling.promise;
  await server.steerTurn(thread.id, turn.id, "arrived after second sample", {
    clientId: "late-after",
  });
  releaseSecond.resolve();
  await turn.done;

  const snapshot = await server.readThread(thread.id);
  const resets = snapshot.items.filter(
    (item) =>
      item.type === "context_compaction" && item.provenance === "agentic",
  );
  assert.equal(resets.length, 2);
  const before = snapshot.items.find(
    (item) => item.type === "user_message" && item.clientId === "late-before",
  );
  const after = snapshot.items.find(
    (item) => item.type === "user_message" && item.clientId === "late-after",
  );
  const initial = snapshot.items.find(
    (item) =>
      item.type === "user_message" &&
      JSON.stringify(item.content).includes("covered before first reset"),
  );
  assert(before?.type === "user_message");
  assert(after?.type === "user_message");
  assert(initial?.type === "user_message");
  assert.deepEqual(resets[1]?.retainedItemIds, [before.id]);
  assert.equal(resets[1]?.retainedItemIds.includes(initial.id), false);
  assert.equal(resets[1]?.retainedItemIds.includes(after.id), false);
  assert.equal(requests.some(isSummaryRequest), false);
  const text = JSON.stringify(requests[2]?.messages);
  assert(text.includes("admitted before second sample"));
  assert(text.includes("arrived after second sample"));
  assert(!text.includes("covered before first reset"));
  assert.deepEqual(
    compileModelMessages(
      (await createServer({ journal, model }).readThread(thread.id)).items,
    ),
    compileModelMessages(snapshot.items),
  );
  assert.equal((await journal.read(thread.id)).length, snapshot.items.length);
});

test("R1 Runtime/Host: hard recent-Turn retention over budget fails without losing admitted input", async () => {
  const beforeSecondSample = deferred<void>();
  const releaseSecondSample = deferred<void>();
  let samples = 0;
  let summaries = 0;
  class PauseSecondSampleRuntime extends AgentRuntime {
    override async runTurn(options: RunTurnOptions): Promise<void> {
      let preparations = 0;
      await super.runTurn({
        ...options,
        prepareModelSample: async (responseId) => {
          preparations += 1;
          if (preparations === 2) {
            beforeSecondSample.resolve();
            await releaseSecondSample.promise;
          }
          return await options.prepareModelSample(responseId);
        },
      });
    }
  }
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        summaries += 1;
        yield { type: "text_delta", delta: "unexpected generated summary" };
        return;
      }
      samples += 1;
      if (samples === 1) {
        yield {
          type: "tool_call",
          callId: "first-reset",
          name: "compact_context",
          arguments: { text: "short reset", includeOriginalReference: false },
        };
      } else if (samples === 2) {
        yield {
          type: "tool_call",
          callId: "overbudget-reset",
          name: "compact_context",
          arguments: {
            text: "second reset",
            includeOriginalReference: false,
            retention: { recentTurnCount: 1 },
          },
        };
      } else {
        yield { type: "text_delta", delta: "continuing after failed reset" };
      }
    },
  };
  const journal = new InMemoryThreadJournal();
  const runtime = new PauseSecondSampleRuntime({
    toolEnvironment: new ToolEnvironment({
      runtimes: [new ShellToolRuntime()],
    }),
  });
  const server = createServer({
    journal,
    model,
    runtime,
    contextCompaction: { agenticEnabled: true },
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow: 400 },
    ]),
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "small original");
  await beforeSecondSample.promise;
  const longInput = "PINNED_INPUT".repeat(250);
  await server.steerTurn(thread.id, turn.id, longInput, {
    clientId: "large-admitted",
  });
  releaseSecondSample.resolve();
  await turn.done;
  const items = (await server.readThread(thread.id)).items;
  assert.equal(
    items.filter((item) => item.type === "context_compaction").length,
    1,
  );
  assert.equal(
    items.some(
      (item) =>
        item.type === "user_message" && item.clientId === "large-admitted",
    ),
    true,
  );
  const failed = items.find(
    (item) => item.type === "tool_result" && item.callId === "overbudget-reset",
  );
  assert(failed?.type === "tool_result");
  assert.equal(failed.exitCode, 1);
  assert.match(
    failed.output,
    /compaction failed|bounded projection|context window/u,
  );
  assert.equal(summaries, 0);
  assert.deepEqual(await journal.read(thread.id), items);
});

test("R1 Host: generated compaction counts Turns across prior agentic reset without restoring old trace", async () => {
  let samples = 0;
  let summaryCalls = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        summaryCalls += 1;
        yield { type: "text_delta", delta: "generated summary" };
        return;
      }
      samples += 1;
      if (samples === 1) {
        yield {
          type: "tool_call",
          callId: "source-reset",
          name: "compact_context",
          arguments: {
            text: "agent continuation",
            includeOriginalReference: false,
          },
        };
      } else {
        yield {
          type: "text_delta",
          delta: samples === 2 ? "first final after reset" : "second final",
        };
      }
    },
  };
  const journal = new InMemoryThreadJournal();
  const server = createServer({
    journal,
    model,
    contextCompaction: { agenticEnabled: true },
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "first covered user")
  ).done;
  await (
    await server.startTurn(thread.id, "second user")
  ).done;
  const before = await server.readThread(thread.id);
  const firstFinal = before.items.find(
    (item) =>
      item.type === "agent_message" && item.text === "first final after reset",
  );
  const secondFinal = before.items.find(
    (item) => item.type === "agent_message" && item.text === "second final",
  );
  const secondUser = before.items.find(
    (item) =>
      item.type === "user_message" &&
      JSON.stringify(item.content).includes("second user"),
  );
  assert(
    firstFinal?.type === "agent_message" &&
      secondFinal?.type === "agent_message" &&
      secondUser?.type === "user_message",
  );
  await server.compactThread(thread.id, {
    includeOriginalReference: false,
    retention: { mode: "selected-items", recentTurnCount: 2 },
  });
  const snapshot = await server.readThread(thread.id);
  const generated = snapshot.items.at(-1);
  assert(
    generated?.type === "context_compaction" &&
      generated.provenance !== "agentic",
  );
  assert.deepEqual(generated.retainedItemIds, [
    firstFinal.id,
    secondUser.id,
    secondFinal.id,
  ]);
  assert.equal(summaryCalls, 1);
  const projection = JSON.stringify(compileModelMessages(snapshot.items));
  assert(!projection.includes("first covered user"));
  assert(!projection.includes("source-reset"));
  assert.deepEqual(
    compileModelMessages(
      (await createServer({ journal, model }).readThread(thread.id)).items,
    ),
    compileModelMessages(snapshot.items),
  );
});

test("agentic compaction accepts a sample following an active settings change", async () => {
  const requests: ModelRequest[] = [];
  let samples = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(cloneRequest(request));
      samples += 1;
      if (samples === 1) {
        yield {
          type: "tool_call",
          callId: "read-first",
          name: "fixture_read",
          arguments: {},
        };
      } else if (samples === 2) {
        yield {
          type: "tool_call",
          callId: "compact-after-settings",
          name: "compact_context",
          arguments: {
            text: "resume after settings change",
            includeOriginalReference: false,
          },
        };
      } else {
        yield { type: "text_delta", delta: "done" };
      }
    },
  };
  let server: ZenAppServer;
  let lastItemBeforeSample: CanonicalItem["type"] | undefined;
  class SettingsBeforeSampleRuntime extends AgentRuntime {
    override async runTurn(options: RunTurnOptions): Promise<void> {
      let preparations = 0;
      await super.runTurn({
        ...options,
        prepareModelSample: async (responseId) => {
          preparations += 1;
          if (preparations === 2) {
            const updated = await server.updateThreadSettings(
              options.thread.id,
              { model: "other-model" },
            );
            lastItemBeforeSample = updated.items.at(-1)?.type;
          }
          return await options.prepareModelSample(responseId);
        },
      });
    }
  }
  const journal = new InMemoryThreadJournal();
  const modelCatalog = new StaticModelCatalog([
    { id: "recording-model", isDefault: true, contextWindow: 32_768 },
    { id: "other-model", contextWindow: 32_768 },
  ]);
  server = createServer({
    journal,
    model,
    modelCatalog,
    contextCompaction: { agenticEnabled: true },
    runtime: new SettingsBeforeSampleRuntime({
      toolEnvironment: new ToolEnvironment({
        runtimes: [
          {
            name: "fixture_read",
            executionMode: "parallel_safe",
            specification: {
              name: "fixture_read",
              description: "Read fixture",
              inputSchema: { type: "object", properties: {} },
            },
            async execute() {
              return { output: "working state", exitCode: 0 };
            },
          },
        ],
      }),
    }),
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "old working request")
  ).done;
  assert.equal(lastItemBeforeSample, "thread_configuration_changed");
  const snapshot = await server.readThread(thread.id);
  const result = snapshot.items.find(
    (item) =>
      item.type === "tool_result" && item.callId === "compact-after-settings",
  );
  assert(result?.type === "tool_result");
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(requests[2]?.messages, [
    {
      role: "user",
      text: "[Zen compacted context]\nresume after settings change",
    },
  ]);
  assert.equal(snapshot.modelId, "other-model");
  assert(requests.every((request) => request.model === "recording-model"));
  const restarted = createServer({ journal, model, modelCatalog });
  assert.deepEqual(
    compileModelMessages((await restarted.readThread(thread.id)).items),
    compileModelMessages(snapshot.items),
  );
});

test("repeated agentic resets supersede deterministically in one active Turn", async () => {
  const requests: ModelRequest[] = [];
  let samples = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(cloneRequest(request));
      samples += 1;
      if (samples <= 2) {
        yield {
          type: "tool_call",
          callId: `compact-${String(samples)}`,
          name: "compact_context",
          arguments: {
            text: `continuation-${String(samples)}`,
            includeOriginalReference: false,
          },
        };
        return;
      }
      yield { type: "text_delta", delta: "final" };
    },
  };
  const journal = new InMemoryThreadJournal();
  const server = createServer({
    journal,
    model,
    contextCompaction: { agenticEnabled: true },
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "replace twice")
  ).done;

  assert.deepEqual(requests[1]?.messages, [
    { role: "user", text: "[Zen compacted context]\ncontinuation-1" },
  ]);
  assert.deepEqual(requests[2]?.messages, [
    { role: "user", text: "[Zen compacted context]\ncontinuation-2" },
  ]);
  const snapshot = await server.readThread(thread.id);
  assert.equal(
    snapshot.items.filter(
      (item) =>
        item.type === "context_compaction" && item.provenance === "agentic",
    ).length,
    2,
  );
  const restarted = createServer({ journal, model });
  assert.deepEqual(
    compileModelMessages((await restarted.readThread(thread.id)).items),
    [
      { role: "user", text: "[Zen compacted context]\ncontinuation-2" },
      { role: "assistant", text: "final" },
    ],
  );
});

test("later generated compaction cannot retain an agentic reset source trace", async () => {
  let samples = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        yield { type: "text_delta", delta: "generated after reset" };
        return;
      }
      samples += 1;
      if (samples === 1) {
        yield { type: "text_delta", delta: "source response text" };
        yield {
          type: "tool_call",
          callId: "reset-source",
          name: "compact_context",
          arguments: {
            text: "agent continuation",
            includeOriginalReference: false,
          },
        };
        return;
      }
      yield { type: "text_delta", delta: "post-reset final" };
    },
  };
  const journal = new InMemoryThreadJournal();
  const server = createServer({
    journal,
    model,
    contextCompaction: { agenticEnabled: true },
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "old input")
  ).done;
  await server.compactThread(thread.id, { includeOriginalReference: false });

  const snapshot = await server.readThread(thread.id);
  const latest = snapshot.items.at(-1);
  assert(latest?.type === "context_compaction");
  assert.equal(latest.provenance, "provider_generated");
  const sourceIds = new Set(
    snapshot.items
      .filter(
        (item) =>
          (item.type === "agent_message" &&
            item.text === "source response text") ||
          ((item.type === "tool_call" || item.type === "tool_result") &&
            item.callId === "reset-source"),
      )
      .map((item) => item.id),
  );
  assert.equal(
    latest.retainedItemIds.some((itemId) => sourceIds.has(itemId)),
    false,
  );
  const projected = compileModelMessages(snapshot.items);
  assert.equal(
    projected.some(
      (message) =>
        (message.role === "assistant" &&
          "text" in message &&
          message.text === "source response text") ||
        message.role === "tool" ||
        (message.role === "assistant" && "toolCalls" in message),
    ),
    false,
  );
});

test("agentic compaction stays off by default and mixed calls fail locally", async () => {
  for (const scenario of ["off", "mixed"] as const) {
    await test(`agentic ${scenario}`, async () => {
      const requests: ModelRequest[] = [];
      let samples = 0;
      const model: ModelAdapter = {
        provider: "recording",
        async *stream(request): AsyncIterable<ModelEvent> {
          requests.push(cloneRequest(request));
          samples += 1;
          if (samples === 1) {
            yield {
              type: "tool_call",
              callId: "rejected-compact",
              name: "compact_context",
              arguments: {
                text: "must not replace",
                includeOriginalReference: false,
              },
            };
            if (scenario === "mixed") {
              yield {
                type: "tool_call",
                callId: "ordinary-call",
                name: "shell",
                arguments: { command: "printf ordinary-result" },
              };
            }
            return;
          }
          yield { type: "text_delta", delta: "done" };
        },
      };
      const server = createServer({
        journal: new InMemoryThreadJournal(),
        model,
        ...(scenario === "mixed"
          ? { contextCompaction: { agenticEnabled: true } }
          : {}),
      });
      const thread = await server.startThread();
      await (
        await server.startTurn(thread.id, "keep the original context")
      ).done;
      const snapshot = await server.readThread(thread.id);

      assert.equal(
        requests[0]?.tools.some((tool) => tool.name === "compact_context"),
        scenario === "mixed",
      );
      assert.equal(
        snapshot.items.some((item) => item.type === "context_compaction"),
        false,
      );
      const rejected = snapshot.items.find(
        (item) =>
          item.type === "tool_result" && item.callId === "rejected-compact",
      );
      assert(rejected?.type === "tool_result");
      assert.notEqual(rejected.exitCode, 0);
      if (scenario === "mixed") {
        const ordinary = snapshot.items.find(
          (item) =>
            item.type === "tool_result" && item.callId === "ordinary-call",
        );
        assert(ordinary?.type === "tool_result");
        assert.equal(ordinary.exitCode, 0);
        assert.equal(ordinary.output, "ordinary-result");
      }
      assert(
        requests[1]?.messages.some(
          (message) =>
            message.role === "user" &&
            "content" in message &&
            message.content[0]?.type === "text" &&
            message.content[0].text === "keep the original context",
        ),
      );
    });
  }
});

test("oversized agentic text fails without changing the effective projection", async () => {
  const requests: ModelRequest[] = [];
  let samples = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(cloneRequest(request));
      samples += 1;
      if (samples === 1) {
        yield {
          type: "tool_call",
          callId: "oversized-compact",
          name: "compact_context",
          arguments: {
            text: "x".repeat(2_000),
            includeOriginalReference: false,
          },
        };
        return;
      }
      yield { type: "text_delta", delta: "done" };
    },
  };
  const server = createServer({
    journal: new InMemoryThreadJournal(),
    model,
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow: 100 },
    ]),
    contextCompaction: {
      agenticEnabled: true,
      triggerPercent: 80,
      targetPercent: 80,
    },
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "original survives")
  ).done;

  const snapshot = await server.readThread(thread.id);
  assert.equal(
    snapshot.items.some((item) => item.type === "context_compaction"),
    false,
  );
  assert(
    requests[1]?.messages.some(
      (message) =>
        message.role === "user" &&
        "content" in message &&
        message.content[0]?.type === "text" &&
        message.content[0].text === "original survives",
    ),
  );
});

test("agentic compaction abort and journal failure never admit another sample", async () => {
  await test("abort before compaction commit", async () => {
    const modelStarted = deferred<void>();
    const releaseModel = deferred<void>();
    let samples = 0;
    const model: ModelAdapter = {
      provider: "recording",
      async *stream(): AsyncIterable<ModelEvent> {
        samples += 1;
        modelStarted.resolve();
        await releaseModel.promise;
        yield {
          type: "tool_call",
          callId: "aborted-compact",
          name: "compact_context",
          arguments: {
            text: "must not become effective",
            includeOriginalReference: false,
          },
        };
      },
    };
    const server = createServer({
      journal: new InMemoryThreadJournal(),
      model,
      contextCompaction: { agenticEnabled: true },
    });
    const thread = await server.startThread();
    const handle = await server.startTurn(thread.id, "stop before reset");
    await modelStarted.promise;
    const interruption = server.interruptTurn(thread.id, handle.id);
    releaseModel.resolve();
    await interruption;
    await handle.done;

    const snapshot = await server.readThread(thread.id);
    assert.equal(samples, 1);
    assert.equal(
      snapshot.items.some((item) => item.type === "context_compaction"),
      false,
    );
    assert.equal(snapshot.turns.at(-1)?.status, "interrupted");
  });

  await test("journal append outcome failure", async () => {
    const backing = new InMemoryThreadJournal();
    const journal: ThreadJournal = {
      append: async (item) => {
        if (item.type === "context_compaction") {
          throw new Error("compaction journal unavailable");
        }
        await backing.append(item);
      },
      listThreadIds: async () => await backing.listThreadIds(),
      read: async (threadId) => await backing.read(threadId),
    };
    let samples = 0;
    const model: ModelAdapter = {
      provider: "recording",
      async *stream(): AsyncIterable<ModelEvent> {
        samples += 1;
        yield {
          type: "tool_call",
          callId: "failed-persist-compact",
          name: "compact_context",
          arguments: {
            text: "must not become effective",
            includeOriginalReference: false,
          },
        };
      },
    };
    const server = createServer({
      journal,
      model,
      contextCompaction: { agenticEnabled: true },
    });
    const thread = await server.startThread();
    const handle = await server.startTurn(thread.id, "surviving source");
    await assert.rejects(handle.done, /compaction journal unavailable/u);

    const persisted = await backing.read(thread.id);
    assert.equal(samples, 1);
    assert.equal(
      persisted.some((item) => item.type === "context_compaction"),
      false,
    );
    assert.equal(
      persisted.some(
        (item) =>
          item.type === "tool_result" &&
          item.callId === "failed-persist-compact",
      ),
      false,
    );
  });
});

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
  const events: AppServerEvent[] = [];
  const unsubscribe = server.subscribe((event) => events.push(event));
  const result = await server.compactThread(thread.id, {
    includeOriginalReference: false,
  });
  unsubscribe();
  const compacted = await server.readThread(thread.id);

  assert.deepEqual(
    compacted.items
      .slice(0, before.items.length)
      .map((item) => JSON.stringify(item)),
    beforeBytes,
  );
  const item = compacted.items.at(-1);
  assert(item?.type === "context_compaction");
  assert.equal(item.initiator, "human");
  assert.equal(result.compactionItemId, item.id);
  assert.equal(
    events.some(
      (event) =>
        event.type === "item_completed" &&
        event.item.id === result.compactionItemId,
    ),
    true,
  );
  assert.equal(item.coveredThroughItemId, before.items.at(-1)?.id);
  assert.equal(item.summary, "summary bytes\nkept verbatim");
  assert.equal(item.algorithmVersion, "zen.context-compaction.v3");
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

test("uses the configured context compaction prompt exactly", async () => {
  const prompt = "CUSTOM_COMPACTION_PROMPT\nKeep the active blockers first.";
  const requests: ModelRequest[] = [];
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(cloneRequest(request));
      const latest = request.messages.at(-1);
      if (
        latest?.role === "user" &&
        "text" in latest &&
        latest.text === prompt
      ) {
        yield { type: "text_delta", delta: "custom summary" };
        return;
      }
      yield { type: "text_delta", delta: "answer" };
    },
  };
  const server = createServer({
    journal: new InMemoryThreadJournal(),
    model,
    contextCompaction: { summaryInstruction: prompt },
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "one")
  ).done;

  await server.compactThread(thread.id, { includeOriginalReference: false });

  const summaryRequest = requests.at(-1);
  assert(summaryRequest !== undefined);
  assert.deepEqual(summaryRequest.tools, []);
  assert.deepEqual(summaryRequest.messages.at(-1), {
    role: "user",
    text: prompt,
  });
  assert.equal(
    (await server.readThread(thread.id)).items.at(-1)?.type,
    "context_compaction",
  );
});

test("rejects an empty configured context compaction prompt", () => {
  assert.throws(
    () =>
      normalizeContextCompactionConfig({
        summaryInstruction: " \n\t ",
      }),
    /summaryInstruction/u,
  );
});

test("normalizes legacy prompt-only and complete compaction policy defaults", () => {
  const defaults = normalizeContextCompactionConfig();
  assert.equal(defaults.includeOriginalReference, true);
  assert.equal(defaults.agenticEnabled, false);
  assert.deepEqual(defaults.retention, {
    mode: "budget",
    recentItemCount: 20,
    preserveUserMessages: false,
    finalMessages: "none",
    finalMessageCount: 10,
    recentTurnCount: 0,
    itemIds: [],
    itemRanges: [],
  });
  assert.equal(
    normalizeContextCompactionConfig({ summaryInstruction: "legacy prompt" })
      .summaryInstruction,
    "legacy prompt",
  );
});

test("rejects unknown and out-of-range compaction policy values", () => {
  for (const config of [
    { unexpected: true },
    { triggerPercent: 0 },
    { triggerPercent: 101 },
    { triggerPercent: 50, targetPercent: 51 },
    { retention: { mode: "unknown" } },
    { retention: { recentItemCount: 0 } },
    { retention: { preserveUserMessages: "yes" } },
    { retention: { finalMessages: "latest" } },
    { retention: { finalMessageCount: 1.5 } },
    { retention: { unexpected: true } },
  ] as unknown[]) {
    assert.throws(
      () => normalizeContextCompactionConfig(config as ContextCompactionConfig),
      /Context compaction/u,
    );
  }
});

test("selected retention keeps users and only finals from successful completed Turns", () => {
  const items = canonicalRetentionHistory();
  const boundary = boundedCompactionBoundary(items, {
    retainedTokenBudget: 10_000,
    estimateRetainedTokens: (retained) => retained.length,
    retention: {
      mode: "selected-items",
      recentItemCount: 20,
      preserveUserMessages: true,
      finalMessages: "recent",
      finalMessageCount: 2,
      recentTurnCount: 0,
      itemIds: [],
      itemRanges: [],
    },
  });
  assert.deepEqual(boundary?.retainedItemIds, [
    "user-1",
    "final-1",
    "user-2",
    "user-3",
    "final-3",
  ]);
});

test("explicit IDs, completed Turns, and user category compose in canonical order", () => {
  const items = canonicalRetentionHistory();
  const retained = boundedCompactionBoundary(items, {
    retainedTokenBudget: 10_000,
    estimateRetainedTokens: (selected) => selected.length,
    retention: normalizeContextCompactionConfig({
      retention: {
        mode: "selected-items",
        itemIds: ["final-1", "user-1", "final-1"],
        itemRanges: [{ fromItemId: "user-2", toItemId: "final-2" }],
        recentTurnCount: 1,
        preserveUserMessages: true,
      },
    }).retention,
  });
  assert.deepEqual(retained?.retainedItemIds, [
    "user-1",
    "final-1",
    "user-2",
    "final-2",
    "user-3",
    "final-3",
  ]);
  assert.throws(
    () =>
      boundedCompactionBoundary(items, {
        retainedTokenBudget: 10_000,
        estimateRetainedTokens: (selected) => selected.length,
        retention: normalizeContextCompactionConfig({
          retention: {
            mode: "selected-items",
            itemIds: ["unknown-or-queued"],
          },
        }).retention,
      }),
    /not eligible/u,
  );
  assert.throws(
    () =>
      boundedCompactionBoundary(items, {
        retainedTokenBudget: 10_000,
        estimateRetainedTokens: (selected) => selected.length,
        retention: normalizeContextCompactionConfig({
          retention: {
            mode: "selected-items",
            itemRanges: [{ fromItemId: "final-3", toItemId: "user-2" }],
          },
        }).retention,
      }),
    /Invalid compaction retention Item range/u,
  );
  assert.throws(
    () =>
      boundedCompactionBoundary(items, {
        retainedTokenBudget: 1,
        estimateRetainedTokens: (selected) => selected.length,
        retention: normalizeContextCompactionConfig({
          retention: {
            mode: "selected-items",
            itemIds: ["user-1", "final-1"],
          },
        }).retention,
      }),
    /bounded projection/u,
  );
});

test("recent retention counts model-context Items and expands complete tool closure", () => {
  const items = canonicalToolHistory();
  const boundary = boundedCompactionBoundary(items, {
    retainedTokenBudget: 10_000,
    estimateRetainedTokens: (retained) => retained.length,
    retention: {
      mode: "recent-items",
      recentItemCount: 3,
      preserveUserMessages: false,
      finalMessages: "none",
      finalMessageCount: 10,
      recentTurnCount: 0,
      itemIds: [],
      itemRanges: [],
    },
  });
  assert.deepEqual(boundary?.retainedItemIds, [
    "response",
    "call-1",
    "call-2",
    "result-1",
    "result-2",
    "final",
  ]);
});

test("recent retention supports exact 10 and 20 Item selections across Turns", () => {
  const items = canonicalPlainHistory(25);
  for (const count of [10, 20]) {
    const boundary = boundedCompactionBoundary(items, {
      retainedTokenBudget: 10_000,
      estimateRetainedTokens: (retained) => retained.length,
      retention: {
        mode: "recent-items",
        recentItemCount: count,
        preserveUserMessages: false,
        finalMessages: "none",
        finalMessageCount: 10,
        recentTurnCount: 0,
        itemIds: [],
        itemRanges: [],
      },
    });
    assert.equal(boundary?.retainedItemIds.length, count);
    assert.deepEqual(
      boundary?.retainedItemIds,
      items
        .filter(
          (item) =>
            item.type === "user_message" || item.type === "agent_message",
        )
        .slice(-count)
        .map((item) => item.id),
    );
  }
});

test("tool closure follows nested parent calls and response siblings", () => {
  const items = canonicalNestedToolHistory();
  const boundary = boundedCompactionBoundary(items, {
    retainedTokenBudget: 10_000,
    estimateRetainedTokens: (retained) => retained.length,
    retention: {
      mode: "recent-items",
      recentItemCount: 2,
      preserveUserMessages: false,
      finalMessages: "none",
      finalMessageCount: 10,
      recentTurnCount: 0,
      itemIds: [],
      itemRanges: [],
    },
  });
  assert.deepEqual(boundary?.retainedItemIds, [
    "response",
    "outer-call",
    "sibling-call",
    "child-call",
    "child-result",
    "outer-result",
    "sibling-result",
    "final",
  ]);
});

test("explicit retained selections fail instead of being trimmed over budget", () => {
  assert.throws(
    () =>
      boundedCompactionBoundary(canonicalRetentionHistory(), {
        retainedTokenBudget: 1,
        estimateRetainedTokens: (retained) => retained.length,
        retention: {
          mode: "selected-items",
          recentItemCount: 20,
          preserveUserMessages: true,
          finalMessages: "all",
          finalMessageCount: 10,
          recentTurnCount: 0,
          itemIds: [],
          itemRanges: [],
        },
      }),
    /bounded projection/u,
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
        yield { type: "usage", inputTokens: 205, outputTokens: 4 };
        return;
      }
      yield {
        type: "reasoning",
        reasoningContent: "reasoning bytes",
        summary: "reasoning bytes",
        contentVisibility: "public",
      };
      yield { type: "text_delta", delta: "answer bytes" };
      yield { type: "usage", inputTokens: 204, outputTokens: 5 };
    },
  };
  const journal = new InMemoryThreadJournal();
  const server = createServer({
    journal,
    model,
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow: 256 },
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
      { id: "recording-model", isDefault: true, contextWindow: 256 },
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

test("uses triggerPercent for admission and targetPercent for the compacted projection", async () => {
  let normalCalls = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        yield { type: "text_delta", delta: "s" };
        return;
      }
      normalCalls += 1;
      yield { type: "text_delta", delta: `answer-${String(normalCalls)}` };
      yield {
        type: "usage",
        inputTokens: normalCalls === 1 ? 59 : 60,
        outputTokens: 1,
      };
    },
  };
  const server = createServer({
    journal: new InMemoryThreadJournal(),
    model,
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow: 100 },
    ]),
    contextCompaction: { triggerPercent: 60, targetPercent: 40 },
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "one")
  ).done;
  assert.equal(
    (await server.readThread(thread.id)).items.some(
      (item) => item.type === "context_compaction",
    ),
    false,
  );
  await (
    await server.startTurn(thread.id, "two")
  ).done;
  const snapshot = await server.readThread(thread.id);
  assert.equal(snapshot.items.at(-1)?.type, "context_compaction");
  assert(
    estimateModelMessageInputTokens(compileModelMessages(snapshot.items)) <= 40,
  );
});

test("recompacts a legacy projection with the selected retention policy and replays it", async () => {
  const journal = new InMemoryThreadJournal();
  const model = summaryModel();
  const server = createServer({
    journal,
    model,
    contextCompaction: {
      retention: {
        mode: "selected-items",
        preserveUserMessages: true,
        finalMessages: "all",
      },
    },
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "one")
  ).done;
  await server.compactThread(thread.id, { includeOriginalReference: false });
  await (
    await server.startTurn(thread.id, "two")
  ).done;
  await server.compactThread(thread.id, { includeOriginalReference: false });

  const snapshot = await server.readThread(thread.id);
  const messages = snapshot.items.filter(
    (item) => item.type === "user_message" || item.type === "agent_message",
  );
  const latest = snapshot.items.at(-1);
  assert(latest?.type === "context_compaction");
  assert.deepEqual(
    latest.retainedItemIds,
    messages.map((item) => item.id),
  );
  const restarted = createServer({ journal, model });
  assert.deepEqual(
    compileModelMessages((await restarted.readThread(thread.id)).items),
    compileModelMessages(snapshot.items),
  );
});

test("does not append when explicit selected Items exceed the target", async () => {
  const journal = new InMemoryThreadJournal();
  const server = createServer({
    journal,
    model: summaryModel(),
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow: 100 },
    ]),
    contextCompaction: {
      triggerPercent: 80,
      targetPercent: 30,
      retention: {
        mode: "selected-items",
        preserveUserMessages: true,
      },
    },
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "x".repeat(200))
  ).done;
  const before = await journal.read(thread.id);
  await expectAppServerCode(
    server.compactThread(thread.id, { includeOriginalReference: false }),
    "compaction_budget_exceeded",
  );
  assert.deepEqual(await journal.read(thread.id), before);
});

test("bounds an oversized latest completed Turn without splitting its tool lifecycle", async () => {
  const toolOutput = "x".repeat(400);
  let normalSamples = 0;
  const contextWindow = 256;
  const summaryRequests: ModelRequest[] = [];
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        summaryRequests.push(cloneRequest(request));
        assert(
          estimateModelMessageInputTokens(request.messages) <= contextWindow,
        );
        yield { type: "text_delta", delta: "tool work completed" };
        return;
      }
      normalSamples += 1;
      if (normalSamples === 1) {
        yield {
          type: "tool_call",
          callId: "large-result",
          name: "shell",
          arguments: { command: `printf ${toolOutput}` },
        };
        yield { type: "usage", inputTokens: 205, outputTokens: 1 };
        return;
      }
      yield { type: "text_delta", delta: "finished" };
      yield { type: "usage", inputTokens: 205, outputTokens: 1 };
    },
  };
  const server = createServer({
    journal: new InMemoryThreadJournal(),
    model,
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow },
    ]),
  });
  const thread = await server.startThread();

  await (
    await server.startTurn(thread.id, "produce a large result")
  ).done;

  const snapshot = await server.readThread(thread.id);
  const compaction = snapshot.items.at(-1);
  assert(compaction?.type === "context_compaction");
  const call = snapshot.items.find((item) => item.type === "tool_call");
  const result = snapshot.items.find((item) => item.type === "tool_result");
  assert(call?.type === "tool_call");
  assert(result?.type === "tool_result");
  assert.equal(result.output, toolOutput);
  assert.equal(compaction.retainedItemIds.includes(call.id), false);
  assert.equal(compaction.retainedItemIds.includes(result.id), false);
  assert(summaryRequests.length > 1);
  const excerptSource = summaryRequests
    .flatMap((request) => request.messages)
    .filter(
      (message) =>
        message.role === "user" &&
        "text" in message &&
        message.text.startsWith("[excerpt]\n"),
    )
    .map((message) => ("text" in message ? message.text.slice(10) : ""))
    .join("");
  assert(excerptSource.includes(toolOutput));
  assert(
    estimateModelMessageInputTokens(compileModelMessages(snapshot.items)) <=
      205,
  );
});

test("compacts an oversized completed history before admitting the next model sample", async () => {
  const contextWindow = 256;
  const requests: ModelRequest[] = [];
  let normalSamples = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(cloneRequest(request));
      if (isSummaryRequest(request)) {
        assert(
          estimateModelMessageInputTokens(request.messages) <= contextWindow,
        );
        yield { type: "text_delta", delta: "s" };
        return;
      }
      normalSamples += 1;
      yield {
        type: "text_delta",
        delta: normalSamples === 1 ? "x".repeat(900) : "next answer",
      };
    },
  };
  const server = createServer({
    journal: new InMemoryThreadJournal(),
    model,
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow },
    ]),
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "first")
  ).done;
  assert.equal(
    (await server.readThread(thread.id)).items.some(
      (item) => item.type === "context_compaction",
    ),
    false,
  );

  await (
    await server.startTurn(thread.id, "second")
  ).done;

  const snapshot = await server.readThread(thread.id);
  const compactionIndex = snapshot.items.findIndex(
    (item) => item.type === "context_compaction",
  );
  const secondTurnId = snapshot.turns[1]?.id;
  const secondTurnIndex = snapshot.items.findIndex(
    (item) => item.type === "turn_started" && item.turnId === secondTurnId,
  );
  assert(compactionIndex >= 0);
  assert(secondTurnIndex > compactionIndex);
  const secondRequest = requests
    .filter((request) => !isSummaryRequest(request))
    .at(-1);
  assert(secondRequest !== undefined);
  assert(
    estimateModelMessageInputTokens(secondRequest.messages) < contextWindow,
  );
});

test("does not append a compaction when its summary alone exceeds the target", async () => {
  const journal = new InMemoryThreadJournal();
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        yield { type: "text_delta", delta: "s".repeat(400) };
        return;
      }
      yield { type: "text_delta", delta: "answer" };
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
  await (
    await server.startTurn(thread.id, "one")
  ).done;
  const before = await journal.read(thread.id);

  await expectAppServerCode(
    server.compactThread(thread.id, { includeOriginalReference: false }),
    "compaction_budget_exceeded",
  );

  assert.deepEqual(await journal.read(thread.id), before);
});

test("automatic compaction does not guess below threshold or from missing or invalid usage", async (t) => {
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
    reasoningEffort: string | null;
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
  assert.equal(compacted.initiator, "automatic");
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
  await assert.rejects(
    persistenceHandle.done,
    ThreadJournalAppendOutcomeUnknownError,
  );
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
  assert.equal(warnings.length, 2);
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
      await expectAppServerCode(
        server.compactThread(thread.id, { includeOriginalReference: false }),
        scenario.code,
      );
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
  await assert.rejects(
    persistence.compactThread(persistenceThread.id),
    ThreadJournalAppendOutcomeUnknownError,
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
  await first.compactThread(thread.id, { includeOriginalReference: false });
  assert.equal(summaryCalls, 1);
  await expectAppServerCode(
    first.compactThread(thread.id, { includeOriginalReference: false }),
    "compaction_not_available",
  );
  assert.equal(summaryCalls, 1);

  await (
    await first.startTurn(thread.id, "third")
  ).done;
  await first.compactThread(thread.id, { includeOriginalReference: false });
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
    reasoningEffort: string | null;
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
      { id: "recording-model", isDefault: true, contextWindow: 32_768 },
      { id: "other-model", contextWindow: 32_768 },
    ]),
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "one")
  ).done;

  const compaction = server.compactThread(thread.id, {
    includeOriginalReference: false,
  });
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

test("agentic threshold gives one host notice before the same Turn continues", async () => {
  const requests: ModelRequest[] = [];
  let samples = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(cloneRequest(request));
      if (request.tools.length === 0) {
        yield { type: "text_delta", delta: "summary" };
        yield { type: "usage", inputTokens: 5, outputTokens: 1 };
        return;
      }
      samples += 1;
      if (samples === 1) {
        yield { type: "text_delta", delta: "seed" };
        yield { type: "usage", inputTokens: 5, outputTokens: 1 };
        return;
      }
      if (samples === 2) {
        yield {
          type: "tool_call",
          callId: "notice-tool",
          name: "shell",
          arguments: { command: "printf ok" },
        };
        yield { type: "usage", inputTokens: 850, outputTokens: 1 };
        return;
      }
      assert(
        requests
          .at(-1)
          ?.messages.some(
            (message) =>
              message.role === "user" &&
              "text" in message &&
              message.text.startsWith("[Host context notice]"),
          ),
      );
      yield { type: "text_delta", delta: "continued" };
      yield { type: "usage", inputTokens: 10, outputTokens: 1 };
    },
  };
  const journal = new InMemoryThreadJournal();
  const server = createServer({
    journal,
    model,
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow: 1_000 },
    ]),
    contextCompaction: { agenticEnabled: true },
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "seed request")
  ).done;
  await (
    await server.startTurn(thread.id, "active request")
  ).done;

  assert.equal(
    requests.filter((request) =>
      request.messages.some(
        (message) =>
          message.role === "user" &&
          "text" in message &&
          message.text.startsWith("[Host context notice]"),
      ),
    ).length,
    1,
  );
  assert.equal(
    (await server.readThread(thread.id)).items.filter(
      (item) => item.type === "turn_started",
    ).length,
    2,
  );
});

test("active Turn hard budget fallback compacts before the next model sample", async () => {
  const requests: ModelRequest[] = [];
  let samples = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(cloneRequest(request));
      if (request.tools.length === 0) {
        yield { type: "text_delta", delta: "summary" };
        yield { type: "usage", inputTokens: 5, outputTokens: 1 };
        return;
      }
      samples += 1;
      if (samples === 1) {
        yield { type: "text_delta", delta: "seed" };
        yield { type: "usage", inputTokens: 5, outputTokens: 1 };
        return;
      }
      if (samples === 2) {
        yield {
          type: "tool_call",
          callId: "fallback-tool",
          name: "shell",
          arguments: { command: "printf ok" },
        };
        yield { type: "usage", inputTokens: 960, outputTokens: 1 };
        return;
      }
      assert(
        requests
          .at(-1)
          ?.messages.some(
            (message) =>
              message.role === "user" &&
              "text" in message &&
              message.text.startsWith("[Zen compacted context]"),
          ),
      );
      yield { type: "text_delta", delta: "continued after host compaction" };
      yield { type: "usage", inputTokens: 10, outputTokens: 1 };
    },
  };
  const journal = new InMemoryThreadJournal();
  const server = createServer({
    journal,
    model,
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow: 1_000 },
    ]),
    contextCompaction: { agenticEnabled: true },
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "seed request")
  ).done;
  await (
    await server.startTurn(thread.id, "active request")
  ).done;

  const snapshot = await server.readThread(thread.id);
  assert(
    snapshot.items.some(
      (item) =>
        item.type === "context_compaction" && item.initiator === "automatic",
    ),
  );
  assert.equal(
    snapshot.items.filter(
      (item) =>
        item.type === "context_compaction" && item.initiator === "automatic",
    ).length,
    1,
  );
  assert.equal(
    (await server.readThread(thread.id)).items.filter(
      (item) => item.type === "turn_started",
    ).length,
    2,
  );
});

test("agentic-off active compaction runs at the trigger threshold", async () => {
  let normalSamples = 0;
  let summaryCalls = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        summaryCalls += 1;
        yield { type: "text_delta", delta: "active summary" };
        return;
      }
      normalSamples += 1;
      if (normalSamples === 1) {
        yield { type: "text_delta", delta: "seed" };
        return;
      }
      if (normalSamples === 2) {
        yield {
          type: "tool_call",
          callId: "trigger-tool",
          name: "shell",
          arguments: { command: "printf ok" },
        };
        // 810 is above the 80% trigger and below the old trigger+15 fallback.
        yield { type: "usage", inputTokens: 810, outputTokens: 1 };
        return;
      }
      assert(
        request.messages.some(
          (message) =>
            message.role === "user" &&
            "text" in message &&
            message.text.startsWith("[Zen compacted context]"),
        ),
      );
      yield { type: "text_delta", delta: "after trigger" };
    },
  };
  const server = createServer({
    journal: new InMemoryThreadJournal(),
    model,
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow: 1_000 },
    ]),
    contextCompaction: { agenticEnabled: false },
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "seed request")
  ).done;
  await (
    await server.startTurn(thread.id, "active request")
  ).done;
  assert.equal(summaryCalls, 1);
});

test("active compaction estimates the complete post-tool projection", async () => {
  const largeOutput = "x".repeat(4_000);
  let normalSamples = 0;
  let summaryCalls = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        summaryCalls += 1;
        yield { type: "text_delta", delta: "post-tool summary" };
        return;
      }
      normalSamples += 1;
      if (normalSamples === 1) {
        yield { type: "text_delta", delta: "seed" };
        return;
      }
      if (normalSamples === 2) {
        yield {
          type: "tool_call",
          callId: "large-tool",
          name: "shell",
          arguments: { command: `printf ${largeOutput}` },
        };
        // Deliberately omit a useful usage value. The canonical tool result
        // itself must still trigger the pre-sample pressure check.
        yield { type: "usage", inputTokens: 1, outputTokens: 1 };
        return;
      }
      yield { type: "text_delta", delta: "after post-tool compaction" };
    },
  };
  const server = createServer({
    journal: new InMemoryThreadJournal(),
    model,
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow: 1_000 },
    ]),
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "seed request")
  ).done;
  await (
    await server.startTurn(thread.id, "active request")
  ).done;
  assert.equal(summaryCalls, 1);
});

test("an oversized first active Turn fails closed without a completed boundary", async () => {
  const requests: ModelRequest[] = [];
  let normalSamples = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(cloneRequest(request));
      normalSamples += 1;
      yield {
        type: "tool_call",
        callId: "first-large-tool",
        name: "shell",
        arguments: { command: `printf ${"x".repeat(2_000)}` },
      };
      yield { type: "usage", inputTokens: 1, outputTokens: 1 };
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
  await (
    await server.startTurn(thread.id, "first request")
  ).done;
  const snapshot = await server.readThread(thread.id);
  assert.equal(normalSamples, 1);
  assert.equal(requests.length, 1);
  assert.equal(
    snapshot.items.some((item) => item.type === "context_compaction"),
    false,
  );
  assert.equal(snapshot.turns[0]?.status, "failed");
});

test("active host compaction preserves same-Turn late steering", async () => {
  const summaryStarted = deferred<void>();
  const releaseSummary = deferred<void>();
  let activeTurnId = "";
  let normalSamples = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (isSummaryRequest(request)) {
        summaryStarted.resolve();
        await releaseSummary.promise;
        yield { type: "text_delta", delta: "steered summary" };
        return;
      }
      normalSamples += 1;
      if (normalSamples === 1) {
        yield { type: "text_delta", delta: "seed" };
        return;
      }
      if (normalSamples === 2) {
        yield {
          type: "tool_call",
          callId: "steer-tool",
          name: "shell",
          arguments: { command: "printf ok" },
        };
        yield { type: "usage", inputTokens: 810, outputTokens: 1 };
        return;
      }
      assert(
        request.messages.some(
          (message) =>
            message.role === "user" &&
            "text" in message &&
            message.text.includes("late steer"),
        ),
      );
      yield { type: "text_delta", delta: "finished" };
    },
  };
  const server = createServer({
    journal: new InMemoryThreadJournal(),
    model,
    modelCatalog: new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow: 1_000 },
    ]),
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "seed request")
  ).done;
  const active = await server.startTurn(thread.id, "active request");
  activeTurnId = active.id;
  await summaryStarted.promise;
  const steer = server.steerTurn(thread.id, activeTurnId, "late steer", {
    clientId: "late-steer",
  });
  releaseSummary.resolve();
  await steer;
  await active.done;
});

test("active compaction preserves unknown journal outcomes and stop handling", async () => {
  await test("unknown compaction append", async () => {
    const backing = new InMemoryThreadJournal();
    const journal: ThreadJournal = {
      append: async (item) => {
        if (item.type === "context_compaction")
          throw new Error("active compaction journal unavailable");
        await backing.append(item);
      },
      listThreadIds: async () => await backing.listThreadIds(),
      read: async (threadId) => await backing.read(threadId),
    };
    let normalSamples = 0;
    const model: ModelAdapter = {
      provider: "recording",
      async *stream(request): AsyncIterable<ModelEvent> {
        if (isSummaryRequest(request)) {
          yield { type: "text_delta", delta: "summary" };
          return;
        }
        normalSamples += 1;
        if (normalSamples === 1) {
          yield { type: "text_delta", delta: "seed" };
          return;
        }
        yield {
          type: "tool_call",
          callId: "unknown-active",
          name: "shell",
          arguments: { command: "printf ok" },
        };
        yield { type: "usage", inputTokens: 810, outputTokens: 1 };
      },
    };
    const server = createServer({
      journal,
      model,
      modelCatalog: new StaticModelCatalog([
        { id: "recording-model", isDefault: true, contextWindow: 1_000 },
      ]),
    });
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "seed request")
    ).done;
    const active = await server.startTurn(thread.id, "active request");
    await assert.rejects(active.done, /active compaction journal unavailable/u);
    assert.equal(normalSamples, 2);
    assert.equal(
      (await backing.read(thread.id)).some(
        (item) => item.type === "context_compaction",
      ),
      false,
    );
  });

  await test("stop during active summary", async () => {
    const summaryStarted = deferred<void>();
    let normalSamples = 0;
    const model: ModelAdapter = {
      provider: "recording",
      async *stream(request): AsyncIterable<ModelEvent> {
        if (isSummaryRequest(request)) {
          summaryStarted.resolve();
          await new Promise<void>((resolve) => {
            request.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return;
        }
        normalSamples += 1;
        if (normalSamples === 1) {
          yield { type: "text_delta", delta: "seed" };
          return;
        }
        yield { type: "text_delta", delta: "seed" };
        yield {
          type: "tool_call",
          callId: "stop-active",
          name: "shell",
          arguments: { command: "printf ok" },
        };
        yield { type: "usage", inputTokens: 810, outputTokens: 1 };
      },
    };
    const server = createServer({
      journal: new InMemoryThreadJournal(),
      model,
      modelCatalog: new StaticModelCatalog([
        { id: "recording-model", isDefault: true, contextWindow: 1_000 },
      ]),
    });
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "seed request")
    ).done;
    const active = await server.startTurn(thread.id, "active request");
    await summaryStarted.promise;
    await server.interruptTurn(thread.id, active.id);
    await active.done;
    const snapshot = await server.readThread(thread.id);
    assert.equal(snapshot.turns.at(-1)?.status, "interrupted");
    assert.equal(
      snapshot.items.some((item) => item.type === "context_compaction"),
      false,
    );
  });
});

function createServer(options: {
  journal: ThreadJournal;
  model: ModelAdapter;
  modelCatalog?: ModelCatalog;
  runtime?: AgentRuntime;
  contextCompaction?: ContextCompactionConfig;
}): ZenAppServer {
  const modelCatalog =
    options.modelCatalog ??
    new StaticModelCatalog([
      { id: "recording-model", isDefault: true, contextWindow: 32_768 },
    ]);
  return new ZenAppServer({
    journal: options.journal,
    runtime:
      options.runtime ??
      new AgentRuntime({
        toolEnvironment: new ToolEnvironment({
          runtimes: [new ShellToolRuntime()],
        }),
      }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: options.model.provider,
        adapter: options.model,
        modelCatalog,
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: options.model.provider,
      modelId: modelCatalog.defaultModel().id,
      reasoningEffort:
        modelCatalog.defaultModel().defaultReasoningEffort ?? "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    contextCompaction: {
      includeOriginalReference: false,
      ...options.contextCompaction,
    },
  });
}

class MalformedCompactionRuntime extends AgentRuntime {
  readonly #override: Record<string, unknown>;

  constructor(override: Record<string, unknown>) {
    super({
      toolEnvironment: new ToolEnvironment({
        runtimes: [new ShellToolRuntime()],
      }),
    });
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

function canonicalRetentionHistory(): CanonicalItem[] {
  const items: CanonicalItem[] = [canonicalMetadata()];
  const addTurn = (
    turn: number,
    status: "completed" | "failed",
    agentTexts: readonly string[],
  ) => {
    const turnId = `turn-${String(turn)}`;
    items.push(
      {
        id: `started-${String(turn)}`,
        threadId: "thread",
        turnId,
        createdAt: `2026-01-01T00:00:0${String(turn)}.000Z`,
        type: "turn_started",
        selection: {
          providerProfileId: "recording",
          modelId: "recording-model",
          reasoningEffort: "medium",
        },
      },
      {
        id: `user-${String(turn)}`,
        threadId: "thread",
        turnId,
        createdAt: `2026-01-01T00:00:0${String(turn)}.001Z`,
        type: "user_message",
        text: `question ${String(turn)}`,
      },
    );
    for (const [index, text] of agentTexts.entries()) {
      items.push({
        id:
          index === agentTexts.length - 1
            ? `final-${String(turn)}`
            : `partial-${String(turn)}-${String(index)}`,
        threadId: "thread",
        turnId,
        createdAt: `2026-01-01T00:00:0${String(turn)}.00${String(index + 2)}Z`,
        type: "agent_message",
        text,
      });
    }
    items.push({
      id: `completed-${String(turn)}`,
      threadId: "thread",
      turnId,
      createdAt: `2026-01-01T00:00:0${String(turn)}.009Z`,
      type: "turn_completed",
      status,
    });
  };
  addTurn(1, "completed", ["tool preface", "answer 1"]);
  addTurn(2, "failed", ["failed partial"]);
  addTurn(3, "completed", ["answer 3"]);
  return items;
}

function canonicalPlainHistory(turnCount: number): CanonicalItem[] {
  const items: CanonicalItem[] = [canonicalMetadata()];
  for (let turn = 1; turn <= turnCount; turn += 1) {
    const turnId = `plain-turn-${String(turn)}`;
    items.push(
      {
        id: `plain-start-${String(turn)}`,
        threadId: "thread",
        turnId,
        createdAt: `2026-01-02T00:00:${String(turn).padStart(2, "0")}.000Z`,
        type: "turn_started",
      },
      {
        id: `plain-user-${String(turn)}`,
        threadId: "thread",
        turnId,
        createdAt: `2026-01-02T00:00:${String(turn).padStart(2, "0")}.001Z`,
        type: "user_message",
        text: `question ${String(turn)}`,
      },
      {
        id: `plain-agent-${String(turn)}`,
        threadId: "thread",
        turnId,
        createdAt: `2026-01-02T00:00:${String(turn).padStart(2, "0")}.002Z`,
        type: "agent_message",
        text: `answer ${String(turn)}`,
      },
      {
        id: `plain-completed-${String(turn)}`,
        threadId: "thread",
        turnId,
        createdAt: `2026-01-02T00:00:${String(turn).padStart(2, "0")}.003Z`,
        type: "turn_completed",
        status: "completed",
      },
    );
  }
  return items;
}

function canonicalNestedToolHistory(): CanonicalItem[] {
  const base = canonicalToolHistory();
  const replacements: Record<string, CanonicalItem> = {
    "call-1": {
      ...base.find((item) => item.id === "call-1")!,
      id: "outer-call",
      type: "tool_call",
      callId: "outer",
    } as CanonicalItem,
    "call-2": {
      ...base.find((item) => item.id === "call-2")!,
      id: "sibling-call",
      type: "tool_call",
      callId: "sibling",
    } as CanonicalItem,
    "result-1": {
      ...base.find((item) => item.id === "result-1")!,
      id: "outer-result",
      type: "tool_result",
      callId: "outer",
    } as CanonicalItem,
    "result-2": {
      ...base.find((item) => item.id === "result-2")!,
      id: "sibling-result",
      type: "tool_result",
      callId: "sibling",
    } as CanonicalItem,
  };
  const items = base.map((item) => replacements[item.id] ?? item);
  const insertion = items.findIndex((item) => item.id === "outer-result");
  items.splice(
    insertion,
    0,
    {
      id: "child-call",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-01-01T00:00:00.0055Z",
      type: "tool_call",
      callId: "child",
      parentCallId: "outer",
      name: "nested",
      arguments: {},
    },
    {
      id: "child-result",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-01-01T00:00:00.0056Z",
      type: "tool_result",
      callId: "child",
      output: "child",
      exitCode: 0,
    },
  );
  return items;
}

function contextCompactionItem(
  items: readonly CanonicalItem[],
): ProviderGeneratedContextCompactionItem {
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
