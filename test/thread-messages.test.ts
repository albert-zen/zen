import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { ZenAppServer } from "../src/app-server.js";
import { decodeCanonicalItem, textFromUserInput } from "../src/item.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { AgentRuntime } from "../src/runtime.js";
import { compileItemList } from "../src/item-list.js";
import { ToolEnvironment, ShellToolRuntime } from "../src/tool.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
  type ModelMessage,
} from "../src/model.js";

import { deferred, fixture, sender } from "./thread-message-fixture.js";

function hasTextPart(message: ModelMessage, text: string): boolean {
  return "content" in message
    ? message.content.some((part) => part.type === "text" && part.text === text)
    : "text" in message && message.text === text;
}

function messageText(message: ModelMessage): string {
  return "content" in message
    ? textFromUserInput(message.content)
    : "text" in message
      ? (message.text ?? "")
      : "";
}

test("agent burst steers one busy Turn with separate truthful sender receipts", async () => {
  const entered = deferred(),
    release = deferred();
  const requests: ModelRequest[] = [];
  let blocked = false;
  const model: ModelAdapter = {
    provider: "messages",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(request);
      if (
        request.messages.some(
          (m) => m.role === "user" && hasTextPart(m, "target"),
        ) &&
        !blocked
      ) {
        blocked = true;
        entered.resolve();
        await release.promise;
      }
      yield { type: "text_delta", delta: "answer" };
    },
  };
  const f = fixture(model);
  const a = await sender(f, "a"),
    b = await sender(f, "b");
  const target = await f.server.startThread();
  const active = await f.server.startTurn(target.id, "target");
  await entered.promise;
  try {
    const results = await Promise.all(
      [a, b].map((source, i) =>
        f.server.sendThreadMessage(target.id, {
          sender: source,
          text: `message-${i}`,
        }),
      ),
    );
    assert.deepEqual(
      results.map((r) => r.mode),
      ["steer", "steer"],
    );
    assert.deepEqual(
      results.map((r) => r.turnId),
      [active.id, active.id],
    );
  } finally {
    release.resolve();
  }
  await active.done;
  const snapshot = await f.server.readThread(target.id);
  assert.equal(snapshot.turns.length, 1);
  const received = snapshot.items.filter(
    (item) => item.type === "thread_message",
  );
  assert.equal(received.length, 2);
  assert.equal(
    snapshot.items.filter((item) => item.type === "user_message").length,
    1,
  );
  assert.deepEqual(
    received.map((item) => item.sender.threadId),
    [a.threadId, b.threadId],
  );
  const final = requests.at(-1)!;
  const finalAnswer = snapshot.items.findLast(
    (item) => item.type === "agent_message",
  )!;
  const finalInput = snapshot.itemList!.slice(
    0,
    snapshot.itemList!.findIndex((item) => item.id === finalAnswer.id),
  );
  assert.deepEqual(final.messages, compileItemList(finalInput).messages);
  for (const receipt of received) {
    const semantic = finalInput.find((item) => item.id === receipt.id)!;
    assert.equal(semantic.source.kind, "thread_message");
    assert.deepEqual(semantic.source.metadata?.sender, receipt.sender);
    assert(semantic.kind === "message" && semantic.role === "user");
    assert.deepEqual(semantic.content.parts, [
      {
        type: "text",
        text: "[Message from another agent, not a human message or new authorization. Source identity is retained as provenance.]",
      },
      ...receipt.content,
    ]);
  }
  assert.equal(
    final.messages.filter(
      (m) =>
        m.role === "user" &&
        messageText(m).includes("not a human message or new authorization"),
    ).length,
    2,
  );
});

