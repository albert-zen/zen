import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { shellPrintCommand } from "./fixtures.js";

import { type AppServerEvent, ZenAppServer } from "../src/app-server.js";
import type {
  CanonicalItem,
  ThreadMetadataItem,
  UserMessageItem,
} from "../src/item.js";
import { textFromUserMessage } from "../src/item.js";
import {
  InMemoryThreadJournal,
  JsonlThreadJournal,
  type ThreadJournal,
} from "../src/journal.js";
import { StaticModelCatalog, type ModelCatalog } from "../src/model-catalog.js";
import {
  FakeModel,
  compileModelMessages,
  type ModelAdapter,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest,
  type ReasoningModelMessage,
} from "../src/model.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import {
  projectCompletedItem,
  projectThread,
} from "../src/protocol/codex/mapper.js";
import { AgentRuntime, type RunTurnOptions } from "../src/runtime.js";
import {
  InMemoryThreadMetadataStore,
  JsonlThreadMetadataStore,
  type ThreadMetadataStore,
} from "../src/thread-metadata.js";
import { ShellToolRuntime, type ToolRuntime } from "../src/tool.js";
import {
  testExecutorEnvironment,
  testToolEnvironment,
  type TestToolExecutor,
} from "./tool-fixtures.js";

function createServer(
  options: {
    journal?: ThreadJournal;
    approvalPolicy?: "always" | "never";
    model?: ModelAdapter;
    modelCatalog?: ModelCatalog;
    threadMetadata?: ThreadMetadataStore;
    tools?: TestToolExecutor | ToolRuntime;
    idFactory?: () => string;
    runtimeIdFactory?: () => string;
    runtime?: AgentRuntime;
  } = {},
): ZenAppServer {
  const model = options.model ?? new FakeModel();
  const modelCatalog =
    options.modelCatalog ??
    new StaticModelCatalog([{ id: "fake", isDefault: true }]);
  return new ZenAppServer({
    journal: options.journal ?? new InMemoryThreadJournal(),
    runtime:
      options.runtime ??
      new AgentRuntime({
        toolEnvironment:
          options.tools === undefined
            ? testToolEnvironment({ providers: [new ShellToolRuntime()] })
            : "specification" in options.tools
              ? testToolEnvironment({ providers: [options.tools] })
              : testExecutorEnvironment(options.tools),
        ...(options.runtimeIdFactory === undefined
          ? {}
          : { idFactory: options.runtimeIdFactory }),
      }),
    providerRegistry: new ProviderRegistry([
      { providerProfileId: model.provider, adapter: model, modelCatalog },
    ]),
    threadMetadata: options.threadMetadata ?? new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: model.provider,
      modelId: modelCatalog.defaultModel().id,
      reasoningEffort:
        modelCatalog.defaultModel().defaultReasoningEffort ?? "medium",
      sandbox: "danger-full-access",
      approvalPolicy: options.approvalPolicy ?? "never",
    },
    ...(options.idFactory === undefined
      ? {}
      : { idFactory: options.idFactory }),
  });
}

test("requires one visible default while hidden models remain addressable", () => {
  assert.throws(
    () => new StaticModelCatalog([{ id: "model-one" }]),
    /exactly one default model/u,
  );
  assert.throws(
    () =>
      new StaticModelCatalog([
        { id: "model-one", isDefault: true, hidden: true },
      ]),
    /default must be visible/u,
  );
  const catalog = new StaticModelCatalog([
    { id: "model-one", isDefault: true },
    { id: "model-hidden", hidden: true },
  ]);
  assert.equal(catalog.defaultModel().id, "model-one");
  assert.equal(catalog.get("model-hidden")?.hidden, true);
});

test("startThread preserves an explicit cwd over the host default", async () => {
  const server = createServer();
  const requestedCwd = path.join(process.cwd(), "project-thread-cwd-override");

  const thread = await server.startThread({ cwd: requestedCwd });

  assert.equal(thread.cwd, requestedCwd);
  assert.equal(
    thread.items.find(
      (item): item is ThreadMetadataItem => item.type === "thread_metadata",
    )?.cwd,
    requestedCwd,
  );
});

test("preserves credential-matching model and tool trace strings verbatim", async () => {
  const credentialBytes = "credential-bytes";
  const model: ModelAdapter = {
    provider: "trace-provider",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (request.messages.some((message) => message.role === "tool")) {
        yield { type: "text_delta", delta: credentialBytes };
        return;
      }
      yield { type: "text_delta", delta: credentialBytes };
      yield {
        type: "reasoning",
        reasoningContent: credentialBytes,
        summary: credentialBytes,
        contentVisibility: "public",
      };
      yield {
        type: "tool_call",
        callId: credentialBytes,
        name: credentialBytes,
        arguments: { [credentialBytes]: credentialBytes },
      };
    },
  };
  const tools: TestToolExecutor = {
    definitions: [
      {
        name: credentialBytes,
        description: "Return captured trace bytes.",
        inputSchema: { type: "object" },
      },
    ],
    execute: async () => ({ output: credentialBytes, exitCode: 0 }),
  };
  const emittedDeltas: string[] = [];
  const server = createServer({ model, tools });
  server.subscribe((event) => {
    if (event.type === "item_delta") emittedDeltas.push(event.delta);
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "preserve trace")
  ).done;

  const snapshot = await server.readThread(thread.id);
  assert.deepEqual(emittedDeltas, [credentialBytes, credentialBytes]);
  assert.deepEqual(
    snapshot.items
      .filter((item) => item.type === "agent_message")
      .map((item) => item.text),
    [credentialBytes, credentialBytes],
  );
  assert.equal(
    snapshot.items.find((item) => item.type === "reasoning")?.summary,
    credentialBytes,
  );
  const toolCall = snapshot.items.find((item) => item.type === "tool_call");
  assert.equal(toolCall?.callId, credentialBytes);
  assert.equal(toolCall?.name, credentialBytes);
  assert.deepEqual(toolCall?.arguments, {
    [credentialBytes]: credentialBytes,
  });
  assert.equal(
    snapshot.items.find((item) => item.type === "tool_result")?.output,
    credentialBytes,
  );
});

test("persists only the latest usage for a model response even when the stream later fails", async () => {
  const model: ModelAdapter = {
    provider: "usage-provider",
    async *stream(): AsyncIterable<ModelEvent> {
      yield {
        type: "usage",
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 2,
      };
      yield {
        type: "usage",
        inputTokens: 12,
        cachedInputTokens: 8,
        outputTokens: 3,
        reasoningOutputTokens: 1,
      };
      throw new Error("request failed after usage");
    },
  };
  const server = createServer({ model });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "measure usage")
  ).done;

  const snapshot = await server.readThread(thread.id);
  const usage = snapshot.items.filter((item) => item.type === "model_usage");
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0], {
    id: usage[0]?.id,
    threadId: thread.id,
    turnId: usage[0]?.turnId,
    createdAt: usage[0]?.createdAt,
    type: "model_usage",
    modelResponseId: usage[0]?.modelResponseId,
    inputTokens: 12,
    cachedInputTokens: 8,
    outputTokens: 3,
    reasoningOutputTokens: 1,
  });
  assert.equal(
    snapshot.items.find((item) => item.type === "turn_completed")?.status,
    "failed",
  );
});

