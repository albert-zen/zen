import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { ZenAppServer } from "../../../src/app-server.js";
import { fixture } from "../../../test/thread-message-fixture.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest,
} from "../../../src/model.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import { serveCodexWebSocket } from "../../../src/protocol/codex/websocket.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import { ToolEnvironment } from "../../../src/tool.js";
import {
  attachPawPipe,
  type PawRequest,
} from "../../../packages/zenx-imzenx-plugin/src/paw-pipe.js";
import * as roomsModule from "../../../packages/zenx-rooms-plugin/src/runtime.js";
import { deliverAssistantInput } from "../src/main/assistant-preset.js";
import {
  createBundledAutomationPluginService,
  type ZenXBundledAutomationPluginService,
} from "../src/main/automation-plugin-service.js";
import {
  ZENX_ROOMS_CAPABILITY_ID,
  ZENX_TRIGGERS_CAPABILITY_ID,
} from "../src/main/capabilities/automation-control-package.js";
import { createImZenXPawHandler } from "../src/main/imzenx-paw.js";
import { createZenXRoomsProfileLoader } from "../src/main/rooms-profile-loader.js";
import {
  ZenXProtocolClient,
  type ServerNotificationMethod,
} from "../src/protocol-client/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Room Host barrier timed out")),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
class Events<T> {
  values: T[] = [];
  listeners = new Set<(value: T) => void>();
  add(value: T) {
    this.values.push(value);
    for (const listener of this.listeners) listener(value);
  }
  async wait(predicate: (value: T) => boolean) {
    const old = this.values.find(predicate);
    if (old !== undefined) return old;
    const ready = deferred<T>();
    const listener = (value: T) => {
      if (predicate(value)) ready.resolve(value);
    };
    this.listeners.add(listener);
    try {
      return await within(ready.promise);
    } finally {
      this.listeners.delete(listener);
    }
  }
}
function terminalIdentity(value: { method: string; params: any }): {
  threadId: string;
  turnId: string;
} | null {
  if (value.method === "turn/completed")
    return { threadId: value.params.threadId, turnId: value.params.turn.id };
  if (
    value.method === "zen/thread/event" &&
    value.params.event.type === "turn_completed" &&
    value.params.threadId === value.params.event.threadId
  )
    return {
      threadId: value.params.threadId,
      turnId: value.params.event.turnId,
    };
  return null;
}

interface Snapshot {
  id?: number;
  event?: string;
  error?: string;
  detail?: string;
  text?: string;
  replyTo?: string;
  bindingThreadId: string | null;
  bindingGeneration: number;
  roomId: string | null;
  checkpoint: string | null;
  postStates: Record<string, number>;
  deliveries: Array<{ text: string; replyTo: string | null }>;
}
class Probe {
  child: ChildProcessWithoutNullStreams;
  events = new Events<Snapshot>();
  exited: Promise<void>;
  detach: () => void;
  sequence = 0;
  constructor(config: object, request: PawRequest) {
    const root = path.resolve("../imzen");
    this.child = spawn(
      process.env.IMZEN_TEST_PYTHON ?? path.join(root, ".venv/bin/python"),
      [path.join(root, "tests/zenx_room_probe.py")],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    this.child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const value = JSON.parse(line);
      if (value.type !== "paw-request") this.events.add(value);
    });
    this.exited = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.stdin.once("error", reject);
      this.child.once("exit", (code, signal) =>
        code === 0
          ? resolve()
          : reject(Error(`Room probe exited ${code}/${signal}: ${stderr}`)),
      );
    });
    void this.exited.catch(() => {});
    this.detach = attachPawPipe(this.child, request, () => true);
    this.child.stdin.write(JSON.stringify(config) + "\n");
  }
  async wait(predicate: (value: Snapshot) => boolean) {
    return await Promise.race([
      this.events.wait(predicate),
      this.exited.then(() => {
        throw Error("Probe ended before expected event");
      }),
    ]);
  }
  async command(command: object) {
    const id = ++this.sequence;
    this.child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
    const result = await this.wait((value) => value.id === id);
    assert.equal(result.error, undefined, `${result.error}: ${result.detail}`);
    return result;
  }
  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
      this.detach();
    }
  }
}

