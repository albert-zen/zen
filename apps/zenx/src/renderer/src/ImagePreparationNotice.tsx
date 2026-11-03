import * as React from "react";
import { useTranslation } from "react-i18next";
import type { ContextItem } from "../../../../../src/item-list.js";
import { projectImagePreparation } from "./image-preparation-projection.js";

export function ImagePreparationNotice({
  items,
}: {
  items: readonly ContextItem[];
}) {
  const { t } = useTranslation("shell");
  const projection = projectImagePreparation(items);
  if (projection === null) return null;
  const fallbacks = new Set(
    projection.images.map((image) => image.originalDetailFallback),
  );
  return (
    <aside
      className="image-preparation-notice"
      aria-label={t("imagePreparationTitle", {
        count: projection.images.length,
      })}
    >
      <strong>
        {t("imagePreparationTitle", { count: projection.images.length })}
      </strong>
      <span>{t("imagePreparationPreserved")}</span>
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
      <details>
        <summary>{t("imagePreparationDetails")}</summary>
        <ul>
          {projection.images.map((image, index) => (
            <li key={index}>
              {t("imagePreparationDimensions", {
                number: index + 1,
                originalWidth: image.original.width,
                originalHeight: image.original.height,
                preparedWidth: image.prepared.width,
                preparedHeight: image.prepared.height,
                profile: image.profile,
              })}
            </li>
          ))}
        </ul>
      </details>
    </aside>
  );
}
