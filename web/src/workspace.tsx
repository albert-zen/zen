import * as React from "react";
import {
  Bot,
  ChevronRight,
  PanelLeft,
  Plus,
  RefreshCw,
  Send,
  Square,
  RotateCcw
} from "lucide-react";

import {
  BrowserAppServerTransportClient,
  WebUiClient,
  type WebUiClientSnapshot,
  type WebUiConnectionState
} from "../../src/web-ui-client";
import type { ThreadSnapshot } from "../../src/app-server-protocol";
import type { TimelineRow, WebUiState } from "../../src/web-ui-state";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Textarea } from "./components/ui/textarea";
import { createBrowserDemoAppServer } from "./demo-app-server";
import { cn } from "./lib/utils";

type RuntimeMode = "real" | "demo";

export function AgentWorkspace(): React.ReactElement {
  const params = React.useMemo(() => new URLSearchParams(window.location.search), []);
  const initialMode: RuntimeMode = params.get("mode") === "demo" ? "demo" : "real";
  const [mode, setMode] = React.useState<RuntimeMode>(initialMode);
  const [client, setClient] = React.useState(() =>
    createWebClient(initialMode, () => undefined)
  );
  const [snapshot, setSnapshot] = React.useState<WebUiClientSnapshot>(() =>
    client.getSnapshot()
  );
  const [threads, setThreads] = React.useState<readonly ThreadSnapshot[]>([]);
  const [input, setInput] = React.useState("");
  const [showTrace, setShowTrace] = React.useState(false);
  const [streamStatus, setStreamStatus] = React.useState("disconnected");
  const [streamError, setStreamError] = React.useState("");

  React.useEffect(() => client.subscribe(setSnapshot), [client]);

  const reconnect = React.useCallback(async () => {
    client.disconnect();
    const next = createWebClient(mode, (status, error) => {
      setStreamStatus(status);
      setStreamError(error ? "event stream failed" : "");
    });
    setClient(next);
    next.subscribe(setSnapshot);
    await next.connect({ threadId: params.get("thread") ?? undefined });
    setThreads(await next.listThreads());
  }, [client, mode, params]);

  React.useEffect(() => {
    void reconnect().catch((cause) => setStreamError(readError(cause)));
    return () => client.disconnect();
  }, []);

  const state = snapshot.state;
  const connection = snapshot.connection;
  const activeThread = state.currentThread;
  const running = connection.status === "running" || activeThread?.status === "running";
  const recoverableTurn = findRecoverableTurn(state);
  const connected = connection.status === "connected" || connection.status === "running";
  const rows = showTrace
    ? state.timelineRows
    : state.timelineRows.filter((row) => row.type !== "trace");

  async function refreshThreads(): Promise<void> {
    setThreads(await client.listThreads());
  }

  async function startThread(): Promise<void> {
    await client.startThread();
    await refreshThreads();
  }

  async function submitMessage(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }
    setInput("");
    await client.submitMessage(trimmed);
    await refreshThreads();
  }

  function changeMode(nextMode: RuntimeMode): void {
    const next = new URL(window.location.href);
    next.searchParams.set("mode", nextMode);
    next.searchParams.delete("server");
    window.location.assign(next.toString());
  }

  return (
    <div className="grid h-screen min-h-screen grid-cols-[312px_minmax(0,1fr)] bg-zinc-950 text-zinc-100 max-md:grid-cols-1">
      <aside className="grid h-screen grid-rows-[auto_auto_auto_minmax(0,1fr)_auto] border-r border-zinc-800 bg-zinc-900 max-md:hidden">
        <header className="flex items-center justify-between gap-3 px-4 pb-3 pt-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-md bg-zinc-100 font-extrabold text-zinc-950">
              Z
            </div>
            <div className="truncate text-sm font-bold">Zen Agent</div>
          </div>
          <Button variant="subtle" size="icon" onClick={() => void refreshThreads()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </header>

        <div className="px-3 pb-3">
          <Button variant="ghost" className="w-full justify-start font-semibold" onClick={() => void startThread()}>
            <Plus className="h-4 w-4" />
            New thread
          </Button>
        </div>

        <div className="px-4 pb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-zinc-500">
          Threads
        </div>

        <nav className="flex min-h-0 flex-col justify-start overflow-auto px-2 pb-4">
          {[...threads].sort(compareThreadUpdatedDesc).map((thread) => (
            <ThreadButton
              key={thread.id}
              active={thread.id === activeThread?.id}
              thread={thread}
              onClick={() => void client.resumeThread(thread.id)}
            />
          ))}
        </nav>

        <RuntimePanel
          connection={connection}
          mode={mode}
          streamStatus={streamStatus}
          streamError={streamError}
          showTrace={showTrace}
          onModeChange={changeMode}
          onConnect={() => void reconnect()}
          onDisconnect={() => client.disconnect()}
          onToggleTrace={() => setShowTrace((value) => !value)}
        />
      </aside>

      <main className="grid h-screen min-h-0 grid-rows-[58px_minmax(0,1fr)]">
        <header className="flex items-center justify-between gap-4 border-b border-zinc-800 bg-zinc-950 px-6 max-md:px-4">
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold">
              {activeThread ? threadTitle({ id: activeThread.id, items: state.items }) : "No thread"}
            </h1>
            <p className="mt-0.5 text-xs text-zinc-400">
              {activeThread
                ? `${activeThread.id} | ${activeThread.status} | ${activeThread.turns.length} turns | ${state.items.length} items`
                : "Start or resume a thread"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {recoverableTurn ? (
              <Button variant="subtle" onClick={() => void client.retryTurn(recoverableTurn.id)}>
                <RotateCcw className="h-4 w-4" />
                Retry
              </Button>
            ) : null}
            {running ? (
              <Button variant="subtle" onClick={() => void client.interruptThread()}>
                <Square className="h-4 w-4" />
                Stop
              </Button>
            ) : null}
          </div>
        </header>

        <section className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]">
          <div id="timeline" className="overflow-auto px-6 py-8 max-md:px-4">
            <div className="mx-auto grid w-full max-w-5xl gap-5">
              {rows.length > 0 ? (
                rows.map((row) => <TimelineMessage key={`${row.type}:${row.itemId}`} row={row} />)
              ) : (
                <div className="grid min-h-[calc(100vh-220px)] place-items-center text-center text-zinc-400">
                  <div>
                    <h2 className="mb-2 text-2xl font-bold text-zinc-100">Start a thread</h2>
                    <p className="max-w-md leading-7">
                      Ask Zen to inspect code, run commands, or explain the item timeline.
                      Threads stay on the left so the conversation gets the room.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="px-6 pb-5 max-md:px-3">
            <form
              id="composer"
              onSubmit={(event) => void submitMessage(event)}
              className="mx-auto grid w-full max-w-5xl grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-800 p-2 shadow-2xl"
            >
              <Button type="button" variant="subtle" size="icon" onClick={() => void startThread()}>
                <Plus className="h-4 w-4" />
              </Button>
              <Textarea
                id="message"
                rows={2}
                autoComplete="off"
                placeholder="Message Zen"
                value={input}
                disabled={!connected || connection.status !== "connected"}
                onChange={(event) => setInput(event.target.value)}
              />
              <Button type="submit" variant="primary" disabled={connection.status !== "connected"}>
                <Send className="h-4 w-4" />
                Send
              </Button>
            </form>
          </div>
        </section>
      </main>
    </div>
  );
}

function ThreadButton({
  thread,
  active,
  onClick
}: {
  thread: ThreadSnapshot;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "mb-1 grid min-h-20 gap-1.5 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:bg-zinc-800",
        active && "border-zinc-700 bg-zinc-800"
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="truncate text-sm font-bold">{threadTitle(thread)}</div>
        <div className="shrink-0 text-xs text-zinc-500">
          {formatRelativeTime(latestItemTimestamp(thread.items))}
        </div>
      </div>
      <div className="line-clamp-2 text-xs leading-5 text-zinc-400">
        {latestAssistantOrUser(thread.items) ?? thread.id}
      </div>
      <div className="w-fit rounded-full border border-zinc-800 px-2 py-0.5 text-[11px] font-semibold text-zinc-300">
        {thread.status} | {thread.turns.length} turns
      </div>
    </button>
  );
}

function RuntimePanel(props: {
  connection: WebUiConnectionState;
  mode: RuntimeMode;
  streamStatus: string;
  streamError: string;
  showTrace: boolean;
  onModeChange: (mode: RuntimeMode) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onToggleTrace: () => void;
}): React.ReactElement {
  return (
    <div className="border-t border-zinc-800 bg-zinc-900 px-3 py-3">
      <div className="mb-2 text-xs text-zinc-400">
        {renderConnectionStatus(props.connection, props.streamStatus, props.streamError)}
      </div>
      <details>
        <summary className="cursor-pointer list-none text-xs font-bold text-zinc-400">
          Runtime
        </summary>
        <div className="mt-2 grid gap-2">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <select
              id="runtime-mode"
              aria-label="Runtime mode"
              value={props.mode}
              onChange={(event) => props.onModeChange(event.target.value as RuntimeMode)}
              className="h-9 rounded-md border border-zinc-700 bg-zinc-800 px-2 text-sm"
            >
              <option value="real">Real transport</option>
              <option value="demo">Demo mode</option>
            </select>
            <Button id="connect" type="button" onClick={props.onConnect}>
              Connect
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button id="disconnect" type="button" onClick={props.onDisconnect}>
              Disconnect
            </Button>
            <Button id="trace-toggle" type="button" onClick={props.onToggleTrace}>
              {props.showTrace ? "Trace on" : "Trace off"}
            </Button>
          </div>
        </div>
      </details>
    </div>
  );
}

function TimelineMessage({ row }: { row: TimelineRow }): React.ReactElement {
  const side = row.type === "user" ? "end" : "start";
  const isAssistant = row.type === "assistant" || row.type === "assistant-progress";
  return (
    <article className={cn("grid gap-2", side === "end" ? "justify-items-end" : "justify-items-start")}>
      <div className="text-xs font-bold uppercase text-zinc-500">{rowLabel(row)}</div>
      <Card
        className={cn(
          "max-w-[min(820px,94%)] px-4 py-3",
          row.type === "user" && "bg-zinc-800",
          isAssistant && "border-transparent bg-transparent px-0"
        )}
      >
        <RowContent row={row} />
        <div className="mt-2 font-mono text-[11px] text-zinc-500">
          #{row.seq} {row.itemId}
        </div>
      </Card>
    </article>
  );
}

function RowContent({ row }: { row: TimelineRow }): React.ReactElement {
  if (row.type === "shell") {
    return (
      <div>
        <div className="mb-2 flex items-center justify-between gap-3 text-xs font-bold uppercase text-zinc-400">
          <span>Shell {row.exitCode === undefined ? row.status : `${row.status} | exit ${row.exitCode}`}</span>
          <span>{row.status}</span>
        </div>
        <CodeBlock value={row.command} />
        {row.stdout ? <OutputBlock label="stdout" value={row.stdout} /> : null}
        {row.stderr ? <OutputBlock label="stderr" value={row.stderr} danger /> : null}
        {row.error ? <OutputBlock label="error" value={row.error} danger /> : null}
      </div>
    );
  }

  if (row.type === "tool-call" || row.type === "tool-result") {
    return <CodeBlock value={stringify(row.type === "tool-call" ? row.input : row.content)} />;
  }

  if (row.type === "tool-error") {
    return <div className="whitespace-pre-wrap text-rose-300">{row.message ?? "tool failed"}</div>;
  }

  return (
    <div className="whitespace-pre-wrap break-words leading-7">
      {stringify("content" in row ? row.content : row.type === "trace" ? row.event : "")}
    </div>
  );
}

function OutputBlock({
  label,
  value,
  danger = false
}: {
  label: string;
  value: string;
  danger?: boolean;
}): React.ReactElement {
  return (
    <div className="mt-3">
      <div className={cn("mb-1 text-[11px] font-bold uppercase text-zinc-500", danger && "text-rose-300")}>
        {label}
      </div>
      <CodeBlock value={value} />
    </div>
  );
}

function CodeBlock({ value }: { value: string }): React.ReactElement {
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-zinc-200">
      {value}
    </pre>
  );
}

function createWebClient(
  mode: RuntimeMode,
  onSubscriptionStatus: (status: string, error?: unknown) => void
): WebUiClient {
  return new WebUiClient({
    mode,
    client:
      mode === "demo"
        ? createBrowserDemoAppServer()
        : new BrowserAppServerTransportClient({
            onSubscriptionStatus
          })
  });
}

function rowLabel(row: TimelineRow): string {
  if (row.type === "assistant-progress") {
    return "Assistant";
  }
  if (row.type === "tool-call") {
    return row.toolName ?? "Tool";
  }
  if (row.type === "tool-result") {
    return `${row.toolName ?? "Tool"} result`;
  }
  return row.type.replaceAll("-", " ");
}

function threadTitle(thread: { id: string; items: readonly ThreadSnapshot["items"][number][] }): string {
  return summarize(latestContent(thread.items, "user.message.completed") ?? thread.id, 48);
}

function latestAssistantOrUser(items: readonly ThreadSnapshot["items"][number][]): string | undefined {
  return latestContent(items, "assistant.message.completed") ?? latestContent(items, "user.message.completed");
}

function latestContent(items: readonly ThreadSnapshot["items"][number][], type: string): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type !== type) {
      continue;
    }
    const payload = item.payload;
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      const content = payload.content;
      if (typeof content === "string" && content.trim()) {
        return content.trim();
      }
    }
  }
  return undefined;
}

