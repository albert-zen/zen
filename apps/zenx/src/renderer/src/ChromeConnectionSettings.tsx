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
  const [snapshot, setSnapshot] = useState<ChromeBridgeSettingsSnapshot | null>(
    null,
  );
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
  const connected = snapshot?.connection.connectedTab;
  return (
    <div className="page-card settings-card chrome-connection-settings">
      <div className="settings-card-head">
        <div>
          <h3>Browser session</h3>
          <p>
            Choose the isolated ZenX browser or one Chrome tab that you connect
            explicitly from Chrome.
          </p>
        </div>
        <span
          className={connected === undefined ? "status-muted" : "status-good"}
        >
          {connected === undefined
            ? "No Chrome tab connected"
            : "Chrome tab connected"}
        </span>
      </div>
      <label className="field">
        <span>Agent browser</span>
        <select
          value={selectedMode}
          onChange={(event) =>
            setDraft({
              ...draft,
              browserMode: event.target.value as "isolated" | "user-session",
            })
          }
        >
          <option value="isolated">Isolated ZenX browser</option>
          <option value="user-session">Explicit Chrome tab</option>
        </select>
        <small className="settings-note">
          Changing this mode takes effect after restarting ZenX. An explicit
          ZENX_BROWSER_MODE environment value overrides this setting.
        </small>
      </label>
      {selectedMode === "user-session" ? (
        <>
          <div className="settings-row">
            <div>
              <strong>1. Register the local connector</strong>
              <span>
                Chrome may start only this ZenX executable. The registration
                accepts the fixed ZenX extension ID and no wildcard origins.
              </span>
            </div>
            <div className="settings-actions">
              {snapshot?.nativeHostRegistered ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    void run("remove", window.zenx.chromeBridge.remove)
                  }
                >
                  {busy === "remove" ? "Removing…" : "Remove connector"}
                </button>
              ) : (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy !== null || snapshot?.packaged === false}
                  onClick={() =>
                    void run("prepare", window.zenx.chromeBridge.prepare)
                  }
                >
                  {busy === "prepare" ? "Registering…" : "Register connector"}
                </button>
              )}
            </div>
          </div>
          <div className="settings-row">
            <div>
              <strong>2. Load the ZenX extension</strong>
              <span>
                Open chrome://extensions, enable Developer mode, choose Load
                unpacked, then select the folder opened here.
              </span>
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void window.zenx.chromeBridge.openExtension()}
            >
              Show extension folder
            </button>
          </div>
          <div className="settings-row">
            <div>
              <strong>3. Connect one current tab</strong>
              <span>
                Open the signed-in page in Chrome and click the ZenX extension.
                Click it again to revoke access. Closing ZenX or disabling the
                extension also disconnects the debugger.
              </span>
            </div>
            <span
              className={
                connected === undefined ? "status-muted" : "status-good"
              }
            >
              {connected === undefined
                ? "Waiting for a tab"
                : `${connected.title || "Untitled tab"} · ${safeHost(connected.url)}`}
            </span>
          </div>
          <p className="settings-note">
            The original page stays in Chrome and keeps its existing login
            state. ZenX receives debugger access only to the selected tab; it
            does not copy cookies or enumerate the rest of the profile. The
            Attached browser panel is an observation surface, not an embedded
            copy of the Chrome tab.
          </p>
        </>
      ) : null}
      {snapshot?.environmentOverride ? (
        <p className="settings-note" role="status">
          The current launch is using the ZENX_BROWSER_MODE environment
          override.
        </p>
      ) : null}
      {error === null ? null : (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function safeHost(value: string): string {
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
