import assert from "node:assert/strict";
import test from "node:test";
import type { Thread } from "../src/protocol-client/index.js";
import { projectForkBoundary } from "../src/renderer/src/thread-fork-boundary.js";

const item = (type: string, id: string, turnId?: string) => ({
  type,
  id,
  threadId: "branch",
  createdAt: "2026-11-01",
  ...(turnId ? { turnId } : {}),
});
const start = item("turn_started", "start", "inherited");
const answer = item("agent_message", "answer", "inherited");
const fork = {
  ...item("thread_forked", "fork"),
  sourceThreadId: "source",
  sourceBoundaryItemId: "source-answer",
  workspace: "same-directory",
};
const completion = item("turn_completed", "completion", "inherited");
function thread(
  items: unknown[],
  ids = ["inherited"],
  positions?: Record<string, number>,
): Thread {
  return {
    id: "branch",
    canonicalItems: items,
    turns: ids.map((id) => ({ id })),
    ...(positions
      ? { history: { itemPositions: positions, before: "cursor", preview: "" } }
      : {}),
  } as unknown as Thread;
}

test("exact final fork includes post-marker completion in inherited Turn; untouched and first branch Turn", () => {
  const items = [start, answer, fork, completion];
  const boundary = projectForkBoundary(thread(items));
  assert.equal(boundary?.afterTurnId, "inherited");
  assert.equal(boundary?.item.id, "fork");
  assert.deepEqual(
    projectForkBoundary(
      thread(
        [...items, item("turn_started", "new-start", "new")],
        ["inherited", "new"],
      ),
    ),
    boundary,
  );
});
test("latest-complete and nested forks choose only latest current-thread provenance", () => {
  assert.equal(
    projectForkBoundary(thread([start, answer, completion, fork]))?.afterTurnId,
    "inherited",
  );
  const latest = { ...fork, id: "latest" };
  assert.equal(
    projectForkBoundary(thread([fork, start, answer, latest, completion]))?.item
      .id,
    "latest",
  );
  assert.equal(
    projectForkBoundary(
      thread([start, answer, { ...fork, threadId: "other" }]),
    ),
    null,
  );
});
test("ordinary, legacy and full-context side chat have no divider", () => {
  assert.equal(projectForkBoundary(thread([start, answer])), null);
  assert.equal(projectForkBoundary(thread([fork])), null);
  assert.equal(
    projectForkBoundary(thread([start, answer, { ...fork, context: "full" }])),
    null,
  );
});
test("retained fork marker or older inherited fragment cannot invent loaded boundary; prepend proves it", () => {
  assert.equal(
    projectForkBoundary(
      thread([fork, item("turn_started", "new-start", "new")], ["new"], {
        fork: 8,
        "new-start": 10,
      }),
    ),
    null,
  );
  assert.equal(
    projectForkBoundary(
      thread([start, answer, fork], ["inherited"], {
        start: 1,
        answer: 2,
        fork: 8,
      }),
    ),
    null,
  );
  assert.equal(
    projectForkBoundary(
      thread([start, answer, fork, completion], ["inherited"], {
        start: 6,
        answer: 7,
        fork: 8,
        completion: 9,
      }),
    )?.afterTurnId,
    "inherited",
  );
});

test("prepending pages preserves authoritative positions and current cursor", async () => {
  const { mergeThreadHistoryPages } =
    await import("../src/renderer/src/thread-history-pages.js");
  const current = thread(
    [fork, item("turn_started", "new-start", "new")],
    ["new"],
    { fork: 8, "new-start": 10 },
  );
  const older = thread([start, answer, fork, completion], ["inherited"], {
    start: 6,
    answer: 7,
    fork: 8,
    completion: 9,
  });
  older.history!.before = null;
  const merged = mergeThreadHistoryPages(current, [older]);
  assert.equal(merged.history?.before, current.history?.before);
  assert.equal(merged.history?.itemPositions.start, 6);
  assert.equal(projectForkBoundary(merged)?.afterTurnId, "inherited");
});

test("unclassified rendered Turn suppresses the boundary rather than guessing", () => {
  assert.equal(
    projectForkBoundary(
      thread([start, answer, fork, completion], ["inherited", "missing-start"]),
    ),
    null,
  );
});
