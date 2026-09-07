import type { CanonicalItem, QueuedUserMessageItem } from "./item.js";

/** Queue entries are consumed by the canonical user message carrying their client id. */
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
  return items.filter(
    (item): item is QueuedUserMessageItem =>
      item.type === "user_message_queued" && !delivered.has(item.clientId),
  );
}
