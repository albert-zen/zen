import assert from "node:assert/strict";
import test from "node:test";

import { ZenAppServer } from "../../../src/app-server.js";
import { RunCodeToolProvider } from "../../../src/code-runtime.js";
import type { CanonicalItem } from "../../../src/item.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  ModelTool,
} from "../../../src/model.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import { ShellToolExecutor, ToolEnvironment } from "../../../src/tool.js";
import { ZenXPluginCatalog } from "../src/main/capabilities/plugin-catalog.js";
import type {
  ZenXPluginCatalogState,
  ZenXCapabilityPackage,
  ZenXPluginManifestV2,
} from "../src/main/capabilities/types.js";
import {
  PluginDiscoveryProjection,
  PluginDiscoveryToolProvider,
} from "../src/main/plugin-discovery.js";
import {
  bundledPackageRegistration,
  CatalogPluginRuntimeLifecycle,
  PluginRuntimeSupervisor,
} from "../src/main/plugin-runtime.js";

const exactOutput = 'plugin bytes: sk-fixture\n<raw-json>{"x":1}</raw-json>';

test("ordinary discovery history progressively exposes one plugin and routes its exact result", async () => {
  const fixture = await fixtureEnvironment();
  const model = new DiscoveryFlowModel();
  const journal = new InMemoryThreadJournal();
  const server = appServer(model, fixture, journal);
  const thread = await server.startThread();

  await (
    await server.startTurn(thread.id, "use fixture")
  ).done;

  assert.deepEqual(model.toolNamesBySample, [
    ["shell", "zenx_plugin"],
    ["shell", "zenx_plugin"],
    ["shell", "zenx_plugin", "fixture_echo"],
    ["shell", "zenx_plugin", "fixture_echo"],
  ]);
  assert.deepEqual(model.toolsBySample[2]?.at(-1), {
    name: "fixture_echo",
    description: "Echo exact bytes",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  });
  assert.equal(fixture.invocations, 1);
  const snapshot = await server.readThread(thread.id);
  const results = snapshot.items.filter((item) => item.type === "tool_result");
  assert.equal(results.at(-1)?.output, exactOutput);
  assert.equal(results.at(-1)?.exitCode, 7);

  const discover = JSON.parse(results[0]!.output) as unknown;
  assert.deepEqual(discover, {
    operation: "discover",
    plugins: [
      {
        id: "fixture",
        name: "Fixture",
        description: "Fixture plugin",
        status: "enabled",
      },
    ],
  });
  const read = JSON.parse(results[1]!.output) as unknown;
  assert.deepEqual(read, {
    operation: "read",
    plugin: {
      id: "fixture",
      name: "Fixture",
      description: "Fixture plugin",
      status: "enabled",
      mainDocument: "Use fixture_echo for exact fixture bytes.",
      tools: [{ name: "fixture_echo", description: "Echo exact bytes" }],
    },
  });

  await fixture.close();
});

