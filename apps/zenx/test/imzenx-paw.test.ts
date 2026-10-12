import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createImZenXPawHandler } from "../src/main/imzenx-paw.js";
import type { AppServerManager } from "../src/main/app-server-manager.js";
import type { ZenXBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";

test("IMZenX PAW reads only configured-workspace assistant Rooms and never working Thread messages", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imzenx-paw-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = await realpath(dir);
  const epoch = randomUUID();
  let enabled = true;
  const posted: unknown[] = [];
  const room = {
    id: "r",
    name: "My custom name",
    assistant: { threadId: "t" },
    operationEpoch: epoch,
    messages: [{ id: "m", kind: "agent", text: "Explicit Room post" }],
  };
  const automation = {
    roomsAvailable: () => enabled,
    snapshot: () => ({
      rooms: [
        room,
        { ...room, id: "other", assistant: { threadId: "outside" } },
      ],
    }),
    prepareRoomMessage: async (...args: unknown[]) => {
      posted.push(args);
    },
    postPreparedRoomMessage: async () => ({ messageId: "posted" }),
    acknowledgeRoomOperation: async () => {},
  } as unknown as ZenXBundledAutomationPluginService;
  const manager = {
    request: async (_method: string, args: { threadId: string }) => ({
      thread: {
        cwd: args.threadId === "t" ? cwd : "/unavailable",
        turns: [{ text: "Private working output" }],
      },
    }),
  } as unknown as AppServerManager;
  const handler = createImZenXPawHandler(manager, () => automation);
  assert.deepEqual(await handler(cwd, "list", {}), {
    rooms: [{ id: "r", name: "My custom name", threadId: "t" }],
  });
  const read = (await handler(cwd, "read", { roomId: "r" })) as {
    messages: unknown[];
  };
  assert.deepEqual(read.messages, room.messages);
  await assert.rejects(
    handler(cwd, "read", { roomId: "other" }),
    /authorized workspace/,
  );
  await assert.rejects(
    handler(cwd, "list", { workspaceCwd: "/" }),
    /Invalid PAW/,
  );
  await handler(cwd, "post", {
    roomId: "r",
    clientId: epoch + ":" + randomUUID(),
    text: "Hello",
  });
  assert.equal(posted.length, 1);
  enabled = false;
  await assert.rejects(
    handler(cwd, "read", { roomId: "r" }),
    /Rooms unavailable/,
  );
});
