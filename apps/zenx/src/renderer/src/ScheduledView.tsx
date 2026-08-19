import { useState } from "react";

import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type {
  TriggerKind,
  TriggerSnapshot,
  ZenXTrigger,
} from "../../main/trigger-types.js";
import { Icon } from "./icons.js";
import { threadTitle } from "./thread-list.js";

export function ScheduledView({
  snapshot,
  threads,
  roomsAvailable,
  onOpenThread,
  onOpenRoom,
  onOpenSidebar,
}: {
  snapshot: TriggerSnapshot;
  threads: readonly NativeThreadSummary[];
  roomsAvailable: boolean;
  onOpenThread(id: string): void;
  onOpenRoom(id: string): void;
  onOpenSidebar?(): void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [kind, setKind] = useState<TriggerKind>("timer");
  const [threadId, setThreadId] = useState(
    threads.find((thread) => thread.status !== "systemError")?.threadId ?? "",
  );
  const [label, setLabel] = useState("Wake up");
  const [prompt, setPrompt] = useState("");
  const [condition, setCondition] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelPending, setCancelPending] = useState<Set<string>>(new Set());
  const active = snapshot.triggers.filter((trigger) => trigger.active);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const common = { threadId, label, prompt };
      const input =
        kind === "timer"
          ? {
              ...common,
              kind,
              runAt: Date.now() + Number(condition) * 60_000,
            }
          : kind === "thread"
            ? { ...common, kind, watchedThreadId: condition }
            : kind === "roomMention"
              ? {
                  ...common,
                  kind,
                  roomId: condition.split("|")[0] ?? "",
                  mention: condition.split("|")[1] ?? "",
                }
              : { ...common, kind, signalName: condition };
      await window.zenx.triggers.create(input);
      setFormOpen(false);
      setPrompt("");
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    setCancelPending((current) => new Set(current).add(id));
    try {
      await window.zenx.triggers.cancel(id);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setCancelPending((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <section className="product-page scheduled-view">
      <header className="page-header">
        <div className="page-title">
          <button
            className="icon-button mobile-menu"
            type="button"
            aria-label="Open sidebar"
            onClick={onOpenSidebar}
          >
            <Icon name="tree" />
          </button>
          <div>
            <h1>Triggers</h1>
            <p>Schedules, external signals, and recent runs</p>
          </div>
        </div>
        <button
          className="primary-button"
          type="button"
          onClick={() => setFormOpen((value) => !value)}
        >
          <Icon name="compose" size={14} /> New trigger
        </button>
      </header>
      <div className="page-scroll">
        <div className="page-intro">
          <div>
            <h2>Agents sleep until something matters.</h2>
            <p>
              Every Trigger starts an ordinary Turn through the App Server.
              Scheduling and audit data stay in the ZenX outer layer.
            </p>
          </div>
        </div>

        <div className="metric-strip">
          <Metric value={active.length} label="Active triggers" />
          <Metric
            value={new Set(active.map((trigger) => trigger.threadId)).size}
            label="Watched Threads"
          />
          <Metric
            value={active.filter((trigger) => trigger.kind === "signal").length}
            label="External signals"
          />
        </div>

        {formOpen ? (
          <div className="page-card trigger-create-card">
            <div className="form-grid">
              <label className="field">
                <span>Target Thread</span>
                <select
                  value={threadId}
                  onChange={(event) => setThreadId(event.target.value)}
                >
                  {threads
                    .filter((thread) => thread.status !== "systemError")
                    .map((thread) => (
                      <option value={thread.threadId} key={thread.threadId}>
                        {threadTitle(thread)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Type</span>
                <select
                  value={kind}
                  onChange={(event) => {
                    const next = event.target.value as TriggerKind;
                    setKind(next);
                    setCondition(next === "timer" ? "5" : "");
                  }}
                >
                  <option value="timer">Timer</option>
                  <option value="thread">Thread completed</option>
                  {roomsAvailable ? (
                    <option value="roomMention">Room mention</option>
                  ) : null}
                  <option value="signal">External signal</option>
                </select>
              </label>
              <label className="field">
                <span>Label</span>
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              {kind === "thread" ? (
                <label className="field">
                  <span>Watched Thread</span>
                  <select
                    value={condition}
                    onChange={(event) => setCondition(event.target.value)}
                  >
                    <option value="">Choose Thread</option>
                    {threads
                      .filter((thread) => thread.status !== "systemError")
                      .map((thread) => (
                        <option value={thread.threadId} key={thread.threadId}>
                          {threadTitle(thread)}
                        </option>
                      ))}
                  </select>
                </label>
              ) : kind === "roomMention" ? (
                <label className="field">
                  <span>Room member</span>
                  <select
                    value={condition}
                    onChange={(event) => setCondition(event.target.value)}
                  >
                    <option value="">Choose membership</option>
                    {snapshot.rooms.flatMap((room) =>
                      room.members
                        .filter((member) => member.threadId === threadId)
                        .map((member) => (
                          <option
                            key={`${room.id}:${member.name}`}
                            value={`${room.id}|${member.name}`}
                          >
                            #{room.name} · @{member.name}
                          </option>
                        )),
                    )}
                  </select>
                </label>
              ) : (
                <label className="field">
                  <span>
                    {kind === "timer" ? "Minutes from now" : "Signal name"}
                  </span>
                  <input
                    value={condition}
                    onChange={(event) => setCondition(event.target.value)}
                  />
                </label>
              )}
              <label className="field wide">
                <span>Injected prompt</span>
                <textarea
                  rows={3}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </label>
            </div>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="form-actions">
              <button type="button" onClick={() => setFormOpen(false)}>
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={
                  busy ||
                  !threadId ||
                  !label.trim() ||
                  !prompt.trim() ||
                  !condition
                }
                onClick={() => void create()}
              >
                {busy ? "Creating…" : "Create Trigger"}
              </button>
            </div>
          </div>
        ) : null}

        <SectionHeading
          title="Active triggers"
          detail={
            active.length === 0 ? "None registered" : `${active.length} running`
          }
        />
        <div className="page-card">
          {active.length === 0 ? (
            <p className="page-empty">
              No Triggers are registered. Create one to wake a Thread from an
              explicit condition.
            </p>
          ) : (
            active.map((trigger) => (
              <TriggerRow
                trigger={trigger}
                key={trigger.id}
                onOpenThread={onOpenThread}
                onOpenRoom={onOpenRoom}
                onCancel={() => void cancel(trigger.id)}
                cancelling={cancelPending.has(trigger.id)}
              />
            ))
          )}
        </div>

        <SectionHeading
          title="Recent wakeups"
          detail={`Last ${Math.min(30, snapshot.history.length)} retained locally`}
        />
        <div className="page-card">
          {snapshot.history.length === 0 ? (
            <p className="page-empty">No Trigger has fired yet.</p>
          ) : (
            snapshot.history.slice(0, 30).map((entry) => (
              <button
                className="history-row"
                type="button"
                key={entry.id}
                onClick={() => onOpenThread(entry.threadId)}
              >
                <time>{new Date(entry.startedAt).toLocaleString()}</time>
                <div>
                  <strong>{entry.reason}</strong>
                  <small>{entry.error ?? `Status · ${entry.status}`}</small>
                </div>
                <span className={`kind-pill ${entry.status}`}>
                  {entry.status}
                </span>
              </button>
            ))
          )}
        </div>
        <SignalSimulator />
      </div>
    </section>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="page-card metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function SectionHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      <span>{detail}</span>
    </div>
  );
}

function TriggerRow({
  trigger,
  onOpenThread,
  onOpenRoom,
  onCancel,
  cancelling,
}: {
  trigger: ZenXTrigger;
  onOpenThread(id: string): void;
  onOpenRoom(id: string): void;
  onCancel(): void;
  cancelling: boolean;
}) {
  return (
    <div className="trigger-row-wrap">
      <button
        className="schedule-row"
        type="button"
        onClick={() =>
          trigger.kind === "roomMention" && trigger.room
            ? onOpenRoom(trigger.room.roomId)
            : onOpenThread(trigger.threadId)
        }
      >
        <span className={`kind-pill ${trigger.kind}`}>
          {trigger.kind === "roomMention" ? "Mention" : trigger.kind}
        </span>
        <div>
          <strong>{trigger.label}</strong>
          <small>{trigger.prompt}</small>
        </div>
        <time>
          {trigger.timer
            ? new Date(trigger.timer.nextRunAt).toLocaleString()
            : "Event driven"}
        </time>
      </button>
      <button
        className="quiet-button cancel-trigger"
        type="button"
        disabled={cancelling}
        onClick={onCancel}
      >
        {cancelling ? "Cancelling…" : "Cancel"}
      </button>
    </div>
  );
}

function SignalSimulator() {
  const [name, setName] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <SectionHeading title="Developer tools" detail="Local testing only" />
      <div className="page-card signal-card">
        <div>
          <h3>Signal simulator</h3>
          <p>
            Exercise a registered external-signal Trigger through the local
            renderer bridge.
          </p>
        </div>
        <div className="inline-form">
          <label className="field">
            <span>Signal</span>
            <input
              placeholder="deploy.completed"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Detail</span>
            <input
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => {
              setBusy(true);
              setError(null);
              void window.zenx.triggers
                .signal(name, detail)
                .then(() => {
                  setName("");
                  setDetail("");
                })
                .catch((reason: unknown) => setError(describeError(reason)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Simulating…" : "Simulate"}
          </button>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
