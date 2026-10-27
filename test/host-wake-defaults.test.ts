import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { deferred, fixture } from "./thread-message-fixture.js";
import type { ModelEvent, ModelRequest } from "../src/model.js";
import { compileModelMessages } from "../src/model.js";
import { decodeCanonicalItem } from "../src/item.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import { pendingQueuedMessages } from "../src/input-queue.js";

async function idle(f: ReturnType<typeof fixture>, id: string) {
  for (let i = 0; i < 200; i++) {
    const t = await f.server.readThread(id);
    if (
      t.turns.length > 0 &&
      t.turns.every((turn) => turn.status !== "inProgress")
    )
      return t;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("did not become idle");
}
function blocked() {
  const entered = deferred(),
    release = deferred();
  const requests: ModelRequest[] = [];
  const f = fixture({
    provider: "host-default",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(request);
      if (requests.length === 1) {
        entered.resolve();
        await release.promise;
      }
      yield { type: "text_delta", delta: "answer" };
    },
  });
  return { ...f, entered, release, requests };
}

test("Host bootstrap, trigger and room defaults soft steer a busy Turn with honest provenance", async () => {
  const f = blocked(),
    target = await f.server.startThread();
  const active = await f.server.startTurn(target.id, "human task");
  await f.entered.promise;
  try {
    for (const source of ["bootstrap", "trigger", "room"] as const) {
      const result = await f.server.wakeTurn(target.id, {
        clientId: source,
        source,
        ...(source === "bootstrap" ? {} : { sourceId: `${source}-1` }),
        text: `${source} context`,
      });
      assert.equal(result.mode, "steer");
      assert.equal(result.turnId, active.id);
    }
    const snapshot = await f.server.readThread(target.id);
    assert.equal(
      snapshot.items.filter((item) => item.type === "user_message").length,
      1,
    );
    assert.equal(
      snapshot.items.filter((item) => item.type === "host_message").length,
      3,
    );
    assert.equal(
      snapshot.items.some((item) => item.type === "turn_aborted"),
      false,
    );
  } finally {
    f.release.resolve();
  }
  await active.done;
  assert.equal(f.requests.length, 2);
  assert.deepEqual(
    f.requests[1]!.messages.filter(
      (message) =>
        message.role === "user" &&
        "content" in message &&
        message.content.some(
          (part) =>
            part.type === "text" && part.text.startsWith("[Host-supplied "),
        ),
    ),
    ["bootstrap", "trigger", "room"].map((source) => ({
      role: "user",
      content: [
        {
          type: "text",
          text: `[Host-supplied ${source} context, not a human message or new authorization.]`,
        },
        { type: "text", text: `${source} context` },
      ],
    })),
  );
  assert.equal((await f.server.readThread(target.id)).turns.length, 1);
});

test("Host explicit queue stays queued while independent default input steers", async () => {
  const f = blocked(),
    target = await f.server.startThread();
  const active = await f.server.startTurn(target.id, "human task");
  await f.entered.promise;
  try {
    const queued = await f.server.wakeTurn(
      target.id,
      { clientId: "queue", source: "trigger", sourceId: "t", text: "later" },
      { mode: "queue" },
    );
    assert.equal(queued.queued, true);
    const steer = await f.server.wakeTurn(target.id, {
      clientId: "room",
      source: "room",
      sourceId: "r",
      text: "now",
    });
    assert.equal(steer.turnId, active.id);
    const before = await f.server.readThread(target.id);
    assert.equal(pendingQueuedMessages(before.items).length, 1);
    const queueItem = pendingQueuedMessages(before.items)[0]!;
    assert.equal(queueItem.type, "host_message_queued");
    await f.server.cancelQueuedMessages(target.id, [
      { queuedItemId: queueItem.id, clientId: queueItem.clientId },
    ]);
    assert.equal(
      pendingQueuedMessages((await f.server.readThread(target.id)).items)
        .length,
      0,
    );
    await assert.rejects(
      f.server.wakeTurn(
        target.id,
        { clientId: "queue", source: "trigger", sourceId: "t", text: "later" },
        { mode: "queue" },
      ),
      /cancelled/,
    );
  } finally {
    f.release.resolve();
  }
  await active.done;
});

