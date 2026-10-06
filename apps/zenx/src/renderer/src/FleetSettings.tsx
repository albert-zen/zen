import { i18n } from "./i18n.js";
import { useTranslation } from "react-i18next";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ActionMenu, Dialog, Select } from "./ui/controls.js";
import { Icon } from "./icons.js";
import { FleetHistory } from "./FleetHistory.js";
import {
  FleetConnectionSetup,
  FleetInvitationIssuer,
} from "./FleetOnboarding.js";
import type {
  FleetInvitation,
  FleetInvitationConsent,
  FleetReadiness,
} from "../../fleet-invitation.js";

type Access = "read" | "control";
type Device = {
  id: string;
  label: string;
  description?: string;
  shellEnabled?: boolean;
  access: Access;
  workspace?: string;
} & (
  | { transport?: "ssh"; sshHost: string; command: string[] }
  | { transport: "https"; endpoint: string; hostId: string }
);
type Hosting = {
  enabled: boolean;
  bindAddress: string;
  port: number;
  tlsCertificateFile: string;
  tlsKeyFile: string;
  access: Access;
  relayEndpoint?: string;
  originEndpoint?: string;
  shellEnabled?: boolean;
};

/** Public configuration only. Peer tokens and TLS key contents stay in main. */
export interface FleetSettingsSnapshot {
  revision: number;
  config: { version: 1; devices: Device[]; hosting?: Hosting };
  devices?: Array<{
    id: string;
    key?: string;
    check: {
      state: "not_checked" | "checking" | "reachable" | "failed";
      live: false;
      checkedAt?: number;
      detail?: string;
    };
  }>;
  host: {
    enabled: boolean;
    hostId: string;
    url?: string;
    clients: Array<{
      deviceId: string;
      label?: string;
      access?: Access;
      shellEnabled?: boolean;
      revoked: boolean;
    }>;
    error?: string;
    relayConfigured?: boolean;
    relayConnected?: boolean;
  };
}

