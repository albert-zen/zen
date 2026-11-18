import assert from "node:assert/strict";
import test from "node:test";
import { withRuntimeDom } from "./agent-runtime-dom.js";
import { historyWindowFixture } from "../../../test/thread-history-window-fixture.js";
import { Thread as CoreThread } from "../../../src/thread.js";
import { projectNativeThread } from "../src/renderer/src/thread-view-state.js";
import type { ThreadSnapshot } from "../../../src/app-server.js";

function fixture(branch: boolean, compact = false) {
  const items = historyWindowFixture(2);
  items.splice(4, 0, {
    type: "thread_forked",
    id: "fork",
    threadId: "thread",
    createdAt: "2026-01-01T00:00:00Z",
    sourceThreadId: "source",
    sourceBoundaryItemId: "source-answer",
    workspace: "same-directory",
  });
  if (!branch) items.splice(6);
  const core = new CoreThread("thread", items);
  const turns = core.deriveTurns();
  if (compact)
    items.splice(4, 0, {
      type: "context_compaction",
      id: "compact",
      threadId: "thread",
      createdAt: "2026-01-01T00:00:00Z",
      provenance: "agentic",
      turnId: "turn-0",
      callId: "call",
      sourceModelResponseId: "response",
      coveredThroughItemId: "agent-0",
      summary: "Synthetic historical summary",
      retainedItemIds: [],
      algorithmVersion: "test",
      includeOriginalReference: true,
    });
  return projectNativeThread({
    id: "thread",
    items,
    turns,
    cwd: "/tmp",
    providerProfileId: "fake",
    modelId: "fake",
    model: "fake",
    provider: "fake",
    reasoningEffort: "medium",
    sandbox: "read-only",
    approvalPolicy: "never",
    archived: false,
  } as ThreadSnapshot);
}

test("separator follows inherited final answer, precedes branch prompt, and append preserves inherited DOM", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(fixture(false));
    const separator = document.querySelector(".fork-history-boundary")!;
    assert(separator);
    assert.equal(
      separator.getAttribute("aria-label"),
      "Copied history ends here",
    );
    assert.equal(separator.querySelectorAll("button, a, [tabindex]").length, 0);
    const before = separator.previousElementSibling;
    assert.match(before!.textContent!, /Answer 0/);
    await h.render(fixture(true));
    assert.equal(document.querySelector(".fork-history-boundary"), separator);
    assert.equal(separator.previousElementSibling, before);
    assert.match(separator.nextElementSibling!.textContent!, /User 1/);
    assert.equal(document.querySelectorAll(".fork-history-boundary").length, 1);
  });
});

test("historical compaction stays above the copied-history separator", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(fixture(true, true));
    const separator = document.querySelector(".fork-history-boundary")!;
    assert(
      separator.previousElementSibling!.classList.contains(
        "context-compaction-event",
      ),
    );
    assert.match(separator.nextElementSibling!.textContent!, /User 1/);
  });
});

test("post-fork closure of an earlier aborted Turn stays above the divider before the new branch", async () => {
  const items = historyWindowFixture(3);
  const aborted = items.findIndex((item) => item.id === "end-1");
  items[aborted] = {
    ...items[aborted]!,
    type: "turn_aborted",
    reason: "Stopped",
  } as (typeof items)[number];
  items.splice(aborted, 0, {
    type: "tool_call",
    id: "call",
    turnId: "turn-1",
    threadId: "thread",
    createdAt: "2026-01-01T00:00:00Z",
    callId: "call",
    name: "test",
    arguments: {},
  });
  items.push({
    type: "thread_forked",
    id: "fork",
    threadId: "thread",
    createdAt: "2026-01-01T00:00:00Z",
    sourceThreadId: "source",
    sourceBoundaryItemId: "agent-2",
    workspace: "same-directory",
  });
  items.push({
    type: "tool_result",
    id: "synthetic-result",
    threadId: "thread",
    turnId: "turn-1",
    createdAt: "2026-01-01T00:00:00Z",
    callId: "call",
    contentType: "application/json",
    output: "Snapshot",
    exitCode: 1,
  });
  items.push(
    ...historyWindowFixture(4).filter((item) => item.turnId === "turn-3"),
  );
  const core = new CoreThread("thread", items);
  const view = projectNativeThread({
    id: "thread",
    items,
    turns: core.deriveTurns(),
    cwd: "/tmp",
    providerProfileId: "fake",
    modelId: "fake",
    model: "fake",
    provider: "fake",
    reasoningEffort: "medium",
    sandbox: "read-only",
    approvalPolicy: "never",
    archived: false,
  } as ThreadSnapshot);
  await withRuntimeDom(async (h) => {
    await h.render(view);
    const separator = document.querySelector(".fork-history-boundary")!;
    assert(separator);
    // Existing Turn ordering is unchanged, but every inherited row is above it.
    assert.match(separator.previousElementSibling!.textContent!, /User 1/);
    assert.match(separator.nextElementSibling!.textContent!, /User 3/);
    const siblings = [...separator.parentElement!.children];
    for (const index of [0, 1, 2]) {
      const row = siblings.find((element) =>
        element.textContent?.includes(`User ${index}:`),
      )!;
      assert(siblings.indexOf(row) < siblings.indexOf(separator));
    }
  });
});