test("persists opaque reasoning semantics and derives replay selection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-continuation-"));
  const journal = new JsonlThreadJournal(root);
  const seenReasoning: ReasoningModelMessage[][] = [];
  let sample = 0;
  const model: ModelAdapter = {
    provider: "openai-codex",
    async *stream(request): AsyncIterable<ModelEvent> {
      seenReasoning.push(
        structuredClone(
          request.messages.filter(
            (message): message is ReasoningModelMessage =>
              message.role === "reasoning",
          ),
        ),
      );
      sample += 1;
      if (sample === 1) {
        yield {
          type: "reasoning",
          reasoningContent: "opaque-restart-state",
          contentVisibility: "opaque",
          providerItemId: "rs_restart",
        };
        yield {
          type: "tool_call",
          callId: "call-restart",
          name: "restart_tool",
          arguments: {},
        };
        return;
      }
      yield { type: "text_delta", delta: "done" };
    },
  };
  const tools: TestToolExecutor = {
    definitions: [
      {
        name: "restart_tool",
        description: "Return a stable result.",
        inputSchema: { type: "object" },
      },
    ],
    execute: async () => ({ output: "restarted", exitCode: 0 }),
  };

  try {
    const first = createServer({ journal, model, tools });
    const thread = await first.startThread();
    await (
      await first.startTurn(thread.id, "continue privately")
    ).done;
    assert.deepEqual(seenReasoning[1], [
      {
        role: "reasoning",
        reasoningContent: "opaque-restart-state",
        contentVisibility: "opaque",
        providerItemId: "rs_restart",
      },
    ]);

    const restarted = createServer({ journal, model, tools });
    const replayed = await restarted.readThread(thread.id);
    const reasoning = replayed.items.find((item) => item.type === "reasoning");
    assert.ok(reasoning);
    assert.equal(reasoning.summary, undefined);
    assert.equal(reasoning.providerItemId, "rs_restart");
    assert.equal(reasoning.reasoningContent, "opaque-restart-state");
    assert.equal(reasoning.contentVisibility, "opaque");
    assert.deepEqual(projectCompletedItem(reasoning), {
      type: "reasoning",
      id: reasoning.id,
      summary: [],
      content: [],
    });
    assert.equal("providerProfileId" in reasoning, false);
    assert.equal("modelId" in reasoning, false);
    assert.equal("reasoningEffort" in reasoning, false);
    assert.equal(
      JSON.stringify(projectThread(replayed, { includeTurns: true })).includes(
        "opaque-restart-state",
      ),
      false,
    );
    await (
      await restarted.startTurn(thread.id, "after restart")
    ).done;
    assert.deepEqual(seenReasoning.at(-1), [
      {
        role: "reasoning",
        reasoningContent: "opaque-restart-state",
        contentVisibility: "opaque",
        providerItemId: "rs_restart",
      },
    ]);
    assert.equal(
      compileModelMessages(replayed.items, {
        providerProfileId: "other-profile",
        modelId: "fake",
        reasoningEffort: "medium",
      }).some((message) => message.role === "reasoning"),
      false,
    );
    assert.equal(
      compileModelMessages(replayed.items, {
        providerProfileId: "openai-codex",
        modelId: "other-model",
        reasoningEffort: "medium",
      }).some((message) => message.role === "reasoning"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projects public semantic reasoning and keeps legacy summaries readable", () => {
  const base = {
    threadId: "thread-reasoning",
    turnId: "turn-reasoning",
    createdAt: "2026-08-26T00:00:00.000Z",
  };
  assert.deepEqual(
    projectCompletedItem({
      ...base,
      id: "reasoning-public",
      type: "reasoning",
      reasoningContent: "visible reasoning",
      contentVisibility: "public",
    }),
    {
      type: "reasoning",
      id: "reasoning-public",
      summary: [],
      content: ["visible reasoning"],
    },
  );
  assert.deepEqual(
    projectCompletedItem({
      ...base,
      id: "reasoning-summary",
      type: "reasoning",
      reasoningContent: "visible reasoning",
      summary: "provider summary",
      contentVisibility: "public",
    }),
    {
      type: "reasoning",
      id: "reasoning-summary",
      summary: ["provider summary"],
      content: ["visible reasoning"],
    },
  );
  assert.deepEqual(
    projectCompletedItem({
      ...base,
      id: "reasoning-opaque-summary",
      type: "reasoning",
      reasoningContent: "private reasoning",
      summary: "provider summary",
      contentVisibility: "opaque",
    }),
    {
      type: "reasoning",
      id: "reasoning-opaque-summary",
      summary: ["provider summary"],
      content: [],
    },
  );
  assert.deepEqual(
    projectCompletedItem({
      ...base,
      id: "reasoning-opaque",
      type: "reasoning",
      reasoningContent: "private reasoning",
      contentVisibility: "opaque",
    }),
    {
      type: "reasoning",
      id: "reasoning-opaque",
      summary: [],
      content: [],
    },
  );
  assert.deepEqual(
    projectCompletedItem({
      ...base,
      id: "reasoning-legacy",
      type: "reasoning",
      summary: "legacy summary",
    }),
    {
      type: "reasoning",
      id: "reasoning-legacy",
      summary: ["legacy summary"],
      content: [],
    },
  );
});

test("derives each turn model from append-only configuration changes", async () => {
  const journal = new InMemoryThreadJournal();
  const requestedModels: string[] = [];
  const requestedMessages: ModelMessage[][] = [];
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requestedModels.push(request.model);
      requestedMessages.push(structuredClone(request.messages));
      yield { type: "text_delta", delta: request.model };
    },
  };
  const catalog = new StaticModelCatalog([
    { id: "model-one", isDefault: true },
    { id: "model-two" },
  ]);
  const server = createServer({ journal, model, modelCatalog: catalog });
  const thread = await server.startThread({ model: "model-one" });
  await (
    await server.startTurn(thread.id, "first")
  ).done;

  const changed = await server.updateThreadSettings(thread.id, {
    model: "model-two",
  });
  assert.equal(changed.model, "model-two");
  await (
    await server.startTurn(thread.id, "second")
  ).done;

  assert.deepEqual(requestedModels, ["model-one", "model-two"]);
  assert.deepEqual(requestedMessages[1], [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", text: "model-one" },
    { role: "user", content: [{ type: "text", text: "second" }] },
  ]);
  assert.deepEqual(
    changed.items
      .filter((item) => item.type === "thread_configuration_changed")
      .map((item) => ("selection" in item ? item.selection : item.model)),
    [
      {
        from: {
          providerProfileId: "recording",
          modelId: "model-one",
          reasoningEffort: "medium",
        },
        to: {
          providerProfileId: "recording",
          modelId: "model-two",
          reasoningEffort: "medium",
        },
      },
    ],
  );

  const replayed = createServer({ journal, model, modelCatalog: catalog });
  const replayedSnapshot = await replayed.readThread(thread.id);
  assert.equal(replayedSnapshot.model, "model-two");
  assert.deepEqual(
    replayedSnapshot.turns.map((turn) => turn.model),
    ["model-one", "model-two"],
  );
});

