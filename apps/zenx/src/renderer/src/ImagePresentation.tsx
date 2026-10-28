import { localErrorDetail } from "../../local-error-detail.js";
import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AttachmentRef } from "../../../../../src/attachment.js";
import type { ZenXThreadAttachmentProjection } from "../../main/image-attachments.js";
import { Icon } from "./icons.js";

export const ThreadImagesContext = createContext<{
  cwd?: string;
  attachments: ZenXThreadAttachmentProjection;
  read(attachment: AttachmentRef): Promise<Uint8Array>;
  open(
    attachment: AttachmentRef,
    name: string,
    trigger: HTMLButtonElement,
  ): void;
} | null>(null);

export function ToolImages({ itemId }: { itemId: string }) {
  useTranslation("panels");
  const context = useContext(ThreadImagesContext);
  const attachments = context?.attachments[itemId] ?? [];
  if (context === null || attachments.length === 0) return null;
  return (
    <div className="message-images" aria-label={i18n.t("panels:toolImages")}>
      {attachments.map((attachment, index) => (
        <AttachmentImage
          key={`${attachment.sha256}-${index}`}
          attachment={attachment}
          name={i18n.t("panels:toolImageNumber", { count: index + 1 })}
          onReadAttachment={context.read}
          onOpen={context.open}
        />
      ))}
    </div>
  );
}

export function AttachmentImage({
  attachment,
  name,
  onOpen,
  onReadAttachment,
  lazy = false,
  retryOnError = false,
  compact = false,
}: {
  attachment: AttachmentRef;
  name: string;
  onOpen(
    attachment: AttachmentRef,
    name: string,
    trigger: HTMLButtonElement,
  ): void;
  onReadAttachment(attachment: AttachmentRef): Promise<Uint8Array>;
  /** Defer payload access until this thumbnail is in the visible scroll area. */
  lazy?: boolean;
  retryOnError?: boolean;
  compact?: boolean;
}) {
  useTranslation("panels");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(!lazy);
  useEffect(() => {
    if (!lazy || visible) return;
    const element = buttonRef.current;
    if (element === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [lazy, visible]);
  const { url, error, detail, retry, invalidate } = useAttachmentUrl(
    attachment,
    onReadAttachment,
    !lazy || visible,
  );
  const retryable = retryOnError && error !== null;
  return (
    <>
      <button
        ref={buttonRef}
        className="image-thumbnail"
        type="button"
        aria-label={i18n.t(
          retryable ? "panels:retryImage" : "panels:previewImage",
          { name },
        )}
        aria-busy={visible && url === null && error === null}
        disabled={url === null && !retryable}
        title={
          url === null
            ? i18n.t(error ? "panels:imageUnavailable" : "panels:loadingImage")
            : name
        }
        onClick={(event) =>
          retryable ? retry() : onOpen(attachment, name, event.currentTarget)
        }
      >
        {url === null ? (
          <span
            className="image-placeholder"
            role={error ? "alert" : undefined}
            aria-label={
              compact
                ? `${name}: ${i18n.t(error ? "panels:imageUnavailable" : "panels:loadingImage")}`
                : undefined
            }
          >
            {compact ? (
              <>
                <Icon name={error ? "warning" : "image"} size={15} />
                {retryable ? <span>{i18n.t("panels:retry")}</span> : null}
              </>
            ) : error ? (
              `${i18n.t("panels:imageUnavailable")}${retryable ? ` · ${i18n.t("panels:retry")}` : ""}`
            ) : (
              i18n.t("panels:loadingImage")
            )}
          </span>
        ) : (
          <img
            alt={name}
            src={url}
            loading={lazy ? "lazy" : undefined}
            onError={invalidate}
          />
        )}
      </button>
      {error && detail ? (
        <details className="image-error-detail">
          <summary>{i18n.t("shell:technicalDetails")}</summary>
          <pre tabIndex={0}>{detail}</pre>
        </details>
      ) : null}
    </>
  );
}

export function ImagePreview({
  attachment,
  name,
  onClose,
  onReadAttachment,
  trigger,
  restoreFocus,
  portalContainer,
}: {
  attachment: AttachmentRef;
  name: string;
  onClose(): void;
  onReadAttachment(attachment: AttachmentRef): Promise<Uint8Array>;
  trigger: HTMLButtonElement;
  restoreFocus?(): void;
  portalContainer?: HTMLElement;
}) {
  useTranslation("panels");
  const { url, error, detail, invalidate } = useAttachmentUrl(
    attachment,
    onReadAttachment,
  );
  return (
    <ImageUrlPreview
      url={url}
      error={error !== null ? i18n.t("panels:imageUnavailable") : null}
      errorDetail={detail}
      name={name}
      onClose={onClose}
      trigger={trigger}
      restoreFocus={restoreFocus}
      onImageError={invalidate}
      portalContainer={portalContainer}
    />
  );
}

export function ImageUrlPreview({
  url,
  error,
  errorDetail,
  name,
  onClose,
  trigger,
  restoreFocus,
  onImageError,
  portalContainer,
}: {
  url: string | null;
  error: string | null;
  errorDetail?: string | null;
  name: string;
  onClose(): void;
  trigger: HTMLElement;
  restoreFocus?(): void;
  onImageError?(): void;
  portalContainer?: HTMLElement;
}) {
  useTranslation("panels");
  const closeRef = useRef<HTMLButtonElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onClose, restoreFocus });
  callbacks.current = { onClose, restoreFocus };
  useEffect(() => {
    closeRef.current?.focus();
    const layer = layerRef.current;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        callbacks.current.onClose();
      } else if (event.key === "Tab") {
        event.preventDefault();
        const controls = [
          ...(layerRef.current?.querySelectorAll<HTMLElement>(
            "button, summary, [tabindex='0']",
          ) ?? []),
        ];
        const available = controls.filter((control) => {
          const details = control.closest("details");
          return !details || details.open || control.tagName === "SUMMARY";
        });
        const current = available.indexOf(
          document.activeElement as HTMLElement,
        );
        available[
          (current + (event.shiftKey ? -1 : 1) + available.length) %
            available.length
        ]?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      const active = document.activeElement;
      if (active !== document.body && !layer?.contains(active)) return;
      if (callbacks.current.restoreFocus) callbacks.current.restoreFocus();
      else if (trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [trigger]);
  return createPortal(
    <div
      ref={layerRef}
      className="image-preview-layer"
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        ref={closeRef}
        className="icon-button image-preview-close"
        type="button"
        aria-label={i18n.t("panels:closeImagePreview")}
        onClick={onClose}
      >
        <Icon name="x" />
      </button>
      <div className="image-preview-content">
        {url === null ? (
          <p role={error ? "alert" : "status"}>
            {error ?? i18n.t("panels:loadingImage2")}
          </p>
        ) : (
          <img alt={name} src={url} onError={onImageError} />
        )}
        {error && errorDetail ? (
          <details className="image-error-detail">
            <summary>{i18n.t("shell:technicalDetails")}</summary>
            <pre tabIndex={0}>{errorDetail}</pre>
          </details>
        ) : null}
      </div>
    </div>,
    portalContainer ?? document.body,
  );
}

// Keep a small LRU of URLs after their last consumer unmounts so streaming
// re-renders and disclosure remounts do not flash. Mounted URLs are never
// evicted; at most this many inactive URLs remain retained for later reuse.
const retainedAttachmentUrlLimit = 32;
const attachmentUrlCache = new Map<
  string,
  { url: string; consumers: number }
>();

function touchAttachmentUrl(
  cacheKey: string,
  entry: { url: string; consumers: number },
): void {
  attachmentUrlCache.delete(cacheKey);
  attachmentUrlCache.set(cacheKey, entry);
}

function trimAttachmentUrls(): void {
  while (attachmentUrlCache.size > retainedAttachmentUrlLimit) {
    const inactive = [...attachmentUrlCache].find(
      ([, entry]) => entry.consumers === 0,
    );
    if (inactive === undefined) return;
    const [cacheKey, entry] = inactive;
    attachmentUrlCache.delete(cacheKey);
    URL.revokeObjectURL(entry.url);
  }
}

function releaseAttachmentUrl(
  cacheKey: string,
  entry: { url: string; consumers: number },
): void {
  if (attachmentUrlCache.get(cacheKey) !== entry) return;
  entry.consumers = Math.max(0, entry.consumers - 1);
  trimAttachmentUrls();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    for (const entry of attachmentUrlCache.values())
      URL.revokeObjectURL(entry.url);
    attachmentUrlCache.clear();
  });
}

