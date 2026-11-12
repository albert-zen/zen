import assert from "node:assert/strict";
import test from "node:test";
import { ZenXTriggerService } from "../src/main/trigger-service.js";
import { canonicalTriggerSnapshot } from "../src/main/trigger-store.js";
import type { TriggerSnapshot } from "../src/main/trigger-types.js";

function fixture() {
  let saved: TriggerSnapshot = { triggers: [], history: [], rooms: [] };
  const calls: Array<{ method: string; params: any }> = [];
  const timers: Array<() => void> = [];
  let listener: any;
  let now = 100;
  let requestOverride: ((params: any) => Promise<any>) | undefined;
  let recoveryOverride: (() => Promise<any>) | undefined;
  const recoveryCalls: string[] = [];
  const listeners: any[] = [];
  let beforeWrite: ((value: TriggerSnapshot) => Promise<void>) | undefined;
  const service = new ZenXTriggerService(
    {
      request: async (method: any, params: any) => {
        if (method === "zen/thread/resume") {
          recoveryCalls.push(params.threadId);
          if (recoveryOverride) return await recoveryOverride();
          throw new Error("Fixture has no canonical recovery snapshot");
        }
        calls.push({ method, params });
        if (requestOverride) return await requestOverride(params);
        return method === "zen/turn/wake"
          ? params.mode === "queue"
            ? { mode: "queue", queued: true }
            : { mode: "steer", turnId: "active" }
          : ({
              turn: { id: "legacy", status: "inProgress", items: [] },
            } as any);
      },
      onNotification: (callback) => {
        listener = callback;
        listeners.push(callback);
        return () => {};
      },
    },
    {
      read: async () => structuredClone(saved),
      write: async (value) => {
        await beforeWrite?.(value);
        saved = canonicalTriggerSnapshot(value);
      },
    },
    {
      now: () => now,
      schedule: (callback) => {
        timers.push(callback);
        return callback;
      },
      cancelScheduled: () => {},
    },
  );
  return {
    service,
    calls,
    setBeforeWrite: (callback: (value: TriggerSnapshot) => Promise<void>) => {
      beforeWrite = callback;
    },
    recoveryCalls,
    listeners,
    setRecovery: (request: () => Promise<any>) => {
      recoveryOverride = request;
    },
    timers,
    advance: () => {
      now = 102;
    },
    emit: (method: string, params: any) => listener(method, params),
    saved: () => saved,
    setRequest: (request: (params: any) => Promise<any>) => {
      requestOverride = request;
    },
  };
}

for (const kind of ["signal", "timer", "thread", "roomMention"] as const) {
  test(`${kind} wakeups default to the atomic Host soft-steer admission`, async () => {
    const f = fixture();
    await f.service.start();
    try {
      const room = await f.service.createRoom({
        name: "Team",
        members: [{ name: "Worker", threadId: "target" }],
      });
      await f.service.create({
        threadId: "target",
        label: kind,
        prompt: "Do this",
        kind,
        ...(kind === "signal"
          ? { signalName: "ready" }
          : kind === "timer"
            ? { runAt: 101 }
            : kind === "thread"
              ? { watchedThreadId: "source" }
              : { roomId: room.id, mention: "Worker" }),
      } as any);
      if (kind === "signal") await f.service.signal("ready", "now");
      if (kind === "timer") {
        f.advance();
        f.timers[0]!();
      }
      if (kind === "thread")
        f.emit("turn/completed", {
          threadId: "source",
          turn: { id: "done", status: "completed", items: [], error: null },
        });
      if (kind === "roomMention")
        await f.service.postAgentRoomMessage(
          room.id,
          "@Worker please look",
          undefined,
          "source",
        );
      for (let i = 0; i < 30 && f.calls.length === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 1));
      assert.equal(f.calls[0]?.method, "zen/turn/wake");
      assert.equal(f.calls[0]?.params.mode, undefined);
      assert.equal(
        f.calls[0]?.params.source,
        kind === "roomMention" ? "room" : "trigger",
      );
      assert.ok(f.calls[0]?.params.clientId);
      assert.equal(f.calls[0]?.params.clientUserMessageId, undefined);
      if (kind === "roomMention") {
        assert.match(f.calls[0]?.params.text, /Agent \(agent\)/);
        assert.doesNotMatch(f.calls[0]?.params.text, /Current user message/);
      }
    } finally {
      await f.service.stop();
    }
  });
}

