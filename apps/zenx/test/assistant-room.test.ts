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
import type { ClientRequestParams } from "../src/protocol-client/index.js";
import type { NativeThreadRecoverySnapshot } from "../../../src/protocol/native/recovery.js";
import {
  createZenXTrustedPlugin,
  type ZenXRoomsTrustedService,
} from "../../../packages/zenx-rooms-plugin/src/runtime.js";

class ModelStub implements ZenXTriggerAppServerPort {
  listener:
    Parameters<ZenXTriggerAppServerPort["onNotification"]>[0] | undefined;
  requests: ClientRequestParams["turn/start"][] = [];
  readRequests: string[] = [];
  failure = false;
  wakeups: Array<{
    threadId: string;
    clientId: string;
    source: "bootstrap";
    text: string;
  }> = [];
  async request(method: any, params: any): Promise<any> {
    if (method === "zen/thread/resume") {
      this.readRequests.push(params.threadId);
      // A failed wake has no canonical receipt in this fixture. Recovery is
      // read-only and must not fabricate another wake or a completion event.
      return {
        processEpoch: "model-stub",
        threadId: params.threadId,
        watermark: 0,
        thread: {
          id: params.threadId,
          items: [],
          turns: [],
          cwd: tmpdir(),
          providerProfileId: "fake",
          modelId: "fake",
          reasoningEffort: "medium",
          model: "fake",
          provider: "fake",
          sandbox: "danger-full-access",
          approvalPolicy: "never",
          archived: false,
        },
        events: [],
      } satisfies NativeThreadRecoverySnapshot;
    }
    assert.equal(method, "zen/turn/wake", "Unexpected ModelStub RPC method");
    const request =
      params.text === undefined
        ? params
        : {
            threadId: params.threadId,
            clientUserMessageId: params.clientId,
            input: [{ type: "text", text: params.text }],
          };
    this.requests.push(request);
    if (params.source === "bootstrap") this.wakeups.push(params);
    if (this.failure) throw new Error("thread_busy");
    const turnId = `turn-${this.requests.length}`;
    this.listener?.("turn/completed", {
      threadId: params.threadId,
      turn: {
        id: turnId,
        status: "completed",
        itemsView: "full",
        error: null,
        startedAt: 0,
        completedAt: 1,
        durationMs: 1,
        items: [
          {
            type: "hostMessage",
            id: randomUUID(),
            clientId: params.clientId,
            source: params.source,
            text: params.text,
            mode: "start",
          },
          {
            id: randomUUID(),
            type: "agentMessage",
            phase: "final_answer",
            memoryCitation: null,
            text: "Mock assistant reply",
          },
        ],
      },
    });
    return { mode: "start", turnId };
  }
  async sendAssistant(params: ClientRequestParams["turn/queue"]) {
    return this.request("zen/turn/wake", {
      threadId: params.threadId,
      clientId: params.clientUserMessageId,
      source: "room",
      text: JSON.stringify(params.input),
    });
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
test("creating a PAW installs one visible hourly heartbeat without running the model", async () => {
  const f = await fixture();
  try {
    const before = Date.now();
    const room = await f.service.createAssistantRoom(input);
    const timers = f.service
      .snapshot()
      .triggers.filter((trigger) => trigger.kind === "timer");
    assert.equal(timers.length, 1);
    const heartbeat = timers[0]!;
    assert.equal(heartbeat.threadId, "chief-thread");
    assert.equal(heartbeat.active, true);
    assert.equal(heartbeat.timer?.intervalMinutes, 60);
    assert.ok(heartbeat.timer!.nextRunAt >= before + 60 * 60_000);
    assert.match(heartbeat.prompt, new RegExp(room.id));
    assert.match(heartbeat.prompt, /authorized work/);
    assert.match(heartbeat.prompt, /Stay quiet/);
    assert.equal(f.model.requests.length, 0);
    assert.deepEqual(
      (await f.store.read()).triggers.find(
        (trigger) => trigger.id === heartbeat.id,
      ),
      heartbeat,
    );
  } finally {
    await f.close();
  }
});

test("existing PAWs keep their saved triggers until heartbeat is explicitly added; adding is idempotent", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom(input);
    await f.service.stop();
    const legacy = await f.store.read();
    legacy.triggers = legacy.triggers.filter(
      (trigger) => trigger.kind !== "timer",
    );
    delete legacy.rooms[0]!.assistant!.heartbeatTriggerId;
    await f.store.write(legacy);
    await f.service.start();
    assert.equal(f.service.snapshot().triggers.length, 1);
    const [first, second] = await Promise.all([
      f.service.addAssistantHeartbeat(room.id),
      f.service.addAssistantHeartbeat(room.id),
    ]);
    assert.equal(first.id, second.id);
    assert.equal(f.service.snapshot().triggers.length, 2);
    await f.service.cancel(first.id);
    assert.equal(
      (await f.service.addAssistantHeartbeat(room.id)).active,
      false,
    );
    await f.service.delete(first.id);
    assert.equal(
      f.service.snapshot().rooms[0]!.assistant!.heartbeatTriggerId,
      undefined,
    );
    await f.service.stop();
    await f.service.start();
    assert.equal(f.service.snapshot().triggers.length, 1);
  } finally {
    await f.close();
  }
});

