import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ZenXTriggerService } from "../src/main/trigger-service.js";
import { ZenXTriggerStore } from "../src/main/trigger-store.js";
import { createZenXTrustedPlugin } from "../../../packages/zenx-rooms-plugin/src/runtime.js";

test(
  "Room history preserves over 256 messages on disk and exposes every older page in order",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "room-retention-"));
    const store = new ZenXTriggerStore(path.join(directory, "triggers.json"));
    const manager = {
      onNotification: () => () => {},
      request: async (): Promise<never> => {
        throw Error("Synthetic history must not dispatch");
      },
    };
    let service = new ZenXTriggerService(manager, store);
    try {
      await service.start();
      const room = await service.createRoom({
        name: "Synthetic history",
        members: [{ name: "Observer", threadId: "observer" }],
      });
      for (let i = 0; i < 320; i++)
        await service.postAgentRoomMessage(room.id, `Synthetic ${i}`);
      const original = service.snapshot().rooms[0]!.messages;
      assert.equal(original.length, 320);
      assert.equal(new Set(original.map((message) => message.id)).size, 320);
      await service.addRoomReaction(room.id, original[0]!.id, "observer", "👀");
      await service.close();
      const persisted = await store.read();
      assert.equal(persisted.rooms[0]!.messages.length, 320);
      assert.equal(
        persisted.rooms[0]!.messages[0]!.reactions?.[0]?.emoji,
        "👀",
      );
      service = new ZenXTriggerService(
        manager,
        new ZenXTriggerStore(path.join(directory, "triggers.json")),
      );
      await service.start();
      const runtime = createZenXTrustedPlugin(service);
      const messages: typeof original = [];
      let cursor: number | null = 0;
      let requests = 0;
      while (cursor !== null) {
        const page = (await runtime.invoke("zenx_rooms_messages", {
          callId: "synthetic-page",
          arguments: { roomId: room.id, cursor },
          cwd: directory,
          signal: new AbortController().signal,
        })) as { messages: typeof original; nextCursor: number | null };
        assert(page.messages.length > 0 && page.messages.length <= 4);
        assert(Buffer.byteLength(JSON.stringify(page)) < 65_536);
        messages.unshift(...page.messages);
        assert(page.nextCursor === null || page.nextCursor > cursor);
        cursor = page.nextCursor;
        assert(++requests <= 80);
      }
      assert.equal(requests, 80);
      assert.deepEqual(
        messages.map((message) => message.id),
        original.map((message) => message.id),
      );
      assert.deepEqual(
        messages.map((message) => message.text),
        original.map((message) => message.text),
      );
      assert.equal(new Set(messages.map((message) => message.id)).size, 320);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
