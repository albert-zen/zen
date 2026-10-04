import { i18n } from "./i18n.js";
import { useTranslation } from "react-i18next";
import { SkillsSettingsPanel } from "./SkillsSettingsPanel.js";
import { Select, Combobox } from "./ui/controls.js";
import { SubscriptionUsageCard } from "./SubscriptionUsageCard.js";
import { RtkSettingsCard } from "./RtkSettingsCard.js";
import {
  Activity,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
} from "react";
import { normalizeContextCompactionConfig } from "../../../../../src/context-compaction.js";
import { ContextCompactionPanel } from "./ContextCompactionPanel.js";
import { WorkflowSettingsPanel } from "./WorkflowSettingsPanel.js";
import {
  normalizeTitlePrompt,
  normalizeWorkflowCommands,
} from "../../main/workflow-configuration.js";

import { builtInModelCatalogPreset } from "../../../../cli/src/model-presets.js";
import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type {
  PublicHostSettings,
  ZenXHostProfile,
  ZenXModelCatalogEntry,
  ZenXModelReference,
  ZenXProviderDeleteReplacements,
  ZenXProviderEditOptions,
  ZenXProviderProfile,
} from "../../main/host-profile.js";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import {
  KNOWN_PROVIDER_PRESETS,
  type ZenXKnownProviderPreset,
} from "../../main/provider-presets.js";
import {
  APPEARANCE_ACCENTS,
  APPEARANCE_CONTRASTS,
  APPEARANCE_MODES,
  APPEARANCE_PRESETS,
  DEFAULT_APPEARANCE_PREFERENCE,
  getAppearanceController,
  type AppearanceAccent,
  type AppearanceContrast,
  type AppearanceMode,
  type AppearancePreference,
  type AppearancePreset,
} from "./appearance.js";
import { PluginSettings } from "./PluginSettings.js";
import { Icon, type IconName } from "./icons.js";
import { ProviderLogo, providerLogoKindForIdentity } from "./ProviderLogo.js";
import { threadModelIdentity, threadTitle } from "./thread-list.js";
import { PluginSettingsSurfaces } from "./PluginProductPage.js";
import { ChromeConnectionSettings } from "./ChromeConnectionSettings.js";
import { FleetSettings } from "./FleetSettings.js";
import { LanguageSettings } from "./LanguageSettings.js";

export type SettingsTab =
  | "account"
  | "models"
  | "plugins"
  | "appearance"
  | "general"
  | "compaction"
  | "skills"
  | "workflows"
  | "fleet"
  | "archived";

// Match the Host profile limit before allowing either model-add path.
const MAX_MODELS_PER_PROVIDER = 1_024;

