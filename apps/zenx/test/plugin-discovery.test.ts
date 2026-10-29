import assert from "node:assert/strict";
import test from "node:test";

import { ZenAppServer } from "../../../src/app-server.js";
import { RunCodeToolRuntime } from "../../../src/code-runtime.js";
import type { CanonicalItem } from "../../../src/item.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  ModelTool,
  ToolResultModelMessage,
} from "../../../src/model.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import {
  ShellToolRuntime,
  ToolEnvironment,
  type CompositeToolRuntime,
} from "../../../src/tool.js";
import { buildToolPresentation } from "../../../src/tool-presentation.js";
import { ZenXPluginCatalog } from "../src/main/capabilities/plugin-catalog.js";
import type {
  ZenXPluginCatalogState,
  ZenXCapabilityPackage,
  ZenXPluginManifestV2,
} from "../src/main/capabilities/types.js";
import {
  PluginDiscoveryProjection,
  PluginDiscoveryToolRuntime,
} from "../src/main/plugin-discovery.js";
import {
  bundledPackageRegistration,
  CatalogPluginRuntimeLifecycle,
  PluginRuntimeSupervisor,
} from "../src/main/plugin-runtime.js";

const exactOutput = 'plugin bytes: sk-fixture\n<raw-json>{"x":1}</raw-json>';

test("readiness reports lifecycle without granting, disclosing or invoking plugin tools", async () => {
  const fixture = await fixtureEnvironment();
  const inspect = async (pluginIds = ["fixture", "not-installed"]) =>
    JSON.parse(
      (
        await fixture.discovery.execute({
          callId: "readiness",
          name: "zenx_plugin",
          arguments: { operation: "readiness", pluginIds },
          cwd: process.cwd(),
          signal: new AbortController().signal,
        })
      ).output,
    );
  try {
    const first = await inspect();
    assert.deepEqual(first.plugins, [
      { pluginId: "fixture", name: "Fixture", state: "ready", action: "none" },
      {
        pluginId: "not-installed",
        name: "not-installed",
        state: "missing",
        action: "install",
      },
    ]);
    assert.match(first.permissionChecks, /does not mean approved/);
    assert.equal(fixture.invocations, 0);
    assert.deepEqual(
      fixture.projection.definitions([]).map((tool) => tool.name),
      ["wait", "shell", "zenx_plugin"],
    );
    await fixture.registry.setEnabled("fixture", false);
    const before = fixture.registry.pluginSnapshot();
    assert.equal((await inspect()).plugins[0].state, "disabled");
    assert.deepEqual(fixture.registry.pluginSnapshot(), before);
    await fixture.registry.uninstall("fixture");
    assert.equal((await inspect()).plugins[0].state, "missing");
    await assert.rejects(inspect(["../../secrets"]), /valid plugin IDs/);
    await assert.rejects(inspect([]), /valid plugin IDs/);
  } finally {
    await fixture.close();
  }
});

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
    ["wait", "shell", "zenx_plugin"],
    ["wait", "shell", "zenx_plugin"],
    ["wait", "shell", "zenx_plugin", "fixture_echo"],
    ["wait", "shell", "zenx_plugin", "fixture_echo"],
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
  assert.equal(snapshot.turns[0]?.status, "completed");
  assert.equal(
    snapshot.items.some((item) => item.type === "failure"),
    false,
  );
  assert.equal(
    snapshot.items.filter((item) => item.type === "turn_started").length,
    1,
  );
  assert.equal(
    snapshot.items.filter(
      (item) => item.type === "tool_call" && item.callId === "invoke",
    ).length,
    1,
  );
  assert.equal(
    snapshot.items.findLast((item) => item.type === "agent_message")?.text,
    "done",
  );
  const results = snapshot.items.filter((item) => item.type === "tool_result");
  assert.equal(results.at(-1)?.output, exactOutput);
  assert.equal(results.at(-1)?.exitCode, 7);

  const discover = discoveryPayload(results[0]!.output);
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
  const read = discoveryPayload(results[1]!.output);
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

