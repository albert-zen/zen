import { unwrapCompactionIpcReply } from "../../preload/compaction-ipc.js";
import type { ClientSendObservation } from "../../../../../src/client-observation.js";
import { requestManualTurnRetry } from "./manual-turn-retry.js";
import { requestQueuedSteer } from "./queue-steer-request.js";
import { i18n } from "./i18n.js";
import React, { useEffect, useRef, useState } from "react";
import type {
  NativeProjectedThreadEvent,
  NativeThreadRecoverySnapshot,
} from "../../../../../src/protocol/native/recovery.js";
import type { EffectiveThreadConfiguration } from "../../../../../src/thread.js";
import { encodeModelKey } from "../../../../../src/protocol/model-key.js";
import type { ModelUsageProjection } from "../../../../../src/model-usage.js";
import type {
  QueuedCancellationTarget,
  QueuedCancellationResult,
} from "../../../../../src/app-server.js";
import type {
  AppServerHostStatus,
  ApprovalDecision,
} from "../../main/app-server-manager.js";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import type {
  ZenXHostProfile,
  ZenXProviderProfile,
} from "../../main/host-profile.js";
import type { ZenXThreadAttachmentProjection } from "../../main/image-attachments.js";
import type { ModelSummary, Thread } from "../../protocol-client/index.js";
import type { ApprovalCardState } from "./approval-state.js";
import { ThreadView } from "./ThreadView.js";
import { requestQueuedEdit, importQueuedImages } from "./queue-edit-request.js";
import type { QueueEditStore } from "./queue-edit-state.js";
import {
  applyNativeThreadEvent,
  projectNativeRecovery,
} from "./thread-view-state.js";
import {
  acceptComposerSubmission,
  addComposerImages,
  beginComposerSubmission,
  dismissCompactionFeedback,
  editComposer,
  failComposerSubmission,
  reconcileCanonicalAdmission,
  removeComposerImage,
  type ComposerIntent,
  type ComposerState,
  type ComposerSubmission,
} from "./composer-state.js";
import {
  canSendWithModel,
  hasValidReasoningSelection,
  imageCapabilityMessage,
  imageCapabilityNotice,
  modelChangeRequest,
  reasoningChangeRequest,
  type SelectedThreadSettings,
} from "./model-settings.js";
import {
  handleCompactCommand,
  isCompactCommand,
  requestContextCompaction,
} from "./compact-command.js";
import type { WorkflowCommand } from "./workflow-commands.js";

function nativeSettings(
  threadId: string,
  value: EffectiveThreadConfiguration,
): SelectedThreadSettings {
  return {
    threadId,
    model: encodeModelKey(value),
    modelProvider: value.providerProfileId,
    reasoningEffort: value.reasoningEffort,
    permissionMode: value.sandbox,
    approvalPolicy: value.approvalPolicy === "never" ? "never" : "on-request",
  };
}