test("Room delivery configuration is independent from other triggers targeting the same Thread", async () => {
  const f = fixture();
  await f.service.start();
  try {
    const room = await f.service.createAssistantRoom({
      name: "PAW",
      members: [{ name: "Helper", threadId: "target" }],
    });
    await f.service.setAssistantDeliveryMode(room.id, "queue");
    await f.service.create({
      threadId: "target",
      label: "event",
      prompt: "event",
      kind: "signal",
      signalName: "ready",
    });
    await f.service.postRoomMessage(room.id, "You", "Room message");
    await f.service.signal("ready", "trigger event");
    assert.equal(f.calls[0]?.params.mode, "queue");
    assert.equal(f.calls[1]?.params.mode, undefined);
    assert.equal(f.saved().rooms[0]?.assistant?.deliveryMode, "queue");
    assert.equal(
      f.service.snapshot().history.find((entry) => entry.kind === "roomMention")
        ?.delivery,
      "queued",
    );
    assert.equal(
      f.service.snapshot().history.find((entry) => entry.kind === "roomMention")
        ?.status,
      "starting",
    );
  } finally {
    await f.service.stop();
  }
});

test("explicit Trigger queue persists only on that Trigger", async () => {
  const f = fixture();
  await f.service.start();
  try {
    await f.service.create({
      threadId: "target",
      label: "queue",
      prompt: "next",
      kind: "signal",
      signalName: "next",
      deliveryMode: "queue",
    });
    await f.service.create({
      threadId: "target",
      label: "now",
      prompt: "now",
      kind: "signal",
      signalName: "now",
    });
    await f.service.signal("next", "event");
    await f.service.signal("now", "event");
    assert.equal(f.calls[0]?.params.mode, "queue");
    assert.equal(f.calls[1]?.params.mode, undefined);
    assert.equal(
      f.saved().triggers.find((trigger) => trigger.label === "queue")
        ?.deliveryMode,
      "queue",
    );
    assert.equal(
      f.saved().triggers.find((trigger) => trigger.label === "now")
        ?.deliveryMode,
      undefined,
    );
  } finally {
    await f.service.stop();
  }
});

