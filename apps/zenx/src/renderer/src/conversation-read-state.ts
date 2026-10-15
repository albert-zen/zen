import {
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";

export const CONVERSATION_READ_KEY = "zenx.conversation-read.v1";
export interface ReadCursor {
  id: string;
  createdAt: number;
  /** Canonical end ordinal for thread ends; Rooms keep their own order. */
  position?: number;
}
export interface ConversationReadPreference {
  baseline: number;
  /** Thread cursors now acknowledge execution ends, independently of Rooms. */
  threadEndBaseline: number;
  threads: Record<string, ReadCursor>;
  /** One live, not-yet-viewed canonical end per Thread; never a history snapshot. */
  pendingThreadEnds: Record<string, ReadCursor>;
  rooms: Record<string, ReadCursor>;
}
type Scope = "threads" | "rooms";
type StoragePort = Pick<Storage, "getItem" | "setItem">;

function cursor(value: unknown): value is ReadCursor {
  if (!value || typeof value !== "object") return false;
  const entry = value as ReadCursor;
  return (
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    entry.id.length <= 512 &&
    Number.isFinite(entry.createdAt) &&
    (entry.position === undefined ||
      (Number.isSafeInteger(entry.position) && entry.position >= 0))
  );
}
function parse(
  raw: string | null,
  now: number,
): ConversationReadPreference | null {
  try {
    const value = JSON.parse(
      raw ?? "null",
    ) as ConversationReadPreference | null;
    if (!value || !Number.isFinite(value.baseline)) return null;
    for (const scope of ["threads", "rooms"] as const) {
      if (
        !value[scope] ||
        typeof value[scope] !== "object" ||
        Array.isArray(value[scope]) ||
        !Object.values(value[scope]).every(cursor)
      )
        return null;
    }
    value.pendingThreadEnds ??= {};
    if (
      !value.pendingThreadEnds ||
      typeof value.pendingThreadEnds !== "object" ||
      Array.isArray(value.pendingThreadEnds) ||
      !Object.values(value.pendingThreadEnds).every(
        (entry) => cursor(entry) && entry.position !== undefined,
      )
    )
      return null;
    if (value.threadEndBaseline === undefined) {
      // Old thread cursors identified Agent messages, not execution ends. Do
      // not relight old history on upgrade or change Room read semantics.
      return { ...value, threadEndBaseline: now, threads: {} };
    }
    return Number.isFinite(value.threadEndBaseline) ? value : null;
  } catch {
    return null;
  }
}

/** UI preferences only: no transcript, delivery receipt or Core mutation. */
export function createConversationReadStore(
  storage: StoragePort | null,
  now = Date.now(),
) {
  const listeners = new Set<() => void>();
  const read = () => {
    try {
      return parse(storage?.getItem(CONVERSATION_READ_KEY) ?? null, now);
    } catch {
      return null;
    }
  };
  let state = read() ?? {
    baseline: now,
    threadEndBaseline: now,
    threads: {},
    pendingThreadEnds: {},
    rooms: {},
  };
  const persist = () => {
    try {
      storage?.setItem(CONVERSATION_READ_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn(
        "Conversation read preference is available only for this window",
        error,
      );
    }
  };
  persist();
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reload: () => {
      const next = read();
      if (next && JSON.stringify(next) !== JSON.stringify(state)) {
        state = next;
        listeners.forEach((listener) => listener());
      }
    },
    observeThreadEnd: (id: string, next: ReadCursor) => {
      if (!cursor(next) || next.position === undefined) return;
      const latest = read() ?? state;
      if (
        (latest.threads[id]?.position ?? -1) >= next.position ||
        (latest.pendingThreadEnds[id]?.position ?? -1) >= next.position
      )
        return;
      state = {
        ...latest,
        pendingThreadEnds: { ...latest.pendingThreadEnds, [id]: next },
      };
      persist();
      listeners.forEach((listener) => listener());
    },
    advance: (
      scope: Scope,
      id: string,
      next: ReadCursor,
      messageOrder?: readonly string[],
    ) => {
      if (!cursor(next) || state[scope][id]?.id === next.id) return;
      const latest = read() ?? state;
      const previous = latest[scope][id];
      if (previous) {
        if (previous.id === next.id) return;
        if (scope === "threads") {
          // The host clock can move backwards. Canonical end ordinals
          // (or explicit canonical order) are the only proof of read progress.
          if (previous.position !== undefined && next.position !== undefined) {
            if (next.position <= previous.position) return;
          } else {
            const before = messageOrder?.indexOf(previous.id) ?? -1;
            const after = messageOrder?.indexOf(next.id) ?? -1;
            if (before < 0 || after <= before) return;
          }
        } else {
          if (previous.createdAt > next.createdAt) return;
          if (previous.createdAt === next.createdAt) {
            const before = messageOrder?.indexOf(previous.id) ?? -1;
            const after = messageOrder?.indexOf(next.id) ?? -1;
            if (before < 0 || after <= before) return;
          }
        }
      }
      let pendingThreadEnds = latest.pendingThreadEnds;
      if (
        scope === "threads" &&
        next.position !== undefined &&
        pendingThreadEnds[id]?.position !== undefined &&
        pendingThreadEnds[id]!.position! <= next.position
      ) {
        pendingThreadEnds = { ...pendingThreadEnds };
        delete pendingThreadEnds[id];
      }
      state = {
        ...latest,
        pendingThreadEnds,
        [scope]: { ...latest[scope], [id]: next },
      };
      persist();
      listeners.forEach((listener) => listener());
    },
  };
}
type ReadStore = ReturnType<typeof createConversationReadStore>;
const stores = new WeakMap<Window, ReadStore>();
const serverStore = createConversationReadStore(null);
export function conversationReadStore(): ReadStore {
  if (typeof window === "undefined") return serverStore;
  let store = stores.get(window);
  if (!store) {
    let storage: StoragePort | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* Session-only preference. */
    }
    store = createConversationReadStore(storage);
    stores.set(window, store);
    const current = store;
    window.addEventListener("storage", (event) => {
      if (event.key === CONVERSATION_READ_KEY || event.key === null)
        current.reload();
    });
  }
  return store;
}
export function useConversationReadPreference() {
  const store = conversationReadStore();
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
export function unreadThreadIds(
  summaries: readonly NativeThreadSummary[],
  preference: ConversationReadPreference,
): ReadonlySet<string> {
  return new Set(
    summaries.flatMap((summary) => {
      if (summary.status !== "idle" || !summary.lastTurnEnd) return [];
      const message = summary.lastTurnEnd;
      const seen = preference.threads[summary.threadId];
      const createdAt = Date.parse(message.createdAt);
      const pending = preference.pendingThreadEnds[summary.threadId];
      return Number.isSafeInteger(message.position) &&
        message.position >= 0 &&
        message.id !== seen?.id &&
        Number.isFinite(createdAt) &&
        (seen
          ? seen.position !== undefined && message.position > seen.position
          : (pending?.id === message.id &&
              pending.position === message.position) ||
            createdAt >= preference.threadEndBaseline)
        ? [summary.threadId]
        : [];
    }),
  );
}

export function messageTailIsVisible(
  viewport: DOMRect,
  message: DOMRect,
  foreground: boolean,
  occluder?: DOMRect,
): boolean {
  const bottom =
    occluder &&
    occluder.height > 0 &&
    occluder.top < viewport.bottom &&
    occluder.bottom > viewport.top
      ? Math.min(viewport.bottom, occluder.top)
      : viewport.bottom;
  return (
    foreground &&
    viewport.width > 0 &&
    viewport.height > 0 &&
    message.width > 0 &&
    message.height > 0 &&
    message.bottom > viewport.top &&
    message.bottom <= bottom &&
    message.right > viewport.left &&
    message.left < viewport.right
  );
}

/** Only a rendered canonical message tail, in the foreground reading viewport, acknowledges it. */
export function useReadVisibleMessage({
  scope,
  conversationId,
  message,
  messageOrder,
  viewport,
  occluder,
  enabled = true,
}: {
  scope: Scope;
  conversationId?: string;
  message?: ReadCursor;
  messageOrder?: readonly string[];
  viewport: RefObject<HTMLElement | null>;
  occluder?: RefObject<HTMLElement | null>;
  enabled?: boolean;
}) {
  const generation = useRef(0);
  useLayoutEffect(() => {
    const token = ++generation.current;
    const root = viewport.current;
    if (!enabled || !root || !conversationId || !message) return;
    let frame: number | undefined;
    const check = () => {
      if (generation.current !== token) return;
      const target = Array.from(
        root.querySelectorAll<HTMLElement>("[data-read-message-id]"),
      ).find((element) => element.dataset.readMessageId === message.id);
      if (!target) return;
      const bounds = target.getBoundingClientRect();
      if (
        messageTailIsVisible(
          root.getBoundingClientRect(),
          bounds,
          document.visibilityState === "visible" &&
            document.hasFocus() &&
            bounds.bottom > 0 &&
            bounds.bottom <= window.innerHeight &&
            bounds.right > 0 &&
            bounds.left < window.innerWidth &&
            !document.querySelector(
              '[role="dialog"][aria-modal="true"], dialog[open]',
            ),
          occluder?.current?.getBoundingClientRect(),
        )
      ) {
        conversationReadStore().advance(
          scope,
          conversationId,
          message,
          messageOrder,
        );
      }
    };
    const schedule = () => {
      if (generation.current !== token) return;
      if (frame !== undefined)
        (window.cancelAnimationFrame ?? window.clearTimeout)(frame);
      frame = window.requestAnimationFrame
        ? window.requestAnimationFrame(check)
        : window.setTimeout(check, 0);
    };
    schedule();
    root.addEventListener("scroll", schedule);
    window.addEventListener("focus", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(root);
    if (root.firstElementChild) observer?.observe(root.firstElementChild);
    return () => {
      generation.current += 1;
      if (frame !== undefined)
        (window.cancelAnimationFrame ?? window.clearTimeout)(frame);
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("focus", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule);
      observer?.disconnect();
    };
  }, [
    scope,
    conversationId,
    message?.id,
    message?.createdAt,
    message?.position,
    messageOrder,
    viewport,
    occluder,
    enabled,
  ]);
}
