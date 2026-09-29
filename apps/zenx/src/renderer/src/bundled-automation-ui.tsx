import { useEffect, useRef, useState } from "react";
import type { ThreadCandidate } from "../../main/thread-target.js";
import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import { threadTitle } from "./thread-list.js";
import { Select, Combobox } from "./ui/controls.js";
import { Markdown } from "./Markdown.js";

import type {
  TriggerKind,
  TriggerHistoryEntry,
  ZenXRoom,
  ZenXTrigger,
} from "../../main/trigger-types.js";
import type {
  PluginUiModule,
  PluginUiSdkV1,
  PluginUiSurfaceProps,
  PluginUiRegistry,
} from "./plugin-ui-host.js";

const TRIGGERS_UI_ENTRY = "zenx/bundled/triggers-ui";
const ROOMS_UI_ENTRY = "zenx/bundled/rooms-ui";

interface TriggerListResult {
  triggers: ZenXTrigger[];
  history: TriggerHistoryEntry[];
  rooms?: ZenXRoom[];
}

interface RoomListResult {
  nextCursor?: number | null;
  rooms: Array<
    Omit<ZenXRoom, "operations"> & {
      pendingCount?: number;
      operationEpoch?: string;
      messageCount?: number;
      nextCursor?: number | null;
      operations?: Array<{
        id: string;
        text: string;
        messageId: string | null;
        createdAt: number;
      }>;
      responders?: Array<{ name: string; configured: boolean }>;
    }
  >;
}
interface RoomDeliveryResult {
  text?: string;
  state: "prepared" | "saved" | "unknown";
  messageId: string | null;
  mentions: Array<{
    name: string;
    configuredNow: boolean;
    deliveries: Array<{
      status:
        | "unconfigured"
        | "pending"
        | "queued"
        | "running"
        | "completed"
        | "failed"
        | "unknown";
    }>;
  }>;
}
interface RoomPendingSend {
  id: string;
  text: string;
  revision: number | null;
  messageId: string | null;
}

export function registerBundledAutomationUi(
  registry: PluginUiRegistry,
): () => void {
  const disposers = [
    registry.registerTrusted(TRIGGERS_UI_ENTRY, {
      "triggers-page": TriggersPage,
      "trigger-panel": TriggersPanel,
    } satisfies PluginUiModule),
    registry.registerTrusted(ROOMS_UI_ENTRY, {
      "rooms-page": RoomsPage,
    } satisfies PluginUiModule),
  ];
  return () => disposers.reverse().forEach((dispose) => dispose());
}

