import assert from "node:assert/strict";
import test from "node:test";

import type { Thread, ThreadItem, Turn } from "../src/protocol-client/index.js";
import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import { threadHasActiveTurn } from "../src/renderer/src/thread-list.js";
import {
  activeTurn,
  applyNativeThreadEvent,
  applyThreadViewNotification,
  markThreadViewAwaitingRecovery,
  projectNativeRecovery,
} from "../src/renderer/src/thread-view-state.js";
import type { NativeThreadRecoverySnapshot } from "../../../src/protocol/native/recovery.js";

test("keeps interrupted history from thread/resume as terminal history", () => {
  const interrupted = turn("turn-old", "interrupted", [
    userItem("user-old", "stop here"),
    agentItem("agent-old", "partial answer"),
  ]);
  const resumed = thread([interrupted]);

  assert.equal(activeTurn(resumed), null);
  assert.equal(resumed.turns[0]?.status, "interrupted");
  assert.equal(resumed.turns[0]?.items[1]?.type, "agentMessage");
});

test("streams agent text in memory and replaces it with the completed item", () => {
  let current = thread();
  const running = turn("turn-1", "inProgress");
  current = applyThreadViewNotification(
    current,
    "turn/started",
    { threadId: current.id, turn: running },
    20,
  );
  current = applyThreadViewNotification(current, "item/started", {
    threadId: current.id,
    turnId: running.id,
    item: agentItem("agent-1", ""),
    startedAtMs: 20_000,
  });
  current = applyThreadViewNotification(current, "item/agentMessage/delta", {
    threadId: current.id,
    turnId: running.id,
    itemId: "agent-1",
    delta: "transient ",
  });
  current = applyThreadViewNotification(current, "item/agentMessage/delta", {
    threadId: current.id,
    turnId: running.id,
    itemId: "agent-1",
    delta: "text",
  });
  assert.equal(agentText(current), "transient text");

  current = applyThreadViewNotification(current, "item/completed", {
    threadId: current.id,
    turnId: running.id,
    item: agentItem("agent-1", "canonical final text"),
    completedAtMs: 21_000,
  });
  current = applyThreadViewNotification(current, "turn/completed", {
    threadId: current.id,
    turn: turn(running.id, "completed"),
  });

  assert.equal(agentText(current), "canonical final text");
  assert.equal(current.turns[0]?.status, "completed");
  assert.equal(current.turns[0]?.items.length, 1);
  assert.equal(current.status.type, "idle");
});

test("native recovery keeps an active partial response once without reviving old epochs", () => {
  const metadata = {
    id: "metadata-1",
    type: "thread_metadata" as const,
    threadId: "thread-1",
    createdAt: new Date(10_000).toISOString(),
    cwd: "/workspace",
    providerProfileId: "fake",
    modelId: "fake",
    reasoningEffort: null,
    sandbox: "danger-full-access" as const,
    approvalPolicy: "never" as const,
  };
  const started = {
    id: "turn-start-1",
    type: "turn_started" as const,
    threadId: "thread-1",
    turnId: "turn-live",
    createdAt: new Date(11_000).toISOString(),
    selection: {
      providerProfileId: "fake",
      modelId: "fake",
      reasoningEffort: null,
    },
  };
  const recovery: NativeThreadRecoverySnapshot = {
    processEpoch: "current",
    threadId: "thread-1",
    watermark: 4,
    thread: {
      id: "thread-1",
      items: [metadata, started],
      turns: [
        {
          id: "turn-live",
          status: "inProgress",
          items: [started],
          selection: started.selection,
          model: "fake",
        },
      ],
      cwd: "/workspace",
      providerProfileId: "fake",
      modelId: "fake",
      reasoningEffort: null,
      model: "fake",
      provider: "fake",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      archived: false,
    },
    events: [
      {
        processEpoch: "old",
        threadId: "thread-1",
        watermark: 99,
        event: {
          type: "item_delta",
          threadId: "thread-1",
          turnId: "turn-live",
          itemId: "agent-live",
          delta: "duplicate ",
        },
      },
      {
        processEpoch: "current",
        threadId: "thread-1",
        watermark: 2,
        event: {
          type: "item_started",
          threadId: "thread-1",
          turnId: "turn-live",
          itemId: "agent-live",
          itemType: "agent_message",
        },
      },
      {
        processEpoch: "current",
        threadId: "thread-1",
        watermark: 3,
        event: {
          type: "item_delta",
          threadId: "thread-1",
          turnId: "turn-live",
          itemId: "agent-live",
          delta: "partial ",
        },
      },
      {
        processEpoch: "current",
        threadId: "thread-1",
        watermark: 4,
        event: {
          type: "item_delta",
          threadId: "thread-1",
          turnId: "turn-live",
          itemId: "agent-live",
          delta: "answer",
        },
      },
    ],
  };

  const projected = projectNativeRecovery(recovery);
  assert.equal(agentText(projected), "partial answer");
  assert.equal(activeTurn(projected)?.id, "turn-live");
  const awaiting = markThreadViewAwaitingRecovery(projected);
  assert.equal(activeTurn(awaiting), null);
  assert.equal(agentText(awaiting), "partial answer");
});

