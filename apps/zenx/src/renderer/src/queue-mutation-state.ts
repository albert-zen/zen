import type { CanonicalItem } from "../../../../../src/item.js";
import type {
  NativeQueueSteerParams,
  NativeQueueSteerResult,
  NativeQueueReorderParams,
  NativeQueueReorderResult,
} from "../../../../../src/protocol/native/wire.js";

export class QueueMutationUnknownError extends Error {}

export type QueueMutationPhase =
  "pending" | "checking" | "unknown" | "confirmed";

export type QueueMutationSession = {
  phase: QueueMutationPhase;
  error?: string;
  detail?: string;
} & (
  | {
      kind: "steer";
      params: NativeQueueSteerParams;
      result?: NativeQueueSteerResult;
    }
  | {
      kind: "reorder";
      params: NativeQueueReorderParams;
      result?: NativeQueueReorderResult;
    }
);

/** App-owned transport feedback only. Canonical queue facts remain the sole authority. */
export function createQueueMutationStore() {
  let snapshot: Readonly<Record<string, QueueMutationSession>> = {};
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(threadId: string, session: QueueMutationSession | null) {
      const next = { ...snapshot };
      if (session === null) delete next[threadId];
      else next[threadId] = session;
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}
export type QueueMutationStore = ReturnType<typeof createQueueMutationStore>;

export function queuedSteerReceipt(
  params: NativeQueueSteerParams,
  items: readonly CanonicalItem[],
): NativeQueueSteerResult | null {
  const promotion = items.find(
    (item) =>
      item.type === "user_message_queue_promoted" &&
      item.threadId === params.threadId &&
      item.queuedItemId === params.queuedItemId &&
      item.clientId === params.clientId &&
      item.expectedRevision === params.expectedRevision,
  );
  if (promotion?.type === "user_message_queue_promoted")
    return {
      queuedItemId: params.queuedItemId,
      clientId: params.clientId,
      status: "staged",
      turnId: promotion.expectedTurnId,
      revision: promotion.expectedRevision + 1,
      promotionItemId: promotion.id,
    };
  const original = items.find(
    (item) =>
      [
        "user_message_queued",
        "thread_message_queued",
        "host_message_queued",
      ].includes(item.type) &&
      item.threadId === params.threadId &&
      item.id === params.queuedItemId &&
      "clientId" in item &&
      item.clientId === params.clientId,
  );
  const delivered =
    original &&
    items.find(
      (item) =>
        ["user_message", "thread_message", "host_message"].includes(
          item.type,
        ) &&
        `${item.type}_queued` === original.type &&
        item.threadId === params.threadId &&
        "clientId" in item &&
        item.clientId === params.clientId,
    );
  if (
    delivered &&
    typeof delivered.turnId === "string" &&
    delivered.turnId.trim()
  )
    return {
      queuedItemId: params.queuedItemId,
      clientId: params.clientId,
      status: "already_started",
      turnId: delivered.turnId,
    };
  return null;
}

export function queuedReorderReceipt(
  params: NativeQueueReorderParams,
  items: readonly CanonicalItem[],
): NativeQueueReorderResult | null {
  const receipt = items.find(
    (item) =>
      item.type === "user_message_queue_reordered" &&
      item.threadId === params.threadId &&
      item.reorderId === params.reorderId &&
      item.expectedTargets.length === params.expectedTargets.length &&
      item.expectedTargets.every((target, index) => {
        const expected = params.expectedTargets[index];
        return (
          expected !== undefined &&
          target.queuedItemId === expected.queuedItemId &&
          target.clientId === expected.clientId &&
          target.expectedRevision === expected.expectedRevision
        );
      }) &&
      JSON.stringify(item.orderedQueuedItemIds) ===
        JSON.stringify(params.orderedQueuedItemIds),
  );
  return receipt
    ? { status: "already_reordered", reorderItemId: receipt.id }
    : null;
}

export function queueMutationObserved(
  session: QueueMutationSession,
  items: readonly CanonicalItem[],
): boolean {
  return session.kind === "steer"
    ? queuedSteerReceipt(session.params, items) !== null
    : queuedReorderReceipt(session.params, items) !== null;
}
