import { useEffect, useState } from "react";
import {
  pluginReadiness,
  requirementsReady,
  type PluginReadiness,
  type PluginRequirement,
} from "../../plugin-readiness.js";

/** Ordinary plugin lifecycle preview, reusable by any configuration/preset UI. */
export function PluginRequirementsPreview({
  requirements,
  onReady,
  openSettings,
}: {
  requirements: readonly PluginRequirement[];
  onReady(ready: boolean): void;
  openSettings(): void;
}) {
  const [readiness, setReadiness] = useState<PluginReadiness[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    let changeRevision = 0;
    const update = (plugins: Parameters<typeof pluginReadiness>[0]) => {
      if (!active) return;
      const next = pluginReadiness(
        plugins,
        requirements.map((entry) => entry.pluginId),
      );
      setReadiness(next);
      setError(false);
      onReady(requirementsReady(requirements, next));
    };
    onReady(false);
    void window.zenx.plugins.get().then(
      (snapshot) => {
        if (changeRevision === 0) update(snapshot.plugins);
      },
      () => {
        if (!active) return;
        setError(true);
        onReady(false);
      },
    );
    const unsubscribe = window.zenx.plugins.onChange((snapshot) => {
      changeRevision++;
      update(snapshot.plugins);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [requirements, onReady]);
  const missing = readiness?.some((entry) => entry.state !== "ready");
  return (
    <section
      aria-label="Plugin readiness"
      className="room-assistant-disclosure"
    >
      {error ? (
        <p role="alert">
          Plugin status is unavailable. Open Settings to check it.
        </p>
      ) : readiness ? (
        <ul>
          {requirements.map((requirement) => {
            const entry = readiness.find(
              (item) => item.pluginId === requirement.pluginId,
            )!;
            return (
              <li key={entry.pluginId}>
                {requirement.purpose}:{" "}
                {entry.state === "ready"
                  ? "Ready"
                  : entry.state === "disabled"
                    ? "Enable plugin"
                    : entry.state === "missing"
                      ? "Install plugin"
                      : "Check plugin"}
                {!requirement.required && entry.state !== "ready"
                  ? " (optional)"
                  : ""}
              </li>
            );
          })}
        </ul>
      ) : (
        <p role="status">Checking plugins…</p>
      )}
      {missing || error ? (
        <button type="button" onClick={openSettings}>
          Open Settings → Plugins
        </button>
      ) : null}
      <p>
        Tool permissions are checked when used. Device and IM connections are
        configured in their own plugins.
      </p>
    </section>
  );
}
