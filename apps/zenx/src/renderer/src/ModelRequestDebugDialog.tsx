import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ModelRequestDebugCommand,
  ModelRequestDebugResult,
  ModelRequestDebugSummary,
  ModelRequestDebugView,
} from "../../../../cli/src/model-request-debug-types.js";
import { Icon } from "./icons.js";
type Props = { threadId?: string; currentSettings?: unknown; onClose?(): void };
/** Thread identity remounts the reader; pending replies cannot cross that boundary. */
export function ModelRequestDebugPanel(props: Props) {
  return <TraceReaderPanel key={props.threadId ?? ""} {...props} />;
}
function TraceReaderPanel({ threadId = "", currentSettings, onClose }: Props) {
  const { i18n } = useTranslation("shell");
  const zh = i18n.language.startsWith("zh");
  const tr = (en: string, cn: string) => (zh ? cn : en);
  const [state, setState] = useState<ModelRequestDebugResult | null>(null);
  const [page, setPage] = useState<ModelRequestDebugResult["page"]>();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState(threadId);
  const [mode, setMode] = useState<"requests" | "events">("requests");
  const [listOffset, setListOffset] = useState(0);
  const [offsets, setOffsets] = useState<number[]>([]);
  const [artifactIndex, setArtifactIndex] = useState(0);
  const [presentation, setPresentation] = useState<"raw" | "tree">("raw");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [narrow, setNarrow] = useState(true);
  const panel = useRef<HTMLDivElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    selectedButton = useRef<HTMLButtonElement | null>(null);
  const sequence = useRef(0),
    busyRef = useRef(false),
    focusDetail = useRef(false),
    focusList = useRef(false);
  const run = useCallback(async (input: ModelRequestDebugCommand) => {
    const epoch = ++sequence.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!window.zenx.modelRequestDebug)
        throw new Error("Local Trace reader unavailable");
      const result = await window.zenx.modelRequestDebug.request(input);
      if (epoch !== sequence.current) return;
      setState((previous) => ({
        ...result,
        records: result.records ?? previous?.records ?? [],
        totalRecords: result.totalRecords ?? previous?.totalRecords,
        nextOffset:
          result.nextOffset === undefined
            ? previous?.nextOffset
            : result.nextOffset,
      }));
      if (result.page) setPage(result.page);
    } catch (err) {
      if (epoch === sequence.current) {
        setError(err instanceof Error ? err.message : String(err));
        if (input.action === "read") setPage(undefined);
      }
    } finally {
      if (epoch === sequence.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, []);
  useEffect(() => {
    sequence.current++;
    setPage(undefined);
    setDetailOpen(false);
    setOffsets([]);
    setState(null);
    const timer = setTimeout(
      () =>
        void run({
          action: "list",
          threadId: scope,
          query,
          mode,
          offset: listOffset,
        }),
      query ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      sequence.current++;
    };
  }, [scope, query, mode, listOffset, run]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!busyRef.current)
        void run({
          action: "list",
          threadId: scope,
          query,
          mode,
          offset: listOffset,
        });
    }, 2000);
    return () => {
      clearInterval(timer);
      sequence.current++;
    };
  }, [scope, query, mode, listOffset, run]);
  useEffect(() => {
    if (!panel.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width <= 720);
    });
    observer.observe(panel.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (detailOpen && page && focusDetail.current) {
      heading.current?.focus({ preventScroll: true });
      focusDetail.current = false;
    }
    if (!detailOpen && focusList.current) {
      selectedButton.current?.focus({ preventScroll: true });
      focusList.current = false;
    }
  }, [detailOpen, page]);
  const select = (
    record: ModelRequestDebugSummary,
    view: ModelRequestDebugView = "payload",
    offset = 0,
    artifact = 0,
  ) => {
    setDetailOpen(true);
    setArtifactIndex(artifact);
    if (page?.record.id !== record.id || page.view !== view) setPage(undefined);
    void run({
      action: "read",
      threadId: record.threadId,
      id: record.id,
      view,
      offset,
      artifactIndex: artifact,
    });
  };
  const back = () => {
    sequence.current++;
    busyRef.current = false;
    setBusy(false);
    setDetailOpen(false);
    focusList.current = true;
  };
  const record = page?.record;
  return (
    <div
      className="trace-inspector"
      ref={panel}
      data-narrow={narrow}
      data-detail-open={detailOpen}
    >
      <header className="trace-inspector-controls">
        <strong>{tr("Durable Trace", "持久 Trace")}</strong>
        <span>{tr("Always on · read only", "常开 · 只读")}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run({
              action: "list",
              threadId: scope,
              query,
              mode,
              offset: listOffset,
            })
          }
        >
          {tr("Refresh index", "刷新索引")}
        </button>
        {onClose && (
          <button type="button" onClick={onClose}>
            {tr("Close", "关闭")}
          </button>
        )}
      </header>
      <div className="trace-inspector-toolbar">
        <label>
          {tr("Scope", "范围")}{" "}
          <select
            aria-label={tr("Scope", "范围")}
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setListOffset(0);
            }}
          >
            {threadId && (
              <option value={threadId}>{tr("This thread", "当前线程")}</option>
            )}
            <option value="">
              {tr("All local · includes title/probe", "本机全部 · 含标题/探测")}
            </option>
          </select>
        </label>
        <label>
          {tr("Evidence", "证据")}{" "}
          <select
            aria-label={tr("Evidence", "证据")}
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as "requests" | "events");
              setListOffset(0);
            }}
          >
            <option value="requests">{tr("Model requests", "模型请求")}</option>
            <option value="events">
              {tr("All events · tools", "全部事件 · 工具")}
            </option>
          </select>
        </label>
        <input
          aria-label={tr("Search metadata", "搜索元数据")}
          placeholder={tr("Search metadata, not body", "搜索元数据（非正文）")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setListOffset(0);
          }}
        />
      </div>
      <details className="trace-inspector-disclosure">
        <summary>
          {tr("Local evidence & privacy", "本机原始证据与隐私")}
        </summary>
        <p>
          {tr(
            "Full originals persist after restart. Only API keys in authentication headers are omitted; bodies are not redacted. Export cleaning is separate. No capture switch or clear action.",
            "完整原始记录重启后仍保留。仅省略认证请求头中的 API Key，正文不脱敏；导出清理另行处理。这里没有捕获开关或清空操作。",
          )}
        </p>
        <p>
          {tr(
            "Fetch invocation is not proof that the provider received a request. Prepared bytes alone do not prove dispatch. Missing history is never reconstructed as actual transport.",
            "发起 fetch 不证明提供方已收到请求；准备好的字节不证明已派发。缺失历史不会用模型上下文伪造。",
          )}
        </p>
        <p>
          {tr("Storage integrity", "日志完整性")}:{" "}
          {state?.completeness ?? "unknown"} · {tr("Writer health", "写入状态")}
          : {state?.durability ?? "unknown"} ·{" "}
          {tr("Artifacts verified on read", "内容读取时逐一校验")}
        </p>
        {state?.issues.map((issue, n) => (
          <p key={n}>
            {issue.kind}: {issue.message}
          </p>
        ))}
      </details>
      <details className="trace-inspector-disclosure">
        <summary>
          {tr(
            "Current UI settings — not the selected request",
            "当前界面设置 — 不是所选请求的设置",
          )}
        </summary>
        <pre>
          {currentSettings === undefined
            ? tr(
                "Current settings unavailable in this scope. Frozen settings remain in each captured sample.",
                "此范围未提供当前设置；每个样本的冻结设置可单独读取。",
              )
            : JSON.stringify(currentSettings, null, 2)}
        </pre>
      </details>
      {error && (
        <p className="trace-inspector-error" role="alert">
          {error}
        </p>
      )}
      {state && state.completeness !== "complete" && (
        <p className="trace-inspector-warning" role="status">
          {tr(
            "Evidence incomplete or unavailable. See integrity details; known facts remain visible.",
            "证据不完整或不可用。请查看完整性详情；已知事实仍保留。",
          )}
        </p>
      )}
      <div className="trace-inspector-body">
        <section
          className="trace-inspector-list"
          aria-label={tr("Trace records", "Trace 记录")}
          hidden={narrow && detailOpen}
        >
          {state?.records?.length === 0 && (
            <p>
              {tr(
                "No recorded evidence in this scope. Earlier uncaptured requests are unavailable.",
                "此范围没有记录。未捕获的早期请求不可用。",
              )}
            </p>
          )}
          {!state && !error && (
            <p role="status">
              {tr("Reading durable evidence…", "正在读取持久记录…")}
            </p>
          )}
          {state?.records?.map((r) => (
            <button
              key={r.id}
              type="button"
              className="trace-inspector-record"
              aria-pressed={record?.id === r.id}
              onClick={(e) => {
                selectedButton.current = e.currentTarget;
                focusDetail.current = true;
                setOffsets([]);
                select(r, mode === "events" ? "timeline" : "payload");
              }}
            >
              <span>
                <strong>{r.model === "unknown" ? r.type : r.model}</strong>
                <time>{r.capturedAt}</time>
              </span>
              <span>
                {r.purpose} · {r.type} · {tr("Attempt", "尝试")}{" "}
                {r.transportAttempt ?? "—"}
              </span>
              <EvidenceStatus record={r} zh={zh} />
            </button>
          ))}
          <footer className="trace-inspector-pagination">
            <button
              disabled={busy || listOffset === 0}
              onClick={() =>
                setListOffset(
                  Math.max(0, listOffset - (state?.limits.pageRecords ?? 100)),
                )
              }
            >
              {tr("Previous records", "前页记录")}
            </button>
            <span>{state?.totalRecords ?? 0}</span>
            <button
              disabled={busy || state?.nextOffset == null}
              onClick={() => setListOffset(state!.nextOffset!)}
            >
              {tr("Next records", "后页记录")}
            </button>
          </footer>
        </section>
        <section
          className="trace-inspector-detail"
          hidden={narrow && !detailOpen}
          aria-label={tr("Selected evidence", "所选证据")}
        >
          {detailOpen && (
            <button type="button" onClick={back}>
              {tr("Back to records", "返回记录")}
            </button>
          )}
          {page && record ? (
            <>
              <h3 ref={heading} tabIndex={-1}>
                {record.model === "unknown" ? record.type : record.model}
              </h3>
              <EvidenceStatus record={record} zh={zh} />
              {record.dispatch === "blocked" && (
                <p className="trace-inspector-warning">
                  {record.preparedRequestCaptured
                    ? tr(
                        "Prepared, blocked before fetch. These bytes were not sent by this attempt.",
                        "请求已准备，但在 fetch 前被阻止；本次尝试未发送这些字节。",
                      )
                    : tr(
                        "Blocked before request preparation. No request body exists for this attempt.",
                        "请求准备前已被阻止，本次尝试没有请求正文。",
                      )}
                </p>
              )}
              <p className="trace-inspector-note">
                {tr(
                  "Detail is a coherent read snapshot; refreshing the index does not silently change these bytes or their status.",
                  "详情是一次完整读取的快照；刷新索引不会悄悄改变这里的字节或状态。",
                )}
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  select(record, page.view, page.offset, artifactIndex)
                }
              >
                {tr("Reload selected evidence", "重新读取所选证据")}
              </button>
              <nav
                className="trace-inspector-views"
                aria-label={tr("Evidence view", "证据视图")}
              >
                {(
                  [
                    ["payload", tr("Request body", "请求正文")],
                    ["messages", tr("Messages & instructions", "消息与指令")],
                    ["tools", tr("Tool definitions", "工具定义")],
                    ["configuration", tr("Frozen settings", "冻结设置")],
                    ["output", tr("Response bytes", "响应字节")],
                    ["timeline", tr("Sample events", "样本事件")],
                    ["artifact", tr("Original artifact", "原始内容")],
                  ] as [ModelRequestDebugView, string][]
                ).map(([view, label]) => (
                  <button
                    key={view}
                    disabled={busy}
                    aria-pressed={view === page.view}
                    onClick={() => {
                      setOffsets([]);
                      select(record, view);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              {page.view === "artifact" && (
                <select
                  aria-label={tr("Artifact", "内容")}
                  value={artifactIndex}
                  onChange={(e) => {
                    setOffsets([]);
                    select(record, "artifact", 0, Number(e.target.value));
                  }}
                >
                  {record.artifacts.map((a, n) => (
                    <option key={n} value={n}>
                      {a.name} · {a.byteLength} B
                    </option>
                  ))}
                </select>
              )}
              <details className="trace-inspector-disclosure">
                <summary>
                  {tr("Timing & internal metadata", "耗时与内部元数据")}
                </summary>
                <p>
                  {tr(
                    "Whole sample (client, includes capture/provider work)",
                    "整个样本（客户端，含捕获与提供方处理）",
                  )}
                  : {record.sampleDurationMs ?? "unknown"} ms
                </p>
                <p>
                  {record.attemptTimingScope ??
                    tr("Attempt timing unknown", "尝试耗时未知")}
                  : {record.attemptDurationMs ?? "unknown"} ms
                </p>
                <pre>{JSON.stringify(record, null, 2)}</pre>
              </details>
              <div className="trace-inspector-presentation">
                <span>
                  {page.encoding} · {page.availability}
                </span>
                <button
                  aria-pressed={presentation === "raw"}
                  onClick={() => setPresentation("raw")}
                >
                  {tr("Raw", "原文")}
                </button>
                <button
                  aria-pressed={presentation === "tree"}
                  onClick={() => setPresentation("tree")}
                >
                  {tr("Tree", "结构")}
                </button>
              </div>
              <div className="trace-inspector-detail-scroll">
                <RequestContent
                  key={`${record.id}:${page.view}:${page.offset}:${artifactIndex}:${presentation}`}
                  text={page.text}
                  structured={
                    presentation === "tree" &&
                    page.encoding === "utf8" &&
                    page.offset === 0 &&
                    page.nextOffset === null
                  }
                />
              </div>
              <footer className="trace-inspector-pagination">
                <button
                  disabled={busy || offsets.length === 0}
                  onClick={() => {
                    const previous = offsets.at(-1)!;
                    setOffsets(offsets.slice(0, -1));
                    select(record, page.view, previous, artifactIndex);
                  }}
                >
                  {tr("Previous page", "上一页")}
                </button>
                <span>
                  {tr("Characters", "字符")}{" "}
                  {page.offset + (page.text.length ? 1 : 0)}–
                  {page.offset + page.text.length} / {page.totalCharacters}
                </span>
                <button
                  disabled={busy || page.nextOffset === null}
                  onClick={() => {
                    setOffsets([...offsets, page.offset]);
                    select(record, page.view, page.nextOffset!, artifactIndex);
                  }}
                >
                  {tr("Next page", "下一页")}
                </button>
              </footer>
            </>
          ) : (
            <p>
              {busy
                ? tr("Reading…", "读取中…")
                : tr(
                    "Select evidence to inspect originals.",
                    "选择记录以查看原始证据。",
                  )}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
function EvidenceStatus({
  record: r,
  zh,
}: {
  record: ModelRequestDebugSummary;
  zh: boolean;
}) {
  return (
    <span className="trace-inspector-status">
      <span>
        {zh ? "样本结果" : "Sample outcome"}: {r.sampleOutcome}
      </span>
      <span>
        {zh ? "派发证据" : "Dispatch evidence"}: {r.dispatch}
      </span>
      <span>
        {zh ? "原始响应捕获" : "Raw response capture"}: {r.responseCapture}
      </span>
    </span>
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
        <span key={match.index} className={`trace-inspector-json-${kind}`}>
          {token}
        </span>,
      );
      offset = match.index + token.length;
    }
    result.push(text.slice(offset));
    return result;
  }, [text]);
  return (
    <pre className="trace-inspector-payload" tabIndex={0}>
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
    <div className="trace-inspector-tree" tabIndex={0}>
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
      <div className="trace-inspector-tree-leaf">
        <span className="trace-inspector-tree-key">{name}</span>
        <span
          className={`trace-inspector-tree-value ${typeof value === "string" ? "string" : "literal"}`}
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
    <div className="trace-inspector-tree-node">
      <button
        type="button"
        className="trace-inspector-tree-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} />
        <span className="trace-inspector-tree-key">{name}</span>
        {hint && <span className="trace-inspector-tree-hint">{hint}</span>}
        <span className="trace-inspector-tree-count">
          {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
      </button>
      {open && (
        <div className="trace-inspector-tree-children">
          {entries.map(([key, child]) => (
            <JsonNode key={key} name={key} value={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