test("streams reasoning summary and content in memory before canonical completion", () => {
  const running = turn("turn-reasoning", "inProgress");
  let current = thread([running]);
  current = applyThreadViewNotification(current, "item/started", {
    threadId: current.id,
    turnId: running.id,
    item: reasoningItem("reasoning-1"),
    startedAtMs: 20_000,
  });
  current = applyThreadViewNotification(
    current,
    "item/reasoning/summaryPartAdded",
    {
      threadId: current.id,
      turnId: running.id,
      itemId: "reasoning-1",
      summaryIndex: 0,
    },
  );
  for (const delta of ["checked ", "the plan"]) {
    current = applyThreadViewNotification(
      current,
      "item/reasoning/summaryTextDelta",
      {
        threadId: current.id,
        turnId: running.id,
        itemId: "reasoning-1",
        summaryIndex: 0,
        delta,
      },
    );
  }
  for (const delta of ["public ", "thought"]) {
    current = applyThreadViewNotification(current, "item/reasoning/textDelta", {
      threadId: current.id,
      turnId: running.id,
      itemId: "reasoning-1",
      contentIndex: 0,
      delta,
    });
  }
  assert.deepEqual(reasoningValue(current), {
    type: "reasoning",
    id: "reasoning-1",
    summary: ["checked the plan"],
    content: ["public thought"],
    status: "inProgress",
  });

  current = applyThreadViewNotification(current, "item/completed", {
    threadId: current.id,
    turnId: running.id,
    item: reasoningItem("reasoning-1", ["canonical summary"], []),
    completedAtMs: 21_000,
  });
  assert.deepEqual(
    reasoningValue(current),
    reasoningItem("reasoning-1", ["canonical summary"], []),
  );
});

test("streams command output and replaces it with the completed projection", () => {
  const running = turn("turn-command", "inProgress", [
    commandItem("command-1", "inProgress", null),
  ]);
  let current = thread([running]);
  current = applyThreadViewNotification(
    current,
    "item/commandExecution/outputDelta",
    {
      threadId: current.id,
      turnId: running.id,
      itemId: "command-1",
      delta: "temporary output",
    },
  );
  assert.equal(commandOutput(current), "temporary output");

  current = applyThreadViewNotification(current, "item/completed", {
    threadId: current.id,
    turnId: running.id,
    item: commandItem("command-1", "completed", "final output"),
    completedAtMs: 30_000,
  });
  assert.equal(commandOutput(current), "final output");
});

test("projects hard steer as an interrupted turn followed by one successor", () => {
  const old = turn("turn-old", "inProgress", [
    userItem("user-old", "old work"),
  ]);
  let current = thread([old]);
  current = applyThreadViewNotification(current, "turn/completed", {
    threadId: current.id,
    turn: turn(old.id, "interrupted", old.items),
  });
  current = applyThreadViewNotification(current, "turn/started", {
    threadId: current.id,
    turn: turn("turn-new", "inProgress", [userItem("user-new", "replacement")]),
  });

  assert.deepEqual(
    current.turns.map(({ id, status }) => ({ id, status })),
    [
      { id: "turn-old", status: "interrupted" },
      { id: "turn-new", status: "inProgress" },
    ],
  );
  assert.equal(activeTurn(current)?.id, "turn-new");
});

