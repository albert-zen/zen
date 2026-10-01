import React, {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { ThreadCandidate } from "../../main/thread-target.js";
import type { AutomationTargetPreview } from "../../main/automation-plugin-service.js";
import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import { threadTitle } from "./thread-list.js";
import { Select, Combobox } from "./ui/controls.js";
import { Markdown } from "./Markdown.js";
import { Icon } from "./icons.js";
import { ComposerShell, ComposerEditor, ComposerAction } from "./Composer.js";
import {
  ComposerSuggestions,
  handleComposerSuggestionKey,
} from "./ComposerSuggestions.js";
import { useRoomComposerSelector } from "./use-room-composer-selector.js";

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
const TRIGGERS_ROUTE = "/plugins/zenx-triggers/triggers";
const ROOMS_ROUTE = "/plugins/zenx-rooms/rooms";

interface RoomReplySetupIntent {
  roomId: string;
  member: string;
  threadId: string;
}

function routeQuery(route: unknown): URLSearchParams {
  const query = typeof route === "string" ? route.split("?", 2)[1] : undefined;
  return new URLSearchParams(query?.split("#", 1)[0]);
}

export function roomReplySetupRoute(
  roomId: string,
  member: string,
  threadId: string,
): string {
  return `${TRIGGERS_ROUTE}?${new URLSearchParams({ setup: "room-reply", roomId, member, threadId })}`;
}

interface TriggerListResult {
  triggers: ZenXTrigger[];
  history: TriggerHistoryEntry[];
  rooms?: ZenXRoom[];
}

interface RoomListResult {
  nextCursor?: number | null;
  rooms: Array<
    Omit<ZenXRoom, "operations"> & {
      assistantRepliesEnabled?: boolean;
      pendingCount?: number;
      operationEpoch?: string;
      messageCount?: number;
      nextCursor?: number | null;
      operations?: Array<{
        id: string;
        text: string;
        messageId: string | null;
        createdAt: number;
        acknowledged?: boolean;
        cancelled?: boolean;
      }>;
      responders?: Array<{ name: string; configured: boolean }>;
    }
  >;
}
interface RoomDeliveryResult {
  operationId?: string;
  text?: string;
  state: "prepared" | "saved" | "cancelled" | "unknown";
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
  cancelled?: boolean;
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
  sourceDevice?: string;
  sourceWorkspace?: string;
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

/** Navigation carries a UI intent only; exact Host facts supply the binding. */
export function roomReplySetupEditor(
  intent: RoomReplySetupIntent,
  rooms: readonly ZenXRoom[],
  threads: readonly ThreadCandidate[],
  triggers: readonly ZenXTrigger[],
):
  | { editor: TriggerEditor; roomName: string }
  | { error: string }
  | { notice: string } {
  const room = rooms.find((entry) => entry.id === intent.roomId);
  if (!room || room.assistant)
    return {
      error:
        "This Room is no longer available for automatic-reply setup. Return to Rooms and choose a current member.",
    };
  const member = room.members.find(
    (entry) =>
      entry.name === intent.member && entry.threadId === intent.threadId,
  );
  if (!member)
    return {
      error:
        "This Room member has changed or is no longer available. Return to the Room and choose a current member.",
    };
  const target = threads.find((entry) => entry.threadId === member.threadId);
  if (!target)
    return {
      error: `The conversation for @${member.name} is unavailable. Choose an available member conversation in Room settings first.`,
    };
  if (target.archived)
    return {
      error: `The conversation for @${member.name} is archived. Unarchive it before setting up automatic replies.`,
    };
  const matching = triggers.filter(
    (entry) =>
      entry.kind === "roomMention" &&
      entry.threadId === member.threadId &&
      entry.room?.roomId === room.id &&
      entry.room.mention.toLocaleLowerCase() ===
        member.name.toLocaleLowerCase(),
  );
  const existing = matching.find((entry) => entry.active) ?? matching[0];
  if (existing)
    return {
      notice: existing.active
        ? `Automatic replies for @${member.name} already have a trigger: ${existing.label}. Check its definition below or return to the Room.`
        : `The reply trigger for @${member.name}, ${existing.label}, is paused. Use Resume on its definition below to enable future replies.`,
    };
  return {
    editor: {
      ...blankEditor(member.threadId),
      kind: "roomMention",
      condition: `${room.id}|${member.name}`,
      label: `Reply as @${member.name}`,
    },
    roomName: room.name,
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
    sourceDevice: trigger.watch?.sourceDevice,
    sourceWorkspace: trigger.watch?.sourceWorkspace,
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
  if (editor.kind === "thread") {
    const sourceDevice = editor.sourceDevice?.trim();
    const remote = sourceDevice && sourceDevice !== "local";
    const sourceWorkspace = editor.sourceWorkspace?.trim();
    if (sourceWorkspace && !remote)
      throw new Error(
        "Choose a remote source device before a source workspace",
      );
    return {
      ...common,
      watchedThreadId: editor.condition,
      once: editor.once,
      ...(remote
        ? { sourceDevice, ...(sourceWorkspace ? { sourceWorkspace } : {}) }
        : {}),
      ...(editor.id === undefined
        ? { includeLatest: editor.includeLatest }
        : {}),
    };
  }
  if (editor.kind === "roomMention") {
    const separator = editor.condition.indexOf("|");
    if (separator < 1 || separator === editor.condition.length - 1)
      throw new Error("Choose a Room member");
    const roomId = editor.condition.slice(0, separator);
    const mention = editor.condition.slice(separator + 1);
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
    return `After ${trigger.watch.sourceDevice ? sourceIdentity(trigger.watch.sourceDevice, trigger.watch.sourceWorkspace, trigger.watch.threadId) : threadLabel(threads, trigger.watch.threadId)} ends · ${trigger.watch.once ? "one attempt" : "each turn"}`;
  if (trigger.room) return `#${trigger.room.roomId} · @${trigger.room.mention}`;
  return `Signal: ${trigger.signal?.name ?? "unknown"}`;
}

function sourceIdentity(
  device: string,
  workspace: string | undefined,
  threadId: string,
): string {
  return `${device}${workspace ? ` · ${workspace}` : ""} · Thread ${threadId}`;
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
  const [loaded, setLoaded] = useState(false);
  const refresh = async () => {
    const [listed, discovered, configured] = await Promise.all([
      sdk.commands.execute("list"),
      sdk.commands.execute("threads"),
      sdk.commands.execute("workspaces"),
    ]);
    setData(listed as TriggerListResult);
    setThreads((discovered as { threads: ThreadCandidate[] }).threads);
    setWorkspaces((configured as { workspaces: string[] }).workspaces);
    setLoaded(true);
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
  return { data, threads, workspaces, error, setError, refresh, loaded };
}

function TriggerManager({
  sdk,
  scopedThreadId,
  setupIntent,
}: {
  sdk: PluginUiSdkV1;
  scopedThreadId?: string;
  setupIntent?: RoomReplySetupIntent;
}) {
  const { data, threads, workspaces, error, setError, refresh, loaded } =
    useTriggerData(sdk);
  const [editor, setEditor] = useState<TriggerEditor>(() =>
    blankEditor(scopedThreadId),
  );
  const [editing, setEditing] = useState(false);
  const [setupNotice, setSetupNotice] = useState("");
  const setupHandled = useRef(false);
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
    if (!setupIntent || !loaded || setupHandled.current) return;
    setupHandled.current = true;
    const result = roomReplySetupEditor(
      setupIntent,
      data.rooms ?? [],
      threads,
      data.triggers,
    );
    if ("error" in result) setError(result.error);
    else if ("notice" in result) setSetupNotice(result.notice);
    else {
      setEditor(result.editor);
      setEditing(true);
      setSetupNotice(
        `Set up future @${setupIntent.member} replies in #${result.roomName}. Review the instructions and save to enable this trigger. Existing conversation permissions are unchanged; earlier messages are not replayed.`,
      );
    }
  }, [setupIntent, loaded, data, threads]);
  useEffect(() => {
    if (editing && setupIntent && setupHandled.current)
      createForm.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [
    editing,
    setupIntent?.roomId,
    setupIntent?.member,
    setupIntent?.threadId,
  ]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      flight.current = null;
      pendingTarget.current = null;
    };
  }, []);
  const roomSetupActive =
    setupIntent !== undefined &&
    editor.id === undefined &&
    editor.kind === "roomMention" &&
    editor.threadId === setupIntent.threadId &&
    editor.condition === `${setupIntent.roomId}|${setupIntent.member}`;
  const setupRoom = (data.rooms ?? []).find(
    (entry) => entry.id === setupIntent?.roomId,
  );
  const setupThread = threads.find(
    (entry) => entry.threadId === setupIntent?.threadId,
  );
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
  const backToRoom = () => {
    invalidateDraft();
    sdk.navigation.navigate(
      `${ROOMS_ROUTE}?${new URLSearchParams({ roomId: setupIntent!.roomId })}`,
    );
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
      if (
        setupIntent &&
        !editor.id &&
        editor.kind === "roomMention" &&
        editor.threadId === setupIntent.threadId &&
        editor.condition === `${setupIntent.roomId}|${setupIntent.member}`
      ) {
        const [listed, discovered] = await Promise.all([
          sdk.commands.execute("list"),
          sdk.commands.execute("threads"),
        ]);
        if (!current(token)) return;
        const facts = listed as TriggerListResult;
        const result = roomReplySetupEditor(
          setupIntent,
          facts.rooms ?? [],
          (discovered as { threads: ThreadCandidate[] }).threads,
          facts.triggers,
        );
        if ("error" in result) throw new Error(result.error);
        if ("notice" in result) throw new Error(result.notice);
      }
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
      setSetupNotice("");
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
      {setupIntent ? (
        <button type="button" className="quiet-button" onClick={backToRoom}>
          Back to Room
        </button>
      ) : null}
      {setupNotice ? <p role="status">{setupNotice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {retiredNotices.map((notice, index) => (
        <p role="status" key={`${index}:${notice}`}>
          {notice}
        </p>
      ))}
      {!setupIntent ? (
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            invalidateDraft();
            setError(null);
            setSetupNotice("");
            setTargetPreview(null);
            setTargetNotice("");
            setWorkspace("");
            setEditor(blankEditor(scopedThreadId));
            setEditing(true);
          }}
        >
          New trigger
        </button>
      ) : null}
      {editing ? (
        <form
          className={`page-card trigger-editor${roomSetupActive ? " trigger-room-setup" : ""}`}
          ref={createForm}
          onSubmit={(event) => void save(event)}
        >
          <h3>
            {roomSetupActive
              ? "Set up replies"
              : editor.id
                ? "Edit trigger"
                : "New trigger"}
          </h3>
          {roomSetupActive ? (
            <div
              className="trigger-room-context"
              role="group"
              aria-label="Room reply context"
            >
              <strong>
                Replies to @{setupIntent.member} in #
                {setupRoom?.name ?? setupIntent.roomId}
              </strong>
              <p title={setupIntent.threadId}>
                Runs in{" "}
                {setupThread
                  ? setupThread.name?.trim() || "Untitled conversation"
                  : setupIntent.threadId}
              </p>
              <small>
                Uses this conversation’s current model and permissions.
              </small>
            </div>
          ) : null}
          <div className="form-grid">
            <Field
              label="Name"
              value={editor.label}
              onChange={(value) => change({ label: value })}
            />
            {!roomSetupActive ? (
              <>
                <label className="field">
                  <span>Type</span>
                  <Select
                    value={editor.kind}
                    onValueChange={(value) =>
                      change({
                        kind: value as TriggerKind,
                        condition: "",
                        sourceDevice: undefined,
                        sourceWorkspace: undefined,
                      })
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
                          <span>
                            Or create a dedicated Thread in a workspace
                          </span>
                          <Select
                            value={workspace}
                            onValueChange={(value) => {
                              if (value === workspace) return;
                              invalidateDraft();
                              setWorkspace(value);
                              setTargetPreview(null);
                            }}
                          >
                            <option value="">
                              Select a configured workspace
                            </option>
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
                            <p>
                              Configured workspace: {targetPreview.workspace}
                            </p>
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
                        {targetNotice ? (
                          <p role="status">{targetNotice}</p>
                        ) : null}
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
                        onChange={(event) =>
                          change({ runAt: event.target.value })
                        }
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
                    {editor.id && editor.sourceDevice ? (
                      <p className="field wide">
                        Remote source:{" "}
                        {sourceIdentity(
                          editor.sourceDevice,
                          editor.sourceWorkspace,
                          editor.condition,
                        )}
                        . This edit keeps the exact source identity.
                      </p>
                    ) : (
                      <>
                        <Field
                          label="Source device ID (blank = this Host)"
                          value={editor.sourceDevice ?? ""}
                          onChange={(sourceDevice) =>
                            change({
                              sourceDevice,
                              sourceWorkspace: undefined,
                              condition: "",
                            })
                          }
                        />
                        {editor.sourceDevice?.trim() &&
                        editor.sourceDevice.trim() !== "local" ? (
                          <Field
                            label="Source workspace (optional)"
                            value={editor.sourceWorkspace ?? ""}
                            onChange={(sourceWorkspace) =>
                              change({ sourceWorkspace })
                            }
                          />
                        ) : null}
                        {editor.sourceDevice?.trim() &&
                        editor.sourceDevice.trim() !== "local" ? (
                          <Field
                            label="Remote Thread ID or exact title"
                            value={editor.condition}
                            onChange={(condition) => change({ condition })}
                          />
                        ) : (
                          <ThreadPicker
                            label="Watch Thread"
                            threads={threads}
                            value={editor.condition}
                            onChange={(value) => change({ condition: value })}
                          />
                        )}
                        {editor.sourceDevice?.trim() &&
                        editor.sourceDevice.trim() !== "local" ? (
                          <p className="field wide">
                            Use a configured Fleet device ID. The Host resolves
                            the remote source; notification delivery stays in
                            the selected local target Thread.
                          </p>
                        ) : null}
                      </>
                    )}
                    <label className="trigger-checkbox">
                      <input
                        type="checkbox"
                        checked={editor.once}
                        onChange={(event) =>
                          change({ once: event.target.checked })
                        }
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
              </>
            ) : null}
            <label className="field wide">
              <span>Instructions for target Thread</span>
              <textarea
                placeholder={
                  roomSetupActive
                    ? "Describe how this agent should respond when mentioned…"
                    : undefined
                }
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
                if (setupIntent) backToRoom();
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
              {trigger.sourceError ? (
                <p role="status">
                  Source connection error: {trigger.sourceError}
                </p>
              ) : null}
              {trigger.timer ? (
                <p>
                  Next run:{" "}
                  {trigger.active
                    ? timeLabel(trigger.timer.nextRunAt)
                    : "Paused"}
                </p>
              ) : null}
              <p>Target: {threadLabel(threads, trigger.threadId)}</p>
              <details className="trigger-instruction-details">
                <summary>Instructions</summary>
                <p className="trigger-instructions">{trigger.prompt}</p>
              </details>
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
              {entry.sourceDevice && entry.sourceThreadId ? (
                <p>
                  Remote source:{" "}
                  {sourceIdentity(
                    entry.sourceDevice,
                    entry.sourceWorkspace,
                    entry.sourceThreadId,
                  )}
                  {entry.sourceTurnId ? ` · Turn ${entry.sourceTurnId}` : ""}
                </p>
              ) : null}
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
                    {entry.sourceDevice === undefined ? (
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
                    ) : null}
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
  const route = typeof sdk.context.route === "string" ? sdk.context.route : "";
  const query = routeQuery(route);
  const setupIntent =
    query.get("setup") === "room-reply"
      ? {
          roomId: query.get("roomId") ?? "",
          member: query.get("member") ?? "",
          threadId: query.get("threadId") ?? "",
        }
      : undefined;
  return <TriggerManager key={route} sdk={sdk} setupIntent={setupIntent} />;
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

function memberConversationContext(
  thread: NativeThreadSummary,
  threads: readonly NativeThreadSummary[],
): string {
  const cwd =
    "currentMetadata" in thread ? thread.currentMetadata.cwd : undefined;
  const parts = cwd?.split(/[\\/]/u).filter(Boolean) ?? [];
  const workspace = !cwd
    ? "Unavailable workspace"
    : parts.length > 2
      ? `…/${parts.slice(-2).join("/")}`
      : cwd;
  let length = 12;
  while (
    length < thread.threadId.length &&
    threads.some(
      (other) =>
        other.threadId !== thread.threadId &&
        other.threadId.startsWith(thread.threadId.slice(0, length)),
    )
  )
    length += 4;
  return `${workspace} · ${thread.threadId.slice(0, length)}`;
}

export function RoomsPage({ sdk }: PluginUiSurfaceProps) {
  const initialRoomId = routeQuery(sdk.context?.route).get("roomId");
  const [assistantMode, setAssistantMode] = useState(false);
  const [data, setData] = useState<RoomListResult>({ rooms: [] });
  const [selected, setSelected] = useState<string | null>(initialRoomId);
  const [panel, setPanel] = useState<"create" | "manage" | null>(null);
  const [name, setName] = useState("");
  const [memberName, setMemberName] = useState("");
  const [threadId, setThreadId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [threads, setThreads] = useState<NativeThreadSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const actionBusy = useRef(false);
  const sending = useRef<Record<string, boolean>>({});
  const [sendingRooms, setSendingRooms] = useState<Record<string, boolean>>({});
  const selectedRef = useRef<string | null>(initialRoomId);
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
    // Confirmed receipts live on the message, not in the persistent chat rail.
    setFeedback((current) => ({ ...current, [roomId]: "" }));
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
    if (!next.rooms.some((entry) => entry.id === selectedRef.current))
      selectedRef.current = target?.id ?? null;
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
    for (const room of next.rooms) {
      const local = merged[room.id];
      // Only an exactly observed saved message and no outstanding Host
      // operation permit clearing a stale local success banner.
      if (
        local?.messageId &&
        room.messages.some((message) => message.id === local.messageId) &&
        !room.operations?.some((operation) => operation.id === local.id) &&
        room.pendingCount === 0
      )
        delete merged[room.id];
    }
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
            cancelled: operation.cancelled,
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
          cancelled: collected[0].cancelled,
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
  const changeRoomDraft = (text: string) => {
    if (!room) return;
    revisions.current[room.id] = (revisions.current[room.id] ?? 0) + 1;
    setDrafts((current) => ({ ...current, [room.id]: text }));
  };
  const roomSelector = useRoomComposerSelector({
    roomId: room?.id,
    draft,
    members: room?.assistant ? [] : (room?.members ?? []),
    textarea: composer,
    onChange: changeRoomDraft,
  });
  const roomSelectorId = useId();
  const pending = room === undefined ? null : (pendingByRoom[room.id] ?? null);
  const roomOperations = room?.operations ?? [];
  const visibleRoomOperations = roomOperations.slice(-3);
  const olderRoomOperations = roomOperations.slice(0, -3);
  const operationStateLabel = (operation: (typeof roomOperations)[number]) =>
    operation.cancelled
      ? "cancelled"
      : operation.messageId
        ? operation.acknowledged
          ? "saved · reviewed"
          : "saved"
        : "delivery unconfirmed";
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
    if (actionBusy.current) return false;
    actionBusy.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await sdk.commands.execute(command, input);
      await refresh();
      if (
        (command === "create" || command === "create-assistant") &&
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
      actionBusy.current = false;
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
      setRoomErrors((current) => ({
        ...current,
        [roomId]: `Send result unknown; check delivery before sending again. ${describeError(reason)}`,
      }));
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
            "Pending message text is unavailable; do not send again",
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
      else if (state.state === "cancelled") {
        if (pendingRef.current[roomId]?.id === entry.id)
          setRoomPending(roomId, null);
        setFeedback((current) => ({ ...current, [roomId]: "" }));
      } else
        setFeedback((current) => ({
          ...current,
          [roomId]:
            "Message has not been sent. Choose Send pending message to send it.",
        }));
      await refresh();
    } catch (reason) {
      setRoomErrors((current) => ({
        ...current,
        [roomId]: `Delivery remains unconfirmed. ${describeError(reason)}`,
      }));
    }
  };
  const cancelPrepared = async (roomId: string, entry: RoomPendingSend) => {
    setRoomErrors((current) => ({ ...current, [roomId]: "" }));
    try {
      // UNKNOWN is never a client-side cancellation fact.
      const exact = (await sdk.commands.execute("operation", {
        roomId,
        operationId: entry.id,
      })) as RoomDeliveryResult;
      if (exact.state === "saved" && exact.messageId) {
        await finishSaved(roomId, entry, exact);
        setRoomErrors((current) => ({
          ...current,
          [roomId]: `Already saved as message ${exact.messageId}; cancellation cannot withdraw it.`,
        }));
        await refresh();
        return;
      }
      if (exact.state === "prepared")
        await sdk.commands.execute("cancel-prepared", {
          roomId,
          operationId: entry.id,
        });
      const result = (await sdk.commands.execute("operation", {
        roomId,
        operationId: entry.id,
      })) as RoomDeliveryResult;
      if (result.state !== "cancelled")
        throw new Error("Cancellation not confirmed; check delivery");
      if (pendingRef.current[roomId]?.id === entry.id)
        setRoomPending(roomId, null);
      if (
        entry.revision !== null &&
        revisions.current[roomId] === entry.revision
      )
        setDrafts((current) =>
          current[roomId] === entry.text
            ? { ...current, [roomId]: "" }
            : current,
        );
      setFeedback((current) => ({ ...current, [roomId]: "" }));
      await refresh();
    } catch (reason) {
      // A lost cancel result is never permission to drop a possibly saved send.
      try {
        const exact = (await sdk.commands.execute("operation", {
          roomId,
          operationId: entry.id,
        })) as RoomDeliveryResult;
        if (exact.state === "cancelled") {
          if (pendingRef.current[roomId]?.id === entry.id)
            setRoomPending(roomId, null);
          await refresh();
          return;
        }
        if (exact.state === "saved" && exact.messageId) {
          await finishSaved(roomId, entry, exact);
          setRoomErrors((current) => ({
            ...current,
            [roomId]: `Already saved as message ${exact.messageId}; cancellation cannot withdraw it.`,
          }));
          await refresh();
          return;
        }
      } catch {
        // No exact receipt: keep the original intent and the next check path.
      }
      setRoomErrors((current) => ({
        ...current,
        [roomId]: `Cancellation result unknown; check delivery. ${describeError(reason)}`,
      }));
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
              setAssistantMode(false);
              setName("");
              setMemberName("");
              setThreadId("");
              setPanel("create");
            }}
          >
            <Icon name="plus" size={15} /> New
          </button>
          <button
            type="button"
            onClick={(event) => {
              dialogInvoker.current = event.currentTarget;
              setAssistantMode(true);
              setName("Always On Assistant");
              setMemberName("Assistant");
              setThreadId("");
              setPanel("create");
            }}
          >
            <Icon name="thread" size={15} /> Always On Assistant
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
            <strong>{entry.assistant ? entry.name : `#${entry.name}`}</strong>
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
            <h3>A place to work together</h3>
            <p>Create a room to bring your agents into one conversation.</p>
          </div>
        ) : (
          <>
            <header className="rooms-chat-header">
              <div>
                <h2>{room.assistant ? room.name : `#${room.name}`}</h2>
                {room.assistant ? (
                  <p className="room-assistant-state" role="status">
                    {room.assistantRepliesEnabled
                      ? "Assistant active"
                      : "Assistant paused or unavailable"}
                  </p>
                ) : null}
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
                <Icon name="users" size={16} /> Members & settings
              </button>
            </header>
            {room.assistant ? (
              <div className="room-assistant-controls">
                <span>
                  Uses an existing conversation. Sending may consume its model
                  quota. Close the window to keep running; Quit stops ZenX.
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run("assistant-replies", {
                      roomId: room.id,
                      enabled: !room.assistantRepliesEnabled,
                    })
                  }
                >
                  {room.assistantRepliesEnabled
                    ? "Pause assistant"
                    : "Resume assistant"}
                </button>
                <small>
                  Pause affects future messages only; already admitted work
                  continues in its source conversation.
                </small>
              </div>
            ) : null}
            {error ||
            roomErrors[room.id] ||
            feedback[room.id] ||
            pending ||
            (!room.assistant &&
              room.responders?.some((entry) => !entry.configured)) ||
            (room.operations ?? []).some(
              (entry) => entry.id !== pendingByRoom[room.id]?.id,
            ) ? (
              <div
                className="rooms-chat-status"
                aria-label="Room delivery and setup"
                tabIndex={0}
              >
                {error || roomErrors[room.id] ? (
                  <p role="alert" className="form-error">
                    {roomErrors[room.id] || error}
                  </p>
                ) : null}
                {!pending &&
                (room.operations ?? []).length === 0 &&
                !room.assistant &&
                room.responders?.some((entry) => !entry.configured) ? (
                  <p className="room-setup-note">
                    Automatic replies are not set up for:{" "}
                    {room.responders
                      .filter((entry) => !entry.configured)
                      .map((entry) => `@${entry.name}`)
                      .join(", ")}
                    .{" "}
                    {room.members
                      .filter((member) =>
                        room.responders?.some(
                          (entry) =>
                            entry.name === member.name && !entry.configured,
                        ),
                      )
                      .map((member) => (
                        <button
                          key={member.threadId}
                          type="button"
                          onClick={() =>
                            sdk.navigation.navigate(
                              roomReplySetupRoute(
                                room.id,
                                member.name,
                                member.threadId,
                              ),
                            )
                          }
                        >
                          Set up @{member.name} replies…
                        </button>
                      ))}
                  </p>
                ) : null}
                {feedback[room.id] ? (
                  <p role="status">{feedback[room.id]}</p>
                ) : null}
                {pending ? (
                  <div role="status" className="room-send-pending">
                    {pending.cancelled
                      ? "Send cancelled; no message was sent."
                      : pending.messageId
                        ? "Message saved; check its delivery status."
                        : "Delivery unconfirmed. Check its status before sending again."}{" "}
                    <button
                      type="button"
                      onClick={() =>
                        void inspectPending(room.id, pending, false)
                      }
                    >
                      Check delivery
                    </button>
                    {!pending.messageId && !pending.cancelled ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void cancelPrepared(room.id, pending)}
                        >
                          Cancel unsent message
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void inspectPending(room.id, pending, true)
                          }
                        >
                          Send pending message
                        </button>
                      </>
                    ) : null}
                  </div>
                ) : null}
                {visibleRoomOperations
                  .filter((operation) => operation.id !== pending?.id)
                  .map((operation) => (
                    <div
                      className="room-send-pending"
                      key={operation.id}
                      role="status"
                    >
                      Pending message: {operationStateLabel(operation)} ·{" "}
                      {Array.from(operation.text).slice(0, 70).join("")}{" "}
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
                        Check delivery
                      </button>
                      {!operation.messageId && !operation.cancelled ? (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              void cancelPrepared(room.id, {
                                id: operation.id,
                                text: operation.text,
                                revision: null,
                                messageId: null,
                              })
                            }
                          >
                            Cancel unsent message
                          </button>
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
                            Send pending message
                          </button>
                        </>
                      ) : null}
                    </div>
                  ))}
                {olderRoomOperations.length > 0 ? (
                  <details className="room-status-history">
                    <summary>
                      Earlier sends ({olderRoomOperations.length})
                    </summary>
                    {olderRoomOperations.map((operation) => (
                      <p className="room-send-pending" key={operation.id}>
                        {operationStateLabel(operation)} ·{" "}
                        {Array.from(operation.text).slice(0, 70).join("")}
                      </p>
                    ))}
                  </details>
                ) : null}
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
                  <h3>
                    {room.assistant
                      ? "What can I help with?"
                      : "Start the conversation"}
                  </h3>
                  <p>
                    {room.assistant
                      ? "Talk to your assistant here. No @mention needed. Send updates while work is in progress."
                      : "Type @ to choose an agent and ask for a reply."}
                  </p>
                </div>
              ) : null}
              {room.messages.map((message) => (
                <article
                  className="room-message"
                  data-kind={message.kind}
                  key={message.id}
                >
                  <header>
                    <span
                      className={`room-role room-role-${message.kind}`}
                      aria-label={`Message role: ${roomRoleLabel(message.kind)}`}
                    >
                      {roomRoleLabel(message.kind)}
                    </span>
                    <strong>{message.author}</strong>
                    <time
                      dateTime={new Date(message.createdAt).toISOString()}
                      title={new Date(message.createdAt).toLocaleString()}
                    >
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
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
                      ).join(" · ") || "No agent mentioned"}
                    </small>
                  ) : message.kind === "human" &&
                    deliveries[message.id]?.state === "unknown" ? (
                    <small className="room-delivery">
                      Message saved · agent response status unavailable
                    </small>
                  ) : null}
                  {message.kind === "human" || message.originThreadId ? (
                    <details className="room-message-details">
                      <summary>Message details</summary>
                      <span>Message ID: {message.id}</span>
                      {message.originThreadId ? (
                        <span>
                          Source conversation: {message.originThreadId}
                        </span>
                      ) : null}
                      {message.originTurnId ? (
                        <span>Turn: {message.originTurnId}</span>
                      ) : null}
                      {deliveries[message.id]?.operationId ? (
                        <span>
                          Operation ID: {deliveries[message.id]!.operationId}
                        </span>
                      ) : null}
                    </details>
                  ) : null}
                </article>
              ))}
            </div>
            <div className="rooms-chat-compose">
              <ComposerShell
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
              >
                <ComposerSuggestions
                  id={roomSelectorId}
                  selector={roomSelector}
                  textarea={composer}
                  label="Room members"
                  hint="Choose a room member to address."
                />
                <label htmlFor="room-chat-input" className="sr-only">
                  Message
                </label>
                <ComposerEditor
                  textareaRef={composer}
                  id="room-chat-input"
                  aria-label="Message"
                  aria-controls={roomSelector.open ? roomSelectorId : undefined}
                  aria-activedescendant={
                    roomSelector.open && roomSelector.rows.length
                      ? `${roomSelectorId}-${roomSelector.active}`
                      : undefined
                  }
                  aria-describedby={
                    roomSelector.open ? `${roomSelectorId}-hint` : undefined
                  }
                  placeholder={
                    room.assistant
                      ? `Message ${room.name}…`
                      : `Message #${room.name}…`
                  }
                  value={draft}
                  onSelect={(event) => roomSelector.select(event.currentTarget)}
                  onBlur={() => roomSelector.dismiss()}
                  onChange={(event) => {
                    roomSelector.reopen();
                    roomSelector.select(event.currentTarget ?? event.target);
                    changeRoomDraft(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (handleComposerSuggestionKey(event, roomSelector))
                      return;
                    if (
                      event.key !== "Enter" ||
                      event.shiftKey ||
                      event.nativeEvent.isComposing
                    )
                      return;
                    event.preventDefault();
                    if (!event.repeat) void send();
                  }}
                />
                <div className="composer-rail">
                  <div className="composer-tools">
                    {!room.assistant && room.members.length > 0 ? (
                      <button
                        className="composer-tool icon-only room-mention-tool"
                        type="button"
                        aria-label="Mention a room member"
                        title="Mention a room member"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => roomSelector.openMembers()}
                      >
                        @
                      </button>
                    ) : null}
                    <small className="room-composer-note">
                      {room.assistant
                        ? room.assistantRepliesEnabled
                          ? "Messages join ongoing work at the next model cycle."
                          : "Replies paused. Messages are saved only; resuming does not replay them."
                        : "@mention an agent to request a reply"}
                    </small>
                  </div>
                  <div className="composer-actions">
                    <ComposerAction
                      label={sendingRooms[room.id] ? "Sending…" : "Send"}
                      disabled={
                        busy ||
                        sendingRooms[room.id] ||
                        pending !== null ||
                        (room.operations?.length ?? 0) > 0 ||
                        !draft.trim()
                      }
                      onClick={() => void send()}
                    />
                  </div>
                </div>
              </ComposerShell>
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
                {panel === "create"
                  ? assistantMode
                    ? "New assistant conversation"
                    : "New Room"
                  : `#${room?.name} settings`}
              </h2>
              <button ref={dialogClose} type="button" onClick={closeDialog}>
                Close
              </button>
            </header>
            {panel === "create" && assistantMode ? (
              <p className="room-assistant-disclosure">
                Choose an existing Thread for the Always On Assistant preset.
                Messages join its ongoing work. It uses Rooms to communicate,
                Triggers to continue after waits, and Fleet-enabled self-control
                to work with configured devices. Enable Rooms, Triggers and
                self-control first. Existing model and permissions are
                preserved.
              </p>
            ) : null}
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
            {panel === "create" || !room?.assistant ? (
              <>
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
                      <option
                        key={thread.threadId}
                        value={thread.threadId}
                        title={`${threadTitle(thread)} · ${thread.threadId} · ${"currentMetadata" in thread ? thread.currentMetadata.cwd : "Unavailable workspace"}`}
                      >
                        <span className="room-member-choice">
                          <span className="room-member-choice-title">
                            {threadTitle(thread)}
                          </span>{" "}
                          <small>
                            {memberConversationContext(thread, threads)}
                          </small>
                        </span>
                      </option>
                    ))}
                  </Combobox>
                </label>
              </>
            ) : null}
            {panel === "create" ? (
              <button
                type="button"
                className="primary-button"
                disabled={
                  busy || !name.trim() || !memberName.trim() || !threadId
                }
                onClick={() =>
                  void run(assistantMode ? "create-assistant" : "create", {
                    name,
                    members: [{ name: memberName, threadId }],
                  }).then((ok) => {
                    if (ok) setPanel(null);
                  })
                }
              >
                {assistantMode ? "Create assistant" : "Create Room"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={
                    busy ||
                    Boolean(room?.assistant) ||
                    !memberName.trim() ||
                    !threadId
                  }
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
                      disabled={busy || Boolean(room.assistant)}
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

function roomRoleLabel(kind: ZenXRoom["messages"][number]["kind"]): string {
  if (kind === "human") return "You";
  if (kind === "agent") return "Agent";
  return "System";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
