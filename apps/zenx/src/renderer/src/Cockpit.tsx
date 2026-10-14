import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { publicItemValue } from "../../public-item.js";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ThreadSnapshot } from "../../../../../src/app-server.js";
import type { CanonicalItem, ToolResultItem } from "../../../../../src/item.js";
import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import { IsolatedPluginSurface, type PluginUiSdkV1 } from "./plugin-ui-host.js";
import { usePluginTheme } from "./ui/plugin-theme.js";
import {
  COCKPIT_CONTENT_TYPE,
  COCKPIT_STALE_MS,
  cockpitEventText,
  cockpitGroup,
  cockpitInterrupt,
  cockpitSend,
  readCockpitComponent,
} from "./cockpit-model.js";

export interface CockpitProps {
  summaries: readonly NativeThreadSummary[];
  approvals: ReadonlySet<string>;
  connected: boolean;
  loading: boolean;
  overviewReadAt: number | null;
  error: string | null;
  onRefresh(): void;
  onOpenThread(threadId: string): void;
}
const groups = ["Needs attention", "Unknown", "Running", "Idle"] as const;
export function Cockpit({
  summaries,
  approvals,
  connected,
  loading,
  overviewReadAt,
  error,
  onRefresh,
  onOpenThread,
}: CockpitProps) {
  const { t } = useTranslation("cockpit");
  const groupLabel = (group: (typeof groups)[number]) =>
    t(
      {
        "Needs attention": "needsAttention",
        Unknown: "unknown",
        Running: "running",
        Idle: "idle",
      }[group],
    );
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const overviewStale =
    !connected ||
    error !== null ||
    overviewReadAt === null ||
    now - overviewReadAt > COCKPIT_STALE_MS;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const selected = summaries.find((summary) => summary.threadId === selectedId);
  const visible = summaries.filter(
    (summary) =>
      !summary.archived &&
      `${summary.name ?? ""} ${"currentMetadata" in summary ? summary.currentMetadata.cwd : ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <section className="cockpit" aria-label={t("experimentalCockpit")}>
      <header className="cockpit-heading">
        <div>
          <span className="cockpit-eyebrow">{t("experimentalEyebrow")}</span>
          <h1>
            {t("workInView")}
            <span>.</span>
          </h1>
          <p>{t("followTheWorkActWhereItMatters")}</p>
        </div>
        <div className="cockpit-connection">
          <span className={connected ? "cockpit-dot" : "cockpit-dot offline"} />
          {connected ? t("hostConnected") : t("hostUnavailableStateUnknown")}
          <button onClick={onRefresh}>{t("refreshOverview")}</button>
          <small role="status">
            {overviewReadAt === null
              ? t("overviewNotYetRead")
              : t("overviewReadAge", {
                  seconds: Math.max(
                    0,
                    Math.floor((now - overviewReadAt) / 1000),
                  ),
                })}
            {overviewStale
              ? t("unknownStale")
              : t("refreshesEvery5sWhileVisible")}
          </small>
        </div>
      </header>
      {error && (
        <p className="cockpit-warning" role="alert">
          {t("overviewFailed", { error })}
        </p>
      )}
      <div className="cockpit-layout">
        <nav className="cockpit-rail" aria-label={t("workOverview")}>
          <label className="cockpit-search">
            {t("findATaskOrWorkspace")}
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("filterWork")}
            />
          </label>
          {loading && <p role="status">{t("loadingTasksFromHost")}</p>}
          {!loading && !visible.length && (
            <p className="cockpit-empty">
              {query
                ? t("noTasksMatchThisFilter")
                : t("noTasksYetStartAConversationToBringWorkIntoView")}
            </p>
          )}
          {groups.map((group) => {
            const tasks = visible.filter(
              (summary) => cockpitGroup(summary, approvals) === group,
            );
            return tasks.length ? (
              <section className="cockpit-group" key={group}>
                <h2>
                  {overviewStale
                    ? t("lastKnown", { group: groupLabel(group) })
                    : groupLabel(group)}
                  <span>{tasks.length}</span>
                </h2>
                {tasks.map((summary) => (
                  <button
                    key={summary.threadId}
                    className={`cockpit-task${summary.threadId === selectedId ? " selected" : ""}`}
                    aria-pressed={summary.threadId === selectedId}
                    onClick={() => setSelectedId(summary.threadId)}
                  >
                    <span className="cockpit-task-project">
                      {"currentMetadata" in summary
                        ? workspaceLabel(summary.currentMetadata.cwd)
                        : t("workspaceUnknown")}
                    </span>
                    <strong>{summary.name || t("untitledTask")}</strong>
                    <span className="cockpit-preview">
                      {summary.status === "systemError"
                        ? summary.error
                        : summary.preview || t("noMessagePreview")}
                    </span>
                    <small>
                      {summary.updatedAt
                        ? t("lastActivity", {
                            time: formatTime(summary.updatedAt),
                          })
                        : t("activityTimeUnknown")}
                    </small>
                  </button>
                ))}
              </section>
            ) : null;
          })}
        </nav>
        <div className="cockpit-focus">
          {selected ? (
            <CockpitFocus
              key={selected.threadId}
              summary={selected}
              connected={connected}
              approval={approvals.has(selected.threadId)}
              onOpenThread={onOpenThread}
            />
          ) : (
            <div className="cockpit-welcome">
              <span className="cockpit-eyebrow">{t("focus")}</span>
              <h2>
                {t("aClearViewStarts")}
                <br />
                {t("withOneTask")}
              </h2>
              <p>
                {t(
                  "selectWorkToInspectItsEventsReviewSourcesAndDirectTheAgent",
                )}
              </p>
              <p className="cockpit-footnote">
                {t(
                  "openingThisViewCreatesNoTurnIdleMeansNoActiveTurnNotACompletedGoal",
                )}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function CockpitFocus({
  summary,
  connected,
  approval,
  onOpenThread,
}: {
  summary: NativeThreadSummary;
  connected: boolean;
  approval: boolean;
  onOpenThread(id: string): void;
}) {
  const { t } = useTranslation("cockpit");
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [draft, setDraft] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [source, setSource] = useState<CanonicalItem | null>(null);
  const [allEvents, setAllEvents] = useState(false);
  const sourcePanel = useRef<HTMLElement>(null);
  const sourceTrigger = useRef<HTMLElement | null>(null);
  const inspectSource = (item: CanonicalItem) => {
    sourceTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setSource(item);
  };
  const closeSource = () => {
    setSource(null);
    sourceTrigger.current?.focus();
  };
  const readGeneration = useRef(0);
  useEffect(() => {
    if (source) {
      sourcePanel.current?.focus();
      sourcePanel.current?.scrollIntoView({ block: "nearest" });
    }
  }, [source]);
  const alive = useRef(true);
  const reading = useRef(false);
  const acting = useRef(false);
  const refreshAfterAction = useRef(false);
  const read = useCallback(async (): Promise<void> => {
    if (reading.current || !connected) return;
    refreshAfterAction.current = false;
    reading.current = true;
    const generation = readGeneration.current;
    try {
      const result = await window.zenx.protocol.request("zen/thread/read", {
        threadId: summary.threadId,
      });
      if (!alive.current || generation !== readGeneration.current) return;
      setSnapshot(result.thread);
      setReadAt(Date.now());
      setReadError(null);
    } catch (error) {
      if (alive.current && generation === readGeneration.current)
        setReadError(describe(error));
    } finally {
      reading.current = false;
      if (alive.current && refreshAfterAction.current) void read();
    }
  }, [summary.threadId, connected]);
  useEffect(() => {
    alive.current = true;
    void read();
    const refresh = setInterval(() => {
      if (!document.hidden) void read();
    }, 5000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive.current = false;
      readGeneration.current++;
      clearInterval(refresh);
      clearInterval(clock);
    };
  }, [read]);
  const stale =
    !connected ||
    readError !== null ||
    readAt === null ||
    now - readAt > COCKPIT_STALE_MS;
  const active = snapshot?.turns.find((turn) => turn.status === "inProgress");
  const lastTurn = snapshot?.turns.at(-1);
  const enabled = snapshot !== null && !stale && !busy && !snapshot.archived;
  const act = async (operation: "send" | "interrupt") => {
    if (!enabled || !snapshot || acting.current) return;
    acting.current = true;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    const submitted = draft;
    try {
      if (operation === "send")
        await cockpitSend(
          window.zenx.protocol.request,
          snapshot,
          submitted,
          crypto.randomUUID(),
        );
      else await cockpitInterrupt(window.zenx.protocol.request, snapshot);
      if (!alive.current) return;
      // Acceptance makes any earlier snapshot obsolete. A pending read drains
      // before exactly one trailing read; ordinary polling never queues work.
      readGeneration.current++;
      setReadAt(null);
      refreshAfterAction.current = true;
      if (operation === "send")
        setDraft((current) => (current === submitted ? "" : current));
      setNotice(
        operation === "send"
          ? t("messageAcceptedByHost")
          : t("interruptAcceptedByHost"),
      );
      await read();
    } catch (error) {
      if (alive.current)
        setActionError(t("actionFailed", { error: describe(error) }));
    } finally {
      acting.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const events =
    snapshot?.items.filter((item) =>
      [
        "user_message",
        "agent_message",
        "tool_call",
        "tool_result",
        "failure",
        "turn_started",
        "turn_completed",
        "turn_aborted",
      ].includes(item.type),
    ) ?? [];
  const displayed = allEvents ? events : events.slice(-12);
  const components =
    snapshot?.items
      .filter(
        (item): item is ToolResultItem =>
          item.type === "tool_result" &&
          item.contentType === COCKPIT_CONTENT_TYPE,
      )
      .slice(-3) ?? [];
  return (
    <>
      <header className="cockpit-focus-header">
        <span className="cockpit-eyebrow">
          {t("focusPrefix")}{" "}
          {"currentMetadata" in summary
            ? workspaceLabel(summary.currentMetadata.cwd)
            : t("unknownWorkspace")}
        </span>
        <h2>{summary.name || t("untitledTask")}</h2>
        <div className="cockpit-toolbar">
          <span className="cockpit-status">
            {stale
              ? t("unknownStaleLabel")
              : active
                ? t("running")
                : lastTurn
                  ? t("lastTurn", { status: lastTurn.status })
                  : t("noTurns")}
          </span>
          <button onClick={() => onOpenThread(summary.threadId)}>
            {t("openConversation")}
          </button>
          <button onClick={() => void read()} disabled={!connected}>
            {t("refreshTask")}
          </button>
        </div>
        <p className="cockpit-freshness">
          {readAt
            ? t("snapshotAge", {
                seconds: Math.max(0, Math.floor((now - readAt) / 1000)),
                refresh: connected
                  ? t("refreshesEvery5sWhileVisibleLabel")
                  : t("refreshPausedWhileHostIsUnavailable"),
              })
            : t("snapshotNotYetRead")}
        </p>
      </header>
      {readError && (
        <p className="cockpit-warning" role="alert">
          {t("readFailed", { error: readError })}{" "}
          {snapshot ? t("previousEvidenceIsStale") : t("noSnapshotIsAvailable")}
        </p>
      )}
      {!snapshot && connected && !readError && (
        <p role="status">{t("readingCanonicalEvents")}</p>
      )}
      {approval && (
        <div className="cockpit-warning">
          <strong>{t("yourDecisionIsNeeded")}</strong>
          <p>{t("reviewThePendingRequestInTheConversation")}</p>
          <button onClick={() => onOpenThread(summary.threadId)}>
            {t("reviewRequest")}
          </button>
        </div>
      )}
      {snapshot && (
        <>
          <form
            className="cockpit-command"
            onSubmit={(event) => {
              event.preventDefault();
              void act("send");
            }}
          >
            <label htmlFor={`cockpit-message-${summary.threadId}`}>
              {t("directThisTask")}
              <textarea
                id={`cockpit-message-${summary.threadId}`}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={t("whatShouldTheAgentDoNext")}
                rows={3}
              />
            </label>
            <div className="cockpit-toolbar">
              <button
                type="submit"
                className="cockpit-primary"
                disabled={!enabled || !draft.trim()}
              >
                {busy
                  ? t("sendingRequest")
                  : active
                    ? t("guideActiveTurn")
                    : t("runAgent")}
              </button>
              {active && (
                <button
                  type="button"
                  disabled={!enabled}
                  onClick={() => void act("interrupt")}
                >
                  {t("interruptTurn")}
                </button>
              )}
            </div>
            <small>
              {t("usesThisTaskSCurrentModelReasoningAndPermissions")}{" "}
              {active
                ? t("guidanceTargetsTheObservedActiveTurn")
                : t("runAgentStartsANewTurn")}
            </small>
            {actionError && (
              <p className="cockpit-warning" role="alert">
                {actionError}
              </p>
            )}
            {notice && <p role="status">{notice}</p>}
          </form>
          {components.map((result) => (
            <ComponentCard
              key={result.id}
              result={result}
              snapshot={snapshot}
              onSource={inspectSource}
            />
          ))}
          <section className="cockpit-events" aria-label={t("canonicalEvents")}>
            <div className="cockpit-section-heading">
              <h3>{t("eventTrail")}</h3>
              <span>{t("eventCount", { count: events.length })}</span>
            </div>
            {events.length === 0 && <p>{t("noCanonicalEventsYet")}</p>}
            {!allEvents && events.length > 12 && (
              <button onClick={() => setAllEvents(true)}>
                {t("showEarlier", { count: events.length - 12 })}
              </button>
            )}
            <ol>
              {displayed.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.type.replaceAll("_", " ")}</strong>
                    <time dateTime={item.createdAt}>
                      {formatTime(item.createdAt)}
                    </time>
                  </div>
                  <p>
                    {cockpitEventText(item).slice(0, 480)}
                    {cockpitEventText(item).length > 480 ? "…" : ""}
                  </p>
                  <button onClick={() => inspectSource(item)}>
                    {t("inspectSource")}
                  </button>
                </li>
              ))}
            </ol>
          </section>
          {source && (
            <section
              ref={sourcePanel}
              tabIndex={-1}
              className="cockpit-source"
              aria-label={t("canonicalSource")}
            >
              <div className="cockpit-section-heading">
                <h3>{t("canonicalSource")}</h3>
                <button onClick={closeSource}>{t("closeSource")}</button>
              </div>
              <p>
                {t("threadLabel", { id: snapshot.id })}
                <br />
                {t("itemLabel", { id: source.id })}
              </p>
              <pre tabIndex={0}>{JSON.stringify(source, null, 2)}</pre>
            </section>
          )}
        </>
      )}
    </>
  );
}

function ComponentCard({
  result,
  snapshot,
  onSource,
}: {
  result: ToolResultItem;
  snapshot: ThreadSnapshot;
  onSource(item: CanonicalItem): void;
}) {
  const { t } = useTranslation("cockpit");
  const [open, setOpen] = useState(false);
  const appearance = usePluginTheme();
  const parsed = useMemo(() => {
    try {
      return { component: readCockpitComponent(snapshot, result), error: null };
    } catch (error) {
      return { component: null, error: describe(error) };
    }
  }, [snapshot, result]);
  const component = parsed.component;
  const sdk = useMemo<PluginUiSdkV1>(
    () => ({
      version: 1,
      pluginId: "cockpit-component",
      theme: "dark",
      appearance,
      context: {
        sourceItemIds: component?.sources.map((item) => item.id) ?? [],
      },
      navigation: {
        navigate() {
          throw new Error(
            t("componentNavigationIsDisabledUseHostSourceControls"),
          );
        },
      },
      commands: {
        async execute() {
          throw new Error(t("generatedComponentsCannotExecuteHostCommands"));
        },
      },
      handles: {
        async read(id) {
          const source = component?.sources.find((item) => item.id === id);
          if (!source)
            throw new Error(t("sourceIsOutsideThisComponentSDeclaredScope"));
          return publicItemValue(source);
        },
      },
    }),
    [component, appearance, t],
  );
  return (
    <section className="cockpit-component">
      <div className="cockpit-section-heading">
        <span className="cockpit-eyebrow">{t("componentEyebrow")}</span>
        <button onClick={() => onSource(result)}>{t("inspectResult")}</button>
      </div>
      <h3>{component?.title ?? t("componentUnavailable")}</h3>
      <p className="cockpit-footnote">
        {t("componentNotice", { time: formatTime(result.createdAt) })}
      </p>
      {parsed.error && (
        <p className="cockpit-warning" role="alert">
          {parsed.error}
        </p>
      )}
      {component && (
        <>
          <div className="cockpit-source-links">
            {component.sources.map((source, index) => (
              <button
                key={`${source.id}-${index}`}
                onClick={() => onSource(source)}
              >
                {t("sourceLabel", {
                  index: index + 1,
                  type: source.type.replaceAll("_", " "),
                })}
              </button>
            ))}
          </div>
          <button onClick={() => setOpen((value) => !value)}>
            {open ? t("closeComponent") : t("openIsolatedComponent")}
          </button>
          {open && (
            <IsolatedPluginSurface
              bundleHtml={component.html}
              exportName="card"
              sdk={sdk}
              className="cockpit-component-frame"
            />
          )}
        </>
      )}
    </section>
  );
}
function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function workspaceLabel(value: string) {
  return (
    value
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .at(-1) || value
  );
}
function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? i18n.t("cockpit:unknownTime")
    : date.toLocaleString(i18n.resolvedLanguage, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
