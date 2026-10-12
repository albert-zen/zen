import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { useEffect, useRef, useState } from "react";
import type { AgentProviderInstance } from "../../main/agent-providers/types.js";
import { agentProvidersApi } from "./agent-providers-ui.js";
import { agentProviderError } from "./agent-provider-state.js";
import { Select } from "./ui/controls.js";

export function AgentProviderSettings({
  active,
  onOpenZen,
  onChanged,
}: {
  active: boolean;
  onOpenZen(tab: "account" | "models"): void;
  onChanged?(): void;
}) {
  useTranslation("shell");
  const [saved, setSaved] = useState<AgentProviderInstance[]>([]);
  const [drafts, setDrafts] = useState<AgentProviderInstance[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [kind, setKind] = useState<"codex" | "opencode">("codex");
  const loaded = useRef(false);
  const checkEpochs = useRef(new Map<string, number>());
  const [checks, setChecks] = useState<
    Record<string, { loading: boolean; message: string; error: boolean }>
  >({});
  const check = async (instance: AgentProviderInstance) => {
    const epoch = (checkEpochs.current.get(instance.id) ?? 0) + 1;
    checkEpochs.current.set(instance.id, epoch);
    setChecks((latest) => ({
      ...latest,
      [instance.id]: {
        loading: true,
        message: i18n.t("shell:providerLoadingModels"),
        error: false,
      },
    }));
    try {
      const models = await agentProvidersApi()!.models(instance.id);
      if (checkEpochs.current.get(instance.id) !== epoch) return;
      const available = models.filter((entry) => !entry.hidden);
      setChecks((latest) => ({
        ...latest,
        [instance.id]: {
          loading: false,
          message:
            available.length === 0
              ? i18n.t("shell:providerConnectedEmpty")
              : i18n.t("shell:providerConnectedModels", {
                  count: available.length,
                }),
          error: available.length === 0,
        },
      }));
    } catch (reason) {
      if (checkEpochs.current.get(instance.id) !== epoch) return;
      setChecks((latest) => ({
        ...latest,
        [instance.id]: {
          loading: false,
          message: i18n.t("shell:providerCheckFailure", {
            error: agentProviderError(reason),
          }),
          error: true,
        },
      }));
    }
  };
  useEffect(() => {
    if (!active || loaded.current) return;
    let current = true;
    const api = agentProvidersApi();
    if (!api) {
      setError(i18n.t("shell:providerSettingsUnavailable"));
      return;
    }
    void api.list().then(
      (instances) => {
        if (!current) return;
        loaded.current = true;
        setSaved(instances.filter((instance) => instance.kind !== "zen"));
        setDrafts((value) => [
          ...instances.filter((instance) => instance.kind !== "zen"),
          ...value,
        ]);
      },
      (reason) => {
        if (current) setError(agentProviderError(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [active, loadRevision]);
  const edit = (id: string, change: Partial<AgentProviderInstance>) => {
    setStatus(null);
    checkEpochs.current.set(id, (checkEpochs.current.get(id) ?? 0) + 1);
    setChecks((latest) => {
      const next = { ...latest };
      delete next[id];
      return next;
    });
    setDrafts((value) =>
      value.map((instance) =>
        instance.id === id ? { ...instance, ...change } : instance,
      ),
    );
  };
  const save = async (instance: AgentProviderInstance) => {
    if (busy !== null) return;
    if (!instance.name.trim()) {
      setError(i18n.t("shell:providerEnterName"));
      return;
    }
    setBusy(instance.id);
    setError(null);
    setStatus(null);
    try {
      const result = await agentProvidersApi()!.save({
        ...instance,
        name: instance.name.trim(),
        executable: instance.executable?.trim() || undefined,
        defaultModel: instance.defaultModel?.trim() || undefined,
      });
      setSaved((value) => [
        ...value.filter((entry) => entry.id !== result.id),
        result,
      ]);
      // A save cannot erase edits made while the request was in flight.
      setDrafts((value) =>
        value.map((entry) => (entry === instance ? result : entry)),
      );
      setStatus(i18n.t("shell:providerSaved", { name: result.name }));
      onChanged?.();
    } catch (reason) {
      setError(agentProviderError(reason));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="agent-provider-settings">
      <header>
        <h2>{i18n.t("shell:agentProviders")}</h2>
      </header>
      <section className="settings-card agent-provider-card">
        <h3>Zen</h3>
        <div className="agent-provider-zen-links">
          <button
            className="quiet-button"
            type="button"
            onClick={() => onOpenZen("models")}
          >
            {i18n.t("shell:providerModels")}
          </button>
          <button
            className="quiet-button"
            type="button"
            onClick={() => onOpenZen("account")}
          >
            {i18n.t("shell:providerAccount")}
          </button>
        </div>
      </section>
      {drafts.map((instance) => {
        const original = saved.find((entry) => entry.id === instance.id);
        const dirty = JSON.stringify(instance) !== JSON.stringify(original);
        const supported =
          instance.kind === "codex" || instance.kind === "opencode";
        return (
          <section
            className="settings-card agent-provider-card"
            key={instance.id}
            aria-label={i18n.t("shell:providerInstanceLabel", {
              kind: instance.kind,
            })}
          >
            <h3>
              {instance.kind === "codex"
                ? "Codex"
                : instance.kind === "opencode"
                  ? "OpenCode"
                  : instance.kind}
            </h3>
            {supported ? (
              <>
                <label className="field">
                  {i18n.t("shell:providerName")}
                  <input
                    aria-label={i18n.t("shell:providerInstanceName", {
                      kind: instance.kind,
                    })}
                    value={instance.name}
                    onChange={(event) =>
                      edit(instance.id, { name: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  {i18n.t("shell:providerExecutable")}
                  <input
                    aria-label={i18n.t("shell:providerExecutableLabel", {
                      kind: instance.kind,
                    })}
                    placeholder={
                      instance.kind === "codex" ? "codex" : "opencode"
                    }
                    value={instance.executable ?? ""}
                    onChange={(event) =>
                      edit(instance.id, { executable: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  {i18n.t("shell:providerDefaultModel")}
                  <input
                    aria-label={i18n.t("shell:providerDefaultModelLabel", {
                      kind: instance.kind,
                    })}
                    placeholder={i18n.t("shell:providerDefault")}
                    value={instance.defaultModel ?? ""}
                    onChange={(event) =>
                      edit(instance.id, { defaultModel: event.target.value })
                    }
                  />
                </label>
                {original === undefined ? null : (
                  <div className="agent-provider-check">
                    <button
                      className="quiet-button"
                      type="button"
                      disabled={
                        busy !== null || dirty || checks[instance.id]?.loading
                      }
                      onClick={() => void check(instance)}
                    >
                      {checks[instance.id]?.loading
                        ? i18n.t("shell:providerLoadingModels")
                        : i18n.t("shell:providerLoadModels")}
                    </button>
                    {checks[instance.id] === undefined ? null : (
                      <p role={checks[instance.id]!.error ? "alert" : "status"}>
                        {checks[instance.id]!.message}
                      </p>
                    )}
                  </div>
                )}
                <div className="agent-provider-save">
                  <button
                    className="primary-button"
                    type="button"
                    disabled={busy !== null || !dirty}
                    onClick={() => void save(instance)}
                  >
                    {busy === instance.id
                      ? i18n.t("shell:providerSaving")
                      : i18n.t("shell:providerSave")}
                  </button>
                </div>
              </>
            ) : (
              <p>{i18n.t("shell:providerUnsupportedBuild")}</p>
            )}
          </section>
        );
      })}
      <div className="agent-provider-add">
        <Select
          aria-label={i18n.t("shell:providerAddType")}
          value={kind}
          onValueChange={(value) => setKind(value as typeof kind)}
        >
          <option value="codex">Codex</option>
          <option value="opencode">OpenCode</option>
        </Select>
        <button
          className="quiet-button"
          type="button"
          disabled={busy !== null}
          onClick={() =>
            setDrafts((value) => [
              ...value,
              {
                id: crypto.randomUUID(),
                kind,
                name: `${kind === "codex" ? "Codex" : "OpenCode"}${value.filter((instance) => instance.kind === kind).length ? ` ${value.filter((instance) => instance.kind === kind).length + 1}` : ""}`,
              },
            ])
          }
        >
          {i18n.t("shell:providerAddInstance")}
        </button>
      </div>
      {error === null ? null : (
        <p className="settings-error" role="alert">
          {error}
          {loaded.current ? null : (
            <button
              className="quiet-button"
              type="button"
              onClick={() => {
                setError(null);
                setLoadRevision((value) => value + 1);
              }}
            >
              {i18n.t("shell:providerRetry")}
            </button>
          )}
        </p>
      )}
      {status === null ? null : <p role="status">{status}</p>}
    </div>
  );
}
