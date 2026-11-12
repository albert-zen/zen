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
import { StaticModelCatalog } from "../src/model-catalog.js";
import type { ModelAdapter, ModelRequest } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolEnvironment } from "../src/tool.js";

function fixture(journal: ThreadJournal = new InMemoryThreadJournal()) {
  const requests: Array<{ profile: string; request: ModelRequest }> = [];
  const server = new ZenAppServer({
    journal,
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({ runtimes: [] }),
    }),
    providerRegistry: new ProviderRegistry(
      ["a", "b"].map((profile) => ({
        providerProfileId: profile,
        adapter: {
          provider: profile,
          async *stream(request) {
            requests.push({ profile, request });
            yield { type: "text_delta", delta: profile };
          },
        } satisfies ModelAdapter,
        modelCatalog: new StaticModelCatalog([
          {
            id: "shared",
            isDefault: true,
            supportedReasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "low",
            contextWindow: 32768,
          },
          {
            id: "high-only",
            supportedReasoningEfforts: ["high"],
            defaultReasoningEffort: "high",
            contextWindow: 32768,
          },
          {
            id: "no-effort",
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            contextWindow: 32768,
          },
        ]),
      })),
    ),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: "a",
      modelId: "shared",
      reasoningEffort: "low",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  return { server, journal, requests };
}

for (const mode of ["fresh", "fork", "side-chat"] as const) {
  test(`${mode} child publishes an explicit profile atomically and preserves copied execution history`, async () => {
    const f = fixture();
    const parent = await f.server.startThread();
    await (
      await f.server.startTurn(parent.id, "parent history")
    ).done;
    const before = (await f.server.readThread(parent.id)).items;
    const started: unknown[] = [];
    const unsubscribe = f.server.subscribe((event) => {
      if (event.type === "thread_started")
        started.push(event.thread.providerProfileId);
    });
    const child = await f.server.createChildThread({
      parentThreadId: parent.id,
      mode,
      selection: {
        providerProfileId: "b",
        modelId: "shared",
        reasoningEffort: "high",
      },
    });
    unsubscribe();
    assert.equal(child.providerProfileId, "b");
    assert.equal(child.reasoningEffort, "high");
    assert.deepEqual(started, ["b"]);
    assert.deepEqual((await f.server.readThread(parent.id)).items, before);
    for (const item of child.items) {
      if (item.type === "turn_started")
        assert.equal(item.selection?.providerProfileId, "a");
    }
    await (
      await f.server.startTurn(child.id, "first child task")
    ).done;
    assert.equal(f.requests.at(-1)?.profile, "b");
    assert.equal(f.requests.at(-1)?.request.reasoningEffort, "high");
    const restored = fixture(f.journal);
    assert.equal(
      (await restored.server.readThread(child.id)).providerProfileId,
      "b",
    );
    assert.equal(
      (await restored.server.readThread(child.id)).reasoningEffort,
      "high",
    );
  });
}

