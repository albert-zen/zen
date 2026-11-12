import assert from "node:assert/strict";
import test from "node:test";
import { fixture, deferred } from "../../../test/thread-message-fixture.js";
import { NativeRecoveryProjection } from "../../../src/protocol/native/recovery.js";
import type { ModelEvent } from "../../../src/model.js";
import { ZenXTriggerService } from "../src/main/trigger-service.js";
import { canonicalTriggerSnapshot } from "../src/main/trigger-store.js";
import type { TriggerSnapshot } from "../src/main/trigger-types.js";

for (const mismatch of [
  "missing-room-origin",
  "ordinary-room-origin",
  "source",
  "sourceId",
  "clientId",
  "threadId",
] as const) {
  test(`bootstrap recovery rejects ${mismatch} instead of claiming another receipt`, async () => {
    const release = deferred();
    const f = fixture({
      provider: "bootstrap-provenance",
      async *stream(): AsyncIterable<ModelEvent> {
        await release.promise;
        yield { type: "text_delta", delta: "Real completed bootstrap" };
      },
    });
    const projection = new NativeRecoveryProjection(f.server);
    let saved: TriggerSnapshot = { triggers: [], history: [], rooms: [] };
    let recovering = false;
    let wakeRequests = 0;
    const service = new ZenXTriggerService(
      {
        request: async (method: any, params: any): Promise<any> => {
          if (method === "zen/thread/resume") {
            const result = structuredClone(
              await projection.resume(params.threadId),
            );
            if (recovering) {
              const corrupt = (item: any) => {
                if (
                  item.type !== "host_message" &&
                  item.type !== "host_message_queued"
                )
                  return;
                if (mismatch === "source") {
                  item.source = "room";
                  item.sourceId = saved.history[0]!.sourceRoomId;
                } else if (mismatch === "sourceId")
                  item.sourceId = "another-origin";
                else if (mismatch === "clientId")
                  item.clientId = "another-client";
                else if (mismatch === "threadId")
                  item.threadId = "another-thread";
              };
              result.thread.items.forEach(corrupt);
              for (const event of result.events)
                if (event.event.type === "item_completed")
                  corrupt(event.event.item);
            }
            return result;
          }
          assert.equal(method, "zen/turn/wake");
          wakeRequests++;
          return f.server.wakeTurn(params.threadId, params);
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
          saved = canonicalTriggerSnapshot(value);
        },
      },
    );
    try {
      const target = await f.server.startThread();
      await service.start();
      const room = await service.createAssistantRoom({
        name: "New PAW",
        members: [{ name: "Worker", threadId: target.id }],
      });
      const operationId = `${room.operationEpoch}:00000000-0000-4000-8000-000000000301`;
      await service.prepareAssistantIntroduction(room.id, operationId, "en");
      await service.startAssistantIntroduction(room.id, operationId);
      await service.stop();
      release.resolve();
      for (let i = 0; i < 100; i++) {
        if (
          (await f.server.readThread(target.id)).turns.at(-1)?.status ===
          "completed"
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(
        (await f.server.readThread(target.id)).turns.at(-1)?.status,
        "completed",
      );
      // A legacy/unknown history row cannot borrow provenance from its Room
      // operation or claim a receipt belonging to another origin or identity.
      saved.rooms[0]!.operations = [];
      if (mismatch === "missing-room-origin")
        saved.history[0]!.sourceRoomId = null;
      if (mismatch === "ordinary-room-origin")
        saved.history[0]!.sourceRoomMessageId = "actual-room-message";
      recovering = true;
      await service.start();
      for (
        let i = 0;
        i < 100 &&
        !service
          .snapshot()
          .history[0]?.error?.includes("No matching canonical Host receipt");
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(service.snapshot().history[0]?.status, "failed");
      assert.equal(service.snapshot().history[0]?.delivery, "unknown");
      assert.match(
        service.snapshot().history[0]?.error ?? "",
        /No matching canonical Host receipt/,
      );
      assert.equal(wakeRequests, 1);
      assert.deepEqual(service.snapshot().rooms[0]!.messages, []);
    } finally {
      release.resolve();
      await service.stop();
      projection.close();
    }
  });
}

test(
  "bootstrap soft-steers the active Turn even when its Room explicitly queues ordinary input",
  { timeout: 10_000 },
  async () => {
    const entered = deferred(),
      release = deferred();
    let samples = 0,
      wakeRequests = 0;
    const f = fixture({
      provider: "bootstrap-busy",
      async *stream(): AsyncIterable<ModelEvent> {
        if (samples++ === 0) {
          entered.resolve();
          await release.promise;
        }
        yield { type: "text_delta", delta: "Real model reply" };
      },
    });
    const projection = new NativeRecoveryProjection(f.server);
    let saved: TriggerSnapshot = { triggers: [], history: [], rooms: [] };
    const service = new ZenXTriggerService(
      {
        request: async (method: any, params: any): Promise<any> => {
          if (method === "zen/thread/resume")
            return projection.resume(params.threadId);
          assert.equal(method, "zen/turn/wake");
          wakeRequests++;
          assert.equal(
            params.mode,
            undefined,
            "Bootstrap does not inherit the Room's queue preference",
          );
          return f.server.wakeTurn(params.threadId, params);
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
          saved = canonicalTriggerSnapshot(value);
        },
      },
    );
    try {
      const target = await f.server.startThread();
      const active = await f.server.startTurn(target.id, "Actual human input");
      await entered.promise;
      await service.start();
      const room = await service.createAssistantRoom({
        name: "New PAW",
        members: [{ name: "Worker", threadId: target.id }],
      });
      await service.setAssistantDeliveryMode(room.id, "queue");
      const operationId = `${room.operationEpoch}:00000000-0000-4000-8000-000000000102`;
      await service.prepareAssistantIntroduction(room.id, operationId, "en");
      await service.startAssistantIntroduction(room.id, operationId);
      const admitted = (await f.server.readThread(target.id)).items.filter(
        (item) => item.type === "host_message",
      );
      assert.equal(admitted.length, 1);
      assert.equal(admitted[0]!.source, "bootstrap");
      assert.equal(admitted[0]!.sourceId, undefined);
      assert.equal(admitted[0]!.turnId, active.id);
      assert.equal(admitted[0]!.mode, "steer");
      assert.ok(admitted[0]!.deliveryAfter);
      release.resolve();
      await active.done;
      for (
        let i = 0;
        i < 100 && service.snapshot().history[0]?.status !== "completed";
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(service.snapshot().history[0]?.status, "completed");
      assert.equal(wakeRequests, 1);
      assert.equal((await f.server.readThread(target.id)).turns.length, 1);
      assert.equal(
        samples,
        2,
        "Bootstrap reaches a fresh sample after the completed active response",
      );
      assert.deepEqual(service.snapshot().rooms[0]!.messages, []);
    } finally {
      release.resolve();
      await service.stop();
      projection.close();
    }
  },
);

test(
  "bootstrap canonical completion survives service restart while history persistence is held",
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
      const room = await service.createAssistantRoom({
        name: "New PAW",
        members: [{ name: "Worker", threadId: target.id }],
      });
      const operationId = `${room.operationEpoch}:00000000-0000-4000-8000-000000000101`;
      await service.prepareAssistantIntroduction(room.id, operationId, "en");
      await service.startAssistantIntroduction(room.id, operationId);
      await service.acknowledgeRoomOperation(room.id, operationId);
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
      assert.equal(
        replies.length,
        0,
        "A model completion is never fabricated as a Room post",
      );
      assert.deepEqual(
        canonical.items
          .filter((item) => item.type === "host_message")
          .map((item) => item.source),
        ["bootstrap"],
      );
      assert.equal(
        canonical.items.filter((item) => item.type === "user_message").length,
        0,
      );
      await service.startAssistantIntroduction(room.id, operationId);
      assert.equal(wakeRequests, 1);
      await service.stop();
      await service.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        service
          .snapshot()
          .rooms[0]!.messages.filter((message) => message.kind === "agent")
          .length,
        0,
      );
    } finally {
      modelRelease.resolve();
      writeRelease.resolve();
      await service.stop();
      projection.close();
    }
  },
);

test(
  "bootstrap completion recovery after acknowledged operation eviction",
  { timeout: 10_000 },
  async () => {
    const entered = deferred(),
      release = deferred();
    let samples = 0,
      wakeRequests = 0;
    const f = fixture({
      provider: "bootstrap-busy",
      async *stream(): AsyncIterable<ModelEvent> {
        if (samples++ === 0) {
          entered.resolve();
          await release.promise;
        }
        yield { type: "text_delta", delta: "Real model reply" };
      },
    });
    const projection = new NativeRecoveryProjection(f.server);
    let saved: TriggerSnapshot = { triggers: [], history: [], rooms: [] };
    const service = new ZenXTriggerService(
      {
        request: async (method: any, params: any): Promise<any> => {
          if (method === "zen/thread/resume")
            return projection.resume(params.threadId);
          assert.equal(method, "zen/turn/wake");
          wakeRequests++;
          assert.equal(
            params.mode,
            undefined,
            "Bootstrap does not inherit the Room's queue preference",
          );
          return f.server.wakeTurn(params.threadId, params);
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
          saved = canonicalTriggerSnapshot(value);
        },
      },
    );
    try {
      const target = await f.server.startThread();
      const active = await f.server.startTurn(target.id, "Actual human input");
      await entered.promise;
      await service.start();
      const room = await service.createAssistantRoom({
        name: "New PAW",
        members: [{ name: "Worker", threadId: target.id }],
      });
      await service.setAssistantDeliveryMode(room.id, "queue");
      const operationId = `${room.operationEpoch}:00000000-0000-4000-8000-000000000102`;
      await service.prepareAssistantIntroduction(room.id, operationId, "en");
      await service.startAssistantIntroduction(room.id, operationId);
      const admitted = (await f.server.readThread(target.id)).items.filter(
        (item) => item.type === "host_message",
      );
      assert.equal(admitted.length, 1);
      assert.equal(admitted[0]!.source, "bootstrap");
      assert.equal(admitted[0]!.sourceId, undefined);
      assert.equal(admitted[0]!.turnId, active.id);
      assert.equal(admitted[0]!.mode, "steer");
      assert.ok(admitted[0]!.deliveryAfter);
      await service.acknowledgeRoomOperation(room.id, operationId);
      for (let j = 0; j < 129; j++) {
        const currentRoom = service.snapshot().rooms[0]!;
        const id = `${currentRoom.operationEpoch}:00000000-0000-4000-8000-${(j + 200).toString().padStart(12, "0")}`;
        await service.prepareRoomMessage(room.id, id, "prepared only");
        await service.cancelPreparedRoomOperation(room.id, id);
      }
      assert.equal(
        service
          .snapshot()
          .rooms[0]!.operations?.some((op) => op.id === operationId),
        false,
        "The bounded Room operation log has evicted the acknowledged bootstrap",
      );
      await service.stop();
      release.resolve();
      await active.done;
      await service.start();
      for (
        let i = 0;
        i < 100 && service.snapshot().history[0]?.status !== "completed";
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(service.snapshot().history[0]?.status, "completed");
      assert.equal(wakeRequests, 1);
      assert.equal((await f.server.readThread(target.id)).turns.length, 1);
      assert.equal(
        samples,
        2,
        "Bootstrap reaches a fresh sample after the completed active response",
      );
      assert.deepEqual(service.snapshot().rooms[0]!.messages, []);
    } finally {
      release.resolve();
      await service.stop();
      projection.close();
    }
  },
);
