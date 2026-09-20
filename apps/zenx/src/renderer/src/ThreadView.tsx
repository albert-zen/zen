import type { SkillEntry } from "../../../../cli/src/skills.js";
import { parseSkillDraft, withSkillDraft } from "./skill-draft.js";
import { toolPresentation } from "./tool-presentation.js";
import { isCompactCommand } from "./compact-command.js";
import { createPortal } from "react-dom";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { AttachmentRef } from "../../../../../src/attachment.js";
import type {
  ModelContextUsageProjection,
  ModelUsageAggregate,
  ModelUsageProjection,
} from "../../../../../src/model-usage.js";

import type { ApprovalDecision } from "../../main/app-server-manager.js";
import type { TriggerHistoryEntry } from "../../main/trigger-types.js";
import type { ZenXProviderProfile } from "../../main/host-profile.js";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import type {
  ModelSummary,
  Thread,
  ThreadItem,
  Turn,
} from "../../protocol-client/index.js";
import type { ApprovalCardState } from "./approval-state.js";
import {
  composerDraftHasContent,
  defaultComposerIntent,
  type ComposerSendMode,
  type ComposerDraftImage,
  type ComposerIntent,
  type ComposerState,
} from "./composer-state.js";
import type { ZenXThreadAttachmentProjection } from "../../main/image-attachments.js";
import { ComposerModelMenu } from "./ComposerModelMenu.js";
import { Icon } from "./icons.js";
import { PermissionSelect } from "./PermissionSelect.js";
import type { FilePermissionMode } from "../../protocol-client/types.js";
import type { ModelMessage } from "../../../../../src/model.js";
import { Markdown } from "./Markdown.js";
import {
  AttachmentImage,
  ImagePreview,
  ThreadImagesContext,
  ToolImages,
} from "./ImagePresentation.js";
import { activeTurn } from "./thread-view-state.js";
import type { PluginUiRegistry } from "./plugin-ui-host.js";
import { ToolResultRenderer } from "./ToolResultRenderer.js";
import {
  commandLabel,
  projectTurn,
  traceDisplayRows,
  type TurnDisplayNode,
} from "./turn-projection.js";
import { WorkflowCommandMenu } from "./WorkflowCommandMenu.js";
import {
  commandCandidates,
  expandWorkflowCommand,
  type WorkflowCommand,
} from "./workflow-commands.js";
import {
  compactionInitiatorLabel,
  projectContextCompactions,
  type ContextCompactionProjection,
} from "./context-compaction-projection.js";

interface ThreadViewProps {
  composerSendMode?: ComposerSendMode;
  onResumeQueue?(): Promise<void>;
  approvals: readonly ApprovalCardState[];
  composer: ComposerState;
  composerContext?: ReactNode;
  composerDisabled?: boolean;
  emptyContent?: ReactNode;
  modelDisabled?: boolean;
  modelError?: string | null;
  imageCapabilityError?: string | null;
  imageCapabilityNotice?: string | null;
  models?: readonly ModelSummary[];
  permissionLabel?: string | null;
  permissionMode?: FilePermissionMode;
  permissionError?: string | null;
  switchingPermission?: boolean;
  onPermissionChange?(mode: FilePermissionMode): void;
  providerProfiles?: readonly ZenXProviderProfile[];
  selectedModel?: string;
  selectedReasoningEffort?: string | null;
  switchingModel?: boolean;
  thread: Thread | null;
  threadAttachments?: ZenXThreadAttachmentProjection;
  threadUsage?: ModelUsageProjection;
  wakeups?: readonly TriggerHistoryEntry[];
  watching?: boolean;
  workflowCommands?: readonly WorkflowCommand[];
  pluginSnapshot?: ZenXPluginSnapshot | null;
  pluginUiRegistry?: PluginUiRegistry | null;
  onDraftChange(draft: string): void;
  onImportImages?(files: readonly File[]): Promise<void>;
  onPickImages?(): Promise<void>;
  onRemoveImage?(imageId: string): void;
  onReadAttachment?(attachment: AttachmentRef): Promise<Uint8Array>;
  onInterrupt(turnId: string): Promise<void>;
  onCompact?(): Promise<void>;
  onModelChange?(model: string): void;
  onReasoningChange?(effort: string): void;
  onRespondToApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  onSubmit(
    intent: ComposerIntent,
    expectedTurnId: string | null,
  ): Promise<void>;
}

