import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import type { ThreadSnapshot } from "../../../../src/app-server.js";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  type AttachmentRef,
  type AttachmentStore,
} from "../../../../src/attachment.js";
import { contentFromUserMessage } from "../../../../src/item.js";

export interface ZenXImageDraft {
  id: string;
  name: string;
  attachment: AttachmentRef;
}

export interface ZenXImageImport {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

export type ZenXThreadAttachmentProjection = Record<
  string,
  readonly AttachmentRef[]
>;

export function imageDraft(
  filename: string,
  attachment: AttachmentRef,
): ZenXImageDraft {
  return { id: randomUUID(), name: basename(filename), attachment };
}

export async function importLocalImageDrafts(
  store: Pick<AttachmentStore, "importLocalImage">,
  filenames: readonly string[],
): Promise<ZenXImageDraft[]> {
  return await Promise.all(
    filenames.map(async (filename) =>
      imageDraft(filename, await store.importLocalImage(filename)),
    ),
  );
}

export async function importImageDrafts(
  store: Pick<AttachmentStore, "importBytes">,
  images: readonly ZenXImageImport[],
): Promise<ZenXImageDraft[]> {
  return await Promise.all(
    images.map(async (image) =>
      imageDraft(
        image.name,
        await store.importBytes(image.bytes, image.mediaType),
      ),
    ),
  );
}

export function projectThreadAttachments(
  snapshot: ThreadSnapshot,
): ZenXThreadAttachmentProjection {
  return Object.fromEntries(
    snapshot.items.flatMap((item) => {
      if (item.type !== "user_message") return [];
      const attachments = contentFromUserMessage(item).flatMap((part) =>
        part.type === "image" ? [part.attachment] : [],
      );
      return attachments.length === 0 ? [] : [[item.id, attachments] as const];
    }),
  );
}

export async function readAttachmentPayload(
  store: Pick<AttachmentStore, "read">,
  value: unknown,
): Promise<Uint8Array> {
  if (!isAttachmentRef(value)) throw new Error("Invalid image attachment");
  return await store.read(value);
}

export function isAttachmentRef(value: unknown): value is AttachmentRef {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const ref = value as Partial<AttachmentRef>;
  return (
    ref.type === "attachment" &&
    typeof ref.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(ref.sha256) &&
    ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
      ref.mediaType ?? "",
    ) &&
    Number.isSafeInteger(ref.byteLength) &&
    Number.isSafeInteger(ref.width) &&
    Number.isSafeInteger(ref.height) &&
    (ref.byteLength ?? 0) > 0 &&
    (ref.byteLength ?? 0) <= MAX_IMAGE_BYTES &&
    (ref.width ?? 0) > 0 &&
    (ref.width ?? 0) <= MAX_IMAGE_DIMENSION &&
    (ref.height ?? 0) > 0 &&
    (ref.height ?? 0) <= MAX_IMAGE_DIMENSION &&
    (ref.width ?? 0) * (ref.height ?? 0) <= MAX_IMAGE_PIXELS
  );
}
