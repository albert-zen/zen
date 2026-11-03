import { MessageSourceLink } from "./message-source-navigation.js";
import {
  useContext,
  useId,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ThreadReadingContext, disclosureKey } from "./thread-reading-state.js";
import { hostMessageSummary } from "./trigger-message-presentation.js";
import { useTranslation } from "react-i18next";
import type { HostWakeupInput } from "../../../../../src/item.js";
import { Icon } from "./icons.js";
import { Markdown } from "./Markdown.js";

const emptyChoices = new Map<string, boolean>();
const noSubscribe = () => () => {};
const emptySnapshot = () => emptyChoices;

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
  findItemId,
}: Pick<HostWakeupInput, "source" | "sourceId" | "text"> & {
  sourceNavigation?: boolean;
  sourceAction?: ReactNode;
  prompt?: string;
  copyAction?: boolean;
  truncated?: boolean;
  onReadingChange?(expanded: boolean): void;
  findItemId?: string;
}) {
  const { t } = useTranslation("shell");
  const detailsId = useId();
  const [localExpanded, setExpanded] = useState(false);
  const reading = useContext(ThreadReadingContext);
  const choices = useSyncExternalStore(
    findItemId && reading ? reading.subscribe : noSubscribe,
    findItemId && reading ? reading.snapshot : emptySnapshot,
    findItemId && reading ? reading.snapshot : emptySnapshot,
  );
  const findKey = findItemId ? disclosureKey("host", findItemId) : undefined;
  const expanded =
    (findKey ? choices.get(findKey) : undefined) ?? localExpanded;
  const [copied, setCopied] = useState(false);
  const label = t(
    source === "trigger"
      ? "hostMessageTrigger"
      : source === "room"
        ? "hostMessageRoom"
        : "hostMessageHost",
  );
  const summary = hostMessageSummary(text, prompt);
  const welcome =
    source === "bootstrap" && !text.startsWith("[ZenX trigger wakeup]");
  const copyLabel = truncated ? "copyHostExcerpt" : "copyHostMessage";
  const copiedLabel = truncated ? "copiedHostExcerpt" : "copiedHostMessage";
  const toggle = () => {
    setExpanded(!expanded);
    // Normal Host disclosure stays local; Find only owns a key after its explicit reveal.
    if (findKey && choices.has(findKey)) reading?.set(findKey, !expanded);
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
        <div
          className="host-message-welcome"
          data-thread-find-item-id={findItemId}
        >
          <Markdown text={text} />
        </div>
      ) : (
        <p
          className="host-message-summary"
          data-thread-find-item-id={summary ? findItemId : undefined}
          data-thread-find-field="host-summary"
        >
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
          <pre
            className="host-message-original"
            data-thread-find-item-id={findItemId}
            data-thread-find-field="host-original"
          >
            {text}
          </pre>
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
