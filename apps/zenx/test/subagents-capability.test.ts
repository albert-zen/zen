import assert from "node:assert/strict";
import test from "node:test";
import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type { ToolInvocation } from "../../../src/tool.js";
import { ZenXSubagentsCapabilityPackage } from "../src/main/capabilities/subagents-package.js";
import {
  ZenXSelfControlCapabilityPackage,
  type AppServerRequestPort,
} from "../src/main/capabilities/self-control-package.js";
import { ZenXProjectProjection } from "../src/main/project-projection.js";
import { ZenXPluginCatalog } from "../src/main/capabilities/plugin-catalog.js";
import { validatePluginManifest } from "../../../packages/zenx-plugin-sdk/src/schema.js";
import { subagentsManifest } from "../../../packages/zenx-subagents-plugin/src/manifest.js";

function invocation(
  name: string,
  args: Record<string, unknown>,
  ui = false,
): ToolInvocation {
  return {
    name,
    callId: "call",
    canonicalToolCallId: "trusted-call-item",
    arguments: args,
    cwd: "/workspace",
    threadId: "trusted-parent",
    signal: new AbortController().signal,
    ...(ui ? { trustedPluginUi: true as const } : {}),
  };
}
function fixture() {
  const requests: Array<{ method: string; params: unknown }> = [];
  const child = {
    id: "child",
    parentThreadId: "trusted-parent",
    items: [],
    turns: [],
  };
  const port = {
    projectProjection: new ZenXProjectProjection(),
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "zen/thread/create-child") return { thread: child };
      if (method === "zen/thread/read") return { thread: child };
      if (method === "thread/list")
        return {
          data: [
            {
              id: "child",
              name: "Child",
              cwd: "/workspace",
              status: { type: "idle" },
            },
          ],
          nextCursor: null,
        };
      if (method === "turn/start") return { turn: { id: "turn" } };
      if (method === "zen/thread/message")
        return {
          turnId: "turn",
          mode: "batch-next",
          queued: false,
          messageId: "received",
          clientId: "agent-message",
        };
      if (method === "thread/name/set") return {};
      throw new Error("unexpected " + method);
    },
  } as AppServerRequestPort;
  let summaries: NativeThreadSummary[] = [];
  const threads = new ZenXSelfControlCapabilityPackage({ appServer: port });
  const service = new ZenXSubagentsCapabilityPackage({
    appServer: port,
    threads,
    listSummaries: async () => structuredClone(summaries),
  });
  return {
    service,
    requests,
    child,
    port,
    setSummaries: (value: NativeThreadSummary[]) => {
      summaries = value;
    },
  };
}