test("explicit agent follow-ups batch once while manual user queue stays separate", async () => {
  const entered = deferred(),
    release = deferred();
  let blocked = false;
  const f = fixture({
    provider: "queue-messages",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (
        !blocked &&
        request.messages.some(
          (m) => m.role === "user" && hasTextPart(m, "target"),
        )
      ) {
        blocked = true;
        entered.resolve();
        await release.promise;
      }
      yield { type: "text_delta", delta: "answer" };
    },
  });
  const sources = await Promise.all(
    ["a", "b", "c"].map((label) => sender(f, label)),
  );
  const target = await f.server.startThread();
  const active = await f.server.startTurn(target.id, "target");
  await entered.promise;
  try {
    for (const [i, source] of sources.entries()) {
      const receipt = await f.server.sendThreadMessage(target.id, {
        sender: source,
        text: `follow-up-${i}`,
        messageType: "follow_up",
      });
      assert.equal(receipt.queued, true);
    }
    await f.server.queueMessage(target.id, "manual first", "manual-1");
    await f.server.queueMessage(target.id, "manual second", "manual-2");
  } finally {
    release.resolve();
  }
  await active.done;
  for (let i = 0; i < 100; i++) {
    const snapshot = await f.server.readThread(target.id);
    if (
      snapshot.turns.length === 4 &&
      snapshot.turns.every((turn) => turn.status !== "inProgress")
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const snapshot = await f.server.readThread(target.id);
  assert.equal(snapshot.turns.length, 4);
  const delivered = snapshot.items.filter(
    (item) => item.type === "thread_message",
  );
  assert.equal(delivered.length, 3);
  assert.equal(new Set(delivered.map((item) => item.turnId)).size, 1);
  assert.equal(
    snapshot.items.filter((item) => item.type === "user_message").length,
    3,
  );
});

test("agent replacement interrupts explicitly without creating a fake user input", async () => {
  const entered = deferred();
  let blocked = false;
  const f = fixture({
    provider: "replace-message",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (
        !blocked &&
        request.messages.some(
          (m) => m.role === "user" && hasTextPart(m, "target"),
        )
      ) {
        blocked = true;
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          );
        });
      }
      yield { type: "text_delta", delta: "answer" };
    },
  });
  const source = await sender(f, "replace");
  const target = await f.server.startThread();
  const active = await f.server.startTurn(target.id, "target");
  await entered.promise;
  const result = await f.server.sendThreadMessage(target.id, {
    sender: source,
    text: "replacement",
    messageType: "replacement",
  });
  assert.equal(result.mode, "replace");
  assert.notEqual(result.turnId, active.id);
  await active.done;
  const snapshot = await f.server.readThread(target.id);
  assert.equal(snapshot.turns[0]?.status, "interrupted");
  assert.equal(
    snapshot.items.filter((item) => item.type === "user_message").length,
    1,
  );
  assert.equal(
    snapshot.items.filter((item) => item.type === "thread_message").length,
    1,
  );
});

const quickModel: ModelAdapter = {
  provider: "quick-messages",
  async *stream(): AsyncIterable<ModelEvent> {
    yield { type: "text_delta", delta: "done" };
  },
};
async function idle(f: ReturnType<typeof fixture>, id: string) {
  for (let i = 0; i < 200; i++) {
    const snapshot = await f.server.readThread(id);
    if (
      snapshot.turns.length > 0 &&
      snapshot.turns.every((turn) => turn.status !== "inProgress")
    )
      return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Thread did not become idle");
}

test("idle burst and exact retries retain one message per source and no fake users", async () => {
  const f = fixture(quickModel);
  const sources = await Promise.all(
    ["a", "b", "c"].map((label) => sender(f, label)),
  );
  const target = await f.server.startThread();
  const inputs = sources.map((sender, index) => ({
    sender,
    text: `idle-${index}`,
  }));
  const results = await Promise.all(
    inputs.map((input) => f.server.sendThreadMessage(target.id, input)),
  );
  const snapshot = await idle(f, target.id);
  assert.equal(snapshot.turns.length, 1);
  assert.equal(
    snapshot.items.filter((item) => item.type === "thread_message").length,
    3,
  );
  assert.equal(
    snapshot.items.filter((item) => item.type === "user_message").length,
    0,
  );
  for (const [index, input] of inputs.entries()) {
    const replay = await f.server.sendThreadMessage(target.id, input);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.clientId, results[index]!.clientId);
    await assert.rejects(
      f.server.sendThreadMessage(target.id, { ...input, text: "changed" }),
      /different input/,
    );
  }
  const restarted = fixture(quickModel, f.journal, f.metadata);
  const replay = await restarted.server.sendThreadMessage(
    target.id,
    inputs[0]!,
  );
  assert.equal(replay.duplicate, true);
  assert.equal((await restarted.server.readThread(target.id)).turns.length, 1);
  for (const item of snapshot.items)
    assert.deepEqual(
      decodeCanonicalItem(JSON.parse(JSON.stringify(item))),
      item,
    );
});

