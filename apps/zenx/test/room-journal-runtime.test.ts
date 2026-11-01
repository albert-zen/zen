import assert from "node:assert/strict";
import test from "node:test";
import { createZenXTrustedPlugin } from "../../../packages/zenx-rooms-plugin/src/runtime.js";
const message = {
  id: "m319",
  roomId: "room",
  text: "Synthetic",
  kind: "agent",
  author: "Bot",
  createdAt: 1,
  originThreadId: null,
  originTurnId: null,
};
const snapshot = {
  generation: "11111111-1111-4111-8111-111111111111",
  revision: 400,
  hash: "a".repeat(64),
  roomId: "room",
  messageCount: 320,
};
const invoke = (
  service: any,
  command: string,
  input: Record<string, unknown>,
) =>
  createZenXTrustedPlugin(service).invoke(`zenx_rooms_${command}`, {
    callId: "test",
    trustedPluginUi: true,
    arguments: { input },
    cwd: ".",
    signal: new AbortController().signal,
  });
test("journal runtime pages forward pinned coordinates without reading the recent cache", async () => {
  const calls: unknown[] = [];
  const service = {
    snapshot() {
      throw Error("No full snapshot");
    },
    async readRoomPage(...args: unknown[]) {
      calls.push(args);
      return {
        messages: [message],
        nextCursor: null,
        snapshot,
        reactionRevisions: { m319: 0 },
      };
    },
  };
  const result: any = await invoke(service, "messages", {
    roomId: "room",
    cursor: 316,
    snapshot,
  });
  assert.deepEqual(calls, [["room", 316, snapshot]]);
  assert.equal(result.messages[0].text, "Synthetic");
  assert.deepEqual(result.snapshot, snapshot);
  await assert.rejects(
    invoke(service, "messages", {
      roomId: "room",
      snapshot: { ...snapshot, roomId: "foreign" },
    }),
    /Invalid Room history snapshot/,
  );
  assert.equal(createZenXTrustedPlugin(service as any).storage.version, 2);
});
test("journal list uses total/unread index and operations use targeted previews", async () => {
  const service = {
    snapshot() {
      throw Error("No full snapshot");
    },
    snapshotPreviews() {
      return {
        rooms: [
          {
            id: "room",
            name: "Synthetic",
            members: [],
            messages: [
              {
                ...message,
                text: "x".repeat(200),
                replyTo: { messageId: "old", author: "Bot", text: "quote" },
                reactions: [],
              },
            ],
            messageCount: 320,
          },
        ],
      };
    },
    roomMessageReadProjection() {
      return {
        unreadCount: 300,
        lastMessage: { id: "m319", createdAt: 1, kind: "agent" },
        lastAgentMessage: { id: "m319", createdAt: 1 },
      };
    },
    roomOperations(roomId: string) {
      assert.equal(roomId, "room");
      return [
        {
          id: "op",
          text: "x".repeat(200),
          createdAt: 0,
          acknowledged: false,
          messageId: null,
          mentions: [],
        },
      ];
    },
  };
  const list: any = await invoke(service, "list", {});
  assert.equal(list.rooms[0].messageCount, 320);
  assert.equal(list.rooms[0].unreadCount, 300);
  assert.equal(list.rooms[0].messages[0].text.length, 120);
  assert.equal(list.rooms[0].messages[0].replyTo, undefined);
  assert.equal(list.rooms[0].messages[0].reactions, undefined);
  const operations: any = await invoke(service, "operations", {
    roomId: "room",
  });
  assert.equal(operations.operations[0].text.length, 120);
  await assert.rejects(
    invoke({ ...service, roomMessageReadProjection: undefined }, "list", {}),
    /projection unavailable/,
  );
});
test("legacy runtime remains paged and refuses a stable cursor without its service", async () => {
  const service = {
    snapshot: () => ({
      rooms: [
        { id: "room", name: "Synthetic", members: [], messages: [message] },
      ],
    }),
  };
  assert.equal(
    ((await invoke(service, "messages", { roomId: "room" })) as any).messages
      .length,
    1,
  );
  await assert.rejects(
    invoke(service, "messages", { roomId: "room", snapshot }),
    /snapshots unavailable/,
  );
  assert.equal(
    ((await invoke(service, "list", {})) as any).rooms[0].messageCount,
    1,
  );
});