test("discovery guidance reaches every presentation and read changes visibility, not registrations", async (t) => {
  const fixture = await fixtureEnvironment({ runCode: true });
  t.after(() => fixture.close());
  const registrations = fixture.environment.definitionEntries;
  const catalog = fixture.registry.pluginSnapshot();
  assert(
    registrations.some((entry) => entry.definition.name === "fixture_echo"),
  );
  const initial = fixture.projection.definitions([]);
  assert(!initial.some((tool) => tool.name === "fixture_echo"));

  for (const mode of ["direct", "code", "both"] as const) {
    const presentation = buildToolPresentation(initial, mode);
    const descriptions = presentation.modelTools
      .map((tool) => tool.description)
      .join("\n");
    assert.match(descriptions, /successful read.*next model request/u);
    assert.match(
      descriptions,
      /direct tool definitions.*tools\.\*.*run_code SDK/u,
    );
    assert.match(
      descriptions,
      /Finish the current run_code program before invoking/u,
    );
    assert.match(
      descriptions,
      /discover\/readiness alone do not expose tools/u,
    );
    assert.match(descriptions, /does not install or enable plugins/u);
    assert.match(descriptions, /not necessarily read-only/u);
    assert.match(descriptions, /current permissions\/approvals/u);
  }

  const read = await fixture.discovery.execute({
    callId: "read",
    name: "zenx_plugin",
    arguments: { operation: "read", pluginId: "fixture" },
    cwd: process.cwd(),
    signal: new AbortController().signal,
  });
  discoveryPayload(read.output);
  assert.deepEqual(fixture.environment.definitionEntries, registrations);
  assert.deepEqual(fixture.registry.pluginSnapshot(), catalog);
  assert.equal(fixture.invocations, 0);
  // Returning text alone is not disclosure: the successful ordinary pair must commit.
  assert.deepEqual(fixture.projection.definitions([]), initial);
  const items = canonicalPair(
    { operation: "read", pluginId: "fixture" },
    read.exitCode,
    JSON.parse(read.output),
  );
  assert(
    fixture.projection
      .definitions(items)
      .some((tool) => tool.name === "fixture_echo"),
  );
});

test("code-only discovery keeps the current program frozen and refreshes SDK and catalog next sample", async (t) => {
  const codeCatalogs: string[][] = [];
  // Synthetic coordinator uses the production nested invocation/admission port;
  // it does not pretend to test JavaScript evaluation or a paid provider.
  const coordinator: CompositeToolRuntime = {
    name: "run_code",
    specification: {
      name: "run_code",
      description: "Synthetic code coordinator",
      inputSchema: { type: "object" },
    },
    async execute() {
      throw new Error("composite entry required");
    },
    async executeComposite(invocation, nested) {
      const names = nested.codeContext!.tools.map((tool) => tool.name);
      codeCatalogs.push(names);
      if (invocation.arguments.code === "// read fixture") {
        assert(!names.includes("fixture_echo"));
        const read = await nested.invoke("zenx_plugin", {
          operation: "read",
          pluginId: "fixture",
        });
        assert.equal(read.exitCode, 0);
        discoveryPayload(read.output);
        const premature = await nested.invoke("fixture_echo", {
          value: exactOutput,
        });
        assert.notEqual(premature.exitCode, 0);
        assert.match(premature.output, /not available in this model sample/u);
        assert(
          !nested.codeContext!.tools.some(
            (tool) => tool.name === "fixture_echo",
          ),
        );
        return read;
      }
      assert(names.includes("fixture_echo"));
      return await nested.invoke("fixture_echo", { value: exactOutput });
    },
  };
  const fixture = await fixtureEnvironment({ runCode: coordinator });
  t.after(() => fixture.close());
  const samples: ModelRequest[] = [];
  const model: ModelAdapter = {
    provider: "code-discovery-fixture",
    async *stream(request) {
      samples.push(request);
      assert.deepEqual(
        request.tools.map((tool) => tool.name),
        ["run_code"],
      );
      const description = request.tools[0]!.description;
      assert.match(description, /successful read.*next model request/u);
      if (samples.length === 1) {
        assert.doesNotMatch(description, /\n  fixture_echo\(/u);
        yield toolCall("read-program", "run_code", { code: "// read fixture" });
      } else if (samples.length === 2) {
        assert.match(description, /\n  fixture_echo\(args:/u);
        yield toolCall("invoke-program", "run_code", {
          code: "// invoke fixture",
        });
      } else {
        yield { type: "text_delta", delta: "done" };
      }
    },
  };
  const server = appServer(model, fixture, new InMemoryThreadJournal(), "code");
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "read and invoke fixture")
  ).done;
  assert.equal(samples.length, 3);
  assert.deepEqual(codeCatalogs, [
    ["wait", "shell", "zenx_plugin"],
    ["wait", "shell", "zenx_plugin", "fixture_echo"],
  ]);
  assert.equal(fixture.invocations, 1);
  const snapshot = await server.readThread(thread.id);
  const readCall = snapshot.items.find(
    (item) => item.type === "tool_call" && item.name === "zenx_plugin",
  );
  assert(readCall?.type === "tool_call");
  assert.equal(readCall.parentCallId, "read-program");
  assert.equal(snapshot.turns[0]?.status, "completed");
});

