import assert from "node:assert/strict";
import test from "node:test";
import { ZenXTriggersCapabilityPackage } from "../src/main/capabilities/automation-control-package.js";
import { ZenXTriggerService } from "../src/main/trigger-service.js";
import { MAX_ID_BYTES, MAX_TRIGGER_COUNT } from "../src/main/trigger-limits.js";
import type { TriggerSnapshot } from "../src/main/trigger-types.js";

function fixture(): TriggerSnapshot {
  return {
    triggers: [
      {
        id: "trigger",
        threadId: "thread",
        kind: "timer",
        active: false,
        label: "Daily",
        prompt: "PRIVATE_TRIGGER_PROMPT",
        createdAt: 1,
        timer: { nextRunAt: 2_000_000_000_000, intervalMinutes: 10 },
        program: { action: { command: "PRIVATE_PROGRAM_BODY" } },
      },
    ],
    history: [],
    rooms: Array.from({ length: 6 }, (_, room) => ({
      id: `room-${room}`,
      name: `Room ${room}`,
      createdAt: 1,
      members: [],
      messages: Array.from({ length: 50 }, (_, message) => ({
        id: `message-${room}-${message}`,
        roomId: `room-${room}`,
        author: "Agent",
        text: "PRIVATE_ROOM_BODY" + "x".repeat(2_000),
        createdAt: message,
        kind: "agent" as const,
        originThreadId: null,
        originTurnId: null,
      })),
    })),
  };
}

function serviceFor(snapshot: TriggerSnapshot) {
  return new ZenXTriggerService(
    {
      request: async () => {
        throw new Error("Projection must not start work");
      },
      onNotification: () => () => {},
    },
    { read: async () => snapshot, write: async () => {} },
  );
}

function invoke(plugin: ZenXTriggersCapabilityPackage, name: string) {
  return plugin.invoke(name, {
    name,
    callId: "projection-test",
    arguments: {},
    cwd: "/tmp",
    signal: new AbortController().signal,
  });
}

test("production sidebar command projects before cloning and never visits private payloads", async (t) => {
  const snapshot = fixture();
  const service = serviceFor(snapshot);
  const plugin = new ZenXTriggersCapabilityPackage(service);
  await service.start(false);
  const full = (await invoke(plugin, "zenx_triggers_list")) as typeof snapshot;
  const fullBytes = Buffer.byteLength(JSON.stringify(full));
  assert.ok(fullBytes > 600_000);
  assert.equal(full.triggers[0]?.prompt, "PRIVATE_TRIGGER_PROMPT");
  assert.ok(full.rooms[0]?.messages[0]?.text.startsWith("PRIVATE_ROOM_BODY"));
  assert.equal(
    full.triggers[0]?.program?.action?.command,
    "PRIVATE_PROGRAM_BODY",
  );
  const poison = (object: object, key: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
    Object.defineProperty(object, key, {
      configurable: true,
      get() {
        throw new Error(`Sidebar touched forbidden ${key}`);
      },
    });
    return () => Object.defineProperty(object, key, descriptor);
  };
  const restore = [
    poison(snapshot, "rooms"),
    poison(snapshot, "history"),
    poison(snapshot.triggers[0]!, "prompt"),
    poison(snapshot.triggers[0]!, "program"),
  ];
  const clone = t.mock.method(globalThis, "structuredClone", () => {
    throw new Error("Sidebar must not clone the broad shared snapshot");
  });
  try {
    const facts = await invoke(plugin, "zenx_triggers_sidebar_facts");
    assert.deepEqual(facts, {
      triggers: [
        {
          id: "trigger",
          threadId: "thread",
          kind: "timer",
          active: false,
          timer: { nextRunAt: 2_000_000_000_000 },
        },
      ],
    });
    const serialized = JSON.stringify(facts);
    assert.ok(Buffer.byteLength(serialized) < 150);
    assert.doesNotMatch(serialized, /PRIVATE|prompt|history|program|rooms/);
    t.diagnostic(
      `Production full list: ${fullBytes} bytes; sidebar-facts: ${Buffer.byteLength(serialized)} bytes.`,
    );
  } finally {
    clone.mock.restore();
    for (const reset of restore) reset();
    await service.stop();
  }
});

test("sidebar facts are detached and bounded by trigger identity count, independent of Room payload", async () => {
  const snapshot = fixture();
  snapshot.triggers = Array.from({ length: MAX_TRIGGER_COUNT }, (_, index) => ({
    ...snapshot.triggers[0]!,
    id: String(index).padEnd(MAX_ID_BYTES, "i"),
    threadId: "t".repeat(MAX_ID_BYTES),
    sourceError: "PRIVATE_SOURCE_DIAGNOSTIC",
  }));
  const service = serviceFor(snapshot);
  const plugin = new ZenXTriggersCapabilityPackage(service);
  await service.start(false);
  try {
    const facts = service.sidebarFacts();
    assert.equal(facts.triggers.length, MAX_TRIGGER_COUNT);
    assert.equal(
      facts.triggers[0]?.sourceError,
      "Source observation unavailable",
    );
    const first = JSON.stringify(facts);
    const tool = plugin.manifest.tools.find(
      (entry) => entry.name === "zenx_triggers_sidebar_facts",
    )!;
    assert.ok(Buffer.byteLength(first) < tool.maxOutputBytes!);
    assert.ok(Buffer.byteLength(first) < 320_000);
    snapshot.rooms.push(...snapshot.rooms);
    assert.equal(JSON.stringify(service.sidebarFacts()), first);
    facts.triggers[0]!.timer!.nextRunAt = 123;
    facts.triggers[0]!.active = true;
    assert.equal(snapshot.triggers[0]!.timer!.nextRunAt, 2_000_000_000_000);
    assert.equal(snapshot.triggers[0]!.active, false);
  } finally {
    await service.stop();
  }
});

test("sidebar projection has no full-list fallback when the Host port is unavailable", async () => {
  let snapshots = 0;
  const service = serviceFor(fixture());
  const plugin = new ZenXTriggersCapabilityPackage(
    new Proxy(service, {
      get(target, key, receiver) {
        if (key === "sidebarFacts") return undefined;
        if (key === "snapshot")
          return () => {
            snapshots += 1;
            return fixture();
          };
        return Reflect.get(target, key, receiver);
      },
    }),
  );
  await assert.rejects(
    invoke(plugin, "zenx_triggers_sidebar_facts"),
    /unavailable/,
  );
  assert.equal(snapshots, 0);
});
