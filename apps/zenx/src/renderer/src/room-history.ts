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
        page.nextCursor >= 256)
    )
      throw new Error(options.invalidCursorMessage);
    return page;
  };
  // Tail-relative offsets do not identify a stable snapshot. An arrival larger
  // than a page can put newer IDs in a later page, even without any overlap.
  // Room messages are append-only with bounded retention: an unchanged tail
  // proves those pages share canonical order, including one-message pages.
  // Retry a changing tail only a bounded number of times; never publish a
  // partially reconciled candidate or invent order from timestamps/IDs.
  for (let attempt = 0; attempt < 3; attempt++) {
    let cursor = 0;
    let messages: ZenXRoom["messages"] = [];
    let tail: string | undefined;
    for (let requests = 0; requests < 256; requests++) {
      const page = await readCurrentPage(cursor);
      if (!page) return null;
      if (requests === 0) tail = page.messages.at(-1)?.id;
      messages = [...page.messages, ...messages].slice(-256);
      const reachedWindow = options.oldestMessageId
        ? messages.findIndex(
            (message) => message.id === options.oldestMessageId,
          ) >= (options.earlierMessages ?? 0)
        : messages.length >= 4;
      if (page.nextCursor === null || reachedWindow) {
        const candidate = { messages, nextCursor: page.nextCursor };
        if (requests === 0) return candidate;
        const newest = await readCurrentPage(0);
        if (!newest) return null;
        if (newest.messages.at(-1)?.id === tail) return candidate;
        break;
      }
      cursor = page.nextCursor;
    }
  }
  throw new Error(options.changedHistoryMessage);
}
