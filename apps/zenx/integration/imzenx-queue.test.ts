import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { ZenAppServer, type AppServerEvent } from "../../../src/app-server.js";
import { contentFromUserMessage } from "../../../src/item.js";
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
import { png1x1 } from "../../../test/fixtures.js";
import { ZenXProtocolClient } from "../src/protocol-client/index.js";

// Model arrival/release, native completion and actual channel delivery are
// explicit barriers. Timeouts bound failures; no timing sleep repairs races.
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
          () => reject(new Error("queue barrier timed out")),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
class EventLog<T> {
  readonly values: T[] = [];
  readonly waiters = new Set<(value: T) => void>();
  add(value: T) {
    this.values.push(value);
    for (const handler of this.waiters) handler(value);
  }
  async waitFor(
    predicate: (value: T) => boolean,
    stopped?: () => Promise<never>,
  ) {
    const existing = this.values.find(predicate);
    if (existing !== undefined) return existing;
    const ready = deferred<T>();
    const handler = (value: T) => {
      if (predicate(value)) ready.resolve(value);
    };
    this.waiters.add(handler);
    try {
      return await within(
        stopped ? Promise.race([ready.promise, stopped()]) : ready.promise,
      );
    } finally {
      this.waiters.delete(handler);
    }
  }
}
interface ModelGate {
  arrived: ReturnType<typeof deferred<void>>;
  release: ReturnType<typeof deferred<void>>;
}
class DeferredModel implements ModelAdapter {
  readonly provider = "fake";
  readonly requests: ModelRequest[] = [];
  readonly gates: ModelGate[] = [];
  private next: ModelGate | undefined;
  holdNext(): ModelGate {
    const gate = { arrived: deferred<void>(), release: deferred<void>() };
    this.next = gate;
    this.gates.push(gate);
    return gate;
  }
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const gate = this.next;
    this.next = undefined;
    if (gate) {
      gate.arrived.resolve();
      await gate.release.promise;
    }
    if (request.signal.aborted) return;
    const lastUser = request.messages
      .filter((message) => message.role === "user")
      .at(-1);
    assert(lastUser && "content" in lastUser);
    // Receipt metadata is its own semantic part, not the original IM body.
    // Echo only the body; keep the routing assertions below exact.
    const [receipt, ...input] = lastUser.content;
    assert(receipt?.type === "text");
    assert.match(receipt.text, /^\[Message received at [^\]\n]+\]$/);
    const text = input
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (
      request.messages.at(-1)?.role === "user" &&
      text.includes("needs-approval")
    ) {
      yield {
        type: "tool_call",
        callId: "queue-approval-call",
        name: "fixture",
        arguments: {},
      };
      return;
    }
    yield { type: "text_delta", delta: `Queue answer: ${text}` };
  }
}
interface Delivery {
  text: string;
  replyTo: string | null;
  formats: string[];
  conversation: string;
}
interface ProbeSnapshot {
  id?: number;
  event?: string;
  error?: string;
  detail?: string;
  text?: string;
  conversation?: string;
  replyTo?: string;
  inputContinuation: string;
  bindingThreadId: string | null;
  pawRoomId: string | null;
  wireCalls: Array<{ method: string; params: Record<string, unknown> }>;
  deliveries: Delivery[];
  queueReceipts: Array<{
    messageId: string;
    conversation: string;
    actorFingerprint: string;
    threadId: string;
    clientMessageId: string;
    inputFingerprint: string;
    state: string;
    turnId: string;
  }>;
  correlations: Array<{
    threadId: string;
    turnId: string;
    replyTo: string;
    clientMessageId: string;
  }>;
}
class QueueProbe {
  readonly events = new EventLog<ProbeSnapshot>();
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  private nextId = 0;
  private stderr = "";
  constructor(config: object) {
    const imRoot = path.resolve("../imzen");
    const python =
      process.env.IMZEN_TEST_PYTHON ??
      path.join(
        imRoot,
        ".venv",
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
      );
    this.child = spawn(
      python,
      [path.join(imRoot, "tests/zenx_queue_probe.py")],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.events.add(JSON.parse(line) as ProbeSnapshot);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.exited = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.stdin.once("error", reject);
      this.child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `IM queue probe exited ${String(code)}/${String(signal)}: ${this.stderr}`,
            ),
          );
      });
    });
    void this.exited.catch(() => {});
    this.child.stdin.write(JSON.stringify(config) + "\n");
  }
  async waitFor(predicate: (value: ProbeSnapshot) => boolean) {
    return await this.events.waitFor(predicate, () =>
      this.exited.then(() => {
        throw new Error("IM queue probe ended before expected event");
      }),
    );
  }
  async command(command: object) {
    const id = ++this.nextId;
    this.child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
    const result = await this.waitFor((value) => value.id === id);
    assert.equal(result.error, undefined, `${result.error}: ${result.detail}`);
    return result;
  }
  async emit(messageId: string, text: string, extra: object = {}) {
    return await this.command({ action: "emit", messageId, text, ...extra });
  }
  async answer(replyTo: string) {
    return await this.waitFor(
      (event) =>
        event.event === "delivery" &&
        event.replyTo === replyTo &&
        Boolean(event.text?.startsWith("Queue answer:")),
    );
  }
  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
