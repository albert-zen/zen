import { Select } from "./ui/controls.js";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  FleetSettingsApi,
  FleetSettingsSnapshot,
} from "./FleetSettings.js";

/** Human-only binding of two existing grants. This never creates a pairing or credential. */
export function FleetMessageSourceSettings({
  snapshot,
  api,
  disabled,
  onSaved,
}: {
  snapshot: FleetSettingsSnapshot;
  api: FleetSettingsApi;
  disabled: boolean;
  onSaved(): Promise<unknown>;
}) {
  const { t } = useTranslation("shell");
  const [inbound, setInbound] = useState("");
  const [device, setDevice] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [workspaces, setWorkspaces] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const saving = useRef(false);
  const peer = snapshot.config.devices.find((entry) => entry.id === device);
  const deviceKey = snapshot.devices?.find((entry) => entry.id === device)?.key;
  useEffect(() => {
    const version = ++generation.current;
    setWorkspace("");
    setWorkspaces([]);
    setConfirmed(false);
    setError(null);
    if (!device || !deviceKey) {
      setBusy(false);
      return;
    }
    setBusy(true);
    void api
      .invoke({
        device,
        expectedDeviceKey: deviceKey,
        name: "zenx_projects_list",
        arguments: { limit: 100 },
      })
      .then((raw) => {
        if (generation.current !== version) return;
        const result = (
          raw as { result: { projects: Array<{ id: string; name: string }> } }
        ).result;
        setWorkspaces(
          result.projects.map((entry) => ({ id: entry.id, name: entry.name })),
        );
      })
      .catch((reason) => {
        if (generation.current === version)
          setError(String(reason instanceof Error ? reason.message : reason));
      })
      .finally(() => {
        if (generation.current === version) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [api, device, deviceKey, snapshot.revision]);
  const save = async (
    bindings: NonNullable<FleetSettingsSnapshot["config"]["messageSources"]>,
  ) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.save(
        { ...snapshot.config, messageSources: bindings },
        snapshot.revision,
      );
      await onSaved();
      setConfirmed(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <details className="fleet-message-source-settings">
      <summary>{t("sourceBindingTitle")}</summary>
      <p className="settings-note">{t("sourceBindingHelp")}</p>
      {(snapshot.config.messageSources ?? []).map((binding) => (
        <div
          className="settings-row"
          key={JSON.stringify([
            binding.inboundDeviceId,
            binding.hostId,
            binding.workspaceId,
          ])}
        >
          <div>
            <strong>
              {binding.inboundDeviceId} → {binding.deviceId}
            </strong>
            <span>
              {binding.hostId} · {binding.workspaceId}
            </span>
          </div>
          <button
            className="quiet-button"
            disabled={disabled || busy}
            onClick={() =>
              void save(
                snapshot.config.messageSources!.filter(
                  (entry) => entry !== binding,
                ),
              )
            }
          >
            {t("sourceBindingRemove")}
          </button>
        </div>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (
            !confirmed ||
            peer?.transport !== "https" ||
            !deviceKey ||
            !workspace ||
            !inbound
          )
            return;
          const binding = {
            inboundDeviceId: inbound,
            hostId: peer.hostId,
            workspaceId: workspace,
            deviceId: peer.id,
            deviceKey,
          };
          void save([
            ...(snapshot.config.messageSources ?? []).filter(
              (entry) =>
                entry.inboundDeviceId !== inbound ||
                entry.hostId !== peer.hostId ||
                entry.workspaceId !== workspace,
            ),
            binding,
          ]);
        }}
      >
        <label>
          <span>{t("sourceBindingInbound")}</span>
          <Select
            value={inbound}
            disabled={disabled || busy}
            onValueChange={(value) => {
              setInbound(value);
              setConfirmed(false);
            }}
          >
            <option value="">{t("sourceBindingChoose")}</option>
            {snapshot.host.clients
              .filter((entry) => !entry.revoked && entry.access === "control")
              .map((entry) => (
                <option key={entry.deviceId} value={entry.deviceId}>
                  {entry.deviceId}
                </option>
              ))}
          </Select>
        </label>
        <label>
          <span>{t("sourceBindingReturn")}</span>
          <Select
            value={device}
            disabled={disabled || saving.current}
            onValueChange={(value) => setDevice(value)}
          >
            <option value="">{t("sourceBindingChoose")}</option>
            {snapshot.config.devices
              .filter((entry) => entry.transport === "https")
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label} ({entry.id})
                </option>
              ))}
          </Select>
        </label>
        {peer?.transport === "https" ? (
          <p className="settings-note">
            {peer.hostId} · {peer.endpoint} · {peer.access}
          </p>
        ) : null}
        <label>
          <span>{t("sourceBindingWorkspace")}</span>
          <Select
            value={workspace}
            disabled={disabled || busy}
            onValueChange={(value) => {
              setWorkspace(value);
              setConfirmed(false);
            }}
          >
            <option value="">{t("sourceBindingChoose")}</option>
            {workspaces.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} ({entry.id})
              </option>
            ))}
          </Select>
        </label>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={disabled || busy || !inbound || !workspace}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          {t("sourceBindingConfirm")}
        </label>
        <button
          className="secondary-button"
          type="submit"
          disabled={
            disabled ||
            busy ||
            !confirmed ||
            !deviceKey ||
            !snapshot.host.enabled
          }
        >
          {t("sourceBindingSave")}
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </details>
  );
}
