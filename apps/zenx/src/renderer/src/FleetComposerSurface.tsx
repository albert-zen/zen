import { useTranslation } from "react-i18next";
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
  const { t, i18n } = useTranslation("settings");
  const translateStatus = (value: string) =>
    value === "active"
      ? t("fleetComposer.statusActive")
      : value === "idle"
        ? t("fleetComposer.statusIdle")
        : value;
  const translateMessage = (value: FleetComposerMessage) =>
    typeof value === "string"
      ? value
      : t(value.key, {
          ...value.values,
          ...(value.checkedAt !== undefined
            ? {
                time: new Date(value.checkedAt).toLocaleTimeString(
                  i18n.resolvedLanguage,
                ),
              }
            : {}),
        });
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
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<FleetComposerMessage | null>(null);
  const [notice, setNotice] = useState<FleetComposerMessage | null>(null);
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
          setError({
            key: "fleetComposer.catalogFailedPreserved",
            values: { error: describe(reason) },
          });
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
      setStatus(typeof state.status === "string" ? state.status : "unknown");
      setError(null);
      setNotice({
        key: "fleetComposer.snapshotChecked",
        checkedAt: Date.now(),
      });
    } catch (reason) {
      if (
        !live.current ||
        version !== scope.current ||
        readVersion !== reading.current
      )
        return;
      setStatus("snapshot_unavailable");
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
        setError({
          key: "fleetComposer.operationFailedInspect",
          values: { error: describe(reason) },
        });
        if (uncertainOnError) setUnknown(true);
      } else
        onNotice?.(
          i18n.t("settings:fleetComposer.earlierOperationUncertain", {
            deviceId,
            error: describe(reason),
          }),
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
        i18n.t("settings:fleetComposer.acceptedAfterLeaving", {
          deviceId: current.deviceId,
          threadId: current.threadId,
        }),
      );
      return;
    }
    if (version === editVersion.current && textRef.current === sent) {
      editVersion.current++;
      onTextChange("");
    }
    setUnknown(false);
    setNotice({
      key: "fleetComposer.messageAccepted",
      values: { deviceId: current.deviceId },
    });
    await read(current).catch((reason: unknown) => {
      if (live.current)
        setError({
          key: "fleetComposer.acceptedSnapshotUnavailable",
          values: { deviceId: current.deviceId, error: describe(reason) },
        });
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
          <span>{t("fleetComposer.machine")}</span>
          <Select
            value={deviceId}
            disabled={busy || locator !== null}
            onValueChange={changeMachine}
          >
            <option value="local">{t("fleetComposer.thisMachine")}</option>
            {machines.map((machine) => (
              <option value={machine.id} key={machine.id}>
                {machine.label}
              </option>
            ))}
          </Select>
        </label>
        {locator ? (
          <span>
            {t("fleetComposer.machineLocked", {
              deviceId: locator.deviceId,
              threadId: locator.threadId,
            })}
          </span>
        ) : (
          <span>
            {machines.find((machine) => machine.id === deviceId)?.description ??
              t("fleetComposer.machineOwnsThread")}
          </span>
        )}
      </div>
      {!remote ? (
        <>
          {error ? (
            <p className="settings-note" role="status">
              {t("fleetComposer.localCatalogUnavailable", {
                error: translateMessage(error),
              })}
            </p>
          ) : null}
          {children}
        </>
      ) : (
        <div className="fleet-remote-conversation">
          <header>
            <h2>
              {locator
                ? t("fleetComposer.remoteConversation")
                : t("fleetComposer.newConversationOn", {
                    name:
                      catalog?.machine.label ??
                      machines.find((entry) => entry.id === deviceId)?.label ??
                      deviceId,
                  })}
            </h2>
            <p>
              {catalog?.machine.description ??
                t("fleetComposer.targetPermissions")}
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
                {t("fleetComposer.reloadCatalog")}
              </button>
            ) : null}
          </header>
          {error ? (
            <p className="settings-error" role="alert">
              {translateMessage(error)}
            </p>
          ) : null}
          {loading ? (
            <p role="status">{t("fleetComposer.loadingCatalog")}</p>
          ) : null}
          {catalog ? (
            <>
              <div className="form-grid">
                <label className="field">
                  <span>{t("fleetComposer.targetWorkspace")}</span>
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
                    <option value="">
                      {t("fleetComposer.chooseWorkspace")}
                    </option>
                    {catalog.workspaces.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="field">
                  <span>{t("fleetComposer.newThreadModel")}</span>
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
                      {t("fleetComposer.chooseModel")}
                    </option>
                    {catalog.models.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.isDefault
                          ? t("fleetComposer.modelDefault", {
                              name: entry.label,
                            })
                          : entry.label}
                      </option>
                    ))}
                  </Select>
                </label>
                {selectedModel?.efforts.length ? (
                  <label className="field">
                    <span>{t("fleetComposer.targetReasoning")}</span>
                    <Select
                      value={effort}
                      disabled={busy || locator !== null}
                      onValueChange={setEffort}
                    >
                      <option value="">
                        {t("fleetComposer.targetDefault")}
                      </option>
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
                    <span>{t("fleetComposer.openExistingThread")}</span>
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
                        {t("fleetComposer.createOrChooseThread")}
                      </option>
                      {threads.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.label} · {translateStatus(entry.status)}
                        </option>
                      ))}
                    </Select>
                  </label>
                ) : null}
              </div>
              {locator ? (
                <>
                  <p className="settings-note">
                    {t("fleetComposer.snapshotScope", {
                      deviceId,
                      route:
                        locator.hostId ?? t("fleetComposer.verifiedSshRoute"),
                      workspace,
                      status:
                        status === null
                          ? t("fleetComposer.notChecked")
                          : status === "snapshot_unavailable"
                            ? t("fleetComposer.snapshotUnavailable")
                            : status === "unknown"
                              ? t("fleetComposer.unknownStatus")
                              : translateStatus(status),
                    })}
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
                    {t("fleetComposer.refreshThread")}
                  </button>
                  <div
                    className="fleet-remote-history"
                    aria-label={t("fleetComposer.history")}
                  >
                    <FleetHistory value={history} />
                  </div>
                </>
              ) : (
                <p className="settings-note">
                  {t("fleetComposer.createDescription")}{" "}
                  {control ? "" : t("fleetComposer.readOnly")}
                </p>
              )}
              {attachmentCount ? (
                <p role="alert">{t("fleetComposer.attachmentWarning")}</p>
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
                          i18n.t("settings:fleetComposer.createdAfterLeaving", {
                            threadId: current.threadId,
                            deviceId: current.deviceId,
                          }),
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
                      ? t("fleetComposer.messageToThread")
                      : t("fleetComposer.taskForMachine")}
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
                    <span>{t("fleetComposer.messageBehavior")}</span>
                    <Select
                      value={messageType}
                      disabled={busy}
                      onValueChange={setMessageType}
                    >
                      <option value="guidance">
                        {t("fleetComposer.guidance")}
                      </option>
                      <option value="follow_up">
                        {t("fleetComposer.followUp")}
                      </option>
                      <option value="replacement">
                        {t("fleetComposer.replacement")}
                      </option>
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
                    ? t("fleetComposer.sending")
                    : locator
                      ? t("fleetComposer.send")
                      : t("fleetComposer.start")}
                </button>
              </form>
              {unknown ? (
                <p className="settings-note">
                  {t("fleetComposer.inspectOutcome")}
                </p>
              ) : null}
              {notice ? <p role="status">{translateMessage(notice)}</p> : null}
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
                    setStatus(null);
                  }}
                >
                  {t("fleetComposer.newDraft")}
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
              {t("fleetComposer.returnLocal")}
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

type FleetComposerMessage =
  | string
  | {
      key: string;
      values?: Record<string, string | number>;
      checkedAt?: number;
    };
