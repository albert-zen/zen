import assert from "node:assert/strict";
import test from "node:test";
import {
  commandPhase,
  commandTask,
} from "../src/renderer/src/tool-presentation.js";
import {
  projectTurn,
  summarizeTraceActivity,
} from "../src/renderer/src/turn-projection.js";
import {
  runtimeCommand,
  runtimeMessage,
  runtimeTask,
  runtimeThread,
  runtimeWait,
} from "./fixtures/agent-runtime-data.js";

test("a raw submitted call is requested rather than successful or proven running", () => {
  assert.equal(
    commandPhase(runtimeCommand("request", "shell", "inProgress")),
    "requested",
  );
  const activity = summarizeTraceActivity([
    runtimeCommand("request", "shell", "inProgress"),
  ]);
  assert.equal("running" in activity, false);
  assert.equal(activity.active, 1);
});
test("declined invocation returns remain complete while their process receipts stay available", () => {
  for (const phase of [
    "running",
    "cancel_requested",
    "cancellation_unconfirmed",
  ] as const) {
    const item = runtimeTask("aborted-call", "same-task", phase, "declined");
    assert.equal(commandPhase(item), "completed");
    assert.equal(commandTask(item)?.phase, phase);
    const activity = summarizeTraceActivity([item]);
    assert.equal(activity.active, 0);
    assert.equal("cancelled" in activity, false);
    const terminal = runtimeTask("later-wait", "same-task", "cancelled");
    assert.equal(summarizeTraceActivity([item, terminal]).active, 0);
  }
});
test("returned failure or decline completes the call without changing its canonical result", () => {
  for (const status of ["failed", "declined"] as const) {
    assert.equal(
      commandPhase(runtimeTask("conflict", "task", "completed", status)),
      "completed",
    );
  }
});
test("concurrent process receipts never reactivate either completed invocation", () => {
  const terminal = runtimeTask("wait-finished", "task", "cancelled");
  const request = runtimeTask(
    "terminate-late",
    "task",
    "cancel_requested",
    "declined",
  );
  const items = [terminal, request];
  assert.equal(summarizeTraceActivity(items).active, 0);
  assert.equal(commandPhase(request), "completed");
});
test("returned calls remain settled in assistant-separated groups and singletons", () => {
  const running = runtimeTask("first", "task", "running");
  const done = runtimeTask("receipt", "task", "completed");
  const items = [
    running,
    runtimeMessage("between", "Partial assistant output"),
    done,
  ];
  assert.equal(summarizeTraceActivity([running]).active, 0);
  assert.equal(commandPhase(running), "completed");
  assert.equal(
    projectTurn(runtimeThread(items).turns[0]!).history.filter(
      (x) => x.kind === "traceItem",
    ).length,
    2,
  );
});
test("canonical successful wait and parallel yielded calls are both settled", () => {
  const wait = runtimeWait("wait", "task");
  assert.equal(wait.status, "completed");
  assert.equal(wait.exitCode, 0);
  assert.equal(commandPhase(wait), "completed");
  const only = summarizeTraceActivity([wait]);
  assert.equal("waiting" in only, false);
  assert.equal("running" in only, false);
  assert.equal(only.phase, "idle");
  const mixed = summarizeTraceActivity([
    wait,
    runtimeTask("parallel", "other", "running"),
  ]);
  assert.equal("running" in mixed, false);
  assert.equal(mixed.phase, "idle");
});
test("call counts remain independent of process identity and receipt order", () => {
  const first = runtimeTask("first", "one", "running");
  const terminal = runtimeTask("terminal", "two", "cancelled");
  const late = runtimeTask("late", "two", "cancel_requested");
  const items = [
    first,
    runtimeMessage("split", "Split trace"),
    terminal,
    late,
    runtimeWait("wait-one", "one"),
  ];
  assert.equal(summarizeTraceActivity(items).active, 0);
  assert.equal(summarizeTraceActivity([...items].reverse()).active, 0);
  assert.equal(summarizeTraceActivity([...items].reverse()).total, 4);
  assert.equal(summarizeTraceActivity([first]).active, 0);
  assert.equal(summarizeTraceActivity(items).total, 4);
});
test("singleton promotion preserves stable trace identity", () => {
  const a = runtimeCommand("stable");
  const first = projectTurn(runtimeThread([a]).turns[0]!).history[0]!;
  const promoted = projectTurn(
    runtimeThread([a, runtimeCommand("next")]).turns[0]!,
  ).history[0]!;
  assert.equal(first.kind, "traceItem");
  assert.equal(promoted.kind, "traceGroup");
  assert.ok("id" in first && "id" in promoted);
  assert.equal(first.id, promoted.id);
});
test("mixed categories count actual calls independently of their outcomes", () => {
  const browser = {
    ...runtimeCommand("browser"),
    toolName: "browser_inspect",
    command: "browser_inspect",
    toolArguments: { tabId: "fixture-tab" },
    aggregatedOutput: "Inspected page headings",
  };
  const items = [
    runtimeCommand("failed", "shell", "failed"),
    runtimeCommand("success"),
    browser,
    runtimeTask("running", "task", "running"),
  ];
  const activity = summarizeTraceActivity(items);
  assert.equal(activity.total, 4);
  assert.equal("failed" in activity, false);
  assert.equal("running" in activity, false);
  assert.equal(
    activity.categories.reduce((n, x) => n + x.count, 0),
    4,
  );
  assert.equal(activity.categories.length, 2);
});
