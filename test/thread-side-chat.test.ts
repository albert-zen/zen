import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { ZenAppServer } from "../src/app-server.js";
import {
  InMemoryThreadJournal,
  JsonlThreadJournal,
  type ThreadJournal,
} from "../src/journal.js";
import { decodeCanonicalItem, type CanonicalItem } from "../src/item.js";
import {
  compileItemList,
  contextItemsFromLegacy,
  type ContextItem,
} from "../src/item-list.js";
import { DomainThreadJournal } from "../src/domain-journal.js";
import { FileTraceStore } from "../src/trace.js";
import { testToolRuntime } from "./tool-fixtures.js";
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from "../src/model.js";
import { estimateModelMessageInputTokens } from "../src/model-usage.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolEnvironment, type ToolRuntime } from "../src/tool.js";

function semanticMessages(history: readonly CanonicalItem[]) {
  const context: ContextItem[] = [];
  for (const [index, item] of history.entries())
    context.push(
      ...contextItemsFromLegacy(item, history.slice(0, index), index, context),
    );
  return compileItemList(context).messages;
}

function fixture(
  options: {
    journal?: ThreadJournal;
    stream?(request: ModelRequest): AsyncIterable<ModelEvent>;
    tools?: ToolRuntime[];
    contextWindow?: number;
  } = {},
) {
  const requests: ModelRequest[] = [];
  const model: ModelAdapter = {
    provider: "test",
    async *stream(request) {
      requests.push(request);
      if (options.stream) yield* options.stream(request);
      else yield { type: "text_delta", delta: "reply" };
    },
  };
  const journal = options.journal ?? new InMemoryThreadJournal();
  const server = new ZenAppServer({
    journal,
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
            contextWindow: options.contextWindow ?? 32768,
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
  });
  return { server, requests, journal };
}