test("the preset heartbeat uses timer admission and its exact Room reply route", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom(input);
    const heartbeat = f.service
      .snapshot()
      .triggers.find((trigger) => trigger.kind === "timer")!;
    await f.service.update({
      id: heartbeat.id,
      kind: "timer",
      threadId: heartbeat.threadId,
      label: heartbeat.label,
      prompt: heartbeat.prompt,
      runAt: Date.now() + 30,
      intervalMinutes: 60,
    });
    const deadline = Date.now() + 2000;
    while (!f.model.requests.length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.model.requests.length, 1);
    const text = f.model.requests[0]!.input.map((part) =>
      part.type === "text" ? part.text : "",
    ).join("\n");
    assert.match(text, /Reply Room ID:/);
    assert.doesNotMatch(text, /source Room message is no longer retained/);
    assert.equal(f.service.snapshot().history[0]?.replyRoomId, room.id);
    assert.equal(f.service.snapshot().history[0]?.sourceRoomMessageId, null);
  } finally {
    await f.close();
  }
});

test("assistant setup and reads make no model call; human send needs no mention and duplicates do not redispatch", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom(input);
    assert.equal(f.model.requests.length, 0);
    assert.equal(f.service.snapshot().triggers.length, 2);
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
    assert.deepEqual(f.model.readRequests, []);
    const messages = structuredClone(f.service.snapshot().rooms[0]!.messages);
    assert.equal(
      messages.filter((message) => message.kind === "agent").length,
      0,
    );
    await f.service.stop();
    await f.service.start();
    assert.deepEqual(f.model.readRequests, ["chief-thread"]);
    assert.equal(f.model.requests.length, 1);
    assert.equal(f.service.snapshot().history[0]?.status, "failed");
    assert.equal(f.service.snapshot().history[0]?.delivery, "unknown");
    assert.deepEqual(f.service.snapshot().rooms[0]!.messages, messages);
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
    setAssistantDeliveryMode: async () => {
      setups++;
    },
    addAssistantHeartbeat: async () => {
      setups++;
    },
  } as unknown as ZenXRoomsTrustedService;
  const runtime = createZenXTrustedPlugin(service);
  for (const toolName of [
    "zenx_rooms_create_assistant",
    "zenx_rooms_assistant_replies",
    "zenx_rooms_assistant_delivery",
    "zenx_rooms_assistant_heartbeat",
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
    /New PAWs include an editable hourly heartbeat/,
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
    await f.service.prepareAssistantIntroduction(room.id, operationId, "en");
    await f.service.startAssistantIntroduction(room.id, operationId);
    assert.equal(f.service.snapshot().rooms[0]!.messages.length, 0);
    assert.match(f.model.wakeups[0]!.text, /Host bootstrap event/);
    assert.doesNotMatch(f.model.wakeups[0]!.text, /Current user message/);
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
    await f.service.prepareAssistantIntroduction(room.id, operationId, "zh");
    await f.service.startAssistantIntroduction(room.id, operationId);
    assert.equal(f.model.requests.length, beforeRestart);
    assert.equal(
      f.service
        .snapshot()
        .rooms[0]!.messages.filter((message) => message.kind === "human")
        .length,
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
    await f.service.prepareAssistantIntroduction(room.id, operationId, "en");
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
            if (id === "prepare-introduction" || id === "start-introduction")
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
    assert.equal(f.service.snapshot().rooms[0]!.messages.length, 0);
    assert.equal(
      f.service
        .snapshot()
        .rooms[0]!.operations?.filter((entry) => entry.wakeupId !== undefined)
        .length,
      1,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    await f.close();
  }
});

test("restarted introduction retains its new operation when delivery and refresh are uncertain", async () => {
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
    await f.service.prepareAssistantIntroduction(room.id, operationId, "en");
    await f.service.cancelPreparedRoomOperation(room.id, operationId);
    const runtime = createZenXRoomsProfileLoader(() => f.service as never)({
      createZenXTrustedPlugin,
    });
    let hideResult = false;
    const prepared: string[] = [];
    const sdk = {
      context: {
        route: `/plugins/zenx-rooms/rooms?roomId=${room.id}`,
        primaryNavigation: true,
      },
      navigation: { navigate: () => {} },
      commands: {
        execute: async (id: string, input: any = {}) => {
          if (id === "list" && hideResult)
            throw Error("list transport unavailable");
          if (id === "prepare-introduction") prepared.push(input.operationId);
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
          if (id === "start-introduction") {
            hideResult = true;
            throw Error("post result lost after admission");
          }
          return result;
        },
      },
    };
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: sdk as any })),
    );
    const startButton = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === "Start introduction",
      )!;
    await act(async () => startButton().click());
    for (let i = 0; i < 100 && startButton()?.disabled; i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    assert.equal(
      f.model.requests.length,
      1,
      "the first renewed introduction was accepted exactly once",
    );
    assert.ok(
      startButton() && !startButton().disabled,
      "the UI offers an explicit retry after its delivery and list reads fail",
    );
    await act(async () => startButton().click());
    for (let i = 0; i < 100 && startButton()?.disabled; i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    assert.equal(
      f.model.requests.length,
      1,
      `an uncertain introduction must never dispatch a second model turn; prepared operations: ${prepared.join(", ")}`,
    );
    assert.equal(
      new Set(prepared).size,
      1,
      `uncertain retry must retain its renewed operation: ${prepared.join(", ")}`,
    );
    await act(async () => root.render(null));
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: sdk as any })),
    );
    assert.equal(
      startButton(),
      undefined,
      "unknown Host state after remount cannot authorize a new introduction",
    );
    assert.equal(f.model.requests.length, 1);
    hideResult = false;
    await act(async () => root.render(null));
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: sdk as any })),
    );
    assert.equal(
      startButton(),
      undefined,
      "Host receipt and saved message recover the existing attempt after remount",
    );
    assert.equal(f.model.requests.length, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    await f.close();
  }
});

