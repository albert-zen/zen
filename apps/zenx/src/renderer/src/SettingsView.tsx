import { useEffect, useState } from "react";

import type {
  PublicHostSettings,
  ZenXHostProfile,
  ZenXProviderProfile,
} from "../../main/host-profile.js";
import { Icon } from "./icons.js";
import { CapabilitySettings } from "./CapabilitySettings.js";

export function SettingsView({ onClose }: { onClose(): void }) {
  const [settings, setSettings] = useState<PublicHostSettings | null>(null);
  const [draft, setDraft] = useState<ZenXHostProfile | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState(false);

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
    try {
      const modelList = models
        .split(/[\n,]/u)
        .map((value) => value.trim())
        .filter(Boolean);
      const value = await window.zenx.settings.save(
        { ...draft, onboardingComplete: true, models: modelList },
        apiKey.trim().length > 0 ? apiKey : undefined,
      );
      setSettings(value);
      setDraft(value.profile);
      setApiKey("");
      onClose();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  };

  const login = async () => {
    setBusy("login");
    setError(null);
    try {
      const value = await window.zenx.settings.loginSubscription();
      setSettings(value);
      setManualCode(false);
    } catch (reason) {
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
  return (
    <section className="settings-view" aria-label="ZenX settings">
      <header className="settings-header">
        <div>
          <span>ZenX host</span>
          <h1>
            {draft.onboardingComplete ? "Settings" : "Connect a provider"}
          </h1>
          <p>
            Credentials stay on this Mac. Threads only record the effective
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
        <CapabilitySettings />
        {error === null ? null : (
          <div className="settings-error" role="alert">
            <Icon name="warning" size={14} />
            {error}
          </div>
        )}
        <div className="settings-actions">
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null}
            onClick={() => void save()}
          >
            {busy === "save" ? "Restarting host…" : "Save and restart host"}
          </button>
        </div>
      </div>
    </section>
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
