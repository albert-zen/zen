import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ZenAppServer } from "../../../src/app-server.js";
import type { CanonicalItem } from "../../../src/item.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import type { ModelAdapter, ModelRequest } from "../../../src/model.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import {
  ShellToolRuntime,
  ToolEnvironment,
  type CompositeToolRuntime,
  type ToolExecutionResult,
  type ToolInvocation,
} from "../../../src/tool.js";
import { TOOL_TASK_CONTENT_TYPE } from "../../../src/tool-task-content.js";
import {
  DEFAULT_TOOL_OUTPUT_PREVIEW_BYTES,
  ToolOutputSpool,
} from "../../../src/tool-output-spool.js";
import { FleetToolGateway } from "../../../src/protocol/native/remote-tools.js";
import { fleetManifest } from "../../../packages/zenx-fleet-plugin/src/manifest.js";
import { createZenXHostToolEnvironment } from "../src/main/capability-tool-executor.js";
import {
  FLEET_CATALOG_CONTENT_TYPE,
  FleetToolTargetRouter,
  FleetToolTransportAdapter,
} from "../src/main/fleet-tool-router.js";
import {
  PLUGIN_DISCLOSURE_CONTENT_TYPE,
  PluginDiscoveryProjection,
  PluginDiscoveryToolRuntime,
  disclosedPluginIds,
} from "../src/main/plugin-discovery.js";
import type { NativeFleetDevice } from "../src/main/fleet.js";

const definitions = fleetManifest.tools.map(
  ({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }),
);
const device: NativeFleetDevice = {
  id: "remote",
  label: "Remote",
  transport: "https",
  endpoint: "https://example.test",
  hostId: "target-host",
  access: "control",
  toolsEnabled: true,
};

function server(
  runtime: AgentRuntime,
  model: ModelAdapter,
  journal = new InMemoryThreadJournal(),
): ZenAppServer {
  return new ZenAppServer({
    runtime,
    journal,
    threadMetadata: new InMemoryThreadMetadataStore(),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          { id: "fixture", isDefault: true, contextWindow: 32768 },
        ]),
      },
    ]),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: model.provider,
      modelId: "fixture",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}

async function fullOutput(output: string): Promise<string> {
  assert.match(output, /^\[tool output receipt\]/u);
  assert.match(output, /source_truncated: false/u);
  const file = /^full_output: (.+)$/mu.exec(output)?.[1];
  assert(file && file !== "unavailable");
  return await readFile(file, "utf8");
}

