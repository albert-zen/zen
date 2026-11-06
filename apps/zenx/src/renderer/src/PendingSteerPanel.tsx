import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  CanonicalItem,
  SteerRecalledItem,
} from "../../../../../src/item.js";
import {
  recoverSteerRecall,
  type PendingSteerInput,
  type RecoveredSteerRecall,
} from "../../../../../src/steer-recall.js";
import type { NativeSteerRecallParams } from "../../../../../src/protocol/native/wire.js";
import { unwrapQueueMutationIpcReply } from "../../preload/queue-edit-ipc.js";
import {
  createSteerRecallStore,
  recalledDrafts,
  resolveRecallRead,
  validateRecallReply,
  type RecallSession,
  type SteerRecallStore,
} from "./steer-recall-state.js";
import { queuedInputDraft } from "./queue-edit-draft.js";
import { parseSkillDraft } from "./skill-draft.js";
import { referenceTitle } from "./reference-draft.js";
import { Markdown } from "./Markdown.js";
import { steerPreviewColumn } from "./steer-preview-column.js";
import { InlineReferenceContent } from "./InlineReferenceContent.js";
import { Icon } from "./icons.js";
import { localErrorDetail } from "../../local-error-detail.js";
import type { AttachmentRef } from "../../../../../src/attachment.js";
import { AttachmentImage, ImagePreview } from "./ImagePresentation.js";
import { sameImageAttachment } from "./queued-message-images.js";
import { useCommittedCallback } from "./use-committed-callback.js";

export interface PendingSteerPanelProps {
  threadId: string;
  items: readonly CanonicalItem[];
  pending: readonly PendingSteerInput[];
  runningTurnId: string | null;
  store?: SteerRecallStore;
  onRestore?(result: RecoveredSteerRecall): boolean | Promise<boolean>;
  onReadAttachment?(attachment: AttachmentRef): Promise<Uint8Array>;
}

