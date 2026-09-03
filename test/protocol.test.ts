import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { png1x1, shellPrintCommand } from "./fixtures.js";

import { createHostedAppServer } from "../apps/cli/src/host.js";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryThreadJournal, type ThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import type { ModelAdapter } from "../src/model.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import {
  CodexClient,
  CodexClientError,
  responseResult,
} from "../src/protocol/codex/client.js";
import { CodexConnection } from "../src/protocol/codex/connection.js";
import { encodeModelKey } from "../src/protocol/codex/model-key.js";
import {
  projectCommandCompleted,
  projectCommandStarted,
} from "../src/protocol/codex/mapper.js";
import { serveCodexWebSocket } from "../src/protocol/codex/websocket.js";
import {
  InMemoryThreadMetadataStore,
  type ThreadMetadataStore,
} from "../src/thread-metadata.js";
import { isRecord, type JsonRpcMessage } from "../src/protocol/codex/wire.js";
import { AgentRuntime } from "../src/runtime.js";
import { ShellToolRuntime, ToolEnvironment } from "../src/tool.js";

function testHost(
  approvalPolicy: "always" | "never" = "never",
  models: readonly string[] = ["fake"],
) {
  return createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: path.join(os.tmpdir(), "unused-zen-test-data"),
    model: models[0] ?? "fake",
    models,
    approvalPolicy,
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
    threadMetadata: new InMemoryThreadMetadataStore(),
  });
}