export function ThreadView({
  composerSendMode = "queue",
  onResumeQueue,
  approvals,
  composer,
  composerContext = null,
  composerDisabled = false,
  emptyContent = null,
  modelDisabled = false,
  modelError = null,
  imageCapabilityError = null,
  imageCapabilityNotice = null,
  models = [],
  permissionLabel = "Full access",
  permissionMode = "danger-full-access",
  permissionError,
  switchingPermission,
  onPermissionChange,
  providerProfiles = [],
  selectedModel,
  selectedReasoningEffort = null,
  switchingModel = false,
  thread,
  threadAttachments = {},
  threadUsage,
  wakeups = [],
  watching = false,
  workflowCommands = [],
  pluginSnapshot = null,
  pluginUiRegistry = null,
  onDraftChange,
  onImportImages = async () => undefined,
  onPickImages = async () => undefined,
  onRemoveImage = () => undefined,
  onReadAttachment = async () => {
    throw new Error("Image payload reader is unavailable");
  },
  onInterrupt,
  onCompact,
  onModelChange,
  onReasoningChange,
  onRespondToApproval,
  onSubmit,
}: ThreadViewProps) {
  const [interrupting, setInterrupting] = useState(false);
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draggingImages, setDraggingImages] = useState(false);
  const [preview, setPreview] = useState<{
    attachment: AttachmentRef;
    name: string;
    trigger: HTMLButtonElement;
  } | null>(null);
  const [atLive, setAtLive] = useState(true);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [skillError, setSkillError] = useState<string | null>(null);
  const skillDraft = parseSkillDraft(composer.draft.text);
  useEffect(() => {
    if (window.zenx?.skills === undefined) return;
    let active = true;
    void window.zenx.skills
      .list()
      .then((value) => {
        if (active) {
          setSkills(value.skills);
          setSkillError(value.errors.join("\n") || null);
        }
      })
      .catch((error: unknown) => active && setSkillError(String(error)));
    return () => {
      active = false;
    };
  }, [thread?.id, composer.draft.text.startsWith("/")]);
  const [workflowIndex, setWorkflowIndex] = useState(0);
  const [dismissedWorkflowInput, setDismissedWorkflowInput] = useState<
    string | null
  >(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true);
  const viewRef = useRef<HTMLDivElement>(null);
  const bottomZoneRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const runningTurn = thread === null ? null : activeTurn(thread);
  const turns = thread?.turns ?? [];
  const contextCompactions = useMemo(
    () => projectContextCompactions(thread?.canonicalItems),
    [thread?.canonicalItems],
  );
  const transcriptRows = useMemo(
    () =>
      buildTranscriptRows(turns, thread?.canonicalItems, contextCompactions),
    [contextCompactions, thread?.canonicalItems, turns],
  );
  const pendingApprovals = approvals.filter(
    (approval) => approval.status === "pending",
  );
  const compactRequested = isCompactCommand(composer.draft.text);
  const submitting =
    composer.submission?.status === "pending" ||
    composer.compaction?.status === "pending";
  const hasDraft = composerDraftHasContent(composer.draft);
  const blockedByImageCapability =
    !compactRequested &&
    composer.draft.images.length > 0 &&
    imageCapabilityError !== null;
  const workflowCandidates = useMemo(
    () =>
      dismissedWorkflowInput === composer.draft.text
        ? []
        : commandCandidates(skillDraft.text, workflowCommands, skills),
    [composer.draft.text, dismissedWorkflowInput, workflowCommands, skills],
  );

  useEffect(() => setWorkflowIndex(0), [composer.draft.text]);

  const chooseWorkflow = (index: number) => {
    const command = workflowCandidates[index];
    if (command === undefined) return;
    const selected =
      command.kind === "skill" &&
      !skillDraft.skills.some((skill) => skill.id === command.id)
        ? [...skillDraft.skills, { id: command.id, name: command.name }]
        : skillDraft.skills;
    onDraftChange(
      withSkillDraft(expandWorkflowCommand(skillDraft.text, command), selected),
    );
    setDismissedWorkflowInput(null);
    requestAnimationFrame(() => composerTextareaRef.current?.focus());
  };

  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll !== null && shouldFollowRef.current) {
      scroll.scrollTop = scroll.scrollHeight;
      setAtLive(true);
    }
  }, [approvals, composer.compaction, thread?.canonicalItems, thread?.turns]);

  // The Composer overlays the bottom of the full-height transcript scroll
  // area. Publish its live height so the list reserves matching virtual
  // space and Back to live can float just above it; growth keeps a live
  // view pinned to the bottom.
  useLayoutEffect(() => {
    const view = viewRef.current;
    const zone = bottomZoneRef.current;
    if (view === null || zone === null) return;
    const publish = () => {
      const height = `${Math.round(zone.getBoundingClientRect().height)}px`;
      if (view.style.getPropertyValue("--bottom-zone-height") === height)
        return;
      view.style.setProperty("--bottom-zone-height", height);
      const scroll = scrollRef.current;
      if (shouldFollowRef.current && scroll !== null)
        scroll.scrollTop = scroll.scrollHeight;
    };
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(publish);
    observer.observe(zone);
    return () => {
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const textarea = composerTextareaRef.current;
    if (textarea === null) return;

    // Reset before measuring so deleting text shrinks the editor as well as
    // adding text grows it. Keep the budget bounded so the transcript remains
    // usable in short windows; the textarea itself scrolls beyond the cap.
    const resize = () => {
      textarea.style.height = "auto";
      const contentHeight = textarea.scrollHeight;
      const declaredMaxHeight = Number.parseFloat(
        window.getComputedStyle(textarea).maxHeight,
      );
      const maxHeight = Number.isFinite(declaredMaxHeight)
        ? declaredMaxHeight
        : 150;
      const height = Math.min(Math.max(contentHeight, 68), maxHeight);
      textarea.style.height = `${height}px`;
      textarea.style.overflowY = contentHeight > height ? "auto" : "hidden";
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [composer.draft.text]);

  const submit = (intent: ComposerIntent) => {
    if (composerDisabled || !hasDraft || submitting || blockedByImageCapability)
      return;
    if (intent === "start" && runningTurn !== null) return;
    if (intent !== "start" && runningTurn === null) return;
    void onSubmit(intent, runningTurn?.id ?? null);
  };

  const interrupt = async () => {
    if (composerDisabled || runningTurn === null || interrupting || submitting)
      return;
    setInterrupting(true);
    setInterruptError(null);
    try {
      await onInterrupt(runningTurn.id);
    } catch (error) {
      setInterruptError(describeError(error));
    } finally {
      setInterrupting(false);
    }
  };

  const sendIntent = defaultComposerIntent(
    runningTurn !== null,
    composerSendMode,
  );
  const alternateIntent = defaultComposerIntent(
    runningTurn !== null,
    composerSendMode,
    true,
  );
  const primaryMode =
    runningTurn === null ? "send" : !hasDraft ? "stop" : sendIntent;
  const intentLabel = (intent: ComposerIntent) =>
    intent === "queue"
      ? "Queue message"
      : intent === "steer"
        ? "Soft steer"
        : intent === "replace"
          ? "Interrupt and send"
          : "Send";
  const primaryLabel = compactRequested
    ? "Compact context"
    : primaryMode === "stop"
      ? "Stop"
      : intentLabel(sendIntent);
  const primary = () => {
    if (primaryMode === "stop") void interrupt();
    else submit(sendIntent);
  };

  return (
    <div
      className={`thread-view${draggingImages ? " image-dragging" : ""}`}
      ref={viewRef}
      onDragEnter={(event) => {
        if (composerDisabled || submitting) return;
        if (hasImageFiles(event.dataTransfer.files)) setDraggingImages(true);
      }}
      onDragOver={(event) => {
        if (composerDisabled || submitting) return;
        if (!hasImageFiles(event.dataTransfer.files)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDraggingImages(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDraggingImages(false);
      }}
      onDrop={(event) => {
        if (composerDisabled || submitting) return;
        const files = imageFiles(event.dataTransfer.files);
        setDraggingImages(false);
        if (files.length === 0) return;
        event.preventDefault();
        setAttachmentError(null);
        void onImportImages(files).catch((error: unknown) =>
          setAttachmentError(describeError(error)),
        );
      }}
    >
      <div
        className="messages"
        ref={scrollRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          const live =
            target.scrollHeight - target.scrollTop - target.clientHeight < 80;
          shouldFollowRef.current = live;
          setAtLive(live);
        }}
      >
        <ThreadImagesContext.Provider
          value={{
            cwd: thread?.cwd,
            attachments: threadAttachments,
            read: onReadAttachment,
            open: (attachment, name, trigger) =>
              setPreview({ attachment, name, trigger }),
          }}
        >
          <div className="messages-inner">
            {transcriptRows.length === 0
              ? (emptyContent ?? (
                  <div className="thread-empty">
                    <h2>Start a new thread</h2>
                    <p>
                      Describe the outcome you want. ZenX will use this Thread’s
                      workspace, model, and permission policy.
                    </p>
                  </div>
                ))
              : transcriptRows.map((row) =>
                  row.type === "turn" ? (
                    <TurnBlock
                      index={row.index}
                      key={row.turn.id}
                      turn={row.turn}
                      usage={threadUsage?.turns[row.turn.id]}
                      wakeups={wakeups}
                      attachments={threadAttachments}
                      onOpenImage={(attachment, name, trigger) =>
                        setPreview({ attachment, name, trigger })
                      }
                      onReadAttachment={onReadAttachment}
                      pluginSnapshot={pluginSnapshot}
                      pluginUiRegistry={pluginUiRegistry}
                    />
                  ) : (
                    <ContextCompactionEvent
                      key={row.compaction.item.id}
                      projection={row.compaction}
                    />
                  ),
                )}
            {composer.compaction?.status === "pending" ||
            composer.compaction?.status === "failed" ? (
              <ContextCompactionProgress state={composer.compaction} />
            ) : null}
          </div>
        </ThreadImagesContext.Provider>
      </div>

      {atLive ? null : (
        <button
          className="back-live"
          type="button"
          onClick={() => {
            const scroll = scrollRef.current;
            if (scroll === null) return;
            shouldFollowRef.current = true;
            scroll.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" });
            setAtLive(true);
          }}
        >
          <Icon name="arrow-down" size={14} />
          Back to live
        </button>
      )}

      <div className="bottom-zone" ref={bottomZoneRef}>
        {composerContext}
        {pendingApprovals.map((approval) => (
          <ApprovalBar
            approval={approval}
            key={approval.requestId}
            onRespond={onRespondToApproval}
          />
        ))}
        {(thread?.queuedMessages?.length ?? 0) > 0 ? (
          <div
            className="queued-messages"
            aria-label="Message queue"
            aria-live="polite"
          >
            <strong>{thread!.queuedMessages!.length} queued</strong>
            <ol>
              {thread!.queuedMessages!.map((message) => (
                <li key={message.id}>
                  {message.text || `${message.imageCount} image(s)`}
                </li>
              ))}
            </ol>
            {runningTurn === null && onResumeQueue !== undefined ? (
              <button
                type="button"
                onClick={() =>
                  void onResumeQueue().catch((error: unknown) =>
                    setInterruptError(describeError(error)),
                  )
                }
              >
                Continue queue
              </button>
            ) : null}
          </div>
        ) : null}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            primary();
          }}
        >
          {skillError !== null && (
            <p role="alert" className="settings-error">
              {skillError}
            </p>
          )}
          {skillDraft.skills.length > 0 && (
            <div className="composer-images" aria-label="Skills to send">
              {skillDraft.skills.map((skill) => (
                <button
                  type="button"
                  className="quiet-button"
                  key={skill.id}
                  aria-label={`Remove Skill ${skill.name}`}
                  onClick={() =>
                    onDraftChange(
                      withSkillDraft(
                        skillDraft.text,
                        skillDraft.skills.filter(
                          (entry) => entry.id !== skill.id,
                        ),
                      ),
                    )
                  }
                >
                  {skill.name} ×
                </button>
              ))}
            </div>
          )}
          <WorkflowCommandMenu
            activeIndex={workflowIndex}
            candidates={workflowCandidates}
            onChoose={(command) =>
              chooseWorkflow(workflowCandidates.indexOf(command))
            }
          />
          <label className="sr-only" htmlFor="thread-composer">
            Message ZenX
          </label>
          {composer.draft.images.length === 0 ? null : (
            <div className="composer-images" aria-label="Images to send">
              {composer.draft.images.map((image) => (
                <DraftImage
                  image={image}
                  key={image.id}
                  onOpen={(trigger) =>
                    setPreview({
                      attachment: image.attachment,
                      name: image.name,
                      trigger,
                    })
                  }
                  onReadAttachment={onReadAttachment}
                  onRemove={() => onRemoveImage(image.id)}
                />
              ))}
            </div>
          )}
          <textarea
            id="thread-composer"
            aria-label="Message"
            data-autogrow="true"
            disabled={composerDisabled}
            onChange={(event) => {
              setDismissedWorkflowInput(null);
              onDraftChange(
                withSkillDraft(event.target.value, skillDraft.skills),
              );
            }}
            onPaste={(event) => {
              if (composerDisabled || submitting) return;
              const files = imageFiles(event.clipboardData.files);
              if (files.length === 0) return;
              event.preventDefault();
              setAttachmentError(null);
              void onImportImages(files).catch((error: unknown) =>
                setAttachmentError(describeError(error)),
              );
            }}
            onKeyDown={(event) => {
              if (
                !event.nativeEvent.isComposing &&
                workflowCandidates.length > 0
              ) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setWorkflowIndex((current) =>
                    event.key === "ArrowDown"
                      ? (current + 1) % workflowCandidates.length
                      : (current - 1 + workflowCandidates.length) %
                        workflowCandidates.length,
                  );
                  return;
                }
                if (event.key === "Tab" || event.key === "Enter") {
                  event.preventDefault();
                  if (!event.repeat) chooseWorkflow(workflowIndex);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDismissedWorkflowInput(composer.draft.text);
                  return;
                }
              }
              if (event.key !== "Enter" || event.shiftKey) return;
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (event.repeat) return;
              submit(
                defaultComposerIntent(
                  runningTurn !== null,
                  composerSendMode,
                  event.metaKey || event.ctrlKey,
                ),
              );
            }}
            placeholder={
              runningTurn === null
                ? watching
                  ? "Send a message to wake this thread…"
                  : "Ask ZenX anything…"
                : composerSendMode === "queue"
                  ? "Queue a message…"
                  : "Steer the current run…"
            }
            ref={composerTextareaRef}
            rows={1}
            value={skillDraft.text}
          />
          <div className="composer-rail">
            <div className="composer-tools">
              <button
                className="composer-tool icon-only"
                type="button"
                aria-label="Add images"
                title="Add images"
                disabled={composerDisabled || submitting}
                onClick={() => {
                  setAttachmentError(null);
                  void onPickImages().catch((error: unknown) =>
                    setAttachmentError(describeError(error)),
                  );
                }}
              >
                <Icon name="paperclip" />
              </button>
              {selectedModel === undefined ? null : (
                <ComposerModelMenu
                  disabled={composerDisabled || modelDisabled}
                  modelError={modelError}
                  models={models}
                  onModelChange={(model) => onModelChange?.(model)}
                  onReasoningChange={(effort) => onReasoningChange?.(effort)}
                  providerProfiles={providerProfiles}
                  selectedModel={selectedModel}
                  selectedReasoningEffort={selectedReasoningEffort}
                  switching={switchingModel}
                />
              )}
              <ContextUsageIndicator
                context={threadUsage?.context}
                threadCacheHitRate={threadUsage?.thread.cacheHitRate}
                compactDisabled={
                  composerDisabled || runningTurn !== null || submitting
                }
                onCompact={onCompact}
              />
              {permissionLabel === null ? null : (
                <PermissionSelect
                  legacyApproval={permissionLabel === "Approval required"}
                  value={permissionMode}
                  disabled={
                    runningTurn !== null ||
                    composerDisabled ||
                    composer.submission?.status === "pending"
                  }
                  switching={switchingPermission ?? false}
                  error={permissionError ?? null}
                  onChange={onPermissionChange}
                />
              )}
            </div>
            <div className="composer-actions">
              {runningTurn !== null && hasDraft ? (
                <button
                  className="steer-button"
                  type="button"
                  disabled={
                    composerDisabled || submitting || blockedByImageCapability
                  }
                  onClick={() => submit(alternateIntent)}
                >
                  {intentLabel(alternateIntent)}
                </button>
              ) : null}
              <button
                className={`action-orb ${primaryMode}`}
                type="button"
                aria-label={primaryLabel}
                title={primaryLabel}
                disabled={
                  composerDisabled ||
                  interrupting ||
                  submitting ||
                  (primaryMode === "send" && !hasDraft) ||
                  blockedByImageCapability
                }
                onClick={primary}
              >
                <Icon
                  name={primaryMode === "stop" ? "stop" : "send"}
                  size={18}
                />
              </button>
            </div>
          </div>
          {composer.submission?.status === "failed" ||
          interruptError !== null ||
          attachmentError !== null ||
          blockedByImageCapability ||
          modelError !== null ? (
            <p
              className="composer-error"
              id={modelError === null ? undefined : "composer-model-error"}
              role="alert"
            >
              {interruptError ??
                attachmentError ??
                (blockedByImageCapability ? imageCapabilityError : null) ??
                composer.submission?.error ??
                modelError}
            </p>
          ) : null}
          {composer.draft.images.length > 0 &&
          imageCapabilityNotice !== null &&
          !blockedByImageCapability ? (
            <p className="composer-note" role="status">
              {imageCapabilityNotice}
            </p>
          ) : null}
        </form>
      </div>
      {preview === null ? null : (
        <ImagePreview
          attachment={preview.attachment}
          name={preview.name}
          onClose={() => setPreview(null)}
          onReadAttachment={onReadAttachment}
          trigger={preview.trigger}
        />
      )}
    </div>
  );
}

