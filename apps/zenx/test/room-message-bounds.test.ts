import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ZenXTriggerService } from "../src/main/trigger-service.js";
import { canonicalTriggerSnapshot } from "../src/main/trigger-store.js";
import { createZenXTrustedPlugin } from "../../../packages/zenx-rooms-plugin/src/runtime.js";
test("Reaction-heavy history pages retain complete text and cursor progress; quoted source dispatch remains complete", async () => {
  let state: any = { triggers: [], history: [], rooms: [] };
  let dispatched: any;
  const service = new ZenXTriggerService(
    {
      onNotification: () => () => {},
      request: async (_method: any, params: any) => {
        dispatched = params;
        return { turn: { id: "turn", status: "inProgress", items: [] } };
      },
    } as any,
    {
      read: async () => structuredClone(state),
      write: async (value: any) => {
        state = canonicalTriggerSnapshot(structuredClone(value));
      },
    },
  );
  await service.start();
  try {
    const members = Array.from({ length: 64 }, (_, i) => ({
      name: `Member${i}` + "n".repeat(120 - String(i).length),
      threadId: `thread${i}` + "x".repeat(490),
    }));
    const room = await service.createRoom({ name: "Budget", members });
    for (let i = 0; i < 4; i++) {
      await service.postAgentRoomMessage(room.id, "x".repeat(8000));
      const msg = service.snapshot().rooms[0]!.messages.at(-1)!;
      for (const member of members)
        await service.setRoomReaction(room.id, msg.id, member.threadId, "👀");
    }
    const runtime = createZenXTrustedPlugin(service as any);
    const result = await runtime.invoke("zenx_rooms_messages", {
      callId: "read",
      arguments: { roomId: room.id },
      cwd: "/tmp",
      signal: new AbortController().signal,
    });
    const bytes = Buffer.byteLength(JSON.stringify(result));
    assert(bytes < 65536);
    const first = result as any;
    assert.equal(first.messages.length, 1);
    assert.equal(first.nextCursor, 1);
    const ids = [first.messages[0].id];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page: any = await runtime.invoke("zenx_rooms_messages", {
        callId: "page",
        arguments: { roomId: room.id, cursor },
        cwd: "/tmp",
        signal: new AbortController().signal,
      });
      assert(
        page.messages.every(
          (message: any) =>
            message.text.length === 8000 && message.reactions.length === 64,
        ),
      );
      ids.push(...page.messages.map((message: any) => message.id));
      cursor = page.nextCursor;
    }
    assert.equal(new Set(ids).size, 4);
    const regular = await service.createRoom({
      name: "Projection",
      members: [{ name: "Worker", threadId: "worker" }],
    });
    await service.postAgentRoomMessage(regular.id, "Original quote");
    const source = service.snapshot().rooms.find((r) => r.id === regular.id)!
      .messages[0]!;
    await service.create({
      threadId: "worker",
      kind: "roomMention",
      label: "Reply",
      prompt: "Respond",
      roomId: regular.id,
      mention: "Worker",
    } as any);
    const text = "@Worker " + "文".repeat(2600) + "END-TAIL";
    const op = `${regular.operationEpoch}:${randomUUID()}`;
    await service.prepareRoomMessage(regular.id, op, text, source.id);
    await service.postPreparedRoomMessage(regular.id, op, text);
    assert(dispatched.input[0].text.includes(text));
    assert(
      dispatched.input[0].text.includes(
        "Reply to Agent (" + source.id + "): Original quote",
      ),
    );
  } finally {
    await service.stop();
  }
});
