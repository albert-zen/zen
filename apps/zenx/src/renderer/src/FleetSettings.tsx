import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Select } from "./ui/controls.js";

type Access = "read" | "control";
type Device = {
  id: string;
  label: string;
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
};

/** Public configuration only. Peer tokens and TLS key contents stay in main. */
export interface FleetSettingsSnapshot {
  revision: number;
  config: { version: 1; devices: Device[]; hosting?: Hosting };
  host: {
    enabled: boolean;
    hostId: string;
    url?: string;
    clients: Array<{
      deviceId: string;
      label?: string;
      access?: Access;
      revoked: boolean;
    }>;
    error?: string;
    relayConfigured?: boolean;
    relayConnected?: boolean;
  };
}

export interface FleetSettingsApi {
  status(): Promise<FleetSettingsSnapshot>;
  save(
    config: Omit<FleetSettingsSnapshot["config"], "hosting"> & {
      hosting?: Hosting & { relayRegistrationToken?: string };
    },
    expectedRevision?: number,
  ): Promise<unknown>;
  pair(input: {
    id: string;
    label: string;
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
  const api = (window.zenx as unknown as { fleet?: FleetSettingsApi }).fleet;
  const [snapshot, setSnapshot] = useState<FleetSettingsSnapshot | null>(null);
  const [hosting, setHosting] = useState(defaultHosting);
  const [relayToken, setRelayToken] = useState("");
  const [exposureConfirmed, setExposureConfirmed] = useState(false);
  const [hostControlConfirmed, setHostControlConfirmed] = useState(false);
  const [editor, setEditor] = useState<DeviceDraft | null>(null);
  const [removing, setRemoving] = useState<Device | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("guidance");
  const [pairCode, setPairCode] = useState<Awaited<
    ReturnType<FleetSettingsApi["hostPair"]>
  > | null>(null);
  const [connections, setConnections] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const inspectionVersion = useRef(0);
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const inspectorTrigger = useRef<HTMLButtonElement | null>(null);
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
    if (editor)
      editorRegion.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [editor?.originalId, editor !== null]);
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
    if (!api) throw new Error("Fleet connection is unavailable");
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
    setEditor(null);
    setError(null);
    editorTrigger.current?.focus();
  };
  const openEditor = (trigger: HTMLButtonElement, device?: Device) => {
    editorTrigger.current = trigger;
    setRemoving(null);
    setRevoking(null);
    setError(null);
    setNotice(null);
    setEditor({
      originalId: device?.id,
      transport: device?.transport === "https" ? "https" : "ssh",
      id: device?.id ?? "",
      label: device?.label ?? "",
      access: device?.access ?? "read",
      sshHost: device && device.transport !== "https" ? device.sshHost : "",
      command:
        device && device.transport !== "https" ? device.command.join("\n") : "",
      endpoint: device?.transport === "https" ? device.endpoint : "",
      hostId: device?.transport === "https" ? device.hostId : "",
      code: "",
      workspace: device?.workspace ?? "",
      controlConfirmed: false,
    });
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
    const current = editor;
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(current.id) ||
      current.id === "local"
    )
      throw new Error(
        "Use a unique device ID of 1–64 letters, numbers, underscores or hyphens; local is reserved.",
      );
    if (
      snapshot.config.devices.some(
        (entry) => entry.id === current.id && entry.id !== current.originalId,
      )
    )
      throw new Error("That device ID is already configured.");
    if (!current.label.trim()) throw new Error("Enter a device label.");
    if (current.access === "control" && !current.controlConfirmed)
      throw new Error("Confirm remote Thread control before saving.");
    let device: Device;
    if (current.transport === "ssh") {
      const command = current.command.split(/\r?\n/u);
      if (!current.sshHost.trim() || command.some((arg) => !arg.trim()))
        throw new Error(
          "Enter an SSH host and non-empty command arguments, one per line.",
        );
      device = {
        transport: "ssh",
        id: current.id,
        label: current.label.trim(),
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
        throw new Error("Use an HTTPS endpoint without embedded credentials.");
      if (!current.hostId.trim())
        throw new Error("Enter the remote Host ID shown by that device.");
      if (!current.originalId) {
        if (!current.code.trim())
          throw new Error(
            "Enter a current one-time pairing code from the remote Host.",
          );
        await api.pair({
          id: current.id,
          label: current.label.trim(),
          endpoint: current.endpoint.trim(),
          hostId: current.hostId.trim(),
          code: current.code.trim(),
          access: current.access,
        });
        await refresh();
        if (mounted.current) {
          closeEditor();
          setNotice("Device paired. Browse it to choose a workspace.");
        }
        return;
      }
      device = {
        transport: "https",
        id: current.id,
        label: current.label.trim(),
        endpoint: current.endpoint.trim(),
        hostId: current.hostId.trim(),
        access: current.access,
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
      setNotice("Device saved");
    }
  };

  const invoke = async (
    device: string,
    name: string,
    args: Record<string, unknown>,
  ) => {
    if (!api) throw new Error("Fleet connection is unavailable");
    const value = await api.invoke({ device, name, arguments: args });
    return unwrap(value);
  };
  const listThreads = async (
    current: Inspection,
    workspace: string,
    cursor?: string,
  ) => {
    const version = inspectionVersion.current;
    const result = record(
      await invoke(current.device.id, "zenx_threads_list", {
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
    const result = record(
      await invoke(device.id, "zenx_projects_list", { limit: 100 }),
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
      device.workspace ??
      (device.transport === "https" && projects.length === 1
        ? projects[0]!.id
        : "");
    const current: Inspection = {
      device,
      projects,
      workspace,
      threads: [],
      nextCursor: null,
      thread: null,
      history: null,
      historyCursor: null,
    };
    setInspection(current);
    if (device.transport === "https" && !workspace) return;
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
    const result = await invoke(current.device.id, "zenx_threads_read", {
      target: thread.id,
      ...(current.device.transport === "https" && current.workspace
        ? { workspace: current.workspace }
        : {}),
      granularity: "items",
      maxItemsPerTurn: 25,
      ...(cursor ? { cursor } : {}),
    });
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
        Fleet connection is unavailable in this app build.
      </div>
    );
  if (!snapshot)
    return (
      <div className="page-card settings-card">
        <p role={error ? "alert" : "status"}>{error ?? "Loading Fleet…"}</p>
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
            Retry
          </button>
        ) : null}
      </div>
    );
  const disabled = busy !== null;
  const hostingDirty =
    JSON.stringify(hosting) !==
      JSON.stringify(snapshot.config.hosting ?? defaultHosting) ||
    relayToken.length > 0;
  const controlExpansion =
    hosting.access === "control" &&
    snapshot.config.hosting?.access !== "control";

  return (
    <>
      <header>
        <h2>Fleet</h2>
        <p>
          Connect your Zen Hosts. Each device keeps its own workspaces, Threads
          and permissions.
        </p>
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
                  "Fleet configuration changed while you were editing. Cancel the device editor or discard hosting changes, then refresh before saving.",
                );
              }
              setSnapshot(value);
              if (!hostingDirty)
                setHosting(value.config.hosting ?? defaultHosting);
              setNotice("Fleet status refreshed");
            })
          }
        >
          Refresh Fleet
        </button>
      </header>
      <div className="page-card settings-card">
        <div className="settings-card-head">
          <div>
            <h3>Devices</h3>
            <p>
              SSH uses your existing SSH setup. HTTPS uses a pinned Host ID and
              a one-time pairing code.
            </p>
          </div>
          <button
            ref={addButton}
            className="secondary-button"
            type="button"
            disabled={disabled}
            onClick={(event) => openEditor(event.currentTarget)}
          >
            Add device
          </button>
        </div>
        {snapshot.config.devices.length === 0 ? (
          <p className="settings-empty">No remote devices configured</p>
        ) : (
          snapshot.config.devices.map((device) => (
            <div className="settings-row" key={device.id}>
              <div>
                <strong>{device.label}</strong>
                <span>
                  {device.id} · {device.transport === "https" ? "HTTPS" : "SSH"}{" "}
                  ·{" "}
                  {device.access === "control" ? "Thread control" : "Read only"}
                </span>
                <span style={{ overflowWrap: "anywhere" }}>
                  {device.transport === "https"
                    ? device.endpoint
                    : device.sshHost}
                </span>
                <span role="status">
                  {connections[device.id] ?? "Not checked"}
                </span>
              </div>
              <div
                className="settings-actions"
                style={{ display: "flex", flexWrap: "wrap" }}
              >
                <button
                  type="button"
                  className="quiet-button"
                  aria-label={`Test ${device.label}`}
                  disabled={disabled}
                  onClick={() =>
                    void run(`test:${device.id}`, async () => {
                      setConnections((value) => ({
                        ...value,
                        [device.id]: "Checking…",
                      }));
                      try {
                        const result = record(await api.test(device.id));
                        if (result.ok === false)
                          throw new Error(
                            string(result.error) || "Connection failed",
                          );
                        if (mounted.current)
                          setConnections((value) => ({
                            ...value,
                            [device.id]: "Connected",
                          }));
                      } catch (reason) {
                        if (mounted.current)
                          setConnections((value) => ({
                            ...value,
                            [device.id]: "Connection failed",
                          }));
                        throw reason;
                      }
                    })
                  }
                >
                  Test
                </button>
                <button
                  type="button"
                  className="quiet-button"
                  aria-label={`Browse ${device.label}`}
                  disabled={disabled}
                  onClick={(event) => {
                    const trigger = event.currentTarget;
                    void run(`browse:${device.id}`, () =>
                      browse(device, trigger),
                    );
                  }}
                >
                  Browse
                </button>
                <button
                  type="button"
                  className="quiet-button"
                  aria-label={`Edit ${device.label}`}
                  disabled={disabled}
                  onClick={(event) => openEditor(event.currentTarget, device)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="quiet-button"
                  aria-label={`Remove ${device.label}`}
                  disabled={disabled}
                  onClick={() => {
                    setRemoving(device);
                    setEditor(null);
                    setError(null);
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {editor ? (
        <div
          ref={editorRegion}
          className="page-card settings-card provider-editor"
          aria-label="Device editor"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !disabled) {
              event.preventDefault();
              closeEditor();
            }
          }}
        >
          <h3>{editor.originalId ? `Edit ${editor.label}` : "Add device"}</h3>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run("save-device", saveDevice);
            }}
          >
            <fieldset
              disabled={disabled}
              style={{ border: 0, padding: 0, margin: 0 }}
            >
              <div className="form-grid">
                <Field
                  label="Device ID"
                  value={editor.id}
                  disabled={!!editor.originalId}
                  onChange={(id) => edit({ id })}
                />
                <Field
                  label="Label"
                  value={editor.label}
                  onChange={(label) => edit({ label })}
                />
                <label className="field">
                  <span>Connection</span>
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
                    <option value="ssh">SSH</option>
                    <option value="https">HTTPS pairing</option>
                  </Select>
                </label>
                <AccessField
                  value={editor.access}
                  disabled={disabled}
                  onChange={(access) =>
                    edit({ access, controlConfirmed: false })
                  }
                />
                {editor.transport === "ssh" ? (
                  <>
                    <Field
                      label="SSH host"
                      value={editor.sshHost}
                      placeholder="user@device or SSH config alias"
                      onChange={(sshHost) => edit({ sshHost })}
                      wide
                    />
                    <Field
                      label="Command arguments (one per line)"
                      value={editor.command}
                      placeholder={
                        "node\n/path/to/fleet-bridge.js\n/path/to/connection.json"
                      }
                      onChange={(command) => edit({ command })}
                      wide
                      multiline
                    />
                    <p className="settings-note field wide">
                      These exact arguments run on the remote device through
                      verified SSH. Configure SSH keys and known hosts yourself
                      before testing.
                    </p>
                  </>
                ) : (
                  <>
                    <Field
                      label="HTTPS endpoint"
                      value={editor.endpoint}
                      placeholder="https://device.example:3940"
                      disabled={!!editor.originalId}
                      onChange={(endpoint) => edit({ endpoint })}
                      wide
                    />
                    <Field
                      label="Remote Host ID"
                      value={editor.hostId}
                      disabled={!!editor.originalId}
                      onChange={(hostId) => edit({ hostId })}
                      wide
                    />
                    {editor.originalId ? (
                      <Field
                        label="Workspace ID (optional)"
                        value={editor.workspace}
                        onChange={(workspace) => edit({ workspace })}
                        wide
                      />
                    ) : (
                      <Field
                        label="One-time pairing code"
                        value={editor.code}
                        onChange={(code) => edit({ code })}
                        secret
                        wide
                      />
                    )}
                    <p className="settings-note field wide">
                      Check the Host ID directly on the remote device. Pairing
                      verifies its identity; saved credentials stay in this
                      app’s protected backend. To change the endpoint or
                      identity, remove this device and pair again. Changing
                      local access cannot expand a server-issued read-only
                      grant. To upgrade, remove this saved device and pair again
                      with Thread control selected; the remote Host must allow
                      it.
                    </p>
                  </>
                )}
              </div>
              {editor.access === "control" ? (
                <Confirmation
                  checked={editor.controlConfirmed}
                  onChange={(controlConfirmed) => edit({ controlConfirmed })}
                >
                  I allow ZenX to create Threads and send messages that can run
                  work on this remote device
                </Confirmation>
              ) : null}
            </fieldset>
            <div
              className="settings-actions"
              style={{ display: "flex", flexWrap: "wrap" }}
            >
              <button
                className="primary-button"
                type="submit"
                disabled={
                  disabled ||
                  (editor.access === "control" && !editor.controlConfirmed)
                }
              >
                {busy === "save-device"
                  ? "Saving…"
                  : editor.transport === "https" && !editor.originalId
                    ? "Pair device"
                    : "Save device"}
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={disabled}
                onClick={closeEditor}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {removing ? (
        <div
          className="page-card settings-card"
          role="alertdialog"
          aria-labelledby="fleet-remove-title"
          aria-describedby="fleet-remove-detail"
        >
          <h3 id="fleet-remove-title">Remove {removing.label}?</h3>
          <p id="fleet-remove-detail">
            This removes the saved connection from this app. Remote Threads
            remain on their Host. Revoke this app on the remote Host to end its
            grant there.
          </p>
          <div className="settings-actions" style={{ display: "flex" }}>
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
                    setNotice("Device removed");
                    addButton.current?.focus();
                  }
                })
              }
            >
              Remove device
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={disabled}
              onClick={() => {
                setRemoving(null);
                addButton.current?.focus();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {inspection ? (
        <div
          ref={inspectorRegion}
          className="page-card settings-card"
          tabIndex={-1}
          aria-label={`Browse ${inspection.device.label}`}
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
                Remote workspaces and Threads ·{" "}
                {inspection.device.access === "control"
                  ? "Control enabled"
                  : "Read only"}
              </p>
            </div>
            <button
              className="quiet-button"
              type="button"
              disabled={disabled}
              onClick={closeInspection}
            >
              Close browser
            </button>
          </div>
          <label className="field">
            <span>Remote workspace</span>
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
              <option
                value=""
                disabled={inspection.device.transport === "https"}
              >
                {inspection.device.transport === "https"
                  ? "Choose a workspace"
                  : "All workspaces"}
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
          <div
            className="settings-actions"
            style={{ display: "flex", flexWrap: "wrap", marginBlock: 12 }}
          >
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
              Refresh Threads
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
                      setInspection({ ...inspection, device });
                      setNotice("Workspace selected for this device");
                    }
                  })
                }
              >
                Use selected workspace
              </button>
            ) : null}
          </div>
          {inspection.threads.length === 0 ? (
            <p>
              {inspection.device.transport === "https" && !inspection.workspace
                ? "Choose a workspace to browse its Threads"
                : "No Threads in this workspace"}
            </p>
          ) : (
            inspection.threads.map((thread) => (
              <div className="settings-row" key={thread.id}>
                <div>
                  <strong>{thread.name || thread.id}</strong>
                  <span style={{ overflowWrap: "anywhere" }}>
                    {thread.id} · {thread.status}
                  </span>
                </div>
                <button
                  className="quiet-button"
                  type="button"
                  aria-label={`Read ${thread.name || thread.id}`}
                  disabled={disabled}
                  onClick={() => {
                    inspectionVersion.current++;
                    void run("read-thread", () => read(inspection, thread));
                  }}
                >
                  Read
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
              More Threads
            </button>
          ) : null}
          {inspection.thread ? (
            <section aria-label="Remote Thread" style={{ marginTop: 20 }}>
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
                  Read older items
                </button>
              ) : null}
              {inspection.device.access === "control" ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run("send", async () => {
                      await invoke(inspection.device.id, "zenx_threads_send", {
                        target: inspection.thread!.id,
                        ...(inspection.device.transport === "https" &&
                        inspection.workspace
                          ? { workspace: inspection.workspace }
                          : {}),
                        text: message,
                        messageType,
                      });
                      if (mounted.current) {
                        setMessage("");
                        setNotice(
                          "Message accepted by the remote Host. Work may still be running; refresh to check its reply.",
                        );
                      }
                    });
                  }}
                >
                  <Field
                    label="Message to remote Thread"
                    value={message}
                    onChange={setMessage}
                    multiline
                    wide
                    disabled={disabled}
                  />
                  <label className="field">
                    <span>Message behavior</span>
                    <Select
                      value={messageType}
                      disabled={disabled}
                      onValueChange={setMessageType}
                    >
                      <option value="guidance">
                        Add guidance to current work
                      </option>
                      <option value="follow_up">Queue next work</option>
                      <option value="replacement">
                        Interrupt and replace current work
                      </option>
                    </Select>
                  </label>
                  <p className="settings-note">
                    Sending can run work on {inspection.device.label}
                    {messageType === "replacement"
                      ? " and interrupt its current task"
                      : ""}
                    .
                  </p>
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={disabled || !message.trim()}
                  >
                    Send to remote Thread
                  </button>
                </form>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}

      <div className="page-card settings-card">
        <div className="settings-card-head">
          <div>
            <h3>Host this device</h3>
            <p>
              Allow paired desktop and mobile clients to reach this Host over
              HTTPS.
            </p>
          </div>
          <span
            role="status"
            className={snapshot.host.enabled ? "status-good" : "status-muted"}
          >
            {snapshot.host.enabled ? "Hosting enabled" : "Hosting disabled"}
          </span>
        </div>
        <p style={{ overflowWrap: "anywhere" }}>
          Host ID: {snapshot.host.hostId}
        </p>
        {snapshot.host.url ? (
          <p style={{ overflowWrap: "anywhere" }}>
            Endpoint: {snapshot.host.url}
          </p>
        ) : null}
        {snapshot.host.relayConfigured || hosting.relayEndpoint ? (
          <p role="status">
            Relay:{" "}
            {snapshot.host.relayConnected
              ? "Connected"
              : snapshot.host.relayConfigured
                ? "Registered · not connected"
                : "Not registered"}
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
          Enable HTTPS hosting
        </Confirmation>
        <fieldset
          disabled={disabled || !hosting.enabled}
          style={{ border: 0, padding: 0, margin: "12px 0" }}
        >
          <div className="form-grid">
            <Field
              label="Bind address"
              value={hosting.bindAddress}
              onChange={(bindAddress) => changeHosting({ bindAddress })}
            />
            <Field
              label="Port"
              value={String(hosting.port)}
              onChange={(port) => changeHosting({ port: Number(port) })}
            />
            <Field
              label="TLS certificate file"
              value={hosting.tlsCertificateFile}
              onChange={(tlsCertificateFile) =>
                changeHosting({ tlsCertificateFile })
              }
              wide
            />
            <Field
              label="TLS private key file"
              value={hosting.tlsKeyFile}
              onChange={(tlsKeyFile) => changeHosting({ tlsKeyFile })}
              wide
            />
            <Field
              label="Android-facing HTTPS endpoint"
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
              Use an exact certificate SAN hostname or IPv4 address and an
              explicit port matching the listener, with no trailing slash. Blank
              allows only native Origin-absent clients; Android WebSocket
              clients need this exact HTTPS endpoint. This does not enable
              browser pairing or broad CORS access.
            </p>
            <Field
              label="Relay endpoint (optional)"
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
              label="Relay registration token"
              value={relayToken}
              placeholder={
                snapshot.host.relayConfigured
                  ? "Saved in backend; leave blank to keep it"
                  : "Enter the trusted relay’s registration token"
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
              label="Maximum client access"
              value={hosting.access}
              disabled={disabled || !hosting.enabled}
              onChange={(access) => changeHosting({ access })}
            />
          </div>
        </fieldset>
        <p className="settings-note">
          An optional self-hosted relay terminates TLS and can see relayed
          pairing codes, messages and device credentials. Use a trusted
          operator; this is not end-to-end encrypted. The registration token is
          saved only in the protected backend; leave it blank to keep the
          existing token.
        </p>
        <p className="settings-note">
          Use existing TLS files. Hosting does not generate keys or change
          firewall/router settings. A loopback bind is reachable only on this
          computer; a network bind can expose this Host to other devices.
          Clients still require pairing.
        </p>
        {hosting.enabled && hostingDirty ? (
          <Confirmation
            checked={exposureConfirmed}
            disabled={disabled}
            onChange={setExposureConfirmed}
          >
            I allow this Host to listen on {hosting.bindAddress}:{hosting.port}{" "}
            and expose its workspaces and Threads to paired clients
            {hosting.originEndpoint
              ? `, including Android connections from ${hosting.originEndpoint}`
              : ""}
            {hosting.relayEndpoint
              ? ` through ${hosting.relayEndpoint}, whose operator can see relayed credentials and messages`
              : ""}
          </Confirmation>
        ) : null}
        {hosting.enabled && hostingDirty && controlExpansion ? (
          <Confirmation
            checked={hostControlConfirmed}
            disabled={disabled}
            onChange={setHostControlConfirmed}
          >
            I allow paired clients with control access to create Threads and run
            work on this device
          </Confirmation>
        ) : null}
        <div
          className="settings-actions"
          style={{ display: "flex", flexWrap: "wrap", marginTop: 12 }}
        >
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
                    "Enter a bind address, a port from 1–65535 and existing TLS certificate/key file paths.",
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
                      "Use an HTTPS relay origin without a path, query, fragment or embedded credentials.",
                    );
                } else if (relayToken) {
                  throw new Error(
                    "Enter the trusted relay endpoint before its registration token.",
                  );
                }
                if (hosting.originEndpoint) {
                  const authority =
                    /^https:\/\/([a-zA-Z0-9.-]+):([1-9][0-9]{0,4})$/u.exec(
                      hosting.originEndpoint,
                    );
                  if (!authority || Number(authority[2]) !== hosting.port)
                    throw new Error(
                      "Use an exact HTTPS hostname or IPv4 address with the listener’s explicit port for Android. The Host will verify the certificate SAN.",
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
                  setNotice("Hosting configuration saved");
                }
              })
            }
          >
            {busy === "hosting" ? "Saving…" : "Apply hosting"}
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
              Discard changes
            </button>
          ) : null}
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
            Create pairing code
          </button>
        </div>
        {pairCode ? (
          <div role="status" style={{ marginTop: 12 }}>
            <p>
              One-time pairing code: <strong>{pairCode.code}</strong>
            </p>
            <p>
              Host ID: {pairCode.hostId}
              {pairCode.expiresAt
                ? ` · Expires ${new Date(pairCode.expiresAt).toLocaleString()}`
                : " · Short-lived; use it now"}
            </p>
            <p className="settings-note">
              Enter this code and the HTTPS endpoint on the client you want to
              pair. Anyone with this code can request access until it expires or
              is used.
            </p>
            <button
              type="button"
              className="quiet-button"
              onClick={() => setPairCode(null)}
            >
              Hide code
            </button>
          </div>
        ) : null}
        <h3 style={{ marginTop: 20 }}>Paired clients</h3>
        {snapshot.host.clients.length === 0 ? (
          <p>No paired clients</p>
        ) : (
          snapshot.host.clients.map((client) => (
            <div className="settings-row" key={client.deviceId}>
              <div>
                <strong>{client.label ?? client.deviceId}</strong>
                <span>
                  {client.access === "control" ? "Thread control" : "Read only"}{" "}
                  · {client.revoked ? "Revoked" : "Paired"}
                </span>
              </div>
              <button
                type="button"
                className="quiet-button"
                disabled={disabled || client.revoked}
                aria-label={`Revoke ${client.label ?? client.deviceId}`}
                onClick={() => {
                  setRevoking(client.deviceId);
                  setError(null);
                }}
              >
                Revoke
              </button>
            </div>
          ))
        )}
        {revoking ? (
          <div role="alertdialog" aria-labelledby="fleet-revoke-title">
            <h3 id="fleet-revoke-title">
              Revoke{" "}
              {snapshot.host.clients.find(
                (client) => client.deviceId === revoking,
              )?.label ?? revoking}
              ?
            </h3>
            <p>
              This ends this client’s access to this Host. It must pair again to
              reconnect.
            </p>
            <div className="settings-actions" style={{ display: "flex" }}>
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
                      setNotice("Client revoked");
                    }
                  })
                }
              >
                Revoke client
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={disabled}
                onClick={() => setRevoking(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {error ? (
        <div className="settings-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="settings-note" role="status">
          {notice}
        </div>
      ) : null}
    </>
  );
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
  label = "Access",
  value,
  onChange,
  disabled,
}: {
  label?: string;
  value: Access;
  onChange(value: Access): void;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(access) => onChange(access as Access)}
      >
        <option value="read">Read only</option>
        <option value="control">Thread control</option>
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
    <label
      className="settings-note"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        marginBlock: 12,
      }}
    >
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
  const items = array(record(value).items);
  return (
    <div aria-label="Remote history">
      {items.length ? (
        items.map((entry, index) => {
          const item = record(entry);
          const text = string(
            item.text ?? record(item.item).text ?? item.preview,
          );
          return (
            <div
              key={string(item.id ?? item.itemId) || index}
              style={{
                marginBlock: 12,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              <strong>{string(item.type) || "Item"}</strong>
              <p>{text || JSON.stringify(item, null, 2)}</p>
              {item.truncated || item.textTruncated ? (
                <small className="settings-note">Excerpt shown</small>
              ) : null}
            </div>
          );
        })
      ) : (
        <p>No history items returned</p>
      )}
    </div>
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
      "Invalid Fleet settings response; retry after checking the Host connection.",
    );
  if (host.clients !== undefined && !Array.isArray(host.clients))
    throw new Error(
      "Invalid Fleet client list; retry after checking the Host connection.",
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
