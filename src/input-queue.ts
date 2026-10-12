import type { CanonicalItem, QueuedUserMessageItem } from "./item.js";

/** Disposable canonical projection; the initial Item remains the queue anchor. */
export interface PendingQueuedUserMessage extends QueuedUserMessageItem {
  revision: number;
}

/** Pending means neither accepted by a user message nor canonically canceled. */
export function pendingQueuedMessages(
  items: readonly CanonicalItem[],
): PendingQueuedUserMessage[] {
  const queued = new Map<string, PendingQueuedUserMessage>();
  const delivered = new Set<string>();
  const cancelled = new Set<string>();
  for (const item of items) {
    if (item.type === "user_message_queued") {
      if (!queued.has(item.id)) queued.set(item.id, { ...item, revision: 0 });
    } else if (item.type === "user_message" && item.clientId !== undefined) {
      delivered.add(item.clientId);
    } else if (
      item.type === "user_message_queue_cancelled" ||
      item.type === "user_message_queue_edited"
    ) {
      const prior = queued.get(item.queuedItemId);
      if (
        prior === undefined ||
        prior.threadId !== item.threadId ||
        prior.clientId !== item.clientId ||
        delivered.has(prior.clientId) ||
        cancelled.has(prior.id)
      )
        continue;
      if (item.type === "user_message_queue_cancelled") cancelled.add(prior.id);
      else if (item.revision === prior.revision + 1) {
        queued.set(prior.id, {
          ...prior,
          revision: item.revision,
          input: item.input,
        });
      }
    }
  }
  return [...queued.values()].filter(
    (item) => !delivered.has(item.clientId) && !cancelled.has(item.id),
  );
}