export function SettingsView({
  archivedError,
  archivedLoading,
  archivedThreads,
  onOpenSidebar,
  onRetryArchived,
  onTabChange,
  onUnarchive,
  showHeader = true,
  tab,
  pluginSnapshot = null,
  active = true,
  browserSettingsFocusRequest = 0,
}: {
  archivedError: string | null;
  archivedLoading: boolean;
  archivedThreads: readonly NativeThreadSummary[];
  onOpenSidebar?(): void;
  onRetryArchived(): void;
  onTabChange(tab: SettingsTab): void;
  onUnarchive(thread: NativeThreadSummary): Promise<void>;
  showHeader?: boolean;
  tab: SettingsTab;
  pluginSnapshot?: ZenXPluginSnapshot | null;
  active?: boolean;
  browserSettingsFocusRequest?: number;
}) {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<PublicHostSettings | null>(null);
  const [draft, setDraft] = useState<ZenXHostProfile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatusState] = useState<{ message: string } | null>(null);
  const feedbackScope = useRef({ tab, active, version: 0 });
  if (
    feedbackScope.current.tab !== tab ||
    feedbackScope.current.active !== active
  ) {
    feedbackScope.current = {
      tab,
      active,
      version: feedbackScope.current.version + 1,
    };
  }
  const feedbackVersion = feedbackScope.current.version;
  const setStatus = (message: string | null) => {
    if (feedbackScope.current.version !== feedbackVersion) return;
    setStatusState(message === null ? null : { message });
  };
  const [manualCode, setManualCode] = useState(false);
  const [localBrowserFocusRequest, setLocalBrowserFocusRequest] = useState(0);
  const handledBrowserFocusRequest = useRef("0:0");
  const [pluginsVisited, setPluginsVisited] = useState(
    active && tab === "plugins",
  );
  if (active && tab === "plugins" && !pluginsVisited) setPluginsVisited(true);
  const navRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [tab]);
  const draftSnapshot = useRef({ settings, draft });
  draftSnapshot.current = { settings, draft };

  useEffect(() => {
    if (!active) return;
    let subscribed = true;
    const dispose = window.zenx.settings.onManualCodeRequested(() => {
      if (subscribed) setManualCode(true);
    });
    const current = draftSnapshot.current;
    const hasUnsaved =
      current.settings !== null &&
      JSON.stringify(current.draft) !==
        JSON.stringify(current.settings.profile);
    if (hasUnsaved)
      return () => {
        subscribed = false;
        dispose();
      };
    void window.zenx.settings
      .get()
      .then((value) => {
        if (!subscribed) return;
        setSettings(value);
        setDraft((latest) =>
          latest === current.draft ? value.profile : latest,
        );
      })
      .catch(
        (reason: unknown) => subscribed && setError(describeError(reason)),
      );
    return () => {
      subscribed = false;
      dispose();
    };
  }, [active]);

  useEffect(() => {
    if (status === null) return;
    const timer = setTimeout(() => setStatusState(null), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  useEffect(() => setStatusState(null), [tab]);

  useEffect(() => {
    if (!active || tab !== "general" || settings === null || draft === null)
      return;
    const request = `${browserSettingsFocusRequest}:${localBrowserFocusRequest}`;
    if (handledBrowserFocusRequest.current === request) return;
    const section = document.getElementById("browser-settings");
    if (section === null) return;
    handledBrowserFocusRequest.current = request;
    section.scrollIntoView?.({ block: "start" });
    section.focus({ preventScroll: true });
  }, [
    active,
    tab,
    settings,
    draft,
    browserSettingsFocusRequest,
    localBrowserFocusRequest,
  ]);

  const save = async () => {
    if (draft === null) return;
    setBusy("save");
    setError(null);
    setStatus(null);
    try {
      normalizeContextCompactionConfig(draft.contextCompaction);
      normalizeWorkflowCommands(draft.workflowCommands);
      normalizeTitlePrompt(draft.titlePrompt);
      const value = await window.zenx.settings.save({
        baseRevision: draft.revision ?? 0,
        onboardingComplete: true,
        computerForegroundControlEnabled:
          draft.computerForegroundControlEnabled === true,
        browserMode: draft.browserMode ?? "isolated",
        providerProfiles: draft.providerProfiles,
        defaultModel: draft.defaultModel,
        titleModel: draft.titleModel,
        approvalPolicy: draft.approvalPolicy,
        toolPresentation: draft.toolPresentation ?? "both",
        experimentalRtkEnabled: draft.experimentalRtkEnabled === true,
        composerSendMode: draft.composerSendMode ?? "soft",
        composerSendModeExplicit: draft.composerSendModeExplicit,
        composerSendModeMigration: draft.composerSendModeMigration,
        maxToolRounds: draft.maxToolRounds,
        contextCompaction: draft.contextCompaction,
        workflowCommands: draft.workflowCommands ?? [],
        titlePrompt: draft.titlePrompt,
        resetTitlePrompt: draft.titlePrompt === undefined,
      });
      setSettings(value);
      setDraft((latest) =>
        latest === draft
          ? value.profile
          : latest === null
            ? value.profile
            : { ...latest, revision: value.profile.revision },
      );
      setStatus(
        draft.experimentalRtkEnabled !==
          settings?.profile.experimentalRtkEnabled
          ? null
          : configurationSaveToast(value),
      );
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  };

  if (draft === null || settings === null) {
    return (
      <section
        hidden={!active}
        inert={!active}
        className={`product-page settings-view${showHeader ? "" : " settings-view-embedded"}`}
      >
        <div className="page-loading">
          <div className="loading-ring" />
          <p>{error ?? t("settingsView.loadingLocalSettings")}</p>
        </div>
      </section>
    );
  }
  let compactionError: string | null = null;
  try {
    normalizeContextCompactionConfig(draft.contextCompaction);
  } catch (reason) {
    compactionError = describeError(reason);
  }
  let workflowError: string | null = null;
  try {
    normalizeWorkflowCommands(draft.workflowCommands);
    normalizeTitlePrompt(draft.titlePrompt);
  } catch (reason) {
    workflowError = describeError(reason);
  }
  const hostDirty = JSON.stringify(draft) !== JSON.stringify(settings.profile);
  const sendModeOnly =
    hostDirty &&
    JSON.stringify({
      ...draft,
      composerSendMode: undefined,
      composerSendModeExplicit: undefined,
    }) ===
      JSON.stringify({
        ...settings.profile,
        composerSendMode: undefined,
        composerSendModeExplicit: undefined,
      });
  const tabs: Array<{
    id: SettingsTab;
    label: string;
    icon: IconName;
  }> = [
    {
      id: "account",
      label: i18n.t("settings:settingsView.account"),
      icon: "users",
    },
    {
      id: "models",
      label: i18n.t("settings:settingsView.modelsProvider"),
      icon: "chip",
    },
    {
      id: "plugins",
      label: i18n.t("settings:settingsView.plugins"),
      icon: "trigger",
    },
    {
      id: "appearance",
      label: i18n.t("settings:settingsView.appearance"),
      icon: "moon",
    },
    {
      id: "general",
      label: i18n.t("settings:settingsView.general"),
      icon: "settings",
    },
    {
      id: "compaction",
      label: i18n.t("settings:settingsView.contextCompaction"),
      icon: "compress",
    },
    {
      id: "skills",
      label: i18n.t("settings:settingsView.skills"),
      icon: "book",
    },
    {
      id: "workflows",
      label: i18n.t("settings:settingsView.workflows"),
      icon: "compose",
    },
    {
      id: "fleet",
      label: i18n.t("settings:settingsView.fleet"),
      icon: "computer",
    },
    {
      id: "archived",
      label: i18n.t("settings:settingsView.archivedThreads"),
      icon: "archive",
    },
  ];
  return (
    <section
      hidden={!active}
      inert={!active}
      className={`product-page settings-view${showHeader ? "" : " settings-view-embedded"}`}
      aria-label={t("settingsView.zenxSettings")}
    >
      {showHeader ? (
        <header className="page-header">
          <div className="page-title">
            <button
              className="icon-button mobile-menu"
              type="button"
              aria-label={t("settingsView.openSidebar")}
              onClick={onOpenSidebar}
            >
              <Icon name="tree" />
            </button>
            <div>
              <h1>{t("settingsView.settings")}</h1>
              <p>{t("settingsView.makeZenxYourOwn")}</p>
            </div>
          </div>
        </header>
      ) : null}
      <div ref={scrollRef} className="page-scroll">
        <div className="settings-layout">
          <nav
            ref={navRef}
            className="settings-nav"
            role="tablist"
            aria-label={t("settingsView.settingsSections")}
            onKeyDown={(event) => {
              if (
                ![
                  "ArrowUp",
                  "ArrowDown",
                  "ArrowLeft",
                  "ArrowRight",
                  "Home",
                  "End",
                ].includes(event.key)
              )
                return;
              const buttons = Array.from(
                navRef.current?.querySelectorAll("button") ?? [],
              );
              const current = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              if (current < 0) return;
              event.preventDefault();
              let next = current;
              if (event.key === "ArrowDown" || event.key === "ArrowRight")
                next = (current + 1) % buttons.length;
              if (event.key === "ArrowUp" || event.key === "ArrowLeft")
                next = (current - 1 + buttons.length) % buttons.length;
              if (event.key === "Home") next = 0;
              if (event.key === "End") next = buttons.length - 1;
              buttons[next]?.focus();
              const id = buttons[next]?.dataset.tab as SettingsTab | undefined;
              if (id) onTabChange(id);
            }}
          >
            {tabs.map((item) => (
              <button
                data-tab={item.id}
                key={item.id}
                type="button"
                role="tab"
                id={`settings-tab-${item.id}`}
                aria-controls="settings-panel"
                tabIndex={tab === item.id ? 0 : -1}
                aria-selected={tab === item.id}
                onClick={() => onTabChange(item.id)}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <div
            className="settings-panel"
            id="settings-panel"
            role="tabpanel"
            aria-labelledby={`settings-tab-${tab}`}
            tabIndex={0}
          >
            <Activity mode={active && tab === "account" ? "visible" : "hidden"}>
              <AccountPanel
                settings={settings}
                busy={busy}
                manualCode={manualCode}
                setBusy={setBusy}
                setError={setError}
                setManualCode={setManualCode}
                setSettings={setSettings}
              />
            </Activity>
            <Activity mode={active && tab === "models" ? "visible" : "hidden"}>
              <ModelsPanel
                busy={busy}
                draft={draft}
                error={error}
                settings={settings}
                setBusy={setBusy}
                setDraft={setDraft}
                setError={setError}
                setSettings={setSettings}
                setStatus={setStatus}
              />
            </Activity>
            {pluginsVisited ? (
              <div
                className="preserved-plugin-settings"
                hidden={tab !== "plugins"}
                inert={tab !== "plugins"}
              >
                <>
                  <header>
                    <h2>{t("settingsView.plugins")}</h2>
                    <p>{t("settingsView.manageThePluginsAvailableInZenx")}</p>
                  </header>
                  <Activity
                    mode={active && tab === "plugins" ? "visible" : "hidden"}
                  >
                    <PluginSettings
                      onOpenGeneral={(pluginId) => {
                        onTabChange("general");
                        if (pluginId === "browser")
                          setLocalBrowserFocusRequest((value) => value + 1);
                      }}
                      onFeedback={(message) => {
                        if (feedbackScope.current.version !== feedbackVersion)
                          return;
                        setError(null);
                        setStatus(message);
                      }}
                    />
                  </Activity>
                  {pluginSnapshot === null ? null : (
                    <PluginSettingsSurfaces snapshot={pluginSnapshot} />
                  )}
                </>
              </div>
            ) : null}
            {active && tab === "appearance" ? <AppearancePanel /> : null}
            {active && tab === "fleet" ? <FleetSettings /> : null}
            <Activity mode={active && tab === "general" ? "visible" : "hidden"}>
              <>
                <GeneralPanel draft={draft} setDraft={setDraft} />
                <ChromeConnectionSettings draft={draft} setDraft={setDraft} />
                <RtkSettingsCard
                  draft={draft}
                  settings={settings}
                  busy={busy !== null}
                  onChange={(experimentalRtkEnabled) =>
                    setDraft({ ...draft, experimentalRtkEnabled })
                  }
                />
              </>
            </Activity>
            <Activity
              mode={active && tab === "compaction" ? "visible" : "hidden"}
            >
              <ContextCompactionPanel
                config={draft.contextCompaction}
                onChange={(contextCompaction) =>
                  setDraft({ ...draft, contextCompaction })
                }
              />
            </Activity>
            <Activity mode={active && tab === "skills" ? "visible" : "hidden"}>
              <SkillsSettingsPanel />
            </Activity>
            <Activity
              mode={active && tab === "workflows" ? "visible" : "hidden"}
            >
              <WorkflowSettingsPanel
                commands={draft.workflowCommands ?? []}
                titlePrompt={draft.titlePrompt}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    workflowCommands: value.workflowCommands,
                    titlePrompt: value.titlePrompt,
                  })
                }
              />
            </Activity>
            {compactionError !== null ? (
              <div className="settings-error" role="alert">
                {compactionError}
              </div>
            ) : null}
            {workflowError !== null && tab === "workflows" ? (
              <div className="settings-error" role="alert">
                {workflowError}
              </div>
            ) : null}
            <Activity
              mode={active && tab === "archived" ? "visible" : "hidden"}
            >
              <ArchivedThreadsPanel
                error={archivedError}
                loading={archivedLoading}
                onRetry={onRetryArchived}
                onUnarchive={onUnarchive}
                threads={archivedThreads}
                providerLogoDataUrls={settings.providerLogoDataUrls}
                providerProfiles={settings.profile.providerProfiles}
              />
            </Activity>
            {settings.configuration?.status === "unconfirmed" ? (
              <div className="settings-note" role="status">
                <p>{configurationSaveMessage(settings)}</p>
                <button
                  type="button"
                  className="quiet-button"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy("configuration-check");
                    setError(null);
                    setStatus(null);
                    void window.zenx.settings
                      .reconcile(false)
                      .then((value) => {
                        setSettings(value);
                        setStatus(configurationSaveToast(value));
                      })
                      .catch((reason) => setError(describeError(reason)))
                      .finally(() => setBusy(null));
                  }}
                >
                  {t("settingsView.checkApplicationStatus")}
                </button>
                <button
                  type="button"
                  className="quiet-button"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy("configuration-retry");
                    setError(null);
                    setStatus(null);
                    void window.zenx.settings
                      .reconcile(true)
                      .then((value) => {
                        setSettings(value);
                        setStatus(configurationSaveToast(value));
                      })
                      .catch((reason) => setError(describeError(reason)))
                      .finally(() => setBusy(null));
                  }}
                >
                  {t("settingsView.retryApplyingSavedSettings")}
                </button>
              </div>
            ) : null}
            {settings.configuration?.pendingRestart.length ? (
              <div className="settings-note" role="status">
                <p>
                  {t("settingsView.savedPendingRestart", {
                    fields: settings.configuration.pendingRestart
                      .map((domain) =>
                        domain === "experimentalRtk"
                          ? t("settingsView.compactShellOutput")
                          : domain,
                      )
                      .join(", "),
                  })}
                </p>
                <button
                  type="button"
                  className="quiet-button"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy("safe-restart");
                    setError(null);
                    setStatus(null);
                    void window.zenx.settings
                      .safeRestart()
                      .then((value) => {
                        setSettings(value);
                        setDraft(value.profile);
                        setStatus(
                          settings.configuration?.pendingRestart.includes(
                            "experimentalRtk",
                          )
                            ? null
                            : configurationSaveToast(value),
                        );
                      })
                      .catch((reason) => setError(describeError(reason)))
                      .finally(() => setBusy(null));
                  }}
                >
                  {t("settingsView.safeRestart")}
                </button>
              </div>
            ) : null}
            {error && tab !== "models" ? (
              <div className="settings-error" role="alert">
                <Icon name="warning" />
                {error}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {hostDirty ||
      tab === "models" ||
      tab === "general" ||
      tab === "compaction" ||
      tab === "workflows" ? (
        <SettingsApplyBar
          busy={busy === "save"}
          disabled={
            busy !== null ||
            compactionError !== null ||
            workflowError !== null ||
            settings.configuration?.status === "unconfirmed"
          }
          dirty={hostDirty}
          requiresRestart={!sendModeOnly}
          onApply={() => void save()}
        />
      ) : null}
      <div
        className="settings-toast-region"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {status && !error ? (
          <div className="settings-toast">
            <Icon name="check" />
            <span>{status.message}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function SettingsApplyBar({
  busy,
  dirty,
  onApply,
  requiresRestart = true,
  disabled = false,
}: {
  disabled?: boolean;
  requiresRestart?: boolean;
  busy: boolean;
  dirty: boolean;
  onApply(): void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className={`settings-apply-bar${dirty ? " dirty" : ""}`}>
      <div>
        <strong>
          {requiresRestart
            ? t("settingsView.appSettings")
            : t("settingsView.messageSending")}
        </strong>
        <span>
          {dirty
            ? requiresRestart
              ? t(
                  "settingsView.unsavedChangesAcrossSettingsRunningTurnsKeepTheirCurrent",
                )
              : t(
                  "settingsView.unsavedSendingPreferenceRunningTurnsContinueUninterrupted",
                )
            : t("settingsView.yourSettingsAreUpToDate")}
        </span>
      </div>
      <button
        className={dirty ? "primary-button" : "quiet-button"}
        type="button"
        disabled={!dirty || busy || disabled}
        onClick={onApply}
      >
        {requiresRestart
          ? busy
            ? t("settingsView.applying")
            : t("settingsView.apply")
          : busy
            ? t("settingsView.applying")
            : t("settingsView.apply")}
      </button>
    </div>
  );
}

export function ArchivedThreadsPanel({
  error,
  loading,
  onRetry,
  onUnarchive,
  threads,
  providerLogoDataUrls,
  providerProfiles,
}: {
  error: string | null;
  loading: boolean;
  onRetry(): void;
  onUnarchive(thread: NativeThreadSummary): Promise<void>;
  threads: readonly NativeThreadSummary[];
  providerLogoDataUrls?: Readonly<Record<string, string>>;
  providerProfiles?: readonly ZenXProviderProfile[];
}) {
  const { t } = useTranslation("settings");
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const unarchive = async (thread: NativeThreadSummary) => {
    setBusyThreadId(thread.threadId);
    setActionError(null);
    try {
      await onUnarchive(thread);
    } catch (reason) {
      setActionError(describeError(reason));
    } finally {
      setBusyThreadId(null);
    }
  };
  return (
    <>
      <header>
        <h2>{t("settingsView.archivedThreads")}</h2>
        <p>{t("settingsView.restoreAnArchivedConversationToReturnItToThe")}</p>
      </header>
      {loading ? (
        <div className="settings-empty" role="status">
          {t("settingsView.loadingArchivedConversations")}
        </div>
      ) : error !== null ? (
        <div className="settings-empty settings-error" role="alert">
          <span>{error}</span>
          <button className="quiet-button" type="button" onClick={onRetry}>
            {t("settingsView.tryAgain")}
          </button>
        </div>
      ) : threads.length === 0 ? (
        <div className="settings-empty">
          {t(
            "settingsView.noArchivedConversationsConversationsYouArchiveWillAppearHere",
          )}
        </div>
      ) : (
        <div className="archived-thread-list">
          {threads.map((thread) => {
            const identity = threadModelIdentity(thread);
            const providerProfileId =
              thread.status === "systemError"
                ? undefined
                : thread.currentMetadata.providerProfileId;
            const providerProfile = providerProfiles?.find(
              (candidate) => candidate.providerProfileId === providerProfileId,
            );
            const busy = busyThreadId === thread.threadId;
            const workspace =
              thread.status === "systemError"
                ? t("settingsView.unavailableJournal")
                : thread.currentMetadata.cwd;
            return (
              <article className="archived-thread-row" key={thread.threadId}>
                <div className="archived-thread-copy">
                  <strong>{threadTitle(thread)}</strong>
                  <span title={workspace}>{workspace}</span>
                  {identity === null ? null : (
                    <small>
                      <ProviderLogo
                        kind={
                          providerProfileId !== undefined &&
                          (providerProfile === undefined ||
                            providerProfile.logoResource !== undefined)
                            ? "generic"
                            : identity.providerKind
                        }
                        customSrc={
                          providerProfileId === undefined
                            ? undefined
                            : providerLogoDataUrls?.[providerProfileId]
                        }
                      />
                      {identity.label}
                    </small>
                  )}
                </div>
                <button
                  className="quiet-button"
                  type="button"
                  disabled={busyThreadId !== null}
                  onClick={() => void unarchive(thread)}
                >
                  {busy
                    ? t("settingsView.restoring")
                    : t("settingsView.unarchive")}
                </button>
              </article>
            );
          })}
        </div>
      )}
      {actionError === null ? null : (
        <div className="settings-error" role="alert">
          <Icon name="warning" />
          {actionError}
        </div>
      )}
    </>
  );
}

function AccountPanel({
  settings,
  busy,
  manualCode,
  setBusy,
  setError,
  setManualCode,
  setSettings,
}: {
  settings: PublicHostSettings;
  busy: string | null;
  manualCode: boolean;
  setBusy(value: string | null): void;
  setError(value: string | null): void;
  setManualCode(value: boolean): void;
  setSettings(value: PublicHostSettings): void;
}) {
  const { t } = useTranslation("settings");
  const subscriptionConfigured =
    settings.subscriptionProviderProfileId !== null;
  const login = () => {
    setBusy("login");
    setError(null);
    void window.zenx.settings
      .loginSubscription()
      .then((value) => {
        setSettings(value);
        setManualCode(false);
      })
      .catch((reason: unknown) => setError(describeError(reason)))
      .finally(() => setBusy(null));
  };
  return (
    <>
      <header>
        <h2>{t("settingsView.account")}</h2>
      </header>
      <div className="page-card settings-card">
        <div className="settings-card-head">
          <div>
            <h3>{t("settingsView.openaiSubscription")}</h3>
            <p>
              {t("settingsView.connectYourChatgptSubscriptionToUseItsModels")}
            </p>
          </div>
          <span
            className={
              !subscriptionConfigured
                ? "status-muted"
                : settings.subscription.authenticated
                  ? "status-good"
                  : "status-muted"
            }
          >
            {!subscriptionConfigured
              ? t("settingsView.notConfigured")
              : settings.subscription.authenticated
                ? t("settingsView.signedIn")
                : t("settingsView.notSignedIn")}
          </span>
        </div>
        <div className="settings-row">
          <div>
            <strong>
              {settings.subscription.authenticated
                ? t("settingsView.accountConnected")
                : t("settingsView.connectAnAccount")}
            </strong>
            <span>
              {!subscriptionConfigured
                ? t("settingsView.addAnOpenaiSubscriptionInModelsProviderToGet")
                : settings.subscription.authenticated
                  ? t("settingsView.yourSignInDetailsAreStoredSecurelyOnThis")
                  : t("settingsView.signInToConnectYourSubscription")}
            </span>
          </div>
          {!subscriptionConfigured ? null : settings.subscription
              .authenticated ? (
            <button
              className="danger-button"
              type="button"
              onClick={() =>
                void window.zenx.settings
                  .logoutSubscription()
                  .then(setSettings)
                  .catch((reason: unknown) => setError(describeError(reason)))
              }
            >
              {t("settingsView.signOut")}
            </button>
          ) : (
            <button
              className="primary-button"
              type="button"
              disabled={busy !== null}
              onClick={login}
            >
              {busy === "login"
                ? t("settingsView.waitingForBrowser")
                : t("settingsView.signInWithOpenai")}
            </button>
          )}
        </div>
        {manualCode ? <ManualCode /> : null}
      </div>
      <SubscriptionUsageCard
        providerProfileId={settings.subscriptionProviderProfileId}
        accountId={settings.subscription.accountId}
        authenticated={settings.subscription.authenticated}
      />
    </>
  );
}

function ModelsPanel({
  busy,
  draft,
  error,
  settings,
  setBusy,
  setDraft,
  setError,
  setSettings,
  setStatus,
}: {
  busy: string | null;
  draft: ZenXHostProfile;
  error: string | null;
  settings: PublicHostSettings;
  setBusy(value: string | null): void;
  setDraft(value: ZenXHostProfile): void;
  setError(value: string | null): void;
  setSettings(value: PublicHostSettings): void;
  setStatus(value: string | null): void;
}) {
  const { t } = useTranslation("settings");
  const [showAddChoices, setShowAddChoices] = useState(false);
  const [editor, setEditor] = useState<{
    mode: "add" | "edit";
    provider: ZenXProviderProfile;
    baseRevision: number;
  } | null>(null);
  const [deletingProviderId, setDeletingProviderId] = useState<string | null>(
    null,
  );

  const acceptSettings = (value: PublicHostSettings, message: string) => {
    setSettings(value);
    setDraft({
      ...value.profile,
      approvalPolicy: draft.approvalPolicy,
      defaultModel: modelReferenceExists(
        draft.defaultModel,
        value.profile.providerProfiles,
      )
        ? draft.defaultModel
        : value.profile.defaultModel,
      titleModel: modelReferenceExists(
        draft.titleModel,
        value.profile.providerProfiles,
      )
        ? draft.titleModel
        : value.profile.titleModel,
    });
    setError(null);
    setStatus(configurationSaveToast(value));
  };

  const runMutation = async (
    operation: string,
    message: string,
    mutation: () => Promise<PublicHostSettings>,
    committed: (value: PublicHostSettings) => boolean,
  ): Promise<"success" | "committed-error" | "failed"> => {
    setBusy(operation);
    setError(null);
    setStatus(null);
    try {
      acceptSettings(await mutation(), message);
      return "success";
    } catch (reason) {
      const originalError = describeError(reason);
      try {
        const authoritative = await window.zenx.settings.get();
        if (
          authoritative.configuration &&
          (authoritative.profile.revision ?? 0) >
            (settings.profile.revision ?? 0) &&
          committed(authoritative)
        ) {
          setSettings(authoritative);
          setDraft(authoritative.profile);
          setStatus(configurationSaveToast(authoritative));
          setError(
            i18n.t("settings:settingsView.settingsFinalizationFailed", {
              error: originalError,
            }),
          );
          return "committed-error";
        }
        setError(originalError);
      } catch (reconciliationReason) {
        setError(
          i18n.t("settings:settingsView.settingsMutationOutcomeUnknown", {
            error: originalError,
            reason: describeError(reconciliationReason),
          }),
        );
      }
      return "failed";
    } finally {
      setBusy(null);
    }
  };

  const runProviderMutation = async (
    operation: "provider-add" | "provider-edit",
    message: string,
    mutation: () => ReturnType<Window["zenx"]["settings"]["addProvider"]>,
  ): Promise<"success" | "committed-error" | "failed"> => {
    setBusy(operation);
    setError(null);
    setStatus(null);
    try {
      const reply = await mutation();
      if (reply.ok) {
        acceptSettings(reply.settings, message);
        if (reply.outcome === "unconfirmed")
          setError(
            i18n.t(
              "settings:settingsView.providerSettingsWereSavedButApplyingThemIsUnconfirmed",
            ),
          );
        return "success";
      }
      if (reply.outcome === "committed-error") {
        try {
          const authoritative = await window.zenx.settings.get();
          setSettings(authoritative);
          setDraft(authoritative.profile);
          setStatus(configurationSaveToast(authoritative));
        } catch {
          // Host confirmed the commit; a failed refresh does not undo it.
        }
        setError(
          i18n.t(
            "settings:settingsView.providerSettingsWereSavedButFinalizationFailedCheckApplication",
          ),
        );
        return "committed-error";
      }
      const messageByCode = {
        "revision-conflict": i18n.t(
          "settings:settingsView.anotherWindowChangedSettingsThisProviderWasNotSaved",
        ),
        "validation-rejected": i18n.t(
          "settings:settingsView.thisProviderWasNotSavedReviewItsConnectionAnd",
        ),
        "save-rejected": i18n.t(
          "settings:settingsView.thisProviderWasNotSavedCheckApplicationStatusThen",
        ),
        "save-finalization-failed": i18n.t(
          "settings:settingsView.providerSettingsWereSavedButFinalizationFailedCheckApplication",
        ),
        "save-unconfirmed": i18n.t(
          "settings:settingsView.couldNotConfirmWhetherThisProviderWasSavedCheck",
        ),
      } as const;
      setError(messageByCode[reply.code]);
      return "failed";
    } catch {
      setError(
        i18n.t(
          "settings:settingsView.couldNotConfirmWhetherThisProviderWasSavedCheck",
        ),
      );
      return "failed";
    } finally {
      setBusy(null);
    }
  };

  const openAddEditor = (type: ZenXProviderProfile["type"]) => {
    const providerProfileId = globalThis.crypto.randomUUID();
    const provider: ZenXProviderProfile =
      type === "fake"
        ? {
            providerProfileId,
            type,
            displayName: i18n.t("settings:settingsView.localDemo"),
            models: [legacyModelCatalogEntry("fake")],
          }
        : type === "openai-subscription"
          ? {
              providerProfileId,
              type,
              displayName: "OpenAI subscription",
              models: subscriptionModelCatalogEntries(),
            }
          : {
              providerProfileId,
              type,
              name: "openai",
              displayName: "",
              baseUrl: "https://api.openai.com/v1",
              models: [manualModelCatalogEntry("")],
            };
    setShowAddChoices(false);
    setDeletingProviderId(null);
    setEditor({
      mode: "add",
      provider,
      baseRevision: settings.profile.revision ?? 0,
    });
    setError(null);
    setStatus(null);
  };

  const openKnownProviderEditor = (preset: ZenXKnownProviderPreset) => {
    setShowAddChoices(false);
    setDeletingProviderId(null);
    setEditor({
      baseRevision: settings.profile.revision ?? 0,
      mode: "add",
      provider: {
        providerProfileId: preset.providerProfileId,
        type: "openai-compatible",
        name: preset.name,
        displayName: preset.displayName,
        baseUrl: preset.baseUrl,
        models: [manualModelCatalogEntry("")],
      },
    });
    setError(null);
    setStatus(null);
  };

  const deletingProvider = settings.profile.providerProfiles.find(
    (provider) => provider.providerProfileId === deletingProviderId,
  );
  return (
    <>
      <header>
        <h2>{t("settingsView.modelsProviders")}</h2>
        <p>{t("settingsView.connectYourProvidersAndChooseTheModelsYouWant")}</p>
      </header>
      {error === null ? null : (
        <div className="settings-error" role="alert">
          <Icon name="warning" />
          {error}
        </div>
      )}
      <div className="page-card settings-card model-routing-card">
        <div className="settings-card-head">
          <div>
            <h3>{t("settingsView.defaultModels")}</h3>
            <p>
              {t("settingsView.chooseAModelForNewConversationsAndAnotherFor")}
            </p>
          </div>
          <span className="status-muted">{t("settingsView.newWork")}</span>
        </div>
        <div className="form-grid">
          <ModelReferenceSelect
            label={t("settingsView.defaultModel")}
            profiles={settings.profile.providerProfiles}
            value={draft.defaultModel}
            onChange={(defaultModel) => setDraft({ ...draft, defaultModel })}
          />
          <ModelReferenceSelect
            label={t("settingsView.titleModel")}
            profiles={settings.profile.providerProfiles}
            value={draft.titleModel}
            onChange={(titleModel) => setDraft({ ...draft, titleModel })}
          />
        </div>
        <p className="settings-note">
          {t("settingsView.existingConversationsKeepTheirModelYouCanChangeIt")}
        </p>
      </div>
      <section
        className="provider-section"
        aria-labelledby="provider-list-title"
      >
        <div className="provider-section-head">
          <div>
            <h3 id="provider-list-title">
              {t("settingsView.providerProfiles")}
            </h3>
            <p>{t("settingsView.manageEachConnectionAndItsAvailableModels")}</p>
          </div>
          {editor === null ? (
            <div className="provider-section-actions">
              <button
                className="quiet-button"
                type="button"
                onClick={() => {
                  setShowAddChoices((visible) => !visible);
                  setDeletingProviderId(null);
                  setError(null);
                }}
              >
                {t("settingsView.addProvider")}
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => openAddEditor("openai-compatible")}
              >
                {t("settingsView.addCustomProvider")}
              </button>
            </div>
          ) : null}
        </div>
        {showAddChoices && editor === null ? (
          <div className="page-card provider-add-choices">
            <div>
              <strong>{t("settingsView.addAKnownProvider")}</strong>
              <span>
                {t("settingsView.chooseABuiltInConnectionPresetCustomApisUse")}
              </span>
            </div>
            <button
              type="button"
              aria-label={t("settingsView.addOpenaiSubscription")}
              onClick={() => openAddEditor("openai-subscription")}
              disabled={settings.profile.providerProfiles.some(
                (provider) => provider.type === "openai-subscription",
              )}
            >
              <ProviderLogo kind="openai" />
              <strong>{t("settingsView.openaiSubscription2")}</strong>
              <span>
                {settings.profile.providerProfiles.some(
                  (provider) => provider.type === "openai-subscription",
                )
                  ? t("settingsView.oneSubscriptionAccountIsAlreadyConfigured")
                  : t("settingsView.usesTheSignInManagedInAccount")}
              </span>
            </button>
            {KNOWN_PROVIDER_PRESETS.map((preset) => {
              const configured = settings.profile.providerProfiles.some(
                (provider) =>
                  provider.providerProfileId === preset.providerProfileId,
              );
              return (
                <button
                  key={preset.providerProfileId}
                  type="button"
                  aria-label={t("settingsView.addNamedProvider", {
                    name: preset.displayName,
                  })}
                  onClick={() => openKnownProviderEditor(preset)}
                  disabled={configured}
                >
                  <ProviderLogo
                    kind={providerLogoKindForIdentity(
                      preset.name,
                      preset.displayName,
                    )}
                  />
                  <strong>{preset.displayName}</strong>
                  <span>
                    {configured
                      ? t("settingsView.thisBuiltInProviderIsAlreadyConfigured")
                      : t("settingsView.openaiCompatibleApiPreset")}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              aria-label={t("settingsView.addLocalDemo")}
              onClick={() => openAddEditor("fake")}
            >
              <ProviderLogo kind="local" />
              <strong>{t("settingsView.localDemo")}</strong>
              <span>
                {t("settingsView.deterministicFakeDevProviderForLocalTesting")}
              </span>
            </button>
            <button
              className="quiet-button provider-choice-cancel"
              type="button"
              onClick={() => setShowAddChoices(false)}
            >
              {t("settingsView.cancel")}
            </button>
          </div>
        ) : null}
        {editor === null ? null : (
          <ProviderEditor
            key={`${editor.mode}:${editor.provider.providerProfileId}`}
            allProfiles={settings.profile.providerProfiles}
            busy={busy !== null}
            defaultModel={settings.profile.defaultModel}
            hasApiKey={settings.apiKeyProviderProfileIds.includes(
              editor.provider.providerProfileId,
            )}
            mode={editor.mode}
            provider={editor.provider}
            logoDataUrl={
              settings.providerLogoDataUrls?.[editor.provider.providerProfileId]
            }
            titleModel={settings.profile.titleModel}
            onCancel={() => setEditor(null)}
            onSubmit={async (
              provider,
              apiKey,
              replacements,
              logoUpload,
              diagnosticAttemptId,
            ) => {
              const success = await runProviderMutation(
                editor.mode === "add" ? "provider-add" : "provider-edit",
                editor.mode === "add"
                  ? t("settingsView.providerAdded")
                  : t("settingsView.providerSaved"),
                async () =>
                  editor.mode === "add"
                    ? await window.zenx.settings.addProvider(
                        provider,
                        apiKey,
                        editor.baseRevision,
                        logoUpload ?? undefined,
                        diagnosticAttemptId,
                      )
                    : await window.zenx.settings.editProvider(
                        editor.provider.providerProfileId,
                        provider,
                        {
                          ...replacements,
                          baseRevision: editor.baseRevision,
                          ...(apiKey === undefined ? {} : { apiKey }),
                          ...(logoUpload === undefined ? {} : { logoUpload }),
                        },
                        diagnosticAttemptId,
                      ),
              );
              if (success !== "failed") setEditor(null);
              return success;
            }}
          />
        )}
        <div className="provider-profile-list">
          {settings.profile.providerProfiles.map((provider) => (
            <ProviderProfileCard
              defaultModel={settings.profile.defaultModel}
              key={provider.providerProfileId}
              provider={provider}
              settings={settings}
              titleModel={settings.profile.titleModel}
              onDelete={() => {
                setDeletingProviderId(provider.providerProfileId);
                setShowAddChoices(false);
                setEditor(null);
                setError(null);
                setStatus(null);
              }}
              onEdit={() => {
                setEditor({
                  mode: "edit",
                  provider,
                  baseRevision: settings.profile.revision ?? 0,
                });
                setDeletingProviderId(null);
                setShowAddChoices(false);
                setError(null);
                setStatus(null);
              }}
            />
          ))}
        </div>
        {deletingProvider === undefined ? null : (
          <DeleteProviderPanel
            busy={busy !== null}
            defaultModel={settings.profile.defaultModel}
            profiles={settings.profile.providerProfiles}
            provider={deletingProvider}
            titleModel={settings.profile.titleModel}
            onCancel={() => setDeletingProviderId(null)}
            onDelete={async (replacements) => {
              const success = await runMutation(
                "provider-delete",
                t("settingsView.providerDeleted"),
                async () =>
                  await window.zenx.settings.deleteProvider(
                    deletingProvider.providerProfileId,
                    {
                      ...replacements,
                      baseRevision: settings.profile.revision ?? 0,
                    },
                  ),
                (authoritative) => {
                  const deleted = authoritative.profile.providerProfiles.some(
                    (candidate) =>
                      candidate.providerProfileId ===
                      deletingProvider.providerProfileId,
                  );
                  if (deleted) return false;
                  return (
                    (replacements?.defaultModel === undefined ||
                      JSON.stringify(authoritative.profile.defaultModel) ===
                        JSON.stringify(replacements.defaultModel)) &&
                    (replacements?.titleModel === undefined ||
                      JSON.stringify(authoritative.profile.titleModel) ===
                        JSON.stringify(replacements.titleModel))
                  );
                },
              );
              if (success !== "failed") setDeletingProviderId(null);
              return success;
            }}
          />
        )}
      </section>
    </>
  );
}

function ProviderProfileCard({
  defaultModel,
  onDelete,
  onEdit,
  provider,
  settings,
  titleModel,
}: {
  defaultModel: ZenXModelReference;
  onDelete(): void;
  onEdit(): void;
  provider: ZenXProviderProfile;
  settings: PublicHostSettings;
  titleModel: ZenXModelReference;
}) {
  const { t } = useTranslation("settings");
  const ownsDefault =
    defaultModel.providerProfileId === provider.providerProfileId;
  const ownsTitle = titleModel.providerProfileId === provider.providerProfileId;
  const status = providerStatus(provider, settings);
  return (
    <article className="page-card provider-profile-card">
      <div className="provider-profile-main">
        <ProviderLogo
          kind={
            provider.logoResource === undefined
              ? providerLogoKind(provider)
              : "generic"
          }
          customSrc={
            settings.providerLogoDataUrls?.[provider.providerProfileId]
          }
        />
        <div>
          <div className="provider-profile-name">
            <strong>{provider.displayName}</strong>
            <span>{providerTypeLabel(provider)}</span>
          </div>
          <small className={status.className}>{status.label}</small>
        </div>
      </div>
      <div
        className="provider-model-summary"
        aria-label={`${provider.displayName} models`}
      >
        {provider.models.map((model) => (
          <span key={model.id}>{model.id}</span>
        ))}
      </div>
      <div
        className="provider-profile-roles"
        aria-label={t("settingsView.providerGlobalRoles", {
          name: provider.displayName,
        })}
      >
        {ownsDefault ? <span>{t("settingsView.default")}</span> : null}
        {ownsTitle ? <span>{t("settingsView.title")}</span> : null}
      </div>
      <div className="provider-profile-actions">
        <button
          className="quiet-button"
          type="button"
          aria-label={t("settingsView.editNamedProvider", {
            name: provider.displayName,
          })}
          onClick={onEdit}
        >
          {t("settingsView.edit")}
        </button>
        <button
          className="danger-button"
          type="button"
          aria-label={t("settingsView.deleteNamedProvider", {
            name: provider.displayName,
          })}
          onClick={onDelete}
        >
          {t("settingsView.delete")}
        </button>
      </div>
    </article>
  );
}

function ProviderEditor({
  allProfiles,
  busy,
  defaultModel,
  hasApiKey,
  mode,
  onCancel,
  onSubmit,
  provider: initialProvider,
  logoDataUrl,
  titleModel,
}: {
  allProfiles: readonly ZenXProviderProfile[];
  busy: boolean;
  defaultModel: ZenXModelReference;
  hasApiKey: boolean;
  mode: "add" | "edit";
  onCancel(): void;
  onSubmit(
    provider: ZenXProviderProfile,
    apiKey: string | undefined,
    replacements: ZenXProviderEditOptions,
    logoUpload: Uint8Array | null | undefined,
    diagnosticAttemptId?: string,
  ): Promise<"success" | "committed-error" | "failed">;
  provider: ZenXProviderProfile;
  logoDataUrl?: string;
  titleModel: ZenXModelReference;
}) {
  const { t } = useTranslation("settings");
  const [provider, setProvider] = useState(initialProvider);
  const [modelRows, setModelRows] = useState(() =>
    initialProvider.models.map((model) => ({
      key: globalThis.crypto.randomUUID(),
      model: { ...model },
    })),
  );
  const models = modelRows.map((row) => row.model);
  const modelIds = new Set(models.map((model) => model.id));
  const remainingModelSlots = Math.max(
    0,
    MAX_MODELS_PER_PROVIDER - models.length,
  );
  const [discovering, setDiscovering] = useState(false);
  const [availableModels, setAvailableModels] = useState<
    ZenXModelCatalogEntry[] | null
  >(null);
  const [selectedAvailableModels, setSelectedAvailableModels] = useState<
    string[]
  >([]);
  const selectedAvailableModelIds = new Set(selectedAvailableModels);
  const selectedNewModels =
    availableModels?.filter(
      (model) =>
        selectedAvailableModelIds.has(model.id) && !modelIds.has(model.id),
    ) ?? [];
  const [modelSearch, setModelSearch] = useState("");
  const [probingModel, setProbingModel] = useState<string | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [logoUpload, setLogoUpload] = useState<Uint8Array | null | undefined>();
  const [logoFilename, setLogoFilename] = useState<string | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoSelectionError, setLogoSelectionError] = useState<string | null>(
    null,
  );
  const [logoReading, setLogoReading] = useState(false);
  const logoReadVersion = useRef(0);
  const logoFileInput = useRef<HTMLInputElement>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationAttempt, setValidationAttempt] = useState(0);
  const validationSummary = useRef<HTMLDivElement>(null);
  const editorId = useId();
  const [defaultReplacement, setDefaultReplacement] = useState("");
  const [titleReplacement, setTitleReplacement] = useState("");
  const normalizedProvider = {
    ...provider,
    models: models.map(normalizedDraftModel),
  } as ZenXProviderProfile;
  const validationIssues =
    validationAttempt === 0
      ? []
      : validateProviderEditor(normalizedProvider, apiKey, mode, hasApiKey);
  const validationIssueByField = new Map(
    validationIssues.map((issue) => [
      `${issue.modelIndex ?? -1}:${issue.field}`,
      issue.message,
    ]),
  );
  const fieldId = (field: ProviderEditorIssue["field"], modelIndex?: number) =>
    `${editorId}-${modelIndex === undefined ? "provider" : `model-${modelIndex}`}-${field}`;
  const issueFor = (field: ProviderEditorIssue["field"], modelIndex?: number) =>
    validationIssueByField.get(`${modelIndex ?? -1}:${field}`);
  const recordValidationRejection = (
    attemptId: string,
    reason:
      | ProviderEditorIssue["code"]
      | "logo_invalid"
      | "logo_loading"
      | "replacement_default_missing"
      | "replacement_title_missing"
      | "validation_issues_truncated",
    modelIndex?: number,
  ) => {
    try {
      void window.zenx.settings
        .recordDiagnostic({
          event: "provider-validation-rejected",
          attemptId,
          operation: mode,
          reason,
          ...(modelIndex === undefined ? {} : { modelIndex }),
        })
        .catch(() => undefined);
    } catch {
      // Diagnostics must not interrupt editing.
    }
  };
  useEffect(() => {
    if (validationAttempt > 0) validationSummary.current?.focus();
  }, [validationAttempt]);
  const replacementProfiles =
    mode === "edit"
      ? allProfiles.map((candidate) =>
          candidate.providerProfileId === provider.providerProfileId
            ? normalizedProvider
            : candidate,
        )
      : [...allProfiles, normalizedProvider];
  const replacesDefault =
    mode === "edit" &&
    defaultModel.providerProfileId === provider.providerProfileId &&
    !normalizedProvider.models.some(
      (model) => model.id === defaultModel.modelId,
    );
  const replacesTitle =
    mode === "edit" &&
    titleModel.providerProfileId === provider.providerProfileId &&
    !normalizedProvider.models.some((model) => model.id === titleModel.modelId);

  const updateModel = (
    index: number,
    update: (model: ZenXModelCatalogEntry) => ZenXModelCatalogEntry,
  ) => {
    setModelRows((current) =>
      current.map((row, candidate) =>
        candidate === index ? { ...row, model: update(row.model) } : row,
      ),
    );
    setValidationError(null);
  };

  return (
    <section
      className="page-card provider-editor"
      aria-label={
        mode === "add"
          ? t("settingsView.addProviderProfile")
          : t("settingsView.editNamedProvider", {
              name: initialProvider.displayName,
            })
      }
    >
      <div className="provider-editor-head">
        <div>
          <strong>
            {mode === "add"
              ? t("settingsView.addProviderProfile")
              : t("settingsView.editNamedProvider", {
                  name: initialProvider.displayName,
                })}
          </strong>
          <span>{providerTypeLabel(provider)}</span>
        </div>
        <button className="quiet-button" type="button" onClick={onCancel}>
          {t("settingsView.cancel2")}
        </button>
      </div>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const diagnosticAttemptId = globalThis.crypto.randomUUID();
          if (models.length > MAX_MODELS_PER_PROVIDER) {
            setValidationError(
              t("settingsView.aProviderCanHaveAtMost1024Models"),
            );
            return;
          }
          if (logoSelectionError !== null || logoReading) {
            recordValidationRejection(
              diagnosticAttemptId,
              logoSelectionError === null ? "logo_loading" : "logo_invalid",
            );
            setValidationError(
              logoSelectionError ??
                t("settingsView.waitForTheProviderLogoToFinishLoading"),
            );
            return;
          }
          const issues = validateProviderEditor(
            normalizedProvider,
            apiKey,
            mode,
            hasApiKey,
          );
          if (issues.length > 0) {
            for (const issue of issues.slice(0, 16))
              recordValidationRejection(
                diagnosticAttemptId,
                issue.code,
                issue.modelIndex,
              );
            if (issues.length > 16)
              recordValidationRejection(
                diagnosticAttemptId,
                "validation_issues_truncated",
              );
            setValidationError(null);
            setValidationAttempt((current) => current + 1);
            return;
          }
          const replacements: ZenXProviderEditOptions = {};
          if (replacesDefault) {
            const reference = modelReferenceFromValue(
              defaultReplacement,
              replacementProfiles,
            );
            if (reference === undefined) {
              recordValidationRejection(
                diagnosticAttemptId,
                "replacement_default_missing",
              );
              setValidationError(
                t("settingsView.chooseAReplacementDefaultModel"),
              );
              return;
            }
            replacements.defaultModel = reference;
          }
          if (replacesTitle) {
            const reference = modelReferenceFromValue(
              titleReplacement,
              replacementProfiles,
            );
            if (reference === undefined) {
              recordValidationRejection(
                diagnosticAttemptId,
                "replacement_title_missing",
              );
              setValidationError(
                t("settingsView.chooseAReplacementTitleModel"),
              );
              return;
            }
            replacements.titleModel = reference;
          }
          void onSubmit(
            normalizedProvider,
            apiKey.trim().length === 0 ? undefined : apiKey,
            replacements,
            logoUpload,
            diagnosticAttemptId,
          );
        }}
      >
        {validationIssues.length === 0 ? null : (
          <div
            ref={validationSummary}
            className="settings-error provider-editor-error-summary"
            role="alert"
            tabIndex={-1}
          >
            <Icon name="warning" />
            <div>
              <strong>{t("settingsView.checkTheseFields")}</strong>
              <ul>
                {validationIssues.map((issue) => {
                  const targetId = fieldId(issue.field, issue.modelIndex);
                  return (
                    <li key={`${targetId}-${issue.code}`}>
                      <a
                        href={`#${targetId}`}
                        onClick={(event) => {
                          event.preventDefault();
                          const target = document.getElementById(targetId);
                          const details = target?.closest("details");
                          if (details !== null && details !== undefined)
                            details.open = true;
                          target?.scrollIntoView?.({ block: "center" });
                          target?.focus();
                        }}
                      >
                        {issue.message}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
        <div className="form-grid">
          <Field
            autoFocus
            id={fieldId("displayName")}
            error={issueFor("displayName")}
            label={t("settingsView.displayName")}
            value={provider.displayName}
            onChange={(displayName) => {
              setProvider({ ...provider, displayName });
              setValidationError(null);
            }}
          />
          {provider.type === "openai-compatible" ? (
            <>
              <Field
                id={fieldId("providerName")}
                error={issueFor("providerName")}
                label={t("settingsView.providerName")}
                value={provider.name}
                onChange={(name) => {
                  setProvider({ ...provider, name });
                  setValidationError(null);
                }}
              />
              <Field
                wide
                id={fieldId("baseUrl")}
                error={issueFor("baseUrl")}
                label={t("settingsView.baseUrl")}
                value={provider.baseUrl}
                onChange={(baseUrl) => {
                  setProvider({ ...provider, baseUrl });
                  setValidationError(null);
                }}
              />
              <Field
                wide
                secret
                id={fieldId("apiKey")}
                error={issueFor("apiKey")}
                label={t("settingsView.apiKey")}
                placeholder={
                  mode === "edit" && hasApiKey
                    ? t("settingsView.apiKeySavedLeaveBlankToKeep")
                    : t("settingsView.required")
                }
                value={apiKey}
                onChange={(value) => {
                  setApiKey(value);
                  setValidationError(null);
                }}
              />
            </>
          ) : null}
        </div>
        {provider.type === "openai-compatible" ? (
          <div
            className="settings-note"
            aria-label={t("settingsView.providerLogo")}
          >
            <ProviderLogo
              kind={
                provider.logoResource === undefined
                  ? providerLogoKind(provider)
                  : "generic"
              }
              customSrc={
                logoUpload === null ? undefined : (logoPreview ?? logoDataUrl)
              }
            />
            <label className="field">
              <span>{t("settingsView.providerLogoPngJpegOrWebpUpTo512")}</span>
              <input
                ref={logoFileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file === undefined) return;
                  const version = ++logoReadVersion.current;
                  setLogoUpload(undefined);
                  setLogoFilename(null);
                  setLogoPreview(null);
                  setLogoSelectionError(null);
                  setLogoReading(false);
                  if (
                    !["image/png", "image/jpeg", "image/webp"].includes(
                      file.type,
                    )
                  ) {
                    const message = t(
                      "settingsView.chooseAPngJpegOrWebpProviderLogo",
                    );
                    setLogoSelectionError(message);
                    setValidationError(message);
                    return;
                  }
                  if (file.size > 512 * 1024) {
                    const message = t(
                      "settingsView.providerLogoMustBeAtMost512Kib",
                    );
                    setLogoSelectionError(message);
                    setValidationError(message);
                    return;
                  }
                  setLogoReading(true);
                  void file
                    .arrayBuffer()
                    .then((bytes) => {
                      if (version !== logoReadVersion.current) return;
                      setLogoUpload(new Uint8Array(bytes));
                      setLogoFilename(file.name);
                      setLogoPreview(
                        `data:${file.type};base64,${base64FromBytes(new Uint8Array(bytes))}`,
                      );
                      setValidationError(null);
                    })
                    .catch((reason) => {
                      if (version !== logoReadVersion.current) return;
                      const message = describeError(reason);
                      setLogoSelectionError(message);
                      setValidationError(message);
                    })
                    .finally(() => {
                      if (version === logoReadVersion.current)
                        setLogoReading(false);
                    });
                }}
              />
            </label>
            {logoFilename === null ? null : <span>{logoFilename}</span>}
            {logoUpload !== null &&
            (logoUpload !== undefined ||
              logoDataUrl !== undefined ||
              initialProvider.logoResource !== undefined) ? (
              <button
                className="quiet-button"
                type="button"
                onClick={() => {
                  logoReadVersion.current += 1;
                  if (logoFileInput.current !== null)
                    logoFileInput.current.value = "";
                  setLogoUpload(null);
                  setLogoFilename(null);
                  setLogoPreview(null);
                  setLogoSelectionError(null);
                  setLogoReading(false);
                  setValidationError(null);
                }}
              >
                {t("settingsView.removeLogo")}
              </button>
            ) : null}
          </div>
        ) : null}
        {provider.type === "openai-compatible" ? (
          <p className="settings-note credential-note">
            {t("settingsView.storedKeysAreNeverShownEnterAValueOnly")}
          </p>
        ) : provider.type === "openai-subscription" ? (
          <p className="settings-note credential-note">
            {t("settingsView.authenticationIsManagedByTheExistingOpenaiSignIn")}
          </p>
        ) : (
          <p className="settings-note credential-note">
            {t("settingsView.localDemoWorksOfflineAndDoesNotNeedAn")}
          </p>
        )}
        <fieldset className="provider-model-editor">
          <legend>{t("settingsView.modelCatalog")}</legend>
          <div className="model-catalog-head">
            <p>
              {t("settingsView.chooseTheModelsAvailableFromThisProviderOrAdd")}
            </p>
            {(provider.type === "openai-compatible" ||
              provider.type === "openai-subscription") &&
            mode === "edit" ? (
              <button
                className="quiet-button"
                type="button"
                disabled={
                  discovering ||
                  (provider.type === "openai-compatible" && !hasApiKey)
                }
                title={
                  provider.type === "openai-subscription"
                    ? t("settingsView.fetchTheOfficialCodexModelCatalog")
                    : hasApiKey
                      ? t("settingsView.fetchModelIdsFromThisProvider")
                      : t("settingsView.saveAnApiKeyBeforeDiscovery")
                }
                onClick={() => {
                  setDiscovering(true);
                  setValidationError(null);
                  setCatalogStatus(null);
                  void window.zenx.settings
                    .discoverProvider(provider.providerProfileId)
                    .then((snapshot) => {
                      setAvailableModels(snapshot.models);
                      if (provider.type === "openai-subscription") {
                        setModelRows((current) =>
                          current.map((row) => {
                            const model = row.model;
                            if (model.source === "manual") return row;
                            const discovered = snapshot.models.find(
                              (entry) => entry.id === model.id,
                            );
                            return discovered === undefined
                              ? row
                              : { ...row, model: { ...discovered } };
                          }),
                        );
                      }
                      setSelectedAvailableModels([]);
                      setModelSearch("");
                      setCatalogStatus(
                        snapshot.warning ??
                          (snapshot.source === "cache"
                            ? t(
                                "settingsView.officialCatalogIsUnchangedUsingTheLocalCache",
                              )
                            : snapshot.source === "remote"
                              ? t(
                                  "settingsView.officialMetadataUpdatedInTheDraftSaveProviderTo",
                                )
                              : null),
                      );
                    })
                    .catch((reason: unknown) =>
                      setValidationError(describeError(reason)),
                    )
                    .finally(() => setDiscovering(false));
                }}
              >
                {discovering
                  ? t("settingsView.fetchingModels")
                  : t("settingsView.getAvailableModels")}
              </button>
            ) : null}
          </div>
          {catalogStatus === null ? null : (
            <p className="model-catalog-status" role="status">
              {catalogStatus}
            </p>
          )}
          {availableModels === null ? null : (
            <section
              className="available-model-picker"
              aria-label={t("settingsView.availableModels")}
            >
              <h4>{t("settingsView.chooseModelsToAdd")}</h4>
              <p className="settings-note">
                {provider.type === "openai-subscription"
                  ? t(
                      "settingsView.chooseAdditionalModelsOfficialMetadataIsUpdatedInThe",
                    )
                  : t(
                      "settingsView.selectTheModelsYouWantExistingModelsAndTheir",
                    )}
              </p>
              {remainingModelSlots <= 10 ? (
                <p className="settings-note" role="status">
                  {remainingModelSlots === 0
                    ? i18n.t("settings:settingsView.modelLimitReached")
                    : t("settingsView.moreModels", {
                        count: remainingModelSlots,
                      })}
                </p>
              ) : null}
              <label className="field">
                <span>{t("settingsView.searchAvailableModels")}</span>
                <input
                  type="search"
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                />
              </label>
              <div className="available-model-list">
                {availableModels
                  .filter((model) =>
                    model.id
                      .toLowerCase()
                      .includes(modelSearch.trim().toLowerCase()),
                  )
                  .map((model) => {
                    const exists = modelIds.has(model.id);
                    const selected = selectedAvailableModelIds.has(model.id);
                    return (
                      <label className="available-model-option" key={model.id}>
                        <input
                          type="checkbox"
                          aria-label={t("settingsView.selectNamedModel", {
                            name: model.id,
                          })}
                          disabled={
                            exists ||
                            (!selected &&
                              selectedNewModels.length >= remainingModelSlots)
                          }
                          checked={exists || selected}
                          onChange={(event) =>
                            setSelectedAvailableModels((current) =>
                              event.target.checked
                                ? [...current, model.id]
                                : current.filter((id) => id !== model.id),
                            )
                          }
                        />
                        <span>{model.id}</span>
                        {exists ? (
                          <small>{t("settingsView.alreadyAdded")}</small>
                        ) : null}
                      </label>
                    );
                  })}
                {availableModels.every(
                  (model) =>
                    !model.id
                      .toLowerCase()
                      .includes(modelSearch.trim().toLowerCase()),
                ) ? (
                  <p className="settings-note">
                    {t("settingsView.noMatchingModels")}
                  </p>
                ) : null}
              </div>
              <div className="available-model-actions">
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => {
                    setAvailableModels(null);
                    setSelectedAvailableModels([]);
                  }}
                >
                  {t("settingsView.cancelSelection")}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={
                    selectedNewModels.length === 0 ||
                    selectedNewModels.length > remainingModelSlots
                  }
                  onClick={() => {
                    const additions = selectedNewModels.slice(
                      0,
                      remainingModelSlots,
                    );
                    setModelRows((current) => [
                      ...current,
                      ...additions
                        .slice(0, MAX_MODELS_PER_PROVIDER - current.length)
                        .map((model) => ({
                          key: globalThis.crypto.randomUUID(),
                          model: { ...model },
                        })),
                    ]);
                    setAvailableModels(null);
                    setSelectedAvailableModels([]);
                    setCatalogStatus(
                      t("settingsView.addedModels", {
                        count: additions.length,
                      }),
                    );
                  }}
                >
                  {t("settingsView.addSelectedModels")}
                  {selectedAvailableModels.length})
                </button>
              </div>
            </section>
          )}
          {modelRows.map(({ key, model }, index) => (
            <div className="provider-model-row" key={key}>
              <label className="field">
                <span>
                  {t("settingsView.modelNumber", { number: index + 1 })}
                </span>
                <input
                  id={fieldId("modelId", index)}
                  aria-invalid={issueFor("modelId", index) ? true : undefined}
                  aria-describedby={
                    issueFor("modelId", index)
                      ? `${fieldId("modelId", index)}-error`
                      : undefined
                  }
                  value={model.id}
                  onChange={(event) => {
                    const id = event.target.value;
                    updateModel(index, (current) => ({
                      ...current,
                      id,
                      displayName:
                        current.displayName === current.id
                          ? id
                          : current.displayName,
                      source: "manual",
                    }));
                  }}
                />
                {issueFor("modelId", index) === undefined ? null : (
                  <small
                    id={`${fieldId("modelId", index)}-error`}
                    className="provider-field-error"
                  >
                    {issueFor("modelId", index)}
                  </small>
                )}
              </label>
              <button
                className="quiet-button"
                type="button"
                aria-label={t("settingsView.removeModelNumber", {
                  number: index + 1,
                })}
                disabled={models.length === 1}
                onClick={() => {
                  setModelRows((current) =>
                    current.filter((_, candidate) => candidate !== index),
                  );
                  setValidationError(null);
                }}
              >
                {t("settingsView.remove")}
              </button>
              <ModelCapabilityEditor
                index={index}
                model={model}
                fieldId={(field) => fieldId(field, index)}
                issueFor={(field) => issueFor(field, index)}
                onChange={(next) => updateModel(index, () => next)}
                probing={probingModel === model.id}
                onProbe={
                  provider.type === "openai-compatible" &&
                  mode === "edit" &&
                  hasApiKey &&
                  initialProvider.models.some(
                    (entry) => entry.id === model.id,
                  ) &&
                  (model.inputModalities === null ||
                    (model.source === "discovered" &&
                      model.inputModalities.length === 1 &&
                      model.inputModalities[0] === "text"))
                    ? async () => {
                        setProbingModel(model.id);
                        setValidationError(null);
                        setCatalogStatus(
                          t(
                            "settingsView.sendingOneTinyImageTestRequestProviderChargesMay",
                          ),
                        );
                        try {
                          const result =
                            await window.zenx.settings.probeProviderImage(
                              provider.providerProfileId,
                              model.id,
                            );
                          updateModel(index, () => ({ ...result.model }));
                          setCatalogStatus(
                            result.outcome === "supported"
                              ? t(
                                  "settingsView.imageProbeSucceededSupportWasSaved",
                                )
                              : result.outcome === "unsupported"
                                ? t(
                                    "settingsView.providerExplicitlyRejectedImageInputUnsupportedWasSaved",
                                  )
                                : t(
                                    "settingsView.imageProbeWasInconclusiveCapabilityRemainsUnknown",
                                  ),
                          );
                        } catch (reason) {
                          setValidationError(describeError(reason));
                          setCatalogStatus(null);
                        } finally {
                          setProbingModel(null);
                        }
                      }
                    : undefined
                }
              />
            </div>
          ))}
          <button
            className="quiet-button add-model-button"
            type="button"
            id={fieldId("addModel")}
            disabled={remainingModelSlots === 0}
            onClick={() =>
              setModelRows((current) =>
                current.length >= MAX_MODELS_PER_PROVIDER
                  ? current
                  : [
                      ...current,
                      {
                        key: globalThis.crypto.randomUUID(),
                        model: manualModelCatalogEntry(""),
                      },
                    ],
              )
            }
          >
            {t("settingsView.addModel")}
          </button>
          {remainingModelSlots === 0 ? (
            <p className="settings-note" role="status">
              {t("settingsView.modelLimitReached1024RemoveAModelTo")}
            </p>
          ) : null}
        </fieldset>
        {replacesDefault ? (
          <ModelReferenceSelect
            label={t("settingsView.replacementDefaultModel")}
            placeholder={t("settingsView.selectAModel")}
            profiles={replacementProfiles}
            value={defaultReplacement}
            onChangeValue={setDefaultReplacement}
          />
        ) : null}
        {replacesTitle ? (
          <ModelReferenceSelect
            label={t("settingsView.replacementTitleModel")}
            placeholder={t("settingsView.selectAModel2")}
            profiles={replacementProfiles}
            value={titleReplacement}
            onChangeValue={setTitleReplacement}
          />
        ) : null}
        {logoSelectionError === null && validationError === null ? null : (
          <div className="settings-error provider-editor-error" role="alert">
            <Icon name="warning" />
            {logoSelectionError ?? validationError}
          </div>
        )}
        <div className="provider-editor-actions">
          <button className="quiet-button" type="button" onClick={onCancel}>
            {t("settingsView.cancel3")}
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || logoReading}
          >
            {busy
              ? mode === "add"
                ? t("settingsView.adding")
                : t("settingsView.saving")
              : mode === "add"
                ? t("settingsView.addProvider")
                : t("settingsView.saveProvider")}
          </button>
        </div>
      </form>
    </section>
  );
}

function ModelCapabilityEditor({
  index,
  model,
  fieldId,
  issueFor,
  onChange,
  onProbe,
  probing = false,
}: {
  index: number;
  model: ZenXModelCatalogEntry;
  fieldId(field: ProviderEditorIssue["field"]): string;
  issueFor(field: ProviderEditorIssue["field"]): string | undefined;
  onChange(model: ZenXModelCatalogEntry): void;
  onProbe?(): Promise<void>;
  probing?: boolean;
}) {
  const { t } = useTranslation("settings");
  const [configuringReasoning, setConfiguringReasoning] = useState(false);
  const savedReasoning = useRef<Pick<
    ZenXModelCatalogEntry,
    "supportedReasoningEfforts" | "defaultReasoningEffort"
  > | null>(null);
  const manual = (
    update: Partial<ZenXModelCatalogEntry>,
  ): ZenXModelCatalogEntry => ({ ...model, ...update, source: "manual" });
  const reasoningMode =
    model.reasoningConfiguration === "manual"
      ? "configured"
      : model.supportedReasoningEfforts === null
        ? "unknown"
        : model.supportedReasoningEfforts.length === 0
          ? configuringReasoning
            ? "configured"
            : "text-only"
          : "configured";
  return (
    <details className="provider-model-capabilities">
      <summary>{modelCapabilitySummary(model)}</summary>
      <div className="model-capability-grid">
        <Field
          label={t("settingsView.modelNumberDisplayName", {
            number: index + 1,
          })}
          value={model.displayName}
          onChange={(displayName) => onChange(manual({ displayName }))}
        />
        <Field
          label={t("settingsView.modelNumberDescription", {
            number: index + 1,
          })}
          value={model.description}
          onChange={(description) => onChange(manual({ description }))}
        />
        <label className="field">
          <span>
            {t("settingsView.modelNumberReasoningMetadata", {
              number: index + 1,
            })}
          </span>
          <Select
            value={reasoningMode}
            onValueChange={(value) => {
              const mode = value;
              if (model.supportedReasoningEfforts?.length)
                savedReasoning.current = {
                  supportedReasoningEfforts: model.supportedReasoningEfforts,
                  defaultReasoningEffort: model.defaultReasoningEffort,
                };
              setConfiguringReasoning(mode === "configured");
              onChange(
                manual(
                  mode === "unknown"
                    ? {
                        reasoningConfiguration: undefined,
                        supportedReasoningEfforts: null,
                        defaultReasoningEffort: null,
                      }
                    : mode === "text-only"
                      ? {
                          reasoningConfiguration: undefined,
                          supportedReasoningEfforts: [],
                          defaultReasoningEffort: null,
                        }
                      : {
                          reasoningConfiguration: "manual",
                          supportedReasoningEfforts: savedReasoning.current
                            ?.supportedReasoningEfforts ?? [
                            "low",
                            "medium",
                            "high",
                          ],
                          defaultReasoningEffort:
                            savedReasoning.current?.defaultReasoningEffort ??
                            "medium",
                        },
                ),
              );
            }}
          >
            <option value="unknown">{t("settingsView.unknown")}</option>
            <option value="text-only">
              {t("settingsView.noReasoningStrengthControl")}
            </option>
            <option value="configured">
              {t("settingsView.manualConfiguration")}
            </option>
          </Select>
        </label>
        {onProbe === undefined ? null : (
          <button
            className="quiet-button"
            type="button"
            disabled={probing}
            onClick={() => void onProbe()}
          >
            {probing
              ? t("settingsView.testingImageSupport")
              : t("settingsView.testImageSupport")}
          </button>
        )}
        {reasoningMode === "configured" ? (
          <>
            <Field
              id={fieldId("reasoningEfforts")}
              error={issueFor("reasoningEfforts")}
              label={t("settingsView.modelNumberReasoningEfforts", {
                number: index + 1,
              })}
              placeholder={t("settingsView.lowMediumHigh")}
              value={model.supportedReasoningEfforts?.join(", ") ?? ""}
              onChange={(value) =>
                onChange(
                  manual({
                    reasoningConfiguration: "manual",
                    supportedReasoningEfforts: commaSeparatedValues(value),
                  }),
                )
              }
            />
            <label className="field">
              <span>
                {t("settingsView.modelNumberDefaultReasoningEffort", {
                  number: index + 1,
                })}
              </span>
              <Select
                id={fieldId("defaultReasoningEffort")}
                aria-invalid={
                  issueFor("defaultReasoningEffort") ? true : undefined
                }
                aria-describedby={
                  issueFor("defaultReasoningEffort")
                    ? `${fieldId("defaultReasoningEffort")}-error`
                    : undefined
                }
                aria-label={t(
                  "settingsView.modelNumberDefaultReasoningEffort",
                  { number: index + 1 },
                )}
                value={model.defaultReasoningEffort ?? ""}
                onValueChange={(value) =>
                  onChange(
                    manual({
                      defaultReasoningEffort: value || null,
                    }),
                  )
                }
              >
                <option value="">{t("settingsView.chooseADefault")}</option>
                {[...new Set(model.supportedReasoningEfforts ?? [])].map(
                  (effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ),
                )}
              </Select>
              {issueFor("defaultReasoningEffort") === undefined ? null : (
                <small
                  id={`${fieldId("defaultReasoningEffort")}-error`}
                  className="provider-field-error"
                >
                  {issueFor("defaultReasoningEffort")}
                </small>
              )}
            </label>
          </>
        ) : null}
        <label className="field">
          <span>
            {t("settingsView.modelNumberInputModalities", {
              number: index + 1,
            })}
          </span>
          <Select
            value={inputModalityValue(model.inputModalities)}
            onValueChange={(value) =>
              onChange(
                manual({
                  inputModalities: inputModalities(value),
                }),
              )
            }
          >
            <option value="unknown">{t("settingsView.unknown2")}</option>
            <option value="text">{t("settingsView.text")}</option>
            <option value="text-image">{t("settingsView.textImage")}</option>
            <option value="image">{t("settingsView.imageOnly")}</option>
            <option value="none">{t("settingsView.knownUnsupported")}</option>
          </Select>
        </label>
        <label className="field">
          <span>
            {t("settingsView.modelNumberContextWindowRequired", {
              number: index + 1,
            })}
          </span>
          <input
            id={fieldId("contextWindow")}
            aria-invalid={issueFor("contextWindow") ? true : undefined}
            aria-describedby={
              issueFor("contextWindow")
                ? `${fieldId("contextWindow")}-error`
                : undefined
            }
            min="1"
            step="1"
            type="number"
            placeholder={t("settingsView.eG128000")}
            value={model.contextWindow ?? ""}
            onChange={(event) =>
              onChange(
                manual({
                  contextWindow:
                    event.target.value.length === 0
                      ? null
                      : Number(event.target.value),
                }),
              )
            }
          />
          <small className="provider-field-hint">
            {t("settingsView.useTheModelProviderSPublishedTokenLimit")}
          </small>
          {issueFor("contextWindow") === undefined ? null : (
            <small
              id={`${fieldId("contextWindow")}-error`}
              className="provider-field-error"
            >
              {issueFor("contextWindow")}
            </small>
          )}
        </label>
        <label className="model-hidden-control">
          <input
            type="checkbox"
            checked={model.hidden}
            onChange={(event) =>
              onChange(manual({ hidden: event.target.checked }))
            }
          />
          {t("settingsView.hideThisModelFromNormalSelection")}
        </label>
      </div>
    </details>
  );
}

function DeleteProviderPanel({
  busy,
  defaultModel,
  onCancel,
  onDelete,
  profiles,
  provider,
  titleModel,
}: {
  busy: boolean;
  defaultModel: ZenXModelReference;
  onCancel(): void;
  onDelete(
    replacements: ZenXProviderDeleteReplacements | undefined,
  ): Promise<"success" | "committed-error" | "failed">;
  profiles: readonly ZenXProviderProfile[];
  provider: ZenXProviderProfile;
  titleModel: ZenXModelReference;
}) {
  const { t } = useTranslation("settings");
  const [defaultReplacement, setDefaultReplacement] = useState("");
  const [titleReplacement, setTitleReplacement] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const remainingProfiles = profiles.filter(
    (candidate) => candidate.providerProfileId !== provider.providerProfileId,
  );
  const replacesDefault =
    defaultModel.providerProfileId === provider.providerProfileId;
  const replacesTitle =
    titleModel.providerProfileId === provider.providerProfileId;
  const hasReplacement = remainingProfiles.length > 0;
  return (
    <section
      className="page-card delete-provider-panel"
      aria-label={t("settingsView.deleteNamedProvider", {
        name: provider.displayName,
      })}
    >
      <div>
        <strong>
          {t("settingsView.delete2")} {provider.displayName}?
        </strong>
        <p>
          {t(
            "settingsView.removeThisProviderAndItsSavedCredentialsExistingConversations",
          )}
        </p>
      </div>
      {!hasReplacement ? (
        <div className="settings-error" role="alert">
          <Icon name="warning" />
          {t("settingsView.addAnotherProviderBeforeDeletingTheOnlyProfile")}
        </div>
      ) : null}
      {hasReplacement && replacesDefault ? (
        <ModelReferenceSelect
          autoFocus
          label={t("settingsView.replacementDefaultModel")}
          placeholder={t("settingsView.selectAModel3")}
          profiles={remainingProfiles}
          value={defaultReplacement}
          onChangeValue={(value) => {
            setDefaultReplacement(value);
            setValidationError(null);
          }}
        />
      ) : null}
      {hasReplacement && replacesTitle ? (
        <ModelReferenceSelect
          autoFocus={!replacesDefault}
          label={t("settingsView.replacementTitleModel")}
          placeholder={t("settingsView.selectAModel4")}
          profiles={remainingProfiles}
          value={titleReplacement}
          onChangeValue={(value) => {
            setTitleReplacement(value);
            setValidationError(null);
          }}
        />
      ) : null}
      {validationError === null ? null : (
        <div className="settings-error" role="alert">
          <Icon name="warning" />
          {validationError}
        </div>
      )}
      <div className="provider-editor-actions">
        <button className="quiet-button" type="button" onClick={onCancel}>
          {t("settingsView.cancel4")}
        </button>
        <button
          autoFocus={!replacesDefault && !replacesTitle}
          className="danger-button"
          type="button"
          disabled={busy || !hasReplacement}
          onClick={() => {
            const replacements: ZenXProviderDeleteReplacements = {};
            if (replacesDefault) {
              const reference = modelReferenceFromValue(
                defaultReplacement,
                remainingProfiles,
              );
              if (reference === undefined) {
                setValidationError(
                  t("settingsView.chooseAReplacementDefaultModel"),
                );
                return;
              }
              replacements.defaultModel = reference;
            }
            if (replacesTitle) {
              const reference = modelReferenceFromValue(
                titleReplacement,
                remainingProfiles,
              );
              if (reference === undefined) {
                setValidationError(
                  t("settingsView.chooseAReplacementTitleModel"),
                );
                return;
              }
              replacements.titleModel = reference;
            }
            void onDelete(
              replacesDefault || replacesTitle ? replacements : undefined,
            );
          }}
        >
          {busy ? t("settingsView.deleting") : t("settingsView.deleteProvider")}
        </button>
      </div>
    </section>
  );
}

function ModelReferenceSelect({
  autoFocus = false,
  label,
  onChange,
  onChangeValue,
  placeholder,
  profiles,
  value,
}: {
  autoFocus?: boolean;
  label: string;
  onChange?(value: ZenXModelReference): void;
  onChangeValue?(value: string): void;
  placeholder?: string;
  profiles: readonly ZenXProviderProfile[];
  value: ZenXModelReference | string;
}) {
  const serialized =
    typeof value === "string" ? value : modelReferenceValue(value);
  return (
    <label className="field model-reference-field">
      <span>{label}</span>
      <Combobox
        autoFocus={autoFocus}
        label={label}
        value={serialized}
        onValueChange={(value) => {
          if (onChangeValue !== undefined) {
            onChangeValue(value);
            return;
          }
          const reference = modelReferenceFromValue(value, profiles);
          if (reference !== undefined) onChange?.(reference);
        }}
      >
        {placeholder === undefined ? null : (
          <option value="">{placeholder}</option>
        )}
        {profiles.flatMap((profile) =>
          profile.models.filter(isRunnableModel).map((model) => {
            const reference = {
              providerProfileId: profile.providerProfileId,
              modelId: model.id,
            };
            return (
              <option
                key={modelReferenceValue(reference)}
                value={modelReferenceValue(reference)}
              >
                {profile.displayName} · {model.displayName}
              </option>
            );
          }),
        )}
      </Combobox>
    </label>
  );
}

interface ProviderEditorIssue {
  code:
    | "display_name_missing"
    | "model_id_missing"
    | "model_id_too_long"
    | "model_id_duplicate"
    | "reasoning_efforts_missing"
    | "reasoning_efforts_duplicate"
    | "reasoning_default_invalid"
    | "context_window_invalid"
    | "provider_name_missing"
    | "api_key_missing"
    | "base_url_invalid"
    | "base_url_scheme_invalid"
    | "base_url_credentials"
    | "base_url_query_fragment";
  field:
    | "displayName"
    | "addModel"
    | "modelId"
    | "reasoningEfforts"
    | "defaultReasoningEffort"
    | "contextWindow"
    | "providerName"
    | "apiKey"
    | "baseUrl";
  modelIndex?: number;
  message: string;
}

function validateProviderEditor(
  provider: ZenXProviderProfile,
  apiKey: string,
  mode: "add" | "edit",
  hasApiKey: boolean,
): ProviderEditorIssue[] {
  const issues: ProviderEditorIssue[] = [];
  if (provider.displayName.trim().length === 0)
    issues.push({
      code: "display_name_missing",
      field: "displayName",
      message: i18n.t("settings:settingsView.enterADisplayName"),
    });
  const seenModelIds = new Set<string>();
  if (provider.models.length === 0)
    issues.push({
      code: "model_id_missing",
      field: "addModel",
      message: i18n.t("settings:settingsView.addAtLeastOneModel"),
    });
  provider.models.forEach((model, modelIndex) => {
    const shortModelId =
      model.id.length > 48 ? `${model.id.slice(0, 45)}…` : model.id;
    const row = i18n.t("settings:settingsView.modelRow", {
      number: modelIndex + 1,
      id: shortModelId || i18n.t("settings:settingsView.noId"),
    });
    if (model.id.length === 0) {
      issues.push({
        code: "model_id_missing",
        field: "modelId",
        modelIndex,
        message: i18n.t("settings:settingsView.modelNumberEnterId", {
          number: modelIndex + 1,
        }),
      });
    } else if (model.id.length > 512) {
      issues.push({
        code: "model_id_too_long",
        field: "modelId",
        modelIndex,
        message: i18n.t("settings:settingsView.modelNumberIdTooLong", {
          number: modelIndex + 1,
        }),
      });
    } else if (seenModelIds.has(model.id)) {
      issues.push({
        code: "model_id_duplicate",
        field: "modelId",
        modelIndex,
        message: i18n.t("settings:settingsView.modelRowUniqueId", { row }),
      });
    }
    seenModelIds.add(model.id);
    if (model.reasoningConfiguration === "manual") {
      if (!model.supportedReasoningEfforts?.length) {
        issues.push({
          code: "reasoning_efforts_missing",
          field: "reasoningEfforts",
          modelIndex,
          message: i18n.t("settings:settingsView.modelRowNeedReasoning", {
            row,
          }),
        });
      } else if (
        new Set(model.supportedReasoningEfforts).size !==
        model.supportedReasoningEfforts.length
      ) {
        issues.push({
          code: "reasoning_efforts_duplicate",
          field: "reasoningEfforts",
          modelIndex,
          message: i18n.t("settings:settingsView.modelRowUniqueReasoning", {
            row,
          }),
        });
      } else if (
        !model.supportedReasoningEfforts.includes(
          model.defaultReasoningEffort ?? "",
        )
      ) {
        issues.push({
          code: "reasoning_default_invalid",
          field: "defaultReasoningEffort",
          modelIndex,
          message: i18n.t("settings:settingsView.modelRowDefaultReasoning", {
            row,
          }),
        });
      }
    }
    if (
      model.contextWindow === null ||
      !Number.isSafeInteger(model.contextWindow) ||
      model.contextWindow <= 0
    ) {
      issues.push({
        code: "context_window_invalid",
        field: "contextWindow",
        modelIndex,
        message: i18n.t("settings:settingsView.modelRowPositiveContext", {
          row,
        }),
      });
    }
  });
  if (provider.type !== "openai-compatible") return issues;
  if (provider.name.trim().length === 0)
    issues.push({
      code: "provider_name_missing",
      field: "providerName",
      message: i18n.t("settings:settingsView.enterAProviderName"),
    });
  if (mode === "add" && apiKey.trim().length === 0)
    issues.push({
      code: "api_key_missing",
      field: "apiKey",
      message: i18n.t("settings:settingsView.enterAnApiKey"),
    });
  if (mode === "edit" && !hasApiKey && apiKey.trim().length === 0) {
    issues.push({
      code: "api_key_missing",
      field: "apiKey",
      message: i18n.t(
        "settings:settingsView.enterAnApiKeyBecauseThisProfileHasNo",
      ),
    });
  }
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    issues.push({
      code: "base_url_invalid",
      field: "baseUrl",
      message: i18n.t("settings:settingsView.enterAValidBaseUrl"),
    });
    return issues;
  }
  const loopbackHttp =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !loopbackHttp) {
    issues.push({
      code: "base_url_scheme_invalid",
      field: "baseUrl",
      message: i18n.t(
        "settings:settingsView.baseUrlMustUseHttpsLoopbackHttpIsAllowed",
      ),
    });
  } else if (url.username.length > 0 || url.password.length > 0) {
    issues.push({
      code: "base_url_credentials",
      field: "baseUrl",
      message: i18n.t("settings:settingsView.removeCredentialsFromTheBaseUrl"),
    });
  } else if (url.search.length > 0 || url.hash.length > 0) {
    issues.push({
      code: "base_url_query_fragment",
      field: "baseUrl",
      message: i18n.t(
        "settings:settingsView.removeTheQueryOrFragmentFromTheBaseUrl",
      ),
    });
  }
  return issues;
}

function providerStatus(
  provider: ZenXProviderProfile,
  settings: PublicHostSettings,
): { className: "status-good" | "status-muted"; label: string } {
  if (provider.type === "fake") {
    return {
      className: "status-muted",
      label: i18n.t("settings:settingsView.localTesting"),
    };
  }
  if (provider.type === "openai-subscription") {
    return settings.subscription.authenticated
      ? {
          className: "status-good",
          label: i18n.t("settings:settingsView.signedIn"),
        }
      : {
          className: "status-muted",
          label: i18n.t("settings:settingsView.notSignedIn"),
        };
  }
  return settings.apiKeyProviderProfileIds.includes(provider.providerProfileId)
    ? {
        className: "status-muted",
        label: i18n.t("settings:settingsView.apiKeySaved"),
      }
    : {
        className: "status-muted",
        label: i18n.t("settings:settingsView.apiKeyNotSaved"),
      };
}

function providerTypeLabel(provider: ZenXProviderProfile): string {
  if (provider.type === "fake")
    return i18n.t("settings:settingsView.localDemo");
  if (provider.type === "openai-subscription")
    return i18n.t("settings:settingsView.openaiSubscription");
  return i18n.t("settings:settingsView.openaiCompatibleApi");
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function providerLogoKind(provider: ZenXProviderProfile) {
  if (provider.type === "fake") return "local";
  if (provider.type === "openai-subscription") return "openai";
  return providerLogoKindForIdentity(provider.name, provider.displayName);
}

function modelReferenceValue(reference: ZenXModelReference): string {
  return JSON.stringify([reference.providerProfileId, reference.modelId]);
}

function modelReferenceFromValue(
  value: string,
  profiles: readonly ZenXProviderProfile[],
): ZenXModelReference | undefined {
  return profiles
    .flatMap((profile) =>
      profile.models.map((model) => ({
        providerProfileId: profile.providerProfileId,
        modelId: model.id,
      })),
    )
    .find((reference) => modelReferenceValue(reference) === value);
}

function modelReferenceExists(
  reference: ZenXModelReference,
  profiles: readonly ZenXProviderProfile[],
): boolean {
  return profiles.some(
    (profile) =>
      profile.providerProfileId === reference.providerProfileId &&
      profile.models.some((model) => model.id === reference.modelId),
  );
}

function isRunnableModel(model: ZenXModelCatalogEntry): boolean {
  return (
    model.contextWindow !== null &&
    model.supportedReasoningEfforts !== null &&
    ((model.defaultReasoningEffort !== null &&
      model.supportedReasoningEfforts.includes(model.defaultReasoningEffort)) ||
      (model.defaultReasoningEffort === null &&
        model.supportedReasoningEfforts.length === 0)) &&
    model.inputModalities !== null &&
    model.inputModalities.includes("text")
  );
}

function AppearancePanel() {
  const { t } = useTranslation("settings");
  const appearanceController = getAppearanceController();
  const [appearance, setAppearance] = useState<AppearancePreference>(() =>
    appearanceController.getPreference(),
  );
  const updateAppearance = (patch: Partial<AppearancePreference>) => {
    const next = { ...appearance, ...patch };
    appearanceController.setPreference(next);
    setAppearance(next);
  };
  const appearanceIsDefault =
    JSON.stringify(appearance) ===
    JSON.stringify(DEFAULT_APPEARANCE_PREFERENCE);
  return (
    <>
      <header>
        <h2>{t("settingsView.appearance")}</h2>
        <p>{t("settingsView.themeColorAndContrast")}</p>
      </header>
      <div className="page-card settings-card appearance-settings-card">
        <div className="settings-card-head">
          <div>
            <h3>{t("settingsView.themeAndColor")}</h3>
            <p>
              {t("settingsView.chooseHowZenxFeelsWhileKeepingEverySurfaceIn")}
            </p>
          </div>
          <span className="status-muted">{t("settingsView.local")}</span>
        </div>
        <fieldset className="appearance-options appearance-mode-options">
          <legend className="sr-only">
            {t("settingsView.appearanceMode")}
          </legend>
          {APPEARANCE_MODES.map((option: AppearanceMode) => (
            <label key={option}>
              <input
                type="radio"
                name="appearance-mode"
                value={option}
                checked={appearance.mode === option}
                onChange={() => updateAppearance({ mode: option })}
              />
              <span>{option[0]?.toUpperCase() + option.slice(1)}</span>
            </label>
          ))}
        </fieldset>
        <div
          className="appearance-preview"
          role="img"
          aria-label={t("settingsView.liveAppearancePreview")}
        >
          <div className="appearance-preview-sidebar">
            <span />
            <span />
            <span />
          </div>
          <div className="appearance-preview-content">
            <span className="appearance-preview-heading" />
            <span />
            <span />
            <span className="appearance-preview-accent">
              {t("settingsView.accent")}
            </span>
          </div>
        </div>
        <div className="appearance-editor-grid">
          <PresetFieldset
            label={t("settingsView.lightPreset")}
            name="light-preset"
            value={appearance.lightPreset}
            onChange={(lightPreset) => updateAppearance({ lightPreset })}
          />
          <PresetFieldset
            label={t("settingsView.darkPreset")}
            name="dark-preset"
            value={appearance.darkPreset}
            onChange={(darkPreset) => updateAppearance({ darkPreset })}
          />
        </div>
        <fieldset className="appearance-accent-group">
          <legend>{t("settingsView.accent2")}</legend>
          <div className="appearance-accent-options">
            {APPEARANCE_ACCENTS.map((option: AppearanceAccent) => (
              <label key={option}>
                <input
                  type="radio"
                  name="appearance-accent"
                  value={option}
                  checked={appearance.accent === option}
                  onChange={() => updateAppearance({ accent: option })}
                />
                <span className={`accent-chip ${option}`}>
                  <i aria-hidden="true" />
                  <span>
                    <strong>{appearanceLabel(option)}</strong>
                    <small>{t(appearanceAccentIntent[option])}</small>
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="appearance-control-list">
          <fieldset className="appearance-control-row">
            <legend>{t("settingsView.contrast")}</legend>
            <div className="appearance-inline-options compact">
              {APPEARANCE_CONTRASTS.map((option: AppearanceContrast) => (
                <label key={option}>
                  <input
                    type="radio"
                    name="appearance-contrast"
                    value={option}
                    checked={appearance.contrast === option}
                    onChange={() => updateAppearance({ contrast: option })}
                  />
                  <span>{appearanceLabel(option)}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <div className="appearance-card-footer">
          <p className="settings-note">
            {t(
              "settingsView.changesApplyImmediatelySystemFollowsYourOperatingSystemLight",
            )}
          </p>
          <button
            className="secondary-button"
            type="button"
            disabled={appearanceIsDefault}
            onClick={() => {
              appearanceController.reset();
              setAppearance(appearanceController.getPreference());
            }}
          >
            {t("settingsView.resetAppearance")}
          </button>
        </div>
      </div>
    </>
  );
}

function GeneralPanel({
  draft,
  setDraft,
}: {
  draft: ZenXHostProfile;
  setDraft(value: ZenXHostProfile): void;
}) {
  const { t } = useTranslation("settings");
  const [maximumInput, setMaximumInput] = useState(
    draft.maxToolRounds?.toString() ?? "",
  );
  const [maximumError, setMaximumError] = useState<string | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  useEffect(() => {
    setMaximumInput(draft.maxToolRounds?.toString() ?? "");
  }, [draft.maxToolRounds]);
  return (
    <>
      <header>
        <h2>{t("settingsView.general")}</h2>
        <p>{t("settingsView.chooseHowZenxWorksWithYouAndYourProjects")}</p>
      </header>
      <LanguageSettings />
      <section className="settings-card">
        <h3>{t("settingsView.interaction")}</h3>{" "}
        <label className="field">
          <span id="composer-send-label">
            {t("settingsView.sendWhileAReplyIsRunning")}
          </span>
          <Select
            aria-labelledby="composer-send-label"
            value={draft.composerSendMode ?? "soft"}
            onValueChange={(value) =>
              setDraft({
                ...draft,
                composerSendMode: value as "batch" | "queue" | "soft" | "hard",
                composerSendModeExplicit: true,
                ...(draft.composerSendModeMigration === undefined
                  ? {}
                  : {
                      composerSendModeMigration: {
                        ...draft.composerSendModeMigration,
                        acknowledged: true,
                      },
                    }),
              })
            }
            aria-describedby="composer-send-help"
          >
            <option value="batch">
              {t("settingsView.sendQueuedMessagesTogether")}
            </option>
            <option value="queue">
              {t("settingsView.runEachQueuedMessageSeparately")}
            </option>
            <option value="soft">
              {t("settingsView.guideTheCurrentReplyDefault")}
            </option>
            <option value="hard">{t("settingsView.interruptAndSend")}</option>
          </Select>
          <small id="composer-send-help" className="settings-note">
            {t("settingsView.enterAndTheSendButtonUseThisChoiceCmd")}
          </small>
        </label>
      </section>
      <div className="page-card settings-card">
        <div className="settings-card-head">
          <div>
            <h3>{t("settingsView.foregroundComputerControl")}</h3>
            <p>
              {t("settingsView.highImpactAccessToTheDesktopYouAreActively")}
            </p>
          </div>
          <span className="status-muted">
            {draft.computerForegroundControlEnabled === true
              ? t("settingsView.optedIn")
              : t("settingsView.blocked")}
          </span>
        </div>
        <div className="settings-row">
          <div>
            <strong>{t("settingsView.allowForegroundTakeover")}</strong>
            <span>
              {t("settingsView.thisLetsZenxAgentsMoveThePointerTypeKeys")}
            </span>
          </div>
          <button
            className="plugin-switch"
            type="button"
            role="switch"
            aria-label={t("settingsView.allowForegroundComputerControl")}
            aria-checked={draft.computerForegroundControlEnabled === true}
            onClick={() =>
              setDraft({
                ...draft,
                computerForegroundControlEnabled:
                  draft.computerForegroundControlEnabled !== true,
              })
            }
          />
        </div>
        <p className="settings-note">
          {t(
            "settingsView.offByDefaultBrowserAutomationAndBackgroundSafeComputer",
          )}
        </p>
      </div>
      <div className="page-card settings-card">
        <h3>{t("settingsView.executionAndPermissions")}</h3>
        <div className="form-grid">
          <div className="field wide">
            <span>{t("settingsView.defaultProject")}</span>
            <div
              className="readonly-field"
              title={draft.workspace ?? undefined}
            >
              {draft.workspace ?? t("settingsView.noProjectConfigured")}
            </div>
          </div>
          <label className="field">
            <span>{t("settingsView.approvalPolicy")}</span>
            <Select
              value={draft.approvalPolicy}
              onValueChange={(value) =>
                setDraft({
                  ...draft,
                  approvalPolicy: value as "always" | "never",
                })
              }
            >
              <option value="always">
                {t("settingsView.approvalRequired")}
              </option>
              <option value="never">{t("settingsView.fullAccess")}</option>
            </Select>
          </label>

          <label className="field">
            <span id="tool-presentation-label">
              {t("settingsView.toolPresentation")}
            </span>
            <Select
              aria-labelledby="tool-presentation-label"
              aria-describedby="tool-presentation-help"
              value={draft.toolPresentation ?? "both"}
              onValueChange={(value) =>
                setDraft({
                  ...draft,
                  toolPresentation: value as "direct" | "code" | "both",
                })
              }
            >
              <option value="both">
                {t("settingsView.directAndCodeRecommended")}
              </option>
              <option value="direct">
                {t("settingsView.directToolsOnly")}
              </option>
              <option value="code">{t("settingsView.codeOnly")}</option>
            </Select>
            <small id="tool-presentation-help" className="settings-note">
              {t("settingsView.chooseHowAgentsUseToolsCallThemDirectlyWrite")}
            </small>
          </label>
          <label className="field">
            <span id="max-tool-rounds-label">
              {t("settingsView.maximumToolRounds")}
            </span>
            <input
              aria-labelledby="max-tool-rounds-label"
              type="number"
              min="1"
              step="1"
              value={maximumInput}
              aria-describedby={
                maximumError === null
                  ? "max-tool-rounds-help"
                  : "max-tool-rounds-help max-tool-rounds-error"
              }
              aria-invalid={maximumError === null ? undefined : true}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setMaximumInput(value);
                if (value === "") {
                  setMaximumError(null);
                  setDraft({ ...draft, maxToolRounds: undefined });
                  return;
                }
                if (!/^\d+$/u.test(value)) return;
                const maximum = Number(value);
                if (!Number.isSafeInteger(maximum) || maximum < 1) return;
                setMaximumError(null);
                setDraft({ ...draft, maxToolRounds: maximum });
              }}
              onBlur={() => {
                if (
                  maximumInput !== "" &&
                  (!/^\d+$/u.test(maximumInput) ||
                    !Number.isSafeInteger(Number(maximumInput)) ||
                    Number(maximumInput) < 1)
                ) {
                  setMaximumError(t("settingsView.enterAWholeNumberOf1OrMore"));
                }
              }}
            />
            {maximumError === null ? null : (
              <small id="max-tool-rounds-error" className="form-error">
                {maximumError}
              </small>
            )}
            <small id="max-tool-rounds-help" className="settings-note">
              {t("settingsView.leaveBlankForUnlimitedStopAReplyAfterThis")}
            </small>
          </label>
        </div>

        <p className="settings-note">
          {t("settingsView.manageProjectsFromTheSidebar")}
        </p>
        <p className="settings-note">
          {t("settingsView.defaultsApplyToNewRepliesRunningRepliesKeepTheir")}
        </p>
        <div className="settings-row">
          <div>
            <strong>{t("settingsView.localDiagnostics")}</strong>
            <span>
              {t("settingsView.storedOnThisDeviceAndNeverSharedAutomatically")}
            </span>
          </div>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              setDiagnosticsError(null);
              void window.zenx.settings
                .openDiagnosticsFolder()
                .catch(() =>
                  setDiagnosticsError(
                    t("settingsView.couldNotOpenDiagnosticsFolder"),
                  ),
                );
            }}
          >
            {t("settingsView.openDiagnosticsFolder")}
          </button>
        </div>
        {diagnosticsError === null ? null : (
          <p className="settings-error" role="alert">
            {diagnosticsError}
          </p>
        )}
      </div>
    </>
  );
}

const appearancePresetIntent: Record<AppearancePreset, string> = {
  graphite: "settingsView.neutral",
  cobalt: "settingsView.cool",
  ember: "settingsView.warm",
};

const appearanceAccentIntent: Record<AppearanceAccent, string> = {
  azure: "settingsView.clearBlue",
  iris: "settingsView.softViolet",
  jade: "settingsView.freshGreen",
};

function PresetFieldset({
  label,
  name,
  onChange,
  value,
}: {
  label: string;
  name: "light-preset" | "dark-preset";
  onChange(value: AppearancePreset): void;
  value: AppearancePreset;
}) {
  const { t } = useTranslation("settings");
  return (
    <fieldset className="appearance-preset-group">
      <legend>{label}</legend>
      <div className="appearance-preset-options">
        {APPEARANCE_PRESETS.map((option: AppearancePreset) => (
          <label key={option}>
            <input
              type="radio"
              name={name}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            <span>
              <strong>{appearanceLabel(option)}</strong>
              <small>{t(appearancePresetIntent[option])}</small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function appearanceLabel(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function legacyModelCatalogEntry(id: string): ZenXModelCatalogEntry {
  return {
    id,
    displayName: id,
    description: "",
    hidden: false,
    supportedReasoningEfforts: ["medium"],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    // The fake adapter uses a synthetic local ceiling, not provider metadata.
    contextWindow: 16_384,
    source: "legacy",
  };
}

function subscriptionModelCatalogEntries(): ZenXModelCatalogEntry[] {
  return builtInModelCatalogPreset("openai-subscription").map((entry) => ({
    id: entry.id,
    displayName: entry.displayName ?? entry.id,
    description: entry.description ?? "",
    hidden: entry.hidden ?? false,
    supportedReasoningEfforts: entry.supportedReasoningEfforts ?? null,
    defaultReasoningEffort: entry.defaultReasoningEffort ?? null,
    inputModalities: entry.inputModalities ?? null,
    contextWindow: entry.contextWindow ?? null,
    source: entry.source ?? "preset",
  }));
}

function manualModelCatalogEntry(id: string): ZenXModelCatalogEntry {
  return {
    id,
    displayName: id,
    description: "",
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ["text"],
    contextWindow: null,
    source: "manual",
  };
}

function normalizedDraftModel(
  model: ZenXModelCatalogEntry,
): ZenXModelCatalogEntry {
  const id = model.id.trim();
  return {
    ...model,
    id,
    displayName: model.displayName.trim() || id,
    description: model.description.trim(),
    supportedReasoningEfforts:
      model.supportedReasoningEfforts?.map((effort) => effort.trim()) ?? null,
    defaultReasoningEffort: model.defaultReasoningEffort?.trim() || null,
  };
}

function commaSeparatedValues(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function inputModalityValue(
  modalities: ZenXModelCatalogEntry["inputModalities"],
): "unknown" | "none" | "text" | "image" | "text-image" {
  if (modalities === null) return "unknown";
  if (modalities.length === 0) return "none";
  if (modalities.length === 2) return "text-image";
  return modalities[0] === "image" ? "image" : "text";
}

function inputModalities(
  value: string,
): ZenXModelCatalogEntry["inputModalities"] {
  if (value === "unknown") return null;
  if (value === "none") return [];
  if (value === "text-image") return ["text", "image"];
  return value === "image" ? ["image"] : ["text"];
}

function modelCapabilitySummary(model: ZenXModelCatalogEntry): string {
  const reasoning =
    model.supportedReasoningEfforts === null
      ? i18n.t("settings:settingsView.reasoningUnknown")
      : model.supportedReasoningEfforts.length === 0
        ? i18n.t("settings:settingsView.noReasoningStrengthControl2")
        : model.supportedReasoningEfforts.join(" / ");
  const modalities =
    model.inputModalities === null
      ? i18n.t("settings:settingsView.inputUnknown")
      : model.inputModalities.length === 0
        ? i18n.t("settings:settingsView.noInputModalities")
        : model.inputModalities.join(" + ");
  const context =
    model.contextWindow === null
      ? i18n.t("settings:settingsView.contextRequired")
      : i18n.t("settings:settingsView.contextTokens", {
          value: model.contextWindow.toLocaleString(i18n.resolvedLanguage),
        });
  return `${reasoning} · ${modalities} · ${context}`;
}

function Field({
  autoFocus = false,
  error,
  id,
  label,
  value,
  onChange,
  placeholder,
  secret = false,
  wide = false,
}: {
  autoFocus?: boolean;
  error?: string;
  id?: string;
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  secret?: boolean;
  wide?: boolean;
}) {
  return (
    <label className={`field${wide ? " wide" : ""}`}>
      <span>{label}</span>
      <input
        autoFocus={autoFocus}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error && id ? `${id}-error` : undefined}
        type={secret ? "password" : "text"}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {error === undefined || id === undefined ? null : (
        <small id={`${id}-error`} className="provider-field-error">
          {error}
        </small>
      )}
    </label>
  );
}

function ManualCode() {
  const { t } = useTranslation("settings");
  const [value, setValue] = useState("");
  return (
    <div className="manual-code">
      <label className="field">
        <span>{t("settingsView.authorizationCodeOrRedirectUrl")}</span>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={!value.trim()}
        onClick={() => void window.zenx.settings.submitManualCode(value)}
      >
        {t("settingsView.continue")}
      </button>
    </div>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function configurationSaveMessage(value: PublicHostSettings): string {
  const result = value.configuration;
  if (!result) return i18n.t("settings:settingsView.settingsSaved");
  switch (result.status) {
    case "unchanged":
      return i18n.t("settings:settingsView.noChanges");
    case "applied":
      return i18n.t(
        "settings:settingsView.changesAppliedRunningTurnsKeepTheirCurrentConfiguration",
      );
    case "pending-restart":
      return i18n.t("settings:settingsView.savedPendingRestart", {
        fields: result.pendingRestart.join(", "),
      });
    case "unconfirmed":
      return i18n.t(
        "settings:settingsView.savedApplicationNotYetConfirmedCheckApplicationStatusBefore",
      );
  }
}

// Actionable configuration states already have persistent notices and controls.
function configurationSaveToast(value: PublicHostSettings): string | null {
  if (value.configuration && value.configuration.status !== "applied")
    return null;
  return i18n.t("settings:settingsView.settingsSaved");
}
