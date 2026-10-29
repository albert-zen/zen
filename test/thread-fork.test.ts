import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { AppServerError, ZenAppServer } from "../src/app-server.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { decodeCanonicalItem, type CanonicalItem } from "../src/item.js";
import { pendingQueuedMessages } from "../src/input-queue.js";
import { InMemoryThreadJournal, type ThreadJournal } from "../src/journal.js";
import { DomainThreadJournal } from "../src/domain-journal.js";
import { FileTraceStore } from "../src/trace.js";
import { compileItemList } from "../src/item-list.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelMessage,
} from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolEnvironment, type ToolRuntime } from "../src/tool.js";
import { ViewImageToolRuntime } from "../src/view-image.js";
import { png1x1 } from "./fixtures.js";

function createServer(
  model: ModelAdapter,
  options: {
    journal?: ThreadJournal;
    attachments?: InMemoryAttachmentStore;
    tools?: ToolRuntime[];
    idPrefix?: string;
  } = {},
) {
  let sequence = 0;
  const journal = options.journal ?? new InMemoryThreadJournal();
  const attachments = options.attachments ?? new InMemoryAttachmentStore();
  return new ZenAppServer({
    journal,
    attachments,
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({
        runtimes: options.tools ?? [],
        approvedTools: new Set(options.tools?.map((tool) => tool.name)),
      }),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          {
            id: "model",
            isDefault: true,
            contextWindow: 32_768,
            inputModalities: ["text", "image"],
          },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: model.provider,
      modelId: "model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    idFactory: () => `${options.idPrefix ?? "id"}-${String(++sequence)}`,
    now: () => new Date(1_000 + sequence).toISOString(),
  });
}

test("forked history keeps image payloads replayable and authorized", async () => {
  const requests: ModelMessage[][] = [];
  const model: ModelAdapter = {
    provider: "images",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request.messages));
      yield { type: "text_delta", delta: "seen" };
    },
  };
  const journal = new InMemoryThreadJournal();
  const attachments = new InMemoryAttachmentStore();
  const server = createServer(model, { journal, attachments });
  const source = await server.startThread();
  const image = await server.importImageBytes(png1x1());
  await (
    await server.startTurn(source.id, [
      { type: "text", text: "remember this image" },
      { type: "image", attachment: image },
    ])
  ).done;

  const fork = await server.forkThread({
    sourceThreadId: source.id,
    through: { type: "latest-complete" },
    workspace: { type: "same-directory" },
  });
  const viewer = new ViewImageToolRuntime({ attachments, journal });
  const viewed = await viewer.execute({
    callId: "copied-image",
    name: "view_image",
    arguments: { attachment: image },
    cwd: fork.cwd,
    threadId: fork.id,
    signal: new AbortController().signal,
  });
  assert.deepEqual(viewed.modelContent, [{ type: "image", attachment: image }]);

  await (
    await server.startTurn(fork.id, "what did I attach?")
  ).done;
  assert.deepEqual(requests[1]?.[0], {
    role: "user",
    content: [
      {
        type: "text",
        text: `[Message received at ${fork.items.find((item) => item.type === "user_message")!.createdAt}]`,
      },
      { type: "text", text: "remember this image" },
      { type: "image", attachment: image },
    ],
  });
});

