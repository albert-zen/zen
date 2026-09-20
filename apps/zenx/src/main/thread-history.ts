import type { ThreadSnapshot } from "../../../../src/app-server.js";
import type { CanonicalItem } from "../../../../src/item.js";

export interface HistoryOptions {
  granularity: "turns" | "items" | "agent_messages" | "item";
  turnId?: string;
  itemId?: string;
  cursor?: string;
  maxTurns: number;
  maxItemsPerTurn: number;
}

interface HistoryCursor {
  version: 1;
  binding: string;
  boundary: string | null;
  before: string | null;
  offset: number;
}

/** Public Item projections; cursors contain only canonical read boundaries. */
export function readThreadHistory(
  thread: ThreadSnapshot,
  options: HistoryOptions,
): Record<string, unknown> {
  const binding = JSON.stringify([
    thread.id,
    options.granularity,
    options.turnId ?? null,
    options.itemId ?? null,
  ]);
  const cursor: HistoryCursor =
    options.cursor === undefined
      ? {
          version: 1,
          binding,
          boundary: thread.items.at(-1)?.id ?? null,
          before: null,
          offset: 0,
        }
      : decodeCursor(options.cursor, binding);
  const boundaryIndex =
    cursor.boundary === null
      ? -1
      : thread.items.findIndex((item) => item.id === cursor.boundary);
  if (cursor.boundary !== null && boundaryIndex < 0)
    throw new Error("History cursor boundary no longer exists");
  const snapshot = thread.items.slice(0, boundaryIndex + 1);
  const items = snapshot.filter(
    (item) => options.turnId === undefined || item.turnId === options.turnId,
  );
  if (
    options.turnId !== undefined &&
    !snapshot.some(
      (item) => item.type === "turn_started" && item.turnId === options.turnId,
    )
  )
    throw new Error("Unknown turnId in this history snapshot");
  const base = {
    source: "zenx.app-server",
    threadId: thread.id,
    cwd: thread.cwd,
    granularity: options.granularity,
    snapshotThroughItemId: cursor.boundary,
  };
  if (options.granularity === "item") {
    const item = items.find((candidate) => candidate.id === options.itemId);
    if (item === undefined)
      throw new Error("Unknown itemId in this history snapshot");
    const raw = JSON.stringify(publicItemValue(item));
    if (cursor.offset > raw.length)
      throw new Error("Invalid item cursor offset");
    const end = Math.min(raw.length, cursor.offset + 8000);
    return {
      ...base,
      itemId: item.id,
      format: "public_item_json",
      content: raw.slice(cursor.offset, end),
      offset: cursor.offset,
      totalLength: raw.length,
      truncated: end < raw.length,
      nextCursor:
        end < raw.length ? encodeCursor({ ...cursor, offset: end }) : null,
    };
  }
  if (options.granularity === "turns") {
    const turns = snapshot.filter((item) => item.type === "turn_started");
    const end = beforeIndex(
      turns.map((item) => item.id),
      cursor.before,
    );
    const start = Math.max(0, end - options.maxTurns);
    const itemLimit = Math.min(
      options.maxItemsPerTurn,
      Math.max(1, Math.floor(100 / options.maxTurns)),
    );
    const page = turns.slice(start, end).map((started) => {
      const turnItems = snapshot.filter(
        (item) => item.turnId === started.turnId,
      );
      const terminal = turnItems.findLast(
        (item) =>
          item.type === "turn_completed" || item.type === "turn_aborted",
      );
      return {
        turnId: started.turnId,
        status:
          terminal?.type === "turn_completed"
            ? terminal.status
            : terminal?.type === "turn_aborted"
              ? "interrupted"
              : "inProgress",
        items: turnItems.slice(-itemLimit).map(previewItem),
        itemsTruncated: turnItems.length > itemLimit,
        readItems: {
          target: thread.id,
          granularity: "items",
          turnId: started.turnId,
        },
      };
    });
    return {
      ...base,
      turns: page,
      maxItemsPerTurn: itemLimit,
      turnsTruncated: start > 0,
      nextCursor:
        start > 0
          ? encodeCursor({ ...cursor, before: turns[start]!.id })
          : null,
    };
  }
  const filtered =
    options.granularity === "agent_messages"
      ? items.filter((item) => item.type === "agent_message")
      : items;
  const end = beforeIndex(
    filtered.map((item) => item.id),
    cursor.before,
  );
  const start = Math.max(0, end - options.maxItemsPerTurn);
  return {
    ...base,
    items: filtered.slice(start, end).map(previewItem),
    truncated: start > 0,
    nextCursor:
      start > 0
        ? encodeCursor({ ...cursor, before: filtered[start]!.id })
        : null,
  };
}

function previewItem(item: CanonicalItem): Record<string, unknown> {
  const projected = publicItemValue(item);
  const raw = JSON.stringify(projected);
  const truncated = raw.length > 500;
  const text =
    item.type === "agent_message"
      ? item.text
      : item.type === "tool_result"
        ? item.output
        : undefined;
  return {
    ...(text === undefined
      ? {}
      : { text: text.slice(0, 500), textTruncated: text.length > 500 }),
    itemId: item.id,
    type: item.type,
    turnId: item.turnId ?? null,
    ...(raw.length <= 500
      ? { item: projected }
      : { preview: raw.slice(0, 500) }),
    truncated,
    read: { target: item.threadId, granularity: "item", itemId: item.id },
  };
}

/** Respect structured visibility at every depth without interpreting text strings. */
function publicItemValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicItemValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const entries =
    record.contentVisibility === "opaque"
      ? [
          "id",
          "threadId",
          "turnId",
          "createdAt",
          "type",
          "role",
          "contentVisibility",
          "summary",
        ]
          .filter((key) => Object.hasOwn(record, key))
          .map((key) => [key, record[key]] as const)
      : Object.entries(record);
  return Object.fromEntries(
    entries.map(([key, child]) => [key, publicItemValue(child)]),
  );
}

function beforeIndex(ids: string[], before: string | null): number {
  if (before === null) return ids.length;
  const index = ids.indexOf(before);
  if (index < 0) throw new Error("History cursor page boundary does not exist");
  return index;
}

function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string, binding: string): HistoryCursor {
  try {
    if (value.length > 16384) throw new Error();
    const cursor = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as HistoryCursor;
    if (
      cursor.version !== 1 ||
      cursor.binding !== binding ||
      !(cursor.boundary === null || typeof cursor.boundary === "string") ||
      !(cursor.before === null || typeof cursor.before === "string") ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0
    )
      throw new Error();
    return cursor;
  } catch {
    throw new Error(
      "Invalid history cursor or cursor does not match the target and filters",
    );
  }
}
