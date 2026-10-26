import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  contentFromUserMessage,
  textFromUserInput,
  type CanonicalItem,
  type ToolCallItem,
} from "../../../../../src/item.js";
import type { AttachmentRef } from "../../../../../src/attachment.js";
import type { Thread } from "../../protocol-client/index.js";
import { Dialog } from "./ui/controls.js";
import { Markdown, MessageLinkContext } from "./Markdown.js";
import { HostMessageContent } from "./HostMessageContent.js";
import {
  AttachmentImage,
  ImagePreview,
  ThreadImagesContext,
} from "./ImagePresentation.js";
import { ToolResultFallback } from "./ToolResultRenderer.js";
import { projectNativeCommandCompleted } from "./thread-view-state.js";
import {
  CanonicalMessageContent,
  MessageContextDebugAction,
  MessageContextDebugContext,
  type DebugInput,
} from "./MessageContextDebug.js";
import { ModelRequestDebugPanel } from "./ModelRequestDebugDialog.js";

type Props = {
  thread: Thread;
  items: readonly CanonicalItem[];
  localModelDebug?: boolean;
  allowOperationHistory?: boolean;
  onExit?(): void;
  onOpenMessageLink?(target: { kind: "file" | "browser"; value: string }): void;
  onReadAttachment?(attachment: AttachmentRef): Promise<Uint8Array>;
};

