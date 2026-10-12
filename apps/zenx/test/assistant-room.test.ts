import "./dom-primitives.js";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import { createZenXRoomsProfileLoader } from "../src/main/rooms-profile-loader.js";
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
test("PAW preset separates direct conversation and closes follow-up lifecycle", () => {
  assert.ok(Buffer.byteLength(ALWAYS_ON_ASSISTANT_PROMPT, "utf8") <= 4096);
  assert.match(ALWAYS_ON_ASSISTANT_PROMPT, /PAW owns no special tools/);
  assert.match(ALWAYS_ON_ASSISTANT_PROMPT, /PAW is a preset label/);
  assert.match(ALWAYS_ON_ASSISTANT_PROMPT, /Use their chosen name/);
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

test("direct working Thread completion stays out of the PAW Room", async () => {
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

test("renaming a PAW atomically updates its speaking identity and mention without renaming the working Thread", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom(input);
    await f.service.renameRoom(room.id, "Nova");
    const saved = await f.store.read();
    assert.equal(saved.rooms[0]?.name, "Nova");
    assert.equal(saved.rooms[0]?.members[0]?.name, "Nova");
    assert.equal(saved.rooms[0]?.members[0]?.threadId, "chief-thread");
    assert.equal(saved.triggers[0]?.room?.mention, "Nova");
    assert.equal(f.model.requests.length, 0);
    await assert.rejects(f.service.renameRoom(room.id, "x".repeat(129)));
    assert.equal((await f.store.read()).rooms[0]?.name, "Nova");
  } finally {
    await f.close();
  }
});

test("conversation introduction receipt survives restart and the bound naming tool updates future speakers", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom({
      name: "PAW",
      members: [{ name: "PAW", threadId: "chief-thread" }],
    });
    const operationId = `${room.operationEpoch}:00000000-0000-4000-8000-000000000001`;
    const text =
      "[Automatic introduction request from Create PAW] Ask what I would like to call you.";
    await f.service.prepareRoomMessage(room.id, operationId, text);
    await f.service.postPreparedRoomMessage(room.id, operationId, text);
    await f.service.acknowledgeRoomOperation(room.id, operationId);
    const requests = f.model.requests.length;
    assert.equal(requests, 1);
    const runtime = createZenXRoomsProfileLoader(() => f.service as never)({
      createZenXTrustedPlugin,
    });
    const invoke = (tool: string, args: Record<string, unknown>) =>
      runtime.invoke(tool, {
        callId: randomUUID(),
        threadId: "chief-thread",
        cwd: "/project",
        arguments: args,
        signal: new AbortController().signal,
      });
    // Scripted model actions traverse the production tool/Host/store seam.
    await invoke("zenx_rooms_post_message", {
      roomId: room.id,
      text: "Welcome. What would you like to call me?",
    });
    await f.service.postRoomMessage(room.id, "You", "Call yourself Nova");
    await invoke("zenx_rooms_rename", { roomId: room.id, name: "Nova" });
    await invoke("zenx_rooms_post_message", {
      roomId: room.id,
      text: "My name is now Nova.",
    });
    const renamed = f.service
      .snapshot()
      .rooms.find((entry) => entry.id === room.id)!;
    assert.equal(renamed.name, "Nova");
    assert.equal(renamed.members[0]!.name, "Nova");
    assert.equal(renamed.messages.at(-1)!.author, "Nova");
    assert.equal(
      renamed.messages.find((message) => message.text.startsWith("Welcome"))!
        .author,
      "PAW",
    );
    const beforeRestart = f.model.requests.length;
    await f.service.stop();
    await f.service.start();
    assert.equal(f.model.requests.length, beforeRestart);
    await f.service.prepareRoomMessage(room.id, operationId, text);
    await f.service.postPreparedRoomMessage(room.id, operationId, text);
    assert.equal(f.model.requests.length, beforeRestart);
    assert.equal(
      f.service
        .snapshot()
        .rooms[0]!.messages.filter((message) => message.text === text).length,
      1,
    );
    assert.equal(f.service.snapshot().rooms[0]!.name, "Nova");
  } finally {
    await f.close();
  }
});

test("explicit Start introduction works after cancelling an unsent introduction", async () => {
  const f = await fixture();
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  const root = createRoot(document.getElementById("root")!);
  try {
    const room = await f.service.createAssistantRoom(input);
    const operationId = `${room.operationEpoch}:00000000-0000-4000-8000-000000000001`;
    await f.service.prepareRoomMessage(
      room.id,
      operationId,
      "[Automatic start] Please say hello and ask what I’d like to call you. I can skip naming and start working.",
    );
    await f.service.cancelPreparedRoomOperation(room.id, operationId);
    const runtime = createZenXRoomsProfileLoader(() => f.service as never)({
      createZenXTrustedPlugin,
    });
    let settleIntroduction!: () => void;
    const introductionSettled = new Promise<void>((resolve) => {
      settleIntroduction = resolve;
    });
    const sdk = {
      context: {
        route: `/plugins/zenx-rooms/rooms?roomId=${room.id}`,
        primaryNavigation: true,
      },
      navigation: { navigate: () => {} },
      commands: {
        execute: async (id: string, input: any = {}) => {
          try {
            const result = await runtime.invoke(
              `zenx_rooms_${id.replaceAll("-", "_")}`,
              {
                callId: randomUUID(),
                trustedPluginUi: true,
                cwd: "/project",
                signal: new AbortController().signal,
                arguments: { input },
              },
            );
            if (id === "ack-operation") settleIntroduction();
            return result;
          } catch (error) {
            if (id === "prepare-message" || id === "post-message")
              settleIntroduction();
            throw error;
          }
        },
      },
    };
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: sdk as any })),
    );
    const start = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent === "Start introduction")!;
    assert.ok(
      start,
      "cancelled operation is acknowledged and the start button is offered again",
    );
    await act(async () => {
      start.click();
      await introductionSettled;
    });
    assert.equal(f.model.requests.length, 1, document.body.textContent!);
    assert.equal(
      f.service.roomOperation(room.id, operationId).state,
      "cancelled",
    );
    assert.equal(f.service.snapshot().rooms[0]!.messages.length, 1);
    assert.equal(
      f.service
        .snapshot()
        .rooms[0]!.operations?.filter((entry) => entry.messageId !== null)
        .length,
      1,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    await f.close();
  }
});
