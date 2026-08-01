import type {
  ApprovalDecision,
  ApprovalRequestEvent,
  ApprovalResolvedEvent,
} from "../../main/app-server-manager.js";

export interface ApprovalCardState extends ApprovalRequestEvent {
  status: "pending" | "responding" | "resolved";
  decision: ApprovalDecision | null;
}

export function addApprovalRequest(
  approvals: readonly ApprovalCardState[],
  event: ApprovalRequestEvent,
): ApprovalCardState[] {
  if (approvals.some((approval) => approval.requestId === event.requestId)) {
    return [...approvals];
  }
  return [...approvals, { ...event, status: "pending", decision: null }];
}

export function markApprovalResponding(
  approvals: readonly ApprovalCardState[],
  requestId: string,
  decision: ApprovalDecision,
): ApprovalCardState[] {
  return approvals.map((approval) =>
    approval.requestId === requestId && approval.status === "pending"
      ? { ...approval, status: "responding", decision }
      : approval,
  );
}

export function restoreApprovalPending(
  approvals: readonly ApprovalCardState[],
  requestId: string,
): ApprovalCardState[] {
  return approvals.map((approval) =>
    approval.requestId === requestId && approval.status === "responding"
      ? { ...approval, status: "pending", decision: null }
      : approval,
  );
}

export function resolveApproval(
  approvals: readonly ApprovalCardState[],
  event: ApprovalResolvedEvent,
): ApprovalCardState[] {
  return approvals.map((approval) =>
    approval.requestId === event.requestId
      ? {
          ...approval,
          status: "resolved",
          decision: event.decision,
        }
      : approval,
  );
}

export function pendingApprovalThreadIds(
  approvals: readonly ApprovalCardState[],
): Set<string> {
  return new Set(
    approvals
      .filter((approval) => approval.status !== "resolved")
      .map((approval) => approval.params.threadId),
  );
}
