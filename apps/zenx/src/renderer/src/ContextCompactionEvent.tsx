import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelMessage } from "../../../../../src/model.js";
import { originalItemListReference } from "../../../../../src/context-compaction.js";
import { i18n } from "./i18n.js";
import { Icon } from "./icons.js";
import { Markdown } from "./Markdown.js";
import { OriginalHistory } from "./OriginalHistory.js";
import {
  compactionInitiatorLabel,
  type ContextCompactionProjection,
} from "./context-compaction-projection.js";

const views = ["retained", "original", "diagnostics"] as const;
type View = (typeof views)[number];

/** One canonical event, one disclosure, three peer read-only views. */
export function ContextCompactionEvent({
  projection,
}: {
  projection: ContextCompactionProjection;
}) {
  useTranslation("shell");
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<View>("retained");
  const [copyState, setCopyState] = useState("");
  const id = useId();
  const { item, effectiveMessages } = projection;
  const labels: Record<View, string> = {
    retained: i18n.t("shell:retainedContext"),
    original: i18n.t("shell:originalHistory"),
    diagnostics: i18n.t("shell:compactionDiagnostics"),
  };
  return (
    <section
      className="context-compaction-event"
      aria-label={i18n.t("shell:contextCompacted")}
    >
      <button
        className="context-compaction-toggle workflow-status"
        type="button"
        aria-expanded={expanded}
        aria-controls={`${id}-detail`}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="context-compaction-mark" aria-hidden="true">
          <Icon name="compress" size={14} />
        </span>
        <span className="context-compaction-label">
          <strong>{i18n.t("shell:contextCompacted")}</strong>
          <small>{compactionInitiatorLabel(item)}</small>
        </span>
        <Icon name="chevron-down" size={13} />
      </button>
      {expanded ? (
        <div className="context-compaction-detail" id={`${id}-detail`}>
          <div
            className="compaction-views"
            role="tablist"
            aria-label={i18n.t("shell:compactionViews")}
            onKeyDown={(event) => {
              const tabs = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                ),
              ];
              const current = tabs.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              if (current < 0) return;
              const next =
                event.key === "ArrowRight"
                  ? (current + 1) % views.length
                  : event.key === "ArrowLeft"
                    ? (current + views.length - 1) % views.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? views.length - 1
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              setView(views[next]!);
              tabs[next]?.focus();
            }}
          >
            {views.map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                id={`${id}-${value}-tab`}
                aria-controls={`${id}-panel`}
                aria-selected={value === view}
                tabIndex={value === view ? 0 : -1}
                onClick={() => setView(value)}
              >
                {labels[value]}
              </button>
            ))}
          </div>
          <div
            className={`compaction-view compaction-view-${view}`}
            id={`${id}-panel`}
            role="tabpanel"
            aria-labelledby={`${id}-${view}-tab`}
            tabIndex={0}
          >
            {view === "retained" ? (
              <>
                <div className="compaction-summary-heading">
                  <p className="context-compaction-metadata">
                    {i18n.t("shell:summaryCharacters", {
                      count: new Intl.NumberFormat(
                        i18n.resolvedLanguage,
                      ).format(Array.from(item.summary).length),
                    })}
                  </p>
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => {
                      void (async () => {
                        try {
                          await navigator.clipboard.writeText(item.summary);
                          setCopyState(i18n.t("shell:summaryCopied"));
                        } catch {
                          setCopyState(
                            i18n.t(
                              "shell:couldNotCopySelectTheSummaryTextToCopyIt",
                            ),
                          );
                        }
                      })();
                    }}
                  >
                    {i18n.t("shell:copySummary")}
                  </button>
                </div>
                {copyState ? <span role="status">{copyState}</span> : null}
                <div className="compaction-summary">
                  <Markdown text={item.summary} />
                </div>
                <p>
                  {i18n.t("shell:retainedItemsDetail", {
                    count: item.retainedItemIds.length,
                  })}
                </p>
              </>
            ) : view === "original" ? (
              <OriginalHistory key={item.id} item={item} />
            ) : (
              <>
                <div className="compaction-projection">
                  <h3>{i18n.t("shell:projectedContext")}</h3>
                  {effectiveMessages === null ? (
                    <p role="status">
                      {i18n.t("shell:retainedContextUnavailable")}
                      {projection.snapshotError
                        ? ` ${projection.snapshotError}`
                        : null}
                    </p>
                  ) : (
                    <>
                      <p>
                        {i18n.t("shell:projectedHistoryDetail", {
                          count: effectiveMessages.length,
                        })}
                      </p>
                      <ol>
                        {effectiveMessages.map((message, index) => (
                          <li key={`${item.id}:${String(index)}`}>
                            <span>{modelMessageRole(message)}</span>
                            <pre>{formatModelMessage(message)}</pre>
                          </li>
                        ))}
                      </ol>
                    </>
                  )}
                </div>
                {item.includeOriginalReference === true ? (
                  <div className="original-history-locator">
                    <h3>{i18n.t("shell:logicalReference")}</h3>
                    <code>
                      {originalItemListReference(
                        item.threadId,
                        item.coveredThroughItemId,
                      )}
                    </code>
                  </div>
                ) : null}
                <div className="compaction-record">
                  <h3>{i18n.t("shell:compactionRecord")}</h3>
                  <pre>{JSON.stringify(item, null, 2)}</pre>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function modelMessageRole(message: ModelMessage): string {
  if (message.role === "tool" || message.role === "tool_discovery")
    return i18n.t("shell:tool");
  if (message.role === "reasoning") return i18n.t("shell:reasoning");
  return message.role === "assistant"
    ? i18n.t("shell:assistant")
    : i18n.t("shell:user");
}

function formatModelMessage(message: ModelMessage): string {
  if (message.role === "tool_discovery")
    return JSON.stringify(message, null, 2);
  if (message.role === "reasoning") {
    return [message.summary, message.reasoningContent]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join("\n");
  }
  if (message.role === "tool") {
    return message.modelContent === undefined
      ? message.text
      : `${message.text}\n${JSON.stringify(message.modelContent, null, 2)}`;
  }
  if ("content" in message) return JSON.stringify(message.content, null, 2);
  if ("toolCalls" in message) {
    return `${message.text ?? ""}\n${JSON.stringify(message.toolCalls, null, 2)}`.trim();
  }
  return message.text;
}
