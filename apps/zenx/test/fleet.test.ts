import assert from "node:assert/strict";
import test from "node:test";
import {
  FleetRouter,
  parseFleetConfig,
  runFleetProcess,
} from "../src/main/fleet.js";
import type { ToolInvocation } from "../../../src/tool.js";
const invocation = {
  name: "zenx_threads_send",
  callId: "call",
  canonicalToolCallId: "item",
  threadId: "caller",
  arguments: {
    device: "workstation",
    target: "remote-thread",
    text: "new detail",
  },
  cwd: "/local",
  signal: new AbortController().signal,
} as ToolInvocation;
const config = {
  version: 1,
  devices: [
    {
      id: "workstation",
      label: "Workstation",
      sshHost: "workstation",
      command: [
        "node",
        "/opt/zenx/fleet-bridge.js",
        "/home/me/.config/zenx/runtime/app-server.json",
      ],
      access: "control",
    },
  ],
};
test("Fleet routes existing tool to explicit device, strips device and defaults busy sends to guidance", async () => {
  let sent: any;
  const fleet = new FleetRouter(
    async () => parseFleetConfig(config),
    async (_device, request) => {
      sent = request;
      return { threadId: "remote-thread" };
    },
  );
  const result: any = await fleet.invoke("workstation", invocation);
  assert.equal(sent.name, "zenx_threads_send");
  assert.equal(sent.arguments.device, undefined);
  assert.equal(sent.arguments.messageType, "guidance");
  assert.equal(sent.cwd, undefined);
  assert.equal(result.device, "workstation");
});
test("Unknown and read-only device reject mutations without connecting", async () => {
  let calls = 0;
  const fleet = new FleetRouter(
    async () =>
      parseFleetConfig({
        ...config,
        devices: [{ ...config.devices[0], access: "read" }],
      }),
    async () => {
      calls++;
    },
  );
  await assert.rejects(fleet.invoke("typo", invocation), /Unknown/);
  await assert.rejects(fleet.invoke("workstation", invocation), /read-only/);
  assert.equal(calls, 0);
});
test("Fleet configuration rejects duplicate/reserved devices and SSH option injection", () => {
  for (const devices of [
    [config.devices[0], config.devices[0]],
    [{ ...config.devices[0], id: "local" }],
    [{ ...config.devices[0], sshHost: "-oProxyCommand=bad" }],
  ])
    assert.throws(() => parseFleetConfig({ version: 1, devices }));
});

test("only exact-ID SSH sends require the guarded bridge version", async () => {
  const versions: number[] = [];
  const fleet = new FleetRouter(
    async () =>
      parseFleetConfig({
        ...config,
        devices: [
          ...config.devices,
          {
            id: "https-peer",
            label: "HTTPS fixture",
            transport: "https",
            endpoint: "https://example.test",
            hostId: "host",
            access: "control",
          },
        ],
      }),
    async (_device, request) => {
      versions.push(request.version);
    },
    {
      invoke: async (_device, request) => {
        versions.push(request.version);
      },
    },
  );
  await fleet.invoke("workstation", {
    ...invocation,
    arguments: { threadId: "exact", text: "hello" },
  });
  await fleet.invoke("workstation", invocation);
  await fleet.invoke("workstation", {
    ...invocation,
    name: "zenx_threads_read",
    arguments: { threadId: "exact" },
  });
  await fleet.invoke("https-peer", {
    ...invocation,
    arguments: { threadId: "exact", text: "hello" },
  });
  assert.deepEqual(versions, [2, 1, 1, 1]);
});

test("an old strict-v1 SSH bridge rejects an exact send without executing or replaying", async () => {
  let attempts = 0;
  const fleet = new FleetRouter(
    async () => parseFleetConfig(config),
    async (_device, request, signal) => {
      attempts++;
      return await runFleetProcess(
        process.execPath,
        [
          "-e",
          `
        let body = "";
        process.stdin.on("data", part => body += part);
        process.stdin.on("end", () => {
          const request = JSON.parse(body);
          if (request.version !== 1)
            process.stdout.write(JSON.stringify({version:1,ok:false,error:"Invalid Fleet request"}));
          else process.stdout.write(JSON.stringify({version:1,ok:true,result:"UNGUARDED_EXECUTION"}));
        });
      `,
        ],
        request,
        signal,
      );
    },
  );
  await assert.rejects(
    fleet.invoke("workstation", {
      ...invocation,
      arguments: { threadId: "exact", text: "must not execute" },
    }),
    /bridge does not support archive-fenced.*Update the target bridge and Host/u,
  );
  assert.equal(attempts, 1);
});

test("an uncertain assistant response is never retried", async () => {
  const { deliverAssistantInput } =
    await import("../src/main/assistant-preset.js");
  let sends = 0;
  const port: any = {
    request: async (method: string) => {
      if (method === "thread/read") return { thread: { turns: [] } };
      sends++;
      throw new Error("connection lost after admission");
    },
  };
  await assert.rejects(
    deliverAssistantInput(port, {
      threadId: "t",
      clientUserMessageId: "stable",
      input: [{ type: "text", text: "hello" }],
    }),
    /connection lost/,
  );
  assert.equal(sends, 1);
});

test("cancellation while assistant snapshot is read prevents later admission", async () => {
  const { deliverAssistantInput } =
    await import("../src/main/assistant-preset.js");
  const controller = new AbortController();
  let sends = 0;
  const port: any = {
    request: async (method: string) => {
      if (method === "thread/read") {
        controller.abort();
        return { thread: { turns: [] } };
      }
      sends++;
      return { turn: { id: "should-not-exist" } };
    },
  };
  await assert.rejects(
    deliverAssistantInput(
      port,
      {
        threadId: "t",
        clientUserMessageId: "cancelled",
        input: [{ type: "text", text: "stop" }],
      },
      controller.signal,
    ),
  );
  assert.equal(sends, 0);
});
