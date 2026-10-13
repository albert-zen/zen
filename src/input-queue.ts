import type { CanonicalItem, QueuedInputItem } from "./item.js";

/** Disposable canonical projection; the initial Item remains the queue anchor. */
export type PendingQueuedInput = QueuedInputItem & { revision: number };
/** Compatibility alias; pending input can now preserve an Agent sender. */
export type PendingQueuedUserMessage = PendingQueuedInput;

/** Pending means neither accepted by a canonical input nor canonically canceled. */
export function pendingQueuedMessages(
  items: readonly CanonicalItem[],
): PendingQueuedInput[] {
  const queued = new Map<string, PendingQueuedInput>();
  const delivered = new Set<string>();
  const cancelled = new Set<string>();
  for (const item of items) {
    if (
      item.type === "user_message_queued" ||
      item.type === "thread_message_queued"
    ) {
      if (!queued.has(item.id)) queued.set(item.id, { ...item, revision: 0 });
    } else if (
      (item.type === "user_message" || item.type === "thread_message") &&
      item.clientId !== undefined
    ) {
      delivered.add(item.clientId);
    } else if (
      item.type === "thread_message_cancelled" ||
      item.type === "user_message_queue_cancelled" ||
      item.type === "user_message_queue_edited"
    ) {
      const prior = queued.get(item.queuedItemId);
      if (
        prior === undefined ||
        prior.threadId !== item.threadId ||
        prior.clientId !== item.clientId ||
        (item.type === "thread_message_cancelled") !==
          (prior.type === "thread_message_queued") ||
        delivered.has(prior.clientId) ||
        cancelled.has(prior.id)
      )
        continue;
      if (
        item.type === "user_message_queue_cancelled" ||
        item.type === "thread_message_cancelled"
      )
        cancelled.add(prior.id);
      else if (
        prior.type === "user_message_queued" &&
        item.revision === prior.revision + 1
      ) {
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
