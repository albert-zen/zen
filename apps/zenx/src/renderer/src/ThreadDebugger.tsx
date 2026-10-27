import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ContextItem } from "../../../../../src/item-list.js";
import type { UserInput } from "../../../../../src/item.js";
import type { AttachmentRef } from "../../../../../src/attachment.js";
import type { Thread } from "../../protocol-client/index.js";
import { Markdown, MessageLinkContext } from "./Markdown.js";
import {
  AttachmentImage,
  ImagePreview,
  ThreadImagesContext,
} from "./ImagePresentation.js";
import { ModelRequestDebugPanel } from "./ModelRequestDebugDialog.js";
type Props = {
  thread: Thread;
  items?: readonly ContextItem[];
  localModelDebug?: boolean;
  currentSettings?: unknown;
  onExit?(): void;
  onOpenMessageLink?(target: { kind: "file" | "browser"; value: string }): void;
  onReadAttachment?(attachment: AttachmentRef): Promise<Uint8Array>;
};
/** Semantic context only. Legacy source/queue/control facts are not additional prompt Items. */
export function ThreadDebugger(props: Props) {
  const { t } = useTranslation("shell");
  const items = props.items ?? [];
  const [tab, setTab] = useState<"items" | "requests">("items");
  const [page, setPage] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const pageCount = Math.max(1, Math.ceil(items.length / 50));
  const currentPage = Math.min(page, pageCount - 1),
    start = currentPage * 50;
  const go = (next: number) => {
    setPage(next);
    if (scroller.current) scroller.current.scrollTop = 0;
  };
  const [preview, setPreview] = useState<{
    attachment: AttachmentRef;
    name: string;
    trigger: HTMLButtonElement;
  } | null>(null);
  return (
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
              {t("debugItems")} <span>{items.length}</span>
            </button>
            {props.localModelDebug && (
              <button
                type="button"
                aria-pressed={tab === "requests"}
                onClick={() => setTab("requests")}
              >
                {t("debugRequests")}
              </button>
            )}
            {props.onExit && (
              <button
                type="button"
                className="thread-debug-exit"
                onClick={props.onExit}
              >
                {t("debugExit")}
              </button>
            )}
          </nav>
          {tab === "requests" && props.localModelDebug ? (
            <div className="thread-debug-requests">
              <ModelRequestDebugPanel
                threadId={props.thread.id}
                currentSettings={props.currentSettings}
              />
            </div>
          ) : (
            <>
              <nav
                className="thread-debug-paging"
                aria-label={t("debugItemPaging")}
              >
                <span>
                  {t("debugItemRange", {
                    start: items.length ? start + 1 : 0,
                    end: Math.min(start + 50, items.length),
                    count: items.length,
                  })}
                </span>
                <button
                  disabled={currentPage === 0}
                  onClick={() => go(currentPage - 1)}
                >
                  {t("debugPreviousItems")}
                </button>
                <button
                  disabled={currentPage === pageCount - 1}
                  onClick={() => go(currentPage + 1)}
                >
                  {t("debugNextItems")}
                </button>
              </nav>
              <div className="thread-debug-items" tabIndex={0} ref={scroller}>
                <p className="thread-debug-note">
                  {t("debugItemsNote", { count: items.length })}
                </p>
                {props.items === undefined ? (
                  <p>{t("debugSemanticUnavailable")}</p>
                ) : (
                  !items.length && <p>{t("debugEmpty")}</p>
                )}
                {items.slice(start, start + 50).map((item, index) => (
                  <article
                    key={item.id}
                    className={`thread-debug-item thread-debug-item-${item.kind}`}
                    data-item-id={item.id}
                  >
                    <header>
                      <span className="thread-debug-index">
                        {start + index + 1}
                      </span>
                      <strong>{item.kind}</strong>
                      <span>{item.role}</span>
                      <span>{item.source.kind}</span>
                    </header>
                    {item.kind === "tool_call" ||
                    item.kind === "tool_result" ||
                    item.kind === "tools" ? (
                      <ToolDisclosure
                        label={
                          item.kind === "tool_call"
                            ? item.content.name
                            : item.kind === "tools"
                              ? `tools (${item.content.tools.length})`
                              : "tool result"
                        }
                      >
                        <SemanticContent item={item} />
                      </ToolDisclosure>
                    ) : (
                      <SemanticContent item={item} />
                    )}
                    {props.onReadAttachment && (
                      <div className="message-images">
                        {parts(item)
                          .flatMap((p) =>
                            p.type === "image" ? [p.attachment] : [],
                          )
                          .map((attachment, n) => (
                            <AttachmentImage
                              key={`${attachment.sha256}-${n}`}
                              attachment={attachment}
                              name={`${item.kind} ${n + 1}`}
                              onReadAttachment={props.onReadAttachment!}
                              onOpen={(attachment, name, trigger) =>
                                setPreview({ attachment, name, trigger })
                              }
                              lazy
                            />
                          ))}
                      </div>
                    )}
                    <ItemJson item={item} label={t("debugJson")} />
                  </article>
                ))}
              </div>
            </>
          )}
          {preview && props.onReadAttachment && (
            <ImagePreview
              {...preview}
              onReadAttachment={props.onReadAttachment}
              onClose={() => setPreview(null)}
            />
          )}
        </section>
      </ThreadImagesContext.Provider>
    </MessageLinkContext.Provider>
  );
}
function parts(item: ContextItem): UserInput {
  return item.kind === "message" || item.kind === "tool_result"
    ? (item.content.parts ?? [])
    : [];
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
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>{label}</summary>
      {open ? children : null}
    </details>
  );
}
function ItemJson({ item, label }: { item: ContextItem; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="thread-debug-json"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>{label}</summary>
      {open && <pre>{JSON.stringify(item, null, 2)}</pre>}
    </details>
  );
}
function SemanticContent({ item }: { item: ContextItem }) {
  const { t } = useTranslation("shell");
  switch (item.kind) {
    case "message":
      return <MessageContent item={item} />;
    case "reasoning":
      return (
        <TextContent
          text={
            item.content.visibility === "opaque"
              ? item.content.summary || t("debugOpaque")
              : item.content.text
          }
        />
      );
    case "selection":
      return <TextContent text={item.content.text} />;
    case "tool_call":
      return (
        <div className="thread-debug-tool">
          <strong>{item.content.name}</strong>
          <TextContent
            text={JSON.stringify(item.content.arguments, null, 2)}
            raw
          />
        </div>
      );
    case "tool_result":
      return (
        <div className="thread-debug-tool-output">
          <TextContent text={item.content.text} raw />
        </div>
      );
    case "tools":
      return (
        <TextContent text={JSON.stringify(item.content.tools, null, 2)} raw />
      );
  }
}
/** Only trusted source provenance, never a user-authored lookalike prefix, enables time presentation. */
function MessageContent({
  item,
}: {
  item: Extract<ContextItem, { kind: "message" }>;
}) {
  const first = item.content.parts[0];
  const match =
    item.source.kind === "user_message" &&
    item.source.metadata?.bodyStart === 1 &&
    first?.type === "text"
      ? /^\[Message received at (.+)\]$/u.exec(first.text)
      : null;
  if (match && Number.isFinite(Date.parse(match[1]!))) {
    const rest = item.content.parts
      .slice(1)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return (
      <>
        <details className="thread-debug-time">
          <summary>
            <time dateTime={match[1]}>
              {new Date(match[1]!).toLocaleString()}
            </time>
          </summary>
          <pre>{first!.type === "text" ? first.text : ""}</pre>
        </details>
        <TextContent text={rest} />
      </>
    );
  }
  return <TextContent text={item.content.text} />;
}
function TextContent({ text, raw = false }: { text: string; raw?: boolean }) {
  const { t } = useTranslation("shell");
  const [expanded, setExpanded] = useState(false),
    shown = expanded ? text : text.slice(0, 8192);
  return (
    <>
      {raw ? <pre>{shown}</pre> : <Markdown text={shown} />}
      {shown.length < text.length && (
        <button
          type="button"
          className="thread-debug-more"
          onClick={() => setExpanded(true)}
        >
          {t("debugShowFullContent")}
        </button>
      )}
    </>
  );
}
async function unavailableImage(): Promise<Uint8Array> {
  throw new Error("Image reader unavailable");
}
