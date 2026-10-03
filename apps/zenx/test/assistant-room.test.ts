import { ALWAYS_ON_ASSISTANT_PROMPT } from "../src/main/assistant-preset.js";
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
  listener:
    Parameters<ZenXTriggerAppServerPort["onNotification"]>[0] | undefined;
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
  async sendAssistant(params: ClientRequestParams["turn/queue"]) {
    const result = await this.request("turn/start", params);
    this.listener?.("turn/completed", {
      threadId: params.threadId,
      turn: {
        ...result.turn,
        items: [
          {
            type: "userMessage",
            id: randomUUID(),
            clientId: params.clientUserMessageId ?? null,
            content: [{ type: "text", text: "input", text_elements: [] }],
          },
          ...result.turn.items,
        ],
      },
    });
    return { turnId: result.turn.id };
  }
  onNotification(
    listener: Parameters<ZenXTriggerAppServerPort["onNotification"]>[0],
  ): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
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
    assert.equal(messages.filter((x) => x.kind === "agent").length, 0);
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

test("assistant includes the complete current message beyond the bounded context preview", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom(input);
    const text = "x".repeat(7000) + "FINAL-CORRECTION";
    await f.service.postRoomMessage(room.id, "You", text);
    assert.ok(JSON.stringify(f.model.requests[0]?.input).includes(text));
    assert.equal(f.service.snapshot().history[0]?.status, "completed");
    assert.equal(f.service.snapshot().history[0]?.delivery, undefined);
  } finally {
    await f.close();
  }
});

// Prompt contracts are explicit product guidance, not proof of model compliance.
test("Companion preset separates direct conversation and closes follow-up lifecycle", () => {
  assert.match(
    ALWAYS_ON_ASSISTANT_PROMPT,
    /Direct messages in the working Thread/,
  );
  assert.match(
    ALWAYS_ON_ASSISTANT_PROMPT,
    /Do not reuse a Reply Room ID from an earlier turn/,
  );
  assert.match(
    ALWAYS_ON_ASSISTANT_PROMPT,
    /stopping condition in the registered wakeup prompt itself/,
  );
  assert.match(
    ALWAYS_ON_ASSISTANT_PROMPT,
    /direct-origin work retain the working Thread destination/,
  );
  assert.match(ALWAYS_ON_ASSISTANT_PROMPT, /cancel or disable/);
  assert.match(
    ALWAYS_ON_ASSISTANT_PROMPT,
    /No heartbeat is installed by this preset/,
  );
});

test("direct working Thread completion stays out of the Companion Room", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom(input);
    await f.model.sendAssistant({
      threadId: input.members[0]!.threadId,
      clientUserMessageId: randomUUID(),
      input: [{ type: "text", text: "Talk to me here only" }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.service.snapshot().rooms[0]!.messages, []);
    await f.service.postAgentRoomMessage(room.id, "Explicit IM reply");
    assert.deepEqual(
      f.service.snapshot().rooms[0]!.messages.map((m) => m.text),
      ["Explicit IM reply"],
    );
  } finally {
    await f.close();
  }
});
