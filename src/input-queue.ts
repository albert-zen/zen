import type { CanonicalItem, QueuedUserMessageItem } from "./item.js";

/** Pending means neither accepted by a user message nor canonically canceled. */
export function pendingQueuedMessages(
  items: readonly CanonicalItem[],
): QueuedUserMessageItem[] {
  const delivered = new Set(
    items.flatMap((item) =>
      item.type === "user_message" && item.clientId !== undefined
        ? [item.clientId]
        : [],
    ),
  );
  const cancelled = new Map(
    items.flatMap((item) =>
      item.type === "user_message_queue_cancelled"
        ? [[item.queuedItemId, item.clientId] as const]
        : [],
    ),
  );
  return items.filter(
    (item): item is QueuedUserMessageItem =>
      item.type === "user_message_queued" &&
      !delivered.has(item.clientId) &&
      cancelled.get(item.id) !== item.clientId,
  );
}