test("fresh, fork, and Side chat use the trusted caller by default and create no implicit Turn", async () => {
  for (const mode of ["fresh", "fork", "side-chat"]) {
    const f = fixture();
    const value = await f.service.invoke(
      "zenx_subagents_create",
      invocation("zenx_subagents_create", { mode }),
    );
    assert.deepEqual(f.requests, [
      {
        method: "zen/thread/create-child",
        params: { parentThreadId: "trusted-parent", mode },
      },
    ]);
    assert.equal((value as { threadId: string }).threadId, "child");
  }
});
test("trusted product create unwraps explicit input; a model cannot use that envelope", async () => {
  const f = fixture();
  await f.service.invoke(
    "zenx_subagents_create",
    invocation(
      "zenx_subagents_create",
      { input: { parentThreadId: "selected", mode: "fresh" } },
      true,
    ),
  );
  assert.deepEqual(f.requests[0]?.params, {
    parentThreadId: "selected",
    mode: "fresh",
  });
  await assert.rejects(
    f.service.invoke(
      "zenx_subagents_create",
      invocation("zenx_subagents_create", {
        input: { parentThreadId: "spoof", mode: "fresh" },
      }),
    ),
    /Unexpected argument: input/,
  );
});
test("Side chat rejects a creation task before any native mutation", async () => {
  const f = fixture();
  await assert.rejects(
    f.service.invoke(
      "zenx_subagents_create",
      invocation("zenx_subagents_create", {
        mode: "side-chat",
        task: "begin inherited work",
      }),
    ),
    /waits for an explicit user request/,
  );
  assert.deepEqual(f.requests, []);
});
test("explicit task uses existing send semantics and reports acceptance without claiming completion", async () => {
  const f = fixture();
  const result = (await f.service.invoke(
    "zenx_subagents_create",
    invocation("zenx_subagents_create", {
      mode: "fresh",
      title: "Child",
      task: "User task",
    }),
  )) as { delivery: { mode: string; turnId: string } };
  assert.equal(result.delivery.mode, "batch-next");
  assert.equal(result.delivery.turnId, "turn");
  assert.deepEqual(
    f.requests.find((r) => r.method === "thread/name/set")?.params,
    { threadId: "child", name: "Child" },
  );
  const sent = f.requests.find((r) => r.method === "zen/thread/message")
    ?.params as {
    threadId: string;
    text: string;
    sourceThreadId: string;
    sourceToolCallId: string;
    messageType?: string;
  };
  assert.equal(sent.threadId, "child");
  assert.equal(sent.text, "User task");
  assert.equal(sent.sourceThreadId, "trusted-parent");
  assert.equal(sent.sourceToolCallId, "trusted-call-item");
  assert.equal(sent.messageType, undefined);
  assert.equal("completed" in result, false);
});
test("list derives nested relationships from native summaries, retains archived child and does not own persistence", async () => {
  const f = fixture();
  const base = {
    archived: false,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    preview: "",
    status: "idle",
    currentMetadata: {
      cwd: "/workspace",
      model: "m",
      provider: "p",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  } as const;
  const summaries: NativeThreadSummary[] = [
    { ...base, threadId: "other" },
    {
      ...base,
      threadId: "grandchild",
      parentThreadId: "child",
      archived: true,
    },
    { ...base, threadId: "child", parentThreadId: "trusted-parent" },
  ];
  f.setSummaries(summaries);
  assert.deepEqual(
    await f.service.invoke(
      "zenx_subagents_list",
      invocation("zenx_subagents_list", {}),
    ),
    { threads: [summaries[1], summaries[2]] },
  );
  assert.equal("storage" in f.service, false);
});
test("read and send retain standard public projections for any Thread without a self-control plugin lifecycle", async () => {
  const f = fixture();
  const result = (await f.service.invoke(
    "zenx_subagents_send",
    invocation("zenx_subagents_send", {
      target: "child",
      text: "Hello",
      messageType: "follow_up",
    }),
  )) as { threadId: string };
  assert.equal(result.threadId, "child");
  assert.equal(f.requests.at(-1)?.method, "zen/thread/message");
  const read = (await f.service.invoke(
    "zenx_subagents_read",
    invocation("zenx_subagents_read", {
      target: "child",
      granularity: "agent_messages",
    }),
  )) as { threadId: string };
  assert.equal(read.threadId, "child");
});
test("native errors propagate and optional follow-up failures retain created Thread identity", async () => {
  const f = fixture();
  f.port.request = async () => {
    throw new Error("native unavailable");
  };
  await assert.rejects(
    f.service.invoke(
      "zenx_subagents_create",
      invocation("zenx_subagents_create", { mode: "fresh" }),
    ),
    /native unavailable/,
  );
  let calls = 0;
  f.port.request = async () => {
    if (calls++ === 0) return { thread: f.child } as never;
    throw new Error("rename unavailable");
  };
  const result = (await f.service.invoke(
    "zenx_subagents_create",
    invocation("zenx_subagents_create", { mode: "fresh", title: "Child" }),
  )) as { threadId: string; followUpError: string };
  assert.equal(result.threadId, "child");
  assert.equal(result.followUpError, "rename unavailable");
});
test("thread header schema requires existing surface and disabling Subagents removes all UI and tools", async () => {
  const f = fixture();
  const manifest = { ...subagentsManifest, mainDocument: "test fixture" };
  validatePluginManifest(manifest);
  assert.throws(
    () =>
      validatePluginManifest({
        ...manifest,
        contributions: {
          ...manifest.contributions,
          threadHeaders: [{ id: "bad", surfaceId: "missing" }],
        },
      }),
    /dangling/,
  );
  const catalog = new ZenXPluginCatalog({
    load: async () => ({ disabled: [], uninstalled: [], packages: {} }),
    save: async () => {},
  });
  await catalog.initialize();
  await catalog.install(
    {
      manifest,
      invoke: (name, invocation) => f.service.invoke(name, invocation),
    },
    "bundled",
  );
  assert.deepEqual(catalog.pluginSnapshot().threadHeaders, []);
  assert.equal(catalog.pluginSnapshot().panels[0]?.id, "subagents");
  assert.equal(catalog.hostSnapshot().definitions.length, 4);
  await catalog.setEnabled("zenx-subagents", false);
  assert.deepEqual(catalog.pluginSnapshot().threadHeaders, []);
  assert.deepEqual(catalog.pluginSnapshot().panels, []);
  assert.deepEqual(catalog.hostSnapshot().definitions, []);
  await catalog.close();
});

test("plugin fresh/fork and reply reading cross the real native Core connection", async () => {
  const { createHostedAppServer } =
    await import("../../../apps/cli/src/host.js");
  const { InMemoryThreadJournal } = await import("../../../src/journal.js");
  const { InMemoryThreadMetadataStore } =
    await import("../../../src/thread-metadata.js");
  const { InMemoryThreadSummaryProjection } =
    await import("../../../src/thread-summary.js");
  const { NativeConnection } =
    await import("../../../src/protocol/native/connection.js");
  const { NativeRecoveryProjection } =
    await import("../../../src/protocol/native/recovery.js");
  const host = createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: "/tmp/unused-subagents-host",
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never",
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
    threadMetadata: new InMemoryThreadMetadataStore(),
    threadSummaryProjection: new InMemoryThreadSummaryProjection(),
  });
  const projection = new NativeRecoveryProjection(host);
  const replies: Array<
    import("../../../src/protocol/codex/wire.js").JsonRpcMessage
  > = [];
  const connection = new NativeConnection({
    appServer: host,
    projection,
    send: (message) => {
      replies.push(message);
    },
  });
  let nextId = 1;
  await connection.receive({
    id: nextId++,
    method: "zen/initialize",
    params: {},
  });
  const port = {
    projectProjection: new ZenXProjectProjection(),
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list")
        return {
          data: (await host.listThreadSummaries()).map((s) => ({
            id: s.threadId,
            name: s.name,
            cwd: s.status === "systemError" ? "" : s.currentMetadata.cwd,
            status: { type: s.status === "active" ? "active" : "idle" },
          })),
          nextCursor: null,
        };
      const id = nextId++;
      await connection.receive({ id, method, params });
      const response = replies.find((m) => "id" in m && m.id === id);
      if (response === undefined) throw new Error("No native reply");
      if ("error" in response) throw new Error(response.error.message);
      if (!("result" in response)) throw new Error("No native result");
      return response.result;
    },
  } as AppServerRequestPort;
  const threads = new ZenXSelfControlCapabilityPackage({ appServer: port });
  const service = new ZenXSubagentsCapabilityPackage({
    appServer: port,
    threads,
    listSummaries: () => host.listThreadSummaries(),
  });
  try {
    const parent = await host.startThread();
    await (
      await host.startTurn(parent.id, "actual parent message")
    ).done;
    const invoke = (name: string, args: Record<string, unknown>) =>
      service.invoke(name, { ...invocation(name, args), threadId: parent.id });
    const child = (await invoke("zenx_subagents_create", {
      mode: "fresh",
    })) as { threadId: string };
    assert.equal(
      (await host.readThread(child.threadId)).parentThreadId,
      parent.id,
    );
    assert.equal((await host.readThread(child.threadId)).turns.length, 0);
    const fork = (await invoke("zenx_subagents_create", { mode: "fork" })) as {
      threadId: string;
    };
    assert(
      (await host.readThread(fork.threadId)).items.some(
        (i) => i.type === "user_message",
      ),
    );
    const listed = (await invoke("zenx_subagents_list", {})) as {
      threads: NativeThreadSummary[];
    };
    assert.deepEqual(
      new Set(listed.threads.map((s) => s.threadId)),
      new Set([child.threadId, fork.threadId]),
    );
    await (
      await host.startTurn(child.threadId, "actual child task")
    ).done;
    const read = await invoke("zenx_subagents_read", {
      target: child.threadId,
      granularity: "agent_messages",
    });
    assert.match(JSON.stringify(read), /agent_message/);
    assert.match(JSON.stringify(read), /actual child task/);
  } finally {
    connection.close();
    projection.close();
    await host.closeProviderTransport();
  }
});

