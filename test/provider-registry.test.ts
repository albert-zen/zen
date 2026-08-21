import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenAppServer } from "../src/app-server.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { CodexClient, CodexClientError } from "../src/protocol/codex/client.js";
import {
  decodeModelKey,
  encodeModelKey,
} from "../src/protocol/codex/model-key.js";
import { serveCodexWebSocket } from "../src/protocol/codex/websocket.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ShellToolExecutor } from "../src/tool.js";

test("routes duplicate model ids and reasoning effort through the fixed Codex wire", async () => {
  const requestsA: ModelRequest[] = [];
  const requestsB: ModelRequest[] = [];
  const adapter = (
    provider: string,
    requests: ModelRequest[],
  ): ModelAdapter => ({
    provider,
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(request);
      yield { type: "text_delta", delta: provider };
    },
  });
  const registry = new ProviderRegistry([
    {
      providerProfileId: "profile-a",
      adapter: adapter("adapter-a", requestsA),
      modelCatalog: new StaticModelCatalog([
        {
          id: "shared-model",
          isDefault: true,
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "low",
          inputModalities: ["text", "image"],
        },
      ]),
    },
    {
      providerProfileId: "profile-b",
      adapter: adapter("adapter-b", requestsB),
      modelCatalog: new StaticModelCatalog([
        {
          id: "shared-model",
          isDefault: true,
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "high",
        },
        {
          id: "high-only-model",
          supportedReasoningEfforts: ["high"],
          defaultReasoningEffort: "high",
        },
      ]),
    },
  ]);
  const appServer = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    runtime: new AgentRuntime({ tools: new ShellToolExecutor() }),
    providerRegistry: registry,
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: "profile-a",
      modelId: "shared-model",
      reasoningEffort: "low",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  const wire = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-provider-registry-test"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(wire.url);
  try {
    await client.initialize({ name: "test", title: "Test", version: "1" });
    const listed = (await client.request("model/list", {})) as {
      data: Array<{
        model: string;
        supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
        inputModalities: string[];
      }>;
    };
    assert.equal(listed.data.length, 3);
    assert.notEqual(listed.data[0]?.model, listed.data[1]?.model);
    assert.deepEqual(
      listed.data[0]?.supportedReasoningEfforts.map(
        (entry) => entry.reasoningEffort,
      ),
      ["low", "high"],
    );
    assert.deepEqual(listed.data[0]?.inputModalities, ["text", "image"]);
    assert.deepEqual(listed.data[1]?.inputModalities, ["text"]);

    const started = (await client.request("thread/start", {
      model: listed.data[0]?.model,
    })) as { thread: { id: string } };
    await completeTurn(client, started.thread.id, "first");
    await client.request("thread/settings/update", {
      threadId: started.thread.id,
      model: listed.data[1]?.model,
    });
    await completeTurn(client, started.thread.id, "second");
    await client.request("thread/settings/update", {
      threadId: started.thread.id,
      model: listed.data[2]?.model,
    });
    await completeTurn(client, started.thread.id, "third");

    assert.deepEqual(
      requestsA.map(({ model, reasoningEffort }) => ({
        model,
        reasoningEffort,
      })),
      [{ model: "shared-model", reasoningEffort: "low" }],
    );
    assert.deepEqual(
      requestsB.map(({ model, reasoningEffort }) => ({
        model,
        reasoningEffort,
      })),
      [
        { model: "shared-model", reasoningEffort: "low" },
        { model: "high-only-model", reasoningEffort: "high" },
      ],
    );
    const snapshot = await appServer.readThread(started.thread.id);
    const change = snapshot.items.find(
      (item) => item.type === "thread_configuration_changed",
    );
    assert(change?.type === "thread_configuration_changed");
    assert("selection" in change);
    assert.deepEqual(change.selection, {
      from: selection("profile-a", "low"),
      to: selection("profile-b", "low"),
    });
    const changes = snapshot.items.filter(
      (item) => item.type === "thread_configuration_changed",
    );
    assert.equal(changes.length, 2);
    const fallback = changes[1];
    assert(fallback?.type === "thread_configuration_changed");
    assert("selection" in fallback);
    assert.deepEqual(fallback.selection, {
      from: selection("profile-b", "low"),
      to: {
        providerProfileId: "profile-b",
        modelId: "high-only-model",
        reasoningEffort: "high",
      },
    });
    assert.deepEqual(
      snapshot.turns.map((turn) => turn.selection),
      [
        {
          providerProfileId: "profile-a",
          modelId: "shared-model",
          reasoningEffort: "low",
        },
        {
          providerProfileId: "profile-b",
          modelId: "shared-model",
          reasoningEffort: "low",
        },
        {
          providerProfileId: "profile-b",
          modelId: "high-only-model",
          reasoningEffort: "high",
        },
      ],
    );
  } finally {
    client.close();
    await wire.close();
  }
});

