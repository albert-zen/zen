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