export interface FleetSettingsApi {
  status(): Promise<FleetSettingsSnapshot>;
  readiness?(): Promise<FleetReadiness>;
  hostInvitation?(input: {
    endpoint: string;
    label: string;
    confirmed: true;
    expected: FleetInvitationConsent;
  }): Promise<{ invitation: FleetInvitation; serialized: string }>;
  save(
    config: Omit<FleetSettingsSnapshot["config"], "hosting"> & {
      hosting?: Hosting & { relayRegistrationToken?: string };
    },
    expectedRevision?: number,
  ): Promise<unknown>;
  pair(input: {
    id: string;
    label: string;
    description?: string;
    shellEnabled?: boolean;
    endpoint: string;
    hostId: string;
    code: string;
    access: Access;
    workspace?: string;
  }): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  test(id: string): Promise<unknown>;
  invoke(input: {
    device: string;
    expectedDeviceKey?: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
  hostPair(): Promise<{ hostId: string; code: string; expiresAt?: string }>;
  revoke(deviceId: string): Promise<unknown>;
}

interface DeviceDraft {
  originalId?: string;
  transport: "ssh" | "https";
  id: string;
  label: string;
  description: string;
  shellEnabled: boolean;
  sshHost: string;
  command: string;
  endpoint: string;
  hostId: string;
  code: string;
  workspace: string;
  access: Access;
  controlConfirmed: boolean;
}
interface Project {
  id: string;
  name: string;
}
interface RemoteThread {
  id: string;
  name: string;
  status: string;
}
interface Inspection {
  device: Device;
  deviceKey: string;
  projects: Project[];
  workspace: string;
  threads: RemoteThread[];
  nextCursor: string | null;
  thread: RemoteThread | null;
  history: unknown;
  historyCursor: string | null;
}
const defaultHosting: Hosting = {
  enabled: false,
  bindAddress: "127.0.0.1",
  port: 3940,
  tlsCertificateFile: "",
  tlsKeyFile: "",
  access: "read",
};

export function FleetSettings() {
  const { t } = useTranslation("settings");
  const api = (window.zenx as unknown as { fleet?: FleetSettingsApi }).fleet;
  const [snapshot, setSnapshot] = useState<FleetSettingsSnapshot | null>(null);
  const [hosting, setHosting] = useState(defaultHosting);
  const [relayToken, setRelayToken] = useState("");
  const [exposureConfirmed, setExposureConfirmed] = useState(false);
  const [hostControlConfirmed, setHostControlConfirmed] = useState(false);
  const [editor, setEditor] = useState<DeviceDraft | null>(null);
  const [connecting, setConnecting] = useState(false);
  const newDraft = useRef<DeviceDraft | null>(null);
  const [removing, setRemoving] = useState<Device | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("guidance");
  const [pairCode, setPairCode] = useState<Awaited<
    ReturnType<FleetSettingsApi["hostPair"]>
  > | null>(null);
  const [connections, setConnections] = useState<
    Record<
      string,
      {
        key: string;
        state: "checking" | "reachable" | "failed";
        checkedAt?: number;
      }
    >
  >({});
  const [busy, setBusy] = useState<string | null>(null);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const inspectionVersion = useRef(0);
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const inspectorTrigger = useRef<HTMLButtonElement | null>(null);
  const removeTrigger = useRef<HTMLButtonElement | null>(null);
  const removeCancel = useRef<HTMLButtonElement>(null);
  const editorRegion = useRef<HTMLDivElement>(null);
  const inspectorRegion = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mounted.current = true;
    if (api)
      void api
        .status()
        .then((raw) => {
          const value = normalizeFleetSnapshot(raw);
          if (!mounted.current) return;
          setSnapshot(value);
          setHosting(value.config.hosting ?? defaultHosting);
        })
        .catch(
          (reason: unknown) =>
            mounted.current && setError(describeError(reason)),
        );
    return () => {
      mounted.current = false;
      inspectionVersion.current++;
    };
  }, [api]);
  useEffect(() => {
    if (!inspection || !snapshot) return;
    const key = snapshot.devices?.find(
      (device) => device.id === inspection.device.id,
    )?.key;
    if (key !== inspection.deviceKey) {
      inspectionVersion.current++;
      setInspection(null);
      setError(i18n.t("settings:fleetSettings.routeChanged"));
    }
  }, [snapshot, inspection]);
  useEffect(() => {
    if (editor)
      editorRegion.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [editor?.originalId, editor !== null]);
  useEffect(() => {
    if (removing) removeCancel.current?.focus();
  }, [removing]);
  useEffect(() => {
    if (!connecting) editorTrigger.current?.focus();
  }, [connecting]);
  useEffect(() => {
    if (inspection) inspectorRegion.current?.focus();
  }, [inspection?.device.id]);
  useEffect(() => {
    if (!api || !pairCode) return;
    let disposed = false;
    const expires = pairCode.expiresAt ? Date.parse(pairCode.expiresAt) : null;
    const timer = window.setInterval(() => {
      if (
        expires !== null &&
        Number.isFinite(expires) &&
        Date.now() >= expires
      ) {
        setPairCode(null);
        return;
      }
      if (busyRef.current) return;
      void api
        .status()
        .then((raw) => {
          const value = normalizeFleetSnapshot(raw);
          if (disposed || !mounted.current) return;
          // Refresh live client grants without rebasing unsaved configuration.
          setSnapshot((previous) =>
            previous ? { ...previous, host: value.host } : value,
          );
        })
        .catch((reason: unknown) => {
          if (!disposed && mounted.current) setError(describeError(reason));
        });
    }, 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [api, pairCode]);

  const refresh = async (resetHosting = false) => {
    if (!api)
      throw new Error(
        i18n.t("settings:fleetSettings.fleetConnectionIsUnavailable"),
      );
    const value = normalizeFleetSnapshot(await api.status());
    if (mounted.current) {
      setSnapshot(value);
      if (resetHosting) setHosting(value.config.hosting ?? defaultHosting);
    }
    return value;
  };
  const run = async (key: string, operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (reason) {
      if (mounted.current) setError(describeError(reason));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const closeEditor = () => {
    if (editor && !editor.originalId)
      newDraft.current = { ...editor, code: "", controlConfirmed: false };
    setConnecting(false);
    setEditor(null);
    setError(null);
  };
  const openEditor = (trigger: HTMLButtonElement, device?: Device) => {
    editorTrigger.current = trigger;
    setRemoving(null);
    setRevoking(null);
    setError(null);
    setNotice(null);
    setConnecting(true);
    setEditor({
      originalId: device?.id,
      transport: device?.transport === "https" ? "https" : "ssh",
      id: device?.id ?? "",
      label: device?.label ?? "",
      description: device?.description ?? "",
      shellEnabled: device?.shellEnabled === true,
      access: device?.access ?? "read",
      sshHost: device && device.transport !== "https" ? device.sshHost : "",
      command:
        device && device.transport !== "https" ? device.command.join("\n") : "",
      endpoint: device?.transport === "https" ? device.endpoint : "",
      hostId: device?.transport === "https" ? device.hostId : "",
      code: "",
      workspace: device?.workspace ?? "",
      controlConfirmed: false,
      ...(!device && newDraft.current ? newDraft.current : {}),
    });
  };
  const openConnection = (trigger: HTMLButtonElement) => {
    editorTrigger.current = trigger;
    setEditor(null);
    setError(null);
    setConnecting(true);
  };
  const chooseConnection = (
    method: "invitation" | "ssh" | "https",
    trigger: HTMLButtonElement,
  ) => {
    if (editor && !editor.originalId)
      newDraft.current = { ...editor, code: "", controlConfirmed: false };
    if (method === "invitation") setEditor(null);
    else {
      const originalTrigger = editorTrigger.current;
      openEditor(trigger);
      editorTrigger.current = originalTrigger;
      setEditor((value) =>
        value
          ? { ...value, transport: method, code: "", controlConfirmed: false }
          : value,
      );
    }
  };
  const edit = (change: Partial<DeviceDraft>) =>
    setEditor((value) => (value ? { ...value, ...change } : value));
  const changeHosting = (change: Partial<Hosting>) => {
    setHosting((value) => ({ ...value, ...change }));
    setExposureConfirmed(false);
    setHostControlConfirmed(false);
    setPairCode(null);
  };
  const saveDevice = async () => {
    if (!editor || !snapshot || !api) return;
    const current = {
      ...editor,
      id:
        editor.id || availableMachineId(editor.label, snapshot.config.devices),
    };
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(current.id) ||
      current.id === "local"
    )
      throw new Error(
        i18n.t("settings:fleetSettings.useAUniqueDeviceIdOf164Letters"),
      );
    if (
      snapshot.config.devices.some(
        (entry) => entry.id === current.id && entry.id !== current.originalId,
      )
    )
      throw new Error(
        i18n.t("settings:fleetSettings.thatDeviceIdIsAlreadyConfigured"),
      );
    if (!current.label.trim())
      throw new Error(i18n.t("settings:fleetSettings.enterADeviceLabel"));
    if (current.access === "control" && !current.controlConfirmed)
      throw new Error(
        i18n.t("settings:fleetSettings.confirmRemoteThreadControlBeforeSaving"),
      );
    let device: Device;
    if (current.transport === "ssh") {
      const command = current.command.split(/\r?\n/u);
      if (!current.sshHost.trim() || command.some((arg) => !arg.trim()))
        throw new Error(
          i18n.t(
            "settings:fleetSettings.enterAnSshHostAndNonEmptyCommandArguments",
          ),
        );
      device = {
        transport: "ssh",
        id: current.id,
        label: current.label.trim(),
        ...(current.description.trim()
          ? { description: current.description.trim() }
          : {}),
        sshHost: current.sshHost.trim(),
        command,
        access: current.access,
      };
    } else {
      const endpoint = new URL(current.endpoint);
      if (
        endpoint.protocol !== "https:" ||
        endpoint.username ||
        endpoint.password
      )
        throw new Error(
          i18n.t(
            "settings:fleetSettings.useAnHttpsEndpointWithoutEmbeddedCredentials",
          ),
        );
      if (!current.hostId.trim())
        throw new Error(
          i18n.t(
            "settings:fleetSettings.enterTheRemoteHostIdShownByThatDevice",
          ),
        );
      if (!current.originalId) {
        if (!current.code.trim())
          throw new Error(
            i18n.t(
              "settings:fleetSettings.enterACurrentOneTimePairingCodeFromThe",
            ),
          );
        // A submitted bearer may have been consumed even if the receipt fails.
        // Keep ordinary edits, but require a fresh code for another attempt.
        edit({ code: "" });
        await api.pair({
          id: current.id,
          label: current.label.trim(),
          ...(current.description.trim()
            ? { description: current.description.trim() }
            : {}),
          endpoint: current.endpoint.trim(),
          hostId: current.hostId.trim(),
          code: current.code.trim(),
          access: current.access,
          ...(current.shellEnabled ? { shellEnabled: true } : {}),
        });
        await refresh();
        if (mounted.current) {
          closeEditor();
          newDraft.current = null;
          setNotice(
            i18n.t(
              "settings:fleetSettings.devicePairedBrowseItToChooseAWorkspace",
            ),
          );
        }
        return;
      }
      device = {
        transport: "https",
        id: current.id,
        label: current.label.trim(),
        ...(current.description.trim()
          ? { description: current.description.trim() }
          : {}),
        endpoint: current.endpoint.trim(),
        hostId: current.hostId.trim(),
        access: current.access,
        ...(current.shellEnabled ? { shellEnabled: true } : {}),
        ...(current.workspace ? { workspace: current.workspace } : {}),
      };
    }
    const devices = current.originalId
      ? snapshot.config.devices.map((entry) =>
          entry.id === current.originalId ? device : entry,
        )
      : [...snapshot.config.devices, device];
    await api.save({ ...snapshot.config, devices }, snapshot.revision);
    await refresh();
    if (mounted.current) {
      closeEditor();
      if (!current.originalId) newDraft.current = null;
      setNotice(i18n.t("settings:fleetSettings.deviceSaved"));
    }
  };

  const invoke = async (
    device: string,
    deviceKey: string,
    name: string,
    args: Record<string, unknown>,
  ) => {
    if (!api)
      throw new Error(
        i18n.t("settings:fleetSettings.fleetConnectionIsUnavailable"),
      );
    if (!deviceKey)
      throw new Error(i18n.t("settings:fleetSettings.routeIdentityMissing"));
    const value = await api.invoke({
      device,
      expectedDeviceKey: deviceKey,
      name,
      arguments: args,
    });
    const result = record(unwrap(value));
    if (result.status === "not_found" || result.status === "ambiguous")
      throw new Error(i18n.t("settings:fleetSettings.exactThreadUnavailable"));
    return unwrap(value);
  };
  const listThreads = async (
    current: Inspection,
    workspace: string,
    cursor?: string,
  ) => {
    if (!workspace)
      throw new Error(i18n.t("settings:fleetSettings.chooseTargetWorkspace"));
    const version = inspectionVersion.current;
    const result = record(
      await invoke(current.device.id, current.deviceKey, "zenx_threads_list", {
        ...(workspace ? { workspace } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 50,
      }),
    );
    const threads = array(result.threads)
      .map((entry) => {
        const value = record(entry);
        return {
          id: string(value.threadId ?? value.id),
          name: string(
            value.name ?? value.preview ?? value.threadId ?? value.id,
          ),
          status: string(value.status),
        };
      })
      .filter((thread) => thread.id);
    if (!mounted.current || version !== inspectionVersion.current) return;
    setInspection({
      ...current,
      workspace,
      threads: cursor ? [...current.threads, ...threads] : threads,
      nextCursor: nullableString(result.nextCursor),
      thread: null,
      history: null,
      historyCursor: null,
    });
    setMessage("");
  };
  const browse = async (device: Device, trigger: HTMLButtonElement) => {
    inspectorTrigger.current = trigger;
    const version = ++inspectionVersion.current;
    const deviceKey = snapshot?.devices?.find(
      (entry) => entry.id === device.id,
    )?.key;
    if (!deviceKey)
      throw new Error(i18n.t("settings:fleetSettings.routeIdentityMissing"));
    const result = record(
      await invoke(device.id, deviceKey, "zenx_projects_list", { limit: 100 }),
    );
    const projects = array(result.projects)
      .map((entry) => {
        const value = record(entry);
        return {
          id: string(value.project ?? value.workspace ?? value.cwd ?? value.id),
          name: string(
            value.name ?? value.project ?? value.workspace ?? value.id,
          ),
        };
      })
      .filter((project) => project.id);
    if (!mounted.current || version !== inspectionVersion.current) return;
    const workspace =
      device.workspace ?? (projects.length === 1 ? projects[0]!.id : "");
    const current: Inspection = {
      device,
      deviceKey,
      projects,
      workspace,
      threads: [],
      nextCursor: null,
      thread: null,
      history: null,
      historyCursor: null,
    };
    setInspection(current);
    if (!workspace) return;
    await listThreads(current, current.workspace);
  };
  const closeInspection = () => {
    inspectionVersion.current++;
    setInspection(null);
    setMessage("");
    setError(null);
    inspectorTrigger.current?.focus();
  };
  const read = async (
    current: Inspection,
    thread: RemoteThread,
    cursor?: string,
  ) => {
    const version = inspectionVersion.current;
    const result = await invoke(
      current.device.id,
      current.deviceKey,
      "zenx_threads_read",
      {
        threadId: thread.id,
        ...(current.workspace ? { workspace: current.workspace } : {}),
        granularity: "items",
        maxItemsPerTurn: 25,
        ...(cursor ? { cursor } : {}),
      },
    );
    if (!mounted.current || version !== inspectionVersion.current) return;
    const value = record(result);
    const history = cursor
      ? {
          ...value,
          items: [
            ...array(value.items),
            ...array(record(current.history).items),
          ],
        }
      : result;
    setInspection({
      ...current,
      thread,
      history,
      historyCursor: nullableString(value.nextCursor),
    });
    if (!cursor) setMessage("");
  };

  if (!api)
    return (
      <div className="settings-error" role="alert">
        {t("fleetSettings.fleetConnectionIsUnavailableInThisAppBuild")}
      </div>
    );
  if (!snapshot)
    return (
      <div className="page-card settings-card">
        <p role={error ? "alert" : "status"}>
          {error ?? t("fleetSettings.loadingFleet")}
        </p>
        {error ? (
          <button
            className="secondary-button"
            type="button"
            onClick={() =>
              void run("refresh", async () => {
                await refresh(true);
              })
            }
          >
            {t("fleetSettings.retry")}
          </button>
        ) : null}
      </div>
    );
  const disabled = busy !== null || onboardingBusy;
  const hostingDirty =
    JSON.stringify(hosting) !==
      JSON.stringify(snapshot.config.hosting ?? defaultHosting) ||
    relayToken.length > 0;
  const controlExpansion =
    hosting.access === "control" &&
    snapshot.config.hosting?.access !== "control";

  return (
    <div className="fleet-settings">
      <header className="fleet-page-header">
        <div>
          <h2>{t("fleetSettings.fleet")}</h2>
          <p>{t("fleetConnection.pageDescription")}</p>
        </div>
        <button
          className="quiet-button"
          type="button"
          disabled={disabled}
          onClick={() =>
            void run("refresh", async () => {
              const value = normalizeFleetSnapshot(await api.status());
              if (!mounted.current) return;
              if (
                (editor !== null || hostingDirty) &&
                value.revision !== snapshot.revision
              ) {
                setSnapshot({ ...snapshot, host: value.host });
                throw new Error(
                  t(
                    "fleetSettings.fleetConfigurationChangedWhileYouWereEditingCancelThe",
                  ),
                );
              }
              setSnapshot(value);
              if (!hostingDirty)
                setHosting(value.config.hosting ?? defaultHosting);
              setNotice(t("fleetSettings.fleetStatusRefreshed"));
            })
          }
        >
          {t("fleetSettings.refreshFleet")}
        </button>
      </header>
      {error && !editor ? (
        <div className="settings-error" role="alert">
          {error}
        </div>
      ) : null}
      <section
        className="fleet-machines"
        aria-label={t("fleetConnection.machines")}
      >
        <div className="settings-card-head">
          <div>
            <h3>{t("fleetConnection.machines")}</h3>
            <p>{t("fleetConnection.machineListHelp")}</p>
          </div>
          <button
            ref={addButton}
            className="primary-button"
            type="button"
            disabled={disabled}
            onClick={(event) => openConnection(event.currentTarget)}
          >
            <Icon name="plus" size={14} /> {t("fleetConnection.connectMachine")}
          </button>
        </div>
        {snapshot.config.devices.length === 0 ? (
          <div className="fleet-empty">
            <Icon name="computer" size={28} />
            <h4>{t("fleetConnection.emptyTitle")}</h4>
            <p>{t("fleetConnection.emptyDescription")}</p>
          </div>
        ) : (
          snapshot.config.devices.map((device) => (
            <div className="settings-row fleet-machine-row" key={device.id}>
              <div className="fleet-machine-icon">
                <Icon name="computer" size={20} />
              </div>
              <div className="fleet-machine-info">
                <strong>{device.label}</strong>
                {device.description ? (
                  <span className="fleet-history-text">
                    {device.description}
                  </span>
                ) : null}
                <span
                  className="fleet-machine-meta"
                  title={
                    device.transport === "https"
                      ? device.endpoint
                      : device.sshHost
                  }
                >
                  {device.transport === "https" ? "HTTPS" : "SSH"} ·{" "}
                  {device.access === "control"
                    ? t("fleetSettings.threadControl")
                    : t("fleetSettings.readOnly")}
                </span>
                <span role="status">
                  {connections[device.id]?.key ===
                  (snapshot.devices?.find((entry) => entry.id === device.id)
                    ?.key ?? JSON.stringify(device))
                    ? connectionCheckLabel(connections[device.id]!)
                    : deviceCheckLabel(snapshot, device.id)}
                </span>
              </div>
              <div className="settings-actions fleet-actions">
                <button
                  type="button"
                  className="quiet-button"
                  aria-label={t("fleetSettings.testDevice", {
                    name: device.label,
                  })}
                  disabled={disabled}
                  onClick={() =>
                    void run(`test:${device.id}`, async () => {
                      setConnections((value) => ({
                        ...value,
                        [device.id]: {
                          key:
                            snapshot.devices?.find(
                              (entry) => entry.id === device.id,
                            )?.key ?? JSON.stringify(device),
                          state: "checking",
                        },
                      }));
                      try {
                        const result = record(await api.test(device.id));
                        if (result.ok === false)
                          throw new Error(
                            string(result.error) ||
                              t("fleetSettings.connectionFailed"),
                          );
                        if (mounted.current)
                          setConnections((value) => ({
                            ...value,
                            [device.id]: {
                              key:
                                snapshot.devices?.find(
                                  (entry) => entry.id === device.id,
                                )?.key ?? JSON.stringify(device),
                              state: "reachable",
                              checkedAt: Date.now(),
                            },
                          }));
                      } catch (reason) {
                        if (mounted.current)
                          setConnections((value) => ({
                            ...value,
                            [device.id]: {
                              key:
                                snapshot.devices?.find(
                                  (entry) => entry.id === device.id,
                                )?.key ?? JSON.stringify(device),
                              state: "failed",
                            },
                          }));
                        throw reason;
                      }
                    })
                  }
                >
                  {t("fleetSettings.test")}
                </button>
                <button
                  type="button"
                  className="quiet-button"
                  aria-label={t("fleetSettings.browseDevice", {
                    name: device.label,
                  })}
                  disabled={disabled}
                  onClick={(event) => {
                    const trigger = event.currentTarget;
                    void run(`browse:${device.id}`, () =>
                      browse(device, trigger),
                    );
                  }}
                >
                  {t("fleetSettings.browse")}
                </button>
                <ActionMenu
                  compact
                  label={t("fleetConnection.machineActions", {
                    name: device.label,
                  })}
                  items={[
                    {
                      label: t("fleetSettings.editDevice", {
                        name: device.label,
                      }),
                      disabled,
                      onSelect: (trigger) =>
                        openEditor(trigger ?? addButton.current!, device),
                    },
                    {
                      label: t("fleetSettings.removeNamedDevice", {
                        name: device.label,
                      }),
                      disabled,
                      danger: true,
                      onSelect: (trigger) => {
                        removeTrigger.current = trigger;
                        setRemoving(device);
                        setEditor(null);
                        setError(null);
                      },
                    },
                  ]}
                />
              </div>
            </div>
          ))
        )}
        <details className="fleet-connection-help">
          <summary>{t("fleetConnection.connectionHelp")}</summary>
          <p>{t("fleetSettings.routeHelp")}</p>
        </details>
      </section>

      <Dialog
        open={connecting}
        onOpenChange={(open) => {
          if (!disabled && !open) closeEditor();
        }}
        title={
          editor?.originalId
            ? t("fleetSettings.editDevice", { name: editor.label })
            : t("fleetConnection.connectMachine")
        }
        className="fleet-connect-dialog"
      >
        <div className="fleet-dialog-head">
          <div>
            <h3>
              {editor?.originalId
                ? t("fleetSettings.editDevice", { name: editor.label })
                : t("fleetConnection.connectMachine")}
            </h3>
            <p>{t("fleetConnection.connectDescription")}</p>
          </div>
          <button
            className="quiet-button fleet-close"
            type="button"
            aria-label={t("fleetConnection.closeConnection")}
            disabled={disabled}
            onClick={closeEditor}
          >
            ×
          </button>
        </div>
        {!editor?.originalId ? (
          <div
            className="fleet-methods"
            role="group"
            aria-label={t("fleetConnection.connectionMethod")}
          >
            {(["invitation", "ssh", "https"] as const).map((method) => (
              <button
                key={method}
                aria-label={t(`fleetConnection.method.${method}`)}
                type="button"
                aria-pressed={(editor?.transport ?? "invitation") === method}
                disabled={disabled}
                onClick={(event) =>
                  chooseConnection(method, event.currentTarget)
                }
              >
                <Icon
                  name={method === "ssh" ? "terminal" : "computer"}
                  size={16}
                />
                <span>
                  <strong>{t(`fleetConnection.method.${method}`)}</strong>
                  <small>{t(`fleetConnection.methodHelp.${method}`)}</small>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {connecting && !editor ? (
          <FleetConnectionSetup
            api={api}
            snapshot={snapshot}
            disabled={disabled}
            onBusy={setOnboardingBusy}
            onChanged={() => refresh()}
            embedded
            onClose={closeEditor}
          />
        ) : null}
        {editor ? (
          <div
            ref={editorRegion}
            className="fleet-device-editor"
            aria-label={t("fleetSettings.deviceEditor")}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !disabled) {
                event.preventDefault();
                closeEditor();
              }
            }}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run("save-device", saveDevice);
              }}
            >
              <fieldset disabled={disabled} className="fleet-fieldset">
                <div className="form-grid">
                  <Field
                    label={t("fleetConnection.machineName")}
                    value={editor.label}
                    onChange={(label) => edit({ label })}
                  />
                  {editor.originalId ? (
                    <label className="field">
                      <span>{t("fleetSettings.connection")}</span>
                      <Select
                        value={editor.transport}
                        disabled={!!editor.originalId || disabled}
                        onValueChange={(transport) =>
                          edit({
                            transport: transport as "ssh" | "https",
                            code: "",
                          })
                        }
                      >
                        <option value="ssh">{t("fleetSettings.ssh")}</option>
                        <option value="https">
                          {t("fleetSettings.httpsPairing")}
                        </option>
                      </Select>
                    </label>
                  ) : null}
                  <AccessField
                    value={editor.access}
                    disabled={disabled}
                    onChange={(access) =>
                      edit({
                        access,
                        controlConfirmed: false,
                        ...(access === "read" ? { shellEnabled: false } : {}),
                      })
                    }
                  />
                  {editor.transport === "ssh" ? (
                    <>
                      <Field
                        label={t("fleetSettings.sshHost")}
                        value={editor.sshHost}
                        placeholder={t(
                          "fleetSettings.userDeviceOrSshConfigAlias",
                        )}
                        onChange={(sshHost) => edit({ sshHost })}
                        wide
                      />
                      <Field
                        label={t("fleetSettings.commandArgumentsOnePerLine")}
                        value={editor.command}
                        placeholder={
                          "node\n/path/to/fleet-bridge.js\n/path/to/connection.json"
                        }
                        onChange={(command) => edit({ command })}
                        wide
                        multiline
                      />
                      <p className="settings-note field wide">
                        {t(
                          "fleetSettings.theseExactArgumentsRunOnTheRemoteDeviceThrough",
                        )}
                      </p>
                    </>
                  ) : (
                    <>
                      <Field
                        label={t("fleetSettings.httpsEndpoint")}
                        value={editor.endpoint}
                        placeholder="https://device.example:3940"
                        disabled={!!editor.originalId}
                        onChange={(endpoint) => edit({ endpoint })}
                        wide
                      />
                      <Field
                        label={t("fleetSettings.remoteHostId")}
                        value={editor.hostId}
                        disabled={!!editor.originalId}
                        onChange={(hostId) => edit({ hostId })}
                        wide
                      />
                      <p className="settings-note field wide">
                        {t("fleetConnection.verifyHostIdentity")}
                      </p>
                      {editor.originalId ? (
                        <Field
                          label={t("fleetSettings.workspaceIdOptional")}
                          value={editor.workspace}
                          onChange={(workspace) => edit({ workspace })}
                          wide
                        />
                      ) : (
                        <Field
                          label={t("fleetSettings.oneTimePairingCode2")}
                          value={editor.code}
                          onChange={(code) => edit({ code })}
                          secret
                          wide
                        />
                      )}
                      <details className="fleet-connection-help fleet-access-help">
                        <summary>{t("fleetConnection.accessHelp")}</summary>{" "}
                        <p className="settings-note field wide">
                          {t(
                            "fleetSettings.checkTheHostIdDirectlyOnTheRemoteDevice",
                          )}
                        </p>
                        <Confirmation
                          checked={editor.shellEnabled}
                          disabled={
                            disabled ||
                            editor.access !== "control" ||
                            (!!editor.originalId &&
                              snapshot.config.devices.find(
                                (device) => device.id === editor.originalId,
                              )?.shellEnabled !== true)
                          }
                          onChange={(shellEnabled) => edit({ shellEnabled })}
                        >
                          {t("fleetSettings.requestShell")}
                        </Confirmation>
                        <p className="settings-note field wide">
                          {t("fleetSettings.shellHelp")}
                        </p>
                      </details>
                    </>
                  )}
                </div>
                <details className="fleet-connection-help fleet-advanced-fields">
                  <summary>{t("fleetConnection.machineDetails")}</summary>
                  <div className="form-grid">
                    <Field
                      label={t("fleetSettings.deviceId")}
                      value={editor.id}
                      disabled={!!editor.originalId}
                      onChange={(id) => edit({ id })}
                    />
                    <Field
                      label={t("fleetSettings.machineDescription")}
                      value={editor.description}
                      onChange={(description) => edit({ description })}
                      multiline
                      wide
                    />
                    <p className="settings-note field wide">
                      {t("fleetSettings.machineDescriptionHelp")}
                    </p>
                  </div>
                </details>
                {editor.access === "control" ? (
                  <Confirmation
                    checked={editor.controlConfirmed}
                    onChange={(controlConfirmed) => edit({ controlConfirmed })}
                  >
                    {t(
                      "fleetSettings.iAllowZenxToCreateThreadsAndSendMessages",
                    )}
                  </Confirmation>
                ) : null}
              </fieldset>
              {error ? (
                <div className="settings-error" role="alert">
                  {error}
                </div>
              ) : null}
              <div className="settings-actions fleet-actions">
                <button
                  className="primary-button"
                  type="submit"
                  disabled={
                    disabled ||
                    (editor.access === "control" && !editor.controlConfirmed)
                  }
                >
                  {busy === "save-device"
                    ? t("fleetSettings.saving")
                    : editor.transport === "https" && !editor.originalId
                      ? t("fleetSettings.pairDevice")
                      : t("fleetSettings.saveDevice")}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={disabled}
                  onClick={closeEditor}
                >
                  {t("fleetSettings.cancel")}
                </button>
              </div>
            </form>
          </div>
        ) : null}
      </Dialog>

      {removing ? (
        <div
          className="page-card settings-card"
          role="alertdialog"
          aria-labelledby="fleet-remove-title"
          aria-describedby="fleet-remove-detail"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !disabled) {
              event.preventDefault();
              setRemoving(null);
              removeTrigger.current?.focus();
            }
          }}
        >
          <h3 id="fleet-remove-title">
            {t("fleetSettings.remove2")} {removing.label}?
          </h3>
          <p id="fleet-remove-detail">
            {t("fleetSettings.thisRemovesTheSavedConnectionFromThisAppRemote")}
          </p>
          <div className="settings-actions fleet-actions">
            <button
              className="danger-button"
              type="button"
              disabled={disabled}
              onClick={() =>
                void run("remove", async () => {
                  await api.remove(removing.id);
                  await refresh();
                  if (mounted.current) {
                    if (inspection?.device.id === removing.id)
                      closeInspection();
                    setRemoving(null);
                    setConnections((value) => {
                      const next = { ...value };
                      delete next[removing.id];
                      return next;
                    });
                    setNotice(t("fleetSettings.deviceRemoved"));
                    addButton.current?.focus();
                  }
                })
              }
            >
              {t("fleetSettings.removeDevice")}
            </button>
            <button
              ref={removeCancel}
              className="secondary-button"
              type="button"
              disabled={disabled}
              onClick={() => {
                setRemoving(null);
                removeTrigger.current?.focus();
              }}
            >
              {t("fleetSettings.cancel2")}
            </button>
          </div>
        </div>
      ) : null}

      {inspection ? (
        <div
          ref={inspectorRegion}
          className="page-card settings-card"
          tabIndex={-1}
          aria-label={t("fleetSettings.browseDevice", {
            name: inspection.device.label,
          })}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !disabled) {
              event.preventDefault();
              closeInspection();
            }
          }}
        >
          <div className="settings-card-head">
            <div>
              <h3>{inspection.device.label}</h3>
              <p>
                {t("fleetSettings.remoteWorkspacesAndThreads")}{" "}
                {inspection.device.access === "control"
                  ? t("fleetSettings.controlEnabled")
                  : t("fleetSettings.readOnly")}
              </p>
            </div>
            <button
              className="quiet-button"
              type="button"
              disabled={disabled}
              onClick={closeInspection}
            >
              {t("fleetSettings.closeBrowser")}
            </button>
          </div>
          <label className="field">
            <span>{t("fleetSettings.remoteWorkspace")}</span>
            <Select
              value={inspection.workspace}
              disabled={disabled}
              onValueChange={(workspace) => {
                inspectionVersion.current++;
                void run("list-threads", () =>
                  listThreads(inspection, workspace),
                );
              }}
            >
              <option value="" disabled>
                {inspection.device.transport === "https"
                  ? t("fleetSettings.chooseAWorkspace")
                  : t("fleetSettings.allWorkspaces")}
              </option>
              {inspection.workspace &&
              !inspection.projects.some(
                (project) => project.id === inspection.workspace,
              ) ? (
                <option value={inspection.workspace}>
                  {inspection.workspace}
                </option>
              ) : null}
              {inspection.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </label>
          <div className="settings-actions fleet-actions fleet-block-space">
            <button
              className="secondary-button"
              type="button"
              disabled={
                disabled ||
                (inspection.device.transport === "https" &&
                  !inspection.workspace)
              }
              onClick={() => {
                inspectionVersion.current++;
                void run("list-threads", () =>
                  listThreads(inspection, inspection.workspace),
                );
              }}
            >
              {t("fleetSettings.refreshThreads")}
            </button>
            {inspection.device.transport === "https" ? (
              <button
                className="quiet-button"
                type="button"
                disabled={disabled || !inspection.workspace}
                onClick={() =>
                  void run("workspace", async () => {
                    const device = {
                      ...inspection.device,
                      workspace: inspection.workspace,
                    };
                    await api.save(
                      {
                        ...snapshot.config,
                        devices: snapshot.config.devices.map((entry) =>
                          entry.id === device.id ? device : entry,
                        ),
                      },
                      snapshot.revision,
                    );
                    await refresh();
                    if (mounted.current) {
                      inspectionVersion.current++;
                      setInspection(null);
                      setNotice(
                        i18n.t(
                          "settings:fleetSettings.workspaceSelectedReopen",
                        ),
                      );
                    }
                  })
                }
              >
                {t("fleetSettings.useSelectedWorkspace")}
              </button>
            ) : null}
          </div>
          {inspection.threads.length === 0 ? (
            <p>
              {inspection.device.transport === "https" && !inspection.workspace
                ? t("fleetSettings.chooseAWorkspaceToBrowseItsThreads")
                : t("fleetSettings.noThreadsInThisWorkspace")}
            </p>
          ) : (
            inspection.threads.map((thread) => (
              <div className="settings-row" key={thread.id}>
                <div>
                  <strong>{thread.name || thread.id}</strong>
                  <span className="fleet-wrap">
                    {thread.id} · {thread.status}
                  </span>
                </div>
                <button
                  className="quiet-button"
                  type="button"
                  aria-label={t("fleetSettings.readThread", {
                    name: thread.name || thread.id,
                  })}
                  disabled={disabled}
                  onClick={() => {
                    inspectionVersion.current++;
                    void run("read-thread", () => read(inspection, thread));
                  }}
                >
                  {t("fleetSettings.read")}
                </button>
              </div>
            ))
          )}
          {inspection.nextCursor ? (
            <button
              className="quiet-button"
              type="button"
              disabled={disabled}
              onClick={() =>
                void run("list-more", () =>
                  listThreads(
                    inspection,
                    inspection.workspace,
                    inspection.nextCursor!,
                  ),
                )
              }
            >
              {t("fleetSettings.moreThreads")}
            </button>
          ) : null}
          {inspection.thread ? (
            <section
              aria-label={t("fleetSettings.remoteThread")}
              className="fleet-section-space"
            >
              <h3>{inspection.thread.name || inspection.thread.id}</h3>
              <History value={inspection.history} />
              {inspection.historyCursor ? (
                <button
                  className="quiet-button"
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    void run("read-more", () =>
                      read(
                        inspection,
                        inspection.thread!,
                        inspection.historyCursor!,
                      ),
                    )
                  }
                >
                  {t("fleetSettings.readOlderItems")}
                </button>
              ) : null}
              {inspection.device.access === "control" ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run("send", async () => {
                      await invoke(
                        inspection.device.id,
                        inspection.deviceKey,
                        "zenx_threads_send",
                        {
                          threadId: inspection.thread!.id,
                          ...(inspection.workspace
                            ? { workspace: inspection.workspace }
                            : {}),
                          text: message,
                          messageType,
                        },
                      );
                      if (mounted.current) {
                        setMessage("");
                        setNotice(
                          t(
                            "fleetSettings.messageAcceptedByTheRemoteHostWorkMayStill",
                          ),
                        );
                      }
                    });
                  }}
                >
                  <Field
                    label={t("fleetSettings.messageToRemoteThread")}
                    value={message}
                    onChange={setMessage}
                    multiline
                    wide
                    disabled={disabled}
                  />
                  <label className="field">
                    <span>{t("fleetSettings.messageBehavior")}</span>
                    <Select
                      value={messageType}
                      disabled={disabled}
                      onValueChange={setMessageType}
                    >
                      <option value="guidance">
                        {t("fleetSettings.addGuidanceToCurrentWork")}
                      </option>
                      <option value="follow_up">
                        {t("fleetSettings.queueNextWork")}
                      </option>
                      <option value="replacement">
                        {t("fleetSettings.interruptAndReplaceCurrentWork")}
                      </option>
                    </Select>
                  </label>
                  <p className="settings-note">
                    {messageType === "replacement"
                      ? t("fleetSettings.sendingCanInterrupt", {
                          name: inspection.device.label,
                        })
                      : t("fleetSettings.sendingCanRunWork", {
                          name: inspection.device.label,
                        })}
                  </p>
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={disabled || !message.trim()}
                  >
                    {t("fleetSettings.sendToRemoteThread")}
                  </button>
                </form>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}

      <details className="fleet-hosting">
        <summary>
          <Icon name="computer" size={18} />
          <span>
            <strong>{t("fleetConnection.thisMachine")}</strong>
            <small>
              {snapshot.host.enabled
                ? t("fleetSettings.hostingEnabled")
                : t("fleetConnection.hostingOff")}
            </small>
          </span>
          <span className="fleet-hosting-action">
            {t("fleetConnection.manageHosting")}{" "}
            <Icon name="chevron-down" size={14} />
          </span>
        </summary>
        <div className="fleet-hosting-body">
          <div className="settings-card-head">
            <div>
              <h3>{t("fleetSettings.hostThisDevice")}</h3>
              <p>
                {t(
                  "fleetSettings.allowPairedDesktopAndMobileClientsToReachThis",
                )}
              </p>
            </div>
            <span
              role="status"
              className={snapshot.host.enabled ? "status-good" : "status-muted"}
            >
              {snapshot.host.enabled
                ? t("fleetSettings.hostingEnabled")
                : t("fleetSettings.hostingDisabled")}
            </span>
          </div>
          <p className="fleet-wrap">
            {t("fleetSettings.hostId")} {snapshot.host.hostId}
          </p>
          {snapshot.host.url ? (
            <p className="fleet-wrap">
              {t("fleetSettings.endpoint")} {snapshot.host.url}
            </p>
          ) : null}
          {snapshot.host.relayConfigured || hosting.relayEndpoint ? (
            <p role="status">
              {t("fleetSettings.relay")}{" "}
              {snapshot.host.relayConnected
                ? t("fleetSettings.connected")
                : snapshot.host.relayConfigured
                  ? t("fleetSettings.registeredNotConnected")
                  : t("fleetSettings.notRegistered")}
            </p>
          ) : null}
          {snapshot.host.error ? (
            <p className="settings-error" role="alert">
              {snapshot.host.error}
            </p>
          ) : null}
          <Confirmation
            checked={hosting.enabled}
            disabled={disabled}
            onChange={(enabled) => changeHosting({ enabled })}
          >
            {t("fleetSettings.enableHttpsHosting")}
          </Confirmation>
          <fieldset
            disabled={disabled || !hosting.enabled}
            className="fleet-fieldset fleet-block-space"
          >
            <div className="form-grid">
              <Field
                label={t("fleetSettings.bindAddress")}
                value={hosting.bindAddress}
                onChange={(bindAddress) => changeHosting({ bindAddress })}
              />
              <Field
                label={t("fleetSettings.port")}
                value={String(hosting.port)}
                onChange={(port) => changeHosting({ port: Number(port) })}
              />
              <Field
                label={t("fleetSettings.tlsCertificateFile")}
                value={hosting.tlsCertificateFile}
                onChange={(tlsCertificateFile) =>
                  changeHosting({ tlsCertificateFile })
                }
                wide
              />
              <Field
                label={t("fleetSettings.tlsPrivateKeyFile")}
                value={hosting.tlsKeyFile}
                onChange={(tlsKeyFile) => changeHosting({ tlsKeyFile })}
                wide
              />
              <Field
                label={t("fleetSettings.clientHttpsEndpoint")}
                value={hosting.originEndpoint ?? ""}
                placeholder="https://device.example:3940"
                onChange={(originEndpoint) =>
                  changeHosting({
                    originEndpoint: originEndpoint.trim() || undefined,
                  })
                }
                wide
              />
              <p className="settings-note field wide">
                {t(
                  "fleetSettings.useAnExactCertificateSanHostnameOrIpv4Address",
                )}
              </p>
              <Field
                label={t("fleetSettings.relayEndpointOptional")}
                value={hosting.relayEndpoint ?? ""}
                placeholder="https://relay.example"
                onChange={(relayEndpoint) =>
                  changeHosting({
                    relayEndpoint: relayEndpoint.trim() || undefined,
                  })
                }
                wide
              />
              <Field
                label={t("fleetSettings.relayRegistrationToken")}
                value={relayToken}
                placeholder={
                  snapshot.host.relayConfigured
                    ? t("fleetSettings.savedInBackendLeaveBlankToKeepIt")
                    : t("fleetSettings.enterTheTrustedRelaySRegistrationToken")
                }
                onChange={(value) => {
                  setRelayToken(value);
                  setExposureConfirmed(false);
                  setPairCode(null);
                }}
                secret
                wide
              />
              <AccessField
                label={t("fleetSettings.maximumClientAccess")}
                value={hosting.access}
                disabled={disabled || !hosting.enabled}
                onChange={(access) =>
                  changeHosting({
                    access,
                    ...(access === "read" ? { shellEnabled: false } : {}),
                  })
                }
              />
            </div>
          </fieldset>
          <Confirmation
            checked={hosting.shellEnabled === true}
            disabled={
              disabled || !hosting.enabled || hosting.access !== "control"
            }
            onChange={(shellEnabled) => changeHosting({ shellEnabled })}
          >
            {t("fleetSettings.allowShell")}
          </Confirmation>
          <p className="settings-note">{t("fleetSettings.hostShellHelp")}</p>
          <p className="settings-note">
            {t("fleetSettings.anOptionalSelfHostedRelayTerminatesTlsAndCan")}
          </p>
          <p className="settings-note">
            {t("fleetSettings.useExistingTlsFilesHostingDoesNotGenerateKeys")}
          </p>
          {hosting.enabled && hostingDirty ? (
            <Confirmation
              checked={exposureConfirmed}
              disabled={disabled}
              onChange={setExposureConfirmed}
            >
              {t("fleetSettings.iAllowThisHostToListenOn")}{" "}
              {hosting.bindAddress}:{hosting.port}{" "}
              {t(
                "fleetSettings.andExposeItsWorkspacesAndThreadsToPairedClients",
              )}
              {hosting.shellEnabled
                ? i18n.t("settings:fleetSettings.includingShell")
                : ""}
              {hosting.originEndpoint
                ? t("fleetSettings.androidConnectionsFrom", {
                    endpoint: hosting.originEndpoint,
                  })
                : ""}
              {hosting.relayEndpoint
                ? t("fleetSettings.throughRelay", {
                    endpoint: hosting.relayEndpoint,
                  })
                : ""}
            </Confirmation>
          ) : null}
          {hosting.enabled && hostingDirty && controlExpansion ? (
            <Confirmation
              checked={hostControlConfirmed}
              disabled={disabled}
              onChange={setHostControlConfirmed}
            >
              {t("fleetSettings.iAllowPairedClientsWithControlAccessToCreate")}
            </Confirmation>
          ) : null}
          <div className="settings-actions fleet-actions fleet-top-space">
            <button
              className="primary-button"
              type="button"
              disabled={
                disabled ||
                !hostingDirty ||
                (hosting.enabled &&
                  (!exposureConfirmed ||
                    (controlExpansion && !hostControlConfirmed)))
              }
              onClick={() =>
                void run("hosting", async () => {
                  if (
                    hosting.enabled &&
                    (!hosting.bindAddress.trim() ||
                      !Number.isInteger(hosting.port) ||
                      hosting.port < 1 ||
                      hosting.port > 65535 ||
                      !hosting.tlsCertificateFile.trim() ||
                      !hosting.tlsKeyFile.trim())
                  )
                    throw new Error(
                      t("fleetSettings.enterABindAddressAPortFrom165535"),
                    );
                  if (hosting.relayEndpoint) {
                    const endpoint = new URL(hosting.relayEndpoint);
                    if (
                      endpoint.protocol !== "https:" ||
                      endpoint.username ||
                      endpoint.password ||
                      endpoint.pathname !== "/" ||
                      endpoint.search ||
                      endpoint.hash
                    )
                      throw new Error(
                        t(
                          "fleetSettings.useAnHttpsRelayOriginWithoutAPathQuery",
                        ),
                      );
                  } else if (relayToken) {
                    throw new Error(
                      t(
                        "fleetSettings.enterTheTrustedRelayEndpointBeforeItsRegistrationToken",
                      ),
                    );
                  }
                  if (hosting.originEndpoint) {
                    const authority =
                      /^https:\/\/([a-zA-Z0-9.-]+):([1-9][0-9]{0,4})$/u.exec(
                        hosting.originEndpoint,
                      );
                    if (!authority || Number(authority[2]) !== hosting.port)
                      throw new Error(
                        t(
                          "fleetSettings.useAnExactHttpsHostnameOrIpv4AddressWith",
                        ),
                      );
                  }
                  await api.save(
                    {
                      ...snapshot.config,
                      hosting: {
                        ...hosting,
                        ...(relayToken
                          ? { relayRegistrationToken: relayToken }
                          : {}),
                      },
                    },
                    snapshot.revision,
                  );
                  if (mounted.current) setRelayToken("");
                  await refresh(true);
                  if (mounted.current) {
                    setExposureConfirmed(false);
                    setHostControlConfirmed(false);
                    setPairCode(null);
                    setNotice(t("fleetSettings.hostingConfigurationSaved"));
                  }
                })
              }
            >
              {busy === "hosting"
                ? t("fleetSettings.saving")
                : t("fleetSettings.applyHosting")}
            </button>
            {hostingDirty ? (
              <button
                className="secondary-button"
                type="button"
                disabled={disabled}
                onClick={() => {
                  setHosting(snapshot.config.hosting ?? defaultHosting);
                  setRelayToken("");
                  setExposureConfirmed(false);
                  setHostControlConfirmed(false);
                }}
              >
                {t("fleetSettings.discardChanges")}
              </button>
            ) : null}
          </div>
          <FleetInvitationIssuer
            api={api}
            snapshot={snapshot}
            disabled={disabled || editor !== null}
            hostingDirty={hostingDirty}
            onBusy={setOnboardingBusy}
            onChanged={() => refresh()}
            onHostStatus={(value) => {
              try {
                const latest = normalizeFleetSnapshot(value);
                setSnapshot((current) =>
                  current ? { ...current, host: latest.host } : current,
                );
              } catch {
                setError(i18n.t("settings:fleetSettings.hostRefreshFailed"));
              }
            }}
          />
          <details className="fleet-section-space">
            <summary>{t("fleetSettings.advancedPairingCode")}</summary>
            <button
              className="secondary-button"
              type="button"
              disabled={disabled || !snapshot.host.enabled || hostingDirty}
              onClick={() =>
                void run("host-pair", async () => {
                  const code = await api.hostPair();
                  if (mounted.current) setPairCode(code);
                })
              }
            >
              {t("fleetSettings.createPairingCode")}
            </button>
            {pairCode ? (
              <div role="status" className="fleet-top-space">
                <p>
                  {t("fleetSettings.oneTimePairingCode")}{" "}
                  <strong>{pairCode.code}</strong>
                </p>
                <p>
                  {t("fleetSettings.hostId2")} {pairCode.hostId}
                  {pairCode.expiresAt
                    ? t("fleetSettings.codeExpires", {
                        time: new Date(pairCode.expiresAt).toLocaleString(
                          i18n.resolvedLanguage,
                        ),
                      })
                    : t("fleetSettings.shortLivedCode")}
                </p>
                <p className="settings-note">
                  {t("fleetSettings.enterThisCodeAndTheHttpsEndpointOnThe")}
                </p>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => setPairCode(null)}
                >
                  {t("fleetSettings.hideCode")}
                </button>
              </div>
            ) : null}
          </details>
          <h3 className="fleet-section-space">
            {t("fleetSettings.pairedClients")}
          </h3>
          {snapshot.host.clients.length === 0 ? (
            <p>{t("fleetSettings.noPairedClients")}</p>
          ) : (
            snapshot.host.clients.map((client) => (
              <div className="settings-row" key={client.deviceId}>
                <div>
                  <strong>{client.label ?? client.deviceId}</strong>
                  <span>
                    {client.access === "control"
                      ? t("fleetSettings.threadControl")
                      : t("fleetSettings.readOnly")}{" "}
                    ·{" "}
                    {client.revoked
                      ? t("fleetSettings.revoked")
                      : t("fleetSettings.paired")}
                    {client.shellEnabled
                      ? i18n.t("settings:fleetSettings.shellGranted")
                      : i18n.t("settings:fleetSettings.noShellGrant")}
                  </span>
                </div>
                <button
                  type="button"
                  className="quiet-button"
                  disabled={disabled || client.revoked}
                  aria-label={t("fleetSettings.revokeNamedClient", {
                    name: client.label ?? client.deviceId,
                  })}
                  onClick={() => {
                    setRevoking(client.deviceId);
                    setError(null);
                  }}
                >
                  {t("fleetSettings.revoke")}
                </button>
              </div>
            ))
          )}
          {revoking ? (
            <div role="alertdialog" aria-labelledby="fleet-revoke-title">
              <h3 id="fleet-revoke-title">
                {t("fleetSettings.revoke2")}{" "}
                {snapshot.host.clients.find(
                  (client) => client.deviceId === revoking,
                )?.label ?? revoking}
                ?
              </h3>
              <p>{t("fleetSettings.thisEndsThisClientSAccessToThisHost")}</p>
              <div className="settings-actions fleet-actions">
                <button
                  className="danger-button"
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    void run("revoke", async () => {
                      await api.revoke(revoking);
                      await refresh();
                      if (mounted.current) {
                        setRevoking(null);
                        setNotice(t("fleetSettings.clientRevoked"));
                      }
                    })
                  }
                >
                  {t("fleetSettings.revokeClient")}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={disabled}
                  onClick={() => setRevoking(null)}
                >
                  {t("fleetSettings.cancel3")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </details>

      {notice ? (
        <div className="settings-note" role="status">
          {notice}
        </div>
      ) : null}
    </div>
  );
}

function availableMachineId(label: string, devices: Device[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "machine";
  let id = base === "local" ? "machine" : base;
  let suffix = 2;
  while (devices.some((device) => device.id === id)) id = `${base}-${suffix++}`;
  return id;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  secret,
  multiline,
  wide,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  disabled?: boolean;
  secret?: boolean;
  multiline?: boolean;
  wide?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={`field${wide ? " wide" : ""}`}>
      <span>{label}</span>
      {multiline ? (
        <textarea
          id={id}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          rows={4}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          type={secret ? "password" : "text"}
          autoComplete="off"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}
function AccessField({
  label,
  value,
  onChange,
  disabled,
}: {
  label?: string;
  value: Access;
  onChange(value: Access): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("settings");
  return (
    <label className="field">
      <span>{label ?? t("fleetSettings.access")}</span>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(access) => onChange(access as Access)}
      >
        <option value="read">{t("fleetSettings.readOnly")}</option>
        <option value="control">{t("fleetSettings.threadControl")}</option>
      </Select>
    </label>
  );
}
function Confirmation({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange(value: boolean): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="settings-note fleet-confirmation">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}
function History({ value }: { value: unknown }) {
  const { t } = useTranslation("settings");
  return (
    <div
      className="fleet-remote-history"
      aria-label={t("fleetSettings.remoteHistory")}
    >
      <FleetHistory value={value} />
    </div>
  );
}

function connectionCheckLabel(check: {
  state: "not_checked" | "checking" | "reachable" | "failed";
  checkedAt?: number;
  detail?: string;
}): string {
  const time = check.checkedAt
    ? i18n.t("settings:fleetSettings.checkedTime", {
        time: new Date(check.checkedAt).toLocaleString(i18n.resolvedLanguage),
      })
    : "";
  if (check.state === "not_checked")
    return i18n.t("settings:fleetSettings.notChecked");
  if (check.state === "checking")
    return i18n.t("settings:fleetSettings.checking");
  if (check.state === "reachable")
    return i18n.t("settings:fleetSettings.reachable") + time;
  return (
    (check.checkedAt
      ? i18n.t("settings:fleetSettings.lastCheckFailed")
      : i18n.t("settings:fleetSettings.connectionFailed")) +
    time +
    (check.detail ? ` · ${check.detail}` : "")
  );
}
function deviceCheckLabel(snapshot: FleetSettingsSnapshot, id: string): string {
  return connectionCheckLabel(
    snapshot.devices?.find((device) => device.id === id)?.check ?? {
      state: "not_checked",
    },
  );
}
function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
function unwrap(value: unknown): unknown {
  const envelope = record(value);
  return "device" in envelope && "result" in envelope ? envelope.result : value;
}

/** Host failure responses can omit grant details, but must still be renderable. */
function normalizeFleetSnapshot(value: unknown): FleetSettingsSnapshot {
  const snapshot = record(value);
  const config = record(snapshot.config);
  const host = record(snapshot.host);
  if (
    config.version !== 1 ||
    !Array.isArray(config.devices) ||
    typeof host.enabled !== "boolean" ||
    typeof host.hostId !== "string" ||
    !Number.isInteger(snapshot.revision) ||
    (snapshot.revision as number) < 0
  )
    throw new Error(
      i18n.t(
        "settings:fleetSettings.invalidFleetSettingsResponseRetryAfterCheckingTheHost",
      ),
    );
  if (host.clients !== undefined && !Array.isArray(host.clients))
    throw new Error(
      i18n.t(
        "settings:fleetSettings.invalidFleetClientListRetryAfterCheckingTheHost",
      ),
    );
  return {
    ...(value as FleetSettingsSnapshot),
    host: {
      ...(host as FleetSettingsSnapshot["host"]),
      clients:
        (host.clients as
          FleetSettingsSnapshot["host"]["clients"] | undefined) ?? [],
    },
  };
}
