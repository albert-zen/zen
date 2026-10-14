import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem, Turn } from "../src/protocol-client/index.js";
import {
  groupReasoningWithoutDetailsRows,
  projectTurn,
  traceDisplayRows,
  traceSummary,
  summarizeTraceActivity,
  createTraceObservationIndex,
  observedCommandStatus,
  observedShellNonzeroResult,
} from "../src/renderer/src/turn-projection.js";

test("adjacent reasoning without public details has one honest row, not one per item", () => {
  const privateItem = (id: string) => ({
    ...reasoning(id, ""),
    summary: [],
    content: [],
  });
  const rows = traceDisplayRows([
    privateItem("opaque-a"),
    privateItem("opaque-b"),
    command("tool", "shell"),
    privateItem("opaque-c"),
    { ...privateItem("public"), summary: ["Public summary"] },
    privateItem("opaque-d"),
    privateItem("opaque-e"),
  ]);
  const grouped = groupReasoningWithoutDetailsRows(rows);
  assert.deepEqual(
    grouped.map((row) =>
      "kind" in row
        ? { kind: row.kind, ids: row.ids }
        : { kind: row.item.type, id: row.item.id },
    ),
    [
      { kind: "reasoningWithoutDetailsRun", ids: ["opaque-a", "opaque-b"] },
      { kind: "commandExecution", id: "tool" },
      { kind: "reasoning", id: "opaque-c" },
      { kind: "reasoning", id: "public" },
      { kind: "reasoningWithoutDetailsRun", ids: ["opaque-d", "opaque-e"] },
    ],
  );
});

test("group summary does not claim unfinished tools have been used", () => {
  const pending = {
    ...command("a", "shell"),
    status: "inProgress" as const,
    toolName: "shell",
  };
  const done = {
    ...command("b", "browser_inspect"),
    toolName: "browser_inspect",
  };
  assert.equal(
    traceSummary([reasoning("r", ""), pending]),
    "Run command · requested",
  );
  assert.equal(traceSummary([pending, done]), "Run command");
  assert.equal(traceSummary([done]), "Inspected page");
  const yielded = {
    ...done,
    contentType: "application/vnd.zen.tool-task+json",
    structuredContent: { task_id: "test-task", status: "running" },
  };
  assert.equal(traceSummary([pending, yielded]), "Inspect page");
});

test("thread send and rename summaries report successful actions without redundant completion or target-work claims", () => {
  const sent = {
    ...command("send", "zenx_threads_send"),
    toolName: "zenx_threads_send",
  };
  const renamed = {
    ...command("rename", "zenx_threads_rename"),
    toolName: "zenx_threads_rename",
  };
  assert.equal(traceSummary([sent]), "Sent message");
  assert.equal(traceSummary([renamed]), "Renamed thread");
  assert.equal(
    traceSummary([sent, renamed]),
    "2 tool calls · Renamed thread · Sent message",
  );
  assert.equal(
    traceSummary([sent, { ...renamed, status: "failed" }]),
    "2 tool calls · Rename thread · failed · Sent message",
  );
});

test("grouped task receipts preserve the same wait and terminal phases as their rows", () => {
  const wait = {
    ...command("wait-item", "wait"),
    toolName: "wait",
    contentType: "application/vnd.zen.tool-task+json",
    structuredContent: { task_id: "test-task", status: "running" },
  };
  const cases = [
    [wait, "Waiting for task"],
    [
      {
        ...wait,
        structuredContent: { task_id: "test-task", status: "timed_out" },
      },
      "Wait · timed out",
    ],
    [
      {
        ...wait,
        status: "declined" as const,
        contentType: undefined,
        structuredContent: undefined,
      },
      "Wait · declined",
    ],
  ] as const;
  for (const [item, label] of cases) {
    const grouped = projectTurn(turn("completed", [reasoning("r", ""), item]))
      .history[0];
    assert.equal(grouped?.kind, "traceGroup");
    if (grouped?.kind !== "traceGroup") continue;
    assert.equal(grouped.summary, label);
    assert.equal(traceSummary(grouped.items), label);
  }
});

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
  assert.equal(projection.inputItems.length, 1);
  assert.deepEqual(
    projection.history.map((node) =>
      node.kind === "traceGroup" ? [node.kind, node.items.length] : [node.kind],
    ),
    [["agent"], ["traceGroup", 2], ["agent"], ["traceItem"]],
  );
  assert.equal(projection.finalItem, null);
});