type TranscriptRow =
  | { type: "turn"; turn: Turn; index: number; order: number }
  | {
      type: "compaction";
      compaction: ContextCompactionProjection;
      order: number;
    };

function buildTranscriptRows(
  turns: readonly Turn[],
  canonicalItems: Thread["canonicalItems"],
  compactions: readonly ContextCompactionProjection[],
): TranscriptRow[] {
  const fallbackStart = (canonicalItems?.length ?? 0) + 1;
  const turnEnds = new Map<string, number>();
  canonicalItems?.forEach((item, index) => {
    if ("turnId" in item && typeof item.turnId === "string") {
      turnEnds.set(item.turnId, index);
    }
  });
  const rows: TranscriptRow[] = turns.map((turn, index) => ({
    type: "turn",
    turn,
    index,
    order: turnEnds.get(turn.id) ?? fallbackStart + index,
  }));
  for (const compaction of compactions) {
    const turnEnd =
      compaction.item.provenance === "agentic"
        ? turnEnds.get(compaction.item.turnId)
        : undefined;
    rows.push({
      type: "compaction",
      compaction,
      order:
        turnEnd === undefined
          ? compaction.canonicalIndex
          : Math.max(compaction.canonicalIndex, turnEnd) + 0.25,
    });
  }
  return rows.sort((left, right) => left.order - right.order);
}

