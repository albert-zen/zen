import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { type AppServerEvent, ZenAppServer } from "../src/app-server.js";
import type {
  CanonicalItem,
  ThreadMetadataItem,
  UserMessageItem,
} from "../src/item.js";
import {
  InMemoryThreadJournal,
  JsonlThreadJournal,
  type ThreadJournal,
} from "../src/journal.js";
import { StaticModelCatalog, type ModelCatalog } from "../src/model-catalog.js";
import {
  FakeModel,
  type ModelAdapter,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest,
} from "../src/model.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { AgentRuntime } from "../src/runtime.js";
import {
  InMemoryThreadMetadataStore,
  JsonlThreadMetadataStore,
  type ThreadMetadataStore,
} from "../src/thread-metadata.js";
import { ShellToolExecutor, type ToolExecutor } from "../src/tool.js";

function createServer(
  options: {
    journal?: ThreadJournal;
    approvalPolicy?: "always" | "never";
    model?: ModelAdapter;
    modelCatalog?: ModelCatalog;
    threadMetadata?: ThreadMetadataStore;
    tools?: ToolExecutor;
    idFactory?: () => string;
    runtimeIdFactory?: () => string;
  } = {},
): ZenAppServer {
  return new ZenAppServer({
    journal: options.journal ?? new InMemoryThreadJournal(),
    runtime: new AgentRuntime({
      model: options.model ?? new FakeModel(),
      tools: options.tools ?? new ShellToolExecutor(),
      ...(options.runtimeIdFactory === undefined
        ? {}
        : { idFactory: options.runtimeIdFactory }),
    }),
    modelCatalog:
      options.modelCatalog ??
      new StaticModelCatalog([{ id: "fake", isDefault: true }]),
    threadMetadata: options.threadMetadata ?? new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      model: options.modelCatalog?.defaultModel().id ?? "fake",
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
    { role: "user", text: "first" },
    { role: "assistant", text: "model-one" },
    { role: "user", text: "second" },
  ]);
  assert.deepEqual(
    changed.items
      .filter((item) => item.type === "thread_configuration_changed")
      .map((item) => item.model),
    [{ from: "model-one", to: "model-two" }],
  );

  const replayed = createServer({ journal, model, modelCatalog: catalog });
  const replayedSnapshot = await replayed.readThread(thread.id);
  assert.equal(replayedSnapshot.model, "model-two");
  assert.deepEqual(
    replayedSnapshot.turns.map((turn) => turn.model),
    ["model-one", "model-two"],
  );
});

test("allows active-turn model no-ops but rejects real changes", async () => {
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
  await assert.rejects(
    server.updateThreadSettings(thread.id, { model: "other" }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "thread_busy",
  );
  releaseModel?.();
  await active.done;
  assert.equal((await server.readThread(thread.id)).model, "fake");
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

test("validates canonical items before appending them to the journal", async () => {
  const journal = new InMemoryThreadJournal();
  const server = createServer({
    journal,
    idFactory: () => "duplicate-id",
    runtimeIdFactory: () => "duplicate-id",
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "must not persist");

  await assert.rejects(turn.done, /Duplicate item id duplicate-id/u);
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

function createStubTools(execute: ToolExecutor["execute"]): ToolExecutor {
  return {
    definitions: new ShellToolExecutor().definitions,
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
        "agent_message",
        "turn_completed",
      ],
    );
    assert(!contents.includes("item_delta"));
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
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
  const server = createServer({ journal, model: slowModel });

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
  const turn = await server.startTurn(thread.id, "!shell printf approved", {
    requestApproval: async () => "accept",
  });
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

test("provider credentials are absent from shell output and canonical items", async () => {
  const providerKey = "sk-provider-key-must-not-enter-the-thread";
  const blockedPath = "/provider-secret/path";
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zen-credential-filter-"),
  );
  try {
    const secretFile = path.join(temporaryDirectory, "provider-secrets");
    await writeFile(secretFile, `${providerKey}|${blockedPath}`, "utf8");
    const executor = new ShellToolExecutor({
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
      `const inherited = [process.env.OPENAI_API_KEY ?? "", process.env.PATH ?? ""]`,
      `const secrets = fs.readFileSync(process.argv[1], "utf8")`,
      `process.stdout.write(inherited.join("|") + "|" + secrets)`,
      `process.stderr.write("|" + secrets)`,
    ].join("; ");
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)} ${JSON.stringify(secretFile)}`;
    const turn = await server.startTurn(thread.id, `!shell ${command}`);
    await turn.done;

    const snapshot = await server.readThread(thread.id);
    const result = snapshot.items.find((item) => item.type === "tool_result");
    assert(result?.type === "tool_result");
    assert.equal(result.exitCode, 0);
    assert(result.output.includes("||"));
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

test("approval errors record results for the failed and abandoned calls", async () => {
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
      ["call_two", 125],
    ],
  );
  assert.equal(snapshot.turns[0]?.status, "failed");
});

test("execution errors record results for the failed and abandoned calls", async () => {
  const tools = createStubTools(async () => {
    throw new Error("execution exploded");
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
      ["call_two", 125],
    ],
  );
  assert.equal(snapshot.turns[0]?.status, "failed");
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
    const tools = new ShellToolExecutor({ terminationGraceMs: 25 });
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
    /requires provider original-provider, but this host provides fake/u,
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
      { id: "provider-model" },
    ]),
  });
  const thread = await server.startThread({ model: "provider-model" });
  const turn = await server.startTurn(thread.id, "use the tool");
  await turn.done;

  assert.equal(requestBodies.length, 2);
  const secondMessages = requestBodies[1]?.messages;
  assert(Array.isArray(secondMessages));
  assert(
    secondMessages.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "tool_calls" in message,
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
  assert.equal(
    snapshot.items.find((item) => item.type === "agent_message")?.text,
    "provider complete",
  );
});