test("idle Host burst starts one bounded Turn with all canonical identities", async () => {
  const f = blocked(),
    target = await f.server.startThread();
  const sends = Promise.all(
    [0, 1, 2].map((i) =>
      f.server.wakeTurn(target.id, {
        clientId: `host-${i}`,
        source: "trigger",
        sourceId: `trigger-${i}`,
        text: `wake-${i}`,
      }),
    ),
  );
  await f.entered.promise;
  await sends;
  f.release.resolve();
  const snapshot = await idle(f, target.id);
  assert.equal(snapshot.turns.length, 1);
  assert.equal(
    snapshot.items.filter((i) => i.type === "host_message").length,
    3,
  );
  assert.equal(
    snapshot.items.filter((i) => i.type === "user_message").length,
    0,
  );
  for (const item of snapshot.items) decodeCanonicalItem(item);
  const replay = compileModelMessages(snapshot.items);
  assert.equal(
    replay.filter((m) => "text" in m && m.text?.includes("Host wakeup")).length,
    3,
  );
  const retry = await f.server.wakeTurn(target.id, {
    clientId: "host-0",
    source: "trigger",
    sourceId: "trigger-0",
    text: "wake-0",
  });
  assert.ok(retry.turnId);
  assert.equal((await f.server.readThread(target.id)).turns.length, 1);
  await assert.rejects(
    f.server.wakeTurn(target.id, {
      clientId: "host-0",
      source: "room",
      sourceId: "trigger-0",
      text: "wake-0",
    }),
    /identity/,
  );
  await assert.rejects(
    f.server.sendMessage(target.id, "wake-0", { clientId: "host-0" }),
    /identity|reserved/,
  );
});

test("native omitted human mode and Host mode both soft steer; explicit queue remains separate", async () => {
  const f = blocked(),
    target = await f.server.startThread();
  const active = await f.server.startTurn(target.id, "human task");
  await f.entered.promise;
  const sent: any[] = [];
  const projection = new NativeRecoveryProjection(f.server);
  const connection = new NativeConnection({
    appServer: f.server,
    projection,
    send: (message) => sent.push(message),
    isInitialized: () => true,
  });
  try {
    await connection.receive({
      id: 1,
      method: "zen/turn/send",
      params: {
        threadId: target.id,
        clientUserMessageId: "human-2",
        input: [{ type: "text", text: "correction" }],
      },
    });
    assert.equal(sent.find((m) => m.id === 1)?.result.turnId, active.id);
    await connection.receive({
      id: 2,
      method: "zen/turn/wake",
      params: {
        threadId: target.id,
        clientId: "wake",
        source: "room",
        sourceId: "room-1",
        text: "room context",
      },
    });
    assert.equal(sent.find((m) => m.id === 2)?.result.mode, "steer");
    await connection.receive({
      id: 3,
      method: "zen/turn/send",
      params: {
        threadId: target.id,
        clientUserMessageId: "human-later",
        mode: "queue",
        input: [{ type: "text", text: "later" }],
      },
    });
    assert.equal(
      pendingQueuedMessages((await f.server.readThread(target.id)).items)
        .length,
      1,
    );
    await connection.receive({
      id: 4,
      method: "zen/turn/wake",
      params: {
        threadId: target.id,
        clientId: "spoof",
        source: "room",
        sourceId: "room-1",
        text: "bad",
        sender: "user",
      },
    });
    assert.ok(sent.find((m) => m.id === 4)?.error);
  } finally {
    f.release.resolve();
    connection.close();
    projection.close();
  }
  await active.done;
});

