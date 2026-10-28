import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ContextCompactionItem } from "../../../../../src/item.js";
import type {
  OriginalHistoryPage,
  PublicHistoryItem,
} from "../../../../../src/thread-history.js";
import { i18n } from "./i18n.js";

type Scope = { threadId: string; throughItemId: string };
type ItemPage = Extract<OriginalHistoryPage, { granularity: "items" }>;
type DetailPage = Extract<OriginalHistoryPage, { granularity: "item" }>;

/** Mounted only for the selected view; unmount discards late read results. */
export function OriginalHistory({ item }: { item: ContextCompactionItem }) {
  useTranslation("shell");
  if (item.includeOriginalReference !== true)
    return (
      <p className="original-history-unavailable">
        {i18n.t("shell:originalHistoryReferenceUnavailable")}
      </p>
    );
  return (
    <OriginalHistoryReader
      key={`${item.threadId}:${item.id}:${item.coveredThroughItemId}`}
      threadId={item.threadId}
      throughItemId={item.coveredThroughItemId}
    />
  );
}

function OriginalHistoryReader(scope: Scope) {
  const [cursors, setCursors] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const cursor = cursors.at(-1);
  const [page, setPage] = useState<ItemPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    setPage(null);
    void (async () => {
      try {
        const result = await window.zenx.protocol.request(
          "zen/thread/original/read",
          {
            threadId: scope.threadId,
            throughItemId: scope.throughItemId,
            limit: 50,
            ...(cursor === undefined ? {} : { cursor }),
          },
        );
        if (
          result.granularity !== "items" ||
          result.threadId !== scope.threadId ||
          result.snapshotThroughItemId !== scope.throughItemId
        )
          throw new Error(i18n.t("shell:originalHistoryResponseMismatch"));
        if (current) setPage(result);
      } catch (reason) {
        if (current)
          setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [scope.threadId, scope.throughItemId, cursor, attempt]);
  return (
    <section
      className="original-history-reader"
      aria-label={i18n.t("shell:originalHistory")}
      aria-busy={loading}
    >
      <p>{i18n.t("shell:originalHistoryExplanation")}</p>
      {loading ? (
        <p role="status">{i18n.t("shell:loadingOriginalHistory")}</p>
      ) : null}
      {error ? (
        <div role="alert">
          <p>
            {i18n.t("shell:originalHistoryReadFailed")} {error}
          </p>
          <button
            type="button"
            className="quiet-button"
            onClick={() => setAttempt(attempt + 1)}
          >
            {i18n.t("shell:retryOriginalHistory")}
          </button>
        </div>
      ) : null}
      {page ? (
        <>
          <p className="original-history-count">
            {i18n.t("shell:originalHistoryPageCount", {
              count: page.items.length,
            })}
          </p>
          <ol className="original-history-items">
            {page.items.map((item) => (
              <OriginalHistoryItem
                key={item.itemId}
                scope={scope}
                item={item}
              />
            ))}
          </ol>
        </>
      ) : null}
      <nav
        className="original-history-pages"
        aria-label={i18n.t("shell:originalHistoryPages")}
      >
        <button
          type="button"
          className="quiet-button"
          disabled={loading || cursors.length < 2}
          onClick={() => setCursors((current) => current.slice(0, -1))}
        >
          {i18n.t("shell:newerOriginalItems")}
        </button>
        <button
          type="button"
          className="quiet-button"
          disabled={loading || page?.nextCursor == null}
          onClick={() => {
            if (page?.nextCursor)
              setCursors((current) => [...current, page.nextCursor!]);
          }}
        >
          {i18n.t("shell:olderOriginalItems")}
        </button>
      </nav>
    </section>
  );
}

function OriginalHistoryItem({
  scope,
  item,
}: {
  scope: Scope;
  item: PublicHistoryItem;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        className="original-history-item-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <strong>{originalItemLabel(item)}</strong>
        {Number.isNaN(Date.parse(item.createdAt)) ? null : (
          <time
            dateTime={item.createdAt}
            title={i18n.t("shell:originalRecordTime")}
          >
            {new Intl.DateTimeFormat(i18n.resolvedLanguage, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }).format(new Date(item.createdAt))}
          </time>
        )}
        <span>
          {i18n.t(
            open
              ? "shell:hideOriginalItemDetails"
              : "shell:originalItemDetails",
          )}
        </span>
      </button>
      {item.text ? (
        <pre className="original-history-body">{item.text}</pre>
      ) : null}
      {item.textTruncated ? (
        <small>{i18n.t("shell:originalItemExcerpt")}</small>
      ) : null}
      {open ? <OriginalItemDetail scope={scope} itemId={item.itemId} /> : null}
    </li>
  );
}

function originalItemLabel(item: PublicHistoryItem): string {
  if (item.type === "user_message") return i18n.t("shell:user");
  if (item.type === "agent_message") return i18n.t("shell:assistant");
  if (item.type === "tool_result") return i18n.t("shell:originalToolResult");
  if (item.type === "tool_call") return i18n.t("shell:tool");
  if (item.type === "reasoning") return i18n.t("shell:reasoning");
  if (
    item.type === "host_message" ||
    item.type === "thread_message" ||
    item.type === "thread_instruction"
  )
    return i18n.t("shell:originalInstruction");
  if (item.type === "context_compaction")
    return i18n.t("shell:contextCompacted");
  return i18n.t("shell:originalRecord");
}

function OriginalItemDetail({
  scope,
  itemId,
}: {
  scope: Scope;
  itemId: string;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [chunks, setChunks] = useState("");
  const [page, setPage] = useState<DetailPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const result = await window.zenx.protocol.request(
          "zen/thread/original/read",
          {
            ...scope,
            granularity: "item",
            itemId,
            ...(cursor === undefined ? {} : { cursor }),
          },
        );
        if (
          result.granularity !== "item" ||
          result.itemId !== itemId ||
          result.threadId !== scope.threadId ||
          result.snapshotThroughItemId !== scope.throughItemId
        )
          throw new Error(i18n.t("shell:originalHistoryResponseMismatch"));
        if (current) {
          setChunks(
            (previous) => previous.slice(0, result.offset) + result.content,
          );
          setPage(result);
        }
      } catch (reason) {
        if (current)
          setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [scope.threadId, scope.throughItemId, itemId, cursor, attempt]);
  let content = chunks;
  if (page?.nextCursor === null) {
    try {
      content = JSON.stringify(JSON.parse(chunks), null, 2);
    } catch {
      /* A partial response stays visibly partial. */
    }
  }
  return (
    <div className="original-history-item-detail">
      <p>{i18n.t("shell:originalItemJson")}</p>
      <pre>{content}</pre>
      {loading ? (
        <p role="status">{i18n.t("shell:loadingOriginalHistory")}</p>
      ) : null}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button
            className="quiet-button"
            type="button"
            onClick={() => setAttempt(attempt + 1)}
          >
            {i18n.t("shell:retryOriginalHistory")}
          </button>
        </div>
      ) : null}
      {page?.nextCursor ? (
        <button
          type="button"
          className="quiet-button"
          disabled={loading}
          onClick={() => setCursor(page.nextCursor!)}
        >
          {i18n.t("shell:readMoreOriginalItem", {
            read: chunks.length,
            total: page.totalLength,
          })}
        </button>
      ) : null}
    </div>
  );
}