test("first installation respects persisted disabled Subagents choice and removal preserves native relations", async () => {
  const f = fixture();
  const catalog = new ZenXPluginCatalog({
    load: async () => ({
      disabled: ["zenx-subagents"],
      uninstalled: [],
      packages: {},
    }),
    save: async () => {},
  });
  await catalog.initialize();
  await catalog.install(
    {
      manifest: { ...subagentsManifest, mainDocument: "test fixture" },
      invoke: (name, input) => f.service.invoke(name, input),
    },
    "bundled",
  );
  assert.equal(catalog.pluginSnapshot().plugins[0]?.enabled, false);
  assert.deepEqual(catalog.hostSnapshot().definitions, []);
  await catalog.setEnabled("zenx-subagents", true);
  assert.equal(catalog.hostSnapshot().definitions.length, 4);
  await catalog.uninstall("zenx-subagents");
  assert.deepEqual(catalog.pluginSnapshot().threadHeaders, []);
  assert.equal(f.child.parentThreadId, "trusted-parent");
  await catalog.close();
});

test("fork create exposes only a public summary on success and partial follow-up failure", async () => {
  for (const title of [undefined, "new title"]) {
    const f = fixture();
    let next = 0;
    f.port.request = async () => {
      if (next++ === 0)
        return {
          thread: {
            ...f.child,
            items: [
              {
                type: "reasoning",
                contentVisibility: "opaque",
                text: "hidden reasoning",
                content: { opaque: "opaque-secret" },
              },
              { type: "tool_result", output: "raw-result-secret" },
            ],
            turns: [
              {
                id: "t",
                status: "completed",
                items: [{ text: "nested-secret" }],
              },
            ],
          },
        } as never;
      throw new Error("rename failed");
    };
    const result = (await f.service.invoke(
      "zenx_subagents_create",
      invocation("zenx_subagents_create", {
        mode: "fork",
        ...(title === undefined ? {} : { title }),
      }),
    )) as { thread: Record<string, unknown> };
    const output = JSON.stringify(result);
    assert.equal(result.thread.id, "child");
    assert.equal(result.thread.parentThreadId, "trusted-parent");
    assert.equal("items" in result.thread, false);
    assert.equal("turns" in result.thread, false);
    assert.doesNotMatch(
      output,
      /opaque-secret|hidden reasoning|raw-result-secret|nested-secret/,
    );
  }
});

