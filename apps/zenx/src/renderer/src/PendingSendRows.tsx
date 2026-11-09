import { AttachmentImage } from "./ImagePresentation.js";
import type { AttachmentRef } from "../../../../../src/attachment.js";
import { parseSkillDraft } from "./skill-draft.js";
import { UserMessageContent } from "./UserMessageContent.js";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PendingSendPresentation } from "./composer-state.js";

export const PendingSendRows = memo(function PendingSendRows({
  messages,
  onReadAttachment,
  onOpenImage,
  onRecover,
  onDismiss,
  onCheck,
}: {
  messages: readonly PendingSendPresentation[];
  onReadAttachment(attachment: AttachmentRef): Promise<Uint8Array>;
  onOpenImage(
    attachment: AttachmentRef,
    name: string,
    trigger: HTMLButtonElement,
  ): void;
  onRecover?(clientId: string): void;
  onDismiss?(clientId: string): void;
  /** Only a usable authoritative read returns checked; it is not a delivery receipt. */
  onCheck?(): Promise<"checked" | "unavailable">;
}) {
  const { t } = useTranslation("shell");
  return messages.map((message) => {
    const draft = parseSkillDraft(message.draft.text);
    return (
      <article
        className="user-row pending-send-row"
        key={message.clientId}
        data-pending-send-client-id={message.clientId}
        data-send-state={message.status}
      >
        {message.draft.images.length > 0 && (
          <div className="message-images" aria-label={t("attachedImages")}>
            {message.draft.images.map((image) => (
              <AttachmentImage
                key={image.id}
                attachment={image.attachment}
                name={image.name}
                onReadAttachment={onReadAttachment}
                onOpen={onOpenImage}
              />
            ))}
          </div>
        )}
        {(draft.text.length > 0 ||
          draft.references.length > 0 ||
          draft.skills.length > 0) && (
          <div className="user-bubble">
            <div className="pending-send-content">
              <UserMessageContent
                parts={[
                  { text: draft.text, references: draft.references },
                  ...draft.skills.map((skill) => ({
                    text: skill.name,
                    references: [],
                  })),
                ]}
              />
            </div>
          </div>
        )}
        <p className="pending-send-status" role="status">
          {t(
            message.status === "sending"
              ? "pendingSendSending"
              : message.status === "admitted"
                ? "pendingSendAdmitted"
                : message.status === "notSent"
                  ? "pendingSendNotSent"
                  : "pendingSendUnconfirmed",
          )}
        </p>
        {(message.status === "unconfirmed" || message.status === "notSent") && (
          <div className="pending-send-recovery">
            <p>
              {t(
                message.status === "unconfirmed"
                  ? "pendingSendUnknownWarning"
                  : "pendingSendLocalWarning",
              )}
            </p>
            {message.error && (
              <details>
                <summary>{t("pendingSendErrorDetails")}</summary>
                <pre>{message.error}</pre>
              </details>
            )}
            {message.recovered ? (
              <>
                <p>{t("pendingSendRecovered")}</p>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => onDismiss?.(message.clientId)}
                >
                  {t("pendingSendDismiss")}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="quiet-button"
                onClick={() => onRecover?.(message.clientId)}
                disabled={onRecover === undefined}
              >
                {t("pendingSendRecover")}
              </button>
            )}
          </div>
        )}
        {(message.status === "unconfirmed" || message.status === "admitted") &&
          onCheck && (
            <PendingSendCheck
              key={message.status}
              status={message.status}
              onCheck={onCheck}
            />
          )}
      </article>
    );
  });
});

/** Disposable feedback owned by this exact input and its current admission state. */
function PendingSendCheck({
  status,
  onCheck,
}: {
  status: "unconfirmed" | "admitted";
  onCheck(): Promise<"checked" | "unavailable">;
}) {
  const { t } = useTranslation("shell");
  const [feedback, setFeedback] = useState<
    | { phase: "idle" | "checking" | "completed" | "unavailable" }
    | { phase: "failed"; error: string }
  >({ phase: "idle" });
  const request = useRef<object | null>(null);
  useEffect(
    () => () => {
      request.current = null;
    },
    [],
  );
  const check = async () => {
    // The ref also fences repeated activation before React commits disabled.
    if (request.current !== null) return;
    const token = {};
    request.current = token;
    setFeedback({ phase: "checking" });
    try {
      const result = await onCheck();
      if (request.current === token)
        setFeedback({
          phase: result === "checked" ? "completed" : "unavailable",
        });
    } catch (error) {
      if (request.current === token)
        setFeedback({ phase: "failed", error: String(error) });
    } finally {
      if (request.current === token) request.current = null;
    }
  };
  return (
    <>
      <button
        type="button"
        className="quiet-button"
        disabled={feedback.phase === "checking"}
        onClick={() => void check()}
      >
        {t("pendingSendCheck")}
      </button>
      {feedback.phase !== "idle" && (
        <p
          className="pending-send-check-feedback"
          data-check-state={feedback.phase}
          role={feedback.phase === "failed" ? "alert" : "status"}
          aria-atomic="true"
        >
          {t(
            feedback.phase === "checking"
              ? "pendingSendChecking"
              : feedback.phase === "unavailable"
                ? "pendingSendCheckUnavailable"
                : feedback.phase === "failed"
                  ? "pendingSendCheckFailed"
                  : status === "admitted"
                    ? "pendingSendCheckedAdmitted"
                    : "pendingSendCheckedUnconfirmed",
          )}
          {feedback.phase === "failed" && <> {feedback.error}</>}
        </p>
      )}
    </>
  );
}