function useAttachmentUrl(
  attachment: AttachmentRef,
  read: (attachment: AttachmentRef) => Promise<Uint8Array>,
  enabled = true,
): {
  url: string | null;
  error: string | null;
  detail?: string;
  retry(): void;
  invalidate(): void;
} {
  const [attempt, setAttempt] = useState(0);
  const cacheKey = `${attachment.mediaType}:${attachment.sha256}`;
  const [state, setState] = useState<{
    url: string | null;
    error: string | null;
    detail?: string;
  }>(() => ({
    url: attachmentUrlCache.get(cacheKey)?.url ?? null,
    error: null,
  }));
  useEffect(() => {
    if (!enabled) return;
    const cached = attachmentUrlCache.get(cacheKey);
    if (cached !== undefined) {
      cached.consumers += 1;
      touchAttachmentUrl(cacheKey, cached);
      setState((current) =>
        current.url === cached.url && current.error === null
          ? current
          : { url: cached.url, error: null },
      );
      return () => releaseAttachmentUrl(cacheKey, cached);
    }
    let active = true;
    let acquired: { url: string; consumers: number } | null = null;
    setState({ url: null, error: null });
    void read(attachment)
      .then((bytes) => {
        const objectUrl = URL.createObjectURL(
          new Blob([bytes.slice().buffer], { type: attachment.mediaType }),
        );
        const raced = attachmentUrlCache.get(cacheKey);
        const entry = raced ?? { url: objectUrl, consumers: 0 };
        if (raced === undefined) attachmentUrlCache.set(cacheKey, entry);
        else URL.revokeObjectURL(objectUrl);
        if (active) {
          entry.consumers += 1;
          acquired = entry;
          touchAttachmentUrl(cacheKey, entry);
          setState({ url: entry.url, error: null });
        }
        trimAttachmentUrls();
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            url: null,
            error: error instanceof Error ? error.message : String(error),
            detail: localErrorDetail(error),
          });
      });
    return () => {
      active = false;
      if (acquired !== null) releaseAttachmentUrl(cacheKey, acquired);
    };
  }, [cacheKey, attachment, read, enabled, attempt]);
  return {
    ...(enabled ? state : { url: null, error: null }),
    retry: () => setAttempt((value) => value + 1),
    invalidate: () => {
      const cached = attachmentUrlCache.get(cacheKey);
      if (cached !== undefined) {
        attachmentUrlCache.delete(cacheKey);
        URL.revokeObjectURL(cached.url);
      }
      setState({ url: null, error: i18n.t("panels:imageUnavailable") });
    },
  };
}
