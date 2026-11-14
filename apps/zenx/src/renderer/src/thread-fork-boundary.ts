import type { Thread } from "../../protocol-client/index.js";

/** Display-only boundary, proven from loaded canonical provenance, never time. */
export function projectForkBoundary(thread: Thread | null | undefined) {
  const items = thread?.canonicalItems;
  if (!thread || !items) return null;
  const forkIndex = items.findLastIndex(
    (item) => item.type === "thread_forked" && item.threadId === thread.id,
  );
  const item = items[forkIndex];
  if (item?.type !== "thread_forked" || item.context === "full") return null;
  const startIndex = items.findLastIndex(
    (entry, index) => index < forkIndex && entry.type === "turn_started",
  );
  const start = items[startIndex];
  if (
    start?.type !== "turn_started" ||
    !thread.turns.some((turn) => turn.id === start.turnId)
  )
    return null;
  // History windows always retain fork markers, even when the copied tail is
  // absent. Require a contiguous loaded tail so an earlier page cannot lie.
  if (thread.history) {
    const positions = thread.history.itemPositions;
    const from = positions[start.id];
    const to = positions[item.id];
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to! < from!)
      return null;
    const loaded = new Set(
      items
        .slice(startIndex, forkIndex + 1)
        .map((entry) => positions[entry.id]),
    );
    if (loaded.size !== to! - from! + 1 || loaded.has(undefined)) return null;
    for (let position = from!; position <= to!; position++)
      if (!loaded.has(position)) return null;
  }
  const turnStarts = new Map(
    items.flatMap((entry, index) =>
      entry.type === "turn_started" ? [[entry.turnId, index] as const] : [],
    ),
  );
  // A rendered legacy/dependency Turn without its start cannot be classified.
  if (thread.turns.some((turn) => !turnStarts.has(turn.id))) return null;
  const inheritedTurnIds = new Set(
    thread.turns
      .filter((turn) => turnStarts.get(turn.id)! < forkIndex)
      .map((turn) => turn.id),
  );
  return {
    item,
    afterTurnId: start.turnId,
    inheritedTurnIds,
    canonicalIndex: forkIndex,
  };
}