// This model is the only semantic fixture. It posts the explicit Room answer
// through the production trusted Rooms runtime, then emits a private Thread
// conclusion. Neither output is inserted into Room/Gateway storage by the test.
class RoomModel implements ModelAdapter {
  readonly provider = "fake";
  readonly requests: ModelRequest[] = [];
  private gate:
    | {
        arrived: ReturnType<typeof deferred<void>>;
        release: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  holdNext() {
    const gate = { arrived: deferred<void>(), release: deferred<void>() };
    this.gate = gate;
    return gate;
  }
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const gate = this.gate;
    this.gate = undefined;
    if (gate) {
      gate.arrived.resolve();
      await gate.release.promise;
    }
    const last = request.messages.at(-1);
    const serialized = JSON.stringify(last);
    const room = serialized.match(/Reply Room ID: ([0-9a-f-]+)/i)?.[1];
    const marker = serialized.match(
      /synthetic-room-(first|unknown|after-restart)/,
    )?.[0];
    if (room && marker) {
      yield {
        type: "tool_call",
        callId: `call-${this.requests.length}`,
        name: "zenx_rooms_post_message",
        arguments: { roomId: room, text: `Formal reply: ${marker}` },
      };
      return;
    }
    yield {
      type: "text_delta",
      delta: serialized.includes("synthetic-normal-baseline")
        ? "Synthetic normal Thread baseline"
        : "PRIVATE synthetic working Thread conclusion",
    };
  }
}

