import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import React, { useEffect, useState } from "react";
import type { WorkspaceFileListing } from "../../main/workspace-files.js";
import { Icon } from "./icons.js";

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
  const [directory, setDirectory] = useState(".");
  const [listing, setListing] = useState<WorkspaceFileListing>();
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setListing(undefined);
    setError("");
    void window.zenx.workspaceFiles.list(threadId, directory).then(
      (value) => {
        if (active) setListing(value);
      },
      (reason) => {
        if (active) setError(String(reason.message ?? reason));
      },
    );
    return () => {
      active = false;
    };
  }, [threadId, directory]);
  const open = async (value: string) => {
    setBusy(true);
    setError("");
    try {
      await onOpen(value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
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
          onClick={onBack}
        >
          <Icon name="chevron-left" />
        </button>
        <span>{i18n.t("panels:openAFile")}</span>
      </div>
      <form
        className="file-path-form"
        onSubmit={(event) => {
          event.preventDefault();
          void open(path);
        }}
      >
        <input
          aria-label={i18n.t("panels:filePath")}
          placeholder={i18n.t("panels:filePathRelativeToThisWorkspace")}
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        <button disabled={!path.trim() || busy}>{i18n.t("panels:open")}</button>
      </form>
      <nav
        className="file-breadcrumbs"
        aria-label={i18n.t("panels:fileLocation")}
      >
        <button
          type="button"
          disabled={directory === "."}
          onClick={() => setDirectory(".")}
        >
          {i18n.t("panels:workspace")}
        </button>
        {directory !== "." ? (
          <>
            <span>/ {directory}</span>
            <button
              type="button"
              onClick={() =>
                setDirectory(directory.split("/").slice(0, -1).join("/") || ".")
              }
            >
              {i18n.t("panels:up")}
            </button>
          </>
        ) : null}
      </nav>
      {error ? (
        <p role="alert" className="browser-ui-error">
          {error}
        </p>
      ) : null}
      <div className="file-list">
        {!listing && !error ? <p>{i18n.t("panels:loadingFiles")}</p> : null}
        {listing?.entries.map((entry) => (
          <button
            type="button"
            key={entry.path}
            disabled={busy}
            onClick={() =>
              entry.kind === "directory"
                ? setDirectory(entry.path)
                : void open(entry.path)
            }
          >
            <Icon name={entry.kind === "directory" ? "folder" : "file"} />
            <span>{entry.name}</span>
          </button>
        ))}
        {listing?.entries.length === 0 ? (
          <p>{i18n.t("panels:noFilesInThisFolder")}</p>
        ) : null}
        {listing?.truncated ? (
          <p>{i18n.t("panels:someEntriesAreOmittedEnterAFile")}</p>
        ) : null}
      </div>
    </section>
  );
}
