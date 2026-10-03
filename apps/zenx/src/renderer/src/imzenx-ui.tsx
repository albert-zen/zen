import { Select } from "./ui/controls.js";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Icon } from "./icons.js";
import type {
  PluginUiRegistry,
  PluginUiSurfaceProps,
} from "./plugin-ui-host.js";

interface Configuration {
  pythonExecutable: string;
  channelsConfigFile: string;
  cwd: string;
  sharedFilesystemRoot: string;
  permissionMode: string;
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
  error?: string;
  configuration: Partial<Configuration> | null;
}
const empty: Configuration = {
  pythonExecutable: "",
  channelsConfigFile: "",
  cwd: "",
  sharedFilesystemRoot: "",
  permissionMode: "full-access",
  allowUnrestrictedFullAccess: false,
};
const states: Record<string, string> = {
  unconfigured: "尚未配置",
  "waiting-for-activation": "等待插件启动",
  "waiting-for-zas": "等待 ZenX Agent 服务",
  starting: "正在连接",
  connected: "已连接",
  failed: "连接失败",
  stopped: "已停止",
};
export function registerImZenXUi(registry: PluginUiRegistry): () => void {
  return registry.registerTrusted("zenx/bundled/imzenx-ui", {
    connection: ImZenXPage,
  });
}
export function ImZenXPage({ sdk }: PluginUiSurfaceProps) {
  const sdkRef = useRef(sdk);
  useEffect(() => {
    sdkRef.current = sdk;
  }, [sdk]);
  const drafts = useContext(ImZenXDraftContext);
  const draft = drafts?.current[sdk.pluginId];
  const [config, setConfigState] = useState(draft?.config ?? empty);
  const revision = useRef(draft?.revision ?? 0);
  const setConfig = (value: Configuration) => {
    revision.current++;
    setConfigState(value);
    if (drafts)
      drafts.current[sdk.pluginId] = {
        config: value,
        revision: revision.current,
        dirty: true,
        settingsOpen: true,
      };
  };
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(
    draft?.settingsOpen ?? false,
  );
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const loadedRevision = revision.current;
    void sdkRef.current.commands
      .execute("status")
      .then((value) => {
        if (!active) return;
        const result = value as Status;
        setStatus(result);
        if (
          revision.current === loadedRevision &&
          !drafts?.current[sdk.pluginId]?.dirty
        ) {
          const loaded = { ...empty, ...result.configuration };
          setConfigState(loaded);
          if (drafts)
            drafts.current[sdk.pluginId] = {
              config: loaded,
              revision: loadedRevision,
              dirty: false,
              settingsOpen:
                drafts.current[sdk.pluginId]?.settingsOpen ??
                !result.configuration,
            };
        }
        setSettingsOpen(
          drafts?.current[sdk.pluginId]?.settingsOpen ?? !result.configuration,
        );
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [sdk.pluginId]);
  useEffect(() => {
    if (busy) return;
    let active = true;
    const timer = setInterval(() => {
      void sdkRef.current.commands
        .execute("status")
        .then((value) => {
          if (active) setStatus(value as Status);
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
  const run = async (command: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const savedRevision = revision.current;
    try {
      setStatus(
        (await sdk.commands.execute(
          command,
          command === "configure" ? config : undefined,
        )) as Status,
      );
      if (command === "configure") {
        setNotice("配置已保存");
        const current = drafts?.current[sdk.pluginId];
        if (current && current.revision === savedRevision)
          current.dirty = false;
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      try {
        setStatus((await sdk.commands.execute("status")) as Status);
      } catch {
        /* Keep the original action error visible. */
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="imzenx-page">
      <header className="imzenx-heading">
        <span className="imzenx-mark">
          <Icon name="imzenx" size={24} />
        </span>
        <div>
          <h2>IM 连接</h2>
          <p>在 IM 中联系 PAW，或继续桌面工作会话。</p>
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
        <div className="imzenx-connection-bottom">
          <span>PAW 聊天与工作会话分开 · 选择自动保留</span>
          <div className="imzenx-actions">
            <button
              className="imzenx-text-button"
              type="button"
              disabled={busy}
              onClick={() => void run("status")}
            >
              刷新状态
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={busy || !status?.configuration}
              onClick={() => void run("connect")}
            >
              {busy ? "处理中…" : "重新连接"}
            </button>
          </div>
        </div>
      </section>
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
      <details
        className="imzenx-settings"
        open={settingsOpen}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setSettingsOpen(open);
          const current = drafts?.current[sdk.pluginId];
          if (current) current.settingsOpen = open;
        }}
      >
        <summary>
          <Icon name="settings" size={18} />
          <span>
            连接设置
            <small>
              {status?.configuration
                ? "已配置，可随时修改"
                : "设置运行环境与频道"}
            </small>
          </span>
          <Icon name="chevron-down" className="imzenx-disclosure" />
        </summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run("configure");
          }}
        >
          <fieldset disabled={busy} className="imzenx-fields">
            <div className="imzenx-form-grid">
              {(
                [
                  ["pythonExecutable", "Python 可执行文件"],
                  ["channelsConfigFile", "频道配置文件"],
                  ["cwd", "工作目录与 PAW 可见范围"],
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
              使用绝对路径。频道沿用 IMZen 配置，凭证保存在本机私有文件中。
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
                        permissionMode: value,
                      })
                    }
                  >
                    <option value="full-access">Full access</option>
                    <option value="approval-required">执行前审批</option>
                  </Select>
                </label>
                <label>
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
                  允许未配置用户／会话白名单的频道使用 Full access
                </label>
              </div>
            </details>
            {notice ? (
              <p className="imzenx-notice" role="status">
                {notice}
              </p>
            ) : null}
            <div className="imzenx-save">
              <span>保存后将重新连接频道</span>
              <button className="primary-button" type="submit">
                {busy ? "保存中…" : "保存并连接"}
              </button>
            </div>
          </fieldset>
        </form>
      </details>
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
