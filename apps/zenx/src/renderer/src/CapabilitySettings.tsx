import { useEffect, useState } from "react";

import type {
  ZenXCapabilitySnapshot,
  ZenXCapabilitySummary,
  ZenXPluginSnapshot,
  ZenXPluginSummary,
} from "../../main/capabilities/types.js";
import { Icon } from "./icons.js";

export function CapabilitySettings() {
  const [capabilities, setCapabilities] =
    useState<ZenXCapabilitySnapshot | null>(null);
  const [plugins, setPlugins] = useState<ZenXPluginSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const disposeCapabilities = window.zenx.capabilities.onChange((value) => {
      if (active) setCapabilities(value);
    });
    const disposePlugins = window.zenx.plugins.onChange((value) => {
      if (active) setPlugins(value);
    });
    void Promise.all([window.zenx.capabilities.get(), window.zenx.plugins.get()])
      .then(([nextCapabilities, nextPlugins]) => {
        if (!active) return;
        setCapabilities(nextCapabilities);
        setPlugins(nextPlugins);
      })
      .catch((reason: unknown) => active && setError(describeError(reason)));
    return () => {
      active = false;
      disposeCapabilities();
      disposePlugins();
    };
  }, []);

  const setGranted = async (
    capability: ZenXCapabilitySummary,
    grant: boolean,
  ) => {
    setBusy(`grant:${capability.manifest.id}`);
    setError(null);
    try {
      const next = grant
        ? await window.zenx.capabilities.grant(capability.manifest.id)
        : await window.zenx.capabilities.revoke(capability.manifest.id);
      setCapabilities(next);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  };

  const setPluginEnabled = async (
    plugin: ZenXPluginSummary,
    enabled: boolean,
  ) => {
    setBusy(`plugin:${plugin.id}`);
    setError(null);
    try {
      setPlugins(await window.zenx.plugins.setEnabled(plugin.id, enabled));
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  };

  if (capabilities === null || plugins === null) {
    return (
      <div className="page-card settings-card">
        <p>{error ?? "Loading installed plugins…"}</p>
      </div>
    );
  }

  const contributedPlugins = plugins.plugins.filter(
    (plugin) => plugin.contributionCount > 0,
  );

  return (
    <>
      <div className="page-card settings-card plugin-boundary">
        <span className="plugin-icon"><Icon name="layers" /></span>
        <div>
          <strong>Extension boundary</strong>
          <span>Projects, Inbox, Threads, and Settings remain native. Enabled packages can mount only their declared pages in Plugin spaces.</span>
        </div>
        <small>{plugins.sidebar.length} Sidebar contributions active</small>
      </div>

      {contributedPlugins.length === 0 ? null : (
        <div className="page-card settings-card">
          <div className="settings-card-head">
            <div>
              <h3>Plugin spaces</h3>
              <p>Disabling a package removes its product space and its Agent tools. Permission grants remain a separate control.</p>
            </div>
          </div>
          <div className="capability-list compact">
            {contributedPlugins.map((plugin) => (
              <div className="capability-row" key={plugin.id}>
                <span className="plugin-icon"><Icon name={pluginIcon(plugin.id)} /></span>
                <div>
                  <strong>{plugin.displayName}</strong>
                  <span>{plugin.source} · v{plugin.version} · {plugin.contributionCount} contributions</span>
                </div>
                <button
                  className="plugin-switch"
                  type="button"
                  role="switch"
                  aria-checked={plugin.enabled}
                  aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.displayName}`}
                  disabled={busy !== null}
                  onClick={() => void setPluginEnabled(plugin, !plugin.enabled)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="page-card settings-card">
        <div className="settings-card-head">
          <div>
            <h3>Installed capability packages</h3>
            <p>Grants decide which enabled tools the Agent may call. They do not install or mount pages.</p>
          </div>
          <span>{capabilities.capabilities.length} installed locally</span>
        </div>
        <div className="capability-list">
          {capabilities.capabilities.map((capability) => {
            const granted =
              capability.manifest.permissions.length > 0 &&
              capability.manifest.permissions.length === capability.granted.length;
            return (
              <div className="capability-row" key={capability.manifest.id}>
                <span className="plugin-icon"><Icon name={pluginIcon(capability.manifest.id)} /></span>
                <div>
                  <strong>{capability.manifest.displayName}</strong>
                  <span>{capability.source} · v{capability.manifest.version} · {capability.enabled ? "enabled" : "disabled"} · {capability.manifest.permissions.length} permissions · {capability.manifest.tools.length} tools{capability.available ? "" : ` · ${capability.unavailableReason}`}</span>
                </div>
                <button
                  className={granted ? "danger-button" : "secondary-button"}
                  type="button"
                  disabled={busy !== null || !capability.enabled || !capability.available || capability.manifest.permissions.length === 0}
                  onClick={() => void setGranted(capability, !granted)}
                >
                  {busy === `grant:${capability.manifest.id}` ? "Restarting…" : granted ? "Revoke" : "Grant"}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {capabilities.providerDiagnostics.length === 0 ? null : (
        <div className="page-card settings-card">
          <div className="settings-card-head">
            <div><h3>Execution providers</h3><p>Availability reported by the current local capability catalog.</p></div>
          </div>
          {capabilities.providerDiagnostics.map((provider) => (
            <div className="settings-row" key={`${provider.capabilityId}:${provider.providerId}`}>
              <div><strong>{provider.providerId}</strong><span>{provider.reason ?? provider.permissionSummary ?? provider.interactionModes.join(", ")}</span></div>
              <small className={provider.status === "unavailable" ? "status-bad" : "status-good"}>{provider.status}</small>
            </div>
          ))}
        </div>
      )}
      {error ? <div className="settings-error" role="alert"><Icon name="warning" />{error}</div> : null}
    </>
  );
}

function pluginIcon(id: string): "search" | "panel-right" | "trigger" | "users" | "layers" {
  if (id === "browser") return "search";
  if (id === "computer") return "panel-right";
  if (id.includes("triggers")) return "trigger";
  if (id.includes("rooms")) return "users";
  return "layers";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
