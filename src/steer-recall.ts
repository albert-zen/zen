import type {
  CanonicalItem,
  QueuedUserMessageItem,
  SteerRecallTarget,
  SteerRecalledItem,
} from "./item.js";
import {
  pendingQueuedMessages,
  type PendingQueuedInput,
} from "./input-queue.js";

export type PendingSteerInput = PendingQueuedInput &
  QueuedUserMessageItem & {
    deliveryMode: "steer";
    expectedTurnId: string;
  };

/** Derived only; an ended/missing live Turn leaves input held, never scheduled. */
export function pendingSteerMessages(
  items: readonly CanonicalItem[],
): PendingSteerInput[] {
  return pendingQueuedMessages(items).filter(
    (item): item is PendingSteerInput =>
      item.type === "user_message_queued" &&
      item.deliveryMode === "steer" &&
      typeof item.expectedTurnId === "string" &&
      item.expectedTurnId.length > 0,
  );
}

/** Idempotency compares exact identities/revisions, not mutable UI row order. */
export function sameSteerRecallTargets(
  left: readonly SteerRecallTarget[],
  right: readonly SteerRecallTarget[],
): boolean {
  if (left.length !== right.length) return false;
  const byId = new Map(left.map((target) => [target.queuedItemId, target]));
  if (byId.size !== left.length) return false;
  const seen = new Set<string>();
  return right.every((target) => {
    const prior = byId.get(target.queuedItemId);
    if (seen.has(target.queuedItemId)) return false;
    seen.add(target.queuedItemId);
    return (
      prior !== undefined &&
      prior.clientId === target.clientId &&
      prior.expectedRevision === target.expectedRevision
    );
  });
}

export interface RecoveredSteerRecall {
  receipt: SteerRecalledItem;
  /** Original admission order and exact pre-recall revisions, not later edits. */
  messages: readonly PendingSteerInput[];
}

/** Recover from existing immutable facts; never manufacture replacement input. */
export function recoverSteerRecall(
  items: readonly CanonicalItem[],
  threadId: string,
  recallId: string,
): RecoveredSteerRecall | undefined {
  const index = items.findIndex(
    (item) =>
      item.type === "user_message_steer_recalled" &&
      item.threadId === threadId &&
      item.recallId === recallId,
  );
  if (index < 0) return undefined;
  const receipt = items[index];
  if (receipt?.type !== "user_message_steer_recalled") return undefined;
  const pending = pendingSteerMessages(items.slice(0, index)).filter(
    (item) => item.threadId === threadId,
  );
  const targets = new Map(
    receipt.targets.map((target) => [target.queuedItemId, target]),
  );
  if (targets.size !== receipt.targets.length || targets.size === 0)
    return undefined;
  const messages = pending.filter((item) => targets.has(item.id));
  if (
    messages.length !== targets.size ||
    messages.some((item) => {
      const target = targets.get(item.id)!;
      return (
        target.clientId !== item.clientId ||
        target.expectedRevision !== item.revision
      );
    })
  )
    return undefined;
  return { receipt, messages };
}

/** Held steer never schedules work or blocks the explicit next-Turn queue. */
export function pendingNextTurnMessages(
  items: readonly CanonicalItem[],
): PendingQueuedInput[] {
  return pendingQueuedMessages(items).filter(
    (item) =>
      item.type !== "user_message_queued" || item.deliveryMode !== "steer",
  );
}
