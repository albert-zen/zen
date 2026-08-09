import { useState } from "react";

import type { Thread } from "../../protocol-client/index.js";
import type { TriggerKind, TriggerSnapshot } from "../../main/trigger-types.js";
import { Icon } from "./icons.js";

export function TriggerRail({
  thread,
  snapshot,
  threads,
}: {
  thread: Thread;
  snapshot: TriggerSnapshot;
  threads: readonly Thread[];
}) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<TriggerKind>("timer");
  const [label, setLabel] = useState("Wake up");
  const [prompt, setPrompt] = useState("");
  const [condition, setCondition] = useState("5");
  const [recurring, setRecurring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggers = snapshot.triggers.filter(
    (item) => item.threadId === thread.id && item.active,
  );
  const history = snapshot.history
    .filter((item) => item.threadId === thread.id)
    .slice(0, 20);

  const create = async () => {
    setError(null);
    try {
      const common = { threadId: thread.id, kind, label, prompt } as const;
      const input =
        kind === "timer"
          ? {
              ...common,
              kind,
              runAt: Date.now() + Number(condition) * 60_000,
              ...(recurring ? { intervalMinutes: Number(condition) } : {}),
            }
          : kind === "thread"
            ? { ...common, kind, watchedThreadId: condition }
            : kind === "roomMention"
              ? {
                  ...common,
                  kind,
                  roomId: condition.split("|")[0] ?? "",
                  mention: condition.split("|")[1] ?? "Zen",
                }
              : { ...common, kind, signalName: condition };
      await window.zenx.triggers.create(input);
      setAdding(false);
      setPrompt("");
    } catch (reason) {
      setError(describeError(reason));
    }
  };
  return (
    <div className="rail-content trigger-rail-content">
      <h2>
        Triggers <span>{triggers.length}</span>
      </h2>
      <p>
        Wake this thread with an explicit new turn. Idle threads with active
        triggers are Watching.
      </p>
      {triggers.map((trigger) => (
        <article className="trigger-card" key={trigger.id}>
          <header>
            <span>{kindLabel(trigger.kind)}</span>
            <button
              type="button"
              aria-label={`Cancel ${trigger.label}`}
              onClick={() => void window.zenx.triggers.cancel(trigger.id)}
            >
              ×
            </button>
          </header>
          <strong>{trigger.label}</strong>
          <p>{conditionLabel(trigger, snapshot)}</p>
          <small>↳ {trigger.prompt}</small>
        </article>
      ))}
      {triggers.length === 0 ? (
        <p className="rail-empty">
          No wakeup conditions. A direct message still starts a normal turn.
        </p>
      ) : null}
      {adding ? (
        <div className="trigger-form">
          <label>
            Type
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as TriggerKind);
                setCondition(event.target.value === "timer" ? "5" : "");
              }}
            >
              <option value="timer">Timer</option>
              <option value="thread">Thread turn completed</option>
              <option value="roomMention">Room @mention</option>
              <option value="signal">External signal</option>
            </select>
          </label>
          <label>
            Label
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          {kind === "thread" ? (
            <label>
              Thread
              <select
                value={condition}
                onChange={(event) => setCondition(event.target.value)}
              >
                <option value="">Choose thread</option>
                {threads
                  .filter((item) => item.id !== thread.id)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name ?? item.preview ?? item.id}
                    </option>
                  ))}
              </select>
            </label>
          ) : kind === "roomMention" ? (
            <label>
              Room member
              <select
                value={condition}
                onChange={(event) => setCondition(event.target.value)}
              >
                <option value="">Choose membership</option>
                {snapshot.rooms.flatMap((room) =>
                  room.members
                    .filter((member) => member.threadId === thread.id)
                    .map((member) => (
                      <option
                        key={`${room.id}-${member.name}`}
                        value={`${room.id}|${member.name}`}
                      >
                        #{room.name} · @{member.name}
                      </option>
                    )),
                )}
              </select>
            </label>
          ) : (
            <label>
              {kind === "timer" ? "Minutes from now" : "Signal name"}
              <input
                value={condition}
                onChange={(event) => setCondition(event.target.value)}
              />
            </label>
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
          <label>
            Injected prompt
            <textarea
              rows={4}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          {error ? (
            <span className="form-error" role="alert">
              {error}
            </span>
          ) : null}
          <div>
            <button type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => void create()}
            >
              Create trigger
            </button>
          </div>
        </div>
      ) : (
        <button
          className="add-trigger"
          type="button"
          onClick={() => setAdding(true)}
        >
          + New trigger
        </button>
      )}
      <h2 className="history-title">History</h2>
      {history.map((entry) => (
        <div className={`trigger-history ${entry.status}`} key={entry.id}>
          <time>
            {new Date(entry.startedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
          <div>
            <strong>{entry.reason}</strong>
            <span>
              {entry.status}
              {entry.error ? ` · ${entry.error}` : ""}
            </span>
          </div>
        </div>
      ))}
      {history.length === 0 ? (
        <p className="rail-empty">No wakeups have fired yet.</p>
      ) : null}
    </div>
  );
}

function kindLabel(kind: TriggerKind): string {
  return {
    timer: "Timer",
    thread: "Watching thread",
    roomMention: "Room mention",
    signal: "Signal",
  }[kind];
}
function conditionLabel(
  trigger: TriggerSnapshot["triggers"][number],
  snapshot: TriggerSnapshot,
): string {
  if (trigger.timer)
    return `Next ${new Date(trigger.timer.nextRunAt).toLocaleString()}`;
  if (trigger.watch)
    return `${trigger.watch.threadId.slice(0, 8)} · turn_completed`;
  if (trigger.room)
    return `#${snapshot.rooms.find((room) => room.id === trigger.room?.roomId)?.name ?? "missing"} @${trigger.room.mention}`;
  return `signal:${trigger.signal?.name ?? ""}`;
}
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
