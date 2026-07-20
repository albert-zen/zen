import type {
  AgentAppClient,
  AgentAppNotification,
  AgentAppNotificationEnvelope,
  AgentAppNotificationListener,
  AgentAppRequest,
  AgentAppResponse,
  AgentAppSubscription,
} from '../product/index.js';
import type { ApprovalDecision, ThreadSnapshot } from '../product/index.js';
import { InteractionProjection, type WebUiState } from './web-ui-state.js';

export type WebUiRuntimeMode = 'real' | 'demo';

export type WebUiConnectionStatus =
  'disconnected' | 'connecting' | 'connected' | 'running' | 'failed';

export type WebUiConnectionState = {
  readonly status: WebUiConnectionStatus;
  readonly mode: WebUiRuntimeMode;
  readonly message?: string;
};

export type WebUiClientSnapshot = {
  readonly connection: WebUiConnectionState;
  readonly state: WebUiState;
};

export type WebUiClientOptions = {
  readonly client: AgentAppClient;
  readonly mode?: WebUiRuntimeMode;
  readonly projectRoot?: string;
  readonly projectName?: string;
};

export type WebUiClientListener = (snapshot: WebUiClientSnapshot) => void;

export class WebUiLifecycleCanceledError extends Error {
  constructor() {
    super('Web UI lifecycle operation was superseded');
    this.name = 'WebUiLifecycleCanceledError';
  }
}

export class WebUiClient {
  private readonly client: AgentAppClient;
  private readonly projectRoot: string;
  private readonly projectName: string;
  private selectedProjectId?: string;
  private readonly listeners = new Set<WebUiClientListener>();
  private unsubscribeFromServer?: AgentAppSubscription;
  private readonly projection = new InteractionProjection();
  private connection: WebUiConnectionState;
  private snapshot: WebUiClientSnapshot;
  private lifecycleGeneration = 0;
  private snapshotHandoff?: SnapshotHandoff;

  constructor(options: WebUiClientOptions) {
    this.client = options.client;
    this.projectRoot = options.projectRoot ?? '/';
    this.projectName = options.projectName ?? 'Zen project';
    this.connection = {
      status: 'disconnected',
      mode: options.mode ?? 'real',
    };
    this.snapshot = { connection: this.connection, state: this.projection.getSnapshot() };
  }

  getSnapshot(): WebUiClientSnapshot {
    return this.snapshot;
  }

  subscribe(listener: WebUiClientListener): AgentAppSubscription {
    this.listeners.add(listener);
    listener(this.getSnapshot());

    return () => {
      this.listeners.delete(listener);
    };
  }

  async connect(
    options: { readonly threadId?: string; readonly projectId?: string } = {}
  ): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    const previousProjectId = this.selectedProjectId;
    this.snapshotHandoff = undefined;
    this.disconnectFromServerOnly();
    const projectionChanged =
      options.projectId !== undefined && options.projectId !== previousProjectId
        ? this.clearProjection()
        : false;
    const connectionChanged = this.updateConnection({ status: 'connecting' });
    if (projectionChanged || connectionChanged) this.refreshSnapshot();
    const projectId = await this.selectProject(generation, options.projectId);
    if (projectId !== previousProjectId && this.clearProjection()) this.refreshSnapshot();
    const handoff = this.beginSnapshotHandoff(generation);
    this.unsubscribeFromServer = this.client.subscribe((notification) => {
      if (generation === this.lifecycleGeneration && notification.projectId === projectId) {
        this.receiveNotification(notification.notification);
      }
    });

