import { i18n } from "./i18n.js";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";

import type { ZenXCapabilityPermission } from "../../main/capabilities/types.js";
import type { ChromeBridgeSettingsSnapshot } from "../../main/chrome-extension-bridge.js";
import type { ZenXComputerReadinessSnapshot } from "../../main/computer-readiness.js";

export function PluginAccessReview({
  pluginId,
  permissions,
  onOpenGeneral,
}: {
  pluginId: "computer" | "browser";
  permissions: readonly ZenXCapabilityPermission[];
  onOpenGeneral?(pluginId: "computer" | "browser"): void;
}) {
  const { t } = useTranslation("settings");
  const [computer, setComputer] =
    useState<ZenXComputerReadinessSnapshot | null>(null);
  const [browser, setBrowser] = useState<ChromeBridgeSettingsSnapshot | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const refreshOnReturn = () => setRevision((value) => value + 1);
    window.addEventListener("focus", refreshOnReturn);
    return () => window.removeEventListener("focus", refreshOnReturn);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const operation =
      pluginId === "computer"
        ? (window.zenx.computerReadiness?.probe?.() ??
          window.zenx.computerReadiness?.get())
        : window.zenx.chromeBridge?.get();
    if (operation === undefined) {
      setError(
        i18n.t(
          "settings:pluginAccessReview.thisAppVersionCannotReadCurrentSetupStatus",
        ),
      );
      setLoading(false);
      return () => {
        active = false;
      };
    }
    void operation.then(
      (value) => {
        if (!active) return;
        if (pluginId === "computer") {
          setComputer(value as ZenXComputerReadinessSnapshot);
        } else {
          setBrowser(value as ChromeBridgeSettingsSnapshot);
        }
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!active) return;
        setComputer(null);
        setBrowser(null);
        setError(describeError(reason));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [pluginId, revision]);

  const openMacSettings = async (
    kind: "accessibility" | "screen-recording",
  ) => {
    setBusy(true);
    setError(null);
    try {
      await window.zenx.computerReadiness.openSettings(kind);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
      setRevision((value) => value + 1);
    }
  };

  return (
    <div
      className="plugin-access-review"
      aria-label={t("pluginAccessReview.namedAccessSetup", { name: pluginId })}
    >
      <div className="plugin-access-heading">
        <div>
          <strong>{t("pluginAccessReview.accessAndSetup")}</strong>
          <p>
            {t(
              "pluginAccessReview.enablingThePluginMakesItsToolsAvailableToAgents",
            )}
          </p>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          {t("pluginAccessReview.refreshStatus")}
        </button>
      </div>
      {permissions.length > 0 ? (
        <ul
          className="plugin-access-scopes"
          aria-label={t("pluginAccessReview.requestedAccess")}
        >
          {permissions.map((permission) => (
            <li key={permission.id}>
              <strong>{permission.title}</strong>
              <span>{permission.description}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="plugin-access-error" role="status">
          {t("pluginAccessReview.thisAppVersionCannotShowTheSelectedProviderS")}
        </p>
      )}
      {pluginId === "computer" ? (
        <div className="plugin-access-statuses">
          <AccessStatus
            title={t("pluginAccessReview.accessibility")}
            value={
              computer === null
                ? loading
                  ? t("pluginAccessReview.checking")
                  : t("pluginAccessReview.unknown")
                : computer.verification !== undefined
                  ? accessCheckLabel(computer.verification.accessibility.state)
                  : computer.accessibility === "granted"
                    ? t("pluginAccessReview.allowedByMacos")
                    : computer.accessibility === "needs-setup"
                      ? t("pluginAccessReview.needsSetup")
                      : computer.accessibility === "not-applicable"
                        ? t("pluginAccessReview.notApplicable")
                        : t("pluginAccessReview.unknown")
            }
            detail={
              computer?.verification?.accessibility.detail ??
              t(
                "pluginAccessReview.zenxChecksWhetherItsNativeHelperCanInspectOpen",
              )
            }
            action={
              computer?.platform === "darwin" &&
              (computer.verification?.accessibility.state === "needs-setup" ||
                (computer.verification === undefined &&
                  computer.accessibility !== "granted")) ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void openMacSettings("accessibility")}
                >
                  {t("pluginAccessReview.openAccessibilitySettings")}
                </button>
              ) : null
            }
          />
          <AccessStatus
            title={t("pluginAccessReview.screenRecording")}
            value={
              computer === null && !loading
                ? t("pluginAccessReview.unknown")
                : computer?.verification !== undefined
                  ? accessCheckLabel(computer.verification.screenCapture.state)
                  : screenRecordingLabel(computer?.screenRecording)
            }
            detail={
              computer?.verification?.screenCapture.detail ??
              t("pluginAccessReview.zenxChecksASmallWindowPreviewAndDiscardsIt")
            }
            action={
              computer?.platform === "darwin" &&
              (computer.verification?.screenCapture.state === "needs-setup" ||
                (computer.verification === undefined &&
                  computer.screenRecording !== "granted")) ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void openMacSettings("screen-recording")}
                >
                  {t("pluginAccessReview.openScreenRecordingSettings")}
                </button>
              ) : null
            }
          />
          <AccessStatus
            title={t("pluginAccessReview.foregroundControl")}
            value={
              computer === null
                ? loading
                  ? t("pluginAccessReview.checking")
                  : t("pluginAccessReview.unknown")
                : computer.foregroundControlEnabled
                  ? t("pluginAccessReview.optedIn")
                  : t("pluginAccessReview.offOptional")
            }
            detail={t(
              "pluginAccessReview.globalPointerKeyboardFocusAndScrollingRequireASeparate",
            )}
            action={
              onOpenGeneral === undefined ? null : (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onOpenGeneral("computer")}
                >
                  {t("pluginAccessReview.openGeneralSettings")}
                </button>
              )
            }
          />
          {computer?.platform === "darwin" &&
          (needsAccessibilitySetup(computer) || needsScreenSetup(computer)) ? (
            <div className="plugin-access-steps">
              <strong>{t("pluginAccessReview.completeMacosSetup")}</strong>
              <ol>
                {!needsAccessibilitySetup(computer) ? null : (
                  <li>
                    {t(
                      "pluginAccessReview.inSystemSettingsPrivacySecurityAccessibilityTurnOnThe",
                    )}
                  </li>
                )}
                {!needsScreenSetup(computer) ? null : (
                  <li>
                    {t(
                      "pluginAccessReview.inScreenSystemAudioRecordingTurnOnZenxFor",
                    )}
                  </li>
                )}
                <li>
                  {t(
                    "pluginAccessReview.relaunchZenxIfMacosAsksThenReturnHereZenx",
                  )}
                </li>
              </ol>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="plugin-access-statuses">
          <AccessStatus
            title={
              browser?.effectiveMode === "user-session"
                ? t("pluginAccessReview.connectedChrome")
                : t("pluginAccessReview.zenxBrowser")
            }
            value={
              browser === null && !loading
                ? t("pluginAccessReview.statusUnavailable")
                : browserStatusLabel(browser)
            }
            detail={
              browser === null && !loading
                ? t(
                    "pluginAccessReview.couldNotReadChromeConnectionStateRefreshStatusTo",
                  )
                : browserStatusDetail(browser)
            }
            action={
              onOpenGeneral === undefined ? null : (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onOpenGeneral("browser")}
                >
                  {t("pluginAccessReview.openBrowserSettings")}
                </button>
              )
            }
          />
        </div>
      )}
      {error === null ? null : (
        <p className="plugin-access-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function AccessStatus({
  title,
  value,
  detail,
  action,
}: {
  title: string;
  value: string;
  detail: string;
  action: React.ReactNode;
}) {
  return (
    <div className="plugin-access-status">
      <div>
        <strong>{title}</strong>
        <span role="status">{value}</span>
        <p>{detail}</p>
      </div>
      {action}
    </div>
  );
}

function screenRecordingLabel(
  value: ZenXComputerReadinessSnapshot["screenRecording"] | undefined,
): string {
  switch (value) {
    case "granted":
      return i18n.t("settings:pluginAccessReview.allowed");
    case "denied":
    case "restricted":
      return i18n.t("settings:pluginAccessReview.needsSetup");
    case "not-determined":
      return i18n.t("settings:pluginAccessReview.notRequested");
    case "not-applicable":
      return i18n.t("settings:pluginAccessReview.notApplicable");
    case "unknown":
      return i18n.t("settings:pluginAccessReview.unknown");
    default:
      return i18n.t("settings:pluginAccessReview.checking");
  }
}

function accessCheckLabel(
  state: NonNullable<
    ZenXComputerReadinessSnapshot["verification"]
  >["accessibility"]["state"],
): string {
  switch (state) {
    case "ready":
      return i18n.t("settings:pluginAccessReview.verified");
    case "needs-setup":
      return i18n.t("settings:pluginAccessReview.needsSetup");
    case "failed":
      return i18n.t("settings:pluginAccessReview.checkFailed");
    case "not-applicable":
      return i18n.t("settings:pluginAccessReview.notApplicable");
    case "unknown":
      return i18n.t("settings:pluginAccessReview.couldNotVerify");
  }
}

function needsAccessibilitySetup(
  computer: ZenXComputerReadinessSnapshot,
): boolean {
  return computer.verification === undefined
    ? computer.accessibility === "needs-setup"
    : computer.verification.accessibility.state === "needs-setup";
}

function needsScreenSetup(computer: ZenXComputerReadinessSnapshot): boolean {
  return computer.verification === undefined
    ? computer.screenRecording === "denied" ||
        computer.screenRecording === "restricted" ||
        computer.screenRecording === "not-determined"
    : computer.verification.screenCapture.state === "needs-setup";
}

function browserStatusLabel(
  value: ChromeBridgeSettingsSnapshot | null,
): string {
  if (value === null) return i18n.t("settings:pluginAccessReview.checking");
  if (value.effectiveMode !== "user-session")
    return i18n.t("settings:pluginAccessReview.noChromeSetupNeeded");
  if (value.connection.state === "connected")
    return i18n.t("settings:pluginAccessReview.connected");
  if (value.connector === "external-cdp")
    return i18n.t("settings:pluginAccessReview.externalEndpointConfigured");
  if (value.connector === "inactive")
    return i18n.t("settings:pluginAccessReview.connectorUnavailable");
  return value.nativeHostRegistered
    ? i18n.t("settings:pluginAccessReview.chromeNotConnected")
    : i18n.t("settings:pluginAccessReview.needsSetup");
}

function browserStatusDetail(
  value: ChromeBridgeSettingsSnapshot | null,
): string {
  if (value === null)
    return i18n.t(
      "settings:pluginAccessReview.checkingWhichBrowserModeZenxIsUsing",
    );
  if (value.effectiveMode !== "user-session") {
    return i18n.t(
      "settings:pluginAccessReview.usesASeparateZenxBrowserSessionNoChromeConnector",
    );
  }
  if (value.connection.state === "connected") {
    return i18n.t("settings:pluginAccessReview.chromeTabsAvailable", {
      count: value.connection.tabCount,
    });
  }
  if (value.connector === "external-cdp") {
    return i18n.t("settings:pluginAccessReview.externalChromeEndpoint");
  }
  if (value.connector === "inactive") {
    return i18n.t(
      "settings:pluginAccessReview.theConnectedChromeConnectorIsNotRunningApplyThe",
    );
  }
  return i18n.t(
    "settings:pluginAccessReview.registerTheLocalConnectorLoadTheExtensionThenClick",
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
