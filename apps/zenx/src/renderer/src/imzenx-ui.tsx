import { useEffect, useState } from "react";
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
  const [config, setConfig] = useState(empty);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void sdk.commands
      .execute("status")
      .then((value) => {
        if (!active) return;
        const result = value as Status;
        setStatus(result);
        setConfig({ ...empty, ...result.configuration });
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
  }, [sdk]);
  const run = async (command: string) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(
        (await sdk.commands.execute(
          command,
          command === "configure" ? config : undefined,
        )) as Status,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page-scroll imzenx-page">
      <div className="page-intro">
        <div>
          <h2>同一个 Agent，随时从 IM 接着聊。</h2>
          <p>
            订阅 ZenX 会话后，桌面发起的回复也会送达 IM。IM
            发出的消息和后续回复会出现在同一桌面会话中。
          </p>
        </div>
      </div>
      <div className="page-card">
        <h2>IMZenX</h2>
        <p role="status">
          {status ? (states[status.state] ?? status.state) : "正在读取状态…"}
        </p>
        {error || status?.error ? (
          <p role="alert">{error ?? status?.error}</p>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run("configure");
          }}
        >
          <fieldset disabled={busy} className="imzenx-fields">
            <div className="form-grid">
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
            <p>
              填写绝对路径。Python 需要安装 IMZen 固定版本的 IM Agent
              SDK；频道配置沿用 IMZen 格式，凭证保存在私有文件中。
            </p>
            <details>
              <summary>高级设置</summary>
              <div className="form-grid">
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
            <div
              className="page-actions"
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                marginTop: 16,
              }}
            >
              <button className="primary-button" type="submit">
                {busy ? "处理中…" : "保存并连接"}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void run("connect")}
              >
                重新连接
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void run("status")}
              >
                刷新状态
              </button>
            </div>
          </fieldset>
        </form>
      </div>
      <div className="page-card">
        <h2>在 IM 中订阅</h2>
        <ol>
          <li>
            发送 <code>/threads</code> 查看 ZenX 会话。
          </li>
          <li>
            发送 <code>/subscribe 会话编号或ID</code>，此后在 IM
            和桌面都可以继续该会话。
          </li>
          <li>
            发送 <code>/unsubscribe</code>{" "}
            停止当前订阅；下一条普通消息会新建会话。
          </li>
        </ol>
        <p>
          每个 IM 会话选择一个 Thread；多个频道可以订阅同一个
          Thread。订阅会在插件重启后保留。关闭窗口继续运行，退出 ZenX
          或停用插件会断开 IM。
        </p>
      </div>
    </div>
  );
}