test(
  "production IM PAW pipe admits through Room Host and TriggerService; formal replies survive restart without Thread leakage or unknown replay",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "imzen-room-host-"));
    const other = path.join(root, "other");
    await mkdir(other);
    const tokenFile = path.join(root, "native.token");
    await writeFile(tokenFile, "synthetic-room-host-token", { mode: 0o600 });
    const model = new RoomModel();
    let automation: ZenXBundledAutomationPluginService | undefined;
    let roomsRuntime: ReturnType<
      ReturnType<typeof createZenXRoomsProfileLoader>
    >;
    const toolCalls: string[] = [];
    const app = new ZenAppServer({
      journal: new InMemoryThreadJournal(),
      runtime: new AgentRuntime({
        toolEnvironment: new ToolEnvironment({
          runtimes: [
            {
              name: "zenx_rooms_post_message",
              specification: {
                name: "zenx_rooms_post_message",
                description: "Post a formal Room result",
                inputSchema: {
                  type: "object",
                  properties: {
                    roomId: { type: "string" },
                    text: { type: "string" },
                  },
                  required: ["roomId", "text"],
                },
              },
              async execute(invocation) {
                toolCalls.push(invocation.threadId!);
                const result = await roomsRuntime.invoke(
                  "zenx_rooms_post_message",
                  invocation,
                );
                return { output: JSON.stringify(result), exitCode: 0 };
              },
            },
          ],
        }),
      }),
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: "fake",
          adapter: model,
          modelCatalog: new StaticModelCatalog([
            {
              id: "fake",
              isDefault: true,
              inputModalities: ["text"],
              supportedReasoningEfforts: ["medium"],
              defaultReasoningEffort: "medium",
              contextWindow: 32768,
            },
          ]),
        },
      ]),
      threadMetadata: new InMemoryThreadMetadataStore(),
      defaults: {
        cwd: root,
        providerProfileId: "fake",
        modelId: "fake",
        reasoningEffort: "medium",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
    });
    const server = await serveCodexWebSocket({
      appServer: app,
      zenHome: root,
      listen: "ws://127.0.0.1:0",
      bearerToken: "synthetic-room-host-token",
    });
    let native: ZenXProtocolClient | undefined;
    let probe: Probe | undefined;
    const sdk = {} as Parameters<
      ZenXBundledAutomationPluginService["startPlugin"]
    >[1];
    try {
      native = await ZenXProtocolClient.connect({
        url: server.url,
        bearerTokenFile: tokenFile,
        clientInfo: {
          name: "synthetic-room-host",
          title: "Room Host probe",
          version: "test",
        },
      });
      const notifications = new Events<{ method: string; params: any }>();
      const methods = [
        "zen/thread/event",
        "turn/started",
        "item/completed",
        "turn/completed",
        "error",
      ] as const;
      const wireCalls: Array<{ method: string; params: any }> = [];
      // Transport adapter only: every request reaches authenticated native;
      // actual production services own Room admission, persistence and scheduling.
      const manager = {
        request: async (method: any, params: any) => {
          wireCalls.push({ method, params });
          return await native!.request(method, params);
        },
        onNotification: (listener: (method: any, params: any) => void) => {
          const stops = methods.map((method) =>
            native!.onNotification(
              method as ServerNotificationMethod,
              (params) => listener(method, params),
            ),
          );
          return () => stops.forEach((stop) => stop());
        },
      };
      for (const method of methods)
        native.onNotification(method, (params) => {
          notifications.add({ method, params });
        });
      const working = (await native.request("thread/start", {})).thread.id;
      const old = (await native.request("thread/start", {})).thread.id;
      const foreign = (await native.request("thread/start", { cwd: other }))
        .thread.id;
      const startAutomation = async () => {
        automation = await createBundledAutomationPluginService({
          userDataDirectory: root,
          appServer: {
            ...manager,
            readThread: (threadId) =>
              manager.request("thread/read", { threadId, includeTurns: true }),
            sendAssistant: (params, signal) =>
              deliverAssistantInput(manager, params, signal),
            enqueue: async (params) => {
              await manager.request("turn/queue", params);
            },
          },
          threadTargets: {
            request: manager.request,
            projectProjection: {
              canonicalKeys: async (values) =>
                await Promise.all(values.map((value) => realpath(value))),
            },
          },
        });
        await automation.startPlugin(ZENX_TRIGGERS_CAPABILITY_ID, sdk);
        await automation.startPlugin(ZENX_ROOMS_CAPABILITY_ID, sdk);
        roomsRuntime = createZenXRoomsProfileLoader(() => automation!)(
          roomsModule,
        );
      };
      const stopAutomation = async () => {
        await automation?.stopPlugin(ZENX_ROOMS_CAPABILITY_ID, sdk);
        await automation?.stopPlugin(ZENX_TRIGGERS_CAPABILITY_ID, sdk);
      };
      await startAutomation();
      const room = await automation!.createAssistantRoom({
        name: "Synthetic PAW",
        members: [{ name: "Synthetic assistant", threadId: working }],
      });
      await automation!.createAssistantRoom({
        name: "Foreign workspace PAW",
        members: [{ name: "Foreign assistant", threadId: foreign }],
      });
      const pawHandler = createImZenXPawHandler(
        manager as any,
        () => automation,
      );
      const requests: Array<{
        operation: string;
        params: Readonly<Record<string, unknown>>;
      }> = [];
      let loseResponse = false;
      probe = new Probe(
        {
          settings: {
            IMZEN_APP_SERVER_URL: server.url,
            IMZEN_APP_SERVER_AUTH_TOKEN_FILE: tokenFile,
            IMZEN_CWD: root,
            IMZEN_GATEWAY_STATE_FILE: path.join(root, "gateway.sqlite3"),
            IMZEN_APP_SERVER_SHARED_FILESYSTEM_ROOT: root,
          },
        },
        async (operation, params) => {
          requests.push({ operation, params });
          const result = await pawHandler(root, operation, params);
          if (operation === "post" && loseResponse) {
            loseResponse = false;
            throw Error("Synthetic response lost after actual Room commit");
          }
          return result;
        },
      );
      await probe.wait((value) => value.event === "ready");
      const emit = async (messageId: string, text: string) =>
        await probe!.command({ action: "emit", messageId, text });
      const subscribed = await emit("old-thread", `/subscribe ${old}`);
      assert.equal(subscribed.bindingThreadId, old);
      await native.request("turn/start", {
        threadId: old,
        input: [{ type: "text", text: "synthetic-normal-baseline" }],
      });
      await probe.wait(
        (value) =>
          value.event === "delivery" &&
          value.text === "Synthetic normal Thread baseline",
      );
      const listed = await emit("list-paws", "/paws");
      const listText = listed.deliveries.find(
        (item) => item.replyTo === "list-paws",
      )!.text;
      assert.match(listText, /1\. Synthetic PAW/);
      assert(!listText.includes("Foreign workspace PAW"));
      const selected = await emit("select-paw", "/paw 1");
      assert.equal(selected.roomId, room.id);
      assert.equal(selected.bindingThreadId, null);
      await assert.rejects(
        pawHandler(root, "post", {
          roomId: room.id,
          text: "reject",
          clientId: "reject",
          mode: "queue",
        }),
        /Invalid PAW request fields/,
      );
      const completed = async (threadId: string, since: number) => {
        // Native subscription suppresses duplicate CAS projections at the
        // real client boundary. Observe the canonical terminal identity.
        const event = await notifications.wait(
          (value) =>
            notifications.values.indexOf(value) >= since &&
            terminalIdentity(value)?.threadId === threadId,
        );
        return terminalIdentity(event)!;
      };
      const firstStart = notifications.values.length;
      await emit("first-input", "synthetic-room-first 你好");
      await completed(working, firstStart);
      const first = await probe.command({ action: "poll" });
      assert.equal(
        first.deliveries.filter(
          (item) => item.text === "Formal reply: synthetic-room-first",
        ).length,
        1,
      );
      assert.equal(toolCalls.length, 1);
      assert.deepEqual(toolCalls, [working]);
      const firstPost = requests.find((value) => value.operation === "post")!;
      assert.deepEqual(Object.keys(firstPost.params).sort(), [
        "clientId",
        "roomId",
        "text",
      ]);
      await emit("first-input", "synthetic-room-first 你好");
      await pawHandler(root, "post", firstPost.params);
      assert.equal(
        automation!
          .snapshot()
          .rooms.find((r) => r.id === room.id)!
          .messages.filter((m) => m.kind === "human").length,
        1,
      );
      assert.equal(toolCalls.length, 1);
      // Old ordinary Thread output and the PAW's private final output stay private.
      const oldStart = notifications.values.length;
      await native.request("turn/start", {
        threadId: old,
        input: [{ type: "text", text: "synthetic-old-private" }],
      });
      await completed(old, oldStart);
      const staged = await probe.command({
        action: "stage-stale-thread",
        threadId: old,
        actionId: "interrupted-pick-one",
      });
      assert.equal(staged.bindingThreadId, old);
      const staleStart = notifications.values.length;
      await native.request("turn/start", {
        threadId: old,
        input: [{ type: "text", text: "synthetic-stale-private" }],
      });
      await completed(old, staleStart);
      const restarted = await probe.command({ action: "restart" });
      assert.equal(restarted.bindingThreadId, null);
      assert.equal(restarted.roomId, room.id);
      // A second interrupted /pick has a new SDK generation beside the same
      // Room generation. Recovery must not reuse the first clear receipt.
      const secondStale = await probe.command({
        action: "stage-stale-thread",
        threadId: old,
        actionId: "interrupted-pick-two",
      });
      assert.equal(secondStale.bindingThreadId, old);
      const secondRestored = await probe.command({ action: "restart" });
      assert.equal(secondRestored.bindingThreadId, null);
      assert(secondRestored.bindingGeneration > restarted.bindingGeneration);
      assert(
        !restarted.deliveries.some((item) => item.text.includes("PRIVATE")),
      );
      const unknownStart = notifications.values.length;
      loseResponse = true;
      const unknown = await emit("unknown-input", "synthetic-room-unknown");
      assert.match(
        unknown.deliveries.find((item) => item.replyTo === "unknown-input")!
          .text,
        /unknown.*not be retried automatically/,
      );
      assert.equal(unknown.postStates.unknown, 1);
      await completed(working, unknownStart);
      await probe.command({ action: "poll" });
      const postsBefore = requests.filter(
        (value) => value.operation === "post",
      ).length;
      const toolsBefore = toolCalls.length;
      await stopAutomation();
      await startAutomation();
      await probe.command({ action: "restart" });
      await emit("unknown-input", "synthetic-room-unknown");
      await probe.command({ action: "poll" });
      assert.equal(
        requests.filter((value) => value.operation === "post").length,
        postsBefore,
      );
      assert.equal(toolCalls.length, toolsBefore);
      const lastStart = notifications.values.length;
      const gate = model.holdNext();
      const active = await native.request("turn/start", {
        threadId: working,
        input: [{ type: "text", text: "synthetic-active-private" }],
      });
      await within(gate.arrived.promise);
      try {
        await emit("after-restart", "synthetic-room-after-restart");
      } finally {
        gate.release.resolve();
      }
      const terminal = await completed(working, lastStart);
      assert.equal(terminal.turnId, active.turn.id);
      // The canonical admission observer below verifies the mode; the Room post
      // itself deliberately supplies no scheduling flag or Composer preference.
      const admission = wireCalls
        .filter((call) =>
          ["turn/start", "turn/steer", "turn/queue", "zen/turn/wake"].includes(
            call.method,
          ),
        )
        .at(-1)!;
      assert(["turn/steer", "zen/turn/wake"].includes(admission.method));
      assert.notEqual(admission.params.mode, "queue");
      const final = await probe.command({ action: "poll" });
      await probe.command({ action: "poll" });
      const settled = await probe.command({ action: "restart" });
      assert.equal(settled.bindingThreadId, null);
      assert.equal(settled.roomId, room.id);
      assert(!settled.deliveries.some((item) => item.text.includes("PRIVATE")));
      for (const text of [
        "synthetic-room-first",
        "synthetic-room-unknown",
        "synthetic-room-after-restart",
      ])
        assert.equal(
          settled.deliveries.filter(
            (item) => item.text === `Formal reply: ${text}`,
          ).length,
          1,
        );
      assert.equal(final.postStates.accepted, 2);
      assert.equal(final.postStates.unknown, 1);
      const saved = automation!.snapshot().rooms.find((r) => r.id === room.id)!;
      assert.equal(saved.messages.filter((m) => m.kind === "human").length, 3);
      assert.equal(
        saved.messages.find((m) => m.kind === "human")!.text,
        "synthetic-room-first 你好",
      );
      const histories = automation!
        .snapshot()
        .history.filter((entry) => entry.sourceRoomId === room.id);
      assert.equal(histories.length, 3);
      assert(
        histories.every((entry) => entry.status === "completed"),
        JSON.stringify(
          histories.map((entry) => ({
            status: entry.status,
            error: entry.error,
          })),
        ),
      );
      assert.equal(saved.messages.filter((m) => m.kind === "agent").length, 3);
      assert(
        saved.messages
          .filter((m) => m.kind === "agent")
          .every(
            (m) =>
              m.author === "Synthetic assistant" &&
              m.originThreadId === working,
          ),
      );
      const nativeWakeCalls = wireCalls.filter(
        (call) => call.method === "zen/turn/wake",
      );
      // Older Hosts have no independent Room delivery configuration. Once that
      // public capability exists, never silently fall back to the legacy test
      // path if the production Host stops using canonical wake admission.
      if ("setAssistantDeliveryMode" in automation!)
        assert(
          nativeWakeCalls.length > 0,
          "Configured Room Host must use native wake admission",
        );
      let canonicalHostSteer = false;
      let independentRoomQueueAndTriggerSteer = false;
      if (nativeWakeCalls.length > 0) {
        const canonical = (
          await native.request("zen/thread/read", { threadId: working })
        ).thread.items as readonly any[];
        const hostInputs = canonical.filter(
          (item) => item.type === "host_message",
        );
        assert.equal(hostInputs.length, 3);
        assert(
          hostInputs.every(
            (item) =>
              item.sender === "host" &&
              item.source === "room" &&
              item.sourceId === room.id,
          ),
        );
        const activeHost = hostInputs.find(
          (item) => item.clientId === admission.params.clientId,
        )!;
        assert.equal(activeHost.turnId, active.turn.id);
        assert.equal(activeHost.mode, "steer");
        assert(activeHost.text.includes("synthetic-room-after-restart"));
        assert(
          !canonical.some(
            (item) =>
              item.type === "user_message" &&
              item.clientId === activeHost.clientId,
          ),
        );
        canonicalHostSteer = true;

        // Real independent configuration: setting this Room to queue must not
        // change an independent signal Trigger's omitted (soft-steer) default.
        const configured =
          automation as unknown as ZenXBundledAutomationPluginService & {
            setAssistantDeliveryMode(
              roomId: string,
              mode: "steer" | "queue",
            ): Promise<void>;
          };
        await configured.setAssistantDeliveryMode(room.id, "queue");
        const trigger = await automation!.create({
          kind: "signal",
          threadId: working,
          label: "Independent synthetic signal",
          prompt: "synthetic-independent-trigger",
          signalName: "synthetic-signal",
        });
        const configGate = model.holdNext();
        const configStart = notifications.values.length;
        const configTurn = await native.request("turn/start", {
          threadId: working,
          input: [{ type: "text", text: "synthetic-config-private" }],
        });
        await within(configGate.arrived.promise);
        let roomQueueCall: (typeof wireCalls)[number];
        let triggerSteerCall: (typeof wireCalls)[number];
        try {
          await emit("explicit-room-queue", "synthetic-config-queued-room");
          roomQueueCall = wireCalls
            .filter((call) => call.method === "zen/turn/wake")
            .at(-1)!;
          assert.equal(roomQueueCall.params.mode, "queue");
          assert.equal(roomQueueCall.params.source, "room");
          const queued = (
            await native.request("zen/thread/read", { threadId: working })
          ).thread.items as readonly any[];
          assert(
            queued.some(
              (item) =>
                item.type === "host_message_queued" &&
                item.clientId === roomQueueCall.params.clientId &&
                item.intent === "queue",
            ),
          );
          assert(
            !queued.some(
              (item) =>
                item.type === "host_message" &&
                item.clientId === roomQueueCall.params.clientId,
            ),
          );
          await automation!.signal(
            "synthetic-signal",
            "synthetic-signal-detail",
          );
          triggerSteerCall = wireCalls
            .filter((call) => call.method === "zen/turn/wake")
            .at(-1)!;
          assert.equal(triggerSteerCall.params.source, "trigger");
          assert.equal(triggerSteerCall.params.sourceId, trigger.id);
          assert.equal(triggerSteerCall.params.mode, undefined);
          const steered = (
            await native.request("zen/thread/read", { threadId: working })
          ).thread.items as readonly any[];
          assert(
            steered.some(
              (item) =>
                item.type === "host_message" &&
                item.clientId === triggerSteerCall.params.clientId &&
                item.turnId === configTurn.turn.id &&
                item.mode === "steer",
            ),
          );
        } finally {
          configGate.release.resolve();
        }
        await completed(working, configStart);
        await notifications.wait(
          (value) =>
            notifications.values.indexOf(value) >= configStart &&
            terminalIdentity(value)?.threadId === working &&
            terminalIdentity(value)?.turnId !== configTurn.turn.id,
        );
        const delivered = (
          await native.request("zen/thread/read", { threadId: working })
        ).thread.items as readonly any[];
        const queuedRoom = delivered.find(
          (item) =>
            item.type === "host_message" &&
            item.clientId === roomQueueCall!.params.clientId,
        )!;
        assert(queuedRoom);
        assert.notEqual(queuedRoom.turnId, configTurn.turn.id);
        independentRoomQueueAndTriggerSteer = true;
        const isolated = await probe.command({ action: "restart" });
        assert(
          !isolated.deliveries.some((item) => item.text.includes("PRIVATE")),
        );
      }
      t.diagnostic(
        JSON.stringify({
          canonicalHostSteer,
          independentRoomQueueAndTriggerSteer,
          roomCount: 2,
          roomHumanPosts: 3,
          formalReplies: 3,
          unknownPosts: final.postStates.unknown,
          privateLeaks: 0,
          nativeAdmissions: wireCalls
            .filter((call) =>
              [
                "turn/start",
                "turn/steer",
                "turn/queue",
                "zen/turn/wake",
              ].includes(call.method),
            )
            .map((call) => ({
              method: call.method,
              mode: call.params.mode ?? "native-default",
            })),
        }),
      );
      await stopAutomation();
    } finally {
      try {
        await probe?.close();
      } finally {
        try {
          await automation?.stopPlugin(ZENX_ROOMS_CAPABILITY_ID, sdk);
          await automation?.stopPlugin(ZENX_TRIGGERS_CAPABILITY_ID, sdk);
        } finally {
          native?.close();
          await server.close();
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  },
);

test("Room Host completion observer preserves exact native Turn identity after CAS projection suppression", async () => {
  const release = deferred<void>();
  const f = fixture({
    provider: "room-observer",
    async *stream() {
      await release.promise;
      yield { type: "text_delta", delta: "Real Host completion" };
    },
  });
  const server = await serveCodexWebSocket({
    appServer: f.server,
    zenHome: os.tmpdir(),
    listen: "ws://127.0.0.1:0",
  });
  const client = await ZenXProtocolClient.connect({
    url: server.url,
    clientInfo: {
      name: "room-observer",
      title: "Room observer",
      version: "test",
    },
  });
  const events = new Events<{ method: string; params: any }>();
  try {
    for (const method of ["turn/completed", "zen/thread/event"] as const)
      client.onNotification(method, (params) => events.add({ method, params }));
    const threadId = (await client.request("thread/start", {})).thread.id;
    const receipt = await client.request("zen/turn/wake", {
      threadId,
      clientId: "exact-room-client",
      source: "room",
      sourceId: "exact-room",
      text: "Actual Room input",
    });
    release.resolve();
    const event = await events.wait(
      (value) => terminalIdentity(value)?.threadId === threadId,
    );
    assert.equal(event.method, "zen/thread/event");
    assert.deepEqual(terminalIdentity(event), {
      threadId,
      turnId: receipt.turnId,
    });
    const read = await client.request("zen/thread/read", { threadId });
    assert.equal(read.thread.turns.at(-1)?.status, "completed");
    assert(
      read.thread.items.some(
        (item) =>
          item.type === "host_message" &&
          item.clientId === "exact-room-client" &&
          item.source === "room" &&
          item.sourceId === "exact-room" &&
          item.turnId === receipt.turnId,
      ),
    );
    assert.equal(
      events.values.filter((value) => value.method === "turn/completed").length,
      0,
      "The client still suppresses duplicate legacy completion",
    );
    assert.equal(
      terminalIdentity({
        method: "zen/thread/event",
        params: {
          threadId: "foreign",
          event: { type: "turn_completed", threadId, turnId: receipt.turnId },
        },
      }),
      null,
    );
  } finally {
    release.resolve();
    client.close();
    await server.close();
  }
});
