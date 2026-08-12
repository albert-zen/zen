import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AppServerManager } from "../src/main/app-server-manager.js";
import {
  projectCompletedTurn,
  ZenXTriggerService,
  type ZenXTriggerAppServerPort,
} from "../src/main/trigger-service.js";
import type {
  TriggerProgramRunInput,
  TriggerProgramRunResult,
  TriggerProgramRunner,
} from "../src/main/trigger-program-runner.js";
import { ZenXTriggerStore } from "../src/main/trigger-store.js";
import type {
  ClientRequestParams,
  ClientRequestResults,
  ServerNotificationMethod,
  ServerNotificationParams,
  ThreadItem,
  Turn,
} from "../src/protocol-client/index.js";
import type { TriggerSnapshot } from "../src/main/trigger-types.js";

test("timer expiry creates one explicit App Server turn and auditable history", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-trigger-"));
  const manager = managerFor(directory);
  try {
    await manager.start();
    const thread = (await manager.request("thread/start", {})).thread;
    const triggers = new ZenXTriggerService(
      manager,
      new ZenXTriggerStore(path.join(directory, "triggers.json")),
    );
    await triggers.start();
    await triggers.create({
      threadId: thread.id,
      kind: "timer",
      label: "Heartbeat",
      prompt: "Inspect the release and report only risks.",
      runAt: Date.now() + 40,
    });
    const completed = await snapshotWhen(
      triggers,
      (snapshot) => snapshot.history[0]?.status === "completed",
    );
    const entry = completed.history[0];
    assert.equal(entry?.kind, "timer");
    assert.equal(entry?.error, null);
    const read = await manager.request("thread/read", {
      threadId: thread.id,
      includeTurns: true,
    });
    const wakeup = read.thread.turns
      .flatMap((turn) => turn.items)
      .find(
        (item) =>
          item.type === "userMessage" &&
          item.clientId === entry?.clientUserMessageId,
      );
    assert.equal(wakeup?.type, "userMessage");
    if (wakeup?.type === "userMessage")
      assert.match(
        wakeup.content[0]?.text ?? "",
        /\[ZenX trigger wakeup\].*Injected prompt/su,
      );
    await triggers.stop();
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("thread snapshots and two-member Room context route through target Threads", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-routing-"));
  const manager = managerFor(directory);
  try {
    await manager.start();
    const source = (await manager.request("thread/start", {})).thread;
    const monitor = (await manager.request("thread/start", {})).thread;
    const reviewer = (await manager.request("thread/start", {})).thread;
    const triggers = new ZenXTriggerService(
      manager,
      new ZenXTriggerStore(path.join(directory, "triggers.json")),
    );
    await triggers.start();
    const room = await triggers.createRoom({
      name: "release",
      members: [
        { name: "Monitor", threadId: monitor.id },
        { name: "Reviewer", threadId: reviewer.id },
      ],
    });
    await triggers.create({
      threadId: monitor.id,
      kind: "thread",
      label: "Review source",
      prompt: "Review the completed turn.",
      watchedThreadId: source.id,
    });
    await triggers.create({
      threadId: monitor.id,
      kind: "roomMention",
      label: "Answer Room",
      prompt: "Answer the Room question.",
      roomId: room.id,
      mention: "Monitor",
    });
    await triggers.create({
      threadId: reviewer.id,
      kind: "roomMention",
      label: "Review Room",
      prompt: "Review the Room question.",
      roomId: room.id,
      mention: "Reviewer",
    });
    await triggers.create({
      threadId: monitor.id,
      kind: "signal",
      label: "Deploy signal",
      prompt: "Inspect the deploy signal.",
      signalName: "deploy",
    });
    await manager.request("turn/start", {
      threadId: source.id,
      input: [{ type: "text", text: "source work" }],
    });
    await snapshotWhen(triggers, (snapshot) =>
      snapshot.history.some(
        (entry) => entry.kind === "thread" && entry.status === "completed",
      ),
    );
    await triggers.postRoomMessage(
      room.id,
      "You",
      "Release 42 is waiting on the database migration.",
    );
    await triggers.postRoomMessage(
      room.id,
      "You",
      "@Monitor @Reviewer status?",
    );
    await snapshotWhen(
      triggers,
      (snapshot) =>
        snapshot.history.filter(
          (entry) =>
            entry.kind === "roomMention" && entry.status === "completed",
        ).length === 2,
    );
    await triggers.signal("deploy", "production completed");
    const final = await snapshotWhen(triggers, (snapshot) =>
      snapshot.history.some(
        (entry) => entry.kind === "signal" && entry.status === "completed",
      ),
    );
    assert(
      final.rooms[0]?.messages.some(
        (message) =>
          message.kind === "agent" && message.originThreadId === monitor.id,
      ),
    );
    const monitorRead = await manager.request("thread/read", {
      threadId: monitor.id,
      includeTurns: true,
    });
    const reviewerRead = await manager.request("thread/read", {
      threadId: reviewer.id,
      includeTurns: true,
    });
    assert.equal(monitorRead.thread.turns.length, 3);
    assert.equal(reviewerRead.thread.turns.length, 1);

    const threadWakeup = final.history.find((entry) => entry.kind === "thread");
    assert.equal(threadWakeup?.sourceThreadId, source.id);
    assert(threadWakeup?.sourceTurnId);
    const threadInput = userInputForClientId(
      monitorRead.thread.turns,
      threadWakeup?.clientUserMessageId,
    );
    assert.match(threadInput, /Bounded source context/u);
    assert.match(threadInput, /User input:\nsource work/u);
    assert.match(threadInput, /Agent conclusion:/u);

    for (const [read, member] of [
      [monitorRead, "Monitor"],
      [reviewerRead, "Reviewer"],
    ] as const) {
      const history = final.history.find(
        (entry) =>
          entry.kind === "roomMention" && entry.threadId === read.thread.id,
      );
      assert.equal(history?.sourceRoomId, room.id);
      const input = userInputForClientId(
        read.thread.turns,
        history?.clientUserMessageId,
      );
      assert.match(input, /Release 42 is waiting on the database migration/u);
      assert.match(input, new RegExp(`@Monitor @Reviewer status\\?`, "u"));
      assert.match(
        input,
        new RegExp(`Registered trigger: .*Room|${member}`, "u"),
      );
    }
    await triggers.stop();
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit cyclic relay is stable, sourceful, auditable, and stops after cancel", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-relay-"));
  const manager = new ControlledManager();
  const triggers = new ZenXTriggerService(
    manager,
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
  );
  try {
    await triggers.start();
    const aWatchesB = await triggers.create({
      threadId: "thread-a",
      kind: "thread",
      label: "A reviews B",
      prompt: "Continue B's work.",
      watchedThreadId: "thread-b",
    });
    await triggers.create({
      threadId: "thread-b",
      kind: "thread",
      label: "B reviews A",
      prompt: "Continue A's work.",
      watchedThreadId: "thread-a",
    });

    manager.complete("thread-b", completedTurn("source-b-1", "first brief"));
    const first = await snapshotWhen(
      triggers,
      (snapshot) => snapshot.history[0]?.status === "running",
    );
    const firstRelay = first.history[0];
    assert.equal(firstRelay?.triggerId, aWatchesB.id);
    assert.equal(firstRelay?.sourceThreadId, "thread-b");
    assert.equal(firstRelay?.sourceTurnId, "source-b-1");
    assert.match(firstRelay?.clientUserMessageId ?? "", /^zenx-wakeup:/u);
    assert.match(manager.requests[0]?.input[0]?.text ?? "", /first brief/u);

    manager.complete("thread-b", completedTurn("source-b-1", "first brief"));
    await settle();
    assert.equal(triggers.snapshot().history.length, 1);
    assert.equal(manager.requests.length, 1);

    manager.complete(
      "thread-a",
      completedTurn(firstRelay?.turnId ?? "missing", "A conclusion"),
    );
    const second = await snapshotWhen(
      triggers,
      (snapshot) =>
        snapshot.history.length === 2 &&
        snapshot.history[0]?.status === "running",
    );
    const returnRelay = second.history[0];
    assert.equal(returnRelay?.sourceThreadId, "thread-a");
    assert.equal(returnRelay?.sourceTurnId, firstRelay?.turnId);
    assert.notEqual(
      returnRelay?.clientUserMessageId,
      firstRelay?.clientUserMessageId,
    );

    await triggers.cancel(aWatchesB.id);
    manager.complete("thread-b", completedTurn("source-b-2", "after cancel"));
    await settle();
    assert.equal(triggers.snapshot().history.length, 2);
    assert.equal(manager.requests.length, 2);
  } finally {
    await triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("self-watch remains an explicit supported relay", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-self-relay-"));
  const manager = new ControlledManager();
  const triggers = new ZenXTriggerService(
    manager,
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
  );
  try {
    await triggers.start();
    await triggers.create({
      threadId: "thread-a",
      kind: "thread",
      label: "Continue myself",
      prompt: "Perform the next bounded step.",
      watchedThreadId: "thread-a",
    });
    manager.complete("thread-a", completedTurn("self-source", "step one"));
    const snapshot = await snapshotWhen(
      triggers,
      (value) => value.history[0]?.status === "running",
    );
    assert.equal(snapshot.history[0]?.sourceThreadId, "thread-a");
    assert.equal(manager.requests[0]?.threadId, "thread-a");
  } finally {
    await triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Room membership enforces unique names and Threads and supports add/remove", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-room-members-"));
  const manager = new ControlledManager();
  const triggers = new ZenXTriggerService(
    manager,
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
  );
  try {
    await triggers.start();
    await assert.rejects(
      async () =>
        await triggers.createRoom({
          name: "invalid",
          members: [
            { name: "Monitor", threadId: "thread-a" },
            { name: "monitor", threadId: "thread-b" },
          ],
        }),
      /name .* already in use/u,
    );
    const room = await triggers.createRoom({
      name: "release",
      members: [{ name: "Monitor", threadId: "thread-a" }],
    });
    await assert.rejects(
      async () =>
        await triggers.addRoomMember(room.id, {
          name: "Reviewer",
          threadId: "thread-a",
        }),
      /already a Room member/u,
    );
    await triggers.addRoomMember(room.id, {
      name: "Reviewer",
      threadId: "thread-b",
    });
    assert.deepEqual(
      triggers.snapshot().rooms[0]?.members.map((member) => member.name),
      ["Monitor", "Reviewer"],
    );
    await triggers.removeRoomMember(room.id, "thread-a");
    assert.deepEqual(triggers.snapshot().rooms[0]?.members, [
      { name: "Reviewer", threadId: "thread-b" },
    ]);
  } finally {
    await triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed relay is terminal and is not hidden, queued, or retried", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-relay-fail-"));
  const manager = new ControlledManager();
  manager.requestError = new Error("target unavailable");
  const triggers = new ZenXTriggerService(
    manager,
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
  );
  try {
    await triggers.start();
    await triggers.create({
      threadId: "thread-target",
      kind: "thread",
      label: "Relay",
      prompt: "Review once.",
      watchedThreadId: "thread-source",
    });
    manager.complete("thread-source", completedTurn("source-failure", "work"));
    const failed = await snapshotWhen(
      triggers,
      (snapshot) => snapshot.history[0]?.status === "failed",
    );
    assert.equal(failed.history[0]?.error, "target unavailable");
    await settle();
    assert.equal(manager.requests.length, 1);
    assert.equal(triggers.snapshot().history.length, 1);
  } finally {
    await triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("admits exactly 64 nonterminal wakeups, rejects the 65th, then frees one slot on terminal completion", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-admission-"));
  const manager = new ControlledManager();
  const triggers = new ZenXTriggerService(
    manager,
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
  );
  try {
    await triggers.start();
    await triggers.create({
      threadId: "target",
      kind: "signal",
      label: "Admission",
      prompt: "Run once.",
      signalName: "wake",
    });
    for (let index = 0; index < 64; index++)
      await triggers.signal("wake", String(index));
    await settle();
    assert.equal(manager.requests.length, 64);
    await triggers.signal("wake", "65");
    const rejected = triggers
      .snapshot()
      .history.find((entry) => entry.reason.endsWith(": 65"));
    assert.equal(manager.requests.length, 64);
    assert.equal(rejected?.status, "failed");
    assert.match(rejected?.error ?? "", /64 nonterminal/u);
    const first = triggers
      .snapshot()
      .history.find((entry) => entry.status === "running");
    assert(first?.turnId);
    manager.complete("target", completedTurn(first.turnId, "release"));
    await snapshotWhen(triggers, (snapshot) =>
      snapshot.history.some(
        (entry) => entry.id === first.id && entry.status === "completed",
      ),
    );
    await triggers.signal("wake", "66");
    await settle();
    assert.equal(manager.requests.length, 65);
  } finally {
    await triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("completedItemText matching does not inspect signal or timer projections", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-match-field-"));
  const manager = new ControlledManager();
  let now = 1_000;
  const scheduled: Array<() => void> = [];
  const triggers = new ZenXTriggerService(
    manager,
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
    {
      now: () => now,
      schedule: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      cancelScheduled: () => undefined,
    },
  );
  try {
    await triggers.start();
    await triggers.create({
      threadId: "target",
      kind: "signal",
      label: "Signal predicate",
      prompt: "Must not run from signal projection.",
      signalName: "probe",
      program: {
        match: { field: "completedItemText", regex: "Signal detail" },
      },
    });
    await triggers.create({
      threadId: "target",
      kind: "timer",
      label: "Timer predicate",
      prompt: "Must not run from timer projection.",
      runAt: now + 10,
      program: {
        match: { field: "completedItemText", regex: "Signal detail" },
      },
    });
    await triggers.signal("probe", "Signal detail");
    await snapshotWhen(
      triggers,
      (snapshot) => snapshot.history[0]?.status === "completed",
    );
    assert.equal(manager.requests.length, 0);
    now += 10;
    scheduled.at(-1)?.();
    const completed = await snapshotWhen(
      triggers,
      (snapshot) =>
        snapshot.history.length === 2 &&
        snapshot.history.every((entry) => entry.status === "completed"),
    );
    assert.equal(manager.requests.length, 0);
    assert.deepEqual(
      completed.history.map((entry) => entry.programOutcome?.status),
      ["non_match", "non_match"],
    );
  } finally {
    await triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("completedItemText only matches the selected completed Agent Item", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-match-item-"));
  const manager = new ControlledManager();
  const triggers = new ZenXTriggerService(
    manager,
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
  );
  try {
    await triggers.start();
    const source = await triggers.createRoom({
      name: "source",
      members: [{ name: "Bot", threadId: "target" }],
    });
    await triggers.create({
      threadId: "target",
      kind: "roomMention",
      label: "Room predicate",
      prompt: "Must not match the Room source text.",
      roomId: source.id,
      mention: "Bot",
      program: {
        match: { field: "completedItemText", regex: "go" },
      },
    });
    await triggers.create({
      threadId: "target",
      kind: "thread",
      label: "Thread predicate",
      prompt: "Must inspect only the final Agent Item.",
      watchedThreadId: "source-thread",
      program: {
        match: { field: "completedItemText", regex: "go" },
      },
    });
    await triggers.postRoomMessage(source.id, "You", "@Bot go");
    await snapshotWhen(triggers, (snapshot) =>
      snapshot.history.some(
        (entry) => entry.kind === "roomMention" && entry.status === "completed",
      ),
    );
    const sourceTurn = completedTurn("source-turn", "go", [
      {
        type: "commandExecution",
        id: "command-go",
        pluginId: null,
        scriptPath: null,
        command: "echo go",
        cwd: "/workspace",
        processId: null,
        source: "agent",
        status: "completed",
        commandActions: [],
        aggregatedOutput: "go",
        exitCode: 0,
        durationMs: null,
      },
    ]);
    const answer = sourceTurn.items.find(
      (item): item is Extract<ThreadItem, { type: "agentMessage" }> =>
        item.type === "agentMessage",
    );
    assert(answer);
    answer.text = "finished";
    manager.complete("source-thread", sourceTurn);
    const finished = await snapshotWhen(
      triggers,
      (snapshot) =>
        snapshot.history.filter((entry) => entry.kind === "thread").length ===
          1 &&
        snapshot.history.some(
          (entry) => entry.kind === "thread" && entry.status === "completed",
        ),
    );
    assert.equal(manager.requests.length, 0);
    assert.equal(
      finished.history.find((entry) => entry.kind === "roomMention")
        ?.programOutcome?.status,
      "non_match",
    );
    assert.equal(
      finished.history.find((entry) => entry.kind === "thread")?.status,
      "completed",
    );
  } finally {
    await triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Unicode completion replies stay byte-bounded and persistence failures release the wakeup", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-unicode-complete-"),
  );
  const manager = new ControlledManager();
  const store = new FailTerminalWriteStore(
    path.join(directory, "triggers.json"),
  );
  const triggers = new ZenXTriggerService(manager, store);
  try {
    await triggers.start();
    const room = await triggers.createRoom({
      name: "release",
      members: [{ name: "Bot", threadId: "target" }],
    });
    await triggers.create({
      threadId: "target",
      kind: "roomMention",
      label: "Unicode reply",
      prompt: "Answer once.",
      roomId: room.id,
      mention: "Bot",
    });
    await triggers.postRoomMessage(room.id, "You", "@Bot status?");
    const running = await snapshotWhen(
      triggers,
      (snapshot) => snapshot.history[0]?.status === "running",
    );
    const answer = "a".repeat(7_975) + "😀" + "trailing text";
    const completed = completedTurn(running.history[0]!.turnId!, "status?");
    const agent = completed.items.find(
      (item): item is Extract<ThreadItem, { type: "agentMessage" }> =>
        item.type === "agentMessage",
    );
    assert(agent);
    agent.text = answer;
    store.failNextTerminalWrite = true;
    manager.complete("target", completed);
    const failed = await snapshotWhen(
      triggers,
      (snapshot) => snapshot.history[0]?.status === "failed",
    );
    assert.equal(failed.history[0]?.programInvocationId, null);
    assert.match(failed.history[0]?.error ?? "", /could not be persisted/u);
    await triggers.postRoomMessage(room.id, "You", "@Bot again");
    const secondRunning = await snapshotWhen(
      triggers,
      (snapshot) =>
        snapshot.history.filter((entry) => entry.kind === "roomMention")
          .length === 2 && snapshot.history[0]?.status === "running",
    );
    const second = completedTurn(secondRunning.history[0]!.turnId!, "again");
    const secondAgent = second.items.find(
      (item): item is Extract<ThreadItem, { type: "agentMessage" }> =>
        item.type === "agentMessage",
    );
    assert(secondAgent);
    secondAgent.text = answer;
    manager.complete("target", second);
    await snapshotWhen(
      triggers,
      (snapshot) =>
        snapshot.history[0]?.status === "completed" &&
        snapshot.rooms[0]?.messages.some(
          (message) => message.kind === "agent",
        ) === true,
    );
    const roomReply = triggers
      .snapshot()
      .rooms[0]?.messages.find((message) => message.kind === "agent");
    assert(roomReply);
    assert(Buffer.byteLength(roomReply.text, "utf8") <= 8_000);
    assert(!roomReply.text.includes("\uFFFD"));
    assert.equal(manager.requests.length, 2);
    const signalDetail = "x".repeat(3_990) + "😀";
    await triggers.create({
      threadId: "target",
      kind: "signal",
      label: "Unicode signal",
      prompt: "No dispatch needed.",
      signalName: "unicode",
    });
    await triggers.signal("unicode", signalDetail);
    const signalHistory = triggers
      .snapshot()
      .history.find((entry) => entry.kind === "signal");
    assert(signalHistory);
    assert(Buffer.byteLength(signalHistory.reason, "utf8") <= 4_000);
    assert(!signalHistory.reason.includes("\uFFFD"));
  } finally {
    await triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Unicode program output and errors are bounded without replacement characters", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-unicode-program-"),
  );
  const manager = new ControlledManager();
  const runner = new UnicodeProgramRunner();
  const triggers = new ZenXTriggerService(
    manager,
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
    { programs: runner },
  );
  try {
    await triggers.start();
    await triggers.create({
      threadId: "target",
      kind: "signal",
      label: "Unicode program",
      prompt: "Run bounded local work.",
      signalName: "unicode-program",
      program: { action: { command: "fixture" } },
    });
    await triggers.signal("unicode-program", "run");
    const failed = await snapshotWhen(
      triggers,
      (snapshot) => snapshot.history[0]?.status === "failed",
    );
    const outcome = failed.history[0]?.programOutcome;
    assert(outcome);
    assert(Buffer.byteLength(outcome.output ?? "", "utf8") <= 8_000);
    assert(Buffer.byteLength(outcome.error ?? "", "utf8") <= 4_000);
    assert(!outcome.output?.includes("\uFFFD"));
    assert(!outcome.error?.includes("\uFFFD"));
  } finally {
    await triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical Trigger history and Room messages use bounded retention", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-retention-"));
  const manager = new ControlledManager();
  const triggers = new ZenXTriggerService(
    manager,
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
  );
  try {
    await triggers.start();
    await triggers.create({
      threadId: "target",
      kind: "signal",
      label: "Bounded",
      prompt: "Keep the audit bounded.",
      signalName: "bounded",
    });
    for (let index = 0; index < 65; index++)
      await triggers.signal("bounded", String(index));
    const admission = triggers.snapshot();
    assert.equal(
      admission.history.filter((entry) => entry.status === "failed").length,
      1,
    );
    assert.match(admission.history[0]?.error ?? "", /64 nonterminal/u);
    for (let index = 65; index < 300; index++)
      await triggers.signal("bounded", String(index));
    assert.equal(triggers.snapshot().history.length, 256);

    const room = await triggers.createRoom({
      name: "bounded-room",
      members: [{ name: "Bot", threadId: "target" }],
    });
    for (let index = 0; index < 300; index++)
      await triggers.postRoomMessage(
        room.id,
        "Human",
        `message-${String(index)}`,
      );
    const roomSnapshot = triggers.snapshot();
    assert.equal(roomSnapshot.rooms[0]?.messages.length, 256);
    assert.equal(roomSnapshot.rooms[0]?.messages.at(-1)?.text, "message-299");
  } finally {
    await triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("early completion requires exact thread and client correlation and is applied once", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-early-completion-"),
  );
  const manager = new EarlyCompletionManager();
  const triggers = new ZenXTriggerService(
    manager,
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
  );
  try {
    await triggers.start();
    await triggers.create({
      threadId: "target",
      kind: "signal",
      label: "Early",
      prompt: "Complete once.",
      signalName: "wake",
    });
    await triggers.signal("wake", "early");
    const completed = await snapshotWhen(
      triggers,
      (snapshot) => snapshot.history[0]?.status === "completed",
    );
    assert.equal(completed.history.length, 1);
    assert.equal(manager.requests.length, 1);
    assert.equal(manager.completions.length, 1);
    manager.emitLate({
      threadId: "other",
      turn: completedTurn("same-turn", "wrong thread"),
    });
    manager.emitLate({
      threadId: "target",
      turn: completedTurn("different-turn", "late"),
    });
    await settle();
    assert.equal(triggers.snapshot().history.length, 1);
    assert.equal(triggers.snapshot().history[0]?.status, "completed");
  } finally {
    await triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("zero and conflicting early completion evidence stays rejected until the owned Turn completes", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-early-evidence-"),
  );
  const manager = new EarlyEvidenceManager();
  const triggers = new ZenXTriggerService(
    manager,
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
  );
  try {
    await triggers.start();
    await triggers.create({
      threadId: "target",
      kind: "signal",
      label: "Evidence",
      prompt: "Complete only with owned evidence.",
      signalName: "wake",
    });
    await triggers.signal("wake", "zero");
    await triggers.signal("wake", "conflict");
    const running = await snapshotWhen(
      triggers,
      (snapshot) =>
        snapshot.history.filter((entry) => entry.status === "running")
          .length === 2,
    );
    assert.equal(manager.requests.length, 2);
    assert.equal(
      running.history.filter((entry) => entry.status === "completed").length,
      0,
    );
    for (const entry of running.history) {
      assert(entry.turnId);
      manager.complete("target", completedTurn(entry.turnId, "owned"));
    }
    const completed = await snapshotWhen(
      triggers,
      (snapshot) =>
        snapshot.history.filter((entry) => entry.status === "completed")
          .length === 2,
    );
    assert.equal(completed.history.length, 2);
  } finally {
    await triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Room deletion is fenced by a nonterminal immutable reply route", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-room-delete-fence-"),
  );
  const manager = new ControlledManager();
  const triggers = new ZenXTriggerService(
    manager,
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
  );
  try {
    await triggers.start();
    const room = await triggers.createRoom({
      name: "release",
      members: [{ name: "Bot", threadId: "target" }],
    });
    const trigger = await triggers.create({
      threadId: "target",
      kind: "roomMention",
      label: "Answer",
      prompt: "Answer the Room.",
      roomId: room.id,
      mention: "Bot",
    });
    await triggers.postRoomMessage(room.id, "You", "@Bot status?");
    const running = await snapshotWhen(
      triggers,
      (snapshot) => snapshot.history[0]?.status === "running",
    );
    await assert.rejects(
      async () => await triggers.deleteRoom(room.id),
      /nonterminal wakeup owns/u,
    );
    await triggers.update({
      id: trigger.id,
      threadId: "target",
      kind: "signal",
      label: "Updated",
      prompt: "Updated.",
      signalName: "unused",
    });
    manager.complete(
      "target",
      completedTurn(running.history[0]!.turnId!, "answer"),
    );
    await snapshotWhen(
      triggers,
      (snapshot) => snapshot.history[0]?.status === "completed",
    );
    assert.equal(triggers.snapshot().rooms[0]?.messages.at(-1)?.author, "Bot");
    await triggers.deleteRoom(room.id);
    assert.equal(triggers.snapshot().rooms.length, 0);
  } finally {
    await triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart records uncertain local work once and never retries it", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-program-restart-"),
  );
  const manager = new ControlledManager();
  const runner = new BlockingProgramRunner();
  const store = new ZenXTriggerStore(path.join(directory, "triggers.json"));
  const triggers = new ZenXTriggerService(manager, store, { programs: runner });
  try {
    await triggers.start();
    await triggers.create({
      threadId: "target",
      kind: "signal",
      label: "Local action",
      prompt: "Run local action.",
      signalName: "local",
      program: { action: { command: "fixture-action" } },
    });
    const firing = triggers.signal("local", "once");
    await runner.started.promise;
    await triggers.stop();
    const stopped = triggers.snapshot().history[0];
    assert.equal(stopped?.status, "failed");
    assert.equal(stopped?.programOutcome?.status, "uncertain");
    runner.release();
    await firing;

    const restarted = new ZenXTriggerService(manager, store, {
      programs: runner,
    });
    await restarted.start();
    assert.equal(runner.calls, 1);
    assert.equal(restarted.snapshot().history[0]?.status, "failed");
    await restarted.stop();
  } finally {
    await triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart preserves completed predicate and match audits while a Turn remains nonterminal", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-program-audit-"),
  );
  const manager = new ControlledManager();
  const store = new ZenXTriggerStore(path.join(directory, "triggers.json"));
  const runner = new MatchingProgramRunner();
  const triggers = new ZenXTriggerService(manager, store, { programs: runner });
  try {
    await triggers.start();
    const predicate = await triggers.create({
      threadId: "target",
      kind: "signal",
      label: "Predicate",
      prompt: "Keep the downstream Turn open.",
      signalName: "restart",
      program: { predicate: { command: "fixture-predicate" } },
    });
    const matchOnly = await triggers.create({
      threadId: "target",
      kind: "signal",
      label: "Match only",
      prompt: "Must not match without completed Item text.",
      signalName: "restart",
      program: {
        match: { field: "completedItemText", regex: "never-present" },
      },
    });
    await triggers.signal("restart", "event");
    const beforeStop = await snapshotWhen(
      triggers,
      (snapshot) =>
        snapshot.history.some(
          (entry) =>
            entry.triggerId === predicate.id && entry.status === "running",
        ) &&
        snapshot.history.some(
          (entry) =>
            entry.triggerId === matchOnly.id && entry.status === "completed",
        ),
    );
    assert.equal(runner.calls, 1);
    const predicateBefore = beforeStop.history.find(
      (entry) => entry.triggerId === predicate.id,
    )!;
    assert.equal(predicateBefore.programInvocationId, null);
    assert.deepEqual(
      predicateBefore.programOutcomes.map((outcome) => outcome.status),
      ["matched"],
    );
    await triggers.stop();
    const stopped = triggers.snapshot();
    const predicateStopped = stopped.history.find(
      (entry) => entry.triggerId === predicate.id,
    )!;
    const matchStopped = stopped.history.find(
      (entry) => entry.triggerId === matchOnly.id,
    )!;
    assert.equal(predicateStopped.status, "failed");
    assert.equal(predicateStopped.programInvocationId, null);
    assert.deepEqual(
      predicateStopped.programOutcomes.map((outcome) => outcome.status),
      ["matched"],
    );
    assert.deepEqual(
      matchStopped.programOutcomes.map((outcome) => outcome.status),
      ["non_match"],
    );

    const restarted = new ZenXTriggerService(manager, store, {
      programs: runner,
    });
    await restarted.start();
    assert.equal(runner.calls, 1);
    assert.deepEqual(
      restarted
        .snapshot()
        .history.find((entry) => entry.triggerId === predicate.id)
        ?.programOutcomes.map((outcome) => outcome.status),
      ["matched"],
    );
    await restarted.stop();
  } finally {
    await triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("long timers reschedule at the clamp boundary instead of firing early", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-long-timer-"));
  const manager = new ControlledManager();
  let now = 1_000;
  const scheduled: Array<{
    callback(): void;
    delay: number;
    cancelled: boolean;
  }> = [];
  const triggers = new ZenXTriggerService(
    manager,
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
    {
      now: () => now,
      schedule: (callback, delay) => {
        const task = { callback, delay, cancelled: false };
        scheduled.push(task);
        return task;
      },
      cancelScheduled: (handle) => {
        (handle as { cancelled: boolean }).cancelled = true;
      },
    },
  );
  const runAt = now + 3_000_000_000;
  try {
    await triggers.start();
    await triggers.create({
      threadId: "thread-a",
      kind: "timer",
      label: "Long timer",
      prompt: "Wake only on the due date.",
      runAt,
    });
    assert.equal(scheduled.at(-1)?.delay, 2_147_000_000);
    now += 2_147_000_000;
    scheduled.at(-1)?.callback();
    assert.equal(manager.requests.length, 0);
    assert.equal(scheduled.at(-1)?.delay, runAt - now);

    now = runAt;
    scheduled.at(-1)?.callback();
    await snapshotWhen(
      triggers,
      (value) => value.history[0]?.status === "running",
    );
    assert.equal(manager.requests.length, 1);
  } finally {
    await triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("completed Turn projection is bounded and includes commands/results", () => {
  const turn = completedTurn("turn-command", "ship it", [
    {
      type: "commandExecution",
      id: "command-1",
      pluginId: null,
      scriptPath: null,
      command: "npm test",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: `all green ${"x".repeat(8_000)}`,
      exitCode: 0,
      durationMs: null,
    },
  ]);
  const projection = projectCompletedTurn("thread-source", turn);
  assert.match(projection, /User input:\nship it/u);
  assert.match(projection, /\$ npm test/u);
  assert.match(projection, /all green/u);
  assert.match(projection, /Agent conclusion:/u);
  assert(projection.length <= 6_000);
});

class ControlledManager implements ZenXTriggerAppServerPort {
  readonly requests: ClientRequestParams["turn/start"][] = [];
  requestError: Error | null = null;
  #listener:
    | ((
        method: ServerNotificationMethod,
        params: ServerNotificationParams[ServerNotificationMethod],
      ) => void)
    | undefined;

  async request(
    _method: "turn/start",
    params: ClientRequestParams["turn/start"],
  ): Promise<ClientRequestResults["turn/start"]> {
    this.requests.push(params);
    if (this.requestError !== null) throw this.requestError;
    return {
      turn: {
        id: `wakeup-turn-${this.requests.length}`,
        items: [],
        itemsView: "full",
        status: "inProgress",
        error: null,
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
      },
    };
  }

  onNotification(
    listener: (
      method: ServerNotificationMethod,
      params: ServerNotificationParams[ServerNotificationMethod],
    ) => void,
  ): () => void {
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) this.#listener = undefined;
    };
  }

  complete(threadId: string, turn: Turn): void {
    this.#listener?.("turn/completed", { threadId, turn });
  }
}

class EarlyCompletionManager implements ZenXTriggerAppServerPort {
  readonly requests: ClientRequestParams["turn/start"][] = [];
  readonly completions: ServerNotificationParams["turn/completed"][] = [];
  #listener:
    | ((
        method: ServerNotificationMethod,
        params: ServerNotificationParams[ServerNotificationMethod],
      ) => void)
    | undefined;

  async request(
    _method: "turn/start",
    params: ClientRequestParams["turn/start"],
  ): Promise<ClientRequestResults["turn/start"]> {
    this.requests.push(params);
    const id = `early-turn-${this.requests.length}`;
    const completed = completedTurn(id, "early", [
      {
        type: "userMessage",
        id: `${id}-user`,
        clientId: params.clientUserMessageId ?? null,
        content: [{ type: "text", text: "early", text_elements: [] }],
      },
    ]);
    const event = { threadId: params.threadId, turn: completed };
    this.completions.push(event);
    this.#listener?.("turn/completed", event);
    return {
      turn: {
        ...completed,
        status: "inProgress",
        completedAt: null,
        durationMs: null,
      },
    };
  }

  onNotification(
    listener: (
      method: ServerNotificationMethod,
      params: ServerNotificationParams[ServerNotificationMethod],
    ) => void,
  ): () => void {
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) this.#listener = undefined;
    };
  }

  emitLate(event: ServerNotificationParams["turn/completed"]): void {
    this.#listener?.("turn/completed", event);
  }
}

class EarlyEvidenceManager implements ZenXTriggerAppServerPort {
  readonly requests: ClientRequestParams["turn/start"][] = [];
  #listener:
    | ((
        method: ServerNotificationMethod,
        params: ServerNotificationParams[ServerNotificationMethod],
      ) => void)
    | undefined;

  async request(
    _method: "turn/start",
    params: ClientRequestParams["turn/start"],
  ): Promise<ClientRequestResults["turn/start"]> {
    this.requests.push(params);
    const id = `evidence-turn-${this.requests.length}`;
    const items: ThreadItem[] =
      this.requests.length === 1
        ? []
        : [
            {
              type: "userMessage" as const,
              id: `${id}-wrong-a`,
              clientId: "wrong-a",
              content: [
                { type: "text" as const, text: "wrong-a", text_elements: [] },
              ],
            },
            {
              type: "userMessage" as const,
              id: `${id}-wrong-b`,
              clientId: "wrong-b",
              content: [
                { type: "text" as const, text: "wrong-b", text_elements: [] },
              ],
            },
          ];
    this.#listener?.("turn/completed", {
      threadId: params.threadId,
      turn: completedTurn(id, "early", items),
    });
    return {
      turn: {
        ...completedTurn(id, "owned"),
        status: "inProgress",
        completedAt: null,
        durationMs: null,
      },
    };
  }

  onNotification(
    listener: (
      method: ServerNotificationMethod,
      params: ServerNotificationParams[ServerNotificationMethod],
    ) => void,
  ): () => void {
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) this.#listener = undefined;
    };
  }

  complete(threadId: string, turn: Turn): void {
    this.#listener?.("turn/completed", { threadId, turn });
  }
}

