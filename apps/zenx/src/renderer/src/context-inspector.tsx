import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import type { ModelUsageProjection } from "../../../../../src/model-usage.js";
import type { ContextPreview } from "../../../../../src/context-inspection.js";

function Preview({ value }: { value: ContextPreview }) {
  const { t } = useTranslation("contextInspection");
  return (
    <>
      <pre>{value.text}</pre>
      {value.truncated ? <p>{t("previewTruncated")}</p> : null}
    </>
  );
}

export function ContextInspector({
  usage,
  stale = false,
  onRefresh,
}: {
  usage: ModelUsageProjection;
  stale?: boolean;
  onRefresh?(): void;
}) {
  const { t } = useTranslation("contextInspection");
  const data = usage.inspection;
  if (!data) return null;
  if (stale)
    return (
      <section className="context-inspector" aria-label={t("title")}>
        <p role="status">{t("stale")}</p>
        <button
          type="button"
          aria-label={t("refreshLabel")}
          onClick={onRefresh}
        >
          {t("refresh")}
        </button>
      </section>
    );
  return (
    <section className="context-inspector" aria-label={t("title")}>
      <header>
        <span className="context-inspector-eyebrow">{t("eyebrow")}</span>
        <h2>{t("heading")}</h2>
        <p>{t("scope")}</p>
      </header>
      <section>
        <h3>{t("occupancy")}</h3>
        <dl>
          <dt>{t("estimate")}</dt>
          <dd>
            {t("tokens", {
              count: data.estimatedMessageTokens.toLocaleString(
                i18n.resolvedLanguage,
              ),
            })}
          </dd>
          <dt>{t("window")}</dt>
          <dd>
            {usage.context.contextWindow?.toLocaleString(
              i18n.resolvedLanguage,
            ) ?? t("unknown")}
          </dd>
          <dt>
            {usage.context.inputTokenSource === "provider"
              ? t("providerInput")
              : t("indicatorEstimate")}
          </dt>
          <dd>
            {usage.context.inputTokens?.toLocaleString(i18n.resolvedLanguage) ??
              t("unknown")}
          </dd>
        </dl>
        <p>{t("estimateScope")}</p>
      </section>
      <section>
        <h3>{t("summaryHeading")}</h3>
        {data.compaction ? (
          <>
            <p>{t("summaryScope")}</p>
            <details>
              <summary>{t("savedSummary")}</summary>
              <Preview value={data.compaction.summary} />
              <p>
                {t("source")}
                <code>{data.compaction.source}</code>
              </p>
              <p>
                {t("coveredThrough")}
                <code>{data.compaction.boundary}</code>
              </p>
            </details>
            <details>
              <summary>
                {t("retainedCount", {
                  count:
                    data.compaction.retainedItemIds.length +
                    data.compaction.retainedOmitted,
                })}
              </summary>
              <pre>
                {data.compaction.retainedItemIds.join("\n") || t("none")}
              </pre>
              {data.compaction.retainedOmitted ? (
                <p>
                  {t("omittedIds", { count: data.compaction.retainedOmitted })}
                </p>
              ) : null}
            </details>
          </>
        ) : (
          <p>{t("noCompaction")}</p>
        )}
      </section>
      <section>
        <h3>{t("rules")}</h3>
        <p>{t("rulesScope")}</p>
        {data.rules.length ? (
          data.rules.map((rule, index) => (
            <details key={index}>
              <summary>{rule.source}</summary>
              <Preview value={rule.preview} />
            </details>
          ))
        ) : (
          <p>{t("noRules")}</p>
        )}
        {data.rulesOmitted ? (
          <p>{t("omittedRules", { count: data.rulesOmitted })}</p>
        ) : null}
      </section>
      <section>
        <h3>{t("capabilities")}</h3>
        <p>{t("capabilitiesScope")}</p>
        <p>
          {t("toolNamesLabel")} {data.toolNames.join(", ") || t("none")}.
        </p>
        <p>{t("mediaScope")}</p>
      </section>
      <section>
        <h3>{t("messages", { count: data.messageCount })}</h3>
        <p>{t("messageScope", { count: data.messages.length })}</p>
        {data.messages.map((message, index) => (
          <details key={index}>
            <summary>
              {data.messageCount - data.messages.length + index + 1}.{" "}
              {message.role}
            </summary>
            <Preview value={message.preview} />
          </details>
        ))}
      </section>
      <footer>
        {t("snapshotPrefix")} <code>{data.throughItemId ?? t("empty")}</code>
        {t("snapshotScope")}
      </footer>
    </section>
  );
}
