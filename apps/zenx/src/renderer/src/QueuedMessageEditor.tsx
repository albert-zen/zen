import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AttachmentRef } from "../../../../../src/attachment.js";
import type { ComposerDraft, ComposerDraftImage } from "./composer-state.js";
import { composerDraftHasContent } from "./composer-state.js";
import { ComposerEditor, ComposerShell } from "./Composer.js";
import { AttachmentImage, ImagePreview } from "./ImagePresentation.js";
import { Icon } from "./icons.js";
import { Dialog } from "./ui/controls.js";
import { ReferenceToken } from "./ReferenceToken.js";
import type { Reference } from "./composer-selector.js";
import { parseReferenceDraft, withReferenceDraft } from "./reference-draft.js";

export interface QueuedMessageEditorProps {
  /** Captured thread + item + client + base revision, never a display index. */
  identity: string;
  open: boolean;
  initialDraft: ComposerDraft;
  /** Parent may retain this local draft across navigation, separate from Composer. */
  onDraftChange?(draft: ComposerDraft): void;
  pending?: boolean;
  error?: string | null;
  disabledReason?: string | null;
  /** Resolves only after an authoritative native edit receipt. */
  onSave(draft: ComposerDraft): Promise<void>;
  onClose(reason: "cancel" | "saved" | "source"): void;
  /** Exact current-viewport target, not a label search; source navigation suspends this draft. */
  onReferenceSource?(
    reference: Extract<Reference, { kind: "message" }>,
  ): HTMLElement | null;
  trigger: HTMLElement | null;
  /** Exact parent-owned thread/selection guard, including a connected trigger. */
  canRestoreFocus?(): boolean;
  /** Parent may focus the same-thread Composer if the queue trigger disappeared. */
  onRestoreFocus?(): void;
  onReadAttachment(attachment: AttachmentRef): Promise<Uint8Array>;
  onImportImages(
    files: readonly File[],
  ): Promise<readonly ComposerDraftImage[]>;
  onPickImages(): Promise<readonly ComposerDraftImage[]>;
}

/** A disposable editor for one native queue identity; it never admits new input. */
export function QueuedMessageEditor(props: QueuedMessageEditorProps) {
  return <EditorSession key={props.identity} {...props} />;
}

