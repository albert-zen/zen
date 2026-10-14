import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ModelRequestDebugCommand,
  ModelRequestDebugResult,
  ModelRequestDebugView,
} from "../../../../cli/src/model-request-debug-types.js";
import { Icon } from "./icons.js";

/** This control always addresses the local owned Host. Remote thread surfaces never mount it. */
export function ModelRequestDebugPanel({
  threadId = "",
  onClose,
}: {
  threadId?: string;
  onClose?(): void;
}) {
  const { t } = useTranslation("shell");
  const [state, setState] = useState<ModelRequestDebugResult | null>(null);
  const [page, setPage] = useState<ModelRequestDebugResult["page"]>(undefined);
  const [query, setQuery] = useState("");
  const [presentation, setPresentation] = useState<"tree" | "raw">("tree");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [offsets, setOffsets] = useState<number[]>([]);
  const sequence = useRef(0);
  const current = useRef<ModelRequestDebugResult | null>(null);
  const busyRef = useRef(false);
  const run = useCallback(async (input: ModelRequestDebugCommand) => {
    const version = ++sequence.current;
    busyRef.current = true;
    setBusy(true);
    setError(false);
    if (
      input.action === "clear" ||
      input.action === "setEnabled" ||
      input.action === "read"
    )
      setPage(undefined);
    try {
      const bridge = window.zenx.modelRequestDebug;
      if (!bridge) throw new Error("Local model debug unavailable");
      const result = await bridge.request(input);
      if (version !== sequence.current) return;
      if (
        current.current?.sessionId !== result.sessionId ||
        current.current.generation !== result.generation
      ) {
        setPage(undefined);
        setOffsets([]);
      }
      const next = {
        ...result,
        records:
          result.records ??
          (current.current?.sessionId === result.sessionId &&
          current.current.generation === result.generation
            ? current.current.records
            : []),
      };
      current.current = next;
      setState(next);
      if (result.page) setPage(result.page);
    } catch {
      if (version === sequence.current) {
        setError(true);
        setPage(undefined);
      }
    } finally {
      if (version === sequence.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, []);
  useEffect(() => {
    const timer = setTimeout(
      () => {
        void run({ action: "list", threadId, query });
      },
      query.length > 0 ? 200 : 0,
    );
    return () => {
      clearTimeout(timer);
      sequence.current += 1;
    };
  }, [threadId, query, run]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!busyRef.current && current.current?.enabled)
        void run({ action: "list", threadId, query });
    }, 2000);
    return () => {
      clearInterval(timer);
      sequence.current += 1;
    };
  }, [threadId, query, run]);
  const select = (
    id: string,
    view: ModelRequestDebugView = "payload",
    offset = 0,
  ) => void run({ action: "read", id, view, offset });
  const record = page?.record;
  return (
    <>
      <header className="model-debug-header">
        <div>
          <p className="model-debug-eyebrow">{t("modelDebugLocal")}</p>
          <h2>{t("modelDebugTitle")}</h2>
        </div>
        <div className="model-debug-header-actions">
          <span
            className={state?.enabled ? "model-debug-live" : "model-debug-off"}
            role="status"
          >
            {state?.enabled ? t("modelDebugOn") : t("modelDebugOff")}
          </span>
          <button
            className="model-debug-switch"
            type="button"
            role="switch"
            aria-checked={state?.enabled ?? false}
            aria-label={
              state?.enabled ? t("modelDebugDisable") : t("modelDebugEnable")
            }
            title={
              state?.enabled ? t("modelDebugDisable") : t("modelDebugEnable")
            }
            disabled={state === null || busy}
            onClick={() =>
              void run({ action: "setEnabled", enabled: !state?.enabled })
            }
          >
            <span />
          </button>
          <span className="model-debug-action-divider" />
          <button
            className="icon-button"
            type="button"
            aria-label={t("modelDebugRefresh")}
            title={t("modelDebugRefresh")}
            disabled={busy}
            onClick={() => void run({ action: "list", threadId, query })}
          >
            <Icon name="reload" />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={t("modelDebugClear")}
            title={t("modelDebugClear")}
            disabled={!state?.retainedCount || busy}
            onClick={() => void run({ action: "clear" })}
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              aria-hidden="true"
            >
              <path d="M3 4.5h10M6 4.5V2.8h4v1.7M4.2 4.5l.6 8.7h6.4l.6-8.7M6.5 7v3.8M9.5 7v3.8" />
            </svg>
          </button>
          {onClose ? (
            <button
              className="icon-button"
              type="button"
              aria-label={t("modelDebugClose")}
              onClick={onClose}
            >
              <Icon name="x" />
            </button>
          ) : null}
        </div>
      </header>
      {error ? (
        <p className="form-error" role="alert">
          {t("modelDebugError")}
        </p>
      ) : null}
      <div className="model-debug-body" aria-busy={busy}>
        <aside className="model-debug-sidebar">
          <div className="model-debug-sidebar-title">
            <strong>{t("modelDebugRequests")}</strong>
            <span>{state?.records?.length ?? 0}</span>
          </div>
          <div className="model-debug-scope" title={threadId}>
            {threadId
              ? t("modelDebugCurrentThread")
              : t("modelDebugAllThreads")}
          </div>
          <label className="model-debug-search">
            <span className="sr-only">{t("modelDebugSearch")}</span>
            <input
              value={query}
              maxLength={1000}
              placeholder={t("modelDebugSearch")}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <div
            className="model-debug-list"
            aria-label={t("modelDebugRequests")}
          >
            {(state?.records ?? []).map((entry, index) => (
              <button
                type="button"
                key={entry.id}
                className={`model-debug-request${record?.id === entry.id ? " selected" : ""}`}
                onClick={() => {
                  setOffsets([]);
                  select(entry.id);
                }}
                aria-expanded={record?.id === entry.id}
              >
                <span className="model-debug-request-index">
                  {String((state?.records?.length ?? 0) - index).padStart(
                    2,
                    "0",
                  )}
                </span>
                <span className="model-debug-request-content">
                  <span className="model-debug-request-heading">
                    <strong>{entry.model}</strong>
                    <time>
                      {new Date(entry.capturedAt).toLocaleTimeString([], {
                        hour12: false,
                      })}
                    </time>
                  </span>
                  <span className="model-debug-request-meta">
                    {entry.purpose === "compaction"
                      ? t("modelDebugCompaction")
                      : t("modelDebugTurn")}
                    <span>·</span>
                    {entry.format}
                  </span>
                  <span className="model-debug-request-meta">
                    <span
                      className="model-debug-attempt"
                      title={t("modelDebugAttempt", {
                        sample: entry.sampleAttempt,
                        transport: entry.transportAttempt,
                      })}
                    >
                      S{entry.sampleAttempt} / HTTP {entry.transportAttempt}
                    </span>
                    <span className="model-debug-request-size">
                      {(entry.retainedBytes / 1024).toFixed(1)} KB
                    </span>
                  </span>
                  <span
                    className="model-debug-request-integrity"
                    data-warning={
                      entry.truncated ||
                      entry.redacted ||
                      entry.format === "model-input"
                    }
                  >
                    {entry.format === "model-input"
                      ? t("modelDebugProjection")
                      : entry.truncated
                        ? t("modelDebugTruncated")
                        : entry.redacted
                          ? t("modelDebugRedacted")
                          : t("modelDebugComplete")}
                  </span>
                </span>
              </button>
            ))}
            {!state?.records?.length ? (
              <p className="model-debug-empty">
                {query ? t("modelDebugNoMatches") : t("modelDebugEmpty")}
              </p>
            ) : null}
          </div>
        </aside>
        <section
          className="model-debug-detail"
          aria-label={t("modelDebugDetail")}
        >
          {page && record ? (
            <>
              <div className="model-debug-detail-heading">
                <div>
                  <span className="model-debug-inspector-label">
                    {record.provider} / {record.model}
                  </span>
                  <strong>
                    {record.format === "model-input"
                      ? t("modelDebugProjection")
                      : t("modelDebugDispatch")}
                  </strong>
                </div>
                <span>
                  {t("modelDebugBytes", {
                    retained: record.retainedBytes,
                    original: record.originalBytes,
                  })}
                </span>
              </div>
              {record.truncated ? (
                <p className="model-debug-warning">
                  {t("modelDebugTruncatedWarning")}
                </p>
              ) : null}
              {record.redacted ? (
                <p className="model-debug-warning">
                  {t("modelDebugRedactedWarning")}
                </p>
              ) : null}
              {record.format === "model-input" ? (
                <p className="model-debug-warning">
                  {t("modelDebugUnsupported")}
                </p>
              ) : (
                <p className="model-debug-note">
                  {t("modelDebugDispatchNote")}
                </p>
              )}
              <div
                className="model-debug-views"
                role="group"
                aria-label={t("modelDebugViews")}
              >
                {(
                  ["payload", "messages", "tools", "configuration"] as const
                ).map((view) => (
                  <button
                    key={view}
                    type="button"
                    className="model-debug-tab"
                    aria-pressed={page.view === view}
                    disabled={busy || (record.truncated && view !== "payload")}
                    onClick={() => {
                      setOffsets([]);
                      select(record.id, view);
                    }}
                  >
                    {t(`modelDebugView_${view}`)}
                  </button>
                ))}
              </div>
              <div className="model-debug-content-toolbar">
                <span>
                  {page.view === "payload"
                    ? record.format
                    : t(`modelDebugView_${page.view}`)}
                </span>
                <div
                  className="model-debug-presentation"
                  role="group"
                  aria-label={t("modelDebugPresentation")}
                >
                  <button
                    type="button"
                    aria-pressed={presentation === "tree"}
                    onClick={() => setPresentation("tree")}
                  >
                    {t("modelDebugTree")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={presentation === "raw"}
                    onClick={() => setPresentation("raw")}
                  >
                    {t("modelDebugRaw")}
                  </button>
                </div>
              </div>
              <RequestContent
                key={`${record.id}:${page.view}:${page.offset}:${presentation}`}
                text={page.text}
                structured={
                  presentation === "tree" &&
                  !record.truncated &&
                  page.offset === 0 &&
                  page.nextOffset === null
                }
              />
              <details className="model-debug-identities">
                <summary>{t("modelDebugIdentity")}</summary>
                <dl>
                  <dt>Thread</dt>
                  <dd>{record.threadId}</dd>
                  <dt>Turn</dt>
                  <dd>{record.turnId ?? t("modelDebugNoTurn")}</dd>
                  <dt>Sample</dt>
                  <dd>{record.sampleId}</dd>
                  <dt>{t("modelDebugBoundary")}</dt>
                  <dd>{record.contextBoundaryItemId}</dd>
                </dl>
              </details>
              {record.sourceAttachmentCount > 0 ? (
                <details className="model-debug-identities">
                  <summary>
                    {t("modelDebugAttachments", {
                      count: record.sourceAttachmentCount,
                      shown: record.sourceAttachments.length,
                    })}
                  </summary>
                  <p>{t("modelDebugAttachmentsNote")}</p>
                  <pre>{JSON.stringify(record.sourceAttachments, null, 2)}</pre>
                </details>
              ) : null}

              <footer className="model-debug-pagination">
                <button
                  className="icon-button"
                  type="button"
                  aria-label={t("modelDebugPrevious")}
                  title={t("modelDebugPrevious")}
                  disabled={busy || offsets.length === 0}
                  onClick={() => {
                    const previous = offsets.at(-1)!;
                    setOffsets(offsets.slice(0, -1));
                    select(record.id, page.view, previous);
                  }}
                >
                  <Icon name="chevron-left" />
                </button>
                <span>
                  {t("modelDebugPage", {
                    start: page.offset + 1,
                    end: page.offset + page.text.length,
                    total: page.totalCharacters,
                  })}
                </span>
                <button
                  className="icon-button"
                  type="button"
                  aria-label={t("modelDebugNext")}
                  title={t("modelDebugNext")}
                  disabled={busy || page.nextOffset === null}
                  onClick={() => {
                    setOffsets([...offsets, page.offset]);
                    select(record.id, page.view, page.nextOffset!);
                  }}
                >
                  <Icon name="chevron-right" />
                </button>
              </footer>
            </>
          ) : (
            <div className="model-debug-welcome">
              <span className="model-debug-welcome-icon" aria-hidden="true">
                {"{ }"}
              </span>
              <h3>
                {state?.enabled
                  ? t("modelDebugInspectTitle")
                  : t("modelDebugStartTitle")}
              </h3>
              <p>
                {state?.enabled ? t("modelDebugSelect") : t("modelDebugEmpty")}
              </p>
              {!state?.enabled && (
                <button
                  type="button"
                  className="primary-button"
                  disabled={state === null || busy}
                  onClick={() =>
                    void run({ action: "setEnabled", enabled: true })
                  }
                >
                  {t("modelDebugEnable")}
                </button>
              )}
              <span>{t("modelDebugLocal")}</span>
            </div>
          )}
        </section>
      </div>
      <footer className="model-debug-footer">
        {" "}
        <details className="model-debug-privacy">
          <summary>
            <Icon name="lock" />
            <span>{t("modelDebugPrivacySummary")}</span>
            <span className="model-debug-privacy-more">
              {t("modelDebugPrivacyMore")}
            </span>
            <Icon name="chevron-down" />
          </summary>
          <p>{t("modelDebugPrivacy")}</p>
        </details>
        {state && (
          <span className="model-debug-retention">
            {t("modelDebugRetention", {
              count: state.retainedCount,
              used: (state.retainedBytes / 1048576).toFixed(1),
              limit: (state.limits.maxBytes / 1048576).toFixed(0),
              evicted: state.evictedCount,
            })}
          </span>
        )}
      </footer>
    </>
  );
}

