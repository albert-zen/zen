import { buildCodeRuntimeWorkerFixture } from "./code-runtime-worker-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CanonicalItem } from "../../../src/item.js";
import type { ToolInvocation, ToolExecutionResult } from "../../../src/tool.js";
import type { ToolTraceCapture } from "../../../src/trace-tool.js";
import {
  ModelReferenceRegistry,
  trustedModelReferenceBindings,
  type ModelReferenceBinding,
} from "../../../src/model-references.js";
import { fleetManifest } from "../../../packages/zenx-fleet-plugin/src/manifest.js";
import {
  FleetToolTransportAdapter,
  FleetToolTargetRouter,
  FLEET_CATALOG_CONTENT_TYPE,
} from "../src/main/fleet-tool-router.js";
import { ZenXHostToolBundle } from "../src/main/capability-tool-executor.js";
import {
  FleetRouter,
  fleetDeviceKey,
  type NativeFleetDevice,
} from "../src/main/fleet.js";
import {
  ZenXSelfControlCapabilityPackage,
  MutableAppServerRequestPort,
} from "../src/main/capabilities/self-control-package.js";
import {
  invokeModelToolFacade,
  modelToolDefinition,
  modelPluginDocument,
} from "../src/main/capabilities/model-tool-facade.js";
const ID = "a1d14e93-70f1-4562-89a8-534c49a10103";
const literal = `User code UUID ${ID}; path /tmp/${ID}; hash ffba5512345678 unchanged`;
const device: NativeFleetDevice = {
  id: `device-${ID}`,
  label: "Worker",
  hostId: `host-${ID}`,
  endpoint: "https://fleet.example.test",
  transport: "https",
  access: "control",
  toolsEnabled: true,
};
const workspace = `workspace-${ID}`,
  target = `thread-${ID}`,
  epoch = `process-${ID}`,
  generation = `generation-${ID}`;
const definition = {
  name: "ordinary",
  description: "Synthetic target",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};