test("blocks Thread lifecycle changes from live turn state before summary refresh", () => {
  const staleSummary: NativeThreadSummary = {
    threadId: "thread-1",
    currentMetadata: {
      model: "fake",
      provider: "fake",
      cwd: "/workspace",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    archived: false,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    preview: "",
    status: "idle",
  };
  const live = applyThreadViewNotification(thread(), "turn/started", {
    threadId: "thread-1",
    turn: turn("turn-live", "inProgress"),
  });

  assert.equal(staleSummary.status, "idle");
  assert.equal(threadHasActiveTurn(staleSummary, live), true);
  assert.equal(threadHasActiveTurn(staleSummary, thread()), false);
});

function thread(turns: Turn[] = []): Thread {
  return {
    id: "thread-1",
    sessionId: "thread-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "fake",
    createdAt: 10,
    updatedAt: 10,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: "/workspace",
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns,
  };
}

function turn(
  id: string,
  status: Turn["status"],
  items: ThreadItem[] = [],
): Turn {
  return {
    id,
    items,
    itemsView: "full",
    status,
    error: null,
    startedAt: 10,
    completedAt: status === "inProgress" ? null : 11,
    durationMs: status === "inProgress" ? null : 1_000,
  };
}

function userItem(id: string, text: string): ThreadItem {
  return {
    type: "userMessage",
    id,
    clientId: null,
    content: [{ type: "text", text, text_elements: [] }],
  };
}

function agentItem(id: string, text: string): ThreadItem {
  return {
    type: "agentMessage",
    id,
    text,
    phase: "final_answer",
    memoryCitation: null,
  };
}

function commandItem(
  id: string,
  status: Extract<ThreadItem, { type: "commandExecution" }>["status"],
  aggregatedOutput: string | null,
): ThreadItem {
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command: "printf zenx",
    cwd: "/workspace",
    processId: null,
    source: "agent",
    status,
    commandActions: [],
    aggregatedOutput,
    exitCode: status === "completed" ? 0 : null,
    durationMs: null,
  };
}

function reasoningItem(
  id: string,
  summary: string[] = [],
  content: string[] = [],
): ThreadItem {
  return { type: "reasoning", id, summary, content };
}

function agentText(value: Thread): string | undefined {
  const item = value.turns[0]?.items[0];
  return item?.type === "agentMessage" ? item.text : undefined;
}

function commandOutput(value: Thread): string | null | undefined {
  const item = value.turns[0]?.items[0];
  return item?.type === "commandExecution" ? item.aggregatedOutput : undefined;
}

function reasoningValue(value: Thread): ThreadItem | undefined {
  return value.turns[0]?.items.find((item) => item.type === "reasoning");
}

test("reasoning follows its own lifecycle and terminal turns settle unfinished thinking", () => {
  const running = turn("thinking", "inProgress");
  let value = thread([running]);
  value = applyThreadViewNotification(value, "item/started", {
    threadId: value.id,
    turnId: running.id,
    item: reasoningItem("r"),
    startedAtMs: 1,
  });
  assert.equal(
    (reasoningValue(value) as { status?: string }).status,
    "inProgress",
  );
  value = applyThreadViewNotification(value, "turn/completed", {
    threadId: value.id,
    turn: turn(running.id, "interrupted"),
  });
  assert.equal(
    (reasoningValue(value) as { status?: string }).status,
    "interrupted",
  );
});

test("native completion replaces live reasoning without duplicates", () => {
  let current = thread([turn("turn-1", "inProgress")]);
  current = applyNativeThreadEvent(current, {
    type: "item_started",
    threadId: current.id,
    turnId: "turn-1",
    itemId: "reasoning-1",
    itemType: "reasoning",
  });
  const item = {
    id: "reasoning-1",
    threadId: current.id,
    turnId: "turn-1",
    createdAt: "2026-09-09T11:25:22Z",
    type: "reasoning" as const,
    reasoningContent: "finished",
    contentVisibility: "public" as const,
  };
  current = applyNativeThreadEvent(current, { type: "item_completed", item });
  current = applyNativeThreadEvent(current, { type: "item_completed", item });
  assert.equal(current.turns[0]!.items.length, 1);
  const completed = current.turns[0]!.items[0]!;
  assert.equal(completed.type, "reasoning");
  if (completed.type === "reasoning") {
    assert.notEqual(completed.status, "inProgress");
    assert.deepEqual(completed.content, ["finished"]);
  }
});

test("replayed native tool call preserves its completed result", () => {
  const current = thread([
    turn("turn-1", "inProgress", [commandItem("tool-1", "completed", "done")]),
  ]);
  const next = applyNativeThreadEvent(current, {
    type: "item_completed",
    item: {
      id: "tool-1",
      threadId: current.id,
      turnId: "turn-1",
      createdAt: "2026-09-09T11:25:22Z",
      type: "tool_call",
      callId: "call-1",
      name: "shell",
      arguments: { command: "echo done" },
    },
  });
  assert.deepEqual(next, current);
});
