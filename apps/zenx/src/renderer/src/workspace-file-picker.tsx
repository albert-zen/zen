import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.js";
import { WorkspaceFileExplorer } from "./workspace-file-explorer.js";

export function WorkspaceFilePicker({
  threadId,
  onOpen,
  onBack,
}: {
  threadId: string;
  onOpen(path: string): Promise<void>;
  onBack(): void;
}) {
  useTranslation("panels");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    setError("");
    setBusy(false);
    return () => {
      epoch.current++;
    };
  }, [threadId]);
  const open = async (value: string) => {
    if (busy) return;
    const current = ++epoch.current;
    setBusy(true);
    setError("");
    try {
      await onOpen(value);
    } catch (reason) {
      if (current === epoch.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  };
  return (
    <section
      className="workspace-file-picker"
      aria-label={i18n.t("panels:chooseAFile")}
    >
      <div className="workspace-picker-heading">
        <button
          type="button"
          className="icon-button"
          aria-label={i18n.t("panels:backToTabTypes")}
          onClick={() => {
            epoch.current++;
            onBack();
          }}
        >
          <Icon name="chevron-left" />
        </button>
        <span>{i18n.t("panels:openAFile")}</span>
      </div>
      {error ? (
        <p role="alert" className="browser-ui-error">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="workspace-file-note">
          {i18n.t("panels:loading")}
        </p>
      ) : null}
      <WorkspaceFileExplorer
        threadId={threadId}
        busy={busy}
        onOpen={(path) => void open(path)}
      />
    </section>
  );
}
