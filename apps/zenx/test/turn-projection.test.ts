import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem, Turn } from "../src/protocol-client/index.js";
import {
  projectTurn,
  traceDisplayRows,
} from "../src/renderer/src/turn-projection.js";

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
      node.kind === "traceGroup" ? [node.kind, node.items.length] : [node.kind],
    ),
    [["agent"], ["traceGroup", 2], ["agent"], ["traceItem"]],
  );
  assert.equal(projection.finalItem, null);
});

test("projects a singleton trace Item directly and promotes it with stable identity", () => {
  const singleton = projectTurn(
    turn("inProgress", [reasoning("reason-a", "Mapped Items")]),
  ).history[0];
  const grouped = projectTurn(
    turn("inProgress", [
      reasoning("reason-a", "Mapped Items"),
      command("tool-a", "rg files"),
    ]),
  ).history[0];

  assert.deepEqual(singleton, {
    kind: "traceItem",
    id: "reason-a",
    item: reasoning("reason-a", "Mapped Items"),
  });
  assert.equal(grouped?.kind, "traceGroup");
  assert.equal(grouped?.id, "reason-a");
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

test("derives nested trace rows only from canonical call lineage", () => {
  const outer = {
    ...command("outer", "const child = await tools.shell({});"),
    toolName: "run_code",
    callId: "outer-call",
  };
  const child = {
    ...command("child", "printf child"),
    toolName: "shell",
    callId: "child-call",
    parentCallId: "outer-call",
  };
  const orphan = {
    ...command("orphan", "printf orphan"),
    toolName: "shell",
    callId: "orphan-call",
    parentCallId: "missing-call",
  };

  assert.deepEqual(
    traceDisplayRows([outer, child, orphan]).map(
      ({ item, nested, parentToolName }) => [item.id, nested, parentToolName],
    ),
    [
      ["outer", false, null],
      ["child", true, "run_code"],
      ["orphan", false, null],
    ],
  );
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

function command(
  id: string,
  value: string,
): Extract<ThreadItem, { type: "commandExecution" }> {
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
    durationMs: null,
  };
}
