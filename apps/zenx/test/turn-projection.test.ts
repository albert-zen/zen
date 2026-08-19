import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem, Turn } from "../src/protocol-client/index.js";
import { projectTurn } from "../src/renderer/src/turn-projection.js";

test("groups only consecutive reasoning and tool Items", () => {
  const projection = projectTurn(
    turn("inProgress", [
      user("user", "request"),
      agent("agent-a", "Checking first."),
      reasoning("reason-a", "Mapped Items"),
      command("tool-a", "rg files"),
      agent("agent-b", "Applied the result."),
      command("tool-b", "npm test"),
    ]),
  );
  assert.equal(projection.userItems.length, 1);
  assert.deepEqual(
    projection.history.map((node) =>
      node.kind === "trace" ? [node.kind, node.items.length] : [node.kind],
    ),
    [["agent"], ["trace", 2], ["agent"], ["trace", 1]],
  );
  assert.equal(projection.finalItem, null);
});

test("completed turns reserve the last Agent Message as the final result", () => {
  const projection = projectTurn(
    turn("completed", [
      user("user", "request"),
      agent("progress", "Working."),
      command("tool", "npm test"),
      agent("final", "Done."),
    ]),
  );
  assert.equal(projection.finalItem?.id, "final");
  assert.equal(
    projection.history.some(
      (node) => node.kind === "agent" && node.item.id === "final",
    ),
    false,
  );
});

test("terminal turns without a final message get an honest fallback", () => {
  const projection = projectTurn(
    turn("interrupted", [user("user", "request"), command("tool", "sleep 9")]),
  );
  assert.match(projection.terminalFallback ?? "", /interrupted/u);
});

function turn(status: Turn["status"], items: ThreadItem[]): Turn {
  return {
    id: "turn",
    items,
    itemsView: "full",
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1_000,
  };
}

function user(id: string, text: string): ThreadItem {
  return {
    type: "userMessage",
    id,
    clientId: null,
    content: [{ type: "text", text, text_elements: [] }],
  };
}

function agent(id: string, text: string): ThreadItem {
  return {
    type: "agentMessage",
    id,
    text,
    phase: "final_answer",
    memoryCitation: null,
  };
}

function reasoning(id: string, text: string): ThreadItem {
  return { type: "reasoning", id, summary: [text], content: [] };
}

function command(id: string, value: string): ThreadItem {
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
    aggregatedOutput: "ok",
    exitCode: 0,
    durationMs: 10,
  };
}