test("creation forwards settings once before sending and never falls back on an older Host", async () => {
  const f = fixture();
  const request = f.port.request.bind(f.port);
  f.port.request = (async (method, params) => {
    if (method === "zen/thread/create-child-configured") {
      f.requests.push({ method, params });
      return { thread: f.child };
    }
    return await request(method, params);
  }) as AppServerRequestPort["request"];
  await f.service.invoke(
    "zenx_subagents_create",
    invocation("zenx_subagents_create", {
      mode: "fresh",
      model: "selected",
      effort: "high",
      task: "first task",
    }),
  );
  assert.deepEqual(f.requests[0], {
    method: "zen/thread/create-child-configured",
    params: {
      parentThreadId: "trusted-parent",
      mode: "fresh",
      model: "selected",
      effort: "high",
    },
  });
  assert.equal(
    f.requests.some((entry) => entry.method === "thread/settings/update"),
    false,
  );
  const calls: string[] = [];
  f.port.request = async (method) => {
    calls.push(method);
    throw new Error("Method not found");
  };
  await assert.rejects(
    f.service.invoke(
      "zenx_subagents_create",
      invocation("zenx_subagents_create", {
        mode: "fresh",
        effort: "high",
        task: "do not send",
      }),
    ),
    /Method not found/,
  );
  assert.deepEqual(calls, ["zen/thread/create-child-configured"]);
});