test("preserves compatible effort and falls back for incompatible Core changes", async () => {
  const requestsA: ModelRequest[] = [];
  const requestsB: ModelRequest[] = [];
  const server = createRegistryServer({
    registry: new ProviderRegistry([
      {
        providerProfileId: "profile-a",
        adapter: recordingAdapter("adapter-a", requestsA),
        modelCatalog: new StaticModelCatalog([
          {
            id: "medium-model",
            isDefault: true,
            supportedReasoningEfforts: ["medium"],
            defaultReasoningEffort: "medium",
          },
          {
            id: "compatible-model",
            supportedReasoningEfforts: ["low", "medium"],
            defaultReasoningEffort: "low",
          },
        ]),
      },
      {
        providerProfileId: "profile-b",
        adapter: recordingAdapter("adapter-b", requestsB),
        modelCatalog: new StaticModelCatalog([
          {
            id: "low-model",
            isDefault: true,
            supportedReasoningEfforts: ["low"],
            defaultReasoningEffort: "low",
          },
        ]),
      },
    ]),
    defaultSelection: {
      providerProfileId: "profile-a",
      modelId: "medium-model",
      reasoningEffort: "medium",
    },
  });
  const thread = await server.startThread();

  const compatible = await server.updateThreadSettings(thread.id, {
    model: "compatible-model",
  });
  assert.equal(compatible.modelId, "compatible-model");
  assert.equal(compatible.reasoningEffort, "medium");
  await (
    await server.startTurn(thread.id, "preserves the compatible effort")
  ).done;

  const incompatible = await server.updateThreadSettings(thread.id, {
    selection: {
      providerProfileId: "profile-b",
      modelId: "low-model",
    },
  });
  assert.equal(incompatible.providerProfileId, "profile-b");
  assert.equal(incompatible.modelId, "low-model");
  assert.equal(incompatible.reasoningEffort, "low");
  await (
    await server.startTurn(thread.id, "uses the target default")
  ).done;
  assert.deepEqual(
    requestsA.map(({ model, reasoningEffort }) => ({ model, reasoningEffort })),
    [{ model: "compatible-model", reasoningEffort: "medium" }],
  );
  assert.deepEqual(
    requestsB.map(({ model, reasoningEffort }) => ({ model, reasoningEffort })),
    [{ model: "low-model", reasoningEffort: "low" }],
  );
});

test("fixed model/list omits unknown and non-runnable entries without hiding valid models", async () => {
  const registry = new ProviderRegistry([
    {
      providerProfileId: "profile-a",
      adapter: recordingAdapter("adapter-a", []),
      modelCatalog: new StaticModelCatalog([
        { id: "shared-model", isDefault: true },
        {
          id: "unknown",
          source: "discovered",
          supportedReasoningEfforts: null,
          defaultReasoningEffort: null,
          inputModalities: null,
          contextWindow: null,
        },
        {
          id: "unsupported",
          source: "manual",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: [],
          contextWindow: 4_096,
        },
      ]),
    },
  ]);
  const appServer = createRegistryServer({
    registry,
    defaultSelection: selection("profile-a", "medium"),
  });
  const wire = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-model-capability-projection"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(wire.url);
  try {
    await client.initialize({ name: "test", title: "Test", version: "1" });
    const projected = registry.listModels();
    assert.equal(
      projected.find((entry) => entry.model.id === "unknown")?.model
        .supportedReasoningEfforts,
      null,
    );
    assert.deepEqual(
      projected.find((entry) => entry.model.id === "unsupported")?.model
        .supportedReasoningEfforts,
      [],
    );
    const listed = (await client.request("model/list", {})) as {
      data: Array<{ model: string }>;
    };
    assert.equal(listed.data.length, 1);
    assert.deepEqual(decodeModelKey(listed.data[0]!.model), {
      providerProfileId: "profile-a",
      modelId: "shared-model",
    });
  } finally {
    client.close();
    await wire.close();
  }
});

