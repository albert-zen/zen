import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import {
  AgentProviderModelScope,
  agentProviderLabel,
  type AgentProviderSelection,
} from "./agent-provider-selection.js";
import { ComposerModelMenu } from "./ComposerModelMenu.js";
export { agentProviderLabel } from "./agent-provider-selection.js";
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
import type { AgentNavigationSession } from "./thread-list.js";
import { activeTurn } from "./thread-view-state.js";

const ZEN: AgentProviderInstance = { id: "zen", kind: "zen", name: "Zen" };
export function agentProvidersApi(): AgentProvidersApi | undefined {
  return window.zenx?.agentProviders;
}

export function useAgentProviders() {
  const [instances, setInstances] = useState<AgentProviderInstance[]>([ZEN]);
  const [sessions, setSessions] = useState<AgentSessionBinding[]>([]);
  const [observations, setObservations] = useState<
    Record<string, Omit<AgentNavigationSession, "binding" | "providerLabel">>
  >({});
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [pendingApprovals, setPendingApprovals] = useState<
    Record<string, string[]>
  >({});
  const failureVersions = useRef(new Map<string, number>());
  const observationVersions = useRef(new Map<string, number>());
  const readRequests = useRef(new Map<string, number>());
  const rememberSnapshot = useCallback(
    (snapshot: AgentSessionSnapshot, failureVersion = 0) => {
      const title =
        snapshot.thread.name?.trim() || snapshot.thread.preview.trim();
      setObservations((latest) => ({
        ...latest,
        [snapshot.binding.id]: {
          ...(title ? { title } : {}),
          model: snapshot.model,
          updatedAt: snapshot.thread.updatedAt * 1000,
          status:
            (failureVersions.current.get(snapshot.binding.providerInstanceId) ??
              0) > failureVersion
              ? "error"
              : snapshot.thread.status.type === "active"
                ? "active"
                : snapshot.thread.status.type === "idle"
                  ? "idle"
                  : snapshot.thread.status.type === "systemError"
                    ? "error"
                    : undefined,
        },
      }));
    },
    [],
  );
  // Only a read begun after the latest native event can replace its observation.
  const readSession = useCallback(
    async (sessionId: string) => {
      const failures = new Map(failureVersions.current);
      const observation = observationVersions.current.get(sessionId) ?? 0;
      const request = (readRequests.current.get(sessionId) ?? 0) + 1;
      readRequests.current.set(sessionId, request);
      const snapshot = await agentProvidersApi()!.read(sessionId);
      const instanceId = snapshot.binding.providerInstanceId;
      if (
        readRequests.current.get(sessionId) === request &&
        (observationVersions.current.get(sessionId) ?? 0) === observation &&
        (failureVersions.current.get(instanceId) ?? 0) ===
          (failures.get(instanceId) ?? 0)
      )
        rememberSnapshot(snapshot, failures.get(instanceId) ?? 0);
      return snapshot;
    },
    [rememberSnapshot],
  );
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
    const disposeApprovals = api?.onEvent((event) => {
      if (
        event.type === "error" &&
        event.sessionId === undefined &&
        event.providerInstanceId !== undefined
      )
        failureVersions.current.set(
          event.providerInstanceId,
          (failureVersions.current.get(event.providerInstanceId) ?? 0) + 1,
        );
      if (event.sessionId !== undefined)
        observationVersions.current.set(
          event.sessionId,
          (observationVersions.current.get(event.sessionId) ?? 0) + 1,
        );
      // A generic engine event invalidates a prior observation; it is not a terminal receipt.
      // Hidden sessions stay unknown until read, without starting saved engines or polling transcripts.
      setObservations((latest) => {
        const ids =
          event.sessionId !== undefined
            ? [event.sessionId]
            : event.type === "error"
              ? sessionsRef.current
                  .filter(
                    (binding) =>
                      binding.providerInstanceId === event.providerInstanceId,
                  )
                  .map((binding) => binding.id)
              : [];
        const next = { ...latest };
        for (const id of ids) {
          if (latest[id] || event.type === "error")
            next[id] = {
              ...latest[id],
              status:
                event.type === "error" || latest[id]?.status === "error"
                  ? "error"
                  : undefined,
            };
        }
        return next;
      });
      if (event.type !== "approval" && event.type !== "approvalResolved")
        return;
      setPendingApprovals((latest) => ({
        ...latest,
        [event.sessionId]:
          event.type === "approval"
            ? [
                ...new Set([
                  ...(latest[event.sessionId] ?? []),
                  event.requestId,
                ]),
              ]
            : (latest[event.sessionId] ?? []).filter(
                (id) => id !== event.requestId,
              ),
      }));
    });
    return () => {
      epoch.current += 1;
      dispose?.();
      disposeApprovals?.();
    };
  }, [refresh]);
  return {
    instances,
    sessions,
    error,
    labels: Object.fromEntries(
      Object.entries(observations).map(([id, observation]) => [
        id,
        observation.title ?? "",
      ]),
    ),
    navigationSessions: sessions.map((binding): AgentNavigationSession => {
      const instance = instances.find(
        (value) => value.id === binding.providerInstanceId,
      );
      return {
        binding,
        providerLabel: instance
          ? agentProviderLabel(instance)
          : binding.providerInstanceId,
        ...observations[binding.id],
        pendingApproval: (pendingApprovals[binding.id]?.length ?? 0) > 0,
      };
    }),
    rememberSnapshot,
    readSession,
    refresh,
    rememberSession: (binding: AgentSessionBinding) =>
      setSessions((latest) => [
        ...latest.filter((entry) => entry.id !== binding.id),
        binding,
      ]),
  };
}

