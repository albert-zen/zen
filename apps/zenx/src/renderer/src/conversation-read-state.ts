/**
 * Read watermarks for background conversations (Threads and Rooms).
 *
 * Unread state is connection-side UI state, never a canonical Item or ZAS
 * session fact: a conversation is unread when its activity watermark advanced
 * after the last time the user viewed it. Entries without a watermark are
 * baselined as read, so first appearance never creates a false backlog.
 * A loaded visible surface acknowledges only the content it actually renders.
 * Values are bounded content positions keyed with a surface prefix
 * ("t:" Thread, "r:" Room), persisted only in window-local storage.
 */
export type ReadWatermarks = Readonly<Record<string, number | string>>;

export interface WatermarkEntry {
  key: string;
  position: number | string | null;
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
  const marks: Record<string, number | string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (
      typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= 0
    )
      marks[key] = Math.floor(candidate);
    else if (
      key.startsWith("r:") &&
      typeof candidate === "string" &&
      candidate.length <= 512
    )
      marks[key] = candidate;
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
  const missing = entries.filter((entry) => marks[entry.key] === undefined);
  if (missing.length === 0) return marks;
  const next = { ...marks };
  for (const entry of missing) next[entry.key] = entry.position ?? 0;
  return next;
}

/** Viewing a conversation marks everything up to its current position read. */
export function withReadMark(
  marks: ReadWatermarks,
  key: string,
  position: number | string | null,
): ReadWatermarks {
  if (position === null) return marks;
  const current = marks[key];
  if (
    current === position ||
    (typeof current === "number" &&
      typeof position === "number" &&
      current >= position)
  )
    return marks;
  return { ...marks, [key]: position };
}

export function deriveUnreadKeys(
  entries: readonly WatermarkEntry[],
  marks: ReadWatermarks,
  viewedKeys: Iterable<string>,
): ReadonlySet<string> {
  const viewed = new Set(viewedKeys);
  const unread = new Set<string>();
  for (const entry of entries) {
    if (entry.position === null) continue;
    const mark = marks[entry.key];
    if (mark === undefined) continue; // baselined elsewhere; never unread
    if (viewed.has(entry.key)) continue;
    if (
      typeof entry.position === "string"
        ? entry.position !== mark
        : typeof mark === "number" && entry.position > mark
    )
      unread.add(entry.key);
  }
  return unread;
}
