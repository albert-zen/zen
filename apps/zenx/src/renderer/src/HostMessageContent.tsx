import { MessageSourceLink } from "./message-source-navigation.js";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { HostWakeupInput } from "../../../../../src/item.js";
import { Icon } from "./icons.js";
import { Markdown } from "./Markdown.js";

/** Disposable presentation only. Source authority always comes from canonical metadata. */
export function HostMessageContent({
  source,
  sourceId,
  sourceNavigation = false,
  sourceAction,
  text,
  prompt,
  copyAction = true,
  truncated = false,
  onReadingChange,
}: Pick<HostWakeupInput, "source" | "sourceId" | "text"> & {
  sourceNavigation?: boolean;
  sourceAction?: ReactNode;
  prompt?: string;
  copyAction?: boolean;
  truncated?: boolean;
  onReadingChange?(expanded: boolean): void;
}) {
  const { t } = useTranslation("shell");
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const label = t(
    source === "trigger"
      ? "hostMessageTrigger"
      : source === "room"
        ? "hostMessageRoom"
        : "hostMessageHost",
  );
  const summary = hostSummary(text, prompt);
  const welcome =
    source === "bootstrap" && !text.startsWith("[ZenX trigger wakeup]");
  const copyLabel = truncated ? "copyHostExcerpt" : "copyHostMessage";
  const copiedLabel = truncated ? "copiedHostExcerpt" : "copiedHostMessage";
  const toggle = () => {
    setExpanded(!expanded);
    onReadingChange?.(!expanded);
  };
  return (
    <div className="host-message-content">
      <header>
        <strong>
          {sourceAction ??
            (source === "trigger" && sourceNavigation ? (
              <MessageSourceLink
                target={{ kind: "trigger", id: sourceId ?? "" }}
                label={label}
                className="host-message-source"
              />
            ) : (
              <span
                className="thread-message-sender host-message-source"
                title={JSON.stringify({ source, sourceId })}
              >
                {label}
              </span>
            ))}
        </strong>
      </header>
      {welcome ? (
        <div className="host-message-welcome">
          <Markdown text={text} />
        </div>
      ) : (
        <p className="host-message-summary">
          {summary ||
            t(
              source === "trigger"
                ? "hostTriggerUpdate"
                : source === "room"
                  ? "hostRoomUpdate"
                  : "hostUpdate",
            )}
        </p>
      )}
      <button
        type="button"
        className="host-message-toggle"
        aria-label={t(
          expanded ? "hideHostMessageDetails" : "showHostMessageDetails",
        )}
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={toggle}
      >
        <Icon name="chevron-down" size={12} />
        {t(expanded ? "hideHostMessageDetails" : "showHostMessageDetails")}
      </button>
      {expanded ? (
        <div id={detailsId} className="host-message-details">
          {sourceId === undefined ? null : (
            <p className="host-message-source-id">
              {t("hostSourceId", { id: sourceId })}
            </p>
          )}
          <pre className="host-message-original">{text}</pre>
          {copyAction ? (
            <button
              type="button"
              className="host-message-copy"
              aria-label={t(copied ? copiedLabel : copyLabel)}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              <Icon name={copied ? "check" : "copy"} size={14} />
              {t(copied ? copiedLabel : copyLabel)}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Recognize only the Host builder's envelope. Unknown formats remain behind disclosure. */
function hostSummary(text: string, historyPrompt?: string): string {
  if (!text.startsWith("[ZenX trigger wakeup]\n")) return "";
  const headerEnd = text.indexOf("\n\nInjected prompt:\n");
  if (headerEnd < 0) return "";
  const header = text.slice(0, headerEnd);
  const title = /^Registered trigger: (.+)$/mu.exec(header)?.[1]?.trim();
  const promptStart = headerEnd + "\n\nInjected prompt:\n".length;
  const promptEnd = text
    .slice(promptStart)
    .search(
      /\n\n(?:Current Room message \(|Bounded source context \(|PAW context:|Reply Room ID:|Associated assistant Room IDs:)/u,
    );
  const prompt =
    historyPrompt ??
    text.slice(
      promptStart,
      promptEnd < 0 ? undefined : promptStart + promptEnd,
    );
  const excerpt = prompt.trim().replace(/\s+/gu, " ").slice(0, 180);
  return [title?.slice(0, 120), excerpt].filter(Boolean).join(" · ");
}
