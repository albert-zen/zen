import type { ThreadSnapshot } from "./app-server-protocol.js";
import type { TimelineRow, WebUiState } from "./web-ui-state.js";

export function renderTerminalStatus(state: WebUiState): string {
  const thread = state.currentThread;

  if (!thread) {
    return "thread: not started";
  }

  return [
    `thread: ${thread.id}`,
    `status: ${thread.status}`,
    `turns: ${thread.turns.length}`,
    `items: ${state.items.length}`
  ].join(" | ");
}

export function renderTerminalTranscript(
  rows: readonly TimelineRow[],
  options: { readonly includeTrace?: boolean } = {}
): readonly string[] {
  return rows.flatMap((row) => renderTerminalTimelineRow(row, options));
}

export function renderTerminalTimelineRow(
  row: TimelineRow,
  options: { readonly includeTrace?: boolean } = {}
): readonly string[] {
  if (row.type === "user") {
    return [`You: ${stringify(row.content)}`];
  }

  if (row.type === "assistant" || row.type === "assistant-progress") {
    return [`Zen: ${stringify(row.content)}`];
  }

  if (row.type === "tool-call") {
    return [`Tool call ${row.toolName ?? "tool"}: ${stringify(row.input)}`];
  }

  if (row.type === "tool-result") {
    return [`Tool result ${row.toolName ?? "tool"}: ${stringify(row.content)}`];
  }

  if (row.type === "tool-error") {
    return [`Tool error ${row.toolName ?? "tool"}: ${row.message ?? "failed"}`];
  }

  if (row.type === "approval-pending") {
    return [`Approval pending: ${row.reason ?? row.approvalId ?? "approval requested"}`];
  }

  if (row.type === "approval-resolved") {
    return [`Approval resolved: ${row.decision ?? "resolved"}`];
  }

  return options.includeTrace ? [`Trace ${row.event}`] : [];
}

export function renderThreadStarted(thread: Pick<ThreadSnapshot, "id" | "status">): string {
  return `Started ${thread.id} (${thread.status})`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  return JSON.stringify(value);
}
