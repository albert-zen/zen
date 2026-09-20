import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { WorkspaceFileListing } from "../../main/workspace-files.js";
import {
  WorkspaceFileDrafts,
  fileDraftKey,
  isFileDirty,
} from "./workspace-file-drafts.js";
import { InlineMarkdownEditor } from "./InlineMarkdownEditor.js";
import { Icon } from "./icons.js";

export function WorkspaceFilesPanel({
  threadId,
  drafts,
  workspacePath,
}: {
  threadId: string;
  drafts: WorkspaceFileDrafts;
  workspacePath?: string;
}) {
  const entries = useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  const [directory, setDirectory] = useState(".");
  const [listing, setListing] = useState<WorkspaceFileListing>();
  const [filePath, setFilePath] = useState<string>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [closePending, setClosePending] = useState<string>();
  const [discardPending, setDiscardPending] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [editorEpoch, setEditorEpoch] = useState(0);
  const sequence = useRef(0);
  const key =
    filePath === undefined ? undefined : fileDraftKey(threadId, filePath);
  const file = key === undefined ? undefined : entries.get(key);
  const dirty = file !== undefined && isFileDirty(file);
  const opened = [...entries.entries()].filter(
    ([key]) => JSON.parse(key)[0] === threadId,
  );
  useEffect(() => {
    const request = ++sequence.current;
    setLoading(true);
    setError("");
    setListing(undefined);
    setFilePath(undefined);
    setDiscardPending(false);
    void window.zenx.workspaceFiles
      .list(threadId, directory)
      .then(
        (value) => {
          if (request === sequence.current) setListing(value);
        },
        (reason) => {
          if (request === sequence.current)
            setError(String(reason.message ?? reason));
        },
      )
      .finally(() => {
        if (request === sequence.current) setLoading(false);
      });
    return () => {
      sequence.current++;
    };
  }, [threadId, directory, revision]);
  const read = async (path: string, reload = false) => {
    const request = ++sequence.current;
    setError("");
    setDiscardPending(false);
    const existing = drafts.snapshot().get(fileDraftKey(threadId, path));
    if (!reload && existing && (isFileDirty(existing) || existing.saving)) {
      setFilePath(path);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const value = await window.zenx.workspaceFiles.read(threadId, path);
      if (request !== sequence.current) return;
      const canonical = drafts
        .snapshot()
        .get(fileDraftKey(threadId, value.path));
      if (
        !reload &&
        canonical &&
        (isFileDirty(canonical) || canonical.saving)
      ) {
        setFilePath(value.path);
        return;
      }
      drafts.set(fileDraftKey(threadId, value.path), {
        base: value,
        text: value.text,
      });
      if (reload) setEditorEpoch((current) => current + 1);
      setFilePath(value.path);
    } catch (reason) {
      if (request === sequence.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  };
  const saver = (path: string) => (text: string, baseRevision: string) =>
    window.zenx.workspaceFiles.save(threadId, path, text, baseRevision);
  const closeFile = (path: string, confirmed = false) => {
    const targetKey = fileDraftKey(threadId, path);
    const draft = drafts.snapshot().get(targetKey);
    if (draft?.saving) return;
    if (draft && isFileDirty(draft) && !confirmed) {
      setFilePath(path);
      setClosePending(path);
      return;
    }
    drafts.remove(targetKey);
    setClosePending(undefined);
    if (filePath === path) setFilePath(undefined);
  };
  const markdown =
    file !== undefined && /\.(md|markdown|mdx)$/i.test(file.base.path);
  const crumbs = (filePath ?? directory)
    .split("/")
    .filter((value) => value !== ".");
  const browse = (path: string) => {
    setFilePath(undefined);
    setDirectory(path);
    setRevision((value) => value + 1);
  };
  return (
    <section
      className="workspace-files-panel"
      aria-label="Workspace files"
      onKeyDown={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          if (key && file) drafts.flush(key, saver(file.base.path));
        }
      }}
    >
      <nav className="file-breadcrumbs" aria-label="File path" hidden={!!file}>
        <button type="button" title={workspacePath} onClick={() => browse(".")}>
          {workspacePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace"}
        </button>
        {crumbs.map((name, index) => (
          <React.Fragment key={index}>
            <span aria-hidden="true">/</span>
            <button
              type="button"
              title={crumbs.slice(0, index + 1).join("/")}
              disabled={!!filePath && index === crumbs.length - 1}
              onClick={() => browse(crumbs.slice(0, index + 1).join("/"))}
            >
              {name}
            </button>
          </React.Fragment>
        ))}
      </nav>
      <form
        hidden={!!file}
        className="file-path-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (pathInput.trim())
            void read(pathInput.trim().replaceAll("\\", "/"));
        }}
      >
        <input
          aria-label="Open workspace-relative file path"
          placeholder="Open file by relative path…"
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
        />
        <button type="submit" disabled={!pathInput.trim()}>
          Open
        </button>
      </form>
      {opened.length > 0 ? (
        <div className="file-open-tabs" role="tablist" aria-label="Open files">
          {opened.map(([entryKey, draft], index) => (
            <span className="file-open-tab" key={entryKey}>
              <button
                tabIndex={
                  filePath === draft.base.path || (!filePath && index === 0)
                    ? 0
                    : -1
                }
                onKeyDown={(event) => {
                  const next =
                    event.key === "ArrowRight"
                      ? (index + 1) % opened.length
                      : event.key === "ArrowLeft"
                        ? (index + opened.length - 1) % opened.length
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? opened.length - 1
                            : -1;
                  if (next < 0) return;
                  event.preventDefault();
                  void read(opened[next]![1].base.path);
                  document
                    .querySelectorAll<HTMLButtonElement>(
                      '.file-open-tabs [role="tab"]',
                    )
                    [next]?.focus();
                }}
                type="button"
                role="tab"
                aria-selected={filePath === draft.base.path}
                title={draft.base.path}
                onClick={() => void read(draft.base.path)}
              >
                {draft.base.path.split("/").at(-1)}
                {isFileDirty(draft) ? " •" : ""}
              </button>
              <button
                type="button"
                aria-label={`Close file ${draft.base.path}`}
                disabled={draft.saving}
                onClick={() => closeFile(draft.base.path)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <header className="file-toolbar">
        <button
          type="button"
          disabled={loading}
          onClick={() =>
            file
              ? (setFilePath(undefined), setError(""), setDiscardPending(false))
              : browse(
                  directory.includes("/")
                    ? directory.slice(0, directory.lastIndexOf("/"))
                    : ".",
                )
          }
        >
          {file ? "Files" : "Up"}
        </button>
        <span title={filePath ?? directory}>{file ? null : directory}</span>
        <button
          type="button"
          disabled={loading || file?.saving}
          onClick={() =>
            file
              ? dirty
                ? setDiscardPending(true)
                : void read(file.base.path, true)
              : setRevision((value) => value + 1)
          }
        >
          Refresh
        </button>
      </header>
      {closePending ? (
        <div role="alert" className="file-discard">
          Discard changes and close {closePending}?
          <button type="button" onClick={() => closeFile(closePending, true)}>
            Discard and close
          </button>
          <button type="button" onClick={() => setClosePending(undefined)}>
            Keep editing
          </button>
        </div>
      ) : null}
      <div className="file-content" aria-busy={loading}>
        {loading ? <p role="status">Loading…</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {!loading && file ? (
          <>
            <p className="file-save-status" role="status">
              {file.saving
                ? "Saving…"
                : file.conflict
                  ? "Save conflict"
                  : file.error
                    ? "Save failed"
                    : dirty
                      ? "Waiting to save…"
                      : "Saved"}{" "}
              · UTF-8
            </p>
            {file.error ? (
              <div className="file-save-error" role="alert">
                <span>{file.error}</span>
                {!file.conflict ? (
                  <button
                    type="button"
                    onClick={() => drafts.flush(key!, saver(file.base.path))}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            ) : null}
            {file.conflict ? (
              <div className="file-conflict">
                <details>
                  <summary>Compare disk version</summary>
                  <SourcePreview
                    text={file.conflict.text}
                    path={file.base.path}
                  />
                </details>
                <button type="button" onClick={() => setDiscardPending(true)}>
                  Reload disk version
                </button>
              </div>
            ) : null}
            {discardPending ? (
              <div role="alert" className="file-discard">
                Discard your unsaved changes and load the disk version?
                <button
                  type="button"
                  onClick={() => void read(file.base.path, true)}
                >
                  Discard and reload
                </button>
                <button type="button" onClick={() => setDiscardPending(false)}>
                  Keep editing
                </button>
              </div>
            ) : null}
            {markdown ? (
              <InlineMarkdownEditor
                key={`${file.base.path}:${editorEpoch}`}
                path={file.base.path}
                text={file.text}
                onChange={(text) =>
                  drafts.edit(key!, text, saver(file.base.path))
                }
              />
            ) : (
              <textarea
                className="file-editor"
                aria-label={`Edit ${file.base.path}`}
                spellCheck={false}
                value={file.text}
                onChange={(event) => {
                  const text = file.base.text.includes("\r\n")
                    ? event.target.value.replace(/\r?\n/g, "\r\n")
                    : event.target.value;
                  drafts.edit(key!, text, saver(file.base.path));
                }}
              />
            )}
          </>
        ) : null}
        {!loading && !file && listing ? (
          <>
            <ul className="file-list">
              {listing.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() =>
                      entry.kind === "directory"
                        ? browse(entry.path)
                        : void read(entry.path)
                    }
                  >
                    <Icon
                      name={entry.kind === "directory" ? "folder" : "file"}
                    />
                    <span>{entry.name}</span>
                    {entry.kind === "directory" ? (
                      <span aria-hidden="true">›</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
            {listing.entries.length === 0 ? (
              <p>This directory is empty.</p>
            ) : null}
            {listing.truncated ? (
              <p role="status">
                Showing the first 2,000 entries. Open a subdirectory to browse
                further.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

// Highlight only common code tokens; React escapes every token, including HTML source.
export function SourcePreview({ text, path }: { text: string; path: string }) {
  const code =
    /\.(?:[cm]?[jt]sx?|json|css|py|sh|ya?ml|toml|rs|go|java|c|cpp|h)$/i.test(
      path,
    );
  const parts =
    code && text.length <= 100_000
      ? text.split(
          /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|#[^\n]*|\b(?:const|let|var|function|return|import|from|export|class|if|else|for|while|async|await|true|false|null|def|self|pub|fn|use)\b|\b\d+(?:\.\d+)?\b)/g,
        )
      : [text];
  return (
    <pre className="file-source" tabIndex={0} aria-label={`Source of ${path}`}>
      <code>
        {parts.map((part, index) =>
          index % 2 ? (
            <span
              key={index}
              className={
                /^["']/.test(part)
                  ? "syntax-string"
                  : /^(\/\/|#)/.test(part)
                    ? "syntax-comment"
                    : /^\d/.test(part)
                      ? "syntax-number"
                      : "syntax-keyword"
              }
            >
              {part}
            </span>
          ) : (
            part
          ),
        )}
      </code>
    </pre>
  );
}