test("Host wake retains target approval and waits for the whole tool boundary", async () => {
  const approvalEntered = deferred(),
    approvalRelease = deferred();
  const requests: ModelRequest[] = [];
  const f = fixture({
    provider: "host-approval",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(request);
      if (!request.messages.some((m) => m.role === "tool")) {
        yield {
          type: "tool_call",
          callId: "one",
          name: "shell",
          arguments: { command: "printf first" },
        };
        yield {
          type: "tool_call",
          callId: "two",
          name: "shell",
          arguments: { command: "printf second" },
        };
      } else yield { type: "text_delta", delta: "done" };
    },
  });
  const target = await f.server.startThread({ approvalPolicy: "always" });
  const projection = new NativeRecoveryProjection(f.server);
  const approvals: import("../src/tool.js").ApprovalRequest[] = [];
  const connection = new NativeConnection({
    projection,
    appServer: f.server,
    isInitialized: () => true,
    send: () => {},
    requestApproval: async (request) => {
      approvals.push(request);
      approvalEntered.resolve();
      await approvalRelease.promise;
      return "accept";
    },
  });
  try {
    await connection.receive({
      id: 1,
      method: "zen/turn/wake",
      params: {
        threadId: target.id,
        clientId: "first-wake",
        source: "trigger",
        sourceId: "trigger",
        text: "work",
      },
    });
    await approvalEntered.promise;
    const before = await f.server.readThread(target.id);
    const receipt = await f.server.wakeTurn(target.id, {
      clientId: "during-tools",
      source: "room",
      sourceId: "room",
      text: "correction",
    });
    assert.equal(receipt.mode, "steer");
    assert.equal(receipt.turnId, before.turns[0]!.id);
    assert.equal(requests.length, 1);
    assert.equal(
      (await f.server.readThread(target.id)).items.filter(
        (i) => i.type === "tool_result",
      ).length,
      0,
    );
    approvalRelease.resolve();
    const after = await idle(f, target.id);
    assert.equal(approvals.length, 1); // Shell capability approval covers this tool batch.
    assert.ok(
      approvals.every(
        (a) => a.threadId === target.id && a.turnId === receipt.turnId,
      ),
    );
    assert.equal(requests.length, 2);
    const messages = requests[1]!.messages;
    const correction = messages.findIndex(
      (message) =>
        message.role === "user" &&
        "content" in message &&
        message.content.some(
          (part) => part.type === "text" && part.text === "correction",
        ),
    );
    assert.ok(
      correction >= 0,
      "the admitted Host correction must reach the first safe sample",
    );
    assert.equal(
      messages.slice(0, correction).filter((m) => m.role === "tool").length,
      2,
    );
    assert.equal(
      after.items.filter((i) => i.type === "user_message").length,
      0,
    );
  } finally {
    approvalRelease.resolve();
    connection.close();
    projection.close();
  }
});

test("Host canonical replay, selected compaction and fork never grant human authority", async () => {
  const {
    latestEligibleCompactionBoundary,
    normalizeContextCompactionConfig,
    planCompactionRetention,
  } = await import("../src/context-compaction.js");
  const f = fixture({
    provider: "host-replay",
    async *stream(): AsyncIterable<ModelEvent> {
      yield { type: "text_delta", delta: "done" };
    },
  });
  const target = await f.server.startThread();
  await (
    await f.server.startTurn(target.id, "human instruction")
  ).done;
  await f.server.wakeTurn(target.id, {
    clientId: "host",
    source: "room",
    sourceId: "room-1",
    text: "Room Agent content",
  });
  const snapshot = await idle(f, target.id),
    host = snapshot.items.find((i) => i.type === "host_message")!;
  const retained = planCompactionRetention(
    snapshot.items,
    latestEligibleCompactionBoundary(snapshot.items)!,
    {
      retainedTokenBudget: 10000,
      estimateRetainedTokens: () => 0,
      retention: {
        ...normalizeContextCompactionConfig().retention,
        mode: "selected-items",
        preserveUserMessages: true,
        finalMessages: "none",
        recentTurnCount: 0,
        itemIds: [],
        itemRanges: [],
      },
    },
  );
  assert.ok(!retained.retainedItemIds.includes(host.id));
  assert.match(
    JSON.stringify(compileModelMessages([decodeCanonicalItem(host)])),
    /not a human message or new authorization/,
  );
  const recovered = fixture(
    {
      provider: "host-replay",
      async *stream(): AsyncIterable<ModelEvent> {
        yield { type: "text_delta", delta: "done" };
      },
    },
    f.journal,
    f.metadata,
  );
  const retry = await recovered.server.wakeTurn(target.id, {
    clientId: "host",
    source: "room",
    sourceId: "room-1",
    text: "Room Agent content",
  });
  assert.equal(retry.turnId, host.turnId);
  assert.equal((await recovered.server.readThread(target.id)).turns.length, 2);
});

