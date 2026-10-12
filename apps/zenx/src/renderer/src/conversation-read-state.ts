/**
 * Read watermarks for background conversations (Threads and Rooms).
 *
 * Unread state is connection-side UI state, never a canonical Item or ZAS
 * session fact: a conversation is unread when its activity watermark advanced
 * after the last time the user viewed it. Entries without a watermark are
 * baselined as read, so first appearance or restart can never create a
 * backlog of false positives. The currently viewed conversation is always
 * read. Values are plain epoch milliseconds keyed with a surface prefix
 * ("t:" Thread, "r:" Room), persisted only in window-local storage.
 */
export type ReadWatermarks = Readonly<Record<string, number>>;

export interface WatermarkEntry {
  key: string;
  updatedAtMs: number | null;
}

export function parseReadWatermarks(raw: string | null): ReadWatermarks {
  if (raw === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {};
  const marks: Record<string, number> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (
      typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= 0
    )
      marks[key] = Math.floor(candidate);
  }
  return marks;
}

export function serializeReadWatermarks(marks: ReadWatermarks): string {
  return JSON.stringify(marks);
}

/** First-seen conversations are read at their current position. */
export function withReadBaselines(
  marks: ReadWatermarks,
  entries: readonly WatermarkEntry[],
): ReadWatermarks {
  const missing = entries.filter(
    (entry) => marks[entry.key] === undefined && entry.updatedAtMs !== null,
  );
  if (missing.length === 0) return marks;
  const next = { ...marks };
  for (const entry of missing) next[entry.key] = entry.updatedAtMs!;
  return next;
}

/** Viewing a conversation marks everything up to its current position read. */
export function withReadMark(
  marks: ReadWatermarks,
  key: string,
  updatedAtMs: number | null,
): ReadWatermarks {
  if (updatedAtMs === null) return marks;
  const current = marks[key];
  if (current !== undefined && current >= updatedAtMs) return marks;
  return { ...marks, [key]: updatedAtMs };
}

export function deriveUnreadKeys(
  entries: readonly WatermarkEntry[],
  marks: ReadWatermarks,
  viewedKeys: Iterable<string>,
): ReadonlySet<string> {
  const viewed = new Set(viewedKeys);
  const unread = new Set<string>();
  for (const entry of entries) {
    if (entry.updatedAtMs === null) continue;
    const mark = marks[entry.key];
    if (mark === undefined) continue; // baselined elsewhere; never unread
    if (viewed.has(entry.key)) continue;
    if (entry.updatedAtMs > mark) unread.add(entry.key);
  }
  return unread;
}
