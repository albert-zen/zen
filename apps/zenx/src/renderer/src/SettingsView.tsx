import { SkillsSettingsPanel } from "./SkillsSettingsPanel.js";
import { Select, Combobox } from "./ui/controls.js";
import { SubscriptionUsageCard } from "./SubscriptionUsageCard.js";
import { RtkSettingsCard } from "./RtkSettingsCard.js";
import { Activity, useEffect, useId, useRef, useState } from "react";
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

export type SettingsTab =
  | "account"
  | "models"
  | "plugins"
  | "appearance"
  | "general"
  | "compaction"
  | "skills"
  | "workflows"
  | "archived";

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
        composerSendMode: draft.composerSendMode ?? "queue",
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
          <p>{error ?? "Loading local settings…"}</p>
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
    JSON.stringify({ ...draft, composerSendMode: undefined }) ===
      JSON.stringify({ ...settings.profile, composerSendMode: undefined });
  const tabs: Array<{
    id: SettingsTab;
    label: string;
    icon: IconName;
  }> = [
    { id: "account", label: "Account", icon: "users" },
    { id: "models", label: "Models & provider", icon: "chip" },
    { id: "plugins", label: "Plugins", icon: "trigger" },
    { id: "appearance", label: "Appearance", icon: "moon" },
    { id: "general", label: "General", icon: "settings" },
    { id: "compaction", label: "Context compaction", icon: "compress" },
    { id: "skills", label: "Skills", icon: "book" },
    { id: "workflows", label: "Workflows", icon: "compose" },
    { id: "archived", label: "Archived threads", icon: "archive" },
  ];
  return (
    <section
      hidden={!active}
      inert={!active}
      className={`product-page settings-view${showHeader ? "" : " settings-view-embedded"}`}
      aria-label="ZenX settings"
    >
      {showHeader ? (
        <header className="page-header">
          <div className="page-title">
            <button
              className="icon-button mobile-menu"
              type="button"
              aria-label="Open sidebar"
              onClick={onOpenSidebar}
            >
              <Icon name="tree" />
            </button>
            <div>
              <h1>Settings</h1>
              <p>Make ZenX your own</p>
            </div>
          </div>
        </header>
      ) : null}
      <div className="page-scroll">
        <div className="settings-layout">
          <nav
            ref={navRef}
            className="settings-nav"
            role="tablist"
            aria-label="Settings sections"
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
                    <h2>Plugins</h2>
                    <p>
                      Install, update, disable, or remove trusted packages.
                      Uninstall keeps plugin data until you explicitly delete
                      it.
                    </p>
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
                  Check application status
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
                  Retry applying saved settings
                </button>
              </div>
            ) : null}
            {settings.configuration?.pendingRestart.length ? (
              <div className="settings-note" role="status">
                <p>
                  Saved ·{" "}
                  {settings.configuration.pendingRestart
                    .map((domain) =>
                      domain === "experimentalRtk"
                        ? "Compact shell output"
                        : domain,
                    )
                    .join(", ")}{" "}
                  takes effect next launch
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
                  Safe restart
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
  return (
    <div className={`settings-apply-bar${dirty ? " dirty" : ""}`}>
      <div>
        <strong>{requiresRestart ? "App settings" : "Message sending"}</strong>
        <span>
          {dirty
            ? requiresRestart
              ? "Unsaved changes across settings. Running turns keep their current configuration."
              : "Unsaved sending preference. Running turns continue uninterrupted."
            : "Your settings are up to date."}
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
            ? "Applying…"
            : "Apply"
          : busy
            ? "Applying…"
            : "Apply"}
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
        <h2>Archived threads</h2>
        <p>
          Archived conversations remain canonical Threads. Restore one to return
          it to the active Sidebar.
        </p>
      </header>
      {loading ? (
        <div className="settings-empty" role="status">
          Loading archived Threads…
        </div>
      ) : error !== null ? (
        <div className="settings-empty settings-error" role="alert">
          <span>{error}</span>
          <button className="quiet-button" type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : threads.length === 0 ? (
        <div className="settings-empty">
          No archived Threads. Conversations you archive will appear here.
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
                ? "Unavailable journal"
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
                  {busy ? "Restoring…" : "Unarchive"}
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
        <h2>Account</h2>
        <p>
          Credentials remain in the local ZenX vault and never enter the Thread
          Item stream.
        </p>
      </header>
      <div className="page-card settings-card">
        <div className="settings-card-head">
          <div>
            <h3>OpenAI subscription</h3>
            <p>
              Use an authenticated ChatGPT subscription for ZenX model access.
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
              ? "No profile configured"
              : settings.subscription.authenticated
                ? "Signed in"
                : "Not signed in"}
          </span>
        </div>
        <div className="settings-row">
          <div>
            <strong>
              {settings.subscription.accountId ?? "No account connected"}
            </strong>
            <span>
              {!subscriptionConfigured
                ? "Add an OpenAI subscription profile from Models & providers to connect an account."
                : settings.subscription.authenticated
                  ? "Authentication is stored in the operating system credential boundary."
                  : "Sign in to use the configured subscription profile."}
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
              Sign out
            </button>
          ) : (
            <button
              className="primary-button"
              type="button"
              disabled={busy !== null}
              onClick={login}
            >
              {busy === "login"
                ? "Waiting for browser…"
                : "Sign in with OpenAI"}
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
      <div className="page-card settings-card">
        <div className="settings-row">
          <div>
            <strong>Privacy boundary</strong>
            <span>
              Thread history stores only effective runtime settings.
              Subscription identity and provider secrets remain outside
              canonical Items.
            </span>
          </div>
          <Icon name="lock" />
        </div>
      </div>
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
            `Settings were saved, but finalization failed: ${originalError}`,
          );
          return "committed-error";
        }
        setError(originalError);
      } catch (reconciliationReason) {
        setError(
          `Settings mutation failed: ${originalError}. Authoritative state could not be reconciled: ${describeError(reconciliationReason)}. Outcome is unknown.`,
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
            "Provider settings were saved, but applying them is unconfirmed. Check application status before using the provider.",
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
          "Provider settings were saved, but finalization failed. Check application status before using the provider.",
        );
        return "committed-error";
      }
      const messageByCode = {
        "revision-conflict":
          "Another window changed settings. This provider was not saved. Your edits are still here; reload settings before trying again.",
        "validation-rejected":
          "This provider was not saved. Review its connection and model fields, then try again.",
        "save-rejected":
          "This provider was not saved. Check application status, then try again.",
        "save-finalization-failed":
          "Provider settings were saved, but finalization failed. Check application status before using the provider.",
        "save-unconfirmed":
          "Could not confirm whether this provider was saved. Check application status before trying again.",
      } as const;
      setError(messageByCode[reply.code]);
      return "failed";
    } catch {
      setError(
        "Could not confirm whether this provider was saved. Check application status before trying again.",
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
            displayName: "Local demo",
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
        <h2>Models & providers</h2>
        <p>
          Connect your providers and choose the models you want to work with.
        </p>
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
            <h3>Default models</h3>
            <p>
              Choose a model for new conversations and another for naming them.
            </p>
          </div>
          <span className="status-muted">New work</span>
        </div>
        <div className="form-grid">
          <ModelReferenceSelect
            label="Default model"
            profiles={settings.profile.providerProfiles}
            value={draft.defaultModel}
            onChange={(defaultModel) => setDraft({ ...draft, defaultModel })}
          />
          <ModelReferenceSelect
            label="Title model"
            profiles={settings.profile.providerProfiles}
            value={draft.titleModel}
            onChange={(titleModel) => setDraft({ ...draft, titleModel })}
          />
        </div>
        <p className="settings-note">
          Existing conversations keep their model. You can change it from the
          message box at any time.
        </p>
      </div>
      <section
        className="provider-section"
        aria-labelledby="provider-list-title"
      >
        <div className="provider-section-head">
          <div>
            <h3 id="provider-list-title">Provider profiles</h3>
            <p>Manage each connection and its available models.</p>
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
                Add provider
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => openAddEditor("openai-compatible")}
              >
                Add custom provider
              </button>
            </div>
          ) : null}
        </div>
        {showAddChoices && editor === null ? (
          <div className="page-card provider-add-choices">
            <div>
              <strong>Add a known Provider</strong>
              <span>
                Choose a built-in connection preset. Custom APIs use the
                separate custom flow.
              </span>
            </div>
            <button
              type="button"
              aria-label="Add OpenAI subscription"
              onClick={() => openAddEditor("openai-subscription")}
              disabled={settings.profile.providerProfiles.some(
                (provider) => provider.type === "openai-subscription",
              )}
            >
              <ProviderLogo kind="openai" />
              <strong>OpenAI subscription</strong>
              <span>
                {settings.profile.providerProfiles.some(
                  (provider) => provider.type === "openai-subscription",
                )
                  ? "One subscription account is already configured"
                  : "Uses the sign-in managed in Account"}
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
                  aria-label={`Add ${preset.displayName}`}
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
                      ? "This built-in Provider is already configured"
                      : "OpenAI-compatible API preset"}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              aria-label="Add Local demo"
              onClick={() => openAddEditor("fake")}
            >
              <ProviderLogo kind="local" />
              <strong>Local demo</strong>
              <span>Deterministic fake/dev Provider for local testing</span>
            </button>
            <button
              className="quiet-button provider-choice-cancel"
              type="button"
              onClick={() => setShowAddChoices(false)}
            >
              Cancel
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
                editor.mode === "add" ? "Provider added" : "Provider saved",
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
                "Provider deleted",
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
        aria-label={`${provider.displayName} global roles`}
      >
        {ownsDefault ? <span>Default</span> : null}
        {ownsTitle ? <span>Title</span> : null}
      </div>
      <div className="provider-profile-actions">
        <button
          className="quiet-button"
          type="button"
          aria-label={`Edit ${provider.displayName}`}
          onClick={onEdit}
        >
          Edit
        </button>
        <button
          className="danger-button"
          type="button"
          aria-label={`Delete ${provider.displayName}`}
          onClick={onDelete}
        >
          Delete
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
  const [provider, setProvider] = useState(initialProvider);
  const [models, setModels] = useState(
    initialProvider.models.map((model) => ({ ...model })),
  );
  const [discovering, setDiscovering] = useState(false);
  const [availableModels, setAvailableModels] = useState<
    ZenXModelCatalogEntry[] | null
  >(null);
  const [selectedAvailableModels, setSelectedAvailableModels] = useState<
    string[]
  >([]);
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
    setModels((current) =>
      current.map((model, candidate) =>
        candidate === index ? update(model) : model,
      ),
    );
    setValidationError(null);
  };

  return (
    <section
      className="page-card provider-editor"
      aria-label={
        mode === "add"
          ? "Add Provider profile"
          : `Edit ${initialProvider.displayName}`
      }
    >
      <div className="provider-editor-head">
        <div>
          <strong>
            {mode === "add"
              ? "Add Provider profile"
              : `Edit ${initialProvider.displayName}`}
          </strong>
          <span>{providerTypeLabel(provider)}</span>
        </div>
        <button className="quiet-button" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const diagnosticAttemptId = globalThis.crypto.randomUUID();
          if (logoSelectionError !== null || logoReading) {
            recordValidationRejection(
              diagnosticAttemptId,
              logoSelectionError === null ? "logo_loading" : "logo_invalid",
            );
            setValidationError(
              logoSelectionError ??
                "Wait for the Provider Logo to finish loading",
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
              setValidationError("Choose a replacement default model");
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
              setValidationError("Choose a replacement title model");
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
              <strong>Check these fields</strong>
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
            label="Display name"
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
                label="Provider name"
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
                label="Base URL"
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
                label="API key"
                placeholder={
                  mode === "edit" && hasApiKey
                    ? "API key saved — leave blank to keep"
                    : "Required"
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
          <div className="settings-note" aria-label="Provider Logo">
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
              <span>
                Provider Logo (PNG, JPEG, or WebP; up to 512 KiB and 1024 ×
                1024; 4 MiB total)
              </span>
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
                    const message = "Choose a PNG, JPEG, or WebP Provider Logo";
                    setLogoSelectionError(message);
                    setValidationError(message);
                    return;
                  }
                  if (file.size > 512 * 1024) {
                    const message = "Provider Logo must be at most 512 KiB";
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
                Remove Logo
              </button>
            ) : null}
          </div>
        ) : null}
        {provider.type === "openai-compatible" ? (
          <p className="settings-note credential-note">
            Stored keys are never shown. Enter a value only to add or replace
            this profile&apos;s key.
          </p>
        ) : provider.type === "openai-subscription" ? (
          <p className="settings-note credential-note">
            Authentication is managed by the existing OpenAI sign-in in Account.
          </p>
        ) : (
          <p className="settings-note credential-note">
            Local demo is deterministic and does not use a network credential.
          </p>
        )}
        <fieldset className="provider-model-editor">
          <legend>Model catalog</legend>
          <div className="model-catalog-head">
            <p>
              Model IDs are Provider-scoped. OpenAI subscription metadata comes
              from the official Codex catalog; compatible Providers use their
              standard model endpoint.
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
                    ? "Fetch the official Codex model catalog"
                    : hasApiKey
                      ? "Fetch model IDs from this Provider"
                      : "Save an API key before discovery"
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
                        setModels((current) =>
                          current.map((model) => {
                            if (model.source === "manual") return model;
                            const discovered = snapshot.models.find(
                              (entry) => entry.id === model.id,
                            );
                            return discovered === undefined
                              ? model
                              : { ...discovered };
                          }),
                        );
                      }
                      setSelectedAvailableModels([]);
                      setModelSearch("");
                      setCatalogStatus(
                        snapshot.warning ??
                          (snapshot.source === "cache"
                            ? "Official catalog is unchanged; using the local cache."
                            : snapshot.source === "remote"
                              ? "Official metadata updated in the draft. Save provider to apply."
                              : null),
                      );
                    })
                    .catch((reason: unknown) =>
                      setValidationError(describeError(reason)),
                    )
                    .finally(() => setDiscovering(false));
                }}
              >
                {discovering ? "Fetching models…" : "Get available models"}
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
              aria-label="Available models"
            >
              <h4>Choose models to add</h4>
              <p className="settings-note">
                {provider.type === "openai-subscription"
                  ? "Choose additional models. Official metadata is updated in the draft; manual settings are preserved. Save provider to apply."
                  : "Select the models you want. Existing models and their settings stay unchanged."}
              </p>
              <label className="field">
                <span>Search available models</span>
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
                    const exists = models.some(
                      (entry) => entry.id === model.id,
                    );
                    return (
                      <label className="available-model-option" key={model.id}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${model.id}`}
                          disabled={exists}
                          checked={
                            exists || selectedAvailableModels.includes(model.id)
                          }
                          onChange={(event) =>
                            setSelectedAvailableModels((current) =>
                              event.target.checked
                                ? [...current, model.id]
                                : current.filter((id) => id !== model.id),
                            )
                          }
                        />
                        <span>{model.id}</span>
                        {exists ? <small>Already added</small> : null}
                      </label>
                    );
                  })}
                {availableModels.every(
                  (model) =>
                    !model.id
                      .toLowerCase()
                      .includes(modelSearch.trim().toLowerCase()),
                ) ? (
                  <p className="settings-note">No matching models.</p>
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
                  Cancel selection
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={selectedAvailableModels.length === 0}
                  onClick={() => {
                    const additions = availableModels.filter(
                      (entry) =>
                        selectedAvailableModels.includes(entry.id) &&
                        !models.some((model) => model.id === entry.id),
                    );
                    setModels((current) => [
                      ...current,
                      ...additions.map((model) => ({ ...model })),
                    ]);
                    setAvailableModels(null);
                    setSelectedAvailableModels([]);
                    setCatalogStatus(
                      `Added ${additions.length} models to the draft. Save provider to apply.`,
                    );
                  }}
                >
                  Add selected models ({selectedAvailableModels.length})
                </button>
              </div>
            </section>
          )}
          {models.map((model, index) => (
            <div className="provider-model-row" key={index}>
              <label className="field">
                <span>{`Model ${index + 1}`}</span>
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
                aria-label={`Remove model ${index + 1}`}
                disabled={models.length === 1}
                onClick={() => {
                  setModels((current) =>
                    current.filter((_, candidate) => candidate !== index),
                  );
                  setValidationError(null);
                }}
              >
                Remove
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
                          "Sending one tiny image test request; Provider charges may apply…",
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
                              ? "Image probe succeeded; support was saved."
                              : result.outcome === "unsupported"
                                ? "Provider explicitly rejected image input; unsupported was saved."
                                : "Image probe was inconclusive; capability remains Unknown.",
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
            onClick={() =>
              setModels((current) => [...current, manualModelCatalogEntry("")])
            }
          >
            Add model
          </button>
        </fieldset>
        {replacesDefault ? (
          <ModelReferenceSelect
            label="Replacement default model"
            placeholder="Select a model"
            profiles={replacementProfiles}
            value={defaultReplacement}
            onChangeValue={setDefaultReplacement}
          />
        ) : null}
        {replacesTitle ? (
          <ModelReferenceSelect
            label="Replacement title model"
            placeholder="Select a model"
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
            Cancel
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || logoReading}
          >
            {busy
              ? mode === "add"
                ? "Adding…"
                : "Saving…"
              : mode === "add"
                ? "Add provider"
                : "Save provider"}
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
          label={`Model ${index + 1} display name`}
          value={model.displayName}
          onChange={(displayName) => onChange(manual({ displayName }))}
        />
        <Field
          label={`Model ${index + 1} description`}
          value={model.description}
          onChange={(description) => onChange(manual({ description }))}
        />
        <label className="field">
          <span>{`Model ${index + 1} reasoning metadata`}</span>
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
            <option value="unknown">Unknown</option>
            <option value="text-only">No reasoning strength control</option>
            <option value="configured">Manual configuration</option>
          </Select>
        </label>
        {onProbe === undefined ? null : (
          <button
            className="quiet-button"
            type="button"
            disabled={probing}
            onClick={() => void onProbe()}
          >
            {probing ? "Testing image support…" : "Test image support"}
          </button>
        )}
        {reasoningMode === "configured" ? (
          <>
            <Field
              id={fieldId("reasoningEfforts")}
              error={issueFor("reasoningEfforts")}
              label={`Model ${index + 1} reasoning efforts`}
              placeholder="low, medium, high"
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
              <span>{`Model ${index + 1} default reasoning effort`}</span>
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
                aria-label={`Model ${index + 1} default reasoning effort`}
                value={model.defaultReasoningEffort ?? ""}
                onValueChange={(value) =>
                  onChange(
                    manual({
                      defaultReasoningEffort: value || null,
                    }),
                  )
                }
              >
                <option value="">Choose a default</option>
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
          <span>{`Model ${index + 1} input modalities`}</span>
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
            <option value="unknown">Unknown</option>
            <option value="text">Text</option>
            <option value="text-image">Text + image</option>
            <option value="image">Image only</option>
            <option value="none">Known unsupported</option>
          </Select>
        </label>
        <label className="field">
          <span>{`Model ${index + 1} context window (Required)`}</span>
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
            placeholder="e.g. 128000"
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
            Use the model provider&apos;s published token limit.
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
          Hide this model from normal selection
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
      aria-label={`Delete ${provider.displayName}`}
    >
      <div>
        <strong>Delete {provider.displayName}?</strong>
        <p>
          This removes its host profile and credential. Existing Threads keep
          their recorded model selection.
        </p>
      </div>
      {!hasReplacement ? (
        <div className="settings-error" role="alert">
          <Icon name="warning" />
          Add another Provider before deleting the only profile.
        </div>
      ) : null}
      {hasReplacement && replacesDefault ? (
        <ModelReferenceSelect
          autoFocus
          label="Replacement default model"
          placeholder="Select a model"
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
          label="Replacement title model"
          placeholder="Select a model"
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
          Cancel
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
                setValidationError("Choose a replacement default model");
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
                setValidationError("Choose a replacement title model");
                return;
              }
              replacements.titleModel = reference;
            }
            void onDelete(
              replacesDefault || replacesTitle ? replacements : undefined,
            );
          }}
        >
          {busy ? "Deleting…" : "Delete provider"}
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
      message: "Enter a display name",
    });
  const seenModelIds = new Set<string>();
  if (provider.models.length === 0)
    issues.push({
      code: "model_id_missing",
      field: "addModel",
      message: "Add at least one model",
    });
  provider.models.forEach((model, modelIndex) => {
    const shortModelId =
      model.id.length > 48 ? `${model.id.slice(0, 45)}…` : model.id;
    const row = `Model ${modelIndex + 1} (${shortModelId || "no ID"})`;
    if (model.id.length === 0) {
      issues.push({
        code: "model_id_missing",
        field: "modelId",
        modelIndex,
        message: `Model ${modelIndex + 1}: enter a model ID`,
      });
    } else if (model.id.length > 512) {
      issues.push({
        code: "model_id_too_long",
        field: "modelId",
        modelIndex,
        message: `Model ${modelIndex + 1}: model ID must be 512 characters or fewer`,
      });
    } else if (seenModelIds.has(model.id)) {
      issues.push({
        code: "model_id_duplicate",
        field: "modelId",
        modelIndex,
        message: `${row}: use a unique model ID`,
      });
    }
    seenModelIds.add(model.id);
    if (model.reasoningConfiguration === "manual") {
      if (!model.supportedReasoningEfforts?.length) {
        issues.push({
          code: "reasoning_efforts_missing",
          field: "reasoningEfforts",
          modelIndex,
          message: `${row}: enter at least one supported reasoning effort`,
        });
      } else if (
        new Set(model.supportedReasoningEfforts).size !==
        model.supportedReasoningEfforts.length
      ) {
        issues.push({
          code: "reasoning_efforts_duplicate",
          field: "reasoningEfforts",
          modelIndex,
          message: `${row}: use each reasoning effort only once`,
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
          message: `${row}: choose a default from the supported reasoning efforts`,
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
        message: `${row}: enter a positive whole number for context window`,
      });
    }
  });
  if (provider.type !== "openai-compatible") return issues;
  if (provider.name.trim().length === 0)
    issues.push({
      code: "provider_name_missing",
      field: "providerName",
      message: "Enter a provider name",
    });
  if (mode === "add" && apiKey.trim().length === 0)
    issues.push({
      code: "api_key_missing",
      field: "apiKey",
      message: "Enter an API key",
    });
  if (mode === "edit" && !hasApiKey && apiKey.trim().length === 0) {
    issues.push({
      code: "api_key_missing",
      field: "apiKey",
      message: "Enter an API key because this profile has no saved key",
    });
  }
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    issues.push({
      code: "base_url_invalid",
      field: "baseUrl",
      message: "Enter a valid Base URL",
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
      message: "Base URL must use HTTPS (loopback HTTP is allowed)",
    });
  } else if (url.username.length > 0 || url.password.length > 0) {
    issues.push({
      code: "base_url_credentials",
      field: "baseUrl",
      message: "Remove credentials from the Base URL",
    });
  } else if (url.search.length > 0 || url.hash.length > 0) {
    issues.push({
      code: "base_url_query_fragment",
      field: "baseUrl",
      message: "Remove the query or fragment from the Base URL",
    });
  }
  return issues;
}

function providerStatus(
  provider: ZenXProviderProfile,
  settings: PublicHostSettings,
): { className: "status-good" | "status-muted"; label: string } {
  if (provider.type === "fake") {
    return { className: "status-muted", label: "Local testing" };
  }
  if (provider.type === "openai-subscription") {
    return settings.subscription.authenticated
      ? { className: "status-good", label: "Signed in" }
      : { className: "status-muted", label: "Not signed in" };
  }
  return settings.apiKeyProviderProfileIds.includes(provider.providerProfileId)
    ? { className: "status-muted", label: "API key saved" }
    : { className: "status-muted", label: "API key not saved" };
}

function providerTypeLabel(provider: ZenXProviderProfile): string {
  if (provider.type === "fake") return "Local demo";
  if (provider.type === "openai-subscription") return "OpenAI subscription";
  return "OpenAI-compatible API";
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
        <h2>Appearance</h2>
        <p>Theme, color, and contrast.</p>
      </header>
      <div className="page-card settings-card appearance-settings-card">
        <div className="settings-card-head">
          <div>
            <h3>Theme and color</h3>
            <p>Choose how ZenX feels while keeping every surface in sync.</p>
          </div>
          <span className="status-muted">Local</span>
        </div>
        <fieldset className="appearance-options appearance-mode-options">
          <legend className="sr-only">Appearance mode</legend>
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
          aria-label="Live appearance preview"
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
            <span className="appearance-preview-accent">Accent</span>
          </div>
        </div>
        <div className="appearance-editor-grid">
          <PresetFieldset
            label="Light preset"
            name="light-preset"
            value={appearance.lightPreset}
            onChange={(lightPreset) => updateAppearance({ lightPreset })}
          />
          <PresetFieldset
            label="Dark preset"
            name="dark-preset"
            value={appearance.darkPreset}
            onChange={(darkPreset) => updateAppearance({ darkPreset })}
          />
        </div>
        <fieldset className="appearance-accent-group">
          <legend>Accent</legend>
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
                    <small>{appearanceAccentIntent[option]}</small>
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="appearance-control-list">
          <fieldset className="appearance-control-row">
            <legend>Contrast</legend>
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
            Changes apply immediately. System follows your operating system;
            Light and Dark remember separate presets.
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
            Reset appearance
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
  const [maximumInput, setMaximumInput] = useState(
    draft.maxToolRounds?.toString() ?? "",
  );
  const [maximumError, setMaximumError] = useState<string | null>(null);
  useEffect(() => {
    setMaximumInput(draft.maxToolRounds?.toString() ?? "");
  }, [draft.maxToolRounds]);
  return (
    <>
      <header>
        <h2>General</h2>
        <p>Choose how ZenX works with you and your projects.</p>
      </header>
      <section className="settings-card">
        <h3>Interaction</h3>{" "}
        <label className="field">
          <span id="composer-send-label">Send during a running turn</span>
          <Select
            aria-labelledby="composer-send-label"
            value={draft.composerSendMode ?? "queue"}
            onValueChange={(value) =>
              setDraft({
                ...draft,
                composerSendMode: value as "queue" | "soft" | "hard",
              })
            }
            aria-describedby="composer-send-help"
          >
            <option value="queue">Queue</option>
            <option value="soft">Soft steer</option>
            <option value="hard">Hard steer (interrupt and send)</option>
          </Select>
          <small id="composer-send-help" className="settings-note">
            Enter and the send button use this choice. Cmd/Ctrl+Enter uses soft
            steer when Queue is selected, and Queue when either steer mode is
            selected. Shift+Enter adds a new line.
          </small>
        </label>
      </section>
      <div className="page-card settings-card">
        <div className="settings-card-head">
          <div>
            <h3>Foreground computer control</h3>
            <p>High-impact access to the desktop you are actively using.</p>
          </div>
          <span className="status-muted">
            {draft.computerForegroundControlEnabled === true
              ? "Opted in"
              : "Blocked"}
          </span>
        </div>
        <div className="settings-row">
          <div>
            <strong>Allow foreground takeover</strong>
            <span>
              This lets ZenX agents move the pointer, type keys, change focus,
              or scroll the app you are currently using.
            </span>
          </div>
          <button
            className="plugin-switch"
            type="button"
            role="switch"
            aria-label="Allow foreground computer control"
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
          Off by default. Browser automation and background-safe Computer tools
          do not need this permission. Apply to change which tools agents can
          use.
        </p>
      </div>
      <div className="page-card settings-card">
        <h3>Execution and permissions</h3>
        <div className="form-grid">
          <div className="field wide">
            <span>Default project</span>
            <div
              className="readonly-field"
              title={draft.workspace ?? undefined}
            >
              {draft.workspace ?? "No project configured"}
            </div>
          </div>
          <label className="field">
            <span>Approval policy</span>
            <Select
              value={draft.approvalPolicy}
              onValueChange={(value) =>
                setDraft({
                  ...draft,
                  approvalPolicy: value as "always" | "never",
                })
              }
            >
              <option value="always">Approval required</option>
              <option value="never">Full access</option>
            </Select>
          </label>

          <label className="field">
            <span id="tool-presentation-label">Tool presentation</span>
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
              <option value="both">Direct and code (recommended)</option>
              <option value="direct">Direct tools only</option>
              <option value="code">Code only</option>
            </Select>
            <small id="tool-presentation-help" className="settings-note">
              Both is the default. Code runs shell-equivalent erasable
              TypeScript through the same tools and history. Direct is the
              rollback path and does not delete providers or rewrite existing
              Threads.
            </small>
          </label>
          <label className="field">
            <span id="max-tool-rounds-label">Maximum tool rounds</span>
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
                  setMaximumError("Enter a whole number of 1 or more.");
                }
              }}
            />
            {maximumError === null ? null : (
              <small id="max-tool-rounds-error" className="form-error">
                {maximumError}
              </small>
            )}
            <small id="max-tool-rounds-help" className="settings-note">
              Leave blank for unlimited. A finite maximum stops a Turn that
              keeps requesting tools after that many model rounds.
            </small>
          </label>
        </div>

        <p className="settings-note">
          Add, remove, and select Projects from the Projects sidebar. Folder
          selection always uses the ZenX directory picker.
        </p>
        <div className="settings-row">
          <div>
            <strong>Zen App Server</strong>
            <span>
              Runtime defaults apply to new turns. Running turns keep their
              admitted configuration. Existing Thread settings remain
              authoritative.
            </span>
          </div>
          <span className="status-good">Local</span>
        </div>
      </div>
    </>
  );
}

const appearancePresetIntent: Record<AppearancePreset, string> = {
  graphite: "Neutral",
  cobalt: "Cool",
  ember: "Warm",
};

const appearanceAccentIntent: Record<AppearanceAccent, string> = {
  azure: "Clear blue",
  iris: "Soft violet",
  jade: "Fresh green",
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
              <small>{appearancePresetIntent[option]}</small>
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
      ? "reasoning unknown"
      : model.supportedReasoningEfforts.length === 0
        ? "no reasoning strength control"
        : model.supportedReasoningEfforts.join(" / ");
  const modalities =
    model.inputModalities === null
      ? "input unknown"
      : model.inputModalities.length === 0
        ? "no input modalities"
        : model.inputModalities.join(" + ");
  const context =
    model.contextWindow === null
      ? "context required"
      : `${model.contextWindow.toLocaleString()} context`;
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
  const [value, setValue] = useState("");
  return (
    <div className="manual-code">
      <label className="field">
        <span>Authorization code or redirect URL</span>
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
        Continue
      </button>
    </div>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function configurationSaveMessage(value: PublicHostSettings): string {
  const result = value.configuration;
  if (!result) return "Settings saved";
  switch (result.status) {
    case "unchanged":
      return "No changes";
    case "applied":
      return "Changes applied · running turns keep their current configuration";
    case "pending-restart":
      return `Saved · ${result.pendingRestart.join(", ")} takes effect next launch`;
    case "unconfirmed":
      return "Saved · application not yet confirmed. Check application status before saving more changes.";
  }
}

// Actionable configuration states already have persistent notices and controls.
function configurationSaveToast(value: PublicHostSettings): string | null {
  if (value.configuration && value.configuration.status !== "applied")
    return null;
  return "Settings saved";
}