/** A transient viewport onto the existing native Thread, never a new session. */
export function ThreadConversationViewport({
  queueEditStore,
  onRecovery,
  threadId,
  composer,
  readComposer,
  updateComposer,
  deliver,
  cancelQueued,
  onOpenMessageLink,
  models,
  providerProfiles,
  serverStatus,
  approvals,
  respondToApproval,
  pluginSnapshot,
  composerSendMode,
  onComposerSendModeChange,
  workflowCommands,
  archived = false,
}: {
  queueEditStore?: QueueEditStore;
  onRecovery?(threadId: string, snapshot: NativeThreadRecoverySnapshot): void;
  threadId: string;
  composer: ComposerState;
  readComposer(): ComposerState;
  updateComposer(change: (state: ComposerState) => ComposerState): void;
  deliver(submission: ComposerSubmission): Promise<void>;
  cancelQueued(
    targets: readonly QueuedCancellationTarget[],
  ): Promise<{ results: QueuedCancellationResult[] }>;
  onOpenMessageLink(target: { kind: "file" | "browser"; value: string }): void;
  models: readonly ModelSummary[];
  providerProfiles: readonly ZenXProviderProfile[];
  serverStatus: AppServerHostStatus;
  approvals: readonly ApprovalCardState[];
  respondToApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  pluginSnapshot: ZenXPluginSnapshot | null;
  composerSendMode: ZenXHostProfile["composerSendMode"];
  onComposerSendModeChange(
    mode: ZenXHostProfile["composerSendMode"],
  ): Promise<void>;
  workflowCommands: readonly WorkflowCommand[];
  archived?: boolean;
}) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [settings, setSettings] = useState<SelectedThreadSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attachments, setAttachments] =
    useState<ZenXThreadAttachmentProjection>({});
  const [usage, setUsage] = useState<ModelUsageProjection>();
  const [revision, setRevision] = useState(0);
  const [queueFailure, setQueueFailure] = useState<{
    queuedItemId: string;
    revision?: number;
    code: string;
    message: string;
  } | null>(null);
  const callbacks = useRef({ updateComposer, onRecovery });
  callbacks.current = { updateComposer, onRecovery };
  const generation = useRef(0);
  useEffect(() => {
    const epoch = ++generation.current;
    const current = () => generation.current === epoch;
    if (serverStatus.type !== "ready") {
      setLoading(true);
      setThread(null);
      return;
    }
    setThread(null);
    setSettings(null);
    setAttachments({});
    setUsage(undefined);
    setQueueFailure(null);
    setError(null);
    setLoading(true);
    let buffered: NativeProjectedThreadEvent[] | null = [];
    let projection: Thread | null = null;
    let processEpoch: string | null = null;
    let watermark = 0;
    let mediaEpoch = 0;
    const refreshMedia = () => {
      const media = ++mediaEpoch;
      void Promise.all([
        window.zenx.imageAttachments.forThread(threadId),
        window.zenx.modelUsage.forThread(threadId),
      ])
        .then(([images, modelUsage]) => {
          if (!current() || media !== mediaEpoch) return;
          setAttachments(images);
          setUsage(modelUsage);
        })
        .catch((cause: unknown) => {
          if (current()) setError(message(cause));
        });
    };
    const apply = (event: NativeProjectedThreadEvent) => {
      if (
        event.processEpoch !== processEpoch ||
        event.watermark <= watermark ||
        projection === null
      )
        return;
      watermark = event.watermark;
      projection = applyNativeThreadEvent(projection, event.event);
      setThread(projection);
      if (event.event.type === "thread_settings_updated")
        setSettings(nativeSettings(threadId, event.event.settings));
      if (
        event.event.type === "queue_failed" ||
        event.event.type === "queue_admission_started"
      ) {
        const queueEvent = event.event;
        if (
          projection.queuedMessages?.some(
            (item) =>
              item.id === queueEvent.queuedItemId &&
              item.clientId === queueEvent.clientId &&
              (item.revision ?? 0) === (queueEvent.revision ?? 0),
          )
        )
          setQueueFailure(
            queueEvent.type === "queue_failed" ? queueEvent : null,
          );
      }
      if (
        event.event.type === "item_completed" &&
        event.event.item.type === "user_message_queue_edited"
      ) {
        const edited = event.event.item;
        setQueueFailure((current) =>
          current?.queuedItemId === edited.queuedItemId &&
          (current.revision ?? 0) < edited.revision
            ? null
            : current,
        );
      }
      if (projection.canonicalItems !== undefined)
        callbacks.current.updateComposer((state) =>
          reconcileCanonicalAdmission(
            state,
            projection!.canonicalItems!,
            event.event.type === "turn_completed"
              ? { turnId: event.event.turnId, status: event.event.status }
              : undefined,
          ),
        );
      if (
        event.event.type === "turn_completed" ||
        event.event.type === "item_completed"
      )
        refreshMedia();
    };
    const dispose = window.zenx.protocol.onNotification((method, params) => {
      if (!current() || method !== "zen/thread/event") return;
      const event = params as NativeProjectedThreadEvent;
      if (event.threadId !== threadId) return;
      if (
        event.event.type === "thread_deleted_updated" &&
        event.event.deleted
      ) {
        if (
          processEpoch !== null &&
          (event.processEpoch !== processEpoch || event.watermark <= watermark)
        )
          return;
        // Revoke this viewport independently of the primary App selection. This
        // also fences its pending resume and attachment/usage responses.
        generation.current += 1;
        buffered = null;
        projection = null;
        setThread(null);
        setSettings(null);
        setAttachments({});
        setUsage(undefined);
        setQueueFailure(null);
        setLoading(false);
        setError(
          i18n.t("settings:settingsView.deletedConversationUnavailable"),
        );
        return;
      }
      if (buffered !== null) buffered.push(event);
      else apply(event);
    });
    void window.zenx.protocol
      .request("zen/thread/resume", { threadId })
      .then((snapshot) => {
        if (!current()) return;
        callbacks.current.onRecovery?.(threadId, snapshot);
        projection = projectNativeRecovery(snapshot);
        processEpoch = snapshot.processEpoch;
        watermark = snapshot.watermark;
        setThread(projection);
        setSettings(nativeSettings(threadId, snapshot.thread));
        callbacks.current.updateComposer((state) =>
          reconcileCanonicalAdmission(state, snapshot.thread.items),
        );
        const pending = buffered ?? [];
        buffered = null;
        pending.forEach(apply);
        setLoading(false);
        refreshMedia();
      })
      .catch((cause: unknown) => {
        if (current()) {
          setError(message(cause));
          setLoading(false);
        }
      });
    return () => {
      generation.current += 1;
      dispose();
    };
  }, [threadId, serverStatus, revision]);

  const reload = () => setRevision((value) => value + 1);
  const report = async (operation: () => Promise<unknown>) => {
    const epoch = generation.current;
    setError(null);
    try {
      await operation();
    } catch (cause) {
      if (generation.current === epoch) setError(message(cause));
    }
  };
  const compact = async (id: string, includeOriginalReference = true) => {
    unwrapCompactionIpcReply(
      await window.zenx.protocol.request("thread/compact", {
        threadId: id,
        ...(includeOriginalReference
          ? {}
          : { includeOriginalReference: false }),
      }),
    );
    if (id === threadId) reload();
  };
  const submit = async (
    intent: ComposerIntent,
    expectedTurnId: string | null,
    clientObservation?: ClientSendObservation,
  ) => {
    if (
      archived ||
      thread === null ||
      settings === null ||
      serverStatus.type !== "ready"
    )
      return;
    const state = readComposer();
    if (
      isCompactCommand(state.draft.text) ||
      state.compaction?.status === "pending"
    ) {
      await handleCompactCommand({
        threadId,
        active:
          expectedTurnId !== null ||
          thread.turns.some((turn) => turn.status === "inProgress"),
        read: readComposer,
        update: updateComposer,
        compact,
      });
      return;
    }
    const imageError = state.draft.images.length
      ? imageCapabilityMessage(providerProfiles, settings, models)
      : null;
    if (imageError !== null) {
      setError(imageError);
      return;
    }
    if (
      intent !== "steer" &&
      (!canSendWithModel(models, settings.model) ||
        !hasValidReasoningSelection(models, settings))
    ) {
      setError(
        i18n.t("shell:chooseAnAvailableModelAndReasoningEffortBeforeSending"),
      );
      return;
    }
    const started = beginComposerSubmission(
      state,
      intent,
      expectedTurnId,
      () => crypto.randomUUID(),
      clientObservation,
    );
    if (started === state || started.submission?.status !== "pending") return;
    updateComposer(() => started);
    const submission = started.submission;
    try {
      await deliver(submission);
      updateComposer((value) =>
        acceptComposerSubmission(value, submission.clientUserMessageId),
      );
    } catch (cause) {
      updateComposer((value) =>
        failComposerSubmission(
          value,
          submission.clientUserMessageId,
          message(cause),
        ),
      );
    }
  };
  if (loading)
    return (
      <div className="conversation-viewport-status" role="status">
        {serverStatus.type === "ready"
          ? i18n.t("shell:loadingConversationDots")
          : i18n.t("shell:reconnecting")}
      </div>
    );
  if (thread === null || settings === null)
    return (
      <div className="conversation-viewport-status" role="alert">
        {error ?? i18n.t("shell:conversationUnavailable")}
        <button type="button" onClick={reload}>
          {i18n.t("panels:retry")}
        </button>
      </div>
    );
  return (
    <div className="thread-conversation-viewport">
      <ThreadView
        composerId={`side-composer-${threadId}`}
        thread={thread}
        composer={composer}
        approvals={approvals.filter(
          (entry) => entry.params.threadId === threadId,
        )}
        composerSendMode={composerSendMode}
        onComposerSendModeChange={onComposerSendModeChange}
        models={models}
        providerProfiles={providerProfiles}
        selectedModel={settings.model}
        selectedReasoningEffort={settings.reasoningEffort}
        modelError={error}
        permissionMode={settings.permissionMode}
        composerDisabled={archived}
        modelDisabled={archived}
        pluginSnapshot={pluginSnapshot}
        workflowCommands={workflowCommands}
        imageCapabilityError={imageCapabilityMessage(
          providerProfiles,
          settings,
          models,
        )}
        imageCapabilityNotice={imageCapabilityNotice(
          providerProfiles,
          settings,
          models,
        )}
        threadAttachments={attachments}
        threadUsage={usage}
        queueFailure={queueFailure}
        onDraftChange={(text) =>
          updateComposer((value) => editComposer(value, text))
        }
        onRespondToApproval={respondToApproval}
        queueEditStore={queueEditStore}
        onSteerQueued={(params) => {
          const epoch = generation.current;
          return requestQueuedSteer(params, () => {
            if (generation.current === epoch && params.threadId === threadId)
              reload();
          });
        }}
        onEditQueued={(params) => {
          const epoch = generation.current;
          return requestQueuedEdit(params, () => {
            // Reload uses the existing read-only native resume barrier.
            if (generation.current === epoch && params.threadId === threadId)
              reload();
          });
        }}
        onImportQueueImages={importQueuedImages}
        onPickQueueImages={() => window.zenx.imageAttachments.pick()}
        onSubmit={submit}
        onOpenMessageLink={onOpenMessageLink}
        onModelChange={(model) =>
          void report(async () =>
            window.zenx.protocol.request(
              "thread/settings/update",
              modelChangeRequest(threadId, model),
            ),
          )
        }
        onReasoningChange={(effort) =>
          void report(async () =>
            window.zenx.protocol.request(
              "thread/settings/update",
              reasoningChangeRequest(threadId, settings.model, effort),
            ),
          )
        }
        onPermissionChange={(sandbox) =>
          void report(async () => {
            await window.zenx.protocol.request("thread/permissions/update", {
              threadId,
              sandbox,
            });
            reload();
          })
        }
        onRetryTurn={
          archived
            ? undefined
            : async (turnId) => {
                await requestManualTurnRetry(thread, turnId);
              }
        }
        onInterrupt={async (turnId) => {
          await window.zenx.protocol.request("turn/interrupt", {
            threadId,
            turnId,
          });
        }}
        onResumeQueue={async () => {
          await window.zenx.protocol.request("turn/queue/resume", { threadId });
        }}
        onCancelQueued={async (items) => {
          const result = await cancelQueued(items);
          reload();
          return result;
        }}
        onReadAttachment={(attachment) =>
          window.zenx.imageAttachments.read(attachment)
        }
        onPickImages={async () => {
          const images = await window.zenx.imageAttachments.pick();
          updateComposer((value) => addComposerImages(value, images));
        }}
        onImportImages={async (files) => {
          const imports = await Promise.all(
            files.map(async (file) => ({
              name: file.name,
              mediaType: file.type,
              bytes: new Uint8Array(await file.arrayBuffer()),
            })),
          );
          const images = await window.zenx.imageAttachments.import(imports);
          updateComposer((value) => addComposerImages(value, images));
        }}
        onRemoveImage={(id) =>
          updateComposer((value) => removeComposerImage(value, id))
        }
        onCompact={async () =>
          await requestContextCompaction({
            threadId,
            active: thread.turns.some((turn) => turn.status === "inProgress"),
            clearCommandDraft: false,
            read: readComposer,
            update: updateComposer,
            compact,
          })
        }
        onDismissCompaction={() => updateComposer(dismissCompactionFeedback)}
      />
    </div>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
