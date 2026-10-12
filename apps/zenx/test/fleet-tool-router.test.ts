import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CanonicalItem } from "../../../src/item.js";
import { ToolEnvironment, type ToolInvocation } from "../../../src/tool.js";
import { TOOL_TASK_CONTENT_TYPE } from "../../../src/tool-task-content.js";
import type { ModelTool } from "../../../src/model.js";
import type {
  RemoteToolCatalogResult,
  RemoteToolResult,
} from "../../../src/protocol/native/remote-tool-wire.js";
import { NativeFleetRejectedError } from "../src/main/fleet-native.js";
import { fleetDeviceKey, type NativeFleetDevice } from "../src/main/fleet.js";
import {
  FleetToolTargetRouter,
  FleetToolTransportAdapter,
} from "../src/main/fleet-tool-router.js";
import { createZenXHostToolEnvironment } from "../src/main/capability-tool-executor.js";
import { ToolOutputSpool } from "../../../src/tool-output-spool.js";

const device: NativeFleetDevice = {
  id: "remote",
  label: "Remote",
  transport: "https",
  endpoint: "https://example.test",
  hostId: "target-host",
  access: "control",
  toolsEnabled: true,
};
const definition: ModelTool = {
  name: "ordinary",
  description: "ordinary remote",
  inputSchema: {
    type: "object",
    properties: { value: { type: "integer" } },
    required: ["value"],
    additionalProperties: false,
  },
};
const catalog: RemoteToolCatalogResult = {
  version: 1,
  hostId: device.hostId,
  processEpoch: "target-epoch",
  tools: [
    {
      owner: { kind: "plugin", id: "ordinary" },
      definition,
      generation: "target-generation",
      eligible: true,
    },
    {
      owner: { kind: "builtin", id: "run-code" },
      definition: { ...definition, name: "run_code" },
      generation: "code-generation",
      eligible: false,
      reason: "composite",
    },
  ],
};
const signal = () => new AbortController().signal;
const invocation = (
  name: string,
  arguments_: Record<string, unknown>,
  threadId = "source",
): ToolInvocation => ({
  name,
  arguments: arguments_,
  callId: "model-call",
  canonicalToolCallId: "canonical-call",
  threadId,
  cwd: "/caller",
  signal: signal(),
});
const result = (
  admissionId: string,
  cursor = "cursor-1",
  output = "target output",
  status: RemoteToolResult["status"] = "running",
): RemoteToolResult => ({
  origin: {
    hostId: device.hostId,
    processEpoch: catalog.processEpoch,
    workspaceId: "workspace",
    threadId: "target-thread",
    toolName: "ordinary",
    toolGeneration: "target-generation",
  },
  admissionId,
  taskId: "target-task",
  status,
  cursor,
  output,
  exitCode: 0,
  sourceTruncated: false,
  paths: "remote-host",
  contentType: "ordinary/value",
  structuredContent: { path: "/target/result.txt" },
});

async function fixture(
  t: import("node:test").TestContext,
  overrides: Partial<
    ConstructorParameters<typeof FleetToolTransportAdapter>[0]["native"]
  > = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fleet-router-"));
  const file = path.join(directory, "fleet.json");
  await writeFile(file, JSON.stringify({ version: 1, devices: [device] }));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = {
    catalog: async () => structuredClone(catalog),
    execute: async (
      _device: NativeFleetDevice,
      request: Parameters<
        ConstructorParameters<
          typeof FleetToolTransportAdapter
        >[0]["native"]["execute"]
      >[1],
    ) => result(request.admissionId),
    wait: async (
      _device: NativeFleetDevice,
      request: Parameters<
        ConstructorParameters<
          typeof FleetToolTransportAdapter
        >[0]["native"]["wait"]
      >[1],
    ) => result(request.admissionId, "cursor-2", "next output", "completed"),
    status: async (
      _device: NativeFleetDevice,
      request: Parameters<
        ConstructorParameters<
          typeof FleetToolTransportAdapter
        >[0]["native"]["status"]
      >[1],
    ) => ({
      origin: result(request.admissionId).origin,
      admissionId: request.admissionId,
      taskId: "target-task",
      status: "running" as const,
      cursor: "cursor-1",
      outputAvailable: true,
      expiresAtMs: Date.now() + 300000,
    }),
    ...overrides,
  };
  return {
    adapter: new FleetToolTransportAdapter({ file, native }, () => {}),
    file,
  };
}
const executeArguments = {
  device: "remote",
  deviceKey: fleetDeviceKey(device),
  workspace: "workspace",
  targetThreadId: "target-thread",
  processEpoch: "target-epoch",
  toolGeneration: "target-generation",
  name: "ordinary",
  arguments: { value: 7 },
};

