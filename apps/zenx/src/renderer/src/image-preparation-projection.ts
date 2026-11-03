import type { ContextItem } from "../../../../../src/item-list.js";

export interface PreparedImageView {
  original: { width: number; height: number } | null;
  prepared: { width: number; height: number } | null;
  profile: "codex-high-v1" | "codex-original-v1";
  originalDetailFallback: "unsupported" | "unknown" | null;
  outcome: "prepared" | "unavailable";
  reason: "image_decode_failed" | "image_processing_failed" | null;
}

export interface ImagePreparationProjection {
  sampleId: string;
  images: PreparedImageView[];
}

function imageDimensions(
  value: unknown,
): { width: number; height: number } | null {
  if (value === null || typeof value !== "object") return null;
  const image = value as Record<string, unknown>;
  return typeof image.width === "number" &&
    Number.isFinite(image.width) &&
    image.width > 0 &&
    typeof image.height === "number" &&
    Number.isFinite(image.height) &&
    image.height > 0
    ? { width: image.width, height: image.height }
    : null;
}

function selectedItemIds(items: readonly ContextItem[]): Set<string> {
  const latest = items.findLast((item) => item.kind === "selection");
  let selected = items;
  if (latest?.kind === "selection") {
    const retained = new Set(latest.content.retainedItemIds);
    selected = items.filter(
      (item) =>
        item === latest ||
        retained.has(item.id) ||
        item.source.sequence > latest.content.coveredSequence ||
        item.role === "system" ||
        item.role === "developer",
    );
  }
  const excluded = new Set(
    items.flatMap((item) =>
      item.kind === "selection" ? (item.content.excludedItemIds ?? []) : [],
    ),
  );
  return new Set(
    selected.filter((item) => !excluded.has(item.id)).map((item) => item.id),
  );
}

/** A disposable, cold-rebuildable projection of persisted sample-scoped notices. */
export function projectImagePreparation(
  items: readonly ContextItem[],
): ImagePreparationProjection | null {
  let latestSampleId: string | null = null;
  for (const item of items) {
    if (item.source.metadata?.onlySampleId === undefined) continue;
    const sampleId = item.source.metadata?.onlySampleId;
    if (typeof sampleId === "string" && sampleId.length > 0)
      latestSampleId = sampleId;
  }
  if (latestSampleId === null) return null;

  const eligible = selectedItemIds(items);
  const images: PreparedImageView[] = [];
  const occurrences = new Set<string>();
  for (const item of items) {
    if (item.kind !== "message" || item.source.kind !== "image_preparation")
      continue;
    const metadata = item.source.metadata;
    if (metadata?.onlySampleId !== latestSampleId || !eligible.has(item.id))
      continue;
    const preparation = metadata.imagePreparation;
    if (
      preparation === null ||
      typeof preparation !== "object" ||
      Array.isArray(preparation)
    )
      continue;
    const detail = preparation as Record<string, unknown>;
    const profile = detail.profile;
    if (profile !== "codex-high-v1" && profile !== "codex-original-v1")
      continue;
    const occurrence = detail.occurrence;
    if (
      occurrence === null ||
      typeof occurrence !== "object" ||
      Array.isArray(occurrence)
    )
      continue;
    const origin = occurrence as Record<string, unknown>;
    if (
      typeof origin.itemId !== "string" ||
      typeof origin.field !== "string" ||
      typeof origin.partIndex !== "number" ||
      typeof origin.sha256 !== "string"
    )
      continue;
    const key = JSON.stringify([
      origin.itemId,
      origin.field,
      origin.partIndex,
      origin.sha256,
    ]);
    if (occurrences.has(key) || !eligible.has(origin.itemId)) continue;
    const original = imageDimensions(detail.originalAttachment);
    const unavailable = detail.outcome === "unavailable";
    const reason =
      detail.reason === "image_decode_failed" ||
      detail.reason === "image_processing_failed"
        ? detail.reason
        : null;
    if (
      unavailable &&
      (reason === null ||
        item.content.parts.length !== 1 ||
        item.content.parts[0]?.type !== "text")
    )
      continue;
    if (
      !unavailable &&
      detail.outcome !== undefined &&
      detail.outcome !== "prepared"
    )
      continue;
    const preparedPart = item.content.parts.find(
      (part) => part.type === "image",
    );
    const prepared =
      preparedPart?.type === "image"
        ? imageDimensions(preparedPart.attachment)
        : null;
    if (
      (!unavailable && original === null) ||
      (!unavailable && prepared === null)
    )
      continue;
    if (
      detail.originalAttachment === null ||
      typeof detail.originalAttachment !== "object"
    )
      continue;
    const originalRef = detail.originalAttachment as Record<string, unknown>;
    if (originalRef.sha256 !== origin.sha256) continue;
    if (
      !unavailable &&
      originalRef.sha256 === preparedPart?.attachment.sha256 &&
      detail.requestedDetail !== "original"
    )
      continue;
    occurrences.add(key);
    const requestedOriginal =
      detail.requestedDetail === "original" && profile === "codex-high-v1";
    images.push({
      original,
      prepared: unavailable ? null : prepared,
      profile,
      outcome: unavailable ? "unavailable" : "prepared",
      reason: unavailable ? reason : null,
      originalDetailFallback:
        !unavailable &&
        requestedOriginal &&
        detail.supportsImageDetailOriginal !== true
          ? detail.supportsImageDetailOriginal === false
            ? "unsupported"
            : "unknown"
          : null,
    });
  }
  return images.length > 0 ? { sampleId: latestSampleId, images } : null;
}
