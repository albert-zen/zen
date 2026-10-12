import type { ComposerDraft } from "./composer-state.js";

export interface QueueEditSession {
  identity: string;
  /** A single viewport may edit this local draft at a time. */
  owner?: symbol;
  threadId: string;
  queuedItemId: string;
  clientId: string;
  expectedRevision: number;
  draft: ComposerDraft;
  trigger: HTMLButtonElement;
  pending: boolean;
  error: string | null;
  attempt?: { editId: string; fingerprint: string };
  confirmed?: { editItemId: string; revision: number };
}

/** App-owned, memory-only drafts survive viewport loading and navigation. */
export function createQueueEditStore() {
  let snapshot: Readonly<Record<string, QueueEditSession>> = {};
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(key: string, session: QueueEditSession | null) {
      const next = { ...snapshot };
      if (session === null) delete next[key];
      else next[key] = session;
      snapshot = next;
      for (const listener of listeners) listener();
    },
    isPending(threadId: string) {
      return Object.values(snapshot).some(
        (session) => session.threadId === threadId && session.pending,
      );
    },
  };
}

export type QueueEditStore = ReturnType<typeof createQueueEditStore>;
