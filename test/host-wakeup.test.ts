import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ZenAppServer, AppServerError } from "../src/app-server.js";
import { decodeCanonicalItem, type HostWakeupInput } from "../src/item.js";
import {
  InMemoryThreadJournal,
  JsonlThreadJournal,
  type ThreadJournal,
} from "../src/journal.js";
import {
  compileModelMessages,
  type ModelAdapter,
  type ModelEvent,
  type ModelMessage,
} from "../src/model.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { ToolEnvironment } from "../src/tool.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import {
  projectCompletedItem,
  projectThread,
} from "../src/protocol/codex/mapper.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import type { JsonRpcMessage } from "../src/protocol/codex/wire.js";
import {
  deliverAssistantWakeup,
  type AssistantWakeupPort,
} from "../apps/zenx/src/main/assistant-preset.js";
import { testToolBundle, testToolRuntime } from "./tool-fixtures.js";
import { ZenXProtocolError } from "../apps/zenx/src/protocol-client/protocol-client.js";

const bootstrap: HostWakeupInput = {
  clientId: "bootstrap-1",
  source: "bootstrap",
  text: "Greet the Room proactively using its ordinary messaging tool.",
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function createServer(
  options: {
    cwd?: string;
    journal?: ThreadJournal;
    adapter?: ModelAdapter;
    requests?: ModelMessage[][];
    tools?: ToolEnvironment;
  } = {},
) {
  const adapter: ModelAdapter = options.adapter ?? {
    provider: "bootstrap-test",
    async *stream(request): AsyncIterable<ModelEvent> {
      options.requests?.push(structuredClone(request.messages));
      yield { type: "text_delta", delta: "A real model response" };
    },
  };
  return new ZenAppServer({
    journal: options.journal ?? new InMemoryThreadJournal(),
    runtime: new AgentRuntime({
      toolEnvironment: options.tools ?? new ToolEnvironment({ runtimes: [] }),
    }),
    threadMetadata: new InMemoryThreadMetadataStore(),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: adapter.provider,
        adapter,
        modelCatalog: new StaticModelCatalog([
          { id: "fake", isDefault: true, contextWindow: 32768 },
        ]),
      },
    ]),
    defaults: {
      cwd: options.cwd ?? tmpdir(),
      providerProfileId: adapter.provider,
      modelId: "fake",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}

async function waitForInputTerminal(
  server: ZenAppServer,
  threadId: string,
  clientId: string,
  inputType: "host_message" | "user_message" = "host_message",
) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const snapshot = await server.readThread(threadId);
    const input = snapshot.items.find(
      (item) => item.type === inputType && item.clientId === clientId,
    );
    if (input?.type === "host_message" || input?.type === "user_message") {
      const terminal = snapshot.items.find(
        (item) =>
          (item.type === "turn_completed" || item.type === "turn_aborted") &&
          item.turnId === input.turnId,
      );
      if (terminal) return { snapshot, input, terminal };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(
    `${inputType} ${clientId} did not reach a canonical terminal fact`,
  );
}

test("bootstrap persists only honest Host input, snapshots AGENTS and deduplicates concurrent/restarted admission", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "zen-bootstrap-"));
  try {
    await promisify(execFile)("git", ["init", cwd]);
    await writeFile(path.join(cwd, "AGENTS.md"), "BOOTSTRAP_REPOSITORY_RULES");
    const journal = new JsonlThreadJournal(path.join(cwd, "journal"));
    const requests: ModelMessage[][] = [];
    const server = createServer({ cwd, journal, requests });
    const thread = await server.startThread();
    const [first, concurrent] = await Promise.all([
      server.wakeTurn(thread.id, bootstrap, { mode: "start" }),
      server.wakeTurn(thread.id, bootstrap, {
        mode: "steer",
        expectedTurnId: "stale-turn",
      }),
    ]);
    const completed = await waitForInputTerminal(
      server,
      thread.id,
      bootstrap.clientId,
    );
    let snapshot = completed.snapshot;
    assert(completed.terminal.type === "turn_completed");
    assert.equal(completed.terminal.status, "completed");
    assert.deepEqual(first, { turnId: completed.input.turnId, mode: "start" });
    // A concurrent retry can observe the durable queue receipt before admission.
    if (concurrent.queued) {
      assert.deepEqual(concurrent, { mode: "queue", queued: true });
    } else {
      assert.deepEqual(concurrent, first);
    }
    const readback = await server.wakeTurn(thread.id, bootstrap, {
      mode: "steer",
      expectedTurnId: "stale-turn",
    });
    assert.deepEqual(readback, first);
    assert.deepEqual(
      (await server.readThread(thread.id)).items,
      snapshot.items,
    );
    assert.deepEqual(
      snapshot.items.map((item) => item.type),
      [
        "thread_metadata",
        "host_message_queued",
        "turn_started",
        "host_message",
        "context_message",
        "context_message",
        "agent_message",
        "turn_completed",
      ],
    );
    const compiled = snapshot.items.filter(
      (item) => item.type === "context_message",
    );
    assert.deepEqual(
      compiled.map((item) => item.purpose),
      ["workspace-instructions", "host_message"],
    );
    assert.deepEqual(
      compiled.map((item) => [item.role, item.origin]),
      [
        ["user", "host"],
        ["user", "host"],
      ],
    );
    assert.deepEqual(
      compiled.map((item) => item.sourceItemIds),
      [
        [snapshot.items.find((item) => item.type === "turn_started")!.id],
        [snapshot.items.find((item) => item.type === "host_message")!.id],
      ],
    );
    for (const item of compiled) decodeCanonicalItem(item);
    const queued = snapshot.items.find(
      (item) => item.type === "host_message_queued",
    )!;
    assert.equal(queued.sender, "host");
    assert.equal(queued.source, "bootstrap");
    assert.equal(queued.clientId, bootstrap.clientId);
    assert.equal(queued.text, bootstrap.text);
    assert.equal(queued.intent, "steer");
    assert.equal(queued.deliveryMode, "batch-next");
    assert.deepEqual(queued.input, [{ type: "text", text: bootstrap.text }]);
    assert.deepEqual(decodeCanonicalItem(queued), queued);
    assert.equal(projectCompletedItem(queued), null);
    const host = snapshot.items.find((item) => item.type === "host_message")!;
    assert.equal(host.sender, "host");
    assert.equal(host.source, "bootstrap");
    assert.equal(host.clientId, bootstrap.clientId);
    assert.equal(host.turnId, first.turnId);
    assert.deepEqual(decodeCanonicalItem(host), host);
    assert.equal(projectCompletedItem(host), null);
    assert(
      !projectThread(snapshot, { includeTurns: true })
        .turns.flatMap((turn) => turn.items)
        .some((item) => item.type === "userMessage"),
    );
    assert.match(JSON.stringify(requests), /BOOTSTRAP_REPOSITORY_RULES/u);
    assert.match(
      JSON.stringify(requests),
      /Host wakeup\. Source: bootstrap.*not a human message or new authorization/u,
    );
    assert.equal(requests.length, 1);
    await writeFile(path.join(cwd, "AGENTS.md"), "LATER_RULES");
    const restarted = createServer({ cwd, journal, requests });
    const replay = await restarted.wakeTurn(thread.id, bootstrap, {
      mode: "steer",
      expectedTurnId: "another-turn",
    });
    assert.deepEqual(replay, first);
    assert.deepEqual(
      (await restarted.readThread(thread.id)).items,
      snapshot.items,
    );
    assert.equal(requests.length, 1);
    await assert.rejects(
      restarted.wakeTurn(
        thread.id,
        { ...bootstrap, text: "Different input" },
        { mode: "start" },
      ),
      (error) =>
        error instanceof AppServerError &&
        error.code === "idempotency_conflict",
    );
    await (
      await restarted.startTurn(thread.id, "Actual human input", {
        clientId: "human-1",
      })
    ).done;
    snapshot = await restarted.readThread(thread.id);
    assert.equal(
      snapshot.items.filter((item) => item.type === "user_message").length,
      1,
    );
    assert.match(
      JSON.stringify(requests.at(-1)),
      /BOOTSTRAP_REPOSITORY_RULES/u,
    );
    assert.doesNotMatch(JSON.stringify(requests.at(-1)), /LATER_RULES/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Host steer at a streamed final response forces another sample, preserving human queue behavior", async () => {
  const entered = deferred();
  const release = deferred();
  const samples: ModelMessage[][] = [];
  const adapter: ModelAdapter = {
    provider: "bootstrap-race",
    async *stream(request): AsyncIterable<ModelEvent> {
      samples.push(structuredClone(request.messages));
      if (samples.length === 1) {
        yield { type: "text_delta", delta: "Already streaming" };
        entered.resolve();
        await release.promise;
      } else yield { type: "text_delta", delta: "Handled the new input" };
    },
  };
  const server = createServer({ adapter });
  const thread = await server.startThread();
  const first = await server.startTurn(thread.id, "Real first message");
  await entered.promise;
  try {
    await assert.rejects(
      server.wakeTurn(thread.id, bootstrap, { mode: "start" }),
      (error) =>
        error instanceof AppServerError && error.code === "thread_busy",
    );
    const steered = await server.wakeTurn(thread.id, bootstrap, {
      mode: "steer",
      expectedTurnId: first.id,
    });
    assert.equal(steered.turnId, first.id);
    assert.equal(steered.mode, "steer");
    const retry = await server.wakeTurn(thread.id, bootstrap, {
      mode: "start",
    });
    assert.equal(retry.turnId, first.id);
    assert.equal(retry.mode, "steer");
    await server.queueMessage(thread.id, "Human follow-up", "human-queued");
  } finally {
    release.resolve();
  }
  await first.done;
  // Wait on the canonical queue admission/completion instead of a wall-clock delay.
  await server.resumeQueue(thread.id);
  const completed = await waitForInputTerminal(
    server,
    thread.id,
    "human-queued",
    "user_message",
  );
  const snapshot = completed.snapshot;
  assert(completed.terminal.type === "turn_completed");
  assert.equal(completed.terminal.status, "completed");
  const host = snapshot.items.find((item) => item.type === "host_message")!;
  assert(host.deliveryAfter);
  assert.equal(
    snapshot.items.filter((item) => item.type === "host_message").length,
    1,
  );
  assert.equal(
    snapshot.items.filter((item) => item.type === "user_message").length,
    2,
  );
  assert.equal(snapshot.turns.length, 2);
  assert.equal(samples.length, 3);
  assert.equal(samples[1]!.at(-1)?.role, "user");
  assert.match(
    JSON.stringify(samples[1]!.at(-1)),
    /Host wakeup\. Source: bootstrap/u,
  );
  const projected = compileModelMessages(snapshot.items);
  const streamedIndex = projected.findIndex(
    (message) => "text" in message && message.text === "Already streaming",
  );
  const hostIndex = projected.findIndex(
    (message) =>
      "text" in message &&
      message.text?.includes("Host wakeup. Source: bootstrap"),
  );
  assert(hostIndex > streamedIndex);
});

