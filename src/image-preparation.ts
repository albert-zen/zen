import { preserveImageExif } from "./image-metadata.js";
import sharp from "sharp";
import {
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
import { modelMediaOrigin } from "./model-media-origin.js";

/** Versioned Zen input profile, following Codex f05aa41's per-image HIGH limits. */
export const IMAGE_PREPARATION_PROFILE = "codex-high-v1";

export class ImagePreparationError extends Error {
  readonly modelRecoveryBlocked = true;
  readonly retryable = false;
  constructor(cause: unknown) {
    super(
      `Image input preparation failed: ${cause instanceof Error ? cause.message : String(cause)}. The original attachment is preserved.`,
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

/** No file/network access here: only immutable, already-admitted attachments. */
export async function prepareImageAttachment(
  original: AttachmentRef,
  attachments: Pick<AttachmentStore, "read" | "importBytes">,
  detail: "high" | "original" = "high",
): Promise<AttachmentRef> {
  if (original.width === undefined || original.height === undefined)
    throw new Error("Image preparation requires image dimensions");
  const [width, height] = preparedImageDimensions(
    original.width,
    original.height,
    detail,
  );
  const bytes = await attachments.read(original);
  if (
    width === original.width &&
    height === original.height &&
    original.mediaType !== "image/gif"
  ) {
    // Codex validates decodability even when preserving the original encoding.
    await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, animated: false })
      .raw()
      .toBuffer();
    return original;
  }
  const metadata = await sharp(bytes, {
    limitInputPixels: MAX_IMAGE_PIXELS,
    animated: false,
  }).metadata();
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
  // Codex copies only an RGB ICC profile. A retained CMYK/YCCK profile
  // would mislabel RGB re-encoded pixels after decoder conversion.
  if (metadata.icc?.subarray(16, 20).toString("ascii") === "RGB ")
    image = image.keepIccProfile();
  image =
    original.mediaType === "image/jpeg"
      ? image.jpeg({ quality: 85 })
      : original.mediaType === "image/webp"
        ? image.webp({ lossless: true })
        : image.png();
  const encoded = await image.toBuffer();
  const prepared =
    original.mediaType === "image/gif"
      ? encoded
      : preserveImageExif(bytes, encoded, original.mediaType);
  return await attachments.importBytes(prepared);
}

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
    const preparedByHash = new Map<string, AttachmentRef>();
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
        const cacheKey = `${original.sha256}:${detail}`;
        let prepared = preparedByHash.get(cacheKey);
        if (prepared === undefined) {
          const profile =
            detail === "original"
              ? "codex-original-v1"
              : IMAGE_PREPARATION_PROFILE;
          const cached = options.itemList.findLast((item) => {
            const metadata = item.source.metadata?.imagePreparation as
              | { profile?: string; occurrence?: { sha256?: string } }
              | undefined;
            return (
              item.source.kind === "image_preparation" &&
              metadata?.profile === profile &&
              metadata.occurrence?.sha256 === original.sha256
            );
          });
          const cachedImage =
            cached?.kind === "message" ? cached.content.parts[1] : undefined;
          if (cachedImage?.type === "image") {
            await options.attachments.read(cachedImage.attachment);
            prepared = cachedImage.attachment;
          }
          prepared ??= await prepareImageAttachment(
            original,
            options.attachments,
            detail,
          );
          preparedByHash.set(cacheKey, prepared);
        }
        if (
          prepared.sha256 === original.sha256 &&
          detail !== "original" &&
          !unavailableOriginal
        )
          continue;
        const profile =
          detail === "original"
            ? "codex-original-v1"
            : IMAGE_PREPARATION_PROFILE;
        const detailNotice = unavailableOriginal
          ? `Original image detail ${options.supportsImageDetailOriginal === false ? "is unsupported" : "capability is unknown"} for the selected provider/model; using a bounded HIGH view. `
          : "";
        const notice = `[${detailNotice}Image input prepared with ${profile}: ${original.width}x${original.height} ${original.mediaType}, ${original.byteLength} bytes -> ${prepared.width}x${prepared.height} ${prepared.mediaType}, ${prepared.byteLength} bytes. This sample sees the prepared view. The original attachment is preserved; request higher detail with view_image({"attachment":${JSON.stringify(original)},"detail":"original"}) only when this provider/model explicitly supports it (still bounded to 6000-edge/10000-patch). Provider image byte/count limits are not inferred by this profile.]`;
        const parts: UserInputPart[] = [
          { type: "text", text: notice },
          {
            type: "image",
            attachment: prepared,
            ...(detail === "original" ? { detail } : {}),
          },
        ];
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
                requestedDetail,
                originalAttachment: original as unknown as JsonValue,
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