export function useAgentModels(
  instance: AgentProviderInstance | undefined,
  cwd?: string,
) {
  const id = instance?.id ?? "";
  const scope = JSON.stringify([id, cwd ?? null]);
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
      id: scope,
      models: [],
      error: null,
      loading: true,
      capabilities: latest.id === scope ? latest.capabilities : null,
      capabilityError: null,
    }));
    const api = agentProvidersApi();
    if (!api) {
      setState({
        id: scope,
        models: [],
        error: i18n.t("shell:providerUnavailable"),
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
    void api.models(id, cwd).then(
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
  }, [id, instance?.kind, instance?.executable, revision, cwd]);
  return {
    ...(state.id === scope
      ? { ...state, error: state.error ?? state.capabilityError }
      : { models: [], error: null, loading: true, capabilities: null }),
    retry: () => setRevision((value) => value + 1),
  };
}

export function ExternalAgentSession({
  instance,
  sessionId,
  composer,
  onComposerChange,
  onCreated,
  workspace,
  permissionMode = "workspace-write",
  providerSelection,
  emptyContent,
  onPermissionChange,
  onOperationChange,
  readSession,
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
  providerSelection?: AgentProviderSelection;
  emptyContent?: ReactNode;
  onPermissionChange?(mode: FilePermissionMode): void;
  onOperationChange?(pending: boolean, selectedModel?: string): void;
  draftModel?: string;
  projectError?: string | null;
  onDraftModelChange?(model: string): void;
  readSession?(sessionId: string): Promise<AgentSessionSnapshot>;
}) {
  useTranslation("shell");
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
  const readingActive = useRef(false);
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
  useEffect(() => {
    readingActive.current = true;
    return () => {
      readingActive.current = false;
      readEpoch.current += 1;
    };
  }, []);
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const operationRef = useRef(false);
  const models = useAgentModels(
    instance,
    snapshot?.binding.id === sessionId
      ? snapshot.binding.cwd
      : (workspace ?? undefined),
  );
  const generation = selection.current.generation;
  const current = () => selection.current.generation === generation;
  const refresh = useCallback(async () => {
    if (sessionId === null || !readingActive.current) return;
    const request = ++readEpoch.current;
    try {
      const version = approvalVersion.current;
      const [value, pending] = await Promise.all([
        readSession
          ? readSession(sessionId)
          : agentProvidersApi()!.read(sessionId),
        agentProvidersApi()!.approvals(sessionId),
      ]);
      if (
        !readingActive.current ||
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
      setReadError(null);
      setLoading(false);
    } catch (reason) {
      if (
        !readingActive.current ||
        readEpoch.current !== request ||
        selection.current.sessionId !== sessionId ||
        selection.current.generation !== generation
      )
        return;
      setReadError(agentProviderError(reason));
      setLoading(false);
    }
  }, [sessionId, generation, readSession]);
  const initializedIdentity = useRef<number | null>(null);
  useEffect(() => {
    // Activity pauses effects without changing this conversation's identity.
    // Keep its exact display snapshot and local disclosures while rereading.
    if (initializedIdentity.current !== generation) {
      initializedIdentity.current = generation;
      approvalEvents.current.clear();
      approvalVersion.current = 0;
      setSnapshot(null);
      setModel("");
      setApprovals([]);
      setReadError(null);
      setEventError(null);
      setLoading(sessionId !== null);
    }
    void refresh();
    const api = agentProvidersApi();
    if (!api) return;
    const refreshDispose =
      sessionId === null
        ? undefined
        : subscribeAgentRefresh(api, sessionId, refresh);
    const dispose = api.onEvent((event) => {
      if (!readingActive.current || selection.current.generation !== generation)
        return;
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
    if (
      visibleSnapshot !== null &&
      (visibleSnapshot.thread.status.type === "active" ||
        activeTurn(visibleSnapshot.thread) !== null)
    )
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
        if (current() && readingActive.current)
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
    visibleSnapshot !== null &&
    (visibleSnapshot.thread.status.type === "active" ||
      activeTurn(visibleSnapshot.thread) !== null);
  const issue =
    instance === undefined
      ? i18n.t("shell:providerInstanceUnavailable")
      : (projectError ??
        eventError ??
        readError ??
        (composer.draft.images.length > 0
          ? i18n.t("shell:providerImagesUnsupported")
          : null) ??
        models.error ??
        (models.loading
          ? i18n.t("shell:providerLoadingModels")
          : !permissionValid
            ? i18n.t("shell:providerChoosePermission")
            : selectedModel === ""
              ? i18n.t("shell:providerNoModels")
              : !models.models.some((entry) => entry.id === selectedModel)
                ? i18n.t("shell:providerModelUnavailable")
                : null));
  return (
    <section
      className={`agent-surface${sessionId === null ? " new-thread-draft-surface" : ""}`}
    >
      {loading ? (
        <div className="page-loading">
          <div className="loading-ring" />
          <p>{i18n.t("shell:providerLoadingConversation")}</p>
        </div>
      ) : (
        <AgentProviderModelScope
          selection={
            providerSelection ??
            (instance ? { instances: [instance], value: instance.id } : null)
          }
        >
          <ThreadView
            composerId={`agent-composer-${sessionId ?? instance?.id ?? "draft"}`}
            zenFeatures={false}
            nativeSessionControl={{
              running,
              interrupt: async () => {
                if (sessionId === null) return;
                try {
                  await agentProvidersApi()!.interrupt(sessionId);
                } finally {
                  await refresh();
                }
              },
            }}
            composer={composer}
            thread={visibleSnapshot?.thread ?? null}
            approvals={[]}
            emptyContent={emptyContent}
            composerDisabled={instance === undefined}
            sendDisabled={running || workspace === null || issue !== null}
            interruptDisabled={models.capabilities?.interrupt !== true}
            modelError={issue}
            imageCapabilityError={i18n.t(
              "shell:providerImageAttachmentsUnsupported",
            )}
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
                <ComposerModelMenu
                  models={models.models}
                  providerProfiles={[]}
                  selectedModel={selectedModel}
                  selectedReasoningEffort={null}
                  modelError={models.error}
                  showReasoning={false}
                  loading={models.loading}
                  disabled={operation || running}
                  switching={false}
                  modelSelectionDisabled={
                    sessionId !== null &&
                    models.capabilities?.changeModel !== true
                  }
                  onReasoningChange={() => undefined}
                  onRetryModels={models.error ? models.retry : undefined}
                  onModelChange={(value) => {
                    if (sessionId === null && onDraftModelChange)
                      onDraftModelChange(value);
                    else setModel(value);
                  }}
                />
                {sessionId === null ? (
                  <Select
                    aria-label={i18n.t("shell:filePermissions")}
                    value={permissionMode}
                    disabled={operation || models.loading}
                    onValueChange={(value) =>
                      onPermissionChange?.(value as FilePermissionMode)
                    }
                  >
                    {permissions.includes(permissionMode) ? null : (
                      <option value={permissionMode}>
                        {i18n.t("shell:providerChoosePermissions")}
                      </option>
                    )}
                    {permissions.map((mode) => (
                      <option key={mode} value={mode}>
                        {mode === "danger-full-access"
                          ? i18n.t("shell:fullAccess")
                          : mode === "read-only"
                            ? i18n.t("shell:readOnly")
                            : i18n.t("shell:workspaceWrite")}
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
                    {i18n.t("shell:providerRetryModels")}
                  </button>
                )}
              </>
            }
            composerContext={
              <>
                {instance?.kind === "opencode" && sessionId === null ? (
                  <p className="agent-provider-warning">
                    {i18n.t("shell:providerOpenCodeWarning")}
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
                        {i18n.t("shell:providerDecline")}
                      </button>
                      <button
                        className="primary-button"
                        type="button"
                        disabled={approval.busy}
                        onClick={() =>
                          void respond(approval.requestId, "accept")
                        }
                      >
                        {approval.busy
                          ? i18n.t("shell:providerResponding")
                          : i18n.t("shell:providerApprove")}
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
        </AgentProviderModelScope>
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
          {i18n.t("shell:providerRetryConversation")}
        </button>
      )}
    </section>
  );
}