const catalog = {
  version: 1,
  hostId: device.hostId,
  processEpoch: epoch,
  tools: [
    {
      definition,
      generation,
      eligible: true,
      owner: { kind: "plugin", id: "synthetic" },
    },
  ],
};
const invocation = (
  name: string,
  args: Record<string, unknown>,
  owner = "owner",
): ToolInvocation => ({
  name,
  arguments: args,
  callId: "call",
  canonicalToolCallId: "canonical-call",
  threadId: owner,
  cwd: "/synthetic",
  signal: new AbortController().signal,
});
function trace(results: ToolExecutionResult[]): ToolTraceCapture {
  return {
    recordResult: async (result) => {
      results.push(result as ToolExecutionResult);
      return { durability: "degraded", error: "synthetic" };
    },
    recordAcceptedResult: async () => {},
    recordInvocation: async () => {},
    recordReferenceBindings: async () => {},
    write: async () => {},
    end: async () => {},
    flush: async () => {},
    hasObservedResult: () => true,
    hasAcceptedResult: () => false,
  };
}
async function fixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fleet-model-rebuilt-")),
    file = path.join(dir, "fleet.json");
  t.after(() => rm(dir, { recursive: true, force: true }));
  let current = device,
    effects = 0,
    statusCalls = 0,
    waitCalls = 0,
    lose = false,
    observedFailure = false;
  const native: ToolInvocation[] = [],
    raw: ToolExecutionResult[] = [],
    requests: Record<string, unknown>[] = [];
  const setDevice = async (value: NativeFleetDevice) => {
    current = value;
    await writeFile(file, JSON.stringify({ version: 1, devices: [value] }));
  };
  await setDevice(device);
  const remoteResult = (request: any) => ({
    origin: {
      hostId: device.hostId,
      processEpoch: epoch,
      workspaceId: workspace,
      threadId: target,
      toolName: "ordinary",
      toolGeneration: generation,
    },
    admissionId: request.admissionId,
    taskId: `task-${ID}`,
    status: "completed" as const,
    cursor: `cursor-${ID}`,
    output: literal,
    exitCode: 0,
    sourceTruncated: false,
    paths: "remote-host" as const,
    contentType: "synthetic/value",
    structuredContent: { literal },
  });
  const adapter = new FleetToolTransportAdapter(
    {
      file,
      native: {
        catalog: async () => structuredClone(catalog) as any,
        execute: async (_peer, request) => {
          requests.push({ ...request });
          if (
            request.processEpoch !== epoch ||
            request.toolGeneration !== generation
          )
            throw Error("stale target generation");
          effects++;
          if (lose) throw Error("Synthetic lost reply");
          return remoteResult(request);
        },
        status: async (_peer, request) => {
          statusCalls++;
          requests.push({ ...request });
          if (observedFailure) throw Error("Synthetic offline");
          return {
            ...remoteResult(request),
            output: undefined,
            cursor: undefined,
          } as any;
        },
        wait: async (_peer, request) => {
          waitCalls++;
          requests.push({ ...request });
          if (observedFailure) throw Error("Synthetic offline");
          return remoteResult(request);
        },
      },
    },
    () => {},
  );
  const fleet = new FleetRouter(
    async () => ({ version: 1, devices: [current] }),
    undefined,
    {
      invoke: async (_peer, request) => {
        requests.push({ ...request.arguments });
        if (request.name === "zenx_projects_list")
          return {
            source: "zenx.remote-host",
            projects: [
              {
                id: workspace,
                project: workspace,
                cwd: workspace,
                workspace,
                name: "Workspace",
              },
            ],
          };
        if (request.name === "zenx_models_list")
          return {
            source: "zenx.remote-host",
            models: [
              {
                id:
                  "zen-model-v1:" +
                  Buffer.from(JSON.stringify(["provider", "model"])).toString(
                    "base64url",
                  ),
                name: "Model",
              },
            ],
          };
        if (request.name === "zenx_threads_list")
          return {
            source: "zenx.remote-host",
            threads: [
              { id: target, name: "Worker", cwd: workspace, workspace },
            ],
          };
        return {
          source: "zenx.remote-host",
          threadId: target,
          status: "idle",
          cwd: workspace,
        };
      },
    },
  );
  const self = new ZenXSelfControlCapabilityPackage({
    fleet,
    appServer: new MutableAppServerRequestPort(),
  });
  const history: ModelReferenceBinding[] = [];
  const makeBundle = () => {
    const bundle = new ZenXHostToolBundle({
      capabilities: {
        definitions: fleetManifest.tools.map(
          ({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          }),
        ),
        generationToken: "synthetic",
      },
      send(event) {
        if (event.type !== "capability/invoke") return;
        const call = {
          ...event.invocation,
          signal: new AbortController().signal,
        };
        native.push(call);
        void (async () => {
          if (
            [
              "zenx_fleet_tools",
              "zenx_fleet_execute",
              "zenx_fleet_tool_status",
              "wait",
            ].includes(call.name)
          )
            return adapter.invoke(call);
          if (call.name === "zenx_fleet_devices")
            return {
              output: JSON.stringify({ devices: await fleet.devices() }),
              exitCode: 0,
            };
          const mapped =
            (
              {
                zenx_fleet_workspaces: "zenx_projects_list",
                zenx_fleet_models: "zenx_models_list",
                zenx_fleet_threads_list: "zenx_threads_list",
                zenx_fleet_threads_read: "zenx_threads_read",
                zenx_fleet_threads_status: "zenx_threads_status",
                zenx_fleet_threads_create: "zenx_threads_create",
              } as Record<string, string>
            )[call.name] ?? call.name;
          return {
            output: JSON.stringify(
              await self.invoke(mapped, { ...call, name: mapped }),
            ),
            exitCode: 0,
          };
        })().then(
          (result) =>
            bundle.handleResult({
              type: "capability/result",
              invocationId: event.invocationId,
              generationToken: event.generationToken,
              ...result,
            }),
          (error) =>
            bundle.handleResult({
              type: "capability/result",
              invocationId: event.invocationId,
              generationToken: event.generationToken,
              error: error.message,
            }),
        );
      },
    });
    return bundle;
  };
  let bundle = makeBundle();
  const call = async (
    name: string,
    args: Record<string, unknown>,
    owner = "owner",
  ) => {
    const result = await bundle.executeTarget({
      ...invocation(name, args, owner),
      modelReferences: history,
      traceOutput: trace(raw),
    });
    for (const binding of trustedModelReferenceBindings(result) ?? [])
      if (
        !history.some(
          (b) =>
            b.ownerThreadId === binding.ownerThreadId && b.ref === binding.ref,
        )
      )
        history.push(binding);
    return result;
  };
  const discover = async () => {
    const d = JSON.parse((await call("zenx_fleet_devices", {})).output)
      .devices[1].ref;
    const w = JSON.parse(
      (await call("zenx_fleet_workspaces", { device: d })).output,
    ).workspaces[0].ref;
    const th = JSON.parse(
      (await call("zenx_fleet_threads_list", { device: d, workspace: w }))
        .output,
    ).threads[0].ref;
    const disclosure = await call("zenx_fleet_tools", {
      device: d,
      workspace: w,
      thread: th,
    });
    return {
      d,
      w,
      th,
      disclosure,
      tool: JSON.parse(disclosure.output).tools[0].ref,
    };
  };
  return {
    get bundle() {
      return bundle;
    },
    call,
    discover,
    history,
    native,
    raw,
    requests,
    setDevice,
    adapter,
    restart: () => {
      bundle = makeBundle();
    },
    lose: () => {
      lose = true;
    },
    offline: () => {
      observedFailure = true;
    },
    counts: () => ({ effects, statusCalls, waitCalls }),
  };
}

