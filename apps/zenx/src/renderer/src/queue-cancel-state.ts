import type {
  QueuedCancellationResult,
  QueuedCancellationTarget,
} from "../../../../../src/app-server.js";
import type { CanonicalItem } from "../../../../../src/item.js";

/** A one-time authoritative read after an uncertain response, never a retry. */
export function cancellationResultsFromItems(
  items: readonly CanonicalItem[],
  targets: readonly QueuedCancellationTarget[],
): QueuedCancellationResult[] | null {
  const results: QueuedCancellationResult[] = [];
  for (const target of targets) {
    const queued = items.find(
      (item) =>
        item.type === "user_message_queued" &&
        item.id === target.queuedItemId &&
        item.clientId === target.clientId,
    );
    if (queued === undefined) {
      results.push({ ...target, status: "not_found" });
    } else if (
      items.some(
        (item) =>
          item.type === "user_message" && item.clientId === target.clientId,
      )
    ) {
      results.push({ ...target, status: "already_started" });
    } else if (
      items.some(
        (item) =>
          item.type === "user_message_queue_cancelled" &&
          item.queuedItemId === target.queuedItemId &&
          item.clientId === target.clientId,
      )
    ) {
      results.push({ ...target, status: "already_cancelled" });
    } else {
      // The request may not have reached the Host, or may still be in flight.
      // Do not send a second cancellation without a new explicit user action.
      return null;
    }
  }
  return results;
}