/** Native pending control facts only; receipt never means model consumption. */
export function PendingSteerPanel(props: PendingSteerPanelProps) {
  const { t } = useTranslation("shell");
  const [fallback] = useState(createSteerRecallStore);
  const store = props.store ?? fallback;
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const session = snapshot.sessions[props.threadId];
  const owner = useRef(Symbol("recall-view"));
  const mounted = useRef(false);
  const restoring = useRef(new Set<string>());
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const [confirm, setConfirm] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const detailsId = useId();
  const shelfRef = useRef<HTMLElement>(null);
  // Match the real transcript column, including independent native scrollbars.
  // Geometry changes never alter admission, recall, or scroll ownership.
  useLayoutEffect(() => {
    const shelf = shelfRef.current;
    const details = shelf?.querySelector<HTMLElement>(".steer-shelf-details");
    const view = shelf?.closest(".thread-view");
    const column = view?.querySelector<HTMLElement>(
      ".virtual-transcript-header, .messages-inner",
    );
    if (!shelf || !details || !column || !detailsOpen) return;
    const measure = () => {
      const rect = column.getBoundingClientRect();
      if (rect.width <= 0) return;
      const geometry = steerPreviewColumn(
        rect,
        shelf.getBoundingClientRect().left,
        details.offsetWidth - details.clientWidth,
      );
      for (const [name, value] of Object.entries(geometry)) {
        const pixel = `${value}px`;
        if (details.style.getPropertyValue(`--steer-column-${name}`) !== pixel)
          details.style.setProperty(`--steer-column-${name}`, pixel);
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    observer.observe(shelf);
    observer.observe(details);
    return () => observer.disconnect();
  });
  const [preview, setPreview] = useState<{
    queuedItemId: string;
    clientId: string;
    attachment: AttachmentRef;
    name: string;
    trigger: HTMLButtonElement;
  } | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const canonicalReceipts = useMemo(
    () =>
      props.items.filter(
        (item): item is SteerRecalledItem =>
          item.type === "user_message_steer_recalled" &&
          item.threadId === props.threadId,
      ),
    [props.items, props.threadId],
  );
  const receiptItems = [...canonicalReceipts];
  if (
    session?.result &&
    !receiptItems.some((item) => item.id === session.result!.receipt.id)
  )
    receiptItems.push(session.result.receipt);
  const recoverable = receiptItems.filter(
    (item) => !snapshot.applied.has(item.id),
  );
  const recalledIds = new Set(
    session?.result?.receipt.targets.map((target) => target.queuedItemId) ?? [],
  );
  const pending = props.pending.filter((item) => !recalledIds.has(item.id));
  const isCurrentImage = (
    attachment: AttachmentRef,
    queuedItemId?: string,
    clientId?: string,
  ) =>
    pending.some(
      (item) =>
        item.threadId === props.threadId &&
        (queuedItemId === undefined ||
          (item.id === queuedItemId && item.clientId === clientId)) &&
        item.input.some(
          (part) =>
            part.type === "image" &&
            sameImageAttachment(part.attachment, attachment),
        ),
    );
  const readPendingImage = useCommittedCallback(
    async (attachment: AttachmentRef) => {
      if (!props.onReadAttachment || !isCurrentImage(attachment))
        throw new Error(t("steerPendingImageUnavailable"));
      return await props.onReadAttachment(attachment);
    },
  );
  const previewCurrent =
    preview !== null &&
    detailsOpen &&
    isCurrentImage(preview.attachment, preview.queuedItemId, preview.clientId);
  useLayoutEffect(() => {
    if (!previewCurrent && preview !== null) setPreview(null);
  }, [previewCurrent, preview]);
  const busy = session?.phase === "pending" || session?.phase === "unknown";
  const held = pending.some(
    (item) => item.expectedTurnId !== props.runningTurnId,
  );
  const supported = pending.every(
    (item) => queuedInputDraft(item.input, item.id, item.clientId) !== null,
  );

  const restoreOrigins = async (
    result: RecoveredSteerRecall,
  ): Promise<boolean> => {
    const id = result.receipt.id;
    if (
      !mounted.current ||
      latest.current.threadId !== result.receipt.threadId ||
      store.getSnapshot().applied.has(id) ||
      restoring.current.has(id)
    )
      return false;
    restoring.current.add(id);
    try {
      const restored = await latest.current.onRestore?.(result);
      if (restored) store.applied(id);
      return restored === true;
    } catch {
      if (
        mounted.current &&
        latest.current.threadId === result.receipt.threadId
      )
        setRestoreError(t("steerRecoveryBusy"));
      return false;
    } finally {
      restoring.current.delete(id);
    }
  };

  const finish = async (
    attempt: RecallSession,
    result: RecoveredSteerRecall,
  ) => {
    const current = store.getSnapshot().sessions[attempt.request.threadId];
    if (current?.request.recallId !== attempt.request.recallId) return;
    store.set(attempt.request.threadId, {
      request: attempt.request,
      owner: attempt.owner,
      phase: "ready",
      result,
    });
    if (
      mounted.current &&
      attempt.owner === owner.current &&
      latest.current.threadId === attempt.request.threadId
    )
      await restoreOrigins(result);
  };

  useEffect(() => {
    const current = store.getSnapshot().sessions[props.threadId];
    if (current?.phase !== "pending" && current?.phase !== "unknown") return;
    const recovered = recoverSteerRecall(
      props.items,
      props.threadId,
      current.request.recallId,
    );
    if (recovered !== undefined) {
      const outcome = resolveRecallRead(current.request, props.items);
      if (outcome.state === "recalled") void finish(current, outcome.result);
    }
  }, [props.items, props.threadId, session?.phase, session?.request.recallId]);

  const readOutcome = async (attempt: RecallSession) => {
    if (store.getSnapshot().sessions[attempt.request.threadId]?.result) return;
    try {
      const recovered = await window.zenx.protocol.request("zen/thread/read", {
        threadId: attempt.request.threadId,
      });
      if (recovered.thread.id !== attempt.request.threadId)
        throw new Error("Mismatched recovery Thread");
      if (
        store.getSnapshot().sessions[attempt.request.threadId]?.request
          .recallId !== attempt.request.recallId ||
        store.getSnapshot().sessions[attempt.request.threadId]?.result
      )
        return;
      const outcome = resolveRecallRead(
        attempt.request,
        recovered.thread.items,
      );
      if (outcome.state === "recalled") await finish(attempt, outcome.result);
      else
        store.set(attempt.request.threadId, {
          ...attempt,
          phase: outcome.state === "conflict" ? "failed" : "unknown",
          error: t(
            outcome.state === "conflict"
              ? "steerRecallConflict"
              : "steerRecallUnknown",
          ),
        });
    } catch (error) {
      if (
        store.getSnapshot().sessions[attempt.request.threadId]?.request
          .recallId !== attempt.request.recallId ||
        store.getSnapshot().sessions[attempt.request.threadId]?.result
      )
        return;
      store.set(attempt.request.threadId, {
        ...attempt,
        phase: "unknown",
        error: t("steerRecallUnknown"),
        errorDetail: localErrorDetail({
          writeOrPreviousRead: attempt.errorDetail,
          read: error,
        }),
      });
    }
  };

  const recall = async () => {
    const current = store.getSnapshot().sessions[props.threadId];
    if (
      current?.phase === "pending" ||
      current?.phase === "unknown" ||
      pending.length === 0 ||
      !supported ||
      props.onRestore === undefined
    )
      return;
    const request: NativeSteerRecallParams = {
      threadId: props.threadId,
      recallId: crypto.randomUUID(),
      targets: pending.map((item) => ({
        queuedItemId: item.id,
        clientId: item.clientId,
        expectedRevision: item.revision,
      })),
    };
    const attempt: RecallSession = {
      request,
      owner: owner.current,
      phase: "pending",
    };
    store.set(props.threadId, attempt);
    try {
      const reply = unwrapQueueMutationIpcReply(
        await window.zenx.protocol.request("zen/thread/steer/recall", request),
      );
      await finish(attempt, validateRecallReply(request, reply));
    } catch (error) {
      const current = store.getSnapshot().sessions[attempt.request.threadId];
      if (
        current?.request.recallId !== attempt.request.recallId ||
        current.result
      )
        return;
      const code =
        typeof error === "object" &&
        error !== null &&
        "data" in error &&
        typeof error.data === "object" &&
        error.data !== null &&
        "zenCode" in error.data
          ? error.data.zenCode
          : undefined;
      if (
        [
          "steer_recall_conflict",
          "idempotency_conflict",
          "invalid_request",
          "steer_recall_unsupported_input",
          "operation_forbidden",
          "thread_not_found",
        ].includes(String(code))
      ) {
        store.set(props.threadId, {
          ...attempt,
          phase: "failed",
          errorDetail: localErrorDetail(error),
          error: t(
            code === "steer_recall_unsupported_input"
              ? "steerRecallUnsupported"
              : "steerRecallConflict",
          ),
        });
      } else
        await readOutcome({ ...attempt, errorDetail: localErrorDetail(error) });
    }
  };

  const restore = async (receipt: SteerRecalledItem) => {
    if (store.getSnapshot().applied.has(receipt.id)) return;
    const result =
      session?.result?.receipt.id === receipt.id
        ? session.result
        : recoverSteerRecall(props.items, props.threadId, receipt.recallId);
    if (result === undefined || recalledDrafts(result) === null) return;
    const restored = await restoreOrigins(result);
    if (!mounted.current || latest.current.threadId !== receipt.threadId)
      return;
    if (restored) {
      setConfirm(null);
      setRestoreError(null);
    } else setRestoreError(t("steerRecoveryBusy"));
  };

  if (pending.length === 0 && recoverable.length === 0 && !session?.error)
    return null;
  return (
    <section
      ref={shelfRef}
      className={`pending-steer-panel queue-shelf steer-shelf${detailsOpen ? " is-open" : ""}`}
      aria-label={t("steerPendingLabel")}
    >
      {pending.length > 0 ? (
        <>
          <div className="pending-steer-heading queue-shelf-header">
            <button
              type="button"
              className="queue-shelf-toggle"
              aria-controls={detailsId}
              aria-expanded={detailsOpen}
              aria-label={t(
                detailsOpen ? "queueHideMessages" : "queueShowMessages",
              )}
              onClick={() => setDetailsOpen(!detailsOpen)}
            >
              {held ? (
                <Icon name="trigger" size={14} />
              ) : (
                <span className="mini-spinner" aria-hidden="true" />
              )}
              <span role="status" aria-live="polite" aria-atomic="true">
                {t("steerPendingCount", { count: pending.length })}
              </span>
              <Icon
                name="chevron-down"
                size={12}
                className="queue-shelf-chevron"
              />
            </button>
            <button
              type="button"
              className="queue-header-action"
              title={t(
                pending.length === 1 ? "steerRecallOne" : "steerRecallAll",
              )}
              onClick={() => void recall()}
              disabled={busy || !supported || props.onRestore === undefined}
            >
              <Icon name="restore" size={14} />
              {session?.phase === "pending"
                ? t("steerRecalling")
                : t(
                    pending.length === 1
                      ? "steerRecallOneShort"
                      : "steerRecallAllShort",
                  )}
            </button>
          </div>
          {held ? (
            <p className="steer-shelf-notice">{t("steerHeldNotice")}</p>
          ) : null}
          {!supported ? (
            <p role="status">{t("steerRecallUnsupported")}</p>
          ) : null}
          <div
            id={detailsId}
            className="queue-shelf-details steer-shelf-details"
            hidden={!detailsOpen}
          >
            <ol className="queue-shelf-list">
              {pending.map((item) => {
                const draft = queuedInputDraft(
                  item.input,
                  item.id,
                  item.clientId,
                );
                const parsed =
                  draft === null ? null : parseSkillDraft(draft.text);
                const text =
                  parsed === null
                    ? ""
                    : referenceTitle(parsed.text, parsed.references);
                const body =
                  parsed === null ? (
                    t("steerStructuredInput")
                  ) : (
                    <div className="pending-steer-text">
                      {parsed.references.length > 0 ? (
                        <InlineReferenceContent
                          text={parsed.text}
                          references={parsed.references}
                        />
                      ) : (
                        <Markdown text={parsed.text} />
                      )}
                    </div>
                  );
                return (
                  <li
                    className="queue-row user-row steer-shelf-row"
                    key={item.id}
                  >
                    {detailsOpen && draft?.images.length ? (
                      <div
                        className="message-images pending-steer-images"
                        aria-label={t("steerImageCount", {
                          count: draft.images.length,
                        })}
                      >
                        {props.onReadAttachment ? (
                          draft.images.map((image) => (
                            <AttachmentImage
                              key={image.id}
                              attachment={image.attachment}
                              name={image.name}
                              onReadAttachment={readPendingImage}
                              onOpen={(attachment, name, trigger) => {
                                if (
                                  isCurrentImage(
                                    attachment,
                                    item.id,
                                    item.clientId,
                                  )
                                )
                                  setPreview({
                                    queuedItemId: item.id,
                                    clientId: item.clientId,
                                    attachment,
                                    name,
                                    trigger,
                                  });
                              }}
                              lazy
                              retryOnError
                              compact
                            />
                          ))
                        ) : (
                          <span className="image-placeholder">
                            {t("steerImageCount", {
                              count: draft.images.length,
                            })}
                          </span>
                        )}
                      </div>
                    ) : null}
                    {parsed === null || text.length > 0 ? (
                      <div className="user-bubble">
                        {text.length > 240 ? (
                          <details className="pending-steer-message">
                            <summary>{text.slice(0, 240)}…</summary>
                            {body}
                          </details>
                        ) : (
                          body
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </div>
        </>
      ) : null}
      {session?.error ? (
        <div role="status">
          <p>{session.error}</p>
          {session.errorDetail ? (
            <details className="context-compaction-error-detail">
              <summary>{t("technicalDetails")}</summary>
              <pre tabIndex={0}>{session.errorDetail}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
      {restoreError ? <p role="status">{restoreError}</p> : null}
      {session?.phase === "unknown" ? (
        <button type="button" onClick={() => void readOutcome(session)}>
          {t("steerRecallCheck")}
        </button>
      ) : null}
      {recoverable.length > 0 ? (
        <details
          className="steer-recovery"
          open={
            session?.phase === "ready" &&
            session.result !== undefined &&
            !snapshot.applied.has(session.result.receipt.id)
          }
        >
          <summary>
            {t("steerRecoveryAvailable", { count: recoverable.length })}
          </summary>
          <p>{t("steerRecoveryNotice")}</p>
          {recoverable.map((receipt) => (
            <div key={receipt.id}>
              <time dateTime={receipt.createdAt}>
                {new Date(receipt.createdAt).toLocaleString(undefined, {
                  timeZoneName: "short",
                })}
              </time>
              {confirm === receipt.id ? (
                <>
                  <p>{t("steerRecoveryConfirm")}</p>
                  <button
                    type="button"
                    onClick={() => void restore(receipt)}
                    disabled={props.onRestore === undefined}
                  >
                    {t("steerRecoveryMerge")}
                  </button>
                  <button type="button" onClick={() => setConfirm(null)}>
                    {t("steerRecoveryCancel")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirm(receipt.id)}
                  disabled={props.onRestore === undefined}
                >
                  {t("steerRecoveryRestore")}
                </button>
              )}
            </div>
          ))}
        </details>
      ) : null}
      {previewCurrent && preview ? (
        <ImagePreview
          attachment={preview.attachment}
          name={preview.name}
          trigger={preview.trigger}
          onReadAttachment={readPendingImage}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </section>
  );
}