for (const deliveryMode of [undefined, "queue"] as const) {
  test(`native-only admission/completion tracks multiple ${deliveryMode ?? "steer"} wakeups in the same Turn`, async () => {
    const f = fixture();
    await f.service.start();
    try {
      for (const name of ["first", "second"])
        await f.service.create({
          threadId: "target",
          label: name,
          prompt: name,
          kind: "signal",
          signalName: name,
          ...(deliveryMode ? { deliveryMode } : {}),
        });
      await f.service.signal("first", "event");
      await f.service.signal("second", "event");
      for (const { params } of f.calls) {
        f.emit("zen/thread/event", {
          threadId: "target",
          processEpoch: "epoch",
          watermark: 1,
          event: {
            type: "item_completed",
            item: {
              type: "host_message",
              id: params.clientId,
              threadId: "target",
              turnId: "active",
              createdAt: 100,
              sender: "host",
              clientId: params.clientId,
              source: params.source,
              sourceId: params.sourceId,
              text: params.text,
              mode: "steer",
            },
          },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(
        f.service
          .snapshot()
          .history.every(
            (entry) =>
              entry.status === "running" && entry.delivery === undefined,
          ),
      );
      f.emit("zen/thread/event", {
        threadId: "target",
        processEpoch: "epoch",
        watermark: 3,
        event: {
          type: "turn_completed",
          threadId: "target",
          turnId: "active",
          status: "completed",
        },
      });
      for (
        let i = 0;
        i < 30 &&
        f.service
          .snapshot()
          .history.some((entry) => entry.status !== "completed");
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 1));
      assert.ok(
        f.service
          .snapshot()
          .history.every(
            (entry) =>
              entry.status === "completed" && entry.delivery === undefined,
          ),
      );
    } finally {
      await f.service.stop();
    }
  });
}

test("several Room messages steered into one Turn produce one automatic ordinary-Room reply", async () => {
  const f = fixture();
  await f.service.start();
  try {
    const room = await f.service.createRoom({
      name: "Team",
      members: [{ name: "Worker", threadId: "target" }],
    });
    await f.service.create({
      threadId: "target",
      kind: "roomMention",
      roomId: room.id,
      mention: "Worker",
      label: "reply",
      prompt: "Respond",
    });
    await f.service.postRoomMessage(room.id, "You", "@Worker first");
    await f.service.postRoomMessage(room.id, "You", "@Worker second");
    f.emit("zen/thread/event", {
      threadId: "target",
      processEpoch: "epoch",
      watermark: 1,
      event: {
        type: "item_completed",
        item: {
          type: "agent_message",
          id: "answer",
          threadId: "target",
          turnId: "active",
          createdAt: 100,
          text: "One combined response",
        },
      },
    });
    f.emit("zen/thread/event", {
      threadId: "target",
      processEpoch: "epoch",
      watermark: 2,
      event: {
        type: "turn_completed",
        threadId: "target",
        turnId: "active",
        status: "completed",
      },
    });
    for (
      let i = 0;
      i < 30 &&
      f.service
        .snapshot()
        .history.some((entry) => entry.status !== "completed");
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(
      f.service
        .snapshot()
        .rooms[0]?.messages.filter((message) => message.kind === "agent")
        .length,
      1,
    );
    assert.ok(
      f.service
        .snapshot()
        .history.every((entry) => entry.status === "completed"),
    );
  } finally {
    await f.service.stop();
  }
});

test("native cancellation releases an explicitly queued wakeup with a visible terminal receipt", async () => {
  const f = fixture();
  await f.service.start();
  try {
    await f.service.create({
      threadId: "target",
      label: "queue",
      prompt: "next",
      kind: "signal",
      signalName: "next",
      deliveryMode: "queue",
    });
    await f.service.signal("next", "event");
    f.emit("zen/thread/event", {
      threadId: "target",
      processEpoch: "epoch",
      watermark: 1,
      event: {
        type: "item_completed",
        item: {
          type: "host_message_cancelled",
          id: "cancel",
          threadId: "target",
          createdAt: 100,
          queuedItemId: "queue",
          clientId: f.calls[0]!.params.clientId,
        },
      },
    });
    for (
      let i = 0;
      i < 30 && f.service.snapshot().history[0]?.status !== "failed";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(f.service.snapshot().history[0]?.status, "failed");
    assert.equal(f.service.snapshot().history[0]?.delivery, "failed");
    assert.match(f.service.snapshot().history[0]?.error ?? "", /cancelled/);
  } finally {
    await f.service.stop();
  }
});

test("a nonmatching predicate completes without inventing pending Host input", async () => {
  const f = fixture();
  await f.service.start();
  try {
    await f.service.create({
      threadId: "target",
      label: "predicate",
      prompt: "respond",
      kind: "signal",
      signalName: "ready",
      program: { match: { field: "completedItemText", regex: "never" } },
    });
    await f.service.signal("ready", "event");
    assert.equal(f.calls.length, 0);
    assert.equal(f.service.snapshot().history[0]?.status, "completed");
    assert.equal(f.service.snapshot().history[0]?.delivery, undefined);
  } finally {
    await f.service.stop();
  }
});

function native(f: ReturnType<typeof fixture>, event: any) {
  f.emit("zen/thread/event", {
    threadId: "target",
    processEpoch: "epoch",
    watermark: 1,
    event,
  });
}
function hostItem(
  f: ReturnType<typeof fixture>,
  type: string,
  clientId: string,
) {
  const request = f.calls.find(
    (call) => call.params.clientId === clientId,
  )!.params;
  return {
    type,
    id: type,
    threadId: "target",
    clientId,
    source: request.source,
    sourceId: request.sourceId,
    text: "queued input",
    createdAt: new Date(100).toISOString(),
    sender: "host",
    ...(type === "host_message"
      ? { turnId: "resumed", mode: "start" }
      : {
          queuedItemId: "host_message_queued",
          intent: "queue",
          deliveryMode: "batch-next",
        }),
  };
}
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 15));
}
async function completeHost(f: ReturnType<typeof fixture>, clientId: string) {
  native(f, {
    type: "item_completed",
    item: hostItem(f, "host_message", clientId),
  });
  native(f, {
    type: "item_completed",
    item: {
      type: "agent_message",
      id: "answer",
      threadId: "target",
      turnId: "resumed",
      text: "Resumed answer",
      createdAt: new Date(101).toISOString(),
    },
  });
  native(f, {
    type: "turn_completed",
    threadId: "target",
    turnId: "resumed",
    status: "completed",
  });
  await flush();
}
for (const order of [
  "queued-first",
  "rejection-first",
  "admitted-first",
  "no-acceptance",
] as const) {
  test(`Host canonical acceptance wins over RPC failure (${order})`, async () => {
    const f = fixture();
    await f.service.start();
    try {
      const room = await f.service.createRoom({
        name: "Team",
        members: [{ name: "Worker", threadId: "target" }],
      });
      await f.service.create({
        kind: "roomMention",
        threadId: "target",
        label: "Room",
        prompt: "answer",
        roomId: room.id,
        mention: "Worker",
        deliveryMode: "queue",
      });
      f.setRequest(async (params) => {
        if (order === "queued-first" || order === "admitted-first")
          native(f, {
            type: "item_completed",
            item: hostItem(f, "host_message_queued", params.clientId),
          });
        if (order === "admitted-first")
          native(f, {
            type: "item_completed",
            item: hostItem(f, "host_message", params.clientId),
          });
        native(f, {
          type: "queue_failed",
          threadId: "target",
          clientId: params.clientId,
          queuedItemId: "host_message_queued",
          attemptId: "attempt",
          code: "operation_forbidden",
          message: "The Thread is archived",
        });
        throw new Error("RPC transport failed");
      });
      await f.service.postRoomMessage(room.id, "You", "@Worker answer");
      await flush();
      const clientId = f.calls[0]!.params.clientId;
      if (order === "no-acceptance" || order === "rejection-first") {
        assert.equal(f.service.snapshot().history[0]?.status, "failed");
        assert.equal(f.service.snapshot().history[0]?.delivery, "unknown");
        if (order === "no-acceptance") return;
        native(f, {
          type: "item_completed",
          item: hostItem(f, "host_message_queued", clientId),
        });
        await flush();
      }
      assert.equal(
        f.service.snapshot().history[0]?.status,
        order === "admitted-first" ? "running" : "starting",
      );
      if (order !== "admitted-first") {
        assert.equal(f.service.snapshot().history[0]?.delivery, "queued");
        assert.ok(f.service.snapshot().history[0]?.error);
      }
      await completeHost(f, clientId);
      await completeHost(f, clientId);
      assert.equal(f.service.snapshot().history[0]?.status, "completed");
      assert.equal(
        f.service
          .snapshot()
          .rooms[0]?.messages.filter((message) => message.kind === "agent")
          .length,
        1,
      );
      assert.equal(f.calls.length, 1);
    } finally {
      await f.service.stop();
    }
  });
}

test("canonical cancellation wins over stale admission events across restart", async () => {
  const f = fixture();
  await f.service.start();
  try {
    await f.service.create({
      kind: "signal",
      threadId: "target",
      label: "queue",
      prompt: "answer",
      signalName: "ready",
      deliveryMode: "queue",
    });
    await f.service.signal("ready", "event");
    const clientId = f.calls[0]!.params.clientId;
    native(f, {
      type: "item_completed",
      item: hostItem(f, "host_message_cancelled", clientId),
    });
    await flush();
    await f.service.stop();
    await f.service.start();
    native(f, {
      type: "item_completed",
      item: hostItem(f, "host_message_queued", clientId),
    });
    native(f, {
      type: "queue_failed",
      threadId: "target",
      clientId,
      queuedItemId: "host_message_queued",
      attemptId: "old",
      code: "operation_forbidden",
      message: "stale failure",
    });
    await completeHost(f, clientId);
    assert.equal(f.service.snapshot().history[0]?.status, "failed");
    assert.equal(f.service.snapshot().history[0]?.delivery, "failed");
    assert.equal(f.service.snapshot().history[0]?.turnId, null);
    assert.match(f.service.snapshot().history[0]?.error ?? "", /cancelled/);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.service.stop();
  }
});

for (const source of ["trigger", "room"] as const) {
  for (const mismatch of ["source", "sourceId"] as const) {
    test(`Host recovery rejects mismatched ${mismatch} for ${source} history`, async () => {
      const f = fixture();
      await f.service.start();
      try {
        const room = await f.service.createRoom({
          name: "Team",
          members: [{ name: "Worker", threadId: "target" }],
        });
        await f.service.create(
          source === "room"
            ? {
                kind: "roomMention",
                threadId: "target",
                label: "Room",
                prompt: "answer",
                roomId: room.id,
                mention: "Worker",
                deliveryMode: "queue",
              }
            : {
                kind: "signal",
                threadId: "target",
                label: "Trigger",
                prompt: "answer",
                signalName: "ready",
                deliveryMode: "queue",
              },
        );
        f.setRequest(async () => {
          throw new Error("RPC outcome unknown");
        });
        if (source === "room")
          await f.service.postRoomMessage(room.id, "You", "@Worker answer");
        else await f.service.signal("ready", "event");
        const clientId = f.calls[0]!.params.clientId;
        for (const type of ["host_message_queued", "host_message"])
          native(f, {
            type: "item_completed",
            item: {
              ...hostItem(f, type, clientId),
              [mismatch]:
                mismatch === "source" ? "bootstrap" : "unrelated-source",
            },
          });
        native(f, {
          type: "item_completed",
          item: {
            type: "agent_message",
            id: "wrong-answer",
            threadId: "target",
            turnId: "resumed",
            text: "Unrelated answer",
            createdAt: new Date(101).toISOString(),
          },
        });
        native(f, {
          type: "turn_completed",
          threadId: "target",
          turnId: "resumed",
          status: "completed",
        });
        await flush();
        assert.equal(f.service.snapshot().history[0]?.delivery, "unknown");
        assert.equal(f.service.snapshot().history[0]?.status, "failed");
        assert.equal(f.service.snapshot().history[0]?.turnId, null);
        assert.equal(
          f.service
            .snapshot()
            .rooms[0]?.messages.filter((message) => message.kind === "agent")
            .length,
          0,
        );
        native(f, {
          type: "item_completed",
          item: hostItem(f, "host_message_queued", clientId),
        });
        await completeHost(f, clientId);
        assert.equal(f.service.snapshot().history[0]?.status, "completed");
        assert.equal(f.calls.length, 1);
      } finally {
        await f.service.stop();
      }
    });
  }
}

function recovered(
  f: ReturnType<typeof fixture>,
  items: any[],
  events: any[] = [],
) {
  return {
    processEpoch: "restarted",
    threadId: "target",
    watermark: 10,
    thread: { id: "target", items, turns: [], archived: false },
    events,
  };
}
async function pendingRoom(f: ReturnType<typeof fixture>) {
  await f.service.start();
  await flush();
  const room = await f.service.createRoom({
    name: "Team",
    members: [{ name: "Worker", threadId: "target" }],
  });
  await f.service.create({
    kind: "roomMention",
    threadId: "target",
    label: "Room",
    prompt: "answer",
    roomId: room.id,
    mention: "Worker",
    deliveryMode: "queue",
  });
  await f.service.postRoomMessage(room.id, "You", "@Worker answer");
  await f.service.stop();
  return f.calls[0]!.params.clientId as string;
}
function recoveredTerminal(f: ReturnType<typeof fixture>, clientId: string) {
  const snapshot = recovered(f, [hostItem(f, "host_message_queued", clientId)]);
  snapshot.events = [
    { type: "item_completed", item: hostItem(f, "host_message", clientId) },
    {
      type: "item_completed",
      item: {
        type: "agent_message",
        id: "recovered-answer",
        threadId: "target",
        turnId: "resumed",
        text: "Recovered answer",
        createdAt: new Date(102).toISOString(),
      },
    },
    {
      type: "turn_completed",
      threadId: "target",
      turnId: "resumed",
      status: "completed",
    },
  ].map((event, index) => ({
    processEpoch: snapshot.processEpoch,
    threadId: "target",
    watermark: index + 8,
    event,
  }));
  return snapshot;
}

test("recovery is read-only, processes barrier tail, and never replays old watchers", async () => {
  const f = fixture();
  const clientId = await pendingRoom(f);
  await f.service.start(false);
  assert.equal(f.recoveryCalls.length, 0);
  // A local watcher must not fire from this historical recovery completion.
  await f.service.create({
    kind: "thread",
    threadId: "other",
    label: "watcher",
    prompt: "never replay",
    watchedThreadId: "target",
  });
  f.setRecovery(async () => recoveredTerminal(f, clientId));
  f.service.resumeWakeups();
  await flush();
  assert.equal(f.service.snapshot().history[0]?.status, "completed");
  assert.equal(
    f.service
      .snapshot()
      .rooms[0]?.messages.filter((message) => message.kind === "agent").length,
    1,
  );
  assert.equal(f.calls.length, 1);
  await f.service.stop();
  await f.service.start();
  await flush();
  assert.equal(f.recoveryCalls.length, 1);
  assert.equal(
    f.service
      .snapshot()
      .rooms[0]?.messages.filter((message) => message.kind === "agent").length,
    1,
  );
  await f.service.stop();
});

for (const boundary of ["suspend", "stop"] as const) {
  test(`late native recovery is fenced across ${boundary} and a new observation epoch`, async () => {
    const f = fixture();
    const clientId = await pendingRoom(f);
    let release!: (value: any) => void;
    f.setRecovery(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const starting = f.service.start();
    await flush();
    const oldListener = f.listeners.at(-1);
    if (boundary === "suspend") f.service.suspendWakeups();
    else await f.service.stop();
    release(recoveredTerminal(f, clientId));
    await starting;
    assert.equal(f.service.snapshot().history[0]?.delivery, "unknown");
    assert.equal(
      f.service
        .snapshot()
        .rooms[0]?.messages.filter((message) => message.kind === "agent")
        .length,
      0,
    );
    if (boundary === "stop") await f.service.start(false);
    f.setRecovery(async () => recoveredTerminal(f, clientId));
    f.service.resumeWakeups();
    oldListener("zen/thread/event", {
      processEpoch: "old",
      threadId: "target",
      watermark: 1,
      event: {
        type: "item_completed",
        item: hostItem(f, "host_message_cancelled", clientId),
      },
    });
    await flush();
    assert.equal(f.service.snapshot().history[0]?.status, "completed");
    assert.equal(
      f.service
        .snapshot()
        .rooms[0]?.messages.filter((message) => message.kind === "agent")
        .length,
      1,
    );
    assert.equal(f.calls.length, 1);
    await f.service.stop();
  });
}

test("failed canonical read is visible and retried only on explicit re-enable", async () => {
  const f = fixture();
  await pendingRoom(f);
  f.setRecovery(async () => {
    throw new Error("native connection unavailable");
  });
  await f.service.start();
  await flush();
  assert.match(
    f.service.snapshot().history[0]?.error ?? "",
    /Could not restore canonical Host observation.*native connection unavailable/,
  );
  await flush();
  f.service.resumeWakeups();
  assert.equal(f.recoveryCalls.length, 1);
  assert.equal(f.calls.length, 1);
  f.service.suspendWakeups();
  f.setRecovery(async () => recovered(f, []));
  f.service.resumeWakeups();
  await flush();
  assert.equal(f.recoveryCalls.length, 2);
  assert.equal(f.service.snapshot().history[0]?.delivery, "unknown");
  assert.match(
    f.service.snapshot().history[0]?.error ?? "",
    /No matching canonical Host receipt/,
  );
  await f.service.stop();
});

for (const mismatch of [
  "source",
  "sourceId",
  "clientId",
  "threadId",
] as const) {
  test(`canonical recovery snapshot rejects wrong ${mismatch}`, async () => {
    const f = fixture();
    const clientId = await pendingRoom(f);
    const bad = hostItem(f, "host_message", clientId);
    f.setRecovery(async () =>
      recovered(f, [
        { ...bad, [mismatch]: mismatch === "source" ? "bootstrap" : "wrong" },
      ]),
    );
    await f.service.start();
    await flush();
    await flush();
    assert.equal(f.service.snapshot().history[0]?.delivery, "unknown");
    assert.equal(f.service.snapshot().history[0]?.turnId, null);
    assert.equal(
      f.service
        .snapshot()
        .rooms[0]?.messages.filter((message) => message.kind === "agent")
        .length,
      0,
    );
    assert.equal(f.calls.length, 1);
    await f.service.stop();
  });
}

test("cancelled canonical recovery snapshot never resurrects the queued identity", async () => {
  const f = fixture();
  const clientId = await pendingRoom(f);
  f.setRecovery(async () =>
    recovered(f, [
      hostItem(f, "host_message_queued", clientId),
      hostItem(f, "host_message_cancelled", clientId),
    ]),
  );
  await f.service.start();
  await flush();
  assert.equal(f.service.snapshot().history[0]?.delivery, "failed");
  await completeHost(f, clientId);
  assert.equal(f.service.snapshot().history[0]?.status, "failed");
  assert.equal(
    f.service
      .snapshot()
      .rooms[0]?.messages.filter((message) => message.kind === "agent").length,
    0,
  );
  assert.equal(f.calls.length, 1);
  await f.service.stop();
});

test("hung canonical recovery never blocks startup, shutdown or a replacement generation", async () => {
  const f = fixture();
  const clientId = await pendingRoom(f);
  let release!: (value: any) => void;
  f.setRecovery(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const within = <T>(operation: Promise<T>) =>
    Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Lifecycle blocked by recovery")),
          250,
        );
        timer.unref();
      }),
    ]);
  await within(f.service.start());
  assert.equal(f.recoveryCalls.length, 1);
  await within(f.service.stop());
  await within(f.service.start(false));
  release(recoveredTerminal(f, clientId));
  await flush();
  assert.equal(f.service.snapshot().history[0]?.delivery, "unknown");
  assert.equal(
    f.service
      .snapshot()
      .rooms[0]?.messages.filter((message) => message.kind === "agent").length,
    0,
  );
  assert.equal(f.calls.length, 1);
  await f.service.stop();
});

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("recovered running identity observes native completion while its history write is held", async () => {
  const f = fixture();
  const clientId = await pendingRoom(f);
  const host = hostItem(f, "host_message", clientId);
  const earlier = {
    type: "agent_message",
    id: "earlier",
    threadId: "target",
    turnId: "resumed",
    text: "Earlier answer",
    createdAt: new Date(101).toISOString(),
  };
  const snapshot: any = recovered(f, [host, earlier]);
  snapshot.thread.turns = [{ id: "resumed", status: "inProgress" }];
  f.setRecovery(async () => snapshot);
  const writing = gate();
  const release = gate();
  let held = false;
  f.setBeforeWrite(async (value) => {
    if (!held && value.history[0]?.status === "running") {
      held = true;
      writing.resolve();
      await release.promise;
    }
  });
  try {
    await f.service.start();
    await writing.promise;
    native(f, {
      type: "item_completed",
      item: { ...earlier, id: "latest", text: "Latest live answer" },
    });
    native(f, {
      type: "turn_completed",
      threadId: "target",
      turnId: "resumed",
      status: "completed",
    });
    await flush();
    release.resolve();
    await flush();
    assert.equal(f.service.snapshot().history[0]?.status, "completed");
    assert.equal(f.service.snapshot().history[0]?.turnId, "resumed");
    const replies = f.service
      .snapshot()
      .rooms[0]!.messages.filter((message) => message.kind === "agent");
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.text, "Latest live answer");
    native(f, {
      type: "turn_completed",
      threadId: "target",
      turnId: "resumed",
      status: "completed",
    });
    await flush();
    assert.equal(
      f.service
        .snapshot()
        .rooms[0]!.messages.filter((message) => message.kind === "agent")
        .length,
      1,
    );
    assert.equal(f.calls.length, 1);
  } finally {
    release.resolve();
    await f.service.stop();
  }
});

