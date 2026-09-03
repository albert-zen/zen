import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalItem } from "../../../src/item.js";
import { ToolOutputSpool } from "../../../src/tool-output-spool.js";
import {
  createZenXHostToolEnvironment,
  ZenXHostToolBundle,
} from "../src/main/capability-tool-executor.js";
import type { HostEvent } from "../src/main/host-messages.js";
import { shellPrintCommand } from "./fixtures/shell-command.js";

test("real ZenX host composition preserves builtin and capability bundle identities", async (t) => {
  const toolOutputSpool = new ToolOutputSpool();
  t.after(async () => await toolOutputSpool.close());
  const events: HostEvent[] = [];
  const { capabilityBundle, toolEnvironment, toolDefinitionProjection } =
    createZenXHostToolEnvironment({
      capabilities: {
        definitions: [
          {
            name: "fixture_inspect",
            description: "Inspect",
            inputSchema: { type: "object" },
          },
        ],
      },
      send: (event) => events.push(event),
      toolOutputSpool,
    });
  assert.deepEqual(
    toolDefinitionProjection([]).map((definition) => definition.name),
    ["shell", "fixture_inspect", "zenx_plugin"],
  );
  const signal = new AbortController().signal;
  const shell = toolEnvironment.prepare({
    callId: "shell-call",
    name: "shell",
    arguments: { command: shellPrintCommand("builtin-route") },
    cwd: process.cwd(),
    signal,
  });
  const capability = toolEnvironment.prepare({
    callId: "capability-call",
    name: "fixture_inspect",
    arguments: { target: "one" },
    cwd: process.cwd(),
    signal,
  });

  assert.deepEqual(shell.owner, { kind: "builtin", id: "shell" });
  assert.deepEqual(capability.owner, {
    kind: "external",
    id: "zenx-capability-host",
  });
  assert.equal(
    await toolEnvironment.execute(shell).then((result) => result.output),
    "builtin-route",
  );
  assert.equal(events.length, 0);

  const execution = toolEnvironment.execute(capability);
  const request = events.find((event) => event.type === "capability/invoke");
  assert.equal(request?.type, "capability/invoke");
  if (request?.type !== "capability/invoke") throw new Error("missing request");
  capabilityBundle.handleResult({
    type: "capability/result",
    invocationId: request.invocationId,
    generationToken: request.generationToken,
    output: "bounded",
    exitCode: 0,
    sourceTruncated: true,
  });
  assert.deepEqual(await execution, {
    output: "bounded",
    exitCode: 0,
    sourceTruncated: true,
  });
});

test("real ZenX child-host projection hides v2 schemas until canonical read history", (t) => {
  const toolOutputSpool = new ToolOutputSpool();
  t.after(async () => await toolOutputSpool.close());
  const pluginTool = {
    name: "fixture_echo",
    description: "Echo exact bytes",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  };
  const { toolDefinitionProjection } = createZenXHostToolEnvironment({
    capabilities: {
      definitions: [pluginTool],
      plugins: [
        {
          id: "fixture",
          name: "Fixture",
          description: "Desktop fixture plugin",
          status: "enabled",
          mainDocument: "Use fixture_echo for exact desktop fixture bytes.",
          tools: [pluginTool],
        },
      ],
    },
    send: () => undefined,
    toolOutputSpool,
  });

  const initial = toolDefinitionProjection([]);
  assert.deepEqual(
    initial.map((tool) => tool.name),
    ["shell", "zenx_plugin"],
  );
  assert.deepEqual(initial.at(-1), {
    name: "zenx_plugin",
    description:
      "Discover available ZenX plugins or read one plugin's main document and tool index.",
    inputSchema: {
      oneOf: [
        {
          type: "object",
          properties: { operation: { const: "discover" } },
          required: ["operation"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            operation: { const: "read" },
            pluginId: { type: "string" },
          },
          required: ["operation", "pluginId"],
          additionalProperties: false,
        },
      ],
    },
  });

  const items = canonicalReadPair({
    operation: "read",
    plugin: {
      id: "fixture",
      name: "Fixture",
      description: "Desktop fixture plugin",
      status: "enabled",
      mainDocument: "Use fixture_echo for exact desktop fixture bytes.",
      tools: [{ name: "fixture_echo", description: "Echo exact bytes" }],
    },
  });
  assert.deepEqual(toolDefinitionProjection(items), [...initial, pluginTool]);
});

