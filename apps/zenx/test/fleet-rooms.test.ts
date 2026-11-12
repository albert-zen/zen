import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFleetRoomsHandler } from "../src/main/fleet-rooms.js";
import type { AppServerManager } from "../src/main/app-server-manager.js";
import type { ZenXBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";

test("Fleet Rooms hides other workspaces and binds idempotent operation to device and epoch", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fleet-rooms-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = await realpath(dir),
    epoch = randomUUID();
  const operations = new Map<string, { text: string; messageId: string }>();
  const room = {
    id: "r",
    name: "Assistant",
    assistant: { threadId: "t" },
    operationEpoch: epoch,
    messages: Array.from({ length: 55 }, (_, i) => ({
      id: String(i),
      text: String(i),
    })),
  };
  const automation = {
    roomsAvailable: () => true,
    snapshot: () => ({
      rooms: [
        room,
        { ...room, id: "private", assistant: { threadId: "other" } },
        { ...room, id: "ordinary", assistant: undefined },
      ],
    }),
    prepareRoomMessage: async (_: string, id: string, text: string) => {
      const existing = operations.get(id);
      if (existing) {
        if (existing.text !== text) throw new Error("different message");
        return;
      }
      if (!id.startsWith(room.operationEpoch + ":")) throw new Error("stale");
      operations.set(id, { text, messageId: randomUUID() });
    },
    postPreparedRoomMessage: async (_: string, id: string) =>
      operations.get(id),
    acknowledgeRoomOperation: async () => {},
  } as unknown as ZenXBundledAutomationPluginService;
  const manager = {
    request: async (_: string, params: { threadId: string }) => ({
      thread: { cwd: params.threadId === "t" ? cwd : "/nonexistent" },
    }),
  } as unknown as AppServerManager;
  const handler = createFleetRoomsHandler(manager, () => automation);
  const base = {
    workspaceId: "work",
    workspaceCwd: cwd,
    deviceId: "device-one",
  };
  assert.deepEqual(await handler("list", base), {
    rooms: [{ id: "r", name: "Assistant", threadId: "t" }],
  });
  await assert.rejects(
    handler("read", { ...base, roomId: "private" }),
    /authorized workspace/,
  );
  const read = (await handler("read", { ...base, roomId: "r" })) as any;
  assert.equal(read.room.operationEpoch, epoch);
  assert.equal(read.messages.length, 50);
  const input = {
    ...base,
    roomId: "r",
    text: "Hello",
    clientId: `${epoch}:${randomUUID()}`,
  };
  const first = await handler("post", input);
  assert.deepEqual(await handler("post", input), first);
  assert.equal(operations.size, 1);
  await assert.rejects(
    handler("post", { ...input, text: "Changed" }),
    /different message/,
  );
  assert.notDeepEqual(
    await handler("post", { ...input, deviceId: "device-two" }),
    first,
  );
  room.operationEpoch = randomUUID();
  assert.deepEqual(await handler("post", input), first);
  await assert.rejects(
    handler("post", { ...input, clientId: `${epoch}:${randomUUID()}` }),
    /stale/,
  );
});

test("remote Trigger settings are exact, workspace-scoped, read-only and exclude program secrets", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fleet-trigger-source-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = await realpath(dir);
  let available = true;
  let archived = false;
  let trigger: any = {
    id: "source-trigger",
    threadId: "owner-thread",
    kind: "signal",
    label: "Same label",
    prompt: "Actual source settings",
    active: true,
    signal: { name: "go" },
    program: {
      action: { command: "PRIVATE_COMMAND", env: { SECRET: "PRIVATE_VALUE" } },
    },
  };
  const service = {
    triggersAvailable: () => available,
    snapshot: () => ({
      triggers: trigger
        ? [trigger, { ...trigger, id: "same-label-other" }]
        : [],
    }),
  } as unknown as ZenXBundledAutomationPluginService;
  const manager = {
    request: async () => ({ thread: { cwd, archived } }),
  } as unknown as AppServerManager;
  const handler = createFleetRoomsHandler(manager, () => service);
  const request = {
    workspaceId: "workspace",
    workspaceCwd: cwd,
    deviceId: "inbound",
    triggerId: "source-trigger",
    threadId: "owner-thread",
  };
  const result: any = await handler("trigger", request);
  assert.equal(result.trigger.id, "source-trigger");
  assert.equal(result.trigger.prompt, "Actual source settings");
  assert.equal(result.trigger.programConfigured, true);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  await assert.rejects(
    handler("trigger", { ...request, threadId: "same-id-local-thread" }),
    /exact Trigger/,
  );
  await assert.rejects(
    handler("trigger", { ...request, workspaceCwd: "/wrong" }),
    /authorized workspace/,
  );
  archived = true;
  await assert.rejects(handler("trigger", request), /authorized workspace/);
  archived = false;
  available = false;
  await assert.rejects(handler("trigger", request), /unavailable/);
  available = true;
  trigger = null;
  await assert.rejects(handler("trigger", request), /exact Trigger/);
});