test("model and effort validation and shipped schema reject malformed settings before creation", async () => {
  const schema = subagentsManifest.tools.find(
    (tool) => tool.name === "zenx_subagents_create",
  )!.inputSchema;
  assert.deepEqual(schema.properties.model?.type, "string");
  assert.deepEqual(schema.properties.effort?.type, "string");
  assert.equal(schema.additionalProperties, false);
  for (const invalid of [
    { model: null },
    { model: " " },
    { model: 42 },
    { effort: "" },
    { effort: [] },
    { effort: null },
  ]) {
    const f = fixture();
    await assert.rejects(
      f.service.invoke(
        "zenx_subagents_create",
        invocation("zenx_subagents_create", {
          mode: "fresh",
          task: "not started",
          ...invalid,
        }),
      ),
      /must be a non-empty string/,
    );
    assert.deepEqual(f.requests, []);
  }
});

test("explicit first tasks use the requested profile through real native creation and standard send", async () => {
  const { ZenAppServer } = await import("../../../src/app-server.js");
  const { InMemoryThreadJournal } = await import("../../../src/journal.js");
  const { StaticModelCatalog } = await import("../../../src/model-catalog.js");
  const { ProviderRegistry } =
    await import("../../../src/provider-registry.js");
  const { AgentRuntime } = await import("../../../src/runtime.js");
  const { ToolEnvironment } = await import("../../../src/tool.js");
  const { InMemoryThreadMetadataStore } =
    await import("../../../src/thread-metadata.js");
  const { CodexConnection } =
    await import("../../../src/protocol/codex/connection.js");
  const { NativeConnection } =
    await import("../../../src/protocol/native/connection.js");
  const { NativeRecoveryProjection } =
    await import("../../../src/protocol/native/recovery.js");
  const { encodeModelKey } = await import("../../../src/protocol/model-key.js");
  const requests: Array<{ profile: string; effort: string | null }> = [];
  const server = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({ runtimes: [] }),
    }),
    providerRegistry: new ProviderRegistry(
      ["parent", "requested"].map((profile) => ({
        providerProfileId: profile,
        adapter: {
          provider: profile,
          async *stream(request: import("../../../src/model.js").ModelRequest) {
            requests.push({ profile, effort: request.reasoningEffort });
            if (
              profile === "parent" &&
              !request.messages.some((message) => message.role === "tool")
            ) {
              yield {
                type: "tool_call" as const,
                name: "source_call",
                callId: "parent-create-call",
                arguments: {},
              };
            } else yield { type: "text_delta" as const, delta: profile };
          },
        },
        modelCatalog: new StaticModelCatalog([
          {
            id: "shared",
            isDefault: true,
            supportedReasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "low",
            contextWindow: 32768,
          },
        ]),
      })),
    ),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: "parent",
      modelId: "shared",
      reasoningEffort: "low",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  const projection = new NativeRecoveryProjection(server);
  const messages: import("../../../src/protocol/codex/wire.js").JsonRpcMessage[] =
    [];
  const send = (
    message: import("../../../src/protocol/codex/wire.js").JsonRpcMessage,
  ) => {
    messages.push(message);
  };
  const native = new NativeConnection({ appServer: server, projection, send });
  const cas = new CodexConnection({
    appServer: server,
    send,
    zenHome: process.cwd(),
  });
  await native.receive({
    id: "native-init",
    method: "zen/initialize",
    params: {},
  });
  await cas.receive({
    id: "cas-init",
    method: "initialize",
    params: { clientInfo: { name: "test", version: "1" } },
  });
  await cas.receive({ method: "initialized" });
  let nextId = 0;
  const methods: string[] = [];
  const port = {
    projectProjection: new ZenXProjectProjection(),
    async request(method: string, params: unknown) {
      methods.push(method);
      const id = ++nextId;
      await (method.startsWith("zen/") ? native : cas).receive({
        id,
        method,
        params,
      });
      const response = messages.find(
        (message) => "id" in message && message.id === id,
      )!;
      if ("error" in response) throw new Error(response.error.message);
      if (!("result" in response)) throw new Error("Missing reply");
      return response.result;
    },
  } as AppServerRequestPort;
  const service = new ZenXSubagentsCapabilityPackage({
    appServer: port,
    threads: new ZenXSelfControlCapabilityPackage({ appServer: port }),
    listSummaries: () => server.listThreadSummaries(),
  });
  try {
    const parent = await server.startThread();
    await (
      await server.startTurn(parent.id, "parent history")
    ).done;
    const sourceCall = (await server.readThread(parent.id)).items.find(
      (item) => item.type === "tool_call",
    );
    assert.ok(sourceCall?.type === "tool_call");
    for (const mode of ["fresh", "fork"] as const) {
      const done = new Promise<void>((resolve) => {
        const stop = server.subscribe((event) => {
          if (event.type === "turn_completed" && event.threadId !== parent.id) {
            stop();
            resolve();
          }
        });
      });
      const result = (await service.invoke("zenx_subagents_create", {
        ...invocation("zenx_subagents_create", {
          mode,
          model: encodeModelKey({
            providerProfileId: "requested",
            modelId: "shared",
          }),
          effort: "high",
          task: "first task",
        }),
        threadId: parent.id,
        canonicalToolCallId: sourceCall.id,
        callId: sourceCall.callId,
      })) as {
        threadId: string;
        delivery: { mode: string };
        thread: { providerProfileId: string };
      };
      assert.equal(result.thread.providerProfileId, "requested");
      assert.equal(result.delivery.mode, "batch-next");
      await done;
      assert.deepEqual(requests.at(-1), {
        profile: "requested",
        effort: "high",
      });
      const snapshot = await server.readThread(result.threadId);
      const beforeRetry = snapshot.items.length;
      const task = snapshot.items.findLast(
        (item) => item.type === "thread_message",
      );
      assert(task?.type === "thread_message");
      assert.equal(task.sender.toolCallId, sourceCall.id);
      await server.sendThreadMessage(result.threadId, {
        sender: {
          threadId: parent.id,
          toolCallId: sourceCall.id,
          callId: sourceCall.callId,
        },
        text: "first task",
      });
      assert.equal(
        (await server.readThread(result.threadId)).items.length,
        beforeRetry,
      );
    }
    assert.equal(
      methods.filter(
        (method) => method === "zen/thread/create-child-configured",
      ).length,
      2,
    );
    assert.equal(methods.includes("thread/settings/update"), false);
    assert.equal(
      (await server.readThread(parent.id)).providerProfileId,
      "parent",
    );
  } finally {
    cas.close();
    native.close();
    projection.close();
  }
});
