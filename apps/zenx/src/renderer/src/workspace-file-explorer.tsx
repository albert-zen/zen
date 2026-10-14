import React, { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WorkspaceFileListing,
  WorkspaceFileSearch,
} from "../../main/workspace-files.js";
import { Icon } from "./icons.js";
import { i18n } from "./i18n.js";

type Entry = WorkspaceFileListing["entries"][number];
type Row = Entry & {
  level: number;
  parent: string;
  position: number;
  siblings: number;
};
const MAX_VISIBLE_FILES = 2000;

/** Renderer-only discovery state; all reads remain scoped by the Host to this Thread's cwd. */
export function WorkspaceFileExplorer(props: {
  threadId: string;
  workspacePath?: string;
  selectedPath?: string;
  busy?: boolean;
  onOpen(path: string): void;
}) {
  // Discard folders, queries, focus and late responses when resource identity changes.
  return <FileExplorer key={props.threadId} {...props} />;
}

function FileExplorer({
  threadId,
  workspacePath,
  selectedPath,
  busy = false,
  onOpen,
}: {
  threadId: string;
  workspacePath?: string;
  selectedPath?: string;
  busy?: boolean;
  onOpen(path: string): void;
}) {
  useTranslation(["panels", "selector"]);
  const [query, setQuery] = useState("");
  const [folders, setFolders] = useState<Record<string, WorkspaceFileListing>>(
    {},
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState<{
    query: string;
    value?: WorkspaceFileSearch;
    error?: string;
  }>();
  const [cursor, setCursor] = useState<string>();
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const inFlight = useRef(new Set<string>());
  const searchInput = useRef<HTMLInputElement>(null);
  const tree = useRef<HTMLDivElement>(null);
  const treeId = useId();
  const needle = query.trim();
  const searchValue = search?.query === needle ? search.value : undefined;
  const searchError = search?.query === needle ? search.error : undefined;
  const searching = !!needle && !searchValue && !searchError;
  const load = async (directory: string) => {
    if (inFlight.current.has(directory)) return;
    const epoch = generation.current;
    inFlight.current.add(directory);
    setPending(new Set(inFlight.current));
    setErrors((current) => {
      const next = { ...current };
      delete next[directory];
      return next;
    });
    try {
      const value = await window.zenx.workspaceFiles.list(threadId, directory);
      if (generation.current === epoch)
        setFolders((current) => ({ ...current, [directory]: value }));
    } catch (error) {
      if (generation.current === epoch)
        setErrors((current) => ({
          ...current,
          [directory]: error instanceof Error ? error.message : String(error),
        }));
    } finally {
      if (generation.current === epoch) {
        inFlight.current.delete(directory);
        setPending(new Set(inFlight.current));
      }
    }
  };
  useEffect(() => {
    generation.current++;
    inFlight.current.clear();
    setFolders({});
    setErrors({});
    setExpanded(new Set());
    setCursor(undefined);
    void load(".");
    return () => {
      generation.current++;
    };
  }, [revision]);
  useEffect(() => {
    let active = true;
    setSearch(undefined);
    if (!needle) return;
    const timer = setTimeout(() => {
      void window.zenx.workspaceFiles.search(threadId, needle).then(
        (value) => {
          if (active) {
            setSearch({ query: needle, value });
            setCursor(undefined);
          }
        },
        (error) => {
          if (active)
            setSearch({
              query: needle,
              error: error instanceof Error ? error.message : String(error),
            });
        },
      );
    }, 180);
    // The Host scan itself is bounded (500 ms / 10,000 entries); clearing,
    // changing query, refreshing or leaving discards its stale result.
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [threadId, needle, revision]);

  useEffect(() => {
    if (!selectedPath) return;
    const segments = selectedPath.split("/");
    const parents = segments
      .slice(0, -1)
      .map((_, index) => segments.slice(0, index + 1).join("/"));
    setExpanded((current) => new Set([...current, ...parents]));
    for (const parent of parents) void load(parent);
    // Opening a file reveals its ancestors, but later manual collapse stays respected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, revision]);

  const rows: Row[] = [];
  let treeTruncated = false;
  const append = (directory: string, level: number) => {
    const entries = folders[directory]?.entries ?? [];
    for (let index = 0; index < entries.length; index++) {
      if (rows.length >= MAX_VISIBLE_FILES) {
        treeTruncated = true;
        return;
      }
      const entry = entries[index]!;
      rows.push({
        ...entry,
        level,
        parent: directory,
        position: index + 1,
        siblings: entries.length,
      });
      if (entry.kind === "directory" && expanded.has(entry.path))
        append(entry.path, level + 1);
    }
  };
  if (needle) {
    for (const [index, entry] of (searchValue?.entries ?? []).entries())
      rows.push({
        ...entry,
        kind: "file",
        level: 1,
        parent: ".",
        position: index + 1,
        siblings: searchValue!.entries.length,
      });
  } else append(".", 1);
  const currentPath = rows.some((row) => row.path === cursor)
    ? cursor
    : (rows.find((row) => row.path === selectedPath)?.path ?? rows[0]?.path);
  const focus = (value: string | undefined) => {
    if (!value) return;
    setCursor(value);
    const element = [
      ...(tree.current?.querySelectorAll<HTMLElement>("[data-file-path]") ??
        []),
    ].find((element) => element.dataset.filePath === value);
    element?.focus();
    element?.scrollIntoView({ block: "nearest" });
  };
  const toggle = (entry: Entry) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    if (!expanded.has(entry.path) && !Object.hasOwn(folders, entry.path))
      void load(entry.path);
  };
  const activate = (entry: Entry) => {
    if (busy) return;
    setCursor(entry.path);
    if (entry.kind === "directory") toggle(entry);
    else onOpen(entry.path);
  };
  const clearSearch = () => {
    setQuery("");
    setSearch(undefined);
    setCursor(undefined);
    searchInput.current?.focus();
  };
  const folderNotes = Object.entries(folders).filter(
    ([directory]) => directory === "." || expanded.has(directory),
  );
  return (
    <div
      className="workspace-file-explorer"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229 &&
          event.key.toLowerCase() === "p"
        ) {
          event.preventDefault();
          searchInput.current?.focus();
          searchInput.current?.select();
        }
      }}
    >
      <div
        className="workspace-file-actions"
        role="group"
        aria-label={i18n.t("panels:workspaceFiles")}
        title={workspacePath}
      >
        <button
          type="button"
          className="icon-button"
          aria-label={i18n.t("panels:refreshFileList")}
          title={i18n.t("panels:refreshFileList")}
          disabled={pending.has(".") || searching}
          aria-busy={pending.has(".") || searching}
          data-refreshing={pending.has(".") || searching}
          onClick={() => setRevision((value) => value + 1)}
        >
          <Icon name="reload" />
        </button>
        <div className="workspace-file-search">
          <Icon name="search" />
          <input
            ref={searchInput}
            type="search"
            value={query}
            maxLength={512}
            aria-label={i18n.t("panels:searchWorkspaceFiles")}
            aria-controls={treeId}
            placeholder={i18n.t("panels:searchFilesByNameOrPath")}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(undefined);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                clearSearch();
              } else if (event.key === "ArrowDown" && rows.length) {
                event.preventDefault();
                focus(rows[0]?.path);
              } else if (event.key === "Enter" && needle && rows[0]) {
                event.preventDefault();
                activate(rows[0]);
              }
            }}
          />
          {query ? (
            <button
              type="button"
              className="icon-button"
              aria-label={i18n.t("panels:clearFileSearch")}
              title={i18n.t("panels:clearFileSearch")}
              onClick={clearSearch}
            >
              ×
            </button>
          ) : null}
        </div>

        <button
          type="button"
          className="icon-button"
          title={i18n.t("panels:collapseFileFolders")}
          aria-label={i18n.t("panels:collapseFileFolders")}
          disabled={!!needle || expanded.size === 0}
          onClick={() => {
            setExpanded(new Set());
            setCursor(undefined);
          }}
        >
          <Icon name="collapse-folders" />
        </button>
      </div>
      <div className="workspace-file-tree-scroll">
        <div
          ref={tree}
          id={treeId}
          role="tree"
          aria-label={i18n.t(
            needle ? "panels:workspaceSearchResults" : "panels:workspaceFiles",
          )}
          aria-busy={searching || (!needle && pending.has("."))}
        >
          {rows.map((entry, index) => (
            <button
              key={entry.path}
              type="button"
              role="treeitem"
              className="workspace-file-row"
              data-file-path={entry.path}
              data-kind={entry.kind}
              data-current={entry.path === selectedPath}
              data-extension={entry.name.split(".").at(-1)?.toLowerCase()}
              style={{ paddingInlineStart: `${8 + (entry.level - 1) * 14}px` }}
              aria-label={needle ? `${entry.name}, ${entry.path}` : entry.name}
              aria-level={entry.level}
              aria-posinset={entry.position}
              aria-setsize={entry.siblings}
              aria-selected={currentPath === entry.path}
              aria-expanded={
                entry.kind === "directory"
                  ? expanded.has(entry.path)
                  : undefined
              }
              aria-busy={
                (entry.kind === "directory" && pending.has(entry.path)) ||
                undefined
              }
              tabIndex={currentPath === entry.path ? 0 : -1}
              disabled={busy}
              title={entry.path}
              onFocus={() => setCursor(entry.path)}
              onClick={() => activate(entry)}
              onKeyDown={(event) => {
                let next: string | undefined;
                if (event.key === "ArrowDown")
                  next = rows[Math.min(index + 1, rows.length - 1)]?.path;
                else if (event.key === "ArrowUp")
                  next = rows[Math.max(index - 1, 0)]?.path;
                else if (event.key === "Home") next = rows[0]?.path;
                else if (event.key === "End") next = rows.at(-1)?.path;
                else if (
                  event.key === "ArrowRight" &&
                  entry.kind === "directory"
                ) {
                  if (!expanded.has(entry.path)) toggle(entry);
                  else if (rows[index + 1]?.parent === entry.path)
                    next = rows[index + 1]?.path;
                } else if (event.key === "ArrowLeft") {
                  if (entry.kind === "directory" && expanded.has(entry.path))
                    toggle(entry);
                  else if (entry.parent !== ".") next = entry.parent;
                } else if (event.key === "Escape" && needle) {
                  clearSearch();
                } else return;
                event.preventDefault();
                event.stopPropagation();
                focus(next);
              }}
            >
              <span className="workspace-file-disclosure" aria-hidden="true">
                {entry.kind === "directory" ? (
                  <Icon
                    name={
                      expanded.has(entry.path)
                        ? "chevron-down"
                        : "chevron-right"
                    }
                  />
                ) : null}
              </span>
              <Icon name={entry.kind === "directory" ? "folder" : "file"} />
              <span className="workspace-file-label">
                <span className="workspace-file-name">
                  {entry.kind === "file" && entry.name.lastIndexOf(".") > 0 ? (
                    <>
                      <span className="workspace-file-name-prefix">
                        {entry.name.slice(0, entry.name.lastIndexOf("."))}
                      </span>
                      <span className="workspace-file-name-suffix">
                        {entry.name.slice(entry.name.lastIndexOf("."))}
                      </span>
                    </>
                  ) : (
                    entry.name
                  )}
                </span>
                {needle ? (
                  <small>
                    {entry.path.includes("/")
                      ? entry.path.slice(0, entry.path.lastIndexOf("/"))
                      : i18n.t("panels:workspace")}
                  </small>
                ) : null}
              </span>
            </button>
          ))}
        </div>
        {searching || (!needle && pending.has(".")) ? (
          <p role="status" className="workspace-file-note">
            {i18n.t(
              needle ? "panels:searchingWorkspaceFiles" : "panels:loadingFiles",
            )}
          </p>
        ) : null}
        {searchError ? (
          <p role="alert" className="workspace-file-note">
            {searchError}
          </p>
        ) : null}
        {!needle
          ? Object.entries(errors)
              .filter(
                ([directory]) => directory === "." || expanded.has(directory),
              )
              .map(([directory, error]) => (
                <p role="alert" className="workspace-file-note" key={directory}>
                  {directory}: {error}{" "}
                  <button type="button" onClick={() => void load(directory)}>
                    {i18n.t("panels:retry")}
                  </button>
                </p>
              ))
          : null}
        {!searching &&
        rows.length === 0 &&
        (searchValue || folders["."]) &&
        !searchError ? (
          <p className="workspace-file-note">
            {i18n.t(
              needle
                ? "panels:noMatchingWorkspaceFiles"
                : "panels:noFilesInThisFolder",
            )}
          </p>
        ) : null}
        {!needle
          ? folderNotes
              .filter(
                ([directory, folder]) =>
                  directory !== "." && folder.entries.length === 0,
              )
              .map(([directory]) => (
                <p key={directory} className="workspace-file-note">
                  {directory}: {i18n.t("panels:noFilesInThisFolder")}
                </p>
              ))
          : null}
        {needle && searchValue?.truncated ? (
          <p role="status" className="workspace-file-note">
            {i18n.t("selector:fileSearchPartial")}
          </p>
        ) : null}
        {!needle &&
        (treeTruncated ||
          folderNotes.some(([, folder]) => folder.truncated)) ? (
          <p role="status" className="workspace-file-note">
            {i18n.t("panels:fileTreeTruncated")}
          </p>
        ) : null}
      </div>
      {needle ? (
        <button
          type="button"
          className="workspace-file-open-path"
          disabled={busy}
          title={needle}
          onClick={() => onOpen(needle.replaceAll("\\", "/"))}
        >
          {i18n.t("panels:openEnteredFilePath")}
        </button>
      ) : null}
      <p
        className="workspace-file-search-hint"
        title={i18n.t("panels:workspaceFileSearchHint")}
      >
        {i18n.t("panels:workspaceFileSearchScope")}
      </p>
    </div>
  );
}