test("freezes an active-turn model while real changes apply next", async () => {
  let releaseModel: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const slowModel: ModelAdapter = {
    provider: "slow",
    async *stream(): AsyncIterable<ModelEvent> {
      await waiting;
      yield { type: "text_delta", delta: "done" };
    },
  };
  const server = createServer({
    model: slowModel,
    modelCatalog: new StaticModelCatalog([
      { id: "fake", isDefault: true },
      { id: "other" },
    ]),
  });
  const thread = await server.startThread();

  await assert.rejects(
    server.updateThreadSettings(thread.id, { model: "missing" }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "model_unavailable",
  );
  const active = await server.startTurn(thread.id, "wait");
  const resumed = await server.updateThreadSettings(thread.id, {
    model: "fake",
  });
  assert.equal(resumed.model, "fake");
  const changed = await server.updateThreadSettings(thread.id, {
    model: "other",
  });
  assert.equal(changed.model, "other");
  releaseModel?.();
  await active.done;
  assert.equal((await server.readThread(thread.id)).model, "other");
});

test("rejects archiving a Thread while its Turn is active", async () => {
  let releaseModel: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const slowModel: ModelAdapter = {
    provider: "slow",
    async *stream(): AsyncIterable<ModelEvent> {
      await waiting;
      yield { type: "text_delta", delta: "done" };
    },
  };
  const server = createServer({ model: slowModel });
  const thread = await server.startThread();
  const active = await server.startTurn(thread.id, "wait");

  await assert.rejects(
    server.setThreadArchived(thread.id, true),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "thread_busy",
  );
  assert.equal((await server.readThread(thread.id)).archived, false);

  releaseModel?.();
  await active.done;
  assert.equal(
    (await server.setThreadArchived(thread.id, true)).archived,
    true,
  );
});

test("persists user-facing names outside the canonical ItemList", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zen-thread-metadata-test-"),
  );
  try {
    const journal = new InMemoryThreadJournal();
    const filename = path.join(temporaryDirectory, "thread-metadata.jsonl");
    const server = createServer({
      journal,
      threadMetadata: new JsonlThreadMetadataStore(filename),
    });
    const thread = await server.startThread();

    const named = await server.setThreadName(thread.id, "  Model routing  ");
    assert.equal(named.name, "Model routing");
    assert.equal(
      named.items.some((item) => "name" in item),
      false,
    );

    const replayed = createServer({
      journal,
      threadMetadata: new JsonlThreadMetadataStore(filename),
    });
    assert.equal((await replayed.readThread(thread.id)).name, "Model routing");
    assert.equal((await replayed.listThreads())[0]?.name, "Model routing");
    const events = (await readFile(filename, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            threadId: string;
            name: string;
            updatedAt: string;
          },
      );
    assert.equal(events.length, 1);
    assert.deepEqual(
      { ...events[0], updatedAt: undefined },
      {
        type: "thread_name_set",
        threadId: thread.id,
        name: "Model routing",
        updatedAt: undefined,
      },
    );
    assert.equal(Number.isNaN(Date.parse(events[0]!.updatedAt)), false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("persists archive state as product metadata and filters listings", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zen-thread-archive-test-"),
  );
  try {
    const journal = new InMemoryThreadJournal();
    const filename = path.join(temporaryDirectory, "thread-metadata.jsonl");
    const server = createServer({
      journal,
      threadMetadata: new JsonlThreadMetadataStore(filename),
    });
    const thread = await server.startThread();
    const originalItems = thread.items;

    const archived = await server.setThreadArchived(thread.id, true);
    assert.equal(archived.archived, true);
    assert.deepEqual(archived.items, originalItems);
    assert.deepEqual(await server.listThreads(), []);
    assert.equal(
      (await server.listThreads({ archived: true }))[0]?.id,
      thread.id,
    );
    await server.setThreadName(thread.id, "Archived work");
    assert.equal(
      (await server.listThreads({ archived: true }))[0]?.name,
      "Archived work",
    );
    assert.equal((await server.readThread(thread.id)).id, thread.id);

    const replayed = createServer({
      journal,
      threadMetadata: new JsonlThreadMetadataStore(filename),
    });
    assert.equal((await replayed.readThread(thread.id)).archived, true);
    assert.equal((await replayed.readThread(thread.id)).name, "Archived work");
    await replayed.setThreadArchived(thread.id, false);
    assert.equal((await replayed.listThreads())[0]?.id, thread.id);
    assert.deepEqual(await replayed.listThreads({ archived: true }), []);
    assert.deepEqual(
      (await journal.read(thread.id)).map((item) => item.type),
      ["thread_metadata"],
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("product metadata corruption never blocks canonical threads", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zen-thread-metadata-corrupt-"),
  );
  const filename = path.join(temporaryDirectory, "thread-metadata.jsonl");
  const journal = new InMemoryThreadJournal();
  try {
    await writeFile(filename, "not-json\n", "utf8");
    const server = createServer({
      journal,
      threadMetadata: new JsonlThreadMetadataStore(filename),
    });
    const thread = await server.startThread();
    assert.equal((await server.listThreads()).length, 1);
    assert.deepEqual(await journal.listThreadIds(), [thread.id]);

    const named = await server.setThreadName(thread.id, "Recovered name");
    assert.equal(named.name, "Recovered name");
    const replayed = createServer({
      journal,
      threadMetadata: new JsonlThreadMetadataStore(filename),
    });
    assert.equal((await replayed.readThread(thread.id)).name, "Recovered name");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("product metadata load failures degrade and retry", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zen-thread-metadata-retry-"),
  );
  const filename = path.join(temporaryDirectory, "thread-metadata.jsonl");
  const journal = new InMemoryThreadJournal();
  try {
    await mkdir(filename);
    const server = createServer({
      journal,
      threadMetadata: new JsonlThreadMetadataStore(filename),
    });
    const thread = await server.startThread();
    assert.equal(thread.name, undefined);

    await rm(filename, { recursive: true });
    await writeFile(
      filename,
      `${JSON.stringify({
        type: "thread_name_set",
        threadId: thread.id,
        name: "Retried name",
        updatedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    assert.equal((await server.readThread(thread.id)).name, "Retried name");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("isolates a corrupt journal and lists it as a system error", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zen-corrupt-journal-"),
  );
  const journalDirectory = path.join(temporaryDirectory, "threads");
  const metadata = new InMemoryThreadMetadataStore();
  const journal = new JsonlThreadJournal(journalDirectory);
  try {
    const server = createServer({ journal, threadMetadata: metadata });
    const healthy = await server.startThread();
    await writeFile(
      path.join(journalDirectory, "corrupt-thread.jsonl"),
      "not-json\n",
      "utf8",
    );
    await metadata.setName("corrupt-thread", "Damaged work");

    const listed = await server.listThreads();
    assert.equal(listed.length, 2);
    assert(listed.some((entry) => entry.id === healthy.id));
    const unavailable = listed.find((entry) => entry.id === "corrupt-thread");
    assert(unavailable !== undefined && "status" in unavailable);
    assert.equal(unavailable.status, "systemError");
    assert.equal(unavailable.name, "Damaged work");
    assert.match(unavailable.error, /Invalid JSON/u);
    assert.deepEqual(
      projectThread(unavailable, { includeTurns: false }).status,
      { type: "systemError" },
    );
    await assert.rejects(server.readThread("corrupt-thread"), /Invalid JSON/u);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("validates canonical items before appending them to the journal", async () => {
  const journal = new InMemoryThreadJournal();
  const server = createServer({
    journal,
    idFactory: () => "duplicate-id",
    runtimeIdFactory: () => "duplicate-id",
  });
  const thread = await server.startThread();
  await assert.rejects(
    server.startTurn(thread.id, "must not persist"),
    /Duplicate item id duplicate-id/u,
  );
  assert.deepEqual(
    (await journal.read(thread.id)).map((item) => item.type),
    ["thread_metadata"],
  );
});

function createTwoCallModel(): ModelAdapter {
  return {
    provider: "two-call-test",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (request.messages.some((message) => message.role === "tool")) {
        yield { type: "text_delta", delta: "tools complete" };
        return;
      }
      yield {
        type: "tool_call",
        callId: "call_one",
        name: "shell",
        arguments: { command: "printf one" },
      };
      yield {
        type: "tool_call",
        callId: "call_two",
        name: "shell",
        arguments: { command: "printf two" },
      };
    },
  };
}

function createStubTools(
  execute: TestToolExecutor["execute"],
): TestToolExecutor {
  return {
    definitions: [new ShellToolRuntime().specification],
    execute,
  };
}

function assertEveryToolCallHasOneResult(
  items: readonly CanonicalItem[],
): void {
  const callIds = items
    .filter((item) => item.type === "tool_call")
    .map((item) => item.callId);
  const resultIds = items
    .filter((item) => item.type === "tool_result")
    .map((item) => item.callId);
  assert(callIds.length > 0);
  for (const callId of callIds) {
    assert.equal(
      resultIds.filter((resultId) => resultId === callId).length,
      1,
      `expected exactly one tool_result for ${callId}`,
    );
  }
}

async function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`operation exceeded ${String(milliseconds)}ms`));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function waitForFile(
  filename: string,
  milliseconds: number,
): Promise<string> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try {
      return await readFile(filename, "utf8");
    } catch {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
    }
  }
  throw new Error(`file was not created within ${String(milliseconds)}ms`);
}

async function waitForProcessExit(
  pid: number,
  milliseconds: number,
): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`process ${String(pid)} survived shell interruption`);
}

test("runs a deterministic in-memory turn from append-only items", async () => {
  const server = createServer();
  const events: AppServerEvent[] = [];
  server.subscribe((event) => {
    events.push(event);
  });

  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "hello");
  await turn.done;

  const snapshot = await server.readThread(thread.id);
  assert.deepEqual(
    snapshot.items.map((item) => item.type),
    [
      "thread_metadata",
      "turn_started",
      "user_message",
      "model_usage",
      "agent_message",
      "turn_completed",
    ],
  );
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0]?.status, "completed");
  assert.equal(
    snapshot.items.find((item) => item.type === "agent_message")?.text,
    "Echo: hello",
  );
  assert(events.some((event) => event.type === "item_delta"));
  assert.equal(events.at(-1)?.type, "turn_completed");
});

test("allows more than eight tool rounds when no maximum is configured", async () => {
  let samples = 0;
  const model: ModelAdapter = {
    provider: "many-tools",
    async *stream(): AsyncIterable<ModelEvent> {
      samples += 1;
      if (samples <= 10) {
        yield {
          type: "tool_call",
          callId: `call-${String(samples)}`,
          name: "continue",
          arguments: {},
        };
        return;
      }
      yield { type: "text_delta", delta: "finished" };
    },
  };
  const tools: TestToolExecutor = {
    definitions: [
      {
        name: "continue",
        description: "Continue the deterministic fixture.",
        inputSchema: { type: "object" },
      },
    ],
    execute: async () => ({ output: "continue", exitCode: 0 }),
  };
  const server = createServer({ model, tools });
  const thread = await server.startThread();

  await (
    await server.startTurn(thread.id, "keep working")
  ).done;

  const snapshot = await server.readThread(thread.id);
  assert.equal(samples, 11);
  assert.equal(snapshot.turns[0]?.status, "completed");
  assert.equal(
    snapshot.items.filter((item) => item.type === "tool_result").length,
    10,
  );
  assert.equal(
    snapshot.items.find((item) => item.type === "agent_message")?.text,
    "finished",
  );
});

test("honors an explicitly configured maximum tool round count", async () => {
  let samples = 0;
  const model: ModelAdapter = {
    provider: "bounded-tools",
    async *stream(): AsyncIterable<ModelEvent> {
      samples += 1;
      yield {
        type: "tool_call",
        callId: `call-${String(samples)}`,
        name: "continue",
        arguments: {},
      };
    },
  };
  const tools: TestToolExecutor = {
    definitions: [
      {
        name: "continue",
        description: "Continue the deterministic fixture.",
        inputSchema: { type: "object" },
      },
    ],
    execute: async () => ({ output: "continue", exitCode: 0 }),
  };
  const runtime = new AgentRuntime({
    toolEnvironment: testExecutorEnvironment(tools),
    maxToolRounds: 2,
  });
  const server = createServer({ model, runtime });
  const thread = await server.startThread();

  await (
    await server.startTurn(thread.id, "stop after two")
  ).done;

  const snapshot = await server.readThread(thread.id);
  assert.equal(samples, 3);
  assert.equal(snapshot.turns[0]?.status, "failed");
  assert.equal(
    snapshot.items.filter((item) => item.type === "tool_result").length,
    2,
  );
  assert.match(
    snapshot.items.find((item) => item.type === "failure")?.message ?? "",
    /exceeded 2 tool rounds/u,
  );
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () =>
        new AgentRuntime({
          toolEnvironment: testExecutorEnvironment(tools),
          maxToolRounds: invalid,
        }),
      /Maximum tool rounds/u,
    );
  }
});

test("event observers cannot fail or strand a Turn", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...arguments_: unknown[]) => {
    warnings.push(String(arguments_[0]));
  });
  const server = createServer();
  let observed = 0;
  server.subscribe(() => {
    throw new Error("observer failed");
  });
  server.subscribe(() => {
    observed += 1;
  });
  const thread = await server.startThread();

  await (
    await server.startTurn(thread.id, "hello")
  ).done;

  const snapshot = await server.readThread(thread.id);
  assert.equal(snapshot.turns[0]?.status, "completed");
  assert(observed > 0);
  assert.deepEqual(warnings, [
    "Removed a failing Zen App Server event subscriber",
  ]);
});

test("journal stores only complete canonical items, never deltas", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zen-journal-test-"),
  );
  try {
    const server = createServer({
      journal: new JsonlThreadJournal(temporaryDirectory),
    });
    const thread = await server.startThread();
    const turn = await server.startTurn(thread.id, "stream this");
    await turn.done;

    const contents = await readFile(
      path.join(temporaryDirectory, `${thread.id}.jsonl`),
      "utf8",
    );
    const records = contents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CanonicalItem);
    assert.deepEqual(
      records.map((item) => item.type),
      [
        "thread_metadata",
        "turn_started",
        "user_message",
        "model_usage",
        "agent_message",
        "turn_completed",
      ],
    );
    assert(!contents.includes("item_delta"));
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

test("streams one correlated reasoning lifecycle and journals one complete item", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zen-reasoning-stream-test-"),
  );
  const model: ModelAdapter = {
    provider: "reasoning-stream-test",
    async *stream(): AsyncIterable<ModelEvent> {
      yield { type: "reasoning_started", reasoningId: "sample-reasoning" };
      yield {
        type: "reasoning_summary_delta",
        reasoningId: "sample-reasoning",
        delta: "summary ",
      };
      yield {
        type: "reasoning_content_delta",
        reasoningId: "sample-reasoning",
        delta: "public ",
      };
      yield {
        type: "reasoning_summary_delta",
        reasoningId: "sample-reasoning",
        delta: "complete",
      };
      yield {
        type: "reasoning_content_delta",
        reasoningId: "sample-reasoning",
        delta: "content",
      };
      yield {
        type: "reasoning",
        reasoningId: "sample-reasoning",
        reasoningContent: "public content",
        summary: "summary complete",
        contentVisibility: "public",
      };
      yield { type: "text_delta", delta: "answer" };
    },
  };
  const server = createServer({
    model,
    journal: new JsonlThreadJournal(temporaryDirectory),
  });
  const events: AppServerEvent[] = [];
  server.subscribe((event) => events.push(event));

  try {
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "stream reasoning")
    ).done;

    const reasoningStarted = events.find(
      (event) =>
        event.type === "item_started" && event.itemType === "reasoning",
    );
    assert(reasoningStarted?.type === "item_started");
    const reasoningEvents = events.filter(
      (event) =>
        event.type === "reasoning_summary_delta" ||
        event.type === "reasoning_content_delta",
    );
    assert.deepEqual(
      reasoningEvents.map((event) => ({
        type: event.type,
        itemId: event.itemId,
        delta: event.delta,
      })),
      [
        {
          type: "reasoning_summary_delta",
          itemId: reasoningStarted.itemId,
          delta: "summary ",
        },
        {
          type: "reasoning_content_delta",
          itemId: reasoningStarted.itemId,
          delta: "public ",
        },
        {
          type: "reasoning_summary_delta",
          itemId: reasoningStarted.itemId,
          delta: "complete",
        },
        {
          type: "reasoning_content_delta",
          itemId: reasoningStarted.itemId,
          delta: "content",
        },
      ],
    );
    const completed = events.find(
      (event) =>
        event.type === "item_completed" && event.item.type === "reasoning",
    );
    assert(
      completed?.type === "item_completed" &&
        completed.item.type === "reasoning",
    );
    assert.equal(completed.item.id, reasoningStarted.itemId);
    assert.equal(completed.item.summary, "summary complete");
    assert.equal(completed.item.reasoningContent, "public content");

    const journal = await readFile(
      path.join(temporaryDirectory, `${thread.id}.jsonl`),
      "utf8",
    );
    const records = journal
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CanonicalItem);
    assert.equal(records.filter((item) => item.type === "reasoning").length, 1);
    assert.equal(journal.includes("reasoning_summary_delta"), false);
    assert.equal(journal.includes("reasoning_content_delta"), false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("failed reasoning streams leave no incomplete canonical reasoning", async () => {
  const model: ModelAdapter = {
    provider: "reasoning-stream-failure",
    async *stream(): AsyncIterable<ModelEvent> {
      yield { type: "reasoning_started", reasoningId: "failed-reasoning" };
      yield {
        type: "reasoning_content_delta",
        reasoningId: "failed-reasoning",
        delta: "transient only",
      };
      throw new Error("reasoning stream failed");
    },
  };
  const server = createServer({ model });
  const events: AppServerEvent[] = [];
  server.subscribe((event) => events.push(event));
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "fail reasoning")
  ).done;

  const snapshot = await server.readThread(thread.id);
  assert.equal(
    snapshot.items.some((item) => item.type === "reasoning"),
    false,
  );
  assert(events.some((event) => event.type === "reasoning_content_delta"));
  assert.equal(
    snapshot.items.find((item) => item.type === "failure")?.message,
    "reasoning stream failed",
  );
});

test("aborted reasoning streams leave no incomplete canonical reasoning", async () => {
  const streamed = testDeferred<void>();
  const model: ModelAdapter = {
    provider: "reasoning-stream-abort",
    async *stream(request): AsyncIterable<ModelEvent> {
      yield { type: "reasoning_started", reasoningId: "aborted-reasoning" };
      yield {
        type: "reasoning_summary_delta",
        reasoningId: "aborted-reasoning",
        delta: "transient summary",
      };
      streamed.resolve();
      request.signal.throwIfAborted();
      await new Promise<void>((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        );
      });
    },
  };
  const server = createServer({ model });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "abort reasoning");
  await streamed.promise;
  await server.interruptTurn(thread.id, turn.id);
  await turn.done;

  const snapshot = await server.readThread(thread.id);
  assert.equal(
    snapshot.items.some((item) => item.type === "reasoning"),
    false,
  );
  assert.equal(snapshot.turns[0]?.status, "interrupted");
});

test("partial model deltas are not canonicalized when the model ends incomplete", async () => {
  const incompleteModel: ModelAdapter = {
    provider: "incomplete-test",
    async *stream(): AsyncIterable<ModelEvent> {
      yield { type: "text_delta", delta: "transient partial answer" };
      throw new Error(
        "OpenAI subscription response was incomplete: max_output_tokens",
      );
    },
  };
  const server = createServer({ model: incompleteModel });
  const events: AppServerEvent[] = [];
  server.subscribe((event) => {
    events.push(event);
  });

  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "answer fully");
  await turn.done;

  const snapshot = await server.readThread(thread.id);
  assert(events.some((event) => event.type === "item_delta"));
  assert.equal(
    snapshot.items.some((item) => item.type === "agent_message"),
    false,
  );
  assert.equal(
    snapshot.items.find((item) => item.type === "failure")?.message,
    "OpenAI subscription response was incomplete: max_output_tokens",
  );
  assert.equal(snapshot.turns[0]?.status, "failed");
});

test("canonical items and exposed snapshots are immutable at runtime", async () => {
  const server = createServer();
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "!shell printf immutable");
  await turn.done;

  const snapshot = await server.readThread(thread.id);
  const toolCall = snapshot.items.find((item) => item.type === "tool_call");
  assert(toolCall?.type === "tool_call");
  assert.equal(Object.isFrozen(snapshot.items), true);
  assert.equal(Object.isFrozen(toolCall), true);
  assert.equal(Object.isFrozen(toolCall.arguments), true);

  assert.throws(() => {
    (snapshot.items as CanonicalItem[]).pop();
  }, TypeError);
  assert.throws(() => {
    toolCall.arguments.command = "mutated";
  }, TypeError);

  const unchanged = await server.readThread(thread.id);
  assert.equal(unchanged.items.length, snapshot.items.length);
  assert.equal(
    unchanged.items.find((item) => item.type === "tool_call")?.arguments
      .command,
    "printf immutable",
  );
});

test("derives an interrupted turn after restart without writing a synthetic record", async () => {
  const journal = new InMemoryThreadJournal();
  const threadId = "recovered_thread";
  const oldTurnId = "old_turn";
  const metadata: ThreadMetadataItem = {
    id: "metadata",
    threadId,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "thread_metadata",
    cwd: process.cwd(),
    model: "fake",
    provider: "fake",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  };
  const user: UserMessageItem = {
    id: "old_user",
    threadId,
    turnId: oldTurnId,
    createdAt: "2026-01-01T00:00:01.000Z",
    type: "user_message",
    text: "unfinished",
  };
  await journal.append(metadata);
  await journal.append({
    id: "old_turn_started",
    threadId,
    turnId: oldTurnId,
    createdAt: "2026-01-01T00:00:00.500Z",
    type: "turn_started",
  });
  await journal.append(user);

  const server = createServer({ journal });
  const recovered = await server.readThread(threadId);
  assert.equal(recovered.turns[0]?.status, "interrupted");

  const next = await server.startTurn(threadId, "continue");
  await next.done;
  const snapshot = await server.readThread(threadId);
  assert.equal(snapshot.turns[0]?.status, "interrupted");
  assert(!snapshot.items.some((item) => item.type === "turn_aborted"));
  assert.equal(snapshot.turns[1]?.status, "completed");
});

test("keeps stale open turns interrupted while only the current turn is active", async () => {
  const journal = new InMemoryThreadJournal();
  const threadId = "recovered_while_active";
  const oldTurnId = "old_turn";
  await journal.append({
    id: "metadata",
    threadId,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "thread_metadata",
    cwd: process.cwd(),
    model: "slow",
    provider: "slow",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });
  await journal.append({
    id: "old_turn_started",
    threadId,
    turnId: oldTurnId,
    createdAt: "2026-01-01T00:00:00.500Z",
    type: "turn_started",
  });
  await journal.append({
    id: "old_user",
    threadId,
    turnId: oldTurnId,
    createdAt: "2026-01-01T00:00:01.000Z",
    type: "user_message",
    text: "unfinished",
  });

  let releaseModel!: () => void;
  const modelBarrier = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const slowModel: ModelAdapter = {
    provider: "slow",
    async *stream(request): AsyncIterable<ModelEvent> {
      await modelBarrier;
      request.signal.throwIfAborted();
      yield { type: "text_delta", delta: "done" };
    },
  };
  const server = createServer({
    journal,
    model: slowModel,
    modelCatalog: new StaticModelCatalog([{ id: "slow", isDefault: true }]),
  });

  assert.equal(
    (await server.readThread(threadId)).turns[0]?.status,
    "interrupted",
  );

  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  server.subscribe((event) => {
    if (event.type === "turn_started") {
      markStarted();
    }
  });
  const current = await server.startTurn(threadId, "continue");
  await started;

  for (const snapshot of [
    await server.readThread(threadId),
    ...(await server.listThreads()),
  ]) {
    assert(!("status" in snapshot));
    assert.deepEqual(
      snapshot.turns.map((turn) => [turn.id, turn.status]),
      [
        [oldTurnId, "interrupted"],
        [current.id, "inProgress"],
      ],
    );
  }

  releaseModel();
  await current.done;
});

test("shell tool has a separate approval decision and execution result", async () => {
  const server = createServer({ approvalPolicy: "always" });
  const thread = await server.startThread();
  const turn = await server.startTurn(
    thread.id,
    `!shell ${shellPrintCommand("approved")}`,
    { requestApproval: async () => "accept" },
  );
  await turn.done;

  const snapshot = await server.readThread(thread.id);
  assert.deepEqual(
    snapshot.items.map((item) => item.type),
    [
      "thread_metadata",
      "turn_started",
      "user_message",
      "tool_call",
      "tool_result",
      "agent_message",
      "turn_completed",
    ],
  );
  assert.equal(
    snapshot.items.find((item) => item.type === "tool_result")?.output,
    "approved",
  );
  assertEveryToolCallHasOneResult(snapshot.items);
  assert.equal(snapshot.turns[0]?.status, "completed");
});

test("declined shell call is explicit and is not executed", async () => {
  const server = createServer({ approvalPolicy: "always" });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "!shell printf must-not-run", {
    requestApproval: async () => "decline",
  });
  await turn.done;

  const snapshot = await server.readThread(thread.id);
  const result = snapshot.items.find((item) => item.type === "tool_result");
  assert.equal(result?.exitCode, 126);
  assert.equal(result?.output, "User declined this tool call.");
  assertEveryToolCallHasOneResult(snapshot.items);
});

test("explicit shell redaction removes caller-designated values", async () => {
  const providerKey = "sk-provider-key-must-not-enter-the-thread";
  const blockedPath = "/provider-secret/path";
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zen-credential-filter-"),
  );
  try {
    const secretFile = path.join(temporaryDirectory, "provider-secrets");
    await writeFile(secretFile, `${providerKey}|${blockedPath}`, "utf8");
    const executor = new ShellToolRuntime({
      environment: {
        OPENAI_API_KEY: providerKey,
        PATH: blockedPath,
      },
      blockedEnvironmentVariables: ["OPENAI_API_KEY", "PATH"],
      redactedValues: [providerKey, blockedPath],
    });
    const server = createServer({ tools: executor });
    const thread = await server.startThread();
    const script = [
      `const fs = require("node:fs")`,
      `const inheritedKey = process.env.OPENAI_API_KEY ?? ""`,
      `const inheritedPath = process.env.PATH ?? ""`,
      `const secrets = fs.readFileSync(process.argv[2], "utf8")`,
      `process.stdout.write("KEY=" + inheritedKey + "|PATH=" + inheritedPath + "|" + secrets)`,
      `process.stderr.write("|" + secrets)`,
    ].join("; ");
    const scriptFile = path.join(temporaryDirectory, "credential-fixture.cjs");
    await writeFile(scriptFile, script, "utf8");
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptFile)} ${JSON.stringify(secretFile)}`;
    const turn = await server.startTurn(thread.id, `!shell ${command}`);
    await turn.done;

    const snapshot = await server.readThread(thread.id);
    const result = snapshot.items.find((item) => item.type === "tool_result");
    assert(result?.type === "tool_result");
    assert.equal(result.exitCode, 0);
    assert(result.output.includes("KEY=|PATH="));
    assert.equal(result.output.match(/\[REDACTED\]/gu)?.length, 4);
    assert(!JSON.stringify(snapshot.items).includes(providerKey));
    assert(!JSON.stringify(snapshot.items).includes(blockedPath));
    assertEveryToolCallHasOneResult(snapshot.items);
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

test("cancelled approval records results for the cancelled and abandoned calls", async () => {
  const server = createServer({
    approvalPolicy: "always",
    model: createTwoCallModel(),
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "cancel tools", {
    requestApproval: async () => "cancel",
  });
  await turn.done;

  const snapshot = await server.readThread(thread.id);
  assertEveryToolCallHasOneResult(snapshot.items);
  const results = snapshot.items.filter((item) => item.type === "tool_result");
  assert.deepEqual(
    results.map((result) => [result.callId, result.exitCode]),
    [
      ["call_one", 130],
      ["call_two", 125],
    ],
  );
  assert.equal(snapshot.turns[0]?.status, "interrupted");
});

test("approval errors settle each call and let the model continue", async () => {
  const server = createServer({
    approvalPolicy: "always",
    model: createTwoCallModel(),
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "fail approval", {
    requestApproval: async () => {
      throw new Error("approval exploded");
    },
  });
  await turn.done;

  const snapshot = await server.readThread(thread.id);
  assertEveryToolCallHasOneResult(snapshot.items);
  const results = snapshot.items.filter((item) => item.type === "tool_result");
  assert.deepEqual(
    results.map((result) => [result.callId, result.exitCode]),
    [
      ["call_one", 1],
      ["call_two", 1],
    ],
  );
  assert(!snapshot.items.some((item) => item.type === "failure"));
  assert.equal(snapshot.turns[0]?.status, "completed");
});

test("execution errors settle one result and do not abandon later calls", async () => {
  const executed: string[] = [];
  const tools = createStubTools(async (invocation) => {
    executed.push(invocation.callId);
    if (invocation.callId === "call_one") {
      throw new Error("execution exploded");
    }
    return { output: "second completed", exitCode: 0 };
  });
  const server = createServer({ model: createTwoCallModel(), tools });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "fail execution");
  await turn.done;

  const snapshot = await server.readThread(thread.id);
  assertEveryToolCallHasOneResult(snapshot.items);
  const results = snapshot.items.filter((item) => item.type === "tool_result");
  assert.deepEqual(
    results.map((result) => [result.callId, result.exitCode]),
    [
      ["call_one", 1],
      ["call_two", 0],
    ],
  );
  assert.deepEqual(executed, ["call_one", "call_two"]);
  assert(!snapshot.items.some((item) => item.type === "failure"));
  assert.equal(snapshot.turns[0]?.status, "completed");
});

test("a provider AbortError is tool-local unless the Turn signal is aborted", async () => {
  const tools = createStubTools(async (invocation) => {
    if (invocation.callId === "call_one") {
      throw new DOMException("provider stopped its operation", "AbortError");
    }
    return { output: "second completed", exitCode: 0 };
  });
  const server = createServer({ model: createTwoCallModel(), tools });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "provider abort")
  ).done;

  const snapshot = await server.readThread(thread.id);
  assertEveryToolCallHasOneResult(snapshot.items);
  const results = snapshot.items.filter((item) => item.type === "tool_result");
  assert.deepEqual(
    results.map((result) => [result.callId, result.exitCode]),
    [
      ["call_one", 1],
      ["call_two", 0],
    ],
  );
  assert(!snapshot.items.some((item) => item.type === "turn_aborted"));
  assert.equal(snapshot.turns[0]?.status, "completed");
});

test("preparation errors settle one result and let later calls run", async () => {
  const model: ModelAdapter = {
    provider: "prepare-failure-test",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (request.messages.some((message) => message.role === "tool")) {
        yield { type: "text_delta", delta: "tools complete" };
        return;
      }
      yield {
        type: "tool_call",
        callId: "call_missing",
        name: "missing_tool",
        arguments: {},
      };
      yield {
        type: "tool_call",
        callId: "call_shell",
        name: "shell",
        arguments: { command: "printf prepared" },
      };
    },
  };
  const server = createServer({ model });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "prepare tools")
  ).done;

  const snapshot = await server.readThread(thread.id);
  assertEveryToolCallHasOneResult(snapshot.items);
  const results = snapshot.items.filter((item) => item.type === "tool_result");
  assert.deepEqual(
    results.map((result) => [result.callId, result.exitCode]),
    [
      ["call_missing", 1],
      ["call_shell", 0],
    ],
  );
  assert.match(results[0]?.output ?? "", /Unsupported tool: missing_tool/u);
  assert(!snapshot.items.some((item) => item.type === "failure"));
  assert.equal(snapshot.turns[0]?.status, "completed");
});

test("result normalization errors become failed results and the loop continues", async () => {
  const tools = createStubTools(async (invocation) =>
    invocation.callId === "call_one"
      ? ({ output: 42, exitCode: 0 } as unknown as {
          output: string;
          exitCode: number;
        })
      : { output: "normalized", exitCode: 0 },
  );
  const server = createServer({ model: createTwoCallModel(), tools });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "normalize tools")
  ).done;

  const snapshot = await server.readThread(thread.id);
  assertEveryToolCallHasOneResult(snapshot.items);
  const results = snapshot.items.filter((item) => item.type === "tool_result");
  assert.deepEqual(
    results.map((result) => [result.callId, result.exitCode]),
    [
      ["call_one", 1],
      ["call_two", 0],
    ],
  );
  assert.match(results[0]?.output ?? "", /invalid output or exit code/u);
  assert(!snapshot.items.some((item) => item.type === "failure"));
  assert.equal(snapshot.turns[0]?.status, "completed");
});

test("interrupting an approval records results even when the handler ignores abort", async () => {
  let approvalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    approvalStarted = resolve;
  });
  const server = createServer({
    approvalPolicy: "always",
    model: createTwoCallModel(),
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "interrupt approval", {
    requestApproval: async () => {
      approvalStarted();
      return await new Promise<never>(() => undefined);
    },
  });
  await withDeadline(started, 1000);
  await withDeadline(server.interruptTurn(thread.id, turn.id), 1000);

  const snapshot = await server.readThread(thread.id);
  assertEveryToolCallHasOneResult(snapshot.items);
  const results = snapshot.items.filter((item) => item.type === "tool_result");
  assert.deepEqual(
    results.map((result) => [result.callId, result.exitCode]),
    [
      ["call_one", 130],
      ["call_two", 125],
    ],
  );
  assert.equal(snapshot.turns[0]?.status, "interrupted");
});

test(
  "interrupting a running shell force-kills a TERM-ignoring process group",
  { skip: process.platform === "win32" },
  async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "zen-shell-interrupt-"),
    );
    const marker = path.join(temporaryDirectory, "pids");
    const tools = new ShellToolRuntime({ terminationGraceMs: 25 });
    const server = createServer({ tools });
    const thread = await server.startThread();
    const command = [
      "trap '' TERM",
      `(trap '' TERM; while :; do :; done) & descendant=$!`,
      `printf '%s|%s' "$$" "$descendant" > ${JSON.stringify(marker)}`,
      "wait",
    ].join("; ");
    const turn = await server.startTurn(thread.id, `!shell ${command}`);

    try {
      const pids = (await waitForFile(marker, 1000))
        .split("|")
        .map((value) => Number(value));
      assert.equal(pids.length, 2);
      assert(pids.every((pid) => Number.isInteger(pid) && pid > 0));

      await withDeadline(server.interruptTurn(thread.id, turn.id), 1000);
      for (const pid of pids) {
        await waitForProcessExit(pid, 500);
      }

      const snapshot = await server.readThread(thread.id);
      assertEveryToolCallHasOneResult(snapshot.items);
      const result = snapshot.items.find((item) => item.type === "tool_result");
      assert.equal(result?.exitCode, 130);
      assert.equal(snapshot.turns[0]?.status, "interrupted");
    } finally {
      await rm(temporaryDirectory, { recursive: true });
    }
  },
);

