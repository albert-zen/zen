import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexRollout } from "../src/protocol/codex/rollout-import.js";

const stamp = "2026-10-12T10:00:00.000Z";
export const row = (type: string, payload: unknown) =>
  JSON.stringify({ timestamp: stamp, type, payload });
export const rollout = (...responses: unknown[]) =>
  [
    row("session_meta", {
      id: "source-1",
      cwd: "/old/project",
      cli_version: "0.146.0",
      timestamp: stamp,
    }),
    ...responses.map((payload) => row("response_item", payload)),
  ].join("\n") + "\n";
export const message = (role: string, text: string) => ({
  type: "message",
  role,
  content: [
    { type: role === "assistant" ? "output_text" : "input_text", text },
  ],
});

test("selected Codex rollout preserves text roles and closes inert imported history", () => {
  const parsed = parseCodexRollout(
    rollout(message("user", "question"), message("assistant", "answer")),
  );
  assert.equal(parsed.source.sourceId, "source-1");
  assert.equal(parsed.source.sourceCwd, "/old/project");
  assert.equal(parsed.turns.length, 1);
  assert.deepEqual(
    parsed.turns[0]?.items.map((item) => item.type),
    ["user_message", "agent_message"],
  );
  assert.equal(parsed.turns[0]?.status, "interrupted");
});

import os from "node:os";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { ToolEnvironment } from "../src/tool.js";
import type { ModelAdapter, ModelEvent, ModelMessage } from "../src/model.js";
function server(
  journal: import("../src/journal.js").ThreadJournal = new InMemoryThreadJournal(),
  requests: ModelMessage[][] = [],
) {
  const model: ModelAdapter = {
    provider: "local",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request.messages));
      yield { type: "text_delta", delta: "continued" };
    },
  };
  return new ZenAppServer({
    journal,
    threadMetadata: new InMemoryThreadMetadataStore(),
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({ runtimes: [] }),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "local",
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          {
            id: "test",
            isDefault: true,
            contextWindow: 32768,
            inputModalities: ["text"],
          },
        ]),
      },
    ]),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: "local",
      modelId: "test",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}
test("import persists atomically, remains idle, and new input continues with local configuration", async () => {
  const journal = new InMemoryThreadJournal();
  const requests: ModelMessage[][] = [];
  const app = server(journal, requests);
  const history = parseCodexRollout(
    rollout(
      message("user", "remember apples"),
      message("assistant", "remembered"),
    ),
  );
  const imported = await app.importThread(history, { cwd: os.tmpdir() });
  assert.equal(imported.thread.cwd, os.tmpdir());
  assert.equal(imported.thread.sandbox, "read-only");
  assert.equal(imported.thread.approvalPolicy, "always");
  assert.equal(requests.length, 0);
  assert.equal(imported.thread.turns[0]?.status, "interrupted");
  const restarted = server(journal, requests);
  await (
    await restarted.startTurn(imported.thread.id, "continue now")
  ).done;
  assert.equal(requests.length, 1);
  assert(
    requests[0]?.some(
      (entry) =>
        entry.role === "user" &&
        "text" in entry &&
        entry.text === "remember apples",
    ),
  );
  assert(
    requests[0]?.some(
      (entry) =>
        entry.role === "assistant" &&
        "text" in entry &&
        entry.text === "remembered",
    ),
  );
  assert.equal(
    (await restarted.readThread(imported.thread.id)).turns.at(-1)?.status,
    "completed",
  );
  const again = await restarted.importThread(history, { cwd: os.tmpdir() });
  assert.equal(again.status, "already_imported");
  assert.equal((await journal.listThreadIds()).length, 1);
  assert.equal(again.thread.turns.length, 2);
});