function ContextCompactionProgress({
  state,
}: {
  state: NonNullable<ComposerState["compaction"]>;
}) {
  const failed = state.status === "failed";
  return (
    <div
      className={`context-compaction-progress${failed ? " is-error" : ""}`}
      role={failed ? "alert" : "status"}
    >
      {failed ? (
        <Icon name="warning" size={15} />
      ) : (
        <span className="mini-spinner" aria-hidden="true" />
      )}
      <span>{state.message}</span>
    </div>
  );
}

export function ContextCompactionEvent({
  projection,
}: {
  projection: ContextCompactionProjection;
}) {
  const [expanded, setExpanded] = useState(false);
  const { item, effectiveMessages } = projection;
  const [copyState, setCopyState] = useState("");
  return (
    <section
      className="context-compaction-event"
      aria-label="Context compacted"
    >
      <button
        className="context-compaction-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="context-compaction-mark" aria-hidden="true">
          <Icon name="compress" size={14} />
        </span>
        <span>
          <strong>Context compacted</strong>
          <small>
            {compactionInitiatorLabel(item)} ·{" "}
            {Array.from(item.summary).length.toLocaleString()} summary
            characters · Full input size unknown
          </small>
        </span>
        <Icon name="chevron-down" size={13} />
      </button>
      {expanded ? (
        <div className="context-compaction-detail">
          <div className="compaction-summary-heading">
            <h3>Saved summary</h3>
            <button
              type="button"
              className="quiet-button"
              onClick={() => {
                void navigator.clipboard.writeText(item.summary).then(
                  () => setCopyState("Summary copied"),
                  () =>
                    setCopyState(
                      "Could not copy. Select the summary text to copy it.",
                    ),
                );
              }}
            >
              Copy summary
            </button>
          </div>
          <span role="status">{copyState}</span>
          <div className="compaction-summary">
            <Markdown text={item.summary} />
          </div>
          <p>
            {item.retainedItemIds.length} original items retained alongside the
            summary. This snapshot is from the time of compaction; later
            conversation adds to it.
          </p>
          <details className="compaction-projection">
            <summary>Retained context and diagnostics</summary>
            <p>
              {effectiveMessages.length} projected history messages, not tokens.
              This includes the summary and retained conversation. Rules, tool
              definitions and other request inputs may be added separately. Full
              model input size was not recorded. The summary generation usage is
              not the post-compaction context size.
            </p>
            <ol>
              {effectiveMessages.map((message, index) => (
                <li key={`${item.id}:${String(index)}`}>
                  <span>{modelMessageRole(message)}</span>
                  <pre>{formatModelMessage(message)}</pre>
                </li>
              ))}
            </ol>
          </details>
        </div>
      ) : null}
    </section>
  );
}

