import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AgentProviderCapabilities,
  AgentProviderInstance,
  AgentSessionBinding,
  AgentSessionSnapshot,
  AgentProvidersApi,
} from "../../main/agent-providers/types.js";
import type {
  ModelSummary,
  FilePermissionMode,
} from "../../protocol-client/types.js";
import { Select } from "./ui/controls.js";
import { ThreadView } from "./ThreadView.js";
import {
  agentProviderError,
  selectAgentModel,
  subscribeAgentRefresh,
} from "./agent-provider-state.js";
import {
  acceptComposerSubmission,
  beginComposerSubmission,
  editComposer,
  emptyComposerState,
  failComposerSubmission,
  removeComposerImage,
  type ComposerState,
} from "./composer-state.js";
import { activeTurn } from "./thread-view-state.js";

export function agentProviderLabel(instance: AgentProviderInstance): string {
  const engine =
    instance.kind === "codex"
      ? "Codex"
      : instance.kind === "opencode"
        ? "OpenCode"
        : instance.kind === "zen"
          ? "Zen"
          : instance.kind;
  return instance.name.toLocaleLowerCase().includes(engine.toLocaleLowerCase())
    ? instance.name
    : `${instance.name} · ${engine}`;
}

const ZEN: AgentProviderInstance = { id: "zen", kind: "zen", name: "Zen" };
export function agentProvidersApi(): AgentProvidersApi | undefined {
  return window.zenx?.agentProviders;
}

export function useAgentProviders() {
  const [instances, setInstances] = useState<AgentProviderInstance[]>([ZEN]);
  const [sessions, setSessions] = useState<AgentSessionBinding[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const rememberSnapshot = useCallback((snapshot: AgentSessionSnapshot) => {
    const label =
      snapshot.thread.name?.trim() || snapshot.thread.preview.trim();
    if (label)
      setLabels((latest) =>
        latest[snapshot.binding.id] === label
          ? latest
          : { ...latest, [snapshot.binding.id]: label },
      );
  }, []);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    const api = agentProvidersApi();
    if (!api) return;
    const request = ++epoch.current;
    try {
      const [providers, bindings] = await Promise.all([
        api.list(),
        api.sessions(),
      ]);
      if (request !== epoch.current) return;
      setInstances(
        providers.filter(
          (provider) =>
            provider.kind === "zen" ||
            provider.kind === "codex" ||
            provider.kind === "opencode",
        ),
      );
      setSessions(bindings);
      setError(null);
    } catch (reason) {
      if (request === epoch.current) setError(agentProviderError(reason));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const api = agentProvidersApi();
    const dispose = api && subscribeAgentRefresh(api, null, refresh);
    return () => {
      epoch.current += 1;
      dispose?.();
    };
  }, [refresh]);
  return {
    instances,
    sessions,
    error,
    labels,
    rememberSnapshot,
    refresh,
    rememberSession: (binding: AgentSessionBinding) =>
      setSessions((latest) => [
        ...latest.filter((entry) => entry.id !== binding.id),
        binding,
      ]),
  };
}

export function AgentProviderSelector({
  instances,
  value,
  onChange,
  disabled = false,
}: {
  instances: readonly AgentProviderInstance[];
  value: string;
  onChange(id: string): void;
  disabled?: boolean;
}) {
  return (
    <Select
      aria-label="Agent Provider"
      className="agent-provider-select"
      value={value}
      disabled={disabled}
      onValueChange={onChange}
    >
      {instances.map((instance) => (
        <option key={instance.id} value={instance.id}>
          {agentProviderLabel(instance)}
        </option>
      ))}
    </Select>
  );
}

