import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { i18n } from "./i18n.js";
import { Icon } from "./icons.js";
import type { ThreadTitleProjection } from "../../main/thread-title-types.js";

/** The title belongs to this exact Thread, independently of a PAW/Room name. */
export function ThreadTitleEditor({
  editable,
  title,
  projection,
  onRename,
  onRetry,
}: {
  editable: boolean;
  title: string;
  projection?: ThreadTitleProjection;
  onRename(title: string): Promise<void>;
  onRetry?(): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const epoch = useRef(0);
  const composing = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(
    () => () => {
      epoch.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (!editing) setDraft(title);
  }, [editing, title]);
  useLayoutEffect(() => {
    composing.current = false;
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus({ preventScroll: true });
    }
  }, [editing]);
  const finish = () => {
    restoreFocus.current = !!form.current?.contains(document.activeElement);
    epoch.current += 1;
    setEditing(false);
    setError(null);
  };
  if (editing)
    return (
      <form
        ref={form}
        className="thread-title-form"
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish();
          } else if (
            event.key === "Enter" &&
            (composing.current ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229)
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (busyRef.current || composing.current || !draft.trim()) return;
          const current = epoch.current;
          busyRef.current = true;
          setBusy(true);
          setError(null);
          void onRename(draft)
            .then(() => {
              if (current === epoch.current) finish();
            })
            .catch((reason: unknown) => {
              if (current === epoch.current)
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                );
            })
            .finally(() => {
              busyRef.current = false;
              setBusy(false);
            });
        }}
      >
        <input
          autoFocus
          aria-label={i18n.t("shell:threadTitle")}
          value={draft}
          readOnly={busy}
          aria-invalid={error ? true : undefined}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          {i18n.t("shell:save")}
        </button>
        <button type="button" onClick={finish}>
          {i18n.t("shell:cancel")}
        </button>
        {error ? <small role="alert">{error}</small> : null}
      </form>
    );
  return (
    <div className="thread-title-line">
      <strong title={title}>{title}</strong>
      {editable ? (
        <button
          ref={trigger}
          type="button"
          className="thread-title-rename"
          aria-label={i18n.t("shell:renameThreadTitle")}
          title={i18n.t("shell:renameThreadTitle")}
          onClick={() => {
            epoch.current += 1;
            setError(null);
            setEditing(true);
          }}
        >
          <Icon name="compose" size={16} />
        </button>
      ) : null}
      {editable && projection?.status === "generating" ? (
        <small>{i18n.t("shell:generatingTitle")}</small>
      ) : null}
      {editable && projection?.status === "failed" && onRetry ? (
        <button type="button" onClick={() => void onRetry()}>
          {i18n.t("shell:retryTitle")}
        </button>
      ) : null}
    </div>
  );
}
