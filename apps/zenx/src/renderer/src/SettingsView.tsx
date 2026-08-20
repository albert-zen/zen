import { useEffect, useRef, useState } from "react";

import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type {
  PublicHostSettings,
  ZenXHostProfile,
  ZenXProviderProfile,
} from "../../main/host-profile.js";
import { CapabilitySettings } from "./CapabilitySettings.js";
import { Icon } from "./icons.js";
import { ProviderLogo } from "./ProviderLogo.js";
import { threadModelIdentity, threadTitle } from "./thread-list.js";

export type SettingsTab =
  "account" | "models" | "plugins" | "general" | "archived";

export function SettingsView({
  archivedError,
  archivedLoading,
  archivedThreads,
  onOpenSidebar,
  onRetryArchived,
  onTabChange,
  onUnarchive,
  tab,
}: {
  archivedError: string | null;
  archivedLoading: boolean;
  archivedThreads: readonly NativeThreadSummary[];
  onOpenSidebar?(): void;
  onRetryArchived(): void;
  onTabChange(tab: SettingsTab): void;
  onUnarchive(thread: NativeThreadSummary): Promise<void>;
  tab: SettingsTab;
}) {
  const [settings, setSettings] = useState<PublicHostSettings | null>(null);
  const [draft, setDraft] = useState<ZenXHostProfile | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
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
        setModels(value.profile.models.join("\n"));
      })
      .catch((reason: unknown) => active && setError(describeError(reason)));
    return () => {
      active = false;
      dispose();
    };
  }, []);

  const setProvider = (type: ZenXProviderProfile["type"]) => {
    if (draft === null) return;
    const provider: ZenXProviderProfile =
      type === "fake"
        ? { type, displayName: "Local demo" }
        : type === "openai-subscription"
          ? { type, displayName: "OpenAI subscription" }
          : {
              type,
              name: "openai",
              displayName: "OpenAI compatible",
              baseUrl: "https://api.openai.com/v1",
            };
    const defaultModel =
      type === "openai-subscription"
        ? "gpt-5.6-terra"
        : type === "fake"
          ? "fake"
          : "gpt-5.4";
    setDraft({ ...draft, provider, defaultModel, models: [defaultModel] });
    setModels(defaultModel);
  };

  const save = async () => {
    if (draft === null) return;
    setBusy("save");
    setError(null);
    setStatus(null);
    try {
      const modelList = normalizedModels(models);
      const value = await window.zenx.settings.save(
        {
          onboardingComplete: true,
          provider: draft.provider,
          defaultModel: draft.defaultModel,
          titleModel: draft.titleModel,
          models: modelList,
          approvalPolicy: draft.approvalPolicy,
        },
        apiKey.trim().length > 0 ? apiKey : undefined,
      );
      setSettings(value);
      setDraft(value.profile);
      setModels(value.profile.models.join("\n"));
      setApiKey("");
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
  const provider = draft.provider;
  const pendingProfile: ZenXHostProfile = {
    ...draft,
    onboardingComplete: true,
    models: normalizedModels(models),
  };
  const hostDirty =
    apiKey.trim().length > 0 ||
    JSON.stringify(pendingProfile) !== JSON.stringify(settings.profile);
  const tabs: Array<{
    id: SettingsTab;
    label: string;
    icon: "users" | "layers" | "trigger" | "settings" | "archive";
  }> = [
    { id: "account", label: "Account", icon: "users" },
    { id: "models", label: "Models & provider", icon: "layers" },
    { id: "plugins", label: "Plugins", icon: "trigger" },
    { id: "general", label: "General", icon: "settings" },
    { id: "archived", label: "Archived threads", icon: "archive" },
  ];
  return (
    <section className="product-page settings-view" aria-label="ZenX settings">
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
            <p>Account, models, plugins, and local host</p>
          </div>
        </div>
      </header>
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
                apiKey={apiKey}
                draft={draft}
                models={models}
                provider={provider}
                settings={settings}
                setApiKey={setApiKey}
                setDraft={setDraft}
                setModels={setModels}
                setProvider={setProvider}
              />
            ) : null}
            {tab === "plugins" ? (
              <>
                <header>
                  <h2>Plugins</h2>
                  <p>
                    Manage loaded packages, their declared product spaces, and
                    Agent tool grants without mixing those states.
                  </p>
                </header>
                <CapabilitySettings />
              </>
            ) : null}
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
            {error ? (
              <div className="settings-error" role="alert">
                <Icon name="warning" />
                {error}
              </div>
            ) : null}
            {status ? (
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
              settings.subscription.authenticated
                ? "status-good"
                : "status-muted"
            }
          >
            {settings.subscription.authenticated
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
              {settings.subscription.authenticated
                ? "Authentication is stored in the operating system credential boundary."
                : "Connect a subscription when this provider is selected."}
            </span>
          </div>
          {settings.subscription.authenticated ? (
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
  apiKey,
  draft,
  models,
  provider,
  settings,
  setApiKey,
  setDraft,
  setModels,
  setProvider,
}: {
  apiKey: string;
  draft: ZenXHostProfile;
  models: string;
  provider: ZenXProviderProfile;
  settings: PublicHostSettings;
  setApiKey(value: string): void;
  setDraft(value: ZenXHostProfile): void;
  setModels(value: string): void;
  setProvider(value: ZenXProviderProfile["type"]): void;
}) {
  return (
    <>
      <header>
        <h2>Models & provider</h2>
        <p>Choose the host adapter and models exposed to new Threads.</p>
      </header>
      <div className="page-card settings-card">
        <div
          className="provider-tabs"
          role="tablist"
          aria-label="Provider type"
        >
          {(["openai-subscription", "openai-compatible", "fake"] as const).map(
            (type) => (
              <button
                key={type}
                type="button"
                role="tab"
                aria-selected={provider.type === type}
                onClick={() => setProvider(type)}
              >
                {type === "openai-subscription"
                  ? "OpenAI subscription"
                  : type === "openai-compatible"
                    ? "API provider"
                    : "Local demo"}
              </button>
            ),
          )}
        </div>
        {provider.type === "openai-compatible" ? (
          <div className="form-grid">
            <Field
              label="Display name"
              value={provider.displayName}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  provider: { ...provider, displayName: value },
                })
              }
            />
            <Field
              label="Provider name"
              value={provider.name}
              onChange={(value) =>
                setDraft({ ...draft, provider: { ...provider, name: value } })
              }
            />
            <Field
              wide
              label="Base URL"
              value={provider.baseUrl}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  provider: { ...provider, baseUrl: value },
                })
              }
            />
            <Field
              wide
              secret
              label="API key"
              placeholder={
                settings.hasApiKey
                  ? "Saved securely — leave blank to keep"
                  : "Required"
              }
              value={apiKey}
              onChange={setApiKey}
            />
          </div>
        ) : provider.type === "fake" ? (
          <p className="settings-note">
            The deterministic local provider is for offline protocol and UI
            testing. Thread lists present it as “Local demo,” never as a fake
            brand.
          </p>
        ) : (
          <p className="settings-note">
            Model access uses the authenticated subscription shown in Account.
          </p>
        )}
      </div>
      <div className="page-card settings-card">
        <div className="form-grid">
          <Field
            label="Default model"
            value={draft.defaultModel}
            onChange={(value) => setDraft({ ...draft, defaultModel: value })}
          />
          <Field
            label="Title model"
            value={draft.titleModel}
            onChange={(value) => setDraft({ ...draft, titleModel: value })}
          />
          <label className="field wide">
            <span>
              Available models <small>one per line</small>
            </span>
            <textarea
              rows={5}
              value={models}
              onChange={(event) => setModels(event.target.value)}
            />
          </label>
        </div>
        <p className="settings-note">
          Existing Threads keep the ZAS-authoritative model until changed
          explicitly in their Composer.
        </p>
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
  return (
    <>
      <header>
        <h2>General</h2>
        <p>Local workspace defaults and Zen App Server behavior.</p>
      </header>
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
        </div>
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

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret = false,
  wide = false,
}: {
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

function normalizedModels(value: string): string[] {
  return value
    .split(/[\n,]/u)
    .map((model) => model.trim())
    .filter(Boolean);
}
