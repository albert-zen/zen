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
const states: Record<string, string> = {
  unconfigured: "尚未配置",
  prepared: "准备已保存，等待连接",
  "waiting-for-activation": "等待插件启动",
  "waiting-for-zas": "等待 ZenX Agent 服务",
  starting: "正在连接",
  connected: "本机连接进程运行中",
  failed: "连接失败",
  stopped: "已停止",
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
  const [snapshot, setSnapshot] = useState<OwnImSnapshot | null>(null);
  const [channelId, setChannelId] = useState("");
  const [values, setValues] = useState<OwnImChannel["values"]>({});
  const [secretOperations, setSecretOperations] = useState<
    Record<string, "keep" | "replace" | "clear">
  >({});
  const [busy, setBusy] = useState<string | null>("inspect");
  const busyRef = useRef(true);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        if (mounted.current) setError("无法读取本机 IM 设置，请重试");
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
          setNotice("运行环境已准备。保存频道后再检查连接准备情况。");
        } else
          setError(
            result.runtime.error ??
              "运行环境未准备完成，请检查可信项目与私有仓库访问后重试",
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
        setNotice("频道设置已安全保存，连接尚未启动");
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
            ? "频道设置未保存。检查本机安全存储与必填项后重试；新凭证需要重新输入。"
            : action === "runtime"
              ? "运行环境未准备完成。检查可信项目与私有仓库访问后重试。"
              : "无法读取本机 IM 设置，请重试",
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
      aria-label="设置自己的 IM"
    >
      <h3>设置自己的 IM</h3>
      <p className="imzenx-hint">
        凭证由这个本机表单直接交给系统安全存储，不进入 Agent 工具或聊天。
      </p>
      {error ? (
        <p className="imzenx-error" role="alert">
          {error}
        </p>
      ) : null}
      {snapshot ? (
        <>
          <div className="imzenx-runtime-setup">
            <span role="status">
              {snapshot.runtime.prepared
                ? "运行环境已准备"
                : snapshot.runtime.preparing || busy === "runtime"
                  ? "正在准备运行环境…"
                  : "需要准备运行环境"}
            </span>
            <button
              className="secondary-button"
              type="button"
              disabled={disabled || busy !== null || snapshot.runtime.preparing}
              onClick={() => void run("runtime")}
            >
              {busy === "runtime" ? "准备中…" : "准备运行环境"}
            </button>
          </div>
          <p className="imzenx-hint">
            此操作会从可信的 IMZen
            项目安装锁定依赖，需要当前用户已有的私有仓库访问权限。
          </p>
          <p className="imzenx-hint">
            {snapshot.runtime.source}{" "}
            <a
              href="https://docs.astral.sh/uv/getting-started/installation/"
              target="_blank"
              rel="noreferrer"
            >
              uv 官方安装说明
            </a>
          </p>
          {!snapshot.encryptionAvailable ? (
            <p role="alert" className="imzenx-storage-warning">
              系统安全存储不可用，无法保存频道凭证。恢复安全存储后重新读取设置。
            </p>
          ) : null}
          <label className="field">
            <span>IM 渠道</span>
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
                  {entry.label}
                  {!entry.supported ? "（当前 SDK 不支持表单）" : ""}
                </option>
              ))}
            </Select>
          </label>
          {snapshot.channels
            .filter((entry) => !entry.supported && entry.prerequisite)
            .map((entry) => (
              <p key={entry.id} className="imzenx-hint">
                {entry.label}：{entry.prerequisite}
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
                                ? "保存后清除"
                                : channel.secretConfigured[field.key]
                                  ? "已安全保存"
                                  : "尚未设置"}
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
                            更换 {field.label}
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
                            清除 {field.label}
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
                    取消修改
                  </button>
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={!snapshot.encryptionAvailable || !dirty}
                  >
                    保存频道
                  </button>
                </div>
              </fieldset>
            </form>
          ) : (
            <p className="imzenx-hint">
              准备运行环境后读取 SDK
              声明的字段；未声明字段的渠道不能在此表单配置。
            </p>
          )}
        </>
      ) : (
        <p role="status">
          {busy === "inspect"
            ? "正在读取本机 IM 设置…"
            : "本机 IM 设置暂不可用"}
        </p>
      )}
      {notice ? (
        <p className="imzenx-notice" role="status">
          {notice}
        </p>
      ) : null}
      <button
        type="button"
        className="imzenx-text-button"
        disabled={disabled || busy !== null}
        onClick={() => void run("inspect")}
      >
        重新读取设置
      </button>
    </section>
  );
}
export function ImZenXPage({ sdk }: PluginUiSurfaceProps) {
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
    setNotice("配置已修改，请重新检查准备情况");
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
        else setNotice("配置已修改，请重新检查准备情况");
      } else {
        if (request === statusVersion.current) setStatus(value as Status);
        if (command === "prepare") {
          setReadiness(null);
          setConnectOpen(false);
          setSingleConsumerConfirmed(false);
          setNotice("准备已保存。完成本机私有凭证设置后，检查并明确连接。");
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
          <h2>IM 连接</h2>
          <p>选择本机运行环境、工作目录与自己的私有频道配置。</p>
        </div>
      </header>
      <section className="imzenx-connection" aria-label="连接概览">
        <div className="imzenx-connection-top">
          <div className="imzenx-endpoint">
            <Icon name="terminal" size={20} />
            <div>
              <h3>本机 ZenX Agent</h3>
              <p>使用当前 ZenX 的会话服务</p>
            </div>
          </div>
          <span
            className="imzenx-status"
            data-state={status?.state}
            role="status"
          >
            <span aria-hidden="true" />
            {status ? (states[status.state] ?? status.state) : "正在读取…"}
          </span>
        </div>
        {error || status?.error ? (
          <p className="imzenx-error" role="alert">
            {error ?? status?.error}
          </p>
        ) : null}
        {pendingConnection ? (
          <p className="imzenx-active-note">
            当前连接仍使用此前的运行配置。新保存的准备配置或频道设置会在明确连接后使用。
          </p>
        ) : null}
        <div className="imzenx-connection-bottom">
          <span>本机进程状态不能证明 QQ 等渠道已完成真实消息投递</span>
          <button
            className="imzenx-text-button"
            type="button"
            disabled={busy}
            onClick={() => void run("status")}
          >
            刷新状态
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
            aria-label="选择工作目录"
          >
            <h3>工作目录</h3>
            <p className="imzenx-hint">
              IM 中的新会话与 PAW 列表使用这个目录。
            </p>
            <div className="imzenx-workspace-choice">
              <span title={config.cwd}>{config.cwd || "尚未选择"}</span>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => setPickingWorkspace(true)}
              >
                选择工作目录
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
            连接配置
            <small>
              {dirty
                ? "有未保存的修改"
                : status?.configuration
                  ? "准备配置已保存"
                  : "选择运行环境与频道文件"}
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
                  ["pythonExecutable", "Python 可执行文件"],
                  ["channelsConfigFile", "自己的私有频道配置文件"],
                  ["cwd", "工作目录"],
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
              使用绝对路径和自己的 IMZen
              格式配置。这里只填写路径；凭证值在本机私有文件中设置。
            </p>
            <details>
              <summary>高级设置</summary>
              <div className="imzenx-form-grid">
                <label className="field">
                  <span>图片共享目录（可选）</span>
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
                  <span>新会话执行权限</span>
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
                    <option value="full-access">Full access</option>
                    <option value="approval-required">执行前审批</option>
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
                  <span>允许未配置用户／会话白名单的频道使用 Full access</span>
                </label>
              </div>
            </details>
            <div className="imzenx-save">
              <span>保存准备不会启动或重启连接</span>
              <button
                className="primary-button"
                type="submit"
                disabled={busy || !pathsComplete}
              >
                {operation === "prepare" ? "保存中…" : "保存准备"}
              </button>
            </div>
          </fieldset>
        </form>
      </details>
      <section
        className="imzenx-connection imzenx-routing imzenx-readiness"
        aria-label="连接前准备"
      >
        <h3>连接前准备</h3>
        <p className="imzenx-hint">
          {nativeApi
            ? "保存频道并选择工作目录后，保存准备、检查，再明确确认连接。"
            : "检查所选路径，保存准备，再在本机完成私有凭证设置。缺少 SDK 时，按检查结果从可信的 IMZen 项目准备环境，再重新检查。"}
        </p>
        {currentReadiness ? (
          <>
            <p role="status">
              {currentReadiness.ready
                ? "本机准备检查通过，可以确认连接"
                : "还有准备步骤需要完成"}
            </p>
            {currentReadiness.enabledChannels.length ? (
              <p className="imzenx-hint">
                启用的渠道：{currentReadiness.enabledChannels.join("、")}
              </p>
            ) : null}
            <ul className="imzenx-checks">
              {currentReadiness.checks.map((check) => (
                <li key={check.id} data-status={check.status}>
                  <span className="imzenx-check-status">
                    {check.status === "ready"
                      ? "就绪"
                      : check.status === "blocked"
                        ? "需处理"
                        : "注意"}
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
              ? "检查只读取明确选择的配置，不启动渠道连接"
              : nativeApi
                ? "先准备运行环境、保存自己的频道，并选择工作目录"
                : "先展开连接配置，填写运行环境、工作目录与私有频道文件路径"}
          </p>
        )}
        {notice ? (
          <p className="imzenx-notice" role="status">
            {notice}
          </p>
        ) : null}
        {currentReadiness?.ready && !saved ? (
          <p className="imzenx-hint">先保存当前准备配置，再确认连接</p>
        ) : null}
        {nativeDirty ? (
          <p className="imzenx-hint">
            先保存或取消频道表单中的修改，再检查连接准备情况
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
              保存准备
            </button>
          ) : null}
          <button
            className="secondary-button"
            type="button"
            disabled={busy || !pathsComplete || nativeDirty}
            onClick={() => void run("readiness")}
          >
            {operation === "readiness" ? "检查中…" : "检查准备情况"}
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
            {operation === "connect" ? "连接中…" : "确认连接…"}
          </button>
        </div>
        <p className="imzenx-hint">
          连接后，在机器人聊天中实际收发一条消息，确认渠道可用。
        </p>
      </section>
      <Dialog
        open={connectOpen}
        onOpenChange={(open) => {
          setConnectOpen(open);
          if (!open) setSingleConsumerConfirmed(false);
        }}
        title="确认唯一机器人连接"
        className="imzenx-connect-dialog"
      >
        <h3>确认唯一机器人连接</h3>
        <p>
          请只选择一个进程消费这个机器人的消息。连接前，停止其他使用同一机器人账号的进程。
        </p>
        <p className="imzenx-hint">{config.channelsConfigFile}</p>
        <label className="imzenx-checkbox">
          <input
            type="checkbox"
            checked={singleConsumerConfirmed}
            onChange={(event) =>
              setSingleConsumerConfirmed(event.target.checked)
            }
          />
          <span>
            我确认 ZenX 是这个机器人唯一选定的消费进程，其他机器人消费进程已停止
          </span>
        </label>
        <p className="imzenx-hint">
          这是你的确认；准备检查无法验证其他进程是否已停止。
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
            取消
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
            连接
          </button>
        </div>
      </Dialog>
      <section
        className="imzenx-connection imzenx-routing"
        aria-label="选择对话方式"
      >
        <h3>选择对话方式</h3>
        <p className="imzenx-hint">
          在 IM 中发送 /paws 查看这个工作目录下的 PAW，再用 /paw
          选择。你发的消息进入 PAW 聊天室，只接收它主动发到聊天室的回复。
        </p>
        <p className="imzenx-hint">
          /threads 和 /pick
          继续直接工作会话；这个模式会同步该线程的模型回复。/new 清除选择。PAW
          模式目前支持文字，平台原生已读、引用和表情取决于后续渠道适配。
        </p>
      </section>
      <section className="imzenx-guide" aria-labelledby="imzenx-guide-title">
        <div className="imzenx-section-heading">
          <h3 id="imzenx-guide-title">从 IM 开始</h3>
          <span>在机器人聊天中发送</span>
        </div>
        <div className="imzenx-quickstart">
          <Icon name="compose" size={18} />
          <p>
            先选择 PAW 聊天室或工作会话。
            <span>没有选择时，直接发消息会新建工作会话。</span>
          </p>
        </div>
        <dl className="imzenx-commands">
          <div>
            <dt>
              <code>/paws</code>
            </dt>
            <dd>查看工作目录下的 PAW</dd>
          </div>
          <div>
            <dt>
              <code>
                /paw <span>列表序号或 ID</span>
              </code>
            </dt>
            <dd>选择 PAW 聊天室；不带参数查看当前选择</dd>
          </div>
          <div>
            <dt>
              <code>/threads</code>
            </dt>
            <dd>查看会话列表</dd>
          </div>
          <div>
            <dt>
              <code>
                /pick <span>列表序号</span>
              </code>
            </dt>
            <dd>选择会话并接收回复</dd>
          </div>
          <div>
            <dt>
              <code>/new</code>
            </dt>
            <dd>清除选择，下条消息新建会话</dd>
          </div>
        </dl>
      </section>
      <footer className="imzenx-footer">
        <Icon name="imzenx" />
        <span>关闭窗口仍保持连接；退出 ZenX 或停用插件后断开。</span>
      </footer>
    </div>
  );
}
