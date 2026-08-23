import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalItem } from "../../../src/item.js";
import {
  createZenXHostToolEnvironment,
  ZenXHostToolExecutor,
} from "../src/main/capability-tool-executor.js";
import type { HostEvent } from "../src/main/host-messages.js";
import { shellPrintCommand } from "./fixtures/shell-command.js";

test("real ZenX host composition preserves builtin and capability provider identities", async () => {
  const events: HostEvent[] = [];
  const { capabilityProvider, toolEnvironment, toolDefinitionProjection } =
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

  assert.deepEqual(shell.provider, { kind: "builtin", id: "shell" });
  assert.deepEqual(capability.provider, {
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
  capabilityProvider.handleResult({
    type: "capability/result",
    invocationId: request.invocationId,
    output: "bounded",
    exitCode: 0,
  });
  assert.deepEqual(await execution, { output: "bounded", exitCode: 0 });
});

test("real ZenX child-host projection hides v2 schemas until canonical read history", () => {
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
  const executor = new ZenXHostToolExecutor({
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
    executor.definitions.map((definition) => definition.name),
    ["fixture_inspect"],
  );
  const execution = executor.execute({
    callId: "call-1",
    name: "fixture_inspect",
    arguments: { target: "one" },
    cwd: "/workspace",
    signal: new AbortController().signal,
  });
  const request = events.find((event) => event.type === "capability/invoke");
  assert.equal(request?.type, "capability/invoke");
  if (request?.type !== "capability/invoke") throw new Error("missing request");
  executor.handleResult({
    type: "capability/result",
    invocationId: request.invocationId,
    output: "bounded",
    exitCode: 0,
  });
  assert.deepEqual(await execution, { output: "bounded", exitCode: 0 });
});

test("propagates cancellation to the main-process provider", async () => {
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
