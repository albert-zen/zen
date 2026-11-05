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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverAnchor,
} from "./ui/controls.js";

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
  const navigateSource = useContext(MessageSourceNavigationContext);
  const [open, setOpen] = useState(false);
  const [sourceUnavailable, setSourceUnavailable] = useState(false);
  const heading = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const cancelHover = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const show = () => {
    cancelHover();
    setOpen(true);
  };
  const hideLater = () => {
    cancelHover();
    timer.current = setTimeout(() => setOpen(false), 180);
  };
  useEffect(
    () => () => {
      cancelHover();
      generation.current++;
    },
    [],
  );
  const identity = JSON.stringify([ownerThreadId, reference]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const dismiss = () => {
    cancelHover();
    generation.current++;
    inFlight.current = false;
    setOpen(false);
  };
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
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
  async function source(selectedSource?: { threadId: string; id: string }) {
    if (inFlight.current) return;
    cancelHover();
    const version = generation.current;
    const isCurrent = () =>
      generation.current === version &&
      currentIdentity.current === identity &&
      trigger.current?.isConnected === true &&
      trigger.current.closest("[hidden], [aria-hidden='true'], [inert]") ===
        null;
    setSourceUnavailable(false);
    try {
      if (!selectedSource && onSource?.()) {
        setOpen(false);
        return;
      }
      if (isExcerpt && sources.length && navigateSource && ownerThreadId) {
        inFlight.current = true;
        const entry = selectedSource ?? sources[0]!;
        await navigateSource(
          {
            kind: "thread",
            id: entry.threadId,
            itemId: entry.id,
            excerpt: reference.excerpt,
          },
          { threadId: ownerThreadId, isCurrent },
        );
        if (isCurrent()) setOpen(false);
        return;
      }
      if (reference.kind === "file" && openLink) {
        openLink({ kind: "file", value: location });
        setOpen(false);
        return;
      }
      setOpen(true);
      setSourceUnavailable(true);
    } catch {
      if (isCurrent()) {
        setOpen(true);
        setSourceUnavailable(true);
      }
    } finally {
      if (isCurrent()) inFlight.current = false;
    }
  }
  const Trigger = isExcerpt ? PopoverAnchor : PopoverTrigger;
  return (
    <Popover open={open} onOpenChange={(next) => (next ? show() : dismiss())}>
      <span className="reference-token-wrap">
        <span
          className="reference-token"
          data-reference-kind={reference.kind}
          data-message-quote-ignore=""
          role="group"
          aria-label={t("referenceDetails")}
        >
          <Trigger asChild>
            <button
              ref={trigger}
              type="button"
              className="reference-token-details"
              onPointerEnter={
                isExcerpt
                  ? (event) => {
                      if (event.pointerType !== "touch") show();
                    }
                  : undefined
              }
              onPointerLeave={isExcerpt ? hideLater : undefined}
              onFocus={isExcerpt ? show : undefined}
              onBlur={isExcerpt ? hideLater : undefined}
              onClick={isExcerpt ? () => void source() : undefined}
              aria-expanded={open}
              aria-controls={open ? heading + "-content" : undefined}
              aria-label={t("referenceDetailsNamed", { name: label })}
              title={label}
            >
              <Icon name={icon} size={13} />
              <span>{label}</span>
            </button>
          </Trigger>
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
        id={heading + "-content"}
        onPointerEnter={isExcerpt ? cancelHover : undefined}
        onPointerLeave={isExcerpt ? hideLater : undefined}
        onFocusCapture={isExcerpt ? cancelHover : undefined}
        onOpenAutoFocus={
          isExcerpt ? (event) => event.preventDefault() : undefined
        }
        onCloseAutoFocus={
          isExcerpt ? (event) => event.preventDefault() : undefined
        }
      >
        <header>
          <strong id={heading}>{t("referenceDetails")}</strong>
          <button
            type="button"
            aria-label={t("closeReferenceDetails")}
            onClick={dismiss}
          >
            <Icon name="x" size={14} />
          </button>
        </header>
        {!isExcerpt && (
          <p className="reference-content-policy">
            {t("referencePointerOnly")}
          </p>
        )}
        {isExcerpt && (
          <pre className="reference-exact-excerpt">{reference.excerpt}</pre>
        )}
        {(!isExcerpt || reference.name) && (
          <dl>
            {reference.name && (
              <>
                <dt>{t("referenceName")}</dt>
                <dd>{reference.name}</dd>
              </>
            )}
            {!isExcerpt && location && (
              <>
                <dt>{t("referenceSource")}</dt>
                <dd>{location}</dd>
              </>
            )}
            {!isExcerpt && reference.cwd && (
              <>
                <dt>{t("referenceWorkspace")}</dt>
                <dd>{reference.cwd}</dd>
              </>
            )}
          </dl>
        )}
        {isExcerpt ? (
          <button
            type="button"
            className="reference-open-source"
            onClick={() => void source()}
          >
            {t("openReferenceSource")}
          </button>
        ) : reference.kind === "thread" ? (
          <MessageSourceLink
            className="reference-open-source"
            target={{ kind: "thread", id: reference.id }}
            label={t("openReferenceSource")}
          />
        ) : (
          <button
            type="button"
            className="reference-open-source"
            onClick={() => void source()}
          >
            {t("openReferenceSource")}
          </button>
        )}
        {isExcerpt &&
          sources.slice(1).map((entry, index) => (
            <button
              key={`${entry.threadId}/${entry.id}`}
              type="button"
              className="reference-open-source"
              onClick={() => void source(entry)}
            >
              {t("openReferenceSource")} {index + 2}
            </button>
          ))}
        {sourceUnavailable && (
          <p role="status" className="reference-source-error">
            {t("referenceSourceUnavailable")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
