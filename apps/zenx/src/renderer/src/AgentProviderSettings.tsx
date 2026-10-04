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
        message: "Loading models…",
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
              ? "Connected, but no models were returned"
              : `Connected · ${available.length} model${available.length === 1 ? "" : "s"} available`,
          error: available.length === 0,
        },
      }));
    } catch (reason) {
      if (checkEpochs.current.get(instance.id) !== epoch) return;
      setChecks((latest) => ({
        ...latest,
        [instance.id]: {
          loading: false,
          message: `${agentProviderError(reason)}. Check the executable and sign in through the native CLI if required.`,
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
      setError("Agent Provider settings are unavailable");
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
      setError("Enter an instance name");
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
      setStatus(`${result.name} saved`);
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
        <h2>Agent Providers</h2>
      </header>
      <section className="settings-card agent-provider-card">
        <h3>Zen</h3>
        <div className="agent-provider-zen-links">
          <button
            className="quiet-button"
            type="button"
            onClick={() => onOpenZen("models")}
          >
            Models &amp; providers
          </button>
          <button
            className="quiet-button"
            type="button"
            onClick={() => onOpenZen("account")}
          >
            Account
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
            aria-label={`${instance.kind} instance`}
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
                  Name
                  <input
                    aria-label={`${instance.kind} instance name`}
                    value={instance.name}
                    onChange={(event) =>
                      edit(instance.id, { name: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  Executable
                  <input
                    aria-label={`${instance.kind} executable`}
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
                  Default model
                  <input
                    aria-label={`${instance.kind} default model`}
                    placeholder="Provider default"
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
                        ? "Loading models…"
                        : "Load models"}
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
                    {busy === instance.id ? "Saving…" : "Save"}
                  </button>
                </div>
              </>
            ) : (
              <p>Not supported in this build</p>
            )}
          </section>
        );
      })}
      <div className="agent-provider-add">
        <Select
          aria-label="Add Agent Provider type"
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
          Add instance
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
              Retry
            </button>
          )}
        </p>
      )}
      {status === null ? null : <p role="status">{status}</p>}
    </div>
  );
}
