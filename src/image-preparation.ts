import { preserveImageExif } from "./image-metadata.js";
import sharp from "sharp";
import {
  AttachmentStoreError,
  type AttachmentRef,
  type AttachmentStore,
  MAX_IMAGE_PIXELS,
} from "./attachment.js";
import {
  type JsonValue,
  type RecoveryMediaOccurrence,
  type UserInputPart,
} from "./item.js";
import { compileItemList, type ContextItem } from "./item-list.js";
import type { ImageInputTokenEstimate } from "./model-usage.js";
import { modelMediaOrigin } from "./model-media-origin.js";

/** Versioned Zen input profile, following Codex f05aa41's per-image HIGH limits. */
export const IMAGE_PREPARATION_PROFILE = "codex-high-v1";

export class ImagePreparationError extends Error {
  readonly modelRecoveryBlocked = true;
  readonly retryable = false;
  constructor(cause: unknown) {
    super(
      `Image input preparation failed before model dispatch (${cause instanceof AttachmentStoreError ? cause.code : "preparation_error"}).`,
      { cause },
    );
    this.name = "ImagePreparationError";
  }
}

export function preparedImageDimensions(
  width: number,
  height: number,
  detail: "high" | "original" = "high",
): [number, number] {
  const edge = detail === "original" ? 6000 : 2048;
  const patches = detail === "original" ? 10000 : 2500;
  const fits = (w: number, h: number) =>
    Math.max(w, h) <= edge && Math.ceil(w / 32) * Math.ceil(h / 32) <= patches;
  if (fits(width, height)) return [width, height];
  const edgeScale = Math.min(1, edge / Math.max(width, height));
  width = Math.max(1, Math.round(width * edgeScale));
  height = Math.max(1, Math.round(height * edgeScale));
  if (fits(width, height)) return [width, height];
  let scale = Math.sqrt((32 * 32 * patches) / width / height);
  const patchesWide = (width * scale) / 32;
  const patchesHigh = (height * scale) / 32;
  scale *= Math.min(
    Math.floor(patchesWide) / patchesWide,
    Math.floor(patchesHigh) / patchesHigh,
  );
  return [
    Math.max(1, Math.floor(width * scale)),
    Math.max(1, Math.floor(height * scale)),
  ];
}

export type ImageUnavailableReason =
  "image_decode_failed" | "image_processing_failed";

/** Only errors from an in-memory codec operation receive this safe category. */
class ImageCodecFailure extends Error {
  constructor(
    readonly reason: ImageUnavailableReason,
    cause: unknown,
  ) {
    super(reason, { cause });
    this.name = "ImageCodecFailure";
  }
}
async function imageCodec<T>(
  reason: ImageUnavailableReason,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new ImageCodecFailure(reason, cause);
  }
}

/** No file/network access here: only immutable, already-admitted attachments. */
export async function prepareImageAttachment(
  original: AttachmentRef,
  attachments: Pick<AttachmentStore, "read" | "importBytes">,
  detail: "high" | "original" = "high",
): Promise<AttachmentRef> {
  const bytes = await attachments.read(original);
  return await prepareImageBytes(original, bytes, attachments, detail);
}

async function prepareImageBytes(
  original: AttachmentRef,
  bytes: Uint8Array,
  attachments: Pick<AttachmentStore, "importBytes">,
  detail: "high" | "original",
): Promise<AttachmentRef> {
  if (original.width === undefined || original.height === undefined)
    throw new Error("Image preparation requires image dimensions");
  const [width, height] = preparedImageDimensions(
    original.width,
    original.height,
    detail,
  );
  if (
    width === original.width &&
    height === original.height &&
    original.mediaType !== "image/gif"
  ) {
    await imageCodec("image_decode_failed", () =>
      sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, animated: false })
        .raw()
        .toBuffer(),
    );
    return original;
  }
  const metadata = await imageCodec("image_decode_failed", () =>
    sharp(bytes, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      animated: false,
    }).metadata(),
  );
  const encoded = await imageCodec("image_processing_failed", async () => {
    let image = sharp(bytes, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      animated: false,
    })
      .resize(width, height, {
        fit: "fill",
        kernel: sharp.kernel.linear,
        withoutEnlargement: true,
      })
      .keepExif();
    if (metadata.icc?.subarray(16, 20).toString("ascii") === "RGB ")
      image = image.keepIccProfile();
    image =
      original.mediaType === "image/jpeg"
        ? image.jpeg({ quality: 85 })
        : original.mediaType === "image/webp"
          ? image.webp({ lossless: true })
          : image.png();
    const output = await image.toBuffer();
    return original.mediaType === "image/gif"
      ? output
      : preserveImageExif(bytes, output, original.mediaType);
  });
  // Store admission, identity and durability errors are deliberately outside the
  // codec boundary. They must never be disguised as unavailable image pixels.
  return await attachments.importBytes(encoded);
}