test("stale, terminal, interrupted and archived Host admissions fail without a receipt", async () => {
  const entered = deferred();
  const release = deferred();
  const server = createServer({
    adapter: {
      provider: "bootstrap-fences",
      async *stream(request): AsyncIterable<ModelEvent> {
        entered.resolve();
        await release.promise;
        request.signal.throwIfAborted();
        yield { type: "text_delta", delta: "done" };
      },
    },
  });
  const thread = await server.startThread();
  await assert.rejects(
    server.wakeTurn(thread.id, bootstrap, {
      mode: "steer",
      expectedTurnId: "stale",
    }),
    (error) =>
      error instanceof AppServerError && error.code === "turn_not_running",
  );
  await server.setThreadArchived(thread.id, true);
  await assert.rejects(
    server.wakeTurn(thread.id, bootstrap, {
      mode: "start",
      requireUnarchived: true,
    }),
    (error) =>
      error instanceof AppServerError && error.code === "operation_forbidden",
  );
  await server.setThreadArchived(thread.id, false);
  const active = await server.startTurn(thread.id, "Human message");
  await entered.promise;
  await assert.rejects(
    server.wakeTurn(thread.id, bootstrap, {
      mode: "steer",
      expectedTurnId: "another-turn",
    }),
    (error) =>
      error instanceof AppServerError && error.code === "turn_not_running",
  );
  const interrupt = server.interruptTurn(thread.id, active.id);
  try {
    await assert.rejects(
      server.wakeTurn(thread.id, bootstrap, {
        mode: "steer",
        expectedTurnId: active.id,
      }),
      (error) =>
        error instanceof AppServerError && error.code === "turn_not_running",
    );
  } finally {
    release.resolve();
  }
  await interrupt;
  await assert.rejects(
    server.wakeTurn(thread.id, bootstrap, {
      mode: "steer",
      expectedTurnId: active.id,
    }),
    (error) =>
      error instanceof AppServerError && error.code === "turn_not_running",
  );
  assert(
    !(await server.readThread(thread.id)).items.some(
      (item) =>
        item.type === "host_message" || item.type === "host_message_queued",
    ),
  );
});

