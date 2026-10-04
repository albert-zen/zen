import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
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
const stateKeys: Record<string, string> = {
  unconfigured: "notConfigured",
  "waiting-for-activation": "waitingForPluginActivation",
  "waiting-for-zas": "waitingForZenxAgentService",
  starting: "connecting",
  connected: "connected",
  failed: "connectionFailed",
  stopped: "stopped",
};
export function registerImZenXUi(registry: PluginUiRegistry): () => void {
  return registry.registerTrusted("zenx/bundled/imzenx-ui", {
    connection: ImZenXPage,
  });
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
  const [notice, setNotice] = useState(false);
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
    setNotice(false);
    const savedRevision = revision.current;
    try {
      setStatus(
        (await sdk.commands.execute(
          command,
          command === "configure" ? config : undefined,
        )) as Status,
      );
      if (command === "configure") {
        setNotice(true);
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
          <h2>{i18n.t("panels:imConnection")}</h2>
          <p>{i18n.t("panels:contactPawInImOrContinueA")}</p>
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
            {error ?? status?.error}
          </p>
        ) : null}
        <div className="imzenx-connection-bottom">
          <span>
            {i18n.t("panels:pawChatsAndWorkConversationsStaySeparate")}
          </span>
          <div className="imzenx-actions">
            <button
              className="imzenx-text-button"
              type="button"
              disabled={busy}
              onClick={() => void run("status")}
            >
              {i18n.t("panels:refreshStatus")}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={busy || !status?.configuration}
              onClick={() => void run("connect")}
            >
              {busy ? i18n.t("panels:processing") : i18n.t("panels:reconnect")}
            </button>
          </div>
        </div>
      </section>
      <section
        className="imzenx-connection imzenx-routing"
        aria-label={i18n.t("panels:chooseAConversationMode")}
      >
        <h3>{i18n.t("panels:chooseAConversationMode")}</h3>
        <p className="imzenx-hint">{i18n.t("panels:imPawInstructions")}</p>
        <p className="imzenx-hint">{i18n.t("panels:imThreadInstructions")}</p>
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
            {i18n.t("panels:connectionSettings")}
            <small>
              {status?.configuration
                ? i18n.t("panels:configuredYouCanChangeItAnytime")
                : i18n.t("panels:setUpTheRuntimeAndChannels")}
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
                  ["pythonExecutable", i18n.t("panels:pythonExecutable")],
                  [
                    "channelsConfigFile",
                    i18n.t("panels:channelConfigurationFile"),
                  ],
                  ["cwd", i18n.t("panels:workingDirectoryAndPawVisibility")],
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
              {i18n.t("panels:useAbsolutePathsChannelsUseTheImzen")}
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
                        permissionMode: value,
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
                  {i18n.t(
                    "panels:allowChannelsWithoutAUserConversationAllowlist",
                  )}
                </label>
              </div>
            </details>
            {notice ? (
              <p className="imzenx-notice" role="status">
                {i18n.t("panels:configurationSaved")}
              </p>
            ) : null}
            <div className="imzenx-save">
              <span>{i18n.t("panels:savingReconnectsTheChannels")}</span>
              <button className="primary-button" type="submit">
                {busy
                  ? i18n.t("panels:saving")
                  : i18n.t("panels:saveAndConnect")}
              </button>
            </div>
          </fieldset>
        </form>
      </details>
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
