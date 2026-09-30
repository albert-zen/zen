import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ZenXTriggerService,
  type ZenXTriggerAppServerPort,
} from "../src/main/trigger-service.js";
import { ZenXTriggerStore } from "../src/main/trigger-store.js";
import type {
  ClientRequestParams,
  ClientRequestResults,
} from "../src/protocol-client/index.js";
import {
  createZenXTrustedPlugin,
  type ZenXRoomsTrustedService,
} from "../../../packages/zenx-rooms-plugin/src/runtime.js";

class ModelStub implements ZenXTriggerAppServerPort {
  requests: ClientRequestParams["turn/start"][] = [];
  failure = false;
  async request(
    _method: "turn/start",
    params: ClientRequestParams["turn/start"],
  ): Promise<ClientRequestResults["turn/start"]> {
    this.requests.push(params);
    if (this.failure) throw new Error("thread_busy");
    return {
      turn: {
        id: `turn-${this.requests.length}`,
        items: [
          {
            id: randomUUID(),
            type: "agentMessage",
            phase: "final_answer",
            memoryCitation: null,
            text: "Mock assistant reply",
          },
        ],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 0,
        completedAt: 1,
        durationMs: 1,
      },
    };
  }
  onNotification(): () => void {
    return () => {};
  }
}
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "zenx-assistant-"));
  const store = new ZenXTriggerStore(path.join(dir, "state.json"));
  const model = new ModelStub();
  const service = new ZenXTriggerService(model, store);
  await service.start();
  return {
    model,
    service,
    store,
    close: async () => {
      await service.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const input = {
  name: "Personal assistant",
  members: [{ name: "Chief", threadId: "chief-thread" }],
};
test("assistant setup and reads make no model call; human send needs no mention and duplicates do not redispatch", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom(input);
    assert.equal(f.model.requests.length, 0);
    assert.equal(f.service.snapshot().triggers.length, 1);
    assert.equal(
      (await f.store.read()).rooms[0]?.assistant?.threadId,
      "chief-thread",
    );
    const op = `${room.operationEpoch}:${randomUUID()}`;
    await f.service.prepareRoomMessage(room.id, op, "Hello");
    await f.service.postPreparedRoomMessage(room.id, op, "Hello");
    await f.service.postPreparedRoomMessage(room.id, op, "Hello");
    assert.equal(f.model.requests.length, 1);
    assert.equal(f.model.requests[0]?.threadId, "chief-thread");
    assert.equal(f.model.requests[0]?.model, undefined);
    const messages = f.service.snapshot().rooms[0]!.messages;
    assert.equal(messages.filter((x) => x.kind === "human").length, 1);
    assert.equal(messages.filter((x) => x.kind === "agent").length, 1);
    assert.equal(messages[1]?.originThreadId, "chief-thread");
    assert.equal(messages[1]?.originTurnId, "turn-1");
    await f.service.postAgentRoomMessage(room.id, "@Chief do not self-wake");
    assert.equal(f.model.requests.length, 1);
  } finally {
    await f.close();
  }
});
test("pause preserves messages without replay; resume only admits later human messages", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom(input);
    await f.service.cancel(room.assistant!.triggerId);
    await f.service.postRoomMessage(room.id, "You", "While paused");
    assert.equal(f.model.requests.length, 0);
    await f.service.resume(room.assistant!.triggerId);
    assert.equal(f.model.requests.length, 0);
    await f.service.postRoomMessage(room.id, "You", "After resume");
    assert.equal(f.model.requests.length, 1);
  } finally {
    await f.close();
  }
});
test("busy wakeup is explicit failure and never auto-retried", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom(input);
    f.model.failure = true;
    await f.service.postRoomMessage(room.id, "You", "Busy");
    assert.equal(f.model.requests.length, 1);
    assert.equal(f.service.snapshot().history[0]?.status, "failed");
    assert.match(f.service.snapshot().history[0]?.error ?? "", /thread_busy/);
    await f.service.stop();
    await f.service.start();
    assert.equal(f.model.requests.length, 1);
  } finally {
    await f.close();
  }
});
test("assistant cannot silently change members or its owned Trigger route", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom(input);
    await assert.rejects(
      f.service.addRoomMember(room.id, { name: "Other", threadId: "other" }),
      /fixed/,
    );
    await assert.rejects(
      f.service.removeRoomMember(room.id, "chief-thread"),
      /fixed/,
    );
    await assert.rejects(
      f.service.update({
        id: room.assistant!.triggerId,
        kind: "signal",
        threadId: "other",
        label: "bad",
        prompt: "bad",
        signalName: "bad",
      }),
      /fixed/,
    );
    await f.service.deleteRoom(room.id);
    assert.equal(f.service.snapshot().triggers.length, 0);
  } finally {
    await f.close();
  }
});
test("assistant atomic creation rejects suspended delivery and invalid membership", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.createAssistantRoom({ name: "bad", members: [] }),
      /at least one|exactly one/,
    );
    f.service.suspendWakeups();
    await assert.rejects(
      f.service.createAssistantRoom(input),
      /Enable Triggers/,
    );
    assert.equal(f.service.snapshot().rooms.length, 0);
    assert.equal(f.service.snapshot().triggers.length, 0);
  } finally {
    await f.close();
  }
});
test("ordinary Rooms retain explicit mention semantics", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createRoom(input);
    await f.service.create({
      kind: "roomMention",
      threadId: "chief-thread",
      roomId: room.id,
      mention: "Chief",
      label: "Replies",
      prompt: "Reply",
    });
    await f.service.postRoomMessage(room.id, "You", "Hello");
    assert.equal(f.model.requests.length, 0);
    await f.service.postRoomMessage(room.id, "You", "@Chief hello");
    assert.equal(f.model.requests.length, 1);
  } finally {
    await f.close();
  }
});
test("model arguments cannot impersonate trusted assistant setup or pause UI", async () => {
  let setups = 0;
  const service = {
    createAssistantRoom: async () => {
      setups++;
      return {};
    },
    setAssistantReplies: async () => {
      setups++;
    },
  } as unknown as ZenXRoomsTrustedService;
  const runtime = createZenXTrustedPlugin(service);
  for (const toolName of [
    "zenx_rooms_create_assistant",
    "zenx_rooms_assistant_replies",
  ]) {
    await assert.rejects(
      runtime.invoke(toolName, {
        callId: "call",
        arguments: {
          trustedPluginUi: true,
          input: {
            name: "test",
            members: input.members,
            roomId: "r",
            enabled: true,
          },
        },
        cwd: tmpdir(),
        signal: new AbortController().signal,
      }),
      /Trusted Room UI/,
    );
  }
  assert.equal(setups, 0);
});

