import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AttachmentRef, AttachmentStore } from "../src/attachment.js";
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
import { ShellToolRuntime, ToolEnvironment } from "../src/tool.js";

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
          contextWindow: 32_768,
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
          contextWindow: 32_768,
        },
        {
          id: "high-only-model",
          supportedReasoningEfforts: ["high"],
          defaultReasoningEffort: "high",
          contextWindow: 32_768,
        },
      ]),
    },
  ]);
  const appServer = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({
        runtimes: [new ShellToolRuntime()],
      }),
    }),
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
            contextWindow: 32_768,
          },
          {
            id: "compatible-model",
            supportedReasoningEfforts: ["low", "medium"],
            defaultReasoningEffort: "low",
            contextWindow: 32_768,
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
            contextWindow: 32_768,
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
        { id: "shared-model", isDefault: true, contextWindow: 8_192 },
        {
          id: "missing-context",
          source: "discovered",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ["text"],
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
      projected.find((entry) => entry.model.id === "missing-context")?.model
        .contextWindow,
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
        { id: "shared-model", isDefault: true, contextWindow: 8_192 },
        {
          id: "discovered-only",
          source: "manual",
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "high",
          inputModalities: ["text", "image"],
          contextWindow: 32_768,
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

test("text-only models are selectable, run without an effort, and remain in model/list", async () => {
  const requests: ModelRequest[] = [];
  const registry = new ProviderRegistry([
    {
      providerProfileId: "profile-a",
      adapter: recordingAdapter("adapter-a", requests),
      modelCatalog: new StaticModelCatalog([
        { id: "shared-model", isDefault: true, contextWindow: 8_192 },
        {
          id: "text-only-model",
          source: "discovered",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ["text"],
          contextWindow: 32_768,
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
    zenHome: path.join(os.tmpdir(), "zen-text-only-model-projection"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(wire.url);
  try {
    await client.initialize({ name: "test", title: "Test", version: "1" });
    const listed = (await client.request("model/list", {})) as {
      data: Array<{
        model: string;
        defaultReasoningEffort: string | null;
        supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
        inputModalities: string[];
      }>;
    };
    const textOnly = listed.data.find(
      (entry) => decodeModelKey(entry.model).modelId === "text-only-model",
    );
    assert(textOnly !== undefined);
    assert.equal(textOnly.defaultReasoningEffort, null);
    assert.deepEqual(textOnly.supportedReasoningEfforts, []);
    assert.deepEqual(textOnly.inputModalities, ["text"]);

    const started = (await client.request("thread/start", {
      model: textOnly.model,
    })) as { thread: { id: string } };
    await completeTurn(client, started.thread.id, "plain text request");
    assert.deepEqual(
      requests.map(({ model, reasoningEffort }) => ({
        model,
        reasoningEffort,
      })),
      [{ model: "text-only-model", reasoningEffort: null }],
    );
  } finally {
    client.close();
    await wire.close();
  }
});

test("rejects a model with incomplete context metadata before runtime selection", () => {
  const registry = new ProviderRegistry([
    {
      providerProfileId: "profile-a",
      adapter: recordingAdapter("adapter-a", []),
      modelCatalog: new StaticModelCatalog([
        {
          id: "incomplete",
          isDefault: true,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ["text"],
          contextWindow: null,
          source: "discovered",
        },
      ]),
    },
  ]);

  assert.throws(
    () =>
      registry.resolve({
        providerProfileId: "profile-a",
        modelId: "incomplete",
      }),
    hasZenCode("context_window_unknown"),
  );
});

test("rejects an explicit effort for unknown reasoning without mutating the Thread or invoking the adapter", async () => {
  const requests: ModelRequest[] = [];
  const server = createRegistryServer({
    registry: new ProviderRegistry([
      {
        providerProfileId: "profile-a",
        adapter: recordingAdapter("adapter-a", requests),
        modelCatalog: new StaticModelCatalog([
          { id: "shared-model", isDefault: true, contextWindow: 32_768 },
          {
            id: "discovered-only",
            source: "discovered",
            supportedReasoningEfforts: null,
            defaultReasoningEffort: null,
            inputModalities: null,
            contextWindow: 32_768,
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
          { id: "shared-model", isDefault: true, contextWindow: 32_768 },
          { id: "second-model", contextWindow: 32_768 },
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
      contextWindow: 32_768,
    },
  ]);
}

function catalogWithModalities(
  inputModalities: readonly ("text" | "image")[],
): StaticModelCatalog {
  return new StaticModelCatalog([
    {
      id: "shared-model",
      isDefault: true,
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
      inputModalities,
      contextWindow: 32_768,
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
  reasoningEffort: string | null,
): {
  providerProfileId: string;
  modelId: string;
  reasoningEffort: string | null;
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

test("publishes immutable snapshots while acquired executions retain retired resources", async () => {
  const oldRequests: ModelRequest[] = [];
  const newRequests: ModelRequest[] = [];
  const oldClosed = deferred<void>();
  let oldCloseCalls = 0;
  const oldAdapter = recordingAdapter("old", oldRequests);
  const registry = new ProviderRegistry(
    [
      {
        providerProfileId: "profile-a",
        adapter: oldAdapter,
        modelCatalog: catalog(),
        close() {
          oldCloseCalls += 1;
          oldClosed.resolve();
        },
      },
    ],
    { revision: 1 },
  );
  const acquired = registry.acquire(selection("profile-a", "low"));
  const prepared = registry.prepareSnapshot(
    [
      {
        providerProfileId: "profile-a",
        adapter: recordingAdapter("new", newRequests),
        modelCatalog: catalog(),
      },
    ],
    2,
  );

  registry.publishSnapshot(prepared);

  assert.equal(registry.currentSnapshot().revision, 2);
  assert.equal(acquired.revision, 1);
  assert.equal(acquired.adapter, oldAdapter);
  assert.equal(oldCloseCalls, 0);
  acquired.release();
  acquired.release();
  await oldClosed.promise;
  assert.equal(oldCloseCalls, 1);
});

test("discarding a prepared snapshot closes only candidate resources", async () => {
  const currentAdapter = recordingAdapter("current", []);
  let currentCloseCalls = 0;
  let candidateCloseCalls = 0;
  const registry = new ProviderRegistry([
    {
      providerProfileId: "profile-a",
      adapter: currentAdapter,
      modelCatalog: catalog(),
      close() {
        currentCloseCalls += 1;
      },
    },
  ]);
  const prepared = registry.prepareSnapshot(
    [
      {
        providerProfileId: "profile-a",
        adapter: currentAdapter,
        modelCatalog: catalog(),
        close() {
          currentCloseCalls += 1;
        },
      },
      {
        providerProfileId: "profile-b",
        adapter: recordingAdapter("candidate", []),
        modelCatalog: catalog(),
        close() {
          candidateCloseCalls += 1;
        },
      },
    ],
    1,
  );

  await registry.discardSnapshot(prepared);

  assert.equal(currentCloseCalls, 0);
  assert.equal(candidateCloseCalls, 1);
  assert.equal(registry.currentSnapshot().revision, 0);
});

test("closing the registry waits for acquired resources and is idempotent", async () => {
  const oldClosed = deferred<void>();
  let oldCloseCalls = 0;
  let currentCloseCalls = 0;
  const registry = new ProviderRegistry([
    {
      providerProfileId: "profile-a",
      adapter: recordingAdapter("adapter", []),
      modelCatalog: catalog(),
      close() {
        oldCloseCalls += 1;
        oldClosed.resolve();
      },
    },
  ]);
  const lease = registry.acquire(selection("profile-a", "low"));
  registry.publishSnapshot(
    registry.prepareSnapshot(
      [
        {
          providerProfileId: "profile-a",
          adapter: recordingAdapter("current", []),
          modelCatalog: catalog(),
          close() {
            currentCloseCalls += 1;
          },
        },
      ],
      1,
    ),
  );
  const closing = registry.close();
  assert.equal(closing, registry.close());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(oldCloseCalls, 0);
  assert.equal(currentCloseCalls, 1);
  assert.throws(
    () => registry.acquire(selection("profile-a", "low")),
    /registry is closed/u,
  );
  lease.release();
  await closing;
  await oldClosed.promise;
  assert.equal(oldCloseCalls, 1);
});

test("an explicit null reasoning selection never silently gains a new default", () => {
  const registry = new ProviderRegistry([
    {
      providerProfileId: "profile-a",
      adapter: recordingAdapter("adapter", []),
      modelCatalog: catalog(),
    },
  ]);

  assert.throws(
    () => registry.resolve(selection("profile-a", null)),
    hasZenCode("reasoning_effort_unavailable"),
  );
  assert.equal(
    registry.resolve({
      providerProfileId: "profile-a",
      modelId: "shared-model",
    }).selection.reasoningEffort,
    "low",
  );
});

test("a Turn pins one published runtime snapshot through retirement", async () => {
  const oldStarted = deferred<void>();
  const finishOld = deferred<void>();
  const oldClosed = deferred<void>();
  const oldRequests: ModelRequest[] = [];
  const newRequests: ModelRequest[] = [];
  const oldAdapter: ModelAdapter = {
    provider: "old",
    async *stream(request): AsyncIterable<ModelEvent> {
      oldRequests.push(request);
      oldStarted.resolve();
      await finishOld.promise;
      yield { type: "text_delta", delta: "old complete" };
    },
  };
  const registry = new ProviderRegistry(
    [
      {
        providerProfileId: "profile-a",
        adapter: oldAdapter,
        modelCatalog: catalog(),
        close: () => oldClosed.resolve(),
      },
    ],
    { revision: 1 },
  );
  const server = createRegistryServer({ registry });
  const thread = await server.startThread();
  const turnPromise = server.startTurn(thread.id, "use old snapshot");
  await oldStarted.promise;
  const events: unknown[] = [];
  const unsubscribe = server.subscribe((event) => events.push(event));
  const prepared = server.prepareRuntimeConfiguration({
    revision: 2,
    providerProfiles: [
      {
        providerProfileId: "profile-a",
        adapter: recordingAdapter("new", newRequests),
        modelCatalog: catalog(),
      },
    ],
    defaults: {
      cwd: process.cwd(),
      ...selection("profile-a", "low"),
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    contextCompaction: { triggerPercent: 70, targetPercent: 40 },
    maxToolRounds: 3,
    maxConcurrentToolBodies: 2,
  });

  server.publishRuntimeConfiguration(prepared);

  assert.equal(server.currentRuntimeConfiguration().revision, 2);
  assert.equal(
    server.currentRuntimeConfiguration().contextCompaction.triggerPercent,
    70,
  );
  assert.equal(server.currentRuntimeConfiguration().maxToolRounds, 3);
  assert.equal(server.currentRuntimeConfiguration().maxConcurrentToolBodies, 2);
  assert.deepEqual(events, [{ type: "model_catalog_updated", revision: 2 }]);
  assert.equal(server.activitySnapshot().rootOperations[0]?.kind, "turn");
  finishOld.resolve();
  const turn = await turnPromise;
  await turn.done;
  await oldClosed.promise;
  await (
    await server.startTurn(thread.id, "use new snapshot")
  ).done;
  unsubscribe();

  assert.equal(oldRequests.length, 1);
  assert.equal(newRequests.length, 1);
  assert.equal(server.activitySnapshot().rootOperations.length, 0);
});

test("safe maintenance atomically refuses activity or closes root admission", async () => {
  const server = createRegistryServer({
    registry: new ProviderRegistry([
      {
        providerProfileId: "profile-a",
        adapter: recordingAdapter("adapter", []),
        modelCatalog: catalog(),
      },
    ]),
  });
  const operation = server.beginHostOperation("provider", "title inference");
  const busy = server.tryBeginMaintenance();
  assert.equal(busy.accepted, false);
  assert.deepEqual(busy.activity.rootOperations, [
    { kind: "provider", label: "title inference" },
  ]);
  operation.release();

  const maintenance = server.tryBeginMaintenance();
  assert.equal(maintenance.accepted, true);
  assert.equal(maintenance.activity.acceptingRootOperations, false);
  await assert.rejects(server.startThread(), hasZenCode("host_restarting"));
  assert.throws(
    () => server.beginHostOperation("plugin"),
    hasZenCode("host_restarting"),
  );
  if (maintenance.accepted) maintenance.end();
  const thread = await server.startThread();
  assert.equal(thread.turns.length, 0);
});

test("an existing explicit null selection is rejected after a capability publish", async () => {
  const noEffortCatalog = new StaticModelCatalog([
    {
      id: "shared-model",
      isDefault: true,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      contextWindow: 32_768,
    },
  ]);
  const server = createRegistryServer({
    registry: new ProviderRegistry([
      {
        providerProfileId: "profile-a",
        adapter: recordingAdapter("old", []),
        modelCatalog: noEffortCatalog,
      },
    ]),
    defaultSelection: selection("profile-a", null),
  });
  const thread = await server.startThread();
  const prepared = server.prepareRuntimeConfiguration({
    revision: 1,
    providerProfiles: [
      {
        providerProfileId: "profile-a",
        adapter: recordingAdapter("new", []),
        modelCatalog: catalog(),
      },
    ],
    defaults: {
      cwd: process.cwd(),
      ...selection("profile-a", "low"),
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  server.publishRuntimeConfiguration(prepared);

  await assert.rejects(
    server.startTurn(thread.id, "must choose effort"),
    hasZenCode("reasoning_effort_unavailable"),
  );
  assert.equal((await server.readThread(thread.id)).turns.length, 0);
});

test("execution limits are pinned at final Turn admission", async () => {
  const firstSampleStarted = deferred<void>();
  const continueFirstSample = deferred<void>();
  let oldSamples = 0;
  let newSamples = 0;
  const adapter: ModelAdapter = {
    provider: "limits",
    async *stream(request): AsyncIterable<ModelEvent> {
      const latestUser = request.messages.findLast(
        (message) => message.role === "user",
      );
      const isOld =
        latestUser !== undefined &&
        (("text" in latestUser && latestUser.text === "old limit") ||
          ("content" in latestUser &&
            latestUser.content.some(
              (part) => part.type === "text" && part.text === "old limit",
            )));
      if (isOld) {
        oldSamples += 1;
        if (oldSamples === 1) {
          firstSampleStarted.resolve();
          await continueFirstSample.promise;
        }
        if (oldSamples <= 2) {
          yield {
            type: "tool_call",
            callId: `old-${String(oldSamples)}`,
            name: "shell",
            arguments: { command: "printf old" },
          };
          return;
        }
        yield { type: "text_delta", delta: "old completed" };
        return;
      }
      newSamples += 1;
      yield {
        type: "tool_call",
        callId: `new-${String(newSamples)}`,
        name: "shell",
        arguments: { command: "printf new" },
      };
    },
  };
  const server = createRegistryServer({
    registry: new ProviderRegistry([
      {
        providerProfileId: "profile-a",
        adapter,
        modelCatalog: catalog(),
      },
    ]),
  });
  const thread = await server.startThread();
  const oldTurnPromise = server.startTurn(thread.id, "old limit");
  await firstSampleStarted.promise;
  server.publishRuntimeConfiguration(
    server.prepareRuntimeConfiguration({
      revision: 1,
      providerProfiles: [
        {
          providerProfileId: "profile-a",
          adapter,
          modelCatalog: catalog(),
        },
      ],
      defaults: {
        cwd: process.cwd(),
        ...selection("profile-a", "low"),
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
      maxToolRounds: 1,
    }),
  );
  continueFirstSample.resolve();
  await (
    await oldTurnPromise
  ).done;

  const next = await server.startTurn(thread.id, "new limit");
  await next.done;
  const snapshot = await server.readThread(thread.id);
  assert.equal(snapshot.turns.at(-1)?.status, "failed");
  assert(
    snapshot.items.some(
      (item) =>
        item.type === "failure" &&
        item.message.includes("exceeded 1 tool rounds"),
    ),
  );
  assert.equal(oldSamples, 3);
  assert.equal(newSamples, 2);
});

test("manual compaction holds its admitted Provider through publication", async () => {
  const summaryStarted = deferred<void>();
  const finishSummary = deferred<void>();
  const oldClosed = deferred<void>();
  let requests = 0;
  let closeCalls = 0;
  const oldAdapter: ModelAdapter = {
    provider: "old-compaction",
    async *stream(): AsyncIterable<ModelEvent> {
      requests += 1;
      if (requests === 1) {
        yield { type: "text_delta", delta: "initial answer" };
        return;
      }
      summaryStarted.resolve();
      await finishSummary.promise;
      yield { type: "text_delta", delta: "summary" };
    },
  };
  const server = createRegistryServer({
    registry: new ProviderRegistry([
      {
        providerProfileId: "profile-a",
        adapter: oldAdapter,
        modelCatalog: catalog(),
        close() {
          closeCalls += 1;
          oldClosed.resolve();
        },
      },
    ]),
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "history")
  ).done;
  const compacting = server.compactThread(thread.id);
  await summaryStarted.promise;
  server.publishRuntimeConfiguration(
    server.prepareRuntimeConfiguration({
      revision: 1,
      providerProfiles: [
        {
          providerProfileId: "profile-a",
          adapter: recordingAdapter("new-compaction", []),
          modelCatalog: catalog(),
        },
      ],
      defaults: {
        cwd: process.cwd(),
        ...selection("profile-a", "low"),
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
    }),
  );

  assert.equal(closeCalls, 0);
  assert.equal(server.activitySnapshot().rootOperations[0]?.kind, "compaction");
  finishSummary.resolve();
  await compacting;
  await oldClosed.promise;
  assert.equal(closeCalls, 1);
  assert.equal(server.activitySnapshot().rootOperations.length, 0);
});

test("final Turn admission revalidates input against the published snapshot", async () => {
  const firstReadStarted = deferred<void>();
  const finishFirstRead = deferred<void>();
  let reads = 0;
  const ref: AttachmentRef = {
    type: "attachment",
    sha256: "a".repeat(64),
    mediaType: "image/png",
    byteLength: 1,
    width: 1,
    height: 1,
  };
  const attachments: AttachmentStore = {
    async importBytes() {
      return ref;
    },
    async importLocalImage() {
      return ref;
    },
    async read() {
      reads += 1;
      if (reads === 1) {
        firstReadStarted.resolve();
        await finishFirstRead.promise;
      }
      return new Uint8Array([1]);
    },
  };
  const adapter = recordingAdapter("images", []);
  const registry = new ProviderRegistry([
    {
      providerProfileId: "profile-a",
      adapter,
      modelCatalog: catalogWithModalities(["text", "image"]),
    },
  ]);
  const server = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    attachments,
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({
        runtimes: [new ShellToolRuntime()],
      }),
    }),
    providerRegistry: registry,
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      ...selection("profile-a", "low"),
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  const thread = await server.startThread();
  const starting = server.startTurn(thread.id, [
    { type: "text", text: "inspect image" },
    { type: "image", attachment: ref },
  ]);
  await firstReadStarted.promise;
  server.publishRuntimeConfiguration(
    server.prepareRuntimeConfiguration({
      revision: 1,
      providerProfiles: [
        {
          providerProfileId: "profile-a",
          adapter,
          modelCatalog: catalogWithModalities(["text"]),
        },
      ],
      defaults: {
        cwd: process.cwd(),
        ...selection("profile-a", "low"),
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
    }),
  );
  finishFirstRead.resolve();

  await assert.rejects(starting, hasZenCode("image_input_unsupported"));
  assert.equal(reads, 1);
  assert.equal((await server.readThread(thread.id)).turns.length, 0);
});

function createRegistryServer(options: {
  registry: ProviderRegistry;
  journal?: InMemoryThreadJournal;
  defaultSelection?: ReturnType<typeof selection>;
}): ZenAppServer {
  const defaultSelection =
    options.defaultSelection ?? selection("profile-a", "low");
  return new ZenAppServer({
    journal: options.journal ?? new InMemoryThreadJournal(),
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({
        runtimes: [new ShellToolRuntime()],
      }),
    }),
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
