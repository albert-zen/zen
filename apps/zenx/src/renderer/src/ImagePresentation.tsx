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
  const context = useContext(ThreadImagesContext);
  const attachments = context?.attachments[itemId] ?? [];
  if (context === null || attachments.length === 0) return null;
  return (
    <div className="message-images" aria-label="Tool images">
      {attachments.map((attachment, index) => (
        <AttachmentImage
          key={`${attachment.sha256}-${index}`}
          attachment={attachment}
          name={`Tool image ${index + 1}`}
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
}: {
  attachment: AttachmentRef;
  name: string;
  onOpen(
    attachment: AttachmentRef,
    name: string,
    trigger: HTMLButtonElement,
  ): void;
  onReadAttachment(attachment: AttachmentRef): Promise<Uint8Array>;
}) {
  const { url, error } = useAttachmentUrl(attachment, onReadAttachment);
  return (
    <button
      className="image-thumbnail"
      type="button"
      aria-label={`Preview ${name}`}
      disabled={url === null}
      onClick={(event) => onOpen(attachment, name, event.currentTarget)}
    >
      {url === null ? (
        <span className="image-placeholder" role={error ? "alert" : undefined}>
          {error ? "Image unavailable" : "Loading image"}
        </span>
      ) : (
        <img alt={name} src={url} />
      )}
    </button>
  );
}

export function ImagePreview({
  attachment,
  name,
  onClose,
  onReadAttachment,
  trigger,
}: {
  attachment: AttachmentRef;
  name: string;
  onClose(): void;
  onReadAttachment(attachment: AttachmentRef): Promise<Uint8Array>;
  trigger: HTMLButtonElement;
}) {
  const { url, error } = useAttachmentUrl(attachment, onReadAttachment);
  return (
    <ImageUrlPreview
      url={url}
      error={error}
      name={name}
      onClose={onClose}
      trigger={trigger}
    />
  );
}

export function ImageUrlPreview({
  url,
  error,
  name,
  onClose,
  trigger,
}: {
  url: string | null;
  error: string | null;
  name: string;
  onClose(): void;
  trigger: HTMLElement;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      trigger.focus();
    };
  }, [onClose, trigger]);
  return createPortal(
    <div
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
        aria-label="Close image preview"
        onClick={onClose}
      >
        <Icon name="x" />
      </button>
      <div className="image-preview-content">
        {url === null ? (
          <p role={error ? "alert" : "status"}>{error ?? "Loading image…"}</p>
        ) : (
          <img alt={name} src={url} />
        )}
      </div>
    </div>,
    document.body,
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
): { url: string | null; error: string | null } {
  const cacheKey = `${attachment.mediaType}:${attachment.sha256}`;
  const [state, setState] = useState<{
    url: string | null;
    error: string | null;
  }>(() => ({
    url: attachmentUrlCache.get(cacheKey)?.url ?? null,
    error: null,
  }));
  useEffect(() => {
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
          });
      });
    return () => {
      active = false;
      if (acquired !== null) releaseAttachmentUrl(cacheKey, acquired);
    };
  }, [cacheKey, attachment, read]);
  return state;
}