test("assistant ignores unrelated duplicate reply triggers and retains its owned trigger", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom(input);
    await f.service.create({
      kind: "roomMention",
      threadId: "chief-thread",
      roomId: room.id,
      mention: "Chief",
      label: "Other route",
      prompt: "Other",
    });
    await f.service.postRoomMessage(room.id, "You", "@Chief hello");
    assert.equal(f.model.requests.length, 1);
    await assert.rejects(
      f.service.delete(room.assistant!.triggerId),
      /owned by its Room/,
    );
    f.service.suspendWakeups();
    await assert.rejects(f.service.deleteRoom(room.id), /Enable Triggers/);
  } finally {
    await f.close();
  }
});

test("failed assistant store commit publishes neither Room nor Trigger", async () => {
  const model = new ModelStub();
  let fail = false;
  const service = new ZenXTriggerService(model, {
    read: async () => ({ rooms: [], triggers: [], history: [] }),
    write: async () => {
      if (fail) throw new Error("mock disk failure");
    },
  });
  await service.start();
  fail = true;
  try {
    await assert.rejects(
      service.createAssistantRoom(input),
      /mock disk failure/,
    );
    assert.deepEqual(service.snapshot(), {
      rooms: [],
      triggers: [],
      history: [],
    });
    assert.equal(model.requests.length, 0);
  } finally {
    fail = false;
    await service.stop();
  }
});