for (const mode of ["fresh", "fork", "side-chat"] as const) {
  test(`${mode} keeps inherited selection, accepts effort-only, and resolves omitted effort against the target`, async () => {
    const f = fixture();
    const parent = await f.server.startThread({
      selection: {
        providerProfileId: "b",
        modelId: "shared",
        reasoningEffort: "high",
      },
    });
    await (
      await f.server.startTurn(parent.id, "history")
    ).done;
    const inherited = await f.server.createChildThread({
      parentThreadId: parent.id,
      mode,
    });
    assert.equal(inherited.providerProfileId, "b");
    assert.equal(inherited.reasoningEffort, "high");
    const effort = await f.server.createChildThread({
      parentThreadId: parent.id,
      mode,
      reasoningEffort: "low",
    });
    assert.equal(effort.providerProfileId, "b");
    assert.equal(effort.modelId, "shared");
    assert.equal(effort.reasoningEffort, "low");
    const preserved = await f.server.createChildThread({
      parentThreadId: parent.id,
      mode,
      selection: { providerProfileId: "a", modelId: "shared" },
    });
    assert.equal(preserved.reasoningEffort, "high");
    const nullEffort = await f.server.createChildThread({
      parentThreadId: parent.id,
      mode,
      selection: { providerProfileId: "a", modelId: "no-effort" },
    });
    assert.equal(nullEffort.reasoningEffort, null);
    const nested = await f.server.createChildThread({
      parentThreadId: nullEffort.id,
      mode,
    });
    assert.equal(nested.modelId, "no-effort");
    assert.equal(nested.reasoningEffort, null);
    const fromNull = await f.server.createChildThread({
      parentThreadId: nullEffort.id,
      mode,
      selection: { providerProfileId: "b", modelId: "high-only" },
    });
    assert.equal(fromNull.reasoningEffort, "high");
    if (mode !== "fresh")
      assert.equal(
        fromNull.items.filter(
          (item) => item.type === "thread_configuration_changed",
        ).length,
        2,
      );
  });

  test(`${mode} rejects unsupported choices before journal mutation or publication`, async () => {
    const f = fixture();
    const parent = await f.server.startThread();
    await (
      await f.server.startTurn(parent.id, "history")
    ).done;
    const before = (await f.server.readThread(parent.id)).items;
    const events: unknown[] = [];
    f.server.subscribe((event) => {
      if (event.type === "thread_started") events.push(event);
    });
    for (const selection of [
      { providerProfileId: "missing", modelId: "shared" },
      { providerProfileId: "b", modelId: "missing" },
      { providerProfileId: "b", modelId: "high-only", reasoningEffort: "low" },
      { providerProfileId: "b", modelId: "no-effort", reasoningEffort: "high" },
      { providerProfileId: "b", modelId: "shared", reasoningEffort: null },
    ]) {
      await assert.rejects(
        f.server.createChildThread({
          parentThreadId: parent.id,
          mode,
          selection,
        }),
      );
    }
    await assert.rejects(
      f.server.createChildThread({
        parentThreadId: parent.id,
        mode,
        reasoningEffort: "invalid",
      }),
    );
    assert.deepEqual(await f.journal.listThreadIds(), [parent.id]);
    assert.deepEqual((await f.server.readThread(parent.id)).items, before);
    assert.deepEqual(events, []);
  });
}

test("concurrent child creation keeps each selection isolated and never changes parent or Host defaults", async () => {
  const f = fixture();
  const parent = await f.server.startThread();
  await (
    await f.server.startTurn(parent.id, "history")
  ).done;
  const before = (await f.server.readThread(parent.id)).items;
  const children = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      f.server.createChildThread({
        parentThreadId: parent.id,
        mode: (["fresh", "fork", "side-chat"] as const)[index % 3]!,
        selection: {
          providerProfileId: index % 2 === 0 ? "a" : "b",
          modelId: "shared",
          reasoningEffort: index % 2 === 0 ? "low" : "high",
        },
      }),
    ),
  );
  await Promise.all(
    children.map(async (child, index) => {
      assert.equal(child.providerProfileId, index % 2 === 0 ? "a" : "b");
      assert.equal(child.reasoningEffort, index % 2 === 0 ? "low" : "high");
      await (
        await f.server.startTurn(child.id, `child ${index}`)
      ).done;
      const started = (await f.server.readThread(child.id)).items
        .filter((item) => item.type === "turn_started")
        .at(-1)!;
      assert.equal(
        started.selection?.providerProfileId,
        child.providerProfileId,
      );
      assert.equal(started.selection?.reasoningEffort, child.reasoningEffort);
    }),
  );
  assert.deepEqual((await f.server.readThread(parent.id)).items, before);
  assert.equal((await f.server.startThread()).providerProfileId, "a");
});

