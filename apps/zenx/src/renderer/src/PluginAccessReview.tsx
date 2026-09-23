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
      setError("This app version cannot read current setup status.");
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
      aria-label={`${pluginId} access and setup`}
    >
      <div className="plugin-access-heading">
        <div>
          <strong>Access and setup</strong>
          <p>
            Enabling the plugin makes its tools available to agents. It does not
            grant access in macOS or connect Chrome.
          </p>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh status
        </button>
      </div>
      {permissions.length > 0 ? (
        <ul className="plugin-access-scopes" aria-label="Requested access">
          {permissions.map((permission) => (
            <li key={permission.id}>
              <strong>{permission.title}</strong>
              <span>{permission.description}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="plugin-access-error" role="status">
          This app version cannot show the selected provider’s complete access
          list. Update ZenX before enabling it.
        </p>
      )}
      {pluginId === "computer" ? (
        <div className="plugin-access-statuses">
          <AccessStatus
            title="Accessibility"
            value={
              computer === null
                ? loading
                  ? "Checking…"
                  : "Unknown"
                : computer.verification !== undefined
                  ? accessCheckLabel(computer.verification.accessibility.state)
                  : computer.accessibility === "granted"
                    ? "Allowed by macOS"
                    : computer.accessibility === "needs-setup"
                      ? "Needs setup"
                      : computer.accessibility === "not-applicable"
                        ? "Not applicable"
                        : "Unknown"
            }
            detail={
              computer?.verification?.accessibility.detail ??
              "ZenX checks whether its native helper can inspect open windows. No window details are saved by this check."
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
                  Open Accessibility settings
                </button>
              ) : null
            }
          />
          <AccessStatus
            title="Screen Recording"
            value={
              computer === null && !loading
                ? "Unknown"
                : computer?.verification !== undefined
                  ? accessCheckLabel(computer.verification.screenCapture.state)
                  : screenRecordingLabel(computer?.screenRecording)
            }
            detail={
              computer?.verification?.screenCapture.detail ??
              "ZenX checks a small window preview and discards it. If Screen Recording is already on, reopen ZenX; if still blocked, remove its old entry and add this ZenX.app again."
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
                  Open Screen Recording settings
                </button>
              ) : null
            }
          />
          <AccessStatus
            title="Foreground control"
            value={
              computer === null
                ? loading
                  ? "Checking…"
                  : "Unknown"
                : computer.foregroundControlEnabled
                  ? "Opted in"
                  : "Off (optional)"
            }
            detail="Global pointer, keyboard, focus and scrolling require a separate opt-in. Background-safe actions do not."
            action={
              onOpenGeneral === undefined ? null : (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onOpenGeneral("computer")}
                >
                  Open General settings
                </button>
              )
            }
          />
          {computer?.platform === "darwin" &&
          (needsAccessibilitySetup(computer) || needsScreenSetup(computer)) ? (
            <div className="plugin-access-steps">
              <strong>Complete macOS setup</strong>
              <ol>
                {!needsAccessibilitySetup(computer) ? null : (
                  <li>
                    In System Settings → Privacy & Security → Accessibility,
                    turn on the current ZenX app. If it is absent, click Add (+)
                    and choose the ZenX.app you launched.
                  </li>
                )}
                {!needsScreenSetup(computer) ? null : (
                  <li>
                    In Screen & System Audio Recording, turn on ZenX for screen
                    access. If absent, click Add (+) and choose the same app.
                  </li>
                )}
                <li>
                  Relaunch ZenX if macOS asks, then return here. ZenX checks
                  both access paths again when this page opens.
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
                ? "Connected Chrome"
                : "ZenX browser"
            }
            value={
              browser === null && !loading
                ? "Status unavailable"
                : browserStatusLabel(browser)
            }
            detail={
              browser === null && !loading
                ? "Could not read Chrome connection state. Refresh status to try again."
                : browserStatusDetail(browser)
            }
            action={
              onOpenGeneral === undefined ? null : (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onOpenGeneral("browser")}
                >
                  Open Browser settings
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
      return "Allowed";
    case "denied":
    case "restricted":
      return "Needs setup";
    case "not-determined":
      return "Not requested";
    case "not-applicable":
      return "Not applicable";
    case "unknown":
      return "Unknown";
    default:
      return "Checking…";
  }
}

function accessCheckLabel(
  state: NonNullable<
    ZenXComputerReadinessSnapshot["verification"]
  >["accessibility"]["state"],
): string {
  switch (state) {
    case "ready":
      return "Verified";
    case "needs-setup":
      return "Needs setup";
    case "failed":
      return "Check failed";
    case "not-applicable":
      return "Not applicable";
    case "unknown":
      return "Could not verify";
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
  if (value === null) return "Checking…";
  if (value.effectiveMode !== "user-session") return "No Chrome setup needed";
  if (value.connection.state === "connected") return "Connected";
  if (value.connector === "external-cdp") return "External endpoint configured";
  if (value.connector === "inactive") return "Connector unavailable";
  return value.nativeHostRegistered ? "Chrome not connected" : "Needs setup";
}

function browserStatusDetail(
  value: ChromeBridgeSettingsSnapshot | null,
): string {
  if (value === null) return "Checking which browser mode ZenX is using.";
  if (value.effectiveMode !== "user-session") {
    return "Uses a separate ZenX browser session. No Chrome connector or macOS desktop permission is needed.";
  }
  if (value.connection.state === "connected") {
    return `${value.connection.tabCount} Chrome tabs available. Agents and you use the same signed-in tabs.`;
  }
  if (value.connector === "external-cdp") {
    return "ZenX is using an externally configured Chrome debugging endpoint. Check that endpoint if tabs are missing.";
  }
  if (value.connector === "inactive") {
    return "The Connected Chrome connector is not running. Apply the browser mode and restart ZenX, then check Browser settings.";
  }
  return "Register the local connector, load the extension, then click it in Chrome. General settings shows each step.";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