test("exposes capability definitions and resolves main-process execution", async () => {
  const events: HostEvent[] = [];
  const bundle = new ZenXHostToolBundle({
    capabilities: {
      definitions: [
        {
          name: "fixture_inspect",
          description: "Inspect",
          inputSchema: { type: "object" },
        },
      ],
    },
    send: (event) => events.push(event),
  });
  assert.deepEqual(
    bundle.tools.map((runtime) => runtime.name),
    ["fixture_inspect"],
  );
  const execution = bundle.tools[0]!.execute({
    callId: "call-1",
    name: "fixture_inspect",
    arguments: { target: "one" },
    cwd: "/workspace",
    signal: new AbortController().signal,
  });
  const request = events.find((event) => event.type === "capability/invoke");
  assert.equal(request?.type, "capability/invoke");
  if (request?.type !== "capability/invoke") throw new Error("missing request");
  bundle.handleResult({
    type: "capability/result",
    invocationId: request.invocationId,
    generationToken: request.generationToken,
    output: "bounded",
    exitCode: 0,
  });
  assert.deepEqual(await execution, { output: "bounded", exitCode: 0 });
});

test("propagates cancellation to the main-process provider", async (t) => {
  const toolOutputSpool = new ToolOutputSpool();
  t.after(async () => await toolOutputSpool.close());
  const events: HostEvent[] = [];
  const { toolEnvironment } = createZenXHostToolEnvironment({
    capabilities: {
      definitions: [
        {
          name: "fixture_wait",
          description: "Wait",
          inputSchema: { type: "object" },
        },
      ],
    },
    send: (event) => events.push(event),
    toolOutputSpool,
  });
  const controller = new AbortController();
  const prepared = toolEnvironment.prepare({
    callId: "call-2",
    name: "fixture_wait",
    arguments: {},
    cwd: "/workspace",
    signal: controller.signal,
  });
  const execution = toolEnvironment.execute(prepared);
  controller.abort(new DOMException("stop", "AbortError"));
  await assert.rejects(execution, /stop/u);
  assert.equal(events.at(-1)?.type, "capability/cancel");
});

test("replaces one target projection while an invocation from another plugin remains active", async (t) => {
  const toolOutputSpool = new ToolOutputSpool();
  t.after(async () => await toolOutputSpool.close());
  const events: HostEvent[] = [];
  const neighbor = tool("neighbor_wait", "Neighbor wait");
  const targetOne = tool("target_echo", "Target one");
  const targetTwo = tool("target_echo", "Target two");
  const composition = createZenXHostToolEnvironment({
    capabilities: {
      definitions: [neighbor, targetOne],
      plugins: [plugin("neighbor", neighbor), plugin("fixture", targetOne)],
    },
    send: (event) => events.push(event),
    toolOutputSpool,
  });
  const preparedNeighbor = composition.toolEnvironment.prepare({
    callId: "neighbor-active",
    name: neighbor.name,
    arguments: {},
    cwd: "/workspace",
    signal: new AbortController().signal,
  });
  const activeNeighbor = composition.toolEnvironment.execute(preparedNeighbor);
  const neighborRequest = events.find(
    (event) => event.type === "capability/invoke",
  );
  assert.equal(neighborRequest?.type, "capability/invoke");
  if (neighborRequest?.type !== "capability/invoke") {
    throw new Error("missing neighbor request");
  }

  composition.replaceCapabilities({
    definitions: [neighbor, targetTwo],
    plugins: [plugin("neighbor", neighbor), plugin("fixture", targetTwo)],
  });
  assert.equal(
    composition
      .toolDefinitionProjection(
        canonicalReadPair({
          operation: "read",
          plugin: plugin("fixture", targetTwo),
        }),
      )
      .find((definition) => definition.name === "target_echo")?.description,
    "Target two",
  );
  composition.capabilityBundle.handleResult({
    type: "capability/result",
    invocationId: neighborRequest.invocationId,
    generationToken: neighborRequest.generationToken,
    output: "neighbor-completed",
    exitCode: 0,
  });
  assert.equal((await activeNeighbor).output, "neighbor-completed");
});

