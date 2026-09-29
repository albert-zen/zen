import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import { createZenXTrustedPlugin } from "../../../packages/zenx-rooms-plugin/src/runtime.js";
import { ZenXTriggerStore } from "../src/main/trigger-store.js";

test("prepared Room operation binds same key to same text and commits at most one human message", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "room-operation-red-"));
  const service = await createBundledAutomationPluginService({
    userDataDirectory: dir,
    appServer: {
      request: async () => {
        throw Error("No wake for plain message");
      },
      onNotification: () => () => {},
    } as any,
  });
  await service.startPlugin("zenx-rooms", {} as any);
  const room = await service.createRoom({
    name: "red",
    members: [{ name: "Bot", threadId: "target" }],
  });
  const key = `${room.operationEpoch}:a6210a98-d106-458c-b7d1-cc5b9a9668f5`;
  const runtime = createZenXTrustedPlugin(service);
  const invocation = (args: Record<string, unknown>) => ({
    callId: "qa",
    arguments: args,
    cwd: dir,
    signal: new AbortController().signal,
  });
  await assert.rejects(
    runtime.invoke(
      "zenx_rooms_post_message",
      invocation({ input: { roomId: room.id, text: "unauthorized human" } }),
    ),
    /roomId/,
  );
  await assert.rejects(
    runtime.invoke(
      "zenx_rooms_prepare_message",
      invocation({
        roomId: room.id,
        operationId: key,
        text: "agent cannot prepare",
      }),
    ),
    /Trusted Room UI required/,
  );
  assert.equal(service.snapshot().rooms[0]?.messages.length, 0);
  await service.prepareRoomMessage(room.id, key, "同文");
  await assert.rejects(
    service.prepareRoomMessage(room.id, key, "不同文"),
    /different|bound/i,
  );
  const first = await service.postPreparedRoomMessage(room.id, key, "同文");
  const again = await service.postPreparedRoomMessage(room.id, key, "同文");
  assert.equal(first.messageId, again.messageId);
  assert.equal(service.snapshot().rooms[0]?.messages.length, 1);
  await runtime.invoke(
    "zenx_rooms_post_message",
    invocation({ roomId: room.id, text: "Agent tool message" }),
  );
  assert.equal(service.snapshot().rooms[0]?.messages[1]?.kind, "agent");
  await service.stopPlugin("zenx-rooms");
  await rm(dir, { recursive: true, force: true });
});

