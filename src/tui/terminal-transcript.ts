import type { ThreadSnapshot } from "../product/index.js";
import type { TimelineRow, WebUiState } from "../presentation/index.js";

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
  rows: Iterable<TimelineRow>,
  options: { readonly includeTrace?: boolean } = {}
): readonly string[] {
  return [...rows].flatMap((row) => renderTerminalTimelineRow(row, options));
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

  if (row.type === "shell") {
    return [renderShellTimelineRow(row)];
  }

  if (row.type === "tool-call") {
    if (row.toolName === "shell") {
      return [`Shell: ${readCommand(row.input)}`];
    }

    return [`Tool call ${row.toolName ?? "tool"}: ${stringify(row.input)}`];
  }

  if (row.type === "tool-result") {
    if (row.toolName === "shell") {
      return [`Shell result: ${stringify(row.content)}`];
    }

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

function readCommand(input: unknown): string {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const command = (input as { readonly command?: unknown }).command;

    if (typeof command === "string") {
      return command;
    }
  }

  return stringify(input);
}

function renderShellTimelineRow(
  row: Extract<TimelineRow, { readonly type: "shell" }>
): string {
  const status =
    row.exitCode === undefined
      ? row.status
      : `${row.status} (exit ${row.exitCode})`;
  const details = [
    summarizeStream("stdout", row.stdout),
    summarizeStream("stderr", row.stderr),
    row.error
  ].filter((entry): entry is string => Boolean(entry));

  return [
    `Shell ${status}: ${row.command}`,
    details.length > 0 ? details.join(" | ") : undefined
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(" | ");
}

function summarizeStream(label: "stdout" | "stderr", value: string): string | undefined {
  const rendered = value.replace(/\s+/g, " ").trim();

  return rendered.length > 0 ? `${label}: ${summarize(rendered)}` : undefined;
}

function summarize(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
}
