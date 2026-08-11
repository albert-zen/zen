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
import { ZenXTriggerStore } from "../src/main/trigger-store.js";
import type {
  ClientRequestParams,
  ClientRequestResults,
  ServerNotificationMethod,
  ServerNotificationParams,
  ThreadItem,
  Turn,
} from "../src/protocol-client/index.js";

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
    triggers.stop();
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
    triggers.stop();
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
    triggers.stop();
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
    triggers.stop();
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
    triggers.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent Room deletion makes a queued Agent post fail explicitly", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-room-race-"));
  const triggers = new ZenXTriggerService(
    new ControlledManager(),
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
  );
  try {
    await triggers.start();
    const room = await triggers.createRoom({
      name: "release",
      members: [{ name: "Reviewer", threadId: "thread-a" }],
    });
    const deletion = triggers.deleteRoom(room.id);
    const posting = triggers.postAgentRoomMessage(room.id, "Status?");
    await deletion;
    await assert.rejects(posting, /Room was not found/u);
    assert.deepEqual(triggers.snapshot().rooms, []);
  } finally {
    triggers.stop();
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
    triggers.stop();
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
    triggers.stop();
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