test("sender identity and archive fences reject without appending target input", async () => {
  const f = fixture(quickModel);
  const source = await sender(f, "valid");
  const other = await sender(f, "other");
  const target = await f.server.startThread();
  await assert.rejects(
    f.server.sendThreadMessage(target.id, {
      sender: { ...source, threadId: other.threadId },
      text: "forged",
    }),
    /canonical tool call/,
  );
  await assert.rejects(
    f.server.sendThreadMessage(target.id, {
      sender: { ...source, callId: "wrong" },
      text: "forged",
    }),
    /canonical tool call/,
  );
  await f.server.setThreadArchived(target.id, true);
  await assert.rejects(
    f.server.sendThreadMessage(target.id, { sender: source, text: "archived" }),
    /archived/,
  );
  assert.equal(
    (await f.server.readThread(target.id)).items.filter(
      (item) =>
        item.type === "thread_message" || item.type === "thread_message_queued",
    ).length,
    0,
  );
});

test("steering waits for a tool approval and completed tool batch without aborting it", async () => {
  const approval = deferred(),
    release = deferred();
  const requests: ModelRequest[] = [];
  const f = fixture({
    provider: "tool-message",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(request);
      if (!request.messages.some((message) => message.role === "tool"))
        yield {
          type: "tool_call",
          callId: "target-tool",
          name: "shell",
          arguments: { command: "printf tool" },
        };
      else yield { type: "text_delta", delta: "done" };
    },
  });
  const source = await sender(f, "tool");
  const target = await f.server.startThread({ approvalPolicy: "always" });
  const active = await f.server.startTurn(target.id, "use tool", {
    requestApproval: async () => {
      approval.resolve();
      await release.promise;
      return "accept";
    },
  });
  await approval.promise;
  await f.server.sendThreadMessage(target.id, {
    sender: source,
    text: "during approval",
  });
  assert.equal(requests.length, 1);
  release.resolve();
  await active.done;
  assert.equal(requests.length, 2);
  const messages = requests[1]!.messages;
  const toolIndex = messages.findIndex((message) => message.role === "tool");
  const steerIndex = messages.findIndex(
    (message) =>
      message.role === "user" && hasTextPart(message, "during approval"),
  );
  assert.ok(toolIndex >= 0 && steerIndex > toolIndex);
});

test("interruption preserves follow-ups and cancellation survives reload without automatic replay", async () => {
  const entered = deferred();
  const blocked: ModelAdapter = {
    provider: "pause-message",
    async *stream(request): AsyncIterable<ModelEvent> {
      entered.resolve();
      await new Promise<void>((_resolve, reject) =>
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        ),
      );
    },
  };
  const f = fixture(blocked);
  const source = await sender(f, "pause");
  const target = await f.server.startThread();
  const active = await f.server.startTurn(target.id, "block");
  await entered.promise;
  const input = {
    sender: source,
    text: "queued",
    messageType: "follow_up" as const,
  };
  const receipt = await f.server.sendThreadMessage(target.id, input);
  await f.server.interruptTurn(target.id, active.id);
  const snapshot = await f.server.readThread(target.id);
  assert.equal(snapshot.turns.length, 1);
  assert.equal(
    snapshot.items.filter((item) => item.type === "thread_message").length,
    0,
  );
  const result = await f.server.cancelQueuedMessages(target.id, [
    { queuedItemId: receipt.messageId, clientId: receipt.clientId },
  ]);
  assert.equal(result[0]?.status, "cancelled");
  const restarted = fixture(
    { ...quickModel, provider: blocked.provider },
    f.journal,
    f.metadata,
  );
  await assert.rejects(
    restarted.server.sendThreadMessage(target.id, input),
    /cancelled/,
  );
  await restarted.server.resumeQueue(target.id);
  assert.equal((await restarted.server.readThread(target.id)).turns.length, 1);
});