/** Disposable view over canonical order. Never writes Items or reconstructs transport bodies. */
export function ThreadDebugger(props: Props) {
  const { t } = useTranslation("shell");
  const [tab, setTab] = useState<"items" | "requests" | "operations">("items");
  const [page, setPage] = useState(0);
  const [requestSample, setRequestSample] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pageCount = Math.max(1, Math.ceil(props.items.length / 50));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * 50;
  const visibleItems = props.items.slice(start, start + 50);
  const go = (next: number) => {
    setPage(next);
    if (scroller.current) scroller.current.scrollTop = 0;
  };
  const [preview, setPreview] = useState<{
    attachment: AttachmentRef;
    name: string;
    trigger: HTMLButtonElement;
  } | null>(null);
  const calls = useMemo(
    () =>
      new Map(
        props.items
          .filter((item): item is ToolCallItem => item.type === "tool_call")
          .map((item) => [JSON.stringify([item.turnId, item.callId]), item]),
      ),
    [props.items],
  );
  const inspectionItems = useMemo(
    () =>
      new Map(
        props.items
          .filter((item): item is DebugInput =>
            [
              "user_message",
              "thread_message",
              "host_message",
              "context_message",
              "model_operation_completed",
            ].includes(item.type),
          )
          .map((item) => [item.id, item]),
      ),
    [props.items],
  );
  return (
    <MessageContextDebugContext.Provider
      value={{
        threadId: props.thread.id,
        items: inspectionItems,
        captureAvailable: props.localModelDebug === true,
      }}
    >
      <MessageLinkContext.Provider value={props.onOpenMessageLink ?? null}>
        <ThreadImagesContext.Provider
          value={{
            cwd: props.thread.cwd,
            attachments: {},
            read: props.onReadAttachment ?? unavailableImage,
            open: (attachment, name, trigger) =>
              setPreview({ attachment, name, trigger }),
          }}
        >
          <section className="thread-debugger" aria-label={t("debugView")}>
            <nav className="thread-debug-tabs" aria-label={t("debugView")}>
              <button
                type="button"
                aria-pressed={tab === "items"}
                onClick={() => setTab("items")}
              >
                {t("debugItems")} <span>{props.items.length}</span>
              </button>
              {props.localModelDebug ? (
                <button
                  type="button"
                  aria-pressed={tab === "requests"}
                  onClick={() => setTab("requests")}
                >
                  {t("debugRequests")}
                </button>
              ) : null}
              {props.localModelDebug &&
              props.allowOperationHistory !== false &&
              window.zenx?.modelOperationHistory ? (
                <button
                  type="button"
                  aria-pressed={tab === "operations"}
                  onClick={() => setTab("operations")}
                >
                  {t("debugOperations")}
                </button>
              ) : null}
              {props.onExit ? (
                <button
                  type="button"
                  className="thread-debug-exit"
                  onClick={props.onExit}
                >
                  {t("debugExit")}
                </button>
              ) : null}
            </nav>
            {tab === "operations" && props.localModelDebug ? (
              <OperationHistoryPanel thread={props.thread} />
            ) : tab === "requests" && props.localModelDebug ? (
              <div className="thread-debug-requests">
                <ModelRequestDebugPanel threadId={props.thread.id} />
              </div>
            ) : (
              <>
                <nav
                  className="thread-debug-paging"
                  aria-label={t("debugItemPaging")}
                >
                  <span>
                    {t("debugItemRange", {
                      start: props.items.length ? start + 1 : 0,
                      end: Math.min(start + 50, props.items.length),
                      count: props.items.length,
                    })}
                  </span>
                  <button
                    type="button"
                    disabled={currentPage === 0}
                    onClick={() => go(currentPage - 1)}
                  >
                    {t("debugPreviousItems")}
                  </button>
                  <button
                    type="button"
                    disabled={currentPage === pageCount - 1}
                    onClick={() => go(currentPage + 1)}
                  >
                    {t("debugNextItems")}
                  </button>
                </nav>
                <div className="thread-debug-items" tabIndex={0} ref={scroller}>
                  <p className="thread-debug-note">
                    {t("debugItemsNote", { count: props.items.length })}
                  </p>
                  {props.items.length === 0 ? <p>{t("debugEmpty")}</p> : null}
                  {visibleItems.map((item, index) => (
                    <article
                      className={`thread-debug-item thread-debug-item-${item.type}`}
                      key={item.id}
                      data-item-id={item.id}
                    >
                      <header>
                        <span className="thread-debug-index">
                          {start + index + 1}
                        </span>
                        <strong>{item.type}</strong>
                        <MessageContextDebugAction itemId={item.id} />
                        {props.localModelDebug && sampleForItem(item) ? (
                          <button
                            type="button"
                            className="quiet-button"
                            onClick={() =>
                              setRequestSample(sampleForItem(item)!)
                            }
                          >
                            {t("messageDebugSampleRequest")}
                          </button>
                        ) : null}
                      </header>
                      {item.type === "tool_call" ||
                      item.type === "tool_result" ? (
                        <ToolDisclosure
                          label={
                            item.type === "tool_call"
                              ? item.name
                              : (calls.get(
                                  JSON.stringify([item.turnId, item.callId]),
                                )?.name ?? item.callId)
                          }
                        >
                          <ItemContent item={item} calls={calls} {...props} />
                          <ItemImages
                            item={item}
                            onReadAttachment={props.onReadAttachment}
                            onOpen={(attachment, name, trigger) =>
                              setPreview({ attachment, name, trigger })
                            }
                          />
                        </ToolDisclosure>
                      ) : (
                        <>
                          <ItemContent item={item} calls={calls} {...props} />
                          <ItemImages
                            item={item}
                            onReadAttachment={props.onReadAttachment}
                            onOpen={(attachment, name, trigger) =>
                              setPreview({ attachment, name, trigger })
                            }
                          />
                        </>
                      )}
                      <ItemJson item={item} label={t("debugJson")} />
                    </article>
                  ))}
                </div>
              </>
            )}
            {requestSample && props.localModelDebug ? (
              <Dialog
                open
                onOpenChange={(open) => {
                  if (!open) setRequestSample(null);
                }}
                title={t("messageDebugSampleRequest")}
                className="model-debug-dialog"
              >
                <ModelRequestDebugPanel
                  key={requestSample}
                  threadId={props.thread.id}
                  sampleId={requestSample}
                  onClose={() => setRequestSample(null)}
                />
              </Dialog>
            ) : null}
            {preview && props.onReadAttachment ? (
              <ImagePreview
                {...preview}
                onReadAttachment={props.onReadAttachment}
                onClose={() => setPreview(null)}
              />
            ) : null}
          </section>
        </ThreadImagesContext.Provider>
      </MessageLinkContext.Provider>
    </MessageContextDebugContext.Provider>
  );
}

function ToolDisclosure({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="thread-debug-tool-content"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{label}</summary>
      {open ? children : null}
    </details>
  );
}

function ItemImages({
  item,
  onReadAttachment,
  onOpen,
}: {
  item: CanonicalItem;
  onReadAttachment?: Props["onReadAttachment"];
  onOpen(
    attachment: AttachmentRef,
    name: string,
    trigger: HTMLButtonElement,
  ): void;
}) {
  return onReadAttachment ? (
    <div className="message-images">
      {itemImages(item).map((attachment, n) => (
        <AttachmentImage
          key={`${attachment.sha256}-${n}`}
          attachment={attachment}
          name={`${item.type} ${n + 1}`}
          onReadAttachment={onReadAttachment}
          onOpen={onOpen}
          lazy
        />
      ))}
    </div>
  ) : null;
}

