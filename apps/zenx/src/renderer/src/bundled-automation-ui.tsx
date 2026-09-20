import { useEffect, useRef, useState } from "react";
import type { ThreadCandidate } from "../../main/thread-target.js";
import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import { threadTitle } from "./thread-list.js";
import { Select, Combobox } from "./ui/controls.js";

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
  rooms: ZenXRoom[];
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
        <Select
          value={value}
          onValueChange={onChange}
        >
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
  const [name, setName] = useState("");
  const [memberName, setMemberName] = useState("");
  const [threadId, setThreadId] = useState("");
  const [draft, setDraft] = useState("");
  const [threads, setThreads] = useState<NativeThreadSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    const next = (await sdk.commands.execute("list")) as RoomListResult;
    setData(next);
    setSelected((current) =>
      current !== null && next.rooms.some((room) => room.id === current)
        ? current
        : (next.rooms[0]?.id ?? null),
    );
  };
  useEffect(() => {
    void window.zenx.threads
      .list()
      .then(setThreads)
      .catch((reason: unknown) => setError(describeError(reason)));
    void refresh().catch((reason: unknown) => setError(describeError(reason)));
  }, [sdk]);
  const room = data.rooms.find((candidate) => candidate.id === selected);
  const run = async (command: string, input: unknown) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await sdk.commands.execute(command, input);
      await refresh();
      return true;
    } catch (reason) {
      setError(describeError(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page-scroll rooms-overview">
      <div className="page-intro">
        <div>
          <h2>Rooms</h2>
          <p>
            Bring conversations together. Mention a registered member to wake
            its agent; other messages stay in the room.
          </p>
        </div>
      </div>
      <div className="page-card room-create-card">
        <h2>New Room</h2>
        <Field label="Room name" value={name} onChange={setName} />
        <Field
          label="First member"
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
        <button
          className="primary-button"
          disabled={busy || !name.trim() || !memberName.trim() || !threadId}
          type="button"
          onClick={() =>
            void run("create", {
              name,
              members: [{ name: memberName, threadId }],
            }).then((saved) => {
              if (saved) setName("");
            })
          }
        >
          Create Room
        </button>
      </div>
      {error === null ? null : <p role="alert">{error}</p>}
      <div className="rooms-layout">
        <nav className="room-list" aria-label="Rooms">
          {data.rooms.map((candidate) => (
            <button
              key={candidate.id}
              aria-current={candidate.id === selected ? "true" : undefined}
              type="button"
              onClick={() => setSelected(candidate.id)}
            >
              #{candidate.name}
            </button>
          ))}
        </nav>
        {room === undefined ? (
          <p>Create a room above to start a shared conversation.</p>
        ) : (
          <section className="page-card" aria-label={`Room ${room.name}`}>
            <h2>#{room.name}</h2>
            <button
              type="button"
              onClick={() => void run("delete", { roomId: room.id })}
            >
              Delete Room
            </button>
            <div className="form-grid">
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
            </div>
            <button
              type="button"
              onClick={() =>
                void run("add-member", {
                  roomId: room.id,
                  name: memberName,
                  threadId,
                })
              }
            >
              Add member
            </button>
            <ul>
              {room.members.map((member) => (
                <li key={member.threadId}>
                  @{member.name} · {member.threadId}{" "}
                  <button
                    type="button"
                    onClick={() =>
                      void run("remove-member", {
                        roomId: room.id,
                        threadId: member.threadId,
                      })
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <div className="room-messages">
              {room.messages.map((message) => (
                <p key={message.id}>
                  <strong>{message.author}</strong>: {message.text}
                </p>
              ))}
            </div>
            <Field label="Message" value={draft} onChange={setDraft} />
            <button
              type="button"
              disabled={busy || !draft.trim()}
              onClick={() =>
                void run("post-message", { roomId: room.id, text: draft }).then(
                  (saved) => {
                    if (saved) setDraft("");
                  },
                )
              }
            >
              Post message
            </button>
          </section>
        )}
      </div>
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