test("fork copies a replayable prefix and both Threads continue independently", async () => {
  const requests: ModelMessage[][] = [];
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request.messages));
      yield { type: "usage", inputTokens: 7, outputTokens: 3 };
      yield { type: "text_delta", delta: `answer-${String(requests.length)}` };
    },
  };
  const server = createServer(model);
  const source = await server.startThread({ cwd: os.tmpdir() });
  await server.setThreadName(source.id, "Investigate parser");
  await (
    await server.startTurn(source.id, "first question")
  ).done;

  const before = await server.readThread(source.id);
  const fork = await server.forkThread({
    sourceThreadId: source.id,
    through: { type: "latest-complete" },
    workspace: { type: "same-directory" },
  });

  assert.notEqual(fork.id, source.id);
  assert.equal(fork.cwd, source.cwd);
  assert.equal(fork.name, "Investigate parser · Copy");
  assert.equal(fork.turns.length, 1);
  assert.equal(requests.length, 1, "copying must not invoke the model");
  assert.deepEqual(await server.readThread(source.id), before);
  const provenance = fork.items.at(-1);
  assert.equal(provenance?.type, "thread_forked");
  assert.deepEqual(
    provenance?.type === "thread_forked"
      ? {
          sourceThreadId: provenance.sourceThreadId,
          sourceTurnId: provenance.sourceTurnId,
        }
      : null,
    { sourceThreadId: source.id, sourceTurnId: before.turns[0]?.id },
  );
  const sourceIds = new Set(before.items.map((item) => item.id));
  assert.equal(
    fork.items.slice(0, -1).some((item) => sourceIds.has(item.id)),
    false,
    "copied canonical Items must receive independent identities",
  );
  const copiedUsage = fork.items.find((item) => item.type === "model_usage");
  assert.ok(copiedUsage);
  assert.ok(
    fork.items.some(
      (item) =>
        item.type === "agent_message" &&
        item.id === copiedUsage.modelResponseId,
    ),
    "internal response references must target copied Items",
  );
  const forkSummary = (await server.listThreadSummaries()).find(
    (summary) => summary.threadId === fork.id,
  );
  assert.equal(
    forkSummary?.status === "systemError"
      ? undefined
      : forkSummary?.forkedFromThreadId,
    source.id,
  );
  assert.equal(forkSummary?.createdAt, provenance?.createdAt);

  await (
    await server.startTurn(fork.id, "fork path")
  ).done;
  const userTimestamps = (await server.readThread(fork.id)).items
    .filter((item) => item.type === "user_message")
    .map((item) => item.createdAt);
  assert.deepEqual(requests[1], [
    {
      role: "user",
      content: [
        { type: "text", text: `[Message received at ${userTimestamps[0]}]` },
        { type: "text", text: "first question" },
      ],
    },
    { role: "assistant", text: "answer-1" },
    {
      role: "user",
      content: [
        { type: "text", text: `[Message received at ${userTimestamps[1]}]` },
        { type: "text", text: "fork path" },
      ],
    },
  ]);
  assert.equal((await server.readThread(source.id)).turns.length, 1);
  assert.equal((await server.readThread(fork.id)).turns.length, 2);
});

test("fork chooses the last closed Turn while the source has active and queued work", async () => {
  let releaseActive!: () => void;
  const activeGate = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  let calls = 0;
  const model: ModelAdapter = {
    provider: "blocking",
    async *stream(): AsyncIterable<ModelEvent> {
      calls += 1;
      if (calls === 2) await activeGate;
      yield { type: "text_delta", delta: `answer-${String(calls)}` };
    },
  };
  const server = createServer(model);
  const source = await server.startThread();
  await (
    await server.startTurn(source.id, "complete")
  ).done;
  const active = await server.startTurn(source.id, "still running");
  await server.queueMessage(source.id, "later", "queued-client");

  const fork = await server.forkThread({
    sourceThreadId: source.id,
    through: { type: "latest-complete" },
    workspace: { type: "same-directory" },
  });
  assert.equal(fork.turns.length, 1);
  assert.equal(
    fork.items.some(
      (item) =>
        item.type === "user_message_queued" ||
        (item.turnId === active.id && item.type !== "thread_forked"),
    ),
    false,
  );

  releaseActive();
  await active.done;
});