test("Fleet model schemas expose semantic refs, never target_context, epochs or encoded task handles", () => {
  const definitions = fleetManifest.tools.map(modelToolDefinition);
  for (const name of [
    "deviceKey",
    "targetThreadId",
    "processEpoch",
    "toolGeneration",
    "fleet-tool:v1:",
  ])
    assert.ok(!JSON.stringify(definitions).includes(name), name);
  assert.ok(
    !modelPluginDocument("zenx-fleet", fleetManifest.mainDocument!).includes(
      "target_context",
    ),
  );
});
test("real bridge resolves the full captured tuple; native raw catalog stays separate from compact model output", async (t) => {
  const f = await fixture(t),
    selected = await f.discover();
  assert.equal(selected.disclosure.contentType, FLEET_CATALOG_CONTENT_TYPE);
  assert.ok(
    JSON.stringify(selected.disclosure.structuredContent).includes(epoch),
  );
  assert.ok(!selected.disclosure.output.includes(ID));
  const result = await f.call("zenx_fleet_execute", {
      tool: selected.tool,
      arguments: { text: literal },
    }),
    data = JSON.parse(result.output);
  assert.equal(data.status, "completed");
  assert.equal(data.output, literal);
  assert.deepEqual(data.result, { literal });
  assert.match(data.task_id, /^r\d+$/u);
  assert.equal(result.structuredContent, undefined);
  const sent = f.native.at(-1)!.arguments;
  assert.equal(sent.deviceKey, fleetDeviceKey(device));
  assert.equal(sent.workspace, workspace);
  assert.equal(sent.targetThreadId, target);
  assert.equal(sent.processEpoch, epoch);
  assert.equal(sent.toolGeneration, generation);
  assert.deepEqual(sent.arguments, { text: literal });
  assert.ok(f.raw.some((r) => r.output.includes("fleet-tool:v1:")));
  assert.ok(
    trustedModelReferenceBindings(result)?.some((b) => b.ref === selected.tool),
  );
});
test("recycled device IDs and cross-owner refs reject before remote effects, including SelfControl", async (t) => {
  const f = await fixture(t),
    selected = await f.discover();
  await assert.rejects(
    f.call(
      "zenx_fleet_execute",
      { tool: selected.tool, arguments: {} },
      "fork",
    ),
    /unavailable|retired/u,
  );
  await f.setDevice({
    ...device,
    endpoint: "https://replacement.example.test",
  });
  await assert.rejects(
    f.call("zenx_threads_list", { device: selected.d }),
    /changed/u,
  );
  await assert.rejects(
    f.call("zenx_fleet_tools", {
      device: selected.d,
      workspace: selected.w,
      thread: selected.th,
    }),
    /changed/u,
  );
  await assert.rejects(
    f.call("zenx_fleet_execute", { tool: selected.tool, arguments: {} }),
    /changed/u,
  );
  assert.equal(f.counts().effects, 0);
});
test("restart retires catalog execution refs but read-only task recovery keeps the original admission", async (t) => {
  const f = await fixture(t),
    selected = await f.discover();
  const task = JSON.parse(
    (
      await f.call("zenx_fleet_execute", {
        tool: selected.tool,
        arguments: { text: literal },
      })
    ).output,
  ).task_id;
  const admission = f.requests.at(-1)!.admissionId;
  f.restart();
  await assert.rejects(
    f.call("zenx_fleet_execute", { tool: selected.tool, arguments: {} }),
    /retired/u,
  );
  await f.call("zenx_fleet_tool_status", { task_id: task });
  await f.call("wait", { task_id: task });
  assert.equal(f.requests.at(-1)!.admissionId, admission);
  assert.deepEqual(f.counts(), { effects: 1, statusCalls: 1, waitCalls: 1 });
});
test("lost execution replies return unknown admission refs; status/wait never replay and accepted loss stays accepted", async (t) => {
  const f = await fixture(t),
    selected = await f.discover();
  f.lose();
  const result = await f.call("zenx_fleet_execute", {
      tool: selected.tool,
      arguments: {},
    }),
    data = JSON.parse(result.output);
  assert.equal(result.exitCode, 1);
  assert.equal(data.admission, "unknown");
  assert.ok(!result.output.includes("fleet-tool:"));
  const admission = f.requests.at(-1)!.admissionId;
  const observed = JSON.parse(
    (await f.call("zenx_fleet_tool_status", { task_id: data.task_id })).output,
  );
  f.offline();
  const unavailable = JSON.parse(
    (await f.call("wait", { task_id: observed.task_id })).output,
  );
  assert.equal(unavailable.admission, "accepted");
  assert.equal(f.requests.at(-1)!.admissionId, admission);
  assert.equal(f.counts().effects, 1);
});
test("dynamic proxy authority requires structured native catalog plus matching canonical provenance", async (t) => {
  const f = await fixture(t),
    selected = await f.discover();
  const items = [
    {
      id: "call-item",
      type: "tool_call",
      threadId: "owner",
      turnId: "turn",
      createdAt: "now",
      callId: "call",
      name: "zenx_fleet_tools",
      arguments: {},
    },
    {
      id: "result-item",
      type: "tool_result",
      threadId: "owner",
      turnId: "turn",
      createdAt: "now",
      callId: "call",
      ...selected.disclosure,
    },
  ] as CanonicalItem[];
  let forwarded: ToolInvocation | undefined;
  const router = new FleetToolTargetRouter(async (call) => {
    forwarded = call;
    return f.call(call.name, call.arguments);
  });
  const definitions = router.definitions(items, fleetManifest.tools, []),
    proxy = definitions.find((t) => t.name.startsWith("fleet_"))!;
  assert.match(proxy.name, /^fleet_ordinary_r\d+$/u);
  const route = router.prepare({
    ...invocation(proxy.name, { arguments: { text: literal } }),
    modelReferences: f.history,
  })!;
  assert.equal(route.resultEnvelope, "tool-task-or-result");
  await route.execute();
  assert.deepEqual(forwarded?.arguments, {
    tool: selected.tool,
    name: "ordinary",
    arguments: { text: literal },
  });
  assert.equal(
    router
      .definitions(
        items.map((i) =>
          i.type === "tool_result"
            ? { ...i, contentType: undefined, structuredContent: undefined }
            : i,
        ),
        fleetManifest.tools,
        [],
      )
      .filter((t) => t.name.startsWith("fleet_")).length,
    0,
  );
});
test("budget failure retains consumed refs, exact trace locator and known outcome without raw fallback or replay", async () => {
  const refs = new ModelReferenceRegistry(),
    scope = refs.scope("owner");
  const d = scope.bind("fleet", "device", {
    id: device.id,
    key: fleetDeviceKey(device),
  });
  let effects = 0;
  const capture = trace([]);
  capture.recordResult = async () =>
    ({
      durability: "durable",
      locator: { recordId: "raw-record", toolCallItemId: "call-item" },
    }) as any;
  const result = await invokeModelToolFacade({
    invocation: {
      ...invocation("zenx_fleet_threads_create", { device: d }),
      modelReferences: scope.newBindings,
      traceOutput: capture,
    },
    epoch: "instance",
    references: refs,
    dispatch: async () => {
      effects++;
      return {
        output: JSON.stringify({
          created: true,
          threadId: "x".repeat(1024 * 1024 + 5),
          source: "zenx.remote-host",
        }),
        exitCode: 0,
      };
    },
  });
  const data = JSON.parse(result.output);
  assert.equal(data.projection, "projection_unavailable");
  assert.equal(data.outcome.created, true);
  assert.equal(data.raw_result_file, undefined);
  assert.equal(effects, 1);
  assert.ok(result.output.length < 1500);
  assert.ok(trustedModelReferenceBindings(result)?.some((b) => b.ref === d));
  assert.ok(
    !trustedModelReferenceBindings(result)?.some(
      (b) => b.namespace === "trace",
    ),
  );
});
test("source reply consumes only the trusted received local message route, not sender rediscovery", async () => {
  const registry = new ModelReferenceRegistry(),
    refs = registry.scope("owner");
  const source = refs.bind("threads", "item", {
    id: "received-item",
    threadId: "receiving-thread",
    device: "local",
  });
  let native: ToolInvocation | undefined;
  const result = await invokeModelToolFacade({
    invocation: {
      ...invocation("zenx_fleet_source_send", { source, text: literal }),
      modelReferences: refs.newBindings,
    },
    references: registry,
    epoch: "instance",
    dispatch: async (call) => {
      native = call;
      return {
        output: JSON.stringify({
          device: device.id,
          result: { accepted: true, status: "queued", threadId: target },
        }),
        exitCode: 0,
      };
    },
  });
  assert.deepEqual(native?.arguments, {
    threadId: "receiving-thread",
    itemId: "received-item",
    text: literal,
  });
  assert.deepEqual(JSON.parse(result.output), {
    status: "queued",
    accepted: true,
  });
  assert.ok(
    trustedModelReferenceBindings(result)?.some((b) => b.ref === source),
  );
});

