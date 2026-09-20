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
  error,
  onRefresh,
  onOpenThread,
}: CockpitProps) {
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
    <section className="cockpit" aria-label="Experimental Cockpit">
      <header className="cockpit-heading">
        <div>
          <span className="cockpit-eyebrow">ZEN / EXPERIMENTAL</span>
          <h1>
            Work in view<span>.</span>
          </h1>
          <p>Follow the work. Act where it matters.</p>
        </div>
        <div className="cockpit-connection">
          <span className={connected ? "cockpit-dot" : "cockpit-dot offline"} />
          {connected ? "Host connected" : "Host unavailable · state unknown"}
          <button onClick={onRefresh}>Refresh overview</button>
        </div>
      </header>
      {error && (
        <p className="cockpit-warning" role="alert">
          Overview refresh failed: {error}. Displayed tasks may be stale.
        </p>
      )}
      <div className="cockpit-layout">
        <nav className="cockpit-rail" aria-label="Work overview">
          <label className="cockpit-search">
            Find a task or workspace
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter work…"
            />
          </label>
          {loading && <p role="status">Loading tasks from Host…</p>}
          {!loading && !visible.length && (
            <p className="cockpit-empty">
              {query
                ? "No tasks match this filter."
                : "No tasks yet. Start a conversation to bring work into view."}
            </p>
          )}
          {groups.map((group) => {
            const tasks = visible.filter(
              (summary) => cockpitGroup(summary, approvals) === group,
            );
            return tasks.length ? (
              <section className="cockpit-group" key={group}>
                <h2>
                  {connected ? group : `Last known · ${group}`}
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
                        : "Workspace unknown"}
                    </span>
                    <strong>{summary.name || "Untitled task"}</strong>
                    <span className="cockpit-preview">
                      {summary.status === "systemError"
                        ? summary.error
                        : summary.preview || "No message preview"}
                    </span>
                    <small>
                      {summary.updatedAt
                        ? `Last activity ${formatTime(summary.updatedAt)}`
                        : "Activity time unknown"}
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
              <span className="cockpit-eyebrow">FOCUS</span>
              <h2>
                A clear view starts
                <br />
                with one task.
              </h2>
              <p>
                Select work to inspect its events, review sources and direct the
                Agent.
              </p>
              <p className="cockpit-footnote">
                Opening this view creates no Turn. Idle means no active Turn,
                not a completed goal.
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
  const read = useCallback(async () => {
    if (reading.current || !connected) return;
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
      if (operation === "send")
        setDraft((current) => (current === submitted ? "" : current));
      setNotice(
        operation === "send"
          ? "Message accepted by Host."
          : "Interrupt accepted by Host.",
      );
      await read();
    } catch (error) {
      if (alive.current)
        setActionError(
          `${describe(error)} No automatic retry was made. Inspect the conversation before retrying an uncertain result.`,
        );
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
          FOCUS /{" "}
          {"currentMetadata" in summary
            ? workspaceLabel(summary.currentMetadata.cwd)
            : "UNKNOWN WORKSPACE"}
        </span>
        <h2>{summary.name || "Untitled task"}</h2>
        <div className="cockpit-toolbar">
          <span className="cockpit-status">
            {stale
              ? "Unknown / stale"
              : active
                ? "Running"
                : lastTurn
                  ? `Last Turn ${lastTurn.status}`
                  : "No Turns"}
          </span>
          <button onClick={() => onOpenThread(summary.threadId)}>
            Open conversation ↗
          </button>
          <button onClick={() => void read()} disabled={!connected}>
            Refresh task
          </button>
        </div>
        <p className="cockpit-freshness">
          {readAt
            ? `Snapshot read ${Math.max(0, Math.floor((now - readAt) / 1000))}s ago · ${connected ? "refreshes every 5s while visible" : "refresh paused while Host is unavailable"}`
            : "Snapshot not yet read"}
        </p>
      </header>
      {readError && (
        <p className="cockpit-warning" role="alert">
          Could not read task: {readError}.{" "}
          {snapshot
            ? "Previous evidence is stale."
            : "No snapshot is available."}
        </p>
      )}
      {!snapshot && connected && !readError && (
        <p role="status">Reading canonical events…</p>
      )}
      {approval && (
        <div className="cockpit-warning">
          <strong>Your decision is needed.</strong>
          <p>Review the pending request in the conversation.</p>
          <button onClick={() => onOpenThread(summary.threadId)}>
            Review request
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
              Direct this task
              <textarea
                id={`cockpit-message-${summary.threadId}`}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="What should the Agent do next?"
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
                  ? "Sending request…"
                  : active
                    ? "Guide active Turn"
                    : "Run Agent"}
              </button>
              {active && (
                <button
                  type="button"
                  disabled={!enabled}
                  onClick={() => void act("interrupt")}
                >
                  Interrupt Turn
                </button>
              )}
            </div>
            <small>
              Uses this task’s current model, reasoning and permissions.{" "}
              {active
                ? "Guidance targets the observed active Turn."
                : "Run Agent starts a new Turn."}
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
          <section className="cockpit-events" aria-label="Canonical events">
            <div className="cockpit-section-heading">
              <h3>Event trail</h3>
              <span>{events.length} canonical events</span>
            </div>
            {events.length === 0 && <p>No canonical events yet.</p>}
            {!allEvents && events.length > 12 && (
              <button onClick={() => setAllEvents(true)}>
                Show earlier events ({events.length - 12})
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
                    Inspect source
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
              aria-label="Canonical source"
            >
              <div className="cockpit-section-heading">
                <h3>Canonical source</h3>
                <button onClick={closeSource}>Close source</button>
              </div>
              <p>
                Thread / {snapshot.id}
                <br />
                Item / {source.id}
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
            "Component navigation is disabled. Use Host source controls.",
          );
        },
      },
      commands: {
        async execute() {
          throw new Error("Generated components cannot execute Host commands.");
        },
      },
      handles: {
        async read(id) {
          const source = component?.sources.find((item) => item.id === id);
          if (!source)
            throw new Error(
              "Source is outside this component’s declared scope.",
            );
          return structuredClone(source);
        },
      },
    }),
    [component, appearance],
  );
  return (
    <section className="cockpit-component">
      <div className="cockpit-section-heading">
        <span className="cockpit-eyebrow">AGENT-AUTHORED / ISOLATED</span>
        <button onClick={() => onSource(result)}>Inspect result</button>
      </div>
      <h3>{component?.title ?? "Component unavailable"}</h3>
      <p className="cockpit-footnote">
        Read-only component · no Host actions. Agent interpretation, not
        verified Host status. Saved {formatTime(result.createdAt)}.
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
                Source {index + 1} · {source.type.replaceAll("_", " ")}
              </button>
            ))}
          </div>
          <button onClick={() => setOpen((value) => !value)}>
            {open ? "Close component" : "Open isolated component"}
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
    ? "Unknown time"
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
