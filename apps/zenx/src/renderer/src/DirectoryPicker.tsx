import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { Dialog } from "./ui/controls.js";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type {
  DirectoryBrowserSnapshot,
  DirectoryListing,
} from "../../main/directory-browser.js";
import { Icon } from "./icons.js";

interface DirectoryPickerSettingsApi {
  getDirectoryBrowser(): Promise<DirectoryBrowserSnapshot>;
  listDirectory(directory: string): Promise<DirectoryListing>;
}

function directorySettings(): DirectoryPickerSettingsApi {
  return (
    window as unknown as { zenx: { settings: DirectoryPickerSettingsApi } }
  ).zenx.settings;
}

export function DirectoryPicker({
  onCancel,
  onSelect,
}: {
  onCancel(): void;
  onSelect(directory: string): void;
}) {
  useTranslation("shell");
  const [snapshot, setSnapshot] = useState<DirectoryBrowserSnapshot | null>(
    null,
  );
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const requestEpoch = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const initialFocus = useRef(true);
  const focusChanges = useRef(0);

  const dismissed = useRef(false);

  const cancel = () => {
    dismissed.current = true;
    requestEpoch.current += 1;
    onCancel();
  };

  const open = async (directory?: string) => {
    if (dismissed.current) return;
    const epoch = ++requestEpoch.current;
    // Keep a stable focus target while rows disappear. Completion may move
    // focus only if the user is still in this browser, not on another control.
    listRef.current?.focus();
    setLoading(true);
    setError(null);
    setFailedPath(null);
    let path = directory;
    try {
      if (path === undefined) {
        const result = await directorySettings().getDirectoryBrowser();
        if (requestEpoch.current !== epoch) return;
        setSnapshot(result);
        path = result.initialPath;
      }
      const result = await directorySettings().listDirectory(path);
      if (requestEpoch.current !== epoch) return;
      setListing(result);
      setActiveIndex(0);
    } catch (caught) {
      if (requestEpoch.current !== epoch) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setFailedPath(path ?? null);
    } finally {
      if (requestEpoch.current === epoch) setLoading(false);
    }
  };

  useEffect(() => {
    dismissed.current = false;
    void open();
    return () => {
      dismissed.current = true;
      requestEpoch.current += 1;
    };
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (loading || !list) return;
    const mayFocus =
      list.contains(document.activeElement) ||
      (initialFocus.current && focusChanges.current <= 1);
    initialFocus.current = false;
    if (!mayFocus) return;
    (
      list.querySelector<HTMLButtonElement>(
        error === null ? `[data-index="${activeIndex}"]` : "button",
      ) ?? list
    ).focus();
  }, [activeIndex, listing, loading, error]);

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count =
      loading || error !== null ? 0 : (listing?.directories.length ?? 0);
    if (event.key === "ArrowDown" && count > 0) {
      event.preventDefault();
      setActiveIndex((value) => Math.min(value + 1, count - 1));
    } else if (event.key === "ArrowUp" && count > 0) {
      event.preventDefault();
      setActiveIndex((value) => Math.max(value - 1, 0));
    } else if (event.key === "Home" && count > 0) {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End" && count > 0) {
      event.preventDefault();
      setActiveIndex(count - 1);
    } else if (event.key === "Backspace") {
      const parent = listing?.parent;
      if (parent !== null && parent !== undefined) {
        event.preventDefault();
        void open(parent);
      }
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
      title={i18n.t("shell:chooseProjectFolder")}
      className="directory-picker-shell"
    >
      <section
        className="directory-picker-dialog"
        ref={dialogRef}
        onFocusCapture={() => {
          focusChanges.current += 1;
        }}
        tabIndex={-1}
        aria-labelledby="directory-picker-title"
      >
        <header>
          <div>
            <span className="eyebrow">{i18n.t("shell:workspaceLibrary")}</span>
            <h2 id="directory-picker-title">
              {i18n.t("shell:addAProjectFolder")}
            </h2>
            <p>
              {i18n.t("shell:zenxReadsThisLocationWithoutChangingItsContents")}
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={cancel}
            aria-label={i18n.t("shell:closeFolderPicker")}
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="directory-picker-body">
          {!!snapshot?.locations.length && (
            <nav aria-label={i18n.t("shell:startingLocations")}>
              {snapshot?.locations.map((location) => (
                <button
                  type="button"
                  key={`${location.label}:${location.path}`}
                  onClick={() => void open(location.path)}
                >
                  <Icon name="folder" size={14} />
                  <span>{location.label}</span>
                </button>
              ))}
            </nav>
          )}
          <div className="directory-picker-browser">
            {listing && (
              <div
                className="directory-picker-breadcrumbs"
                aria-label={i18n.t("shell:currentFolderPath")}
              >
                <button
                  type="button"
                  disabled={listing?.parent == null || loading}
                  onClick={() => listing?.parent && void open(listing.parent)}
                  aria-label={i18n.t("shell:openParentFolder")}
                >
                  <Icon name="chevron-left" size={14} />
                </button>
                {listing?.breadcrumbs.map((crumb) => (
                  <button
                    type="button"
                    key={crumb.path}
                    title={crumb.path}
                    aria-current={
                      crumb.path === listing.path ? "location" : undefined
                    }
                    onClick={() => void open(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                ))}
              </div>
            )}
            <div
              className="directory-picker-list"
              ref={listRef}
              role="group"
              tabIndex={
                loading || error !== null || !listing?.directories.length
                  ? 0
                  : -1
              }
              onKeyDown={onListKeyDown}
              aria-label={i18n.t("shell:subfolders")}
              aria-busy={loading}
            >
              {loading ? (
                <p aria-live="polite">{i18n.t("shell:readingFolders")}</p>
              ) : error !== null ? (
                <div className="directory-picker-error" role="alert">
                  <Icon name="warning" />
                  <p>{error}</p>
                  <button
                    type="button"
                    onClick={() => void open(failedPath ?? undefined)}
                  >
                    {i18n.t("shell:tryAgain")}
                  </button>
                </div>
              ) : listing?.directories.length === 0 ? (
                <p>{i18n.t("shell:thisFolderHasNoSubfolders")}</p>
              ) : (
                listing?.directories.map((entry, index) => (
                  <button
                    type="button"
                    data-index={index}
                    key={`${entry.name}:${entry.path}`}
                    tabIndex={index === activeIndex ? 0 : -1}
                    title={entry.path}
                    aria-label={i18n.t("shell:openFolder", {
                      name: entry.name,
                    })}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => void open(entry.path)}
                  >
                    <Icon name="folder" size={15} />
                    <span>{entry.name}</span>
                    <Icon name="chevron-right" size={12} />
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
        <footer>
          <div>
            <span>{i18n.t("shell:folderToAdd")}</span>
            <strong
              id="directory-picker-selection"
              title={listing?.path}
              tabIndex={listing ? 0 : undefined}
            >
              {listing?.path ?? i18n.t("shell:noFolderSelected")}
            </strong>
          </div>
          <button className="secondary-button" type="button" onClick={cancel}>
            {i18n.t("shell:cancel")}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={listing === null || loading || error !== null}
            aria-describedby="directory-picker-selection"
            onClick={() => listing && onSelect(listing.path)}
          >
            {i18n.t("shell:addFolder")}
          </button>
        </footer>
      </section>
    </Dialog>
  );
}
