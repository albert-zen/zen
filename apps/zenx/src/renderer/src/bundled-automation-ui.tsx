import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { useContext, useLayoutEffect } from "react";
import { RoomDraftContext } from "./room-drafts.js";
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
import { PluginRequirementsPreview } from "./PluginRequirementsPreview.js";
import { PAW_PLUGIN_REQUIREMENTS } from "../../assistant-preset-requirements.js";

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
  receipt?: "delivered" | "unknown";
  readers?: Array<{
    threadId: string;
    name: string;
    state: "read" | "unconfirmed" | "unavailable";
  }>;
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
      error: i18n.t("panels:thisRoomIsNoLongerAvailableFor"),
    };
  const member = room.members.find(
    (entry) =>
      entry.name === intent.member && entry.threadId === intent.threadId,
  );
  if (!member)
    return {
      error: i18n.t("panels:thisRoomMemberHasChangedOrIs"),
    };
  const target = threads.find((entry) => entry.threadId === member.threadId);
  if (!target)
    return {
      error: i18n.t("panels:conversationForUnavailable", { name: member.name }),
    };
  if (target.archived)
    return {
      error: i18n.t("panels:conversationForArchived", { name: member.name }),
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
        ? i18n.t("panels:existingReplyTrigger", {
            name: member.name,
            trigger: existing.label,
          })
        : i18n.t("panels:pausedReplyTrigger", {
            name: member.name,
            trigger: existing.label,
          }),
    };
  return {
    editor: {
      ...blankEditor(member.threadId),
      kind: "roomMention",
      condition: `${room.id}|${member.name}`,
      label: i18n.t("panels:replyAsMember", { name: member.name }),
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
    throw new Error(i18n.t("panels:chooseATargetThreadAndEnterA"));
  if (editor.kind === "timer") {
    const runAt = new Date(editor.runAt).getTime();
    if (!Number.isFinite(runAt) || runAt <= Date.now())
      throw new Error(i18n.t("panels:chooseAFutureLocalDateAndTime"));
    const intervalMinutes =
      editor.interval.trim() === "" ? undefined : Number(editor.interval);
    if (
      intervalMinutes !== undefined &&
      (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0)
    )
      throw new Error(i18n.t("panels:repeatIntervalMustBePositiveMinutes"));
    return {
      ...common,
      runAt,
      ...(intervalMinutes === undefined ? {} : { intervalMinutes }),
    };
  }
  if (!editor.condition.trim())
    throw new Error(i18n.t("panels:chooseATriggerCondition"));
  if (editor.kind === "thread") {
    const sourceDevice = editor.sourceDevice?.trim();
    const remote = sourceDevice && sourceDevice !== "local";
    const sourceWorkspace = editor.sourceWorkspace?.trim();
    if (sourceWorkspace && !remote)
      throw new Error(i18n.t("panels:chooseARemoteSourceDeviceBeforeA"));
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
      throw new Error(i18n.t("panels:chooseARoomMember"));
    const roomId = editor.condition.slice(0, separator);
    const mention = editor.condition.slice(separator + 1);
    return { ...common, roomId, mention };
  }
  return { ...common, signalName: editor.condition.trim() };
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString(i18n.resolvedLanguage, {
    timeZoneName: "short",
  });
}

function conditionLabel(
  trigger: ZenXTrigger,
  threads: readonly ThreadCandidate[],
): string {
  if (trigger.timer)
    return trigger.timer.intervalMinutes === null
      ? i18n.t("panels:onceAt", { time: timeLabel(trigger.timer.nextRunAt) })
      : i18n.t("panels:everyMinutesAt", {
          count: trigger.timer.intervalMinutes,
          time: timeLabel(trigger.timer.nextRunAt),
        });
  if (trigger.watch)
    return i18n.t("panels:afterThreadEnds", {
      name: trigger.watch.sourceDevice
        ? sourceIdentity(
            trigger.watch.sourceDevice,
            trigger.watch.sourceWorkspace,
            trigger.watch.threadId,
          )
        : threadLabel(threads, trigger.watch.threadId),
      mode: trigger.watch.once
        ? i18n.t("panels:oneAttempt")
        : i18n.t("panels:eachTurn"),
    });
  if (trigger.room) return `#${trigger.room.roomId} · @${trigger.room.mention}`;
  return i18n.t("panels:signalNameLabel", {
    name: trigger.signal?.name ?? i18n.t("panels:unknown"),
  });
}

function sourceIdentity(
  device: string,
  workspace: string | undefined,
  threadId: string,
): string {
  return i18n.t("panels:sourceThreadIdentity", {
    device,
    workspace: workspace ? ` · ${workspace}` : "",
    id: threadId,
  });
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
  return i18n.t("panels:programFailure", {
    stage: outcome.stage,
    status: outcome.status,
    exit:
      outcome.exitCode === null
        ? ""
        : i18n.t("panels:programExit", { code: outcome.exitCode }),
    id: entry.id,
  });
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
  useTranslation("panels");
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
        i18n.t("panels:newReplySetup", {
          name: setupIntent.member,
          room: result.roomName,
        }),
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
          i18n.t("panels:earlierIdleThreadCreated", { id: result.threadId }),
        );
        return;
      }
      setTargetNotice(
        i18n.t("panels:dedicatedThreadCreated", {
          id: result.threadId,
          sandbox: result.effective.sandbox,
          approval: result.effective.approvalPolicy,
          model: result.effective.modelId,
        }),
      );
      pendingTarget.current = {
        generation: token.generation,
        threadId: result.threadId,
      };
      await refresh();
      if (!current(token)) {
        pendingTarget.current = null;
        noteRetired(
          i18n.t("panels:earlierIdleThreadCreated", { id: result.threadId }),
        );
        return;
      }
      setTargetPreview(null);
      // The effect binds only after discovery has committed the new option.
    } catch (reason) {
      if (current(token)) {
        setTargetPreview(null);
        setError(
          i18n.t("panels:creationOutcomeUnknown", {
            prefix:
              createdId === null
                ? ""
                : i18n.t("panels:idleThreadCreatedPrefix", { id: createdId }),
            error: describeError(reason),
          }),
        );
      } else
        noteRetired(
          createdId === null
            ? i18n.t("panels:anEarlierThreadCreationDidNotReturn")
            : i18n.t("panels:earlierIdleThreadCreated", { id: createdId }),
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
          i18n.t("panels:earlierTriggerSaved", {
            action: editor.id
              ? i18n.t("panels:updated")
              : i18n.t("panels:created"),
            id: result.id ?? editor.id ?? i18n.t("panels:idUnavailable"),
          }),
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
        noteRetired(i18n.t("panels:anEarlierTriggerSaveReturnedAnUncertain"));
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
          <h2>
            {scopedThreadId
              ? i18n.t("panels:threadTriggers")
              : i18n.t("panels:automations")}
          </h2>
          <p>
            {scopedThreadId
              ? i18n.t("panels:hostSchedulesIndependentlyOfThisPanel")
              : i18n.t("panels:hostSchedulesWhileRunningEvenWhenThis")}
          </p>
          {!scopedThreadId ? (
            <details>
              <summary>{i18n.t("panels:schedulingAndRecovery")}</summary>
              <p>{i18n.t("panels:schedulingRecoveryDetails")}</p>
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
            {i18n.t("panels:allAutomations")}
          </button>
        ) : null}
      </header>
      {setupIntent ? (
        <button type="button" className="quiet-button" onClick={backToRoom}>
          {i18n.t("panels:backToRoom")}
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
          {i18n.t("panels:newTrigger")}
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
              ? i18n.t("panels:setUpReplies")
              : editor.id
                ? i18n.t("panels:editTrigger")
                : i18n.t("panels:newTrigger")}
          </h3>
          {roomSetupActive ? (
            <div
              className="trigger-room-context"
              role="group"
              aria-label={i18n.t("panels:roomReplyContext")}
            >
              <strong>
                {i18n.t("panels:repliesToInRoom", {
                  member: setupIntent.member,
                  room: setupRoom?.name ?? setupIntent.roomId,
                })}
              </strong>
              <p title={setupIntent.threadId}>
                {i18n.t("panels:runsIn")}{" "}
                {setupThread
                  ? setupThread.name?.trim() ||
                    i18n.t("panels:untitledConversation")
                  : setupIntent.threadId}
              </p>
              <small>
                {i18n.t("panels:usesThisConversationSCurrentModelAnd")}
              </small>
            </div>
          ) : null}
          <div className="form-grid">
            <Field
              label={i18n.t("panels:name")}
              value={editor.label}
              onChange={(value) => change({ label: value })}
            />
            {!roomSetupActive ? (
              <>
                <label className="field">
                  <span>{i18n.t("panels:type")}</span>
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
                    <option value="timer">{i18n.t("panels:timer")}</option>
                    <option value="thread">
                      {i18n.t("panels:threadTurnEnded")}
                    </option>
                    <option value="roomMention">
                      {i18n.t("panels:roomMention")}
                    </option>
                    <option value="signal">{i18n.t("panels:signal")}</option>
                  </Select>
                </label>
                {scopedThreadId ? (
                  <p className="field">
                    {i18n.t("panels:target")}{" "}
                    {threadLabel(threads, scopedThreadId)}
                  </p>
                ) : (
                  <div className="trigger-target-picker">
                    <ThreadPicker
                      label={i18n.t("panels:targetThread")}
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
                            {i18n.t("panels:orCreateADedicatedThreadInA")}
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
                              {i18n.t("panels:selectAConfiguredWorkspace")}
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
                          {i18n.t("panels:reviewThreadPermissions")}
                        </button>
                        {targetPreview?.workspace === workspace ? (
                          <div
                            className="trigger-target-confirm"
                            role="group"
                            aria-label={i18n.t(
                              "panels:confirmDedicatedThreadSettings",
                            )}
                          >
                            <p>
                              {i18n.t(
                                "panels:hostDefaultsForThisUnattendedThread",
                              )}
                            </p>
                            <p>
                              {i18n.t("panels:configuredWorkspace")}{" "}
                              {targetPreview.workspace}
                            </p>
                            {targetPreview.resolvedWorkspace !==
                            targetPreview.workspace ? (
                              <p>
                                {i18n.t("panels:actualDirectoryForThisThread")}{" "}
                                {targetPreview.resolvedWorkspace}
                              </p>
                            ) : null}
                            <p>
                              {i18n.t("panels:modelProfileEffort", {
                                model: targetPreview.modelId,
                                profile: targetPreview.providerProfileId,
                                effort:
                                  targetPreview.reasoningEffort ??
                                  i18n.t("panels:defaultEffort"),
                              })}
                            </p>
                            <p>
                              {i18n.t("panels:fileAccessApproval", {
                                access:
                                  targetPreview.sandbox === "danger-full-access"
                                    ? i18n.t(
                                        "panels:fullAccessMayChangeFilesOutsideThis",
                                      )
                                    : targetPreview.sandbox,
                                approval:
                                  targetPreview.approvalPolicy === "never"
                                    ? i18n.t(
                                        "panels:neverActionsMayProceedWithoutAskingYou",
                                      )
                                    : i18n.t("panels:onRequest"),
                              })}
                            </p>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void createTarget()}
                            >
                              {i18n.t(
                                "panels:confirmSettingsAndCreateDedicatedThread",
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                invalidateDraft();
                                setTargetPreview(null);
                              }}
                            >
                              {i18n.t("panels:cancel")}
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
                      <span>{i18n.t("panels:nextRunLocalTimezone")}</span>
                      <input
                        type="datetime-local"
                        value={editor.runAt}
                        onChange={(event) =>
                          change({ runAt: event.target.value })
                        }
                      />
                    </label>
                    <Field
                      label={i18n.t("panels:repeatEveryNMinutesBlankOnce")}
                      value={editor.interval}
                      onChange={(value) => change({ interval: value })}
                    />
                  </>
                ) : editor.kind === "thread" ? (
                  <>
                    {editor.id && editor.sourceDevice ? (
                      <p className="field wide">
                        {i18n.t("panels:remoteSource")}{" "}
                        {sourceIdentity(
                          editor.sourceDevice,
                          editor.sourceWorkspace,
                          editor.condition,
                        )}
                        {i18n.t("panels:thisEditKeepsTheExactSourceIdentity")}
                      </p>
                    ) : (
                      <>
                        <Field
                          label={i18n.t("panels:sourceDeviceIdBlankThisHost")}
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
                            label={i18n.t("panels:sourceWorkspaceOptional")}
                            value={editor.sourceWorkspace ?? ""}
                            onChange={(sourceWorkspace) =>
                              change({ sourceWorkspace })
                            }
                          />
                        ) : null}
                        {editor.sourceDevice?.trim() &&
                        editor.sourceDevice.trim() !== "local" ? (
                          <Field
                            label={i18n.t("panels:remoteThreadIdOrExactTitle")}
                            value={editor.condition}
                            onChange={(condition) => change({ condition })}
                          />
                        ) : (
                          <ThreadPicker
                            label={i18n.t("panels:watchThread")}
                            threads={threads}
                            value={editor.condition}
                            onChange={(value) => change({ condition: value })}
                          />
                        )}
                        {editor.sourceDevice?.trim() &&
                        editor.sourceDevice.trim() !== "local" ? (
                          <p className="field wide">
                            {i18n.t("panels:useAConfiguredFleetDeviceIdThe")}
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
                      {i18n.t("panels:onlyOneAttempt")}
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
                        {i18n.t("panels:includeLatestCompletedTurn")}
                      </label>
                    ) : null}
                  </>
                ) : editor.kind === "roomMention" ? (
                  <label className="field">
                    <span>{i18n.t("panels:roomMember")}</span>
                    <Select
                      value={editor.condition}
                      onValueChange={(value) => change({ condition: value })}
                    >
                      <option value="">
                        {i18n.t("panels:chooseMembership")}
                      </option>
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
                    label={i18n.t("panels:signalName")}
                    value={editor.condition}
                    onChange={(value) => change({ condition: value })}
                  />
                )}
              </>
            ) : null}
            <label className="field wide">
              <span>{i18n.t("panels:instructionsForTargetThread")}</span>
              <textarea
                placeholder={
                  roomSetupActive
                    ? i18n.t("panels:describeHowThisAgentShouldRespondWhen")
                    : undefined
                }
                value={editor.prompt}
                onChange={(event) => change({ prompt: event.target.value })}
              />
            </label>
          </div>
          <div className="trigger-actions">
            <button type="submit" className="primary-button" disabled={busy}>
              {i18n.t("panels:save")}
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
              {i18n.t("panels:cancel")}
            </button>
          </div>
        </form>
      ) : null}
      <section
        aria-label={i18n.t("panels:triggerDefinitions")}
        className="trigger-grid"
      >
        {visible.length === 0 ? (
          <p className="trigger-empty">
            {i18n.t("panels:noTriggersYetCreateOneAboveTo")}
          </p>
        ) : null}
        {visible.map((trigger) => {
          const last = history.find((entry) => entry.triggerId === trigger.id);
          return (
            <article className="page-card trigger-card" key={trigger.id}>
              <div className="trigger-card-heading">
                <h3>{trigger.label}</h3>
                <span>
                  {trigger.active
                    ? i18n.t("panels:enabled")
                    : i18n.t("panels:paused")}
                </span>
              </div>
              <p>{conditionLabel(trigger, threads)}</p>
              {trigger.sourceError ? (
                <p role="status">
                  {i18n.t("panels:sourceConnectionError")} {trigger.sourceError}
                </p>
              ) : null}
              {trigger.timer ? (
                <p>
                  {i18n.t("panels:nextRun")}{" "}
                  {trigger.active
                    ? timeLabel(trigger.timer.nextRunAt)
                    : i18n.t("panels:paused")}
                </p>
              ) : null}
              <p>
                {i18n.t("panels:target")}{" "}
                {threadLabel(threads, trigger.threadId)}
              </p>
              <details className="trigger-instruction-details">
                <summary>{i18n.t("panels:instructions")}</summary>
                <p className="trigger-instructions">{trigger.prompt}</p>
              </details>
              <p>
                {i18n.t("panels:last")}{" "}
                {last
                  ? `${timeLabel(last.startedAt)} · ${deliveryLabel(last)}${safeProgramFailure(last) ? ` · ${safeProgramFailure(last)}` : last.error ? ` · ${last.error}` : ""}`
                  : i18n.t("panels:noRunsYet")}
              </p>
              <div className="trigger-actions">
                <button
                  type="button"
                  disabled={busy || trigger.program !== undefined}
                  title={
                    trigger.program
                      ? i18n.t(
                          "panels:programStepsRequireTheAdvancedApiEditing",
                        )
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
                  {i18n.t("panels:edit")}
                </button>
                {trigger.program ? (
                  <small>
                    {i18n.t("panels:programManagedEditUsingTheAdvancedApi")}
                  </small>
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
                  {trigger.active
                    ? i18n.t("panels:pause")
                    : i18n.t("panels:enable")}
                </button>
                {confirmDelete === trigger.id ? (
                  <>
                    <span>
                      {i18n.t("panels:deleteDefinitionHistoryRemains")}
                    </span>
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
                      {i18n.t("panels:confirmDelete")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(null)}
                    >
                      {i18n.t("panels:cancel")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => setConfirmDelete(trigger.id)}
                  >
                    {i18n.t("panels:delete")}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </section>
      <section
        aria-label={i18n.t("panels:triggerHistory")}
        className="trigger-history-list"
      >
        <h3>{i18n.t("panels:recentRuns")}</h3>
        {history.length === 0 ? (
          <p>{i18n.t("panels:noRunsYet2")}</p>
        ) : (
          history.map((entry) => (
            <article
              className={`trigger-history ${entry.status}`}
              key={entry.id}
            >
              <strong>
                {data.triggers.find((item) => item.id === entry.triggerId)
                  ?.label ?? i18n.t("panels:deletedTrigger")}
              </strong>{" "}
              · {timeLabel(entry.startedAt)} · {deliveryLabel(entry)}
              <p>{entry.reason}</p>
              {entry.sourceDevice && entry.sourceThreadId ? (
                <p>
                  {i18n.t("panels:remoteSource")}{" "}
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
                      {i18n.t("panels:sourceResult")}
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
                        {i18n.t("panels:sourceThread")}
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
                  {i18n.t("panels:targetThread")}
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
  useTranslation("panels");
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
    ? i18n.t("panels:unavailableThreadId", { id })
    : `${thread.name ?? i18n.t("panels:untitled")} · ${thread.shortId} · ${thread.status}${thread.archived ? i18n.t("panels:archived") : ""}`;
}

function deliveryLabel(entry: TriggerHistoryEntry): string {
  switch (entry.delivery) {
    case "queued":
      return i18n.t("panels:queued");
    case "pending":
      return i18n.t("panels:sending");
    case "failed":
      return i18n.t("panels:failed");
    case "unknown":
      return i18n.t("panels:deliveryUnknownNotRetried");
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
  useTranslation("panels");
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
        <span>
          {i18n.t("panels:search")} {label}
        </span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={i18n.t("panels:titleShortIdOrWorkspace")}
        />
      </label>
      <label className="field">
        <span>{label}</span>
        <Select value={value} onValueChange={onChange}>
          <option value="">{i18n.t("panels:chooseAThread")}</option>
          {visible.map((thread) => (
            <option key={thread.threadId} value={thread.threadId}>
              {threadLabel(threads, thread.threadId)}
            </option>
          ))}
        </Select>
      </label>
      {visible.length === 0 ? (
        <small>{i18n.t("panels:noMatchingThreadsTryAnotherTitleOr")}</small>
      ) : null}
    </div>
  );
}

export function TriggersPanel({ sdk }: PluginUiSurfaceProps) {
  useTranslation("panels");
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
    ? i18n.t("panels:unavailableWorkspace")
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
  useTranslation("panels");
  const setupSdk = useRef(sdk);
  useLayoutEffect(() => {
    setupSdk.current = sdk;
  }, [sdk]);
  const initialRoomId = routeQuery(sdk.context?.route).get("roomId");
  const primaryNavigation = sdk.context?.primaryNavigation === true;
  const createIntent = routeQuery(sdk.context?.route).get("create");
  const viewEpoch = useRef(0);
  useLayoutEffect(() => {
    viewEpoch.current += 1;
    return () => {
      viewEpoch.current += 1;
    };
  }, [sdk.context?.route]);
  const [assistantMode, setAssistantMode] = useState(false);
  const [assistantPluginsReady, setAssistantPluginsReady] = useState(false);
  const [data, setData] = useState<RoomListResult>({ rooms: [] });
  const [selected, setSelected] = useState<string | null>(initialRoomId);
  const [panel, setPanel] = useState<"create" | "manage" | "rename" | null>(
    null,
  );
  const [name, setName] = useState("");
  const [memberName, setMemberName] = useState("");
  const [threadId, setThreadId] = useState("");
  const [assistantTarget, setAssistantTarget] = useState<"new" | "existing">(
    "new",
  );
  const [assistantWorkspaces, setAssistantWorkspaces] = useState<string[]>([]);
  const [assistantWorkspacesLoaded, setAssistantWorkspacesLoaded] =
    useState(false);
  const [assistantSetupSession, setAssistantSetupSession] = useState(0);
  const [assistantProjectNames, setAssistantProjectNames] = useState<
    Record<string, string>
  >({});
  const [assistantWorkspace, setAssistantWorkspace] = useState("");
  const [assistantTargetPreview, setAssistantTargetPreview] =
    useState<AutomationTargetPreview | null>(null);
  const [assistantSetupError, setAssistantSetupError] = useState<string | null>(
    null,
  );
  const assistantCreation = useRef<{
    operationId: string;
    input: unknown;
  } | null>(null);
  const [assistantCreationFailed, setAssistantCreationFailed] = useState(false);
  const assistantNameTooLong =
    new TextEncoder().encode(name.trim()).length > 128;
  const [localDrafts, setLocalDrafts] = useState<Record<string, string>>({});
  const [localReplies, setLocalReplies] = useState<
    Record<string, ZenXRoom["messages"][number]["replyTo"]>
  >({});
  const sharedDrafts = useContext(RoomDraftContext);
  const replies = sharedDrafts?.replies ?? localReplies;
  const setReplies = sharedDrafts?.setReplies ?? setLocalReplies;
  const localIntentRevisions = useRef<
    Record<
      string,
      { roomId: string; revision: number | null; settled: boolean }
    >
  >({});
  const intentRevisions = sharedDrafts?.intentRevisions ?? localIntentRevisions;
  const drafts = sharedDrafts?.drafts ?? localDrafts;
  const setDrafts = sharedDrafts?.setDrafts ?? setLocalDrafts;
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
  const localRevisions = useRef<Record<string, number>>({});
  const revisions = sharedDrafts?.revisions ?? localRevisions;
  const refreshSequence = useRef(0);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [deliveries, setDeliveries] = useState<
    Record<string, RoomDeliveryResult>
  >({});
  const composer = useRef<HTMLTextAreaElement>(null);
  const dialogClose = useRef<HTMLButtonElement>(null);
  const dialogEpoch = useRef(0);
  useLayoutEffect(() => {
    dialogEpoch.current += 1;
  }, [panel]);
  const dialog = useRef<HTMLElement>(null);
  const dialogInvoker = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!primaryNavigation) return;
    selectedRef.current = initialRoomId;
    setSelected(initialRoomId);
    setError(null);
    setPanel(null);
    if (createIntent === "room" || createIntent === "companion") {
      setAssistantMode(createIntent === "companion");
      setName(createIntent === "companion" ? "PAW" : "");
      setMemberName(createIntent === "companion" ? "Assistant" : "");
      setThreadId("");
      setAssistantTarget("new");
      setAssistantSetupSession((session) => session + 1);
      setAssistantWorkspace("");
      setAssistantTargetPreview(null);
      setAssistantSetupError(null);
      assistantCreation.current = null;
      setAssistantCreationFailed(false);
      setPanel("create");
    }
  }, [initialRoomId, primaryNavigation, createIntent]);
  // SDK wrappers change on ordinary parent polling, without a new setup intent.
  useEffect(() => {
    if (panel !== "create" || !assistantMode) return;
    let active = true;
    setAssistantWorkspaces([]);
    setAssistantWorkspacesLoaded(false);
    void Promise.all([
      setupSdk.current.commands.execute("workspaces"),
      window.zenx.projects?.get?.().catch(() => null) ?? Promise.resolve(null),
    ])
      .then(([result, projects]) => {
        if (!active) return;
        if (
          !Array.isArray(result) ||
          result.some((value) => typeof value !== "string")
        )
          throw new Error("Invalid configured Projects");
        setAssistantWorkspaces(result);
        setAssistantWorkspacesLoaded(true);
        setAssistantProjectNames(
          Object.fromEntries(
            projects?.projects
              .filter((project) => project.configured && project.name)
              .map((project) => [project.workspace, project.name!]) ?? [],
          ),
        );
        setAssistantWorkspace((current) =>
          result.includes(current)
            ? current
            : projects?.lastUsedWorkspace &&
                result.includes(projects.lastUsedWorkspace)
              ? projects.lastUsedWorkspace
              : (result[0] ?? ""),
        );
      })
      .catch(
        (reason: unknown) =>
          active && setAssistantSetupError(describeError(reason)),
      );
    return () => {
      active = false;
    };
  }, [panel, assistantMode, assistantSetupSession]);
  useEffect(() => {
    setAssistantTargetPreview(null);
    if (
      panel !== "create" ||
      !assistantMode ||
      assistantTarget !== "new" ||
      !assistantWorkspace
    )
      return;
    let active = true;
    setAssistantSetupError(null);
    void setupSdk.current.commands
      .execute("preview-target", { workspace: assistantWorkspace })
      .then((result) => {
        if (active)
          setAssistantTargetPreview(result as AutomationTargetPreview);
      })
      .catch(
        (reason: unknown) =>
          active && setAssistantSetupError(describeError(reason)),
      );
    return () => {
      active = false;
    };
  }, [
    panel,
    assistantMode,
    assistantTarget,
    assistantWorkspace,
    assistantSetupSession,
  ]);
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
    const revision =
      entry.revision ?? intentRevisions.current[entry.id]?.revision;
    if (revision != null && revisions.current[roomId] === revision) {
      setDrafts((current) => ({ ...current, [roomId]: "" }));
      setReplies((current) => ({ ...current, [roomId]: undefined }));
    }
    if (pendingRef.current[roomId]?.id === entry.id)
      setRoomPending(roomId, null);
    delete intentRevisions.current[entry.id];
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
  const finishCancelled = (roomId: string, entry: RoomPendingSend) => {
    if (pendingRef.current[roomId]?.id === entry.id)
      setRoomPending(roomId, null);
    const revision =
      entry.revision ?? intentRevisions.current[entry.id]?.revision;
    if (revision != null && revisions.current[roomId] === revision) {
      setDrafts((current) => ({ ...current, [roomId]: "" }));
      setReplies((current) => ({ ...current, [roomId]: undefined }));
    }
    delete intentRevisions.current[entry.id];
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
      const cached = historyCache.current[target.id];
      const desired = Math.min(
        target.messageCount,
        Math.max(
          4,
          (cached?.messages.length ?? 0) +
            Math.max(
              0,
              target.messageCount - (cached?.count ?? target.messageCount),
            ),
        ),
      );
      let cursor: number | null = 0;
      let messages: ZenXRoom["messages"] = [];
      do {
        const page = (await sdk.commands.execute("messages", {
          roomId: target.id,
          cursor,
        })) as { messages: ZenXRoom["messages"]; nextCursor: number | null };
        if (
          sequence !== refreshSequence.current ||
          (selectedRef.current !== null && selectedRef.current !== target.id)
        )
          return;
        messages = [...page.messages, ...messages];
        if (page.nextCursor !== null && page.nextCursor <= cursor)
          throw new Error(i18n.t("panels:roomHistoryCursorDidNotAdvance"));
        cursor = page.nextCursor;
      } while (cursor !== null && messages.length < desired);
      historyCache.current[target.id] = {
        messages,
        count: target.messageCount,
        nextCursor: cursor,
      };
      target.messages = messages;
      target.nextCursor = cursor;
    }
    if (sequence !== refreshSequence.current) return;
    setData({ ...next });
    setSelected((current) =>
      primaryNavigation ||
      (current !== null && next.rooms.some((entry) => entry.id === current))
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
                : (intentRevisions.current[operation.id]?.revision ?? null),
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
          revision: intentRevisions.current[collected[0].id]?.revision ?? null,
          messageId: collected[0].messageId,
          cancelled: collected[0].cancelled,
        };
      pendingRef.current = merged;
      setPendingByRoom(merged);
    }
    for (const listed of next.rooms) {
      if (
        listed.pendingCount === 0 &&
        !sending.current[listed.id] &&
        !pendingRef.current[listed.id]
      ) {
        for (const [key, intent] of Object.entries(intentRevisions.current))
          if (intent.roomId === listed.id && intent.settled)
            delete intentRevisions.current[key];
      }
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
    if (panel === "rename") dialog.current?.querySelector("input")?.focus();
    else if (panel !== null) dialogClose.current?.focus();
  }, [panel]);
  const closeDialog = () => {
    dialogEpoch.current += 1;
    setPanel(null);
    if (primaryNavigation && createIntent)
      sdk.navigation.navigate(
        selected
          ? `${ROOMS_ROUTE}?${new URLSearchParams({ roomId: selected })}`
          : ROOMS_ROUTE,
      );
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
    const epoch = viewEpoch.current;
    const creation = command === "create" || command === "create-assistant";
    const dialogToken = dialogEpoch.current;
    const current = () =>
      epoch === viewEpoch.current &&
      (!creation || dialogToken === dialogEpoch.current);
    actionBusy.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await sdk.commands.execute(command, input);
      if (!current()) return false;
      try {
        await refresh();
      } catch (reason) {
        if (current())
          setError(
            `Saved, but refresh failed: ${describeError(reason)}. Reopen the conversation to refresh.`,
          );
      }
      if (!current()) return false;
      if (
        creation &&
        result &&
        typeof result === "object" &&
        "id" in result &&
        typeof result.id === "string"
      ) {
        setSelected(result.id);
        if (primaryNavigation)
          sdk.navigation.navigate(
            `${ROOMS_ROUTE}?${new URLSearchParams({ roomId: result.id })}`,
          );
      }
      return true;
    } catch (reason) {
      if (!current()) return false;
      if (command === "create-assistant") setAssistantCreationFailed(true);
      setError(
        command === "create-assistant"
          ? `${describeError(reason)}. Close and reopen to edit setup; inspect any reported Thread before creating another.`
          : `Result unknown; refresh before repeating. ${describeError(reason)}`,
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
        [roomId]: i18n.t("panels:olderMessagesUnavailable", {
          error: describeError(reason),
        }),
      }));
    } finally {
      setLoadingOlder(false);
    }
  };
  const reacting = useRef(new Set<string>());
  const reactToMessage = async (
    roomId: string,
    messageId: string,
    emoji: string | null,
  ) => {
    const key = `${roomId}:${messageId}`;
    if (reacting.current.has(key)) return;
    reacting.current.add(key);
    try {
      const result = (await sdk.commands.execute("react", {
        roomId,
        messageId,
        emoji,
      })) as { message: ZenXRoom["messages"][number] };
      if (result.message?.id !== messageId || result.message.roomId !== roomId)
        throw new Error(i18n.t("panels:reactionReceiptIdentityMismatch"));
      const cached = historyCache.current[roomId];
      if (cached)
        cached.messages = cached.messages.map((message) =>
          message.id === messageId ? result.message : message,
        );
      setData((current) => ({
        ...current,
        rooms: current.rooms.map((entry) =>
          entry.id === roomId
            ? {
                ...entry,
                messages: entry.messages.map((message) =>
                  message.id === messageId ? result.message : message,
                ),
              }
            : entry,
        ),
      }));
      await refresh();
    } catch (reason) {
      setRoomErrors((current) => ({
        ...current,
        [roomId]: `Reaction result unconfirmed; refresh before retrying. ${describeError(reason)}`,
      }));
    } finally {
      reacting.current.delete(key);
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
    intentRevisions.current[entry.id] = {
      roomId,
      revision: entry.revision,
      settled: false,
    };
    sending.current[roomId] = true;
    setSendingRooms((current) => ({ ...current, [roomId]: true }));
    setRoomPending(roomId, entry);
    setRoomErrors((current) => ({ ...current, [roomId]: "" }));
    let postAttempted = false;
    try {
      await sdk.commands.execute("prepare-message", {
        roomId,
        operationId: entry.id,
        text,
        ...(replies[roomId]
          ? { replyToMessageId: replies[roomId]!.messageId }
          : {}),
      });
      postAttempted = true;
      const committed = (await sdk.commands.execute("post-message", {
        roomId,
        operationId: entry.id,
        text,
      })) as { messageId: string };
      if (!committed.messageId)
        throw new Error(i18n.t("panels:noImmutableRoomMessageIdReturned"));
      const status = (await sdk.commands.execute("operation", {
        roomId,
        operationId: entry.id,
      })) as RoomDeliveryResult;
      await finishSaved(roomId, entry, status);
      await refresh();
    } catch (reason) {
      if (!postAttempted) {
        // prepare cannot post. Preserve the draft and release only this local
        // send; refresh still exposes a Host preparation whose reply was lost.
        if (pendingRef.current[roomId]?.id === entry.id)
          setRoomPending(roomId, null);
        setRoomErrors((current) => ({
          ...current,
          [roomId]: `Message was not posted; preparation failed. ${describeError(reason)}`,
        }));
        try {
          await refresh();
        } catch (refreshError) {
          setRoomErrors((current) => ({
            ...current,
            [roomId]: `Message was not posted; could not check prepared operations. ${describeError(refreshError)}`,
          }));
        }
        return;
      }
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
      if (intentRevisions.current[entry.id])
        intentRevisions.current[entry.id]!.settled = true;
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
            i18n.t("panels:pendingMessageTextIsUnavailableDoNot"),
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
        finishCancelled(roomId, entry);
        setFeedback((current) => ({ ...current, [roomId]: "" }));
      } else
        setFeedback((current) => ({
          ...current,
          [roomId]: i18n.t("panels:messageHasNotBeenSentChooseSend"),
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
        throw new Error(i18n.t("panels:cancellationNotConfirmedCheckDelivery"));
      finishCancelled(roomId, entry);
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
          finishCancelled(roomId, entry);
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
    <div
      className={`rooms-chat${primaryNavigation ? " rooms-chat-primary" : ""}`}
    >
      {!primaryNavigation ? (
        <nav className="rooms-chat-list" aria-label={i18n.t("panels:rooms")}>
          <div className="rooms-chat-list-head">
            <strong>{i18n.t("panels:rooms")}</strong>
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
              <Icon name="plus" size={15} /> {i18n.t("panels:new")}
            </button>
            <button
              type="button"
              onClick={(event) => {
                dialogInvoker.current = event.currentTarget;
                setAssistantMode(true);
                setName("PAW");
                setMemberName("Assistant");
                setThreadId("");
                setAssistantTarget("new");
                setAssistantSetupSession((session) => session + 1);
                setAssistantWorkspace("");
                setAssistantTargetPreview(null);
                setAssistantSetupError(null);
                assistantCreation.current = null;
                setAssistantCreationFailed(false);
                setPanel("create");
              }}
            >
              <Icon name="thread" size={15} /> PAW
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
              <small>
                {entry.messages.at(-1)?.text ?? i18n.t("panels:noMessagesYet")}
              </small>
            </button>
          ))}
        </nav>
      ) : null}
      <main className="rooms-chat-main">
        {loading ? (
          <p className="rooms-chat-empty" role="status">
            {i18n.t("panels:loadingRooms")}
          </p>
        ) : room === undefined ? (
          <div className="rooms-chat-empty">
            <h3>{i18n.t("panels:aPlaceToWorkTogether")}</h3>
            <p>{i18n.t("panels:createARoomToBringYourAgents")}</p>
          </div>
        ) : (
          <>
            <header className="rooms-chat-header">
              <div>
                {!primaryNavigation ? (
                  <h2>{room.assistant ? room.name : `#${room.name}`}</h2>
                ) : null}
                {room.assistant && !room.assistantRepliesEnabled ? (
                  <p className="room-assistant-state" role="status">
                    {i18n.t("panels:repliesPaused")}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                aria-label={i18n.t("panels:renameConversation")}
                title={i18n.t("panels:renameConversation")}
                onClick={(event) => {
                  dialogInvoker.current = event.currentTarget;
                  setName(room.name);
                  setPanel("rename");
                }}
              >
                <Icon name="compose" size={16} />
              </button>
              {primaryNavigation ? (
                <button
                  id="thread-browser-toggle"
                  data-room-id={room.id}
                  type="button"
                  aria-label={i18n.t("panels:openConversationWorkspace")}
                  title={i18n.t("panels:openConversationWorkspace")}
                  onClick={() =>
                    sdk.navigation.navigate(
                      `${ROOMS_ROUTE}?${new URLSearchParams({ roomId: room.id, panel: "open" })}`,
                    )
                  }
                >
                  <Icon name="panel-right" size={16} />
                </button>
              ) : null}
              <button
                type="button"
                aria-label={i18n.t("panels:conversationSettings")}
                title={i18n.t("panels:conversationSettings")}
                onClick={(event) => {
                  dialogInvoker.current = event.currentTarget;
                  setName(room.name);
                  setPanel("manage");
                }}
              >
                <Icon name="settings" size={16} />
              </button>
            </header>
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
                aria-label={i18n.t("panels:roomDeliveryAndSetup")}
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
                    {i18n.t("panels:automaticRepliesAreNotSetUpFor")}{" "}
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
                          {i18n.t("panels:setupMemberReplies", {
                            member: member.name,
                          })}
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
                      ? i18n.t("panels:sendCancelledNoMessageWasSent")
                      : pending.messageId
                        ? i18n.t("panels:messageSavedCheckItsDeliveryStatus")
                        : i18n.t(
                            "panels:deliveryUnconfirmedCheckItsStatusBeforeSending",
                          )}{" "}
                    <button
                      type="button"
                      onClick={() =>
                        void inspectPending(room.id, pending, false)
                      }
                    >
                      {i18n.t("panels:checkDelivery")}
                    </button>
                    {!pending.messageId && !pending.cancelled ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void cancelPrepared(room.id, pending)}
                        >
                          {i18n.t("panels:cancelUnsentMessage")}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void inspectPending(room.id, pending, true)
                          }
                        >
                          {i18n.t("panels:sendPendingMessage")}
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
                      {i18n.t("panels:pendingMessage")}{" "}
                      {operationStateLabel(operation)} ·{" "}
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
                        {i18n.t("panels:checkDelivery")}
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
                            {i18n.t("panels:cancelUnsentMessage")}
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
                            {i18n.t("panels:sendPendingMessage")}
                          </button>
                        </>
                      ) : null}
                    </div>
                  ))}
                {olderRoomOperations.length > 0 ? (
                  <details className="room-status-history">
                    <summary>
                      {i18n.t("panels:earlierSends")}
                      {olderRoomOperations.length})
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
                  {loadingOlder
                    ? i18n.t("panels:loading")
                    : i18n.t("panels:loadEarlierMessages")}
                </button>
              ) : null}
              {room.messages.length === 0 ? (
                <div className="rooms-chat-empty">
                  <h3>
                    {room.assistant
                      ? i18n.t("panels:whatCanIHelpWith")
                      : i18n.t("panels:startTheConversation")}
                  </h3>
                  <p>
                    {room.assistant
                      ? i18n.t("panels:talkToYourPawHereNoMention")
                      : i18n.t("panels:typeToChooseAnAgentAndAsk")}
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
                    {message.author === roomRoleLabel(message.kind) ? null : (
                      <span
                        className={`room-role room-role-${message.kind}`}
                        aria-label={i18n.t("panels:messageRole", {
                          role: roomRoleLabel(message.kind),
                        })}
                      >
                        {roomRoleLabel(message.kind)}
                      </span>
                    )}
                    <strong>{message.author}</strong>
                    <time
                      dateTime={new Date(message.createdAt).toISOString()}
                      title={new Date(message.createdAt).toLocaleString(
                        i18n.resolvedLanguage,
                      )}
                    >
                      {new Date(message.createdAt).toLocaleTimeString(
                        i18n.resolvedLanguage,
                        {
                          hour: "2-digit",
                          minute: "2-digit",
                        },
                      )}
                    </time>
                  </header>
                  {message.replyTo ? (
                    <div
                      className="room-message-quote"
                      aria-label={i18n.t("panels:replyToAuthor", {
                        name: message.replyTo.author,
                      })}
                    >
                      <strong>{message.replyTo.author}</strong>
                      <p>{message.replyTo.text}</p>
                    </div>
                  ) : null}
                  <Markdown text={message.text} />
                  <div className="room-message-actions">
                    <button
                      type="button"
                      disabled={Boolean(pending) || sendingRooms[room.id]}
                      onClick={() => {
                        revisions.current[room.id] =
                          (revisions.current[room.id] ?? 0) + 1;
                        setReplies((current) => ({
                          ...current,
                          [room.id]: {
                            messageId: message.id,
                            author: message.author,
                            text: message.text,
                          },
                        }));
                        composer.current?.focus();
                      }}
                    >
                      {i18n.t("panels:reply")}
                    </button>
                    <details>
                      <summary>{i18n.t("panels:react")}</summary>
                      <div
                        className="room-reaction-options"
                        aria-label={i18n.t("panels:chooseReaction")}
                      >
                        {["👍", "❤️", "🎉", "👀", "✅", "🤔"].map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            aria-label={i18n.t("panels:reactEmoji", { emoji })}
                            aria-pressed={
                              message.reactions?.some(
                                (reaction) =>
                                  reaction.actorId === "user" &&
                                  reaction.emoji === emoji,
                              ) ?? false
                            }
                            onClick={() =>
                              void reactToMessage(
                                room.id,
                                message.id,
                                message.reactions?.some(
                                  (reaction) =>
                                    reaction.actorId === "user" &&
                                    reaction.emoji === emoji,
                                )
                                  ? null
                                  : emoji,
                              )
                            }
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </details>
                    {message.reactions?.map((reaction) => (
                      <span
                        key={reaction.actorId}
                        title={`${reaction.label}: ${reaction.emoji}`}
                        aria-label={i18n.t("panels:reactedEmoji", {
                          name: reaction.label,
                          emoji: reaction.emoji,
                        })}
                      >
                        {reaction.emoji}
                      </span>
                    ))}
                  </div>
                  {message.kind === "human" &&
                  (deliveries[message.id]?.receipt === "delivered" ||
                    deliveries[message.id]?.state === "saved") ? (
                    <small
                      className="room-delivery"
                      title={i18n.t(
                        "panels:deliveredSavedInThisRoomReadAdmitted",
                      )}
                    >
                      {i18n.t("panels:deliveredToRoom")}{" "}
                      {deliveries[message.id]?.readers
                        ?.map((reader) =>
                          i18n.t("panels:roomReplyStatus", {
                            name: reader.name,
                            status:
                              reader.state === "read"
                                ? i18n.t("panels:read")
                                : reader.state === "unavailable"
                                  ? i18n.t("panels:readStatusUnavailable")
                                  : i18n.t("panels:readNotConfirmed"),
                          }),
                        )
                        .join(" · ")}
                      {deliveries[message.id]?.readers?.length
                        ? ""
                        : i18n.t("panels:readNotConfirmed")}
                    </small>
                  ) : message.kind === "human" &&
                    deliveries[message.id]?.state === "unknown" ? (
                    <small className="room-delivery">
                      {i18n.t("panels:deliveredToRoomAgentReadResponseStatus")}
                    </small>
                  ) : null}
                  {message.kind === "human" || message.originThreadId ? (
                    <details className="room-message-details">
                      <summary>{i18n.t("panels:messageDetails")}</summary>
                      <span>
                        {i18n.t("panels:messageId")} {message.id}
                      </span>
                      {message.originThreadId ? (
                        <span>
                          {i18n.t("panels:sourceConversation")}{" "}
                          {message.originThreadId}
                        </span>
                      ) : null}
                      {message.originTurnId ? (
                        <span>
                          {i18n.t("panels:turn")} {message.originTurnId}
                        </span>
                      ) : null}
                      {deliveries[message.id]?.operationId ? (
                        <span>
                          {i18n.t("panels:operationId")}{" "}
                          {deliveries[message.id]!.operationId}
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
                  label={i18n.t("panels:roomMembers")}
                  hint={i18n.t("panels:chooseARoomMemberToAddress")}
                />
                {replies[room.id] ? (
                  <div className="room-reply-draft">
                    <span>
                      {i18n.t("panels:replyingTo")} {replies[room.id]!.author}:{" "}
                      {replies[room.id]!.text.slice(0, 160)}
                    </span>
                    <button
                      type="button"
                      aria-label={i18n.t("panels:cancelReply")}
                      disabled={Boolean(pending) || sendingRooms[room.id]}
                      onClick={() => {
                        revisions.current[room.id] =
                          (revisions.current[room.id] ?? 0) + 1;
                        setReplies((current) => ({
                          ...current,
                          [room.id]: undefined,
                        }));
                      }}
                    >
                      {i18n.t("panels:cancelReply")}
                    </button>
                  </div>
                ) : null}
                <label htmlFor="room-chat-input" className="sr-only">
                  {i18n.t("panels:message")}
                </label>
                <ComposerEditor
                  textareaRef={composer}
                  id="room-chat-input"
                  aria-label={i18n.t("panels:message")}
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
                        aria-label={i18n.t("panels:mentionARoomMember")}
                        title={i18n.t("panels:mentionARoomMember")}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => roomSelector.openMembers()}
                      >
                        @
                      </button>
                    ) : null}
                    {!room.assistant || !room.assistantRepliesEnabled ? (
                      <small className="room-composer-note">
                        {room.assistant
                          ? i18n.t(
                              "panels:repliesPausedMessagesAreSavedOnlyResuming",
                            )
                          : i18n.t("panels:mentionAgentForReply")}
                      </small>
                    ) : null}
                  </div>
                  <div className="composer-actions">
                    <ComposerAction
                      label={
                        sendingRooms[room.id]
                          ? i18n.t("panels:sending2")
                          : i18n.t("panels:send")
                      }
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
            aria-label={
              panel === "create"
                ? assistantMode
                  ? i18n.t("panels:createPaw")
                  : i18n.t("panels:createRoom")
                : panel === "rename"
                  ? i18n.t("panels:renameConversation")
                  : i18n.t("panels:conversationSettings")
            }
            className="rooms-chat-dialog"
          >
            <header>
              <h2>
                {panel === "create"
                  ? assistantMode
                    ? i18n.t("panels:newPawConversation")
                    : i18n.t("panels:newRoom")
                  : panel === "rename"
                    ? i18n.t("panels:renameConversation")
                    : i18n.t("panels:roomSettingsTitle", {
                        name: room?.name ?? "",
                      })}
              </h2>
              <button ref={dialogClose} type="button" onClick={closeDialog}>
                {panel === "rename"
                  ? i18n.t("panels:cancel")
                  : i18n.t("panels:close")}
              </button>
            </header>
            {panel === "create" && assistantMode ? (
              <>
                <p className="room-assistant-disclosure">
                  {i18n.t("panels:pawWorkingConversationDisclosure")}
                </p>
                <PluginRequirementsPreview
                  requirements={PAW_PLUGIN_REQUIREMENTS}
                  purposeLabels={{
                    "zenx-rooms": i18n.t("panels:pawChatAndMemory"),
                    "zenx-triggers": i18n.t("panels:pawReplyToMessages"),
                    "zenx-self-control": i18n.t(
                      "panels:pawWorkWithConversations",
                    ),
                    "zenx-subagents": i18n.t("panels:pawDelegateWork"),
                  }}
                  onReady={setAssistantPluginsReady}
                  openSettings={() => {
                    closeDialog();
                    sdk.navigation.navigate("settings");
                  }}
                />
              </>
            ) : null}
            <Field
              label={
                room?.assistant || assistantMode
                  ? i18n.t("panels:name")
                  : i18n.t("panels:roomName")
              }
              value={name}
              onChange={setName}
              disabled={
                panel === "create" &&
                assistantMode &&
                (busy ||
                  (assistantCreation.current !== null &&
                    assistantCreationFailed))
              }
            />
            {panel === "create" && assistantMode && assistantNameTooLong ? (
              <p role="alert">{i18n.t("panels:pawNameTooLong")}</p>
            ) : null}
            {panel !== "create" ? (
              <button
                type="button"
                disabled={busy || !name.trim() || name === room?.name}
                onClick={() => {
                  const epoch = dialogEpoch.current;
                  void run("rename", { roomId: room?.id, name }).then((ok) => {
                    if (ok && epoch === dialogEpoch.current) closeDialog();
                  });
                }}
              >
                {panel === "rename"
                  ? i18n.t("panels:saveName")
                  : i18n.t("panels:rename")}
              </button>
            ) : null}
            {panel === "create" || (panel === "manage" && !room?.assistant) ? (
              <>
                {!assistantMode ? (
                  <Field
                    label={i18n.t("panels:memberName")}
                    value={memberName}
                    onChange={setMemberName}
                  />
                ) : null}
                {assistantMode ? (
                  <>
                    <label className="field">
                      <span>{i18n.t("panels:pawWorkingConversation")}</span>
                      <Select
                        aria-label={i18n.t("panels:pawWorkingConversation")}
                        value={assistantTarget}
                        onValueChange={(value) => {
                          setAssistantTarget(value as "new" | "existing");
                          if (value === "existing") {
                            assistantCreation.current = null;
                          }
                        }}
                        disabled={busy}
                      >
                        <option value="new">
                          {i18n.t("panels:pawNewWorkingConversation")}
                        </option>
                        <option value="existing">
                          {i18n.t("panels:pawExistingWorkingConversation")}
                        </option>
                      </Select>
                    </label>
                    {assistantTarget === "new" ? (
                      <>
                        <label className="field">
                          <span>{i18n.t("panels:pawProject")}</span>
                          <Select
                            aria-label={i18n.t("panels:pawProject")}
                            value={assistantWorkspace}
                            onValueChange={setAssistantWorkspace}
                            disabled={
                              busy ||
                              assistantCreationFailed ||
                              !assistantWorkspacesLoaded
                            }
                          >
                            <option value="">
                              {i18n.t("panels:selectAConfiguredWorkspace")}
                            </option>
                            {assistantWorkspaces.map((workspace) => (
                              <option
                                key={workspace}
                                value={workspace}
                                title={workspace}
                              >
                                {assistantProjectNames[workspace] ?? workspace}
                              </option>
                            ))}
                          </Select>
                        </label>
                        {assistantTargetPreview?.workspace ===
                        assistantWorkspace ? (
                          <p
                            className="room-assistant-disclosure"
                            role="status"
                          >
                            {i18n.t("panels:modelProfileEffort", {
                              model: assistantTargetPreview.modelId,
                              profile: assistantTargetPreview.providerProfileId,
                              effort:
                                assistantTargetPreview.reasoningEffort ??
                                i18n.t("panels:defaultEffort"),
                            })}
                            <br />
                            {i18n.t("panels:pawNewThreadPermissions", {
                              access:
                                assistantTargetPreview.sandbox ===
                                "danger-full-access"
                                  ? i18n.t("shell:fullAccess")
                                  : assistantTargetPreview.sandbox ===
                                      "read-only"
                                    ? i18n.t("shell:readOnly")
                                    : i18n.t("shell:workspaceWrite"),
                              approval:
                                assistantTargetPreview.approvalPolicy ===
                                "never"
                                  ? i18n.t(
                                      "panels:neverActionsMayProceedWithoutAskingYou",
                                    )
                                  : i18n.t("panels:onRequest"),
                            })}
                          </p>
                        ) : assistantWorkspace &&
                          assistantSetupError === null ? (
                          <p role="status">
                            {i18n.t("panels:pawReviewingSettings")}
                          </p>
                        ) : null}
                        {assistantWorkspacesLoaded &&
                        assistantWorkspaces.length === 0 &&
                        assistantSetupError === null ? (
                          <p className="room-assistant-disclosure">
                            {i18n.t("panels:pawAddProjectFirst")}
                          </p>
                        ) : null}
                      </>
                    ) : null}
                    {assistantSetupError !== null &&
                    assistantTarget === "new" ? (
                      <p role="alert">{assistantSetupError}</p>
                    ) : null}
                  </>
                ) : null}
                {!assistantMode || assistantTarget === "existing" ? (
                  <label className="field">
                    <span>
                      {assistantMode
                        ? i18n.t("panels:pawExistingConversation")
                        : i18n.t("panels:memberConversation")}
                    </span>
                    <Combobox
                      label={
                        assistantMode
                          ? i18n.t("panels:pawExistingConversation")
                          : i18n.t("panels:memberConversation")
                      }
                      value={threadId}
                      onValueChange={setThreadId}
                      disabled={
                        panel === "create" &&
                        assistantMode &&
                        (busy ||
                          (assistantCreation.current !== null &&
                            assistantCreationFailed))
                      }
                    >
                      {threads.map((thread) => (
                        <option
                          key={thread.threadId}
                          value={thread.threadId}
                          title={`${threadTitle(thread)} · ${thread.threadId} · ${"currentMetadata" in thread ? thread.currentMetadata.cwd : i18n.t("panels:unavailableWorkspace")}`}
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
                ) : null}
              </>
            ) : null}
            {panel === "create" ? (
              <button
                type="button"
                className="primary-button"
                disabled={
                  busy ||
                  !name.trim() ||
                  (assistantMode && assistantNameTooLong) ||
                  (!assistantMode && !memberName.trim()) ||
                  (assistantMode
                    ? assistantTarget === "new"
                      ? !assistantTargetPreview ||
                        assistantTargetPreview.workspace !== assistantWorkspace
                      : !threadId
                    : !threadId) ||
                  (assistantMode &&
                    assistantTarget === "new" &&
                    assistantCreationFailed) ||
                  (assistantMode && !assistantPluginsReady)
                }
                onClick={() => {
                  const creationDialogToken = dialogEpoch.current;
                  const creationViewToken = viewEpoch.current;
                  let input: unknown = {
                    name,
                    members: [
                      { name: assistantMode ? name : memberName, threadId },
                    ],
                  };
                  if (assistantMode) {
                    assistantCreation.current ??= {
                      operationId: crypto.randomUUID(),
                      input: {
                        name,
                        memberName: name,
                        target:
                          assistantTarget === "new"
                            ? {
                                kind: "new",
                                workspace: assistantWorkspace,
                                expected: assistantTargetPreview,
                              }
                            : { kind: "existing", threadId },
                      },
                    };
                    input = {
                      ...(assistantCreation.current.input as Record<
                        string,
                        unknown
                      >),
                      operationId: assistantCreation.current.operationId,
                    };
                  }
                  void run(
                    assistantMode ? "create-assistant" : "create",
                    input,
                  ).then((ok) => {
                    if (
                      ok &&
                      creationDialogToken === dialogEpoch.current &&
                      creationViewToken === viewEpoch.current
                    )
                      setPanel(null);
                  });
                }}
              >
                {assistantMode
                  ? i18n.t("panels:createPaw")
                  : i18n.t("panels:createRoom")}
              </button>
            ) : panel === "manage" ? (
              <>
                {room?.assistant ? (
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
                      ? i18n.t("panels:pausePaw")
                      : i18n.t("panels:resumePaw")}
                  </button>
                ) : null}
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
                  {i18n.t("panels:addMember")}
                </button>
                <h3>{i18n.t("panels:members")}</h3>
                {room?.members.map((member) => (
                  <div className="rooms-chat-member" key={member.threadId}>
                    <strong>@{member.name}</strong>
                    <details>
                      <summary>{i18n.t("panels:details")}</summary>
                      <code>{member.threadId}</code>
                    </details>
                    <button
                      type="button"
                      disabled={busy || Boolean(room.assistant)}
                      onClick={() => {
                        if (
                          window.confirm(
                            i18n.t("panels:removeMemberConfirm", {
                              name: member.name,
                              room: room.name,
                            }),
                          )
                        )
                          void run("remove-member", {
                            roomId: room.id,
                            threadId: member.threadId,
                          });
                      }}
                    >
                      {i18n.t("panels:remove")}
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
                  {i18n.t("panels:deleteRoom")}
                </button>
              </>
            ) : null}
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
  disabled = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}) {
  useTranslation("panels");
  return (
    <label className="field">
      <span>{label}</span>
      <input
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function roomRoleLabel(kind: ZenXRoom["messages"][number]["kind"]): string {
  if (kind === "human") return i18n.t("panels:you");
  if (kind === "agent") return i18n.t("panels:agent");
  return i18n.t("panels:system");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
