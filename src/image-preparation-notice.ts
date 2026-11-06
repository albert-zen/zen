import type { AttachmentRef } from "./attachment-ref.js";

export type ImageUnavailableReason =
  "image_decode_failed" | "image_processing_failed";

/** Canonical safe original receipt. Never serialize caller-provided extra fields. */
export function imageOriginalReceipt(original: AttachmentRef): AttachmentRef {
  return {
    type: original.type,
    sha256: original.sha256,
    mediaType: original.mediaType,
    byteLength: original.byteLength,
    ...(original.width === undefined
      ? {}
      : { width: original.width, height: original.height }),
  } as AttachmentRef;
}

/** Shared by the writer and strict decoder, without a codec/runtime dependency. */
export function imageUnavailableNotice(
  reason: ImageUnavailableReason,
  original: AttachmentRef,
): string {
  return `[Image input unavailable (${reason}). No image pixels from this occurrence were sent in this sample. The original attachment is unchanged and remains referenced: ${JSON.stringify(imageOriginalReceipt(original))}.]`;
}
