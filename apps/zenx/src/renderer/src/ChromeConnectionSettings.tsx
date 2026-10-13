import { useTranslation } from "react-i18next";
import { Select } from "./ui/controls.js";
import { useEffect, useState } from "react";

import type { ChromeBridgeSettingsSnapshot } from "../../main/chrome-extension-bridge.js";
import type { ZenXHostProfile } from "../../main/host-profile.js";

export function ChromeConnectionSettings({
  draft,
  setDraft,
}: {
  draft: ZenXHostProfile;
  setDraft(value: ZenXHostProfile): void;
}) {
  const { t } = useTranslation("settings");
  const [snapshot, setSnapshot] = useState<ChromeBridgeSettingsSnapshot | null>(
    null,
  );
  const [registrationBrowser, setRegistrationBrowser] = useState<
    "chrome" | "edge"
  >("chrome");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const api = window.zenx.chromeBridge;
    if (api === undefined) return () => undefined;
    const refresh = () =>
      void api.get().then(
        (value) => active && setSnapshot(value),
        (reason: unknown) => active && setError(describeError(reason)),
      );
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const run = async (
    key: string,
    operation: () => Promise<ChromeBridgeSettingsSnapshot>,
  ) => {
    setBusy(key);
    setError(null);
    try {
      setSnapshot(await operation());
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  };

  const selectedMode = draft.browserMode ?? "isolated";
  const connected = snapshot?.connection.state === "connected";
  const tabCount = snapshot?.connection.tabCount ?? 0;
  return (
    <div
      id="browser-settings"
      className="page-card settings-card chrome-connection-settings"
      tabIndex={-1}
    >
      <div className="settings-card-head">
        <div>
          <h3>{t("chromeConnectionSettings.browser")}</h3>
          <p>{t("chromeConnectionSettings.chooseWhereBrowserToolsWork")}</p>
        </div>
        <span
          role="status"
          className={connected ? "status-good" : "status-muted"}
        >
          {connected
            ? t("chromeConnectionSettings.chromeConnected")
            : t("chromeConnectionSettings.chromeNotConnected")}
        </span>
      </div>
      <p className="settings-note">
        {t("chromeConnectionSettings.workspaceAlwaysAvailable")}
      </p>
      <label className="settings-row">
        <span>{t("chromeConnectionSettings.enableExternalBrowser")}</span>
        <input
          type="checkbox"
          checked={selectedMode === "user-session"}
          onChange={(event) =>
            setDraft({
              ...draft,
              browserMode: event.currentTarget.checked
                ? "user-session"
                : "isolated",
            })
          }
        />
      </label>
      <p className="settings-note">
        {t(
          "chromeConnectionSettings.changingThisModeTakesEffectAfterRestartingZenx",
        )}
      </p>
      {selectedMode === "user-session" ? (
        <>
          <label className="field">
            <span>{t("chromeConnectionSettings.connectorBrowser")}</span>
            <Select
              value={registrationBrowser}
              onValueChange={(value) =>
                setRegistrationBrowser(value as "chrome" | "edge")
              }
            >
              <option value="chrome">Google Chrome</option>
              <option value="edge">Microsoft Edge</option>
            </Select>
          </label>
          <div className="settings-row">
            <div>
              <strong>
                {t("chromeConnectionSettings.1RegisterTheLocalConnector")}
              </strong>
              <span>
                {t(
                  "chromeConnectionSettings.letChromeConnectToThisInstalledZenxApp",
                )}
              </span>
            </div>
            <div className="settings-actions">
              {(
                registrationBrowser === "edge"
                  ? snapshot?.edgeNativeHostRegistered
                  : snapshot?.nativeHostRegistered
              ) ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    void run("remove", () =>
                      window.zenx.chromeBridge.remove(registrationBrowser),
                    )
                  }
                >
                  {busy === "remove"
                    ? t("chromeConnectionSettings.removing")
                    : t("chromeConnectionSettings.removeConnector")}
                </button>
              ) : (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy !== null || snapshot?.packaged === false}
                  onClick={() =>
                    void run("prepare", () =>
                      window.zenx.chromeBridge.prepare(registrationBrowser),
                    )
                  }
                >
                  {busy === "prepare"
                    ? t("chromeConnectionSettings.registering")
                    : t("chromeConnectionSettings.registerConnector")}
                </button>
              )}
            </div>
          </div>
          <div className="settings-row">
            <div>
              <strong>
                {t("chromeConnectionSettings.2LoadTheZenxExtension")}
              </strong>
              <span>
                {t(
                  "chromeConnectionSettings.openChromeExtensionsEnableDeveloperModeChooseLoadUnpacked",
                )}
              </span>
            </div>
            <button
              className="secondary-button"
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void run("open", async () => {
                  await window.zenx.chromeBridge.openExtension();
                  return await window.zenx.chromeBridge.get();
                })
              }
            >
              {busy === "open"
                ? t("chromeConnectionSettings.opening")
                : t("chromeConnectionSettings.showExtensionFolder")}
            </button>
          </div>
          <div className="settings-row">
            <div>
              <strong>
                {t("chromeConnectionSettings.3ConnectYourBrowser")}
              </strong>
              <span>
                {t(
                  "chromeConnectionSettings.clickTheZenxExtensionOnceInChromeExistingAnd",
                )}
              </span>
            </div>
            <span className={connected ? "status-good" : "status-muted"}>
              {connected
                ? t("chromeConnectionSettings.tabsAvailable", {
                    count: tabCount,
                  })
                : t("chromeConnectionSettings.waitingForChrome")}
            </span>
          </div>
          <p className="settings-note">
            {t(
              "chromeConnectionSettings.keepUsingYourUsualChromeWindowsAndSignedIn",
            )}
          </p>
        </>
      ) : null}
      {error === null ? null : (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