test("Side chat from an empty parent durably appends its identity instruction without creating a Turn", async () => {
  const f = fixture();
  const parent = await f.server.startThread();
  const child = await f.server.createChildThread({
    parentThreadId: parent.id,
    mode: "side-chat",
  });
  assert.equal(child.parentThreadId, parent.id);
  assert.deepEqual(child.turns, []);
  assert.equal(f.requests.length, 0);
  const instruction = child.items.at(-1)!;
  assert.equal(instruction.type, "thread_instruction");
  assert.equal(instruction.turnId, undefined);
  assert.match(JSON.stringify(instruction), /side chat/i);
  assert.match(JSON.stringify(instruction), /not the main thread/i);
  assert.match(JSON.stringify(instruction), /explicit user request/i);
  assert.match(JSON.stringify(instruction), /do not begin/i);
  assert.equal(
    decodeCanonicalItem(JSON.parse(JSON.stringify(instruction))).type,
    "thread_instruction",
  );
  assert.match(
    JSON.stringify(compileItemList(child.itemList!).messages),
    /explicit user request/i,
  );
  assert.deepEqual((await f.server.readThread(parent.id)).items, parent.items);
  const reloaded = fixture({ journal: f.journal });
  assert.deepEqual(
    (await reloaded.server.readThread(child.id)).items,
    child.items,
  );
  assert.equal(reloaded.requests.length, 0);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("Side chat preserves the exact open-time history and semantic context prefixes", async () => {
  const f = fixture();
  const parent = await f.server.startThread();
  await (
    await f.server.startTurn(parent.id, "before opening")
  ).done;
  const opened = await f.server.readThread(parent.id);
  const snapshot = {
    itemId: opened.items.at(-1)!.id,
    contextItemId: opened.itemList!.at(-1)?.id ?? null,
  };
  await (
    await f.server.startTurn(parent.id, "after opening")
  ).done;
  const advanced = await f.server.readThread(parent.id);
  const child = await f.server.createChildThread({
    parentThreadId: parent.id,
    mode: "side-chat",
    snapshot,
  });
  assert.equal(child.parentThreadId, parent.id);
  assert.match(JSON.stringify(child.items), /before opening/);
  assert.doesNotMatch(JSON.stringify(child.items), /after opening/);
  assert.match(
    JSON.stringify(compileItemList(child.itemList!).messages),
    /before opening/,
  );
  assert.doesNotMatch(
    JSON.stringify(compileItemList(child.itemList!).messages),
    /after opening/,
  );
  assert.equal(
    f.requests.length,
    2,
    "opening the side chat starts no model request",
  );
  assert.deepEqual(
    (await f.server.readThread(parent.id)).items,
    advanced.items,
  );
});

test("Side chat rejects missing snapshot boundaries instead of copying newer history", async () => {
  const f = fixture();
  const parent = await f.server.startThread();
  await assert.rejects(
    f.server.createChildThread({
      parentThreadId: parent.id,
      mode: "side-chat",
      snapshot: { itemId: "missing", contextItemId: null },
    }),
    /snapshot.*unavailable/i,
  );
  await assert.rejects(
    f.server.createChildThread({
      parentThreadId: parent.id,
      mode: "side-chat",
      snapshot: { itemId: parent.items.at(-1)!.id, contextItemId: "missing" },
    }),
    /snapshot.*unavailable/i,
  );
});

test("Side chat snapshots the active full tail, cancels inherited work, and waits for its first explicit ask", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let toolsExecuted = 0;
  let initialSample = true;
  const f = fixture({
    stream: async function* () {
      if (initialSample) {
        initialSample = false;
        yield {
          type: "tool_call",
          callId: "parent-call",
          name: "parent-tool",
          arguments: { topic: "parent task" },
        };
      } else {
        yield { type: "text_delta", delta: "done" };
      }
    },
    tools: [
      {
        name: "parent-tool",
        specification: {
          name: "parent-tool",
          description: "Parent task",
          inputSchema: { type: "object" },
        },
        execute: async () => {
          toolsExecuted += 1;
          entered.resolve();
          await release.promise;
          return { output: "real parent result", exitCode: 0 };
        },
      },
    ],
  });
  const parent = await f.server.startThread();
  const active = await f.server.startTurn(parent.id, "work only in parent");
  try {
    await Promise.race([
      entered.promise,
      active.done.then(() => {
        throw new Error("Parent finished before tool entered");
      }),
    ]);
    await f.server.steerTurn(parent.id, active.id, "latest parent guidance", {
      clientId: "steer",
    });
    await f.server.queueMessage(
      parent.id,
      "queued parent work",
      "parent-queue",
    );
    const before = await f.server.readThread(parent.id);
    const events: string[] = [];
    const dispose = f.server.subscribe((event) => {
      events.push(event.type);
    });
    const child = await f.server.createChildThread({
      parentThreadId: parent.id,
      mode: "side-chat",
    });
    dispose();
    assert.deepEqual(events, ["thread_started"]);
    assert.equal(f.requests.length, 1);
    assert.equal(toolsExecuted, 1);
    assert.deepEqual(
      (await f.server.readThread(parent.id)).items,
      before.items,
    );
    assert.equal(
      (await f.server.readThread(parent.id)).turns.at(-1)?.status,
      "inProgress",
    );
    assert.equal(child.turns.at(-1)?.status, "interrupted");
    assert.deepEqual(
      child.items.slice(0, before.items.length).map((item) => item.type),
      before.items.map((item) => item.type),
    );
    assert(
      child.items.some(
        (item) =>
          item.type === "user_message" &&
          item.content?.some(
            (part) =>
              part.type === "text" && part.text === "latest parent guidance",
          ),
      ),
    );
    assert(
      child.items.some(
        (item) =>
          item.type === "user_message_queued" &&
          item.clientId === "parent-queue",
      ),
    );
    assert(
      child.items.some(
        (item) =>
          item.type === "user_message_queue_cancelled" &&
          item.clientId === "parent-queue",
      ),
    );
    const snapshotResult = child.items.find(
      (item) => item.type === "tool_result" && item.callId === "parent-call",
    );
    assert(snapshotResult && snapshotResult.type === "tool_result");
    assert.match(
      snapshotResult.output,
      /not executed in (this|the) side chat/i,
    );
    assert.equal(snapshotResult.exitCode, 1);
    assert.equal(snapshotResult.executionStatus, undefined);
    assert.equal(child.items.at(-1)?.type, "thread_instruction");
    await f.server.resumeQueue(child.id);
    assert.equal(f.requests.length, 1);
    await (
      await f.server.startTurn(child.id, "answer my side question")
    ).done;
    assert.equal(toolsExecuted, 1);
    assert.equal(f.requests.length, 2);
    const messages = f.requests[1]!.messages;
    assert.match(JSON.stringify(messages), /latest parent guidance/);
    assert.match(JSON.stringify(messages), /not the main thread/);
    assert.match(JSON.stringify(messages), /answer my side question/);
    assert.doesNotMatch(JSON.stringify(messages), /queued parent work/);
    const calls = messages.flatMap((message) =>
      "toolCalls" in message ? message.toolCalls : [],
    );
    const results = messages.filter((message) => message.role === "tool");
    assert.equal(calls.length, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.callId, calls[0]!.callId);
    assert.deepEqual(
      (await f.server.readThread(parent.id)).items,
      before.items,
    );
  } finally {
    release.resolve();
    await active.done;
  }
});

test("Side chat inherits post-Turn configuration and its instruction survives repeated compaction", async () => {
  const f = fixture();
  const parent = await f.server.startThread();
  await (
    await f.server.startTurn(parent.id, "completed parent context")
  ).done;
  await f.server.setThreadPermissions(parent.id, "workspace-write");
  const child = await f.server.createChildThread({
    parentThreadId: parent.id,
    mode: "side-chat",
  });
  assert.equal(child.sandbox, "workspace-write");
  assert.equal(f.requests.length, 1);
  await (
    await f.server.startTurn(child.id, "first side question")
  ).done;
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await f.server.compactThread(child.id, {
      retention: { mode: "selected-items", itemIds: [] },
    });
    const snapshot = await f.server.readThread(child.id);
    const messages = compileItemList(snapshot.itemList!).messages;
    assert.equal(
      messages.filter(
        (message) =>
          "text" in message && /not the main thread/.test(message.text),
      ).length,
      1,
    );
    await (
      await f.server.startTurn(child.id, `explicit question ${cycle}`)
    ).done;
    assert.match(
      JSON.stringify(f.requests.at(-1)!.messages),
      /not the main thread/,
    );
  }
});

