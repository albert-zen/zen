import { useContext, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Reference } from "./composer-selector.js";
import { Icon } from "./icons.js";
import { MessageLinkContext } from "./Markdown.js";
import {
  MessageSourceLink,
  MessageSourceViewportContext,
} from "./message-source-navigation.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/controls.js";

/** One presentation for pointer identities and explicit excerpt snapshots. */
export function ReferenceToken({
  reference,
  onRemove,
  removeDisabled = false,
  onSource,
}: {
  reference: Reference;
  onRemove?(): void;
  removeDisabled?: boolean;
  onSource?(): boolean;
}) {
  const { t } = useTranslation("shell");
  const openLink = useContext(MessageLinkContext);
  const ownerThreadId = useContext(MessageSourceViewportContext);
  const [open, setOpen] = useState(false);
  const [sourceUnavailable, setSourceUnavailable] = useState(false);
  const heading = useId();
  const identity = JSON.stringify(reference);
  useEffect(() => {
    setOpen(false);
    setSourceUnavailable(false);
  }, [identity]);
  const label =
    reference.kind === "message" ? reference.excerpt : reference.name;
  const icon =
    reference.kind === "message"
      ? "quote"
      : reference.kind === "thread"
        ? "thread"
        : "file";
  const location =
    reference.kind === "file"
      ? `${reference.cwd.replace(/[\\/]+$/u, "")}/${reference.path}`
      : reference.kind === "thread"
        ? reference.id
        : `${reference.threadId} / ${reference.id}`;
  function source() {
    try {
      if (onSource?.()) {
        setOpen(false);
        return;
      }
      if (reference.kind === "file" && openLink) {
        openLink({ kind: "file", value: location });
        setOpen(false);
        return;
      }
      setSourceUnavailable(true);
    } catch {
      setSourceUnavailable(true);
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span className="reference-token-wrap">
        <span
          className="reference-token"
          data-reference-kind={reference.kind}
          data-message-quote-ignore=""
          role="group"
          aria-label={t("referenceDetails")}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className="reference-token-details"
              aria-label={t("referenceDetailsNamed", { name: label })}
              title={label}
            >
              <Icon name={icon} size={13} />
              <span>{label}</span>
            </button>
          </PopoverTrigger>
          {onRemove && (
            <button
              type="button"
              className="reference-token-remove"
              aria-label={t("removeReference", { name: reference.name })}
              disabled={removeDisabled}
              onClick={onRemove}
            >
              <Icon name="x" size={10} />
            </button>
          )}
        </span>
      </span>
      <PopoverContent
        className="reference-details-popover"
        aria-labelledby={heading}
      >
        <header>
          <strong id={heading}>{t("referenceDetails")}</strong>
          <button
            type="button"
            aria-label={t("closeReferenceDetails")}
            onClick={() => setOpen(false)}
          >
            <Icon name="x" size={14} />
          </button>
        </header>
        <p className="reference-content-policy">
          {t(
            reference.kind === "message"
              ? "referenceExcerptIncluded"
              : "referencePointerOnly",
          )}
        </p>
        {reference.kind === "message" && (
          <pre className="reference-exact-excerpt">{reference.excerpt}</pre>
        )}
        <dl>
          <dt>{t("referenceName")}</dt>
          <dd>{reference.name}</dd>
          <dt>{t("referenceSource")}</dt>
          <dd>{location}</dd>
          {reference.cwd && (
            <>
              <dt>{t("referenceWorkspace")}</dt>
              <dd>{reference.cwd}</dd>
            </>
          )}
        </dl>
        {reference.kind === "thread" ||
        (reference.kind === "message" &&
          ownerThreadId !== null &&
          ownerThreadId !== reference.threadId) ? (
          <MessageSourceLink
            className="reference-open-source"
            target={
              reference.kind === "message"
                ? {
                    kind: "thread",
                    id: reference.threadId,
                    itemId: reference.id,
                  }
                : { kind: "thread", id: reference.id }
            }
            label={t("openReferenceSource")}
          />
        ) : (
          <button
            type="button"
            className="reference-open-source"
            onClick={source}
          >
            {t("openReferenceSource")}
          </button>
        )}
        {sourceUnavailable && (
          <p role="status" className="reference-source-error">
            {t("referenceSourceUnavailable")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