for (const outcome of [
  "completed",
  "duplicate",
  "cancelled",
  "overflow",
  "overflow-count",
  "wrong-source",
] as const) {
  test(`recovery captures synchronous response-to-continuation events (${outcome})`, async () => {
    const f = fixture();
    const clientId = await pendingRoom(f);
    const admitted = hostItem(f, "host_message", clientId);
    const snapshot: any = recovered(f, [
      hostItem(f, "host_message_queued", clientId),
      ...(outcome === "cancelled" ? [] : [admitted]),
    ]);
    snapshot.thread.turns =
      outcome === "cancelled" ? [] : [{ id: "resumed", status: "inProgress" }];
    if (outcome === "wrong-source") {
      for (const item of snapshot.thread.items) item.source = "bootstrap";
    }
    if (outcome === "duplicate") {
      const answer = {
        type: "agent_message",
        id: "same-chunk",
        threadId: "target",
        turnId: "resumed",
        text: "After resolve",
        createdAt: new Date(102).toISOString(),
      };
      snapshot.thread.items.push(answer);
      snapshot.events.push(
        ...[
          { type: "item_completed", item: answer },
          {
            type: "turn_completed",
            threadId: "target",
            turnId: "resumed",
            status: "completed",
          },
        ].map((event) => ({
          processEpoch: snapshot.processEpoch,
          threadId: "target",
          watermark: 11,
          event,
        })),
      );
    }
    const emit = (event: any) =>
      f.emit("zen/thread/event", {
        processEpoch: snapshot.processEpoch,
        threadId: "target",
        watermark: 11,
        event,
      });
    f.setRecovery(
      () =>
        new Promise((resolve) => {
          resolve(snapshot);
          // The request promise resolves before these same-chunk notifications;
          // the recovering await continuation has not had a chance to run yet.
          if (outcome === "cancelled")
            emit({
              type: "item_completed",
              item: hostItem(f, "host_message_cancelled", clientId),
            });
          else if (outcome === "overflow-count") {
            for (let i = 0; i < 257; i++)
              emit({
                type: "item_completed",
                item: {
                  type: "agent_message",
                  id: `overflow-${i}`,
                  threadId: "target",
                  turnId: "resumed",
                  text: "a",
                  createdAt: new Date(102).toISOString(),
                },
              });
          } else if (outcome === "overflow")
            emit({
              type: "item_completed",
              item: {
                type: "agent_message",
                id: "oversized",
                threadId: "target",
                turnId: "resumed",
                text: "x".repeat(1_048_577),
                createdAt: new Date(102).toISOString(),
              },
            });
          else {
            emit({
              type: "item_completed",
              item: {
                type: "agent_message",
                id: "same-chunk",
                threadId: "target",
                turnId: "resumed",
                text: "After resolve",
                createdAt: new Date(102).toISOString(),
              },
            });
            emit({
              type: "turn_completed",
              threadId: "target",
              turnId: "resumed",
              status: "completed",
            });
          }
        }),
    );
    try {
      await f.service.start();
      await flush();
      if (outcome === "completed" || outcome === "duplicate") {
        assert.equal(f.service.snapshot().history[0]?.status, "completed");
        assert.equal(
          f.service
            .snapshot()
            .rooms[0]?.messages.filter((message) => message.kind === "agent")
            .length,
          1,
        );
        assert.equal(
          f.service.snapshot().rooms[0]?.messages.at(-1)?.text,
          "After resolve",
        );
      } else {
        assert.equal(
          f.service.snapshot().history[0]?.delivery,
          outcome === "cancelled" ? "failed" : "unknown",
        );
        assert.equal(
          f.service
            .snapshot()
            .rooms[0]?.messages.filter((message) => message.kind === "agent")
            .length,
          0,
        );
        assert.match(
          f.service.snapshot().history[0]?.error ?? "",
          outcome === "cancelled"
            ? /cancelled/
            : outcome === "wrong-source"
              ? /No matching canonical/
              : /exceeded its bound/,
        );
      }
      assert.equal(f.calls.length, 1);
    } finally {
      await f.service.stop();
    }
  });
}