test("manual capability override makes an otherwise unknown model visible in fixed model/list", async () => {
  const registry = new ProviderRegistry([
    {
      providerProfileId: "profile-a",
      adapter: recordingAdapter("adapter-a", []),
      modelCatalog: new StaticModelCatalog([
        { id: "shared-model", isDefault: true },
        {
          id: "discovered-only",
          source: "manual",
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "high",
          inputModalities: ["text", "image"],
          contextWindow: null,
        },
      ]),
    },
  ]);
  const appServer = createRegistryServer({
    registry,
    defaultSelection: selection("profile-a", "medium"),
  });
  const wire = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-manual-model-capability-projection"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(wire.url);
  try {
    await client.initialize({ name: "test", title: "Test", version: "1" });
    const listed = (await client.request("model/list", {})) as {
      data: Array<{
        model: string;
        supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
        defaultReasoningEffort: string;
        inputModalities: string[];
      }>;
    };
    const manual = listed.data.find(
      (entry) => decodeModelKey(entry.model).modelId === "discovered-only",
    );
    assert(manual !== undefined);
    assert.deepEqual(
      manual.supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
      ["low", "high"],
    );
    assert.equal(manual.defaultReasoningEffort, "high");
    assert.deepEqual(manual.inputModalities, ["text", "image"]);
  } finally {
    client.close();
    await wire.close();
  }
});

test("rejects an explicit effort for unknown reasoning without mutating the Thread or invoking the adapter", async () => {
  const requests: ModelRequest[] = [];
  const server = createRegistryServer({
    registry: new ProviderRegistry([
      {
        providerProfileId: "profile-a",
        adapter: recordingAdapter("adapter-a", requests),
        modelCatalog: new StaticModelCatalog([
          { id: "shared-model", isDefault: true },
          {
            id: "discovered-only",
            source: "discovered",
            supportedReasoningEfforts: null,
            defaultReasoningEffort: null,
            inputModalities: null,
            contextWindow: null,
          },
        ]),
      },
    ]),
    defaultSelection: selection("profile-a", "medium"),
  });
  const thread = await server.startThread();
  const before = await server.readThread(thread.id);
  await assert.rejects(
    server.startTurn(thread.id, "must not run", {
      selection: {
        providerProfileId: "profile-a",
        modelId: "discovered-only",
        reasoningEffort: "user-supplied-effort",
      },
    }),
    hasZenCode("reasoning_effort_unknown"),
  );
  const after = await server.readThread(thread.id);
  assert.equal(after.modelId, "shared-model");
  assert.equal(after.reasoningEffort, "medium");
  assert.deepEqual(after.items, before.items);
  assert.equal(requests.length, 0);
});

test("keeps opaque model keys stable and round-trippable", () => {
  const identity = {
    providerProfileId: "profile-a",
    modelId: "shared-model",
  };
  const key = encodeModelKey(identity);
  assert.equal(key, "zen-model-v1:WyJwcm9maWxlLWEiLCJzaGFyZWQtbW9kZWwiXQ");
  assert.deepEqual(decodeModelKey(key), identity);
  const unicodeIdentity = {
    providerProfileId: "本地-provider",
    modelId: "模型/β",
  };
  assert.deepEqual(
    decodeModelKey(encodeModelKey(unicodeIdentity)),
    unicodeIdentity,
  );
});

test("freezes an active Turn selection while a concurrent change applies to the next Turn", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const requestsA: ModelRequest[] = [];
  const requestsB: ModelRequest[] = [];
  const adapterA: ModelAdapter = {
    provider: "adapter-a",
    async *stream(request): AsyncIterable<ModelEvent> {
      requestsA.push(request);
      entered.resolve();
      await release.promise;
      yield { type: "text_delta", delta: "a" };
    },
  };
  const adapterB = recordingAdapter("adapter-b", requestsB);
  const server = createRegistryServer({
    registry: duplicateModelRegistry(adapterA, adapterB),
  });
  const thread = await server.startThread();
  const launching = server.startTurn(thread.id, "first");
  const changing = server.updateThreadSettings(thread.id, {
    selection: selection("profile-b", "high"),
  });
  const first = await launching;
  await changing;
  await entered.promise;
  release.resolve();
  await first.done;
  await (
    await server.startTurn(thread.id, "second")
  ).done;

  assert.deepEqual(
    requestsA.map((request) => request.reasoningEffort),
    ["low"],
  );
  assert.deepEqual(
    requestsB.map((request) => request.reasoningEffort),
    ["high"],
  );
  assert.deepEqual(
    (await server.readThread(thread.id)).turns.map((turn) => turn.selection),
    [selection("profile-a", "low"), selection("profile-b", "high")],
  );
});