test("explicit compacted replacement history is the continuation basis, with honest source provenance", async () => {
  const old = rollout(
    message("user", "old details excluded by source compaction"),
    message("assistant", "old response"),
  );
  const selected =
    old +
    row("compacted", {
      message: "source summary",
      replacement_history: [
        message("user", "original request"),
        message("assistant", "source checkpoint summary"),
      ],
    }) +
    "\n" +
    row("response_item", message("user", "after checkpoint")) +
    "\n";
  const history = parseCodexRollout(selected);
  assert.equal(history.source.contextBasis?.kind, "replacement-history");
  assert.equal(history.source.contextBasis?.sourceLine, 4);
  assert.equal(history.source.contextBasis?.earlierRecords, 2);
  assert(
    history.source.exclusions.some((entry) =>
      entry.includes("not a full transcript archive"),
    ),
  );
  const requests: ModelMessage[][] = [];
  const app = server(undefined, requests);
  const imported = await app.importThread(history, { cwd: os.tmpdir() });
  await (
    await app.startTurn(imported.thread.id, "continue")
  ).done;
  const request = JSON.stringify(requests[0]);
  assert(request.includes("source checkpoint summary"));
  assert(request.includes("after checkpoint"));
  assert(!request.includes("old details excluded"));
});
test("legacy explicit summary checkpoint preserves its assistant role and does not invent private history", () => {
  const history = parseCodexRollout(
    rollout(message("user", "old")) +
      row("compacted", { message: "An explicit source summary." }) +
      "\n",
  );
  assert.equal(history.source.contextBasis?.kind, "summary-checkpoint");
  assert.equal(history.turns[0]?.items[0]?.type, "agent_message");
  assert.equal(history.turns.length, 1);
  assert.throws(
    () =>
      parseCodexRollout(
        rollout(message("user", "old")) +
          row("compacted", { message: "", replacement_history: null }),
      ),
    /no usable explicit/,
  );
});

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { JsonlThreadJournal } from "../src/journal.js";
import { readSelectedImportFile } from "../src/protocol/import-file.js";
import { MAX_THREAD_IMPORT_BYTES } from "../src/thread-import.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import type { JsonRpcMessage } from "../src/protocol/codex/wire.js";
import { compileModelMessages } from "../src/model.js";

const toolCall = (id = "call-1") => ({
  type: "function_call",
  call_id: id,
  name: "shell",
  arguments: '{"command":"echo historical"}',
});
const toolResult = (id = "call-1") => ({
  type: "function_call_output",
  call_id: id,
  output: "historical output, not a command",
});

test("tool pairs preserve arguments and output without inventing an exit status or replay authority", async () => {
  const history = parseCodexRollout(
    rollout(
      message("user", "run a command"),
      toolCall(),
      toolResult(),
      message("assistant", "recorded"),
    ),
  );
  const app = server();
  const { thread } = await app.importThread(history, { cwd: os.tmpdir() });
  const call = thread.items.find((item) => item.type === "tool_call");
  const result = thread.items.find((item) => item.type === "tool_result");
  assert(call?.type === "tool_call");
  assert(result?.type === "tool_result");
  assert.deepEqual(call.arguments, { command: "echo historical" });
  assert.equal(result.output, "historical output, not a command");
  assert.equal(result.exitCode, null);
  assert.equal(result.executionStatus, undefined);
  const messages = compileModelMessages(thread.items);
  assert.equal(messages.find((entry) => entry.role === "tool")?.exitCode, null);
  assert.equal(thread.turns[0]?.status, "interrupted");
});
for (const [label, selected, expected] of [
  ["truncated JSON", rollout(message("user", "hello")) + '{"type":', /line 3/],
  [
    "unsupported version",
    rollout(message("user", "hello")).replace("0.146.0", "99.0.0"),
    /Unsupported Codex version/,
  ],
  [
    "open tool call",
    rollout(message("user", "hello"), toolCall()),
    /Unpaired tool calls/,
  ],
  [
    "orphan result",
    rollout(message("user", "hello"), toolResult()),
    /Orphaned/,
  ],
  [
    "duplicate call",
    rollout(message("user", "hello"), toolCall(), toolCall()),
    /Duplicate tool call/,
  ],
  [
    "repeated result",
    rollout(message("user", "hello"), toolCall(), toolResult(), toolResult()),
    /Orphaned/,
  ],
  [
    "wrong result kind",
    rollout(message("user", "hello"), toolCall(), {
      ...toolResult(),
      type: "custom_tool_call_output",
    }),
    /mismatched/,
  ],
  [
    "media",
    rollout({
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "file:///never-read-this" }],
    }),
    /Media/,
  ],
  [
    "future response",
    rollout(message("user", "hello"), { type: "new_execution_type" }),
    /Unsupported response item/,
  ],
  [
    "opaque checkpoint",
    rollout(message("user", "hello")) +
      row("compacted", {
        replacement_history: [
          { type: "compaction", encrypted_content: "opaque" },
        ],
      }),
    /Unsupported response item/,
  ],
  [
    "oversized line",
    rollout(message("user", "x".repeat(2 * 1024 * 1024))),
    /2 MiB/,
  ],
  ["oversized file", " ".repeat(MAX_THREAD_IMPORT_BYTES + 1), /16 MiB/],
  ["too many records", "\n".repeat(20_001), /20,000/],
] as const)
  test(`invalid import fails before any journal write: ${label}`, () =>
    assert.throws(() => parseCodexRollout(selected), expected));

