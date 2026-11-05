import type { CanonicalItem } from "./item.js";
import { firstInputMessagePreview } from "./item.js";
import { pendingQueuedMessages } from "./input-queue.js";

/** A presentation window, never a replacement for the canonical ItemList.
 * Semantic context is deliberately absent. zen/thread/read and full native
 * resume remain exact context/audit reads; a window must not infer an empty
 * or partial ItemList from that absence.
 */
export interface ThreadHistoryWindow {
  /** Exclusive stable boundary, scoped to this Thread and valid across Host epochs. */
  before: string | null;
  preview: string;
  /** Canonical positions order overlapping pages and live append facts without timestamps. */
  itemPositions: Record<string, number>;
}
export interface ThreadHistoryWindowOptions {
  before?: string;
  limit?: number;
}

export function selectThreadHistoryWindow(
  threadId: string,
  items: readonly CanonicalItem[],
  options: ThreadHistoryWindowOptions = {},
): {
  items: readonly CanonicalItem[];
  turnIds: ReadonlySet<string>;
  history: ThreadHistoryWindow;
} {
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new Error("History limit must be an integer between 1 and 50");
  const starts: { id: string; index: number }[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (item.turnId !== undefined && !seen.has(item.turnId)) {
      seen.add(item.turnId);
      starts.push({ id: item.turnId, index });
    }
  });
  let end = starts.length;
  if (options.before !== undefined) {
    if (options.before.length > 4096) throw new Error("Invalid history cursor");
    let cursor: unknown;
    try {
      cursor = JSON.parse(
        Buffer.from(options.before, "base64url").toString("utf8"),
      );
    } catch {
      throw new Error("Invalid history cursor");
    }
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 3 ||
      cursor[0] !== 1 ||
      cursor[1] !== threadId ||
      typeof cursor[2] !== "string"
    )
      throw new Error("Invalid history cursor for this Thread");
    end = starts.findIndex((entry) => entry.id === cursor[2]);
    if (end < 0)
      throw new Error("History cursor boundary is no longer available");
  }
  const start = Math.max(0, end - limit);
  const from = start === 0 ? 0 : starts[start]!.index;
  const to = starts[end]?.index ?? items.length;
  // Queue authority still derives from original facts, including every edit in
  // a pending chain. Do not synthesize an edited anchor or revive settled input.
  const pending = new Set(pendingQueuedMessages(items).map((item) => item.id));
  const turnIds = new Set(starts.slice(start, end).map((entry) => entry.id));
  const visible = (item: CanonicalItem, index: number) =>
    (item.turnId !== undefined && turnIds.has(item.turnId)) ||
    (item.turnId === undefined && index >= from && index < to) ||
    pending.has(item.id);
  const questionCalls = new Set(
    items.flatMap((item, index) =>
      visible(item, index) &&
      "questionReply" in item &&
      item.questionReply?.request.threadId === threadId
        ? [item.questionReply.request.callItemId]
        : [],
    ),
  );
  const selected = items.filter(
    (item, index) =>
      (item.turnId !== undefined && turnIds.has(item.turnId)) ||
      (item.turnId === undefined && index >= from && index < to) ||
      item.type === "thread_metadata" ||
      item.type === "thread_forked" ||
      pending.has(item.id) ||
      (item.type === "tool_call" &&
        item.name === "ask_user_question" &&
        questionCalls.has(item.id)) ||
      (item.type === "user_message_queue_edited" &&
        pending.has(item.queuedItemId)),
  );
  const selectedIds = new Set(selected.map((item) => item.id));
  return {
    items: selected,
    turnIds,
    history: {
      before:
        start === 0
          ? null
          : Buffer.from(
              JSON.stringify([1, threadId, starts[start]!.id]),
            ).toString("base64url"),
      preview: firstInputMessagePreview(items).slice(0, 256),
      itemPositions: Object.fromEntries(
        items.flatMap((item, index) =>
          selectedIds.has(item.id) ? [[item.id, index]] : [],
        ),
      ),
    },
  };
}