class QueuedModel implements ZenXTriggerAppServerPort {
  queued: ClientRequestParams["turn/queue"][] = [];
  early = false;
  rejectAdmission = false;
  listener:
    Parameters<ZenXTriggerAppServerPort["onNotification"]>[0] | undefined;
  async request(): Promise<ClientRequestResults["turn/start"]> {
    throw new Error("Assistant must use the canonical queue");
  }
  onNotification(
    listener: Parameters<ZenXTriggerAppServerPort["onNotification"]>[0],
  ) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  async enqueue(input: ClientRequestParams["turn/queue"]) {
    this.queued.push(input);
    if (this.early) this.complete(this.queued.length - 1);
    if (this.rejectAdmission) throw new Error("mock admission response lost");
  }
  complete(
    index: number,
    clientId?: string,
    status: "completed" | "interrupted" = "completed",
  ) {
    const input = this.queued[index]!;
    this.listener?.("turn/completed", {
      threadId: input.threadId,
      turn: {
        id: `queued-turn-${index}`,
        itemsView: "full",
        status,
        error: null,
        startedAt: 0,
        completedAt: 1,
        durationMs: 1,
        items: [
          {
            type: "userMessage",
            id: `queued-input-${index}`,
            clientId: clientId ?? input.clientUserMessageId ?? null,
            content: [
              { type: "text", text: "queued input", text_elements: [] },
            ],
          },
          {
            type: "agentMessage",
            id: `queued-answer-${index}`,
            text: "Queued mock reply",
            phase: "final_answer",
            memoryCitation: null,
          },
        ],
      },
    });
  }
}
async function queueFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "zenx-assistant-queue-"));
  const model = new QueuedModel();
  const service = new ZenXTriggerService(
    model,
    new ZenXTriggerStore(path.join(dir, "state.json")),
  );
  await service.start();
  const room = await service.createAssistantRoom(input);
  return {
    model,
    service,
    room,
    close: async () => {
      await service.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function waitForReceipt(service: ZenXTriggerService, status: string) {
  if (service.snapshot().history[0]?.status === status) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      dispose();
      reject(new Error("Receipt did not settle"));
    }, 5000);
    const dispose = service.onChange((snapshot) => {
      if (snapshot.history[0]?.status === status) {
        clearTimeout(timeout);
        dispose();
        resolve();
      }
    });
  });
}
test("assistant queues busy input and only projects its exact completed Turn once", async () => {
  const f = await queueFixture();
  try {
    await f.service.postRoomMessage(f.room.id, "You", "new request");
    assert.equal(f.model.queued.length, 1);
    assert.equal(f.service.snapshot().history[0]?.delivery, "queued");
    assert.equal(f.service.snapshot().rooms[0]?.messages.length, 1);
    f.model.complete(0, "unrelated-client");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(f.service.snapshot().rooms[0]?.messages.length, 1);
    f.model.complete(0);
    f.model.complete(0);
    await waitForReceipt(f.service, "completed");
    assert.equal(
      f.service.snapshot().rooms[0]?.messages.filter((m) => m.kind === "agent")
        .length,
      1,
    );
    assert.equal(
      f.service.snapshot().rooms[0]?.messages.at(-1)?.originTurnId,
      "queued-turn-0",
    );
  } finally {
    await f.close();
  }
});
test("queued assistant completion may precede acknowledgment without being resurrected", async () => {
  const f = await queueFixture();
  try {
    f.model.early = true;
    await f.service.postRoomMessage(f.room.id, "You", "fast response");
    assert.equal(f.service.snapshot().history[0]?.status, "completed");
    assert.equal(f.service.snapshot().rooms[0]?.messages.length, 2);
  } finally {
    await f.close();
  }
});
test("pause does not misrepresent already queued input as cancelled; interrupted completion has no reply", async () => {
  const f = await queueFixture();
  try {
    await f.service.postRoomMessage(f.room.id, "You", "queued first");
    await f.service.cancel(f.room.assistant!.triggerId);
    await f.service.postRoomMessage(f.room.id, "You", "paused second");
    assert.equal(f.model.queued.length, 1);
    f.model.complete(0, undefined, "interrupted");
    await waitForReceipt(f.service, "failed");
    assert.equal(
      f.service.snapshot().rooms[0]?.messages.filter((m) => m.kind === "agent")
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});
test("unknown queue admission and restart never silently requeue an assistant message", async () => {
  const f = await queueFixture();
  try {
    f.model.rejectAdmission = true;
    await f.service.postRoomMessage(f.room.id, "You", "unknown send");
    assert.equal(f.service.snapshot().history[0]?.delivery, "unknown");
    await f.service.stop();
    await f.service.start();
    assert.equal(f.model.queued.length, 1);
    assert.equal(f.service.snapshot().rooms[0]?.messages.length, 1);
  } finally {
    await f.close();
  }
});

test(
  "real App Server accepts assistant input behind a busy Turn and returns its correlated reply",
  { timeout: 20000 },
  async () => {
    const { AppServerManager } =
      await import("../src/main/app-server-manager.js");
    const { fileURLToPath } = await import("node:url");
    const dir = await mkdtemp(path.join(tmpdir(), "zenx-assistant-real-"));
    const manager = new AppServerManager({
      entryPath: fileURLToPath(
        new URL("../src/main/app-server-host.ts", import.meta.url),
      ),
      tokenFile: path.join(dir, "runtime/token"),
      hostConfig: {
        cwd: dir,
        dataDirectory: path.join(dir, "data"),
        model: "fake",
        models: ["fake"],
        approvalPolicy: "never",
        provider: { type: "fake" },
      },
      execArgv: ["--import", "tsx"],
      startupTimeoutMs: 10000,
    });
    let service: ZenXTriggerService | undefined;
    try {
      await manager.start();
      const thread = (await manager.request("thread/start", {})).thread;
      let observedBusy = false;
      service = new ZenXTriggerService(
        {
          request: (method, params) => manager.request(method, params),
          onNotification: (listener) => manager.onNotification(listener),
          enqueue: async (params) => {
            const before = await manager.request("thread/read", {
              threadId: thread.id,
              includeTurns: true,
            });
            observedBusy = before.thread.turns.at(-1)?.status === "inProgress";
            await manager.request("turn/queue", params);
          },
        },
        new ZenXTriggerStore(path.join(dir, "rooms.json")),
      );
      await service.start();
      const room = await service.createAssistantRoom({
        name: "Chief",
        members: [{ name: "Chief", threadId: thread.id }],
      });
      const first = await manager.request("turn/start", {
        threadId: thread.id,
        input: [
          {
            type: "text",
            text: `!shell ${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},1200)"`,
          },
        ],
      });
      await service.postRoomMessage(room.id, "You", "Continue when ready");
      assert.equal(observedBusy, true);
      await waitForReceipt(service, "completed");
      const result = await manager.request("thread/read", {
        threadId: thread.id,
        includeTurns: true,
      });
      assert.equal(result.thread.turns.length, 2);
      assert.equal(result.thread.turns[0]?.id, first.turn.id);
      assert.equal(result.thread.turns[0]?.status, "completed");
      const replies = service
        .snapshot()
        .rooms[0]!.messages.filter((m) => m.kind === "agent");
      assert.equal(replies.length, 1);
      assert.equal(replies[0]?.originTurnId, result.thread.turns[1]?.id);
    } finally {
      await service?.stop();
      await manager.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("two queued assistant messages retain separate identities and reply receipts", async () => {
  const f = await queueFixture();
  try {
    await f.service.postRoomMessage(f.room.id, "You", "first");
    await f.service.postRoomMessage(f.room.id, "You", "second");
    assert.equal(f.model.queued.length, 2);
    assert.notEqual(
      f.model.queued[0]?.clientUserMessageId,
      f.model.queued[1]?.clientUserMessageId,
    );
    f.model.complete(1);
    await waitForReceipt(f.service, "completed");
    f.model.complete(0);
    await new Promise<void>((resolve, reject) => {
      const ready = () =>
        f.service.snapshot().history.every((h) => h.status === "completed");
      if (ready()) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        dispose();
        reject(new Error("second receipt did not settle"));
      }, 1000);
      const dispose = f.service.onChange(() => {
        if (ready()) {
          clearTimeout(timer);
          dispose();
          resolve();
        }
      });
    });
    const replies = f.service
      .snapshot()
      .rooms[0]!.messages.filter((m) => m.kind === "agent");
    assert.equal(replies.length, 2);
    assert.deepEqual(
      new Set(replies.map((m) => m.originTurnId)),
      new Set(["queued-turn-0", "queued-turn-1"]),
    );
  } finally {
    await f.close();
  }
});
