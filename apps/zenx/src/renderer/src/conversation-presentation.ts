import { useSyncExternalStore } from "react";

export const CONVERSATION_DETAIL_STORAGE_KEY = "zenx.conversationDetail";
export type ConversationDetail = "normal" | "debug";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

/** A renderer-local display preference; it never enters the Host profile or Thread history. */
export function createConversationPresentationStore(
  storage?: PreferenceStorage,
) {
  const read = (): ConversationDetail => {
    try {
      return storage?.getItem(CONVERSATION_DETAIL_STORAGE_KEY) === "debug"
        ? "debug"
        : "normal";
    } catch {
      return "normal";
    }
  };
  let detail = read();
  const listeners = new Set<() => void>();
  const publish = (next: ConversationDetail) => {
    if (next === detail) return;
    detail = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => detail,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setDetail: (next: ConversationDetail) => {
      try {
        storage?.setItem(CONVERSATION_DETAIL_STORAGE_KEY, next);
      } catch {
        // As with Appearance, an explicit choice still applies in this window.
      }
      publish(next);
    },
    refresh: () => publish(read()),
  };
}

const windowStores = new WeakMap<
  Window,
  ReturnType<typeof createConversationPresentationStore>
>();

export function getConversationPresentationStore(target: Window = window) {
  let store = windowStores.get(target);
  if (store !== undefined) return store;
  let storage: PreferenceStorage | undefined;
  try {
    storage = target.localStorage;
  } catch {
    /* Unavailable storage starts in Normal. */
  }
  store = createConversationPresentationStore(storage);
  windowStores.set(target, store);
  const current = store;
  target.addEventListener("storage", (event) => {
    if (event.key === CONVERSATION_DETAIL_STORAGE_KEY || event.key === null)
      current.refresh();
  });
  return store;
}

export function useConversationDetailPreference() {
  const store = getConversationPresentationStore();
  const detail = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    () => "normal" as const,
  );
  return [detail, store.setDetail] as const;
}