function handle(
  value: import("../../../src/tool.js").ToolExecutionResult,
): string {
  assert.equal(value.contentType, TOOL_TASK_CONTENT_TYPE);
  return String((value.structuredContent as { task_id: string }).task_id);
}

test("Host adapter preserves target origin and cursor ACK in the canonical task handle", async (t) => {
  let observed:
    | Parameters<
        ConstructorParameters<
          typeof FleetToolTransportAdapter
        >[0]["native"]["wait"]
      >[1]
    | undefined;
  const { adapter } = await fixture(t, {
    wait: async (_device, request) => {
      observed = request;
      return result(request.admissionId, "cursor-2", "delta", "completed");
    },
  });
  const initial = await adapter.invoke(
    invocation("zenx_fleet_execute", executeArguments),
  );
  assert.match(initial.output, /host: target-host/);
  assert.match(initial.output, /paths: remote-host/);
  assert.equal(
    (initial.structuredContent as { result: { path: string } }).result.path,
    "/target/result.txt",
  );
  const terminal = await adapter.invoke(
    invocation("wait", { task_id: handle(initial), terminate: true }),
  );
  assert.equal(observed?.ackCursor, "cursor-1");
  assert.equal(observed?.terminate, true);
  assert.equal(observed?.processEpoch, "target-epoch");
  assert.match(terminal.output, /delta/);
  assert.notEqual(handle(terminal), handle(initial));
});

test("qualified handles reject other source Threads and changed target configuration", async (t) => {
  const { adapter, file } = await fixture(t);
  const task = handle(
    await adapter.invoke(invocation("zenx_fleet_execute", executeArguments)),
  );
  await assert.rejects(
    adapter.invoke(invocation("wait", { task_id: task }, "other-source")),
    /another source Thread/,
  );
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      devices: [{ ...device, hostId: "other-host" }],
    }),
  );
  await assert.rejects(
    adapter.invoke(invocation("wait", { task_id: task })),
    /configuration changed/,
  );
});

test("lost execute response returns exact observation address and never auto-replays mutation", async (t) => {
  let executes = 0;
  let statuses = 0;
  const { adapter } = await fixture(t, {
    execute: async () => {
      executes++;
      throw new Error("socket lost");
    },
    status: async (_device, request) => {
      statuses++;
      return {
        origin: result(request.admissionId).origin,
        admissionId: request.admissionId,
        taskId: "target-task",
        status: "running",
        cursor: "cursor-1",
        outputAvailable: true,
        expiresAtMs: Date.now() + 300000,
      };
    },
  });
  let task = "";
  await assert.rejects(
    adapter.invoke(invocation("zenx_fleet_execute", executeArguments)),
    (error: Error) => {
      assert.match(error.message, /unconfirmed/);
      task = error.message.split("task_id: ")[1]!;
      return true;
    },
  );
  await adapter.invoke(invocation("zenx_fleet_tool_status", { task_id: task }));
  await adapter.invoke(invocation("wait", { task_id: task }));
  assert.equal(executes, 1);
  assert.equal(statuses, 2);
});