class BlockingProgramRunner implements TriggerProgramRunner {
  calls = 0;
  readonly started = deferred<void>();
  #resolve: ((result: TriggerProgramRunResult) => void) | undefined;

  run(
    _spec: { command: string },
    _input: TriggerProgramRunInput,
    _signal: AbortSignal,
  ): Promise<TriggerProgramRunResult> {
    this.calls += 1;
    this.started.resolve();
    return new Promise<TriggerProgramRunResult>((resolve) => {
      this.#resolve = resolve;
    });
  }

  release(): void {
    this.#resolve?.({
      status: "completed",
      output: '{"ok":true}',
      exitCode: 0,
      error: null,
    });
  }
}

class MatchingProgramRunner implements TriggerProgramRunner {
  calls = 0;

  async run(
    _spec: { command: string },
    _input: TriggerProgramRunInput,
    _signal: AbortSignal,
  ): Promise<TriggerProgramRunResult> {
    this.calls += 1;
    return {
      status: "matched",
      output: '{"match":true}',
      exitCode: 0,
      error: null,
    };
  }
}

class UnicodeProgramRunner implements TriggerProgramRunner {
  async run(
    _spec: { command: string },
    _input: TriggerProgramRunInput,
    _signal: AbortSignal,
  ): Promise<TriggerProgramRunResult> {
    return {
      status: "failed",
      output: "😀".repeat(4_500),
      exitCode: 7,
      error: "💥".repeat(3_000),
    };
  }
}