test("explicit Host steer requires expectedTurnId before idle or busy admission", async (t) => {
  for (const state of ["idle", "busy"] as const) {
    await t.test(state, async () => {
      const entered = deferred();
      const release = deferred();
      const server = createServer({
        adapter: {
          provider: "bootstrap-explicit-steer",
          async *stream(): AsyncIterable<ModelEvent> {
            entered.resolve();
            await release.promise;
            yield { type: "text_delta", delta: "done" };
          },
        },
      });
      const thread = await server.startThread();
      const active =
        state === "busy"
          ? await server.startTurn(thread.id, "Real human input")
          : undefined;
      if (active) await entered.promise;
      const before = await server.readThread(thread.id);
      try {
        await assert.rejects(
          server.wakeTurn(thread.id, bootstrap, { mode: "steer" }),
          (error) =>
            error instanceof AppServerError && error.code === "invalid_request",
        );
        assert.deepEqual(
          (await server.readThread(thread.id)).items,
          before.items,
        );
      } finally {
        release.resolve();
        if (active) await active.done;
        const after = await server.readThread(thread.id);
        if (after.items.some((item) => item.type === "host_message")) {
          await waitForInputTerminal(server, thread.id, bootstrap.clientId);
        }
      }
    });
  }
});

test("native wake carries canonical Host provenance and rejects invalid source; CAS has no fabricated user projection", async () => {
  const server = createServer();
  const thread = await server.startThread();
  const projection = new NativeRecoveryProjection(server);
  const sent: JsonRpcMessage[] = [];
  const connection = new NativeConnection({
    projection,
    appServer: server,
    send: (message) => {
      sent.push(message);
    },
  });
  try {
    await connection.receive({ id: 1, method: "zen/initialize", params: {} });
    await connection.receive({
      id: 2,
      method: "zen/turn/wake",
      params: {
        ...bootstrap,
        threadId: thread.id,
        mode: "start",
        source: "user",
      },
    });
    assert(
      sent.some(
        (message) => "id" in message && message.id === 2 && "error" in message,
      ),
    );
    await connection.receive({
      id: 3,
      method: "zen/turn/wake",
      params: { ...bootstrap, threadId: thread.id, mode: "start" },
    });
    const turn = await server.wakeTurn(thread.id, bootstrap, { mode: "start" });
    const completed = await waitForInputTerminal(
      server,
      thread.id,
      bootstrap.clientId,
    );
    assert.deepEqual(turn, { turnId: completed.input.turnId, mode: "start" });
    assert(completed.terminal.type === "turn_completed");
    assert.equal(completed.terminal.status, "completed");
    const native = await projection.read(thread.id);
    assert.equal(
      native.items.filter((item) => item.type === "host_message").length,
      1,
    );
    assert(!native.items.some((item) => item.type === "user_message"));
    assert(
      sent.some(
        (message) =>
          "method" in message &&
          message.method === "zen/thread/event" &&
          JSON.stringify(message).includes('"sender":"host"'),
      ),
    );
    const reply = sent.find(
      (message) => "id" in message && message.id === 3 && "result" in message,
    );
    assert(reply && "result" in reply);
    assert.deepEqual(reply.result, turn);
  } finally {
    connection.close();
    projection.close();
  }
});

