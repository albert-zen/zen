import React from "react";
import { createRoot } from "react-dom/client";
import type {
  Thread,
  ThreadItem,
  Turn,
} from "../../src/protocol-client/index.js";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
function thread(turns: Turn[]): Thread {
  return {
    id: "thread-1",
    sessionId: "thread-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "openai",
    createdAt: 10,
    updatedAt: 10,
    recencyAt: null,
    status:
      turns.length === 0
        ? { type: "idle" }
        : { type: "active", activeFlags: [] },
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

function turn(): Turn {
  return turnWithItems("inProgress", []);
}

function turnWithItems(
  status: Turn["status"],
  items: ThreadItem[],
  durationMs: number | null = null,
): Turn {
  return {
    id: "turn-1",
    items,
    itemsView: "full",
    status,
    error: null,
    startedAt: 10,
    completedAt: status === "inProgress" ? null : 11,
    durationMs,
  };
}

function user(text: string, id = "user-1", deliveryAfter?: string): ThreadItem {
  return {
    type: "userMessage",
    id,
    clientId: null,
    content: [{ type: "text", text, text_elements: [] }],
    ...(deliveryAfter === undefined ? {} : { deliveryAfter }),
  } as ThreadItem;
}

function agent(text: string): ThreadItem {
  return {
    type: "agentMessage",
    id: `agent-${text}`,
    text,
    phase: "final_answer",
    memoryCitation: null,
  };
}

function reasoning(summary: string): ThreadItem {
  return {
    type: "reasoning",
    id: "reasoning-1",
    summary: [summary],
    content: [],
  };
}

function reasoningItem(
  id: string,
  summary: string[],
  content: string[],
): Extract<ThreadItem, { type: "reasoning" }> {
  return { type: "reasoning", id, summary, content };
}

function command(value: string): ThreadItem {
  return commandItem("command-1", value);
}

function commandItem(id: string, value: string): ThreadItem {
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command: value,
    cwd: "/workspace",
    processId: null,
    source: "agent",
    status: "completed",
    commandActions: [],
    aggregatedOutput: "ThreadView.tsx",
    exitCode: 0,
    durationMs: null,
  };
}

const values: ThreadItem[] = [
  user("Keep the conversation and its controls aligned."),
  agent("Checking the layout."),
  {
    ...reasoningItem("live", ["Reasoning details"], ["Thinking in progress"]),
    status: "inProgress",
  },
  commandItem("tool-a", "echo test"),
  reasoningItem("done", ["Reasoning details"], ["Complete thought"]),
  {
    ...reasoningItem("partial", ["Reasoning details"], ["Partial thought"]),
    status: "interrupted",
  },
];
document.documentElement.dataset.appearance =
  new URLSearchParams(location.search).get("theme") ?? "light";
createRoot(document.getElementById("root")!).render(
  <div className="agent-surface" style={{ gridTemplateRows: "minmax(0, 1fr)" }}>
    <ThreadView
      approvals={[]}
      composer={emptyComposerState()}
      thread={thread([turnWithItems("inProgress", values)])}
      onDraftChange={() => {}}
      onInterrupt={async () => {}}
      onRespondToApproval={async () => {}}
      onSubmit={async () => {}}
    />
  </div>,
);