class FailTerminalWriteStore extends ZenXTriggerStore {
  failNextTerminalWrite = false;

  override async write(snapshot: TriggerSnapshot): Promise<void> {
    if (
      this.failNextTerminalWrite &&
      snapshot.history.some((entry) => entry.status === "completed")
    ) {
      this.failNextTerminalWrite = false;
      throw new Error("fixture terminal persistence failure");
    }
    await super.write(snapshot);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function completedTurn(
  id: string,
  userText: string,
  extra: ThreadItem[] = [],
): Turn {
  return {
    id,
    items: [
      {
        type: "userMessage",
        id: `${id}-user`,
        clientId: null,
        content: [{ type: "text", text: userText, text_elements: [] }],
      },
      ...extra,
      {
        type: "agentMessage",
        id: `${id}-agent`,
        text: `Conclusion for ${userText}`,
        phase: "final_answer",
        memoryCitation: null,
      },
    ],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
  };
}

function userInputForClientId(
  turns: readonly Turn[],
  clientId: string | null | undefined,
): string {
  const item = turns
    .flatMap((turn) => turn.items)
    .find(
      (candidate) =>
        candidate.type === "userMessage" && candidate.clientId === clientId,
    );
  assert.equal(item?.type, "userMessage");
  return item.type === "userMessage"
    ? item.content.map((content) => content.text).join("\n")
    : "";
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

function managerFor(directory: string): AppServerManager {
  return new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "token"),
    hostConfig: {
      cwd: process.cwd(),
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
}

async function snapshotWhen(
  service: ZenXTriggerService,
  predicate: (snapshot: ReturnType<ZenXTriggerService["snapshot"]>) => boolean,
) {
  const current = service.snapshot();
  if (predicate(current)) return current;
  return await new Promise<ReturnType<ZenXTriggerService["snapshot"]>>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        dispose();
        reject(new Error("Timed out waiting for trigger"));
      }, 10_000);
      const dispose = service.onChange((snapshot) => {
        if (predicate(snapshot)) {
          clearTimeout(timeout);
          dispose();
          resolve(snapshot);
        }
      });
    },
  );
}