test("restarted introduction lookup across remount retains one admission", async () => {
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
  let releaseLookup!: () => void;
  const heldLookup = new Promise<void>((resolve) => (releaseLookup = resolve));
  let lookupHeld = false;
  let acks = 0;
  const prepared: string[] = [];
  try {
    const room = await f.service.createAssistantRoom(input);
    const originalId = `${room.operationEpoch}:00000000-0000-4000-8000-000000000001`;
    await f.service.prepareAssistantIntroduction(room.id, originalId, "en");
    await f.service.cancelPreparedRoomOperation(room.id, originalId);
    const runtime = createZenXRoomsProfileLoader(() => f.service as never)({
      createZenXTrustedPlugin,
    });
    const sdk = {
      context: {
        route: `/plugins/zenx-rooms/rooms?roomId=${room.id}`,
        primaryNavigation: true,
      },
      navigation: { navigate: () => {} },
      commands: {
        execute: async (id: string, input: any = {}) => {
          if (id === "prepare-introduction") prepared.push(input.operationId);
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
          if (id === "operation" && !lookupHeld) {
            lookupHeld = true;
            await heldLookup;
          }
          if (id === "ack-operation") acks++;
          return result;
        },
      },
    };
    const render = () =>
      act(async () =>
        root.render(React.createElement(RoomsPage, { sdk: sdk as any })),
      );
    const start = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === "Start introduction",
      );
    const until = async (condition: () => boolean) => {
      for (let i = 0; i < 100 && !condition(); i++)
        await act(async () => {
          await new Promise((r) => setTimeout(r, 10));
        });
      assert.ok(condition());
    };
    await render();
    await act(async () => start()!.click());
    await until(() => lookupHeld);
    assert.equal(f.model.requests.length, 0);
    // Leaving the plugin surface and returning remounts RoomsPage, while its
    // existing command promise still settles normally through PluginUiHost.
    await act(async () => root.render(null));
    await render();
    assert.ok(
      start() && !start()!.disabled,
      "the new viewport offers Start while the old read is pending",
    );
    await act(async () => start()!.click());
    await until(() => acks === 1);
    assert.equal(f.model.requests.length, 1);
    await act(async () => releaseLookup());
    await until(() => acks === 2);
    assert.equal(
      f.model.requests.length,
      1,
      `the old viewport must not independently send a second introduction: ${prepared.join(", ")}`,
    );
  } finally {
    releaseLookup();
    await act(async () => root.unmount());
    dom.window.close();
    await f.close();
  }
});

