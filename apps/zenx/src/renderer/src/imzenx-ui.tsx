import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { Dialog, Select } from "./ui/controls.js";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Icon } from "./icons.js";
import { DirectoryPicker } from "./DirectoryPicker.js";
import type {
  ImZenXSetupView,
  ImZenXChannelSave,
} from "../../main/imzenx-setup-service.js";
import type {
  PluginUiRegistry,
  PluginUiSurfaceProps,
} from "./plugin-ui-host.js";

interface Configuration {
  pythonExecutable: string;
  channelsConfigFile: string;
  cwd: string;
  sharedFilesystemRoot: string;
  permissionMode: "full-access" | "approval-required";
  allowUnrestrictedFullAccess: boolean;
}
export interface ImZenXDraft {
  config: Configuration;
  revision: number;
  dirty: boolean;
  settingsOpen: boolean;
}
export const ImZenXDraftContext = createContext<RefObject<
  Record<string, ImZenXDraft>
> | null>(null);
interface Status {
  state: string;
  configurationRevision?: string;
  error?: string;
  configuration: Partial<Configuration> | null;
  activeConfiguration?: Partial<Configuration> | null;
  explicitConnectRequired?: boolean;
}
interface Readiness {
  ready: boolean;
  configurationRevision: string;
  checks: Array<{
    id: string;
    status: "ready" | "blocked" | "warning";
    message: string;
    action?: string;
  }>;
  enabledChannels: string[];
  singleConsumerConfirmationRequired: true;
  connectionState: string;
}
const empty: Configuration = {
  pythonExecutable: "",
  channelsConfigFile: "",
  cwd: "",
  sharedFilesystemRoot: "",
  permissionMode: "approval-required",
  allowUnrestrictedFullAccess: false,
};
const stateKeys: Record<string, string> = {
  unconfigured: "notConfigured",
  prepared: "imPreparedWaitingToConnect",
  "waiting-for-activation": "waitingForPluginActivation",
  "waiting-for-zas": "waitingForZenxAgentService",
  starting: "connecting",
  connected: "imLocalConsumerRunning",
  failed: "connectionFailed",
  stopped: "stopped",
};
export function registerImZenXUi(registry: PluginUiRegistry): () => void {
  return registry.registerTrusted("zenx/bundled/imzenx-ui", {
    connection: ImZenXPage,
  });
}
function configurationFrom(
  value: Partial<Configuration> | null,
): Configuration {
  return {
    pythonExecutable: value?.pythonExecutable ?? "",
    channelsConfigFile: value?.channelsConfigFile ?? "",
    cwd: value?.cwd ?? "",
    sharedFilesystemRoot: value?.sharedFilesystemRoot ?? "",
    permissionMode: value?.permissionMode ?? empty.permissionMode,
    allowUnrestrictedFullAccess: value?.allowUnrestrictedFullAccess ?? false,
  };
}
function sameConfiguration(
  left: Configuration,
  right: Partial<Configuration> | null,
): boolean {
  if (!right) return false;
  const other = configurationFrom(right);
  return (Object.keys(empty) as Array<keyof Configuration>).every(
    (key) => left[key] === other[key],
  );
}
type OwnImSnapshot = ImZenXSetupView;
type OwnImChannel = OwnImSnapshot["channels"][number];
interface OwnImApi {
  inspect(): Promise<OwnImSnapshot>;
  saveChannel(input: ImZenXChannelSave): Promise<OwnImSnapshot>;
  prepareRuntime(): Promise<OwnImSnapshot>;
}
function ownImApi(): OwnImApi | undefined {
  return (window as unknown as { zenx?: { imzenx?: OwnImApi } }).zenx?.imzenx;
}
function OwnImSetup({
  api,
  disabled,
  onApply,
  onBusy,
  onDirty,
}: {
  api: OwnImApi;
  disabled: boolean;
  onApply(snapshot: OwnImSnapshot): void;
  onBusy(busy: boolean): void;
  onDirty(dirty: boolean): void;
}) {
  useTranslation("panels");
  const [snapshot, setSnapshot] = useState<OwnImSnapshot | null>(null);
  const [channelId, setChannelId] = useState("");
  const [values, setValues] = useState<OwnImChannel["values"]>({});
  const [secretOperations, setSecretOperations] = useState<
    Record<string, "keep" | "replace" | "clear">
  >({});
  const [busy, setBusy] = useState<string | null>("inspect");
  const busyRef = useRef(true);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<
    { key: string } | { message: string } | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const mounted = useRef(false);
  const callbacks = useRef({ onApply, onBusy, onDirty });
  callbacks.current = { onApply, onBusy, onDirty };
  const clearPasswords = () => {
    formRef.current
      ?.querySelectorAll<HTMLInputElement>('input[type="password"]')
      .forEach((input) => {
        input.value = "";
      });
  };
  const loadChannel = (channel: OwnImChannel | undefined) => {
    clearPasswords();
    setChannelId(channel?.id ?? "");
    setValues(
      Object.fromEntries(
        (channel?.fields ?? [])
          .filter((field) => !field.secret)
          .map((field) => [
            field.key,
            channel?.values[field.key] ??
              field.defaultValue ??
              (field.type === "boolean" ? false : ""),
          ]),
      ),
    );
    setSecretOperations(
      Object.fromEntries(
        (channel?.fields ?? [])
          .filter((field) => field.secret)
          .map((field) => [
            field.key,
            !channel?.secretConfigured[field.key] && field.required
              ? "replace"
              : "keep",
          ]),
      ),
    );
    setDirty(false);
    callbacks.current.onDirty(false);
  };
  const applySnapshot = (result: OwnImSnapshot, selected = channelId) => {
    setSnapshot(result);
    loadChannel(
      result.channels.find(
        (channel) => channel.id === selected && channel.supported,
      ) ?? result.channels.find((channel) => channel.supported),
    );
  };
  useEffect(() => {
    mounted.current = true;
    callbacks.current.onBusy(true);
    void api
      .inspect()
      .then((result) => {
        if (mounted.current) applySnapshot(result);
      })
      .catch(() => {
        if (mounted.current) setError({ key: "imReadSettingsFailed" });
      })
      .finally(() => {
        busyRef.current = false;
        if (mounted.current) {
          setBusy(null);
          callbacks.current.onBusy(false);
        }
      });
    return () => {
      mounted.current = false;
    };
  }, [api]);
  useEffect(() => {
    const form = formRef.current;
    return () => {
      form
        ?.querySelectorAll<HTMLInputElement>('input[type="password"]')
        .forEach((input) => {
          input.value = "";
        });
    };
  }, [channelId]);
  const markDirty = () => {
    setDirty(true);
    setNotice(null);
    callbacks.current.onDirty(true);
  };
  const run = async (action: "inspect" | "runtime" | "save") => {
    if (disabled || busyRef.current) return;
    if (action === "save" && (!snapshot?.encryptionAvailable || !channelId))
      return;
    busyRef.current = true;
    setBusy(action);
    callbacks.current.onBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action === "runtime") {
        const result = await api.prepareRuntime();
        if (!mounted.current) return;
        // Preparing the runtime must not replace a channel form the user is filling.
        setSnapshot(result);
        if (result.runtime.prepared) {
          callbacks.current.onApply(result);
          setNotice("imRuntimePreparedNotice");
        } else
          setError(
            result.runtime.error
              ? { message: result.runtime.error }
              : { key: "imRuntimePreparationIncomplete" },
          );
      } else if (action === "save") {
        const channel = snapshot!.channels.find(
          (entry) => entry.id === channelId,
        )!;
        // Password values go directly to the local native API, never the plugin SDK or draft context.
        const secrets = Object.fromEntries(
          channel.fields
            .filter((field) => field.secret)
            .map((field) => {
              const operation = secretOperations[field.key] ?? "keep";
              const input = formRef.current?.elements.namedItem(
                field.key,
              ) as HTMLInputElement | null;
              return [
                field.key,
                {
                  operation,
                  ...(operation === "replace"
                    ? { value: input?.value ?? "" }
                    : {}),
                },
              ];
            }),
        );
        const pending = api.saveChannel({ channelId, values, secrets });
        clearPasswords();
        const result = await pending;
        if (!mounted.current) return;
        applySnapshot(result);
        callbacks.current.onApply(result);
        setNotice("imChannelSavedNotice");
      } else {
        const result = await api.inspect();
        if (mounted.current) {
          if (dirty) setSnapshot(result);
          else applySnapshot(result);
        }
      }
    } catch {
      clearPasswords();
      if (mounted.current)
        setError(
          action === "save"
            ? { key: "imChannelSaveFailed" }
            : action === "runtime"
              ? { key: "imRuntimePreparationFailed" }
              : { key: "imReadSettingsFailed" },
        );
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(null);
        callbacks.current.onBusy(false);
      }
    }
  };
  const channel = snapshot?.channels.find((entry) => entry.id === channelId);
  return (
    <section
      className="imzenx-connection imzenx-routing imzenx-own-setup"
      aria-label={i18n.t("panels:imOwnSetup")}
    >
      <h3>{i18n.t("panels:imOwnSetup")}</h3>
      <p className="imzenx-hint">
        {i18n.t("panels:imCredentialStorageNotice")}
      </p>
      {error ? (
        <p className="imzenx-error" role="alert">
          {"key" in error ? i18n.t(`panels:${error.key}`) : error.message}
        </p>
      ) : null}
      {snapshot ? (
        <>
          <div className="imzenx-runtime-setup">
            <span role="status">
              {snapshot.runtime.prepared
                ? i18n.t("panels:imRuntimePrepared")
                : snapshot.runtime.preparing || busy === "runtime"
                  ? i18n.t("panels:imPreparingRuntime")
                  : i18n.t("panels:imRuntimePreparationRequired")}
            </span>
            <button
              className="secondary-button"
              type="button"
              disabled={disabled || busy !== null || snapshot.runtime.preparing}
              onClick={() => void run("runtime")}
            >
              {busy === "runtime"
                ? i18n.t("panels:imPreparing")
                : i18n.t("panels:imPrepareRuntime")}
            </button>
          </div>
          <p className="imzenx-hint">
            {i18n.t("panels:imRuntimeInstallNotice")}
          </p>
          <p className="imzenx-hint">
            {snapshot.runtime.source}{" "}
            <a
              href="https://docs.astral.sh/uv/getting-started/installation/"
              target="_blank"
              rel="noreferrer"
            >
              {i18n.t("panels:imUvInstallationGuide")}
            </a>
          </p>
          {!snapshot.encryptionAvailable ? (
            <p role="alert" className="imzenx-storage-warning">
              {i18n.t("panels:imSecureStorageUnavailable")}
            </p>
          ) : null}
          <label className="field">
            <span>{i18n.t("panels:imChannel")}</span>
            <Select
              value={channelId}
              disabled={
                disabled ||
                busy !== null ||
                !snapshot.channels.some((entry) => entry.supported)
              }
              onValueChange={(value) => {
                clearPasswords();
                loadChannel(
                  snapshot.channels.find((entry) => entry.id === value),
                );
                setError(null);
                setNotice(null);
              }}
            >
              {snapshot.channels.map((entry) => (
                <option
                  key={entry.id}
                  value={entry.id}
                  disabled={!entry.supported}
                >
                  {entry.supported
                    ? entry.label
                    : i18n.t("panels:imUnsupportedChannel", {
                        channel: entry.label,
                      })}
                </option>
              ))}
            </Select>
          </label>
          {snapshot.channels
            .filter((entry) => !entry.supported && entry.prerequisite)
            .map((entry) => (
              <p key={entry.id} className="imzenx-hint">
                {entry.label}: {entry.prerequisite}
              </p>
            ))}
          {channel?.supported ? (
            <form
              ref={formRef}
              onSubmit={(event) => {
                event.preventDefault();
                void run("save");
              }}
            >
              <fieldset
                className="imzenx-fields"
                disabled={disabled || busy !== null}
              >
                <div className="imzenx-form-grid">
                  {channel.fields.map((field) =>
                    field.secret ? (
                      <div key={field.key} className="imzenx-secret-field">
                        <label className="field">
                          <span>{field.label}</span>
                          {secretOperations[field.key] === "replace" ? (
                            <input
                              name={field.key}
                              type="password"
                              autoComplete="new-password"
                              disabled={!snapshot.encryptionAvailable}
                              required={field.required}
                              onInput={markDirty}
                            />
                          ) : (
                            <span className="imzenx-secret-state">
                              {secretOperations[field.key] === "clear"
                                ? i18n.t("panels:imSecretWillClear")
                                : channel.secretConfigured[field.key]
                                  ? i18n.t("panels:imSecretStored")
                                  : i18n.t("panels:imSecretNotSet")}
                            </span>
                          )}
                        </label>
                        <div className="imzenx-actions">
                          <button
                            className="imzenx-text-button"
                            type="button"
                            onClick={() => {
                              clearPasswords();
                              setSecretOperations({
                                ...secretOperations,
                                [field.key]: "replace",
                              });
                              markDirty();
                            }}
                          >
                            {i18n.t("panels:imReplaceCredential", {
                              field: field.label,
                            })}
                          </button>
                          <button
                            className="imzenx-text-button"
                            type="button"
                            onClick={() => {
                              clearPasswords();
                              setSecretOperations({
                                ...secretOperations,
                                [field.key]: "clear",
                              });
                              markDirty();
                            }}
                          >
                            {i18n.t("panels:imClearCredential", {
                              field: field.label,
                            })}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <label
                        key={field.key}
                        className={
                          field.type === "boolean" ? "imzenx-checkbox" : "field"
                        }
                      >
                        {field.type === "boolean" ? (
                          <>
                            <input
                              type="checkbox"
                              checked={values[field.key] === true}
                              onChange={(event) => {
                                setValues({
                                  ...values,
                                  [field.key]: event.target.checked,
                                });
                                markDirty();
                              }}
                            />
                            <span>{field.label}</span>
                          </>
                        ) : (
                          <>
                            <span>{field.label}</span>
                            {field.options ? (
                              <Select
                                value={String(
                                  values[field.key] ?? field.defaultValue ?? "",
                                )}
                                onValueChange={(value) => {
                                  setValues({ ...values, [field.key]: value });
                                  markDirty();
                                }}
                              >
                                {field.options.map((option) => (
                                  <option key={option} value={option}>
                                    {option}
                                  </option>
                                ))}
                              </Select>
                            ) : (
                              <input
                                required={field.required}
                                value={String(values[field.key] ?? "")}
                                onChange={(event) => {
                                  setValues({
                                    ...values,
                                    [field.key]: event.target.value,
                                  });
                                  markDirty();
                                }}
                              />
                            )}
                          </>
                        )}
                      </label>
                    ),
                  )}
                </div>
                <div className="imzenx-save">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      loadChannel(channel);
                      setError(null);
                      setNotice(null);
                    }}
                  >
                    {i18n.t("panels:imCancelChanges")}
                  </button>
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={!snapshot.encryptionAvailable || !dirty}
                  >
                    {i18n.t("panels:imSaveChannel")}
                  </button>
                </div>
              </fieldset>
            </form>
          ) : (
            <p className="imzenx-hint">
              {i18n.t("panels:imDeclaredFieldsNotice")}
            </p>
          )}
        </>
      ) : (
        <p role="status">
          {busy === "inspect"
            ? i18n.t("panels:imReadingSettings")
            : i18n.t("panels:imSettingsUnavailable")}
        </p>
      )}
      {notice ? (
        <p className="imzenx-notice" role="status">
          {i18n.t(`panels:${notice}`)}
        </p>
      ) : null}
      <button
        type="button"
        className="imzenx-text-button"
        disabled={disabled || busy !== null}
        onClick={() => void run("inspect")}
      >
        {i18n.t("panels:imReloadSettings")}
      </button>
    </section>
  );
}
export function ImZenXPage({ sdk }: PluginUiSurfaceProps) {
  useTranslation("panels");
  const sdkRef = useRef(sdk);
  useEffect(() => {
    sdkRef.current = sdk;
  }, [sdk]);
  const drafts = useContext(ImZenXDraftContext);
  const draft = drafts?.current[sdk.pluginId];
  const [config, setConfigState] = useState(draft?.config ?? empty);
  const configRef = useRef(config);
  const revision = useRef(draft?.revision ?? 0);
  const dirtyRef = useRef(draft?.dirty ?? false);
  const [dirty, setDirty] = useState(dirtyRef.current);
  const [status, setStatus] = useState<Status | null>(null);
  const [readiness, setReadiness] = useState<{
    value: Readiness;
    revision: number;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(
    draft?.settingsOpen ?? false,
  );
  const settingsRevision = useRef(0);
  const [operation, setOperation] = useState<string | null>("status");
  const nativeApi = ownImApi();
  const [nativeBusy, setNativeBusy] = useState(false);
  const nativeBusyRef = useRef(false);
  const [nativeDirty, setNativeDirty] = useState(false);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const busy = operation !== null || nativeBusy;
  const busyRef = useRef(true);
  const mounted = useRef(false);
  const statusVersion = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [singleConsumerConfirmed, setSingleConsumerConfirmed] = useState(false);
  const setConfig = (value: Configuration) => {
    revision.current++;
    configRef.current = value;
    dirtyRef.current = true;
    setConfigState(value);
    setDirty(true);
    setReadiness(null);
    setNotice(null);
    setConnectOpen(false);
    setSingleConsumerConfirmed(false);
    if (drafts)
      drafts.current[sdk.pluginId] = {
        config: value,
        revision: revision.current,
        dirty: true,
        settingsOpen: true,
      };
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const request = ++statusVersion.current;
    const loadedRevision = revision.current;
    const loadedSettingsRevision = settingsRevision.current;
    void sdkRef.current.commands
      .execute("status")
      .then((value) => {
        if (!active || request !== statusVersion.current) return;
        const result = value as Status;
        setStatus(result);
        if (revision.current === loadedRevision && !dirtyRef.current) {
          const loaded = configurationFrom(result.configuration);
          configRef.current = loaded;
          setConfigState(loaded);
          if (drafts)
            drafts.current[sdk.pluginId] = {
              config: loaded,
              revision: loadedRevision,
              dirty: false,
              settingsOpen:
                drafts.current[sdk.pluginId]?.settingsOpen ??
                (!result.configuration && !nativeApi),
            };
        }
        if (settingsRevision.current === loadedSettingsRevision)
          setSettingsOpen(
            drafts?.current[sdk.pluginId]?.settingsOpen ??
              (!result.configuration && !nativeApi),
          );
      })
      .catch((reason: unknown) => {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) {
          busyRef.current = false;
          setOperation(null);
        }
      });
    return () => {
      active = false;
      mounted.current = false;
      statusVersion.current++;
    };
  }, [sdk.pluginId]);
  useEffect(() => {
    if (busy) return;
    let active = true;
    const timer = setInterval(() => {
      if (busyRef.current) return;
      const request = ++statusVersion.current;
      void sdkRef.current.commands
        .execute("status")
        .then((value) => {
          if (active && request === statusVersion.current)
            setStatus(value as Status);
        })
        .catch(() => {
          /* Explicit refresh reports request errors. */
        });
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [sdk.pluginId, busy]);
  useEffect(() => {
    // A fresh readiness response may supersede an older status snapshot. Compare
    // only when a new authoritative status arrives (including background polls).
    if (
      !status?.configurationRevision ||
      !readiness ||
      !sameConfiguration(configRef.current, status.configuration) ||
      status.configurationRevision === readiness.value.configurationRevision
    )
      return;
    setReadiness(null);
    setConnectOpen(false);
    setSingleConsumerConfirmed(false);
    setNotice("imReadinessChanged");
  }, [status]);
  const run = async (
    command: "status" | "readiness" | "prepare" | "connect",
  ) => {
    // A ref closes the same-event-loop gap before disabled controls rerender.
    if (busyRef.current || nativeBusyRef.current) return;
    busyRef.current = true;
    setOperation(command);
    setError(null);
    setNotice(null);
    const savedRevision = revision.current;
    const selectedConfig = { ...configRef.current };
    const request = ++statusVersion.current;
    try {
      const value = await sdkRef.current.commands.execute(
        command,
        command === "prepare" || command === "readiness"
          ? selectedConfig
          : command === "connect"
            ? {
                singleConsumerConfirmed: true,
                expectedConfigurationRevision:
                  currentReadiness?.configurationRevision,
              }
            : undefined,
      );
      if (!mounted.current) return;
      if (command === "readiness") {
        if (revision.current === savedRevision)
          setReadiness({ value: value as Readiness, revision: savedRevision });
        else setNotice("imConfigurationEditedNotice");
      } else {
        if (request === statusVersion.current) setStatus(value as Status);
        if (command === "prepare") {
          setReadiness(null);
          setConnectOpen(false);
          setSingleConsumerConfirmed(false);
          setNotice("imPreparationSavedNotice");
          if (revision.current === savedRevision) {
            dirtyRef.current = false;
            setDirty(false);
            const current = drafts?.current[sdk.pluginId];
            if (current?.revision === savedRevision) current.dirty = false;
          }
        }
      }
    } catch (reason) {
      if (!mounted.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      if (command === "readiness" || command === "connect") setReadiness(null);
      if (command === "connect") {
        setConnectOpen(false);
        setSingleConsumerConfirmed(false);
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setOperation(null);
    }
  };
  const pathsComplete = Boolean(
    config.pythonExecutable.trim() &&
    config.channelsConfigFile.trim() &&
    config.cwd.trim(),
  );
  const saved =
    !dirty && sameConfiguration(config, status?.configuration ?? null);
  const currentReadiness =
    readiness?.revision === revision.current ? readiness.value : null;
  const canConnect =
    saved &&
    !nativeDirty &&
    !nativeBusy &&
    currentReadiness?.ready === true &&
    Boolean(currentReadiness.configurationRevision?.trim());
  const pendingConnection =
    (status?.state === "connected" &&
      status.explicitConnectRequired === true) ||
    Boolean(
      status?.activeConfiguration &&
      !sameConfiguration(
        configurationFrom(status.activeConfiguration),
        status.configuration,
      ),
    );
  return (
    <div className="imzenx-page">
      <header className="imzenx-heading">
        <span className="imzenx-mark">
          <Icon name="imzenx" size={24} />
        </span>
        <div>
          <h2>{i18n.t("panels:imConnection")}</h2>
          <p>{i18n.t("panels:imSetupDescription")}</p>
        </div>
      </header>
      <section
        className="imzenx-connection"
        aria-label={i18n.t("panels:connectionOverview")}
      >
        <div className="imzenx-connection-top">
          <div className="imzenx-endpoint">
            <Icon name="terminal" size={20} />
            <div>
              <h3>{i18n.t("panels:localZenxAgent")}</h3>
              <p>{i18n.t("panels:usesTheCurrentZenxConversationService")}</p>
            </div>
          </div>
          <span
            className="imzenx-status"
            data-state={status?.state}
            role="status"
          >
            <span aria-hidden="true" />
            {status
              ? stateKeys[status.state]
                ? i18n.t(`panels:${stateKeys[status.state]}`)
                : status.state
              : i18n.t("panels:loading")}
          </span>
        </div>
        {error || status?.error ? (
          <p className="imzenx-error" role="alert">
            {error ===
            "IM settings changed after readiness was reviewed. Check readiness, confirm other bot consumers are stopped, then Connect again."
              ? i18n.t("panels:imReadinessChanged")
              : (error ?? status?.error)}
          </p>
        ) : null}
        {pendingConnection ? (
          <p className="imzenx-active-note">
            {i18n.t("panels:imPendingConfigurationNotice")}
          </p>
        ) : null}
        <div className="imzenx-connection-bottom">
          <span>{i18n.t("panels:imDeliveryVerificationNotice")}</span>
          <button
            className="imzenx-text-button"
            type="button"
            disabled={busy}
            onClick={() => void run("status")}
          >
            {i18n.t("panels:refreshStatus")}
          </button>
        </div>
      </section>
      {nativeApi ? (
        <>
          <OwnImSetup
            api={nativeApi}
            disabled={operation !== null}
            onBusy={(value) => {
              nativeBusyRef.current = value;
              setNativeBusy(value);
            }}
            onDirty={(value) => {
              setNativeDirty(value);
              if (value) {
                setReadiness(null);
                setConnectOpen(false);
                setSingleConsumerConfirmed(false);
              }
            }}
            onApply={(value) => {
              setConfig({
                ...configRef.current,
                channelsConfigFile: value.configurationFile,
                ...(value.runtime.prepared
                  ? { pythonExecutable: value.runtime.pythonExecutable }
                  : {}),
              });
              const request = ++statusVersion.current;
              void sdkRef.current.commands
                .execute("status")
                .then((result) => {
                  if (mounted.current && request === statusVersion.current)
                    setStatus(result as Status);
                })
                .catch(() => {
                  /* The saved native view remains available; explicit refresh can retry. */
                });
            }}
          />
          <section
            className="imzenx-connection imzenx-routing"
            aria-label={i18n.t("panels:imChooseWorkingDirectory")}
          >
            <h3>{i18n.t("panels:imWorkingDirectory")}</h3>
            <p className="imzenx-hint">
              {i18n.t("panels:imWorkspaceDescription")}
            </p>
            <div className="imzenx-workspace-choice">
              <span title={config.cwd}>
                {config.cwd || i18n.t("panels:imNotSelected")}
              </span>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => setPickingWorkspace(true)}
              >
                {i18n.t("panels:imChooseWorkingDirectory")}
              </button>
            </div>
          </section>
          {pickingWorkspace ? (
            <DirectoryPicker
              onCancel={() => setPickingWorkspace(false)}
              onSelect={(cwd) => {
                setPickingWorkspace(false);
                setConfig({ ...configRef.current, cwd });
              }}
            />
          ) : null}
        </>
      ) : null}
      <details
        className="imzenx-settings"
        open={settingsOpen}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          settingsRevision.current++;
          setSettingsOpen(open);
          const current = drafts?.current[sdk.pluginId];
          if (current) current.settingsOpen = open;
        }}
      >
        <summary>
          <Icon name="settings" size={18} />
          <span>
            {i18n.t("panels:imConnectionConfiguration")}
            <small>
              {dirty
                ? i18n.t("panels:imUnsavedChanges")
                : status?.configuration
                  ? i18n.t("panels:imPreparationConfigurationSaved")
                  : i18n.t("panels:imChooseRuntimeAndChannelFile")}
            </small>
          </span>
          <Icon name="chevron-down" className="imzenx-disclosure" />
        </summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (pathsComplete) void run("prepare");
          }}
        >
          <fieldset className="imzenx-fields">
            <div className="imzenx-form-grid">
              {(
                [
                  ["pythonExecutable", i18n.t("panels:pythonExecutable")],
                  [
                    "channelsConfigFile",
                    i18n.t("panels:imPrivateChannelConfigurationFile"),
                  ],
                  ["cwd", i18n.t("panels:imWorkingDirectory")],
                ] as const
              ).map(([key, label]) => (
                <label className="field" key={key}>
                  <span>{label}</span>
                  <input
                    required
                    value={config[key]}
                    onChange={(event) =>
                      setConfig({ ...config, [key]: event.target.value })
                    }
                  />
                </label>
              ))}
            </div>
            <p className="imzenx-hint">
              {i18n.t("panels:imPrivatePathNotice")}
            </p>
            <details>
              <summary>{i18n.t("panels:advancedSettings")}</summary>
              <div className="imzenx-form-grid">
                <label className="field">
                  <span>{i18n.t("panels:sharedImageDirectoryOptional")}</span>
                  <input
                    value={config.sharedFilesystemRoot}
                    onChange={(event) =>
                      setConfig({
                        ...config,
                        sharedFilesystemRoot: event.target.value,
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>{i18n.t("panels:newConversationPermissions")}</span>
                  <Select
                    value={config.permissionMode}
                    onValueChange={(value) =>
                      setConfig({
                        ...config,
                        permissionMode:
                          value as Configuration["permissionMode"],
                      })
                    }
                  >
                    <option value="full-access">
                      {i18n.t("panels:fullAccess")}
                    </option>
                    <option value="approval-required">
                      {i18n.t("panels:requireApprovalBeforeExecution")}
                    </option>
                  </Select>
                </label>
                <label className="imzenx-checkbox">
                  <input
                    type="checkbox"
                    checked={config.allowUnrestrictedFullAccess}
                    onChange={(event) =>
                      setConfig({
                        ...config,
                        allowUnrestrictedFullAccess: event.target.checked,
                      })
                    }
                  />
                  <span>
                    {i18n.t(
                      "panels:allowChannelsWithoutAUserConversationAllowlist",
                    )}
                  </span>
                </label>
              </div>
            </details>
            <div className="imzenx-save">
              <span>{i18n.t("panels:imPreparationDoesNotConnect")}</span>
              <button
                className="primary-button"
                type="submit"
                disabled={busy || !pathsComplete}
              >
                {operation === "prepare"
                  ? i18n.t("panels:saving")
                  : i18n.t("panels:imSavePreparation")}
              </button>
            </div>
          </fieldset>
        </form>
      </details>
      <section
        className="imzenx-connection imzenx-routing imzenx-readiness"
        aria-label={i18n.t("panels:imConnectionReadiness")}
      >
        <h3>{i18n.t("panels:imConnectionReadiness")}</h3>
        <p className="imzenx-hint">
          {nativeApi
            ? i18n.t("panels:imNativePreparationSteps")
            : i18n.t("panels:imManualPreparationSteps")}
        </p>
        {currentReadiness ? (
          <>
            <p role="status">
              {currentReadiness.ready
                ? i18n.t("panels:imReadinessPassed")
                : i18n.t("panels:imReadinessIncomplete")}
            </p>
            {currentReadiness.enabledChannels.length ? (
              <p className="imzenx-hint">
                {i18n.t("panels:imEnabledChannels", {
                  channels: currentReadiness.enabledChannels.join(", "),
                })}
              </p>
            ) : null}
            <ul className="imzenx-checks">
              {currentReadiness.checks.map((check) => (
                <li key={check.id} data-status={check.status}>
                  <span className="imzenx-check-status">
                    {check.status === "ready"
                      ? i18n.t("panels:imCheckReady")
                      : check.status === "blocked"
                        ? i18n.t("panels:imCheckBlocked")
                        : i18n.t("panels:imCheckWarning")}
                  </span>
                  <div>
                    <p>{check.message}</p>
                    {check.action ? (
                      <p className="imzenx-check-action">{check.action}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="imzenx-hint">
            {pathsComplete
              ? i18n.t("panels:imReadinessDoesNotConnect")
              : nativeApi
                ? i18n.t("panels:imPrepareNativeBeforeReadiness")
                : i18n.t("panels:imFillPathsBeforeReadiness")}
          </p>
        )}
        {notice ? (
          <p className="imzenx-notice" role="status">
            {i18n.t(`panels:${notice}`)}
          </p>
        ) : null}
        {currentReadiness?.ready && !saved ? (
          <p className="imzenx-hint">
            {i18n.t("panels:imSavePreparationBeforeConnect")}
          </p>
        ) : null}
        {nativeDirty ? (
          <p className="imzenx-hint">
            {i18n.t("panels:imSaveChannelBeforeReadiness")}
          </p>
        ) : null}
        <div className="imzenx-actions">
          {nativeApi ? (
            <button
              className="secondary-button"
              type="button"
              disabled={busy || !pathsComplete || nativeDirty}
              onClick={() => void run("prepare")}
            >
              {i18n.t("panels:imSavePreparation")}
            </button>
          ) : null}
          <button
            className="secondary-button"
            type="button"
            disabled={busy || !pathsComplete || nativeDirty}
            onClick={() => void run("readiness")}
          >
            {operation === "readiness"
              ? i18n.t("panels:imCheckingReadiness")
              : i18n.t("panels:imCheckReadiness")}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy || !canConnect}
            onClick={() => {
              if (busyRef.current || !canConnect) return;
              setSingleConsumerConfirmed(false);
              setConnectOpen(true);
            }}
          >
            {operation === "connect"
              ? i18n.t("panels:imConnecting")
              : i18n.t("panels:imConfirmConnection")}
          </button>
        </div>
        <p className="imzenx-hint">{i18n.t("panels:imVerifyActualDelivery")}</p>
      </section>
      <Dialog
        open={connectOpen}
        onOpenChange={(open) => {
          setConnectOpen(open);
          if (!open) setSingleConsumerConfirmed(false);
        }}
        title={i18n.t("panels:imSingleConsumerTitle")}
        className="imzenx-connect-dialog"
      >
        <h3>{i18n.t("panels:imSingleConsumerTitle")}</h3>
        <p>{i18n.t("panels:imSingleConsumerInstruction")}</p>
        <p className="imzenx-hint">{config.channelsConfigFile}</p>
        <label className="imzenx-checkbox">
          <input
            type="checkbox"
            checked={singleConsumerConfirmed}
            onChange={(event) =>
              setSingleConsumerConfirmed(event.target.checked)
            }
          />
          <span>{i18n.t("panels:imSingleConsumerConfirmation")}</span>
        </label>
        <p className="imzenx-hint">
          {i18n.t("panels:imSingleConsumerVerificationLimit")}
        </p>
        <div className="imzenx-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              setConnectOpen(false);
              setSingleConsumerConfirmed(false);
            }}
          >
            {i18n.t("panels:cancel")}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy || !singleConsumerConfirmed || !canConnect}
            onClick={() => {
              if (busyRef.current || !singleConsumerConfirmed || !canConnect)
                return;
              setConnectOpen(false);
              setSingleConsumerConfirmed(false);
              void run("connect");
            }}
          >
            {i18n.t("panels:imConnectButton")}
          </button>
        </div>
      </Dialog>
      <section
        className="imzenx-connection imzenx-routing"
        aria-label={i18n.t("panels:chooseAConversationMode")}
      >
        <h3>{i18n.t("panels:chooseAConversationMode")}</h3>
        <p className="imzenx-hint">{i18n.t("panels:imPawInstructions")}</p>
        <p className="imzenx-hint">{i18n.t("panels:imThreadInstructions")}</p>
      </section>
      <section className="imzenx-guide" aria-labelledby="imzenx-guide-title">
        <div className="imzenx-section-heading">
          <h3 id="imzenx-guide-title">{i18n.t("panels:getStartedInIm")}</h3>
          <span>{i18n.t("panels:sendInTheBotChat")}</span>
        </div>
        <div className="imzenx-quickstart">
          <Icon name="compose" size={18} />
          <p>
            {i18n.t("panels:firstChooseAPawRoomOrWork")}
            <span>
              {i18n.t("panels:withoutASelectionSendingAMessageCreates")}
            </span>
          </p>
        </div>
        <dl className="imzenx-commands">
          <div>
            <dt>
              <code>/paws</code>
            </dt>
            <dd>{i18n.t("panels:listPawsInTheWorkingDirectory")}</dd>
          </div>
          <div>
            <dt>
              <code>
                /paw <span>{i18n.t("panels:listNumberOrId")}</span>
              </code>
            </dt>
            <dd>{i18n.t("panels:chooseAPawRoomOmitTheArgument")}</dd>
          </div>
          <div>
            <dt>
              <code>/threads</code>
            </dt>
            <dd>{i18n.t("panels:listConversations")}</dd>
          </div>
          <div>
            <dt>
              <code>
                /pick <span>{i18n.t("panels:listNumber")}</span>
              </code>
            </dt>
            <dd>{i18n.t("panels:chooseAConversationAndReceiveReplies")}</dd>
          </div>
          <div>
            <dt>
              <code>/new</code>
            </dt>
            <dd>{i18n.t("panels:clearTheSelectionTheNextMessageCreates")}</dd>
          </div>
        </dl>
      </section>
      <footer className="imzenx-footer">
        <Icon name="imzenx" />
        <span>
          {i18n.t("panels:closingTheWindowKeepsTheConnectionQuitting")}
        </span>
      </footer>
    </div>
  );
}
