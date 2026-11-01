import type { ZenXRoom } from "../../main/trigger-types.js";

export interface RoomHistoryPage {
  messages: ZenXRoom["messages"];
  nextCursor: number | null;
}

/** Reconcile the renderer window against the Host's retained, tail-relative pages. */
export async function readRoomHistory(
  readPage: (cursor: number) => Promise<RoomHistoryPage>,
  options: {
    oldestMessageId?: string;
    earlierMessages?: number;
    isCurrent: () => boolean;
    invalidCursorMessage: string;
    changedHistoryMessage: string;
  },
): Promise<RoomHistoryPage | null> {
  const readCurrentPage = async (cursor: number) => {
    let page: RoomHistoryPage;
    try {
      page = await readPage(cursor);
    } catch (error) {
      if (!options.isCurrent()) return null;
      throw error;
    }
    if (!options.isCurrent()) return null;
    if (
      page.nextCursor !== null &&
      (!Number.isSafeInteger(page.nextCursor) ||
        page.nextCursor <= cursor ||
        page.messages.length === 0)
    )
      throw new Error(options.invalidCursorMessage);
    return page;
  };
  // Tail-relative offsets do not identify a stable snapshot. An arrival larger
  // than a page can put newer IDs in a later page, even without any overlap.
  // Room messages are append-only: an unchanged tail
  // proves those pages share canonical order, including one-message pages.
  // Retry a changing tail only a bounded number of times; never publish a
  // partially reconciled candidate or invent order from timestamps/IDs.
  for (let attempt = 0; attempt < 3; attempt++) {
    let cursor = 0;
    const pages: ZenXRoom["messages"][] = [];
    let count = 0;
    let beforeAnchor: number | undefined;
    let tail: string | undefined;
    for (let requests = 0; ; requests++) {
      const page = await readCurrentPage(cursor);
      if (!page) return null;
      if (requests === 0) tail = page.messages.at(-1)?.id;
      pages.push(page.messages);
      count += page.messages.length;
      if (beforeAnchor !== undefined) beforeAnchor += page.messages.length;
      else if (options.oldestMessageId) {
        const anchor = page.messages.findIndex(
          (message) => message.id === options.oldestMessageId,
        );
        if (anchor >= 0) beforeAnchor = anchor;
      }
      const reachedWindow = options.oldestMessageId
        ? beforeAnchor !== undefined &&
          beforeAnchor >= (options.earlierMessages ?? 0)
        : count >= 4;
      const complete = page.nextCursor === null || reachedWindow;
      // Check long scans periodically so a continuously moving tail cannot
      // keep us chasing an unreachable anchor. This is not a history limit.
      if ((complete && requests > 0) || (requests + 1) % 64 === 0) {
        const newest = await readCurrentPage(0);
        if (!newest) return null;
        if (newest.messages.at(-1)?.id !== tail) break;
      }
      if (page.nextCursor === null || reachedWindow) {
        const messages = pages.reverse().flat();
        if (
          new Set(messages.map((message) => message.id)).size !==
          messages.length
        )
          throw new Error(options.changedHistoryMessage);
        return { messages, nextCursor: page.nextCursor };
      }
      cursor = page.nextCursor;
    }
  }
  throw new Error(options.changedHistoryMessage);
}