export function TriggersPage({ sdk }: PluginUiSurfaceProps) {
  const createForm = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<TriggerListResult>({
    triggers: [],
    history: [],
  });
  const [threadId, setThreadId] = useState("");
  const [kind, setKind] = useState<TriggerKind>("thread");
  const [label, setLabel] = useState("Wake up");
  const [prompt, setPrompt] = useState("");
  const [condition, setCondition] = useState("");
  const [threads, setThreads] = useState<ThreadCandidate[]>([]);
  const [once, setOnce] = useState(true);
  const [includeLatest, setIncludeLatest] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [recurring, setRecurring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    setData((await sdk.commands.execute("list")) as TriggerListResult);
  };
  useEffect(() => {
    void refresh().catch((reason: unknown) => setError(describeError(reason)));
    void sdk.commands
      .execute("threads")
      .then((value) =>
        setThreads((value as { threads: ThreadCandidate[] }).threads),
      )
      .catch((reason: unknown) => setError(describeError(reason)));
    const timer = setInterval(() => {
      void refresh().catch((reason: unknown) =>
        setError(describeError(reason)),
      );
    }, 3000);
    return () => clearInterval(timer);
  }, [sdk]);
  const create = async () => {
    setError(null);
    setSaving(true);
    try {
      await sdk.commands.execute("create", {
        threadId,
        kind,
        label,
        prompt,
        ...(kind === "timer"
          ? {
              runAt: Date.now() + Number(condition) * 60_000,
              ...(recurring ? { intervalMinutes: Number(condition) } : {}),
            }
          : kind === "thread"
            ? { watchedThreadId: condition, once, includeLatest }
            : kind === "roomMention"
              ? {
                  roomId: condition.split("|")[0] ?? "",
                  mention: condition.split("|")[1] ?? "",
                }
              : { signalName: condition }),
      });
      setPrompt("");
      await refresh();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="page-scroll trigger-page">
      <div className="page-intro">
        <div>
          <h2>Triggers</h2>
          <p>
            Notify a Thread when work ends. Notifications join its message
            queue, including while it is busy.
          </p>
        </div>
      </div>
      <div className="page-card trigger-create-card" ref={createForm}>
        <h2>New Trigger</h2>
        <div className="form-grid">
          <label className="field">
            <span>Type</span>
            <Select
              value={kind}
              onValueChange={(value) => {
                const next = value as TriggerKind;
                setKind(next);
                setCondition(next === "timer" ? "5" : "");
              }}
            >
              <option value="timer">Timer</option>
              <option value="thread">Thread turn ended</option>
              <option value="roomMention">Room mention</option>
              <option value="signal">External signal</option>
            </Select>
          </label>
          <Field label="Label" value={label} onChange={setLabel} />
          <ThreadPicker
            label="Notify Thread"
            threads={threads}
            value={threadId}
            onChange={setThreadId}
          />
          {kind === "roomMention" ? (
            <label className="field">
              <span>Room member</span>
              <Select
                value={condition}
                onValueChange={(value) => setCondition(value)}
              >
                <option value="">Choose membership</option>
                {(data.rooms ?? []).flatMap((room) =>
                  room.members.map((member) => (
                    <option
                      key={`${room.id}:${member.name}`}
                      value={`${room.id}|${member.name}`}
                    >
                      #{room.name} · @{member.name}
                    </option>
                  )),
                )}
              </Select>
            </label>
          ) : kind === "thread" ? (
            <ThreadPicker
              label="Watch Thread"
              threads={threads}
              value={condition}
              onChange={setCondition}
            />
          ) : (
            <Field
              label={kind === "timer" ? "Minutes from now" : "Signal name"}
              value={condition}
              onChange={setCondition}
            />
          )}
          {kind === "timer" ? (
            <label className="trigger-checkbox">
              <input
                type="checkbox"
                checked={recurring}
                onChange={(event) => setRecurring(event.target.checked)}
              />
              Repeat at this interval
            </label>
          ) : null}
          {kind === "thread" ? (
            <>
              <label className="trigger-checkbox">
                <input
                  type="checkbox"
                  checked={once}
                  onChange={(event) => setOnce(event.target.checked)}
                />
                Only attempt one notification
              </label>
              <label className="trigger-checkbox">
                <input
                  type="checkbox"
                  checked={includeLatest}
                  onChange={(event) => setIncludeLatest(event.target.checked)}
                />
                Include the latest result if already ended
              </label>
              <p style={{ gridColumn: "1 / -1", margin: 0 }}>
                Completed, failed and cancelled turns all notify. Waiting for
                input is still active.{" "}
                {once
                  ? "The watch stops when a notification attempt is recorded, even if delivery fails."
                  : "Repeat for each future turn until you stop this watch. Watching the same Thread or reciprocal watches can keep starting new turns."}{" "}
                Offline events are not replayed after restart.
              </p>
            </>
          ) : null}
          <label className="field wide">
            <span>Notification instructions</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="What should the notified Thread do with the result?"
            />
          </label>
        </div>
        <button
          className="primary-button"
          type="button"
          disabled={
            saving || !threadId || !condition || !prompt.trim() || !label.trim()
          }
          onClick={() => void create()}
        >
          {saving ? "Saving…" : "Create trigger"}
        </button>
      </div>
      {error === null ? null : <p role="alert">{error}</p>}
      <div className="trigger-grid">
        {data.triggers.map((trigger) => (
          <article className="page-card trigger-card" key={trigger.id}>
            <h2>{trigger.label}</h2>
            <p>
              {trigger.active ? "Listening" : "Stopped"} ·{" "}
              {trigger.watch?.once
                ? "One attempt"
                : trigger.kind === "thread"
                  ? "Every turn"
                  : trigger.kind}
            </p>
            <p>Notify: {threadLabel(threads, trigger.threadId)}</p>
            {trigger.watch === undefined ? null : (
              <p>Watch: {threadLabel(threads, trigger.watch.threadId)}</p>
            )}
            <p>{trigger.prompt}</p>
            {trigger.active ? (
              <button
                className="quiet-button"
                type="button"
                onClick={() =>
                  void sdk.commands
                    .execute("cancel", { triggerId: trigger.id })
                    .then(refresh)
                    .catch((reason: unknown) => setError(describeError(reason)))
                }
              >
                Stop listening
              </button>
            ) : null}
            {!trigger.active && trigger.kind === "thread" ? (
              <button
                type="button"
                className="quiet-button"
                onClick={() => {
                  setKind("thread");
                  setThreadId(trigger.threadId);
                  setCondition(trigger.watch?.threadId ?? "");
                  setLabel(trigger.label);
                  setPrompt(trigger.prompt);
                  setOnce(trigger.watch?.once ?? false);
                  createForm.current?.scrollIntoView({ block: "start" });
                  createForm.current?.querySelector("textarea")?.focus();
                }}
              >
                Set up again
              </button>
            ) : null}
            <button
              className="quiet-button"
              type="button"
              onClick={() =>
                void sdk.commands
                  .execute("delete", { triggerId: trigger.id })
                  .then(refresh)
                  .catch((reason: unknown) => setError(describeError(reason)))
              }
            >
              Delete
            </button>
          </article>
        ))}
      </div>
      <h2 className="history-title">History</h2>
      {data.history.map((entry) => (
        <div className={`trigger-history ${entry.status}`} key={entry.id}>
          <strong>{entry.reason}</strong> · {deliveryLabel(entry)}
          {entry.error === null ? null : <p role="status">{entry.error}</p>}
          {entry.sourceThreadId === null ? null : (
            <>
              <button
                type="button"
                className="quiet-button"
                onClick={() =>
                  void sdk.commands
                    .execute("result", { historyId: entry.id })
                    .then((value) =>
                      setPreviews((current) => ({
                        ...current,
                        [entry.id]: (value as { preview: string }).preview,
                      })),
                    )
                    .catch((reason: unknown) => setError(describeError(reason)))
                }
              >
                Read source result
              </button>
              <button
                type="button"
                className="quiet-button"
                onClick={() =>
                  sdk.navigation.navigate(
                    `/threads/${encodeURIComponent(entry.sourceThreadId!)}`,
                  )
                }
              >
                Open source Thread
              </button>
            </>
          )}
          <button
            type="button"
            className="quiet-button"
            onClick={() =>
              sdk.navigation.navigate(
                `/threads/${encodeURIComponent(entry.threadId)}`,
              )
            }
          >
            Open notified Thread
          </button>
          {previews[entry.id] === undefined ? null : (
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {previews[entry.id]}
            </pre>
          )}
        </div>
      ))}
      {kind === "signal" ? (
        <div className="page-card">
          <h2>Run named signal</h2>
          <button
            type="button"
            onClick={() =>
              void sdk.commands
                .execute("signal", {
                  name: condition,
                  detail: "Sent from Triggers UI",
                })
                .then(refresh)
                .catch((reason: unknown) => setError(describeError(reason)))
            }
          >
            Send signal (Run Agent)
          </button>
        </div>
      ) : null}
    </div>
  );
}

function threadLabel(threads: readonly ThreadCandidate[], id: string): string {
  const thread = threads.find((candidate) => candidate.threadId === id);
  return thread === undefined
    ? id
    : `${thread.name ?? "Untitled"} · ${thread.shortId} · ${thread.status}${thread.archived ? " · archived" : ""}`;
}

function deliveryLabel(entry: TriggerHistoryEntry): string {
  switch (entry.delivery) {
    case "queued":
      return "Notification queued";
    case "pending":
      return "Sending notification";
    case "failed":
      return "Notification failed";
    case "unknown":
      return "Delivery unknown — not retried";
    default:
      return entry.status;
  }
}

function ThreadPicker({
  label,
  threads,
  value,
  onChange,
}: {
  label: string;
  threads: readonly ThreadCandidate[];
  value: string;
  onChange(value: string): void;
}) {
  const [query, setQuery] = useState("");
  const visible = threads.filter(
    (thread) =>
      thread.threadId === value ||
      `${thread.name ?? ""} ${thread.threadId} ${thread.cwd}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  return (
    <div className="field">
      <label className="field">
        <span>Search {label}</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Title, short ID or workspace"
        />
      </label>
      <label className="field">
        <span>{label}</span>
        <Select value={value} onValueChange={onChange}>
          <option value="">Choose a Thread</option>
          {visible.map((thread) => (
            <option key={thread.threadId} value={thread.threadId}>
              {threadLabel(threads, thread.threadId)}
            </option>
          ))}
        </Select>
      </label>
      {visible.length === 0 ? (
        <small>No matching Threads. Try another title or workspace.</small>
      ) : null}
    </div>
  );
}

export function TriggersPanel({ sdk }: PluginUiSurfaceProps) {
  const [data, setData] = useState<TriggerListResult>({
    triggers: [],
    history: [],
  });
  const [error, setError] = useState<string | null>(null);
  const threadId =
    typeof sdk.context["threadId"] === "string"
      ? sdk.context["threadId"]
      : null;
  useEffect(() => {
    const refresh = () => {
      void sdk.commands
        .execute("list")
        .then((value) => {
          setData(value as TriggerListResult);
          setError(null);
        })
        .catch((reason: unknown) => setError(describeError(reason)));
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [sdk]);
  if (threadId === null) return null;
  const wakeups = data.history
    .filter((entry) => entry.threadId === threadId)
    .slice(0, 5);
  const watching = data.triggers.some(
    (trigger) => trigger.active && trigger.threadId === threadId,
  );
  if (!watching && wakeups.length === 0 && error === null) return null;
  return (
    <aside className="trigger-rail" aria-label="Trigger wakeups">
      <h2>{watching ? "Watching" : "Recent wakeups"}</h2>
      {error === null ? null : <p role="alert">{error}</p>}
      {wakeups.map((entry) => (
        <p key={entry.id}>
          <strong>{entry.reason}</strong> · {deliveryLabel(entry)}
        </p>
      ))}
    </aside>
  );
}

export function RoomsPage({ sdk }: PluginUiSurfaceProps) {
  const [data, setData] = useState<RoomListResult>({ rooms: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<"create" | "manage" | null>(null);
  const [name, setName] = useState("");
  const [memberName, setMemberName] = useState("");
  const [threadId, setThreadId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [threads, setThreads] = useState<NativeThreadSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const sending = useRef<Record<string, boolean>>({});
  const [sendingRooms, setSendingRooms] = useState<Record<string, boolean>>({});
  const selectedRef = useRef<string | null>(null);
  const historyCache = useRef<
    Record<
      string,
      {
        messages: ZenXRoom["messages"];
        count: number;
        nextCursor: number | null;
      }
    >
  >({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [roomErrors, setRoomErrors] = useState<Record<string, string>>({});
  const [pendingByRoom, setPendingByRoom] = useState<
    Record<string, RoomPendingSend>
  >({});
  const pendingRef = useRef<Record<string, RoomPendingSend>>({});
  const revisions = useRef<Record<string, number>>({});
  const refreshSequence = useRef(0);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [deliveries, setDeliveries] = useState<
    Record<string, RoomDeliveryResult>
  >({});
  const composer = useRef<HTMLTextAreaElement>(null);
  const dialogClose = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const dialogInvoker = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const feed = useRef<HTMLDivElement>(null);
  const lastMessage = useRef<string | null>(null);
  const lastRoom = useRef<string | null>(null);
  const stickToBottom = useRef(true);
  const setRoomPending = (roomId: string, value: RoomPendingSend | null) => {
    const next = { ...pendingRef.current };
    if (value === null) delete next[roomId];
    else next[roomId] = value;
    pendingRef.current = next;
    setPendingByRoom(next);
  };
  const finishSaved = async (
    roomId: string,
    entry: RoomPendingSend,
    result: RoomDeliveryResult,
  ) => {
    if (result.state !== "saved" || !result.messageId) return;
    setRoomErrors((current) => ({ ...current, [roomId]: "" }));
    refreshSequence.current += 1;
    if (
      entry.revision !== null &&
      revisions.current[roomId] === entry.revision
    ) {
      setDrafts((current) => ({ ...current, [roomId]: "" }));
    }
    if (pendingRef.current[roomId]?.id === entry.id)
      setRoomPending(roomId, null);
    setFeedback((current) => ({
      ...current,
      [roomId]: "Message saved. Check wake status on the message.",
    }));
    await sdk.commands
      .execute("ack-operation", { roomId, operationId: entry.id })
      .catch((reason: unknown) =>
        setError(
          `Saved, but acknowledgment is unknown: ${describeError(reason)}`,
        ),
      );
  };
  const refresh = async () => {
    const sequence = ++refreshSequence.current;
    const next: RoomListResult = { rooms: [] };
    let cursor: number | null = 0;
    while (cursor !== null && next.rooms.length < 128) {
      const page = (await sdk.commands.execute("list", {
        cursor,
      })) as RoomListResult;
      if (sequence !== refreshSequence.current) return;
      next.rooms.push(...page.rooms);
      cursor = page.nextCursor ?? null;
    }
    const target =
      next.rooms.find((entry) => entry.id === selectedRef.current) ??
      next.rooms[0];
    if (target?.messageCount !== undefined) {
      const recent = (await sdk.commands.execute("messages", {
        roomId: target.id,
        cursor: 0,
      })) as { messages: ZenXRoom["messages"]; nextCursor: number | null };
      if (
        sequence !== refreshSequence.current ||
        (selectedRef.current !== null && selectedRef.current !== target.id)
      )
        return;
      const cached = historyCache.current[target.id];
      const tailIds = new Set(recent.messages.map((message) => message.id));
      const messages = [
        ...(cached?.messages.filter((message) => !tailIds.has(message.id)) ??
          []),
        ...recent.messages,
      ].slice(-target.messageCount);
      const loaded = Math.max(
        recent.messages.length,
        (cached?.nextCursor ?? 0) +
          Math.max(0, target.messageCount - (cached?.count ?? 0)),
      );
      const nextCursor = loaded < target.messageCount ? loaded : null;
      historyCache.current[target.id] = {
        messages,
        count: target.messageCount,
        nextCursor,
      };
      target.messages = messages;
      target.nextCursor = nextCursor;
    }
    if (sequence !== refreshSequence.current) return;
    setData({ ...next });
    setSelected((current) =>
      current !== null && next.rooms.some((entry) => entry.id === current)
        ? current
        : (next.rooms[0]?.id ?? null),
    );
    // The Host is the authority. Unacknowledged prepared/committed operations
    // survive renderer unmount; lack of a retained receipt NEVER means unsent.
    const merged = { ...pendingRef.current };
    for (const room of next.rooms)
      for (const operation of room.operations ?? []) {
        if (!merged[room.id] || merged[room.id]?.id === operation.id) {
          merged[room.id] = {
            id: operation.id,
            text: operation.text,
            revision:
              merged[room.id]?.id === operation.id
                ? merged[room.id]!.revision
                : null,
            messageId: operation.messageId,
          };
        }
      }
    pendingRef.current = merged;
    setPendingByRoom(merged);
    const active = next.rooms.find((entry) => entry.id === selectedRef.current);
    if (active?.pendingCount && !active.operations?.length) {
      const collected: NonNullable<typeof active.operations> = [];
      let cursor: number | null = 0;
      while (cursor !== null && collected.length < 128) {
        const page = (await sdk.commands.execute("operations", {
          roomId: active.id,
          cursor,
        })) as { operations: typeof collected; nextCursor: number | null };
        if (
          sequence !== refreshSequence.current ||
          selectedRef.current !== active.id
        )
          return;
        collected.push(...page.operations);
        cursor = page.nextCursor;
      }
      active.operations = collected;
      setData({ ...next, rooms: [...next.rooms] });
      const merged = { ...pendingRef.current };
      if (!merged[active.id] && collected[0])
        merged[active.id] = {
          id: collected[0].id,
          text: collected[0].text,
          revision: null,
          messageId: collected[0].messageId,
        };
      pendingRef.current = merged;
      setPendingByRoom(merged);
    }
    if (active) {
      const latest = active.messages
        .filter((message) => message.kind === "human")
        .slice(-10);
      void Promise.all(
        latest.map(async (message) => {
          try {
            const status = (await sdk.commands.execute("delivery", {
              roomId: active.id,
              messageId: message.id,
            })) as RoomDeliveryResult;
            if (sequence === refreshSequence.current)
              setDeliveries((previous) => ({
                ...previous,
                [message.id]: status,
              }));
          } catch {
            /* No retained result is unknown, never unsent. */
          }
        }),
      );
    }
    setLoading(false);
  };
  useEffect(() => {
    selectedRef.current = selected;
    if (selected) void refresh().catch(() => {});
  }, [selected]);
  useEffect(() => {
    void window.zenx.threads
      .list()
      .then(setThreads)
      .catch((reason: unknown) => setError(describeError(reason)));
    void refresh().catch((reason: unknown) => {
      setLoading(false);
      setError(describeError(reason));
    });
    const timer = setInterval(
      () =>
        void refresh().catch((reason: unknown) =>
          setError(describeError(reason)),
        ),
      3000,
    );
    return () => clearInterval(timer);
  }, [sdk]);
  useEffect(() => {
    if (panel !== null) dialogClose.current?.focus();
  }, [panel]);
  const closeDialog = () => {
    setPanel(null);
    requestAnimationFrame(() => dialogInvoker.current?.focus());
  };
  const room = data.rooms.find((entry) => entry.id === selected);
  const draft = room === undefined ? "" : (drafts[room.id] ?? "");
  const pending = room === undefined ? null : (pendingByRoom[room.id] ?? null);
  const tail = room?.messages.at(-1)?.id ?? null;
  useEffect(() => {
    if (
      selected !== lastRoom.current ||
      (tail !== lastMessage.current && stickToBottom.current)
    ) {
      if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
    }
    lastRoom.current = selected;
    lastMessage.current = tail;
  }, [selected, tail]);
  const run = async (command: string, input: unknown) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await sdk.commands.execute(command, input);
      await refresh();
      if (
        command === "create" &&
        result &&
        typeof result === "object" &&
        "id" in result &&
        typeof result.id === "string"
      )
        setSelected(result.id);
      return true;
    } catch (reason) {
      setError(
        `Result unknown; refresh before repeating. ${describeError(reason)}`,
      );
      void refresh().catch(() => {});
      return false;
    } finally {
      setBusy(false);
    }
  };
  const loadEarlier = async (roomId: string, cursor: number) => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    ++refreshSequence.current;
    try {
      let offset: number | null = cursor;
      let cache = historyCache.current[roomId];
      for (let n = 0; n < 4 && offset !== null; n++) {
        const page = (await sdk.commands.execute("messages", {
          roomId,
          cursor: offset,
        })) as { messages: ZenXRoom["messages"]; nextCursor: number | null };
        const known = new Set(
          cache?.messages.map((message) => message.id) ?? [],
        );
        cache = {
          messages: [
            ...page.messages.filter((message) => !known.has(message.id)),
            ...(cache?.messages ?? []),
          ].slice(-256),
          count: cache?.count ?? 0,
          nextCursor: page.nextCursor,
        };
        offset = page.nextCursor;
      }
      if (cache) {
        historyCache.current[roomId] = cache;
        const height = feed.current?.scrollHeight ?? 0;
        setData((current) => ({
          ...current,
          rooms: current.rooms.map((entry) =>
            entry.id === roomId
              ? {
                  ...entry,
                  messages: cache!.messages,
                  nextCursor: cache!.nextCursor,
                }
              : entry,
          ),
        }));
        requestAnimationFrame(() => {
          if (feed.current)
            feed.current.scrollTop += feed.current.scrollHeight - height;
        });
      }
    } catch (reason) {
      setRoomErrors((current) => ({
        ...current,
        [roomId]: `Older messages unavailable: ${describeError(reason)}`,
      }));
    } finally {
      setLoadingOlder(false);
    }
  };
  const send = async () => {
    if (
      !room ||
      !draft.trim() ||
      sending.current[room.id] ||
      busy ||
      pendingByRoom[room.id] ||
      (room.operations?.length ?? 0) > 0
    )
      return;
    const text = draft;
    const roomId = room.id;
    const entry: RoomPendingSend = {
      id: `${room.operationEpoch ?? "legacy"}:${crypto.randomUUID()}`,
      text,
      revision: revisions.current[roomId] ?? 0,
      messageId: null,
    };
    sending.current[roomId] = true;
    setSendingRooms((current) => ({ ...current, [roomId]: true }));
    setRoomPending(roomId, entry);
    setRoomErrors((current) => ({ ...current, [roomId]: "" }));
    try {
      await sdk.commands.execute("prepare-message", {
        roomId,
        operationId: entry.id,
        text,
      });
      const committed = (await sdk.commands.execute("post-message", {
        roomId,
        operationId: entry.id,
        text,
      })) as { messageId: string };
      if (!committed.messageId)
        throw new Error("No immutable Room message ID returned");
      const status = (await sdk.commands.execute("operation", {
        roomId,
        operationId: entry.id,
      })) as RoomDeliveryResult;
      await finishSaved(roomId, entry, status);
      await refresh();
    } catch (reason) {
      // Do not infer success from matching text, even when a new ID appeared.
      setError(
        `Send result unknown for this operation; do not resend. ${describeError(reason)}`,
      );
      try {
        const status = (await sdk.commands.execute("operation", {
          roomId,
          operationId: entry.id,
        })) as RoomDeliveryResult;
        if (status.state === "saved" && status.messageId)
          await finishSaved(roomId, entry, status);
      } catch {
        /* Unknown remains unresolved across Room switches. */
      }
      void refresh().catch(() => {});
    } finally {
      sending.current[roomId] = false;
      setSendingRooms((current) => ({ ...current, [roomId]: false }));
    }
  };
  const inspectPending = async (
    roomId: string,
    entry: RoomPendingSend,
    resume: boolean,
  ) => {
    setRoomErrors((current) => ({ ...current, [roomId]: "" }));
    try {
      let state = (await sdk.commands.execute("operation", {
        roomId,
        operationId: entry.id,
      })) as RoomDeliveryResult;
      if (state.state === "prepared" && resume) {
        if (!state.text)
          throw new Error(
            "Prepared operation text is not available; do not resend",
          );
        await sdk.commands.execute("post-message", {
          roomId,
          operationId: entry.id,
          text: state.text,
        });
        state = (await sdk.commands.execute("operation", {
          roomId,
          operationId: entry.id,
        })) as RoomDeliveryResult;
      }
      if (state.state === "saved" && state.messageId)
        await finishSaved(roomId, entry, state);
      else
        setFeedback((current) => ({
          ...current,
          [roomId]:
            "Prepared but not sent; no message has been confirmed. Retry only by explicitly choosing Send prepared operation.",
        }));
      await refresh();
    } catch (reason) {
      setError(
        `Result unknown; this operation stays unresolved. ${describeError(reason)}`,
      );
    }
  };
  return (
    <div className="rooms-chat">
      <nav className="rooms-chat-list" aria-label="Rooms">
        <div className="rooms-chat-list-head">
          <strong>Rooms</strong>
          <button
            type="button"
            onClick={(event) => {
              dialogInvoker.current = event.currentTarget;
              setName("");
              setMemberName("");
              setThreadId("");
              setPanel("create");
            }}
          >
            + New
          </button>
        </div>
        {data.rooms.map((entry) => (
          <button
            type="button"
            key={entry.id}
            aria-current={entry.id === selected ? "page" : undefined}
            onClick={() => {
              selectedRef.current = entry.id;
              setSelected(entry.id);
              setPanel(null);
              setError(null);
            }}
          >
            <strong>#{entry.name}</strong>
            <small>{entry.messages.at(-1)?.text ?? "No messages yet"}</small>
          </button>
        ))}
      </nav>
      <main className="rooms-chat-main">
        {loading ? (
          <p className="rooms-chat-empty" role="status">
            Loading rooms…
          </p>
        ) : room === undefined ? (
          <div className="rooms-chat-empty">
            No room selected. Create a room to start a conversation.
          </div>
        ) : (
          <>
            <header className="rooms-chat-header">
              <div>
                <h2>#{room.name}</h2>
                <span>
                  {room.members.length
                    ? room.members
                        .map((member) => `@${member.name}`)
                        .join(" · ")
                    : "No agents yet"}
                </span>
              </div>
              <button
                type="button"
                onClick={(event) => {
                  dialogInvoker.current = event.currentTarget;
                  setName(room.name);
                  setPanel("manage");
                }}
              >
                Members & settings
              </button>
            </header>
            {error ||
            roomErrors[room.id] ||
            feedback[room.id] ||
            pending ||
            room.responders?.some((entry) => !entry.configured) ||
            (room.operations ?? []).some(
              (entry) => entry.id !== pendingByRoom[room.id]?.id,
            ) ? (
              <div
                className="rooms-chat-status"
                aria-label="Room delivery and setup"
              >
                {error || roomErrors[room.id] ? (
                  <p role="alert" className="form-error">
                    {roomErrors[room.id] || error}
                  </p>
                ) : null}
                {room.responders?.some((entry) => !entry.configured) ? (
                  <p className="room-setup-note">
                    No automatic wakeup for:{" "}
                    {room.responders
                      .filter((entry) => !entry.configured)
                      .map((entry) => `@${entry.name}`)
                      .join(", ")}
                    .{" "}
                    <button
                      type="button"
                      onClick={() =>
                        sdk.navigation.navigate(
                          "/plugins/zenx-triggers/triggers",
                        )
                      }
                    >
                      Configure Trigger…
                    </button>
                  </p>
                ) : null}
                {feedback[room.id] ? (
                  <p role="status">{feedback[room.id]}</p>
                ) : null}
                {pending ? (
                  <div role="status" className="room-send-pending">
                    {pending.messageId
                      ? `Message ${pending.messageId} saved; verify its wakeup status.`
                      : "Operation awaiting confirmation. This Room cannot silently resend it."}{" "}
                    <button
                      type="button"
                      onClick={() =>
                        void inspectPending(room.id, pending, false)
                      }
                    >
                      Check exact operation
                    </button>
                    {!pending.messageId ? (
                      <button
                        type="button"
                        onClick={() =>
                          void inspectPending(room.id, pending, true)
                        }
                      >
                        Send prepared operation (explicit)
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {(room.operations ?? [])
                  .filter((operation) => operation.id !== pending?.id)
                  .map((operation) => (
                    <div
                      className="room-send-pending"
                      key={operation.id}
                      role="status"
                    >
                      Unreviewed Room operation {operation.id.slice(0, 8)}:{" "}
                      {operation.messageId
                        ? "saved"
                        : "prepared / result unknown"}{" "}
                      · {Array.from(operation.text).slice(0, 70).join("")}{" "}
                      <button
                        type="button"
                        onClick={() =>
                          void inspectPending(
                            room.id,
                            {
                              id: operation.id,
                              text: operation.text,
                              revision: null,
                              messageId: operation.messageId,
                            },
                            false,
                          )
                        }
                      >
                        Check exact operation
                      </button>
                      {!operation.messageId ? (
                        <button
                          type="button"
                          onClick={() =>
                            void inspectPending(
                              room.id,
                              {
                                id: operation.id,
                                text: operation.text,
                                revision: null,
                                messageId: null,
                              },
                              true,
                            )
                          }
                        >
                          Send prepared operation (explicit)
                        </button>
                      ) : null}
                    </div>
                  ))}
              </div>
            ) : null}
            <div
              className="rooms-chat-feed"
              ref={feed}
              role="log"
              aria-label={`${room.name} messages`}
              onScroll={(event) => {
                const target = event.currentTarget;
                stickToBottom.current =
                  target.scrollHeight - target.scrollTop - target.clientHeight <
                  80;
              }}
            >
              {room.nextCursor !== null && room.nextCursor !== undefined ? (
                <button
                  type="button"
                  className="room-load-earlier"
                  disabled={loadingOlder}
                  onClick={() => void loadEarlier(room.id, room.nextCursor!)}
                >
                  {loadingOlder ? "Loading…" : "Load earlier messages"}
                </button>
              ) : null}
              {room.messages.length === 0 ? (
                <div className="rooms-chat-empty">
                  Start the conversation. @mention a registered member to
                  request an agent response.
                </div>
              ) : null}
              {room.messages.map((message) => (
                <article className="room-message" key={message.id}>
                  <header>
                    <strong>{message.author}</strong>
                    <span className="room-kind">{message.kind}</span>
                    <time dateTime={new Date(message.createdAt).toISOString()}>
                      {new Date(message.createdAt).toLocaleString()}
                    </time>
                  </header>
                  <Markdown text={message.text} />
                  {message.kind === "human" &&
                  deliveries[message.id]?.state === "saved" ? (
                    <small className="room-delivery">
                      Saved ·{" "}
                      {deliveries[message.id]!.mentions.map(
                        (mention) =>
                          `@${mention.name}: ${mention.deliveries.map((entry) => entry.status).join(", ")}`,
                      ).join(" · ") || "No @ wake requested"}
                    </small>
                  ) : message.kind === "human" &&
                    deliveries[message.id]?.state === "unknown" ? (
                    <small className="room-delivery">
                      Saved message · wake result unavailable
                    </small>
                  ) : null}
                </article>
              ))}
            </div>
            <div className="rooms-chat-compose">
              <div className="rooms-chat-mentions">
                {room.members.map((member) => (
                  <button
                    key={member.threadId}
                    type="button"
                    onClick={() => {
                      const input = composer.current;
                      const start = input?.selectionStart ?? draft.length;
                      const end = input?.selectionEnd ?? draft.length;
                      const token = `@${member.name} `;
                      revisions.current[room.id] =
                        (revisions.current[room.id] ?? 0) + 1;
                      setDrafts((current) => ({
                        ...current,
                        [room.id]: `${(current[room.id] ?? "").slice(0, start)}${token}${(current[room.id] ?? "").slice(end)}`,
                      }));
                      requestAnimationFrame(() => {
                        input?.focus();
                        input?.setSelectionRange(
                          start + token.length,
                          start + token.length,
                        );
                      });
                    }}
                  >
                    @{member.name}
                  </button>
                ))}
              </div>
              <label htmlFor="room-chat-input" className="sr-only">
                Message
              </label>
              <textarea
                ref={composer}
                id="room-chat-input"
                placeholder={`Message #${room.name} · Enter to send, Shift+Enter for newline`}
                value={draft}
                disabled={false}
                onChange={(event) => {
                  revisions.current[room.id] =
                    (revisions.current[room.id] ?? 0) + 1;
                  setDrafts((current) => ({
                    ...current,
                    [room.id]: event.target.value,
                  }));
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <button
                type="button"
                className="primary-button"
                disabled={
                  busy ||
                  sendingRooms[room.id] ||
                  pending !== null ||
                  !draft.trim()
                }
                onClick={() => void send()}
              >
                {sendingRooms[room.id] ? "Sending…" : "Send"}
              </button>
              <small>
                Only explicit @mentions with an active Room mention Trigger wake
                agents.
              </small>
            </div>
          </>
        )}
      </main>
      {panel !== null ? (
        <div
          className="rooms-chat-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDialog();
          }}
        >
          <section
            ref={dialog}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeDialog();
                return;
              }
              if (event.key !== "Tab") return;
              const targets = [
                ...(dialog.current?.querySelectorAll<HTMLElement>(
                  "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [role=combobox], summary, a[href]",
                ) ?? []),
              ];
              const first = targets[0],
                last = targets.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              }
              if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
            role="dialog"
            aria-modal="true"
            aria-label={panel === "create" ? "Create Room" : "Room settings"}
            className="rooms-chat-dialog"
          >
            <header>
              <h2>
                {panel === "create" ? "New Room" : `#${room?.name} settings`}
              </h2>
              <button ref={dialogClose} type="button" onClick={closeDialog}>
                Close
              </button>
            </header>
            <Field label="Room name" value={name} onChange={setName} />
            {panel === "manage" ? (
              <button
                type="button"
                disabled={busy || !name.trim() || name === room?.name}
                onClick={() =>
                  void run("rename", { roomId: room?.id, name }).then((ok) => {
                    if (ok) setPanel(null);
                  })
                }
              >
                Rename
              </button>
            ) : null}
            <Field
              label="Member name"
              value={memberName}
              onChange={setMemberName}
            />
            <label className="field">
              <span>Member conversation</span>
              <Combobox
                label="Member conversation"
                value={threadId}
                onValueChange={setThreadId}
              >
                {threads.map((thread) => (
                  <option key={thread.threadId} value={thread.threadId}>
                    {threadTitle(thread)} · {thread.threadId} ·{" "}
                    {"currentMetadata" in thread
                      ? thread.currentMetadata.cwd
                      : "Unavailable workspace"}
                  </option>
                ))}
              </Combobox>
            </label>
            {panel === "create" ? (
              <button
                type="button"
                className="primary-button"
                disabled={
                  busy || !name.trim() || !memberName.trim() || !threadId
                }
                onClick={() =>
                  void run("create", {
                    name,
                    members: [{ name: memberName, threadId }],
                  }).then((ok) => {
                    if (ok) setPanel(null);
                  })
                }
              >
                Create Room
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy || !memberName.trim() || !threadId}
                  onClick={() =>
                    void run("add-member", {
                      roomId: room?.id,
                      name: memberName,
                      threadId,
                    }).then((ok) => {
                      if (ok) {
                        setMemberName("");
                        setThreadId("");
                      }
                    })
                  }
                >
                  Add member
                </button>
                <h3>Members</h3>
                {room?.members.map((member) => (
                  <div className="rooms-chat-member" key={member.threadId}>
                    <strong>@{member.name}</strong>
                    <details>
                      <summary>Details</summary>
                      <code>{member.threadId}</code>
                    </details>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Remove @${member.name} from #${room.name}?`,
                          )
                        )
                          void run("remove-member", {
                            roomId: room.id,
                            threadId: member.threadId,
                          });
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="rooms-chat-danger"
                  disabled={busy}
                  onClick={() => {
                    if (
                      room &&
                      window.confirm(
                        `Permanently delete #${room.name} and its message history?`,
                      )
                    )
                      void run("delete", { roomId: room.id }).then((ok) => {
                        if (ok) setPanel(null);
                      });
                  }}
                >
                  Delete Room…
                </button>
              </>
            )}
            {error ? <p role="alert">{error}</p> : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