test("prepared child calls keep their exact capability generation through consecutive replacements", async (t) => {
  const toolOutputSpool = new ToolOutputSpool();
  t.after(async () => await toolOutputSpool.close());
  const events: HostEvent[] = [];
  const versioned = (generationToken: string, description: string) => ({
    generationToken,
    definitions: [tool("fixture_echo", description)],
  });
  const composition = createZenXHostToolEnvironment({
    capabilities: versioned("generation-v1", "Version one"),
    send: (event) => events.push(event),
    toolOutputSpool,
  });
  const prepare = (callId: string) =>
    composition.toolEnvironment.prepare({
      callId,
      name: "fixture_echo",
      arguments: {},
      cwd: "/workspace",
      signal: new AbortController().signal,
    });
  const v1 = prepare("v1-call");
  composition.replaceCapabilities(versioned("generation-v2", "Version two"));
  const v2 = prepare("v2-call");
  composition.replaceCapabilities(versioned("generation-v3", "Version three"));
  await Promise.resolve();
  assert.deepEqual(
    events.filter((event) => event.type === "capabilities/released"),
    [],
  );

  const v1Execution = composition.toolEnvironment.execute(v1);
  const v1Invocation = events.find(
    (event) =>
      event.type === "capability/invoke" &&
      event.invocation.callId === "v1-call",
  );
  assert.equal(v1Invocation?.type, "capability/invoke");
  if (v1Invocation?.type !== "capability/invoke")
    throw new Error("missing v1 invocation");
  assert.equal(v1Invocation.generationToken, "generation-v1");
  composition.capabilityBundle.handleResult({
    type: "capability/result",
    invocationId: v1Invocation.invocationId,
    generationToken: "generation-v1",
    output: "v1",
    exitCode: 0,
  });
  assert.equal((await v1Execution).output, "v1");
  await Promise.resolve();
  assert.equal(
    events.some(
      (event) =>
        event.type === "capabilities/released" &&
        event.generationToken === "generation-v1",
    ),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === "capabilities/released" &&
        event.generationToken === "generation-v2",
    ),
    false,
  );

  const v2Execution = composition.toolEnvironment.execute(v2);
  const v2Invocation = events.find(
    (event) =>
      event.type === "capability/invoke" &&
      event.invocation.callId === "v2-call",
  );
  assert.equal(v2Invocation?.type, "capability/invoke");
  if (v2Invocation?.type !== "capability/invoke")
    throw new Error("missing v2 invocation");
  assert.equal(v2Invocation.generationToken, "generation-v2");
  composition.capabilityBundle.handleResult({
    type: "capability/result",
    invocationId: v2Invocation.invocationId,
    generationToken: "generation-v2",
    output: "v2",
    exitCode: 0,
  });
  assert.equal((await v2Execution).output, "v2");
  await Promise.resolve();
  assert.equal(
    events.some(
      (event) =>
        event.type === "capabilities/released" &&
        event.generationToken === "generation-v2",
    ),
    true,
  );
  await composition.close();
});

function tool(name: string, description: string) {
  return { name, description, inputSchema: { type: "object" } };
}

function plugin(id: string, pluginTool: ReturnType<typeof tool>) {
  return {
    id,
    name: id,
    description: `${id} plugin`,
    status: "enabled" as const,
    mainDocument: `${id} main document`,
    tools: [pluginTool],
  };
}

function canonicalReadPair(result: unknown): CanonicalItem[] {
  const common = {
    threadId: "thread",
    turnId: "turn",
    createdAt: "2026-08-24T00:00:00.000Z",
  };
  return [
    {
      ...common,
      id: "call-item",
      type: "tool_call",
      callId: "read-fixture",
      name: "zenx_plugin",
      arguments: { operation: "read", pluginId: "fixture" },
    },
    {
      ...common,
      id: "result-item",
      type: "tool_result",
      callId: "read-fixture",
      output: JSON.stringify(result),
      exitCode: 0,
    },
  ];
}