test("remote provenance is bound to the authenticated device and never asserted as local", async () => {
  const f = fixture(quickModel);
  const target = await f.server.startThread();
  const input = {
    sender: {
      threadId: "remote-thread",
      toolCallId: "remote-item",
      callId: "remote-call",
    },
    text: "remote agent",
  };
  const result = await f.server.sendRemoteThreadMessage(
    target.id,
    input,
    "paired-device",
    "remote-id",
  );
  const snapshot = await idle(f, target.id);
  const item = snapshot.items.find((item) => item.type === "thread_message")!;
  assert.equal(item.type, "thread_message");
  assert.equal(item.sender.deviceId, "paired-device");
  assert.equal(item.sender.turnId, undefined);
  const semantic = snapshot.itemList!.find((entry) => entry.id === item.id)!;
  assert.deepEqual(semantic.source.metadata?.sender, item.sender);
  assert(semantic.kind === "message" && semantic.role === "user");
  assert.deepEqual(semantic.content.parts.slice(1), item.content);
  const messages = compileItemList(snapshot.itemList!).messages;
  assert.match(
    JSON.stringify(messages),
    /not a human message or new authorization/,
  );
  assert.doesNotMatch(
    JSON.stringify(messages),
    /local Host verified|human authorization/,
  );
  await assert.rejects(
    f.server.sendRemoteThreadMessage(
      target.id,
      input,
      "other-device",
      result.clientId,
    ),
    /different input/,
  );
});

test("deleted target and deleted source are fenced before accepting agent input", async () => {
  const f = fixture(quickModel);
  const source = await sender(f, "deleted");
  const target = await f.server.startThread();
  await f.server.setThreadArchived(target.id, true);
  const deletion = await f.server.deleteThread(
    target.id,
    (await f.server.readThread(target.id)).items.at(-1)!.id,
  );
  await assert.rejects(
    f.server.sendThreadMessage(target.id, { sender: source, text: "no" }),
    /deleted/,
  );
  await assert.rejects(
    f.server.sendRemoteThreadMessage(
      target.id,
      { sender: source, text: "no" },
      "peer",
      "remote-deleted",
    ),
    /deleted/,
  );
  await f.server.restoreThread(target.id, deletion.deletionItemId);
  await f.server.setThreadArchived(source.threadId, true);
  await f.server.deleteThread(
    source.threadId,
    (await f.server.readThread(source.threadId)).items.at(-1)!.id,
  );
  await assert.rejects(
    f.server.sendThreadMessage(target.id, { sender: source, text: "no" }),
    /deleted/,
  );
  assert.equal((await f.server.readThread(target.id)).turns.length, 0);
});

