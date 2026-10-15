import assert from "node:assert/strict";
import test from "node:test";
import {
  commandPhase,
  commandTask,
} from "../src/renderer/src/tool-presentation.js";
import {
  createTraceObservationIndex,
  observedCommandPhase,
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
  assert.equal(activity.running, 0);
  assert.equal(activity.active, 1);
});
test("declined call receipts retain unresolved task lifetime until terminal proof", () => {
  for (const phase of [
    "running",
    "cancel_requested",
    "cancellation_unconfirmed",
  ] as const) {
    const item = runtimeTask("aborted-call", "same-task", phase, "declined");
    assert.equal(commandPhase(item), phase);
    assert.equal(commandTask(item)?.phase, phase);
    const activity = summarizeTraceActivity([item]);
    assert.equal(activity.active, 1);
    assert.equal(activity.cancelled, 0);
    const terminal = runtimeTask("later-wait", "same-task", "cancelled");
    assert.equal(summarizeTraceActivity([item, terminal]).active, 0);
  }
});
test("completed receipt cannot make a canonical failed or declined call green", () => {
  for (const status of ["failed", "declined"] as const) {
    assert.equal(
      commandPhase(runtimeTask("conflict", "task", "completed", status)),
      status,
    );
  }
});
test("concurrent terminal receipt supersedes a later array-position cancel request", () => {
  const terminal = runtimeTask("wait-finished", "task", "cancelled");
  const request = runtimeTask(
    "terminate-late",
    "task",
    "cancel_requested",
    "declined",
  );
  const items = [terminal, request];
  const index = createTraceObservationIndex(items);
  assert.equal(summarizeTraceActivity(items, index).active, 0);
  assert.equal(observedCommandPhase(request, index), "cancelled");
});
test("whole-turn observation retires stale work across assistant-separated groups and singletons", () => {
  const running = runtimeTask("first", "task", "running");
  const done = runtimeTask("receipt", "task", "completed");
  const items = [
    running,
    runtimeMessage("between", "Partial assistant output"),
    done,
  ];
  const index = createTraceObservationIndex(items);
  assert.equal(summarizeTraceActivity([running], index).active, 0);
  assert.equal(observedCommandPhase(running, index), "completed");
  assert.equal(
    projectTurn(runtimeThread(items).turns[0]!).history.filter(
      (x) => x.kind === "traceItem",
    ).length,
    2,
  );
});
test("canonical successful wait call with running receipt is waiting; parallel task stays running", () => {
  const wait = runtimeWait("wait", "task");
  assert.equal(wait.status, "completed");
  assert.equal(wait.exitCode, 0);
  assert.equal(commandPhase(wait), "waiting");
  const only = summarizeTraceActivity([wait]);
  assert.equal(only.waiting, 1);
  assert.equal(only.running, 0);
  assert.equal(only.phase, "waiting");
  const mixed = summarizeTraceActivity([
    wait,
    runtimeTask("parallel", "other", "running"),
  ]);
  assert.equal(mixed.running, 1);
  assert.equal(mixed.phase, "running");
});
test("shared index and raw item observations give equal retirement and call counts", () => {
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
  const index = createTraceObservationIndex(items);
  assert.deepEqual(
    summarizeTraceActivity(items, index),
    summarizeTraceActivity(items, items),
  );
  assert.deepEqual(
    summarizeTraceActivity([first], index),
    summarizeTraceActivity([first], items),
  );
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
  assert.equal(activity.running, 1);
  assert.equal(
    activity.categories.reduce((n, x) => n + x.count, 0),
    4,
  );
  assert.equal(activity.categories.length, 2);
});
