import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
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
  const [detailOpen, setDetailOpen] = useState(false);
  const [narrow, setNarrow] = useState(true);
  const panel = useRef<HTMLDivElement>(null);
  const detailHeading = useRef<HTMLDivElement>(null);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const focusDetail = useRef(false);
  const focusList = useRef(false);
  const detailScroller = useRef<HTMLDivElement>(null);
  const captureInfo = useRef<HTMLDetailsElement>(null);
  const disclosureId = useId();
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const info = captureInfo.current;
      if (info?.open && !info.contains(event.target as Node)) info.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  const sequence = useRef(0);
  useEffect(() => {
    const element = panel.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width <= 720);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (page && detailOpen && focusDetail.current) {
      focusDetail.current = false;
      detailHeading.current?.focus({ preventScroll: true });
    }
    if (!detailOpen && focusList.current) {
      focusList.current = false;
      selectedButton.current?.focus({ preventScroll: true });
    }
  }, [page, detailOpen]);
  useEffect(() => {
    if (detailScroller.current) detailScroller.current.scrollTop = 0;
  }, [page?.record.id, page?.view, page?.offset]);
  useEffect(() => {
    if (
      narrow &&
      detailOpen &&
      selectedButton.current === document.activeElement
    ) {
      detailHeading.current?.focus({ preventScroll: true });
    }
  }, [narrow, detailOpen]);
  const current = useRef<ModelRequestDebugResult | null>(null);
  const busyRef = useRef(false);
  const run = useCallback(async (input: ModelRequestDebugCommand) => {
    const version = ++sequence.current;
    busyRef.current = true;
    setBusy(true);
    setError(false);
    if (input.action === "clear" || input.action === "setEnabled") {
      setPage(undefined);
      setDetailOpen(false);
    }
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
        setDetailOpen(false);
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
      if (result.page) {
        setPage(result.page);
      }
    } catch {
      if (version === sequence.current) {
        setError(true);
        setPage(undefined);
        setDetailOpen(false);
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
  ) => {
    if (page?.record.id !== id) setPage(undefined);
    setDetailOpen(true);
    void run({ action: "read", id, view, offset });
  };
  const back = () => {
    setDetailOpen(false);
    focusList.current = true;
  };
  const record = page?.record;
  return (
    <div className="model-debug-panel" ref={panel} data-narrow={narrow}>
      <header className="model-debug-controls">
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
          aria-describedby={!state?.enabled ? disclosureId : undefined}
          disabled={state === null || busy}
          onClick={() =>
            void run({ action: "setEnabled", enabled: !state?.enabled })
          }
        >
          <span />
        </button>
        <span className="model-debug-control-spacer" />
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
        <details
          className="model-debug-capture-info"
          ref={captureInfo}
          onKeyDown={(event) => {
            if (event.key === "Escape" && event.currentTarget.open) {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary
            aria-label={t("modelDebugCaptureInfo")}
            title={t("modelDebugCaptureInfo")}
          >
            <Icon name="lock" />
          </summary>
          <div>
            <strong>{t("modelDebugLocal")}</strong>
            <p>{t("modelDebugPrivacy")}</p>
            {state ? (
              <p>
                {t("modelDebugRetention", {
                  count: state.retainedCount,
                  used: (state.retainedBytes / 1048576).toFixed(1),
                  limit: (state.limits.maxBytes / 1048576).toFixed(0),
                  evicted: state.evictedCount,
                })}
              </p>
            ) : null}
          </div>
        </details>
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
      </header>
      {!state?.enabled ? (
        <p className="model-debug-consent" id={disclosureId}>
          {t("modelDebugPrivacySummary")}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {t("modelDebugError")}
        </p>
      ) : null}
      <div
        className="model-debug-body"
        aria-busy={busy}
        data-detail={detailOpen}
      >
        <aside className="model-debug-sidebar" hidden={narrow && detailOpen}>
          <div className="model-debug-list-heading">
            <span className="model-debug-scope" title={threadId}>
              {threadId
                ? t("modelDebugCurrentThread")
                : t("modelDebugAllThreads")}
            </span>
            <span>{state?.records?.length ?? 0}</span>
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
            {(state?.records ?? []).map((entry) => (
              <button
                type="button"
                key={entry.id}
                className={`model-debug-request${record?.id === entry.id ? " selected" : ""}`}
                onClick={(event) => {
                  selectedButton.current = event.currentTarget;
                  focusDetail.current = true;
                  setOffsets([]);
                  select(entry.id);
                }}
                aria-current={record?.id === entry.id ? "true" : undefined}
              >
                <span className="model-debug-request-heading">
                  <strong title={`${entry.provider} / ${entry.model}`}>
                    {entry.model}
                  </strong>
                  <time>
                    {new Date(entry.capturedAt).toLocaleTimeString([], {
                      hour12: false,
                    })}
                  </time>
                </span>
                <span className="model-debug-request-meta">
                  <span>
                    {entry.purpose === "compaction"
                      ? t("modelDebugCompaction")
                      : t("modelDebugTurn")}{" "}
                    · {entry.format}
                  </span>
                  <span>{(entry.retainedBytes / 1024).toFixed(1)} KB</span>
                </span>
                <span className="model-debug-request-meta">
                  <span
                    title={t("modelDebugAttempt", {
                      sample: entry.sampleAttempt,
                      transport: entry.transportAttempt,
                    })}
                  >
                    S{entry.sampleAttempt} / HTTP {entry.transportAttempt}
                  </span>
                  <span
                    className="model-debug-request-integrity"
                    data-warning={
                      entry.truncated ||
                      entry.redacted ||
                      entry.format === "model-input"
                    }
                  >
                    {[
                      entry.format === "model-input"
                        ? t("modelDebugProjection")
                        : null,
                      entry.truncated ? t("modelDebugTruncatedShort") : null,
                      entry.redacted ? t("modelDebugRedactedShort") : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || t("modelDebugCompleteShort")}
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
          hidden={narrow && !detailOpen}
        >
          {page && record ? (
            <>
              <div
                className="model-debug-detail-heading"
                tabIndex={-1}
                ref={detailHeading}
              >
                {narrow ? (
                  <button
                    type="button"
                    className="model-debug-back"
                    aria-label={t("modelDebugBack")}
                    onClick={back}
                  >
                    <Icon name="chevron-left" />
                    {t("modelDebugBackShort")}
                  </button>
                ) : null}
                <strong title={`${record.provider} / ${record.model}`}>
                  {record.provider} / {record.model}
                </strong>
              </div>
              <div className="model-debug-content-toolbar">
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
                      aria-label={t(`modelDebugView_${view}`)}
                      title={t(`modelDebugView_${view}`)}
                      aria-pressed={page.view === view}
                      disabled={
                        busy || (record.truncated && view !== "payload")
                      }
                      onClick={() => {
                        setOffsets([]);
                        select(record.id, view);
                      }}
                    >
                      {t(`modelDebugCompactView_${view}`)}
                    </button>
                  ))}
                </div>
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
                    aria-label={t("modelDebugRaw")}
                    aria-pressed={presentation === "raw"}
                    onClick={() => setPresentation("raw")}
                  >
                    {t("modelDebugRawShort")}
                  </button>
                </div>
              </div>
              <div
                className="model-debug-detail-scroll"
                tabIndex={0}
                ref={detailScroller}
              >
                <details className="model-debug-record-info" key={record.id}>
                  <summary>
                    <span>{t("modelDebugDetail")}</span>
                    <span className="model-debug-integrity-flags">
                      {record.format === "model-input" ? (
                        <span>{t("modelDebugProjection")}</span>
                      ) : null}
                      {record.truncated ? (
                        <span>{t("modelDebugTruncatedShort")}</span>
                      ) : null}
                      {record.redacted ? (
                        <span>{t("modelDebugRedactedShort")}</span>
                      ) : null}
                    </span>
                    <span className="model-debug-bytes">
                      {(record.retainedBytes / 1024).toFixed(1)} KB
                    </span>
                  </summary>
                  <div className="model-debug-record-metadata">
                    <p>
                      {record.format === "model-input"
                        ? t("modelDebugUnsupported")
                        : t("modelDebugDispatchNote")}
                    </p>
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
                    <p>
                      {t("modelDebugBytes", {
                        retained: record.retainedBytes,
                        original: record.originalBytes,
                      })}
                    </p>
                    <p>
                      {record.format} ·{" "}
                      {t("modelDebugAttempt", {
                        sample: record.sampleAttempt,
                        transport: record.transportAttempt,
                      })}
                    </p>
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
                    {record.sourceAttachmentCount > 0 ? (
                      <details className="model-debug-identities">
                        <summary>
                          {t("modelDebugAttachments", {
                            count: record.sourceAttachmentCount,
                            shown: record.sourceAttachments.length,
                          })}
                        </summary>
                        <p>{t("modelDebugAttachmentsNote")}</p>
                        <pre>
                          {JSON.stringify(record.sourceAttachments, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                </details>
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
                {page.nextOffset !== null || page.offset > 0 ? (
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
                ) : null}
              </div>
            </>
          ) : (
            <div className="model-debug-welcome">
              <p>{t("modelDebugSelect")}</p>
            </div>
          )}
        </section>
      </div>
    </div>
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
