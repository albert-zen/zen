import type { ThreadSnapshot } from "./app-server.js";
import { textFromUserInput, type CanonicalItem } from "./item.js";
import { originalHistoryBoundary } from "./context-compaction.js";

export interface HistoryOptions {
  granularity: "turns" | "items" | "agent_messages" | "item";
  turnId?: string;
  itemId?: string;
  cursor?: string;
  throughItemId?: string;
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
    ...(options.throughItemId === undefined ? [] : [options.throughItemId]),
  ]);
  const throughIndex =
    options.throughItemId === undefined
      ? thread.items.length - 1
      : originalHistoryBoundary(thread.items, options.throughItemId);
  const cursor: HistoryCursor =
    options.cursor === undefined
      ? {
          version: 1,
          binding,
          boundary: thread.items[throughIndex]?.id ?? null,
          before: null,
          offset: 0,
        }
      : decodeCursor(options.cursor, binding);
  const boundaryIndex =
    cursor.boundary === null
      ? -1
      : thread.items.findIndex((item) => item.id === cursor.boundary);
  if (
    options.throughItemId !== undefined &&
    cursor.boundary !== options.throughItemId
  )
    throw new Error(
      "History cursor does not match the original history boundary",
    );
  if (boundaryIndex > throughIndex)
    throw new Error("History cursor exceeds the original history boundary");
  if (cursor.boundary !== null && boundaryIndex < 0)
    throw new Error("History cursor boundary no longer exists");
  // Recovery controls are product lifecycle facts, not public agent history.
  // Keep the canonical cursor boundary, but omit controls from every view.
  const snapshot = thread.items
    .slice(0, boundaryIndex + 1)
    .filter(
      (item) =>
        item.type !== "thread_deleted" && item.type !== "thread_restored",
    );
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
    const raw = JSON.stringify(publicItemValue(item, true));
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
    const selectedTurns = turns.slice(start, end);
    // Group only this page in canonical order, without rescanning the snapshot
    // for each turn or retaining an index beyond this read.
    const selectedItems = new Map<string | undefined, CanonicalItem[]>();
    for (const started of selectedTurns) selectedItems.set(started.turnId, []);
    for (const item of snapshot) selectedItems.get(item.turnId)?.push(item);
    const page = selectedTurns.map((started) => {
      const turnItems = selectedItems.get(started.turnId)!;
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
        items: turnItems
          .slice(-itemLimit)
          .map((item) => previewItem(item, options.throughItemId)),
        itemsTruncated: turnItems.length > itemLimit,
        readItems: {
          target: thread.id,
          granularity: "items",
          turnId: started.turnId,
          ...(options.throughItemId === undefined
            ? {}
            : { throughItemId: options.throughItemId }),
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
    items: filtered
      .slice(start, end)
      .map((item) => previewItem(item, options.throughItemId)),
    truncated: start > 0,
    nextCursor:
      start > 0
        ? encodeCursor({ ...cursor, before: filtered[start]!.id })
        : null,
  };
}

function previewItem(
  item: CanonicalItem,
  throughItemId?: string,
): PublicHistoryItem {
  const projected = publicItemValue(item, true);
  const raw = JSON.stringify(projected);
  const truncated = raw.length > 500;
  // Render only the public projection. A structured opaque object never gains
  // a text side channel merely because its outer Item type normally has text.
  const visible = projected as Record<string, unknown>;
  const text =
    typeof visible.text === "string"
      ? visible.text
      : typeof visible.output === "string"
        ? visible.output
        : item.type === "user_message" && Array.isArray(visible.content)
          ? textFromUserInput(visible.content as import("./item.js").UserInput)
          : item.type === "reasoning" && typeof visible.summary === "string"
            ? visible.summary
            : item.type === "reasoning" &&
                typeof visible.reasoningContent === "string"
              ? visible.reasoningContent
              : undefined;
  return {
    ...(text === undefined
      ? {}
      : { text: text.slice(0, 500), textTruncated: text.length > 500 }),
    ...(item.type === "host_message"
      ? {
          source: item.source,
          ...(item.sourceId === undefined ? {} : { sourceId: item.sourceId }),
          mode: item.mode,
        }
      : {}),
    ...(visible.contentVisibility !== "opaque" && item.type === "tool_result"
      ? {
          outcome: {
            exitCode: item.exitCode,
            ...(item.executionStatus === undefined
              ? {}
              : { executionStatus: item.executionStatus }),
          },
        }
      : {}),
    ...(visible.contentVisibility !== "opaque" && item.type === "failure"
      ? {
          failure: {
            code: item.code,
            message: item.message.slice(0, 500),
            messageTruncated: item.message.length > 500,
          },
        }
      : {}),
    ...(visible.contentVisibility !== "opaque" && item.type === "turn_completed"
      ? { status: item.status }
      : {}),
    itemId: item.id,
    createdAt: item.createdAt,
    type: item.type,
    turnId: item.turnId ?? null,
    ...(raw.length <= 500
      ? { item: projected }
      : { preview: raw.slice(0, 500) }),
    truncated,
    read: {
      ...(throughItemId === undefined
        ? { target: item.threadId }
        : { threadId: item.threadId }),
      granularity: "item",
      itemId: item.id,
      ...(throughItemId === undefined ? {} : { throughItemId }),
    },
  };
}

/** Respect structured visibility at every depth without interpreting text strings. */
function publicItemValue(value: unknown, root = false): unknown {
  if (Array.isArray(value)) return value.map((child) => publicItemValue(child));
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
      : Object.entries(record).filter(
          ([key]) =>
            !(
              root &&
              record.type === "tool_result" &&
              key === "referenceBindings"
            ),
        );
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

export interface PublicHistoryItem {
  outcome?: {
    exitCode: number | null;
    executionStatus?: Extract<
      CanonicalItem,
      { type: "tool_result" }
    >["executionStatus"];
  };
  failure?: { code: string; message: string; messageTruncated: boolean };
  status?: Extract<CanonicalItem, { type: "turn_completed" }>["status"];
  itemId: string;
  createdAt: string;
  type: CanonicalItem["type"];
  turnId: string | null;
  text?: string;
  textTruncated?: boolean;
  item?: unknown;
  preview?: string;
  truncated: boolean;
  read: {
    target?: string;
    threadId?: string;
    granularity: "item";
    itemId: string;
    throughItemId?: string;
  };
}
export interface OriginalHistoryOptions {
  throughItemId: string;
  granularity?: "items" | "item";
  itemId?: string;
  cursor?: string;
  limit?: number;
}
export type OriginalHistoryPage = {
  source: string;
  threadId: string;
  snapshotThroughItemId: string;
  nextCursor: string | null;
} & (
  | { granularity: "items"; items: PublicHistoryItem[]; truncated: boolean }
  | {
      granularity: "item";
      itemId: string;
      format: "public_item_json";
      content: string;
      offset: number;
      totalLength: number;
      truncated: boolean;
    }
);

/** Bounded public views of the exact enabled compaction prefix; never a second history. */
export function readOriginalThreadHistory(
  thread: ThreadSnapshot,
  options: OriginalHistoryOptions,
): OriginalHistoryPage {
  const allowed = ["throughItemId", "granularity", "itemId", "cursor", "limit"];
  if (Object.keys(options).some((key) => !allowed.includes(key)))
    throw new Error("Unsupported original history parameter");
  for (const key of ["throughItemId", "itemId", "cursor"] as const) {
    if (
      (key === "throughItemId" || options[key] !== undefined) &&
      (typeof options[key] !== "string" || !options[key]!.trim())
    )
      throw new Error(`${key} must be a non-empty string`);
  }
  const granularity = options.granularity ?? "items";
  if (granularity !== "items" && granularity !== "item")
    throw new Error("Original history granularity must be items or item");
  if ((granularity === "item") !== (options.itemId !== undefined))
    throw new Error("itemId is required only for item reads");
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error("limit must be between 1 and 50");
  return readThreadHistory(thread, {
    ...options,
    granularity,
    maxTurns: 1,
    maxItemsPerTurn: limit,
  }) as OriginalHistoryPage;
}
