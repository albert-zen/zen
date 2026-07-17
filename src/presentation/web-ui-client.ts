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
    this.unsubscribeFromServer = this.client.subscribe((notification) => {
      if (generation === this.lifecycleGeneration) this.applyNotification(notification);
    });

    try {
      const thread = await this.requestThread(
        generation,
        options.threadId
          ? { method: 'thread/read', params: { threadId: options.threadId } }
          : { method: 'thread/start' },
        options.threadId ? 'thread/read' : 'thread/start'
      );
      const projectionChanged = this.projection.replaceSnapshot(thread);
      const connectionChanged = this.updateConnection({ status: 'connected' });
      if (projectionChanged || connectionChanged) this.refreshSnapshot();
    } catch (cause) {
      if (generation === this.lifecycleGeneration) this.fail(cause);
      throw cause;
    }
  }

  disconnect(): void {
    this.lifecycleGeneration += 1;
    this.disconnectFromServerOnly();
    this.setConnection({ status: 'disconnected' });
  }

  dispose(): void {
    this.disconnect();
    this.listeners.clear();
  }

  async startThread(): Promise<void> {
    const thread = await this.requestThread(
      this.lifecycleGeneration,
      { method: 'thread/start' },
      'thread/start'
    );
    if (this.projection.replaceSnapshot(thread)) {
      this.refreshSnapshot();
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
    const thread = await this.requestThread(
      this.lifecycleGeneration,
      { method: 'thread/read', params: { threadId } },
      'thread/read'
    );
    if (this.projection.replaceSnapshot(thread)) {
      this.refreshSnapshot();
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
    const projectionChanged = this.projection.apply(notification);
    const connectionChanged =
      notification.type === 'turn/started'
        ? this.updateConnection({ status: 'running', message: undefined })
        : notification.type === 'turn/completed'
          ? this.updateConnection({ status: 'connected', message: undefined })
          : notification.type === 'turn/failed'
            ? this.updateConnection({ status: 'failed', message: notification.error.message })
            : false;
    if (projectionChanged || connectionChanged) this.refreshSnapshot();
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
    await this.awaitSubscriptionsReady();
    const response = await this.fetchImpl('/request', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    });

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
    };
    this.subscriptions.add(subscription);

    events.onopen = () => {
      if (!subscription.active) return;
      subscription.phase = 'open';
      subscription.gate.resolve();
      this.onSubscriptionStatus?.('connected');
    };
    events.onerror = (event) => {
      if (!subscription.active) return;
      subscription.gate.reject(new Error('Browser event subscription failed before request'));
      subscription.generation += 1;
      subscription.phase = 'reconnecting';
      subscription.gate = createBrowserSubscriptionGate();
      this.onSubscriptionStatus?.('failed', event);
    };
    events.addEventListener('notification', (event) => {
      if (!subscription.active || subscription.phase !== 'open') return;
      listener(JSON.parse(event.data) as AppServerNotification);
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

  private async awaitSubscriptionsReady(): Promise<void> {
    const authorization = [...this.subscriptions].map((subscription) => ({
      subscription,
      generation: subscription.generation,
      gate: subscription.gate,
    }));
    await Promise.all(authorization.map(({ gate }) => gate.promise));
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
  }
}

type BrowserSubscriptionPhase = 'connecting' | 'open' | 'reconnecting' | 'closed';

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