function modelTestHost(model: ModelAdapter): ZenAppServer {
  const profile = model.provider;
  return new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({
        runtimes: [new ShellToolRuntime()],
      }),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: profile,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          {
            id: "reasoning-model",
            isDefault: true,
            supportedReasoningEfforts: ["medium"],
            defaultReasoningEffort: "medium",
          },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: profile,
      modelId: "reasoning-model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}

test("projects correlated reasoning summary and content streams with canonical item ids", async () => {
  const model: ModelAdapter = {
    provider: "reasoning-stream",
    async *stream() {
      yield { type: "reasoning_started", reasoningId: "summary-0" };
      yield {
        type: "reasoning_summary_delta",
        reasoningId: "summary-0",
        delta: "checked ",
      };
      yield {
        type: "reasoning_summary_delta",
        reasoningId: "summary-0",
        delta: "the plan",
      };
      yield {
        type: "reasoning",
        reasoningId: "summary-0",
        reasoningContent: "opaque-provider-payload",
        summary: "checked the plan",
        contentVisibility: "opaque",
      };
      yield { type: "text_delta", delta: "interleaved answer" };
      yield { type: "reasoning_started", reasoningId: "content-0" };
      yield {
        type: "reasoning_summary_delta",
        reasoningId: "content-0",
        delta: "public summary",
      };
      yield {
        type: "reasoning_content_delta",
        reasoningId: "content-0",
        delta: "public ",
      };
      yield {
        type: "reasoning_content_delta",
        reasoningId: "content-0",
        delta: "thought",
      };
      yield {
        type: "reasoning",
        reasoningId: "content-0",
        reasoningContent: "public thought",
        summary: "public summary",
        contentVisibility: "public",
      };
    },
  };
  const appServer = modelTestHost(model);
  const messages: JsonRpcMessage[] = [];
  const completed = deferred<void>();
  const connection = new CodexConnection({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    send: (message) => {
      messages.push(message);
      if ("method" in message && message.method === "turn/completed") {
        completed.resolve();
      }
    },
  });

  try {
    await connection.receive({ id: 1, method: "initialize", params: {} });
    await connection.receive({ method: "initialized" });
    await connection.receive({ id: 2, method: "thread/start", params: {} });
    const started = messages.find(
      (message) => "result" in message && String(message.id) === "2",
    );
    assert(started !== undefined && "result" in started);
    const thread = responseResult<Record<string, unknown>>(
      started.result,
      "thread",
    );
    await connection.receive({
      id: 3,
      method: "turn/start",
      params: { threadId: thread.id, input: [{ type: "text", text: "go" }] },
    });
    await within(completed.promise);

    const notifications = messages.filter(
      (message): message is Extract<JsonRpcMessage, { method: string }> =>
        "method" in message,
    );
    const reasoningStarted = notifications.filter(
      (message) =>
        message.method === "item/started" &&
        isRecord(message.params) &&
        isRecord(message.params.item) &&
        message.params.item.type === "reasoning",
    );
    assert.equal(reasoningStarted.length, 2);
    const summaryId = String(
      (reasoningStarted[0]?.params as { item: { id: string } }).item.id,
    );
    const contentId = String(
      (reasoningStarted[1]?.params as { item: { id: string } }).item.id,
    );
    assert.deepEqual(
      notifications
        .filter((message) =>
          [
            "item/reasoning/summaryPartAdded",
            "item/reasoning/summaryTextDelta",
            "item/reasoning/textDelta",
          ].includes(message.method),
        )
        .map((message) => ({ method: message.method, params: message.params })),
      [
        {
          method: "item/reasoning/summaryPartAdded",
          params: {
            threadId: thread.id,
            turnId: (reasoningStarted[0]?.params as { turnId: string }).turnId,
            itemId: summaryId,
            summaryIndex: 0,
          },
        },
        {
          method: "item/reasoning/summaryTextDelta",
          params: {
            threadId: thread.id,
            turnId: (reasoningStarted[0]?.params as { turnId: string }).turnId,
            itemId: summaryId,
            delta: "checked ",
            summaryIndex: 0,
          },
        },
        {
          method: "item/reasoning/summaryTextDelta",
          params: {
            threadId: thread.id,
            turnId: (reasoningStarted[0]?.params as { turnId: string }).turnId,
            itemId: summaryId,
            delta: "the plan",
            summaryIndex: 0,
          },
        },
        {
          method: "item/reasoning/summaryPartAdded",
          params: {
            threadId: thread.id,
            turnId: (reasoningStarted[1]?.params as { turnId: string }).turnId,
            itemId: contentId,
            summaryIndex: 0,
          },
        },
        {
          method: "item/reasoning/summaryTextDelta",
          params: {
            threadId: thread.id,
            turnId: (reasoningStarted[1]?.params as { turnId: string }).turnId,
            itemId: contentId,
            delta: "public summary",
            summaryIndex: 0,
          },
        },
        {
          method: "item/reasoning/textDelta",
          params: {
            threadId: thread.id,
            turnId: (reasoningStarted[1]?.params as { turnId: string }).turnId,
            itemId: contentId,
            delta: "public ",
            contentIndex: 0,
          },
        },
        {
          method: "item/reasoning/textDelta",
          params: {
            threadId: thread.id,
            turnId: (reasoningStarted[1]?.params as { turnId: string }).turnId,
            itemId: contentId,
            delta: "thought",
            contentIndex: 0,
          },
        },
      ],
    );
    const completedReasoning = notifications
      .filter(
        (message) =>
          message.method === "item/completed" &&
          isRecord(message.params) &&
          isRecord(message.params.item) &&
          message.params.item.type === "reasoning",
      )
      .map((message) => (message.params as { item: unknown }).item);
    assert.deepEqual(completedReasoning, [
      {
        type: "reasoning",
        id: summaryId,
        summary: ["checked the plan"],
        content: [],
      },
      {
        type: "reasoning",
        id: contentId,
        summary: ["public summary"],
        content: ["public thought"],
      },
    ]);
    assert.equal(
      JSON.stringify(notifications).includes("opaque-provider-payload"),
      false,
    );
  } finally {
    connection.close();
  }
});

test("ignores empty subscription reasoning without a dangling protocol item", async () => {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const accessToken = `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_protocol" },
  })}.signature`;
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "rs_empty", summary: [] },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", id: "rs_empty", summary: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "message", id: "msg_answer", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 1,
      delta: "answer",
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "message",
        id: "msg_answer",
        content: [{ type: "output_text", text: "answer" }],
      },
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [],
        usage: { input_tokens: 2, output_tokens: 1 },
      },
    },
  ];
  const model = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({ accessToken }),
    fetch: async () =>
      new Response(
        `${events
          .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
          .join("")}data: [DONE]\r\n\r\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const appServer = modelTestHost(model);
  const messages: JsonRpcMessage[] = [];
  const completed = deferred<void>();
  const connection = new CodexConnection({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    send: (message) => {
      messages.push(message);
      if ("method" in message && message.method === "turn/completed") {
        completed.resolve();
      }
    },
  });

  try {
    await connection.receive({ id: 1, method: "initialize", params: {} });
    await connection.receive({ method: "initialized" });
    await connection.receive({ id: 2, method: "thread/start", params: {} });
    const started = messages.find(
      (message) => "result" in message && String(message.id) === "2",
    );
    assert(started !== undefined && "result" in started);
    const thread = responseResult<Record<string, unknown>>(
      started.result,
      "thread",
    );
    await connection.receive({
      id: 3,
      method: "turn/start",
      params: { threadId: thread.id, input: [{ type: "text", text: "go" }] },
    });
    await within(completed.promise);

    assert.equal(
      messages.some(
        (message) =>
          "method" in message &&
          (message.method === "item/started" ||
            message.method === "item/completed") &&
          isRecord(message.params) &&
          isRecord(message.params.item) &&
          message.params.item.type === "reasoning",
      ),
      false,
    );
    assert.equal(
      messages.some(
        (message) => "method" in message && message.method === "error",
      ),
      false,
    );
    const snapshot = await appServer.readThread(String(thread.id));
    assert.equal(snapshot.turns[0]?.status, "completed");
    assert.equal(
      snapshot.items.some(
        (item) => item.type === "reasoning" || item.type === "failure",
      ),
      false,
    );
  } finally {
    connection.close();
  }
});

test("imports Codex localImage and image inputs before canonical turn/start", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-protocol-image-"));
  const localPath = path.join(root, "ephemeral-local.png");
  await writeFile(localPath, png1x1());
  const appServer = createHostedAppServer({
    cwd: root,
    dataDirectory: root,
    model: "fake-image",
    modelCatalog: [
      {
        id: "fake-image",
        isDefault: true,
        supportedReasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
        inputModalities: ["text", "image"],
        source: "manual",
      },
    ],
    approvalPolicy: "never",
    provider: { type: "fake" },
  });
  const messages: JsonRpcMessage[] = [];
  let turnCompleted = deferred<void>();
  const connection = new CodexConnection({
    appServer,
    zenHome: path.join(root, "home"),
    send: (message) => {
      messages.push(message);
      if ("method" in message && message.method === "turn/completed") {
        turnCompleted.resolve();
      }
    },
  });
  try {
    await connection.receive({ id: 1, method: "initialize", params: {} });
    await connection.receive({ method: "initialized" });
    await connection.receive({ id: 2, method: "thread/start", params: {} });
    const started = messages.find(
      (message) => "result" in message && String(message.id) === "2",
    );
    assert(
      started !== undefined && "result" in started && isRecord(started.result),
    );
    const thread = responseResult<Record<string, unknown>>(
      started.result,
      "thread",
    );
    await connection.receive({
      id: 3,
      method: "turn/start",
      params: {
        threadId: thread.id,
        input: [{ type: "image", url: "https://example.test/image.png" }],
      },
    });
    const remoteImageFailure = messages.find(
      (message) => "error" in message && String(message.id) === "3",
    );
    assert(remoteImageFailure !== undefined && "error" in remoteImageFailure);
    assert(
      isRecord(remoteImageFailure.error.data) &&
        remoteImageFailure.error.data.zenCode === "attachment_invalid",
    );
    assert.deepEqual(
      (await appServer.readThread(String(thread.id))).items.map(
        (item) => item.type,
      ),
      ["thread_metadata"],
    );
    await connection.receive({
      id: 4,
      method: "turn/start",
      params: {
        threadId: thread.id,
        input: [
          { type: "text", text: "local" },
          { type: "localImage", path: localPath },
        ],
      },
    });
    await within(turnCompleted.promise);

    const firstSnapshot = await appServer.readThread(String(thread.id));
    const retainedRef = firstSnapshot.items
      .filter((item) => item.type === "user_message")
      .flatMap((item) => item.content ?? [])
      .find((part) => part.type === "image");
    assert(retainedRef?.type === "image");

    turnCompleted = deferred<void>();
    await connection.receive({
      id: 5,
      method: "turn/start",
      params: {
        threadId: thread.id,
        input: [
          {
            type: "image",
            url: `data:image/png;base64,${Buffer.from(png1x1()).toString("base64")}`,
          },
        ],
      },
    });
    await within(turnCompleted.promise);

    turnCompleted = deferred<void>();
    await connection.receive({
      id: 6,
      method: "turn/start",
      params: {
        threadId: thread.id,
        input: [{ type: "attachment", attachment: retainedRef.attachment }],
      },
    });
    await within(turnCompleted.promise);

    const snapshot = await appServer.readThread(String(thread.id));
    const canonicalMessages = snapshot.items.filter(
      (item) => item.type === "user_message",
    );
    assert.equal(canonicalMessages.length, 3);
    assert(
      canonicalMessages.every((item) =>
        item.content?.some((part) => part.type === "image"),
      ),
    );
    const attachmentDirectories = await readdir(
      path.join(root, "attachments", "sha256"),
    );
    assert.equal(attachmentDirectories.length, 1);
    const journal = await readFile(
      path.join(root, "threads", `${String(thread.id)}.jsonl`),
      "utf8",
    );
    assert.equal(journal.includes(localPath), false);
    assert.equal(journal.includes("base64"), false);
  } finally {
    connection.close();
    await appServer.closeProviderTransport();
    await rm(root, { recursive: true, force: true });
  }
});

test("enforces the Codex initialize handshake and method boundary", async () => {
  const messages: JsonRpcMessage[] = [];
  const connection = new CodexConnection({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    send: (message) => {
      messages.push(message);
    },
  });

  await connection.receive({ id: 1, method: "thread/list", params: {} });
  assert.deepEqual(messages.pop(), {
    id: 1,
    error: { code: -32600, message: "Not initialized" },
  });

  await connection.receive({
    id: 2,
    method: "initialize",
    params: {
      clientInfo: { name: "test", title: "Test", version: "1" },
      capabilities: null,
    },
  });
  const initialized = messages.pop();
  assert(
    initialized !== undefined &&
      "result" in initialized &&
      typeof initialized.result === "object",
  );

  await connection.receive({ id: 3, method: "initialize", params: {} });
  assert.deepEqual(messages.pop(), {
    id: 3,
    error: { code: -32600, message: "Already initialized" },
  });

  await connection.receive({ method: "initialized" });
  await connection.receive({ id: 4, method: "not/a-method", params: {} });
  assert.deepEqual(messages.pop(), {
    id: 4,
    error: { code: -32601, message: "Method not found: not/a-method" },
  });
  connection.close();
});

test("does not project App Server events before both initialize phases", async () => {
  const appServer = testHost();
  const thread = await appServer.startThread();
  const messages: JsonRpcMessage[] = [];
  const connection = new CodexConnection({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    send: (message) => messages.push(message),
  });

  try {
    await appServer.setThreadArchived(thread.id, true);
    await flushTasks();
    await connection.receive({ id: 1, method: "initialize", params: {} });
    await appServer.setThreadArchived(thread.id, false);
    await flushTasks();
    await connection.receive({ method: "initialized" });
    await appServer.setThreadArchived(thread.id, true);
    await flushTasks();

    assert.deepEqual(
      messages
        .filter(
          (message): message is Extract<JsonRpcMessage, { method: string }> =>
            "method" in message,
        )
        .map((message) => message.method),
      ["thread/archived"],
    );
  } finally {
    connection.close();
    await appServer.closeProviderTransport();
  }
});

test("captures one internally consistent App Server snapshot after metadata IO", async () => {
  const backingMetadata = new InMemoryThreadMetadataStore();
  const readEntered = deferred<void>();
  const releaseRead = deferred<void>();
  let blockNextRead = false;
  const threadMetadata: ThreadMetadataStore = {
    read: async (threadId) => {
      if (blockNextRead) {
        blockNextRead = false;
        readEntered.resolve();
        await releaseRead.promise;
      }
      return await backingMetadata.read(threadId);
    },
    setName: async (threadId, name) =>
      await backingMetadata.setName(threadId, name),
    setArchived: async (threadId, archived) =>
      await backingMetadata.setArchived(threadId, archived),
  };
  const appServer = createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: path.join(os.tmpdir(), "unused-zen-test-data"),
    model: "fake",
    models: ["fake", "other"],
    approvalPolicy: "never",
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
    threadMetadata,
  });

  try {
    const thread = await appServer.startThread();
    blockNextRead = true;
    const pendingSnapshot = appServer.readThread(thread.id);
    await within(readEntered.promise);
    await appServer.updateThreadSettings(thread.id, { model: "other" });
    releaseRead.resolve();

    const snapshot = await within(pendingSnapshot);
    assert.equal(snapshot.modelId, "other");
    assert.equal(
      snapshot.items.filter(
        (item) => item.type === "thread_configuration_changed",
      ).length,
      1,
    );
  } finally {
    await appServer.closeProviderTransport();
  }
});

test("thread/resume sends its snapshot before lossless non-duplicate catch-up", async () => {
  const appServer = testHost();
  const thread = await appServer.startThread();
  const snapshotCaptured = deferred<void>();
  const releaseSnapshot = deferred<void>();
  const readThread = appServer.readThread.bind(appServer);
  let intercept = true;
  appServer.readThread = async (threadId) => {
    const snapshot = await readThread(threadId);
    if (intercept) {
      intercept = false;
      snapshotCaptured.resolve();
      await releaseSnapshot.promise;
    }
    return snapshot;
  };
  const messages: JsonRpcMessage[] = [];
  const connection = new CodexConnection({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    send: (message) => messages.push(message),
  });

  try {
    await connection.receive({ id: 1, method: "initialize", params: {} });
    await connection.receive({ method: "initialized" });
    messages.length = 0;

    const resume = connection.receive({
      id: 2,
      method: "thread/resume",
      params: { threadId: thread.id },
    });
    await within(snapshotCaptured.promise);
    await (
      await appServer.startTurn(thread.id, "during resume")
    ).done;
    releaseSnapshot.resolve();
    await within(resume);
    await flushTasks();

    const responseIndex = messages.findIndex(
      (message) => "result" in message && message.id === 2,
    );
    const startedIndexes = messages.flatMap((message, index) =>
      "method" in message && message.method === "turn/started" ? [index] : [],
    );
    const completedIndexes = messages.flatMap((message, index) =>
      "method" in message && message.method === "turn/completed" ? [index] : [],
    );
    assert(responseIndex >= 0);
    assert.deepEqual(startedIndexes.length, 1);
    assert.deepEqual(completedIndexes.length, 1);
    assert(startedIndexes[0]! > responseIndex);
    assert(completedIndexes[0]! > startedIndexes[0]!);
  } finally {
    connection.close();
    await appServer.closeProviderTransport();
  }
});

test("thread/resume does not wait for later projection work from another thread", async () => {
  const appServer = testHost();
  const messages: JsonRpcMessage[] = [];
  const connection = new CodexConnection({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    send: (message) => messages.push(message),
  });
  const firstReadEntered = deferred<void>();
  const releaseFirstRead = deferred<void>();
  const secondReadEntered = deferred<void>();
  const releaseSecondRead = deferred<void>();
  let resume: Promise<void> | undefined;

  try {
    await connection.receive({ id: 1, method: "initialize", params: {} });
    await connection.receive({ method: "initialized" });
    await connection.receive({ id: 2, method: "thread/start", params: {} });
    const started = messages.find(
      (message) => "result" in message && message.id === 2,
    );
    assert(started !== undefined && "result" in started);
    const threadA = responseResult<Record<string, unknown>>(
      started.result,
      "thread",
    );
    const threadB = await appServer.startThread();
    const readThread = appServer.readThread.bind(appServer);
    let threadAReads = 0;
    appServer.readThread = async (threadId) => {
      if (threadId === threadA.id) {
        threadAReads += 1;
        if (threadAReads === 1) {
          firstReadEntered.resolve();
          await releaseFirstRead.promise;
        } else if (threadAReads === 2) {
          secondReadEntered.resolve();
          await releaseSecondRead.promise;
        }
      }
      return await readThread(threadId);
    };

    const firstTurn = await appServer.startTurn(String(threadA.id), "first");
    await within(firstReadEntered.promise);
    await firstTurn.done;
    resume = connection.receive({
      id: 3,
      method: "thread/resume",
      params: { threadId: threadB.id },
    });
    const secondTurn = await appServer.startTurn(String(threadA.id), "second");
    await secondTurn.done;
    releaseFirstRead.resolve();
    await within(secondReadEntered.promise);
    await flushTasks();

    assert.equal(
      messages.some((message) => "result" in message && message.id === 3),
      true,
    );
  } finally {
    releaseFirstRead.resolve();
    releaseSecondRead.resolve();
    if (resume !== undefined) await within(resume);
    connection.close();
    await appServer.closeProviderTransport();
  }
});

test("thread/resume never replays superseded state after its final snapshot", async () => {
  const backingMetadata = new InMemoryThreadMetadataStore();
  const readEntered = deferred<void>();
  const releaseRead = deferred<void>();
  let blockNextRead = false;
  const threadMetadata: ThreadMetadataStore = {
    read: async (threadId) => {
      if (blockNextRead) {
        blockNextRead = false;
        readEntered.resolve();
        await releaseRead.promise;
      }
      return await backingMetadata.read(threadId);
    },
    setName: async (threadId, name) =>
      await backingMetadata.setName(threadId, name),
    setArchived: async (threadId, archived) =>
      await backingMetadata.setArchived(threadId, archived),
  };
  const appServer = createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: path.join(os.tmpdir(), "unused-zen-test-data"),
    model: "fake",
    models: ["fake", "other", "final"],
    approvalPolicy: "never",
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
    threadMetadata,
  });
  const thread = await appServer.startThread();
  const messages: JsonRpcMessage[] = [];
  const connection = new CodexConnection({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    send: (message) => messages.push(message),
  });

  try {
    await connection.receive({ id: 1, method: "initialize", params: {} });
    await connection.receive({ method: "initialized" });
    messages.length = 0;
    blockNextRead = true;
    const resume = connection.receive({
      id: 2,
      method: "thread/resume",
      params: { threadId: thread.id },
    });
    await within(readEntered.promise);
    await appServer.updateThreadSettings(thread.id, { model: "other" });
    await appServer.updateThreadSettings(thread.id, { model: "final" });
    await appServer.setThreadName(thread.id, "First name");
    await appServer.setThreadName(thread.id, "Final name");
    await appServer.setThreadArchived(thread.id, true);
    await appServer.setThreadArchived(thread.id, false);
    releaseRead.resolve();
    await within(resume);
    await flushTasks();

    const responseIndex = messages.findIndex(
      (message) => "result" in message && message.id === 2,
    );
    assert(responseIndex >= 0);
    const response = messages[responseIndex]!;
    assert("result" in response && isRecord(response.result));
    assert.equal(
      responseResult<Record<string, unknown>>(response.result, "thread").name,
      "Final name",
    );
    assert.equal(
      response.result.model,
      encodeModelKey({ providerProfileId: "fake", modelId: "final" }),
    );
    assert.deepEqual(
      messages
        .slice(responseIndex + 1)
        .filter((message) => "method" in message)
        .map((message) => ("method" in message ? message.method : ""))
        .filter((method) =>
          [
            "thread/settings/updated",
            "thread/name/updated",
            "thread/archived",
            "thread/unarchived",
          ].includes(method),
        ),
      [],
    );
    const snapshot = await appServer.readThread(thread.id);
    assert.equal(snapshot.modelId, "final");
    assert.equal(snapshot.name, "Final name");
    assert.equal(snapshot.archived, false);
  } finally {
    connection.close();
    await appServer.closeProviderTransport();
  }
});

test("closing a connection discards its transient resume catch-up buffer", async () => {
  const appServer = testHost();
  const thread = await appServer.startThread();
  const snapshotCaptured = deferred<void>();
  const releaseSnapshot = deferred<void>();
  const readThread = appServer.readThread.bind(appServer);
  let intercept = true;
  appServer.readThread = async (threadId) => {
    const snapshot = await readThread(threadId);
    if (intercept) {
      intercept = false;
      snapshotCaptured.resolve();
      await releaseSnapshot.promise;
    }
    return snapshot;
  };
  const messages: JsonRpcMessage[] = [];
  const connection = new CodexConnection({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    send: (message) => messages.push(message),
  });

  try {
    await connection.receive({ id: 1, method: "initialize", params: {} });
    await connection.receive({ method: "initialized" });
    messages.length = 0;
    const resume = connection.receive({
      id: 2,
      method: "thread/resume",
      params: { threadId: thread.id },
    });
    await within(snapshotCaptured.promise);
    await (
      await appServer.startTurn(thread.id, "before close")
    ).done;
    connection.close();
    releaseSnapshot.resolve();
    await within(resume);
    await flushTasks();

    assert.equal(
      messages.some((message) => "method" in message),
      false,
    );
  } finally {
    connection.close();
    await appServer.closeProviderTransport();
  }
});

test("closing a connection discards App Server events already queued behind projection", async () => {
  const appServer = testHost();
  const messages: JsonRpcMessage[] = [];
  const connection = new CodexConnection({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    send: (message) => messages.push(message),
  });
  const readEntered = deferred<void>();
  const releaseRead = deferred<void>();

  try {
    await connection.receive({ id: 1, method: "initialize", params: {} });
    await connection.receive({ method: "initialized" });
    await connection.receive({ id: 2, method: "thread/start", params: {} });
    const started = messages.find(
      (message) => "result" in message && message.id === 2,
    );
    assert(started !== undefined && "result" in started);
    const thread = responseResult<Record<string, unknown>>(
      started.result,
      "thread",
    );
    const readThread = appServer.readThread.bind(appServer);
    let blockNextRead = true;
    appServer.readThread = async (threadId) => {
      if (blockNextRead) {
        blockNextRead = false;
        readEntered.resolve();
        await releaseRead.promise;
      }
      return await readThread(threadId);
    };

    const turn = await appServer.startTurn(
      String(thread.id),
      `!shell ${shellPrintCommand("queued-close")}`,
    );
    await within(readEntered.promise);
    await appServer.setThreadName(String(thread.id), "Must not project");
    connection.close();
    releaseRead.resolve();
    await turn.done;
    await flushTasks();

    assert.equal(
      messages.some(
        (message) =>
          "method" in message && message.method === "thread/name/updated",
      ),
      false,
    );
  } finally {
    connection.close();
    await appServer.closeProviderTransport();
  }
});

test("projects the exact T3 Code provider bootstrap from host configuration", async () => {
  const messages: JsonRpcMessage[] = [];
  const connection = new CodexConnection({
    appServer: testHost("never", ["gpt-5.6-terra", "gpt-5.6-sol"]),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    send: (message) => {
      messages.push(message);
    },
  });

  await connection.receive({ id: 1, method: "initialize", params: {} });
  messages.pop();
  await connection.receive({ method: "initialized" });

  await connection.receive({ id: 2, method: "account/read", params: {} });
  assert.deepEqual(messages.pop(), {
    id: 2,
    result: { account: null, requiresOpenaiAuth: false },
  });

  const cwds = [process.cwd(), path.join(os.tmpdir(), "second-workspace")];
  await connection.receive({
    id: 3,
    method: "skills/list",
    params: { cwds },
  });
  assert.deepEqual(messages.pop(), {
    id: 3,
    result: {
      data: cwds.map((cwd) => ({ cwd, skills: [], errors: [] })),
    },
  });

  await connection.receive({ id: 4, method: "model/list", params: {} });
  assert.deepEqual(messages.pop(), {
    id: 4,
    result: {
      data: [
        {
          id: wireModel("gpt-5.6-terra"),
          model: wireModel("gpt-5.6-terra"),
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          displayName: "gpt-5.6-terra",
          description: "Model configured by the Zen host",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "medium" },
          ],
          defaultReasoningEffort: "medium",
          inputModalities: ["text"],
          supportsPersonality: false,
          additionalSpeedTiers: [],
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: true,
        },
        {
          id: wireModel("gpt-5.6-sol"),
          model: wireModel("gpt-5.6-sol"),
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          displayName: "gpt-5.6-sol",
          description: "Model configured by the Zen host",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "medium" },
          ],
          defaultReasoningEffort: "medium",
          inputModalities: ["text"],
          supportsPersonality: false,
          additionalSpeedTiers: [],
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: false,
        },
      ],
      nextCursor: null,
    },
  });
  connection.close();
});

test("switches models canonically and synchronizes thread settings", async () => {
  const appServer = testHost("never", ["fake", "other"]);
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const initiating = await CodexClient.connect(server.url);
  const observing = await CodexClient.connect(server.url);
  try {
    await initiating.initialize({
      name: "initiating",
      title: "Initiating",
      version: "1",
    });
    await observing.initialize({
      name: "observing",
      title: "Observing",
      version: "1",
    });
    const started = await initiating.request("thread/start", {
      model: "fake",
      cwd: process.cwd(),
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
    const thread = responseResult<Record<string, unknown>>(started, "thread");
    if (typeof thread.id !== "string") {
      throw new Error("thread/start omitted id");
    }
    await observing.request("thread/resume", { threadId: thread.id });

    const updated = deferred<Record<string, unknown>>();
    initiating.onNotification("thread/settings/updated", (params) => {
      if (isRecord(params)) {
        updated.resolve(params);
      }
    });
    const response = await initiating.request("thread/settings/update", {
      threadId: thread.id,
      model: "other",
    });
    assert.deepEqual(response, {});
    const notification = await within(updated.promise);
    assert.equal(notification.threadId, thread.id);
    assert(
      isRecord(notification.threadSettings) &&
        notification.threadSettings.model === wireModel("other"),
    );

    const snapshot = await appServer.readThread(thread.id);
    assert.equal(snapshot.model, "other");
    assert.equal(
      snapshot.items.filter(
        (item) => item.type === "thread_configuration_changed",
      ).length,
      1,
    );

    const completed = deferred<void>();
    initiating.onNotification("turn/completed", () => {
      completed.resolve();
    });
    await initiating.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "switch back" }],
      model: "fake",
    });
    await within(completed.promise);
    const afterTurn = await appServer.readThread(thread.id);
    assert.equal(afterTurn.model, "fake");
    assert.equal(
      afterTurn.items.filter(
        (item) => item.type === "thread_configuration_changed",
      ).length,
      2,
    );

    const rapidModels: string[] = [];
    const rapidUpdates = deferred<void>();
    initiating.onNotification("thread/settings/updated", (params) => {
      if (
        isRecord(params) &&
        isRecord(params.threadSettings) &&
        typeof params.threadSettings.model === "string"
      ) {
        rapidModels.push(params.threadSettings.model);
        if (rapidModels.length === 2) {
          rapidUpdates.resolve();
        }
      }
    });
    await Promise.all([
      appServer.updateThreadSettings(String(thread.id), { model: "other" }),
      appServer.updateThreadSettings(String(thread.id), { model: "fake" }),
    ]);
    await within(rapidUpdates.promise);
    assert.deepEqual(rapidModels, [wireModel("other"), wireModel("fake")]);
  } finally {
    initiating.close();
    observing.close();
    await server.close();
  }
});

test("exposes manual context compaction only as the thread/compact Zen extension", async () => {
  const appServer = testHost();
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    await client.initialize({
      name: "compact",
      title: "Compact",
      version: "1",
    });
    const started = await client.request("thread/start", {});
    const thread = responseResult<Record<string, unknown>>(started, "thread");
    assert.equal(typeof thread.id, "string");
    const threadId = String(thread.id);
    const completed = deferred<void>();
    client.onNotification("turn/completed", () => completed.resolve());
    await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "history to compact" }],
    });
    await within(completed.promise);

    const result = await client.request("thread/compact", { threadId });
    assert(isRecord(result));
    assert.deepEqual(Object.keys(result), ["compactionItemId"]);
    assert.equal(typeof result.compactionItemId, "string");
    const snapshot = await appServer.readThread(threadId);
    assert.equal(snapshot.items.at(-1)?.id, result.compactionItemId);
    assert.equal(snapshot.items.at(-1)?.type, "context_compaction");

    const read = await client.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    const projected = responseResult<Record<string, unknown>>(read, "thread");
    assert(Array.isArray(projected.turns));
    assert.equal(projected.turns.length, 1);
    assert.equal(
      JSON.stringify(projected.turns).includes("context_compaction"),
      false,
    );

    await assert.rejects(
      client.request("thread/compact", {
        threadId,
        coveredThroughItemId: "not-callable",
      }),
      (error: unknown) => {
        assert(error instanceof CodexClientError);
        assert.equal(error.code, -32602);
        return true;
      },
    );
  } finally {
    client.close();
    await server.close();
  }
});

test("resumes an active thread and applies an explicit model change next", async () => {
  const appServer = testHost("always", ["fake", "other"]);
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const running = await CodexClient.connect(server.url);
  const resuming = await CodexClient.connect(server.url);
  const approvalSeen = deferred<void>();
  const releaseApproval = deferred<{ decision: "decline" }>();
  try {
    await running.initialize({
      name: "imzen",
      title: "IMZen",
      version: "1",
    });
    await resuming.initialize({
      name: "t3code_desktop",
      title: "T3 Code Desktop",
      version: "0.0.31",
    });
    running.onServerRequest(
      "item/commandExecution/requestApproval",
      async () => {
        approvalSeen.resolve();
        return await releaseApproval.promise;
      },
    );
    const started = await running.request("thread/start", {
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
    const thread = responseResult<Record<string, unknown>>(started, "thread");
    const turn = await running.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "!shell printf active" }],
      model: "fake",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "dangerFullAccess" },
      approvalsReviewer: "user",
    });
    await within(approvalSeen.promise);

    const resumed = await resuming.request("thread/resume", {
      threadId: thread.id,
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
    assert.equal(
      responseResult<Record<string, unknown>>(resumed, "thread").id,
      thread.id,
    );
    assert.equal((await appServer.readThread(String(thread.id))).model, "fake");

    await resuming.request("thread/resume", {
      threadId: thread.id,
      model: "other",
    });
    assert.equal(
      (await appServer.readThread(String(thread.id))).model,
      "other",
    );

    const completed = deferred<void>();
    running.onNotification("turn/completed", () => {
      completed.resolve();
    });
    releaseApproval.resolve({ decision: "decline" });
    await within(completed.promise);
    assert(isRecord(turn) && isRecord(turn.turn));
  } finally {
    running.close();
    resuming.close();
    await server.close();
  }
});

test("dispatches Codex turn/steer to the same active Turn for every subscriber", async () => {
  const appServer = testHost("always");
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const initiating = await CodexClient.connect(server.url);
  const steering = await CodexClient.connect(server.url);
  const approvalSeen = deferred<void>();
  const releaseApproval = deferred<{ decision: "decline" }>();
  const turnCompleted = deferred<void>();
  try {
    await initiating.initialize({
      name: "initiating",
      title: "Initiating",
      version: "1",
    });
    await steering.initialize({
      name: "steering",
      title: "Steering",
      version: "1",
    });
    initiating.onServerRequest(
      "item/commandExecution/requestApproval",
      async () => {
        approvalSeen.resolve();
        return await releaseApproval.promise;
      },
    );
    initiating.onNotification("turn/completed", () => {
      turnCompleted.resolve();
    });
    const started = await initiating.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(started, "thread");
    await steering.request("thread/resume", { threadId: thread.id });
    const turnStart = await initiating.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "!shell printf active" }],
    });
    const turn = responseResult<Record<string, unknown>>(turnStart, "turn");
    await within(approvalSeen.promise);

    const observedByInitiator = deferred<Record<string, unknown>>();
    const observedBySteerer = deferred<Record<string, unknown>>();
    const observeSteer =
      (target: ReturnType<typeof deferred<Record<string, unknown>>>) =>
      (params: unknown): void => {
        if (
          isRecord(params) &&
          isRecord(params.item) &&
          params.item.type === "userMessage" &&
          params.item.clientId === "steer-protocol-id"
        ) {
          target.resolve(params);
        }
      };
    initiating.onNotification(
      "item/completed",
      observeSteer(observedByInitiator),
    );
    steering.onNotification("item/completed", observeSteer(observedBySteerer));

    assert.deepEqual(
      await steering.request("turn/steer", {
        threadId: thread.id,
        expectedTurnId: turn.id,
        input: [{ type: "text", text: "change direction" }],
        clientUserMessageId: "steer-protocol-id",
      }),
      { turnId: turn.id },
    );
    const observations = await within(
      Promise.all([observedByInitiator.promise, observedBySteerer.promise]),
    );
    for (const observation of observations) {
      assert.equal(observation.threadId, thread.id);
      assert.equal(observation.turnId, turn.id);
    }

    await assert.rejects(
      steering.request("turn/steer", {
        threadId: thread.id,
        expectedTurnId: "stale-turn",
        input: [{ type: "text", text: "must fail" }],
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32000,
    );
    releaseApproval.resolve({ decision: "decline" });
    await within(turnCompleted.promise);
  } finally {
    initiating.close();
    steering.close();
    await server.close();
  }
});

test("turn/replace atomically interrupts the fenced Turn before starting its successor", async () => {
  const appServer = testHost("always");
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const initiating = await CodexClient.connect(server.url);
  const replacing = await CodexClient.connect(server.url);
  const approvalSeen = deferred<void>();
  const releaseOldApproval = deferred<{ decision: "decline" }>();
  const approvalResolved = deferred<void>();
  const replacementCompleted = deferred<void>();
  const observed: Array<{ method: string; params: unknown }> = [];
  try {
    await initiating.initialize({
      name: "initiating",
      title: "Initiating",
      version: "1",
    });
    await replacing.initialize({
      name: "replacing",
      title: "Replacing",
      version: "1",
    });
    initiating.onServerRequest(
      "item/commandExecution/requestApproval",
      async () => {
        approvalSeen.resolve();
        return await releaseOldApproval.promise;
      },
    );
    initiating.onNotification("serverRequest/resolved", () => {
      approvalResolved.resolve();
    });
    for (const method of ["turn/completed", "turn/started", "item/completed"]) {
      replacing.onNotification(method, (params) => {
        observed.push({ method, params });
        if (
          method === "turn/completed" &&
          isRecord(params) &&
          isRecord(params.turn) &&
          params.turn.status === "completed"
        ) {
          replacementCompleted.resolve();
        }
      });
    }

    const started = await initiating.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(started, "thread");
    await replacing.request("thread/resume", { threadId: thread.id });
    const turnStart = await initiating.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "!shell printf old" }],
    });
    const oldTurn = responseResult<Record<string, unknown>>(turnStart, "turn");
    await within(approvalSeen.promise);

    const response = await replacing.request("turn/replace", {
      threadId: thread.id,
      expectedTurnId: oldTurn.id,
      input: [{ type: "text", text: "replacement request" }],
      clientUserMessageId: "replace-protocol-id",
    });
    assert(isRecord(response));
    assert.equal(response.interruptedTurnId, oldTurn.id);
    assert.equal(typeof response.turnId, "string");
    assert.notEqual(response.turnId, oldTurn.id);
    await within(approvalResolved.promise);
    await within(replacementCompleted.promise);
    releaseOldApproval.resolve({ decision: "decline" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const oldCompletedIndex = observed.findIndex(
      ({ method, params }) =>
        method === "turn/completed" &&
        isRecord(params) &&
        isRecord(params.turn) &&
        params.turn.id === oldTurn.id &&
        params.turn.status === "interrupted",
    );
    const newStartedIndex = observed.findIndex(
      ({ method, params }) =>
        method === "turn/started" &&
        isRecord(params) &&
        isRecord(params.turn) &&
        params.turn.id === response.turnId,
    );
    const replacementInputIndex = observed.findIndex(
      ({ method, params }) =>
        method === "item/completed" &&
        isRecord(params) &&
        isRecord(params.item) &&
        params.item.type === "userMessage" &&
        params.item.clientId === "replace-protocol-id",
    );
    assert(oldCompletedIndex >= 0);
    assert(newStartedIndex > oldCompletedIndex);
    assert(replacementInputIndex > newStartedIndex);
  } finally {
    releaseOldApproval.resolve({ decision: "decline" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    initiating.close();
    replacing.close();
    await server.close();
  }
});

test("synchronizes ZAS-owned thread names without adding Agent items", async () => {
  const appServer = testHost();
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const initiating = await CodexClient.connect(server.url);
  const observing = await CodexClient.connect(server.url);
  try {
    await initiating.initialize({
      name: "initiating",
      title: "Initiating",
      version: "1",
    });
    await observing.initialize({
      name: "observing",
      title: "Observing",
      version: "1",
    });
    const started = await initiating.request("thread/start", {});
    const thread = responseResult<Record<string, unknown>>(started, "thread");
    if (typeof thread.id !== "string") {
      throw new Error("thread/start omitted id");
    }
    await observing.request("thread/resume", { threadId: thread.id });

    const renamed = deferred<Record<string, unknown>>();
    observing.onNotification("thread/name/updated", (params) => {
      if (isRecord(params)) {
        renamed.resolve(params);
      }
    });
    await initiating.request("thread/name/set", {
      threadId: thread.id,
      name: "Shared title",
    });
    assert.deepEqual(await within(renamed.promise), {
      threadId: thread.id,
      threadName: "Shared title",
    });

    for (const [method, params] of [
      ["thread/read", { threadId: thread.id }],
      ["thread/resume", { threadId: thread.id }],
      ["thread/list", {}],
    ] as const) {
      const result = await observing.request(method, params);
      if (method === "thread/list") {
        assert(isRecord(result) && Array.isArray(result.data));
        const first = result.data[0];
        assert(isRecord(first));
        assert.equal(first.name, "Shared title");
      } else {
        assert.equal(
          responseResult<Record<string, unknown>>(result, "thread").name,
          "Shared title",
        );
      }
    }
    assert.equal(
      (await appServer.readThread(thread.id)).items.some(
        (item) => "name" in item,
      ),
      false,
    );
  } finally {
    initiating.close();
    observing.close();
    await server.close();
  }
});

test("archives Threads through the fixed Codex lifecycle and filters lists", async () => {
  const appServer = testHost();
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const initiating = await CodexClient.connect(server.url);
  const observing = await CodexClient.connect(server.url);
  try {
    await initiating.initialize({
      name: "initiating",
      title: "Initiating",
      version: "1",
    });
    await observing.initialize({
      name: "observing",
      title: "Observing",
      version: "1",
    });
    const started = await initiating.request("thread/start", {});
    const thread = responseResult<Record<string, unknown>>(started, "thread");
    assert.equal(typeof thread.id, "string");
    const threadId = thread.id as string;

    const archived = deferred<Record<string, unknown>>();
    const unarchived = deferred<Record<string, unknown>>();
    observing.onNotification("thread/archived", (params) => {
      if (isRecord(params)) archived.resolve(params);
    });
    observing.onNotification("thread/unarchived", (params) => {
      if (isRecord(params)) unarchived.resolve(params);
    });

    assert.deepEqual(
      await initiating.request("thread/archive", { threadId }),
      {},
    );
    assert.deepEqual(await within(archived.promise), { threadId });
    const activeList = await initiating.request("thread/list", {});
    assert(isRecord(activeList) && Array.isArray(activeList.data));
    assert.equal(activeList.data.length, 0);
    const archivedList = await initiating.request("thread/list", {
      archived: true,
    });
    assert(isRecord(archivedList) && Array.isArray(archivedList.data));
    assert.equal(archivedList.data.length, 1);
    await assert.rejects(
      initiating.request("thread/list", { archived: "yes" }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
    assert.equal(
      responseResult<Record<string, unknown>>(
        await initiating.request("thread/read", { threadId }),
        "thread",
      ).id,
      threadId,
    );

    const restored = await initiating.request("thread/unarchive", {
      threadId,
    });
    assert.equal(
      responseResult<Record<string, unknown>>(restored, "thread").id,
      threadId,
    );
    assert.deepEqual(await within(unarchived.promise), { threadId });
    const restoredList = await initiating.request("thread/list", {});
    assert(isRecord(restoredList) && Array.isArray(restoredList.data));
    assert.equal(restoredList.data.length, 1);
    assert.equal(
      (await appServer.readThread(threadId)).items.some(
        (item) => "archived" in item,
      ),
      false,
    );

    await assert.rejects(
      initiating.request("thread/archive", { threadId: "missing" }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32000,
    );
  } finally {
    initiating.close();
    observing.close();
    await server.close();
  }
});

test("paginates active and archived Thread lists with filter-bound cursors", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    await client.initialize({
      name: "pagination",
      title: "Pagination",
      version: "1",
    });
    const threadIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const result = await client.request("thread/start", {});
      const thread = responseResult<Record<string, unknown>>(result, "thread");
      assert.equal(typeof thread.id, "string");
      threadIds.push(thread.id as string);
    }
    const archivedIds = [threadIds[1]!, threadIds[3]!].sort();
    const activeIds = [threadIds[0]!, threadIds[2]!].sort();
    for (const threadId of archivedIds) {
      await client.request("thread/archive", { threadId });
    }

    const firstActive = await threadListPage(client, { limit: 1 });
    assert.deepEqual(firstActive.ids, activeIds.slice(0, 1));
    assert.equal(typeof firstActive.nextCursor, "string");
    assert.equal(firstActive.backwardsCursor, null);
    const secondActive = await threadListPage(client, {
      cursor: firstActive.nextCursor,
    });
    assert.deepEqual(secondActive.ids, activeIds.slice(1));
    assert.equal(secondActive.nextCursor, null);
    assert.equal(secondActive.backwardsCursor, null);

    const firstArchived = await threadListPage(client, {
      archived: true,
      limit: 1,
    });
    assert.deepEqual(firstArchived.ids, archivedIds.slice(0, 1));
    assert.equal(typeof firstArchived.nextCursor, "string");
    const secondArchived = await threadListPage(client, {
      archived: true,
      limit: 10,
      cursor: firstArchived.nextCursor,
    });
    assert.deepEqual(secondArchived.ids, archivedIds.slice(1));
    assert.equal(secondArchived.nextCursor, null);

    await assert.rejects(
      client.request("thread/list", {
        archived: false,
        limit: 1,
        cursor: firstArchived.nextCursor,
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
    await assert.rejects(
      client.request("thread/list", {
        archived: true,
        limit: 1,
        cursor: "not-a-valid-cursor",
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
    await assert.rejects(
      client.request("thread/list", {
        limit: 1,
        sortDirection: "desc",
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );

    const archivedRead = await client.request("thread/read", {
      threadId: archivedIds[0],
    });
    assert.equal(
      responseResult<Record<string, unknown>>(archivedRead, "thread").id,
      archivedIds[0],
    );
    const archivedResume = await client.request("thread/resume", {
      threadId: archivedIds[0],
    });
    assert.equal(
      responseResult<Record<string, unknown>>(archivedResume, "thread").id,
      archivedIds[0],
    );

    const beforeSnapshotChange = await threadListPage(client, { limit: 1 });
    assert.equal(typeof beforeSnapshotChange.nextCursor, "string");
    await client.request("thread/start", {});
    await assert.rejects(
      client.request("thread/list", {
        cursor: beforeSnapshotChange.nextCursor,
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
  } finally {
    client.close();
    await server.close();
  }
});

test("streams the minimal Codex Thread/Turn/Item lifecycle over WebSocket", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    const notifications: string[] = [];
    const completed = deferred<void>();
    for (const method of [
      "thread/started",
      "turn/started",
      "item/started",
      "item/agentMessage/delta",
      "item/completed",
      "thread/tokenUsage/updated",
      "turn/completed",
    ]) {
      client.onNotification(method, () => {
        notifications.push(method);
        if (method === "turn/completed") {
          completed.resolve();
        }
      });
    }

    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const start = await client.request("thread/start", {
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");
    assert.equal(typeof thread.id, "string");

    const turnStart = await client.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "hello", text_elements: [] }],
    });
    const turn = responseResult<Record<string, unknown>>(turnStart, "turn");
    assert.equal(turn.status, "inProgress");
    await completed.promise;

    assert(notifications.includes("thread/started"));
    assert(notifications.includes("turn/started"));
    assert(notifications.includes("item/agentMessage/delta"));
    assert(!notifications.includes("thread/tokenUsage/updated"));
    assert.equal(notifications.at(-1), "turn/completed");

    const read = await client.request("thread/read", {
      threadId: thread.id,
      includeTurns: true,
    });
    const readThread = responseResult<Record<string, unknown>>(read, "thread");
    assert(Array.isArray(readThread.turns));
    const firstTurn = readThread.turns[0];
    assert(isRecord(firstTurn));
    assert.equal(firstTurn.status, "completed");
    assert(Array.isArray(firstTurn.items));
    const projectedUser = firstTurn.items.find(
      (item) => isRecord(item) && item.type === "userMessage",
    );
    assert(isRecord(projectedUser));
    assert.equal(projectedUser.clientId, null);
  } finally {
    client.close();
    await server.close();
  }
});

test("preserves client user message IDs across subscribed connections", async () => {
  const appServer = testHost();
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const initiating = await CodexClient.connect(server.url);
  const observing = await CodexClient.connect(server.url);
  try {
    const userStarted = deferred<Record<string, unknown>>();
    const userCompleted = deferred<Record<string, unknown>>();
    const turnCompleted = deferred<void>();

    observing.onNotification("item/started", (params) => {
      if (
        isRecord(params) &&
        isRecord(params.item) &&
        params.item.type === "userMessage"
      ) {
        userStarted.resolve(params.item);
      }
    });
    observing.onNotification("item/completed", (params) => {
      if (
        isRecord(params) &&
        isRecord(params.item) &&
        params.item.type === "userMessage"
      ) {
        userCompleted.resolve(params.item);
      }
    });
    observing.onNotification("turn/completed", () => {
      turnCompleted.resolve();
    });

    await initiating.initialize({
      name: "initiating",
      title: "Initiating Client",
      version: "0.1.0",
    });
    await observing.initialize({
      name: "observing",
      title: "Observing Client",
      version: "0.1.0",
    });
    const start = await initiating.request("thread/start", {
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");
    if (typeof thread.id !== "string") {
      throw new Error("thread/start returned no thread id");
    }
    const threadId = thread.id;
    await observing.request("thread/resume", { threadId });

    const clientUserMessageId = "t3-user-message-123";
    await initiating.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "cross-client hello" }],
      clientUserMessageId,
    });

    const [startedItem, completedItem] = await within(
      Promise.all([userStarted.promise, userCompleted.promise]),
    );
    await within(turnCompleted.promise);
    assert.equal(startedItem.clientId, clientUserMessageId);
    assert.equal(completedItem.clientId, clientUserMessageId);
    assert.equal(startedItem.id, completedItem.id);

    const snapshot = await appServer.readThread(threadId);
    const canonicalUser = snapshot.items.find(
      (item) => item.type === "user_message",
    );
    assert.equal(canonicalUser?.clientId, clientUserMessageId);

    const read = await observing.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    const readThread = responseResult<Record<string, unknown>>(read, "thread");
    assert(Array.isArray(readThread.turns));
    const projectedTurn = readThread.turns[0];
    assert(isRecord(projectedTurn));
    assert(Array.isArray(projectedTurn.items));
    const projectedUser = projectedTurn.items.find(
      (item) => isRecord(item) && item.type === "userMessage",
    );
    assert(isRecord(projectedUser));
    assert.equal(projectedUser.clientId, clientUserMessageId);
  } finally {
    initiating.close();
    observing.close();
    await server.close();
  }
});

test("accepts matching T3 full-access resume and turn configuration", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    await client.initialize({
      name: "t3code_desktop",
      title: "T3 Code Desktop",
      version: "0.0.30",
    });
    const start = await client.request("thread/start", {
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");

    await assert.rejects(
      client.request("thread/resume", {
        threadId: thread.id,
        model: "",
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
    await assert.rejects(
      client.request("thread/settings/update", {
        threadId: thread.id,
        model: "",
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );

    const resumed = await client.request("thread/resume", {
      threadId: thread.id,
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
      serviceTier: null,
    });
    assert.equal(
      responseResult<Record<string, unknown>>(resumed, "thread").id,
      thread.id,
    );

    const completed = deferred<void>();
    client.onNotification("turn/completed", () => {
      completed.resolve();
    });
    const turn = await client.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "hello from T3" }],
      model: "fake",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
      serviceTier: null,
      effort: null,
      collaborationMode: {
        mode: "default",
        settings: {
          model: "fake",
          reasoning_effort: "medium",
          developer_instructions: "T3 default-mode compatibility envelope",
        },
      },
    });
    assert.equal(
      responseResult<Record<string, unknown>>(turn, "turn").status,
      "inProgress",
    );
    await completed.promise;
  } finally {
    client.close();
    await server.close();
  }
});

test("rejects mismatched or unsupported T3 thread configuration", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    await client.initialize({
      name: "t3code_desktop",
      title: "T3 Code Desktop",
      version: "0.0.30",
    });
    const start = await client.request("thread/start", {
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");

    await assert.rejects(
      client.request("thread/resume", {
        threadId: thread.id,
        model: "a-different-model",
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32000,
    );

    for (const params of [
      { threadId: thread.id, approvalPolicy: "on-request" },
      { threadId: thread.id, sandbox: "workspace-write" },
      { threadId: thread.id, approvalsReviewer: "auto_review" },
      { threadId: thread.id, serviceTier: "fast" },
    ]) {
      await assert.rejects(
        client.request("thread/resume", params),
        (error: unknown) =>
          error instanceof CodexClientError && error.code === -32602,
      );
    }

    const input = [{ type: "text", text: "must not run" }];
    await assert.rejects(
      client.request("turn/start", {
        threadId: thread.id,
        input,
        model: "",
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
    await assert.rejects(
      client.request("turn/start", {
        threadId: thread.id,
        input,
        model: "a-different-model",
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32000,
    );
    for (const overrides of [
      { approvalPolicy: "on-request" },
      { sandboxPolicy: { type: "workspaceWrite" } },
      { approvalsReviewer: "auto_review" },
      { serviceTier: "fast" },
      { collaborationMode: { mode: "plan", settings: {} } },
      {
        collaborationMode: {
          mode: "default",
          settings: {
            model: "a-different-model",
            reasoning_effort: "medium",
            developer_instructions: "ignored",
          },
        },
      },
    ]) {
      await assert.rejects(
        client.request("turn/start", {
          threadId: thread.id,
          input,
          ...overrides,
        }),
        (error: unknown) =>
          error instanceof CodexClientError && error.code === -32602,
      );
    }
    await assert.rejects(
      client.request("turn/start", {
        threadId: thread.id,
        input,
        effort: "high",
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32000,
    );
  } finally {
    client.close();
    await server.close();
  }
});

test("routes transient command approval and persists only command facts", async () => {
  const host = testHost("always");
  const server = await serveCodexWebSocket({
    appServer: host,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    let approvalRequests = 0;
    const commandOrder: string[] = [];
    client.onNotification("item/started", (params) => {
      if (
        isRecord(params) &&
        isRecord(params.item) &&
        params.item.type === "commandExecution"
      ) {
        commandOrder.push("item/started");
      }
    });
    client.onServerRequest(
      "item/commandExecution/requestApproval",
      (params) => {
        approvalRequests += 1;
        commandOrder.push("approval");
        assert.equal(
          (params as { command: string }).command,
          "printf protocol-approved",
        );
        return { decision: "accept" };
      },
    );
    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const start = await client.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");
    const completed = deferred<void>();
    client.onNotification("turn/completed", () => {
      completed.resolve();
    });
    await client.request("turn/start", {
      threadId: thread.id,
      input: [
        {
          type: "text",
          text: "!shell printf protocol-approved",
          text_elements: [],
        },
      ],
    });
    await completed.promise;
    assert.equal(approvalRequests, 1);
    assert.deepEqual(commandOrder, ["item/started", "approval"]);

    const snapshot = await host.readThread(String(thread.id));
    assert(!snapshot.items.some((item) => item.type.includes("approval")));
    assert(snapshot.items.some((item) => item.type === "tool_call"));
    assert(snapshot.items.some((item) => item.type === "tool_result"));
  } finally {
    client.close();
    await server.close();
  }
});

test("acceptForSession remains connection-local and suppresses later approval prompts", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost("always"),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    let approvalRequests = 0;
    client.onServerRequest("item/commandExecution/requestApproval", () => {
      approvalRequests += 1;
      return { decision: "acceptForSession" };
    });
    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const start = await client.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");

    for (const command of ["printf first", "printf second"]) {
      const completed = deferred<void>();
      const dispose = client.onNotification("turn/completed", () => {
        completed.resolve();
      });
      await client.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: `!shell ${command}`, text_elements: [] }],
      });
      await completed.promise;
      dispose();
    }
    assert.equal(approvalRequests, 1);
  } finally {
    client.close();
    await server.close();
  }
});

test("acceptForSession applies only to the approved thread on one connection", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost("always"),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    const approvalThreadIds: string[] = [];
    client.onServerRequest(
      "item/commandExecution/requestApproval",
      (params) => {
        assert(isRecord(params));
        const threadId = params.threadId;
        assert(typeof threadId === "string");
        approvalThreadIds.push(threadId);
        return {
          decision:
            approvalThreadIds.length === 1 ? "acceptForSession" : "accept",
        };
      },
    );
    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const firstStart = await client.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const firstThread = responseResult<Record<string, unknown>>(
      firstStart,
      "thread",
    );
    const secondStart = await client.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const secondThread = responseResult<Record<string, unknown>>(
      secondStart,
      "thread",
    );

    const runCommand = async (
      threadId: string,
      command: string,
    ): Promise<void> => {
      const completed = deferred<void>();
      const dispose = client.onNotification("turn/completed", (params) => {
        if (isRecord(params) && params.threadId === threadId) {
          completed.resolve();
        }
      });
      try {
        await client.request("turn/start", {
          threadId,
          input: [
            { type: "text", text: `!shell ${command}`, text_elements: [] },
          ],
        });
        await completed.promise;
      } finally {
        dispose();
      }
    };

    await runCommand(String(firstThread.id), "printf first");
    await runCommand(String(firstThread.id), "printf second");
    await runCommand(String(secondThread.id), "printf third");

    assert.deepEqual(approvalThreadIds, [
      String(firstThread.id),
      String(secondThread.id),
    ]);
  } finally {
    client.close();
    await server.close();
  }
});

test("matches the pinned thread/unsubscribe response and rejects thread/subscribe", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const start = await client.request("thread/start", {});
    const thread = responseResult<Record<string, unknown>>(start, "thread");

    assert.deepEqual(
      await client.request("thread/unsubscribe", { threadId: thread.id }),
      { status: "unsubscribed" },
    );
    assert.deepEqual(
      await client.request("thread/unsubscribe", { threadId: thread.id }),
      { status: "notSubscribed" },
    );
    await assert.rejects(
      client.request("thread/subscribe", { threadId: thread.id }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32601,
    );
    await assert.rejects(
      client.request("thread/start", { approvalPolicy: "untrusted" }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
    await assert.rejects(
      client.request("thread/start", { sandbox: "workspace-write" }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
  } finally {
    client.close();
    await server.close();
  }
});

test("interrupts a pending approval and resolves its server request", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost("always"),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    const approvalSeen = deferred<void>();
    const unansweredApproval = deferred<unknown>();
    const requestResolved = deferred<Record<string, unknown>>();
    const commandCompleted = deferred<Record<string, unknown>>();
    const turnCompleted = deferred<Record<string, unknown>>();

    client.onServerRequest("item/commandExecution/requestApproval", () => {
      approvalSeen.resolve();
      return unansweredApproval.promise;
    });
    client.onNotification("serverRequest/resolved", (params) => {
      if (isRecord(params)) {
        requestResolved.resolve(params);
      }
    });
    client.onNotification("item/completed", (params) => {
      if (
        isRecord(params) &&
        isRecord(params.item) &&
        params.item.type === "commandExecution"
      ) {
        commandCompleted.resolve(params.item);
      }
    });
    client.onNotification("turn/completed", (params) => {
      if (isRecord(params) && isRecord(params.turn)) {
        turnCompleted.resolve(params.turn);
      }
    });

    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const start = await client.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");
    const turnStart = await client.request("turn/start", {
      threadId: thread.id,
      input: [
        {
          type: "text",
          text: "!shell printf never-runs",
          text_elements: [],
        },
      ],
    });
    const turn = responseResult<Record<string, unknown>>(turnStart, "turn");
    await within(approvalSeen.promise);

    assert.deepEqual(
      await within(
        client.request("turn/interrupt", {
          threadId: thread.id,
          turnId: turn.id,
        }),
      ),
      {},
    );
    const [resolved, command, completedTurn] = await within(
      Promise.all([
        requestResolved.promise,
        commandCompleted.promise,
        turnCompleted.promise,
      ]),
    );
    assert.equal(resolved.threadId, thread.id);
    assert.equal(resolved.requestId, "approval_1");
    assert.equal(command.status, "declined");
    assert.equal(completedTurn.status, "interrupted");
  } finally {
    client.close();
    await server.close();
  }
});

test("resumed connections complete commands from canonical tool-call history", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost("always"),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const first = await CodexClient.connect(server.url);
  const resumed = await CodexClient.connect(server.url);
  try {
    const approvalSeen = deferred<void>();
    const approvalDecision = deferred<unknown>();
    const firstTurnCompleted = deferred<void>();
    const resumedCommand = deferred<Record<string, unknown>>();
    const resumedErrors: unknown[] = [];

    first.onServerRequest("item/commandExecution/requestApproval", () => {
      approvalSeen.resolve();
      return approvalDecision.promise;
    });
    first.onNotification("turn/completed", () => {
      firstTurnCompleted.resolve();
    });
    resumed.onNotification("item/completed", (params) => {
      if (
        isRecord(params) &&
        isRecord(params.item) &&
        params.item.type === "commandExecution"
      ) {
        resumedCommand.resolve(params.item);
      }
    });
    resumed.onNotification("error", (params) => {
      resumedErrors.push(params);
    });

    await first.initialize({
      name: "first",
      title: "First",
      version: "0.1.0",
    });
    await resumed.initialize({
      name: "resumed",
      title: "Resumed",
      version: "0.1.0",
    });
    const start = await first.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");
    await first.request("turn/start", {
      threadId: thread.id,
      input: [
        {
          type: "text",
          text: `!shell ${shellPrintCommand("resumed-command")}`,
          text_elements: [],
        },
      ],
    });
    await within(approvalSeen.promise);

    await resumed.request("thread/resume", { threadId: thread.id });
    approvalDecision.resolve({ decision: "accept" });

    const command = await within(resumedCommand.promise);
    await within(firstTurnCompleted.promise);
    assert.equal(command.status, "completed");
    assert.equal(command.aggregatedOutput, "resumed-command");
    assert.deepEqual(resumedErrors, []);
  } finally {
    first.close();
    resumed.close();
    await server.close();
  }
});

test("projects real shell exit 126 and 130 as failed rather than declined", async () => {
  const appServer = testHost();
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    await client.initialize({ name: "test", title: "Test", version: "1" });
    const started = await client.request("thread/start", {});
    const thread = responseResult<Record<string, unknown>>(started, "thread");
    for (const exitCode of [126, 130]) {
      const commandCompleted = deferred<Record<string, unknown>>();
      const turnCompleted = deferred<void>();
      const disposeCommand = client.onNotification(
        "item/completed",
        (params) => {
          if (
            isRecord(params) &&
            isRecord(params.item) &&
            params.item.type === "commandExecution"
          ) {
            commandCompleted.resolve(params.item);
          }
        },
      );
      const disposeTurn = client.onNotification("turn/completed", () => {
        turnCompleted.resolve();
      });
      await client.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: `!shell exit ${String(exitCode)}` }],
      });
      const command = await within(commandCompleted.promise);
      await within(turnCompleted.promise);
      disposeCommand();
      disposeTurn();
      assert.equal(command.exitCode, exitCode);
      assert.equal(command.status, "failed");
    }

    const snapshot = await appServer.readThread(String(thread.id));
    const results = snapshot.items.filter(
      (item) => item.type === "tool_result",
    );
    assert.deepEqual(
      results.map((result) =>
        "executionStatus" in result ? result.executionStatus : undefined,
      ),
      ["failed", "failed"],
    );
  } finally {
    client.close();
    await server.close();
  }
});

test("legacy declined inference requires both its sentinel code and exact output", () => {
  const call = {
    id: "call-item",
    threadId: "thread",
    turnId: "turn",
    createdAt: "2026-09-03T00:00:00.000Z",
    type: "tool_call" as const,
    callId: "call",
    name: "shell",
    arguments: { command: "exit 126" },
  };
  const result = (exitCode: number, output: string) => ({
    id: `result-${String(exitCode)}`,
    threadId: "thread",
    turnId: "turn",
    createdAt: "2026-09-03T00:00:01.000Z",
    type: "tool_result" as const,
    callId: "call",
    exitCode,
    output,
  });

  assert.equal(
    projectCommandCompleted(
      call,
      result(126, "User declined this tool call."),
      "/tmp",
    ).status,
    "declined",
  );
  assert.equal(
    projectCommandCompleted(call, result(126, "real exit"), "/tmp").status,
    "failed",
  );
  assert.equal(
    projectCommandCompleted(
      call,
      result(130, "User cancelled this tool call."),
      "/tmp",
    ).status,
    "declined",
  );
  assert.equal(projectCommandStarted(call, "/tmp").status, "inProgress");
});

test("a rejected terminal append emits an error but no invented completion", async () => {
  const backing = new InMemoryThreadJournal();
  let rejectTerminal = false;
  const journal: ThreadJournal = {
    append: async (item) => {
      await backing.append(item);
      if (rejectTerminal && item.type === "turn_completed") {
        throw new Error("terminal durability unknown");
      }
    },
    listThreadIds: async () => await backing.listThreadIds(),
    read: async (threadId) => await backing.read(threadId),
  };
  const appServer = createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: path.join(os.tmpdir(), "unused-zen-test-data"),
    model: "fake",
    approvalPolicy: "never",
    provider: { type: "fake" },
    journal,
    threadMetadata: new InMemoryThreadMetadataStore(),
  });
  const thread = await appServer.startThread();
  const messages: JsonRpcMessage[] = [];
  const errorSeen = deferred<void>();
  const connection = new CodexConnection({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    send: (message) => {
      messages.push(message);
      if ("method" in message && message.method === "error") {
        errorSeen.resolve();
      }
    },
  });

  try {
    await connection.receive({ id: 1, method: "initialize", params: {} });
    await connection.receive({ method: "initialized" });
    rejectTerminal = true;
    await connection.receive({
      id: 2,
      method: "turn/start",
      params: {
        threadId: thread.id,
        input: [{ type: "text", text: "complete ambiguously" }],
      },
    });
    await within(errorSeen.promise);

    const turnResponse = messages.find(
      (message) => "result" in message && message.id === 2,
    );
    assert(turnResponse !== undefined && "result" in turnResponse);
    const turnId = responseResult<Record<string, unknown>>(
      turnResponse.result,
      "turn",
    ).id;
    assert.equal(
      messages.some(
        (message) =>
          "method" in message &&
          message.method === "turn/completed" &&
          isRecord(message.params) &&
          isRecord(message.params.turn) &&
          message.params.turn.id === turnId,
      ),
      false,
    );
    assert.equal(
      (await appServer.readThread(thread.id)).turns.at(-1)?.status,
      "completed",
    );
  } finally {
    connection.close();
    await appServer.closeProviderTransport();
  }
});

test("a rejected replacement terminal append emits no invented successor completion", async () => {
  const backing = new InMemoryThreadJournal();
  let rejectTerminal = false;
  const journal: ThreadJournal = {
    append: async (item) => {
      await backing.append(item);
      if (rejectTerminal && item.type === "turn_completed") {
        throw new Error("replacement terminal durability unknown");
      }
    },
    listThreadIds: async () => await backing.listThreadIds(),
    read: async (threadId) => await backing.read(threadId),
  };
  let sample = 0;
  const model: ModelAdapter = {
    provider: "replacement-outcome",
    async *stream(request) {
      sample += 1;
      if (sample === 1) {
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else
            request.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        request.signal.throwIfAborted();
      }
      yield { type: "text_delta", delta: "replacement complete" };
    },
  };
  const appServer = new ZenAppServer({
    journal,
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({
        runtimes: [new ShellToolRuntime()],
      }),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          {
            id: "replacement-model",
            isDefault: true,
            supportedReasoningEfforts: ["medium"],
            defaultReasoningEffort: "medium",
          },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: model.provider,
      modelId: "replacement-model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  const thread = await appServer.startThread();
  const messages: JsonRpcMessage[] = [];
  const errorSeen = deferred<void>();
  const connection = new CodexConnection({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    send: (message) => {
      messages.push(message);
      if ("method" in message && message.method === "error")
        errorSeen.resolve();
    },
  });

  try {
    await connection.receive({ id: 1, method: "initialize", params: {} });
    await connection.receive({ method: "initialized" });
    await connection.receive({
      id: 2,
      method: "turn/start",
      params: { threadId: thread.id, input: [{ type: "text", text: "first" }] },
    });
    const firstResponse = messages.find(
      (message) => "result" in message && message.id === 2,
    );
    assert(firstResponse !== undefined && "result" in firstResponse);
    const firstTurnId = responseResult<Record<string, unknown>>(
      firstResponse.result,
      "turn",
    ).id;

    rejectTerminal = true;
    await connection.receive({
      id: 3,
      method: "turn/replace",
      params: {
        threadId: thread.id,
        expectedTurnId: firstTurnId,
        clientUserMessageId: "replacement-client",
        input: [{ type: "text", text: "replacement" }],
      },
    });
    const replacementResponse = messages.find(
      (message) => "result" in message && message.id === 3,
    );
    assert(
      replacementResponse !== undefined && "result" in replacementResponse,
    );
    assert(
      isRecord(replacementResponse.result) &&
        typeof replacementResponse.result.turnId === "string",
    );
    const successorTurnId = replacementResponse.result.turnId;
    await within(errorSeen.promise);
    assert.equal(
      messages.some(
        (message) =>
          "method" in message &&
          message.method === "turn/completed" &&
          isRecord(message.params) &&
          isRecord(message.params.turn) &&
          message.params.turn.id === successorTurnId,
      ),
      false,
    );
    assert.equal(
      (await appServer.readThread(thread.id)).turns.at(-1)?.status,
      "completed",
    );
  } finally {
    connection.close();
  }
});

test("CLI executes one full local protocol turn", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zen-cli-test-"),
  );
  try {
    const echo = await executeCli([
      "run",
      "--data-dir",
      temporaryDirectory,
      "hello CLI",
    ]);
    assert.equal(echo.stderr, "");
    assert.match(echo.stdout, /Echo: hello CLI/);
    const [persistedThreadFile] = await readdir(
      path.join(temporaryDirectory, "threads"),
    );
    if (
      persistedThreadFile === undefined ||
      !persistedThreadFile.endsWith(".jsonl")
    ) {
      throw new Error("CLI did not persist the expected Thread journal");
    }
    const persistedThreadId = persistedThreadFile.slice(0, -".jsonl".length);

    for (const [options, expected] of [
      [["--approval", "always", "--approve"], /approvalPolicy does not match/u],
      [["--cwd", os.tmpdir()], /cwd does not match/u],
    ] as const) {
      await assert.rejects(
        executeCli([
          "run",
          "--data-dir",
          temporaryDirectory,
          "--thread",
          persistedThreadId,
          ...options,
          "resume must reject a mismatched explicit setting",
        ]),
        expected,
      );
    }

    const switchedModel = await executeCli([
      "run",
      "--data-dir",
      temporaryDirectory,
      "--thread",
      persistedThreadId,
      "--model",
      "different-model",
      "resume with a different model",
    ]);
    assert.match(switchedModel.stdout, /Echo: resume with a different model/u);

    const switchedFromCatalog = await executeCli([
      "run",
      "--data-dir",
      temporaryDirectory,
      "--thread",
      persistedThreadId,
      "--model",
      "fake",
      "--models",
      "fake,different-model",
      "resume with a host model catalog",
    ]);
    assert.match(
      switchedFromCatalog.stdout,
      /Echo: resume with a host model catalog/u,
    );

    const matchingResume = await executeCli([
      "run",
      "--data-dir",
      temporaryDirectory,
      "--thread",
      persistedThreadId,
      "--approval",
      "never",
      "resume with matching settings",
    ]);
    assert.match(matchingResume.stdout, /Echo: resume with matching settings/u);

    const fullAccessTool = await executeCli([
      "run",
      "--data-dir",
      temporaryDirectory,
      `!shell ${shellPrintCommand("cli-full-access")}`,
    ]);
    assert.equal(fullAccessTool.stderr, "");
    assert.match(fullAccessTool.stdout, /Command result:\s+cli-full-access/u);

    const approvedTool = await executeCli([
      "run",
      "--data-dir",
      temporaryDirectory,
      "--approve",
      `!shell ${shellPrintCommand("cli-approved")}`,
    ]);
    assert.equal(approvedTool.stderr, "");
    assert.match(approvedTool.stdout, /Command result:\s+cli-approved/u);

    const deniedTool = await executeCli([
      "run",
      "--data-dir",
      temporaryDirectory,
      "--deny",
      "!shell printf command-must-not-run",
    ]);
    assert.equal(deniedTool.stderr, "");
    assert.match(deniedTool.stdout, /User declined this tool call/u);
    assert.doesNotMatch(deniedTool.stdout, /command-must-not-run/u);

    await assert.rejects(
      executeCli([
        "run",
        "--data-dir",
        temporaryDirectory,
        "--approve",
        "--deny",
        "conflicting decisions",
      ]),
      /--approve and --deny cannot be used together/u,
    );
    await assert.rejects(
      executeCli([
        "run",
        "--data-dir",
        temporaryDirectory,
        "--approval",
        "never",
        "--approve",
        "contradictory approval mode",
      ]),
      /--approve\/--deny require approval mode/u,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

async function executeCli(
  arguments_: string[],
): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.resolve("dist/apps/cli/src/cli.js"), ...arguments_],
      { cwd: process.cwd() },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`${error.message}\n${stderr}`));
        }
      },
    );
  });
}

async function threadListPage(
  client: CodexClient,
  params: { archived?: boolean; limit?: number; cursor?: string | null },
): Promise<{
  ids: string[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}> {
  const result = await client.request("thread/list", params);
  assert(isRecord(result) && Array.isArray(result.data));
  assert(result.nextCursor === null || typeof result.nextCursor === "string");
  assert(
    result.backwardsCursor === null ||
      typeof result.backwardsCursor === "string",
  );
  return {
    ids: result.data.map((entry) => {
      assert(isRecord(entry) && typeof entry.id === "string");
      return entry.id;
    }),
    nextCursor: result.nextCursor,
    backwardsCursor: result.backwardsCursor,
  };
}

function wireModel(modelId: string): string {
  return encodeModelKey({ providerProfileId: "fake", modelId });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${String(timeoutMs)} ms`));
    }, timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
