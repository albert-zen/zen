/** Pure Browser observation shaping. Native capture and reference authority remain in the Host. */
export function boundedBrowserQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 120
  )
    throw new Error("query must be 1–120 characters");
  return value.trim().toLocaleLowerCase();
}

export function boundedBrowserLimit(value: unknown): number {
  if (value === undefined) return 20;
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 80
  )
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

/** Exact subset of an already captured backend view, never a new DOM search. */
export function focusCapturedTargets<T extends BrowserSearchTarget>(
  targets: readonly T[],
  text: string | undefined,
  targetId?: string,
): { targets: T[]; text?: string; textOffset: number } {
  const index =
    targetId === undefined
      ? -1
      : targets.findIndex((target) => target.targetId === targetId);
  const start = index < 0 ? 0 : Math.max(0, index - 3);
  const selected = targets.slice(start, start + 7);
  if (text === undefined) return { targets: selected, textOffset: 0 };
  const name = selected.find((target) => target.targetId === targetId)?.name;
  const match = name
    ? text.toLocaleLowerCase().indexOf(name.toLocaleLowerCase())
    : -1;
  const offset = match < 0 ? 0 : Math.max(0, match - 180);
  return {
    targets: selected,
    text: text.slice(offset, offset + 600),
    textOffset: offset,
  };
}

/** One splice of the bounded visible-text window; offsets are UTF-16 code units. */
export function localTextChange(before: string, after: string) {
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let oldEnd = before.length,
    newEnd = after.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    before[oldEnd - 1] === after[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  return {
    start,
    deleteCount: oldEnd - start,
    insert: after.slice(start, newEnd),
  };
}

/** Convert a captured first-page delta to exact replacement references. */
export function projectTargetChanges(
  changes: Record<string, unknown>,
  previousIds: readonly string[],
  returned: number,
  baseObservationId: string,
  observationId: string,
  bind: (targetId: string, observationId: string) => string,
  project: (
    target: Record<string, unknown>,
    observationId: string,
  ) => Record<string, unknown>,
): Record<string, unknown> {
  const ids = (value: unknown): string[] => {
    if (
      !Array.isArray(value) ||
      !value.every((part) => typeof part === "string")
    )
      throw Error("Invalid Browser target change IDs");
    return value;
  };
  const targets = (value: unknown): Record<string, unknown>[] => {
    if (
      !Array.isArray(value) ||
      !value.every(
        (part) =>
          part &&
          typeof part === "object" &&
          !Array.isArray(part) &&
          typeof part.targetId === "string",
      )
    )
      throw Error("Invalid Browser target changes");
    return value;
  };
  const old = new Set(previousIds);
  const currentIds =
    changes.order === undefined
      ? previousIds.slice(0, returned)
      : ids(changes.order);
  const added = targets(changes.added);
  const updated = targets(changes.updated);
  return {
    added: added.map((item) => project(item, observationId)),
    updated: updated.map((item) => ({
      beforeRef: bind(item.targetId as string, baseObservationId),
      ...project(item, observationId),
    })),
    removedFromView: ids(changes.removedFromView).map((id) =>
      bind(id, baseObservationId),
    ),
    replacements: currentIds
      .filter((id) => old.has(id))
      .map((id) => ({
        beforeRef: bind(id, baseObservationId),
        ref: bind(id, observationId),
      })),
    order: currentIds.map((id) => bind(id, observationId)),
  };
}
