import { describe, expect, it } from "vitest";

import {
  renderSlashCommandHelp,
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
    [{ type: "tool-call", toolName: "shell", input: { command: "npm test" } }, "Shell: npm test"],
    [{ type: "tool-result", toolName: "demo", content: "ok" }, "Tool result demo: ok"],
    [
      { type: "tool-result", toolName: "shell", content: "exitCode: 0\nstdout:\nok" },
      "Shell result: exitCode: 0\nstdout:\nok"
    ],
    [
      {
        type: "shell",
        command: "npm test",
        status: "completed",
        exitCode: 0,
        stdout: "ok\n",
        stderr: ""
      },
      "Shell completed (exit 0): npm test | stdout: ok"
    ],
    [
      {
        type: "shell",
        command: "npm test",
        status: "running",
        stdout: "running tests\n",
        stderr: "warning\n"
      },
      "Shell running: npm test | stdout: running tests | stderr: warning"
    ],
    [
      {
        type: "shell",
        command: "npm test",
        status: "failed",
        exitCode: 7,
        stdout: "",
        stderr: "bad\n"
      },
      "Shell failed (exit 7): npm test | stderr: bad"
    ],
    [
      {
        type: "shell",
        command: "npm test",
        status: "interrupted",
        stdout: "",
        stderr: "",
        error: "Shell command canceled"
      },
      "Shell interrupted: npm test | Shell command canceled"
    ],
    [{ type: "tool-error", toolName: "demo", message: "bad" }, "Tool error demo: bad"],
    [{ type: "approval-pending", reason: "Run?" }, "Approval pending: Run?"],
    [{ type: "approval-resolved", decision: "approveOnce" }, "Approval resolved: approveOnce"]
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

describe("slash command help", () => {
  it("includes interactive TUI commands", () => {
    expect(renderSlashCommandHelp()).toContain(
      "/resume [query|number|thread-id]"
    );
    expect(renderSlashCommandHelp()).toContain("/interrupt");
    expect(renderSlashCommandHelp()).toContain("/tools");
  });
});
