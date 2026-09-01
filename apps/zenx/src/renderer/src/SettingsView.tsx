import { useEffect, useRef, useState } from "react";

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
import { Icon } from "./icons.js";
import { ProviderLogo, providerLogoKindForIdentity } from "./ProviderLogo.js";
import { threadModelIdentity, threadTitle } from "./thread-list.js";
import { PluginSettingsSurfaces } from "./PluginProductPage.js";

export type SettingsTab =
  "account" | "models" | "plugins" | "appearance" | "general" | "archived";

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
}) {
  const [settings, setSettings] = useState<PublicHostSettings | null>(null);
  const [draft, setDraft] = useState<ZenXHostProfile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    const dispose = window.zenx.settings.onManualCodeRequested(() => {
      if (active) setManualCode(true);
    });
    void window.zenx.settings
      .get()
      .then((value) => {
        if (!active) return;
        setSettings(value);
        setDraft(value.profile);
      })
      .catch((reason: unknown) => active && setError(describeError(reason)));
    return () => {
      active = false;
      dispose();
    };
  }, []);

  const save = async () => {
    if (draft === null) return;
    setBusy("save");
    setError(null);
    setStatus(null);
    try {
      const value = await window.zenx.settings.save({
        onboardingComplete: true,
        computerForegroundControlEnabled:
          draft.computerForegroundControlEnabled === true,
        providerProfiles: draft.providerProfiles,
        defaultModel: draft.defaultModel,
        titleModel: draft.titleModel,
        approvalPolicy: draft.approvalPolicy,
        maxToolRounds: draft.maxToolRounds,
      });
      setSettings(value);
      setDraft(value.profile);
      setStatus("Changes applied · local host restarted");
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  };

  if (draft === null || settings === null) {
    return (
      <section className="product-page settings-view">
        <div className="page-loading">
          <div className="loading-ring" />
          <p>{error ?? "Loading local settings…"}</p>
        </div>
      </section>
    );
  }
  const hostDirty = JSON.stringify(draft) !== JSON.stringify(settings.profile);
  const tabs: Array<{
    id: SettingsTab;
    label: string;
    icon: "users" | "layers" | "trigger" | "moon" | "settings" | "archive";
  }> = [
    { id: "account", label: "Account", icon: "users" },
    { id: "models", label: "Models & provider", icon: "layers" },
    { id: "plugins", label: "Plugins", icon: "trigger" },
    { id: "appearance", label: "Appearance", icon: "moon" },
    { id: "general", label: "General", icon: "settings" },
    { id: "archived", label: "Archived threads", icon: "archive" },
  ];
  return (
    <section className="product-page settings-view" aria-label="ZenX settings">
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
              <p>Account, appearance, models, plugins, and local host</p>
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
                aria-selected={tab === item.id}
                onClick={() => onTabChange(item.id)}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="settings-panel">
            {tab === "account" ? (
              <AccountPanel
                settings={settings}
                busy={busy}
                manualCode={manualCode}
                setBusy={setBusy}
                setError={setError}
                setManualCode={setManualCode}
                setSettings={setSettings}
              />
            ) : null}
            {tab === "models" ? (
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
                status={status}
              />
            ) : null}
            {tab === "plugins" ? (
              <>
                <header>
                  <h2>Plugins</h2>
                  <p>
                    Install, update, disable, or remove trusted packages.
                    Uninstall keeps plugin data until you explicitly delete it.
                  </p>
                </header>
                <PluginSettings />
                {pluginSnapshot === null ? null : (
                  <PluginSettingsSurfaces snapshot={pluginSnapshot} />
                )}
              </>
            ) : null}
            {tab === "appearance" ? <AppearancePanel /> : null}
            {tab === "general" ? (
              <GeneralPanel draft={draft} setDraft={setDraft} />
            ) : null}
            {tab === "archived" ? (
              <ArchivedThreadsPanel
                error={archivedError}
                loading={archivedLoading}
                onRetry={onRetryArchived}
                onUnarchive={onUnarchive}
                threads={archivedThreads}
              />
            ) : null}
            {tab === "models" || tab === "general" ? (
              <SettingsApplyBar
                busy={busy === "save"}
                dirty={hostDirty}
                onApply={() => void save()}
              />
            ) : null}
            {error && tab !== "models" ? (
              <div className="settings-error" role="alert">
                <Icon name="warning" />
                {error}
              </div>
            ) : null}
            {status && tab !== "models" ? (
              <div className="settings-success" role="status">
                <Icon name="check" />
                {status}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export function SettingsApplyBar({
  busy,
  dirty,
  onApply,
}: {
  busy: boolean;
  dirty: boolean;
  onApply(): void;
}) {
  return (
    <div className={`settings-apply-bar${dirty ? " dirty" : ""}`}>
      <div>
        <strong>Local host configuration</strong>
        <span>
          {dirty
            ? "Apply these changes when you are ready. ZenX will restart the local host."
            : "No unapplied host changes."}
        </span>
      </div>
      <button
        className={dirty ? "primary-button" : "quiet-button"}
        type="button"
        disabled={!dirty || busy}
        onClick={onApply}
      >
        {busy ? "Applying & restarting…" : "Apply & restart"}
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
}: {
  error: string | null;
  loading: boolean;
  onRetry(): void;
  onUnarchive(thread: NativeThreadSummary): Promise<void>;
  threads: readonly NativeThreadSummary[];
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
                      <ProviderLogo kind={identity.providerKind} />
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
  status,
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
  status: string | null;
}) {
  const [showAddChoices, setShowAddChoices] = useState(false);
  const [editor, setEditor] = useState<{
    mode: "add" | "edit";
    provider: ZenXProviderProfile;
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
    setStatus(message);
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
        if (committed(authoritative)) {
          setSettings(authoritative);
          setDraft(authoritative.profile);
          setStatus(
            `${message.replace(/ · local host restarted$/u, "")} · saved, but local host restart failed`,
          );
          setError(`Settings were saved, but restart failed: ${originalError}`);
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
    setEditor({ mode: "add", provider });
    setError(null);
    setStatus(null);
  };

  const openKnownProviderEditor = (preset: ZenXKnownProviderPreset) => {
    setShowAddChoices(false);
    setDeletingProviderId(null);
    setEditor({
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
          Manage independent Provider profiles and choose which profile owns
          each global model role.
        </p>
      </header>
      {error === null ? null : (
        <div className="settings-error" role="alert">
          <Icon name="warning" />
          {error}
        </div>
      )}
      {status === null ? null : (
        <div className="settings-success" role="status">
          <Icon name="check" />
          {status}
        </div>
      )}
      <div className="page-card settings-card model-routing-card">
        <div className="settings-card-head">
          <div>
            <h3>Global model routing</h3>
            <p>
              Provider identity is part of each selection, including when two
              profiles use the same model ID.
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
          Existing Threads keep their ZAS-authoritative selection until you
          change it explicitly in the Composer.
        </p>
      </div>
      <section
        className="provider-section"
        aria-labelledby="provider-list-title"
      >
        <div className="provider-section-head">
          <div>
            <h3 id="provider-list-title">Provider profiles</h3>
            <p>Credentials and model IDs stay scoped to one profile.</p>
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
            titleModel={settings.profile.titleModel}
            onCancel={() => setEditor(null)}
            onSubmit={async (provider, apiKey, replacements) => {
              const success = await runMutation(
                editor.mode === "add" ? "provider-add" : "provider-edit",
                editor.mode === "add"
                  ? "Provider added · local host restarted"
                  : "Provider saved · local host restarted",
                async () =>
                  editor.mode === "add"
                    ? await window.zenx.settings.addProvider(provider, apiKey)
                    : await window.zenx.settings.editProvider(
                        editor.provider.providerProfileId,
                        provider,
                        {
                          ...replacements,
                          ...(apiKey === undefined ? {} : { apiKey }),
                        },
                      ),
                (authoritative) => {
                  const current = authoritative.profile.providerProfiles.find(
                    (candidate) =>
                      candidate.providerProfileId ===
                      provider.providerProfileId,
                  );
                  return (
                    current !== undefined &&
                    providerProfilesEquivalent(current, provider)
                  );
                },
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
                setEditor({ mode: "edit", provider });
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
                "Provider deleted · local host restarted",
                async () =>
                  await window.zenx.settings.deleteProvider(
                    deletingProvider.providerProfileId,
                    replacements,
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
        <ProviderLogo kind={providerLogoKind(provider)} />
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
  ): Promise<"success" | "committed-error" | "failed">;
  provider: ZenXProviderProfile;
  titleModel: ZenXModelReference;
}) {
  const [provider, setProvider] = useState(initialProvider);
  const [models, setModels] = useState(
    initialProvider.models.map((model) => ({ ...model })),
  );
  const [discovering, setDiscovering] = useState(false);
  const [probingModel, setProbingModel] = useState<string | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [defaultReplacement, setDefaultReplacement] = useState("");
  const [titleReplacement, setTitleReplacement] = useState("");
  const normalizedProvider = {
    ...provider,
    models: models.map(normalizedDraftModel),
  } as ZenXProviderProfile;
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
        onSubmit={(event) => {
          event.preventDefault();
          const error = validateProviderEditor(
            normalizedProvider,
            apiKey,
            mode,
            hasApiKey,
          );
          if (error !== null) {
            setValidationError(error);
            return;
          }
          const replacements: ZenXProviderEditOptions = {};
          if (replacesDefault) {
            const reference = modelReferenceFromValue(
              defaultReplacement,
              replacementProfiles,
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
              replacementProfiles,
            );
            if (reference === undefined) {
              setValidationError("Choose a replacement title model");
              return;
            }
            replacements.titleModel = reference;
          }
          void onSubmit(
            normalizedProvider,
            apiKey.trim().length === 0 ? undefined : apiKey,
            replacements,
          );
        }}
      >
        <div className="form-grid">
          <Field
            autoFocus
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
                label="Provider name"
                value={provider.name}
                onChange={(name) => {
                  setProvider({ ...provider, name });
                  setValidationError(null);
                }}
              />
              <Field
                wide
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
              Model IDs are Provider-scoped. Unknown capabilities stay unknown
              until discovery or a manual override supplies them.
            </p>
            {provider.type === "openai-compatible" && mode === "edit" ? (
              <button
                className="quiet-button"
                type="button"
                disabled={discovering || !hasApiKey}
                title={
                  hasApiKey
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
                      setModels(snapshot.models.map((model) => ({ ...model })));
                      setCatalogStatus(
                        `Found ${snapshot.models.length} configured and available models`,
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
          {models.map((model, index) => (
            <div className="provider-model-row" key={index}>
              <label className="field">
                <span>{`Model ${index + 1}`}</span>
                <input
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
                onChange={(next) => updateModel(index, () => next)}
                probing={probingModel === model.id}
                onProbe={
                  provider.type === "openai-compatible" &&
                  mode === "edit" &&
                  hasApiKey &&
                  initialProvider.models.some(
                    (entry) => entry.id === model.id,
                  ) &&
                  model.inputModalities === null
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
        {validationError === null ? null : (
          <div className="settings-error provider-editor-error" role="alert">
            <Icon name="warning" />
            {validationError}
          </div>
        )}
        <div className="provider-editor-actions">
          <button className="quiet-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy
              ? mode === "add"
                ? "Adding & restarting…"
                : "Saving & restarting…"
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
  onChange,
  onProbe,
  probing = false,
}: {
  index: number;
  model: ZenXModelCatalogEntry;
  onChange(model: ZenXModelCatalogEntry): void;
  onProbe?(): Promise<void>;
  probing?: boolean;
}) {
  const manual = (
    update: Partial<ZenXModelCatalogEntry>,
  ): ZenXModelCatalogEntry => ({ ...model, ...update, source: "manual" });
  const reasoningMode =
    model.supportedReasoningEfforts === null ? "unknown" : "configured";
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
          <select
            value={reasoningMode}
            onChange={(event) =>
              onChange(
                manual(
                  event.target.value === "unknown"
                    ? {
                        supportedReasoningEfforts: null,
                        defaultReasoningEffort: null,
                      }
                    : {
                        supportedReasoningEfforts:
                          model.supportedReasoningEfforts ?? [],
                      },
                ),
              )
            }
          >
            <option value="unknown">Unknown</option>
            <option value="configured">Configured</option>
          </select>
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
              label={`Model ${index + 1} reasoning efforts`}
              placeholder="low, medium, high"
              value={model.supportedReasoningEfforts?.join(", ") ?? ""}
              onChange={(value) =>
                onChange(
                  manual({
                    supportedReasoningEfforts: commaSeparatedValues(value),
                  }),
                )
              }
            />
            <Field
              label={`Model ${index + 1} default reasoning effort`}
              placeholder="None"
              value={model.defaultReasoningEffort ?? ""}
              onChange={(value) =>
                onChange(
                  manual({
                    defaultReasoningEffort:
                      value.trim().length === 0 ? null : value,
                  }),
                )
              }
            />
          </>
        ) : null}
        <label className="field">
          <span>{`Model ${index + 1} input modalities`}</span>
          <select
            value={inputModalityValue(model.inputModalities)}
            onChange={(event) =>
              onChange(
                manual({
                  inputModalities: inputModalities(event.target.value),
                }),
              )
            }
          >
            <option value="unknown">Unknown</option>
            <option value="text">Text</option>
            <option value="text-image">Text + image</option>
            <option value="image">Image only</option>
            <option value="none">Known unsupported</option>
          </select>
        </label>
        <label className="field">
          <span>{`Model ${index + 1} context window`}</span>
          <input
            min="1"
            step="1"
            type="number"
            placeholder="Unknown"
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
          {busy ? "Deleting & restarting…" : "Delete provider"}
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
      <select
        autoFocus={autoFocus}
        value={serialized}
        onChange={(event) => {
          if (onChangeValue !== undefined) {
            onChangeValue(event.target.value);
            return;
          }
          const reference = modelReferenceFromValue(
            event.target.value,
            profiles,
          );
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
      </select>
    </label>
  );
}

function validateProviderEditor(
  provider: ZenXProviderProfile,
  apiKey: string,
  mode: "add" | "edit",
  hasApiKey: boolean,
): string | null {
  if (provider.displayName.trim().length === 0)
    return "Display name is required";
  if (
    provider.models.length === 0 ||
    provider.models.some((model) => model.id.length === 0)
  ) {
    return "Every configured model row needs a model ID";
  }
  if (
    new Set(provider.models.map((model) => model.id)).size !==
    provider.models.length
  ) {
    return "Model IDs must be unique within this Provider profile";
  }
  if (provider.type !== "openai-compatible") return null;
  if (provider.name.trim().length === 0) return "Provider name is required";
  if (mode === "add" && apiKey.trim().length === 0)
    return "API key is required";
  if (mode === "edit" && !hasApiKey && apiKey.trim().length === 0) {
    return "API key is required because this profile has no saved key";
  }
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    return "Base URL must be a valid URL";
  }
  const loopbackHttp =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !loopbackHttp) {
    return "Base URL must use HTTPS (loopback HTTP is allowed)";
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return "Base URL must not contain credentials";
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    return "Base URL must not contain a query or fragment";
  }
  return null;
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

function providerLogoKind(provider: ZenXProviderProfile) {
  if (provider.type === "fake") return "local";
  if (provider.type === "openai-subscription") return "openai";
  return providerLogoKindForIdentity(provider.name, provider.displayName);
}

function providerProfilesEquivalent(
  left: ZenXProviderProfile,
  right: ZenXProviderProfile,
): boolean {
  const normalize = (provider: ZenXProviderProfile): ZenXProviderProfile => {
    if (provider.type === "openai-compatible") {
      return {
        ...provider,
        providerProfileId: provider.providerProfileId.trim(),
        displayName: provider.displayName.trim(),
        models: provider.models.map((model) => ({
          ...model,
          id: model.id.trim(),
          displayName: model.displayName.trim(),
          description: model.description.trim(),
        })),
        name: provider.name.trim(),
        baseUrl: provider.baseUrl.trim().replace(/\/$/u, ""),
      };
    }
    return {
      ...provider,
      providerProfileId: provider.providerProfileId.trim(),
      displayName: provider.displayName.trim(),
      models: provider.models.map((model) => ({
        ...model,
        id: model.id.trim(),
        displayName: model.displayName.trim(),
        description: model.description.trim(),
      })),
    };
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
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
    model.supportedReasoningEfforts !== null &&
    model.defaultReasoningEffort !== null &&
    model.supportedReasoningEfforts.includes(model.defaultReasoningEffort) &&
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
        <p>Theme, color, contrast, and window material.</p>
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
          <label className="appearance-switch-row">
            <span>
              <strong>Translucent sidebar</strong>
              <small>Layer the sidebar material over the window canvas.</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              name="sidebar-translucency"
              value="on"
              checked={appearance.translucentSidebar}
              onChange={(event) =>
                updateAppearance({ translucentSidebar: event.target.checked })
              }
            />
          </label>
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
        <p>Local workspace defaults and Zen App Server behavior.</p>
      </header>
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
          do not need this permission. Apply and restart to change which tools
          agents can use.
        </p>
      </div>
      <div className="page-card settings-card">
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
            <select
              value={draft.approvalPolicy}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  approvalPolicy: event.target.value as "always" | "never",
                })
              }
            >
              <option value="always">Approval required</option>
              <option value="never">Full access</option>
            </select>
          </label>
          <label className="field">
            <span>Maximum tool rounds</span>
            <input
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
          </label>
        </div>
        <p id="max-tool-rounds-help" className="settings-note">
          Leave blank for unlimited. A finite maximum stops a Turn that keeps
          requesting tools after that many model rounds.
        </p>
        <p className="settings-note">
          Add, remove, and select Projects from the Projects sidebar. Folder
          selection always uses the ZenX directory picker.
        </p>
        <div className="settings-row">
          <div>
            <strong>Zen App Server</strong>
            <span>
              Applying changes restarts the local host with these defaults.
              Existing Thread settings remain authoritative.
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
    contextWindow: null,
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
    supportedReasoningEfforts: null,
    defaultReasoningEffort: null,
    inputModalities: null,
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
        ? "no selectable reasoning"
        : model.supportedReasoningEfforts.join(" / ");
  const modalities =
    model.inputModalities === null
      ? "input unknown"
      : model.inputModalities.length === 0
        ? "no input modalities"
        : model.inputModalities.join(" + ");
  const context =
    model.contextWindow === null
      ? "context unknown"
      : `${model.contextWindow.toLocaleString()} context`;
  return `${reasoning} · ${modalities} · ${context}`;
}

function Field({
  autoFocus = false,
  label,
  value,
  onChange,
  placeholder,
  secret = false,
  wide = false,
}: {
  autoFocus?: boolean;
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
        type={secret ? "password" : "text"}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
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
