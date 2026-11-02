import type { CanonicalItem, FailureItem } from "../../../../../src/item.js";

/** Disposable render lookup; canonical array order, not timestamps, wins. */
export function indexTurnOutcomeItems(
  items: readonly CanonicalItem[] | undefined,
): {
  abortedTurnIds: ReadonlySet<string>;
  latestFailureByTurn: ReadonlyMap<string, FailureItem>;
} {
  const abortedTurnIds = new Set<string>();
  const latestFailureByTurn = new Map<string, FailureItem>();
  for (const item of items ?? []) {
    if (item.type === "turn_aborted") abortedTurnIds.add(item.turnId);
    else if (item.type === "failure" && item.recovery === undefined)
      latestFailureByTurn.set(item.turnId, item);
  }
  return { abortedTurnIds, latestFailureByTurn };
}
