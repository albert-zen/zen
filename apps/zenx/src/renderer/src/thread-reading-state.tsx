import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

// Reading choices are disposable renderer state, never Thread execution facts.
export function createThreadReadingState() {
  let disclosures: ReadonlyMap<string, boolean> = new Map();
  const listeners = new Set<() => void>();
  return {
    snapshot: () => disclosures,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (
      key: string,
      change: boolean | ((current: boolean | undefined) => boolean),
    ) => {
      const open =
        typeof change === "function" ? change(disclosures.get(key)) : change;
      if (disclosures.get(key) === open) return;
      disclosures = new Map(disclosures).set(key, open);
      for (const listener of listeners) listener();
    },
  };
}
type ThreadReadingState = ReturnType<typeof createThreadReadingState>;
function createReadingStore() {
  const threads = new Map<string, ThreadReadingState>();
  return (threadId: string) => {
    let state = threads.get(threadId);
    if (!state) threads.set(threadId, (state = createThreadReadingState()));
    return state;
  };
}
const ReadingStoreContext = createContext<ReturnType<
  typeof createReadingStore
> | null>(null);
export const ThreadReadingContext = createContext<ThreadReadingState | null>(
  null,
);

/** One App-owned cache survives navigation without retaining transcript DOM. */
export function ThreadReadingStateProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [store] = useState(createReadingStore);
  return (
    <ReadingStoreContext.Provider value={store}>
      {children}
    </ReadingStoreContext.Provider>
  );
}
export function useThreadReadingState(threadId: string | undefined) {
  const shared = useContext(ReadingStoreContext);
  const [local] = useState(createReadingStore);
  return (shared ?? local)(threadId ?? "");
}
export function disclosureKey(...parts: string[]) {
  return JSON.stringify(parts);
}
export function useReadingDisclosures() {
  const state = useContext(ThreadReadingContext)!;
  const choices = useSyncExternalStore(
    state.subscribe,
    state.snapshot,
    state.snapshot,
  );
  return { choices, set: state.set };
}
export function useReadingDisclosure(key: string) {
  const { choices, set } = useReadingDisclosures();
  return [
    choices.get(key),
    (change: boolean | ((current: boolean | undefined) => boolean)) =>
      set(key, change),
  ] as const;
}
