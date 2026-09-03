import type {
  ApprovalDecision,
  ApprovalRequestEvent,
  ApprovalResolvedEvent,
} from "../../main/app-server-manager.js";

export interface ApprovalCardState extends ApprovalRequestEvent {
  status: "pending" | "responding";
  decision: ApprovalDecision | null;
}

export type ApprovalStateEvent =
  | { type: "requested"; event: ApprovalRequestEvent }
  | { type: "resolved"; event: ApprovalResolvedEvent };

export function replacePendingApprovals(
  pending: readonly ApprovalRequestEvent[],
  events: readonly ApprovalStateEvent[] = [],
): ApprovalCardState[] {
  return events.reduce<ApprovalCardState[]>(
    (current, update) =>
      update.type === "requested"
        ? addApprovalRequest(current, update.event)
        : resolveApproval(current, update.event),
    pending.map((event) => ({
      ...event,
      status: "pending",
      decision: null,
    })),
  );
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
  return approvals.filter((approval) => approval.requestId !== event.requestId);
}

export function pendingApprovalThreadIds(
  approvals: readonly ApprovalCardState[],
): Set<string> {
  return new Set(approvals.map((approval) => approval.params.threadId));
}