test("confirmed target denial stays a denial instead of an unknown mutation", async (t) => {
  const { adapter } = await fixture(t, {
    execute: async () => {
      throw new NativeFleetRejectedError("operation_forbidden");
    },
  });
  await assert.rejects(
    adapter.invoke(invocation("zenx_fleet_execute", executeArguments)),
    (error) =>
      error instanceof NativeFleetRejectedError &&
      error.code === "operation_forbidden",
  );
});

test("lazy target proxy uses exact remote-only schema and excludes ineligible entries", async (t) => {
  const { adapter } = await fixture(t);
  const catalogResult = await adapter.invoke(
    invocation("zenx_fleet_tools", {
      device: "remote",
      workspace: "workspace",
      targetThreadId: "target-thread",
    }),
  );
  const router = new FleetToolTargetRouter((value) => adapter.invoke(value));
  const fleetTool = {
    name: "zenx_fleet_tools",
    description: "catalog",
    inputSchema: { type: "object" },
  };
  const items: CanonicalItem[] = [
    {
      type: "tool_call",
      id: "call-item",
      createdAt: "2026-10-05T00:00:00Z",
      threadId: "source",
      turnId: "turn",
      callId: "catalog-call",
      name: "zenx_fleet_tools",
      arguments: {},
    },
    {
      type: "tool_result",
      id: "result-item",
      createdAt: "2026-10-05T00:00:01Z",
      threadId: "source",
      turnId: "turn",
      callId: "catalog-call",
      ...catalogResult,
    },
  ];
  assert.equal(router.definitions([], [fleetTool], []).length, 1);
  const projected = router.definitions(items, [fleetTool], []);
  assert.equal(projected.length, 2);
  const proxy = projected[1]!;
  assert.deepEqual(proxy.inputSchema.properties, {
    arguments: definition.inputSchema,
  });
  const caller = new ToolEnvironment({ targetRouter: router });
  t.after(() => caller.close());
  router.definitions(
    [
      {
        type: "user_message",
        id: "other-user",
        threadId: "other-source",
        turnId: "other-turn",
        createdAt: "2026-10-05T00:00:02Z",
        text: "other concurrent Thread",
      },
    ],
    [fleetTool],
    [],
  );
  const prepared = caller.prepare(
    invocation(proxy.name, { arguments: { value: 7 } }),
  );
  const receipt = await caller.execute(prepared);
  assert.equal(caller.taskManager.activeTaskCount, 0);
  assert.match(receipt.output, /target-host/);
  assert.equal(
    JSON.parse(catalogResult.output).deviceKey,
    fleetDeviceKey(device),
  );
});

test("Host child IPC marks target transport and creates no local facade execution task", async (t) => {
  const { adapter } = await fixture(t);
  const spool = new ToolOutputSpool();
  const fleetTool: ModelTool = {
    name: "zenx_fleet_execute",
    description: "execute",
    inputSchema: { type: "object", properties: { device: { type: "string" } } },
  };
  let composition: ReturnType<typeof createZenXHostToolEnvironment>;
  composition = createZenXHostToolEnvironment({
    capabilities: { definitions: [fleetTool] },
    toolOutputSpool: spool,
    send: (event) => {
      if (event.type !== "capability/invoke") return;
      assert.equal(event.targetRoute, true);
      void adapter
        .invoke({ ...event.invocation, signal: signal() })
        .then((value) => {
          composition.capabilityBundle.handleResult({
            type: "capability/result",
            invocationId: event.invocationId,
            generationToken: event.generationToken,
            ...value,
          });
        });
    },
  });
  t.after(async () => {
    await composition.close();
    await spool.close();
  });
  const prepared = composition.toolEnvironment.prepare(
    invocation("zenx_fleet_execute", executeArguments),
  );
  const value = await composition.toolEnvironment.execute(prepared);
  assert.equal(composition.toolEnvironment.taskManager.activeTaskCount, 0);
  assert.equal(
    (value.structuredContent as { status: string }).status,
    "running",
  );
});

