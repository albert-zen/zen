import { useEffect, useRef, useState, type ReactNode } from "react";
import { Select } from "./ui/controls.js";
import { FleetHistory } from "./FleetHistory.js";
import type {
  FleetTargetCatalog,
  FleetThreadLocator,
} from "../../main/fleet-product.js";
import type { FleetSettingsApi } from "./FleetSettings.js";

export interface FleetProductApi extends FleetSettingsApi {
  catalog(id: string): Promise<FleetTargetCatalog>;
  listThreads(input: {
    deviceId: string;
    deviceKey: string;
    workspace: string;
  }): Promise<{
    threads: Array<{ id: string; label: string; status: string }>;
    truncated: boolean;
  }>;
  createThread(input: {
    deviceId: string;
    deviceKey: string;
    workspace: string;
    model: string;
    effort?: string;
  }): Promise<FleetThreadLocator>;
  readThread(locator: FleetThreadLocator): Promise<Record<string, unknown>>;
  threadStatus(locator: FleetThreadLocator): Promise<Record<string, unknown>>;
  sendThread(input: {
    locator: FleetThreadLocator;
    text: string;
    messageType?: "guidance" | "follow_up" | "replacement";
  }): Promise<unknown>;
}

/** An ephemeral target-scoped view. Local conversations keep their existing path. */
export function FleetComposerSurface({
  children,
  text,
  onTextChange,
  attachmentCount = 0,
  onNotice,
}: {
  children: ReactNode;
  text: string;
  onTextChange(text: string): void;
  attachmentCount?: number;
  onNotice?(notice: string): void;
}) {
  const api = (window.zenx as unknown as { fleet?: FleetProductApi }).fleet;
  const [machines, setMachines] = useState<
    Array<{ id: string; label: string; description?: string }>
  >([]);
  const [deviceId, setDeviceId] = useState("local");
  const [catalog, setCatalog] = useState<FleetTargetCatalog | null>(null);
  const [catalogReload, setCatalogReload] = useState(0);
  const [workspace, setWorkspace] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [threads, setThreads] = useState<
    Array<{ id: string; label: string; status: string }>
  >([]);
  const [locator, setLocator] = useState<FleetThreadLocator | null>(null);
  const [history, setHistory] = useState<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState("Not checked");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [messageType, setMessageType] = useState("guidance");
  const live = useRef(false);
  const scope = useRef(0);
  const reading = useRef(0);
  const mutation = useRef(false);
  const textRef = useRef(text);
  const editVersion = useRef(0);
  if (textRef.current !== text) {
    textRef.current = text;
    editVersion.current++;
  }
  useEffect(() => {
    live.current = true;
    if (api)
      void api
        .status()
        .then((value) => {
          if (live.current) setMachines(value.config.devices);
        })
        .catch((reason: unknown) => {
          if (live.current) setError(describe(reason));
        });
    return () => {
      live.current = false;
      scope.current++;
    };
  }, [api]);
  useEffect(() => {
    if (!api || deviceId === "local") return;
    const version = ++scope.current;
    setLoading(true);
    setError(null);
    setNotice(null);
    setCatalog(null);
    setWorkspace("");
    setModel("");
    setThreads([]);
    setHistory(null);
    setUnknown(false);
    void api
      .catalog(deviceId)
      .then((value) => {
        if (!live.current || version !== scope.current) return;
        setCatalog(value);
        setWorkspace(
          value.preferredWorkspace &&
            value.workspaces.some(
              (entry) => entry.id === value.preferredWorkspace,
            )
            ? value.preferredWorkspace
            : value.workspaces.length === 1
              ? value.workspaces[0]!.id
              : "",
        );
        const choice =
          value.models.find((entry) => entry.isDefault) ?? value.models[0];
        setModel(choice?.id ?? "");
        setEffort(choice?.defaultEffort ?? "");
      })
      .catch((reason: unknown) => {
        if (live.current && version === scope.current)
          setError(
            `${describe(reason)} Your text is preserved; no local machine was substituted.`,
          );
      })
      .finally(() => {
        if (live.current && version === scope.current) setLoading(false);
      });
  }, [api, deviceId, catalogReload]);
  useEffect(() => {
    if (!api || !catalog || !workspace || locator) return;
    let active = true;
    const version = scope.current;
    void api
      .listThreads({ deviceId, deviceKey: catalog.machine.key, workspace })
      .then((value) => {
        if (active && live.current && version === scope.current)
          setThreads(value.threads);
      })
      .catch((reason: unknown) => {
        if (active && live.current && version === scope.current)
          setError(describe(reason));
      });
    return () => {
      active = false;
    };
  }, [api, catalog, deviceId, workspace, locator]);

  const read = async (current: FleetThreadLocator) => {
    if (!api) return;
    const version = scope.current;
    const readVersion = ++reading.current;
    try {
      const [items, state] = await Promise.all([
        api.readThread(current),
        api.threadStatus(current),
      ]);
      if (
        !live.current ||
        version !== scope.current ||
        readVersion !== reading.current
      )
        return;
      setHistory(items);
      setStatus(typeof state.status === "string" ? state.status : "Unknown");
      setError(null);
      setNotice(`Snapshot checked ${new Date().toLocaleTimeString()}`);
    } catch (reason) {
      if (
        !live.current ||
        version !== scope.current ||
        readVersion !== reading.current
      )
        return;
      setStatus("Unavailable · last snapshot may be stale");
      setError(describe(reason));
      throw reason;
    }
  };
  useEffect(() => {
    if (!locator || !api) return;
    const version = scope.current;
    void read(locator).catch((reason: unknown) => {
      if (live.current && version === scope.current) setError(describe(reason));
    });
  }, [locator, api]);
  useEffect(() => {
    if (!api || !locator || status !== "active") return;
    const version = scope.current;
    const timer = window.setInterval(() => {
      if (mutation.current) return;
      void read(locator).catch((reason: unknown) => {
        if (live.current && version === scope.current)
          setError(describe(reason));
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [api, locator, status]);
  const changeMachine = (id: string) => {
    if (locator || mutation.current) return;
    scope.current++;
    setDeviceId(id);
    setCatalog(null);
    setWorkspace("");
    setModel("");
    setEffort("");
    setThreads([]);
    setHistory(null);
    setError(null);
    setUnknown(false);
    setNotice(null);
  };
  const run = async (
    operation: () => Promise<void>,
    uncertainOnError = true,
  ) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (reason) {
      if (live.current) {
        setError(
          `${describe(reason)} Inspect the selected remote machine before trying again. No operation was automatically retried.`,
        );
        if (uncertainOnError) setUnknown(true);
      } else
        onNotice?.(
          `Earlier Fleet operation on ${deviceId} has an uncertain outcome: ${describe(reason)}. Inspect that machine before retrying.`,
        );
    } finally {
      mutation.current = false;
      if (live.current) setBusy(false);
    }
  };
  const send = async (
    current: FleetThreadLocator,
    sent: string,
    version: number,
  ) => {
    await api!.sendThread({
      locator: current,
      text: sent,
      messageType: messageType as "guidance" | "follow_up" | "replacement",
    });
    if (!live.current) {
      onNotice?.(
        `Message accepted on machine ${current.deviceId}, Thread ${current.threadId}, after leaving its view. Acceptance is not completion.`,
      );
      return;
    }
    if (version === editVersion.current && textRef.current === sent) {
      editVersion.current++;
      onTextChange("");
    }
    setUnknown(false);
    setNotice(
      `Message accepted on ${current.deviceId}; the target may still be running`,
    );
    await read(current).catch((reason: unknown) => {
      if (live.current)
        setError(
          `Message accepted on ${current.deviceId}, but its latest snapshot is unavailable: ${describe(reason)}. Refresh to inspect; the message was not retried.`,
        );
    });
  };
  if (!api) return <>{children}</>;
  const remote = deviceId !== "local";
  const control = catalog?.machine.access === "control";
  const selectedModel = catalog?.models.find((entry) => entry.id === model);
  return (
    <div className="fleet-composer-surface">
      <div className="fleet-machine-strip">
        <label className="field">
          <span>Machine</span>
          <Select
            value={deviceId}
            disabled={busy || locator !== null}
            onValueChange={changeMachine}
          >
            <option value="local">This machine</option>
            {machines.map((machine) => (
              <option value={machine.id} key={machine.id}>
                {machine.label}
              </option>
            ))}
          </Select>
        </label>
        {locator ? (
          <span>
            Machine locked · {locator.deviceId} · Thread {locator.threadId}
          </span>
        ) : (
          <span>
            {machines.find((machine) => machine.id === deviceId)?.description ??
              "The selected machine owns the Thread and its permissions"}
          </span>
        )}
      </div>
      {!remote ? (
        <>
          {error ? (
            <p className="settings-note" role="status">
              Fleet catalog unavailable: {error}
            </p>
          ) : null}
          {children}
        </>
      ) : (
        <div className="fleet-remote-conversation">
          <header>
            <h2>
              {locator
                ? "Remote conversation"
                : `New conversation on ${catalog?.machine.label ?? machines.find((entry) => entry.id === deviceId)?.label ?? deviceId}`}
            </h2>
            <p>
              {catalog?.machine.description ??
                "Target permissions and models apply. Your local Thread is unchanged."}
            </p>
            {!locator ? (
              <button
                className="quiet-button"
                type="button"
                disabled={busy || loading}
                onClick={() => {
                  scope.current++;
                  setCatalogReload((value) => value + 1);
                }}
              >
                Reload target catalog
              </button>
            ) : null}
          </header>
          {error ? (
            <p className="settings-error" role="alert">
              {error}
            </p>
          ) : null}
          {loading ? (
            <p role="status">Loading this machine’s workspaces and models…</p>
          ) : null}
          {catalog ? (
            <>
              <div className="form-grid">
                <label className="field">
                  <span>Target workspace</span>
                  <Select
                    value={workspace}
                    disabled={busy || locator !== null}
                    onValueChange={(value) => {
                      scope.current++;
                      setWorkspace(value);
                      setThreads([]);
                      setHistory(null);
                      setError(null);
                    }}
                  >
                    <option value="">Choose a target workspace</option>
                    {catalog.workspaces.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="field">
                  <span>Model for new Threads</span>
                  <Select
                    value={model}
                    disabled={busy || locator !== null}
                    onValueChange={(value) => {
                      setModel(value);
                      setEffort(
                        catalog.models.find((entry) => entry.id === value)
                          ?.defaultEffort ?? "",
                      );
                    }}
                  >
                    <option value="" disabled>
                      Choose a target model
                    </option>
                    {catalog.models.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                        {entry.isDefault ? " · Default" : ""}
                      </option>
                    ))}
                  </Select>
                </label>
                {selectedModel?.efforts.length ? (
                  <label className="field">
                    <span>Target reasoning</span>
                    <Select
                      value={effort}
                      disabled={busy || locator !== null}
                      onValueChange={setEffort}
                    >
                      <option value="">Target default</option>
                      {selectedModel.efforts.map((entry) => (
                        <option key={entry} value={entry}>
                          {entry}
                        </option>
                      ))}
                    </Select>
                  </label>
                ) : null}
                {!locator && workspace ? (
                  <label className="field">
                    <span>Open an existing remote Thread</span>
                    <Select
                      value=""
                      disabled={busy}
                      onValueChange={(threadId) => {
                        scope.current++;
                        setLocator({
                          deviceId,
                          deviceKey: catalog.machine.key,
                          ...(catalog.machine.hostId
                            ? { hostId: catalog.machine.hostId }
                            : {}),
                          workspace,
                          threadId,
                        });
                        setUnknown(false);
                      }}
                    >
                      <option value="">
                        Create new, or choose an existing Thread
                      </option>
                      {threads.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.label} · {entry.status}
                        </option>
                      ))}
                    </Select>
                  </label>
                ) : null}
              </div>
              {locator ? (
                <>
                  <p className="settings-note">
                    {deviceId} · {locator.hostId ?? "Verified SSH route"} ·{" "}
                    {workspace} · {status}. This is a checked public snapshot,
                    not a full local copy of remote history.
                  </p>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await read(locator);
                      }, false)
                    }
                  >
                    Refresh remote Thread
                  </button>
                  <div
                    className="fleet-remote-history"
                    aria-label="Remote conversation history"
                  >
                    <FleetHistory value={history} />
                  </div>
                </>
              ) : (
                <p className="settings-note">
                  Create uses this target’s current defaults and selected Zen
                  model. It creates an idle Thread first; sending starts work.{" "}
                  {control
                    ? ""
                    : "This machine is read-only; you can inspect existing Threads."}
                </p>
              )}
              {attachmentCount ? (
                <p role="alert">
                  This remote entry supports text only. Remove local
                  images/attachments or return to This machine before sending;
                  nothing was discarded.
                </p>
              ) : null}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (
                    unknown ||
                    !control ||
                    !text.trim() ||
                    attachmentCount ||
                    !workspace ||
                    !model
                  )
                    return;
                  const sent = text;
                  const version = editVersion.current;
                  void run(async () => {
                    let current = locator;
                    if (!current) {
                      current = await api.createThread({
                        deviceId,
                        deviceKey: catalog.machine.key,
                        workspace,
                        model,
                        ...(effort ? { effort } : {}),
                      });
                      if (!live.current) {
                        onNotice?.(
                          `Remote Thread ${current.threadId} was created on ${current.deviceId} after leaving its draft; inspect it before creating another. No message was sent.`,
                        );
                        return;
                      }
                      setLocator(current);
                    }
                    await send(current, sent, version);
                  });
                }}
              >
                <label className="field">
                  <span>
                    {locator
                      ? "Message to remote Thread"
                      : "Task for the remote machine"}
                  </span>
                  <textarea
                    value={text}
                    onChange={(event) => {
                      editVersion.current++;
                      onTextChange(event.target.value);
                    }}
                    rows={5}
                  />
                </label>
                {locator ? (
                  <label className="field">
                    <span>Remote message behavior</span>
                    <Select
                      value={messageType}
                      disabled={busy}
                      onValueChange={setMessageType}
                    >
                      <option value="guidance">Add guidance</option>
                      <option value="follow_up">Queue next work</option>
                      <option value="replacement">Interrupt and replace</option>
                    </Select>
                  </label>
                ) : null}
                <button
                  className="primary-button"
                  type="submit"
                  disabled={
                    busy ||
                    unknown ||
                    !control ||
                    !workspace ||
                    !model ||
                    !text.trim() ||
                    attachmentCount > 0
                  }
                >
                  {busy
                    ? "Sending to target…"
                    : locator
                      ? "Send to remote Thread"
                      : "Start on selected machine"}
                </button>
              </form>
              {unknown ? (
                <p className="settings-note">
                  Outcome needs inspection. Refresh the remote Thread or reopen
                  this machine’s catalog; automatic retry is disabled.
                </p>
              ) : null}
              {notice ? <p role="status">{notice}</p> : null}
              {locator ? (
                <button
                  className="quiet-button"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    scope.current++;
                    setLocator(null);
                    setHistory(null);
                    setError(null);
                    setUnknown(false);
                    setStatus("Not checked");
                  }}
                >
                  New draft on this machine
                </button>
              ) : null}
            </>
          ) : !loading ? (
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setDeviceId("local");
                scope.current++;
              }}
            >
              Return to This machine
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
