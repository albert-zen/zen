import assert from "node:assert/strict";
import test from "node:test";
import { fixture, deferred } from "../../../test/thread-message-fixture.js";
import { NativeRecoveryProjection } from "../../../src/protocol/native/recovery.js";
import type { ModelEvent } from "../../../src/model.js";
import { ZenXTriggerService } from "../src/main/trigger-service.js";
import { canonicalTriggerSnapshot } from "../src/main/trigger-store.js";
import type { TriggerSnapshot } from "../src/main/trigger-types.js";

test(
  "real Core terminal is retained while recovery history persistence is held",
  { timeout: 10_000 },
  async () => {
    const entered = deferred(),
      modelRelease = deferred(),
      writeEntered = deferred(),
      writeRelease = deferred();
    const f = fixture({
      provider: "recovery-race",
      async *stream(): AsyncIterable<ModelEvent> {
        entered.resolve();
        await modelRelease.promise;
        yield {
          type: "text_delta",
          delta: "Real final response during recovery",
        };
      },
    });
    const projection = new NativeRecoveryProjection(f.server);
    let saved: TriggerSnapshot = { triggers: [], history: [], rooms: [] };
    let hold = false,
      wakeRequests = 0;
    const service = new ZenXTriggerService(
      {
        request: async (method: any, params: any): Promise<any> => {
          if (method === "zen/thread/resume")
            return projection.resume(params.threadId);
          assert.equal(method, "zen/turn/wake");
          wakeRequests++;
          return f.server.wakeTurn(
            params.threadId,
            {
              clientId: params.clientId,
              source: params.source,
              sourceId: params.sourceId,
              text: params.text,
            },
            { mode: params.mode },
          );
        },
        onNotification: (listener) =>
          projection.subscribe((event) => {
            if (event.type === "thread_event")
              listener("zen/thread/event", event.event);
          }),
      },
      {
        read: async () => structuredClone(saved),
        write: async (value) => {
          if (hold && value.history[0]?.status === "running") {
            hold = false;
            writeEntered.resolve();
            await writeRelease.promise;
          }
          saved = canonicalTriggerSnapshot(value);
        },
      },
    );
    try {
      const target = await f.server.startThread();
      await service.start();
      const room = await service.createRoom({
        name: "Team",
        members: [{ name: "Worker", threadId: target.id }],
      });
      await service.create({
        kind: "roomMention",
        threadId: target.id,
        label: "Room",
        prompt: "Respond",
        roomId: room.id,
        mention: "Worker",
      });
      await service.postRoomMessage(room.id, "You", "@Worker reply");
      await entered.promise;
      await service.stop();
      hold = true;
      await service.start();
      await writeEntered.promise;
      modelRelease.resolve();
      for (let i = 0; i < 100; i++) {
        if (
          (await f.server.readThread(target.id)).turns.at(-1)?.status ===
          "completed"
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const canonical = await f.server.readThread(target.id);
      assert.equal(canonical.turns.at(-1)?.status, "completed");
      assert.equal(
        canonical.items.filter((item) => item.type === "host_message").length,
        1,
      );
      assert.equal(
        canonical.items.find((item) => item.type === "agent_message")?.text,
        "Real final response during recovery",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      writeRelease.resolve();
      for (
        let i = 0;
        i < 100 && service.snapshot().history[0]?.status !== "completed";
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(service.snapshot().history[0]?.status, "completed");
      const replies = service
        .snapshot()
        .rooms[0]!.messages.filter((message) => message.kind === "agent");
      assert.equal(replies.length, 1);
      assert.equal(replies[0]?.text, "Real final response during recovery");
      assert.equal(wakeRequests, 1);
      await service.stop();
      await service.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        service
          .snapshot()
          .rooms[0]!.messages.filter((message) => message.kind === "agent")
          .length,
        1,
      );
    } finally {
      modelRelease.resolve();
      writeRelease.resolve();
      await service.stop();
      projection.close();
    }
  },
);
