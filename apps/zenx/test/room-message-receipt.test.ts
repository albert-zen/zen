import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ZenXTriggerService } from "../src/main/trigger-service.js";
import { ZenXTriggerStore } from "../src/main/trigger-store.js";

test("Room delivered and per-recipient read derive from durable message and exact admitted client identity", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "room-receipt-"));
  const filename = path.join(dir, "state.json");
  let inputId = "",
    mode = "pending",
    sends = 0;
  const port: any = {
    onNotification: () => () => {},
    request: async () => {
      throw Error("unexpected start");
    },
    sendAssistant: async (params: any) => {
      inputId = params.clientUserMessageId;
      sends++;
      return { turnId: "turn" };
    },
    readThread: async (id: string) => {
      if (mode === "missing") throw Error("missing Thread");
      return {
        thread: {
          id: mode === "wrong-thread" ? "another" : id,
          turns: [
            {
              id: "turn",
              items:
                mode === "pending"
                  ? []
                  : [
                      {
                        type:
                          mode === "queued"
                            ? "userMessageQueued"
                            : "userMessage",
                        id: "canonical",
                        clientId:
                          mode === "wrong-client" ? "unrelated" : inputId,
                        deliveryAfter: "prior-sample",
                        content: [],
                      },
                    ],
            },
          ],
        },
      };
    },
  };
  let service = new ZenXTriggerService(port, new ZenXTriggerStore(filename));
  await service.start();
  try {
    const room = await service.createAssistantRoom({
      name: "Receipt test",
      members: [{ name: "Companion", threadId: "bound" }],
    });
    const op = `${room.operationEpoch}:${randomUUID()}`;
    await service.prepareRoomMessage(room.id, op, "Hello");
    assert.equal(
      (await service.roomMessageReceipt(room.id, "not-committed")).receipt,
      "unknown",
    );
    const saved = await service.postPreparedRoomMessage(room.id, op, "Hello");
    const receipt = () => service.roomMessageReceipt(room.id, saved.messageId!);
    assert.equal((await receipt()).receipt, "delivered");
    assert.equal((await receipt()).readers[0]?.state, "unconfirmed");
    for (mode of ["queued", "wrong-client"])
      assert.equal((await receipt()).readers[0]?.state, "unconfirmed");
    mode = "wrong-thread";
    assert.equal((await receipt()).readers[0]?.state, "unavailable");
    mode = "read";
    assert.equal((await receipt()).readers[0]?.state, "read");
    await service.postPreparedRoomMessage(room.id, op, "Hello");
    assert.equal(sends, 1);
    await service.stop();
    service = new ZenXTriggerService(port, new ZenXTriggerStore(filename));
    await service.start();
    assert.equal((await receipt()).readers[0]?.state, "read");
    assert.equal(sends, 1);
    mode = "missing";
    assert.equal((await receipt()).readers[0]?.state, "unavailable");
  } finally {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Room quote target is bound at prepare, survives restart, and reactions are idempotent without wakeups", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "room-social-"));
  const filename = path.join(dir, "state.json");
  let calls = 0;
  const port: any = {
    onNotification: () => () => {},
    request: async () => {
      calls++;
      throw Error("unexpected wakeup");
    },
  };
  let service = new ZenXTriggerService(port, new ZenXTriggerStore(filename));
  await service.start();
  try {
    const room = await service.createRoom({
      name: "Social",
      members: [{ name: "Worker", threadId: "worker" }],
    });
    await service.postAgentRoomMessage(room.id, "source 文".repeat(250));
    const target = service.snapshot().rooms[0]!.messages[0]!;
    const key = `${room.operationEpoch}:${randomUUID()}`;
    const prepared = await service.prepareRoomMessage(
      room.id,
      key,
      "response",
      target.id,
    );
    assert.equal(prepared.replyTo?.messageId, target.id);
    assert(Buffer.byteLength(prepared.replyTo!.text) <= 1000);
    await assert.rejects(
      service.prepareRoomMessage(room.id, key, "response"),
      /different/,
    );
    await service.postPreparedRoomMessage(room.id, key, "response");
    const reply = service.snapshot().rooms[0]!.messages[1]!;
    assert.deepEqual(reply.replyTo, prepared.replyTo);
    await service.setRoomReaction(room.id, reply.id, null, "👍");
    await service.setRoomReaction(room.id, reply.id, null, "👍");
    await service.setRoomReaction(room.id, reply.id, "worker", "👀");
    assert.equal(
      service.snapshot().rooms[0]!.messages[1]!.reactions?.length,
      2,
    );
    await assert.rejects(
      service.setRoomReaction(room.id, reply.id, "stranger", "👍"),
      /member/,
    );
    await assert.rejects(
      service.setRoomReaction(room.id, reply.id, null, "not emoji"),
      /Unsupported/,
    );
    await service.setRoomReaction(room.id, reply.id, null, null);
    assert.deepEqual(service.snapshot().rooms[0]!.messages[1]!.reactions, [
      { actorId: "thread:worker", label: "Worker", emoji: "👀" },
    ]);
    assert.equal(calls, 0);
    await service.stop();
    service = new ZenXTriggerService(port, new ZenXTriggerStore(filename));
    await service.start();
    assert.deepEqual(
      service.snapshot().rooms[0]!.messages[1]!.replyTo,
      prepared.replyTo,
    );
    assert.equal(
      service.snapshot().rooms[0]!.messages[1]!.reactions?.length,
      1,
    );
    const other = await service.createRoom({
      name: "Other",
      members: [{ name: "Other", threadId: "other" }],
    });
    await assert.rejects(
      service.prepareRoomMessage(
        other.id,
        `${other.operationEpoch}:${randomUUID()}`,
        "cross-room",
        target.id,
      ),
      /not retained/,
    );
    await service.postAgentRoomMessage(room.id, "Agent quoted reply", reply.id);
    assert.equal(
      service.snapshot().rooms[0]!.messages[2]!.replyTo?.messageId,
      reply.id,
    );
  } finally {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import { createZenXRoomsProfileLoader } from "../src/main/rooms-profile-loader.js";
import { createZenXTrustedPlugin } from "../../../packages/zenx-rooms-plugin/src/runtime.js";
test("reaction attribution is Host-owned and agent arguments cannot impersonate the user", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "room-reaction-scope-"));
  const service = await createBundledAutomationPluginService({
    userDataDirectory: dir,
    appServer: {
      onNotification: () => () => {},
      request: async () => {
        throw Error("unexpected");
      },
    } as any,
  });
  await service.startPlugin("zenx-rooms", {} as any);
  try {
    const room = await service.createRoom({
      name: "Scope",
      members: [{ name: "Worker", threadId: "worker" }],
    });
    await service.postAgentRoomMessage(room.id, "source");
    const message = service.snapshot().rooms[0]!.messages[0]!;
    const runtime = createZenXRoomsProfileLoader(() => service)({
      createZenXTrustedPlugin,
    });
    const args = { roomId: room.id, messageId: message.id, emoji: "👍" };
    const invocation: any = {
      callId: "call",
      name: "zenx_rooms_react",
      arguments: args,
      cwd: dir,
      signal: new AbortController().signal,
      threadId: "worker",
    };
    await runtime.invoke("zenx_rooms_post_message", {
      ...invocation,
      name: "zenx_rooms_post_message",
      arguments: {
        roomId: room.id,
        text: "Explicit tool reply",
        replyToMessageId: message.id,
        author: "You",
        threadId: "forged",
      },
    });
    const posted = service.snapshot().rooms[0]!.messages.at(-1)!;
    assert.equal(posted.author, "Worker");
    assert.equal(posted.originThreadId, "worker");
    assert.equal(posted.kind, "agent");
    assert.equal(posted.replyTo?.messageId, message.id);
    assert.equal(
      service.snapshot().rooms[0]!.messages[0]!.originThreadId,
      null,
    );
    await runtime.invoke("zenx_rooms_react", invocation);
    assert.equal(
      service.snapshot().rooms[0]!.messages[0]!.reactions?.[0]?.actorId,
      "thread:worker",
    );
    await assert.rejects(
      runtime.invoke("zenx_rooms_react", {
        ...invocation,
        arguments: { input: args },
      }),
      /Trusted Room UI/,
    );
    await assert.rejects(
      runtime.invoke("zenx_rooms_react", {
        ...invocation,
        threadId: undefined,
      }),
      /calling Thread/,
    );
    await runtime.invoke("zenx_rooms_react", {
      ...invocation,
      trustedPluginUi: true,
      arguments: { input: args },
    });
    assert.deepEqual(
      service
        .snapshot()
        .rooms[0]!.messages[0]!.reactions?.map((r) => r.actorId),
      ["thread:worker", "user"],
    );
  } finally {
    await service.stopPlugin("zenx-rooms");
    await rm(dir, { recursive: true, force: true });
  }
});
