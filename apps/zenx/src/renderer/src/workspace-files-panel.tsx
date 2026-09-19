import React, { useEffect, useRef, useState } from "react";
import type {
  WorkspaceFileListing,
  WorkspaceTextFile,
} from "../../main/workspace-files.js";
import { Markdown } from "./Markdown.js";
import { Icon } from "./icons.js";

export function WorkspaceFilesPanel({ threadId }: { threadId: string }) {
  const [directory, setDirectory] = useState(".");
  const [listing, setListing] = useState<WorkspaceFileListing>();
  const [file, setFile] = useState<WorkspaceTextFile>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    const request = ++sequence.current;
    setLoading(true);
    setError("");
    setListing(undefined);
    setFile(undefined);
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
  const read = async (path: string) => {
    const request = ++sequence.current;
    setLoading(true);
    setError("");
    setFile(undefined);
    setSource(false);
    try {
      const value = await window.zenx.workspaceFiles.read(threadId, path);
      if (request === sequence.current) setFile(value);
    } catch (reason) {
      if (request === sequence.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  };
  const markdown =
    file !== undefined && /\.(md|markdown|mdx)$/i.test(file.path);
  return (
    <section className="workspace-files-panel" aria-label="Workspace files">
      <header className="file-toolbar">
        {file ? (
          <button
            type="button"
            onClick={() => {
              sequence.current++;
              setFile(undefined);
              setError("");
              setLoading(false);
            }}
          >
            Files
          </button>
        ) : (
          <button
            type="button"
            disabled={directory === "." || loading}
            onClick={() =>
              setDirectory(
                directory.includes("/")
                  ? directory.slice(0, directory.lastIndexOf("/"))
                  : ".",
              )
            }
          >
            Up
          </button>
        )}
        <span title={file?.path ?? directory}>{file?.path ?? directory}</span>
        {markdown ? (
          <button
            type="button"
            aria-pressed={source}
            onClick={() => setSource((value) => !value)}
          >
            {source ? "Preview" : "Source"}
          </button>
        ) : null}
        <button
          type="button"
          disabled={loading}
          onClick={() =>
            file ? void read(file.path) : setRevision((value) => value + 1)
          }
        >
          Refresh
        </button>
      </header>
      <div className="file-content" aria-busy={loading}>
        {loading ? <p role="status">Loading…</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {!loading && file ? (
          <>
            <p className="file-readonly">Read-only · UTF-8</p>
            {markdown && !source ? (
              <Markdown text={file.text} />
            ) : (
              <SourcePreview text={file.text} path={file.path} />
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
                        ? setDirectory(entry.path)
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