test("canonical Host decoding rejects missing or false attribution", () => {
  const item = {
    id: "h",
    threadId: "t",
    turnId: "turn",
    createdAt: "2026-10-12T00:00:00.000Z",
    type: "host_message",
    sender: "host",
    mode: "start",
    ...bootstrap,
  };
  for (const change of [
    { sender: "user" },
    { sender: undefined },
    { source: "user" },
    { source: undefined },
    { source: "trigger" },
    { source: "room" },
    { sourceId: "" },
    { clientId: "" },
    { clientId: undefined },
    { turnId: undefined },
    { mode: "queue" },
    { mode: undefined },
    { deliveryAfter: "" },
  ])
    assert.throws(() => decodeCanonicalItem({ ...item, ...change }));
  for (const source of ["bootstrap", "trigger", "room"] as const) {
    const valid = {
      ...item,
      source,
      sourceId: `${source}-source`,
      deliveryAfter: "model-response",
    };
    assert.deepEqual(decodeCanonicalItem(valid), valid);
  }
});

test("assistant wakeup delivery retries only definitive admission races, using stable Host input", async () => {
  const calls: { method: string; params: unknown }[] = [];
  let attempts = 0;
  const port = {
    async request(method: string, params: unknown) {
      calls.push({ method, params });
      if (method === "thread/read")
        return {
          thread: {
            turns:
              attempts === 0 ? [] : [{ id: "active", status: "inProgress" }],
          },
        };
      if (attempts++ === 0)
        throw new ZenXProtocolError(-32602, "busy", { zenCode: "thread_busy" });
      return { turnId: "active", mode: "steer" };
    },
  } as AssistantWakeupPort;
  assert.deepEqual(
    await deliverAssistantWakeup(
      port,
      { ...bootstrap, threadId: "thread" },
      undefined,
      { requireUnarchived: true },
    ),
    { turnId: "active", mode: "steer", expectedTurnId: "active" },
  );
  const wakes = calls.filter((call) => call.method === "zen/turn/wake");
  assert.equal(wakes.length, 2);
  for (const call of wakes)
    assert.deepEqual(
      {
        ...(call.params as object),
        mode: undefined,
        expectedTurnId: undefined,
      },
      {
        ...bootstrap,
        threadId: "thread",
        requireUnarchived: true,
        mode: undefined,
        expectedTurnId: undefined,
      },
    );
  assert(
    !calls.some(
      (call) => call.method === "turn/start" || call.method === "turn/steer",
    ),
  );
  let failedCalls = 0;
  const uncertain = {
    async request(method: string) {
      if (method === "thread/read") return { thread: { turns: [] } };
      failedCalls++;
      throw new Error("Disconnected; unknown admission");
    },
  } as AssistantWakeupPort;
  await assert.rejects(
    deliverAssistantWakeup(uncertain, { ...bootstrap, threadId: "thread" }),
    /unknown admission/u,
  );
  assert.equal(failedCalls, 1);
});

