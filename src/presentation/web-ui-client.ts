import type {
  AppServerClient,
  AppServerNotificationListener,
  AppServerRequestInput,
  AppServerSubscription,
} from '../product/index.js';
import type {
  AppServerNotification,
  AppServerResponse,
  ApprovalDecision,
  ThreadSnapshot,
} from '../product/index.js';
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
  readonly client: AppServerClient;
  readonly mode?: WebUiRuntimeMode;
};

export type WebUiClientListener = (snapshot: WebUiClientSnapshot) => void;

export class WebUiLifecycleCanceledError extends Error {
  constructor() {
    super('Web UI lifecycle operation was superseded');
    this.name = 'WebUiLifecycleCanceledError';
  }
}

export class WebUiClient {
  private readonly client: AppServerClient;
  private readonly listeners = new Set<WebUiClientListener>();
  private unsubscribeFromServer?: AppServerSubscription;
  private readonly projection = new InteractionProjection();
  private connection: WebUiConnectionState;
  private snapshot: WebUiClientSnapshot;
  private lifecycleGeneration = 0;
  private snapshotHandoff?: SnapshotHandoff;

  constructor(options: WebUiClientOptions) {
    this.client = options.client;
    this.connection = {
      status: 'disconnected',
      mode: options.mode ?? 'real',
    };
    this.snapshot = { connection: this.connection, state: this.projection.getSnapshot() };
  }

  getSnapshot(): WebUiClientSnapshot {
    return this.snapshot;
  }

  subscribe(listener: WebUiClientListener): AppServerSubscription {
    this.listeners.add(listener);
    listener(this.getSnapshot());

    return () => {
      this.listeners.delete(listener);
    };
  }

  async connect(options: { readonly threadId?: string } = {}): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    this.disconnectFromServerOnly();
    this.setConnection({ status: 'connecting' });
    const handoff = this.beginSnapshotHandoff(generation);
    this.unsubscribeFromServer = this.client.subscribe((notification) => {
      if (generation === this.lifecycleGeneration) {
        this.receiveNotification(notification);
      }
    });

    try {
      const thread = await this.requestThread(
        generation,
        options.threadId
          ? { method: 'thread/read', params: { threadId: options.threadId } }
          : { method: 'thread/start' },
        options.threadId ? 'thread/read' : 'thread/start'
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
        { method: 'thread/start' },
        'thread/start'
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
    const response = await this.client.request({ method: 'thread/list' });

    if (response.ok && response.method === 'thread/list') {
      return response.result.threads;
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
        { method: 'thread/read', params: { threadId } },
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
      throw new Error('Web UI has no current thread after thread/start');
    }

    this.setConnection({ status: 'running' });

    const response = await this.client.request({
      method: 'turn/start',
      params: {
        threadId,
        input: trimmed,
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
      params: { threadId },
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
      params: { threadId, turnId },
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
      params: { ...approval, decision },
    });

    if (!response.ok) {
      this.fail(response.error.message);
      throw new Error(response.error.message);
    }
  }

  private applyNotification(notification: AppServerNotification): void {
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

  private receiveNotification(notification: AppServerNotification): void {
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

  private emit(): void {
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  private async requestThread(
    generation: number,
    request: AppServerRequestInput,
    method: 'thread/start' | 'thread/read'
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
}

export type BrowserAppServerTransportClientOptions = {
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

export class BrowserAppServerTransportClient implements AppServerClient {
  private readonly fetchImpl: typeof fetch;
  private readonly createEventSource: (url: string) => WebUiEventSource;
  private readonly onSubscriptionStatus?: BrowserAppServerTransportClientOptions['onSubscriptionStatus'];
  private readonly subscriptions = new Set<BrowserSubscriptionState>();

  constructor(options: BrowserAppServerTransportClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.createEventSource =
      options.createEventSource ?? ((url) => new globalThis.EventSource(url) as WebUiEventSource);
    this.onSubscriptionStatus = options.onSubscriptionStatus;
  }

  async request(request: AppServerRequestInput): Promise<AppServerResponse> {
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
      throw new Error(`App Server request failed with HTTP ${response.status}: ${body}`);
    }

    return JSON.parse(body) as AppServerResponse;
  }

  subscribe(listener: AppServerNotificationListener): AppServerSubscription {
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
      const notification = JSON.parse(event.data) as AppServerNotification;
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
    listener: AppServerNotificationListener
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
      if (resetThreads) listener({ type: 'sync/reset', threads: resetThreads });
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
    const response = await this.fetchImpl('/request', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ method: 'thread/list' }),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${body}`);
    }
    const result = JSON.parse(body) as AppServerResponse;
    if (!result.ok || result.method !== 'thread/list') {
      throw new Error(result.ok ? `Unexpected ${result.method}` : result.error.message);
    }
    return result.result.threads;
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
  pendingNotifications: AppServerNotification[];
};

function hasBrowserResetDebt(subscription: BrowserSubscriptionState): boolean {
  return subscription.resetVersion > subscription.installedResetVersion;
}

type SnapshotHandoff = {
  readonly generation: number;
  readonly notifications: AppServerNotification[];
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

function readThreadResponse(response: AppServerResponse, method: 'thread/start' | 'thread/read') {
  if (response.ok && response.method === method) {
    return response.result.thread;
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