export function useAgentModels(instance: AgentProviderInstance | undefined) {
  const id = instance?.id ?? "";
  const [state, setState] = useState<{
    id: string;
    models: ModelSummary[];
    error: string | null;
    loading: boolean;
    capabilities: AgentProviderCapabilities | null;
    capabilityError: string | null;
  }>({
    id: "",
    models: [],
    error: null,
    loading: false,
    capabilities: null,
    capabilityError: null,
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!instance || instance.kind === "zen") return;
    let current = true;
    setState((latest) => ({
      id,
      models: [],
      error: null,
      loading: true,
      capabilities: latest.id === id ? latest.capabilities : null,
      capabilityError: null,
    }));
    const api = agentProvidersApi();
    if (!api) {
      setState({
        id,
        models: [],
        error: "Agent Providers are unavailable",
        loading: false,
        capabilities: null,
        capabilityError: null,
      });
      return;
    }
    void api.capabilities(id).then(
      (capabilities) => {
        if (current)
          setState((latest) => ({
            ...latest,
            capabilities,
            capabilityError: null,
          }));
      },
      (reason) => {
        if (current)
          setState((latest) => ({
            ...latest,
            capabilityError: agentProviderError(reason),
          }));
      },
    );
    void api.models(id).then(
      (catalog) => {
        if (current)
          setState((latest) => ({
            ...latest,
            models: catalog.filter((model) => !model.hidden),
            error: null,
            loading: false,
          }));
      },
      (reason) => {
        if (current)
          setState((latest) => ({
            ...latest,
            models: [],
            error: agentProviderError(reason),
            loading: false,
          }));
      },
    );
    return () => {
      current = false;
    };
  }, [id, instance?.kind, instance?.executable, revision]);
  return {
    ...(state.id === id
      ? { ...state, error: state.error ?? state.capabilityError }
      : { models: [], error: null, loading: true, capabilities: null }),
    retry: () => setRevision((value) => value + 1),
  };
}