/** Presentation-only token colors; concatenated text stays exactly equal to the retained page. */
function RequestJson({ text }: { text: string }) {
  const tokens = useMemo(() => {
    const pattern =
      /"(?:\\.|[^"\\])*"(?:\s*(?=:))?|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
    const result: React.ReactNode[] = [];
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      result.push(text.slice(offset, match.index));
      const token = match[0];
      const kind = token.startsWith('"')
        ? text[match.index + token.length] === ":"
          ? "key"
          : "string"
        : "literal";
      result.push(
        <span key={match.index} className={`model-debug-json-${kind}`}>
          {token}
        </span>,
      );
      offset = match.index + token.length;
    }
    result.push(text.slice(offset));
    return result;
  }, [text]);
  return (
    <pre className="model-debug-payload" tabIndex={0}>
      <code>{tokens}</code>
    </pre>
  );
}

/** A reversible presentation of a complete retained page. Never reconstruct partial JSON. */
function RequestContent({
  text,
  structured,
}: {
  text: string;
  structured: boolean;
}) {
  let value: unknown;
  try {
    if (!structured) return <RequestJson text={text} />;
    value = JSON.parse(text);
  } catch {
    return <RequestJson text={text} />;
  }
  return (
    <div className="model-debug-tree" tabIndex={0}>
      <JsonNode value={value} depth={0} name="$" />
    </div>
  );
}
function JsonNode({
  value,
  name,
  depth,
}: {
  value: unknown;
  name: string;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  const object = typeof value === "object" && value !== null;
  const entries = object ? Object.entries(value) : [];
  if (!object || depth >= 12)
    return (
      <div className="model-debug-tree-leaf">
        <span className="model-debug-tree-key">{name}</span>
        <span
          className={`model-debug-tree-value ${typeof value === "string" ? "string" : "literal"}`}
        >
          {typeof value === "string" ? value : JSON.stringify(value)}
        </span>
      </div>
    );
  const record = value as Record<string, unknown>;
  const hint =
    typeof record.role === "string"
      ? record.role
      : typeof record.name === "string"
        ? record.name
        : typeof record.type === "string"
          ? record.type
          : null;
  return (
    <div className="model-debug-tree-node">
      <button
        type="button"
        className="model-debug-tree-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} />
        <span className="model-debug-tree-key">{name}</span>
        {hint && <span className="model-debug-tree-hint">{hint}</span>}
        <span className="model-debug-tree-count">
          {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
      </button>
      {open && (
        <div className="model-debug-tree-children">
          {entries.map(([key, child]) => (
            <JsonNode key={key} name={key} value={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