for (const decision of ["accept", "decline"] as const) {
  test(`disclosed mutable plugin action still requires its own approval: ${decision}`, async (t) => {
    const fixture = await fixtureEnvironment();
    t.after(() => fixture.close());
    let value = "unchanged";
    await fixture.registry.install(
      {
        manifest: pluginManifest({
          id: "mutable",
          name: "Mutable",
          description: "Synthetic mutable plugin",
          mainDocument: "Use mutable_write to change fixture state.",
          toolName: "mutable_write",
          toolDescription: "Change fixture state",
        }),
        invoke: async (_name, invocation) => {
          value = String(invocation.arguments.value);
          return { output: value, exitCode: 0 };
        },
      },
      "bundled",
    );
    let sample = 0;
    const model: ModelAdapter = {
      provider: "mutable-discovery-fixture",
      async *stream(request) {
        sample += 1;
        if (sample === 1) {
          assert(!request.tools.some((tool) => tool.name === "mutable_write"));
          yield toolCall("read-mutable", "zenx_plugin", {
            operation: "read",
            pluginId: "mutable",
          });
        } else if (sample === 2) {
          assert(request.tools.some((tool) => tool.name === "mutable_write"));
          assert.equal(value, "unchanged");
          yield toolCall("write-mutable", "mutable_write", {
            value: "changed",
          });
        } else {
          yield { type: "text_delta", delta: "done" };
        }
      },
    };
    const server = appServer(
      model,
      fixture,
      new InMemoryThreadJournal(),
      "direct",
      "always",
    );
    const thread = await server.startThread();
    const approvals: string[] = [];
    await (
      await server.startTurn(thread.id, "update fixture state", {
        requestApproval: async (request) => {
          approvals.push(request.toolName!);
          return request.toolName === "zenx_plugin" ? "accept" : decision;
        },
      })
    ).done;
    assert.deepEqual(approvals, ["zenx_plugin", "mutable_write"]);
    assert.equal(value, decision === "accept" ? "changed" : "unchanged");
    const snapshot = await server.readThread(thread.id);
    const actionResult = snapshot.items.find(
      (item) => item.type === "tool_result" && item.callId === "write-mutable",
    );
    assert(actionResult?.type === "tool_result");
    assert.equal(actionResult.exitCode, decision === "accept" ? 0 : 126);
    assert.equal(
      actionResult.executionStatus,
      decision === "accept" ? "completed" : "declined",
    );
  });
}

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
    ["wait", "shell", "zenx_plugin", "run_code"],
    ["wait", "shell", "zenx_plugin", "fixture_echo", "run_code"],
    ["wait", "shell", "zenx_plugin", "fixture_echo", "run_code"],
    ["wait", "shell", "zenx_plugin", "run_code"],
    ["wait", "shell", "zenx_plugin", "run_code"],
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
    "wait",
    "shell",
    "zenx_plugin",
    "fixture_echo",
  ]);

  await fixture.registry.setEnabled("fixture", false);
  assert.deepEqual(
    fixture.projection
      .definitions((await resumedServer.readThread(thread.id)).items)
      .map((tool) => tool.name),
    ["wait", "shell", "zenx_plugin"],
  );
  const discovery = await fixture.discovery.execute({
    callId: "discover-disabled",
    name: "zenx_plugin",
    arguments: { operation: "discover" },
    cwd: process.cwd(),
    signal: new AbortController().signal,
  });
  assert.deepEqual(discoveryPayload(discovery.output), {
    operation: "discover",
    plugins: [],
  });
  await fixture.registry.uninstall("fixture");
  assert.deepEqual(
    fixture.projection
      .definitions((await resumedServer.readThread(thread.id)).items)
      .map((tool) => tool.name),
    ["wait", "shell", "zenx_plugin"],
  );
  assert.deepEqual(
    discoveryPayload(
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
    ["wait", "shell", "zenx_plugin", "fixture_echo"],
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
      ["wait", "shell", "zenx_plugin"],
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
    if (latest.callId === "invoke") {
      assert.equal(semanticToolOutput(latest), exactOutput);
      assert.equal(latest.exitCode, 7);
      yield { type: "text_delta", delta: "done" };
      return;
    }
    assert(["discover", "read"].includes(latest.callId));
    const result = parseRecord(semanticToolOutput(latest));
    assert.equal(result.operation, latest.callId);
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

async function fixtureEnvironment(
  options: { runCode?: boolean | CompositeToolRuntime } = {},
) {
  const environment = new ToolEnvironment({
    bundles: [
      {
        identity: { kind: "builtin", id: "shell" },
        tools: [new ShellToolRuntime()],
      },
    ],
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
  const discovery = new PluginDiscoveryToolRuntime(registry, environment);
  environment.registerBundle({
    identity: { kind: "builtin", id: "zenx-plugin-discovery" },
    tools: [discovery],
  });
  if (options.runCode) {
    environment.registerBundle({
      identity: { kind: "builtin", id: "run-code" },
      tools: [
        options.runCode === true ? new RunCodeToolRuntime() : options.runCode,
      ],
    });
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
  approvalPolicy: "always" | "never" = "never",
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
          { id: "fixture-model", contextWindow: 32_768, isDefault: true },
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
      approvalPolicy,
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

function semanticToolOutput(message: ToolResultModelMessage): string {
  const prefix =
    message.exitCode === null
      ? "Outcome: unknown\n"
      : `Exit code: ${message.exitCode}\n`;
  assert(
    message.text.startsWith(prefix),
    "Expected the compiler's exact tool outcome prefix",
  );
  return message.text.slice(prefix.length);
}

test("discovery fixture reads exact semantic tool body without parsing its outcome prefix as JSON", () => {
  const body = '{"operation":"read","literal":"Exit code: 7"}';
  assert.equal(
    semanticToolOutput({
      role: "tool",
      callId: "fixture",
      exitCode: 7,
      text: `Exit code: 7\n${body}`,
    }),
    body,
  );
  assert.throws(() =>
    semanticToolOutput({
      role: "tool",
      callId: "fixture",
      exitCode: 7,
      text: `Exit code: 0\n${body}`,
    }),
  );
});

/** Check the model-visible workflow without coupling assertions to exact prose. */
function discoveryPayload(output: string): Record<string, unknown> {
  const { nextStep, permissionChecks, ...payload } = parseRecord(output);
  assert.equal(typeof nextStep, "string");
  assert.match(nextStep as string, /next model request/u);
  if (payload.operation === "discover") {
    assert.equal(permissionChecks, undefined);
    assert.match(nextStep as string, /operation: "read".*exact pluginId/u);
    assert.match(nextStep as string, /Discover alone does not expose/u);
  } else {
    assert.equal(typeof permissionChecks, "string");
    assert.match(permissionChecks as string, /Disclosure is not approval/u);
    assert.match(permissionChecks as string, /may inspect or change state/u);
    assert.match(
      nextStep as string,
      /direct tool definitions.*tools\.\*.*run_code SDK/u,
    );
    assert.match(nextStep as string, /finish that program first/u);
    assert.match(nextStep as string, /does not install or enable plugins/u);
  }
  return payload;
}
