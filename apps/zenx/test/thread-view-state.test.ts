import assert from "node:assert/strict";
import test from "node:test";

import type { Thread, ThreadItem, Turn } from "../src/protocol-client/index.js";
import {
  activeTurn,
  applyThreadViewNotification,
} from "../src/renderer/src/thread-view-state.js";

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

function agentText(value: Thread): string | undefined {
  const item = value.turns[0]?.items[0];
  return item?.type === "agentMessage" ? item.text : undefined;
}

function commandOutput(value: Thread): string | null | undefined {
  const item = value.turns[0]?.items[0];
  return item?.type === "commandExecution" ? item.aggregatedOutput : undefined;
}
