import { abandonDraftImage } from "./draft-image-lifecycle.js";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import type {
  AppShotApi,
  AppShotConfiguration,
  AppShotShortcutKind,
  AppShotShortcutState,
} from "../../app-shot.js";
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
  const shortcutToken = useRef<string>(token);
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
  const [portalState, setPortalState] = useState<AppShotShortcutState | null>(
    null,
  );
  const [shortcutBusy, setShortcutBusy] = useState(false);
  const shortcutRequested = useRef(false);
  const shortcutOperation = useRef(0);
  const supportsBothShift =
    window.zenx.platform === "darwin" || window.zenx.platform === "win32";
  const [shortcutKind, setShortcutKind] = useState<AppShotShortcutKind>(
    supportsBothShift ? "both-shift" : "chord",
  );
  const pending = useRef(false);
  const [configuration, setConfiguration] =
    useState<AppShotConfiguration | null>(null);

  useEffect(() => {
    let current = true;
    if (!open) return;
    setConfiguration(null);
    if (api.configuration)
      void api.configuration().then(
        (value) => {
          if (current) setConfiguration(value);
        },
        (cause) => {
          if (current)
            setError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    return () => {
      current = false;
    };
  }, [api, open]);

  useEffect(() => {
    live.current = true;
    const dispose = api.onCapture((event) => {
      if (
        !live.current ||
        !shortcutRequested.current ||
        event.token !== shortcutToken.current
      ) {
        // All mounted Composers share this event channel. Only retire a late
        // image from this component's own registration, never another owner's.
        if (event.image && event.token.startsWith(`${token}:`))
          void api.discard(event.image.id).catch(() => {});
        return;
      }
      if (event.disarmed) {
        shortcutOperation.current++;
        shortcutRequested.current = false;
        setShortcutBusy(false);
        setArmed(false);
        setPortalState(null);
        if (event.error && !latest.current.disabled) {
          setError(event.error);
          setOpen(true);
        }
        return;
      }
      if (latest.current.disabled) {
        if (event.image) void api.discard(event.image.id).catch(() => {});
        return;
      }
      if (event.shortcutState) {
        setPortalState(event.shortcutState);
        setArmed(event.shortcutState.registered);
        return;
      }
      if (event.openPicker) {
        if (currentImage.current) setOpen(true);
        else void openLatest.current();
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
      shortcutOperation.current++;
      shortcutRequested.current = false;
      operation.current++;
      dispose();
      for (const image of [currentImage.current, ...waitingImages.current])
        if (image) void api.discard(image.id).catch(() => {});
      void api.disarm(shortcutToken.current).catch(() => {});
    };
  }, [api, token]);

  useEffect(() => {
    if (!disabled) return;
    shortcutOperation.current++;
    shortcutRequested.current = false;
    setShortcutBusy(false);
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
    setPortalState(null);
    void api.disarm(shortcutToken.current).catch(() => {});
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
        (armed && shortcutKind === "chord" && !configuration?.portalShortcut) ||
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
  }, [armed, shortcutKind, configuration?.portalShortcut]);

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
      ) {
        abandonDraftImage(attached.id);
        return;
      }
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
  const toggleShortcut = async (requested?: boolean) => {
    if (latest.current.disabled) return;
    const generation = ++shortcutOperation.current;
    const next = requested ?? !shortcutRequested.current;
    shortcutRequested.current = next;
    setArmed(next);
    setShortcutBusy(true);
    setError(null);
    try {
      if (next) {
        // Every registration gets a new token, so queued events from a revoked
        // session cannot revive its state after a later enable.
        const registrationToken = `${token}:${crypto.randomUUID()}`;
        shortcutToken.current = registrationToken;
        const result = await api.arm(
          registrationToken,
          includeAccessibility,
          shortcutKind,
        );
        if (
          !live.current ||
          shortcutOperation.current !== generation ||
          latest.current.disabled
        )
          return;
        if (typeof result !== "string") {
          setPortalState(result);
          setArmed(result.registered);
        }
      } else {
        setPortalState(null);
        await api.disarm(shortcutToken.current);
      }
    } catch (cause) {
      if (live.current && shortcutOperation.current === generation) {
        shortcutRequested.current = false;
        setArmed(false);
        setPortalState(null);
        setError(String(cause instanceof Error ? cause.message : cause));
      }
    } finally {
      if (live.current && shortcutOperation.current === generation)
        setShortcutBusy(false);
    }
  };
  const configureShortcut = async () => {
    if (!api.configureShortcut || latest.current.disabled || shortcutBusy)
      return;
    const generation = ++shortcutOperation.current;
    setShortcutBusy(true);
    setError(null);
    try {
      const result = await api.configureShortcut(shortcutToken.current);
      if (
        live.current &&
        shortcutOperation.current === generation &&
        !latest.current.disabled
      ) {
        setPortalState(result);
        setArmed(result.registered);
      }
    } catch (cause) {
      if (live.current && shortcutOperation.current === generation)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (live.current && shortcutOperation.current === generation)
        setShortcutBusy(false);
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
          {shortcutBusy && <p role="status">{t("appShotShortcutWorking")}</p>}
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
          <div className="app-shot-shortcut">
            <fieldset disabled={armed || shortcutBusy}>
              <legend>{t("appShotShortcutPreference")}</legend>
              {supportsBothShift && (
                <label className="app-shot-option">
                  <input
                    type="radio"
                    name={`app-shot-shortcut-${token}`}
                    value="both-shift"
                    checked={shortcutKind === "both-shift"}
                    onChange={() => setShortcutKind("both-shift")}
                  />
                  {t("appShotBothShift")}
                </label>
              )}
              <label className="app-shot-option">
                <input
                  type="radio"
                  name={`app-shot-shortcut-${token}`}
                  value="chord"
                  checked={shortcutKind === "chord"}
                  onChange={() => setShortcutKind("chord")}
                />
                {t("appShotChord")}
              </label>
            </fieldset>
            <label className="app-shot-option">
              <input
                type="checkbox"
                checked={armed}
                disabled={disabled}
                onChange={(event) => void toggleShortcut(event.target.checked)}
              />
              {t(
                configuration?.niriBinding
                  ? "appShotNiriEnable"
                  : configuration?.portalShortcut
                    ? "appShotPortalEnable"
                    : "appShotGlobalShortcut",
              )}
            </label>
            <p className="app-shot-hint">
              {t(
                configuration?.niriBinding
                  ? "appShotNiriHint"
                  : configuration?.portalShortcut
                    ? "appShotPortalHint"
                    : window.zenx.platform === "linux"
                      ? "appShotLinuxShortcutHint"
                      : shortcutKind === "both-shift"
                        ? "appShotBothShiftHint"
                        : "appShotGlobalHint",
              )}
            </p>
            {portalState && (
              <>
                <p role="status" className="app-shot-hint">
                  {portalState.registered
                    ? t("appShotPortalAssigned", {
                        shortcut:
                          portalState.shortcutDescription ??
                          t("appShotPortalAssignedUnknown"),
                      })
                    : t("appShotPortalNotAssigned")}
                </p>
                <div className="app-shot-actions">
                  {portalState.canConfigure && api.configureShortcut && (
                    <button
                      type="button"
                      className="quiet-button"
                      disabled={disabled || shortcutBusy}
                      onClick={() => void configureShortcut()}
                    >
                      {t("appShotPortalConfigure")}
                    </button>
                  )}
                  {!portalState.registered && (
                    <button
                      type="button"
                      className="quiet-button"
                      disabled={disabled}
                      onClick={() => void toggleShortcut(false)}
                    >
                      {t("appShotPortalStop")}
                    </button>
                  )}
                </div>
              </>
            )}
            {configuration?.niriBinding && (
              <details>
                <summary>{t("appShotNiriBinding")}</summary>
                <p className="app-shot-hint">{t("appShotNiriManualSetup")}</p>
                <pre className="app-shot-context">
                  {configuration.niriBinding}
                </pre>
              </details>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}
