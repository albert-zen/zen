import { parseSkillDraft } from "./skill-draft.js";
import { referenceTitle } from "./reference-draft.js";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PendingSendPresentation } from "./composer-state.js";

export const PendingSendRows = memo(function PendingSendRows({
  messages,
  onRecover,
  onDismiss,
  onCheck,
}: {
  messages: readonly PendingSendPresentation[];
  onRecover?(clientId: string): void;
  onDismiss?(clientId: string): void;
  onCheck?(): Promise<void>;
}) {
  const { t } = useTranslation("shell");
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const check = async () => {
    if (checking || onCheck === undefined) return;
    setChecking(true);
    setCheckError(null);
    try { await onCheck(); }
    catch (error) { setCheckError(String(error)); }
    finally { setChecking(false); }
  };
  return messages.map((message) => {
    const draft = parseSkillDraft(message.draft.text);
    const displayText = [
      referenceTitle(draft.text, draft.references),
      ...draft.skills.map((skill) => skill.name),
    ].filter(Boolean).join("\n");
    return (
    <article
      className="user-row pending-send-row"
      key={message.clientId}
      data-pending-send-client-id={message.clientId}
      data-send-state={message.status}
    >
      <div className="user-bubble">
        {displayText && (
          <p className="pending-send-content">{displayText}</p>
        )}
        {message.draft.images.length > 0 && (
          <ul aria-label={t("attachedImages")}>
            {message.draft.images.map((image) => (
              <li key={image.id}>{image.name}</li>
            ))}
          </ul>
        )}
      </div>
      <p className="pending-send-status" role="status">
        {t(
          message.status === "sending" ? "pendingSendSending" :
          message.status === "admitted" ? "pendingSendAdmitted" :
          message.status === "notSent" ? "pendingSendNotSent" :
          "pendingSendUnconfirmed",
        )}
      </p>
      {(message.status === "unconfirmed" || message.status === "notSent") && (
        <div className="pending-send-recovery">
          <p>{t(message.status === "unconfirmed" ? "pendingSendUnknownWarning" : "pendingSendLocalWarning")}</p>
          {message.error && <details><summary>{t("pendingSendErrorDetails")}</summary><pre>{message.error}</pre></details>}
          {message.recovered ? (
            <>
              <p>{t("pendingSendRecovered")}</p>
              <button type="button" className="quiet-button" onClick={() => onDismiss?.(message.clientId)}>{t("pendingSendDismiss")}</button>
            </>
          ) : (
            <button type="button" className="quiet-button" onClick={() => onRecover?.(message.clientId)} disabled={onRecover === undefined}>{t("pendingSendRecover")}</button>
          )}
        </div>
      )}
      {(message.status === "unconfirmed" || message.status === "admitted") && onCheck && (
        <button type="button" className="quiet-button" disabled={checking} onClick={() => void check()}>{t("pendingSendCheck")}</button>
      )}
      {checkError && <p role="alert">{checkError}</p>}
    </article>
    );
  });
});
