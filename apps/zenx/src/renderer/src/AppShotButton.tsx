import { useAppShotShortcutRecorder } from "./use-app-shot-shortcut-recorder.js";
import {
  APP_SHOT_DEFAULT_CHORD,
  appShotKeyChordAccelerator,
  appShotKeyChordFromEvent,
  validateAppShotKeyChord,
  type AppShotKeyChord,
} from "../../app-shot-key-chord.js";
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
import {
  readAppShotShortcutPreference,
  saveAppShotShortcutPreference,
} from "./app-shot-shortcut-preference.js";

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
  const supportsModifierPairs =
    window.zenx.platform === "darwin" || window.zenx.platform === "win32";
  // Snapshot only: another Composer or a storage event must not alter a live
  // shortcut session. Reading a choice never restores capture authority.
  const [shortcutSelection, setShortcutSelection] = useState(() =>
    readAppShotShortcutPreference(window.zenx.platform),
  );
  const { kind: shortcutKind, chord: shortcutChord } = shortcutSelection;
  const [shortcutSaveFailed, setShortcutSaveFailed] = useState(false);
  const changeShortcutKind = (
    kind: AppShotShortcutKind,
    chord: AppShotKeyChord = APP_SHOT_DEFAULT_CHORD,
  ) => {
    if (
      disabled ||
      armed ||
      busy ||
      shortcutBusy ||
      recorder.pending ||
      recorder.releaseFailed ||
      (kind !== "chord" && !supportsModifierPairs)
    )
      return;
    const selection = { kind, chord };
    recorder.stop();
    setShortcutSelection(selection);
    setShortcutSaveFailed(!saveAppShotShortcutPreference(selection));
  };
  const modifierChoices = [
    ["both-shift", "appShotBothShift"],
    ["both-control", "appShotBothControl"],
    [
      "both-alt",
      window.zenx.platform === "darwin"
        ? "appShotBothOption"
        : "appShotBothAlt",
    ],
    [
      "both-meta",
      window.zenx.platform === "darwin"
        ? "appShotBothCommand"
        : "appShotBothWindows",
    ],
  ] as const;
  const pending = useRef(false);
  const [configuration, setConfiguration] =
    useState<AppShotConfiguration | null>(null);
  const [configurationRevision, setConfigurationRevision] = useState(0);
  // Keep the action/key distinction while a newly opened picker probes capture
  // readiness. An active portal session already identifies its managed mode.
  const managedByHyprland =
    Boolean(configuration?.hyprlandBinding) ||
    portalState?.actionRegistered !== undefined;

  const compositorManaged =
    managedByHyprland || Boolean(configuration?.niriBinding);
  // Wait for Linux capabilities before showing any ordinary chord preference.
  const canChooseShortcut =
    supportsModifierPairs || (configuration !== null && !compositorManaged);
  const shortcutEditingDisabled = disabled || armed || busy || shortcutBusy;
  const recorder = useAppShotShortcutRecorder({
    api,
    token,
    disabled: shortcutEditingDisabled || !open || !canChooseShortcut,
    onError: setError,
  });
  const { recording } = recorder;

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
  }, [api, open, configurationRevision]);

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
        setArmed(
          event.shortcutState.registered ||
            event.shortcutState.actionRegistered === true,
        );
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
    recorder.stop();
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
    setConfigurationRevision((revision) => revision + 1);
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
        event.defaultPrevented ||
        (event.target instanceof window.Element &&
          event.target.closest("[data-keybinding-capture]")) ||
        (armed &&
          shortcutKind === "chord" &&
          shortcutChord.key === "2" &&
          shortcutChord.shiftKey &&
          !shortcutChord.altKey &&
          (window.zenx.platform === "darwin"
            ? (shortcutChord.modKey || shortcutChord.metaKey) &&
              !shortcutChord.ctrlKey
            : (shortcutChord.modKey || shortcutChord.ctrlKey) &&
              !shortcutChord.metaKey) &&
          !configuration?.portalShortcut &&
          !portalState) ||
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
  }, [
    armed,
    shortcutKind,
    shortcutChord,
    configuration?.portalShortcut,
    portalState,
  ]);

  const close = () => {
    operation.current++;
    pending.current = false;
    setBusy(false);
    setExpanded(false);
    recorder.stop();
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
    if (
      latest.current.disabled ||
      (requested === true &&
        (busy || recording || recorder.pending || recorder.releaseFailed))
    )
      return;
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
          compositorManaged ? "chord" : shortcutKind,
          !compositorManaged && shortcutKind === "chord"
            ? shortcutChord
            : undefined,
        );
        if (
          !live.current ||
          shortcutOperation.current !== generation ||
          latest.current.disabled
        )
          return;
        if (typeof result !== "string") {
          setPortalState(result);
          setArmed(result.registered || result.actionRegistered === true);
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
        setArmed(result.registered || result.actionRegistered === true);
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
        onEscapeKeyDown={(event) => {
          if (!recording) return;
          event.preventDefault();
          if (!event.repeat) recorder.stop();
        }}
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
          {(error || configuration?.nativeCaptureError) && (
            <p role="alert" className="settings-error">
              {error || configuration?.nativeCaptureError}
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
            {configuration?.gnomeSupport && (
              <details className="app-shot-hint">
                <summary>
                  {t(
                    configuration.gnomeSupport === "ready"
                      ? "appShotGnomeReady"
                      : "appShotGnomeSetup",
                  )}
                </summary>
                <p>{t("appShotGnomeSetupHint")}</p>
                <p>{t("appShotGnomeRevokeHint")}</p>
              </details>
            )}
            {configuration?.kdeSupport && (
              <details className="app-shot-hint">
                <summary>
                  {t(
                    configuration.kdeSupport === "ready"
                      ? "appShotKdeReady"
                      : configuration.kdeSupport === "error"
                        ? "appShotKdeError"
                        : configuration.kdeSupport === "unavailable"
                          ? "appShotKdeUnavailable"
                          : "appShotKdeSetup",
                  )}
                </summary>
                <p>{t("appShotKdeSetupHint")}</p>
                <p>{t("appShotNativeDataHome")}</p>
                <pre className="app-shot-context">
                  {
                    "$XDG_DATA_HOME/zenx/kde-capture/zenx-kde-snap-shot\n$XDG_DATA_HOME/applications/io.github.albert_zen.ZenX.KdeCapture.desktop"
                  }
                </pre>
                <p>{t("appShotKdeRevokeHint")}</p>
              </details>
            )}
            {configuration?.hyprlandSupport && (
              <details className="app-shot-hint">
                <summary>
                  {t(
                    configuration.hyprlandSupport === "ready"
                      ? "appShotHyprlandReady"
                      : configuration.hyprlandSupport === "error"
                        ? "appShotHyprlandError"
                        : configuration.hyprlandSupport === "update-required"
                          ? "appShotHyprlandUpdate"
                          : configuration.hyprlandSupport ===
                              "unsupported-session"
                            ? "appShotHyprlandUnavailable"
                            : "appShotHyprlandSetup",
                  )}
                </summary>
                <p>{t("appShotHyprlandSetupHint")}</p>
                <p>{t("appShotNativeDataHome")}</p>
                <pre className="app-shot-context">
                  {
                    "$XDG_DATA_HOME/zenx/hyprland-capture/zenx-hyprland-snap-shot"
                  }
                </pre>
                <p>{t("appShotHyprlandRevokeHint")}</p>
              </details>
            )}
            {canChooseShortcut && (
              <fieldset disabled={shortcutEditingDisabled}>
                <legend>{t("appShotShortcutPreference")}</legend>
                <p className="app-shot-hint">
                  {t("appShotShortcutRemembered")}
                </p>
                {shortcutSaveFailed && (
                  <p role="alert" className="settings-error">
                    {t("appShotShortcutSaveFailed")}
                  </p>
                )}
                {supportsModifierPairs &&
                  modifierChoices.map(([kind, label]) => (
                    <label className="app-shot-option" key={kind}>
                      <input
                        type="radio"
                        name={`app-shot-shortcut-${token}`}
                        disabled={recorder.pending || recorder.releaseFailed}
                        value={kind}
                        checked={shortcutKind === kind}
                        onChange={() => changeShortcutKind(kind)}
                      />
                      {t(label)}
                    </label>
                  ))}
                <label className="app-shot-option">
                  <input
                    type="radio"
                    name={`app-shot-shortcut-${token}`}
                    disabled={recorder.pending || recorder.releaseFailed}
                    value="chord"
                    checked={
                      shortcutKind === "chord" &&
                      appShotKeyChordAccelerator(shortcutChord) ===
                        appShotKeyChordAccelerator(APP_SHOT_DEFAULT_CHORD)
                    }
                    onChange={() => changeShortcutKind("chord")}
                  />
                  {t("appShotChord")}
                </label>
                <button
                  type="button"
                  className="quiet-button"
                  data-keybinding-capture=""
                  aria-label={t("appShotRecordChord")}
                  aria-pressed={recording}
                  disabled={shortcutEditingDisabled || recorder.releaseFailed}
                  onClick={() => {
                    setError(null);
                    void recorder.start();
                  }}
                  onBlur={() => {
                    if (recording || recorder.pending) recorder.stop();
                  }}
                  onKeyDown={(event) => {
                    if (
                      !recording ||
                      shortcutEditingDisabled ||
                      event.key === "Tab" ||
                      event.repeat
                    )
                      return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.key === "Escape") {
                      recorder.stop();
                      return;
                    }
                    if (
                      !event.metaKey &&
                      !event.ctrlKey &&
                      !event.altKey &&
                      !event.shiftKey
                    )
                      return;
                    const chord = appShotKeyChordFromEvent(
                      event,
                      window.zenx.platform,
                    );
                    if (!chord) {
                      if (
                        ![
                          "Control",
                          "Shift",
                          "Alt",
                          "Meta",
                          "OS",
                          "AltGraph",
                        ].includes(event.key)
                      )
                        setError(t("appShotUnsupportedChord"));
                      return;
                    }
                    try {
                      const normalized = validateAppShotKeyChord(
                        chord,
                        window.zenx.platform,
                      );
                      changeShortcutKind("chord", normalized);
                      setError(null);
                    } catch (cause) {
                      setError(
                        cause instanceof Error ? cause.message : String(cause),
                      );
                    }
                  }}
                >
                  {recording ? t("appShotPressChord") : t("appShotRecordChord")}
                </button>
                {recorder.releaseFailed && (
                  <p role="alert" className="settings-error">
                    {t("appShotRecordingReleaseFailed")} {recorder.releaseError}
                  </p>
                )}
                {recorder.releaseFailed && (
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => recorder.retryRelease()}
                  >
                    {t("appShotStopRecording")}
                  </button>
                )}
                {shortcutKind === "chord" && (
                  <p className="app-shot-hint" data-app-shot-chord="">
                    {t("appShotSelectedChord", {
                      chord: appShotKeyChordAccelerator(shortcutChord)
                        .replace(
                          "CommandOrControl",
                          window.zenx.platform === "darwin"
                            ? "Command"
                            : "Ctrl",
                        )
                        .replace(
                          "Super",
                          window.zenx.platform === "darwin"
                            ? "Command"
                            : "Super",
                        ),
                    })}
                  </p>
                )}
                <p className="app-shot-hint">{t("appShotRecordHint")}</p>
              </fieldset>
            )}
            <label className="app-shot-option">
              <input
                type="checkbox"
                checked={armed}
                disabled={
                  disabled ||
                  (!armed &&
                    (busy ||
                      recording ||
                      recorder.pending ||
                      recorder.releaseFailed ||
                      (!canChooseShortcut && !compositorManaged)))
                }
                onChange={(event) => void toggleShortcut(event.target.checked)}
              />
              {t(
                configuration?.niriBinding
                  ? "appShotNiriEnable"
                  : managedByHyprland
                    ? "appShotHyprlandEnable"
                    : configuration?.portalShortcut
                      ? "appShotPortalEnable"
                      : "appShotGlobalShortcut",
              )}
            </label>
            <p className="app-shot-hint">
              {t(
                configuration?.niriBinding
                  ? "appShotNiriHint"
                  : managedByHyprland
                    ? "appShotHyprlandHint"
                    : configuration?.portalShortcut
                      ? "appShotPortalHint"
                      : window.zenx.platform === "linux"
                        ? "appShotLinuxShortcutHint"
                        : shortcutKind !== "chord"
                          ? "appShotModifierPairHint"
                          : "appShotGlobalHint",
              )}
            </p>
            {window.zenx.platform === "win32" &&
              (shortcutKind === "both-meta" || shortcutKind === "both-alt") && (
                <p className="app-shot-hint">
                  {t(
                    shortcutKind === "both-meta"
                      ? "appShotWindowsMenuWarning"
                      : "appShotAltMenuWarning",
                  )}
                </p>
              )}
            {portalState && (
              <>
                <p role="status" className="app-shot-hint">
                  {managedByHyprland
                    ? t(
                        portalState.actionRegistered
                          ? "appShotHyprlandActionRegistered"
                          : "appShotHyprlandActionMissing",
                      )
                    : portalState.registered
                      ? t("appShotPortalAssigned", {
                          shortcut:
                            portalState.shortcutDescription ??
                            t("appShotPortalAssignedUnknown"),
                        })
                      : t("appShotPortalNotAssigned")}
                </p>
                <div className="app-shot-actions">
                  {!managedByHyprland &&
                    portalState.canConfigure &&
                    api.configureShortcut && (
                      <button
                        type="button"
                        className="quiet-button"
                        disabled={disabled || shortcutBusy}
                        onClick={() => void configureShortcut()}
                      >
                        {t("appShotPortalConfigure")}
                      </button>
                    )}
                  {!portalState.registered && !portalState.actionRegistered && (
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
            {configuration?.hyprlandBinding && (
              <details className="app-shot-hyprland-binding">
                <summary>{t("appShotHyprlandBinding")}</summary>
                <p className="app-shot-hint">
                  {t("appShotHyprlandManualSetup")}
                </p>
                <p className="app-shot-hint">{t("appShotHyprlandLegacy")}</p>
                <pre className="app-shot-context">
                  {configuration.hyprlandBinding.legacy}
                </pre>
                <p className="app-shot-hint">{t("appShotHyprlandLua")}</p>
                <pre className="app-shot-context">
                  {configuration.hyprlandBinding.lua}
                </pre>
              </details>
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