test("JSONL restart preserves Side chat snapshot, instruction, idle status and first-send context", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-side-chat-"));
  const journal = new JsonlThreadJournal(directory);
  try {
    const f = fixture({ journal });
    const parent = await f.server.startThread();
    await (
      await f.server.startTurn(parent.id, "durable parent context")
    ).done;
    const child = await f.server.createChildThread({
      parentThreadId: parent.id,
      mode: "side-chat",
    });
    const restored = fixture({ journal: new JsonlThreadJournal(directory) });
    assert.deepEqual(
      (await restored.server.readThread(child.id)).items,
      child.items,
    );
    const summaries = await restored.server.listThreadSummaries();
    assert.equal(
      summaries.find((summary) => summary.threadId === child.id)?.status,
      "idle",
    );
    assert.equal(restored.requests.length, 0);
    await (
      await restored.server.startTurn(child.id, "new user question")
    ).done;
    assert.equal(restored.requests.length, 1);
    assert.match(
      JSON.stringify(restored.requests[0]!.messages),
      /durable parent context/,
    );
    assert.match(
      JSON.stringify(restored.requests[0]!.messages),
      /explicit user request/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed Side chat atomic creation publishes no child and leaves its parent untouched", async () => {
  class FailingJournal extends InMemoryThreadJournal {
    override async create(): Promise<void> {
      throw new Error("snapshot storage failed");
    }
  }
  const f = fixture({ journal: new FailingJournal() });
  const parent = await f.server.startThread();
  const events: string[] = [];
  const dispose = f.server.subscribe((event) => {
    events.push(event.type);
  });
  await assert.rejects(
    f.server.createChildThread({
      parentThreadId: parent.id,
      mode: "side-chat",
    }),
    /snapshot storage failed/,
  );
  dispose();
  assert.deepEqual(events, []);
  assert.deepEqual(await f.journal.listThreadIds(), [parent.id]);
  assert.deepEqual((await f.server.readThread(parent.id)).items, parent.items);
  assert.equal(f.requests.length, 0);
});

test("thread instructions have no Turn and legacy forks still require a source Turn", () => {
  const base = {
    id: "instruction",
    threadId: "child",
    createdAt: "2026-10-02T00:00:00Z",
  };
  assert.throws(
    () =>
      decodeCanonicalItem({
        ...base,
        type: "thread_instruction",
        text: "wait",
        turnId: "invented",
      }),
    /turnId/,
  );
  assert.throws(
    () =>
      decodeCanonicalItem({ ...base, type: "thread_instruction", text: "" }),
    /empty/,
  );
  const fork = {
    ...base,
    type: "thread_forked",
    sourceThreadId: "parent",
    sourceBoundaryItemId: "metadata",
    workspace: "same-directory",
  };
  assert.throws(() => decodeCanonicalItem(fork), /sourceTurnId/);
  assert.equal(
    decodeCanonicalItem({ ...fork, context: "full" }).type,
    "thread_forked",
  );
});

test("a copied pending parent replacement is historical and cannot block the first Side chat ask", async () => {
  const journal = new InMemoryThreadJournal();
  const f = fixture({ journal });
  const parent = await f.server.startThread();
  await journal.append({
    id: "parent-replacement",
    threadId: parent.id,
    turnId: "old-turn",
    createdAt: "2026-10-02T00:00:00Z",
    type: "turn_replacement_requested",
    successorTurnId: "parent-successor",
    clientId: "parent-replacement-client",
    text: "replace parent task",
  });
  const restored = fixture({ journal });
  const child = await restored.server.createChildThread({
    parentThreadId: parent.id,
    mode: "side-chat",
  });
  assert(
    child.items.some((item) => item.type === "turn_replacement_requested"),
  );
  await (
    await restored.server.startTurn(child.id, "explicit side request")
  ).done;
  assert.equal(restored.requests.length, 1);
  assert.doesNotMatch(
    JSON.stringify(restored.requests[0]!.messages),
    /replace parent task/,
  );
  await assert.rejects(
    restored.server.startTurn(parent.id, "unrelated parent request"),
    /unfinished replacement/,
  );
});

test("copied accepted unknown-outcome receipts precede later conversation without replaying historical calls", async () => {
  const journal = new InMemoryThreadJournal();
  const f = fixture({ journal });
  const parent = await f.server.startThread();
  const base = {
    threadId: parent.id,
    turnId: "interrupted-parent",
    createdAt: "2026-10-02T00:00:00Z",
  };
  await journal.append({ ...base, id: "old-start", type: "turn_started" });
  await journal.append({
    ...base,
    id: "old-call",
    type: "tool_call",
    callId: "old-tool",
    name: "shell",
    arguments: { command: "parent command" },
  });
  await journal.append({
    ...base,
    id: "old-abort",
    type: "turn_aborted",
    reason: "parent interruption",
  });
  let executions = 0;
  const restored = fixture({
    journal,
    tools: [
      testToolRuntime({
        name: "shell",
        description: "count any unexpected historical dispatch",
        async execute() {
          executions++;
          return { output: "must not run", exitCode: 0 };
        },
      }),
    ],
  });
  await (
    await restored.server.startTurn(parent.id, "later completed context")
  ).done;
  const recoveredParent = await restored.server.readThread(parent.id);
  const acceptedReceipt = recoveredParent.items.find(
    (item) => item.type === "tool_result",
  )!;
  assert.equal(acceptedReceipt.exitCode, null);
  assert.equal(acceptedReceipt.executionStatus, "unknown");
  const child = await restored.server.createChildThread({
    parentThreadId: parent.id,
    mode: "side-chat",
  });
  await (
    await restored.server.startTurn(child.id, "explicit child question")
  ).done;
  const messages = restored.requests.at(-1)!.messages;
  const callIndex = messages.findIndex(
    (message) =>
      "toolCalls" in message &&
      message.toolCalls.some((call) => call.callId === "old-tool"),
  );
  assert(callIndex >= 0);
  assert.equal(messages[callIndex + 1]?.role, "tool");
  assert.deepEqual(messages[callIndex + 1], {
    role: "tool",
    callId: acceptedReceipt.callId,
    text: `Outcome: unknown\n${acceptedReceipt.output}`,
    exitCode: null,
  });
  assert.equal(executions, 0);
  assert.deepEqual(
    await restored.server.readThread(parent.id),
    recoveredParent,
  );
  assert(
    messages.findIndex(
      (message) =>
        "content" in message &&
        message.content.some(
          (part) =>
            part.type === "text" && part.text === "later completed context",
        ),
    ) >
      callIndex + 1,
  );
});

test("copied agentic reset tool receipts remain outside the effective compacted context", () => {
  const base = {
    threadId: "child",
    turnId: "parent-active",
    createdAt: "2026-10-02T00:00:00Z",
  };
  const messages = semanticMessages([
    {
      ...base,
      id: "source",
      type: "user_message",
      text: "covered parent input",
    },
    {
      ...base,
      id: "reset-call",
      type: "tool_call",
      callId: "reset",
      modelResponseId: "reset-response",
      name: "compact_context",
      arguments: { text: "parent summary" },
    },
    {
      ...base,
      id: "reset-item",
      type: "context_compaction",
      provenance: "agentic",
      initiator: "agent",
      coveredThroughItemId: "source",
      retainedItemIds: [],
      summary: "parent summary",
      callId: "reset",
      sourceModelResponseId: "reset-response",
      algorithmVersion: "agentic-v1",
    },
    {
      ...base,
      id: "snapshot-result",
      type: "tool_result",
      callId: "reset",
      output: "snapshot not executed",
      exitCode: 1,
      contentType: "zen.side-chat-tool-snapshot.v1",
      structuredContent: { status: "snapshot", executed: false },
    },
    {
      id: "instruction",
      threadId: "child",
      createdAt: base.createdAt,
      type: "thread_instruction",
      text: "Side chat waits for user",
    },
    {
      ...base,
      id: "new-input",
      turnId: "child-turn",
      type: "user_message",
      text: "explicit child ask",
    },
  ]);
  assert.equal(
    messages.some((message) => message.role === "tool"),
    false,
  );
  assert.equal(
    messages.some((message) => "toolCalls" in message),
    false,
  );
  assert.match(JSON.stringify(messages), /parent summary/);
  assert.match(JSON.stringify(messages), /Side chat waits for user/);
  assert.match(JSON.stringify(messages), /explicit child ask/);
});

test("generated compaction budgets the full pinned Side chat instructions before committing", async () => {
  const f = fixture({
    contextWindow: 1000,
    stream: async function* (request) {
      assert(
        estimateModelMessageInputTokens(request.messages) <= 1000,
        "provider context window exceeded",
      );
      yield {
        type: "text_delta",
        delta:
          request.debugContext?.purpose === "compaction"
            ? "summary ".repeat(300)
            : "answer",
      };
    },
  });
  let current = await f.server.startThread();
  for (let depth = 0; depth < 3; depth += 1)
    current = await f.server.createChildThread({
      parentThreadId: current.id,
      mode: "side-chat",
    });
  await (
    await f.server.startTurn(current.id, "question")
  ).done;
  const before = await f.server.readThread(current.id);
  assert.equal(
    before.turns[0]?.status,
    "completed",
    "fixture must fit complete sampled input before testing compaction target",
  );
  assert.equal(
    before.items.filter((item) => item.type === "thread_instruction").length,
    3,
  );
  await assert.rejects(
    f.server.compactThread(current.id, {
      retention: { mode: "selected-items", itemIds: [] },
    }),
    /token target|projection exceeds/,
  );
  assert.deepEqual((await f.server.readThread(current.id)).items, before.items);
  await (
    await f.server.startTurn(current.id, "next explicit question")
  ).done;
  assert.equal(
    (await f.server.readThread(current.id)).turns.at(-1)?.status,
    "completed",
  );
  assert(estimateModelMessageInputTokens(f.requests.at(-1)!.messages) <= 1000);
});

test("unretained historical calls and their Side chat receipts stay behind a generated compaction boundary", () => {
  const base = {
    threadId: "child",
    turnId: "old-turn",
    createdAt: "2026-10-02T00:00:00Z",
  };
  const messages = semanticMessages([
    {
      ...base,
      id: "old-call",
      type: "tool_call",
      callId: "old",
      name: "shell",
      arguments: {},
    },
    {
      ...base,
      id: "later-context",
      turnId: "later-turn",
      type: "user_message",
      text: "covered later input",
    },
    {
      id: "generated-reset",
      threadId: "child",
      createdAt: base.createdAt,
      type: "context_compaction",
      provenance: "provider_generated",
      initiator: "human",
      coveredThroughItemId: "later-context",
      retainedItemIds: [],
      summary: "effective summary",
      providerProfileId: "test",
      modelId: "model",
      reasoningEffort: "medium",
      algorithmVersion: "v1",
      tokenUsage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      ...base,
      id: "snapshot-result",
      type: "tool_result",
      callId: "old",
      output: "snapshot not executed",
      exitCode: 1,
      contentType: "zen.side-chat-tool-snapshot.v1",
      structuredContent: { status: "snapshot", executed: false },
    },
    {
      id: "instruction",
      threadId: "child",
      createdAt: base.createdAt,
      type: "thread_instruction",
      text: "Side chat waits for user",
    },
  ]);
  assert.equal(
    messages.some((message) => message.role === "tool"),
    false,
  );
  assert.equal(
    messages.some((message) => "toolCalls" in message),
    false,
  );
  assert.match(JSON.stringify(messages), /effective summary/);
  assert.match(JSON.stringify(messages), /Side chat waits for user/);
});

function assertToolProtocol(
  messages: readonly import("../src/model.js").ModelMessage[],
): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      assert(pending.delete(message.callId), `Orphan result ${message.callId}`);
      continue;
    }
    assert.equal(
      pending.size,
      0,
      `Intervening ${message.role} before pending tool results`,
    );
    if ("toolCalls" in message)
      for (const call of message.toolCalls) pending.add(call.callId);
  }
  assert.equal(pending.size, 0, "Unclosed tool-call batch");
}