function modelMessageRole(message: ModelMessage): string {
  if (message.role === "tool") return "Tool";
  if (message.role === "reasoning") return "Reasoning";
  return message.role === "assistant" ? "Assistant" : "User";
}

function formatModelMessage(message: ModelMessage): string {
  if (message.role === "reasoning") {
    return [message.summary, message.reasoningContent]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join("\n");
  }
  if (message.role === "tool") {
    return message.modelContent === undefined
      ? message.text
      : `${message.text}\n${JSON.stringify(message.modelContent, null, 2)}`;
  }
  if ("content" in message) return JSON.stringify(message.content, null, 2);
  if ("toolCalls" in message) {
    return `${message.text ?? ""}\n${JSON.stringify(message.toolCalls, null, 2)}`.trim();
  }
  return message.text;
}

function RunningTurnLabel({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const duration = startedAt === null ? null : now - startedAt * 1_000;
  return (
    <div className="turn-running-label" role="status" aria-label="Working">
      <span className="mini-spinner" aria-hidden="true" />
      <span aria-hidden="true">
        {duration === null
          ? "Working"
          : `Working for ${formatDuration(duration)}`}
      </span>
    </div>
  );
}

function TurnBlock({
  turn,
  index,
  wakeups,
  attachments,
  onOpenImage,
  onReadAttachment,
  pluginSnapshot,
  pluginUiRegistry,
  usage,
}: {
  turn: Turn;
  index: number;
  wakeups: readonly TriggerHistoryEntry[];
  attachments: ZenXThreadAttachmentProjection;
  onOpenImage(
    attachment: AttachmentRef,
    name: string,
    trigger: HTMLButtonElement,
  ): void;
  onReadAttachment(attachment: AttachmentRef): Promise<Uint8Array>;
  pluginSnapshot: ZenXPluginSnapshot | null;
  pluginUiRegistry: PluginUiRegistry | null;
  usage?: ModelUsageAggregate;
}) {
  const projection = useMemo(() => projectTurn(turn), [turn]);
  const [expandedOverride, setExpanded] = useState<boolean | null>(null);
  const expanded =
    expandedOverride ??
    (turn.status === "failed" || turn.status === "interrupted");
  const complete = turn.status !== "inProgress";
  const renderUserItem = (
    item: Extract<ThreadItem, { type: "userMessage" }>,
  ) => {
    const wakeup = wakeups.find(
      (entry) => entry.clientUserMessageId === item.clientId,
    );
    return wakeup === undefined ? (
      <UserMessage
        attachments={attachments[item.id] ?? []}
        item={item}
        key={item.id}
        onOpenImage={onOpenImage}
        onReadAttachment={onReadAttachment}
        turn={turn}
      />
    ) : (
      <WakeupCard entry={wakeup} key={item.id} />
    );
  };
  return (
    <section className={`turn ${turn.status}`} aria-label={`Turn ${index + 1}`}>
      {projection.userItems.map(renderUserItem)}
      {complete ? (
        <button
          className="turn-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <span>{completedTurnLabel(turn)}</span>
          <Icon name="chevron-down" size={14} />
        </button>
      ) : (
        <RunningTurnLabel startedAt={turn.startedAt} />
      )}
      {!complete || expanded ? (
        <div className="turn-history">
          {projection.history.map((node) =>
            node.kind === "user" ? (
              renderUserItem(node.item)
            ) : (
              <DisplayNode
                key={node.kind === "agent" ? node.item.id : node.id}
                node={node}
                turn={turn}
                usage={usage}
                pluginSnapshot={pluginSnapshot}
                pluginUiRegistry={pluginUiRegistry}
              />
            ),
          )}
          {!complete && projection.finalItem !== null ? (
            <AgentMessage
              item={projection.finalItem}
              showActions={false}
              turn={turn}
              usage={usage}
            />
          ) : null}
        </div>
      ) : null}
      {complete && !expanded
        ? projection.history
            .filter(
              (node): node is Extract<TurnDisplayNode, { kind: "user" }> =>
                node.kind === "user",
            )
            .map((node) => renderUserItem(node.item))
        : null}
      {complete && projection.finalItem !== null ? (
        <div className="turn-final">
          <AgentMessage
            item={projection.finalItem}
            showActions
            turn={turn}
            usage={usage}
          />
        </div>
      ) : projection.terminalFallback === null ? null : (
        <div className="turn-terminal" role="status">
          {projection.terminalFallback}
        </div>
      )}
    </section>
  );
}

export function usageLabel(usage: ModelUsageAggregate, prefix: string): string {
  const cache =
    usage.cacheHitRate === undefined
      ? `${prefix} unknown`
      : `${prefix} ${String(Math.round(usage.cacheHitRate * 100))}%`;
  return `${cache} · ${formatTokenCount(usage.inputTokens)} in · ${formatTokenCount(usage.outputTokens)} out`;
}

export function contextUsageLabel(
  context: ModelContextUsageProjection,
): string | null {
  if (context.inputTokens === null && context.contextWindow === null) {
    return null;
  }
  if (context.inputTokens === null) {
    const window = context.contextWindow;
    return window === null
      ? null
      : `Context unknown · ${formatTokenCount(window)} max`;
  }
  const input = formatTokenCount(context.inputTokens);
  const source = context.inputTokenSource === "estimated" ? " est." : "";
  if (context.contextWindow === null || context.ratio === null) {
    return `Context unknown · ${input} in${source}`;
  }
  return `Context ${String(Math.round(context.ratio * 100))}%${source} · ${input} / ${formatTokenCount(context.contextWindow)}`;
}

export function threadCacheUsageLabel(
  cacheHitRate: number | undefined,
): string {
  return cacheHitRate === undefined
    ? "Thread cache unknown"
    : `Thread cache ${String(Math.round(cacheHitRate * 100))}%`;
}

export function ContextUsageIndicator({
  context,
  threadCacheHitRate,
  compactDisabled = false,
  onCompact,
}: {
  context?: ModelContextUsageProjection;
  threadCacheHitRate?: number;
  compactDisabled?: boolean;
  onCompact?(): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const [popoverPosition, setPopoverPosition] = useState({
    left: 0,
    width: 286,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const root = rootRef.current;
    const boundary = root.closest(".thread-view");
    const place = () => {
      const anchor = root.getBoundingClientRect();
      const bounds = boundary?.getBoundingClientRect();
      const left = Math.max(0, bounds?.left ?? 0) + 8;
      const right =
        Math.min(
          window.innerWidth,
          bounds?.width ? bounds.right : window.innerWidth,
        ) - 8;
      const width = Math.min(286, Math.max(0, right - left));
      setPopoverPosition({
        left:
          Math.max(left, Math.min(anchor.right - width, right - width)) -
          anchor.left,
        width,
      });
    };
    place();
    window.addEventListener("resize", place);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(place);
    observer?.observe(root);
    if (boundary) observer?.observe(boundary);
    return () => {
      window.removeEventListener("resize", place);
      observer?.disconnect();
    };
  }, [open]);
  if (context?.ratio === null || context?.ratio === undefined) return null;
  const percent = Math.round(context.ratio * 100);
  const visualRatio = Math.max(0, Math.min(1, context.ratio));
  const visualPercent = Math.round(visualRatio * 100);
  const label = contextUsageLabel(context);
  const contextLabel = label ?? `Context ${String(percent)}%`;
  const tooltip = `${contextLabel}\n${threadCacheUsageLabel(threadCacheHitRate)}`;
  const radius = 7;
  return (
    <div
      className="context-usage-indicator"
      ref={rootRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement))
          setOpen(false);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        className="context-usage-trigger"
        type="button"
        aria-controls={popoverId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Open context details. ${tooltip}`}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <circle className="context-usage-track" cx="10" cy="10" r={radius} />
          <circle
            className="context-usage-progress"
            cx="10"
            cy="10"
            r={radius}
            pathLength="1"
            strokeDasharray={`${visualRatio} 1`}
          />
        </svg>
      </button>
      {open ? (
        <div
          className="context-usage-popover"
          style={popoverPosition}
          id={popoverId}
          role="dialog"
          aria-label="Context details"
        >
          <div className="context-usage-heading">
            <span>Context window</span>
            <strong>{String(percent)}%</strong>
          </div>
          <div
            className="context-usage-meter"
            role="progressbar"
            aria-label={contextLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={visualPercent}
          >
            <span style={{ width: `${String(visualPercent)}%` }} />
          </div>
          <p>{contextLabel}</p>
          <p>{threadCacheUsageLabel(threadCacheHitRate)}</p>
          <p className="context-usage-explanation">
            Condense earlier context for the next reply. Your conversation stays
            available.
          </p>
          <button
            className="context-usage-compact"
            type="button"
            disabled={compactDisabled || onCompact === undefined}
            onClick={() => {
              setOpen(false);
              void onCompact?.();
            }}
          >
            Compact context
          </button>
        </div>
      ) : null}
    </div>
  );
}

function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function DisplayNode({
  node,
  turn,
  usage,
  pluginSnapshot,
  pluginUiRegistry,
}: {
  node: Exclude<TurnDisplayNode, { kind: "user" }>;
  turn: Turn;
  usage?: ModelUsageAggregate;
  pluginSnapshot: ZenXPluginSnapshot | null;
  pluginUiRegistry: PluginUiRegistry | null;
}) {
  return node.kind === "agent" ? (
    <AgentMessage
      item={node.item}
      showActions={
        (turn.status === "failed" || turn.status === "interrupted") &&
        turn.items
          .filter(
            (item) => item.type === "agentMessage" && item.text.length > 0,
          )
          .at(-1)?.id === node.item.id
      }
      turn={turn}
      usage={usage}
    />
  ) : (
    <TraceSequence
      node={node}
      pluginSnapshot={pluginSnapshot}
      pluginUiRegistry={pluginUiRegistry}
    />
  );
}

function TraceSequence({
  node,
  pluginSnapshot,
  pluginUiRegistry,
}: {
  node: Extract<TurnDisplayNode, { kind: "traceItem" | "traceGroup" }>;
  pluginSnapshot: ZenXPluginSnapshot | null;
  pluginUiRegistry: PluginUiRegistry | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  const grouped = node.kind === "traceGroup";
  const singleton = node.kind === "traceItem" ? node.item : null;
  const singletonExpandable =
    singleton !== null && traceItemExpandable(singleton);
  const toggleExpanded = () => {
    setExpanded((current) => {
      if (current) setOpenItems(new Set());
      else if (singleton !== null && singletonExpandable) {
        setOpenItems(new Set([singleton.id]));
      }
      return !current;
    });
  };
  return (
    <section className={grouped ? "trace-group" : "trace-item trace-singleton"}>
      {grouped ? (
        <button
          className="trace-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          <Icon name="layers" size={15} />
          <span>{node.summary}</span>
          <small>{node.items.length} items</small>
          <Icon name="chevron-down" size={13} />
        </button>
      ) : singletonExpandable ? (
        <button
          className="trace-item-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          <TraceItemHeader item={singleton} expandable />
        </button>
      ) : (
        <div className="trace-item-static">
          <TraceItemHeader item={singleton!} expandable={false} />
        </div>
      )}
      {!grouped && expanded && singletonExpandable ? (
        <TraceDetail
          item={singleton}
          pluginSnapshot={pluginSnapshot}
          pluginUiRegistry={pluginUiRegistry}
        />
      ) : null}
      {grouped && expanded ? (
        <div className="trace-items">
          {traceDisplayRows(node.items).map(
            ({ item, nested, parentToolName }) => {
              const open = openItems.has(item.id);
              const expandable = traceItemExpandable(item);
              return (
                <div
                  className={`trace-item${nested ? " trace-item-nested" : ""}`}
                  aria-label={
                    nested
                      ? `Nested tool invoked by ${parentToolName ?? "parent code"}`
                      : undefined
                  }
                  key={item.id}
                >
                  {expandable ? (
                    <button
                      className="trace-item-toggle"
                      type="button"
                      aria-expanded={open}
                      onClick={() =>
                        setOpenItems((current) => {
                          const next = new Set(current);
                          if (next.has(item.id)) next.delete(item.id);
                          else next.add(item.id);
                          return next;
                        })
                      }
                    >
                      <TraceItemHeader item={item} expandable />
                    </button>
                  ) : (
                    <div className="trace-item-static">
                      <TraceItemHeader item={item} expandable={false} />
                    </div>
                  )}
                  {open && expandable ? (
                    <TraceDetail
                      item={item}
                      pluginSnapshot={pluginSnapshot}
                      pluginUiRegistry={pluginUiRegistry}
                    />
                  ) : null}
                </div>
              );
            },
          )}
        </div>
      ) : null}
    </section>
  );
}

function TraceItemHeader({
  item,
  expandable,
}: {
  item: Extract<ThreadItem, { type: "reasoning" | "commandExecution" }>;
  expandable: boolean;
}) {
  return (
    <>
      <Icon
        name={
          item.type === "reasoning"
            ? "reasoning"
            : toolPresentation(item.toolName ?? item.command).icon
        }
        size={14}
      />
      <strong>
        {item.type === "reasoning"
          ? "Think"
          : toolPresentation(item.toolName ?? item.command).category}
      </strong>
      <span>{traceItemLabel(item)}</span>
      <span className="trace-item-status">
        <StatusMark item={item} />
      </span>
      <span className="trace-item-chevron">
        {expandable ? <Icon name="chevron-down" size={13} /> : null}
      </span>
    </>
  );
}

function traceItemExpandable(
  item: Extract<ThreadItem, { type: "reasoning" | "commandExecution" }>,
): boolean {
  return (
    item.type !== "reasoning" || reasoningContentText(item).trim().length > 0
  );
}

function StatusMark({ item }: { item: ThreadItem }) {
  if (item.type === "reasoning") {
    if (item.status === "inProgress")
      return <span className="mini-spinner" aria-label="Thinking" />;
    if (item.status === "interrupted")
      return <small className="tool-status interrupted">Interrupted</small>;
    return null;
  }
  if (item.type !== "commandExecution") return null;
  return item.status === "inProgress" ? (
    <span className="mini-spinner" aria-label="Running" />
  ) : (
    <small className={`tool-status ${item.status}`}>
      {commandStatus(item)}
    </small>
  );
}

function TraceDetail({
  item,
  pluginSnapshot,
  pluginUiRegistry,
}: {
  item: ThreadItem;
  pluginSnapshot: ZenXPluginSnapshot | null;
  pluginUiRegistry: PluginUiRegistry | null;
}) {
  if (item.type === "reasoning") {
    return (
      <div className="trace-detail trace-detail-markdown">
        <Markdown text={reasoningContentText(item)} />
      </div>
    );
  }
  if (item.type !== "commandExecution") return null;
  return (
    <div className="trace-detail">
      <pre className="trace-command">
        <code>{item.command}</code>
      </pre>
      <ToolImages itemId={item.id} />
      <ToolResultRenderer
        item={item}
        snapshot={pluginSnapshot}
        registry={pluginUiRegistry}
        theme={
          document.documentElement.dataset.appearance === "dark"
            ? "dark"
            : "light"
        }
      />
    </div>
  );
}

function reasoningContentText(
  item: Extract<ThreadItem, { type: "reasoning" }>,
): string {
  return item.content.join("\n");
}

function UserMessage({
  item,
  attachments,
  turn,
  onOpenImage,
  onReadAttachment,
}: {
  item: Extract<ThreadItem, { type: "userMessage" }>;
  attachments: readonly AttachmentRef[];
  turn: Turn;
  onOpenImage(
    attachment: AttachmentRef,
    name: string,
    trigger: HTMLButtonElement,
  ): void;
  onReadAttachment(attachment: AttachmentRef): Promise<Uint8Array>;
}) {
  const text = item.content.map((content) => content.text).join("\n");
  return (
    <article className="user-row">
      {attachments.length === 0 ? null : (
        <div className="message-images" aria-label="Attached images">
          {attachments.map((attachment, index) => (
            <AttachmentImage
              attachment={attachment}
              key={`${attachment.sha256}-${String(index)}`}
              name={`Attached image ${String(index + 1)}`}
              onOpen={onOpenImage}
              onReadAttachment={onReadAttachment}
            />
          ))}
        </div>
      )}
      {text.length === 0 ? null : (
        <div className="user-bubble">
          <Markdown text={text} />
        </div>
      )}
      <MessageActions
        className="user-message-actions"
        copyLabel="Copy user message"
        text={text}
        turn={turn}
      />
    </article>
  );
}

function DraftImage({
  image,
  onOpen,
  onReadAttachment,
  onRemove,
}: {
  image: ComposerDraftImage;
  onOpen(trigger: HTMLButtonElement): void;
  onReadAttachment(attachment: AttachmentRef): Promise<Uint8Array>;
  onRemove(): void;
}) {
  return (
    <div className="draft-image">
      <AttachmentImage
        attachment={image.attachment}
        name={image.name}
        onOpen={(_attachment, _name, trigger) => onOpen(trigger)}
        onReadAttachment={onReadAttachment}
      />
      <button
        className="remove-draft-image"
        type="button"
        aria-label={`Remove ${image.name}`}
        title={`Remove ${image.name}`}
        onClick={onRemove}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

function imageFiles(files: FileList): File[] {
  return Array.from(files).filter((file) =>
    ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type),
  );
}

function hasImageFiles(files: FileList): boolean {
  return imageFiles(files).length > 0;
}

function AgentMessage({
  item,
  showActions,
  turn,
  usage,
}: {
  item: Extract<ThreadItem, { type: "agentMessage" }>;
  showActions: boolean;
  turn: Turn;
  usage?: ModelUsageAggregate;
}) {
  return (
    <article className="agent-copy">
      <Markdown text={item.text} />
      {item.text.length === 0 ? <span className="stream-cursor" /> : null}
      {showActions ? (
        <MessageActions
          className="assistant-message-actions"
          copyLabel="Copy assistant message"
          text={item.text}
          turn={turn}
          usage={usage}
        />
      ) : null}
    </article>
  );
}

function MessageActions({
  className,
  copyLabel,
  text,
  turn,
  usage,
}: {
  className: string;
  copyLabel: string;
  text: string;
  turn: Turn;
  usage?: ModelUsageAggregate;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className={`message-actions ${className}`}>
      {turn.completedAt === null ? null : (
        <time
          className="message-time"
          dateTime={new Date(turn.completedAt * 1_000).toISOString()}
        >
          {formatCompletedAt(turn.completedAt)}
        </time>
      )}
      {usage === undefined ? null : (
        <span className="message-cache" title="Turn cache telemetry">
          {usageLabel(usage, "Cache")}
        </span>
      )}
      <button
        className="message-copy"
        type="button"
        aria-label={copied ? copyLabel.replace(/^Copy/u, "Copied") : copyLabel}
        title={copied ? "Copied" : "Copy"}
        onClick={() => void copy()}
      >
        <Icon name={copied ? "check" : "copy"} size={14} />
      </button>
    </div>
  );
}

function WakeupCard({ entry }: { entry: TriggerHistoryEntry }) {
  return (
    <article className={`wakeup-card ${entry.status}`}>
      <header>
        <Icon name="trigger" size={14} />
        <strong>Trigger wakeup</strong>
        <span>{entry.kind}</span>
      </header>
      <p>{entry.reason}</p>
      <Markdown text={entry.prompt} />
      {entry.error ? <small>{entry.error}</small> : null}
    </article>
  );
}

function ApprovalBar({
  approval,
  onRespond,
}: {
  approval: ApprovalCardState;
  onRespond(requestId: string, decision: ApprovalDecision): Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const respond = async (decision: "accept" | "decline") => {
    setError(null);
    try {
      await onRespond(approval.requestId, decision);
      document.getElementById("thread-composer")?.focus();
    } catch (reason) {
      setError(describeError(reason));
    }
  };
  const once = approval.params.approvalScope === "once";
  const runCode = approval.params.toolName === "run_code";
  const toolName = approval.params.toolName ?? "tool";
  const code =
    runCode && typeof approval.params.toolArguments?.code === "string"
      ? approval.params.toolArguments.code
      : approval.params.command;
  return (
    <section className="approval-bar" aria-label={`${toolName} approval`}>
      <span className="approval-icon" aria-hidden="true">
        <Icon name="warning" size={15} />
      </span>
      <div>
        <strong>
          {once
            ? `Allow ${toolName} with full file access once?`
            : runCode
              ? "Allow the shell-equivalent run_code capability?"
              : `Allow the ${toolName} capability?`}
        </strong>
        <p>
          {once
            ? "This call runs outside the file sandbox. Approval applies only to this call and its nested operations."
            : `Approval is remembered for the stable ${toolName} capability, not granted per command or code segment.`}
        </p>
        <pre className="approval-command">
          <code>{code}</code>
        </pre>
        <code className="approval-cwd">
          Working directory: {approval.params.cwd}
        </code>
        {error ? <small role="alert">{error}</small> : null}
      </div>
      <div className="approval-actions">
        <button type="button" onClick={() => void respond("decline")}>
          Deny
        </button>
        <button
          className="allow"
          type="button"
          onClick={() => void respond("accept")}
        >
          {once ? "Allow once" : "Allow capability"}
        </button>
      </div>
    </section>
  );
}

function traceItemLabel(item: ThreadItem): string {
  if (item.type === "reasoning") {
    const summary = item.summary.join("\n").trim();
    return summary.length > 0 ? summary : "Reasoning details";
  }
  return item.type === "commandExecution"
    ? item.toolName === "run_code" &&
      typeof item.toolArguments?.description === "string"
      ? item.toolArguments.description
      : (toolPresentation(item.toolName ?? item.command).action ??
        commandLabel(item.toolName ?? item.command))
    : "Item details";
}

function completedTurnLabel(turn: Turn): string {
  const duration = turn.durationMs;
  const result =
    turn.status === "completed"
      ? "Worked"
      : turn.status === "interrupted"
        ? "Interrupted"
        : "Failed";
  if (duration === null) return result;
  return `${result} for ${formatDuration(duration)}`;
}

function formatCompletedAt(seconds: number): string {
  const completed = new Date(seconds * 1_000);
  const now = new Date();
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(completed);
  if (
    completed.getFullYear() === now.getFullYear() &&
    completed.getMonth() === now.getMonth() &&
    completed.getDate() === now.getDate()
  ) {
    return time;
  }
  const date = new Intl.DateTimeFormat(
    undefined,
    completed.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" },
  ).format(completed);
  return `${date} ${time}`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

function commandStatus(
  item: Extract<ThreadItem, { type: "commandExecution" }>,
): string {
  const data = item.structuredContent;
  if (
    item.contentType === "application/vnd.zen.tool-task+json" &&
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    "status" in data
  ) {
    if (data.status === "queued") return "Queued";
    if (data.status === "running")
      return item.toolName === "wait" ? "Waiting" : "Started";
    if (data.status === "cancel_requested") return "Cancelling";
    if (data.status === "cancellation_unconfirmed")
      return "Cancellation unconfirmed";
    if (data.status === "failed") return "Failed";
    if (data.status === "completed") return "Done";
    if (data.status === "timed_out") return "Timed out";
    if (data.status === "cancelled") return "Cancelled";
  }
  return {
    inProgress: "Running",
    completed: "Done",
    failed: "Failed",
    declined: "Declined",
  }[item.status];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