test("Host admission fences deleted/archive targets and protects all canonical client identities", async () => {
  const f = fixture({
      provider: "host-fences",
      async *stream(): AsyncIterable<ModelEvent> {
        yield { type: "text_delta", delta: "done" };
      },
    }),
    target = await f.server.startThread();
  await (
    await f.server.startTurn(target.id, "human", { clientId: "human" })
  ).done;
  const input = {
    clientId: "host",
    source: "trigger" as const,
    sourceId: "t",
    text: "wake",
  };
  await assert.rejects(
    f.server.wakeTurn(target.id, { ...input, clientId: "human" }),
    /identity/,
  );
  await f.server.setThreadArchived(target.id, true);
  await assert.rejects(f.server.wakeTurn(target.id, input), /archived/);
  await f.server.deleteThread(
    target.id,
    (await f.server.readThread(target.id)).items.at(-1)!.id,
  );
  await assert.rejects(f.server.wakeTurn(target.id, input), /deleted/);
  assert.throws(
    () =>
      decodeCanonicalItem({
        id: "invalid",
        threadId: "t",
        turnId: "turn",
        createdAt: new Date().toISOString(),
        type: "host_message",
        sender: "host",
        source: "room",
        clientId: "c",
        text: "x",
        mode: "steer",
      }),
    /sourceId/,
  );
});

test("ordinary human default starts idle, steers busy, and ignores no explicit queue", async () => {
  const f = blocked(),
    target = await f.server.startThread();
  const active = await f.server.sendMessage(target.id, "first", {
    clientId: "first",
  });
  await f.entered.promise;
  try {
    const second = await f.server.sendMessage(target.id, "second", {
      clientId: "second",
    });
    assert.equal(second.id, active.id);
    await f.server.queueMessage(target.id, "explicit later", "later");
    assert.equal(
      pendingQueuedMessages((await f.server.readThread(target.id)).items)
        .length,
      1,
    );
  } finally {
    f.release.resolve();
  }
  await active.done;
  const duplicate = await f.server.sendMessage(target.id, "second", {
    clientId: "second",
  });
  assert.equal(duplicate.id, active.id);
});

test(
  "CLI ordinary prompt defaults to native soft steer on an existing busy Thread",
  { timeout: 10_000 },
  async () => {
    const { spawn } = await import("node:child_process");
    const { serveCodexWebSocket } =
      await import("../src/protocol/codex/websocket.js");
    const f = blocked(),
      target = await f.server.startThread();
    const active = await f.server.startTurn(target.id, "first");
    await f.entered.promise;
    const host = await serveCodexWebSocket({
      appServer: f.server,
      zenHome: "/tmp",
      listen: "ws://127.0.0.1:0",
    });
    const observed = deferred();
    const stop = f.server.subscribe((event) => {
      if (
        event.type === "item_completed" &&
        event.item.type === "user_message" &&
        event.item.clientId !== undefined
      )
        observed.resolve();
    });
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "apps/cli/src/cli.ts",
        "run",
        "--remote",
        host.url,
        "--thread",
        target.id,
        "cli correction",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let error = "";
    child.stderr.on("data", (chunk) => {
      error += String(chunk);
    });
    const exited = once(child, "exit");
    try {
      await Promise.race([
        observed.promise,
        exited.then(() => {
          throw new Error(`CLI exited before admission: ${error}`);
        }),
      ]);
      f.release.resolve();
      await active.done;
      assert.equal((await exited)[0], 0, error);
      const snapshot = await f.server.readThread(target.id);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(
        snapshot.items.filter((item) => item.type === "user_message").length,
        2,
      );
      assert.equal(
        snapshot.items.some((item) => item.type === "user_message_queued"),
        false,
      );
    } finally {
      f.release.resolve();
      stop();
      if (child.exitCode === null) child.kill();
      await host.close();
    }
  },
);

