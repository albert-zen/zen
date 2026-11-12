import type {
  NativeProjectedThreadEvent,
  NativeThreadRecoverySnapshot,
} from "../../../../../src/protocol/native/recovery.js";
import { isTurnEndItem } from "../../../../../src/turn-end.js";
import type { createConversationReadStore } from "./conversation-read-state.js";

/** Observe current-connection notifications and live resume-barrier events.
 * Never infer a fresh notification from canonical snapshot history.
 * The native handshake proves the epoch; canonical ordinals fence persisted
 * pending reads across windows, reconnects and host restarts.
 */
export function createThreadEndNotificationObserver(
  store: ReturnType<typeof createConversationReadStore>,
  initialize: () => Promise<{ processEpoch: string }>,
) {
  let generation = 0;
  let accepting = false;
  let processEpoch: string | null = null;
  let connecting: Promise<void> | null = null;
  let retryAfterFailure = false;
  const watermarks = new Map<string, number>();
  const buffered = new Map<string, NativeProjectedThreadEvent>();
  const observe = (projected: NativeProjectedThreadEvent) => {
    const event = projected.event;
    if (
      !accepting ||
      !Number.isSafeInteger(projected.watermark) ||
      projected.watermark < 0 ||
      event.type !== "item_completed" ||
      !isTurnEndItem(event.item) ||
      !Number.isSafeInteger(event.turnEndPosition) ||
      event.turnEndPosition! < 0 ||
      event.item.threadId !== projected.threadId
    )
      return;
    if (processEpoch === null) {
      const key = `${projected.processEpoch}\0${projected.threadId}`;
      if ((buffered.get(key)?.watermark ?? -1) < projected.watermark)
        buffered.set(key, projected);
      return;
    }
    if (
      projected.processEpoch !== processEpoch ||
      projected.watermark <= (watermarks.get(projected.threadId) ?? -1)
    )
      return;
    watermarks.set(projected.threadId, projected.watermark);
    store.observeThreadEnd(projected.threadId, {
      id: event.item.id,
      createdAt: Date.parse(event.item.createdAt),
      position: event.turnEndPosition,
    });
  };
  const establish = (): Promise<void> => {
    accepting = true;
    const current = ++generation;
    connecting = Promise.resolve()
      .then(initialize)
      .then((ready) => {
        if (current !== generation) return;
        if (
          !ready ||
          typeof ready.processEpoch !== "string" ||
          !ready.processEpoch
        )
          throw new Error("Missing native process epoch");
        processEpoch = ready.processEpoch;
        const pending = [...buffered.values()];
        buffered.clear();
        for (const event of pending) observe(event);
      })
      .catch((error: unknown) => {
        if (current !== generation) return;
        if (retryAfterFailure) {
          retryAfterFailure = false;
          return establish();
        }
        accepting = false;
        buffered.clear();
        console.warn("Live thread end observations unavailable", error);
      })
      .finally(() => {
        if (current === generation) {
          connecting = null;
          retryAfterFailure = false;
        }
      });
    return connecting;
  };
  return {
    observe,
    recover(threadId: string, snapshot: NativeThreadRecoverySnapshot) {
      if (
        snapshot.threadId !== threadId ||
        snapshot.thread.id !== threadId ||
        !Number.isSafeInteger(snapshot.watermark) ||
        snapshot.watermark < 0
      )
        return;
      for (const projected of snapshot.events) {
        if (
          projected.threadId === threadId &&
          projected.processEpoch === snapshot.processEpoch &&
          projected.watermark <= snapshot.watermark
        )
          observe(projected);
      }
    },
    connect() {
      if (accepting) {
        // A ready signal during an older IPC handshake buys one retry if that
        // handshake fails. A failure by itself never creates a retry loop.
        if (connecting !== null) retryAfterFailure = true;
        return connecting ?? Promise.resolve();
      }
      return establish();
    },
    disconnect() {
      generation++;
      accepting = false;
      processEpoch = null;
      connecting = null;
      retryAfterFailure = false;
      buffered.clear();
      watermarks.clear();
    },
  };
}