function ItemContent({
  item,
  calls,
  ...props
}: Props & { item: CanonicalItem; calls: Map<string, ToolCallItem> }) {
  const { t } = useTranslation("shell");
  switch (item.type) {
    case "model_operation":
      return (
        <div className="canonical-message-content">
          <p>{item.kind}</p>
          <pre>{JSON.stringify(item.selection, null, 2)}</pre>
          <small>
            {t("messageDebugSources")}: {item.sourceItemIds.join(", ") || "—"}
          </small>
        </div>
      );
    case "context_message":
    case "model_operation_completed":
    case "user_message":
      return <CanonicalMessageContent item={item} />;
    case "agent_message":
      return <TextContent text={item.text} />;
    case "user_message_queued":
    case "host_message_queued":
    case "thread_message_queued":
      return <TextContent text={textFromUserInput(item.input)} />;
    case "thread_message":
      return <CanonicalMessageContent item={item} />;
    case "host_message":
      return <CanonicalMessageContent item={item} />;
    case "reasoning":
      return (
        <TextContent
          text={
            item.contentVisibility === "opaque"
              ? item.summary || t("debugOpaque")
              : (item.reasoningContent ?? item.summary ?? "")
          }
        />
      );
    case "tool_call":
      return (
        <div className="thread-debug-tool">
          <strong>{item.name}</strong>
          <pre>{compactFields(item.arguments)}</pre>
        </div>
      );
    case "tool_result": {
      const call = calls.get(JSON.stringify([item.turnId, item.callId]));
      return (
        <ToolContent item={item} call={call} cwd={props.thread.cwd ?? ""} />
      );
    }
    default:
      return <p className="thread-debug-metadata">{compactFields(item)}</p>;
  }
}

function ItemJson({ item, label }: { item: CanonicalItem; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="thread-debug-json"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{label}</summary>
      {open ? <pre>{JSON.stringify(item, null, 2)}</pre> : null}
    </details>
  );
}

function itemImages(item: CanonicalItem): readonly AttachmentRef[] {
  const content =
    item.type === "user_message"
      ? contentFromUserMessage(item)
      : item.type === "tool_result"
        ? (item.modelContent ?? [])
        : item.type === "thread_message" || item.type === "context_message"
          ? item.content
          : item.type === "user_message_queued" ||
              item.type === "host_message_queued" ||
              item.type === "thread_message_queued"
            ? item.input
            : [];
  return content.flatMap((part) =>
    part.type === "image" ? [part.attachment] : [],
  );
}

async function unavailableImage(): Promise<Uint8Array> {
  throw new Error("Image reader unavailable");
}

// Do not stringify hidden object payloads merely to paint a summary.
function compactFields(value: object): string {
  const fields: string[] = [];
  for (const key in value) {
    if (
      !Object.hasOwn(value, key) ||
      ["id", "type", "threadId", "turnId", "createdAt"].includes(key)
    )
      continue;
    const field = (value as Record<string, unknown>)[key];
    const summary =
      typeof field === "string"
        ? field.slice(0, 160) + (field.length > 160 ? "…" : "")
        : field === null
          ? "null"
          : Array.isArray(field)
            ? `[${field.length} entries]`
            : typeof field === "object"
              ? "{…}"
              : String(field);
    fields.push(`${key.slice(0, 80)}: ${summary}`);
    if (fields.length === 6) break;
  }
  return fields.join(" · ");
}

