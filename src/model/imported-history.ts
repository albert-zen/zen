import { createHash } from "node:crypto";
import type { ToolCallModelMessage } from "../model.js";

/** Transport-only past-data aliases: no definitions are registered under these names. */
export function historicalToolName(
  call: ToolCallModelMessage["toolCalls"][number],
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        call.imported?.namespace ?? null,
        call.name,
        call.imported?.inputFormat,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  return `history_${call.name.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 20)}_${digest}`;
}
export function historicalCallId(callId: string): string {
  return `history_${createHash("sha256").update(callId).digest("hex").slice(0, 40)}`;
}
