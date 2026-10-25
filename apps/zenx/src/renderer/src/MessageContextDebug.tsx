import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CanonicalItem } from "../../../../../src/item.js";
import type { ModelRequestDebugResult } from "../../../../cli/src/model-request-debug-types.js";
import { Dialog } from "./ui/controls.js";
import { Icon } from "./icons.js";

export type DebugInput = Extract<
  CanonicalItem,
  { type: "user_message" | "thread_message" | "host_message" }
>;
export const MessageContextDebugContext = createContext<{
  threadId: string;
  items: ReadonlyMap<string, DebugInput>;
} | null>(null);

/** Experimental local-only entry; opening it never enables capture or resends input. */
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
}: {
  threadId: string;
  item: DebugInput;
  onClose(): void;
}) {
  const { t } = useTranslation("shell");
  const [state, setState] = useState<ModelRequestDebugResult | null>(null);
  const [page, setPage] = useState<ModelRequestDebugResult["page"]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const epoch = useRef(0);
  const current = useRef<ModelRequestDebugResult | null>(null);
  const close = () => {
    epoch.current++;
    onClose();
  };
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
          (source) => source.itemId === item.id,
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
  const saved =
    "content" in item && item.content !== undefined ? item.content : item.text;
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
        <pre tabIndex={0}>{JSON.stringify(saved, null, 2)}</pre>
      </section>
      <section>
        <div className="message-context-debug-heading">
          <h3>{t("messageDebugCaptured")}</h3>
          <button type="button" disabled={busy} onClick={() => void run()}>
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
                  disabled={busy}
                  onClick={() => void run(page.record.id)}
                >
                  {t("messageDebugFirst")}
                </button>
              ) : null}
              {page.nextOffset !== null ? (
                <button
                  type="button"
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
    </Dialog>
  );
}