test("restart after bootstrap receipt preserves interrupted status without replay or fabricated output", async () => {
  const entered = deferred();
  const release = deferred();
  const journal = new InMemoryThreadJournal();
  const adapter: ModelAdapter = {
    provider: "bootstrap-test",
    async *stream(): AsyncIterable<ModelEvent> {
      entered.resolve();
      await release.promise;
      yield { type: "text_delta", delta: "Original process only" };
    },
  };
  const original = createServer({ journal, adapter });
  const thread = await original.startThread();
  const active = await original.wakeTurn(thread.id, bootstrap, {
    mode: "start",
  });
  await entered.promise;
  try {
    const crashSnapshot = new InMemoryThreadJournal();
    await crashSnapshot.create(await journal.read(thread.id));
    const requests: ModelMessage[][] = [];
    const restarted = createServer({ journal: crashSnapshot, requests });
    const recovered = await restarted.readThread(thread.id);
    assert.equal(recovered.turns[0]?.status, "interrupted");
    const duplicate = await restarted.wakeTurn(thread.id, bootstrap, {
      mode: "start",
    });
    assert.ok(active.turnId);
    assert.deepEqual(duplicate, active);
    assert.equal(recovered.turns[0]?.id, active.turnId);
    assert(
      recovered.items.some(
        (item) => item.type === "turn_started" && item.turnId === active.turnId,
      ),
    );
    assert(
      recovered.items.some(
        (item) =>
          item.type === "host_message" &&
          item.turnId === active.turnId &&
          item.clientId === bootstrap.clientId,
      ),
    );
    assert(
      !recovered.items.some(
        (item) =>
          item.type === "turn_completed" || item.type === "turn_aborted",
      ),
    );
    assert.equal(requests.length, 0);
    const after = await restarted.readThread(thread.id);
    assert.deepEqual(after.items, recovered.items);
    assert(
      !after.items.some(
        (item) => item.type === "user_message" || item.type === "agent_message",
      ),
    );
  } finally {
    release.resolve();
    const completed = await waitForInputTerminal(
      original,
      thread.id,
      bootstrap.clientId,
    );
    assert(completed.terminal.type === "turn_completed");
    assert.equal(completed.terminal.status, "completed");
  }
});

