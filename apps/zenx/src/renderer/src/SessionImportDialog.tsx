import { Icon } from "./icons.js";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "./ui/controls.js";
import { DirectoryPicker } from "./DirectoryPicker.js";
import { decodeModelKey } from "../../../../../src/protocol/model-key.js";
import { MAX_THREAD_IMPORT_BYTES } from "../../../../../src/thread-import.js";
import type { SessionImportPreview } from "../../../../../src/protocol/session-import.js";
import type { ModelSummary } from "../../protocol-client/index.js";

export function SessionImportDialog({
  models,
  initialCwd,
  onClose,
  onImported,
}: {
  models: readonly ModelSummary[];
  initialCwd: string;
  onClose(): void;
  onImported(threadId: string): Promise<void>;
}) {
  const { t } = useTranslation("shell");
  const epoch = useRef(0);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contents, setContents] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<SessionImportPreview | null>(null);
  const [cwd, setCwd] = useState(initialCwd);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [modelKey, setModelKey] = useState(
    () => models.find((model) => model.isDefault && !model.hidden)?.id ?? "",
  );
  const [sandbox, setSandbox] = useState<
    "read-only" | "workspace-write" | "danger-full-access"
  >("read-only");
  const [importedId, setImportedId] = useState<string | null>(null);
  const selectedModel = models.find(
    (model) => model.id === modelKey && !model.hidden,
  );
  useEffect(
    () => () => {
      epoch.current += 1;
    },
    [],
  );
  const selectFile = async (file: File | undefined) => {
    if (!file || pending.current) return;
    const token = ++epoch.current;
    setPreview(null);
    setContents("");
    setFileName(file.name);
    setError(null);
    setReading(true);
    setImportedId(null);
    try {
      if (file.size > MAX_THREAD_IMPORT_BYTES)
        throw new Error(t("importTooLarge"));
      const selected = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(await file.arrayBuffer());
      const report = await window.zenx.protocol.request(
        "zen/thread/import/preview",
        { format: "codex-rollout-0.146.0", contents: selected },
      );
      if (token !== epoch.current) return;
      setContents(selected);
      setPreview(report);
    } catch (reason) {
      if (token === epoch.current) setError(describe(reason));
    } finally {
      if (token === epoch.current) setReading(false);
    }
  };
  const submit = async () => {
    if (
      pending.current ||
      (!importedId && (!preview || !selectedModel || !cwd.trim()))
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      let id = importedId;
      if (!id) {
        if (!preview || !selectedModel) return;
        const identity = decodeModelKey(selectedModel.id);
        const result = await window.zenx.protocol.request("zen/thread/import", {
          format: preview.source.format,
          contents,
          expectedSha256: preview.source.sha256,
          configuration: {
            cwd: cwd.trim(),
            sandbox,
            selection: {
              ...identity,
              reasoningEffort: selectedModel.defaultReasoningEffort,
            },
          },
        });
        id = result.thread.id;
        setImportedId(id);
      }
      await onImported(id);
      onClose();
    } catch (reason) {
      setError(describe(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog
        open={!pickingDirectory}
        onOpenChange={(open) => {
          if (!open && !pending.current) onClose();
        }}
        title={t("importSession")}
        className="session-import-dialog"
      >
        <header>
          <h2>{t("importSession")}</h2>
          <button
            className="icon-button"
            aria-label={t("panels:close")}
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </header>
        <p>{t("importExplanation")}</p>
        <label>
          {t("importSelectedFile")}
          <input
            type="file"
            accept=".jsonl"
            disabled={busy}
            onChange={(event) => void selectFile(event.target.files?.[0])}
          />
        </label>
        {fileName && <p>{fileName}</p>}
        {reading && <p role="status">{t("importReading")}</p>}
        {preview && (
          <>
            <p>
              {t("importCounts", {
                turns: preview.turns,
                messages: preview.messages,
                calls: preview.toolCalls,
              })}
            </p>
            <p>
              {t("importSourceCwd")}:{" "}
              <span className="session-import-path">
                {preview.source.sourceCwd}
              </span>
            </p>
            {(preview.source.sourceProvider || preview.source.sourceModel) && (
              <p>
                {t("importSourceModel")}: {preview.source.sourceProvider ?? "?"}{" "}
                / {preview.source.sourceModel ?? "?"}
              </p>
            )}
            {preview.source.contextBasis && (
              <p role="note">
                {t("importCheckpointWarning", {
                  line: preview.source.contextBasis.sourceLine,
                  count: preview.source.contextBasis.earlierRecords,
                })}
              </p>
            )}
            {preview.unconfirmedTurns > 0 && (
              <p>
                {t("importUnconfirmed", { count: preview.unconfirmedTurns })}
              </p>
            )}
            {preview.source.exclusions.length > 0 && (
              <details>
                <summary>{t("importExclusions")}</summary>
                <ul>
                  {preview.source.exclusions.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </details>
            )}
            <details>
              <summary>{t("importPreview")}</summary>
              {preview.excerpt.map((entry, index) => (
                <p key={index}>
                  <strong>{entry.role}</strong>
                  <br />
                  {entry.text}
                </p>
              ))}
            </details>
          </>
        )}
        <fieldset disabled={busy || importedId !== null}>
          <label>
            {t("importLocalDirectory")}
            <input
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="quiet-button"
            onClick={() => setPickingDirectory(true)}
          >
            {t("importBrowseDirectory")}
          </button>
          <label>
            {t("importLocalModel")}
            <select
              value={modelKey}
              onChange={(event) => setModelKey(event.target.value)}
            >
              <option value="">{t("importChooseModel")}</option>
              {models
                .filter((model) => !model.hidden)
                .map((model) => (
                  <option key={model.id} value={model.id}>
                    {importModelLabel(model)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {t("importPermissions")}
            <select
              value={sandbox}
              onChange={(event) =>
                setSandbox(event.target.value as typeof sandbox)
              }
            >
              <option value="read-only">{t("importReadOnly")}</option>
              <option value="workspace-write">
                {t("importWorkspaceWrite")}
              </option>
              <option value="danger-full-access">
                {t("importFullAccess")}
              </option>
            </select>
          </label>
        </fieldset>
        <p>{t("importFreshAuthority")}</p>
        {importedId && <p role="status">{t("importSaved")}</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <footer>
          <button
            className="quiet-button"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            disabled={
              busy ||
              reading ||
              (!importedId && (!preview || !selectedModel || !cwd.trim()))
            }
            className="primary-button"
            onClick={() => void submit()}
          >
            {busy
              ? t("importSaving")
              : importedId
                ? t("importOpen")
                : t("importConfirm")}
          </button>
        </footer>
      </Dialog>
      {pickingDirectory && (
        <DirectoryPicker
          onCancel={() => setPickingDirectory(false)}
          onSelect={(directory) => {
            setCwd(directory);
            setPickingDirectory(false);
          }}
        />
      )}
    </>
  );
}
function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function importModelLabel(model: ModelSummary): string {
  try {
    return `${decodeModelKey(model.id).providerProfileId} · ${model.displayName}`;
  } catch {
    return model.displayName;
  }
}
