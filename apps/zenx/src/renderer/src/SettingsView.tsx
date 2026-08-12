import React, { useEffect, useState } from "react";

import type {
  PublicHostSettings,
  ZenXHostProfile,
  ZenXProviderProfile,
} from "../../main/host-profile.js";
import type { JournalCompatibilityProjection } from "../../main/journal-compatibility.js";
import { Icon } from "./icons.js";
import { CapabilitySettings } from "./CapabilitySettings.js";

export function SettingsView({
  onClose,
  onLegacyJournalCleanup,
  onSettingsChange,
}: {
  onClose(): void;
  onLegacyJournalCleanup(): Promise<void>;
  onSettingsChange(settings: PublicHostSettings): void;
}) {
  const [settings, setSettings] = useState<PublicHostSettings | null>(null);
  const [draft, setDraft] = useState<ZenXHostProfile | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState(false);
  const [applyState, setApplyState] = useState<
    "idle" | "applying" | "restarting" | "applied" | "failed"
  >("idle");
  const [legacyReport, setLegacyReport] =
    useState<JournalCompatibilityProjection | null>(null);
  const [cleanupResult, setCleanupResult] = useState<string | null>(null);

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
    const disposeLegacy = window.zenx.settings.onLegacyJournalChange(
      (report) => {
        if (active) setLegacyReport(report);
      },
    );
    void window.zenx.settings
      .getLegacyJournalReport()
      .then((report) => {
        if (active) setLegacyReport(report);
      })
      .catch((reason: unknown) => active && setError(describeError(reason)));
    return () => {
      active = false;
      dispose();
      disposeLegacy();
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
    setApplyState("applying");
    setError(null);
    try {
      const modelList = models
        .split(/[\n,]/u)
        .map((value) => value.trim())
        .filter(Boolean);
      setApplyState("restarting");
      const value = await window.zenx.settings.save(
        { ...draft, onboardingComplete: true, models: modelList },
        apiKey.trim().length > 0 ? apiKey : undefined,
      );
      setSettings(value);
      setDraft(value.profile);
      setModels(value.profile.models.join("\n"));
      setApiKey("");
      setApplyState("applied");
      onSettingsChange(value);
    } catch (reason) {
      setError(describeError(reason));
      setApplyState("failed");
    } finally {
      setBusy(null);
    }
  };

  const login = async () => {
    setBusy("login");
    setApplyState("applying");
    setError(null);
    try {
      const value = await window.zenx.settings.loginSubscription();
      setSettings(value);
      setDraft(value.profile);
      setModels(value.profile.models.join("\n"));
      setApiKey("");
      setApplyState("applied");
      onSettingsChange(value);
      setManualCode(false);
    } catch (reason) {
      setApplyState("failed");
      setError(
        `${describeError(reason)} Open Settings and retry, or paste the redirect URL when prompted.`,
      );
    } finally {
      setBusy(null);
    }
  };

  if (draft === null || settings === null) {
    return (
      <section className="settings-view">
        <div className="loading-ring" />
        <p>{error ?? "Loading local settings…"}</p>
      </section>
    );
  }
  const provider = draft.provider;
  const modelList = models
    .split(/[\n,]/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const dirty =
    apiKey.trim().length > 0 ||
    JSON.stringify({ ...draft, models: modelList }) !==
      JSON.stringify(settings.profile);
  const visibleApplyState =
    dirty && applyState === "applied" ? "idle" : applyState;
  const providerReady = isProviderReady(
    provider,
    settings.subscription.authenticated,
    settings.hasApiKey,
    apiKey,
  );
  const applyBlockedReason =
    provider.type === "openai-subscription" && !providerReady
      ? "Sign in with OpenAI before applying subscription settings."
      : null;
  const steps = [
    ["Provider", providerReady],
    [
      "Model",
      draft.defaultModel.trim().length > 0 &&
        modelList.includes(draft.defaultModel),
    ],
    ["Project folder", draft.workspace.trim().length > 0],
    [
      "Ready",
      providerReady &&
        draft.workspace.trim().length > 0 &&
        modelList.includes(draft.defaultModel),
    ],
  ] as const;
  return (
    <section className="settings-view" aria-label="ZenX settings">
      <header className="settings-header">
        <div>
          <span>ZenX host</span>
          <h1>
            {draft.onboardingComplete ? "Settings" : "Connect a provider"}
          </h1>
          <p>
            Credentials stay on this device. Threads only record the effective
            provider and model.
          </p>
        </div>
        {draft.onboardingComplete ? (
          <button
            className="icon-button"
            type="button"
            aria-label="Close settings"
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
      </header>
      <div className="settings-scroll">
        <ol className="setup-rail" aria-label="Setup progress">
          {steps.map(([label, complete], index) => (
            <li className={complete ? "complete" : undefined} key={label}>
              <span>
                {complete ? <Icon name="check" size={12} /> : index + 1}
              </span>
              {label}
            </li>
          ))}
        </ol>
        <div className="settings-card">
          <h2>Provider</h2>
          <div
            className="provider-tabs"
            role="tablist"
            aria-label="Provider type"
          >
            {(
              ["openai-subscription", "openai-compatible", "fake"] as const
            ).map((type) => (
              <button
                key={type}
                type="button"
                role="tab"
                aria-selected={draft.provider.type === type}
                onClick={() => setProvider(type)}
              >
                {type === "openai-subscription"
                  ? "OpenAI subscription"
                  : type === "openai-compatible"
                    ? "API provider"
                    : "Local demo"}
              </button>
            ))}
          </div>
          {provider.type === "openai-subscription" ? (
            <div className="auth-panel">
              <div>
                <strong>
                  {settings.subscription.authenticated
                    ? "Signed in"
                    : "Not signed in"}
                </strong>
                <span>
                  {settings.subscription.accountId ??
                    "Use your ChatGPT subscription in ZenX."}
                </span>
              </div>
              {settings.subscription.authenticated ? (
                <button
                  type="button"
                  onClick={() =>
                    void window.zenx.settings
                      .logoutSubscription()
                      .then(setSettings)
                      .catch((reason: unknown) =>
                        setError(describeError(reason)),
                      )
                  }
                >
                  Sign out
                </button>
              ) : (
                <button
                  className="primary-button"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void login()}
                >
                  {busy === "login"
                    ? "Waiting for browser…"
                    : "Sign in with OpenAI"}
                </button>
              )}
              {manualCode ? (
                <ManualCode
                  onSubmit={(code) =>
                    void window.zenx.settings.submitManualCode(code)
                  }
                />
              ) : null}
            </div>
          ) : provider.type === "openai-compatible" ? (
            <div className="settings-grid">
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
          ) : (
            <p className="settings-note">
              A deterministic local provider for trying the interface without
              network access.
            </p>
          )}
        </div>
        <div className="settings-card">
          <h2>Models and workspace</h2>
          <div className="settings-grid">
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
            <Field
              label="Workspace"
              value={draft.workspace}
              onChange={(value) => setDraft({ ...draft, workspace: value })}
            />
            <div className="workspace-picker wide">
              <button
                type="button"
                onClick={() =>
                  void window.zenx.settings
                    .chooseWorkspace()
                    .then((workspace) => {
                      if (workspace === null) return;
                      setDraft({
                        ...draft,
                        workspace,
                        workspaces: [
                          ...new Set([...draft.workspaces, workspace]),
                        ],
                      });
                      setApplyState("idle");
                    })
                    .catch((reason: unknown) => setError(describeError(reason)))
                }
              >
                Choose project folder…
              </button>
              <span>
                Used for new threads on this device. Existing threads are
                unchanged.
              </span>
            </div>
            <label className="field wide">
              <span>
                Available models <small>one per line</small>
              </span>
              <textarea
                rows={4}
                value={models}
                onChange={(event) => setModels(event.target.value)}
              />
            </label>
          </div>
          <p className="settings-note">
            The title model is independent from the thread ModelCatalog and
            defaults to gpt-5.6-luna. Existing threads keep their
            ZAS-authoritative model until you change it explicitly.
          </p>
        </div>
        <LegacyJournalCard
          report={legacyReport}
          result={cleanupResult}
          busy={busy === "cleanup"}
          onCleanup={async () => {
            setBusy("cleanup");
            setCleanupResult(null);
            setError(null);
            try {
              const value = await cleanupLegacyJournalsAndRefreshThreads(
                () => window.zenx.settings.cleanupLegacyJournals(),
                onLegacyJournalCleanup,
              );
              setLegacyReport(value.report);
              setCleanupResult(
                `Moved ${value.result.moved.length} empty legacy ${value.result.moved.length === 1 ? "journal" : "journals"} to ${value.result.quarantineDirectory}. The list has been refreshed.`,
              );
            } catch (reason) {
              setError(describeError(reason));
            } finally {
              setBusy(null);
            }
          }}
        />
        <CapabilitySettings />
        {error === null ? null : (
          <div className="settings-error" role="alert">
            <Icon name="warning" size={14} />
            {error}
          </div>
        )}
        <div
          className={`settings-actions ${visibleApplyState}`}
          aria-live="polite"
        >
          <div>
            <strong>{applyStatusCopy(visibleApplyState, dirty)}</strong>
            <span>
              {applyBlockedReason ??
                "Provider, model, and project changes apply to new work. Active threads are never silently changed."}
            </span>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={
              busy !== null ||
              !providerReady ||
              (!dirty && applyState !== "failed")
            }
            onClick={() => void save()}
          >
            {busy === "save" ? "Applying…" : "Apply and restart"}
          </button>
        </div>
      </div>
    </section>
  );
}

export function applyStatusCopy(
  state: "idle" | "applying" | "restarting" | "applied" | "failed",
  dirty: boolean,
): string {
  if (state === "applying") return "Applying on this device…";
  if (state === "restarting") return "Restarting the local host…";
  if (state === "applied") return "Applied on this device";
  if (state === "failed") return "Changes were not applied";
  return dirty ? "Changes ready to apply" : "Settings are up to date";
}

export function isProviderReady(
  provider: ZenXProviderProfile,
  subscriptionAuthenticated: boolean,
  hasApiKey: boolean,
  apiKey: string,
): boolean {
  return (
    provider.type === "fake" ||
    (provider.type === "openai-subscription"
      ? subscriptionAuthenticated
      : hasApiKey || apiKey.trim().length > 0)
  );
}

export async function cleanupLegacyJournalsAndRefreshThreads<T>(
  cleanup: () => Promise<T>,
  refreshThreads: () => Promise<void>,
): Promise<T> {
  const result = await cleanup();
  await refreshThreads();
  return result;
}

export function LegacyJournalCard({
  report,
  result,
  busy,
  onCleanup,
}: {
  report: JournalCompatibilityProjection | null;
  result: string | null;
  busy: boolean;
  onCleanup(): Promise<void>;
}) {
  if (report === null || report.counts.unavailable === 0) return null;
  const removable = report.counts.legacyNoUsefulContent;
  return (
    <div className="settings-card legacy-maintenance">
      <div className="legacy-card-title">
        <Icon name="warning" size={15} />
        <div>
          <h2>{report.counts.unavailable} unavailable journals</h2>
          <p>
            These were created by a legacy format or cannot be safely
            classified.
          </p>
        </div>
      </div>
      <dl>
        <div>
          <dt>Safe to clean up</dt>
          <dd>{removable}</dd>
        </div>
        <div>
          <dt>Useful legacy content</dt>
          <dd>{report.counts.legacyUsefulContent}</dd>
        </div>
        <div>
          <dt>Unknown or damaged</dt>
          <dd>{report.counts.unknown}</dd>
        </div>
      </dl>
      <p className="settings-note">
        Cleanup only moves known empty legacy entries to a recoverable
        quarantine. Useful and unknown files remain untouched.
      </p>
      <button
        className="secondary-button"
        type="button"
        disabled={busy || removable === 0}
        onClick={() => void onCleanup()}
      >
        {busy
          ? "Cleaning up…"
          : `Clean up ${removable} safe ${removable === 1 ? "entry" : "entries"}`}
      </button>
      {result === null ? null : (
        <p className="cleanup-result" role="status">
          {result}
        </p>
      )}
    </div>
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

function ManualCode({ onSubmit }: { onSubmit(value: string): void }) {
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
        onClick={() => onSubmit(value)}
      >
        Continue
      </button>
    </div>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
