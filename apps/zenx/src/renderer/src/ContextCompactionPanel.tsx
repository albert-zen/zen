import { useTranslation } from "react-i18next";
import { Select } from "./ui/controls.js";
import {
  CONTEXT_COMPACTION_SUMMARY_INSTRUCTION,
  type ContextCompactionConfig,
} from "../../../../../src/context-compaction.js";

export function ContextCompactionPanel({
  config,
  onChange,
}: {
  config: ContextCompactionConfig | undefined;
  onChange(config: ContextCompactionConfig | undefined): void;
}) {
  const { t } = useTranslation("settings");
  const mode = config?.retention?.mode ?? "budget";
  const finals = config?.retention?.finalMessages ?? "none";
  const retention = (
    update: NonNullable<ContextCompactionConfig["retention"]>,
  ) => onChange({ ...config, retention: { ...config?.retention, ...update } });
  const numeric = (value: number) => (Number.isFinite(value) ? value : "");
  return (
    <>
      <header className="settings-section-header">
        <h2>{t("contextCompactionPanel.contextCompaction")}</h2>
        <p>
          {t(
            "contextCompactionPanel.controlWhenHistoryIsSummarizedAndWhichOriginalItems",
          )}
        </p>
      </header>
      <section
        className="settings-card compaction-settings"
        aria-label={t("contextCompactionPanel.agenticCompactionExperiment")}
      >
        <h3>{t("contextCompactionPanel.agenticCompactionExperimental")}</h3>
        <div className="settings-row">
          <div>
            <strong>
              {t("contextCompactionPanel.enableAgenticCompaction")}
            </strong>
          </div>
          <button
            className="plugin-switch"
            type="button"
            role="switch"
            aria-label={t(
              "contextCompactionPanel.enableAgenticCompactionExperimental",
            )}
            aria-describedby="agentic-compaction-description"
            aria-checked={config?.agenticEnabled ?? false}
            onClick={() =>
              onChange({ ...config, agenticEnabled: !config?.agenticEnabled })
            }
          />
        </div>
        <p id="agentic-compaction-description" className="settings-note">
          {t("contextCompactionPanel.letTheAgentChooseWhenToReplaceItsWorking")}
        </p>
        <p className="settings-note">
          {t(
            "contextCompactionPanel.theSummaryPromptAndRetentionRulesBelowApplyTo",
          )}
        </p>
      </section>
      <section
        className="settings-card compaction-settings"
        aria-label={t("contextCompactionPanel.compactionBudget")}
      >
        <h3>{t("contextCompactionPanel.triggerAndBudget")}</h3>
        <div className="compaction-field-grid">
          <label className="field">
            <span>{t("contextCompactionPanel.compactionTrigger")}</span>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              value={numeric(config?.triggerPercent ?? 80)}
              onChange={(event) =>
                onChange({
                  ...config,
                  triggerPercent:
                    event.target.value === ""
                      ? NaN
                      : Number(event.target.value),
                })
              }
            />
          </label>
          <label className="field">
            <span>{t("contextCompactionPanel.postCompactionBudget")}</span>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              value={numeric(config?.targetPercent ?? 80)}
              onChange={(event) =>
                onChange({
                  ...config,
                  targetPercent:
                    event.target.value === ""
                      ? NaN
                      : Number(event.target.value),
                })
              }
            />
          </label>
        </div>
        <p className="settings-note">
          {t(
            "contextCompactionPanel.percentagesUseTheSelectedModelSContextWindowThe",
          )}
        </p>
        <p className="settings-note">
          {t(
            "contextCompactionPanel.automaticCompactionRunsAtCompletedTurnBoundariesOrBefore",
          )}
        </p>
      </section>
      <section
        className="settings-card compaction-settings"
        aria-label={t("contextCompactionPanel.retentionRules")}
      >
        <h3>{t("contextCompactionPanel.originalItemsToRetain")}</h3>
        <label className="field">
          <span>{t("contextCompactionPanel.retentionMode")}</span>
          <Select
            value={mode}
            onValueChange={(value) =>
              retention({
                mode: value as "budget" | "recent-items" | "selected-items",
              })
            }
          >
            <option value="budget">
              {t("contextCompactionPanel.fillTheTokenBudgetWithRecentItems")}
            </option>
            <option value="recent-items">
              {t("contextCompactionPanel.keepTheMostRecentNItems")}
            </option>
            <option value="selected-items">
              {t("contextCompactionPanel.keepOnlyTheTypesSelectedBelow")}
            </option>
          </Select>
        </label>
        {mode === "recent-items" ? (
          <div className="compaction-count-control">
            <label className="field">
              <span>{t("contextCompactionPanel.numberOfRecentItems")}</span>
              <input
                type="number"
                min="1"
                step="1"
                value={numeric(config?.retention?.recentItemCount ?? 20)}
                onChange={(event) =>
                  retention({
                    recentItemCount:
                      event.target.value === ""
                        ? NaN
                        : Number(event.target.value),
                  })
                }
              />
            </label>
            <div className="compaction-presets">
              <button
                type="button"
                className="quiet-button"
                onClick={() => retention({ recentItemCount: 10 })}
              >
                {t("contextCompactionPanel.last10Items")}
              </button>
              <button
                type="button"
                className="quiet-button"
                onClick={() => retention({ recentItemCount: 20 })}
              >
                {t("contextCompactionPanel.last20Items")}
              </button>
            </div>
          </div>
        ) : null}
        <details className="settings-explanation">
          <summary>
            {t("contextCompactionPanel.howOriginalItemsAreCounted")}
          </summary>
          <p className="settings-note">
            {t(
              "contextCompactionPanel.itemsIncludeUserAndAgentMessagesReasoningToolCalls",
            )}
          </p>
        </details>
        <label className="compaction-checkbox">
          <input
            type="checkbox"
            aria-label={t("contextCompactionPanel.preserveAllUserMessages")}
            checked={config?.retention?.preserveUserMessages ?? false}
            onChange={(event) =>
              retention({ preserveUserMessages: event.target.checked })
            }
          />
          <span>{t("contextCompactionPanel.preserveAllUserMessages2")}</span>
        </label>
        <label className="field">
          <span>{t("contextCompactionPanel.agentFinalMessages")}</span>
          <Select
            value={finals}
            onValueChange={(value) =>
              retention({
                finalMessages: value as "none" | "all" | "recent",
              })
            }
          >
            <option value="none">
              {t("contextCompactionPanel.noAdditionalFinalMessages")}
            </option>
            <option value="all">
              {t("contextCompactionPanel.preserveAllFinalMessages")}
            </option>
            <option value="recent">
              {t("contextCompactionPanel.preserveTheMostRecentNFinalMessages")}
            </option>
          </Select>
        </label>
        {finals === "recent" ? (
          <label className="field">
            <span>{t("contextCompactionPanel.numberOfFinalMessages")}</span>
            <input
              type="number"
              min="1"
              step="1"
              value={numeric(config?.retention?.finalMessageCount ?? 10)}
              onChange={(event) =>
                retention({
                  finalMessageCount:
                    event.target.value === ""
                      ? NaN
                      : Number(event.target.value),
                })
              }
            />
          </label>
        ) : null}
        <p className="settings-note">
          {t("contextCompactionPanel.aFinalMessageIsTheFinalAgentReplyOf")}
        </p>
        <details className="settings-explanation">
          <summary>
            {t("contextCompactionPanel.howRetentionRulesCombine")}
          </summary>
          <p className="settings-note">
            {t(
              "contextCompactionPanel.theseRulesCombineSelectingUserMessagesOrFinalReplies",
            )}
          </p>
        </details>
      </section>
      <section
        className="settings-card compaction-settings"
        aria-label={t("contextCompactionPanel.compactionInstruction")}
      >
        <h3>{t("contextCompactionPanel.summaryInstruction")}</h3>
        <label className="field">
          <span>{t("contextCompactionPanel.compactionPrompt")}</span>
          <textarea
            rows={9}
            maxLength={32768}
            value={
              config?.summaryInstruction ??
              CONTEXT_COMPACTION_SUMMARY_INSTRUCTION
            }
            onChange={(event) =>
              onChange({ ...config, summaryInstruction: event.target.value })
            }
          />
        </label>
        <p className="settings-note">
          {t(
            "contextCompactionPanel.replacesTheDefaultInstructionPreserveGoalsDecisionsConstraintsUnfinished",
          )}
        </p>
        <button
          type="button"
          className="quiet-button"
          onClick={() => {
            const { summaryInstruction: _, ...rest } = config ?? {};
            onChange(rest);
          }}
        >
          {t("contextCompactionPanel.restoreDefaultPrompt")}
        </button>
      </section>
      <button
        type="button"
        className="quiet-button"
        onClick={() => onChange(undefined)}
      >
        {t("contextCompactionPanel.resetAllCompactionSettings")}
      </button>
    </>
  );
}
