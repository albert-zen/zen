import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { ZenAppServer, type AppServerEvent } from "../../../src/app-server.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { contentFromUserMessage } from "../../../src/item.js";
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
import {
  applyNativeThreadEvent,
  projectNativeRecovery,
} from "../src/renderer/src/thread-view-state.js";

// Model arrival/release, protocol events, and probe responses are explicit
// barriers. No timing sleeps or live channel/model/service are needed.
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
          () => reject(new Error("steering barrier timed out")),
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
  add(value: T): void {
    this.values.push(value);
    for (const waiter of this.waiters) waiter(value);
  }
  async waitFor(
    predicate: (value: T) => boolean,
    stopped?: () => Promise<never>,
  ): Promise<T> {
    const existing = this.values.find(predicate);
    if (existing !== undefined) return existing;
    const ready = deferred<T>();
    const handler = (value: T) => {
      if (predicate(value)) ready.resolve(value);
    };
    this.waiters.add(handler);
    try {
      return await within(
        stopped === undefined
          ? ready.promise
          : Promise.race([ready.promise, stopped()]),
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
    if (gate !== undefined) {
      gate.arrived.resolve();
      await gate.release.promise;
    }
    if (request.signal.aborted) return;
    const text = request.messages
      .filter((message) => message.role === "user")
      .map((message) =>
        "text" in message
          ? message.text
          : "content" in message
            ? message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n")
            : "",
      )
      .join("\n");
    if (
      request.messages.at(-1)?.role === "user" &&
      text.includes("synthetic-approval-input")
    ) {
      yield {
        type: "tool_call",
        callId: "fixture-approval-call",
        name: "fixture",
        arguments: {},
      };
      return;
    }
    yield { type: "text_delta", delta: `Synthetic answer: ${text}` };
  }
}

interface ProbeSnapshot {
  id?: number;
  event?: string;
  error?: string;
  detail?: string;
  text?: string;
  replyTo?: string;
  rejected?: string;
  bindingThreadId?: string | null;
  calls: Array<{
    method: string;
    params: {
      expectedTurnId?: string;
      input: Array<{
        type: string;
        path?: string;
        url?: string;
        text?: string;
      }>;
    };
    imageEpoch: number | null;
  }>;
  deliveries: Array<{ text: string; replyTo: string | null }>;
  wireCalls: Array<{ method: string; params: object }>;
  imageEpoch: number;
  correlations: Array<{
    turnId: string;
    replyTo: string;
    clientMessageId: string;
  }>;
}

class SteeringProbe {
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
      [path.join(imRoot, "tests/zenx_steering_probe.py")],
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
              `IM steering probe exited ${String(code)}/${String(signal)}: ${this.stderr}`,
            ),
          );
      });
    });
    // A failure still reaches callers through command/wait. Mark the exit
    // promise handled immediately, including failures before the ready event.
    void this.exited.catch(() => {});
    this.child.stdin.write(JSON.stringify(config) + "\n");
  }
  async waitFor(predicate: (value: ProbeSnapshot) => boolean) {
    return await this.events.waitFor(predicate, () =>
      this.exited.then(() => {
        throw new Error("IM probe ended before the expected event");
      }),
    );
  }
  async command(command: object): Promise<ProbeSnapshot> {
    const id = ++this.nextId;
    this.child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
    const result = await this.waitFor((value) => value.id === id);
    assert.equal(result.error, undefined, `${result.error}: ${result.detail}`);
    return result;
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

test("a cached IM probe event stays handled when the probe later exits cleanly", async () => {
  const exited = deferred<void>();
  const events = new EventLog<ProbeSnapshot>();
  events.add({ event: "ready" } as ProbeSnapshot);
  // Exercise the actual wait method without creating a child or native server.
  const receiver = { events, exited: exited.promise } as SteeringProbe;
  const result = await SteeringProbe.prototype.waitFor.call(
    receiver,
    (event) => event.event === "ready",
  );
  assert.equal(result.event, "ready");
  exited.resolve();
  // A formerly eager, unused shutdown promise rejected on this next task.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test(
  "real IM SDK steers text and images on a correlated native Turn and rejects foreign/stale/ended Turns",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "imzenx-steering-"));
    const image = path.join(root, "input.png");
    const file = path.join(root, "notes.txt");
    const tokenFile = path.join(root, "app-server.token");
    await writeFile(image, png1x1());
    await writeFile(file, "synthetic local attachment");
    await writeFile(tokenFile, "synthetic-steering-token", { mode: 0o600 });
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
                description: "Synthetic approval fixture",
                inputSchema: { type: "object", properties: {} },
              },
              async execute() {
                fixtureExecutions += 1;
                return { output: "approved-fixture", exitCode: 0 };
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
    const server = await serveCodexWebSocket({
      appServer,
      zenHome: root,
      listen: "ws://127.0.0.1:0",
      bearerToken: "synthetic-steering-token",
    });
    let desktop: ZenXProtocolClient | undefined;
    let probe: SteeringProbe | undefined;
    try {
      desktop = await ZenXProtocolClient.connect({
        url: server.url,
        bearerTokenFile: tokenFile,
        clientInfo: {
          name: "steering-desktop",
          title: "ZenX",
          version: "test",
        },
      });
      const created = await desktop.request("thread/start", {});
      const threadId = created.thread.id;
      let view = projectNativeRecovery(
        await desktop.request("zen/thread/resume", { threadId }),
      );
      const events = new EventLog<AppServerEvent>();
      desktop.onNotification("zen/thread/event", ({ event }) => {
        view = applyNativeThreadEvent(view, event);
        events.add(event);
      });
      const read = async () =>
        (await desktop!.request("zen/thread/read", { threadId })).thread.items;
      const completed = async (turnId: string) =>
        await events.waitFor(
          (event) => event.type === "turn_completed" && event.turnId === turnId,
        );
      probe = new SteeringProbe({
        threadId,
        settings: {
          IMZEN_APP_SERVER_URL: server.url,
          IMZEN_APP_SERVER_AUTH_TOKEN_FILE: tokenFile,
          IMZEN_CWD: root,
          IMZEN_GATEWAY_STATE_FILE: path.join(root, "gateway.sqlite3"),
          IMZEN_APP_SERVER_SHARED_FILESYSTEM_ROOT: root,
        },
      });
      await probe.waitFor((event) => event.event === "ready");
      const command = async (messageId: string, text: string) =>
        await probe!.command({ action: "emit", messageId, text });
      const listed = await command("native-threads", "/threads");
      assert(
        listed.deliveries.some(
          (item) =>
            item.replyTo === "native-threads" &&
            item.text.includes("/pick <number>"),
        ),
      );
      const picked = await command("native-pick", "/pick 1");
      assert(
        picked.deliveries.some(
          (item) =>
            item.replyTo === "native-pick" &&
            item.text.includes("Selected thread"),
        ),
      );
      const models = await command("native-models", "/model");
      assert(
        models.deliveries.some(
          (item) =>
            item.replyTo === "native-models" && item.text.includes("fake"),
        ),
      );
      const modelUpdated = await command("native-model-update", "/model fake");
      assert(
        modelUpdated.deliveries.some(
          (item) =>
            item.replyTo === "native-model-update" &&
            item.text.includes("Model switched"),
        ),
      );
      const status = await command("native-status", "/status");
      assert(
        status.deliveries.some(
          (item) =>
            item.replyTo === "native-status" &&
            item.text.includes("## Zen thread"),
        ),
      );
      assert.deepEqual(
        status.calls,
        [],
        "navigation and settings do not create a Turn",
      );

      const initialGate = model.holdNext();
      const started = await probe.command({
        action: "emit",
        messageId: "im-original",
        text: "im-original-input",
      });
      await within(initialGate.arrived.promise);
      assert.deepEqual(
        started.calls.map((call) => call.method),
        ["turn/start"],
      );
      assert.equal(started.correlations.length, 1);
      const originalCorrelation = started.correlations[0]!;
      const turnId = originalCorrelation.turnId;
      assert.equal(originalCorrelation.replyTo, "im-original");

      const steered = await probe.command({
        action: "emit",
        messageId: "im-guidance",
        text: "im-active-guidance",
      });
      const illustrated = await probe.command({
        action: "emit",
        messageId: "im-image",
        text: "im-active-image",
        image,
        file,
      });
      assert.deepEqual(
        illustrated.calls.map((call) => call.method),
        ["turn/start", "turn/steer", "turn/steer"],
      );
      for (const call of illustrated.calls.slice(1))
        assert.equal(call.params.expectedTurnId, turnId);
      assert.deepEqual(steered.correlations, [originalCorrelation]);
      assert.deepEqual(illustrated.correlations, [originalCorrelation]);
      assert.equal(illustrated.calls[2]!.imageEpoch, null);
      assert(illustrated.imageEpoch > 0);
      assert(
        illustrated.calls[2]!.params.input.some(
          (part) =>
            part.type === "image" &&
            part.url?.startsWith("data:image/png;base64,"),
        ),
      );
      const activeItems = await read();
      const messages = activeItems.filter(
        (item) => item.type === "user_message",
      );
      assert.equal(
        activeItems.filter((item) => item.type === "turn_started").length,
        1,
      );
      assert.equal(messages.length, 3);
      assert(messages.every((item) => item.turnId === turnId));
      const illustratedItem = messages[2]!;
      const illustratedContent = contentFromUserMessage(illustratedItem);
      assert(
        illustratedContent.some(
          (part) =>
            part.type === "text" &&
            part.text.includes(`[Attachments]\n- notes.txt: ${file}`),
        ),
      );
      assert(
        illustratedContent.some(
          (part) =>
            part.type === "image" && part.attachment.mediaType === "image/png",
        ),
      );
      assert.equal(view.turns.length, 1);
      assert.equal(
        view.turns[0]!.items.filter((item) => item.type === "userMessage")
          .length,
        3,
      );

      const invalidEpoch = await probe.command({
        action: "image-epoch-steer",
        expectedTurnId: turnId,
        image,
        imageEpoch: illustrated.imageEpoch - 1,
      });
      assert.equal(invalidEpoch.rejected, "image_epoch");
      assert.deepEqual(
        invalidEpoch.wireCalls,
        illustrated.wireCalls,
        "mismatched image verification epoch is rejected before transport send",
      );
      assert.equal(invalidEpoch.calls.length, illustrated.calls.length + 1);
      assert.equal(invalidEpoch.calls.at(-1)?.method, "turn/steer");
      assert.deepEqual(invalidEpoch.correlations, [originalCorrelation]);
      assert.deepEqual(await read(), activeItems);

      initialGate.release.resolve();
      await completed(turnId);
      const answer = await probe.waitFor(
        (event) =>
          event.event === "delivery" &&
          Boolean(event.text?.includes("im-active-image")),
      );
      assert.equal(
        answer.replyTo,
        "im-original",
        "steered Agent output keeps the initiating IM reply",
      );
      assert(
        model.requests.some((request) =>
          request.messages.some(
            (message) =>
              message.role === "user" &&
              "content" in message &&
              message.content.some((part) => part.type === "image"),
          ),
        ),
        "image reaches the real Agent runtime model request",
      );

      const nextGate = model.holdNext();
      const next = await probe.command({
        action: "emit",
        messageId: "im-next",
        text: "im-next-idle",
      });
      await within(nextGate.arrived.promise);
      assert.equal(next.calls.at(-1)?.method, "turn/start");
      const nextCorrelation = next.correlations.find(
        (entry) => entry.replyTo === "im-next",
      )!;
      assert.notEqual(nextCorrelation.turnId, turnId);
      nextGate.release.resolve();
      await completed(nextCorrelation.turnId);
      const nextAnswer = await probe.waitFor(
        (event) =>
          event.event === "delivery" &&
          event.replyTo === "im-next" &&
          Boolean(event.text?.includes("im-next-idle")),
      );
      assert.equal(nextAnswer.replyTo, "im-next");

      const externalGate = model.holdNext();
      const external = await desktop.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "desktop-active-input" }],
      });
      await within(externalGate.arrived.promise);
      const beforeForeign = await read();
      const beforeCalls = (await probe.command({ action: "snapshot" })).calls;
      const foreign = await probe.command({
        action: "emit",
        messageId: "im-foreign",
        text: "must-not-append-to-foreign-turn",
      });
      assert.deepEqual(
        foreign.calls,
        beforeCalls,
        "Gateway rejects an uncorrelated external Turn before native input dispatch",
      );
      assert.deepEqual(await read(), beforeForeign);
      assert(
        foreign.deliveries.some((message) => message.replyTo === "im-foreign"),
        "foreign-Turn failure is presented to its IM sender",
      );

      const stale = await probe.command({
        action: "fenced-steer",
        expectedTurnId: turnId,
        text: "stale-must-not-append",
      });
      assert.equal(stale.rejected, "turn_ended");
      assert.equal(stale.calls.length, beforeCalls.length + 1);
      assert.equal(stale.calls.at(-1)?.method, "turn/steer");
      assert.equal(stale.wireCalls.length, foreign.wireCalls.length + 1);
      assert.equal(stale.wireCalls.at(-1)?.method, "turn/steer");
      assert.deepEqual(await read(), beforeForeign);
      externalGate.release.resolve();
      await completed(external.turn.id);
      const beforeEnded = await read();
      const ended = await probe.command({
        action: "fenced-steer",
        expectedTurnId: external.turn.id,
        text: "ended-must-not-start",
      });
      assert.equal(ended.rejected, "turn_ended");
      assert.equal(ended.calls.length, stale.calls.length + 1);
      assert.equal(ended.calls.at(-1)?.method, "turn/steer");
      assert.equal(ended.wireCalls.length, stale.wireCalls.length + 1);
      assert.equal(ended.wireCalls.at(-1)?.method, "turn/steer");
      assert.deepEqual(
        await read(),
        beforeEnded,
        "received native Turn fence rejection never appends or falls back to start",
      );
      assert.deepEqual(
        await journal.read(threadId),
        beforeEnded,
        "native recovery reflects the authoritative append-only journal",
      );
      assert.equal(
        (await read()).filter((item) => item.type === "turn_started").length,
        3,
      );
      await command("approval-profile", "/permission approval-required");
      const approvalInput = await command(
        "approval-input",
        "synthetic-approval-input",
      );
      const approval = await probe.waitFor(
        (event) =>
          event.event === "delivery" &&
          Boolean(event.text?.includes("/approve ")),
      );
      const requestRef = /\/approve ([^`\s]+)/.exec(approval.text!)?.[1];
      assert(requestRef);
      assert.equal(fixtureExecutions, 0);
      const approvedThread = approvalInput.bindingThreadId!;
      assert.notEqual(approvedThread, threadId);
      const pending = (
        await desktop.request("zen/thread/read", { threadId: approvedThread })
      ).thread.items;
      const approvedTurn = pending.find(
        (item) => item.type === "turn_started",
      )!.turnId!;
      await desktop.request("zen/thread/resume", { threadId: approvedThread });
      await command("approval-reply", `/approve ${requestRef}`);
      await completed(approvedTurn);
      await command("approval-reply", `/approve ${requestRef}`);
      assert.equal(
        fixtureExecutions,
        1,
        "native approval executes only once for duplicate IM responses",
      );
      const approved = (
        await desktop.request("zen/thread/read", { threadId: approvedThread })
      ).thread.items;
      assert(
        approved.some(
          (item) =>
            item.type === "tool_result" && item.output === "approved-fixture",
        ),
      );
    } finally {
      for (const gate of model.gates) gate.release.resolve();
      try {
        await probe?.close();
      } finally {
        desktop?.close();
        try {
          await server.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  },
);
