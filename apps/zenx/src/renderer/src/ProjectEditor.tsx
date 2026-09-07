import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./icons.js";
import { DirectoryPicker } from "./DirectoryPicker.js";

export function ProjectEditor({
  workspace,
  name: initialName,
  isDefault,
  hostBusy,
  onSave,
  onRemove,
  onClose,
}: {
  workspace: string;
  name: string;
  isDefault: boolean;
  hostBusy: boolean;
  onSave(name: string, workspace: string): Promise<void>;
  onRemove(): Promise<void>;
  onClose(): void;
}) {
  const [name, setName] = useState(initialName);
  const [folder, setFolder] = useState(workspace);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const folderRef = useRef<HTMLButtonElement>(null);
  const initialFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    initialFocus.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector("input")?.focus();
    return () => {
      if (initialFocus.current?.isConnected) initialFocus.current.focus();
    };
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      if (!busy) onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const elements = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
      ) ?? [],
    );
    if (!elements.length) {
      event.preventDefault();
      return;
    }
    const first = elements[0],
      last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };
  const changesDefaultFolder = isDefault && folder !== workspace;
  return (
    <>
      <div className="project-editor-backdrop" hidden={picking}>
        <section
          className="project-editor"
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="project-editor-title"
          onKeyDown={keyDown}
        >
          <header>
            <h2 id="project-editor-title">Edit project</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close project editor"
              disabled={busy}
              onClick={onClose}
            >
              <Icon name="x" />
            </button>
          </header>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && !(changesDefaultFolder && hostBusy))
                void run(() => onSave(name.trim(), folder));
            }}
          >
            <label>
              Project name
              <input
                value={name}
                maxLength={200}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div className="project-editor-folder">
              <span>Project folder</span>
              <div>
                <Icon name="folder" />
                <span title={folder}>{folder}</span>
                <button
                  ref={folderRef}
                  className="quiet-button"
                  type="button"
                  disabled={busy}
                  onClick={() => setPicking(true)}
                >
                  Change folder
                </button>
              </div>
            </div>
            {folder !== workspace ? (
              <p className="muted">
                Existing conversations keep their original folder. New
                conversations use this folder.
              </p>
            ) : null}
            {changesDefaultFolder ? (
              <p className="muted">
                {hostBusy
                  ? "Wait for running tasks to finish before changing the default project folder."
                  : "Changing the default folder restarts the local host."}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="error">
                {error}
              </p>
            ) : null}
            <footer>
              <button
                type="button"
                className="danger-button"
                disabled={busy || (isDefault && hostBusy)}
                onClick={() => void run(onRemove)}
              >
                Remove from ZenX
              </button>
              <span />
              <button
                className="quiet-button"
                type="button"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={
                  busy || !name.trim() || (changesDefaultFolder && hostBusy)
                }
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </footer>
          </form>
        </section>
      </div>
      {picking ? (
        <DirectoryPicker
          onCancel={() => {
            setPicking(false);
            requestAnimationFrame(() => folderRef.current?.focus());
          }}
          onSelect={(directory) => {
            setFolder(directory);
            setPicking(false);
            requestAnimationFrame(() => folderRef.current?.focus());
          }}
        />
      ) : null}
    </>
  );
}
