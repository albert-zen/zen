import React, { useEffect, useRef, useState, type FormEvent } from "react";
import type { ThreadCandidate } from "../../main/thread-target.js";
import type { AutomationTargetPreview } from "../../main/automation-plugin-service.js";
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

interface TriggerEditor {
  id?: string;
  threadId: string;
  kind: TriggerKind;
  label: string;
  prompt: string;
  condition: string;
  runAt: string;
  interval: string;
  once: boolean;
  includeLatest: boolean;
}

export function localDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function blankEditor(threadId = ""): TriggerEditor {
  return {
    threadId,
    kind: "timer",
    label: "",
    prompt: "",
    condition: "",
    runAt: localDateTime(Date.now() + 5 * 60_000),
    interval: "",
    once: true,
    includeLatest: false,
  };
}

export function editorFromTrigger(trigger: ZenXTrigger): TriggerEditor {
  return {
    id: trigger.id,
    threadId: trigger.threadId,
    kind: trigger.kind,
    label: trigger.label,
    prompt: trigger.prompt,
    condition:
      trigger.watch?.threadId ??
      (trigger.room
        ? `${trigger.room.roomId}|${trigger.room.mention}`
        : (trigger.signal?.name ?? "")),
    runAt: localDateTime(trigger.timer?.nextRunAt ?? Date.now() + 5 * 60_000),
    interval: trigger.timer?.intervalMinutes?.toString() ?? "",
    once: trigger.watch?.once ?? true,
    includeLatest: false,
  };
}

export function triggerEditorInput(editor: TriggerEditor) {
  const common = {
    threadId: editor.threadId,
    kind: editor.kind,
    label: editor.label.trim(),
    prompt: editor.prompt.trim(),
    ...(editor.id === undefined ? {} : { id: editor.id }),
  };
  if (!common.threadId || !common.label || !common.prompt)
    throw new Error("Choose a target Thread and enter a name and instructions");
  if (editor.kind === "timer") {
    const runAt = new Date(editor.runAt).getTime();
    if (!Number.isFinite(runAt) || runAt <= Date.now())
      throw new Error("Choose a future local date and time");
    const intervalMinutes =
      editor.interval.trim() === "" ? undefined : Number(editor.interval);
    if (
      intervalMinutes !== undefined &&
      (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0)
    )
      throw new Error("Repeat interval must be positive minutes");
    return {
      ...common,
      runAt,
      ...(intervalMinutes === undefined ? {} : { intervalMinutes }),
    };
  }
  if (!editor.condition.trim()) throw new Error("Choose a trigger condition");
  if (editor.kind === "thread")
    return {
      ...common,
      watchedThreadId: editor.condition,
      once: editor.once,
      ...(editor.id === undefined
        ? { includeLatest: editor.includeLatest }
        : {}),
    };
  if (editor.kind === "roomMention") {
    const [roomId, mention] = editor.condition.split("|");
    return { ...common, roomId, mention };
  }
  return { ...common, signalName: editor.condition.trim() };
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    timeZoneName: "short",
  });
}

function conditionLabel(
  trigger: ZenXTrigger,
  threads: readonly ThreadCandidate[],
): string {
  if (trigger.timer)
    return `${trigger.timer.intervalMinutes === null ? "Once" : `Every ${trigger.timer.intervalMinutes} min`} · ${timeLabel(trigger.timer.nextRunAt)}`;
  if (trigger.watch)
    return `After ${threadLabel(threads, trigger.watch.threadId)} ends · ${trigger.watch.once ? "one attempt" : "each turn"}`;
  if (trigger.room) return `#${trigger.room.roomId} · @${trigger.room.mention}`;
  return `Signal: ${trigger.signal?.name ?? "unknown"}`;
}

export function safeProgramFailure(entry: TriggerHistoryEntry): string | null {
  if (
    entry.status !== "failed" ||
    entry.programOutcome === null ||
    entry.programOutcome === undefined
  )
    return null;
  const outcome = entry.programOutcome;
  // Host-classified fields only; never raw error, stdout, command or env.
  return `Program ${outcome.stage}: ${outcome.status}${outcome.exitCode === null ? "" : ` (exit ${outcome.exitCode})`}. Diagnostic history ${entry.id}.`;
}

