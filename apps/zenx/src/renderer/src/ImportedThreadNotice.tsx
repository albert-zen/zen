import { useTranslation } from "react-i18next";
import type { CanonicalItem } from "../../../../../src/item.js";
export function ImportedThreadNotice({
  items,
}: {
  items: readonly CanonicalItem[];
}) {
  const { t } = useTranslation("shell");
  const source = items.find(
    (item) => item.type === "thread_metadata",
  )?.importedFrom;
  if (!source) return null;
  return (
    <aside
      className="imported-thread-notice"
      aria-label={t("importedThreadNotice")}
    >
      <strong>{t("importedThreadNotice")}</strong>
      {source.contextBasis && (
        <p>
          {t("importCheckpointWarning", {
            line: source.contextBasis.sourceLine,
            count: source.contextBasis.earlierRecords,
          })}
        </p>
      )}
      <details>
        <summary>{t("importedThreadDetails")}</summary>
        <p>
          {t("importedThreadIdentity", {
            format: source.format,
            id: source.sourceId,
            cwd: source.sourceCwd,
          })}
        </p>
        <ul>
          {source.exclusions.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      </details>
    </aside>
  );
}