    try {
      const thread = await this.requestThread(
        generation,
        options.threadId
          ? { method: 'thread/read', params: { projectId, threadId: options.threadId } }
          : {
              method: 'thread/create',
              params: { projectId, idempotencyKey: this.idempotencyKey() },
            },
        options.threadId ? 'thread/read' : 'thread/create'
      );
      const projectionChanged = this.installSnapshot(thread, handoff);
      const connectionChanged = this.deriveConnectionFromProjection();
      if (projectionChanged || connectionChanged) this.refreshSnapshot();
    } catch (cause) {
      this.cancelSnapshotHandoff(handoff);
      if (generation === this.lifecycleGeneration) this.fail(cause);
      throw cause;
    }
  }

  disconnect(): void {
    this.lifecycleGeneration += 1;
    this.snapshotHandoff = undefined;
    this.disconnectFromServerOnly();
    this.setConnection({ status: 'disconnected' });
  }

  dispose(): void {
    this.disconnect();
    this.listeners.clear();
  }

  async startThread(): Promise<void> {
    const handoff = this.beginSnapshotHandoff(this.lifecycleGeneration);
    try {
      const thread = await this.requestThread(
        this.lifecycleGeneration,
        {
          method: 'thread/create',
          params: { projectId: this.requireProjectId(), idempotencyKey: this.idempotencyKey() },
        },
        'thread/create'
      );
      const projectionChanged = this.installSnapshot(thread, handoff);
      const connectionChanged = this.deriveConnectionFromProjection();
      if (projectionChanged || connectionChanged) {
        this.refreshSnapshot();
      }
    } catch (cause) {
      this.cancelSnapshotHandoff(handoff);
      throw cause;
    }
  }

  async listThreads(): Promise<readonly ThreadSnapshot[]> {
    const response = await this.client.request({
      method: 'thread/list',
      params: { projectId: this.requireProjectId() },
    });

    if (response.ok && response.method === 'thread/list') {
      return response.result.threads as readonly ThreadSnapshot[];
    }

    if (!response.ok) {
      throw new Error(response.error.message);
    }

    throw new Error(`Expected thread/list response, received ${response.method}`);
  }

  async resumeThread(threadId: string): Promise<void> {
    const handoff = this.beginSnapshotHandoff(this.lifecycleGeneration);
    try {
      const thread = await this.requestThread(
        this.lifecycleGeneration,
        { method: 'thread/read', params: { projectId: this.requireProjectId(), threadId } },
        'thread/read'
      );
      const projectionChanged = this.installSnapshot(thread, handoff);
      const connectionChanged = this.deriveConnectionFromProjection();
      if (projectionChanged || connectionChanged) {
        this.refreshSnapshot();
      }
    } catch (cause) {
      this.cancelSnapshotHandoff(handoff);
      throw cause;
    }
  }

  async submitMessage(input: string): Promise<void> {
    const trimmed = input.trim();

    if (!trimmed) {
      return;
    }

    const thread = this.projection.getSnapshot().currentThread;

    if (!thread) {
      await this.startThread();
    }

    const threadId = this.projection.getSnapshot().currentThread?.id;

    if (!threadId) {
      throw new Error('Web UI has no current thread after thread/create');
    }

    this.setConnection({ status: 'running' });

    const response = await this.client.request({
      method: 'turn/start',
      params: {
        projectId: this.requireProjectId(),
        threadId,
        input: trimmed,
        idempotencyKey: this.idempotencyKey(),
      },
    });

    if (!response.ok) {
      this.fail(response.error.message);
      throw new Error(response.error.message);
    }
  }

  async interruptThread(): Promise<void> {
    const threadId = this.projection.getSnapshot().currentThread?.id;

    if (!threadId) {
      return;
    }

    const response = await this.client.request({
      method: 'turn/interrupt',
      params: {
        projectId: this.requireProjectId(),
        threadId,
        idempotencyKey: this.idempotencyKey(),
      },
    });

    if (!response.ok) {
      this.fail(response.error.message);
      throw new Error(response.error.message);
    }
  }

  async retryTurn(turnId?: string): Promise<void> {
    const threadId = this.projection.getSnapshot().currentThread?.id;

    if (!threadId) {
      return;
    }

    this.setConnection({ status: 'running' });
    const response = await this.client.request({
      method: 'turn/retry',
      params: {
        projectId: this.requireProjectId(),
        threadId,
        ...(turnId === undefined ? {} : { turnId }),
        idempotencyKey: this.idempotencyKey(),
      },
    });

    if (!response.ok) {
      this.fail(response.error.message);
      throw new Error(response.error.message);
    }
  }

  async resolveApproval(
    approval: { readonly approvalId: string; readonly threadId: string; readonly turnId: string },
    decision: ApprovalDecision
  ): Promise<void> {
    const response = await this.client.request({
      method: 'approval/resolve',
      params: {
        projectId: this.requireProjectId(),
        ...approval,
        decision,
        idempotencyKey: this.idempotencyKey(),
      },
    });

    if (!response.ok) {
      this.fail(response.error.message);
      throw new Error(response.error.message);
    }
  }

  private applyNotification(notification: AgentAppNotification): void {
    const previousThreadId = this.projection.getSnapshot().currentThread?.id;
    const projectionChanged = this.projection.apply(notification);
    const connectionChanged =
      notification.type === 'sync/reset' ||
      (notification.type === 'thread/started' && notification.thread.id !== previousThreadId)
        ? this.deriveConnectionFromProjection()
        : notification.type === 'turn/started'
          ? this.updateConnection({ status: 'running', message: undefined })
          : notification.type === 'turn/completed'
            ? this.updateConnection({ status: 'connected', message: undefined })
            : notification.type === 'turn/failed'
              ? this.updateConnection({ status: 'failed', message: notification.error.message })
              : false;
    if (projectionChanged || connectionChanged) this.refreshSnapshot();
  }

  private deriveConnectionFromProjection(): boolean {
    const thread = this.projection.getSnapshot().currentThread;
    if (!thread || thread.status === 'idle') {
      return this.updateConnection({ status: 'connected', message: undefined });
    }
    if (thread.status === 'running') {
      return this.updateConnection({ status: 'running', message: undefined });
    }
    return this.updateConnection({
      status: 'failed',
      message: readThreadFailureMessage(thread),
    });
  }

  private beginSnapshotHandoff(generation: number): SnapshotHandoff {
    const handoff = { generation, notifications: [] } satisfies SnapshotHandoff;
    this.snapshotHandoff = handoff;
    return handoff;
  }

  private receiveNotification(notification: AgentAppNotification): void {
    if (this.snapshotHandoff) {
      this.snapshotHandoff.notifications.push(notification);
      return;
    }
    this.applyNotification(notification);
  }

  private installSnapshot(snapshot: ThreadSnapshot, handoff: SnapshotHandoff): boolean {
    if (this.snapshotHandoff !== handoff || handoff.generation !== this.lifecycleGeneration) {
      throw new WebUiLifecycleCanceledError();
    }
    let changed = this.projection.replaceSnapshot(snapshot);
    this.snapshotHandoff = undefined;
    for (const notification of handoff.notifications) {
      changed = this.projection.apply(notification) || changed;
    }
    return changed;
  }

  private cancelSnapshotHandoff(handoff: SnapshotHandoff): void {
    if (this.snapshotHandoff === handoff) this.snapshotHandoff = undefined;
  }

  private fail(cause: unknown): void {
    this.setConnection({
      status: 'failed',
      message: readErrorMessage(cause),
    });
  }

  private setConnection(
    next: Omit<WebUiConnectionState, 'mode'> & Partial<Pick<WebUiConnectionState, 'mode'>>
  ): void {
    if (this.updateConnection(next)) this.refreshSnapshot();
  }

  private updateConnection(
    next: Omit<WebUiConnectionState, 'mode'> & Partial<Pick<WebUiConnectionState, 'mode'>>
  ): boolean {
    const nextConnection: WebUiConnectionState = {
      mode: this.connection.mode,
      ...next,
    };
    if (sameConnection(this.connection, nextConnection)) return false;
    this.connection = nextConnection;
    return true;
  }

  private disconnectFromServerOnly(): void {
    this.unsubscribeFromServer?.();
    this.unsubscribeFromServer = undefined;
  }

  private clearProjection(): boolean {
    return this.projection.apply({ type: 'sync/reset', threads: [] });
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  private async requestThread(
    generation: number,
    request: AgentAppRequest,
    method: 'thread/create' | 'thread/read'
  ): Promise<ThreadSnapshot> {
    const response = await this.client.request(request);
    if (generation !== this.lifecycleGeneration) {
      throw new WebUiLifecycleCanceledError();
    }
    return readThreadResponse(response, method);
  }

  private refreshSnapshot(): void {
    this.snapshot = { connection: this.connection, state: this.projection.getSnapshot() };
    this.emit();
  }

  private async selectProject(generation: number, requestedId?: string): Promise<string> {
    const listed = await this.client.request({ method: 'project/list', params: {} });
    if (generation !== this.lifecycleGeneration) throw new WebUiLifecycleCanceledError();
    if (!listed.ok || listed.method !== 'project/list')
      throw new Error(listed.ok ? 'Unexpected project/list response' : listed.error.message);
    const projects = listed.result.projects as unknown[];
    const active = projects.filter(
      (project): project is { id: string; status: string } =>
        typeof project === 'object' &&
        project !== null &&
        'id' in project &&
        typeof project.id === 'string' &&
        'status' in project &&
        project.status === 'active'
    );
    const selected = active.find((project) => project.id === requestedId) ?? active[0];
    if (selected) {
      this.selectedProjectId = selected.id;
      return selected.id;
    }
    const created = await this.client.request({
      method: 'project/create',
      params: {
        name: this.projectName,
        rootPath: this.projectRoot,
        idempotencyKey: this.idempotencyKey(),
      },
    });
    if (!created.ok || created.method !== 'project/create')
      throw new Error(created.ok ? 'Unexpected project/create response' : created.error.message);
    const project = created.result.project as { id?: unknown };
    if (typeof project?.id !== 'string')
      throw new Error('project/create did not return a project id');
    this.selectedProjectId = project.id;
    return project.id;
  }

  private requireProjectId(): string {
    if (!this.selectedProjectId) throw new Error('Web UI has no selected project');
    return this.selectedProjectId;
  }

  private idempotencyKey(): string {
    return globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random()}`;
  }
}

export type BrowserAgentAppTransportClientOptions = {
  readonly fetch?: typeof fetch;
  readonly createEventSource?: (url: string) => WebUiEventSource;
  readonly onSubscriptionStatus?: (
    status: 'connected' | 'disconnected' | 'failed',
    error?: unknown
  ) => void;
};

export type WebUiEventSource = {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
};

export class BrowserAgentAppTransportClient implements AgentAppClient {
  private readonly fetchImpl: typeof fetch;
  private readonly createEventSource: (url: string) => WebUiEventSource;
  private readonly onSubscriptionStatus?: BrowserAgentAppTransportClientOptions['onSubscriptionStatus'];
  private readonly subscriptions = new Set<BrowserSubscriptionState>();
  private lastProjectId?: string;

  constructor(options: BrowserAgentAppTransportClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.createEventSource =
      options.createEventSource ?? ((url) => new globalThis.EventSource(url) as WebUiEventSource);
    this.onSubscriptionStatus = options.onSubscriptionStatus;
  }

  async request(request: AgentAppRequest): Promise<AgentAppResponse> {
    if (typeof request.params.projectId === 'string') this.lastProjectId = request.params.projectId;
    const response = await this.withSubscriptionsReady(() =>
      this.fetchImpl('/request', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
      })
    );

    const body = await response.text();

    if (!response.ok) {
      throw new Error(`Agent App request failed with HTTP ${response.status}: ${body}`);
    }

    return JSON.parse(body) as AgentAppResponse;
  }

  subscribe(listener: AgentAppNotificationListener): AgentAppSubscription {
    const events = this.createEventSource('/events');
    const subscription: BrowserSubscriptionState = {
      phase: 'connecting',
      active: true,
      generation: 0,
      gate: createBrowserSubscriptionGate(),
      resetVersion: 0,
      installedResetVersion: 0,
      pendingNotifications: [],
    };
    this.subscriptions.add(subscription);

    events.onopen = () => {
      if (!subscription.active) return;
      if (subscription.phase === 'connecting') {
        subscription.phase = 'open';
        subscription.gate.resolve();
        this.onSubscriptionStatus?.('connected');
        return;
      }
      if (subscription.phase === 'reconnecting') {
        subscription.phase = 'recovering';
      }
    };
    events.onerror = (event) => {
      if (!subscription.active) return;
      subscription.gate.reject(new Error('Browser event subscription failed before request'));
      subscription.generation += 1;
      subscription.phase = 'reconnecting';
      subscription.gate = createBrowserSubscriptionGate();
      if (!hasBrowserResetDebt(subscription)) subscription.pendingNotifications = [];
      this.onSubscriptionStatus?.('failed', event);
    };
    events.addEventListener('notification', (event) => {
      if (!subscription.active) return;
      const notification = JSON.parse(event.data) as AgentAppNotificationEnvelope;
      if (subscription.phase === 'recovering') {
        if (hasBrowserResetDebt(subscription)) {
          subscription.pendingNotifications.push(notification);
        } else {
          listener(notification);
        }
        return;
      }
      if (subscription.phase === 'open') listener(notification);
    });
    events.addEventListener('reset', () => {
      if (!subscription.active) return;
      subscription.resetVersion += 1;
    });
    events.addEventListener('sync', () => {
      if (!subscription.active || subscription.phase !== 'recovering') return;
      void this.completeRecovery(subscription, listener);
    });

    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      subscription.generation += 1;
      subscription.phase = 'closed';
      subscription.gate.reject(new Error('Browser event subscription disconnected'));
      this.subscriptions.delete(subscription);
      events.close();
      this.onSubscriptionStatus?.('disconnected');
    };
  }

  private async completeRecovery(
    subscription: BrowserSubscriptionState,
    listener: AgentAppNotificationListener
  ): Promise<void> {
    const generation = subscription.generation;
    const gate = subscription.gate;
    const resetVersion = subscription.resetVersion;
    try {
      let resetThreads: readonly ThreadSnapshot[] | undefined;
      if (resetVersion > subscription.installedResetVersion) {
        resetThreads = await this.readRecoverySnapshots();
      }
      if (
        !subscription.active ||
        subscription.phase !== 'recovering' ||
        subscription.generation !== generation ||
        subscription.gate !== gate ||
        subscription.resetVersion !== resetVersion
      ) {
        return;
      }
      if (resetThreads && this.lastProjectId) {
        listener({
          projectId: this.lastProjectId,
          notification: { type: 'sync/reset', threads: resetThreads },
        });
      }
      if (
        !subscription.active ||
        subscription.phase !== 'recovering' ||
        subscription.generation !== generation ||
        subscription.gate !== gate ||
        subscription.resetVersion !== resetVersion
      ) {
        return;
      }
      for (const notification of subscription.pendingNotifications) listener(notification);
      subscription.pendingNotifications = [];
      if (resetThreads) subscription.installedResetVersion = resetVersion;
      if (hasBrowserResetDebt(subscription)) return;
      subscription.phase = 'open';
      gate.resolve();
      this.onSubscriptionStatus?.('connected');
    } catch (cause) {
      if (subscription.active && subscription.generation === generation) {
        subscription.phase = 'failed';
        gate.reject(new Error(`Reconnect resnapshot failed: ${readErrorMessage(cause)}`));
        this.onSubscriptionStatus?.('failed', cause);
      }
    }
  }

  private async readRecoverySnapshots(): Promise<readonly ThreadSnapshot[]> {
    if (!this.lastProjectId) return [];
    const response = await this.fetchImpl('/request', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ method: 'thread/list', params: { projectId: this.lastProjectId } }),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${body}`);
    }
    const result = JSON.parse(body) as AgentAppResponse;
    if (!result.ok || result.method !== 'thread/list') {
      throw new Error(result.ok ? `Unexpected ${result.method}` : result.error.message);
    }
    return result.result.threads as readonly ThreadSnapshot[];
  }

  private async withSubscriptionsReady<T>(operation: () => Promise<T>): Promise<T> {
    const authorization = [...this.subscriptions].map((subscription) => ({
      subscription,
      generation: subscription.generation,
      gate: subscription.gate,
    }));
    await Promise.all(authorization.map(({ gate }) => gate.promise));
    // Let EventSource state callbacks already queued behind the gate settlement
    // run before the final, atomic authorization-and-operation continuation.
    await Promise.resolve();
    if (
      authorization.some(
        ({ subscription, generation, gate }) =>
          !subscription.active ||
          subscription.phase !== 'open' ||
          subscription.generation !== generation ||
          subscription.gate !== gate
      )
    ) {
      throw new Error('Browser event subscription changed before request');
    }
    return operation();
  }
}

