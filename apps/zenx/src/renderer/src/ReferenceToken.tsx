import { useContext, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Reference } from "./composer-selector.js";
import { Icon } from "./icons.js";
import { MessageLinkContext } from "./Markdown.js";
import {
  MessageSourceLink,
  MessageSourceNavigationContext,
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
  onSource?(afterClose?: Promise<void>): boolean;
}) {
  const { t } = useTranslation("shell");
  const openLink = useContext(MessageLinkContext);
  const ownerThreadId = useContext(MessageSourceViewportContext);
  const navigateSource = useContext(MessageSourceNavigationContext);
  const [open, setOpen] = useState(false);
  const [popupInstance, setPopupInstance] = useState(0);
  const [sourceUnavailable, setSourceUnavailable] = useState(false);
  const sourceFocusTransferred = useRef(false);
  const sourceClose = useRef<{
    identity: string;
    popupInstance: number;
    accepted: boolean;
    resolve(): void;
    retire(): void;
  } | null>(null);
  const heading = useId();
  const identity = JSON.stringify(reference);
  useEffect(() => {
    if (sourceClose.current && sourceClose.current.identity !== identity) {
      sourceClose.current.retire();
      sourceClose.current = null;
    }
    setOpen(false);
    setSourceUnavailable(false);
  }, [identity]);
  const isExcerpt = reference.kind === "message" || reference.kind === "text";
  const sources =
    reference.kind === "message"
      ? [{ threadId: reference.threadId, id: reference.id }]
      : reference.kind === "text"
        ? reference.sources
        : [];
  const label = isExcerpt ? reference.excerpt : reference.name;
  const icon = isExcerpt
    ? "quote"
    : reference.kind === "thread"
      ? "thread"
      : "file";
  const location =
    reference.kind === "file"
      ? `${reference.cwd.replace(/[\\/]+$/u, "")}/${reference.path}`
      : reference.kind === "thread"
        ? reference.id
        : sources
            .map((source) => `${source.threadId} / ${source.id}`)
            .join("\n");
  function source() {
    try {
      sourceClose.current?.retire();
      sourceClose.current = null;
      let resolveClose = () => {};
      let retireClose = () => {};
      const afterClose =
        reference.kind === "message"
          ? new Promise<void>((resolve, reject) => {
              resolveClose = resolve;
              retireClose = () => reject();
            })
          : undefined;
      void afterClose?.catch(() => {});
      const ticket = afterClose
        ? {
            identity,
            popupInstance,
            accepted: false,
            resolve: resolveClose,
            retire: retireClose,
          }
        : null;
      sourceClose.current = ticket;
      if (onSource?.(afterClose)) {
        if (ticket) ticket.accepted = true;
        // The current ThreadView now owns bounded reveal/position/focus. The
        // closing popup must not create a competing focus-return intent.
        sourceFocusTransferred.current = reference.kind === "message";
        setOpen(false);
        return;
      }
      ticket?.retire();
      if (sourceClose.current === ticket) sourceClose.current = null;
      if (reference.kind === "file" && openLink) {
        openLink({ kind: "file", value: location });
        setOpen(false);
        return;
      }
      setSourceUnavailable(true);
    } catch {
      sourceClose.current?.retire();
      sourceClose.current = null;
      setSourceUnavailable(true);
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          sourceClose.current?.retire();
          sourceClose.current = null;
          sourceFocusTransferred.current = false;
          setPopupInstance((value) => value + 1);
        }
        setOpen(next);
      }}
    >
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
              aria-label={t("removeReference", {
                name: reference.name || label,
              })}
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
        onCloseAutoFocus={(event) => {
          if (sourceFocusTransferred.current) event.preventDefault();
          sourceFocusTransferred.current = false;
          const ticket = sourceClose.current;
          if (
            ticket?.accepted &&
            ticket.popupInstance === popupInstance &&
            ticket.identity === identity
          ) {
            sourceClose.current = null;
            ticket.resolve();
          }
        }}
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
          {t(isExcerpt ? "referenceExcerptIncluded" : "referencePointerOnly")}
        </p>
        {isExcerpt && (
          <pre className="reference-exact-excerpt">{reference.excerpt}</pre>
        )}
        <dl>
          {reference.name && (
            <>
              <dt>{t("referenceName")}</dt>
              <dd>{reference.name}</dd>
            </>
          )}
          {location && (
            <>
              <dt>{t("referenceSource")}</dt>
              <dd>{location}</dd>
            </>
          )}
          {reference.cwd && (
            <>
              <dt>{t("referenceWorkspace")}</dt>
              <dd>{reference.cwd}</dd>
            </>
          )}
        </dl>
        {reference.kind === "text" ? (
          sources.map((entry) => (
            <MessageSourceLink
              key={`${entry.threadId}/${entry.id}`}
              className="reference-open-source"
              target={{ kind: "thread", id: entry.threadId, itemId: entry.id }}
              label={t("openReferenceSource")}
            />
          ))
        ) : reference.kind === "thread" ||
          (reference.kind === "message" &&
            navigateSource !== null &&
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