test("receipt survives transcript truncation and a restart without inferring an unsent message", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "room-operation-retain-"));
  const port = {
    request: async () => {
      throw Error("No turn expected");
    },
    onNotification: () => () => {},
  } as any;
  const service = await createBundledAutomationPluginService({
    userDataDirectory: dir,
    appServer: port,
  });
  await service.startPlugin("zenx-rooms", {} as any);
  const room = await service.createRoom({
    name: "retain",
    members: [{ name: "Bot", threadId: "target" }],
  });
  const id = `${room.operationEpoch}:0fd47a51-53c2-498e-a698-6d91d2e1ab87`;
  await service.prepareRoomMessage(room.id, id, "retain original");
  const receipt = await service.postPreparedRoomMessage(
    room.id,
    id,
    "retain original",
  );
  for (let n = 0; n < 260; n++)
    await service.postRoomMessage(room.id, "You", `ordinary ${n}`);
  assert.equal(service.snapshot().rooms[0]?.messages.length, 256);
  const runtime = createZenXTrustedPlugin(service);
  const paged = (name: string, arguments_: Record<string, unknown>) =>
    runtime.invoke(name, {
      callId: "qa",
      trustedPluginUi: true,
      arguments: arguments_,
      cwd: dir,
      signal: new AbortController().signal,
    });
  const metadata = (await paged("zenx_rooms_list", {
    input: { cursor: 0 },
  })) as {
    rooms: Array<{ messageCount: number; messages: Array<{ text: string }> }>;
    nextCursor: number | null;
  };
  assert.equal(metadata.rooms[0]?.messageCount, 256);
  assert(metadata.rooms[0]?.messages[0]!.text.length <= 120);
  const messageIds = new Set<string>();
  let offset: number | null = 0;
  while (offset !== null) {
    const page = (await paged("zenx_rooms_messages", {
      input: { roomId: room.id, cursor: offset },
    })) as {
      messages: Array<{ id: string; text: string }>;
      nextCursor: number | null;
    };
    assert(page.messages.length <= 4);
    assert(Buffer.byteLength(JSON.stringify(page)) < 65536);
    for (const entry of page.messages) messageIds.add(entry.id);
    offset = page.nextCursor;
  }
  assert.equal(messageIds.size, 256);
  assert.equal(service.roomOperation(room.id, id).messageId, receipt.messageId);
  const again = await service.postPreparedRoomMessage(
    room.id,
    id,
    "retain original",
  );
  assert.equal(again.messageId, receipt.messageId);
  assert.equal(service.snapshot().rooms[0]?.messages.length, 256);
  await service.stopPlugin("zenx-rooms");
  const restarted = await createBundledAutomationPluginService({
    userDataDirectory: dir,
    appServer: port,
  });
  await restarted.startPlugin("zenx-rooms", {} as any);
  assert.equal(
    restarted.roomOperation(room.id, id).messageId,
    receipt.messageId,
  );
  await restarted.stopPlugin("zenx-rooms");
  await rm(dir, { recursive: true, force: true });
});

test("bounded Room receipts reject overflow rather than dropping unacknowledged operations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "room-operation-cap-"));
  const service = await createBundledAutomationPluginService({
    userDataDirectory: dir,
    appServer: {
      request: async () => {
        throw Error("No turn expected");
      },
      onNotification: () => () => {},
    } as any,
  });
  await service.startPlugin("zenx-rooms", {} as any);
  const room = await service.createRoom({
    name: "cap",
    members: [{ name: "Bot", threadId: "target" }],
  });
  for (let n = 0; n < 128; n++)
    await service.prepareRoomMessage(
      room.id,
      `${room.operationEpoch}:68a9fc31-9bf7-4282-aa3a-${n.toString(16).padStart(12, "0")}`,
      "未解消息",
    );
  await assert.rejects(
    service.prepareRoomMessage(
      room.id,
      `${room.operationEpoch}:68a9fc31-9bf7-4282-aa3a-fffffffffffe`,
      "extra",
    ),
    /Unresolved Room operation limit/,
  );
  assert.equal(service.snapshot().rooms[0]?.operations?.length, 128);
  const runtime = createZenXTrustedPlugin(service);
  const invoke = async (name: string, input?: Record<string, unknown>) =>
    await runtime.invoke(name, {
      callId: "qa",
      ...(input === undefined ? {} : { trustedPluginUi: true as const }),
      arguments: input === undefined ? {} : { input },
      cwd: dir,
      signal: new AbortController().signal,
    });
  const listed = (await invoke("zenx_rooms_list", {})) as {
    rooms: Array<{ pendingCount: number; operations: unknown[] }>;
  };
  assert.equal(listed.rooms[0]?.pendingCount, 128);
  assert.deepEqual(listed.rooms[0]?.operations, []);
  const agentList = (await invoke("zenx_rooms_list")) as {
    rooms: Array<{ pendingCount?: number }>;
  };
  assert.equal(agentList.rooms[0]?.pendingCount, undefined);
  const ids = new Set<string>();
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page = (await invoke("zenx_rooms_operations", {
      roomId: room.id,
      cursor,
    })) as {
      operations: Array<{ id: string; text: string }>;
      nextCursor: number | null;
    };
    assert(page.operations.length <= 8);
    assert(Buffer.byteLength(JSON.stringify(page)) < 65536);
    for (const entry of page.operations) ids.add(entry.id);
    cursor = page.nextCursor;
  }
  assert.equal(ids.size, 128);
  await service.stopPlugin("zenx-rooms");
  await rm(dir, { recursive: true, force: true });
});

