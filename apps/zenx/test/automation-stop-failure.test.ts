import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { ZenXBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import type { ZenXPluginHostSdkV1 } from "../src/main/plugin-host-sdk.js";
import type { TriggerSnapshot } from "../src/main/trigger-types.js";

const ROOMS = "zenx-rooms";
const TRIGGERS = "zenx-triggers";
const sdk = () => ({}) as ZenXPluginHostSdkV1;

for (const order of [
  [ROOMS, TRIGGERS],
  [TRIGGERS, ROOMS],
]) {
  for (const fault of [
    "first-start",
    "second-stop",
    "second-start",
    "last-stop",
  ]) {
    test(`${order.join(" → ")} ${fault}: explicit start restores actual Room and Trigger persistence`, async () => {
      let durable: TriggerSnapshot = { rooms: [], triggers: [], history: [] };
      let injection: "read" | "write" | null = null;
      let writeFails = false;
      const active = new Set<string>();
      const service = new ZenXBundledAutomationPluginService(
        {
          request: async () => {
            throw Error("Unexpected wakeup");
          },
          onNotification: () => () => {},
        } as never,
        {
          read: async () => {
            if (injection === "read") {
              injection = null;
              throw Error("FAULT read");
            }
            return structuredClone(durable);
          },
          write: async (snapshot) => {
            if (injection === "write" || writeFails) {
              injection = null;
              throw Error("FAULT write");
            }
            durable = structuredClone(snapshot);
          },
        },
        active,
      );
      const first = sdk();
      const second = sdk();
      try {
        if (fault === "first-start") injection = "read";
        if (fault === "first-start")
          await assert.rejects(
            service.startPlugin(order[0]!, first),
            /FAULT read/u,
          );
        else await service.startPlugin(order[0]!, first);

        if (fault === "second-stop") injection = "write";
        if (fault === "second-start") injection = "read";
        if (fault === "second-stop" || fault === "second-start")
          await assert.rejects(
            service.startPlugin(order[1]!, second),
            /FAULT (write|read)/u,
          );
        else await service.startPlugin(order[1]!, second);

        if (fault === "last-stop") {
          await service.stopPlugin(order[0]!, first);
          injection = "write";
          await assert.rejects(
            service.stopPlugin(order[1]!, second),
            /FAULT write/u,
          );
        }

        if (fault === "second-stop" || fault === "last-stop") {
          // A failed stop retired the underlying generation. No capability
          // may claim that a mutation succeeded before an explicit start.
          await assert.rejects(
            service.createRoom({ name: "before recovery", members: [] }),
            /not running/u,
          );
          writeFails = true;
          await assert.rejects(
            service.startPlugin(order[0]!, first),
            /FAULT write/u,
          );
          await assert.rejects(
            service.createRoom({ name: "still down", members: [] }),
            /not running/u,
          );
          writeFails = false;
        }

        await service.startPlugin(order[0]!, first);
        await service.startPlugin(order[1]!, second);
        assert.deepEqual([...active].sort(), [ROOMS, TRIGGERS]);
        const room = await service.createRoom({
          name: "recovered",
          members: [{ name: "Bot", threadId: "target" }],
        });
        const key = `${room.operationEpoch}:${randomUUID()}`;
        await service.prepareRoomMessage(room.id, key, "only prepared");
        assert.equal(
          (await service.cancelPreparedRoomOperation(room.id, key)).state,
          "cancelled",
        );
        assert.equal(service.roomOperation(room.id, key).state, "cancelled");
        await assert.rejects(
          service.postPreparedRoomMessage(room.id, key, "only prepared"),
          /cancelled/u,
        );
        const timer = await service.create({
          kind: "timer",
          threadId: "target",
          label: "recovered",
          prompt: "No wake before close",
          runAt: Date.now() + 60_000,
        });
        assert.equal(
          durable.rooms.find((item) => item.id === room.id)?.operations?.[0]
            ?.cancelled,
          true,
        );
        assert.ok(durable.triggers.some((item) => item.id === timer.id));
      } finally {
        writeFails = false;
        injection = null;
        for (const plugin of [TRIGGERS, ROOMS]) {
          // Healthy Trigger replacement may own more than one count.
          for (let i = 0; i < 3; i++)
            await service.stopPlugin(plugin).catch(() => {});
        }
      }
    });
  }
}

test("failed switch retains both Trigger admissions, while old Room close cannot withdraw the new SDK", async () => {
  let durable: TriggerSnapshot = { rooms: [], triggers: [], history: [] };
  let fail = false;
  const active = new Set<string>();
  const service = new ZenXBundledAutomationPluginService(
    {
      request: async () => {
        throw Error("Unexpected wakeup");
      },
      onNotification: () => () => {},
    } as never,
    {
      read: async () => structuredClone(durable),
      write: async (snapshot) => {
        if (fail) throw Error("FAULT write");
        durable = structuredClone(snapshot);
      },
    },
    active,
  );
  const oldTrigger = sdk();
  const newTrigger = sdk();
  const oldRoom = sdk();
  const newRoom = sdk();
  try {
    await service.startPlugin(TRIGGERS, oldTrigger);
    await service.startPlugin(TRIGGERS, newTrigger);
    fail = true;
    await assert.rejects(service.startPlugin(ROOMS, oldRoom), /FAULT write/u);
    assert.deepEqual([...active], [TRIGGERS]);
    await assert.rejects(
      service.createRoom({ name: "not running", members: [] }),
      /not running/u,
    );
    fail = false;
    await service.startPlugin(ROOMS, oldRoom); // explicit recovery + Room admission
    await service.startPlugin(ROOMS, oldRoom); // same SDK is not a new Room lease
    await service.startPlugin(ROOMS, newRoom);
    await service.stopPlugin(TRIGGERS);
    assert.equal(active.has(TRIGGERS), true);
    await service.stopPlugin(ROOMS); // tokenless old Room runtime
    assert.equal(active.has(ROOMS), true);
    await service.stopPlugin(TRIGGERS);
    assert.equal(active.has(TRIGGERS), false);
    const room = await service.createRoom({
      name: "new only",
      members: [{ name: "Bot", threadId: "target" }],
    });
    assert.equal(
      durable.rooms.find((entry) => entry.id === room.id)?.name,
      "new only",
    );
    await service.stopPlugin(ROOMS, newRoom);
    assert.equal(active.size, 0);
  } finally {
    fail = false;
    await service.stopPlugin(TRIGGERS).catch(() => {});
    await service.stopPlugin(TRIGGERS).catch(() => {});
    await service.stopPlugin(ROOMS, newRoom).catch(() => {});
    await service.stopPlugin(ROOMS, oldRoom).catch(() => {});
  }
});

test("a distinct Trigger SDK admitted on explicit recovery does not replace the old count", async () => {
  let durable: TriggerSnapshot = { rooms: [], triggers: [], history: [] };
  let fail = false;
  const active = new Set<string>();
  const service = new ZenXBundledAutomationPluginService(
    {
      request: async () => {
        throw Error("Unexpected wakeup");
      },
      onNotification: () => () => {},
    } as never,
    {
      read: async () => structuredClone(durable),
      write: async (snapshot) => {
        if (fail) throw Error("FAULT write");
        durable = structuredClone(snapshot);
      },
    },
    active,
  );
  const oldTrigger = sdk();
  const newTrigger = sdk();
  const roomSdk = sdk();
  try {
    await service.startPlugin(TRIGGERS, oldTrigger);
    fail = true;
    await assert.rejects(service.startPlugin(ROOMS, roomSdk), /FAULT write/u);
    fail = false;
    await service.startPlugin(TRIGGERS, newTrigger);
    await service.startPlugin(ROOMS, roomSdk);
    await service.stopPlugin(TRIGGERS); // old Trigger admission
    assert.equal(active.has(TRIGGERS), true);
    await service.stopPlugin(TRIGGERS); // new Trigger admission
    assert.equal(active.has(TRIGGERS), false);
    const room = await service.createRoom({
      name: "Room still active",
      members: [{ name: "Bot", threadId: "target" }],
    });
    assert.equal(durable.rooms[0]?.id, room.id);
  } finally {
    fail = false;
    await service.stopPlugin(TRIGGERS).catch(() => {});
    await service.stopPlugin(TRIGGERS).catch(() => {});
    await service.stopPlugin(ROOMS, roomSdk).catch(() => {});
  }
});

test("concurrent last close and explicit start serialize across a failed durable stop", async () => {
  let durable: TriggerSnapshot = { rooms: [], triggers: [], history: [] };
  let unblock!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const stopping = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let failStop = false;
  const active = new Set<string>();
  const service = new ZenXBundledAutomationPluginService(
    {
      request: async () => {
        throw Error("Unexpected wakeup");
      },
      onNotification: () => () => {},
    } as never,
    {
      read: async () => structuredClone(durable),
      write: async (snapshot) => {
        if (failStop) {
          entered();
          await gate;
          failStop = false;
          throw Error("FAULT write");
        }
        durable = structuredClone(snapshot);
      },
    },
    active,
  );
  const old = sdk();
  const next = sdk();
  try {
    await service.startPlugin(ROOMS, old);
    const room = await service.createRoom({
      name: "existing",
      members: [{ name: "Bot", threadId: "target" }],
    });
    failStop = true;
    const close = service.stopPlugin(ROOMS, old);
    await stopping;
    const explicitStart = service.startPlugin(ROOMS, next);
    unblock();
    await assert.rejects(close, /FAULT write/u);
    await explicitStart;
    assert.equal(active.has(ROOMS), true);
    await service.stopPlugin(ROOMS, old); // stale exact handle
    const nextRoom = await service.createRoom({
      name: "recovered",
      members: [{ name: "Bot", threadId: "target" }],
    });
    assert.deepEqual(
      durable.rooms.map((item) => item.id),
      [room.id, nextRoom.id],
    );
  } finally {
    unblock();
    await service.stopPlugin(ROOMS, next).catch(() => {});
  }
});