test("actual Fleet HOWTO and gateway catalog survive AgentRuntime default spooling and repeated provider IDs", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "fleet-disclosure-spool-"),
  );
  const file = path.join(directory, "fleet.json");
  await writeFile(file, JSON.stringify({ version: 1, devices: [device] }));
  const spool = new ToolOutputSpool();
  const targetTools = new ToolEnvironment({
    runtimes: [
      new ShellToolRuntime(),
      ...definitions.map((definition) => ({
        name: definition.name,
        specification: definition,
        async execute() {
          throw new Error("unexpected target body");
        },
      })),
    ],
  });
  const targetServer = server(
    new AgentRuntime({ toolEnvironment: targetTools }),
    {
      provider: "target",
      async *stream() {
        yield { type: "text_delta", delta: "done" };
      },
    },
  );
  const target = await targetServer.startThread();
  const gateway = new FleetToolGateway({
    tools: targetTools,
    hostId: device.hostId,
    processEpoch: "target-epoch",
  });
  const adapter = new FleetToolTransportAdapter(
    {
      file,
      native: {
        catalog: async (_device, request) =>
          gateway.catalog(
            {
              ...request,
              version: 1,
              hostId: device.hostId,
              processEpoch: "target-epoch",
            },
            () => targetServer.readThread(target.id),
            "source-host",
          ),
        execute: async () => {
          throw new Error("unexpected remote execute");
        },
        wait: async () => {
          throw new Error("unexpected remote wait");
        },
        status: async () => {
          throw new Error("unexpected remote status");
        },
      },
    },
    () => {},
  );
  let composition: ReturnType<typeof createZenXHostToolEnvironment>;
  composition = createZenXHostToolEnvironment({
    capabilities: {
      definitions,
      plugins: [
        {
          id: fleetManifest.id,
          name: fleetManifest.name,
          description: fleetManifest.description,
          status: "enabled",
          mainDocument: fleetManifest.mainDocument,
          tools: definitions,
        },
      ],
    },
    toolOutputSpool: spool,
    send(event) {
      if (event.type !== "capability/invoke") return;
      void adapter
        .invoke({ ...event.invocation, signal: new AbortController().signal })
        .then((result) =>
          composition.capabilityBundle.handleResult({
            type: "capability/result",
            invocationId: event.invocationId,
            generationToken: event.generationToken,
            ...result,
          }),
        );
    },
  });
  t.after(async () => {
    await composition.close();
    await gateway.close();
    await targetTools.close();
    await spool.close();
    await rm(directory, { recursive: true, force: true });
  });
  const samples: ModelRequest[] = [];
  const model: ModelAdapter = {
    provider: "source",
    async *stream(request) {
      samples.push(request);
      if (samples.length === 1)
        yield {
          type: "tool_call",
          callId: "read",
          name: "zenx_plugin",
          arguments: { operation: "read", pluginId: fleetManifest.id },
        };
      else if (samples.length === 2)
        yield {
          type: "tool_call",
          callId: "reused-provider-id",
          name: "zenx_fleet_tools",
          arguments: {
            device: device.id,
            workspace: "workspace",
            targetThreadId: target.id,
          },
        };
      else if ([3, 5].includes(samples.length))
        yield {
          type: "tool_call",
          callId: "reused-provider-id",
          name: "shell",
          arguments: { command: "printf unrelated" },
        };
      else yield { type: "text_delta", delta: "done" };
    },
  };
  const app = server(
    new AgentRuntime({
      toolEnvironment: composition.toolEnvironment,
      toolDefinitionProjection: composition.toolDefinitionProjection,
      toolOutputSpool: spool,
    }),
    model,
  );
  const source = await app.startThread();
  await (
    await app.startTurn(source.id, "Read Fleet and obtain the target catalog")
  ).done;
  await (
    await app.startTurn(source.id, "An unrelated later Turn")
  ).done;
  const snapshot = await app.readThread(source.id);
  const calls = snapshot.items.filter((item) => item.type === "tool_call");
  const results = snapshot.items.filter((item) => item.type === "tool_result");
  assert(results.every((item) => item.exitCode === 0));
  assert.deepEqual(
    calls.map((item) => item.callId),
    ["read", "reused-provider-id", "reused-provider-id", "reused-provider-id"],
  );
  assert.equal(new Set(calls.map((item) => item.id)).size, 4);
  assert.notEqual(calls[1]?.modelResponseId, calls[2]?.modelResponseId);
  assert.notEqual(calls[2]?.turnId, calls[3]?.turnId);
  const read = results[0]!;
  assert.equal(read.contentType, PLUGIN_DISCLOSURE_CONTENT_TYPE);
  assert.deepEqual(read.structuredContent, {
    version: 1,
    operation: "read",
    pluginId: fleetManifest.id,
  });
  const readText = await fullOutput(read.output);
  assert(Buffer.byteLength(readText) > DEFAULT_TOOL_OUTPUT_PREVIEW_BYTES);
  assert.equal(
    JSON.parse(readText).plugin.mainDocument,
    fleetManifest.mainDocument,
  );
  assert(
    samples[1]!.messages.some(
      (message) => message.role === "tool" && message.text === read.output,
    ),
  );
  assert(samples[1]!.tools.some((tool) => tool.name === "zenx_fleet_tools"));
  const catalog = results[1]!;
  assert.equal(catalog.contentType, FLEET_CATALOG_CONTENT_TYPE);
  const catalogText = await fullOutput(catalog.output);
  assert(Buffer.byteLength(catalogText) > DEFAULT_TOOL_OUTPUT_PREVIEW_BYTES);
  assert.deepEqual(catalog.structuredContent, JSON.parse(catalogText));
  const proxies = samples[2]!.tools.filter((tool) =>
    tool.name.startsWith("fleet_tool_"),
  );
  assert(proxies.length > 0);
  for (const sample of samples.slice(2))
    assert.deepEqual(
      sample.tools.filter((tool) => tool.name.startsWith("fleet_tool_")),
      proxies,
    );
  // Data metadata is never another source of provider-visible instruction text.
  assert(
    samples.every((sample) =>
      sample.messages.every(
        (message) =>
          !JSON.stringify(message).includes(PLUGIN_DISCLOSURE_CONTENT_TYPE),
      ),
    ),
  );
  // The same canonical history is enough to rebuild after a Host projection restart.
  const restarted = new FleetToolTargetRouter(async () => {
    throw new Error("unexpected execute");
  });
  assert.deepEqual(
    restarted
      .definitions(
        snapshot.items,
        samples[1]!.tools,
        composition.toolEnvironment.remoteDefinitions,
      )
      .filter((tool) => tool.name.startsWith("fleet_tool_")),
    proxies,
  );
});