test("PAW bootstrap is an honest Host event with no Room sender, and early completion is retained", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom(input);
    const id = `${room.operationEpoch}:${randomUUID()}`;
    const operation = await f.service.prepareAssistantIntroduction(
      room.id,
      id,
      "zh",
    );
    assert.equal(operation.kind, "assistantIntroduction");
    assert.equal(operation.messageId, null);
    assert.equal(f.model.requests.length, 0);
    await assert.rejects(
      f.service.postPreparedRoomMessage(room.id, id, operation.text),
      /different message/,
    );
    await Promise.all([
      f.service.startAssistantIntroduction(room.id, id),
      f.service.startAssistantIntroduction(room.id, id),
    ]);
    assert.equal(f.model.wakeups.length, 1);
    assert.equal(f.model.wakeups[0]!.source, "bootstrap");
    assert.match(f.model.wakeups[0]!.text, /Write the welcome in Chinese/);
    const snapshot = f.service.snapshot();
    assert.deepEqual(snapshot.rooms[0]!.messages, []);
    assert.equal(snapshot.history.length, 1);
    assert.equal(snapshot.history[0]!.sourceRoomMessageId, null);
    assert.equal(
      snapshot.history[0]!.status,
      "completed",
      "completion before admission response must not remain running",
    );
    const receipt = f.service.roomOperation(room.id, id);
    assert.equal(receipt.state, "saved");
    assert.equal(receipt.messageId, null);
    assert.equal(receipt.wakeupId, snapshot.history[0]!.id);
    await assert.rejects(
      f.service.cancelPreparedRoomOperation(room.id, id),
      /Cannot cancel an admitted/,
    );
    await assert.rejects(
      f.service.prepareRoomMessage(room.id, id, operation.text),
      /different message/,
    );
  } finally {
    await f.close();
  }
});

test("interrupted preparation remains explicit and cancellable across restart without a fabricated welcome", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom(input);
    const id = `${room.operationEpoch}:${randomUUID()}`;
    await f.service.prepareAssistantIntroduction(room.id, id, "en");
    await f.service.stop();
    await f.service.start();
    assert.equal(f.service.roomOperation(room.id, id).state, "prepared");
    assert.equal(f.model.wakeups.length, 0);
    assert.deepEqual(f.service.snapshot().rooms[0]!.messages, []);
    await f.service.cancelPreparedRoomOperation(room.id, id);
    await f.service.stop();
    await f.service.start();
    await assert.rejects(
      f.service.startAssistantIntroduction(room.id, id),
      /cancelled/,
    );
    assert.equal(f.service.roomOperation(room.id, id).state, "cancelled");
    assert.equal(f.model.wakeups.length, 0);
  } finally {
    await f.close();
  }
});

