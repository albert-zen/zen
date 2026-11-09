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
      item.type === "thread_message_queued" ||
      item.type === "host_message_queued"
    ) {
      if (!queued.has(item.id)) queued.set(item.id, { ...item, revision: 0 });
    } else if (
      (item.type === "user_message" ||
        item.type === "thread_message" ||
        item.type === "host_message") &&
      item.clientId !== undefined
    ) {
      delivered.add(item.clientId);
    } else if (item.type === "user_message_queue_promoted") {
      const prior = queued.get(item.queuedItemId);
      if (
        prior?.type === "user_message_queued" &&
        prior.deliveryMode !== "steer" &&
        prior.threadId === item.threadId &&
        prior.clientId === item.clientId &&
        prior.revision === item.expectedRevision &&
        !delivered.has(prior.clientId) &&
        !cancelled.has(prior.id)
      ) {
        // Promotion time, not the original Queue admission time, orders Steer.
        queued.delete(prior.id);
        queued.set(prior.id, {
          ...prior,
          deliveryMode: "steer",
          expectedTurnId: item.expectedTurnId,
          revision: prior.revision + 1,
        });
      }
    } else if (item.type === "user_message_queue_reordered") {
      const current = [...queued.values()].filter(
        (entry) =>
          !delivered.has(entry.clientId) &&
          !cancelled.has(entry.id) &&
          (entry.type !== "user_message_queued" ||
            entry.deliveryMode !== "steer"),
      );
      const currentIds = new Set(current.map((entry) => entry.id));
      if (
        current.length === item.expectedTargets.length &&
        current.every((entry, index) => {
          const target = item.expectedTargets[index];
          return (
            entry.threadId === item.threadId &&
            target?.queuedItemId === entry.id &&
            target.clientId === entry.clientId &&
            target.expectedRevision === entry.revision
          );
        }) &&
        new Set(item.orderedQueuedItemIds).size === current.length &&
        item.orderedQueuedItemIds.length === current.length &&
        item.orderedQueuedItemIds.every((id) => currentIds.has(id))
      ) {
        const entries = item.orderedQueuedItemIds.map((id) => queued.get(id)!);
        for (const entry of entries) queued.delete(entry.id);
        for (const entry of entries) queued.set(entry.id, entry);
      }
    } else if (item.type === "user_message_steer_recalled") {
      // A malformed/stale batch must never partially hide valid pending input.
      const targets = item.targets.map((target) => {
        const prior = queued.get(target.queuedItemId);
        return prior?.type === "user_message_queued" &&
          prior.deliveryMode === "steer" &&
          prior.threadId === item.threadId &&
          prior.clientId === target.clientId &&
          prior.revision === target.expectedRevision &&
          !delivered.has(prior.clientId) &&
          !cancelled.has(prior.id)
          ? prior
          : undefined;
      });
      if (
        targets.length > 0 &&
        targets.every((target) => target !== undefined) &&
        new Set(targets.map((target) => target?.id)).size === targets.length
      )
        for (const target of targets) cancelled.add(target!.id);
    } else if (
      item.type === "host_message_cancelled" ||
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
        (item.type === "host_message_cancelled") !==
          (prior.type === "host_message_queued") ||
        delivered.has(prior.clientId) ||
        cancelled.has(prior.id)
      )
        continue;
      if (
        item.type === "user_message_queue_cancelled" ||
        item.type === "thread_message_cancelled" ||
        item.type === "host_message_cancelled"
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
