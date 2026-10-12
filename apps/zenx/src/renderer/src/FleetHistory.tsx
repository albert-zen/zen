import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import "./i18n.js";

/** Public snapshot rendering only; never resolves target assets against local files. */
export function FleetHistory({ value }: { value: unknown }) {
  const { t } = useTranslation("settings");
  const items = record(value).items;
  if (!Array.isArray(items)) return <p>{t("fleetHistory.readPrompt")}</p>;
  if (!items.length) return <p>{t("fleetHistory.emptyHistory")}</p>;
  return (
    <>
      {items.map((entry, index) => {
        const row = record(entry);
        const item = record(row.item ?? row);
        const type = string(row.type ?? item.type);
        const explicit = string(row.text ?? row.preview);
        const text =
          type === "reasoning" && item.contentVisibility === "opaque"
            ? string(item.summary) || t("fleetHistory.privateReasoning")
            : explicit ||
              string(
                item.text ?? item.output ?? item.message ?? item.summary,
              ) ||
              contentText(item.content, t);
        const message = type === "user_message" || type === "agent_message";
        const label =
          type === "user_message"
            ? t("fleetHistory.you")
            : type === "agent_message"
              ? t("fleetHistory.agent")
              : Object.hasOwn(historyTypeKeys, type)
                ? t(historyTypeKeys[type]!)
                : type.replaceAll("_", " ") || t("fleetHistory.item");
        const detail =
          type === "tool_call"
            ? text || JSON.stringify(item.arguments ?? {}, null, 2)
            : text;
        const summary =
          type === "tool_call"
            ? string(item.name) || label
            : type === "turn_completed"
              ? t("fleetHistory.turnStatus", {
                  status: Object.hasOwn(historyStatusKeys, string(item.status))
                    ? t(historyStatusKeys[string(item.status)]!)
                    : string(item.status) || t("fleetHistory.completed"),
                })
              : type === "model_usage"
                ? t("fleetHistory.modelUsage", {
                    inputTokens: String(item.inputTokens ?? "?"),
                    outputTokens: String(item.outputTokens ?? "?"),
                  })
                : label;
        const truncated =
          row.truncated || row.textTruncated || detail.length > 16384;
        return (
          <article key={string(row.itemId ?? row.id ?? item.id) || index}>
            {message ? (
              <>
                <strong>{label}</strong>
                <p className="fleet-history-text">
                  {text.slice(0, 16384) || t("fleetHistory.remoteAttachment")}
                </p>
              </>
            ) : detail ? (
              <details>
                <summary>{summary}</summary>
                <p className="fleet-history-text">{detail.slice(0, 16384)}</p>
              </details>
            ) : (
              <small className="settings-note">{summary}</small>
            )}
            {truncated ? (
              <small className="settings-note">
                {t("fleetHistory.boundedExcerpt")}
              </small>
            ) : null}
          </article>
        );
      })}
    </>
  );
}
function contentText(value: unknown, t: TFunction<"settings">): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      const item = record(block);
      return item.type === "text"
        ? string(item.text)
        : item.type === "image"
          ? t("fleetHistory.remoteImage")
          : "";
    })
    .filter(Boolean)
    .join("\n");
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const historyTypeKeys: Record<string, string> = {
  thread_metadata: "fleetHistory.threadMetadata",
  thread_forked: "fleetHistory.threadForked",
  thread_instruction: "fleetHistory.threadInstruction",
  thread_configuration_changed: "fleetHistory.threadConfigurationChanged",
  context_compaction: "fleetHistory.contextCompaction",
  turn_started: "fleetHistory.turnStarted",
  turn_aborted: "fleetHistory.turnAborted",
  turn_replacement_requested: "fleetHistory.turnReplacementRequested",
  user_message_queued: "fleetHistory.userMessageQueued",
  user_message_queue_cancelled: "fleetHistory.userMessageQueueCancelled",
  reasoning: "fleetHistory.reasoning",
  tool_call: "fleetHistory.toolCall",
  tool_result: "fleetHistory.toolResult",
  code_state: "fleetHistory.codeState",
  failure: "fleetHistory.failure",
};

const historyStatusKeys: Record<string, string> = {
  completed: "fleetHistory.statusCompleted",
  failed: "fleetHistory.statusFailed",
  interrupted: "fleetHistory.statusInterrupted",
  inProgress: "fleetHistory.statusInProgress",
};
