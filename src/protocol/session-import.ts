import type { StartThreadInput } from "../app-server.js";
import type {
  ThreadImportHistory,
  ThreadImportSource,
} from "../thread-import.js";
import {
  CODEX_ROLLOUT_FORMAT,
  parseCodexRollout,
} from "./codex/rollout-import.js";

export interface SessionImportParams {
  format: string;
  contents: string;
}
export interface SessionImportCommitParams extends SessionImportParams {
  expectedSha256: string;
  configuration: Pick<StartThreadInput, "selection" | "sandbox"> & {
    cwd: string;
  };
}
export interface SessionImportPreview {
  source: ThreadImportSource;
  turns: number;
  messages: number;
  toolCalls: number;
  unconfirmedTurns: number;
  /** Bounded display preview; full history remains in the selected input. */
  excerpt: { role: "user" | "assistant"; text: string }[];
}
export function parseSessionImport(
  params: SessionImportParams,
): ThreadImportHistory {
  if (params.format !== CODEX_ROLLOUT_FORMAT)
    throw new Error("Unsupported session import format.");
  return parseCodexRollout(params.contents);
}
export function previewSessionImport(
  history: ThreadImportHistory,
): SessionImportPreview {
  const items = history.turns.flatMap((turn) => turn.items);
  const messages = items.filter(
    (item) => item.type === "user_message" || item.type === "agent_message",
  );
  return {
    source: history.source,
    turns: history.turns.length,
    messages: messages.length,
    toolCalls: items.filter((item) => item.type === "tool_call").length,
    unconfirmedTurns: history.turns.filter(
      (turn) => turn.status === "interrupted",
    ).length,
    excerpt: messages.slice(0, 6).map((item) => ({
      role: item.type === "user_message" ? "user" : "assistant",
      text: (item.text ?? "").slice(0, 1000),
    })),
  };
}