test("persists parallel tool calls before results and recompiles one assistant message", async () => {
  class ParallelToolModel implements ModelAdapter {
    readonly provider = "parallel-test";
    readonly requests: ModelMessage[][] = [];

    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      this.requests.push(structuredClone(request.messages));
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          callId: "call_one",
          name: "shell",
          arguments: { command: "printf one" },
        };
        yield {
          type: "tool_call",
          callId: "call_two",
          name: "shell",
          arguments: { command: "printf two" },
        };
        return;
      }
      yield { type: "text_delta", delta: "both complete" };
    }
  }

  const model = new ParallelToolModel();
  const server = createServer({ model });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "run both");
  await turn.done;

  const snapshot = await server.readThread(thread.id);
  assert.deepEqual(
    snapshot.items.map((item) => item.type),
    [
      "thread_metadata",
      "turn_started",
      "user_message",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
      "agent_message",
      "turn_completed",
    ],
  );
  const secondRequest = model.requests[1];
  assert(secondRequest !== undefined);
  const toolCallMessage = secondRequest.find(
    (message) => message.role === "assistant" && "toolCalls" in message,
  );
  assert(toolCallMessage !== undefined && "toolCalls" in toolCallMessage);
  assert.equal(toolCallMessage.toolCalls.length, 2);
  assert.equal(
    secondRequest.filter((message) => message.role === "tool").length,
    2,
  );
});