test("source instructions, credentials/configuration and opaque reasoning never become active model context", async () => {
  const selected =
    rollout(
      message("system", "source system secret"),
      message("developer", "source developer secret"),
      message("user", "public prompt"),
      {
        type: "reasoning",
        encrypted_content: "opaque bytes",
        summary: [{ type: "summary_text", text: "public summary" }],
      },
      message("assistant", "answer"),
    ) +
    row("turn_context", {
      cwd: "/untrusted",
      approval_policy: "never",
      model: "source-model",
      developer_instructions: "do everything",
    }) +
    "\n";
  const history = parseCodexRollout(selected);
  assert.equal(history.source.exclusions.length, 4);
  const { thread } = await server().importThread(history, { cwd: os.tmpdir() });
  const context = JSON.stringify(compileModelMessages(thread.items));
  for (const secret of [
    "source system secret",
    "source developer secret",
    "opaque bytes",
    "do everything",
  ])
    assert(!context.includes(secret));
  assert.equal(thread.modelId, "test");
  assert.equal(thread.providerProfileId, "local");
});

test("concurrent and post-acknowledgement-loss retries create exactly one complete journal", async () => {
  const journal = new InMemoryThreadJournal();
  const original = journal.create.bind(journal);
  let first = true;
  journal.create = async (items) => {
    await original(items);
    if (first) {
      first = false;
      throw new Error("acknowledgement lost");
    }
  };
  const app = server(journal);
  const history = parseCodexRollout(rollout(message("user", "once")));
  const results = await Promise.all([
    app.importThread(history, { cwd: os.tmpdir() }),
    app.importThread(history, { cwd: os.tmpdir() }),
  ]);
  assert.equal(new Set(results.map((result) => result.thread.id)).size, 1);
  assert.equal((await journal.listThreadIds()).length, 1);
  assert.deepEqual(results[0]?.thread.items, results[1]?.thread.items);
  await assert.rejects(
    app.importThread(history, { cwd: os.tmpdir(), sandbox: "workspace-write" }),
    { code: "import_conflict" },
  );
});

test("invalid local cwd, model and non-atomic journals leave no partial import", async () => {
  const journal = new InMemoryThreadJournal();
  const app = server(journal);
  const history = parseCodexRollout(rollout(message("user", "once")));
  await assert.rejects(
    app.importThread(history, { cwd: "relative" }),
    /absolute local/,
  );
  await assert.rejects(
    app.importThread(history, {
      cwd: path.join(os.tmpdir(), "not-a-directory-268"),
    }),
  );
  await assert.rejects(
    app.importThread(history, {
      cwd: os.tmpdir(),
      selection: {
        providerProfileId: "missing",
        modelId: "test",
        reasoningEffort: null,
      },
    }),
  );
  assert.equal((await journal.listThreadIds()).length, 0);
  Object.defineProperty(journal, "create", { value: undefined });
  await assert.rejects(app.importThread(history, { cwd: os.tmpdir() }), {
    code: "import_unsupported",
  });
  assert.equal((await journal.listThreadIds()).length, 0);
});