test("places a steered user message after its delivery anchor", () => {
  const projection = projectTurn(
    turn("completed", [
      user("request", "initial request"),
      user("steer", "apply this correction", "tool-a"),
      agent("progress", "Checking the code."),
      command("tool-a", "rg deliveryAfter"),
      agent("after-steer", "Applied the correction."),
      agent("final", "Done."),
    ]),
  );

  assert.deepEqual(
    projection.inputItems.map((item) => item.id),
    ["request"],
  );
  assert.deepEqual(
    projection.history.map((node) =>
      node.kind === "agent" ? [node.kind, node.item.id] : [node.kind, node.id],
    ),
    [
      ["agent", "progress"],
      ["traceItem", "tool-a"],
      ["input", "steer"],
      ["agent", "after-steer"],
    ],
  );
  assert.equal(projection.finalItem?.id, "final");
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

function user(id: string, text: string, deliveryAfter?: string): ThreadItem {
  return {
    type: "userMessage",
    id,
    clientId: null,
    content: [{ type: "text", text, text_elements: [] }],
    ...(deliveryAfter === undefined ? {} : { deliveryAfter }),
  } as ThreadItem;
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

function reasoning(
  id: string,
  text: string,
): Extract<ThreadItem, { type: "reasoning" }> {
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

test("failed turns retain prior text and reasoning as history alongside the error", () => {
  const failed = turn("failed", [
    reasoning("trace", "Thinking"),
    agent("partial", "Already received"),
  ]);
  failed.error = {
    message: "invalid tool call id",
    codexErrorInfo: null,
    additionalDetails: null,
  };
  const projection = projectTurn(failed);
  assert.equal(projection.finalItem, null);
  assert.deepEqual(
    projection.history.map((node) => node.kind),
    ["traceItem", "agent"],
  );
  assert.equal(projection.terminalFallback, "invalid tool call id");
});

test("collapsed trace counts all calls without hiding earlier failures", () => {
  const items = ["one", "two", "three", "four"].map((value) => ({
    ...command(value, `echo ${value}`),
    toolName: "shell",
    toolArguments: { command: `echo ${value}` },
  }));
  assert.equal(
    traceSummary([reasoning("r", ""), ...items]),
    "4 tool calls · Ran · echo four · Ran · echo three · Ran · echo two",
  );
  const activity = summarizeTraceActivity([
    { ...items[0]!, status: "failed" },
    ...items.slice(1),
  ]);
  assert.equal(activity.total, 4);
  assert.equal(activity.failed, 1);
});

test("shell nonzero warnings are counted separately while actual failure phases stay intact", () => {
  const shell = {
    ...command("nonzero", "grep absent file"),
    toolName: "shell",
    status: "failed" as const,
    exitCode: 1,
  };
  const task = {
    ...shell,
    id: "timeout",
    contentType: "application/vnd.zen.tool-task+json",
    structuredContent: {
      task_id: "timeout",
      tool_name: "shell",
      status: "timed_out",
      exit_code: 124,
    },
    exitCode: 124,
  };
  const other = { ...shell, id: "other", toolName: "other_tool" };
  const cancelled = {
    ...task,
    id: "cancel",
    structuredContent: {
      ...task.structuredContent,
      task_id: "cancel",
      status: "cancelled",
      exit_code: 130,
    },
    exitCode: 130,
  };
  const activity = summarizeTraceActivity([shell, task, other, cancelled]);
  assert.equal(activity.total, 4);
  assert.equal(activity.shellNonzero, 1);
  assert.equal(activity.failed, 2);
  assert.equal(activity.cancelled, 1);
  assert.equal(activity.active, 0);
  assert.match(traceSummary([shell]), /shell returned a nonzero status/);
});

test("later nonzero observation updates earlier shell summaries without changing items or double-counting", () => {
  const early = {
    ...command("early", "grep absent file"),
    toolName: "shell",
    contentType: "application/vnd.zen.tool-task+json",
    structuredContent: {
      task_id: "shared",
      tool_name: "shell",
      status: "running",
      exit_code: null,
    },
  };
  const final = {
    ...early,
    id: "final",
    toolName: "wait",
    status: "failed" as const,
    exitCode: 1,
    structuredContent: {
      ...early.structuredContent,
      status: "failed",
      exit_code: 1,
    },
  };
  const items = [early, final];
  const before = structuredClone(items);
  assert.match(traceSummary([early], items), /shell returned a nonzero status/);
  assert.doesNotMatch(traceSummary(items), /failed/i);
  assert.equal(summarizeTraceActivity(items).shellNonzero, 1);
  assert.equal(summarizeTraceActivity(items).failed, 0);
  assert.equal(summarizeTraceActivity([early], items).shellNonzero, 0);
  assert.deepEqual(items, before);
});

test("observed nonzero facts cannot override signals, cancellation, other tools or a newer terminal outcome", () => {
  const early = {
    ...command("early", "grep absent file"),
    toolName: "shell",
    contentType: "application/vnd.zen.tool-task+json",
    structuredContent: {
      task_id: "shared",
      tool_name: "shell",
      status: "running",
      exit_code: null,
    },
  };
  const final = {
    ...early,
    id: "final",
    toolName: "wait",
    status: "failed" as const,
    exitCode: 1,
    structuredContent: {
      ...early.structuredContent,
      status: "failed",
      exit_code: 1,
    },
  };
  for (const [patch, label] of [
    [{ status: "timed_out" }, "Timed out"],
    [{ status: "cancelled" }, "Cancelled"],
    [{ foreground_signal: "SIGTERM" }, "Failed"],
    [{ tool_name: "other_tool" }, "Failed"],
  ] as const) {
    const index = createTraceObservationIndex([
      early,
      { ...final, structuredContent: { ...final.structuredContent, ...patch } },
    ]);
    assert.equal(observedShellNonzeroResult(early, index), false);
    assert.equal(observedCommandStatus(early, index), label);
  }
  const lateRunning = { ...early, id: "late-running" };
  const index = createTraceObservationIndex([early, final, lateRunning]);
  assert.equal(observedShellNonzeroResult(early, index), true);
  assert.equal(observedShellNonzeroResult(lateRunning, index), true);
});