type BrowserSubscriptionPhase =
  'connecting' | 'open' | 'reconnecting' | 'recovering' | 'failed' | 'closed';

type BrowserSubscriptionGate = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (cause: Error) => void;
};

type BrowserSubscriptionState = {
  phase: BrowserSubscriptionPhase;
  active: boolean;
  generation: number;
  gate: BrowserSubscriptionGate;
  resetVersion: number;
  installedResetVersion: number;
  pendingNotifications: AgentAppNotificationEnvelope[];
};

function hasBrowserResetDebt(subscription: BrowserSubscriptionState): boolean {
  return subscription.resetVersion > subscription.installedResetVersion;
}

type SnapshotHandoff = {
  readonly generation: number;
  readonly notifications: AgentAppNotification[];
};

function createBrowserSubscriptionGate(): BrowserSubscriptionGate {
  let resolve!: () => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // EventSource may fail while no request is waiting. Keep the rejection
  // observable to request callers without producing an unhandled rejection.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function readThreadResponse(
  response: AgentAppResponse,
  method: 'thread/create' | 'thread/read'
): ThreadSnapshot {
  if (response.ok && response.method === method) {
    return response.result.thread as ThreadSnapshot;
  }

  if (!response.ok) {
    throw new Error(response.error.message);
  }

  throw new Error(`Expected ${method} response, received ${response.method}`);
}

function readErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sameConnection(left: WebUiConnectionState, right: WebUiConnectionState): boolean {
  return left.status === right.status && left.mode === right.mode && left.message === right.message;
}

function readThreadFailureMessage(thread: NonNullable<WebUiState['currentThread']>): string {
  const error = [...thread.turns].reverse().find((turn) => turn.status === 'failed')?.error;
  if (typeof error === 'string' && error.length > 0) return error;
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const message = error.message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return error === undefined ? 'Thread failed' : JSON.stringify(error);
}
