export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 16_384;
export const MAX_IMAGE_PIXELS = 40_000_000;

export type ImageMediaType =
  "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageAttachmentRef {
  type: "attachment";
  sha256: string;
  mediaType: ImageMediaType;
  byteLength: number;
  width: number;
  height: number;
}

export type AudioMediaType = "audio/wav" | "audio/mpeg";
export interface AudioAttachmentRef {
  type: "attachment";
  sha256: string;
  mediaType: AudioMediaType;
  byteLength: number;
  width?: never;
  height?: never;
}

export type AttachmentRef = ImageAttachmentRef | AudioAttachmentRef;
