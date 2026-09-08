import { useEffect, useRef, useState } from "react";
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
  const [config, setConfig] = useState(empty);
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void sdkRef.current.commands
      .execute("status")
      .then((value) => {
        if (!active) return;
        const result = value as Status;
        setStatus(result);
        setConfig({ ...empty, ...result.configuration });
        setSettingsOpen(!result.configuration);
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
    try {
      setStatus(
        (await sdk.commands.execute(
          command,
          command === "configure" ? config : undefined,
        )) as Status,
      );
      if (command === "configure") setNotice("配置已保存");
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
          <p>在 IM 和桌面之间，继续同一个会话。</p>
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
          <span>消息与回复双端同步 · 订阅自动保留</span>
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
      <details
        className="imzenx-settings"
        open={settingsOpen}
        onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
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
                  ["cwd", "新会话工作目录"],
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
                  <select
                    value={config.permissionMode}
                    onChange={(event) =>
                      setConfig({
                        ...config,
                        permissionMode: event.target.value,
                      })
                    }
                  >
                    <option value="full-access">Full access</option>
                    <option value="approval-required">执行前审批</option>
                  </select>
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
            直接发消息，即可新建会话。
            <span>已有会话？先查看列表，再订阅。</span>
          </p>
        </div>
        <dl className="imzenx-commands">
          <div>
            <dt>
              <code>/threads</code>
            </dt>
            <dd>查看会话列表</dd>
          </div>
          <div>
            <dt>
              <code>
                /subscribe <span>编号或 ID</span>
              </code>
            </dt>
            <dd>关联会话，双端接着聊</dd>
          </div>
          <div>
            <dt>
              <code>/unsubscribe</code>
            </dt>
            <dd>取消当前订阅</dd>
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