test("generated selected-item compaction keeps snapshot tool closure in sampling order through restart and first send", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-side-chat-semantic-"));
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
  const initial = fixture({ journal });
  const parent = await initial.server.startThread();
  const base = { threadId: parent.id, createdAt: "2026-10-02T00:00:00Z" };
  for (const item of [
    {
      ...base,
      id: "old-start",
      turnId: "old-turn",
      type: "turn_started" as const,
    },
    {
      ...base,
      id: "old-user",
      turnId: "old-turn",
      type: "user_message" as const,
      text: "old parent task",
    },
    {
      ...base,
      id: "old-call",
      turnId: "old-turn",
      type: "tool_call" as const,
      callId: "old-tool",
      modelResponseId: "old-response",
      name: "shell",
      arguments: { command: "old parent command" },
    },
    {
      ...base,
      id: "old-abort",
      turnId: "old-turn",
      type: "turn_aborted" as const,
      reason: "parent interruption",
    },
    {
      ...base,
      id: "later-start",
      turnId: "later-turn",
      type: "turn_started" as const,
    },
    {
      ...base,
      id: "later-user",
      turnId: "later-turn",
      type: "user_message" as const,
      text: "later parent task",
    },
    {
      ...base,
      id: "later-answer",
      turnId: "later-turn",
      type: "agent_message" as const,
      text: "later answer",
    },
    {
      ...base,
      id: "later-complete",
      turnId: "later-turn",
      type: "turn_completed" as const,
      status: "completed" as const,
    },
  ])
    await journal.append(item);
  const strictStream = async function* (
    request: ModelRequest,
  ): AsyncIterable<ModelEvent> {
    assertToolProtocol(request.messages);
    if (request.debugContext?.purpose === "turn") {
      const activeJournal = coldJournal ?? journal;
      assert.deepEqual(
        request.messages,
        compileItemList(
          await activeJournal.readItemList(request.debugContext.threadId),
        ).messages,
      );
    }
    yield { type: "text_delta", delta: "reply" };
  };
  const f = fixture({ journal, stream: strictStream });
  const child = await f.server.createChildThread({
    parentThreadId: parent.id,
    mode: "side-chat",
  });
  await (
    await f.server.startTurn(child.id, "explicit side question")
  ).done;
  const before = await f.server.readThread(child.id);
  assertToolProtocol(compileItemList(before.itemList!).messages);
  const selected = before.items
    .filter((item) => item.type === "tool_call" || item.type === "user_message")
    .map((item) => item.id);
  await f.server.compactThread(child.id, {
    retention: { mode: "selected-items", itemIds: selected },
  });
  const after = await f.server.readThread(child.id);
  const projection = compileItemList(after.itemList!).messages;
  assertToolProtocol(projection);
  assert.match(JSON.stringify(projection), /old parent task/);
  assert.match(JSON.stringify(projection), /later parent task/);
  const persisted = await journal.readItemList(child.id);
  assert.deepEqual(persisted, after.itemList);
  await journal.close();
  coldJournal = new DomainThreadJournal({
    directory,
    trace: new FileTraceStore(path.join(root, "trace")),
    metadata,
  });
  const restored = fixture({ journal: coldJournal, stream: strictStream });
  const coldChild = await restored.server.readThread(child.id);
  assert.deepEqual(coldChild.itemList, persisted);
  assert.deepEqual(coldChild.items, after.items);
  assertToolProtocol(compileItemList(coldChild.itemList!).messages);
  assert.equal(restored.requests.length, 0);
  await (
    await restored.server.startTurn(child.id, "next explicit question")
  ).done;
  assert.equal(restored.requests.length, 1);
  assert.equal(
    (await restored.server.readThread(child.id)).turns.at(-1)?.status,
    "completed",
  );
});