for (const kind of ["fleet", "plugin"] as const) {
  test(`late nested ${kind} disclosure survives coordinator yield and the next model response`, async (t) => {
    const started = deferred();
    const release = deferred();
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nested-disclosure-"),
    );
    const file = path.join(directory, "fleet.json");
    await writeFile(file, JSON.stringify({ version: 1, devices: [device] }));
    const ordinary = {
      name: "fixture_echo",
      description: "Remote and plugin fixture",
      inputSchema: { type: "object", properties: {} },
    };
    const targetTools = new ToolEnvironment({
      runtimes: [
        {
          name: ordinary.name,
          remoteExecution: "text-json",
          specification: ordinary,
          async execute() {
            throw new Error("unexpected target body");
          },
        },
      ],
    });
    const targetServer = server(
      new AgentRuntime({ toolEnvironment: targetTools }),
      {
        provider: "target",
        async *stream() {
          yield { type: "text_delta", delta: "done" };
        },
      },
    );
    const target = await targetServer.startThread();
    const gateway = new FleetToolGateway({
      tools: targetTools,
      hostId: device.hostId,
      processEpoch: "target-epoch",
    });
    const adapter = new FleetToolTransportAdapter(
      {
        file,
        native: {
          async catalog(_device, request) {
            started.resolve();
            await release.promise;
            return await gateway.catalog(
              {
                ...request,
                version: 1,
                hostId: device.hostId,
                processEpoch: "target-epoch",
              },
              () => targetServer.readThread(target.id),
              "source-host",
            );
          },
          async execute() {
            throw new Error("unexpected remote execute");
          },
          async wait() {
            throw new Error("unexpected remote wait");
          },
          async status() {
            throw new Error("unexpected remote status");
          },
        },
      },
      () => {},
    );
    const childName = kind === "fleet" ? "zenx_fleet_tools" : "zenx_plugin";
    const childArguments =
      kind === "fleet"
        ? {
            device: device.id,
            workspace: "workspace",
            targetThreadId: target.id,
          }
        : { operation: "read", pluginId: "fixture" };
    const coordinator: CompositeToolRuntime = {
      name: "run_code",
      specification: {
        name: "run_code",
        description: "Coordinate discovery",
        inputSchema: { type: "object" },
      },
      async execute() {
        throw new Error("composite entry required");
      },
      async executeComposite(invocation, nested) {
        const result = nested.invoke(childName, childArguments);
        await started.promise;
        assert(invocation.taskContext?.requestYield);
        invocation.taskContext.requestYield();
        await result;
        await nested.drain?.();
        return { output: "discovery completed", exitCode: 0 };
      },
    };
    const router = new FleetToolTargetRouter((invocation) =>
      adapter.invoke(invocation),
    );
    const tools = new ToolEnvironment({
      runtimes: [
        coordinator,
        {
          name: "zenx_fleet_tools",
          specification: {
            name: "zenx_fleet_tools",
            description: "catalog",
            inputSchema: { type: "object" },
          },
          async execute() {
            throw new Error("unexpected local catalog");
          },
        },
      ],
      bundles: [
        {
          identity: { kind: "plugin", id: "fixture" },
          tools: [
            {
              name: ordinary.name,
              specification: ordinary,
              async execute() {
                throw new Error("unexpected plugin body");
              },
            },
          ],
        },
      ],
      targetRouter: router,
    });
    const catalog = {
      availablePlugins: () => [
        {
          id: "fixture",
          name: "Fixture",
          description: "Fixture plugin",
          status: "enabled" as const,
          mainDocument: "Use fixture_echo",
          tools: [ordinary],
        },
      ],
    };
    class GatedDiscovery extends PluginDiscoveryToolRuntime {
      override async execute(
        invocation: ToolInvocation,
      ): Promise<ToolExecutionResult> {
        started.resolve();
        await release.promise;
        return await super.execute(invocation);
      }
    }
    tools.registerRuntime(new GatedDiscovery(catalog, tools), {
      kind: "builtin",
      id: "zenx-plugin-discovery",
    });
    const projection = new PluginDiscoveryProjection(tools, catalog);
    const journal = new InMemoryThreadJournal();
    const append = journal.append.bind(journal);
    journal.append = async (item) => {
      await append(item);
      if (item.type === "tool_call" && item.name === "wait") release.resolve();
    };
    const samples: ModelRequest[] = [];
    const model: ModelAdapter = {
      provider: "source",
      async *stream(request) {
        samples.push(request);
        if (samples.length === 1) {
          yield {
            type: "tool_call",
            callId: "coordinator",
            name: "run_code",
            arguments: {},
          };
        } else if (samples.length === 2) {
          const receipt = request.messages
            .filter((message) => message.role === "tool")
            .at(-1);
          assert(receipt?.role === "tool");
          const taskId = /task_id: (\S+)/u.exec(receipt.text)?.[1];
          assert(taskId, receipt.text);
          yield { type: "text_delta", delta: "Waiting for discovery" };
          yield {
            type: "tool_call",
            callId: "wait",
            name: "wait",
            arguments: { task_id: taskId, yield_time_ms: 1000 },
          };
        } else {
          yield { type: "text_delta", delta: "done" };
        }
      },
    };
    const app = server(
      new AgentRuntime({
        toolEnvironment: tools,
        toolPresentation: "both",
        toolDefinitionProjection: (items) =>
          router.definitions(
            items,
            projection.definitions(items),
            tools.remoteDefinitions,
          ),
      }),
      model,
      journal,
    );
    t.after(async () => {
      release.resolve();
      await tools.close();
      await gateway.close();
      await targetTools.close();
      await rm(directory, { recursive: true, force: true });
    });
    const source = await app.startThread();
    await (
      await app.startTurn(source.id, "Discover through a yielding coordinator")
    ).done;
    const snapshot = await app.readThread(source.id);
    const child = snapshot.items.find(
      (item) => item.type === "tool_call" && item.name === childName,
    );
    assert(child?.type === "tool_call");
    assert.equal(child.parentCallId, "coordinator");
    assert.equal(child.modelResponseId, undefined);
    const childResult = snapshot.items.find(
      (item) => item.type === "tool_result" && item.callId === child.callId,
    );
    assert(childResult?.type === "tool_result");
    assert.equal(childResult.exitCode, 0);
    assert.equal(
      childResult.contentType,
      kind === "fleet"
        ? FLEET_CATALOG_CONTENT_TYPE
        : PLUGIN_DISCLOSURE_CONTENT_TYPE,
    );
    const rootReceipt = snapshot.items.find(
      (item) => item.type === "tool_result" && item.callId === "coordinator",
    );
    assert(rootReceipt?.type === "tool_result");
    assert.equal(rootReceipt.contentType, TOOL_TASK_CONTENT_TYPE);
    assert.equal(
      (rootReceipt.structuredContent as { status: string }).status,
      "running",
    );
    const waitCall = snapshot.items.find(
      (item) => item.type === "tool_call" && item.name === "wait",
    );
    assert(waitCall?.type === "tool_call");
    const rootCall = snapshot.items.find(
      (item) => item.type === "tool_call" && item.name === "run_code",
    );
    assert(rootCall?.type === "tool_call");
    assert.notEqual(waitCall.modelResponseId, rootCall.modelResponseId);
    assert(
      snapshot.items.indexOf(waitCall) < snapshot.items.indexOf(childResult),
    );
    assert(
      snapshot.items.some(
        (item) =>
          item.type === "agent_message" &&
          item.text === "Waiting for discovery",
      ),
    );
    assert.equal(samples.length, 3);
    const disclosed = (sample: ModelRequest) =>
      sample.tools.filter((tool) =>
        kind === "fleet"
          ? tool.name.startsWith("fleet_tool_")
          : tool.name === "fixture_echo",
      );
    assert.deepEqual(
      samples.slice(0, 2).map((sample) => disclosed(sample).length),
      [0, 0],
    );
    assert.equal(disclosed(samples[2]!).length, 1);
    const rebuilt = new FleetToolTargetRouter(async () => {
      throw new Error("unexpected execute");
    }).definitions(
      snapshot.items,
      new PluginDiscoveryProjection(tools, catalog).definitions(snapshot.items),
      tools.remoteDefinitions,
    );
    assert.deepEqual(
      rebuilt.filter((tool) =>
        kind === "fleet"
          ? tool.name.startsWith("fleet_tool_")
          : tool.name === "fixture_echo",
      ),
      disclosed(samples[2]!),
    );
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pair(
  callName: string,
  output: string,
  overrides: Partial<Extract<CanonicalItem, { type: "tool_call" }>> = {},
): CanonicalItem[] {
  const base = {
    threadId: "source",
    turnId: "turn",
    createdAt: "2026-10-05T00:00:00Z",
    callId: "reused",
  };
  return [
    {
      ...base,
      type: "tool_call",
      id: "call",
      name: callName,
      arguments: {},
      ...overrides,
    },
    { ...base, type: "tool_result", id: "result", exitCode: 0, output },
  ];
}

const legacyDisclosure = JSON.stringify({
  source: "zenx.fleet.tools",
  device: "remote",
  deviceKey: "key",
  sourceThreadId: "source",
  workspaceId: "workspace",
  targetThreadId: "target",
  catalog: {
    version: 1,
    hostId: "host",
    processEpoch: "epoch",
    tools: [
      {
        owner: { kind: "builtin", id: "ordinary" },
        generation: "generation",
        eligible: true,
        definition: {
          name: "ordinary",
          description: "exact",
          inputSchema: { type: "object", properties: {} },
        },
      },
    ],
  },
});
const fleetTool = {
  name: "zenx_fleet_tools",
  description: "catalog",
  inputSchema: { type: "object" },
};

test("temporal disclosure cannot adopt earlier unrelated output or span Turn/model-response boundaries", () => {
  const router = new FleetToolTargetRouter(async () => {
    throw new Error("unexpected execute");
  });
  const unrelated = pair("shell", legacyDisclosure);
  const laterCall = pair("zenx_fleet_tools", "unrelated", {
    modelResponseId: "later-response",
  });
  assert.equal(
    router.definitions([...unrelated, ...laterCall], [fleetTool], []).length,
    1,
  );
  const valid = pair("zenx_fleet_tools", legacyDisclosure, {
    modelResponseId: "first-response",
  });
  assert.equal(router.definitions(valid, [fleetTool], []).length, 2);
  assert.equal(
    router.definitions(
      [
        ...valid,
        ...pair("shell", "unrelated", { modelResponseId: "next-response" }),
      ],
      [fleetTool],
      [],
    ).length,
    2,
  );
  for (const boundary of [
    { ...laterCall[0]!, callId: "different", turnId: "different-turn" },
    { ...laterCall[0]!, callId: "different", modelResponseId: "next-response" },
  ])
    assert.equal(
      router.definitions(
        [valid[0]!, boundary as CanonicalItem, valid[1]!],
        [fleetTool],
        [],
      ).length,
      1,
    );
});

for (const kind of ["fleet", "plugin"] as const) {
  test(`${kind} disclosure rejects overlapping root/nested ID reuse and accepts reuse only after settlement`, () => {
    const router = new FleetToolTargetRouter(async () => {
      throw new Error("unexpected execute");
    });
    const read =
      kind === "fleet"
        ? pair("zenx_fleet_tools", legacyDisclosure)
        : pair(
            "zenx_plugin",
            JSON.stringify({
              operation: "read",
              plugin: {
                id: "fixture",
                name: "Fixture",
                description: "Fixture",
                status: "enabled",
                mainDocument: "HOWTO",
                tools: [],
              },
            }),
            { arguments: { operation: "read", pluginId: "fixture" } },
          );
    const count = (items: CanonicalItem[]) =>
      kind === "fleet"
        ? router.definitions(items, [fleetTool], []).length - 1
        : disclosedPluginIds(items).size;
    const call = read[0] as Extract<CanonicalItem, { type: "tool_call" }>;
    const result = read[1] as Extract<CanonicalItem, { type: "tool_result" }>;
    for (const [earlierNested, laterNested] of [
      [true, false],
      [false, true],
      [true, true],
      [false, false],
    ]) {
      for (const earlierDisclosure of [true, false]) {
        const earlier = {
          ...call,
          modelResponseId: "first-response",
          name: earlierDisclosure ? call.name : "shell",
          ...(earlierNested ? { parentCallId: "coordinator" } : {}),
        };
        const later = {
          ...call,
          id: "later-call",
          modelResponseId: "next-response",
          name: earlierDisclosure ? "shell" : call.name,
          ...(laterNested ? { parentCallId: "coordinator" } : {}),
        };
        const overlapping: CanonicalItem[] = [
          earlier,
          {
            id: "message",
            type: "agent_message",
            threadId: call.threadId,
            turnId: call.turnId,
            createdAt: call.createdAt,
            text: "next response",
          },
          later,
          result,
          { ...result, id: "later-result" },
        ];
        assert.equal(
          count(overlapping),
          0,
          JSON.stringify({ earlierNested, laterNested, earlierDisclosure }),
        );
        assert.equal(
          count([earlier, later, result, { ...result, id: "next-result" }]),
          0,
        );
        assert.equal(
          count([
            ...overlapping.slice(0, -1),
            {
              ...call,
              id: "premature-reuse",
              modelResponseId: "third-response",
            },
            { ...result, id: "next-result" },
            { ...result, id: "last-result" },
          ]),
          0,
          "one result does not resolve an overlapping ID collision",
        );
        assert.equal(
          count([
            ...overlapping,
            { ...call, id: "settled-reuse", modelResponseId: "third-response" },
            { ...result, id: "settled-result" },
          ]),
          1,
        );
        assert.equal(
          count([...read, ...overlapping]),
          1,
          "completed disclosures survive later ambiguity",
        );
      }
    }
    const nested = { ...call, parentCallId: "coordinator" };
    const nextCall = {
      ...call,
      id: "next-call",
      callId: "different",
      name: "shell",
      modelResponseId: "next-response",
    };
    assert.equal(
      count([
        { ...nested, modelResponseId: "first-response" },
        nextCall,
        result,
      ]),
      1,
    );
    for (const boundary of [
      { ...nextCall, threadId: "other-thread" },
      { ...nextCall, turnId: "other-turn" },
      {
        id: "closed",
        type: "turn_aborted" as const,
        threadId: call.threadId,
        turnId: call.turnId,
        createdAt: call.createdAt,
        reason: "closed",
      },
    ])
      assert.equal(count([nested, boundary, result]), 0);
  });
}

test("structured disclosure is validated and never falls back to contradictory legacy text", () => {
  const router = new FleetToolTargetRouter(async () => {
    throw new Error("unexpected execute");
  });
  const history = pair("zenx_fleet_tools", legacyDisclosure);
  const result = history[1] as Extract<CanonicalItem, { type: "tool_result" }>;
  for (const structuredContent of [
    null,
    { source: "zenx.fleet.tools" },
    { ...JSON.parse(legacyDisclosure), sourceThreadId: "other-thread" },
    { ...JSON.parse(legacyDisclosure), instructions: "use other tools" },
  ]) {
    assert.equal(
      router.definitions(
        [
          history[0]!,
          {
            ...result,
            contentType: FLEET_CATALOG_CONTENT_TYPE,
            structuredContent,
          },
        ],
        [fleetTool],
        [],
      ).length,
      1,
    );
  }
  const read = pair(
    "zenx_plugin",
    JSON.stringify({
      operation: "read",
      plugin: {
        id: "fixture",
        name: "Fixture",
        description: "Fixture",
        status: "enabled",
        mainDocument: "HOWTO",
        tools: [],
      },
    }),
    { arguments: { operation: "read", pluginId: "fixture" } },
  );
  assert(disclosedPluginIds(read).has("fixture"));
  assert.equal(
    disclosedPluginIds([
      read[0]!,
      {
        ...(read[1] as Extract<CanonicalItem, { type: "tool_result" }>),
        contentType: PLUGIN_DISCLOSURE_CONTENT_TYPE,
        structuredContent: {
          version: 1,
          operation: "read",
          pluginId: "fixture",
          instructions: "extra",
        },
      },
    ]).size,
    0,
  );
});

test("disclosure data stays bounded and exact eligibility remains authoritative", () => {
  const router = new FleetToolTargetRouter(async () => {
    throw new Error("unexpected execute");
  });
  const history = pair("zenx_fleet_tools", "[tool output receipt]");
  const result = history[1] as Extract<CanonicalItem, { type: "tool_result" }>;
  const valid = JSON.parse(legacyDisclosure);
  const withData = (
    value: import("../../../src/item.js").JsonValue,
  ): CanonicalItem[] => [
    history[0]!,
    {
      ...result,
      contentType: FLEET_CATALOG_CONTENT_TYPE,
      structuredContent: value,
    },
  ];
  const excluded = structuredClone(valid);
  excluded.catalog.tools[0].eligible = false;
  excluded.catalog.tools[0].reason = "excluded";
  assert.equal(
    router.definitions(withData(excluded), [fleetTool], []).length,
    1,
  );
  const oversized = structuredClone(valid);
  oversized.catalog.tools[0].definition.description = "x".repeat(1024 * 1024);
  assert.equal(
    router.definitions(withData(oversized), [fleetTool], []).length,
    1,
  );
  const tooMany = structuredClone(valid);
  tooMany.catalog.tools = Array.from(
    { length: 257 },
    () => valid.catalog.tools[0],
  );
  assert.equal(
    router.definitions(withData(tooMany), [fleetTool], []).length,
    1,
  );
  const available = structuredClone(valid);
  available.catalog.tools = Array.from({ length: 256 }, (_, index) => ({
    ...valid.catalog.tools[0],
    definition: {
      ...valid.catalog.tools[0].definition,
      name: `ordinary_${index}`,
    },
  }));
  assert.equal(
    router.definitions(withData(available), [fleetTool], []).length,
    129,
  );
  const pluginId = "x".repeat(129);
  const read = pair("zenx_plugin", "receipt", {
    arguments: { operation: "read", pluginId },
  });
  assert.equal(
    disclosedPluginIds([
      read[0]!,
      {
        ...(read[1] as Extract<CanonicalItem, { type: "tool_result" }>),
        contentType: PLUGIN_DISCLOSURE_CONTENT_TYPE,
        structuredContent: { version: 1, operation: "read", pluginId },
      },
    ]).size,
    0,
  );
});