for (const boundary of ["cancel", "stop"] as const) {
  test(`recovery projection held write respects concurrent ${boundary}`, async () => {
    const f = fixture();
    const clientId = await pendingRoom(f);
    const snapshot: any = recovered(f, [
      hostItem(f, "host_message_queued", clientId),
      ...(boundary === "stop" ? [hostItem(f, "host_message", clientId)] : []),
    ]);
    snapshot.thread.turns =
      boundary === "stop" ? [{ id: "resumed", status: "inProgress" }] : [];
    f.setRecovery(async () => snapshot);
    const writing = gate(),
      release = gate();
    let held = false;
    f.setBeforeWrite(async (value) => {
      if (
        !held &&
        value.history[0]?.status ===
          (boundary === "stop" ? "running" : "starting")
      ) {
        held = true;
        writing.resolve();
        await release.promise;
      }
    });
    try {
      await f.service.start();
      await writing.promise;
      const stopping = boundary === "stop" ? f.service.stop() : undefined;
      if (boundary === "cancel")
        native(f, {
          type: "item_completed",
          item: hostItem(f, "host_message_cancelled", clientId),
        });
      else {
        native(f, {
          type: "item_completed",
          item: {
            type: "agent_message",
            id: "late",
            threadId: "target",
            turnId: "resumed",
            text: "Late answer",
            createdAt: new Date(102).toISOString(),
          },
        });
        native(f, {
          type: "turn_completed",
          threadId: "target",
          turnId: "resumed",
          status: "completed",
        });
      }
      release.resolve();
      await stopping;
      await flush();
      assert.equal(
        f.service.snapshot().history[0]?.delivery,
        boundary === "cancel" ? "failed" : "unknown",
      );
      assert.equal(
        f.service
          .snapshot()
          .rooms[0]?.messages.filter((message) => message.kind === "agent")
          .length,
        0,
      );
      if (boundary === "cancel") {
        await completeHost(f, clientId);
        assert.equal(f.service.snapshot().history[0]?.delivery, "failed");
      }
      assert.equal(f.calls.length, 1);
    } finally {
      release.resolve();
      await f.service.stop();
    }
  });
}
