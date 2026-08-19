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

  const open = async (directory: string) => {
    const epoch = ++requestEpoch.current;
    setLoading(true);
    setError(null);
    setFailedPath(null);
    try {
      const result = await directorySettings().listDirectory(directory);
      if (requestEpoch.current !== epoch) return;
      setListing(result);
      setActiveIndex(0);
    } catch (caught) {
      if (requestEpoch.current !== epoch) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setFailedPath(directory);
    } finally {
      if (requestEpoch.current === epoch) setLoading(false);
    }
  };

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);

  useEffect(() => {
    let active = true;
    void directorySettings()
      .getDirectoryBrowser()
      .then((result) => {
        if (!active) return;
        setSnapshot(result);
        return open(result.initialPath);
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : String(caught));
          setLoading(false);
        }
      });
    return () => {
      active = false;
      requestEpoch.current += 1;
    };
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-index="${activeIndex}"]`)
      ?.focus();
  }, [activeIndex, listing]);

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = listing?.directories.length ?? 0;
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
    } else if (event.key === "Backspace" && listing?.parent !== null) {
      event.preventDefault();
      void open(listing!.parent!);
    }
  };

  const onDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    );
    if (focusable === undefined || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (!Array.from(focusable).includes(active as HTMLElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <div className="directory-picker-backdrop" role="presentation">
      <section
        className="directory-picker-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="directory-picker-title"
        onKeyDown={onDialogKeyDown}
      >
        <header>
          <div>
            <span className="eyebrow">Workspace library</span>
            <h2 id="directory-picker-title">Add a project folder</h2>
            <p>ZenX reads this location without changing its contents.</p>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onCancel}
            aria-label="Close folder picker"
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="directory-picker-body">
          <nav aria-label="Starting locations">
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
          <div className="directory-picker-browser">
            <div
              className="directory-picker-breadcrumbs"
              aria-label="Current folder path"
            >
              <button
                type="button"
                disabled={listing?.parent == null || loading}
                onClick={() => listing?.parent && void open(listing.parent)}
                aria-label="Open parent folder"
              >
                <Icon name="chevron-left" size={14} />
              </button>
              {listing?.breadcrumbs.map((crumb) => (
                <button
                  type="button"
                  key={crumb.path}
                  title={crumb.path}
                  onClick={() => void open(crumb.path)}
                >
                  {crumb.label}
                </button>
              ))}
            </div>
            <div
              className="directory-picker-list"
              ref={listRef}
              onKeyDown={onListKeyDown}
              aria-label="Subfolders"
              aria-busy={loading}
            >
              {loading ? (
                <p aria-live="polite">Reading folders…</p>
              ) : error !== null ? (
                <div className="directory-picker-error" role="alert">
                  <Icon name="warning" />
                  <p>{error}</p>
                  {failedPath === null ? null : (
                    <button type="button" onClick={() => void open(failedPath)}>
                      Try again
                    </button>
                  )}
                </div>
              ) : listing?.directories.length === 0 ? (
                <p>This folder has no subfolders.</p>
              ) : (
                listing?.directories.map((entry, index) => (
                  <button
                    type="button"
                    data-index={index}
                    data-active={index === activeIndex}
                    key={`${entry.name}:${entry.path}`}
                    tabIndex={index === activeIndex ? 0 : -1}
                    title={entry.path}
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
            <span>Current selection</span>
            <strong title={listing?.path}>
              {listing?.path ?? "No folder selected"}
            </strong>
          </div>
          <button className="secondary-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={listing === null || loading || error !== null}
            onClick={() => listing && onSelect(listing.path)}
          >
            Add folder
          </button>
        </footer>
      </section>
    </div>
  );
}