test("agent provenance is preserved in replay and compaction retention never promotes it to user authority", async () => {
  const {
    latestEligibleCompactionBoundary,
    normalizeContextCompactionConfig,
    planCompactionRetention,
  } = await import("../src/context-compaction.js");
  const { NativeRecoveryProjection } =
    await import("../src/protocol/native/recovery.js");
  const { projectNativeRecovery } =
    await import("../apps/zenx/src/renderer/src/thread-view-state.js");
  const f = fixture(quickModel),
    source = await sender(f, "compaction");
  const target = await f.server.startThread();
  const human = await f.server.startTurn(target.id, "human instruction");
  await human.done;
  await f.server.sendThreadMessage(target.id, {
    sender: source,
    text: "agent context",
  });
  const snapshot = await idle(f, target.id);
  const boundary = latestEligibleCompactionBoundary(snapshot.items)!;
  const retained = planCompactionRetention(snapshot.items, boundary, {
    retainedTokenBudget: 10_000,
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
  });
  const agentItem = snapshot.items.find(
    (item) => item.type === "thread_message",
  )!;
  const userItem = snapshot.items.find((item) => item.type === "user_message")!;
  assert.ok(retained.retainedItemIds.includes(userItem.id));
  assert.ok(!retained.retainedItemIds.includes(agentItem.id));
  const explicitlyRetained = planCompactionRetention(snapshot.items, boundary, {
    retainedTokenBudget: 10_000,
    estimateRetainedTokens: () => 0,
    retention: {
      ...normalizeContextCompactionConfig().retention,
      mode: "selected-items",
      preserveUserMessages: false,
      finalMessages: "none",
      recentTurnCount: 0,
      itemIds: [agentItem.id],
      itemRanges: [],
    },
  });
  assert.deepEqual(explicitlyRetained.retainedItemIds, [agentItem.id]);
  assert.match(
    JSON.stringify(
      compileItemList(
        snapshot.itemList!.filter((item) => item.id === agentItem.id),
      ).messages,
    ),
    /not a human message or new authorization/,
  );
  const projection = new NativeRecoveryProjection(f.server);
  try {
    const view = projectNativeRecovery(await projection.resume(target.id));
    assert.equal(
      view.turns
        .flatMap((turn) => turn.items)
        .filter((item) => item.type === "threadMessage").length,
      1,
    );
    assert.equal(
      view.turns
        .flatMap((turn) => turn.items)
        .filter((item) => item.type === "userMessage").length,
      1,
    );
  } finally {
    projection.close();
  }
});

test("uncertain append is never replayed as another message after restart", async () => {
  class UncertainJournal extends InMemoryThreadJournal {
    fail = false;
    override async append(item: import("../src/item.js").CanonicalItem) {
      await super.append(item);
      if (this.fail && item.type === "thread_message") {
        this.fail = false;
        throw new Error("injected outcome unknown");
      }
    }
  }
  const entered = deferred(),
    release = deferred();
  const journal = new UncertainJournal();
  let blocked = false;
  const model: ModelAdapter = {
    provider: "unknown-message",
    async *stream(): AsyncIterable<ModelEvent> {
      if (!blocked) {
        blocked = true;
        entered.resolve();
        await release.promise;
      }
      yield { type: "text_delta", delta: "done" };
    },
  };
  const f = fixture(model, journal);
  const source = await sender(f, "unknown"),
    target = await f.server.startThread();
  const active = await f.server.startTurn(target.id, "target");
  await entered.promise;
  const input = { sender: source, text: "accepted but response uncertain" };
  journal.fail = true;
  await assert.rejects(f.server.sendThreadMessage(target.id, input), /unknown/);
  release.resolve();
  await active.done.catch(() => undefined);
  const restarted = fixture(
    { ...quickModel, provider: model.provider },
    journal,
    f.metadata,
  );
  const retry = await restarted.server.sendThreadMessage(target.id, input);
  assert.equal(retry.duplicate, true);
  assert.equal(
    (await restarted.server.readThread(target.id)).items.filter(
      (item) => item.type === "thread_message",
    ).length,
    1,
  );
});

test("a human send cannot consume or impersonate an Agent client identity", async () => {
  const f = fixture(quickModel),
    source = await sender(f, "identity");
  const target = await f.server.startThread();
  const receipt = await f.server.sendThreadMessage(target.id, {
    sender: source,
    text: "agent",
  });
  await idle(f, target.id);
  await assert.rejects(
    f.server.startTurn(target.id, "agent", { clientId: receipt.clientId }),
    /identity|reserved/,
  );
  await assert.rejects(
    f.server.queueMessage(target.id, "agent", receipt.clientId),
    /identity|reserved/,
  );
  assert.equal(
    (await f.server.readThread(target.id)).items.filter(
      (item) => item.type === "user_message",
    ).length,
    0,
  );
});