test("execute rejects a changed discovery route before making a request", async (t) => {
  let sent = 0;
  const { adapter, file } = await fixture(t, {
    execute: async (_device, request) => {
      sent++;
      return result(request.admissionId);
    },
  });
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      devices: [{ ...device, endpoint: "https://changed.example.test" }],
    }),
  );
  await assert.rejects(
    adapter.invoke(invocation("zenx_fleet_execute", executeArguments)),
    /configuration changed since discovery/,
  );
  assert.equal(sent, 0);
});

test("program-side await observes the same target admission until completion", async (t) => {
  let executes = 0;
  let waits = 0;
  const { adapter } = await fixture(t, {
    execute: async (_device, request) => {
      executes++;
      return result(request.admissionId, "first", "initial");
    },
    wait: async (_device, request) => {
      waits++;
      assert.equal(request.ackCursor, "first");
      return result(request.admissionId, "last", " final", "completed");
    },
  });
  const value = await adapter.invoke({
    ...invocation("zenx_fleet_execute", executeArguments),
    task: { waitForCompletion: true },
  });
  assert.equal(executes, 1);
  assert.equal(waits, 1);
  assert.equal(
    (value.structuredContent as { status: string }).status,
    "completed",
  );
  assert.match(value.output, /initial final/);
});

test("unknown execute recovery preserves the original output ceiling", async (t) => {
  let outputCeiling = 0;
  const { adapter } = await fixture(t, {
    execute: async () => {
      throw new Error("lost execute response");
    },
    wait: async (_device, request) => {
      outputCeiling = request.maxOutputBytes;
      return result(
        request.admissionId,
        "recovered",
        "x".repeat(20000),
        "completed",
      );
    },
  });
  let task = "";
  await assert.rejects(
    adapter.invoke(
      invocation("zenx_fleet_execute", {
        ...executeArguments,
        max_output_bytes: 65536,
      }),
    ),
    (error: Error) => {
      task = error.message.split("task_id: ")[1]!;
      return true;
    },
  );
  const recovered = await adapter.invoke(invocation("wait", { task_id: task }));
  assert.equal(outputCeiling, 65536);
  assert.match(recovered.output, /x{20000}/);
});

test("program polling recovery reuses exact ACK observation bounds without executing again", async (t) => {
  let executes = 0;
  let waits = 0;
  const limits: Array<[number, number]> = [];
  const { adapter } = await fixture(t, {
    execute: async (_device, request) => {
      executes++;
      return result(request.admissionId, "prior", "initial");
    },
    wait: async (_device, request) => {
      waits++;
      limits.push([request.yieldTimeMs, request.maxOutputBytes]);
      assert.equal(request.ackCursor, "prior");
      if (waits === 1) throw new Error("lost destructive wait response");
      return result(request.admissionId, "replayed", "terminal", "completed");
    },
  });
  let task = "";
  await assert.rejects(
    adapter.invoke({
      ...invocation("zenx_fleet_execute", {
        ...executeArguments,
        max_output_bytes: 65536,
      }),
      task: { waitForCompletion: true },
    }),
    (error: Error) => {
      task = error.message.split("task_id: ")[1]!;
      return true;
    },
  );
  const recovered = await adapter.invoke(
    invocation("wait", { task_id: task, yield_time_ms: 1 }),
  );
  assert.deepEqual(limits, [
    [30000, 65536],
    [30000, 65536],
  ]);
  assert.equal(executes, 1);
  assert.equal(
    (recovered.structuredContent as { status: string }).status,
    "completed",
  );
});

test("Host-owned timing and preview controls reach the target transport", async (t) => {
  let controls: [number, number, number] | undefined;
  const { adapter } = await fixture(t, {
    execute: async (_device, request) => {
      controls = [
        request.yieldTimeMs,
        request.timeoutMs,
        request.maxOutputBytes,
      ];
      return result(request.admissionId, "complete", "done", "completed");
    },
  });
  await adapter.invoke({
    ...invocation("zenx_fleet_execute", executeArguments),
    task: { yieldTimeMs: 5, timeoutMs: 25, previewBytes: 1024 },
  });
  assert.deepEqual(controls, [5, 25, 1024]);
});