export function AgentSessionNavigation({
  sessions,
  instances,
  selectedId,
  labels = {},
  onOpen,
  error,
  onRetry,
}: {
  sessions: readonly AgentSessionBinding[];
  instances: readonly AgentProviderInstance[];
  selectedId: string | null;
  labels?: Readonly<Record<string, string>>;
  onOpen(id: string): void;
  error: string | null;
  onRetry(): void;
}) {
  if (sessions.length === 0 && error === null) return null;
  return (
    <section
      className="agent-session-navigation"
      aria-label="External agent sessions"
    >
      <h2>Agent sessions</h2>
      {sessions.map((session) => {
        const instance = instances.find(
          (candidate) => candidate.id === session.providerInstanceId,
        );
        const name = instance
          ? agentProviderLabel(instance)
          : session.providerInstanceId;
        const cwd =
          session.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? session.cwd;
        return (
          <button
            className="agent-session-row"
            type="button"
            key={session.id}
            aria-current={selectedId === session.id ? "page" : undefined}
            title={`${name} · ${session.cwd} · ${session.nativeSessionId}`}
            onClick={() => onOpen(session.id)}
          >
            <span>
              {labels[session.id] ||
                `Session ${session.nativeSessionId.slice(0, 8)}`}
            </span>
            <small>
              {name} · {cwd}
            </small>
          </button>
        );
      })}
      {error === null ? null : (
        <div className="settings-error" role="alert">
          {error}
          <button className="quiet-button" type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
    </section>
  );
}

export function ExternalAgentSession({
  instance,
  sessionId,
  composer,
  onComposerChange,
  onCreated,
  workspace,
  permissionMode = "workspace-write",
  providerControl,
  emptyContent,
  onPermissionChange,
  onOperationChange,
  onSnapshot,
  draftModel,
  onDraftModelChange,
  projectError = null,
}: {
  instance: AgentProviderInstance | undefined;
  sessionId: string | null;
  composer: ComposerState;
  onComposerChange(update: (state: ComposerState) => ComposerState): void;
  onCreated(snapshot: AgentSessionSnapshot): void;
  workspace: string | null;
  permissionMode?: FilePermissionMode;
  providerControl?: ReactNode;
  emptyContent?: ReactNode;
  onPermissionChange?(mode: FilePermissionMode): void;
  onOperationChange?(pending: boolean, selectedModel?: string): void;
  draftModel?: string;
  projectError?: string | null;
  onDraftModelChange?(model: string): void;
  onSnapshot?(snapshot: AgentSessionSnapshot): void;
}) {
  const [snapshot, setSnapshot] = useState<AgentSessionSnapshot | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  const [loading, setLoading] = useState(sessionId !== null);
  const [model, setModel] = useState("");
  const [operation, setOperation] = useState(false);
  const [approvals, setApprovals] = useState<
    Array<{
      requestId: string;
      title: string;
      detail: string;
      busy: boolean;
      error: string | null;
    }>
  >([]);
  const readEpoch = useRef(0);
  const approvalVersion = useRef(0);
  const approvalEvents = useRef(
    new Map<string, { version: number; resolved: boolean }>(),
  );
  const selection = useRef({
    sessionId,
    instanceId: instance?.id,
    generation: 0,
  });
  if (
    selection.current.sessionId !== sessionId ||
    selection.current.instanceId !== instance?.id
  )
    selection.current = {
      sessionId,
      instanceId: instance?.id,
      generation: selection.current.generation + 1,
    };
  useEffect(
    () => () => {
      selection.current.generation += 1;
    },
    [],
  );
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const operationRef = useRef(false);
  const models = useAgentModels(instance);
  const generation = selection.current.generation;
  const current = () => selection.current.generation === generation;
  const refresh = useCallback(async () => {
    if (sessionId === null) return;
    const request = ++readEpoch.current;
    try {
      const version = approvalVersion.current;
      const [value, pending] = await Promise.all([
        agentProvidersApi()!.read(sessionId),
        agentProvidersApi()!.approvals(sessionId),
      ]);
      if (
        readEpoch.current !== request ||
        selection.current.sessionId !== sessionId ||
        selection.current.generation !== generation
      )
        return;
      setApprovals((latest) => {
        const newer = latest.filter(
          (entry) =>
            (approvalEvents.current.get(entry.requestId)?.version ?? 0) >
            version,
        );
        const existing = new Map(
          latest.map((entry) => [entry.requestId, entry]),
        );
        return [
          ...pending
            .filter((entry) => {
              const event = approvalEvents.current.get(entry.requestId);
              return !(event && event.version > version && event.resolved);
            })
            .map((entry) => ({
              ...entry,
              busy: existing.get(entry.requestId)?.busy ?? false,
              error: existing.get(entry.requestId)?.error ?? null,
            })),
          ...newer.filter(
            (entry) =>
              !pending.some((item) => item.requestId === entry.requestId),
          ),
        ];
      });
      setSnapshot(value);
      onSnapshot?.(value);
      setReadError(null);
      setLoading(false);
    } catch (reason) {
      if (
        readEpoch.current !== request ||
        selection.current.sessionId !== sessionId ||
        selection.current.generation !== generation
      )
        return;
      setReadError(agentProviderError(reason));
      setLoading(false);
    }
  }, [sessionId, generation]);
  useEffect(() => {
    approvalEvents.current.clear();
    approvalVersion.current = 0;
    setSnapshot(null);
    setModel("");
    setApprovals([]);
    setReadError(null);
    setEventError(null);
    setLoading(sessionId !== null);
    void refresh();
    const api = agentProvidersApi();
    if (!api) return;
    const refreshDispose =
      sessionId === null
        ? undefined
        : subscribeAgentRefresh(api, sessionId, refresh);
    const dispose = api.onEvent((event) => {
      if (selection.current.generation !== generation) return;
      const belongsToSession =
        sessionId !== null && event.sessionId === sessionId;
      const belongsToInstance =
        event.type === "error" &&
        event.sessionId === undefined &&
        event.providerInstanceId !== undefined &&
        event.providerInstanceId === instance?.id;
      if (!belongsToSession && !belongsToInstance) return;
      if (event.type === "error") setEventError(event.message);
      if (event.type === "approvalResolved") {
        approvalEvents.current.set(event.requestId, {
          version: ++approvalVersion.current,
          resolved: true,
        });
        setApprovals((latest) =>
          latest.filter((item) => item.requestId !== event.requestId),
        );
      }
      if (event.type === "approval") {
        approvalEvents.current.set(event.requestId, {
          version: ++approvalVersion.current,
          resolved: false,
        });
        setApprovals((latest) =>
          latest.some((item) => item.requestId === event.requestId)
            ? latest
            : [...latest, { ...event, busy: false, error: null }],
        );
      }
    });
    return () => {
      refreshDispose?.();
      dispose();
    };
  }, [refresh, sessionId, generation]);
  const permissions = models.capabilities?.permissionModes ?? [];
  const permissionValid =
    sessionId !== null || permissions.includes(permissionMode);
  const selectedModel =
    (sessionId === null ? draftModel : undefined) ||
    model ||
    (sessionId !== null
      ? (snapshot?.model ?? "")
      : selectAgentModel(models.models, instance?.defaultModel));
  const visibleSnapshot = snapshot?.binding.id === sessionId ? snapshot : null;
  const submit = async () => {
    if (
      operationRef.current ||
      !permissionValid ||
      projectError !== null ||
      !instance ||
      workspace === null ||
      !selectedModel ||
      models.loading ||
      !models.models.some((entry) => entry.id === selectedModel)
    )
      return;
    if (visibleSnapshot !== null && activeTurn(visibleSnapshot.thread) !== null)
      return;
    const started = beginComposerSubmission(
      composerRef.current,
      "start",
      null,
      () => crypto.randomUUID(),
    );
    const submission = started.submission;
    if (submission === null || started === composerRef.current) return;
    operationRef.current = true;
    setOperation(true);
    onOperationChange?.(true, selectedModel);
    onComposerChange(() => started);
    let created: AgentSessionSnapshot | null = null;
    try {
      const api = agentProvidersApi()!;
      if (sessionId === null)
        created = await api.create({
          providerInstanceId: instance.id,
          cwd: workspace,
          model: selectedModel,
          permissionMode,
        });
      const id = created?.binding.id ?? sessionId!;
      // A created native session remains discoverable even if the user navigated away.
      if (created !== null) onCreated(created);
      await api.send(id, { text: submission.text, model: selectedModel });
      onComposerChange((latest) =>
        acceptComposerSubmission(latest, submission.clientUserMessageId),
      );
      if (current() && created === null) {
        setModel("");
        await refresh();
      }
    } catch (reason) {
      onComposerChange((latest) =>
        failComposerSubmission(
          latest,
          submission.clientUserMessageId,
          agentProviderError(reason),
        ),
      );
    } finally {
      operationRef.current = false;
      onOperationChange?.(false);
      if (current()) setOperation(false);
    }
  };
  const respond = async (requestId: string, decision: "accept" | "decline") => {
    if (sessionId === null) return;
    setApprovals((latest) =>
      latest.map((entry) =>
        entry.requestId === requestId
          ? { ...entry, busy: true, error: null }
          : entry,
      ),
    );
    try {
      await agentProvidersApi()!.respondApproval(
        sessionId,
        requestId,
        decision,
      );
      if (current()) {
        approvalEvents.current.set(requestId, {
          version: ++approvalVersion.current,
          resolved: true,
        });
        setApprovals((latest) =>
          latest.filter((entry) => entry.requestId !== requestId),
        );
        await refresh();
        if (current())
          document.getElementById(`agent-composer-${sessionId}`)?.focus();
      }
    } catch (reason) {
      if (current())
        setApprovals((latest) =>
          latest.map((entry) =>
            entry.requestId === requestId
              ? { ...entry, busy: false, error: agentProviderError(reason) }
              : entry,
          ),
        );
    }
  };
  const running =
    visibleSnapshot !== null && activeTurn(visibleSnapshot.thread) !== null;
  const issue =
    instance === undefined
      ? "This Agent Provider instance is unavailable"
      : (projectError ??
        eventError ??
        readError ??
        (composer.draft.images.length > 0
          ? "This Agent Provider cannot send attached images. Remove them or switch to Zen."
          : null) ??
        models.error ??
        (models.loading
          ? "Loading models…"
          : !permissionValid
            ? "Choose a supported file permission mode"
            : selectedModel === ""
              ? "No models available"
              : !models.models.some((entry) => entry.id === selectedModel)
                ? "The selected model is unavailable"
                : null));
  return (
    <section
      className={`agent-surface${sessionId === null ? " new-thread-draft-surface" : ""}`}
    >
      {loading ? (
        <div className="page-loading">
          <div className="loading-ring" />
          <p>Loading conversation…</p>
        </div>
      ) : (
        <ThreadView
          composerId={`agent-composer-${sessionId ?? instance?.id ?? "draft"}`}
          zenFeatures={false}
          composer={composer}
          thread={visibleSnapshot?.thread ?? null}
          approvals={[]}
          emptyContent={emptyContent}
          composerDisabled={instance === undefined}
          sendDisabled={running || workspace === null || issue !== null}
          interruptDisabled={models.capabilities?.interrupt !== true}
          modelError={issue}
          imageCapabilityError="This Agent Provider cannot send image attachments"
          onReadAttachment={(attachment) =>
            window.zenx.imageAttachments.read(attachment)
          }
          onRemoveImage={(imageId) =>
            onComposerChange((latest) => removeComposerImage(latest, imageId))
          }
          permissionLabel={null}
          permissionMode={permissionMode}
          onPermissionChange={onPermissionChange}
          composerTools={
            <>
              {providerControl}
              <Select
                aria-label="Agent model"
                value={selectedModel}
                disabled={
                  operation ||
                  running ||
                  models.loading ||
                  (sessionId !== null &&
                    models.capabilities?.changeModel !== true)
                }
                onValueChange={(value) => {
                  if (sessionId === null && onDraftModelChange)
                    onDraftModelChange(value);
                  else setModel(value);
                }}
              >
                {models.models.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.displayName}
                  </option>
                ))}
              </Select>
              {sessionId === null ? (
                <Select
                  aria-label="File permissions"
                  value={permissionMode}
                  disabled={operation || models.loading}
                  onValueChange={(value) =>
                    onPermissionChange?.(value as FilePermissionMode)
                  }
                >
                  {permissions.includes(permissionMode) ? null : (
                    <option value={permissionMode}>Choose permissions</option>
                  )}
                  {permissions.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode === "danger-full-access"
                        ? "Full access"
                        : mode === "read-only"
                          ? "Read only"
                          : "Workspace write"}
                    </option>
                  ))}
                </Select>
              ) : null}
              {models.error === null ? null : (
                <button
                  className="quiet-button"
                  type="button"
                  onClick={models.retry}
                >
                  Retry models
                </button>
              )}
            </>
          }
          composerContext={
            <>
              {instance?.kind === "opencode" && sessionId === null ? (
                <p className="agent-provider-warning">
                  OpenCode has no filesystem sandbox. Full access permits tools
                  to access files outside this Project.
                </p>
              ) : null}
              {approvals.map((approval) => (
                <div
                  className="agent-approval"
                  key={approval.requestId}
                  role="group"
                  aria-label={approval.title}
                >
                  <strong>{approval.title}</strong>
                  <pre>{approval.detail}</pre>
                  {approval.error === null ? null : (
                    <p role="alert">{approval.error}</p>
                  )}
                  <div>
                    <button
                      className="quiet-button"
                      type="button"
                      disabled={approval.busy}
                      onClick={() =>
                        void respond(approval.requestId, "decline")
                      }
                    >
                      Decline
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={approval.busy}
                      onClick={() => void respond(approval.requestId, "accept")}
                    >
                      {approval.busy ? "Responding…" : "Approve"}
                    </button>
                  </div>
                </div>
              ))}
            </>
          }
          onDraftChange={(text) =>
            onComposerChange((state) => editComposer(state, text))
          }
          onInterrupt={async () => {
            if (sessionId !== null) {
              await agentProvidersApi()!.interrupt(sessionId);
              await refresh();
            }
          }}
          onRespondToApproval={async () => undefined}
          onSubmit={submit}
        />
      )}
      {readError === null && eventError === null ? null : (
        <button
          className="quiet-button agent-session-retry"
          type="button"
          onClick={() => {
            setEventError(null);
            void refresh();
          }}
        >
          Retry conversation
        </button>
      )}
    </section>
  );
}
