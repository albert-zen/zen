import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
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
  purposeLabels,
  onReady,
  openSettings,
}: {
  requirements: readonly PluginRequirement[];
  purposeLabels?: Readonly<Record<string, string>>;
  onReady(ready: boolean): void;
  openSettings(): void;
}) {
  useTranslation("panels");
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
      aria-label={i18n.t("panels:pluginReadinessLabel")}
      className="room-assistant-disclosure"
    >
      {error ? (
        <p role="alert">{i18n.t("panels:pluginReadinessUnavailable")}</p>
      ) : readiness ? (
        <ul>
          {requirements.map((requirement) => {
            const entry = readiness.find(
              (item) => item.pluginId === requirement.pluginId,
            )!;
            return (
              <li key={entry.pluginId}>
                {purposeLabels?.[requirement.pluginId] ?? requirement.purpose}:{" "}
                {entry.state === "ready"
                  ? i18n.t("panels:pluginReadinessReady")
                  : entry.state === "disabled"
                    ? i18n.t("panels:pluginReadinessEnable")
                    : entry.state === "missing"
                      ? i18n.t("panels:pluginReadinessInstall")
                      : i18n.t("panels:pluginReadinessCheck")}
                {!requirement.required && entry.state !== "ready"
                  ? i18n.t("panels:pluginReadinessOptional")
                  : ""}
              </li>
            );
          })}
        </ul>
      ) : (
        <p role="status">{i18n.t("panels:pluginReadinessChecking")}</p>
      )}
      {missing || error ? (
        <button type="button" onClick={openSettings}>
          {i18n.t("panels:pluginReadinessOpenSettings")}
        </button>
      ) : null}
      <p>{i18n.t("panels:pluginReadinessPermissionNotice")}</p>
    </section>
  );
}
