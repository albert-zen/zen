import { useEffect, useState } from "react";

import type {
  ZenXCapabilitySnapshot,
  ZenXCapabilitySummary,
} from "../../main/capabilities/types.js";
import { Icon } from "./icons.js";

export function CapabilitySettings() {
  const [snapshot, setSnapshot] = useState<ZenXCapabilitySnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const dispose = window.zenx.capabilities.onChange((value) => {
      if (active) setSnapshot(value);
    });
    void window.zenx.capabilities
      .get()
      .then((value) => active && setSnapshot(value))
      .catch((reason: unknown) => active && setError(describeError(reason)));
    return () => {
      active = false;
      dispose();
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
      setSnapshot(next);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  };

  if (snapshot === null) {
    return <div className="page-card settings-card"><p>{error ?? "Loading installed plugins…"}</p></div>;
  }

  return (
    <>
      <div className="page-card settings-card plugin-boundary">
        <span className="plugin-icon"><Icon name="layers" /></span>
        <div><strong>Extension boundary</strong><span>Projects, Inbox, Threads, and Settings remain native. Loaded packages can mount declared pages only in Plugin spaces.</span></div>
        <small>{snapshot.contributions.filter((item) => item.enabled && item.available).length} Sidebar contributions active</small>
      </div>

      {snapshot.contributions.length === 0 ? null : (
        <div className="page-card settings-card">
          <div className="settings-card-head"><div><h3>Plugin spaces</h3><p>Page enablement is independent from Agent tool grants and per-call approval.</p></div></div>
          <div className="capability-list compact">
            {snapshot.contributions.map((contribution) => (
              <div className="capability-row" key={`${contribution.capabilityId}:${contribution.id}`}>
                <span className="plugin-icon"><Icon name={contribution.icon === "rooms" ? "users" : "trigger"} /></span>
                <div><strong>{contribution.label}</strong><span>{contribution.available ? `${contribution.page} page · bundled contribution` : "Package unavailable"}</span></div>
                <button
                  className="plugin-switch"
                  type="button"
                  role="switch"
                  aria-checked={contribution.enabled}
                  aria-label={`${contribution.enabled ? "Disable" : "Enable"} ${contribution.label} plugin space`}
                  disabled={busy !== null || !contribution.available}
                  onClick={() => {
                    const key = `contribution:${contribution.capabilityId}:${contribution.id}`;
                    setBusy(key); setError(null);
                    void window.zenx.capabilities.setContributionEnabled(contribution.capabilityId, contribution.id, !contribution.enabled).then(setSnapshot).catch((reason: unknown) => setError(describeError(reason))).finally(() => setBusy(null));
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="page-card settings-card">
        <div className="settings-card-head"><div><h3>Installed capability packages</h3><p>Grants control Agent tools. They do not mount or hide product pages.</p></div><span>{snapshot.capabilities.length} installed locally</span></div>
        <div className="capability-list">
          {snapshot.capabilities.map((capability) => {
            const granted = capability.manifest.permissions.length > 0 && capability.manifest.permissions.length === capability.granted.length;
            return <div className="capability-row" key={capability.manifest.id}><span className="plugin-icon"><Icon name={capability.manifest.id === "browser" ? "search" : capability.manifest.id === "computer" ? "panel-right" : capability.manifest.id.includes("automation") ? "trigger" : "layers"} /></span><div><strong>{capability.manifest.displayName}</strong><span>{capability.source} · v{capability.manifest.version} · {capability.manifest.permissions.length} permissions · {capability.manifest.tools.length} tools{capability.available ? "" : ` · ${capability.unavailableReason}`}</span></div><button className={granted ? "danger-button" : "secondary-button"} type="button" disabled={busy !== null || !capability.available || capability.manifest.permissions.length === 0} onClick={() => void setGranted(capability, !granted)}>{busy === `grant:${capability.manifest.id}` ? "Restarting…" : granted ? "Revoke" : "Grant"}</button></div>;
          })}
        </div>
      </div>

      {snapshot.providerDiagnostics.length === 0 ? null : <div className="page-card settings-card"><div className="settings-card-head"><div><h3>Execution providers</h3><p>Availability reported by the current local capability catalog.</p></div></div>{snapshot.providerDiagnostics.map((provider) => <div className="settings-row" key={`${provider.capabilityId}:${provider.providerId}`}><div><strong>{provider.providerId}</strong><span>{provider.reason ?? provider.permissionSummary ?? provider.interactionModes.join(", ")}</span></div><small className={provider.status === "unavailable" ? "status-bad" : "status-good"}>{provider.status}</small></div>)}</div>}
      {error ? <div className="settings-error" role="alert"><Icon name="warning" />{error}</div> : null}
    </>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