type PreparedView =
  | { outcome: "prepared"; attachment: AttachmentRef }
  | { outcome: "unavailable"; reason: ImageUnavailableReason };

/** Materialize an immutable, sample-scoped overlay; the compiler alone places it. */
export async function prepareSampleImages(options: {
  threadId: string;
  turnId?: string;
  sampleId: string;
  itemList: readonly ContextItem[];
  selection: { providerProfileId: string; modelId: string };
  inputModalities: readonly string[] | null;
  supportsImageDetailOriginal?: boolean | null;
  attachments: Pick<AttachmentStore, "read" | "importBytes">;
  id(): string;
  now(): string;
}): Promise<ContextItem[]> {
  try {
    if (
      options.inputModalities !== null &&
      !options.inputModalities.includes("image")
    )
      return [];
    const compiled = compileItemList(options.itemList, options);
    const result: ContextItem[] = [];
    const preparedByHash = new Map<string, PreparedView>();
    const seen = new Set<string>();
    for (const message of compiled.messages) {
      const content =
        message.role === "user" && "content" in message
          ? message.content
          : message.role === "tool"
            ? (message.modelContent ?? [])
            : [];
      for (const part of content) {
        if (part.type !== "image") continue;
        const occurrence = modelMediaOrigin(part);
        if (occurrence === undefined)
          throw new Error(
            "Image preparation requires compiler occurrence provenance",
          );
        const key = JSON.stringify(occurrence);
        if (seen.has(key)) continue;
        seen.add(key);
        const original = part.attachment;
        const requestedDetail = part.detail ?? "high";
        const unavailableOriginal =
          requestedDetail === "original" &&
          options.supportsImageDetailOriginal !== true;
        const detail = unavailableOriginal ? "high" : requestedDetail;
        // Verify the original even on a derived-cache hit. A missing/corrupt
        // source is a storage/identity failure, not a codec placeholder.
        const bytes = await options.attachments.read(original);
        const cacheKey = `${original.sha256}:${detail}`;
        const profile =
          detail === "original"
            ? "codex-original-v1"
            : IMAGE_PREPARATION_PROFILE;
        let view = preparedByHash.get(cacheKey);
        if (view === undefined) {
          const cached = options.itemList.findLast((item) => {
            const metadata = item.source.metadata?.imagePreparation as
              | {
                  profile?: string;
                  outcome?: string;
                  occurrence?: { sha256?: string };
                }
              | undefined;
            return (
              item.source.kind === "image_preparation" &&
              metadata?.profile === profile &&
              metadata.outcome !== "unavailable" &&
              metadata.occurrence?.sha256 === original.sha256
            );
          });
          const cachedImage =
            cached?.kind === "message" ? cached.content.parts[1] : undefined;
          if (cachedImage?.type === "image") {
            await options.attachments.read(cachedImage.attachment);
            view = { outcome: "prepared", attachment: cachedImage.attachment };
          } else {
            try {
              view = {
                outcome: "prepared",
                attachment: await prepareImageBytes(
                  original,
                  bytes,
                  options.attachments,
                  detail,
                ),
              };
            } catch (error) {
              if (!(error instanceof ImageCodecFailure)) throw error;
              view = { outcome: "unavailable", reason: error.reason };
            }
          }
          preparedByHash.set(cacheKey, view);
        }
        if (
          view.outcome === "prepared" &&
          view.attachment.sha256 === original.sha256 &&
          detail !== "original" &&
          !unavailableOriginal
        )
          continue;
        const receipt = {
          type: original.type,
          sha256: original.sha256,
          mediaType: original.mediaType,
          byteLength: original.byteLength,
          width: original.width,
          height: original.height,
        };
        let notice: string;
        let parts: UserInputPart[];
        if (view.outcome === "unavailable") {
          notice = `[Image input unavailable (${view.reason}). No image pixels from this occurrence were sent in this sample. The original attachment is unchanged and remains referenced: ${JSON.stringify(receipt)}.]`;
          parts = [{ type: "text", text: notice }];
        } else {
          const prepared = view.attachment;
          const detailNotice = unavailableOriginal
            ? `Original image detail ${options.supportsImageDetailOriginal === false ? "is unsupported" : "capability is unknown"} for the selected provider/model; using a bounded HIGH view. `
            : "";
          notice = `[${detailNotice}Image input prepared with ${profile}: ${original.width}x${original.height} ${original.mediaType}, ${original.byteLength} bytes -> ${prepared.width}x${prepared.height} ${prepared.mediaType}, ${prepared.byteLength} bytes. This sample sees the prepared view. The original attachment is preserved; request higher detail with view_image({"attachment":${JSON.stringify(receipt)},"detail":"original"}) only when this provider/model explicitly supports it (still bounded to 6000-edge/10000-patch). Provider image byte/count limits are not inferred by this profile.]`;
          parts = [
            { type: "text", text: notice },
            {
              type: "image",
              attachment: prepared,
              ...(part.detail === undefined || unavailableOriginal
                ? {}
                : { detail }),
            },
          ];
        }
        result.push({
          id: options.id(),
          threadId: options.threadId,
          ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
          createdAt: options.now(),
          kind: "message",
          role: "user",
          source: {
            kind: "image_preparation",
            sequence: Math.max(
              0,
              ...options.itemList.map((i) => i.source.sequence),
            ),
            metadata: {
              onlySampleId: options.sampleId,
              selection: { ...options.selection },
              imagePreparation: {
                profile,
                outcome: view.outcome,
                ...(view.outcome === "unavailable"
                  ? { reason: view.reason }
                  : {}),
                requestedDetail,
                originalAttachment: receipt as unknown as JsonValue,
                supportsImageDetailOriginal:
                  options.supportsImageDetailOriginal ?? null,
                occurrence: occurrence as unknown as JsonValue,
              },
            },
          },
          content: { text: notice, parts },
        });
      }
    }
    return result;
  } catch (error) {
    throw new ImagePreparationError(error);
  }
}