test("canonical sender validation and queue projection preserve origin boundaries", async () => {
  const { pendingQueuedMessages } = await import("../src/input-queue.js");
  const input = [{ type: "text" as const, text: "context" }];
  const queued = {
    type: "thread_message_queued" as const,
    id: "queued",
    threadId: "target",
    createdAt: "2026-10-13T00:00:00.000Z",
    clientId: "agent-id",
    sender: {
      threadId: "source",
      turnId: "turn",
      toolCallId: "tool",
      callId: "call",
    },
    input,
    deliveryMode: "batch-next" as const,
    messageType: "guidance" as const,
  };
  const origin = { hostId: "source-host", workspaceId: "source-workspace" };
  const returnRoute = {
    ...origin,
    receiverHostId: "receiver-host",
    deviceId: "outbound-peer",
    deviceKey: "a".repeat(64),
  };
  const remote = {
    ...queued,
    sender: {
      ...queued.sender,
      turnId: undefined,
      deviceId: "inbound-peer",
      origin,
      returnRoute,
    },
  };
  assert.deepEqual(decodeCanonicalItem(remote), remote);
  assert.throws(
    () =>
      decodeCanonicalItem({ ...queued, sender: { ...queued.sender, origin } }),
    /Only remote/,
  );
  assert.throws(
    () =>
      decodeCanonicalItem({
        ...remote,
        sender: {
          ...remote.sender,
          returnRoute: { ...returnRoute, workspaceId: "other-workspace" },
        },
      }),
    /must match/,
  );
  assert.throws(
    () =>
      decodeCanonicalItem({
        ...remote,
        sender: { ...remote.sender, origin: undefined },
      }),
    /origin/,
  );
  const cancel = {
    type: "user_message_queue_cancelled" as const,
    id: "cancel",
    threadId: queued.threadId,
    createdAt: queued.createdAt,
    clientId: queued.clientId,
    queuedItemId: queued.id,
  };
  assert.equal(pendingQueuedMessages([queued, cancel]).length, 1);
  assert.equal(
    pendingQueuedMessages([
      queued,
      { ...cancel, type: "thread_message_cancelled" },
    ]).length,
    0,
  );
  assert.throws(
    () =>
      decodeCanonicalItem({
        ...queued,
        sender: { ...queued.sender, turnId: undefined },
      }),
    /turnId/,
  );
  assert.throws(
    () =>
      decodeCanonicalItem({
        ...queued,
        sender: { ...queued.sender, deviceId: "remote" },
      }),
    /Remote sender/,
  );
  assert.throws(
    () =>
      decodeCanonicalItem({
        type: "turn_replacement_requested",
        id: "replacement",
        threadId: queued.threadId,
        turnId: "old",
        successorTurnId: "new",
        createdAt: queued.createdAt,
        clientId: queued.clientId,
        input,
        sender: { ...queued.sender, deviceId: "remote" },
      }),
    /Remote sender/,
  );
});