function reply(snapshot: ProbeSnapshot, messageId: string) {
  const message = snapshot.deliveries.findLast(
    (entry) => entry.replyTo === messageId,
  );
  assert(
    message,
    `missing response to ${messageId}: ${JSON.stringify(snapshot)}`,
  );
  return message;
}
async function evidence(name: string, value: unknown) {
  const directory = process.env.IMZEN_QUEUE_EVIDENCE_DIR;
  if (directory)
    await writeFile(
      path.join(directory, name + ".json"),
      JSON.stringify(value, null, 2) + "\n",
    );
}
function sends(snapshot: ProbeSnapshot) {
  return snapshot.wireCalls.filter(
    (call) =>
      call.method === "zen/turn/send" ||
      call.method === "zen/turn/send-unarchived" ||
      call.method === "turn/start" ||
      call.method === "turn/steer",
  );
}
async function fixture(options: { approval?: boolean; paw?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "imzenx-queue-"));
  const image = path.join(root, "input.png");
  const tokenFile = path.join(root, "app-server.token");
  await writeFile(image, png1x1());
  await writeFile(tokenFile, "synthetic-queue-token", { mode: 0o600 });
  const model = new DeferredModel();
  const journal = new InMemoryThreadJournal();
  let fixtureExecutions = 0;
  const appServer = new ZenAppServer({
    journal,
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({
        runtimes: [
          {
            name: "fixture",
            specification: {
              name: "fixture",
              description: "Synthetic approval",
              inputSchema: { type: "object", properties: {} },
            },
            async execute() {
              fixtureExecutions += 1;
              return { output: "queue-approved", exitCode: 0 };
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
            inputModalities: ["text", "image"],
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
  const events = new EventLog<AppServerEvent>();
  const unsubscribe = appServer.subscribe((event) => events.add(event));
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: root,
    listen: "ws://127.0.0.1:0",
    bearerToken: "synthetic-queue-token",
  });
  const desktop = await ZenXProtocolClient.connect({
    url: server.url,
    bearerTokenFile: tokenFile,
    clientInfo: { name: "queue-observer", title: "ZenX", version: "test" },
  });
  const probe = new QueueProbe({
    paw: options.paw,
    settings: {
      IMZEN_APP_SERVER_URL: server.url,
      IMZEN_APP_SERVER_AUTH_TOKEN_FILE: tokenFile,
      IMZEN_CWD: root,
      IMZEN_GATEWAY_STATE_FILE: path.join(root, "gateway.sqlite3"),
      IMZEN_APP_SERVER_SHARED_FILESYSTEM_ROOT: root,
      IMZEN_INPUT_CONTINUATION: "queue",
      IMZEN_PERMISSION_MODE: options.approval
        ? "approval-required"
        : "full-access",
    },
  });
  const ready = await probe.waitFor((event) => event.event === "ready");
  assert.equal(ready.inputContinuation, "queue");
  assert.equal(
    ready.bindingThreadId,
    null,
    "real first ingress must create its own Thread",
  );
  return {
    probe,
    model,
    journal,
    desktop,
    events,
    image,
    executions: () => fixtureExecutions,
    read: async (threadId: string) =>
      (await desktop.request("zen/thread/read", { threadId })).thread,
    completed: async (turnId: string) =>
      await events.waitFor(
        (event) => event.type === "turn_completed" && event.turnId === turnId,
      ),
    async close() {
      for (const gate of model.gates) gate.release.resolve();
      try {
        await probe.close();
      } finally {
        unsubscribe();
        desktop.close();
        try {
          await server.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    },
  };
}

test(
  "real IM queue ingress preserves approval, image, scoped controls and original replies",
  { timeout: 30000 },
  async () => {
    const h = await fixture({ approval: true });
    try {
      const gate = h.model.holdNext();
      const first = await h.probe.emit("first", "first-needs-approval");
      await within(gate.arrived.promise);
      const threadId = first.bindingThreadId!;
      assert(threadId);
      const created = await h.read(threadId);
      assert.equal(created.approvalPolicy, "always");
      assert.equal(created.sandbox, "danger-full-access");
      assert.equal(
        first.wireCalls.filter((call) => call.method === "thread/start").length,
        1,
      );
      assert.equal(sends(first).length, 1);
      assert.equal(sends(first)[0]!.params.mode, "queue");
      gate.release.resolve();
      const approval = await h.probe.waitFor(
        (event) =>
          event.event === "delivery" &&
          Boolean(event.text?.includes("/approve ")),
      );
      assert.equal(approval.replyTo, "first");
      const requestId = /\/approve ([^`\s]+)/.exec(approval.text!)?.[1];
      assert(requestId);
      assert.equal(h.executions(), 0);
      const second = await h.probe.emit("second", "second-image", {
        image: h.image,
      });
      assert.match(reply(second, "second").text, /waiting for a turn/);
      assert(reply(second, "second").text.length < 1500);
      assert.deepEqual(reply(second, "second").formats, ["markdown"]);
      assert.equal(second.correlations.length, 1);
      assert.equal(second.correlations[0]!.replyTo, "first");
      assert.equal(
        second.correlations[0]!.turnId,
        second.queueReceipts.find((item) => item.messageId === "first")!.turnId,
      );
      assert.equal(sends(second).length, 2);
      assert(sends(second).every((call) => call.params.mode === "queue"));
      assert(
        sends(second).every(
          (call) => !["turn/start", "turn/steer"].includes(call.method),
        ),
        "image upload must never start a turn as a workaround",
      );
      const imageInput = sends(second)[1]!.params.input as Array<{
        type: string;
      }>;
      assert(imageInput.some((part) => part.type === "image_bytes"));
      const active = await h.read(threadId);
      assert.equal(
        active.items.filter((item) => item.type === "user_message").length,
        1,
      );
      assert.equal(
        active.items.filter((item) => item.type === "user_message_queued")
          .length,
        2,
      );
      const queued = active.items.findLast(
        (item) => item.type === "user_message_queued",
      );
      assert(queued && queued.input.some((part) => part.type === "image"));
      const duplicate = await h.probe.emit(
        "second",
        "changed-redelivery-must-not-append",
      );
      assert.deepEqual(sends(duplicate), sends(second));
      assert.deepEqual((await h.read(threadId)).items, active.items);
      await h.probe.emit("cancel-me", "must-never-run");
      const foreignActor = await h.probe.emit(
        "wrong-actor",
        "/unqueue cancel-me",
        { actor: "other" },
      );
      assert.match(
        reply(foreignActor, "wrong-actor").text,
        /unauthorized|not authorized|not found/i,
      );
      const foreignRoom = await h.probe.emit(
        "wrong-room",
        "/queued cancel-me",
        { conversation: "other" },
      );
      assert.match(reply(foreignRoom, "wrong-room").text, /not found/i);
      assert.equal(
        foreignRoom.wireCalls.filter(
          (call) => call.method === "zen/thread/queue/cancel",
        ).length,
        0,
        "unauthorized controls must not reach the native cancellation mutation",
      );
      const checked = await h.probe.emit("check", "/queued cancel-me");
      assert.match(reply(checked, "check").text, /waiting for a turn/);
      const cancelled = await h.probe.emit("cancel", "/unqueue cancel-me");
      assert.match(reply(cancelled, "cancel").text, /cancelled/);
      assert.equal(cancelled.bindingThreadId, threadId);
      const canonicalCancelled = (await h.read(threadId)).items;
      assert.equal(
        canonicalCancelled.filter(
          (item) => item.type === "user_message_queue_cancelled",
        ).length,
        1,
      );
      await h.probe.emit("cancel", "/unqueue cancel-me");
      assert.deepEqual((await h.read(threadId)).items, canonicalCancelled);
      const approved = await h.probe.emit("approve", `/approve ${requestId}`);
      assert.match(reply(approved, "approve").text, /accept/);
      await h.probe.answer("first");
      await h.probe.answer("second");
      const final = await h.probe.command({ action: "snapshot" });
      // Terminal events may legitimately remove temporary turn reply rows.
      // Durable queued origins retain the original Turn, client and IM identity.
      const correlations = final.queueReceipts.filter((item) =>
        ["first", "second"].includes(item.messageId),
      );
      assert.deepEqual(correlations.map((item) => item.messageId).sort(), [
        "first",
        "second",
      ]);
      assert.equal(new Set(correlations.map((item) => item.turnId)).size, 2);
      for (const correlation of correlations)
        await h.completed(correlation.turnId);
      assert.equal(h.executions(), 1);
      assert.deepEqual(
        final.deliveries
          .filter((message) => message.text.startsWith("Queue answer:"))
          .map((message) => message.replyTo),
        ["first", "second"],
      );
      const done = await h.read(threadId);
      assert.equal(
        done.items.filter((item) => item.type === "user_message").length,
        2,
      );
      assert.equal(
        done.items.filter((item) => item.type === "turn_started").length,
        2,
      );
      for (const receipt of correlations) {
        assert.equal(receipt.state, "admitted");
        assert.equal(receipt.threadId, threadId);
        assert.equal(receipt.conversation, "chat-1");
        assert(receipt.actorFingerprint && receipt.inputFingerprint);
        assert(
          done.items.some(
            (item) =>
              item.type === "user_message" &&
              item.turnId === receipt.turnId &&
              item.clientId === receipt.clientMessageId,
          ),
        );
      }
      assert.deepEqual(await h.journal.read(threadId), done.items);
      await evidence("consumer-queue-approval-image", {
        held: second,
        final,
        canonical: done,
      });
      assert(
        h.model.requests.some((request) =>
          request.messages.some(
            (message) =>
              message.role === "user" &&
              "content" in message &&
              message.content.some((part) => part.type === "image"),
          ),
        ),
      );
      const admitted = await h.probe.emit("already-started", "/unqueue second");
      assert.match(reply(admitted, "already-started").text, /already started/);
      assert.doesNotMatch(reply(admitted, "already-started").text, /cancelled/);
      const status = await h.probe.emit("admitted-status", "/queued second");
      assert.match(
        reply(status, "admitted-status").text,
        /not confirmation of completion/,
      );
      assert.equal(status.bindingThreadId, threadId);
    } finally {
      await h.close();
    }
  },
);

test(
  "IM Python Gateway restart restores SQLite queue even after input default changes to steer",
  { timeout: 30000 },
  async () => {
    const h = await fixture();
    try {
      const gate = h.model.holdNext();
      const first = await h.probe.emit("restart-first", "restart-first-input");
      await within(gate.arrived.promise);
      const threadId = first.bindingThreadId!;
      const second = await h.probe.emit(
        "restart-second",
        "restart-second-input",
      );
      assert.match(reply(second, "restart-second").text, /waiting for a turn/);
      const before = await h.read(threadId);
      const restarted = await h.probe.command({
        action: "restart",
        mode: "steer",
      });
      assert.equal(restarted.inputContinuation, "steer");
      assert.equal(restarted.bindingThreadId, threadId);
      assert.deepEqual(sends(restarted), sends(second));
      const checked = await h.probe.emit(
        "restart-check",
        "/queued restart-second",
      );
      assert.match(reply(checked, "restart-check").text, /waiting for a turn/);
      const duplicate = await h.probe.emit(
        "restart-second",
        "changed-after-restart",
      );
      assert.deepEqual(sends(duplicate), sends(second));
      assert.deepEqual((await h.read(threadId)).items, before.items);
      gate.release.resolve();
      await h.probe.answer("restart-first");
      await h.probe.answer("restart-second");
      const final = await h.probe.command({ action: "snapshot" });
      for (const item of final.queueReceipts) await h.completed(item.turnId);
      const done = await h.read(threadId);
      assert.equal(
        done.items.filter((item) => item.type === "user_message_queued").length,
        2,
      );
      assert.equal(
        done.items.filter((item) => item.type === "user_message").length,
        2,
      );
      assert.deepEqual(
        final.queueReceipts.map((item) => item.messageId).sort(),
        ["restart-first", "restart-second"],
      );
      for (const receipt of final.queueReceipts) {
        assert.equal(receipt.state, "admitted");
        const original = second.queueReceipts.find(
          (item) => item.messageId === receipt.messageId,
        )!;
        assert.equal(receipt.clientMessageId, original.clientMessageId);
        assert.equal(receipt.inputFingerprint, original.inputFingerprint);
        assert.equal(receipt.actorFingerprint, original.actorFingerprint);
        assert.equal(receipt.conversation, original.conversation);
        assert(
          done.items.some(
            (item) =>
              item.type === "user_message" &&
              item.turnId === receipt.turnId &&
              item.clientId === receipt.clientMessageId,
          ),
        );
      }
      assert.deepEqual(
        final.deliveries
          .filter((message) => message.text.startsWith("Queue answer:"))
          .map((message) => message.replyTo),
        ["restart-first", "restart-second"],
      );
      await evidence("consumer-queue-python-restart", {
        before: second,
        restarted,
        final,
        canonical: done,
      });
      const ordinary = await h.probe.emit(
        "new-default",
        "ordinary-steer-default",
      );
      assert.equal(sends(ordinary).at(-1)?.method, "turn/start");
      await h.probe.answer("new-default");
    } finally {
      await h.close();
    }
  },
);

test(
  "PAW switch preserves original queue controls while private native output stays in its subscribed conversation",
  { timeout: 30000 },
  async () => {
    const h = await fixture({ paw: true });
    try {
      const gate = h.model.holdNext();
      const first = await h.probe.emit("paw-first", "paw-private-first");
      await within(gate.arrived.promise);
      const threadId = first.bindingThreadId!;
      await h.probe.emit("paw-cancel", "paw-private-cancelled");
      await h.probe.emit("paw-last", "paw-private-last");
      // A second real subscription is a positive delivery barrier: native final
      // output is actually projected while the switched Conversation stays fenced.
      await h.probe.emit("watch", `/subscribe ${threadId}`, {
        conversation: "observer",
      });
      const selected = await h.probe.emit("choose-paw", "/paw room-1");
      assert.equal(selected.bindingThreadId, null);
      assert.equal(selected.pawRoomId, "room-1");
      const offset = selected.deliveries.length;
      const checked = await h.probe.emit("paw-check", "/queued paw-cancel");
      assert.match(reply(checked, "paw-check").text, /waiting for a turn/);
      const cancelled = await h.probe.emit(
        "paw-unqueue",
        "/unqueue paw-cancel",
      );
      assert.match(reply(cancelled, "paw-unqueue").text, /cancelled/);
      assert.equal(cancelled.bindingThreadId, null);
      assert.equal(cancelled.pawRoomId, "room-1");
      gate.release.resolve();
      await h.probe.waitFor(
        (event) =>
          event.event === "delivery" &&
          event.conversation === "observer" &&
          Boolean(event.text?.startsWith("Queue answer: paw-private-last")),
      );
      const canonical = await h.read(threadId);
      const started = canonical.items.filter(
        (item) => item.type === "turn_started",
      );
      assert.equal(started.length, 2);
      for (const item of started) await h.completed(item.turnId);
      const users = canonical.items.filter(
        (item) => item.type === "user_message",
      );
      assert.deepEqual(users.map(contentFromUserMessage), [
        [{ type: "text", text: "paw-private-first" }],
        [{ type: "text", text: "paw-private-last" }],
      ]);
      assert.deepEqual(
        h.model.requests.map((request) =>
          request.messages.findLast((message) => message.role === "user"),
        ),
        users.map((user) => {
          const queued = canonical.items.find(
            (item) =>
              item.type === "user_message_queued" &&
              item.clientId === user.clientId,
          );
          assert(queued?.type === "user_message_queued");
          assert.deepEqual(queued.input, contentFromUserMessage(user));
          return {
            role: "user",
            content: [
              {
                type: "text",
                text: `[Message received at ${queued.createdAt}]`,
              },
              ...queued.input,
            ],
          };
        }),
      );
      const final = await h.probe.command({ action: "snapshot" });
      assert(
        final.deliveries.some(
          (message) =>
            message.conversation === "observer" &&
            message.text === "Queue answer: paw-private-first",
        ),
      );
      assert(
        final.deliveries.some(
          (message) =>
            message.conversation === "observer" &&
            message.text === "Queue answer: paw-private-last",
        ),
      );
      assert(
        !final.deliveries
          .slice(offset)
          .some(
            (message) =>
              message.conversation === "chat-1" &&
              ["paw-first", "paw-cancel", "paw-last"].includes(
                message.replyTo ?? "",
              ),
          ),
        "neither private finals nor automatic queue notices may leak after PAW selection",
      );
      const restarted = await h.probe.command({
        action: "restart",
        mode: "steer",
      });
      assert.equal(restarted.bindingThreadId, null);
      assert.equal(restarted.pawRoomId, "room-1");
      assert.deepEqual(sends(restarted), sends(final));
      const admitted = await h.probe.emit(
        "paw-final-status",
        "/queued paw-last",
      );
      assert.match(
        reply(admitted, "paw-final-status").text,
        /not confirmation of completion/,
      );
      assert.equal(admitted.bindingThreadId, null);
      assert.equal(admitted.pawRoomId, "room-1");
      await evidence("consumer-queue-paw-isolation", {
        selected,
        final,
        restarted,
        admitted,
        canonical,
      });
      assert(
        !admitted.deliveries
          .slice(offset)
          .some(
            (message) =>
              message.conversation === "chat-1" &&
              ["paw-first", "paw-cancel", "paw-last"].includes(
                message.replyTo ?? "",
              ),
          ),
      );
    } finally {
      await h.close();
    }
  },
);