test("allows only one active turn per thread under concurrent requests", async () => {
  const server = createServer();
  const thread = await server.startThread();
  const attempts = await Promise.allSettled([
    server.startTurn(thread.id, "first"),
    server.startTurn(thread.id, "second"),
  ]);
  const fulfilled = attempts.filter(
    (
      attempt,
    ): attempt is PromiseFulfilledResult<
      Awaited<ReturnType<typeof server.startTurn>>
    > => attempt.status === "fulfilled",
  );
  const rejected = attempts.filter(
    (attempt): attempt is PromiseRejectedResult =>
      attempt.status === "rejected",
  );
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0]?.reason), /already has a running turn/);
  await fulfilled[0]?.value.done;
});

test("waits for a terminal predecessor handle to settle before starting its successor", async () => {
  const predecessorTerminal = testDeferred<void>();
  const releasePredecessor = testDeferred<void>();
  let runs = 0;
  class DelayedSettlementRuntime extends AgentRuntime {
    override async runTurn(options: RunTurnOptions): Promise<void> {
      await super.runTurn(options);
      runs += 1;
      if (runs !== 1) return;
      predecessorTerminal.resolve();
      await releasePredecessor.promise;
    }
  }
  const runtime = new DelayedSettlementRuntime({
    toolEnvironment: testToolEnvironment({
      providers: [new ShellToolRuntime()],
    }),
  });
  const server = createServer({ runtime });
  const thread = await server.startThread();
  const predecessor = await server.startTurn(thread.id, "first");
  await testWithin(
    predecessorTerminal.promise,
    "predecessor canonical terminal Item before handle settlement",
  );
  assert.equal(
    (await server.readThread(thread.id)).turns[0]?.status,
    "completed",
  );

  let earlyOutcome:
    | PromiseSettledResult<Awaited<ReturnType<typeof server.startTurn>>>
    | undefined;
  const successorOutcome = server.startTurn(thread.id, "second").then(
    (value) => ({ status: "fulfilled", value }) as const,
    (reason: unknown) => ({ status: "rejected", reason }) as const,
  );
  void successorOutcome.then((outcome) => {
    earlyOutcome = outcome;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      earlyOutcome,
      undefined,
      "successor launch must wait while the terminal predecessor handle settles",
    );
  } finally {
    releasePredecessor.resolve();
  }

  await predecessor.done;
  const outcome = await testWithin(
    successorOutcome,
    "successor launch after predecessor handle settlement",
  );
  assert.equal(outcome.status, "fulfilled");
  if (outcome.status === "fulfilled") await outcome.value.done;
});