const PREVIEW_CHARACTERS = 8192;
function TextContent({
  text,
  host,
}: {
  text: string;
  host?: Extract<CanonicalItem, { type: "host_message" }>;
}) {
  const { t } = useTranslation("shell");
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? text : text.slice(0, PREVIEW_CHARACTERS);
  return (
    <>
      {host ? (
        <HostMessageContent
          {...host}
          text={shown}
          truncated={shown.length < text.length}
          copyAction={false}
        />
      ) : (
        <Markdown text={shown} />
      )}
      {shown.length < text.length ? (
        <button
          className="thread-debug-more"
          type="button"
          onClick={() => setExpanded(true)}
        >
          {t("debugShowFullContent")}
        </button>
      ) : null}
    </>
  );
}
function ToolContent({
  item,
  call,
  cwd,
}: {
  item: Extract<CanonicalItem, { type: "tool_result" }>;
  call: ToolCallItem | undefined;
  cwd: string;
}) {
  const { t } = useTranslation("shell");
  const [expanded, setExpanded] = useState(false);
  const output = expanded
    ? item.output
    : item.output.slice(0, PREVIEW_CHARACTERS);
  // This is a bounded presentation projection, never a replacement canonical Item.
  const display = { ...item, output, structuredContent: undefined };
  return (
    <>
      {call ? (
        <ToolResultFallback
          item={projectNativeCommandCompleted(
            { ...call, arguments: {} },
            display,
            cwd,
          )}
        />
      ) : (
        <pre>{output}</pre>
      )}
      {item.structuredContent !== undefined ? (
        <p className="thread-debug-metadata">{t("debugStructuredInJson")}</p>
      ) : null}
      {output.length < item.output.length ? (
        <button
          className="thread-debug-more"
          type="button"
          onClick={() => setExpanded(true)}
        >
          {t("debugShowFullContent")}
        </button>
      ) : null}
    </>
  );
}

/** Only identities explicitly guaranteed by the runtime, never nearest-turn guesses. */
export function sampleForItem(item: CanonicalItem): string | undefined {
  if (item.type === "agent_message") return item.id;
  if (item.type === "model_operation") return item.id;
  if (item.type === "model_operation_completed") return item.operationItemId;
  if (item.type === "tool_call" || item.type === "model_usage")
    return item.modelResponseId;
  return undefined;
}

function OperationHistoryPanel({ thread }: { thread: Thread }) {
  const { t } = useTranslation("shell");
  const [listing, setListing] = useState<
    | import("../../main/model-operation-messages.js").HostModelOperationHistory
    | null
  >(null);
  const [selected, setSelected] = useState<{
    threadId: string;
    items: readonly CanonicalItem[];
  } | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const read = async (threadId?: string) => {
    const token = ++epoch.current;
    setBusy(true);
    setError(false);
    setSelected(null);
    try {
      const result = await window.zenx.modelOperationHistory!(threadId);
      if (token !== epoch.current) return;
      if (threadId === undefined && "summaries" in result) setListing(result);
      else if ("items" in result && result.threadId === threadId)
        setSelected(result);
      else throw new Error("Unexpected operation history identity");
    } catch {
      if (token === epoch.current) setError(true);
    } finally {
      if (token === epoch.current) setBusy(false);
    }
  };
  useEffect(() => {
    void read();
    return () => {
      epoch.current++;
    };
  }, [thread.id]);
  const metadata = selected?.items.find(
    (item) => item.type === "thread_metadata",
  );
  return (
    <section className="operation-history-panel">
      <p className="thread-debug-note">{t("debugOperationsNote")}</p>
      <button
        type="button"
        className="quiet-button"
        disabled={busy}
        onClick={() => void read()}
      >
        {t("modelDebugRefresh")}
      </button>
      {busy ? <p role="status">{t("messageDebugLoading")}</p> : null}
      {error ? <p role="alert">{t("debugOperationsUnavailable")}</p> : null}
      {listing && "summaries" in listing ? (
        <div className="message-context-debug-records">
          {listing.summaries.length === 0 ? (
            <p>{t("debugOperationsEmpty")}</p>
          ) : (
            listing.summaries.map((summary) => (
              <button
                type="button"
                className="quiet-button"
                key={summary.threadId}
                disabled={busy}
                onClick={() => void read(summary.threadId)}
              >
                {summary.name || t("debugOperationProbe")} ·{" "}
                {summary.createdAt ?? t("debugOperationsUnavailable")}
              </button>
            ))
          )}
        </div>
      ) : null}
      {selected ? (
        <ThreadDebugger
          key={selected.threadId}
          thread={
            {
              ...thread,
              id: selected.threadId,
              cwd: metadata?.type === "thread_metadata" ? metadata.cwd : "",
              turns: [],
              canonicalItems: selected.items,
            } as Thread
          }
          items={selected.items}
          localModelDebug
          allowOperationHistory={false}
          onReadAttachment={(attachment) =>
            window.zenx.imageAttachments.read(attachment)
          }
        />
      ) : null}
    </section>
  );
}
