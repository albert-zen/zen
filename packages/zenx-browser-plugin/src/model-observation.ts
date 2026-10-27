/** Pure Browser observation shaping. Native capture and reference authority remain in the Host. */
export function boundedBrowserQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 120)
    throw new Error("query must be 1–120 characters");
  return value.trim().toLocaleLowerCase();
}

export function boundedBrowserLimit(value: unknown): number {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 80)
    throw new Error("limit must be an integer from 1 to 80");
  return value as number;
}

export interface BrowserSearchTarget {
  role: string;
  name: string;
  value?: string;
  targetId: string;
}

export function searchCapturedTargets<T extends BrowserSearchTarget>(
  targets: readonly T[],
  query: string,
  limit: number,
): { matches: T[]; totalMatches: number } {
  const matches = targets.filter((target) =>
    [target.role, target.name, target.value].some((part) =>
      part?.toLocaleLowerCase().includes(query),
    ),
  );
  return { matches: matches.slice(0, limit), totalMatches: matches.length };
}

/** One splice of the bounded visible-text window; offsets are UTF-16 code units. */
export function localTextChange(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { start, deleteCount: oldEnd - start, insert: after.slice(start, newEnd) };
}