test("does not let a rejected terminal predecessor handle reject successor admission", async () => {
  const predecessorTerminal = testDeferred<void>();
  const releasePredecessor = testDeferred<void>();
  let runs = 0;
  class RejectedSettlementRuntime extends AgentRuntime {
    override async runTurn(options: RunTurnOptions): Promise<void> {
      await super.runTurn(options);
      runs += 1;
      if (runs !== 1) return;
      predecessorTerminal.resolve();
      await releasePredecessor.promise;
      throw new Error("fixture rejection after canonical terminal");
    }
  }
  const runtime = new RejectedSettlementRuntime({
    toolEnvironment: testToolEnvironment({
      providers: [new ShellToolRuntime()],
    }),
  });
  const server = createServer({ runtime });
  const thread = await server.startThread();
  const predecessor = await server.startTurn(thread.id, "first");
  await testWithin(
    predecessorTerminal.promise,
    "predecessor canonical terminal Item before rejected settlement",
  );
  assert.equal(
    (await server.readThread(thread.id)).turns[0]?.status,
    "completed",
  );

  let earlyOutcome:
    | PromiseSettledResult<Awaited<ReturnType<typeof server.startTurn>>>
    | undefined;
  const successorOutcome = server.startTurn(thread.id, "second").then(
    (value) => ({ status: "fulfilled", value }) as const,
    (reason: unknown) => ({ status: "rejected", reason }) as const,
  );
  void successorOutcome.then((outcome) => {
    earlyOutcome = outcome;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      earlyOutcome,
      undefined,
      "successor launch must wait while the terminal predecessor handle settles",
    );
  } finally {
    releasePredecessor.resolve();
  }

  await assert.rejects(
    predecessor.done,
    /fixture rejection after canonical terminal/u,
  );
  const outcome = await testWithin(
    successorOutcome,
    "successor launch after rejected predecessor settlement",
  );
  assert.equal(outcome.status, "fulfilled");
  if (outcome.status === "fulfilled") await outcome.value.done;
});