function EditorSession(props: QueuedMessageEditorProps) {
  const { t } = useTranslation("shell");
  const dialogId = useId();
  const editorId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState<ComposerDraft>(() => ({
    text: props.initialDraft.text,
    images: [...props.initialDraft.images],
  }));
  const draftRef = useRef(draft);
  const referenceDraft = parseReferenceDraft(draft.text);
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(true);
  const saveLock = useRef(false);
  const importLock = useRef(false);
  const restoreRequested = useRef(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const previewHost = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{
    image: ComposerDraftImage;
    trigger: HTMLButtonElement;
  } | null>(null);
  const pending = saving || props.pending === true;
  const locked = pending || importing || !!props.disabledReason;
  const error = localError ?? props.error ?? null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!props.open) {
      setPreview(null);
      setDragging(false);
      return;
    }
    // Another viewport may have edited the shared session while this copy was
    // hidden. Reconcile only on open, never on streaming parent rerenders.
    const currentDraft = latest.current.initialDraft;
    const nextDraft = {
      text: currentDraft.text,
      images: [...currentDraft.images],
    };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setLocalError(null);
    restoreRequested.current = false;
    const frame = requestAnimationFrame(() => {
      if (mounted.current && latest.current.open) textarea.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [props.open]);

  const updateDraft = (next: ComposerDraft) => {
    draftRef.current = next;
    setDraft(next);
    setLocalError(null);
    latest.current.onDraftChange?.(next);
  };
  const canEdit = () =>
    mounted.current &&
    latest.current.open &&
    !saveLock.current &&
    !importLock.current &&
    !latest.current.pending &&
    !latest.current.disabledReason;
  const dismiss = (reason: "cancel" | "saved") => {
    if (!mounted.current || !latest.current.open) return;
    restoreRequested.current = true;
    setPreview(null);
    latest.current.onClose(reason);
  };
  const save = async () => {
    if (
      !mounted.current ||
      !latest.current.open ||
      saveLock.current ||
      importLock.current ||
      latest.current.pending ||
      latest.current.disabledReason
    )
      return;
    if (!composerDraftHasContent(draftRef.current)) {
      setLocalError(t("queueEditorEmpty"));
      textarea.current?.focus();
      return;
    }
    saveLock.current = true;
    setSaving(true);
    setLocalError(null);
    const submitted: ComposerDraft = {
      text: draftRef.current.text,
      images: [...draftRef.current.images],
    };
    try {
      await latest.current.onSave(submitted);
      if (!mounted.current) return;
      if (latest.current.open) dismiss("saved");
      // A confirmed hidden session must retire its old base revision too. The
      // parent callback is bound to this exact identity; do not restore focus.
      else latest.current.onClose("saved");
    } catch (reason) {
      if (mounted.current)
        setLocalError(
          reason instanceof Error ? reason.message : String(reason),
        );
    } finally {
      saveLock.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const addImages = async (
    operation: () => Promise<readonly ComposerDraftImage[]>,
  ) => {
    if (!canEdit()) return;
    importLock.current = true;
    setImporting(true);
    setLocalError(null);
    try {
      const images = await operation();
      if (!mounted.current || images.length === 0) return;
      updateDraft({
        ...draftRef.current,
        images: [...draftRef.current.images, ...images],
      });
    } catch (reason) {
      if (mounted.current)
        setLocalError(
          reason instanceof Error ? reason.message : String(reason),
        );
    } finally {
      importLock.current = false;
      if (mounted.current) setImporting(false);
    }
  };
  const importFiles = (files: FileList) => {
    const images = Array.from(files).filter((file) =>
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        file.type,
      ),
    );
    if (images.length === 0) return false;
    void addImages(() => latest.current.onImportImages(images));
    return true;
  };

  return (
    <Dialog
      id={dialogId}
      open={props.open}
      title={t("queueEditorTitle")}
      className="queued-message-editor"
      data-queue-editor-identity={props.identity}
      onOpenChange={(open) => {
        if (!open) dismiss("cancel");
      }}
      onEscapeKeyDown={(event) => {
        if (preview !== null) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (preview !== null) event.preventDefault();
      }}
      onDragEnter={(event) => event.stopPropagation()}
      onDragOver={(event) => {
        event.stopPropagation();
        if (Array.from(event.dataTransfer.types).includes("Files"))
          event.preventDefault();
      }}
      onDragLeave={(event) => event.stopPropagation()}
      onDrop={(event) => {
        // React portal events otherwise reach ThreadView's main draft importer.
        event.stopPropagation();
        if (event.dataTransfer.files.length > 0) event.preventDefault();
      }}
      restoreFocus={() => {
        const active = document.activeElement;
        const target = latest.current.trigger;
        const dialog = document.getElementById(dialogId);
        if (
          restoreRequested.current &&
          (latest.current.canRestoreFocus?.() ?? true) &&
          (active === document.body ||
            active === target ||
            dialog?.contains(active))
        ) {
          if (target?.isConnected) target.focus({ preventScroll: true });
          else latest.current.onRestoreFocus?.();
        }
        // Restoration uses the exact supplied queue trigger, never a late
        // captured field from another thread or an image-preview close button.
        return false;
      }}
    >
      <div ref={previewHost} className="queue-editor-preview-host" />
      <header className="queue-editor-heading">
        <div>
          <h2>{t("queueEditorTitle")}</h2>
          <p id={descriptionId}>{t("queueEditorDescription")}</p>
        </div>
        <button
          className="queue-editor-close"
          type="button"
          aria-label={t("panels:close")}
          title={t("panels:close")}
          onClick={() => dismiss("cancel")}
        >
          <Icon name="x" size={18} />
        </button>
      </header>
      {referenceDraft.references.length > 0 && (
        <div
          className="reference-rail queue-editor-reference-rail"
          aria-label={t("referencesToSend")}
        >
          {referenceDraft.references.map((reference, index) => (
            <ReferenceToken
              key={JSON.stringify([index, reference])}
              reference={reference}
              removeDisabled={locked}
              onSource={
                reference.kind === "message"
                  ? () => {
                      if (!canEdit()) return false;
                      const target =
                        latest.current.onReferenceSource?.(reference);
                      if (!target) return false;
                      restoreRequested.current = false;
                      latest.current.onClose("source");
                      // Wait for the modal focus trap to leave, then reveal the exact source.
                      requestAnimationFrame(() => {
                        if (
                          target.isConnected &&
                          (latest.current.canRestoreFocus?.() ?? true)
                        ) {
                          target.scrollIntoView({
                            block: "center",
                            behavior: "auto",
                          });
                          target.focus({ preventScroll: true });
                        }
                      });
                      return true;
                    }
                  : undefined
              }
              onRemove={() => {
                if (!canEdit()) return;
                const current = parseReferenceDraft(draftRef.current.text);
                updateDraft({
                  ...draftRef.current,
                  text: withReferenceDraft(
                    current.text,
                    current.references.filter((_, i) => i !== index),
                  ),
                });
                textarea.current?.focus({ preventScroll: true });
              }}
            />
          ))}
        </div>
      )}
      {draft.images.length ? (
        <div
          className="composer-images queue-editor-images"
          aria-label={t("imagesToSend")}
        >
          {draft.images.map((image) => (
            <div
              className="draft-image"
              key={image.id}
              data-editor-image-id={image.id}
            >
              <AttachmentImage
                attachment={image.attachment}
                name={image.name}
                onReadAttachment={props.onReadAttachment}
                retryOnError
                onOpen={(_attachment, _name, trigger) => {
                  if (mounted.current && latest.current.open)
                    setPreview({ image, trigger });
                }}
              />
              <button
                className="remove-draft-image"
                type="button"
                disabled={locked}
                aria-label={t("removeImageName", { name: image.name })}
                title={t("removeImageName", { name: image.name })}
                onClick={() => {
                  if (!canEdit()) return;
                  updateDraft({
                    ...draftRef.current,
                    images: draftRef.current.images.filter(
                      (entry) => entry.id !== image.id,
                    ),
                  });
                  requestAnimationFrame(() => {
                    if (
                      mounted.current &&
                      latest.current.open &&
                      document.activeElement === document.body
                    )
                      textarea.current?.focus({ preventScroll: true });
                  });
                }}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <ComposerShell
        className={`queue-editor-form${dragging ? " is-dragging" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        aria-describedby={descriptionId}
        aria-busy={pending || importing}
        onDragEnter={(event) => {
          if (locked || !Array.from(event.dataTransfer.types).includes("Files"))
            return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (locked || !Array.from(event.dataTransfer.types).includes("Files"))
            return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDragging(false);
        }}
        onDrop={(event) => {
          if (locked) return;
          setDragging(false);
          if (importFiles(event.dataTransfer.files)) event.preventDefault();
        }}
      >
        <div className="queue-editor-body">
          {props.disabledReason ? (
            <p className="queue-editor-notice" role="status">
              {props.disabledReason}
            </p>
          ) : null}
          <label className="queue-editor-label" htmlFor={editorId}>
            {t("message")}
          </label>
          <ComposerEditor
            id={editorId}
            textareaRef={textarea}
            value={referenceDraft.text}
            readOnly={locked}
            aria-describedby={error ? errorId : descriptionId}
            aria-label={t("message")}
            onChange={(event) =>
              canEdit() &&
              updateDraft({
                ...draftRef.current,
                text: withReferenceDraft(
                  event.target.value,
                  parseReferenceDraft(draftRef.current.text).references,
                ),
              })
            }
            onPaste={(event) => {
              if (!locked && importFiles(event.clipboardData.files)) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey))
                return;
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (!event.repeat) void save();
            }}
          />
          <div className="queue-editor-image-tools">
            <button
              type="button"
              disabled={locked}
              onClick={() =>
                void addImages(() => latest.current.onPickImages())
              }
            >
              <Icon name="paperclip" size={16} />
              {t("addImages")}
            </button>
            <span role="status">
              {importing
                ? t("queueEditorImporting")
                : dragging
                  ? t("queueEditorDropImages")
                  : null}
            </span>
          </div>
        </div>
        <footer className="queue-editor-footer">
          {error ? (
            <p
              id={errorId}
              className="queue-editor-error"
              role="alert"
              tabIndex={0}
            >
              {error}
            </p>
          ) : null}
          <p
            className="queue-editor-hint"
            role={pending ? "status" : undefined}
          >
            {pending ? t("queueEditorPendingHint") : t("queueEditorShortcuts")}
          </p>
          <div className="queue-editor-actions">
            <button type="button" onClick={() => dismiss("cancel")}>
              {pending ? t("panels:close") : t("cancel")}
            </button>
            <button
              className="queue-editor-save"
              type="submit"
              disabled={locked || !composerDraftHasContent(draft)}
            >
              {pending ? t("saving") : t("queueEditorSave")}
            </button>
          </div>
        </footer>
      </ComposerShell>
      {preview !== null && previewHost.current !== null ? (
        <ImagePreview
          attachment={preview.image.attachment}
          name={preview.image.name}
          trigger={preview.trigger}
          onReadAttachment={props.onReadAttachment}
          onClose={() => setPreview(null)}
          portalContainer={previewHost.current}
          safeError
          restoreFocus={() => {
            if (!mounted.current || !latest.current.open) return;
            if (preview.trigger.isConnected)
              preview.trigger.focus({ preventScroll: true });
            else textarea.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </Dialog>
  );
}