test("wake failure retains exact committed message and repeated key never re-wakes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "room-operation-wake-"));
  let calls = 0;
  const service = await createBundledAutomationPluginService({
    userDataDirectory: dir,
    appServer: {
      request: async () => {
        calls++;
        throw Error("QA controlled delivery failure");
      },
      onNotification: () => () => {},
    } as any,
  });
  await service.startPlugin("zenx-rooms", {} as any);
  await service.startPlugin("zenx-triggers", {} as any);
  const room = await service.createRoom({
    name: "wake",
    members: [{ name: "Bot", threadId: "target" }],
  });
  await service.create({
    threadId: "target",
    kind: "roomMention",
    roomId: room.id,
    mention: "Bot",
    label: "respond",
    prompt: "Reply",
  });
  const id = `${room.operationEpoch}:19af8963-d2aa-4c2d-b05a-94f19bdf99cd`;
  await service.prepareRoomMessage(room.id, id, "@Bot test");
  const first = await service.postPreparedRoomMessage(room.id, id, "@Bot test");
  const result = service.roomOperation(room.id, id);
  assert.equal(result.messageId, first.messageId);
  assert.equal(result.mentions[0]?.deliveries[0]?.status, "failed");
  assert.equal(
    (await service.postPreparedRoomMessage(room.id, id, "@Bot test")).messageId,
    first.messageId,
  );
  assert.equal(calls, 1);
  assert.equal(service.snapshot().rooms[0]?.messages.length, 1);
  await service.stopPlugin("zenx-triggers");
  await service.stopPlugin("zenx-rooms");
  await rm(dir, { recursive: true, force: true });
});

test("disabled Triggers plugin cannot wake from an active persisted Room mention definition", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "room-disabled-wake-"));
  let calls = 0;
  const service = await createBundledAutomationPluginService({
    userDataDirectory: dir,
    appServer: {
      request: async () => {
        calls++;
        throw Error("unexpected wake");
      },
      onNotification: () => () => {},
    } as any,
  });
  await service.startPlugin("zenx-rooms", {} as any);
  await service.startPlugin("zenx-triggers", {} as any);
  const room = await service.createRoom({
    name: "disabled",
    members: [{ name: "Bot", threadId: "target" }],
  });
  await service.create({
    threadId: "target",
    kind: "roomMention",
    roomId: room.id,
    mention: "Bot",
    label: "old",
    prompt: "wake",
  });
  await service.stopPlugin("zenx-triggers");
  const key = `${room.operationEpoch}:a2b57f52-62e6-4a32-bd02-0c7c17c24eb0`;
  await service.prepareRoomMessage(room.id, key, "@Bot no wake");
  const committed = await service.postPreparedRoomMessage(
    room.id,
    key,
    "@Bot no wake",
  );
  const status = service.roomOperation(room.id, key);
  assert.equal(status.messageId, committed.messageId);
  assert.equal(status.mentions[0]?.configuredNow, false);
  assert.equal(status.mentions[0]?.deliveries[0]?.status, "unconfigured");
  assert.equal(calls, 0);
  assert.equal(service.snapshot().history.length, 0);
  await service.stopPlugin("zenx-rooms");
  await rm(dir, { recursive: true, force: true });
});