test("deduplicates concurrent cold thread loads before starting a turn", async () => {
  const backing = new InMemoryThreadJournal();
  const threadId = "cold_thread";
  await backing.append({
    id: "cold_metadata",
    threadId,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "thread_metadata",
    cwd: process.cwd(),
    model: "fake",
    provider: "fake",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });

  let readCount = 0;
  const journal: ThreadJournal = {
    append: async (item) => {
      await backing.append(item);
    },
    listThreadIds: async () => await backing.listThreadIds(),
    read: async (requestedThreadId) => {
      readCount += 1;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      return await backing.read(requestedThreadId);
    },
  };
  const server = createServer({ journal });

  const attempts = await withDeadline(
    Promise.allSettled([
      server.startTurn(threadId, "first"),
      server.startTurn(threadId, "second"),
    ]),
    1000,
  );
  const winner = attempts.find(
    (
      attempt,
    ): attempt is PromiseFulfilledResult<
      Awaited<ReturnType<typeof server.startTurn>>
    > => attempt.status === "fulfilled",
  );
  assert(winner !== undefined);
  assert.equal(
    attempts.filter((attempt) => attempt.status === "rejected").length,
    1,
  );
  await winner.value.done;

  const snapshot = await server.readThread(threadId);
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0]?.status, "completed");
  assert.equal(readCount, 1);
  assert(snapshot.items.some((item) => item.type === "agent_message"));
});

test("refuses to run a persisted thread through a different provider", async () => {
  const journal = new InMemoryThreadJournal();
  const threadId = "provider_mismatch";
  await journal.append({
    id: "provider_metadata",
    threadId,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "thread_metadata",
    cwd: process.cwd(),
    model: "original-model",
    provider: "original-provider",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });
  const server = createServer({
    journal,
    modelCatalog: new StaticModelCatalog([
      { id: "original-model", isDefault: true },
      { id: "other-model" },
    ]),
  });

  await assert.rejects(
    server.startTurn(threadId, "must not silently switch providers", {
      model: "other-model",
    }),
    /Provider profile is not available from this Zen host: original-provider/u,
  );
  const snapshot = await server.readThread(threadId);
  assert.deepEqual(
    snapshot.items.map((item) => item.type),
    ["thread_metadata"],
  );
});

