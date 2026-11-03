import { validateBoardOwner, type BoardOwner } from "../board-host.js";
import type { ApprovalDecision } from "./app-server-manager.js";
import type { ApprovalRequest } from "../../../../src/tool.js";

/** Transport-only projection; approval authority remains in AppServerManager. */
export type UserMcpApproval = Omit<ApprovalRequest, "signal">;
export type UserMcpHostEvent =
  | {
      type: "user-mcp/open";
      requestId: string;
      connectionId: string;
      owner: BoardOwner;
    }
  | { type: "user-mcp/check-owner"; requestId: string; connectionId: string }
  | {
      type: "user-mcp/approval";
      requestId: string;
      connectionId: string;
      request: UserMcpApproval;
    }
  | { type: "user-mcp/cancel"; requestId: string; connectionId: string }
  | { type: "user-mcp/close"; connectionId: string };
export type UserMcpHostCommand =
  | {
      type: "user-mcp/result";
      requestId: string;
      decision?: ApprovalDecision;
      error?: string;
    }
  | { type: "user-mcp/revoked"; connectionId: string; error: string };
export function isUserMcpHostCommand(
  value: unknown,
): value is UserMcpHostCommand {
  try {
    return isUserMcpHostCommandUnsafe(value);
  } catch {
    return false;
  }
}
function isUserMcpHostCommandUnsafe(
  value: unknown,
): value is UserMcpHostCommand {
  if (!record(value)) return false;
  return (
    (value.type === "user-mcp/result" &&
      typeof value.requestId === "string" &&
      (value.error === undefined || typeof value.error === "string") &&
      (value.decision === undefined ||
        ["accept", "acceptForSession", "decline", "cancel"].includes(
          String(value.decision),
        ))) ||
    (value.type === "user-mcp/revoked" &&
      typeof value.connectionId === "string" &&
      typeof value.error === "string")
  );
}
export function isUserMcpHostEvent(value: unknown): value is UserMcpHostEvent {
  try {
    return isUserMcpHostEventUnsafe(value);
  } catch {
    return false;
  }
}
function isUserMcpHostEventUnsafe(value: unknown): value is UserMcpHostEvent {
  if (!record(value) || typeof value.connectionId !== "string") return false;
  if (value.type === "user-mcp/close") return true;
  if (typeof value.requestId !== "string") return false;
  if (["user-mcp/check-owner", "user-mcp/cancel"].includes(String(value.type)))
    return true;
  if (value.type === "user-mcp/open") {
    try {
      validateBoardOwner(value.owner);
      return true;
    } catch {
      return false;
    }
  }
  if (value.type !== "user-mcp/approval" || !record(value.request))
    return false;
  const request = value.request;
  return (
    ["threadId", "turnId", "itemId", "callId", "command", "cwd"].every(
      (key) => typeof request[key] === "string",
    ) &&
    (request.toolName === undefined || typeof request.toolName === "string") &&
    (request.toolArguments === undefined || record(request.toolArguments))
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
