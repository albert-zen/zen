import type { Thread } from "../../protocol-client/index.js";

/** Historical pages add immutable rows; the live projection owns all overlap. */
export function mergeThreadHistoryPages(
  current: Thread,
  pages: readonly Thread[],
): Thread {
  if (pages.length === 0) return current;
  const all = [...pages].reverse().concat(current);
  const positions = Object.assign(
    {},
    ...all.map((page) => page.history?.itemPositions ?? {}),
  ) as Record<string, number>;
  const items = new Map(
    all.flatMap((page) =>
      (page.canonicalItems ?? []).map((item) => [item.id, item] as const),
    ),
  );
  const canonicalItems = [...items.values()].sort(
    (left, right) =>
      (positions[left.id] ?? Infinity) - (positions[right.id] ?? Infinity),
  );
  const order = new Map<string, number>();
  for (const item of canonicalItems)
    if (item.turnId && !order.has(item.turnId))
      order.set(item.turnId, order.size);
  const turns = new Map(
    all.flatMap((page) => page.turns.map((turn) => [turn.id, turn] as const)),
  );
  return {
    ...current,
    canonicalItems,
    turns: [...turns.values()].sort(
      (left, right) =>
        (order.get(left.id) ?? Infinity) - (order.get(right.id) ?? Infinity),
    ),
  };
}