test("replays the same per-Turn selections after journal restart", async () => {
  const journal = new InMemoryThreadJournal();
  const firstRequests: ModelRequest[] = [];
  const secondRequests: ModelRequest[] = [];
  const registry = duplicateModelRegistry(
    recordingAdapter("adapter-a", firstRequests),
    recordingAdapter("adapter-b", secondRequests),
  );
  const initial = createRegistryServer({ journal, registry });
  const thread = await initial.startThread();
  await (
    await initial.startTurn(thread.id, "first")
  ).done;
  await initial.updateThreadSettings(thread.id, {
    selection: selection("profile-b", "high"),
  });
  await (
    await initial.startTurn(thread.id, "second")
  ).done;

  const restarted = createRegistryServer({ journal, registry });
  assert.deepEqual(
    (await restarted.readThread(thread.id)).turns.map((turn) => turn.selection),
    [selection("profile-a", "low"), selection("profile-b", "high")],
  );
  await (
    await restarted.startTurn(thread.id, "third")
  ).done;
  assert.equal(secondRequests.at(-1)?.reasoningEffort, "high");
});

test("reads legacy provider/model Items without rewriting the journal", async () => {
  const journal = new InMemoryThreadJournal();
  const threadId = "legacy_provider_items";
  const legacyItems = [
    {
      id: "metadata",
      threadId,
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "thread_metadata" as const,
      cwd: process.cwd(),
      provider: "profile-a",
      model: "shared-model",
      sandbox: "danger-full-access" as const,
      approvalPolicy: "never" as const,
    },
    {
      id: "turn-started",
      threadId,
      turnId: "legacy-turn",
      createdAt: "2026-01-01T00:00:01.000Z",
      type: "turn_started" as const,
    },
    {
      id: "turn-completed",
      threadId,
      turnId: "legacy-turn",
      createdAt: "2026-01-01T00:00:02.000Z",
      type: "turn_completed" as const,
      status: "completed" as const,
    },
    {
      id: "legacy-change",
      threadId,
      createdAt: "2026-01-01T00:00:03.000Z",
      type: "thread_configuration_changed" as const,
      model: { from: "shared-model", to: "second-model" },
    },
  ];
  for (const item of legacyItems) await journal.append(item);
  const adapter = recordingAdapter("adapter-a", []);
  const server = createRegistryServer({
    journal,
    registry: new ProviderRegistry([
      {
        providerProfileId: "profile-a",
        adapter,
        modelCatalog: new StaticModelCatalog([
          { id: "shared-model", isDefault: true },
          { id: "second-model" },
        ]),
      },
    ]),
    defaultSelection: selection("profile-a", "medium"),
  });

  const snapshot = await server.readThread(threadId);
  assert.equal(snapshot.providerProfileId, "profile-a");
  assert.equal(snapshot.modelId, "second-model");
  assert.equal(snapshot.reasoningEffort, "medium");
  assert.deepEqual(snapshot.turns[0]?.selection, {
    providerProfileId: "profile-a",
    modelId: "shared-model",
    reasoningEffort: "medium",
  });
  assert.deepEqual(await journal.read(threadId), legacyItems);
});

test("keeps a deleted-profile Thread readable and lets the user switch to an available profile", async () => {
  const journal = new InMemoryThreadJournal();
  const original = createRegistryServer({
    journal,
    registry: duplicateModelRegistry(
      recordingAdapter("adapter-a", []),
      recordingAdapter("adapter-b", []),
    ),
  });
  const thread = await original.startThread();
  const requestsB: ModelRequest[] = [];
  const availableOnly = createRegistryServer({
    journal,
    registry: new ProviderRegistry([
      {
        providerProfileId: "profile-b",
        adapter: recordingAdapter("adapter-b", requestsB),
        modelCatalog: catalog(),
      },
    ]),
    defaultSelection: selection("profile-b", "low"),
  });

  assert.equal(
    (await availableOnly.readThread(thread.id)).providerProfileId,
    "profile-a",
  );
  await assert.rejects(
    availableOnly.startTurn(thread.id, "cannot run"),
    hasZenCode("provider_unavailable"),
  );
  assert.equal((await journal.read(thread.id)).length, 1);
  await availableOnly.updateThreadSettings(thread.id, {
    selection: selection("profile-b", "high"),
  });
  await (
    await availableOnly.startTurn(thread.id, "runs after explicit switch")
  ).done;
  assert.equal(requestsB[0]?.reasoningEffort, "high");
});

