import type {
  CanonicalItem,
  TurnAbortedItem,
  TurnCompletedItem,
} from "./item.js";

export function isTurnEndItem(
  item: CanonicalItem,
): item is TurnCompletedItem | TurnAbortedItem {
  return item.type === "turn_completed" || item.type === "turn_aborted";
}

/** Only the latest locally started Turn can produce a new execution end.
 * Copied/imported history (including synthetic snapshot closures) never ran here.
 */
export function latestTurnEnd(items: readonly CanonicalItem[]) {
  const forkIndex = items.findLastIndex(
    (item) => item.type === "thread_forked",
  );
  const metadata = items.find((item) => item.type === "thread_metadata");
  // A fork may truncate imported history while retaining its original metadata.
  const localBoundary =
    forkIndex >= 0
      ? forkIndex
      : (metadata?.importedFrom?.historyItemCount ?? -1);
  const startIndex = items.findLastIndex(
    (item, index) => index > localBoundary && item.type === "turn_started",
  );
  const start = items[startIndex];
  if (!start || start.type !== "turn_started") return undefined;
  return items.findLast(
    (item, index): item is TurnCompletedItem | TurnAbortedItem =>
      index > startIndex && isTurnEndItem(item) && item.turnId === start.turnId,
  );
}

/** Zero-based index among ALL canonical turn_completed/turn_aborted Items.
 * Inherited ends and fork closures retain fixed slots but latestTurnEnd excludes
 * them from notifications. Compaction only appends; full recovery and live
 * lifecycle events therefore preserve this order despite omitted metadata.
 */
export function turnEndPosition(
  items: readonly CanonicalItem[],
  end: TurnCompletedItem | TurnAbortedItem,
): number {
  return items.filter(isTurnEndItem).findIndex((item) => item.id === end.id);
}
