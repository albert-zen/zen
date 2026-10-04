import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { AppServerManager } from "../src/main/app-server-manager.js";
import { FleetRouter, runFleetProcess } from "../src/main/fleet.js";
import {
  MutableAppServerRequestPort,
  ZenXSelfControlCapabilityPackage,
} from "../src/main/capabilities/self-control-package.js";
import { ZenXTriggerService } from "../src/main/trigger-service.js";
import { ZenXTriggerStore } from "../src/main/trigger-store.js";
import { deliverAssistantInput } from "../src/main/assistant-preset.js";
const bridge = fileURLToPath(
  new URL("../src/main/fleet-bridge.ts", import.meta.url),
);
async function makeHost(dir: string) {
  await mkdir(dir, { recursive: true });
  const descriptorFile = path.join(dir, "runtime/app-server.json");
  const manager = new AppServerManager({
    entryPath: fileURLToPath(
      new URL("../src/main/app-server-host.ts", import.meta.url),
    ),
    tokenFile: path.join(dir, "runtime/token"),
    descriptorFile,
    hostConfig: {
      cwd: dir,
      dataDirectory: path.join(dir, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10000,
  });
  await writeFile(
    path.join(dir, "host-profile.json"),
    JSON.stringify({ workspace: dir, workspaces: [dir] }),
  );
  await manager.start();
  return { manager, descriptorFile };
}
test(
  "two Hosts: natural tools list/read/create/send/steer/wait remotely; reconnect after Host restart",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "zenx-fleet-real-"));
    const a = await makeHost(path.join(dir, "a"));
    const b = await makeHost(path.join(dir, "b"));
    try {
      const port = new MutableAppServerRequestPort();
      await port.attach(a.manager, path.join(dir, "a"));
      const config = {
        version: 1 as const,
        devices: [
          {
            id: "b",
            label: "B",
            sshHost: "b",
            command: ["bridge"],
            access: "control" as const,
          },
        ],
      };
      const fleet = new FleetRouter(
        async () => config,
        (_device, request, signal) =>
          runFleetProcess(
            process.execPath,
            ["--import", "tsx", bridge, b.descriptorFile],
            request,
            signal,
          ),
      );
      const pkg = new ZenXSelfControlCapabilityPackage({
        appServer: port,
        fleet,
      });
      const invoke = (name: string, args: Record<string, unknown>) =>
        pkg.invoke(name, {
          name,
          arguments: args,
          callId: randomUUID(),
          canonicalToolCallId: randomUUID(),
          threadId: "source-a",
          cwd: path.join(dir, "a"),
          signal: AbortSignal.timeout(20000),
        });
      const local: any = await invoke("zenx_threads_create", {
        cwd: path.join(dir, "a"),
      });
      const remote: any = await invoke("zenx_threads_create", {
        device: "b",
        cwd: path.join(dir, "b"),
      });
      const threadId = remote.result.threadId;
      assert.ok(threadId);
      assert.notEqual(threadId, local.threadId);
      const listed: any = await invoke("zenx_threads_list", { device: "b" });
      assert.ok(JSON.stringify(listed).includes(threadId));
      assert.ok(!JSON.stringify(listed).includes(local.threadId));
      const first = await b.manager.request("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text: `!shell ${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},3500)"`,
          },
        ],
      });
      const sent: any = await invoke("zenx_threads_send", {
        device: "b",
        target: threadId,
        text: "补充信息：use this in the next cycle",
      });
      assert.equal(sent.result.mode, "steer");
      assert.equal(sent.result.turnId, first.turn.id);
      const waited: any = await invoke("zenx_self_control_threads_wait", {
        device: "b",
        target: threadId,
        turnId: first.turn.id,
        timeoutSeconds: 15,
      });
      assert.equal(waited.result.timedOut, false);
      assert.equal(waited.result.status, "completed");
      const read: any = await invoke("zenx_threads_read", {
        device: "b",
        target: threadId,
      });
      assert.ok(JSON.stringify(read).includes("补充信息"));
      const snapshot = await b.manager.request("thread/read", {
        threadId,
        includeTurns: true,
      });
      assert.equal(snapshot.thread.turns.length, 1);
      await b.manager.stop();
      await assert.rejects(
        invoke("zenx_threads_status", { device: "b", target: threadId }),
        /Fleet/,
      );
      await b.manager.start();
      const after: any = await invoke("zenx_threads_status", {
        device: "b",
        target: threadId,
      });
      assert.equal(after.result.threadId, threadId);
    } finally {
      await a.manager.stop();
      await b.manager.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "assistant absorbs two messages into busy Turn and posts only explicit Room messages",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "zenx-assistant-live-"));
    const { manager } = await makeHost(dir);
    const service = new ZenXTriggerService(
      {
        request: (m, p) => manager.request(m, p),
        onNotification: (listener) => manager.onNotification(listener),
        sendAssistant: (p) => deliverAssistantInput(manager, p),
      },
      new ZenXTriggerStore(path.join(dir, "rooms.json")),
    );
    try {
      await service.start();
      const thread = (await manager.request("thread/start", {})).thread;
      const room = await service.createAssistantRoom({
        name: "Always On Assistant",
        members: [{ name: "Assistant", threadId: thread.id }],
      });
      const first = await manager.request("turn/start", {
        threadId: thread.id,
        input: [
          {
            type: "text",
            text: `!shell ${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},1500)"`,
          },
        ],
      });
      await service.postRoomMessage(room.id, "You", "Use the other device");
      await service.postRoomMessage(room.id, "You", "And keep the same task");
      assert.ok(
        service
          .snapshot()
          .history.every(
            (h) => h.status === "running" && h.delivery === undefined,
          ),
      );
      await service.postAgentRoomMessage(
        room.id,
        "I am checking the other device",
      );
      const end = Date.now() + 12000;
      while (
        service.snapshot().history.some((h) => h.status !== "completed") &&
        Date.now() < end
      )
        await new Promise((r) => setTimeout(r, 50));
      assert.equal(service.snapshot().history.length, 2);
      assert.ok(
        service
          .snapshot()
          .history.every(
            (h) => h.status === "completed" && h.turnId === first.turn.id,
          ),
      );
      const state = await manager.request("thread/read", {
        threadId: thread.id,
        includeTurns: true,
      });
      assert.equal(state.thread.turns.length, 1);
      assert.equal(
        service.snapshot().rooms[0]!.messages.filter((m) => m.kind === "agent")
          .length,
        1,
      );
    } finally {
      await service.stop();
      await manager.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "assistant retries only confirmed idle/start and completion/steer races without losing messages",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "zenx-assistant-races-"));
    const { manager } = await makeHost(dir);
    try {
      const thread = (await manager.request("thread/start", {})).thread;
      let reads = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => (release = resolve));
      const port: any = {
        request: async (method: any, params: any) => {
          const result = await manager.request(method, params);
          if (method === "thread/read" && reads < 2) {
            reads++;
            if (reads === 2) release();
            await barrier;
          }
          return result;
        },
      };
      const [one, two] = await Promise.all(
        ["one", "two"].map((text, index) =>
          deliverAssistantInput(port, {
            threadId: thread.id,
            clientUserMessageId: `race-${index}`,
            input: [
              {
                type: "text",
                text: `!shell ${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},800)" ${text}`,
              },
            ],
          }),
        ),
      );
      assert.ok(one && two);
      assert.equal(one.turnId, two.turnId);
      let latest = await manager.request("thread/read", {
        threadId: thread.id,
        includeTurns: true,
      });
      assert.equal(
        latest.thread.turns[0]!.items.filter(
          (item) => item.type === "userMessage",
        ).length,
        2,
      );
      let paused = false;
      const stale: any = {
        request: async (method: any, params: any) => {
          const result = await manager.request(method, params);
          if (method === "thread/read" && !paused) {
            paused = true;
            while (
              (
                await manager.request("thread/read", {
                  threadId: thread.id,
                  includeTurns: true,
                })
              ).thread.turns.some((t) => t.status === "inProgress")
            )
              await new Promise((r) => setTimeout(r, 30));
          }
          return result;
        },
      };
      const after = await deliverAssistantInput(stale, {
        threadId: thread.id,
        clientUserMessageId: "after-terminal",
        input: [{ type: "text", text: "Continue after the finished turn" }],
      });
      assert.notEqual(after.turnId, one.turnId);
      latest = await manager.request("thread/read", {
        threadId: thread.id,
        includeTurns: true,
      });
      assert.equal(
        latest.thread.turns
          .flatMap((t) => t.items)
          .filter(
            (i) => i.type === "userMessage" && i.clientId === "after-terminal",
          ).length,
        1,
      );
    } finally {
      await manager.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