test("one discovery snapshot synchronizes direct schemas and the run_code SDK on the next sample", async () => {
  const fixture = await fixtureEnvironment({ runCode: true });
  const model = new DiscoveryPresentationModel();
  const journal = new InMemoryThreadJournal();
  const server = appServer(model, fixture, journal, "both");
  const thread = await server.startThread();

  await (
    await server.startTurn(thread.id, "read and use fixture")
  ).done;
  const beforeLifecycleChanges = await journal.read(thread.id);
  await fixture.registry.setEnabled("fixture", false);
  await (
    await server.startTurn(thread.id, "after disable")
  ).done;
  await fixture.registry.uninstall("fixture");
  await (
    await server.startTurn(thread.id, "after uninstall")
  ).done;

  assert.deepEqual(model.toolNamesBySample, [
    ["shell", "zenx_plugin", "run_code"],
    ["shell", "zenx_plugin", "fixture_echo", "run_code"],
    ["shell", "zenx_plugin", "fixture_echo", "run_code"],
    ["shell", "zenx_plugin", "run_code"],
    ["shell", "zenx_plugin", "run_code"],
  ]);
  assert.equal(model.runCodeDescriptions.length, 5);
  assert.doesNotMatch(model.runCodeDescriptions[0]!, /\n  fixture_echo\(/u);
  assert.match(model.runCodeDescriptions[1]!, /\n  fixture_echo\(args:/u);
  assert.match(model.runCodeDescriptions[2]!, /\n  fixture_echo\(args:/u);
  assert.doesNotMatch(model.runCodeDescriptions[3]!, /\n  fixture_echo\(/u);
  assert.doesNotMatch(model.runCodeDescriptions[4]!, /\n  fixture_echo\(/u);
  assert(
    model.runCodeDescriptions.every(
      (description) => !/\n  run_code\(|\n  "run_code"\(/u.test(description),
    ),
  );
  assert.equal(fixture.invocations, 1);
  const snapshot = await server.readThread(thread.id);
  const fixtureResult = snapshot.items.find(
    (item) => item.type === "tool_result" && item.callId === "invoke",
  );
  assert(fixtureResult?.type === "tool_result");
  assert.equal(fixtureResult.output, exactOutput);
  assert.deepEqual(
    (await journal.read(thread.id)).slice(0, beforeLifecycleChanges.length),
    beforeLifecycleChanges,
  );

  await fixture.close();
});

test("disclosure is rebuilt from journal history and current availability gates later samples", async () => {
  const fixture = await fixtureEnvironment();
  const journal = new InMemoryThreadJournal();
  const firstModel = new DiscoveryFlowModel();
  const firstServer = appServer(firstModel, fixture, journal);
  const thread = await firstServer.startThread();
  await (
    await firstServer.startTurn(thread.id, "read fixture")
  ).done;
  const before = await journal.read(thread.id);

  const resumedModel = new CaptureAndFinishModel();
  const resumedServer = appServer(resumedModel, fixture, journal);
  await (
    await resumedServer.startTurn(thread.id, "after restart")
  ).done;
  assert.deepEqual(resumedModel.toolNames, [
    "shell",
    "zenx_plugin",
    "fixture_echo",
  ]);

  await fixture.registry.setEnabled("fixture", false);
  assert.deepEqual(
    fixture.projection
      .definitions((await resumedServer.readThread(thread.id)).items)
      .map((tool) => tool.name),
    ["shell", "zenx_plugin"],
  );
  const discovery = await fixture.discovery.execute({
    callId: "discover-disabled",
    name: "zenx_plugin",
    arguments: { operation: "discover" },
    cwd: process.cwd(),
    signal: new AbortController().signal,
  });
  assert.deepEqual(JSON.parse(discovery.output), {
    operation: "discover",
    plugins: [],
  });
  await fixture.registry.uninstall("fixture");
  assert.deepEqual(
    fixture.projection
      .definitions((await resumedServer.readThread(thread.id)).items)
      .map((tool) => tool.name),
    ["shell", "zenx_plugin"],
  );
  assert.deepEqual(
    JSON.parse(
      (
        await fixture.discovery.execute({
          callId: "discover-uninstalled",
          name: "zenx_plugin",
          arguments: { operation: "discover" },
          cwd: process.cwd(),
          signal: new AbortController().signal,
        })
      ).output,
    ),
    { operation: "discover", plugins: [] },
  );
  assert.deepEqual(
    (await journal.read(thread.id)).slice(0, before.length),
    before,
  );

  await fixture.close();
});

test("reading one plugin never exposes another available plugin", async () => {
  const fixture = await fixtureEnvironment();
  await fixture.registry.install(
    {
      manifest: pluginManifest({
        id: "other",
        name: "Other",
        description: "Other plugin",
        mainDocument: "Use other_run.",
        toolName: "other_run",
        toolDescription: "Run other",
      }),
      invoke: async () => ({ output: "other", exitCode: 0 }),
    },
    "bundled",
  );
  const read = await fixture.discovery.execute({
    callId: "read-fixture",
    name: "zenx_plugin",
    arguments: { operation: "read", pluginId: "fixture" },
    cwd: process.cwd(),
    signal: new AbortController().signal,
  });
  const items = canonicalPair(
    { operation: "read", pluginId: "fixture" },
    read.exitCode,
    JSON.parse(read.output),
  );

  assert.deepEqual(
    fixture.projection.definitions(items).map((tool) => tool.name),
    ["shell", "zenx_plugin", "fixture_echo"],
  );
  await fixture.close();
});

test("malformed, failed, discover, and mismatched read history do not disclose", async () => {
  const fixture = await fixtureEnvironment();
  const base = canonicalPair({ operation: "discover" }, 0, {
    operation: "discover",
    plugins: [],
  });
  const malformed = canonicalPair({ operation: "read" }, 0, {
    operation: "read",
    plugin: { id: "fixture" },
  });
  const failed = canonicalPair({ operation: "read", pluginId: "fixture" }, 1, {
    operation: "read",
    plugin: { id: "fixture" },
  });
  const mismatched = canonicalPair(
    { operation: "read", pluginId: "other" },
    0,
    {
      operation: "read",
      plugin: {
        id: "fixture",
        name: "Fixture",
        description: "Fixture plugin",
        status: "enabled",
        mainDocument: "Use fixture_echo.",
        tools: [],
      },
    },
  );

  for (const items of [base, malformed, failed, mismatched]) {
    assert.deepEqual(
      fixture.projection.definitions(items).map((tool) => tool.name),
      ["shell", "zenx_plugin"],
    );
  }
  await fixture.close();
});

class DiscoveryFlowModel implements ModelAdapter {
  readonly provider = "discovery-flow";
  readonly toolNamesBySample: string[][] = [];
  readonly toolsBySample: ModelTool[][] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.toolsBySample.push(structuredClone(request.tools));
    this.toolNamesBySample.push(request.tools.map((tool) => tool.name));
    const latest = request.messages.at(-1);
    if (latest?.role !== "tool") {
      yield toolCall("discover", "zenx_plugin", { operation: "discover" });
      return;
    }
    const result = parseRecord(latest.text);
    if (result.operation === "discover") {
      yield toolCall("read", "zenx_plugin", {
        operation: "read",
        pluginId: "fixture",
      });
      return;
    }
    if (result.operation === "read") {
      yield toolCall("invoke", "fixture_echo", { value: exactOutput });
      return;
    }
    yield { type: "text_delta", delta: "done" };
  }
}

class CaptureAndFinishModel implements ModelAdapter {
  readonly provider = "discovery-flow";
  toolNames: string[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.toolNames = request.tools.map((tool) => tool.name);
    yield { type: "text_delta", delta: "resumed" };
  }
}

class DiscoveryPresentationModel implements ModelAdapter {
  readonly provider = "discovery-presentation";
  readonly toolNamesBySample: string[][] = [];
  readonly runCodeDescriptions: string[] = [];
  #sample = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.#sample += 1;
    this.toolNamesBySample.push(request.tools.map(({ name }) => name));
    const runCode = request.tools.find(({ name }) => name === "run_code");
    assert(runCode);
    this.runCodeDescriptions.push(runCode.description);
    if (this.#sample === 1) {
      yield toolCall("read", "zenx_plugin", {
        operation: "read",
        pluginId: "fixture",
      });
    } else if (this.#sample === 2) {
      yield toolCall("invoke", "fixture_echo", { value: exactOutput });
    } else {
      yield { type: "text_delta", delta: "done" };
    }
  }
}

async function fixtureEnvironment(options: { runCode?: boolean } = {}) {
  const environment = new ToolEnvironment({
    providers: [new ShellToolExecutor()],
  });
  const supervisor = new PluginRuntimeSupervisor(environment);
  const store: {
    configuration: ZenXPluginCatalogState;
    load(): Promise<ZenXPluginCatalogState>;
    save(configuration: ZenXPluginCatalogState): Promise<void>;
  } = {
    configuration: {
      disabled: [],
      uninstalled: [],
      packages: {},
    },
    async load() {
      return structuredClone(this.configuration);
    },
    async save(configuration: ZenXPluginCatalogState) {
      this.configuration = structuredClone(configuration);
    },
  };
  const registry = new ZenXPluginCatalog(store, {
    pluginRuntimeLifecycle: new CatalogPluginRuntimeLifecycle({
      supervisor,
      registrationFor: bundledPackageRegistration,
    }),
  });
  await registry.initialize();
  let invocations = 0;
  const capabilityPackage: ZenXCapabilityPackage = {
    manifest: fixtureManifest(),
    invoke: async () => {
      invocations += 1;
      return { output: exactOutput, exitCode: 7 };
    },
  };
  await registry.install(capabilityPackage, "bundled");
  const discovery = new PluginDiscoveryToolProvider(registry, environment);
  environment.registerProvider(discovery);
  if (options.runCode === true) {
    environment.registerProvider(new RunCodeToolProvider());
  }
  const projection = new PluginDiscoveryProjection(environment, registry);
  return {
    environment,
    registry,
    discovery,
    projection,
    get invocations() {
      return invocations;
    },
    close: async () => {
      await registry.close();
      await supervisor.close();
    },
  };
}

function appServer(
  model: ModelAdapter,
  fixture: Awaited<ReturnType<typeof fixtureEnvironment>>,
  journal: InMemoryThreadJournal,
  toolPresentation?: "direct" | "code" | "both",
): ZenAppServer {
  return new ZenAppServer({
    journal,
    runtime: new AgentRuntime({
      toolEnvironment: fixture.environment,
      toolDefinitionProjection: (items) =>
        fixture.projection.definitions(items),
      ...(toolPresentation === undefined ? {} : { toolPresentation }),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          { id: "fixture-model", isDefault: true },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: model.provider,
      modelId: "fixture-model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}

function fixtureManifest(): ZenXPluginManifestV2 {
  return pluginManifest({
    id: "fixture",
    name: "Fixture",
    description: "Fixture plugin",
    mainDocument: "Use fixture_echo for exact fixture bytes.",
    toolName: "fixture_echo",
    toolDescription: "Echo exact bytes",
  });
}

function pluginManifest(options: {
  id: string;
  name: string;
  description: string;
  mainDocument: string;
  toolName: string;
  toolDescription: string;
}): ZenXPluginManifestV2 {
  return {
    schemaVersion: 2,
    id: options.id,
    name: options.name,
    version: "1.0.0",
    description: options.description,
    compatibility: { zenx: ">=0.1.0 <0.2.0" },
    runtime: { type: "bundled", entry: options.id },
    mainDocument: options.mainDocument,
    provider: {
      id: `${options.id}-provider`,
      platforms: ["*"],
      interactionModes: ["background_safe"],
      capabilities: [`${options.id}.run`],
    },
    permissions: [],
    tools: [
      {
        name: options.toolName,
        description: options.toolDescription,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        permissions: [],
        interactionMode: "background_safe",
        capabilities: [`${options.id}.run`],
      },
    ],
  };
}

function canonicalPair(
  arguments_: Record<string, unknown>,
  exitCode: number,
  output: unknown,
): CanonicalItem[] {
  return [
    {
      id: "call-item",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "tool_call",
      callId: "call",
      modelResponseId: "response",
      name: "zenx_plugin",
      arguments: arguments_,
    },
    {
      id: "result-item",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-01-01T00:00:00.001Z",
      type: "tool_result",
      callId: "call",
      output: JSON.stringify(output),
      exitCode,
    },
  ];
}

function toolCall(
  callId: string,
  name: string,
  arguments_: Record<string, unknown>,
): ModelEvent {
  return { type: "tool_call", callId, name, arguments: arguments_ };
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  assert(
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
  );
  return parsed as Record<string, unknown>;
}
