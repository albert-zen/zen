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
    <section className="workspace-file-picker" aria-label="Choose a file">
      <div className="workspace-picker-heading">
        <button
          type="button"
          className="icon-button"
          aria-label="Back to tab types"
          onClick={onBack}
        >
          <Icon name="chevron-left" />
        </button>
        <span>Open a file</span>
      </div>
      <form
        className="file-path-form"
        onSubmit={(event) => {
          event.preventDefault();
          void open(path);
        }}
      >
        <input
          aria-label="File path"
          placeholder="File path relative to this workspace"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        <button disabled={!path.trim() || busy}>Open</button>
      </form>
      <nav className="file-breadcrumbs" aria-label="File location">
        <button
          type="button"
          disabled={directory === "."}
          onClick={() => setDirectory(".")}
        >
          Workspace
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
              Up
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
        {!listing && !error ? <p>Loading files…</p> : null}
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
        {listing?.entries.length === 0 ? <p>No files in this folder.</p> : null}
        {listing?.truncated ? (
          <p>Some entries are omitted. Enter a file path above to open it.</p>
        ) : null}
      </div>
    </section>
  );
}