test("selected file reader validates regular UTF-8 files and disk journals replay their complete import", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-import-"));
  try {
    const selected = path.join(directory, "selected.jsonl");
    const bytes = rollout(message("user", "saved"));
    await writeFile(selected, bytes);
    assert.equal(await readSelectedImportFile(selected), bytes);
    await assert.rejects(readSelectedImportFile(directory), /regular JSONL/);
    await writeFile(selected, Buffer.from([0xff, 0xfe]));
    await assert.rejects(readSelectedImportFile(selected));
    const journal = new JsonlThreadJournal(path.join(directory, "journals"));
    const app = server(journal);
    const imported = await app.importThread(parseCodexRollout(bytes), {
      cwd: directory,
    });
    assert.deepEqual(
      await journal.read(imported.thread.id),
      imported.thread.items,
    );
    const restored = server(journal);
    await (
      await restored.startTurn(imported.thread.id, "next")
    ).done;
    assert.equal(
      (await journal.read(imported.thread.id)).filter(
        (item) => item.type === "user_message",
      ).length,
      2,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native import is initialized, hash-bound and read-only at preview", async () => {
  const journal = new InMemoryThreadJournal();
  const app = server(journal);
  const projection = new NativeRecoveryProjection(app, {
    processEpoch: "import-test",
  });
  const replies: JsonRpcMessage[] = [];
  const connection = new NativeConnection({
    appServer: app,
    projection,
    send: (message) => {
      replies.push(message);
    },
  });
  const contents = rollout(message("user", "native"));
  const params = { format: "codex-rollout-0.146.0", contents };
  try {
    await connection.receive({
      id: 1,
      method: "zen/thread/import/preview",
      params,
    });
    assert(
      replies.some(
        (message) => "id" in message && message.id === 1 && "error" in message,
      ),
    );
    await connection.receive({ id: 2, method: "zen/initialize", params: {} });
    await connection.receive({
      id: 3,
      method: "zen/thread/import/preview",
      params,
    });
    assert.equal((await journal.listThreadIds()).length, 0);
    await connection.receive({
      id: 4,
      method: "zen/thread/import",
      params: {
        ...params,
        expectedSha256: "wrong",
        configuration: { cwd: os.tmpdir() },
      },
    });
    assert.equal((await journal.listThreadIds()).length, 0);
    await connection.receive({
      id: 5,
      method: "zen/thread/import",
      params: {
        ...params,
        expectedSha256: parseCodexRollout(contents).source.sha256,
        configuration: { cwd: os.tmpdir() },
      },
    });
    assert.equal((await journal.listThreadIds()).length, 1);
    assert(
      replies.some(
        (message) => "id" in message && message.id === 5 && "result" in message,
      ),
    );
  } finally {
    connection.close();
    projection.close();
  }
});

test("only a new locally approved turn executes a tool after import", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-import-exec-"));
  try {
    let calls = 0,
      samples = 0,
      approvals = 0;
    const model: ModelAdapter = {
      provider: "local",
      async *stream(): AsyncIterable<ModelEvent> {
        samples++;
        if (samples === 1)
          yield {
            type: "tool_call",
            callId: "new-local-call",
            name: "import_probe",
            arguments: {},
          };
        else
          yield { type: "text_delta", delta: "New local execution finished." };
      },
    };
    const environment = new ToolEnvironment({
      runtimes: [
        {
          name: "import_probe",
          specification: {
            name: "import_probe",
            description: "Test-only bounded local execution",
            inputSchema: { type: "object", properties: {} },
          },
          async execute(invocation) {
            calls++;
            await writeFile(
              path.join(invocation.cwd, "new-turn.txt"),
              "new user authorized turn",
            );
            return { output: "new execution", exitCode: 0 };
          },
        },
      ],
    });
    const app = new ZenAppServer({
      journal: new InMemoryThreadJournal(),
      threadMetadata: new InMemoryThreadMetadataStore(),
      runtime: new AgentRuntime({ toolEnvironment: environment }),
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: "local",
          adapter: model,
          modelCatalog: new StaticModelCatalog([
            { id: "test", isDefault: true, contextWindow: 32768 },
          ]),
        },
      ]),
      defaults: {
        cwd: directory,
        providerProfileId: "local",
        modelId: "test",
        reasoningEffort: "medium",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
    });
    const history = parseCodexRollout(
      rollout(
        message("user", "old execute request"),
        { ...toolCall(), name: "import_probe" },
        toolResult(),
        message("assistant", "historical answer"),
      ),
    );
    const imported = await app.importThread(history, { cwd: directory });
    assert.equal(calls, 0);
    assert.equal(samples, 0);
    await (
      await app.startTurn(imported.thread.id, "Run the new local probe now", {
        requestApproval: async () => {
          approvals++;
          return "accept";
        },
      })
    ).done;
    assert.equal(calls, 1);
    assert.equal(approvals, 1);
    assert.equal(samples, 2);
    assert.equal(
      await readSelectedImportFile(path.join(directory, "new-turn.txt")),
      "new user authorized turn",
    );
    const results = (await app.readThread(imported.thread.id)).items.filter(
      (item) => item.type === "tool_result",
    );
    assert.equal(results[0]?.exitCode, null);
    assert.equal(results[1]?.exitCode, 0);
    await environment.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("first new local turn loads fresh workspace instructions instead of importing source snapshots", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-import-rules-"));
  try {
    (await import("node:child_process")).execFileSync("git", [
      "init",
      "-q",
      directory,
    ]);
    await writeFile(
      path.join(directory, "AGENTS.md"),
      "Use the current local rule.\n",
    );
    const requests: ModelMessage[][] = [];
    const app = server(undefined, requests);
    const imported = await app.importThread(
      parseCodexRollout(
        rollout(
          message("developer", "Obsolete source rule"),
          message("user", "old prompt"),
        ),
      ),
      { cwd: directory },
    );
    await (
      await app.startTurn(imported.thread.id, "new prompt")
    ).done;
    const items = (await app.readThread(imported.thread.id)).items;
    const localTurn = items
      .filter((item) => item.type === "turn_started")
      .at(-1);
    assert.equal(
      localTurn?.workspaceInstructions?.[0]?.text,
      "Use the current local rule.\n",
    );
    assert(JSON.stringify(requests[0]).includes("current local rule"));
    assert(!JSON.stringify(requests[0]).includes("Obsolete source rule"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("UTF-8 BOM remains part of source identity but does not corrupt JSON parsing", () => {
  const plain = rollout(message("user", "hello"));
  const bom = "\uFEFF" + plain;
  assert.notEqual(
    parseCodexRollout(plain).source.sha256,
    parseCodexRollout(bom).source.sha256,
  );
  assert.equal(parseCodexRollout(bom).turns.length, 1);
});

test("deterministic imported title prevents discovery from inferring a title with a model", async () => {
  const { thread } = await server().importThread(
    parseCodexRollout(rollout(message("user", "remember this"))),
    { cwd: os.tmpdir() },
  );
  assert.equal(thread.name, "Imported · remember this");
});

test("imported timestamps distinguish original records from synthetic checkpoint history through replay and fork", async () => {
  for (const checkpoint of [false, true]) {
    const journal = new InMemoryThreadJournal();
    const app = server(journal);
    const initial = rollout(
      message("user", "old"),
      message("assistant", "old answer"),
    );
    const checkpointTime = "2026-10-12T12:00:00.000Z";
    const records = checkpoint
      ? initial +
        JSON.stringify({
          type: "compacted",
          timestamp: checkpointTime,
          payload: {
            replacement_history: [
              message("user", "carried"),
              message("assistant", "summary"),
            ],
          },
        }) +
        "\n" +
        JSON.stringify({
          type: "event_msg",
          timestamp: checkpointTime,
          payload: { type: "task_complete" },
        }) +
        "\n" +
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-10-12T13:00:00.000Z",
          payload: message("user", "tail"),
        }) +
        "\n"
      : initial;
    const imported = await app.importThread(parseCodexRollout(records), {
      cwd: os.tmpdir(),
    });
    const timestamps = (
      items: readonly import("../src/item.js").CanonicalItem[],
    ) =>
      compileModelMessages(items).flatMap((entry) =>
        entry.role === "user" && entry.userTimestamp !== undefined
          ? [entry.userTimestamp]
          : [],
      );
    const expected = checkpoint ? [null, null] : [stamp];
    assert.deepEqual(timestamps(imported.thread.items), expected);
    if (checkpoint)
      assert.equal(
        imported.thread.items.find((entry) => entry.type === "user_message")
          ?.createdAt,
        checkpointTime,
        "checkpoint times remain canonical but are not claimed as receipt times",
      );
    const restored = server(journal);
    assert.deepEqual(
      timestamps((await restored.readThread(imported.thread.id)).items),
      expected,
    );
    if (checkpoint) {
      // The final imported Turn is interrupted, so latest-complete copies a
      // shorter prefix than importedFrom.historyItemCount describes.
      const partial = await restored.forkThread({
        sourceThreadId: imported.thread.id,
        through: { type: "latest-complete" },
        workspace: { type: "same-directory" },
      });
      assert.deepEqual(timestamps(partial.items), [null]);
      await (
        await restored.startTurn(partial.id, "local after partial fork")
      ).done;
      const partialSnapshot = await restored.readThread(partial.id);
      const partialLocalTime = partialSnapshot.items.findLast(
        (entry) => entry.type === "user_message",
      )!.createdAt;
      assert.deepEqual(timestamps(partialSnapshot.items), [
        null,
        partialLocalTime,
      ]);
      const repeated = await restored.forkThread({
        sourceThreadId: partial.id,
        through: { type: "latest-complete" },
        workspace: { type: "same-directory" },
      });
      assert.deepEqual(timestamps(repeated.items), [null, partialLocalTime]);
      assert.deepEqual(
        timestamps((await server(journal).readThread(repeated.id)).items),
        [null, partialLocalTime],
      );
    }
    await (
      await restored.startTurn(imported.thread.id, "new local input")
    ).done;
    const snapshot = await restored.readThread(imported.thread.id);
    const localTime = snapshot.items.findLast(
      (entry) => entry.type === "user_message",
    )!.createdAt;
    assert.deepEqual(timestamps(snapshot.items), [...expected, localTime]);
    const fork = await restored.forkThread({
      sourceThreadId: imported.thread.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    });
    assert.deepEqual(timestamps(fork.items), [...expected, localTime]);
  }
});