for (const origin of ["human", "host"] as const) {
  test(`new ${origin} default during interrupt quiescence starts after the exact predecessor`, async () => {
    const entered = deferred(),
      aborting = deferred(),
      cleanup = deferred();
    let calls = 0;
    const f = fixture({
      provider: `interrupt-${origin}`,
      async *stream(request): AsyncIterable<ModelEvent> {
        if (calls++ === 0) {
          entered.resolve();
          await new Promise<void>((resolve) =>
            request.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          aborting.resolve();
          await cleanup.promise;
          request.signal.throwIfAborted();
        }
        yield { type: "text_delta", delta: "done" };
      },
    });
    const target = await f.server.startThread();
    const old = await f.server.startTurn(target.id, "old");
    await entered.promise;
    const interrupted = f.server.interruptTurn(target.id, old.id);
    await aborting.promise;
    const send =
      origin === "human"
        ? f.server.sendMessage(target.id, "new", { clientId: "new" })
        : f.server.wakeTurn(target.id, {
            clientId: "new",
            source: "trigger",
            sourceId: "t",
            text: "new",
          });
    cleanup.resolve();
    await interrupted;
    await send;
    const snapshot = await idle(f, target.id);
    assert.equal(snapshot.turns.length, 2);
    assert.equal(snapshot.turns[0]!.status, "interrupted");
    assert.equal(
      snapshot.items.filter(
        (item) =>
          (item.type === "user_message" || item.type === "host_message") &&
          item.clientId === "new",
      ).length,
      1,
    );
  });
}

test("unknown Host append outcome is read back after restart without replay", async () => {
  const { InMemoryThreadJournal } = await import("../src/journal.js");
  class UncertainJournal extends InMemoryThreadJournal {
    fail = false;
    override async append(item: import("../src/item.js").CanonicalItem) {
      await super.append(item);
      if (this.fail && item.type === "host_message") {
        this.fail = false;
        throw new Error("unknown append result");
      }
    }
  }
  const journal = new UncertainJournal(),
    entered = deferred(),
    release = deferred();
  let calls = 0;
  const f = fixture(
    {
      provider: "host-unknown",
      async *stream(): AsyncIterable<ModelEvent> {
        if (calls++ === 0) {
          entered.resolve();
          await release.promise;
        }
        yield { type: "text_delta", delta: "done" };
      },
    },
    journal,
  );
  const target = await f.server.startThread();
  const active = await f.server.startTurn(target.id, "hold");
  await entered.promise;
  const input = {
    clientId: "unknown",
    source: "trigger" as const,
    sourceId: "t",
    text: "accepted",
  };
  journal.fail = true;
  await assert.rejects(f.server.wakeTurn(target.id, input), /unknown/);
  release.resolve();
  await active.done.catch(() => undefined);
  const restarted = fixture(
    {
      provider: "host-unknown",
      async *stream(): AsyncIterable<ModelEvent> {
        yield { type: "text_delta", delta: "done" };
      },
    },
    journal,
    f.metadata,
  );
  const result = await restarted.server.wakeTurn(target.id, input);
  assert.equal(result.turnId, active.id);
  assert.equal(
    (await restarted.server.readThread(target.id)).items.filter(
      (item) => item.type === "host_message",
    ).length,
    1,
  );
});

test("Host input cannot override canonical sender, Thread, Turn or Item kind", async () => {
  const f = fixture({
      provider: "host-whitelist",
      async *stream(): AsyncIterable<ModelEvent> {
        yield { type: "text_delta", delta: "done" };
      },
    }),
    target = await f.server.startThread();
  await f.server.wakeTurn(target.id, {
    clientId: "whitelist",
    source: "bootstrap",
    text: "wake",
    sender: "user",
    type: "user_message",
    threadId: "spoof",
    turnId: "spoof",
    id: "spoof",
  } as import("../src/item.js").HostWakeupInput);
  const snapshot = await idle(f, target.id),
    host = snapshot.items.find((item) => item.type === "host_message")!;
  assert.equal(host.threadId, target.id);
  assert.notEqual(host.id, "spoof");
  assert.notEqual(host.turnId, "spoof");
  assert.equal(host.type, "host_message");
  assert.equal(host.sender, "host");
  assert.equal(
    snapshot.items.some((item) => item.type === "user_message"),
    false,
  );
});

test("large idle Host burst drains bounded soft batches before final completion", async () => {
  const f = fixture({
      provider: "host-burst-budget",
      async *stream(): AsyncIterable<ModelEvent> {
        yield { type: "text_delta", delta: "done" };
      },
    }),
    target = await f.server.startThread();
  await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      f.server.wakeTurn(target.id, {
        clientId: `burst-${i}`,
        source: "trigger",
        sourceId: `source-${i}`,
        text: `note-${i}`,
      }),
    ),
  );
  const snapshot = await idle(f, target.id);
  assert.equal(
    snapshot.items.filter((item) => item.type === "host_message").length,
    30,
  );
  assert.equal(snapshot.turns.length, 1);
  assert.equal(pendingQueuedMessages(snapshot.items).length, 0);
});