test("failed bootstrap delivery stays explicit and never redispatches after restart", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom(input);
    const id = `${room.operationEpoch}:${randomUUID()}`;
    f.model.failure = true;
    await f.service.prepareAssistantIntroduction(room.id, id, "en");
    await f.service.startAssistantIntroduction(room.id, id);
    assert.equal(f.service.snapshot().history[0]!.status, "failed");
    assert.deepEqual(f.service.snapshot().rooms[0]!.messages, []);
    await f.service.acknowledgeRoomOperation(room.id, id);
    await f.service.stop();
    await f.service.start();
    f.model.failure = false;
    await f.service.startAssistantIntroduction(room.id, id);
    assert.equal(f.model.wakeups.length, 1);
    const runtime = createZenXRoomsProfileLoader(() => f.service as never)({
      createZenXTrustedPlugin,
    });
    const result = (await runtime.invoke("zenx_rooms_list", {
      callId: randomUUID(),
      trustedPluginUi: true,
      cwd: "/project",
      arguments: { input: {} },
      signal: new AbortController().signal,
    })) as { rooms: Array<{ introduction: { state: string; error: string } }> };
    assert.equal(result.rooms[0]!.introduction.state, "failed");
    assert.match(
      result.rooms[0]!.introduction.error,
      /No matching canonical Host receipt.*no wakeup was resent/,
    );
    assert.equal(f.model.readRequests.length, 1);
  } finally {
    await f.close();
  }
});

test("bootstrap commands require trusted UI and cannot be reinterpreted as ordinary Room messaging", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom(input);
    const id = `${room.operationEpoch}:${randomUUID()}`;
    const runtime = createZenXRoomsProfileLoader(() => f.service as never)({
      createZenXTrustedPlugin,
    });
    for (const tool of [
      "zenx_rooms_prepare_introduction",
      "zenx_rooms_start_introduction",
    ]) {
      await assert.rejects(
        runtime.invoke(tool, {
          callId: randomUUID(),
          threadId: "chief-thread",
          cwd: "/project",
          arguments: { roomId: room.id, operationId: id, language: "en" },
          signal: new AbortController().signal,
        }),
        /Trusted Room UI required/,
      );
    }
    const ordinary = await f.service.createRoom(input);
    await assert.rejects(
      f.service.prepareAssistantIntroduction(
        ordinary.id,
        `${ordinary.operationEpoch}:${randomUUID()}`,
        "en",
      ),
      /PAW assistant Room/,
    );
    assert.equal(f.model.wakeups.length, 0);
    assert.deepEqual(
      f.service.snapshot().rooms.map((entry) => entry.messages),
      [[], []],
    );
  } finally {
    await f.close();
  }
});

test("bootstrap reconciles the exact admitted terminal Turn when its completion event is already gone", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom(input);
    const id = `${room.operationEpoch}:${randomUUID()}`;
    const originalRequest = f.model.request.bind(f.model);
    let admitted: {
      threadId: string;
      clientId: string;
      source: "bootstrap";
      text: string;
    };
    let reads = 0;
    f.model.request = async (method, params) => {
      if (method === "zen/turn/wake") {
        admitted = params;
        f.model.wakeups.push(params);
        return { mode: "start", turnId: "early-terminal" };
      }
      assert.equal(method, "zen/thread/resume");
      reads++;
      const recovery = await originalRequest(method, params);
      return {
        ...recovery,
        thread: {
          ...recovery.thread,
          items: [
            {
              id: "canonical-bootstrap",
              threadId: admitted.threadId,
              turnId: "early-terminal",
              createdAt: "2026-01-01T00:00:00Z",
              type: "host_message",
              sender: "host",
              mode: "start",
              clientId: admitted.clientId,
              source: admitted.source,
              text: admitted.text,
            },
          ],
          turns: [{ id: "early-terminal", status: "completed", items: [] }],
        },
      };
    };
    await f.service.prepareAssistantIntroduction(room.id, id, "en");
    await f.service.startAssistantIntroduction(room.id, id);
    assert.equal(reads, 1);
    assert.equal(f.service.snapshot().history[0]!.status, "completed");
    assert.deepEqual(f.service.snapshot().rooms[0]!.messages, []);
  } finally {
    await f.close();
  }
});
