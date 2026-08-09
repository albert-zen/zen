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
    setBusy(capability.manifest.id);
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
    return (
      <div className="settings-card capability-settings">
        <h2>Agent capabilities</h2>
        <p className="settings-note">{error ?? "Loading capabilities…"}</p>
      </div>
    );
  }

  return (
    <div className="settings-card capability-settings">
      <div className="capability-heading">
        <div>
          <h2>Agent capabilities</h2>
          <p className="settings-note">
            Grants control which structured tools the Agent can discover and
            execute. Per-call approval and the execution sandbox remain
            separate. Foreground-required tools are labeled because they may
            temporarily take over pointer, keyboard, or focus; Stop cancels a
            running operation.
          </p>
        </div>
        <span>{snapshot.capabilities.length} installed</span>
      </div>
      <div className="capability-list">
        {snapshot.capabilities.map((capability) => {
          const granted =
            capability.manifest.permissions.length ===
            capability.granted.length;
          return (
            <article className="capability-card" key={capability.manifest.id}>
              <header>
                <div>
                  <strong>{capability.manifest.displayName}</strong>
                  <span>
                    {capability.source} · v{capability.manifest.version}
                  </span>
                  <span>
                    {capability.manifest.provider.id} ·{" "}
                    {capability.manifest.provider.platforms.join(", ")}
                  </span>
                  {capability.available ? null : (
                    <span>{capability.unavailableReason}</span>
                  )}
                </div>
                <button
                  className={granted ? "danger-button" : "primary-button"}
                  type="button"
                  disabled={busy !== null || !capability.available}
                  onClick={() => void setGranted(capability, !granted)}
                >
                  {busy === capability.manifest.id
                    ? "Restarting host…"
                    : granted
                      ? "Revoke"
                      : "Grant"}
                </button>
              </header>
              <p>{capability.manifest.description}</p>
              <ul>
                {capability.manifest.permissions.map((permission) => {
                  const allowed = capability.granted.some(
                    (grant) => grant.permissionId === permission.id,
                  );
                  return (
                    <li key={permission.id}>
                      <Icon name={allowed ? "check" : "warning"} size={12} />
                      <span>
                        <strong>{permission.title}</strong>
                        <small>
                          {permission.scope} · {permission.description}
                        </small>
                      </span>
                    </li>
                  );
                })}
              </ul>
              <ul>
                {capability.manifest.tools.map((tool) => (
                  <li key={tool.name}>
                    <Icon
                      name={
                        tool.interactionMode !== "foreground_required"
                          ? "check"
                          : "warning"
                      }
                      size={12}
                    />
                    <span>
                      <strong>{tool.name}</strong>
                      <small>
                        {tool.interactionMode} · {tool.capabilities.join(", ")}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
              <footer>
                {capability.enabledTools.length} of{" "}
                {capability.manifest.tools.length} tools exposed ·{" "}
                {
                  capability.manifest.tools.filter(
                    (tool) => tool.interactionMode === "background_safe",
                  ).length
                }{" "}
                background-safe · {capability.blockedTools.length} foreground
                blocked · {capability.manifest.resources.length} instruction
                resources
              </footer>
            </article>
          );
        })}
      </div>
      {snapshot.recentInvocations.length === 0 ? null : (
        <div className="capability-audit">
          <h3>Recent capability use</h3>
          {snapshot.recentInvocations.slice(0, 8).map((invocation) => (
            <div key={invocation.id}>
              <Icon
                name={invocation.status === "completed" ? "check" : "warning"}
                size={12}
              />
              <code>{invocation.toolName}</code>
              <span>{invocation.interactionMode}</span>
              <span>{invocation.status}</span>
              <time>{new Date(invocation.startedAt).toLocaleTimeString()}</time>
            </div>
          ))}
        </div>
      )}
      {snapshot.discoveryErrors.map((message) => (
        <div className="settings-error" role="alert" key={message}>
          <Icon name="warning" size={14} />
          Local capability: {message}
        </div>
      ))}
      {error === null ? null : (
        <div className="settings-error" role="alert">
          <Icon name="warning" size={14} />
          {error}
        </div>
      )}
    </div>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
