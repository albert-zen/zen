import type { AttachmentRef } from "../../../../../src/attachment-ref.js";
import { pendingQueuedMessages } from "../../../../../src/input-queue.js";
import type { Thread } from "../../protocol-client/index.js";

/** Read-only native references for exactly the currently displayed pending inputs. */
export function projectQueuedImages(
  thread: Pick<Thread, "canonicalItems" | "queuedMessages"> | null,
): Record<string, readonly AttachmentRef[]> {
  if (thread?.canonicalItems === undefined) return {};
  const displayed = new Map(
    (thread.queuedMessages ?? []).map((item) => [item.id, item.clientId]),
  );
  return Object.fromEntries(
    pendingQueuedMessages(thread.canonicalItems).flatMap((item) => {
      if (displayed.get(item.id) !== item.clientId) return [];
      const images = item.input.flatMap((part) =>
        part.type === "image" ? [part.attachment] : [],
      );
      return images.length === 0 ? [] : [[item.id, images]];
    }),
  );
}

export function sameImageAttachment(
  a: AttachmentRef,
  b: AttachmentRef,
): boolean {
  return (
    a.type === b.type &&
    a.sha256 === b.sha256 &&
    a.mediaType === b.mediaType &&
    a.byteLength === b.byteLength &&
    a.width === b.width &&
    a.height === b.height
  );
}