for (const replacement of [false, true]) {
  test(`native agent ${replacement ? "replacement" : "idle"} launch retains target approval routing`, async () => {
    const { NativeConnection } =
      await import("../src/protocol/native/connection.js");
    const { NativeRecoveryProjection } =
      await import("../src/protocol/native/recovery.js");
    const entered = deferred();
    const f = fixture({
      provider: "native-approval",
      async *stream(request): AsyncIterable<ModelEvent> {
        if (
          !request.messages.some(
            (message) =>
              message.role === "user" &&
              hasTextPart(message, "Run approved shell"),
          )
        ) {
          entered.resolve();
          await new Promise<void>((_resolve, reject) =>
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            ),
          );
          return;
        }
        if (!request.messages.some((message) => message.role === "tool"))
          yield {
            type: "tool_call",
            callId: "approval-target",
            name: "shell",
            arguments: { command: "printf approved" },
          };
        else yield { type: "text_delta", delta: "done" };
      },
    });
    const source = await sender(f, "approval");
    const target = await f.server.startThread({ approvalPolicy: "always" });
    const active = replacement
      ? await f.server.startTurn(target.id, "hold")
      : undefined;
    if (active) await entered.promise;
    const projection = new NativeRecoveryProjection(f.server);
    const approvals: import("../src/tool.js").ApprovalRequest[] = [];
    const replies: unknown[] = [];
    const connection = new NativeConnection({
      projection,
      appServer: f.server,
      isInitialized: () => true,
      requestApproval: async (request) => {
        approvals.push(request);
        return "accept";
      },
      send: (message) => {
        if ("id" in message && message.id === 1) replies.push(message);
      },
    });
    try {
      await connection.receive({
        id: 1,
        method: "zen/thread/message",
        params: {
          threadId: target.id,
          sourceThreadId: source.threadId,
          sourceToolCallId: source.toolCallId,
          sourceCallId: source.callId,
          text: "Run approved shell",
          ...(replacement ? { messageType: "replacement" } : {}),
        },
      });
      const snapshot = await idle(f, target.id);
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0]!.threadId, target.id);
      assert.notEqual(approvals[0]!.threadId, source.threadId);
      assert.equal(approvals[0]!.turnId, snapshot.turns.at(-1)!.id);
      assert.equal(
        snapshot.items.find((item) => item.type === "tool_result")?.exitCode,
        0,
      );
      assert.equal(replies.length, 1);
    } finally {
      await active?.done;
      connection.close();
      projection.close();
    }
  });
}

test(
  "late native approval cannot execute an interrupted and deleted target",
  { timeout: 5000 },
  async () => {
    const { NativeConnection } =
      await import("../src/protocol/native/connection.js");
    const { NativeRecoveryProjection } =
      await import("../src/protocol/native/recovery.js");
    const { mkdtemp, access, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(os.tmpdir(), "agent-approval-"));
    const marker = join(directory, "must-not-run");
    const entered = deferred(),
      release = deferred();
    let approval: import("../src/tool.js").ApprovalRequest | undefined;
    const f = fixture({
      provider: "late-approval",
      async *stream(): AsyncIterable<ModelEvent> {
        yield {
          type: "tool_call",
          callId: "late-tool",
          name: "shell",
          arguments: {
            command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(process.argv[1], 'ran')" ${JSON.stringify(marker)}`,
          },
        };
      },
    });
    const source = await sender(f, "late");
    const target = await f.server.startThread({ approvalPolicy: "always" });
    const projection = new NativeRecoveryProjection(f.server);
    const connection = new NativeConnection({
      projection,
      appServer: f.server,
      isInitialized: () => true,
      send: () => {},
      requestApproval: async (request) => {
        approval = request;
        entered.resolve();
        await release.promise;
        return "accept";
      },
    });
    try {
      await connection.receive({
        id: 1,
        method: "zen/thread/message",
        params: {
          threadId: target.id,
          sourceThreadId: source.threadId,
          sourceToolCallId: source.toolCallId,
          sourceCallId: source.callId,
          text: "run tool",
        },
      });
      await entered.promise;
      assert.equal(approval!.threadId, target.id);
      await assert.rejects(
        f.server.setThreadArchived(target.id, true),
        /running turn/,
      );
      await f.server.interruptTurn(target.id, approval!.turnId);
      assert.equal(approval!.signal.aborted, true);
      const snapshot = await idle(f, target.id);
      await f.server.setThreadArchived(target.id, true);
      await f.server.deleteThread(target.id, snapshot.items.at(-1)!.id);
      release.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await assert.rejects(access(marker));
      await assert.rejects(
        f.server.sendThreadMessage(target.id, {
          sender: source,
          text: "run tool",
        }),
        /deleted/,
      );
    } finally {
      if (approval !== undefined)
        await f.server
          .interruptTurn(target.id, approval.turnId)
          .catch(() => undefined);
      release.resolve();
      connection.close();
      projection.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
