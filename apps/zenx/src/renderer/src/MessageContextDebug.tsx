import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CanonicalItem } from "../../../../../src/item.js";
import type { ModelRequestDebugResult } from "../../../../cli/src/model-request-debug-types.js";
import { Dialog } from "./ui/controls.js";
import { Icon } from "./icons.js";

export type DebugInput = Extract<
  CanonicalItem,
  {
    type:
      | "user_message"
      | "thread_message"
      | "host_message"
      | "context_message"
      | "model_operation_completed";
  }
>;
export const MessageContextDebugContext = createContext<{
  threadId: string;
  items: ReadonlyMap<string, DebugInput>;
  captureAvailable?: boolean;
} | null>(null);

/** Canonical history inspection; transport observations are a separate opt-in layer. */
export function MessageContextDebugAction({ itemId }: { itemId: string }) {
  const owner = useContext(MessageContextDebugContext);
  const { t } = useTranslation("shell");
  const [open, setOpen] = useState(false);
  const item = owner?.items.get(itemId);
  if (!owner || !item) return null;
  return (
    <>
      <button
        className="message-copy"
        type="button"
        aria-label={t("messageDebugOpen")}
        title={t("messageDebugOpen")}
        onClick={() => setOpen(true)}
      >
        <Icon name="terminal" size={14} />
      </button>
      {open ? (
        <MessageContextDebugDialog
          key={`${owner.threadId}:${itemId}`}
          threadId={owner.threadId}
          item={item}
          captureAvailable={owner.captureAvailable === true}
          relatedItems={[...owner.items.values()].filter(
            (candidate) =>
              candidate.type === "context_message" &&
              candidate.sourceItemIds.includes(item.id),
          )}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

export function MessageContextDebugDialog({
  threadId,
  item,
  onClose,
  captureAvailable = false,
  relatedItems = [],
}: {
  threadId: string;
  item: DebugInput;
  captureAvailable?: boolean;
  relatedItems?: DebugInput[];
  onClose(): void;
}) {
  const { t } = useTranslation("shell");
  const [showCapture, setShowCapture] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const close = onClose;
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) close();
      }}
      title={t("messageDebugTitle")}
      className="message-context-debug"
    >
      <header>
        <div>
          <small>{t("messageDebugExperiment")}</small>
          <h2>{t("messageDebugTitle")}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t("messageDebugClose")}
          onClick={close}
        >
          <Icon name="x" />
        </button>
      </header>
      <p className="message-context-debug-note">{t("messageDebugScope")}</p>
      <section>
        <h3>{t("messageDebugSaved")}</h3>
        <p>{t("messageDebugSavedNote")}</p>
        <CanonicalMessageContent item={item} />
        <details
          className="message-context-debug-raw"
          onToggle={(event) => setRawOpen(event.currentTarget.open)}
        >
          <summary>{t("debugJson")}</summary>
          {rawOpen ? (
            <pre tabIndex={0}>{JSON.stringify(item, null, 2)}</pre>
          ) : null}
        </details>
      </section>
      {relatedItems.length ? (
        <section>
          <h3>{t("messageDebugRelated")}</h3>
          {relatedItems.map((related) => (
            <RelatedCanonicalItem key={related.id} item={related} />
          ))}
        </section>
      ) : null}
      {captureAvailable ? (
        <details onToggle={(event) => setShowCapture(event.currentTarget.open)}>
          <summary>{t("messageDebugCaptured")}</summary>
          {showCapture ? (
            <MessageCapture item={item} threadId={threadId} />
          ) : null}
        </details>
      ) : null}
    </Dialog>
  );
}