test("an evicted acknowledged key cannot be re-admitted after the bounded epoch rotates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "room-epoch-fence-"));
  const service = await createBundledAutomationPluginService({
    userDataDirectory: dir,
    appServer: {
      request: async () => {
        throw Error("No wake expected");
      },
      onNotification: () => () => {},
    } as any,
  });
  await service.startPlugin("zenx-rooms", {} as any);
  const room = await service.createRoom({
    name: "epoch",
    members: [{ name: "Bot", threadId: "target" }],
  });
  const epoch = room.operationEpoch!;
  const oldKey = `${epoch}:5ad12132-06ab-4b81-b302-09b45e77d117`;
  await service.prepareRoomMessage(room.id, oldKey, "once");
  await service.postPreparedRoomMessage(room.id, oldKey, "once");
  await service.acknowledgeRoomOperation(room.id, oldKey);
  for (let n = 0; n < 127; n++)
    await service.prepareRoomMessage(
      room.id,
      `${epoch}:5ad12132-06ab-4b81-b302-${n.toString(16).padStart(12, "0")}`,
      "pending",
    );
  const rollover = `${epoch}:5ad12132-06ab-4b81-b302-ffffffffffff`;
  await service.prepareRoomMessage(room.id, rollover, "another");
  const nextEpoch = service.snapshot().rooms[0]?.operationEpoch;
  assert(nextEpoch && nextEpoch !== epoch);
  assert.throws(
    () => service.roomOperation(room.id, oldKey),
    /not retained; result unknown/,
  );
  await assert.rejects(
    service.prepareRoomMessage(room.id, oldKey, "once"),
    /stale or invalid; result unknown/,
  );
  assert.equal(service.snapshot().rooms[0]?.messages.length, 1);
  assert.equal(service.snapshot().rooms[0]?.operations?.length, 128);
  await service.stopPlugin("zenx-rooms");
  await rm(dir, { recursive: true, force: true });
});

test("legacy Room without epoch migrates in place with stable ID and trustworthy first send", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "room-legacy-epoch-"));
  const roomId = "legacy-room-id";
  await new ZenXTriggerStore(path.join(dir, "trigger-registry.json")).write({
    triggers: [],
    history: [],
    rooms: [
      {
        id: roomId,
        name: "old",
        members: [{ name: "Bot", threadId: "target" }],
        messages: [],
        createdAt: 1,
      },
    ],
  });
  const service = await createBundledAutomationPluginService({
    userDataDirectory: dir,
    appServer: {
      request: async () => {
        throw Error("No wake expected");
      },
      onNotification: () => () => {},
    } as any,
  });
  await service.startPlugin("zenx-rooms", {} as any);
  const runtime = createZenXTrustedPlugin(service);
  const listed = (await runtime.invoke("zenx_rooms_list", {
    callId: "qa",
    trustedPluginUi: true,
    arguments: { input: { cursor: 0 } },
    cwd: dir,
    signal: new AbortController().signal,
  })) as { rooms: Array<{ id: string; operationEpoch: string }> };
  assert.equal(listed.rooms[0]?.id, roomId);
  assert.equal(listed.rooms[0]?.operationEpoch, "legacy");
  const key = "legacy:b4dcbde7-135a-4353-afac-20a98be9cb11";
  await service.prepareRoomMessage(roomId, key, "来自升级后");
  const committed = await service.postPreparedRoomMessage(
    roomId,
    key,
    "来自升级后",
  );
  assert.equal(
    service.roomOperation(roomId, key).messageId,
    committed.messageId,
  );
  assert.equal(service.snapshot().rooms[0]?.operationEpoch, "legacy");
  await service.stopPlugin("zenx-rooms");
  const reopened = await createBundledAutomationPluginService({
    userDataDirectory: dir,
    appServer: {
      request: async () => {
        throw Error("No wake expected");
      },
      onNotification: () => () => {},
    } as any,
  });
  await reopened.startPlugin("zenx-rooms", {} as any);
  assert.equal(reopened.snapshot().rooms[0]?.id, roomId);
  assert.equal(
    reopened.roomOperation(roomId, key).messageId,
    committed.messageId,
  );
  await reopened.stopPlugin("zenx-rooms");
  await rm(dir, { recursive: true, force: true });
});