test("fork preserves exact compaction text and source ownership with only local identities remapped", async () => {
  let calls = 0;
  const model: ModelAdapter = {
    provider: "compacting",
    async *stream(): AsyncIterable<ModelEvent> {
      calls += 1;
      yield { type: "usage", inputTokens: 5, outputTokens: 2 };
      yield {
        type: "text_delta",
        delta: calls === 1 ? "first answer" : "summary of the first exchange",
      };
    },
  };
  const server = createServer(model);
  const source = await server.startThread();
  await (
    await server.startTurn(source.id, "first question")
  ).done;
  await server.compactThread(source.id);
  const compactedSource = await server.readThread(source.id);

  const fork = await server.forkThread({
    sourceThreadId: source.id,
    through: { type: "latest-complete" },
    workspace: { type: "same-directory" },
  });
  assert.equal(calls, 2, "copying compacted history must not resummarize");
  const selection = {
    providerProfileId: source.providerProfileId,
    modelId: source.modelId,
    reasoningEffort: source.reasoningEffort,
  };
  const forkMessages = compileItemList(fork.itemList!, { selection }).messages;
  const sourceMessages = compileItemList(compactedSource.itemList!, {
    selection,
  }).messages;
  assert.deepEqual(forkMessages, sourceMessages);
  const sourceCompaction = compactedSource.items.find(
    (item) => item.type === "context_compaction",
  );
  const forkCompaction = fork.items.find(
    (item) => item.type === "context_compaction",
  );
  assert.ok(sourceCompaction);
  assert.ok(forkCompaction);
  const sourceSelection = compactedSource.itemList!.find(
    (item) => item.kind === "selection",
  )!;
  const forkSelection = fork.itemList!.find(
    (item) => item.kind === "selection",
  )!;
  assert(
    sourceSelection.kind === "selection" && forkSelection.kind === "selection",
  );
  assert.equal(forkSelection.content.text, sourceSelection.content.text);
  assert.deepEqual(
    forkSelection.source.metadata?.referenceBindings,
    sourceSelection.source.metadata?.referenceBindings,
  );
  assert.equal(
    forkSelection.content.coveredThroughItemId,
    forkCompaction.coveredThroughItemId,
  );
  assert.deepEqual(
    forkSelection.content.retainedItemIds,
    forkCompaction.retainedItemIds.filter((id) =>
      fork.itemList!.some((item) => item.id === id),
    ),
  );
  assert.notEqual(
    forkCompaction.coveredThroughItemId,
    sourceCompaction.coveredThroughItemId,
  );
  assert.ok(
    fork.items.some((item) => item.id === forkCompaction.coveredThroughItemId),
  );
  assert.equal(
    forkCompaction.retainedItemIds.every((id) =>
      fork.items.some((item) => item.id === id),
    ),
    true,
  );
});