test("rejects malformed keys and unknown profile, model, or effort explicitly", async () => {
  const appServer = createRegistryServer({
    registry: duplicateModelRegistry(
      recordingAdapter("adapter-a", []),
      recordingAdapter("adapter-b", []),
    ),
  });
  const wire = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-provider-rejections"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(wire.url);
  try {
    await client.initialize({ name: "test", title: "Test", version: "1" });
    const listed = (await client.request("model/list", {})) as {
      data: Array<{ model: string }>;
    };
    const started = (await client.request("thread/start", {
      model: listed.data[0]?.model,
    })) as { thread: { id: string } };

    await assert.rejects(
      client.request("thread/settings/update", {
        threadId: started.thread.id,
        model: "zen-model-v1:not+base64",
      }),
      isRpcError(-32602),
    );
    for (const [model, effort, messageFragment] of [
      [
        encodeModelKey({
          providerProfileId: "missing",
          modelId: "shared-model",
        }),
        "low",
        "provider profile is not available",
      ],
      [
        encodeModelKey({ providerProfileId: "profile-a", modelId: "missing" }),
        "low",
        "model missing is not available",
      ],
      [
        listed.data[0]?.model,
        "unknown-effort",
        "reasoning effort unknown-effort is not available",
      ],
    ] as const) {
      await assert.rejects(
        client.request("thread/settings/update", {
          threadId: started.thread.id,
          model,
          effort,
        }),
        isRpcError(-32000, messageFragment),
      );
    }
  } finally {
    client.close();
    await wire.close();
  }
});

async function completeTurn(
  client: CodexClient,
  threadId: string,
  text: string,
): Promise<void> {
  const completed = new Promise<void>((resolve) => {
    const dispose = client.onNotification("turn/completed", (params) => {
      if (
        typeof params === "object" &&
        params !== null &&
        "threadId" in params &&
        params.threadId === threadId
      ) {
        dispose();
        resolve();
      }
    });
  });
  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text }],
  });
  await completed;
}

function catalog(): StaticModelCatalog {
  return new StaticModelCatalog([
    {
      id: "shared-model",
      isDefault: true,
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
    },
  ]);
}

function duplicateModelRegistry(
  adapterA: ModelAdapter,
  adapterB: ModelAdapter,
): ProviderRegistry {
  return new ProviderRegistry([
    {
      providerProfileId: "profile-a",
      adapter: adapterA,
      modelCatalog: catalog(),
    },
    {
      providerProfileId: "profile-b",
      adapter: adapterB,
      modelCatalog: catalog(),
    },
  ]);
}

function selection(
  providerProfileId: string,
  reasoningEffort: string,
): {
  providerProfileId: string;
  modelId: string;
  reasoningEffort: string;
} {
  return { providerProfileId, modelId: "shared-model", reasoningEffort };
}

function recordingAdapter(
  provider: string,
  requests: ModelRequest[],
): ModelAdapter {
  return {
    provider,
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(request);
      yield { type: "text_delta", delta: provider };
    },
  };
}

function createRegistryServer(options: {
  registry: ProviderRegistry;
  journal?: InMemoryThreadJournal;
  defaultSelection?: ReturnType<typeof selection>;
}): ZenAppServer {
  const defaultSelection =
    options.defaultSelection ?? selection("profile-a", "low");
  return new ZenAppServer({
    journal: options.journal ?? new InMemoryThreadJournal(),
    runtime: new AgentRuntime({ tools: new ShellToolExecutor() }),
    providerRegistry: options.registry,
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      ...defaultSelection,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function hasZenCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}

function isRpcError(
  rpcCode: number,
  messageFragment?: string,
): (error: unknown) => boolean {
  return (error) =>
    error instanceof CodexClientError &&
    error.code === rpcCode &&
    (messageFragment === undefined ||
      error.message.toLowerCase().includes(messageFragment));
}