function MessageCapture({
  item,
  threadId,
}: {
  item: DebugInput;
  threadId: string;
}) {
  const { t } = useTranslation("shell");
  const [state, setState] = useState<ModelRequestDebugResult | null>(null);
  const [page, setPage] = useState<ModelRequestDebugResult["page"]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const epoch = useRef(0);
  const current = useRef<ModelRequestDebugResult | null>(null);
  const run = async (id?: string, offset = 0) => {
    const version = ++epoch.current;
    setBusy(true);
    setError(false);
    setPage(undefined);
    try {
      const result = await window.zenx.modelRequestDebug!.request(
        id === undefined
          ? { action: "list", threadId, itemId: item.id }
          : { action: "read", id, view: "message", itemId: item.id, offset },
      );
      if (version !== epoch.current) return;
      const sameSession =
        current.current?.sessionId === result.sessionId &&
        current.current.generation === result.generation;
      const next = {
        ...result,
        records:
          result.records ?? (sameSession ? current.current?.records : []),
      };
      current.current = next;
      setState(next);
      if (
        result.page &&
        sameSession &&
        result.page.record.threadId === threadId &&
        result.page.record.messageSources?.some(
          (source) =>
            source.itemId === item.id ||
            source.sourceItemIds?.includes(item.id),
        )
      )
        setPage(result.page);
    } catch {
      if (version === epoch.current) setError(true);
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  };
  useEffect(() => {
    void run();
    return () => {
      epoch.current++;
    };
  }, [threadId, item.id]);
  useEffect(() => {
    let active = true;
    const timer = setInterval(() => {
      void window.zenx
        .modelRequestDebug!.request({ action: "status" })
        .then((result) => {
          if (!active) return;
          if (
            current.current &&
            (current.current.sessionId !== result.sessionId ||
              current.current.generation !== result.generation)
          ) {
            epoch.current++;
            current.current = result;
            setState(result);
            setPage(undefined);
            setBusy(false);
          }
        })
        .catch(() => {
          if (active) {
            epoch.current++;
            setPage(undefined);
            setState(null);
            setError(true);
            setBusy(false);
          }
        });
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [threadId, item.id]);
  return (
    <section>
      <div className="message-context-debug-heading">
        <h3>{t("messageDebugCaptured")}</h3>
        <button
          className="quiet-button"
          type="button"
          disabled={busy}
          onClick={() => void run()}
        >
          {t("modelDebugRefresh")}
        </button>
      </div>
      <p>{t("messageDebugCaptureNote")}</p>
      {error ? <p role="alert">{t("messageDebugUnavailable")}</p> : null}
      {busy ? <p role="status">{t("messageDebugLoading")}</p> : null}
      {state && !state.enabled ? <p>{t("messageDebugOff")}</p> : null}
      {state?.enabled && !state.records?.length ? (
        <p>{t("messageDebugNoCapture")}</p>
      ) : null}
      <div className="message-context-debug-records">
        {state?.records?.map((record) => (
          <button
            type="button"
            className="quiet-button"
            key={record.id}
            disabled={busy || record.truncated}
            aria-pressed={page?.record.id === record.id}
            onClick={() => void run(record.id)}
          >
            {record.model} · {record.capturedAt} · #{record.sampleAttempt}/
            {record.transportAttempt}
            {record.redacted ? ` · ${t("messageDebugRedacted")}` : ""}
            {record.truncated ? ` · ${t("messageDebugTruncated")}` : ""}
          </button>
        ))}
      </div>
      {page ? (
        <>
          <p className="message-context-debug-note">
            {t(
              page.record.redacted
                ? "messageDebugRedactedNote"
                : "messageDebugObservedNote",
            )}
          </p>
          <pre tabIndex={0}>{page.text}</pre>
          <div className="message-context-debug-heading">
            <span>
              {t("messageDebugPage", {
                start: page.offset + 1,
                end: page.offset + page.text.length,
                total: page.totalCharacters,
              })}
            </span>
            {page.offset > 0 ? (
              <button
                type="button"
                className="quiet-button"
                disabled={busy}
                onClick={() => void run(page.record.id)}
              >
                {t("messageDebugFirst")}
              </button>
            ) : null}
            {page.nextOffset !== null ? (
              <button
                type="button"
                className="quiet-button"
                disabled={busy}
                onClick={() => void run(page.record.id, page.nextOffset!)}
              >
                {t("messageDebugNext")}
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** Display saved text parts literally; never derive missing text from metadata. */
export function CanonicalMessageContent({ item }: { item: DebugInput }) {
  const { t } = useTranslation("shell");
  const parts =
    "content" in item && Array.isArray(item.content) ? item.content : null;
  return (
    <div className="canonical-message-content">
      <dl className="message-context-debug-source">
        <dt>{t("messageDebugItemType")}</dt>
        <dd>{item.type}</dd>
        <dt>{t("messageDebugRecordedAt")}</dt>
        <dd>{item.createdAt}</dd>
      </dl>
      {item.type === "context_message" ? (
        <dl className="message-context-debug-source">
          <dt>{t("messageDebugOrigin")}</dt>
          <dd>
            {item.origin} · {item.role} · {item.purpose}
          </dd>
          <dt>{t("messageDebugSources")}</dt>
          <dd>{item.sourceItemIds.join(", ")}</dd>
        </dl>
      ) : null}
      {item.type === "model_operation_completed" ? (
        <p>
          {item.status}
          {item.incomplete ? " · incomplete" : ""}
          {item.error
            ? ` · ${t("messageDebugHostDiagnostic")}: ${item.error}`
            : ""}
        </p>
      ) : null}
      {(!parts && item.type !== "model_operation_completed") ||
      (item.type === "user_message" && item.contentAuthority === undefined) ? (
        <p>{t("messageDebugLegacy")}</p>
      ) : null}
      {parts ? (
        parts.map((part, index) => (
          <div key={index} className="canonical-message-part">
            <small>
              content[{index}] · {part.type}
              {item.type === "user_message" &&
              item.contentAuthority?.hostTextPartIndices.includes(index)
                ? ` · ${t("messageDebugHostPart")}`
                : ""}
            </small>
            {part.type === "text" ? (
              <pre tabIndex={0}>{part.text}</pre>
            ) : (
              <pre tabIndex={0}>{JSON.stringify(part, null, 2)}</pre>
            )}
            {part.type === "text" &&
            Object.keys(part).some(
              (key) => key !== "type" && key !== "text",
            ) ? (
              <details>
                <summary>{t("messageDebugPartSource")}</summary>
                <pre>
                  {JSON.stringify(
                    Object.fromEntries(
                      Object.entries(part).filter(([key]) => key !== "text"),
                    ),
                    null,
                    2,
                  )}
                </pre>
              </details>
            ) : null}
          </div>
        ))
      ) : (
        <pre tabIndex={0}>{"text" in item ? item.text : ""}</pre>
      )}
    </div>
  );
}

function RelatedCanonicalItem({ item }: { item: DebugInput }) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation("shell");
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {item.type} · {item.id}
      </summary>
      {open ? (
        <>
          <CanonicalMessageContent item={item} />
          <details>
            <summary>{t("debugJson")}</summary>
            <pre>{JSON.stringify(item, null, 2)}</pre>
          </details>
        </>
      ) : null}
    </details>
  );
}
