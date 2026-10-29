import type { BoardOwner } from "../../../packages/zenx-board-plugin/src/board.js";
export type { BoardOwner } from "../../../packages/zenx-board-plugin/src/board.js";

/** First draft intentionally supports only the existing local Shell runtime.
 * API/form requests must be explicit scripts; no arbitrary plugin/control tools.
 */
export interface BoardToolRequest {
  threadId: string;
  /** Host-owned exact conversation scope; never inferred from tool arguments. */
  owner?: BoardOwner;
  tool: "shell";
  arguments: Record<string, unknown>;
}

export function validateBoardOwner(value: unknown): BoardOwner {
  if (!record(value) || !id(value.threadId))
    throw new Error("Board owner requires an exact Thread ID");
  if (
    value.kind === "thread" &&
    Object.keys(value).every((key) => ["kind", "threadId"].includes(key))
  )
    return { kind: "thread", threadId: value.threadId };
  if (
    value.kind === "room" &&
    id(value.roomId) &&
    Object.keys(value).every((key) =>
      ["kind", "roomId", "threadId"].includes(key),
    )
  )
    return { kind: "room", roomId: value.roomId, threadId: value.threadId };
  throw new Error("Board owner is invalid");
}

export function validateBoardToolRequest(value: unknown): BoardToolRequest {
  if (
    !record(value) ||
    !id(value.threadId) ||
    value.tool !== "shell" ||
    !record(value.arguments) ||
    !Object.keys(value).every((key) =>
      ["threadId", "owner", "tool", "arguments"].includes(key),
    )
  )
    throw new Error(
      "Board execution supports only an explicit local shell action",
    );
  if (
    "device" in value.arguments ||
    "target_context" in value.arguments ||
    !json(value.arguments, 0) ||
    JSON.stringify(value.arguments).length > 100_000
  )
    throw new Error("Board shell arguments must be bounded local JSON");
  if (
    value.arguments.timeout_ms !== undefined &&
    (!Number.isSafeInteger(value.arguments.timeout_ms) ||
      Number(value.arguments.timeout_ms) < 1 ||
      Number(value.arguments.timeout_ms) > 86400000)
  )
    throw new Error("Board shell timeout_ms must be from 1 to 86400000");
  const owner =
    value.owner === undefined ? undefined : validateBoardOwner(value.owner);
  if (owner && owner.threadId !== value.threadId)
    throw new Error("Board execution owner must match its exact Thread");
  return {
    threadId: value.threadId,
    ...(owner ? { owner } : {}),
    tool: "shell",
    arguments: structuredClone(value.arguments),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 512;
}
function json(value: unknown, depth: number): boolean {
  if (depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((entry) => json(entry, depth + 1));
  return (
    record(value) &&
    Object.values(value).every((entry) => json(entry, depth + 1))
  );
}