test("runs an OpenAI-compatible tool round through the same Runtime and ItemList", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const streams = [
    [
      {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_content: "tool reasoning",
              tool_calls: [
                {
                  index: 0,
                  id: "provider_call",
                  function: {
                    name: "shell",
                    arguments: '{"command":"printf provider"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "tool_calls",
          },
        ],
      },
    ],
    [
      {
        choices: [
          {
            index: 0,
            delta: { content: "provider complete" },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      },
    ],
  ];
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://provider.invalid/v1",
    apiKey: "test-key-never-logged",
    fetch: async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      const frames = streams.shift();
      assert(frames !== undefined);
      return new Response(
        `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });
  const server = createServer({
    model,
    modelCatalog: new StaticModelCatalog([
      { id: "fake", isDefault: true },
      {
        id: "vendor/qwen3.8-max",
        supportedReasoningEfforts: ["medium", "high"],
        defaultReasoningEffort: "medium",
      },
    ]),
  });
  const thread = await server.startThread({
    model: "vendor/qwen3.8-max",
    reasoningEffort: "high",
  });
  const turn = await server.startTurn(thread.id, "use the tool");
  await turn.done;

  assert.equal(requestBodies.length, 2);
  assert.deepEqual(
    requestBodies.map((body) => body.reasoning_effort),
    ["high", "high"],
  );
  assert.equal(
    requestBodies.some((body) => "thinking_budget" in body),
    false,
  );
  const secondMessages = requestBodies[1]?.messages;
  assert(Array.isArray(secondMessages));
  assert(
    secondMessages.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "tool_calls" in message &&
        "reasoning_content" in message &&
        message.reasoning_content === "tool reasoning",
    ),
  );
  assert(
    secondMessages.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "tool",
    ),
  );
  const snapshot = await server.readThread(thread.id);
  assert.equal(snapshot.turns[0]?.status, "completed");
  const compatibleReasoning = snapshot.items.find(
    (item) => item.type === "reasoning",
  );
  assert.ok(compatibleReasoning);
  assert.equal(compatibleReasoning.reasoningContent, "tool reasoning");
  assert.equal(compatibleReasoning.contentVisibility, "public");
  assert.equal(
    snapshot.items.find((item) => item.type === "agent_message")?.text,
    "provider complete",
  );
});

test("soft steer stays in one Turn and forces a new sample after streamed output", async () => {
  const firstSampleEntered = testDeferred<void>();
  const releaseFirstSample = testDeferred<void>();
  const requests: ModelMessage[][] = [];
  let sample = 0;
  const model: ModelAdapter = {
    provider: "steer-test",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request.messages));
      sample += 1;
      if (sample === 1) {
        firstSampleEntered.resolve();
        await releaseFirstSample.promise;
        yield { type: "text_delta", delta: "first answer" };
        return;
      }
      yield { type: "text_delta", delta: "steered answer" };
    },
  };
  const server = createServer({ model });
  const events: AppServerEvent[] = [];
  server.subscribe((event) => events.push(event));
  const thread = await server.startThread();
  const active = await server.startTurn(thread.id, "initial request", {
    clientId: "initial-client-id",
  });
  await firstSampleEntered.promise;

  const steered = await server.steerTurn(
    thread.id,
    active.id,
    "follow this correction",
    { clientId: "steer-client-id" },
  );
  assert.equal(steered.id, active.id);
  assert.equal(
    (
      await server.steerTurn(thread.id, active.id, "follow this correction", {
        clientId: "steer-client-id",
      })
    ).id,
    active.id,
  );
  await server.steerTurn(thread.id, active.id, "then preserve the tests", {
    clientId: "steer-client-id-2",
  });
  await assert.rejects(
    server.steerTurn(thread.id, active.id, "conflicting correction", {
      clientId: "steer-client-id",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "idempotency_conflict",
  );

  releaseFirstSample.resolve();
  await active.done;

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], [
    {
      role: "user",
      content: [{ type: "text", text: "initial request" }],
    },
    { role: "assistant", text: "first answer" },
    {
      role: "user",
      content: [{ type: "text", text: "follow this correction" }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "then preserve the tests" }],
    },
  ]);
  const snapshot = await server.readThread(thread.id);
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0]?.id, active.id);
  assert.equal(snapshot.turns[0]?.status, "completed");
  assert.deepEqual(
    snapshot.items
      .filter((item) => item.type === "user_message")
      .map(textFromUserMessage),
    ["initial request", "follow this correction", "then preserve the tests"],
  );
  assert.equal(
    snapshot.items.filter((item) => item.type === "turn_started").length,
    1,
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "item_completed" &&
        event.item.type === "user_message" &&
        event.item.clientId === "steer-client-id",
    ).length,
    1,
  );
});

test("soft steer waits behind a tool result and does not cancel approval", async () => {
  const approvalRequested = testDeferred<void>();
  const releaseApproval = testDeferred<"accept">();
  const requests: ModelMessage[][] = [];
  let sample = 0;
  const model: ModelAdapter = {
    provider: "steer-tool-test",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request.messages));
      sample += 1;
      if (sample === 1) {
        yield {
          type: "tool_call",
          callId: "steer-call",
          name: "shell",
          arguments: { command: "printf tool" },
        };
        return;
      }
      yield { type: "text_delta", delta: "done after correction" };
    },
  };
  const tools: TestToolExecutor = {
    definitions: [
      {
        name: "shell",
        description: "shell",
        inputSchema: { type: "object" },
      },
    ],
    async execute() {
      return { output: "tool complete", exitCode: 0 };
    },
  };
  const server = createServer({
    model,
    tools,
    approvalPolicy: "always",
  });
  const thread = await server.startThread();
  const active = await server.startTurn(thread.id, "use a tool", {
    requestApproval: async () => {
      approvalRequested.resolve();
      return await releaseApproval.promise;
    },
  });
  await testWithin(
    Promise.race([
      approvalRequested.promise,
      active.done.then(() => {
        throw new Error("Turn finished before requesting approval");
      }),
    ]),
    "approval request",
  );

  await server.steerTurn(thread.id, active.id, "change the final response", {
    clientId: "approval-steer",
  });
  assert.equal(requests.length, 1);
  releaseApproval.resolve("accept");
  await testWithin(active.done, "steered approval turn");

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], [
    { role: "user", content: [{ type: "text", text: "use a tool" }] },
    {
      role: "assistant",
      toolCalls: [
        {
          callId: "steer-call",
          name: "shell",
          arguments: { command: "printf tool" },
        },
      ],
    },
    { role: "tool", callId: "steer-call", text: "tool complete", exitCode: 0 },
    {
      role: "user",
      content: [{ type: "text", text: "change the final response" }],
    },
  ]);
});

test("soft steer never acknowledges a failed journal append or crosses a terminal fence", async () => {
  const backing = new InMemoryThreadJournal();
  const journal: ThreadJournal = {
    append: async (item) => {
      if (
        item.type === "user_message" &&
        textFromUserMessage(item) === "must not persist"
      ) {
        throw new Error("steer journal unavailable");
      }
      await backing.append(item);
    },
    listThreadIds: async () => await backing.listThreadIds(),
    read: async (threadId) => await backing.read(threadId),
  };
  const modelEntered = testDeferred<void>();
  const releaseModel = testDeferred<void>();
  const model: ModelAdapter = {
    provider: "steer-failure-test",
    async *stream(): AsyncIterable<ModelEvent> {
      modelEntered.resolve();
      await releaseModel.promise;
      yield { type: "text_delta", delta: "finished" };
    },
  };
  const server = createServer({ journal, model });
  const thread = await server.startThread();
  const active = await server.startTurn(thread.id, "initial");
  await modelEntered.promise;

  await assert.rejects(
    server.steerTurn(thread.id, active.id, "must not persist", {
      clientId: "failed-steer-id",
    }),
    /steer journal unavailable/u,
  );
  assert.equal(
    (await server.readThread(thread.id)).items.some(
      (item) =>
        item.type === "user_message" && item.clientId === "failed-steer-id",
    ),
    false,
  );

  releaseModel.resolve();
  await active.done;
  await assert.rejects(
    server.steerTurn(thread.id, active.id, "too late"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "turn_not_running",
  );
  assert.equal(
    (await server.readThread(thread.id)).items.at(-1)?.type,
    "turn_completed",
  );
});

test("an interrupt that wins the mutation fence rejects a racing soft steer", async () => {
  const modelEntered = testDeferred<void>();
  const releaseModel = testDeferred<void>();
  const model: ModelAdapter = {
    provider: "steer-interrupt-test",
    async *stream(request): AsyncIterable<ModelEvent> {
      modelEntered.resolve();
      await releaseModel.promise;
      request.signal.throwIfAborted();
      yield { type: "text_delta", delta: "too late" };
    },
  };
  const server = createServer({ model });
  const thread = await server.startThread();
  const active = await server.startTurn(thread.id, "wait");
  await modelEntered.promise;

  const interrupted = server.interruptTurn(thread.id, active.id);
  await assert.rejects(
    server.steerTurn(thread.id, active.id, "must lose the fence"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "turn_not_running",
  );
  releaseModel.resolve();
  await interrupted;

  const snapshot = await server.readThread(thread.id);
  assert.equal(snapshot.turns[0]?.status, "interrupted");
  assert.equal(
    snapshot.items.some(
      (item) =>
        item.type === "user_message" &&
        textFromUserMessage(item) === "must lose the fence",
    ),
    false,
  );
});

test("hard steer aborts the fenced Turn and starts one idempotent successor", async () => {
  const firstSampleEntered = testDeferred<void>();
  let samples = 0;
  const model: ModelAdapter = {
    provider: "replace-test",
    async *stream(request): AsyncIterable<ModelEvent> {
      samples += 1;
      if (samples === 1) {
        firstSampleEntered.resolve();
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          );
        });
        return;
      }
      yield { type: "text_delta", delta: "replacement complete" };
    },
  };
  const server = createServer({ model });
  const thread = await server.startThread();
  const active = await server.startTurn(thread.id, "old work");
  await firstSampleEntered.promise;

  const replacementRequest = server.replaceTurn(
    thread.id,
    active.id,
    "new direction",
    { clientId: "replace-client-id" },
  );
  const concurrentRetry = server.replaceTurn(
    thread.id,
    active.id,
    "new direction",
    { clientId: "replace-client-id" },
  );
  const [replacement, concurrentDuplicate] = await Promise.all([
    replacementRequest,
    concurrentRetry,
  ]);
  assert.equal(replacement.interruptedTurnId, active.id);
  assert.notEqual(replacement.turn.id, active.id);
  assert.equal(concurrentDuplicate.turn.id, replacement.turn.id);
  await replacement.turn.done;

  const duplicate = await server.replaceTurn(
    thread.id,
    active.id,
    "new direction",
    { clientId: "replace-client-id" },
  );
  assert.equal(duplicate.turn.id, replacement.turn.id);
  await assert.rejects(
    server.replaceTurn(thread.id, active.id, "conflicting direction", {
      clientId: "replace-client-id",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "idempotency_conflict",
  );
  await assert.rejects(
    server.replaceTurn(thread.id, active.id, "late replacement", {
      clientId: "late-replacement-id",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "turn_not_running",
  );

  const snapshot = await server.readThread(thread.id);
  assert.deepEqual(
    snapshot.turns.map((turn) => [turn.id, turn.status]),
    [
      [active.id, "interrupted"],
      [replacement.turn.id, "completed"],
    ],
  );
  const relevant = snapshot.items.filter(
    (item) =>
      item.type === "turn_replacement_requested" ||
      item.type === "turn_aborted" ||
      item.type === "turn_started" ||
      item.type === "user_message",
  );
  assert.deepEqual(
    relevant.map((item) => item.type),
    [
      "turn_started",
      "user_message",
      "turn_replacement_requested",
      "turn_aborted",
      "turn_started",
      "user_message",
    ],
  );
  const successorInput = relevant.at(-1);
  assert.equal(
    successorInput?.type === "user_message"
      ? successorInput.clientId
      : undefined,
    "replace-client-id",
  );
  assert.equal(
    snapshot.items.filter((item) => item.type === "turn_replacement_requested")
      .length,
    1,
  );
});

test("hard steer resumes only by explicit retry after the abort/start durable gap", async () => {
  const backing = new InMemoryThreadJournal();
  let startedItems = 0;
  let failSuccessorStart = true;
  const journal: ThreadJournal = {
    append: async (item) => {
      if (item.type === "turn_started") {
        startedItems += 1;
        if (startedItems === 2 && failSuccessorStart) {
          failSuccessorStart = false;
          throw new Error("successor start journal failure");
        }
      }
      await backing.append(item);
    },
    listThreadIds: async () => await backing.listThreadIds(),
    read: async (threadId) => await backing.read(threadId),
  };
  const oldSampleEntered = testDeferred<void>();
  let samples = 0;
  const model: ModelAdapter = {
    provider: "replace-retry-test",
    async *stream(request): AsyncIterable<ModelEvent> {
      samples += 1;
      if (samples === 1) {
        oldSampleEntered.resolve();
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          );
        });
        return;
      }
      yield { type: "text_delta", delta: "retried successor" };
    },
  };
  const firstHost = createServer({ journal, model });
  const thread = await firstHost.startThread();
  const active = await firstHost.startTurn(thread.id, "old work");
  await oldSampleEntered.promise;

  await assert.rejects(
    firstHost.replaceTurn(thread.id, active.id, "retry this replacement", {
      clientId: "replace-retry-id",
    }),
    /successor start journal failure/u,
  );
  const interrupted = await firstHost.readThread(thread.id);
  const intent = interrupted.items.find(
    (item) => item.type === "turn_replacement_requested",
  );
  assert(intent !== undefined);
  assert.equal(interrupted.turns[0]?.status, "interrupted");
  assert.equal(
    interrupted.items.some(
      (item) =>
        item.type === "turn_started" && item.turnId === intent.successorTurnId,
    ),
    false,
  );

  const restarted = createServer({ journal, model });
  const recovered = await restarted.replaceTurn(
    thread.id,
    active.id,
    "retry this replacement",
    { clientId: "replace-retry-id" },
  );
  assert.equal(recovered.turn.id, intent.successorTurnId);
  await recovered.turn.done;
  const snapshot = await restarted.readThread(thread.id);
  assert.deepEqual(
    snapshot.turns.map((turn) => turn.status),
    ["interrupted", "completed"],
  );
  assert.equal(
    snapshot.items.filter(
      (item) =>
        item.type === "user_message" && item.clientId === "replace-retry-id",
    ).length,
    1,
  );
});

function testDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T extends void ? void : T) => void;
} {
  let resolve!: (value: T extends void ? void : T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise as (value: T extends void ? void : T) => void;
  });
  return { promise, resolve };
}

async function testWithin<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