test("fork rejects Threads without a closed Turn", async () => {
  const model: ModelAdapter = {
    provider: "unused",
    async *stream(): AsyncIterable<ModelEvent> {
      yield { type: "text_delta", delta: "unused" };
    },
  };
  const server = createServer(model);
  const source = await server.startThread();

  await assert.rejects(
    server.forkThread({
      sourceThreadId: source.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "fork_boundary_unavailable",
  );
});

test("latest-complete fork rejects a failed Turn", async () => {
  const model: ModelAdapter = {
    provider: "failing",
    async *stream(): AsyncIterable<ModelEvent> {
      throw new Error("failed turn");
    },
  };
  const server = createServer(model);
  const source = await server.startThread();
  await (
    await server.startTurn(source.id, "fail")
  ).done;

  await assert.rejects(
    server.forkThread({
      sourceThreadId: source.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "fork_boundary_unavailable",
  );
});

test("exact-item fork copies only the selected message prefix across rename and later history", async () => {
  const requests: ModelMessage[][] = [];
  let executions = 0;
  const model: ModelAdapter = {
    provider: "exact-prefix",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request.messages));
      if (requests.length === 1) {
        yield { type: "text_delta", delta: "selected message" };
        yield {
          type: "tool_call",
          callId: "later-tool",
          name: "observe",
          arguments: {},
        };
      } else {
        yield {
          type: "text_delta",
          delta: `later response ${String(requests.length)}`,
        };
      }
    },
  };
  const server = createServer(model, {
    tools: [
      {
        name: "observe",
        specification: {
          name: "observe",
          description: "Observe",
          inputSchema: { type: "object" },
        },
        async execute() {
          executions += 1;
          return { output: "later tool result", exitCode: 0 };
        },
      },
    ],
  });
  const source = await server.startThread();
  await server.setThreadName(source.id, "Old title");
  await (
    await server.startTurn(source.id, "original question")
  ).done;
  const selected = (await server.readThread(source.id)).items.find(
    (item) => item.type === "agent_message",
  )!;
  await (
    await server.startTurn(source.id, "later turn")
  ).done;
  await server.setThreadPermissions(source.id, "read-only");
  await server.setThreadName(source.id, "Renamed source");
  const before = await server.readThread(source.id);
  const callsBefore = requests.length;
  const fork = await server.forkThread({
    sourceThreadId: source.id,
    through: { type: "item", itemId: selected.id },
    workspace: { type: "same-directory" },
  });
  const prefix = before.items.slice(
    0,
    before.items.findIndex((item) => item.id === selected.id) + 1,
  );
  const copied = fork.items.slice(0, prefix.length);
  const withoutIdentity = ({
    id: _id,
    threadId: _threadId,
    ...item
  }: CanonicalItem) => item;
  assert.deepEqual(copied.map(withoutIdentity), prefix.map(withoutIdentity));
  assert(
    copied.every(
      (item) =>
        item.threadId === fork.id &&
        !prefix.some((original) => original.id === item.id),
    ),
  );
  assert.deepEqual(
    fork.items.slice(prefix.length).map((item) => item.type),
    ["thread_forked", "turn_aborted"],
  );
  const provenance = fork.items[prefix.length];
  assert(provenance?.type === "thread_forked");
  assert.equal(provenance.sourceBoundaryItemId, selected.id);
  assert.equal(provenance.sourceTurnId, selected.turnId);
  assert.equal(provenance.sourceThreadId, source.id);
  assert.equal(fork.turns.length, 1);
  assert.equal(fork.turns[0]?.status, "interrupted");
  assert.equal(fork.name, "Renamed source · Copy");
  assert.equal(
    fork.sandbox,
    "danger-full-access",
    "later configuration is outside the selected prefix",
  );
  assert.equal(requests.length, callsBefore);
  assert.equal(executions, 1);
  assert.deepEqual(await server.readThread(source.id), before);
  await (
    await server.startTurn(fork.id, "explicit fork question")
  ).done;
  assert.deepEqual(requests.at(-1), [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `[Message received at ${before.items.find((item) => item.type === "user_message")!.createdAt}]`,
        },
        { type: "text", text: "original question" },
      ],
    },
    { role: "assistant", text: "selected message" },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `[Message received at ${(await server.readThread(fork.id)).items.findLast((item) => item.type === "user_message")!.createdAt}]`,
        },
        { type: "text", text: "explicit fork question" },
      ],
    },
  ]);
  assert.equal(executions, 1, "fork continuation never replays a source tool");
  assert.deepEqual(await server.readThread(source.id), before);
});

