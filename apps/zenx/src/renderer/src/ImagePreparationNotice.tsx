import * as React from "react";
import { useTranslation } from "react-i18next";
import type { ContextItem } from "../../../../../src/item-list.js";
import { projectImagePreparation } from "./image-preparation-projection.js";
import {
  disclosureKey,
  type useThreadReadingState,
} from "./thread-reading-state.js";

const emptyChoices: ReadonlyMap<string, boolean> = new Map();
const emptySnapshot = () => emptyChoices;
const noSubscription = () => () => {};

export function imagePreparationDisclosureKey(sampleId: string) {
  return disclosureKey("image-preparation", sampleId);
}

/** Capture native toggles before a viewport replacement can discard their queued event. */
export function captureImagePreparationDisclosure(
  viewport: HTMLElement,
  reading: ReturnType<typeof useThreadReadingState>,
) {
  const details = viewport.querySelector<HTMLDetailsElement>(
    ".image-preparation-notice details[data-image-preparation-sample-id]",
  );
  const sampleId = details?.dataset.imagePreparationSampleId;
  if (details && sampleId)
    reading.set(imagePreparationDisclosureKey(sampleId), details.open);
}

export function ImagePreparationNotice({
  items,
  reading,
}: {
  items: readonly ContextItem[];
  reading?: ReturnType<typeof useThreadReadingState>;
}) {
  const { t } = useTranslation("shell");
  const choices = React.useSyncExternalStore(
    reading?.subscribe ?? noSubscription,
    reading?.snapshot ?? emptySnapshot,
    reading?.snapshot ?? emptySnapshot,
  );
  const projection = projectImagePreparation(items);
  const details = React.useRef<HTMLDetailsElement>(null);
  const sampleId = projection?.sampleId;
  React.useLayoutEffect(() => {
    const node = details.current;
    if (!reading || !node || sampleId === undefined) return;
    // A sample can be replaced before native toggle is delivered. Capture the
    // departing keyed node, never the next sample's DOM or reading choice.
    return () => {
      reading.set(imagePreparationDisclosureKey(sampleId), node.open);
    };
  }, [reading, sampleId]);
  if (projection === null) return null;
  const preparedCount = projection.images.filter(
    (image) => image.outcome === "prepared",
  ).length;
  const unavailableCount = projection.images.length - preparedCount;
  const titleKey =
    unavailableCount === 0
      ? "imagePreparationTitle"
      : preparedCount === 0
        ? "imagePreparationUnavailableTitle"
        : "imagePreparationMixedTitle";
  const title = t(titleKey, { count: preparedCount, unavailableCount });
  const fallbacks = new Set(
    projection.images.map((image) => image.originalDetailFallback),
  );
  return (
    <aside className="image-preparation-notice" aria-label={title}>
      <strong>{title}</strong>
      <span>
        {t(
          unavailableCount === 0
            ? "imagePreparationPreserved"
            : preparedCount === 0
              ? "imagePreparationUnavailablePreserved"
              : "imagePreparationMixedPreserved",
        )}
      </span>
      {fallbacks.has("unsupported") && (
        <span className="image-preparation-fallback">
          {t("imagePreparationFallbackUnsupported")}
        </span>
      )}
      {fallbacks.has("unknown") && (
        <span className="image-preparation-fallback">
          {t("imagePreparationFallbackUnknown")}
        </span>
      )}
      <details
        key={reading ? projection.sampleId : undefined}
        ref={reading ? details : undefined}
        open={
          reading
            ? (choices.get(
                imagePreparationDisclosureKey(projection.sampleId),
              ) ?? false)
            : undefined
        }
        data-image-preparation-sample-id={
          reading ? projection.sampleId : undefined
        }
        onToggle={
          reading
            ? (event) => {
                if (
                  event.currentTarget !== details.current ||
                  !event.currentTarget.isConnected
                )
                  return;
                reading.set(
                  imagePreparationDisclosureKey(projection.sampleId),
                  event.currentTarget.open,
                );
              }
            : undefined
        }
      >
        <summary>{t("imagePreparationDetails")}</summary>
        <ul>
          {projection.images.map((image, index) => (
            <li key={index}>
              {image.outcome === "unavailable"
                ? t(
                    image.reason === "image_decode_failed"
                      ? image.original === null
                        ? "imagePreparationUnavailableDecodeNoDimensions"
                        : "imagePreparationUnavailableDecode"
                      : image.original === null
                        ? "imagePreparationUnavailableProcessingNoDimensions"
                        : "imagePreparationUnavailableProcessing",
                    {
                      number: index + 1,
                      originalWidth: image.original?.width,
                      originalHeight: image.original?.height,
                    },
                  )
                : t("imagePreparationDimensions", {
                    number: index + 1,
                    originalWidth: image.original!.width,
                    originalHeight: image.original!.height,
                    preparedWidth: image.prepared!.width,
                    preparedHeight: image.prepared!.height,
                    profile: image.profile,
                  })}
            </li>
          ))}
        </ul>
      </details>
    </aside>
  );
}