test("Host steer received during a tool batch is projected after that batch's result", async () => {
  const entered = deferred();
  const release = deferred();
  const requests: ModelMessage[][] = [];
  const tool = testToolRuntime({
    name: "read_fixture",
    async execute() {
      entered.resolve();
      await release.promise;
      return { output: "tool result", exitCode: 0 };
    },
  });
  const tools = new ToolEnvironment({
    bundles: [
      testToolBundle({ kind: "external", id: "bootstrap-tool" }, [tool]),
    ],
  });
  const adapter: ModelAdapter = {
    provider: "bootstrap-tools",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request.messages));
      if (requests.length === 1)
        yield {
          type: "tool_call",
          callId: "read-call",
          name: tool.name,
          arguments: {},
        };
      else yield { type: "text_delta", delta: "done" };
    },
  };
  const server = createServer({ adapter, tools });
  const thread = await server.startThread();
  const active = await server.startTurn(thread.id, "Real human request");
  await entered.promise;
  try {
    await server.wakeTurn(thread.id, bootstrap, {
      mode: "steer",
      expectedTurnId: active.id,
    });
  } finally {
    release.resolve();
  }
  await active.done;
  assert.equal(requests.length, 2);
  const sample = requests[1]!;
  assert.equal(sample.at(-2)?.role, "tool");
  assert.match(
    JSON.stringify(sample.at(-1)),
    /Host wakeup\. Source: bootstrap/u,
  );
  assert.equal(
    (await server.readThread(thread.id)).items.filter(
      (item) => item.type === "user_message",
    ).length,
    1,
  );
});