function latestItemTimestamp(items: readonly ThreadSnapshot["items"][number][]): number | undefined {
  return items.reduce<number | undefined>(
    (latest, item) => (latest === undefined ? item.createdAtMs : Math.max(latest, item.createdAtMs)),
    undefined
  );
}

function compareThreadUpdatedDesc(left: ThreadSnapshot, right: ThreadSnapshot): number {
  return (latestItemTimestamp(right.items) ?? 0) - (latestItemTimestamp(left.items) ?? 0);
}

function findRecoverableTurn(state: WebUiState): ThreadSnapshot["turns"][number] | undefined {
  const latestTurn = state.currentThread?.turns.at(-1);
  return latestTurn?.status === "failed" || latestTurn?.status === "canceled"
    ? latestTurn
    : undefined;
}

function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) {
    return "new";
  }
  const deltaMs = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  if (deltaMs < minute) {
    return "now";
  }
  if (deltaMs < hour) {
    return `${Math.floor(deltaMs / minute)}m`;
  }
  return `${Math.floor(deltaMs / hour)}h`;
}

function renderConnectionStatus(
  connection: WebUiConnectionState,
  streamStatus: string,
  statusText: string
): string {
  if (connection.status === "connected") {
    return connection.mode === "demo" ? "Local workspace" : "Connected";
  }
  if (connection.status === "running") {
    return "Working";
  }
  if (connection.status === "connecting") {
    return "Connecting";
  }
  if (connection.status === "failed") {
    return statusText ? `Connection issue: ${statusText}` : "Connection issue";
  }
  if (connection.mode === "real" && streamStatus === "failed") {
    return "Event stream disconnected";
  }
  return "Disconnected";
}

function summarize(value: string, maxLength: number): string {
  const rendered = value.replace(/\s+/g, " ").trim();
  return rendered.length <= maxLength ? rendered : `${rendered.slice(0, maxLength - 3)}...`;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function readError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
