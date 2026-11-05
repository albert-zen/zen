import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import type { AppShotApi } from "../../app-shot.js";
import type { AppShotSource } from "../../main/app-shot.js";
import type { ZenXImageDraft } from "../../main/image-attachments.js";
import { AttachmentImage } from "./ImagePresentation.js";
import { Icon } from "./icons.js";
import { Dialog } from "./ui/controls.js";
import { registerNativeViewOverlay } from "./native-view-overlays.js";

export function AppShotButton({
  disabled,
  onAttach,
  api = window.zenx.appShot,
}: {
  disabled: boolean;
  onAttach(image: ZenXImageDraft): void;
  api?: AppShotApi;
}) {
  const { t } = useTranslation("shell");
  const token = useRef(crypto.randomUUID()).current;
  const button = useRef<HTMLButtonElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  const operation = useRef(0);
  const latest = useRef({ disabled, onAttach });
  latest.current = { disabled, onAttach };
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [sources, setSources] = useState<AppShotSource[]>([]);
  const [image, setImage] = useState<ZenXImageDraft | null>(null);
  const currentImage = useRef<ZenXImageDraft | null>(null);
  currentImage.current = image;
  const waitingImages = useRef<ZenXImageDraft[]>([]);
  const [waitingCount, setWaitingCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeAccessibility, setIncludeAccessibility] = useState(false);
  const [armed, setArmed] = useState(false);
  const pending = useRef(false);

  useEffect(() => {
    live.current = true;
    const dispose = api.onCapture((event) => {
      if (!live.current || event.token !== token) return;
      if (event.disarmed) {
        setArmed(false);
        return;
      }
      if (latest.current.disabled) {
        if (event.image) void api.discard(event.image.id).catch(() => {});
        return;
      }
      if (currentImage.current) {
        if (event.image) {
          if (waitingImages.current.length >= 3) {
            void api.discard(event.image.id).catch(() => {});
            setError(i18n.t("shell:appShotQueueFull"));
            return;
          }
          waitingImages.current.push(event.image);
          setWaitingCount(waitingImages.current.length);
        }
        if (event.error) setError(event.error);
        setOpen(true);
        return;
      }
      operation.current++;
      pending.current = false;
      setBusy(false);
      if (event.image) {
        currentImage.current = event.image;
        setImage(event.image);
      }
      setError(event.error ?? null);
      setOpen(true);
    });
    return () => {
      live.current = false;
      operation.current++;
      dispose();
      for (const image of [currentImage.current, ...waitingImages.current])
        if (image) void api.discard(image.id).catch(() => {});
      void api.disarm(token).catch(() => {});
    };
  }, [api, token]);

  useEffect(() => {
    if (!disabled) return;
    operation.current++;
    pending.current = false;
    setExpanded(false);
    setOpen(false);
    for (const image of [currentImage.current, ...waitingImages.current])
      if (image) void api.discard(image.id).catch(() => {});
    currentImage.current = null;
    waitingImages.current = [];
    setWaitingCount(0);
    setImage(null);
    setBusy(false);
    setArmed(false);
    void api.disarm(token).catch(() => {});
  }, [api, disabled, token]);

  useEffect(() => {
    if (open && overlay.current)
      return registerNativeViewOverlay(overlay.current);
  }, [open]);

  const load = async () => {
    if (pending.current || latest.current.disabled) return;
    const generation = ++operation.current;
    pending.current = true;
    setOpen(true);
    for (const image of [currentImage.current, ...waitingImages.current])
      if (image) void api.discard(image.id).catch(() => {});
    currentImage.current = null;
    waitingImages.current = [];
    setWaitingCount(0);
    setImage(null);
    setSources([]);
    setError(null);
    setBusy(true);
    try {
      const result = await api.list();
      if (live.current && operation.current === generation) setSources(result);
    } catch (cause) {
      if (live.current && operation.current === generation)
        setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      if (live.current && operation.current === generation) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const openLatest = useRef(load);
  openLatest.current = load;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        armed ||
        event.repeat ||
        !event.shiftKey ||
        (!event.ctrlKey && !event.metaKey) ||
        event.altKey ||
        event.code !== "Digit2"
      )
        return;
      const view = button.current?.closest(".thread-view");
      if (!view?.contains(document.activeElement)) return;
      event.preventDefault();
      void openLatest.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [armed]);

  const close = () => {
    operation.current++;
    pending.current = false;
    setBusy(false);
    setExpanded(false);
    setOpen(false);
    for (const image of [currentImage.current, ...waitingImages.current])
      if (image) void api.discard(image.id).catch(() => {});
    currentImage.current = null;
    waitingImages.current = [];
    setWaitingCount(0);
    setImage(null);
    setError(null);
  };
  const capture = async (source: AppShotSource) => {
    if (pending.current || latest.current.disabled) return;
    const generation = ++operation.current;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const captured = await api.capture(source.id, includeAccessibility);
      if (live.current && operation.current === generation) {
        currentImage.current = captured;
        setImage(captured);
      } else {
        void api.discard(captured.id).catch(() => {});
      }
    } catch (cause) {
      if (live.current && operation.current === generation)
        setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      if (live.current && operation.current === generation) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const attach = async () => {
    const preview = currentImage.current;
    if (!preview || pending.current || latest.current.disabled) return;
    const generation = ++operation.current;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const attached = await api.attach(preview.id);
      if (
        !live.current ||
        operation.current !== generation ||
        latest.current.disabled
      )
        return;
      latest.current.onAttach(attached);
      const next = waitingImages.current.shift();
      if (next) {
        currentImage.current = next;
        setImage(next);
        setWaitingCount(waitingImages.current.length);
        setExpanded(false);
      } else close();
    } catch (cause) {
      if (live.current && operation.current === generation)
        setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      if (live.current && operation.current === generation) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const toggleShortcut = async () => {
    if (pending.current) return;
    const next = !armed;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (next) await api.arm(token, includeAccessibility);
      else await api.disarm(token);
      if (live.current && !latest.current.disabled) setArmed(next);
      else await api.disarm(token);
    } catch (cause) {
      if (live.current)
        setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      if (live.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`composer-tool icon-only${armed ? " is-active" : ""}`}
        disabled={disabled}
        title={t("appShotShortcutTitle")}
        aria-label={t("appShot")}
        onClick={() => void load()}
      >
        <Icon name="computer" />
      </button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
        title={t("appShot")}
        className="app-shot-dialog"
      >
        <div ref={overlay}>
          <header className="app-shot-heading">
            <h2>{t("appShot")}</h2>
            <button
              type="button"
              className="icon-button"
              aria-label={t("appShotClose")}
              onClick={close}
            >
              <Icon name="x" />
            </button>
          </header>
          <p>{t("appShotPrivacy")}</p>
          {error && (
            <p role="alert" className="settings-error">
              {error}
            </p>
          )}
          {busy && <p role="status">{t("appShotWorking")}</p>}
          {waitingCount > 0 && (
            <p role="status">{t("appShotWaiting", { count: waitingCount })}</p>
          )}
          {image ? (
            <>
              <div
                className={`app-shot-preview${expanded ? " is-expanded" : ""}`}
              >
                <AttachmentImage
                  attachment={image.attachment}
                  name={image.name}
                  onReadAttachment={(ref) => api.read(image.id)}
                  onOpen={() => setExpanded((value) => !value)}
                />
              </div>
              <details open>
                <summary>{t("appShotContext")}</summary>
                <pre className="app-shot-context">{image.appShotContext}</pre>
              </details>
              <div className="app-shot-actions">
                <button
                  type="button"
                  className="quiet-button"
                  disabled={waitingCount > 0}
                  onClick={() => void load()}
                >
                  {t("appShotChooseAnother")}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={disabled || busy}
                  onClick={() => void attach()}
                >
                  {t("appShotAttach")}
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="app-shot-option">
                <input
                  type="checkbox"
                  checked={includeAccessibility}
                  disabled={busy || armed}
                  onChange={(event) =>
                    setIncludeAccessibility(event.target.checked)
                  }
                />
                {t("appShotIncludeText")}
              </label>
              <p className="app-shot-hint">{t("appShotTextHint")}</p>
              <div
                className="app-shot-sources"
                aria-label={t("appShotWindows")}
              >
                {sources.map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void capture(source)}
                  >
                    <Icon name="computer" />
                    <span>
                      {source.applicationName
                        ? `${source.applicationName} · `
                        : ""}
                      {source.title || t("appShotUntitled")}
                    </span>
                  </button>
                ))}
                {!busy && sources.length === 0 && (
                  <p>{t("appShotNoWindows")}</p>
                )}
              </div>
              <div className="app-shot-actions">
                <button
                  type="button"
                  className="quiet-button"
                  disabled={busy}
                  onClick={() => void load()}
                >
                  {t("appShotRefresh")}
                </button>
                <button type="button" className="quiet-button" onClick={close}>
                  {t("appShotCancel")}
                </button>
              </div>
            </>
          )}
          {window.zenx.platform === "darwin" && (
            <div className="app-shot-shortcut">
              <label className="app-shot-option">
                <input
                  type="checkbox"
                  checked={armed}
                  disabled={busy}
                  onChange={() => void toggleShortcut()}
                />
                {t("appShotGlobalShortcut")}
              </label>
              <p className="app-shot-hint">{t("appShotGlobalHint")}</p>
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}