test("native configured creation validates models and efforts before creating or publishing a Thread", async () => {
  const { NativeConnection } =
    await import("../src/protocol/native/connection.js");
  const { NativeRecoveryProjection } =
    await import("../src/protocol/native/recovery.js");
  const { encodeModelKey } = await import("../src/protocol/model-key.js");
  const f = fixture();
  const parent = await f.server.startThread();
  const projection = new NativeRecoveryProjection(f.server);
  const messages: import("../src/protocol/codex/wire.js").JsonRpcMessage[] = [];
  const connection = new NativeConnection({
    appServer: f.server,
    projection,
    send: (message) => {
      messages.push(message);
    },
  });
  let nextId = 1;
  const request = async (
    params: Record<string, unknown>,
    method = "zen/thread/create-child-configured",
  ) => {
    const id = nextId++;
    await connection.receive({ id, method, params });
    return messages.find((message) => "id" in message && message.id === id)!;
  };
  try {
    const uninitialized = await request({
      parentThreadId: parent.id,
      mode: "fresh",
      effort: "high",
    });
    assert("error" in uninitialized && uninitialized.error.code === -32600);
    await request({}, "zen/initialize");
    for (const invalid of [
      { model: null },
      { model: 42 },
      { model: " " },
      { effort: null },
      { effort: [] },
      { effort: "" },
      { model: "zen-model-v1:bad" },
      { model: "shared" },
      { model: "missing" },
      { effort: "unsupported" },
      {
        model: encodeModelKey({ providerProfileId: "b", modelId: "shared" }),
        effort: "unsupported",
      },
      { selection: { providerProfileId: "b", modelId: "shared" } },
    ]) {
      const failed = await request({
        parentThreadId: parent.id,
        mode: "fresh",
        ...invalid,
      });
      assert("error" in failed, JSON.stringify(invalid));
      assert.equal(failed.error.code, -32602);
      assert.deepEqual(await f.journal.listThreadIds(), [parent.id]);
    }
    const created = await request({
      parentThreadId: parent.id,
      mode: "fresh",
      model: encodeModelKey({ providerProfileId: "b", modelId: "shared" }),
      effort: "high",
    });
    assert("result" in created);
    const child = (
      created.result as {
        thread: import("../src/app-server.js").ThreadSnapshot;
      }
    ).thread;
    assert.equal(child.providerProfileId, "b");
    assert.equal(child.reasoningEffort, "high");
    const effortOnly = await request({
      parentThreadId: child.id,
      mode: "side-chat",
      effort: "low",
    });
    assert("result" in effortOnly);
    const next = (
      effortOnly.result as {
        thread: import("../src/app-server.js").ThreadSnapshot;
      }
    ).thread;
    assert.equal(next.providerProfileId, "b");
    assert.equal(next.reasoningEffort, "low");
    assert.equal(f.requests.length, 0);
  } finally {
    connection.close();
    projection.close();
  }
});

test("a pending atomic fork never exposes inherited settings while parent settings change", async () => {
  let resolveEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  class HeldJournal extends InMemoryThreadJournal {
    override async create(
      items: readonly import("../src/item.js").CanonicalItem[],
    ) {
      const selection = items.find(
        (item) => item.type === "thread_configuration_changed",
      );
      assert(selection !== undefined && "selection" in selection);
      assert.equal(selection.selection.to.providerProfileId, "b");
      resolveEntered();
      await barrier;
      await super.create(items);
    }
  }
  const f = fixture(new HeldJournal());
  const parent = await f.server.startThread();
  await (
    await f.server.startTurn(parent.id, "history")
  ).done;
  const snapshots: import("../src/app-server.js").ThreadSnapshot[] = [];
  f.server.subscribe((event) => {
    if (event.type === "thread_started") snapshots.push(event.thread);
  });
  const creating = f.server.createChildThread({
    parentThreadId: parent.id,
    mode: "fork",
    selection: {
      providerProfileId: "b",
      modelId: "shared",
      reasoningEffort: "high",
    },
  });
  await entered;
  assert.deepEqual(await f.journal.listThreadIds(), [parent.id]);
  assert.equal(snapshots.length, 0);
  await f.server.updateThreadSettings(parent.id, { reasoningEffort: "high" });
  release();
  const child = await creating;
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.providerProfileId, "b");
  assert.equal(snapshots[0]?.reasoningEffort, "high");
  assert.equal(
    child.items.find((item) => item.type === "turn_started")?.selection
      ?.reasoningEffort,
    "low",
  );
});

test("JSONL restart reconstructs every child selection without a second settings store", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-child-selection-"),
  );
  try {
    const f = fixture(new JsonlThreadJournal(directory));
    const parent = await f.server.startThread();
    await (
      await f.server.startTurn(parent.id, "history")
    ).done;
    const children = await Promise.all(
      (["fresh", "fork", "side-chat"] as const).map((mode) =>
        f.server.createChildThread({
          parentThreadId: parent.id,
          mode,
          selection: { providerProfileId: "b", modelId: "no-effort" },
        }),
      ),
    );
    const restored = fixture(new JsonlThreadJournal(directory));
    for (const child of children) {
      const snapshot = await restored.server.readThread(child.id);
      assert.equal(snapshot.providerProfileId, "b");
      assert.equal(snapshot.modelId, "no-effort");
      assert.equal(snapshot.reasoningEffort, null);
      assert.equal(snapshot.parentThreadId, parent.id);
      await (
        await restored.server.startTurn(child.id, "first after restart")
      ).done;
      assert.equal(restored.requests.at(-1)?.profile, "b");
      assert.equal(restored.requests.at(-1)?.request.reasoningEffort, null);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
