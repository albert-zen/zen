import { describe, expect, it } from "vitest";

import {
  renderTerminalStatus,
  renderTerminalTimelineRow,
  type TimelineRow,
  type WebUiState
} from "../src/index.js";

describe("terminal transcript", () => {
  it("renders status from projected state", () => {
    const state: WebUiState = {
      currentThread: {
        id: "thread-1",
        status: "idle",
        turns: [{ id: "turn-1", runId: "run-1", status: "completed", itemIds: [] }]
      },
      items: [],
      timelineRows: []
    };

    expect(renderTerminalStatus(state)).toBe(
      "thread: thread-1 | status: idle | turns: 1 | items: 0"
    );
  });

  it.each([
    [{ type: "user", content: "hello" }, "You: hello"],
    [{ type: "assistant", content: "hi" }, "Zen: hi"],
    [{ type: "assistant-progress", content: "draft" }, "Zen: draft"],
    [{ type: "tool-call", toolName: "demo", input: { q: "x" } }, 'Tool call demo: {"q":"x"}'],
    [{ type: "tool-result", toolName: "demo", content: "ok" }, "Tool result demo: ok"],
    [{ type: "tool-error", toolName: "demo", message: "bad" }, "Tool error demo: bad"],
    [{ type: "approval-pending", reason: "Run?" }, "Approval pending: Run?"],
    [{ type: "approval-resolved", decision: "approve" }, "Approval resolved: approve"]
  ] as const)("renders a %s row", (partial, expected) => {
    const row = {
      itemId: "item-1",
      seq: 1,
      turnId: "turn-1",
      ...partial
    } as TimelineRow;

    expect(renderTerminalTimelineRow(row)).toEqual([expected]);
  });
});