export type ImagePreparationOccurrence = RecoveryMediaOccurrence;

/** Read-only pressure estimate, never a preparation or dispatch decision. Reuse
 * only an exact origin's durable codec observation for the same profile/detail
 * capability. A later real sample still verifies and prepares the original. */
export function unavailableImageTokenEstimate(
  itemList: readonly ContextItem[],
  supportsImageDetailOriginal: boolean | null,
): ImageInputTokenEstimate {
  const observations = new Map<string, number>();
  const key = (
    origin: RecoveryMediaOccurrence,
    requestedDetail: string,
    profile: string,
  ) =>
    JSON.stringify([
      origin.itemId,
      origin.field,
      origin.partIndex,
      origin.sha256,
      requestedDetail,
      profile,
    ]);
  for (const item of itemList) {
    if (item.source.kind !== "image_preparation" || item.kind !== "message")
      continue;
    const preparation = item.source.metadata?.imagePreparation as
      | {
          outcome?: string;
          reason?: string;
          profile?: string;
          requestedDetail?: string;
          supportsImageDetailOriginal?: boolean | null;
          occurrence?: RecoveryMediaOccurrence;
        }
      | undefined;
    if (
      preparation?.occurrence === undefined ||
      preparation.requestedDetail === undefined ||
      preparation.profile === undefined ||
      preparation.supportsImageDetailOriginal !== supportsImageDetailOriginal
    )
      continue;
    const observationKey = key(
      preparation.occurrence,
      preparation.requestedDetail,
      preparation.profile,
    );
    if (preparation.outcome !== "unavailable") {
      observations.delete(observationKey);
      continue;
    }
    if (
      preparation.reason !== "image_decode_failed" &&
      preparation.reason !== "image_processing_failed"
    )
      continue;
    observations.set(
      key(
        preparation.occurrence,
        preparation.requestedDetail,
        preparation.profile,
      ),
      Math.ceil(item.content.text.length / 4),
    );
  }
  return (part) => {
    const origin = modelMediaOrigin(part);
    if (origin === undefined) return undefined;
    const detail = part.detail ?? "high";
    const profile =
      detail === "original" && supportsImageDetailOriginal === true
        ? "codex-original-v1"
        : IMAGE_PREPARATION_PROFILE;
    return observations.get(key(origin, detail, profile));
  };
}
