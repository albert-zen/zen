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

test("fresh and fork use the trusted caller by default and create no implicit Turn", async () => {
  for (const mode of ["fresh", "fork"]) {
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
  assert.equal(result.delivery.mode, "start");
  assert.equal(result.delivery.turnId, "turn");
  assert.deepEqual(
    f.requests.find((r) => r.method === "thread/name/set")?.params,
    { threadId: "child", name: "Child" },
  );
  const sent = f.requests.find((r) => r.method === "turn/start")?.params as {
    threadId: string;
    input: unknown;
  };
  assert.equal(sent.threadId, "child");
  assert.deepEqual(sent.input, [{ type: "text", text: "User task" }]);
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
  assert.equal(f.requests.at(-1)?.method, "turn/start");
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
  assert.equal(
    catalog.pluginSnapshot().threadHeaders?.[0]?.pluginId,
    "zenx-subagents",
  );
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