test("exact-item fork rejects missing, wrong-Thread and non-agent identities without creating a Thread", async () => {
  const model: ModelAdapter = {
    provider: "invalid-boundary",
    async *stream() {
      yield { type: "text_delta", delta: "answer" };
    },
  };
  const journal = new InMemoryThreadJournal();
  const server = createServer(model, { journal });
  const source = await server.startThread();
  const other = await server.startThread();
  await (
    await server.startTurn(source.id, "question")
  ).done;
  await (
    await server.startTurn(other.id, "other question")
  ).done;
  const before = await server.readThread(source.id);
  const otherMessage = (await server.readThread(other.id)).items.find(
    (item) => item.type === "agent_message",
  )!;
  for (const itemId of [
    "missing",
    otherMessage.id,
    ...before.items
      .filter((item) => item.type !== "agent_message")
      .map((item) => item.id),
  ]) {
    await assert.rejects(
      server.forkThread({
        sourceThreadId: source.id,
        through: { type: "item", itemId },
        workspace: { type: "same-directory" },
      }),
      (error: unknown) =>
        error instanceof AppServerError &&
        error.code ===
          (before.items.some((item) => item.id === itemId)
            ? "invalid_request"
            : "fork_boundary_unavailable"),
    );
  }
  assert.deepEqual(await journal.listThreadIds(), [source.id, other.id].sort());
  assert.deepEqual(await server.readThread(source.id), before);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("exact-item fork works during active tool execution and excludes later queued work", async () => {
  const entered = deferred();
  const release = deferred();
  const requests: ModelMessage[][] = [];
  let executions = 0;
  const model: ModelAdapter = {
    provider: "active-exact",
    async *stream(request) {
      requests.push(structuredClone(request.messages));
      if (requests.length === 1) {
        yield { type: "text_delta", delta: "completed message before tool" };
        yield {
          type: "tool_call",
          callId: "active-call",
          name: "block",
          arguments: {},
        };
      } else yield { type: "text_delta", delta: "answer" };
    },
  };
  const server = createServer(model, {
    tools: [
      {
        name: "block",
        specification: {
          name: "block",
          description: "Block",
          inputSchema: { type: "object" },
        },
        async execute() {
          executions += 1;
          entered.resolve();
          await release.promise;
          return { output: "source result", exitCode: 0 };
        },
      },
    ],
  });
  const source = await server.startThread();
  const active = await server.startTurn(source.id, "source task");
  try {
    await entered.promise;
    await server.queueMessage(source.id, "later queued input", "source-queue");
    const before = await server.readThread(source.id);
    const selected = before.items.find(
      (item) => item.type === "agent_message",
    )!;
    const fork = await server.forkThread({
      sourceThreadId: source.id,
      through: { type: "item", itemId: selected.id },
      workspace: { type: "same-directory" },
    });
    assert.equal(fork.turns[0]?.status, "interrupted");
    assert.equal(
      (await server.readThread(source.id)).turns[0]?.status,
      "inProgress",
    );
    assert(
      !fork.items.some(
        (item) =>
          item.type === "tool_call" || item.type === "user_message_queued",
      ),
    );
    assert.equal(requests.length, 1);
    assert.equal(executions, 1);
    assert.deepEqual(await server.readThread(source.id), before);
    await server.resumeQueue(fork.id);
    assert.equal(requests.length, 1);
    await (
      await server.startTurn(fork.id, "new fork input")
    ).done;
    assert.equal(requests.length, 2);
    assert.equal(executions, 1);
    assert.deepEqual(await server.readThread(source.id), before);
  } finally {
    release.resolve();
    await active.done;
  }
});

test("exact-item fork refuses a streaming-only identity and accepts its interrupted canonical snapshot", async () => {
  const streamed = deferred();
  let streamingItemId = "";
  let requests = 0;
  const model: ModelAdapter = {
    provider: "streaming-exact",
    async *stream(request) {
      requests += 1;
      yield { type: "text_delta", delta: "partial answer" };
      if (requests === 1) {
        streamed.resolve();
        await new Promise<void>((_resolve, reject) =>
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          ),
        );
      }
    },
  };
  const server = createServer(model);
  const source = await server.startThread();
  const unsubscribe = server.subscribe((event) => {
    if (event.type === "item_started" && event.itemType === "agent_message")
      streamingItemId = event.itemId;
  });
  const active = await server.startTurn(source.id, "start answer");
  try {
    await streamed.promise;
    assert(streamingItemId);
    const input = {
      sourceThreadId: source.id,
      through: { type: "item" as const, itemId: streamingItemId },
      workspace: { type: "same-directory" as const },
    };
    await assert.rejects(
      server.forkThread(input),
      (error: unknown) =>
        error instanceof AppServerError &&
        error.code === "fork_boundary_unavailable",
    );
    await server.interruptTurn(source.id, active.id);
    await active.done;
    const before = await server.readThread(source.id);
    assert.equal(before.turns[0]?.status, "interrupted");
    const fork = await server.forkThread(input);
    assert.equal(fork.turns[0]?.status, "interrupted");
    assert.equal(requests, 1);
    await (
      await server.startTurn(fork.id, "continue explicitly")
    ).done;
    assert.equal(requests, 2);
    assert.deepEqual(await server.readThread(source.id), before);
  } finally {
    unsubscribe();
    await server.interruptTurn(source.id, active.id).catch(() => undefined);
    await active.done;
  }
});

test("exact-item snapshot closures make copied tools, all queue kinds and replacement intent inert after reload", async (t) => {
  const requests: ModelMessage[][] = [];
  const model: ModelAdapter = {
    provider: "inert-prefix",
    async *stream(request) {
      requests.push(structuredClone(request.messages));
      yield { type: "text_delta", delta: "explicit answer" };
    },
  };
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-fork-semantic-"));
  const directory = path.join(root, "threads");
  const trace = new FileTraceStore(path.join(root, "trace"));
  const metadata = new InMemoryThreadMetadataStore();
  const journal = new DomainThreadJournal({ directory, trace, metadata });
  let coldJournal: DomainThreadJournal | undefined;
  t.after(async () => {
    await coldJournal?.close();
    await journal.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = {
    threadId: "persisted-source",
    createdAt: "2026-10-14T00:00:00Z",
  };
  const turn = { ...base, turnId: "interrupted-turn" };
  const input = [{ type: "text" as const, text: "pending inherited input" }];
  await journal.create([
    {
      ...base,
      id: "metadata",
      type: "thread_metadata",
      cwd: os.tmpdir(),
      providerProfileId: model.provider,
      modelId: "model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    { ...turn, id: "start", type: "turn_started" },
    { ...turn, id: "input", type: "user_message", text: "original input" },
    {
      ...turn,
      id: "call",
      type: "tool_call",
      name: "observe",
      callId: "unfinished-call",
      arguments: {},
    },
    {
      ...turn,
      id: "abort",
      type: "turn_aborted",
      reason: "source interrupted",
    },
    {
      ...base,
      id: "queue",
      type: "user_message_queued",
      clientId: "human-queue",
      input,
    },
    {
      ...base,
      id: "host-queue",
      type: "host_message_queued",
      clientId: "host-queue",
      sender: "host",
      source: "trigger",
      sourceId: "source-trigger",
      text: "pending inherited input",
      input,
      intent: "queue",
      deliveryMode: "batch-next",
    },
    {
      ...base,
      id: "thread-queue",
      type: "thread_message_queued",
      clientId: "thread-queue",
      input,
      messageType: "follow_up",
      deliveryMode: "batch-next",
      sender: {
        threadId: "sender",
        turnId: "sender-turn",
        toolCallId: "sender-tool",
        callId: "sender-call",
      },
    },
    {
      ...turn,
      id: "replacement",
      type: "turn_replacement_requested",
      clientId: "replacement",
      successorTurnId: "successor",
      text: "pending replacement",
    },
    { ...base, turnId: "later-turn", id: "later-start", type: "turn_started" },
    {
      ...base,
      turnId: "later-turn",
      id: "selected",
      type: "agent_message",
      text: "selected later message",
    },
    {
      ...base,
      turnId: "later-turn",
      id: "later-hidden",
      type: "agent_message",
      text: "excluded message",
    },
  ]);
  const server = createServer(model, { journal });
  const before = await server.readThread(base.threadId);
  const fork = await server.forkThread({
    sourceThreadId: base.threadId,
    through: { type: "item", itemId: "selected" },
    workspace: { type: "same-directory" },
  });
  assert.equal(requests.length, 0);
  assert.equal(pendingQueuedMessages(fork.items).length, 0);
  assert.equal(fork.turns.at(-1)?.status, "interrupted");
  assert.deepEqual(
    fork.items.slice(0, 11).map((item) => item.type),
    before.items.slice(0, 11).map((item) => item.type),
  );
  assert(
    !fork.items.some(
      (item) =>
        item.type === "agent_message" && item.text === "excluded message",
    ),
  );
  const result = fork.items.find((item) => item.type === "tool_result");
  assert(result?.type === "tool_result");
  assert.deepEqual(result.structuredContent, {
    status: "snapshot",
    executed: false,
  });
  assert.match(result.output, /not executed/i);
  for (const item of fork.items)
    assert.deepEqual(
      decodeCanonicalItem(JSON.parse(JSON.stringify(item))),
      item,
    );
  const persistedFork = await journal.readItemList(fork.id);
  assert.deepEqual(persistedFork, fork.itemList);
  await journal.close();
  coldJournal = new DomainThreadJournal({
    directory,
    trace: new FileTraceStore(path.join(root, "trace")),
    metadata,
  });
  const restored = createServer(model, { journal: coldJournal });
  const coldFork = await restored.readThread(fork.id);
  assert.deepEqual(coldFork.items, fork.items);
  assert.deepEqual(coldFork.itemList, persistedFork);
  await restored.resumeQueue(fork.id);
  assert.equal(requests.length, 0);
  await (
    await restored.startTurn(fork.id, "explicit follow-up")
  ).done;
  assert.equal(requests.length, 1);
  assert.doesNotMatch(
    JSON.stringify(requests[0]),
    /pending inherited input|pending replacement|excluded message/,
  );
  const messages = requests[0]!;
  const resultIndex = messages.findIndex((message) => message.role === "tool");
  const selectedIndex = messages.findIndex(
    (message) =>
      message.role === "assistant" && message.text === "selected later message",
  );
  assert(
    resultIndex >= 0 && resultIndex < selectedIndex,
    "synthetic closure projects at the original tool batch",
  );
  assert.deepEqual(await server.readThread(base.threadId), before);
  assert.deepEqual(await coldJournal.read(base.threadId), before.items);
});

test("forking a completed final message retains the observed completion without later semantic history", async (t) => {
  const requests: ModelMessage[][] = [];
  const model: ModelAdapter = {
    provider: "completed-final",
    async *stream(request) {
      requests.push(structuredClone(request.messages));
      yield {
        type: "text_delta",
        delta: `Exact final answer ${requests.length}.\n  Preserve whitespace.`,
      };
      yield { type: "usage", inputTokens: 100, outputTokens: 10 };
    },
  };
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-fork-final-"));
  const directory = path.join(root, "threads");
  const metadata = new InMemoryThreadMetadataStore();
  const journal = new DomainThreadJournal({
    directory,
    trace: new FileTraceStore(path.join(root, "trace")),
    metadata,
  });
  let coldJournal: DomainThreadJournal | undefined;
  t.after(async () => {
    await coldJournal?.close();
    await journal.close();
    await rm(root, { recursive: true, force: true });
  });
  const server = createServer(model, { journal });
  const source = await server.startThread();
  await (
    await server.startTurn(source.id, "First input")
  ).done;
  const completed = await server.readThread(source.id);
  const selected = completed.items.findLast(
    (item) => item.type === "agent_message",
  )!;
  const completion = completed.items.findLast(
    (item) => item.type === "turn_completed",
  )!;
  await (
    await server.startTurn(source.id, "Later input must not be copied")
  ).done;
  const before = await server.readThread(source.id);
  const fork = await server.forkThread({
    sourceThreadId: source.id,
    through: { type: "item", itemId: selected.id },
    workspace: { type: "same-directory" },
  });
  assert.equal(fork.turns[0]?.status, "completed");
  assert.equal(fork.turns.length, 1);
  assert.equal(
    fork.items.some((item) => item.type === "turn_aborted"),
    false,
  );
  const copiedFinal = fork.items.findLast(
    (item) => item.type === "agent_message",
  );
  assert.equal(
    copiedFinal?.text,
    selected.type === "agent_message" ? selected.text : null,
  );
  const copiedCompletion = fork.items.findLast(
    (item) => item.type === "turn_completed",
  );
  assert.deepEqual(
    copiedCompletion && {
      ...copiedCompletion,
      id: completion.id,
      threadId: completion.threadId,
    },
    completion,
  );
  assert.equal(
    fork.itemList.some((item) => JSON.stringify(item).includes("Later input")),
    false,
  );
  const summary = (await server.listThreadSummaries()).find(
    (item) => item.threadId === fork.id,
  );
  assert.equal(summary?.status, "idle");
  assert.equal(
    summary?.lastTurnEnd,
    undefined,
    "inherited completion is not new local execution",
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(await server.readThread(source.id), before);
  await journal.close();
  coldJournal = new DomainThreadJournal({
    directory,
    trace: new FileTraceStore(path.join(root, "trace")),
    metadata,
  });
  const restored = createServer(model, {
    journal: coldJournal,
    idPrefix: "restored",
  });
  const cold = await restored.readThread(fork.id);
  assert.equal(cold.turns[0]?.status, "completed");
  assert.deepEqual(cold.itemList, fork.itemList);
  const again = await restored.forkThread({
    sourceThreadId: fork.id,
    through: { type: "item", itemId: copiedFinal!.id },
    workspace: { type: "same-directory" },
  });
  assert.equal(again.turns[0]?.status, "completed");
  await (
    await restored.startTurn(fork.id, "Explicit continuation")
  ).done;
  assert.equal(requests.length, 3);
  assert.doesNotMatch(
    JSON.stringify(requests.at(-1)),
    /Later input|Exact final answer 2/,
  );
});
