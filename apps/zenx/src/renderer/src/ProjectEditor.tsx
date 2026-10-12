import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { Dialog } from "./ui/controls.js";
import { useRef, useState } from "react";
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
  useTranslation("shell");
  const [name, setName] = useState(initialName);
  const [folder, setFolder] = useState(workspace);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const folderRef = useRef<HTMLButtonElement>(null);
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

  const changesDefaultFolder = isDefault && folder !== workspace;
  return (
    <>
      <Dialog
        open={!picking}
        onOpenChange={(open) => {
          if (!open && !busy) onClose();
        }}
        title={i18n.t("shell:editProject")}
        className="project-editor-shell"
      >
        <section
          className="project-editor"
          ref={dialogRef}
          aria-labelledby="project-editor-title"
        >
          <header>
            <h2 id="project-editor-title">{i18n.t("shell:editProject")}</h2>
            <button
              type="button"
              className="icon-button"
              aria-label={i18n.t("shell:closeProjectEditor")}
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
              {i18n.t("shell:projectName")}
              <input
                value={name}
                maxLength={200}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div className="project-editor-folder">
              <span>{i18n.t("shell:projectFolder")}</span>
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
                  {i18n.t("shell:changeFolder")}
                </button>
              </div>
            </div>
            {folder !== workspace ? (
              <p className="muted">
                {i18n.t("shell:existingConversationsKeepFolder")}
              </p>
            ) : null}
            {changesDefaultFolder ? (
              <p className="muted">
                {hostBusy
                  ? i18n.t(
                      "shell:waitForRunningTasksToFinishBeforeChangingTheDefaultProjectFolder",
                    )
                  : i18n.t(
                      "shell:changingTheDefaultFolderRestartsTheLocalHost",
                    )}
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
                {i18n.t("shell:removeFromZenx")}
              </button>
              <span />
              <button
                className="quiet-button"
                type="button"
                disabled={busy}
                onClick={onClose}
              >
                {i18n.t("shell:cancel")}
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={
                  busy || !name.trim() || (changesDefaultFolder && hostBusy)
                }
              >
                {busy ? i18n.t("shell:saving") : i18n.t("shell:save")}
              </button>
            </footer>
          </form>
        </section>
      </Dialog>
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
