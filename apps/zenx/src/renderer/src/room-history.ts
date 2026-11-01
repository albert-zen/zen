import type { ZenXRoom } from "../../main/trigger-types.js";

export interface RoomHistorySnapshot {
  generation: string;
  revision: number;
  hash: string;
  roomId: string;
  messageCount: number;
}
export interface RoomHistoryPage {
  snapshot?: RoomHistorySnapshot;
  reactionRevisions?: Record<string, number>;
  messages: ZenXRoom["messages"];
  nextCursor: number | null;
}

/** Reconcile the renderer window against the Host's retained, tail-relative pages. */
export async function readRoomHistory(
  readPage: (
    cursor: number,
    snapshot?: RoomHistorySnapshot,
  ) => Promise<RoomHistoryPage>,
  options: {
    oldestMessageId?: string;
    earlierMessages?: number;
    isCurrent: () => boolean;
    invalidCursorMessage: string;
    changedHistoryMessage: string;
  },
): Promise<RoomHistoryPage | null> {
  let snapshot: RoomHistorySnapshot | undefined;
  let legacy = false;
  const revisions: Record<string, number> = Object.create(null);
  const readCurrentPage = async (cursor: number) => {
    let page: RoomHistoryPage;
    try {
      page = await readPage(cursor, snapshot ? { ...snapshot } : undefined);
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
    if (page.snapshot) {
      const next = page.snapshot;
      if (
        legacy ||
        !validSnapshot(next) ||
        (snapshot && !sameSnapshot(snapshot, next))
      )
        throw Error(options.changedHistoryMessage);
      snapshot ??= { ...next };
      const end = cursor + page.messages.length;
      if (
        end > next.messageCount ||
        (page.nextCursor === null) !== (end === next.messageCount) ||
        (page.nextCursor !== null && page.nextCursor !== end)
      )
        throw Error(options.invalidCursorMessage);
      for (const message of page.messages) {
        const revision = page.reactionRevisions?.[message.id];
        if (
          message.roomId !== next.roomId ||
          !Number.isSafeInteger(revision) ||
          revision! < 0 ||
          revision! > next.revision
        )
          throw Error(options.changedHistoryMessage);
        revisions[message.id] = revision!;
      }
    } else {
      if (snapshot) throw Error(options.changedHistoryMessage);
      legacy = true;
    }
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
      if (
        !snapshot &&
        ((complete && requests > 0) || (requests + 1) % 64 === 0)
      ) {
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
        return {
          messages,
          nextCursor: page.nextCursor,
          ...(snapshot ? { snapshot, reactionRevisions: revisions } : {}),
        };
      }
      cursor = page.nextCursor;
    }
  }
  throw new Error(options.changedHistoryMessage);
}

function validSnapshot(value: RoomHistorySnapshot): boolean {
  return (
    typeof value.roomId === "string" &&
    typeof value.generation === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.generation,
    ) &&
    typeof value.hash === "string" &&
    /^[a-f0-9]{64}$/.test(value.hash) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    Number.isSafeInteger(value.messageCount) &&
    value.messageCount >= 0
  );
}
function sameSnapshot(a: RoomHistorySnapshot, b: RoomHistorySnapshot): boolean {
  return (
    a.generation === b.generation &&
    a.revision === b.revision &&
    a.hash === b.hash &&
    a.roomId === b.roomId &&
    a.messageCount === b.messageCount
  );
}
/** Preserve newer live reaction projections without changing snapshot message order. */
export function mergeRoomHistoryReactions(
  page: RoomHistoryPage,
  current: RoomHistoryPage | undefined,
  newerReceiptIds: ReadonlySet<string> = new Set(),
): RoomHistoryPage {
  if (
    !current ||
    page.snapshot?.generation !== current.snapshot?.generation ||
    page.snapshot?.roomId !== current.snapshot?.roomId
  )
    return page;
  const visible = new Map(
    current.messages.map((message) => [message.id, message]),
  );
  const revisions = Object.assign(Object.create(null), page.reactionRevisions);
  const messages = page.messages.map((message) => {
    const prior = visible.get(message.id);
    const revision = current.reactionRevisions?.[message.id];
    if (
      !prior ||
      (!(
        revision !== undefined &&
        revision > (page.reactionRevisions?.[message.id] ?? -1)
      ) &&
        !newerReceiptIds.has(message.id))
    )
      return message;
    if (revision !== undefined)
      revisions[message.id] = Math.max(
        revision,
        page.reactionRevisions?.[message.id] ?? 0,
      );
    const { reactions: _old, ...body } = message;
    return {
      ...body,
      ...(prior.reactions === undefined ? {} : { reactions: prior.reactions }),
    };
  });
  return {
    ...page,
    messages,
    ...(page.reactionRevisions || current.reactionRevisions
      ? { reactionRevisions: revisions }
      : {}),
  };
}
