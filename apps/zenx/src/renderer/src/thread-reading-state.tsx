import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export interface ReadingAnchor {
  turnId: string;
  itemId?: string;
  /** Distance from the item's top to the uncovered viewport's top. */
  offset: number;
}

// Exact DOM identity lookup, including IDs containing CSS punctuation.
export function readingIdentitySelector(attribute: string, id: string) {
  const escaped = id.replace(
    /[\x00-\x1f\x7f"\\]/g,
    (character) => `\\${character.charCodeAt(0).toString(16)} `,
  );
  return `[${attribute}="${escaped}"]`;
}

export function readingViewportBounds(viewport: HTMLElement) {
  const rect = viewport.getBoundingClientRect();
  const zone = viewport
    .closest(".thread-view")
    ?.querySelector<HTMLElement>(":scope > .bottom-zone")
    ?.getBoundingClientRect();
  return {
    top: Math.max(0, rect.top),
    bottom: Math.min(
      window.innerHeight,
      rect.bottom,
      zone && zone.height > 0 && zone.bottom > rect.top ? zone.top : Infinity,
    ),
    left: Math.max(0, rect.left),
    right: Math.min(window.innerWidth, rect.right),
  };
}

export function findReadingAnchor(
  viewport: HTMLElement,
  anchor: ReadingAnchor,
) {
  const turn = viewport.querySelector<HTMLElement>(
    readingIdentitySelector("data-turn-id", anchor.turnId),
  );
  if (!turn || anchor.itemId === undefined) return turn;
  return turn.querySelector<HTMLElement>(
    `${readingIdentitySelector("data-quote-item-id", anchor.itemId)}, ${readingIdentitySelector("data-sent-message-id", anchor.itemId)}`,
  );
}

/** At most nine viewport hit tests/nearby identity rects, never a history scan. */
export function captureReadingAnchor(
  viewport: HTMLElement,
): ReadingAnchor | undefined {
  if (
    !document.elementFromPoint ||
    viewport.closest("[hidden], [aria-hidden='true'], [inert]")
  )
    return;
  const bounds = readingViewportBounds(viewport);
  const height = bounds.bottom - bounds.top;
  const width = bounds.right - bounds.left;
  if (height <= 0 || width <= 0) return;
  for (const y of [1, Math.min(24, height / 2), height / 2]) {
    for (const x of [0.5, 0.25, 0.75]) {
      const hit = document.elementFromPoint(
        bounds.left + width * x,
        bounds.top + y,
      );
      const turn = hit?.closest<HTMLElement>("[data-turn-id]");
      if (!turn || !viewport.contains(turn)) continue;
      const item = hit?.closest<HTMLElement>(
        "[data-quote-item-id], [data-sent-message-id]",
      );
      const target = item && turn.contains(item) ? item : turn;
      const rect = target.getBoundingClientRect();
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.bottom <= bounds.top ||
        rect.top >= bounds.bottom
      )
        continue;
      const itemId = target.dataset.quoteItemId ?? target.dataset.sentMessageId;
      return {
        turnId: turn.dataset.turnId!,
        ...(itemId === undefined ? {} : { itemId }),
        offset: bounds.top - rect.top,
      };
    }
  }
}

// Reading choices are disposable renderer state, never Thread execution facts.
export function createThreadReadingState() {
  let disclosures: ReadonlyMap<string, boolean> = new Map();
  const listeners = new Set<() => void>();
  return {
    scroll: null as {
      top: number;
      following: boolean;
      anchor?: ReadingAnchor;
    } | null,
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