function useTriggerData(sdk: PluginUiSdkV1) {
  const [data, setData] = useState<TriggerListResult>({
    triggers: [],
    history: [],
  });
  const [threads, setThreads] = useState<ThreadCandidate[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    const [listed, discovered, configured] = await Promise.all([
      sdk.commands.execute("list"),
      sdk.commands.execute("threads"),
      sdk.commands.execute("workspaces"),
    ]);
    setData(listed as TriggerListResult);
    setThreads((discovered as { threads: ThreadCandidate[] }).threads);
    setWorkspaces((configured as { workspaces: string[] }).workspaces);
  };
  useEffect(() => {
    void refresh().catch((reason: unknown) => setError(describeError(reason)));
    // Poll Host facts only; no scheduling in the renderer.
    const timer = setInterval(
      () =>
        void refresh().catch((reason: unknown) =>
          setError(describeError(reason)),
        ),
      3000,
    );
    return () => clearInterval(timer);
  }, [sdk]);
  return { data, threads, workspaces, error, setError, refresh };
}

function TriggerManager({
  sdk,
  scopedThreadId,
}: {
  sdk: PluginUiSdkV1;
  scopedThreadId?: string;
}) {
  const { data, threads, workspaces, error, setError, refresh } =
    useTriggerData(sdk);
  const [editor, setEditor] = useState<TriggerEditor>(() =>
    blankEditor(scopedThreadId),
  );
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [targetPreview, setTargetPreview] =
    useState<AutomationTargetPreview | null>(null);
  const [targetNotice, setTargetNotice] = useState("");
  const [retiredNotices, setRetiredNotices] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const createForm = useRef<HTMLFormElement>(null);
  const generation = useRef(0);
  const flight = useRef<{ generation: number } | null>(null);
  const pendingTarget = useRef<{ generation: number; threadId: string } | null>(
    null,
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      flight.current = null;
      pendingTarget.current = null;
    };
  }, []);
  const visible =
    scopedThreadId === undefined
      ? data.triggers
      : data.triggers.filter((item) => item.threadId === scopedThreadId);
  const history =
    scopedThreadId === undefined
      ? data.history
      : data.history.filter((entry) => entry.threadId === scopedThreadId);
  useEffect(() => {
    const pending = pendingTarget.current;
    if (
      !pending ||
      pending.generation !== generation.current ||
      !mounted.current ||
      !threads.some((candidate) => candidate.threadId === pending.threadId)
    )
      return;
    pendingTarget.current = null;
    setEditor((value) =>
      generation.current === pending.generation
        ? { ...value, threadId: pending.threadId }
        : value,
    );
  }, [threads]);
  const invalidateDraft = () => {
    generation.current++;
    flight.current = null; // This retires UI writes, not a Host request already admitted.
    pendingTarget.current = null;
    setBusy(false);
  };
  const begin = () => {
    if (flight.current !== null) return null; // Synchronous, even before React renders disabled.
    const token = { generation: generation.current };
    flight.current = token;
    setBusy(true);
    return token;
  };
  const current = (token: { generation: number }) =>
    mounted.current &&
    flight.current === token &&
    generation.current === token.generation;
  const finish = (token: { generation: number }) => {
    if (flight.current !== token) return;
    flight.current = null;
    if (mounted.current) setBusy(false);
  };
  const change = (patch: Partial<TriggerEditor>) => {
    if (flight.current !== null) invalidateDraft();
    setEditor((value) => ({ ...value, ...patch }));
  };
  const noteRetired = (message: string) => {
    if (mounted.current)
      setRetiredNotices((notices) => [...notices, message].slice(-5));
    else console.warn(message);
  };
  const run = async (command: string, input: Record<string, unknown>) => {
    const token = begin();
    if (token === null) return false;
    setError(null);
    try {
      try {
        await sdk.commands.execute(command, input);
      } catch (reason) {
        if (current(token))
          setError(
            `${describeError(reason)}. If the outcome is uncertain, inspect the list before retrying.`,
          );
        return false;
      }
      if (!current(token)) return false;
      try {
        await refresh();
      } catch (reason) {
        if (current(token))
          setError(
            `Action may have saved, but refresh failed: ${describeError(reason)}. Reopen before retrying.`,
          );
      }
      return current(token);
    } finally {
      finish(token);
    }
  };
  const previewDedicatedTarget = async () => {
    if (!workspace) return;
    const token = begin();
    if (token === null) return;
    setError(null);
    setTargetPreview(null);
    try {
      const preview = (await sdk.commands.execute("preview-target", {
        workspace,
      })) as AutomationTargetPreview;
      if (current(token)) setTargetPreview(preview);
    } catch (reason) {
      if (current(token)) setError(describeError(reason));
    } finally {
      finish(token);
    }
  };
  const createTarget = async () => {
    if (!workspace || targetPreview?.workspace !== workspace) return;
    const token = begin();
    if (token === null) return;
    setError(null);
    let createdId: string | null = null;
    try {
      const result = (await sdk.commands.execute("create-target", {
        workspace,
        preview: targetPreview,
      })) as { threadId: string; effective: AutomationTargetPreview };
      createdId = result.threadId;
      if (!current(token)) {
        noteRetired(
          `An earlier request created idle Thread ${result.threadId} after its form was left. Inspect it in Threads; no Trigger was saved or cancelled.`,
        );
        return;
      }
      setTargetNotice(
        `Dedicated Thread ${result.threadId} created with ${result.effective.sandbox} / ${result.effective.approvalPolicy}, model ${result.effective.modelId}. Save this trigger to bind it; if saving fails, this idle Thread remains available.`,
      );
      pendingTarget.current = {
        generation: token.generation,
        threadId: result.threadId,
      };
      await refresh();
      if (!current(token)) {
        pendingTarget.current = null;
        noteRetired(
          `An earlier request created idle Thread ${result.threadId} after its form was left. Inspect it in Threads; no Trigger was saved or cancelled.`,
        );
        return;
      }
      setTargetPreview(null);
      // The effect binds only after discovery has committed the new option.
    } catch (reason) {
      if (current(token)) {
        setTargetPreview(null);
        setError(
          `${createdId === null ? "" : `Idle Thread ${createdId} was created; `}${describeError(reason)}. Inspect Threads before retrying; do not assume the request was cancelled.`,
        );
      } else
        noteRetired(
          createdId === null
            ? "An earlier Thread creation did not return a confirmed outcome. Inspect Threads before retrying; leaving its form did not cancel the Host request."
            : `An earlier request created idle Thread ${createdId} after its form was left. Inspect it in Threads; no Trigger was saved or cancelled.`,
        );
    } finally {
      finish(token);
    }
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = begin();
    if (token === null) return;
    setError(null);
    try {
      const input = triggerEditorInput(editor);
      const result = (await sdk.commands.execute(
        editor.id ? "update" : "create",
        input,
      )) as { id?: string };
      if (!current(token)) {
        noteRetired(
          `An earlier form ${editor.id ? "updated" : "created"} Trigger ${result.id ?? editor.id ?? "(ID unavailable)"} after it was left. Inspect the list; it was not cancelled.`,
        );
        if (mounted.current) void refresh().catch(() => {});
        return;
      }
      try {
        await refresh();
      } catch (reason) {
        if (current(token))
          setError(
            `Action may have saved, but refresh failed: ${describeError(reason)}. Reopen before retrying.`,
          );
      }
      if (!current(token)) return;
      invalidateDraft();
      setEditing(false);
      setEditor(blankEditor(scopedThreadId));
      setTargetNotice("");
    } catch (reason) {
      if (current(token))
        setError(
          `${describeError(reason)}. If the outcome is uncertain, inspect the list before retrying.`,
        );
      else
        noteRetired(
          "An earlier Trigger save returned an uncertain outcome after its form was left. Inspect definitions before retrying; no Host cancellation was implied.",
        );
    } finally {
      finish(token);
    }
  };
  return (
    <div
      className={
        scopedThreadId
          ? "trigger-manager trigger-manager-rail"
          : "page-scroll trigger-manager"
      }
    >
      <header className="trigger-manager-header">
        <div>
          <h2>{scopedThreadId ? "Thread triggers" : "Automations"}</h2>
          <p>
            {scopedThreadId
              ? "Host schedules independently of this panel."
              : "Host schedules while running, even when this page is closed."}
          </p>
          {!scopedThreadId ? (
            <details>
              <summary>Scheduling and recovery</summary>
              <p>
                Sleep or Host exit pauses execution; missed timers fire at most
                once when Host resumes. Unknown deliveries are not retried
                automatically. Pausing or deleting a definition does not cancel
                an already accepted delivery.
              </p>
            </details>
          ) : null}
        </div>
        {scopedThreadId ? (
          <button
            className="quiet-button"
            type="button"
            onClick={() =>
              sdk.navigation.navigate("/plugins/zenx-triggers/triggers")
            }
          >
            All automations
          </button>
        ) : null}
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {retiredNotices.map((notice, index) => (
        <p role="status" key={`${index}:${notice}`}>
          {notice}
        </p>
      ))}
      <button
        type="button"
        className="primary-button"
        onClick={() => {
          invalidateDraft();
          setError(null);
          setTargetPreview(null);
          setTargetNotice("");
          setWorkspace("");
          setEditor(blankEditor(scopedThreadId));
          setEditing(true);
        }}
      >
        New trigger
      </button>
      {editing ? (
        <form
          className="page-card trigger-editor"
          ref={createForm}
          onSubmit={(event) => void save(event)}
        >
          <h3>{editor.id ? "Edit trigger" : "New trigger"}</h3>
          <div className="form-grid">
            <Field
              label="Name"
              value={editor.label}
              onChange={(value) => change({ label: value })}
            />
            <label className="field">
              <span>Type</span>
              <Select
                value={editor.kind}
                onValueChange={(value) =>
                  change({ kind: value as TriggerKind, condition: "" })
                }
              >
                <option value="timer">Timer</option>
                <option value="thread">Thread turn ended</option>
                <option value="roomMention">Room mention</option>
                <option value="signal">Signal</option>
              </Select>
            </label>
            {scopedThreadId ? (
              <p className="field">
                Target: {threadLabel(threads, scopedThreadId)}
              </p>
            ) : (
              <div className="trigger-target-picker">
                <ThreadPicker
                  label="Target Thread"
                  threads={threads}
                  value={editor.threadId}
                  onChange={(value) => {
                    if (value === editor.threadId) return;
                    invalidateDraft();
                    setTargetPreview(null);
                    change({ threadId: value });
                  }}
                />
                {!editor.id ? (
                  <div className="trigger-dedicated">
                    <label className="field">
                      <span>Or create a dedicated Thread in a workspace</span>
                      <Select
                        value={workspace}
                        onValueChange={(value) => {
                          if (value === workspace) return;
                          invalidateDraft();
                          setWorkspace(value);
                          setTargetPreview(null);
                        }}
                      >
                        <option value="">Select a configured workspace</option>
                        {workspaces.map((cwd) => (
                          <option key={cwd} value={cwd}>
                            {cwd}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <button
                      type="button"
                      className="quiet-button"
                      disabled={busy || !workspace}
                      onClick={() => void previewDedicatedTarget()}
                    >
                      Review Thread permissions
                    </button>
                    {targetPreview?.workspace === workspace ? (
                      <div
                        className="trigger-target-confirm"
                        role="group"
                        aria-label="Confirm dedicated Thread settings"
                      >
                        <p>Host defaults for this unattended Thread:</p>
                        <p>Configured workspace: {targetPreview.workspace}</p>
                        {targetPreview.resolvedWorkspace !==
                        targetPreview.workspace ? (
                          <p>
                            Actual directory for this Thread:{" "}
                            {targetPreview.resolvedWorkspace}
                          </p>
                        ) : null}
                        <p>
                          Model: {targetPreview.modelId} (profile{" "}
                          {targetPreview.providerProfileId}); effort{" "}
                          {targetPreview.reasoningEffort ?? "default"}
                        </p>
                        <p>
                          File access:{" "}
                          {targetPreview.sandbox === "danger-full-access"
                            ? "Full Access — may change files outside this workspace without sandbox approval"
                            : targetPreview.sandbox}
                          . Approval:{" "}
                          {targetPreview.approvalPolicy === "never"
                            ? "Never — actions may proceed without asking you"
                            : "On request"}
                          .
                        </p>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void createTarget()}
                        >
                          Confirm settings and create dedicated Thread
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            invalidateDraft();
                            setTargetPreview(null);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : null}
                    {targetNotice ? <p role="status">{targetNotice}</p> : null}
                  </div>
                ) : null}
              </div>
            )}
            {editor.kind === "timer" ? (
              <>
                <label className="field">
                  <span>Next run (local timezone)</span>
                  <input
                    type="datetime-local"
                    value={editor.runAt}
                    onChange={(event) => change({ runAt: event.target.value })}
                  />
                </label>
                <Field
                  label="Repeat every N minutes (blank = once)"
                  value={editor.interval}
                  onChange={(value) => change({ interval: value })}
                />
              </>
            ) : editor.kind === "thread" ? (
              <>
                <ThreadPicker
                  label="Watch Thread"
                  threads={threads}
                  value={editor.condition}
                  onChange={(value) => change({ condition: value })}
                />
                <label className="trigger-checkbox">
                  <input
                    type="checkbox"
                    checked={editor.once}
                    onChange={(event) => change({ once: event.target.checked })}
                  />
                  Only one attempt
                </label>
                {!editor.id ? (
                  <label className="trigger-checkbox">
                    <input
                      type="checkbox"
                      checked={editor.includeLatest}
                      onChange={(event) =>
                        change({ includeLatest: event.target.checked })
                      }
                    />
                    Include latest completed turn
                  </label>
                ) : null}
              </>
            ) : editor.kind === "roomMention" ? (
              <label className="field">
                <span>Room member</span>
                <Select
                  value={editor.condition}
                  onValueChange={(value) => change({ condition: value })}
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
            ) : (
              <Field
                label="Signal name"
                value={editor.condition}
                onChange={(value) => change({ condition: value })}
              />
            )}
            <label className="field wide">
              <span>Instructions for target Thread</span>
              <textarea
                value={editor.prompt}
                onChange={(event) => change({ prompt: event.target.value })}
              />
            </label>
          </div>
          <div className="trigger-actions">
            <button type="submit" className="primary-button" disabled={busy}>
              Save
            </button>
            <button
              type="button"
              className="quiet-button"
              onClick={() => {
                invalidateDraft();
                setEditing(false);
                setTargetPreview(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <section aria-label="Trigger definitions" className="trigger-grid">
        {visible.length === 0 ? (
          <p className="trigger-empty">
            No triggers yet. Create one above to notify a Thread.
          </p>
        ) : null}
        {visible.map((trigger) => {
          const last = history.find((entry) => entry.triggerId === trigger.id);
          return (
            <article className="page-card trigger-card" key={trigger.id}>
              <div className="trigger-card-heading">
                <h3>{trigger.label}</h3>
                <span>{trigger.active ? "Enabled" : "Paused"}</span>
              </div>
              <p>{conditionLabel(trigger, threads)}</p>
              {trigger.timer ? (
                <p>
                  Next run:{" "}
                  {trigger.active
                    ? timeLabel(trigger.timer.nextRunAt)
                    : "Paused"}
                </p>
              ) : null}
              <p>Target: {threadLabel(threads, trigger.threadId)}</p>
              <p className="trigger-instructions">{trigger.prompt}</p>
              <p>
                Last:{" "}
                {last
                  ? `${timeLabel(last.startedAt)} · ${deliveryLabel(last)}${safeProgramFailure(last) ? ` · ${safeProgramFailure(last)}` : last.error ? ` · ${last.error}` : ""}`
                  : "No runs yet"}
              </p>
              <div className="trigger-actions">
                <button
                  type="button"
                  disabled={busy || trigger.program !== undefined}
                  title={
                    trigger.program
                      ? "Program steps require the advanced API; editing here would discard private settings"
                      : undefined
                  }
                  className="quiet-button"
                  onClick={() => {
                    invalidateDraft();
                    setEditor(editorFromTrigger(trigger));
                    setEditing(true);
                    createForm.current?.scrollIntoView({ block: "nearest" });
                  }}
                >
                  Edit
                </button>
                {trigger.program ? (
                  <small>Program-managed; edit using the advanced API.</small>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  className="quiet-button"
                  onClick={() =>
                    void run(trigger.active ? "cancel" : "resume", {
                      triggerId: trigger.id,
                      ...(!trigger.active
                        ? { expectedRevision: trigger.definitionRevision ?? 0 }
                        : {}),
                    })
                  }
                >
                  {trigger.active ? "Pause" : "Enable"}
                </button>
                {confirmDelete === trigger.id ? (
                  <>
                    <span>Delete definition? History remains.</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run("delete", { triggerId: trigger.id }).then(
                          (saved) => {
                            if (saved) setConfirmDelete(null);
                          },
                        )
                      }
                    >
                      Confirm delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => setConfirmDelete(trigger.id)}
                  >
                    Delete…
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </section>
      <section aria-label="Trigger history" className="trigger-history-list">
        <h3>Recent runs</h3>
        {history.length === 0 ? (
          <p>No runs yet.</p>
        ) : (
          history.map((entry) => (
            <article
              className={`trigger-history ${entry.status}`}
              key={entry.id}
            >
              <strong>
                {data.triggers.find((item) => item.id === entry.triggerId)
                  ?.label ?? "Deleted trigger"}
              </strong>{" "}
              · {timeLabel(entry.startedAt)} · {deliveryLabel(entry)}
              <p>{entry.reason}</p>
              {safeProgramFailure(entry) ? (
                <p role="status">{safeProgramFailure(entry)}</p>
              ) : entry.error ? (
                <p role="status">{entry.error}</p>
              ) : null}
              <div className="trigger-actions">
                {entry.sourceThreadId ? (
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
                              [entry.id]: (value as { preview: string })
                                .preview,
                            })),
                          )
                          .catch((reason: unknown) =>
                            setError(describeError(reason)),
                          )
                      }
                    >
                      Source result
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
                      Source Thread
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() =>
                    sdk.navigation.navigate(
                      `/threads/${encodeURIComponent(entry.threadId)}`,
                    )
                  }
                >
                  Target Thread
                </button>
              </div>
              {previews[entry.id] ? <pre>{previews[entry.id]}</pre> : null}
            </article>
          ))
        )}
      </section>
    </div>
  );
}

export function TriggersPage({ sdk }: PluginUiSurfaceProps) {
  return <TriggerManager sdk={sdk} />;
}

function threadLabel(threads: readonly ThreadCandidate[], id: string): string {
  const thread = threads.find((candidate) => candidate.threadId === id);
  return thread === undefined
    ? `${id} (unavailable)`
    : `${thread.name ?? "Untitled"} · ${thread.shortId} · ${thread.status}${thread.archived ? " · archived" : ""}`;
}

function deliveryLabel(entry: TriggerHistoryEntry): string {
  switch (entry.delivery) {
    case "queued":
      return "Queued";
    case "pending":
      return "Sending";
    case "failed":
      return "Failed";
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
  const threadId = sdk.context["threadId"];
  if (typeof threadId !== "string") return null;
  return <TriggerManager key={threadId} sdk={sdk} scopedThreadId={threadId} />;
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
