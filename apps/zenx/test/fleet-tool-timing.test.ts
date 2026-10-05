import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHostedAppServer } from "../../cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import {
  ShellToolRuntime,
  ToolEnvironment,
  type ToolInvocation,
} from "../../../src/tool.js";
import {
  RemoteHostAccess,
  RemoteHostError,
} from "../../../src/protocol/native/remote-host.js";
import { FleetToolGateway } from "../../../src/protocol/native/remote-tools.js";
import { fleetDeviceKey, type NativeFleetDevice } from "../src/main/fleet.js";
import {
  FleetToolTargetRouter,
  FleetToolTransportAdapter,
} from "../src/main/fleet-tool-router.js";

async function fixture(t: import("node:test").TestContext) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "fleet-timing-"));
  const timings: NonNullable<ToolInvocation["task"]>[] = [];
  const targetShell = new ShellToolRuntime();
  const targetTools = new ToolEnvironment({
    runtimes: [
      {
        name: targetShell.name,
        specification: targetShell.specification,
        remoteExecution: "text-json",
        enforcesSandbox: true,
        executionMode: targetShell.executionMode,
        taskPolicy: targetShell.taskPolicy,
        execute: (invocation) => {
          timings.push({ ...invocation.task });
          return targetShell.execute(invocation);
        },
      },
    ],
  });
  const app = createHostedAppServer({
    cwd,
    dataDirectory: path.join(cwd, "data"),
    provider: { type: "fake" },
    model: "fake",
    approvalPolicy: "never",
    journal: new InMemoryThreadJournal(),
    toolEnvironment: targetTools,
  });
  const access = new RemoteHostAccess({
    appServer: app,
    hostId: "target",
    access: "control",
    toolsEnabled: true,
    tools: (identity) =>
      new FleetToolGateway({ ...identity, tools: targetTools }),
    workspaces: () => [{ id: "work", label: "Work", cwd }],
  });
  const paired = await access.pair({
    hostId: "target",
    deviceId: "peer",
    code: access.createPairingCode(),
    access: "control",
    toolsEnabled: true,
  });
  const thread = await app.startThread({ cwd });
  const hello = await access.hello("peer", paired.token, "target", 1);
  const device: NativeFleetDevice = {
    id: "remote",
    label: "Remote",
    endpoint: "https://fixture.test",
    hostId: "target",
    access: "control",
    transport: "https",
    toolsEnabled: true,
  };
  const file = path.join(cwd, "fleet.json");
  await writeFile(file, JSON.stringify({ version: 1, devices: [device] }));
  const adapter = new FleetToolTransportAdapter(
    {
      file,
      native: {
        catalog: (_device, request) =>
          access.toolsCatalog("peer", paired.token, {
            ...request,
            processEpoch: request.processEpoch ?? hello.processEpoch,
            hostId: "target",
            version: 1,
          }),
        execute: (_device, request) =>
          access.toolsExecute("peer", paired.token, {
            ...request,
            hostId: "target",
            version: 1,
          }),
        wait: (_device, request) =>
          access.toolsWait("peer", paired.token, {
            ...request,
            hostId: "target",
            version: 1,
          }),
        status: (_device, request) =>
          access.toolsStatus("peer", paired.token, {
            ...request,
            hostId: "target",
            version: 1,
          }),
      },
    },
    () => {},
  );
  const router = new FleetToolTargetRouter((invocation) =>
    adapter.invoke(invocation),
  );
  const caller = new ToolEnvironment({
    targetRouter: router,
    runtimes: [
      {
        name: "shell",
        specification: targetShell.specification,
        remoteExecution: "text-json",
        execute: async () => {
          throw new Error("local fallback executed");
        },
      },
    ],
  });
  t.after(async () => {
    access.close();
    await caller.close();
    await app.closeHostResources();
    await targetTools.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const context = {
    workspace: "work",
    targetThreadId: thread.id,
    processEpoch: hello.processEpoch,
    deviceKey: fleetDeviceKey(device),
    toolGeneration: targetTools.remoteDefinitions.find(
      (entry) => entry.definition.name === "shell",
    )!.generation,
  };
  const invoke = (
    name: string,
    arguments_: Record<string, unknown>,
    callId = "call",
  ): ToolInvocation => ({
    name,
    arguments: arguments_,
    callId,
    canonicalToolCallId: callId,
    cwd,
    threadId: "source",
    signal: new AbortController().signal,
  });
  return { caller, adapter, context, invoke, timings };
}
const delayedPrint = `${JSON.stringify(process.execPath)} -e "setTimeout(()=>process.stdout.write('survived'),300)"`;

test("ordinary remote shell preserves domain deadline and early yield", async (t) => {
  const { caller, adapter, context, invoke, timings } = await fixture(t);
  const prepared = caller.prepare(
    invoke("shell", {
      command: delayedPrint,
      timeout_ms: 25,
      yield_time_ms: 5,
      device: "remote",
      target_context: context,
    }),
  );
  let response = await caller.execute(prepared);
  assert.equal(timings[0]?.timeoutMs, 25);
  assert.equal(timings[0]?.yieldTimeMs, 5);
  assert.equal(caller.taskManager.activeTaskCount, 0);
  for (;;) {
    const data = response.structuredContent as {
      status: string;
      task_id: string;
    };
    if (["timed_out", "cancelled", "failed", "completed"].includes(data.status))
      break;
    response = await adapter.invoke(
      invoke("wait", { task_id: data.task_id, yield_time_ms: 1000 }, "wait"),
    );
  }
  assert.equal(
    (response.structuredContent as { status: string }).status,
    "timed_out",
  );
  assert.doesNotMatch(response.output, /survived/);
});

test("generic facade honors smaller domain timing and explicit facade narrowing", async (t) => {
  const { adapter, context, invoke, timings } = await fixture(t);
  const response = await adapter.invoke({
    ...invoke("zenx_fleet_execute", {
      device: "remote",
      ...context,
      name: "shell",
      arguments: { command: delayedPrint, timeout_ms: 500, yield_time_ms: 100 },
      timeout_ms: 25,
      yield_time_ms: 5,
    }),
    task: { waitForCompletion: true },
  });
  assert.equal(timings[0]?.timeoutMs, 25);
  assert.equal(timings[0]?.yieldTimeMs, 5);
  assert.equal(
    (response.structuredContent as { status: string }).status,
    "timed_out",
  );
  assert.doesNotMatch(response.output, /survived/);
});

test("unsupported domain timing rejects before any target body", async (t) => {
  const { adapter, context, invoke, timings } = await fixture(t);
  await assert.rejects(
    adapter.invoke(
      invoke("zenx_fleet_execute", {
        device: "remote",
        ...context,
        name: "shell",
        arguments: { command: delayedPrint, timeout_ms: 120001 },
      }),
    ),
    (error) =>
      error instanceof Error && /remote supported range/.test(error.message),
  );
  assert.equal(timings.length, 0);
});
