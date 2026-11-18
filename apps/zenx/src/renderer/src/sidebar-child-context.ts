import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";

/** Already-loaded, uniquely named parent context only. Never resolve IDs by I/O. */
export function uniqueSidebarParentTitles(
  threads: readonly NativeThreadSummary[],
): ReadonlyMap<string, string> {
  const ids = new Map<string, number>();
  const titles = new Map<string, number>();
  const projected = threads.map((thread) => {
    const name = thread.name?.trim() ?? "";
    // The existing row formatter abbreviates these envelopes with routing IDs.
    // They are not human parent names and must not enter this description.
    const title =
      thread.status !== "systemError" &&
      !name.startsWith("[ZenX trigger wakeup]")
        ? name
        : "";
    ids.set(thread.threadId, (ids.get(thread.threadId) ?? 0) + 1);
    if (title) titles.set(title, (titles.get(title) ?? 0) + 1);
    return { id: thread.threadId, title };
  });
  return new Map(
    projected
      .filter(
        ({ id, title }) =>
          title && ids.get(id) === 1 && titles.get(title) === 1,
      )
      .map(({ id, title }): [string, string] => [id, title]),
  );
}