test("compiled run_code carries full Fleet receipts across nested dispatch, durable compaction and cold restart without replay", async (t) => {
  const { ZenAppServer } = await import("../../../src/app-server.js");
  const { AgentRuntime } = await import("../../../src/runtime.js");
  const { ToolEnvironment } = await import("../../../src/tool.js");
  const { CodeRuntime, RunCodeToolRuntime } =
    await import("../../../src/code-runtime.js");
  const { DomainThreadJournal } =
    await import("../../../src/domain-journal.js");
  const { FileTraceStore } = await import("../../../src/trace.js");
  const { JsonlThreadMetadataStore } =
    await import("../../../src/thread-metadata.js");
  const { StaticModelCatalog } = await import("../../../src/model-catalog.js");
  const { ProviderRegistry } =
    await import("../../../src/provider-registry.js");
  const { compileItemList } = await import("../../../src/item-list.js");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "fleet-semantic-runtime-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workerUrl = await buildCodeRuntimeWorkerFixture(directory);
  const f = await fixture(t);
  let phase = "nested",
    round = 0,
    chosenTask = "",
    chosenTool = "",
    owner = "",
    compactions = 0;
  let journal!: InstanceType<typeof DomainThreadJournal>;
  const samples: import("../../../src/model.js").ModelRequest[] = [];
  const model: import("../../../src/model.js").ModelAdapter = {
    provider: "synthetic-fleet",
    async *stream(request) {
      samples.push(request);
      if (request.debugContext?.purpose === "compaction") {
        compactions++;
        yield {
          type: "text_delta",
          delta: `Fleet task ${chosenTask} finished once. Observe only, never replay.`,
        };
        return;
      }
      assert.deepEqual(
        request.messages,
        compileItemList(await journal.readItemList(owner)).messages,
      );
      if (round++ % 2) {
        yield { type: "text_delta", delta: "Observed without replay." };
        return;
      }
      if (phase === "nested")
        yield {
          type: "tool_call",
          callId: "coordinator",
          name: "run_code",
          arguments: {
            code: `
const devices = await tools.zenx_fleet_devices({}); text(devices);
if (Object.hasOwn(devices,'referenceBindings')) throw Error('private provenance exposed');
const device = JSON.parse(devices.output).devices[1].ref;
const workspaces = await tools.zenx_fleet_workspaces({device}); text(workspaces);
const workspace = JSON.parse(workspaces.output).workspaces[0].ref;
const threads = await tools.zenx_fleet_threads_list({device,workspace}); text(threads);
const thread = JSON.parse(threads.output).threads[0].ref;
const catalog = await tools.zenx_fleet_tools({device,workspace,thread}); text(catalog);
const tool = JSON.parse(catalog.output).tools[0].ref;
const result = await tools.zenx_fleet_execute({tool,arguments:{text:'synthetic user literal'}}); text(result);
if (Object.hasOwn(result,'referenceBindings')) throw Error('private task provenance exposed');
const task_id = JSON.parse(result.output).task_id;
text(await tools.zenx_fleet_tool_status({task_id}));
text(await tools.wait({task_id}));
`,
          },
        };
      else
        yield {
          type: "tool_call",
          callId: phase,
          name:
            phase === "retired"
              ? "zenx_fleet_execute"
              : "zenx_fleet_tool_status",
          arguments:
            phase === "retired"
              ? { tool: chosenTool, arguments: {} }
              : { task_id: chosenTask },
        };
    },
  };
  const build = () => {
    const trace = new FileTraceStore(path.join(directory, "trace")),
      metadata = new JsonlThreadMetadataStore(
        path.join(directory, "metadata.jsonl"),
      );
    journal = new DomainThreadJournal({
      directory: path.join(directory, "threads"),
      trace,
      metadata,
    });
    const tools = new ToolEnvironment({
      bundles: [f.bundle],
      targetRouter: new FleetToolTargetRouter((call) =>
        f.bundle.executeTarget(call),
      ),
      runtimes: [
        new RunCodeToolRuntime(
          new CodeRuntime({
            workerUrl,
          }),
        ),
      ],
    });
    const app = new ZenAppServer({
      journal,
      threadMetadata: metadata,
      runtime: new AgentRuntime({ toolEnvironment: tools, trace }),
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: model.provider,
          adapter: model,
          modelCatalog: new StaticModelCatalog([
            { id: "fixture", isDefault: true, contextWindow: 1000000 },
          ]),
        },
      ]),
      defaults: {
        cwd: directory,
        providerProfileId: model.provider,
        modelId: "fixture",
        reasoningEffort: "medium",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
    });
    return {
      app,
      tools,
      trace,
      journal,
      close: async () => {
        await app.closeRuntimeConfiguration();
        await tools.close();
        await journal.close();
      },
    };
  };
  let current = build();
  try {
    owner = (await current.app.startThread()).id;
    await (
      await current.app.startTurn(
        owner,
        "Discover the selected synthetic Fleet target and execute once.",
      )
    ).done;
    const state = await current.app.readThread(owner),
      root = state.items.find(
        (i) => i.type === "tool_result" && i.callId === "coordinator",
      );
    assert.ok(root?.type === "tool_result");
    assert.equal(root.exitCode, 0, root.output);
    assert.doesNotMatch(
      root.output,
      /device-a1d|process-a1d|generation-a1d|fleet-tool:v1|ownerThreadId|referenceBindings/u,
    );
    const semantic = await journal.readItemList(owner);
    const bindings = semantic.flatMap(
      (i) => i.source.metadata?.referenceBindings ?? [],
    ) as unknown as ModelReferenceBinding[];
    chosenTask = bindings.find(
      (b) => b.namespace === "fleet" && b.kind === "task",
    )!.ref;
    chosenTool = bindings.find(
      (b) => b.namespace === "fleet" && b.kind === "tool",
    )!.ref;
    assert.ok(bindings.length >= 5);
    assert.equal(f.counts().effects, 1);
    assert.doesNotMatch(
      JSON.stringify(compileItemList(semantic).messages),
      /device-a1d|process-a1d|generation-a1d|fleet-tool:v1/u,
    );
    const traceRead = await current.trace.read(owner);
    const artifacts = await Promise.all(
      traceRead.records
        .flatMap((r) => r.artifacts)
        .map(async (a) =>
          Buffer.from(await current.trace.readArtifact(a.ref)).toString("utf8"),
        ),
    );
    assert.ok(artifacts.some((s) => s.includes("fleet-tool:v1:")));
    assert.ok(artifacts.some((s) => s.includes(epoch)));
    await current.app.compactThread(owner, { includeOriginalReference: false });
    assert.equal(compactions, 1);
    phase = "status";
    round = 0;
    await (
      await current.app.startTurn(owner, `Observe ${chosenTask}.`)
    ).done;
    assert.equal(f.counts().effects, 1);
    await current.close();
    f.restart();
    current = build();
    phase = "cold-status";
    round = 0;
    await (
      await current.app.startTurn(owner, `Observe ${chosenTask} after restart.`)
    ).done;
    const recovered = (await current.app.readThread(owner)).items.find(
      (i) => i.type === "tool_result" && i.callId === "cold-status",
    );
    assert.ok(recovered?.type === "tool_result");
    assert.equal(recovered.exitCode, 0, recovered.output);
    phase = "retired";
    round = 0;
    await (
      await current.app.startTurn(
        owner,
        `Old catalog ${chosenTool} is retired.`,
      )
    ).done;
    const retired = (await current.app.readThread(owner)).items.find(
      (i) => i.type === "tool_result" && i.callId === "retired",
    );
    assert.ok(retired?.type === "tool_result");
    assert.notEqual(retired.exitCode, 0);
    assert.match(retired.output, /retired/u);
    assert.equal(f.counts().effects, 1);
    assert.ok(samples.length >= 8);
  } finally {
    await current.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("model selections and same-label replacement devices keep distinct captured keys", async (t) => {
  const f = await fixture(t),
    chosen = await f.discover();
  const models = JSON.parse(
    (await f.call("zenx_fleet_models", { device: chosen.d })).output,
  );
  const model = models.models[0].ref;
  await f.call("zenx_fleet_threads_create", {
    device: chosen.d,
    workspace: chosen.w,
    model,
  });
  assert.equal(
    f.requests.at(-1)!.model,
    "zen-model-v1:" +
      Buffer.from(JSON.stringify(["provider", "model"])).toString("base64url"),
  );
  await f.setDevice({
    ...device,
    endpoint: "https://replacement.example.test",
  });
  const replacement = JSON.parse(
    (await f.call("zenx_fleet_devices", {})).output,
  ).devices[1];
  assert.equal(replacement.label, device.label);
  assert.notEqual(replacement.ref, chosen.d);
  await assert.rejects(
    f.call("zenx_fleet_threads_create", { device: replacement.ref, model }),
    /different device/u,
  );
});
test("native remote history emits exact Trigger source refs while preserving literal text and no sender routes", async () => {
  const references = new ModelReferenceRegistry(),
    refs = references.scope("owner");
  const d = refs.bind("fleet", "device", {
      id: device.id,
      key: fleetDeviceKey(device),
    }),
    w = refs.bind("fleet", "workspace", {
      id: workspace,
      device: device.id,
      deviceKey: fleetDeviceKey(device),
    }),
    th = refs.bind("threads", "thread", {
      id: target,
      device: device.id,
      deviceKey: fleetDeviceKey(device),
      workspace,
    });
  const read = await invokeModelToolFacade({
    invocation: {
      ...invocation("zenx_fleet_threads_read", {
        device: d,
        workspace: w,
        ref: th,
      }),
      modelReferences: refs.newBindings,
    },
    references,
    epoch: "fixture",
    dispatch: async () => ({
      output: JSON.stringify({
        device: device.id,
        result: {
          source: "zenx.remote-host",
          threadId: target,
          workspace,
          items: [
            {
              itemId: "trigger-item",
              type: "host_message",
              source: "trigger",
              sourceId: "opaque-trigger",
              text: literal,
              sender: { threadId: "opaque-sender", threadName: "Author" },
            },
          ],
        },
      }),
      exitCode: 0,
    }),
  });
  const item = JSON.parse(read.output).items[0];
  assert.equal(item.text, literal);
  assert.equal(item.sender.threadName, "Author");
  assert.match(item.sourceRef, /^r\d+$/u);
  assert.ok(!read.output.includes("opaque-sender"));
  assert.ok(!read.output.includes("opaque-trigger"));
  let routed: ToolInvocation | undefined;
  const result = await invokeModelToolFacade({
    invocation: {
      ...invocation("zenx_fleet_trigger_read", { source: item.sourceRef }),
      modelReferences: trustedModelReferenceBindings(read),
    },
    references,
    epoch: "fixture",
    dispatch: async (call) => {
      routed = call;
      return {
        output: JSON.stringify({
          device: device.id,
          result: {
            source: "zenx.remote-host",
            trigger: {
              id: "opaque-trigger",
              threadId: target,
              name: "Trigger",
              enabled: true,
            },
          },
        }),
        exitCode: 0,
      };
    },
  });
  assert.deepEqual(routed?.arguments, {
    device: device.id,
    deviceKey: fleetDeviceKey(device),
    workspace,
    threadId: target,
    triggerId: "opaque-trigger",
  });
  assert.equal(JSON.parse(result.output).name, "Trigger");
  assert.ok(!result.output.includes(target));
});
test("publication failure with no typed outcome is unclassified and ordinary shell reads the original local artifact bytes", async (t) => {
  const { FileTraceStore } = await import("../../../src/trace.js"),
    { createToolTraceCapture } = await import("../../../src/trace-tool.js");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "fleet-budget-trace-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const traceStore = new FileTraceStore(directory),
    references = new ModelReferenceRegistry(),
    scope = references.scope("owner");
  const d = scope.bind("fleet", "device", {
    id: device.id,
    key: fleetDeviceKey(device),
  });
  let effects = 0;
  const nativeOutput = JSON.stringify({
    threadId: "x".repeat(1024 * 1024 + 1),
    literal,
    targetOnlySpool: "/remote-only/not-transmitted",
  });
  const result = await invokeModelToolFacade({
    invocation: {
      ...invocation("zenx_fleet_threads_create", { device: d }),
      modelReferences: scope.newBindings,
      traceOutput: createToolTraceCapture(traceStore, {
        threadId: "owner",
        callId: "call",
        toolCallItemId: "canonical-call",
        toolName: "zenx_fleet_threads_create",
      }),
    },
    references,
    epoch: "fixture",
    dispatch: async () => {
      effects++;
      return { output: nativeOutput, exitCode: 0, sourceTruncated: true };
    },
  });
  const receipt = JSON.parse(result.output);
  assert.equal(receipt.outcome.classification, "unclassified");
  assert.equal(receipt.projection, "projection_unavailable");
  assert.equal(effects, 1);
  const { ShellToolRuntime } = await import("../../../src/tool.js");
  const shell = new ShellToolRuntime({ maxOutputBytes: 2 * 1024 * 1024 });
  const read = await shell.execute({
    ...invocation("shell", {
      command: `cat ${JSON.stringify(receipt.raw_result_file.path)}`,
    }),
    outputAudience: "program",
    sandbox: "read-only",
    cwd: directory,
    task: { previewBytes: 2 * 1024 * 1024 },
  });
  assert.equal(JSON.parse(read.output).output, nativeOutput);
  assert.equal(receipt.raw_result_file.previewTruncated, true);
  assert.equal(receipt.raw_result_file.sourceTruncated, true);
  assert.equal(receipt.raw_result_file.captureComplete, true);
  assert.ok(receipt.raw_result_file.path.startsWith(directory));
  assert.notEqual(receipt.raw_result_file.path, "/remote-only/not-transmitted");
  assert.ok(receipt.raw_result_file.byteLength > 1024 * 1024);
  const raw = await traceStore.read("owner");
  const observed = raw.records.find((r) => r.type === "tool_result_observed")!;
  assert.ok(observed.artifacts.length);
  const json = observed.artifacts.find((a) => a.name === "result_json")!;
  assert.equal(
    JSON.parse(
      Buffer.from(await traceStore.readArtifact(json.ref)).toString("utf8"),
    ).output,
    nativeOutput,
  );
});
test("an explicit remoteTool on an ineligible tool never falls back locally", async (t) => {
  const { ToolEnvironment } = await import("../../../src/tool.js");
  let effects = 0;
  const tools = new ToolEnvironment({
    targetRouter: new FleetToolTargetRouter(async () => {
      throw Error("unexpected transport");
    }),
    runtimes: [
      {
        name: "ineligible",
        specification: {
          name: "ineligible",
          description: "synthetic",
          inputSchema: { type: "object", properties: {} },
        },
        execute: async () => {
          effects++;
          return { output: "local", exitCode: 0 };
        },
      },
    ],
  });
  t.after(() => tools.close());
  assert.throws(
    () => tools.prepare(invocation("ineligible", { remoteTool: "r1" })),
    /not eligible.*no local fallback/u,
  );
  assert.equal(effects, 0);
});

test("selected message source is read-only until a verified source read emits its exact receiving-route ref", async () => {
  const references = new ModelReferenceRegistry();
  const selected: ModelReferenceBinding = {
    ref: "s1",
    ownerThreadId: "owner",
    namespace: "selected-reference",
    kind: "message",
    value: { id: "received", threadId: "receiving" },
  };
  let effects = 0;
  const send = (source: string, history: readonly ModelReferenceBinding[]) =>
    invokeModelToolFacade({
      invocation: {
        ...invocation("zenx_fleet_source_send", { source, text: literal }),
        modelReferences: history,
      },
      references,
      epoch: "fixture",
      dispatch: async (call) => {
        effects++;
        assert.equal(call.arguments.threadId, "receiving");
        assert.equal(call.arguments.itemId, "received");
        return { output: JSON.stringify({ accepted: true }), exitCode: 0 };
      },
    });
  await assert.rejects(send("s1", [selected]), /read-only/u);
  assert.equal(effects, 0);
  const read = await invokeModelToolFacade({
    invocation: {
      ...invocation("zenx_fleet_source_read", { source: "s1" }),
      modelReferences: [selected],
    },
    references,
    epoch: "fixture",
    dispatch: async () => ({
      output: JSON.stringify({
        receipt: { threadId: "receiving", itemId: "received" },
        locator: {
          deviceId: device.id,
          deviceKey: fleetDeviceKey(device),
          workspace,
          threadId: target,
        },
        history: { source: "zenx.remote-host", threadId: target, items: [] },
      }),
      exitCode: 0,
    }),
  });
  const source = JSON.parse(read.output).source;
  assert.match(source, /^r\d+$/u);
  await send(source, trustedModelReferenceBindings(read)!);
  assert.equal(effects, 1);
});
