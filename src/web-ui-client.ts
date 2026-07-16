import type {
  AppServerClient,
  AppServerNotificationListener,
  AppServerRequestInput,
  AppServerSubscription
} from "./app-server.js";
import type {
  AppServerNotification,
  AppServerResponse,
  ApprovalDecision,
  ThreadSnapshot
} from "./app-server-protocol.js";
import {
  applyAppServerNotification,
  createWebUiState,
  type WebUiState
} from "./web-ui-state.js";

export type WebUiRuntimeMode = "real" | "demo";

export type WebUiConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "running"
  | "failed";

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

export class WebUiClient {
  private readonly client: AppServerClient;
  private readonly listeners = new Set<WebUiClientListener>();
  private unsubscribeFromServer?: AppServerSubscription;
  private state = createWebUiState();
  private connection: WebUiConnectionState;

  constructor(options: WebUiClientOptions) {
    this.client = options.client;
    this.connection = {
      status: "disconnected",
      mode: options.mode ?? "real"
    };
  }

  getSnapshot(): WebUiClientSnapshot {
    return {
      connection: { ...this.connection },
      state: this.state
    };
  }

  subscribe(listener: WebUiClientListener): AppServerSubscription {
    this.listeners.add(listener);
    listener(this.getSnapshot());

    return () => {
      this.listeners.delete(listener);
    };
  }

  async connect(options: { readonly threadId?: string } = {}): Promise<void> {
    this.disconnectFromServerOnly();
    this.setConnection({ status: "connecting" });
    this.unsubscribeFromServer = this.client.subscribe((notification) => {
      this.applyNotification(notification);
    });

    try {
      if (options.threadId) {
        await this.resumeThread(options.threadId);
      } else {
        await this.startThread();
      }
      this.setConnection({ status: "connected" });
    } catch (cause) {
      this.fail(cause);
      throw cause;
    }
  }

  disconnect(): void {
    this.disconnectFromServerOnly();
    this.setConnection({ status: "disconnected" });
  }

  async startThread(): Promise<void> {
    const response = await this.client.request({ method: "thread/start" });
    const thread = readThreadResponse(response, "thread/start");
    this.state = createWebUiState(thread);
    this.emit();
  }

  async listThreads(): Promise<readonly ThreadSnapshot[]> {
    const response = await this.client.request({ method: "thread/list" });

    if (response.ok && response.method === "thread/list") {
      return response.result.threads;
    }

    if (!response.ok) {
      throw new Error(response.error.message);
    }

    throw new Error(`Expected thread/list response, received ${response.method}`);
  }

  async resumeThread(threadId: string): Promise<void> {
    const response = await this.client.request({
      method: "thread/read",
      params: { threadId }
    });
    const thread = readThreadResponse(response, "thread/read");
    this.state = createWebUiState(thread);
    this.emit();
  }

  async submitMessage(input: string): Promise<void> {
    const trimmed = input.trim();

    if (!trimmed) {
      return;
    }

    const thread = this.state.currentThread;

    if (!thread) {
      await this.startThread();
    }

    const threadId = this.state.currentThread?.id;

    if (!threadId) {
      throw new Error("Web UI has no current thread after thread/start");
    }

    this.setConnection({ status: "running" });

    const response = await this.client.request({
      method: "turn/start",
      params: {
        threadId,
        input: trimmed
      }
    });

    if (!response.ok) {
      this.fail(response.error.message);
      throw new Error(response.error.message);
    }
  }

  async interruptThread(): Promise<void> {
    const threadId = this.state.currentThread?.id;

    if (!threadId) {
      return;
    }

    const response = await this.client.request({
      method: "turn/interrupt",
      params: { threadId }
    });

    if (!response.ok) {
      this.fail(response.error.message);
      throw new Error(response.error.message);
    }
  }

  async retryTurn(turnId?: string): Promise<void> {
    const threadId = this.state.currentThread?.id;

    if (!threadId) {
      return;
    }

    this.setConnection({ status: "running" });
    const response = await this.client.request({
      method: "turn/retry",
      params: { threadId, turnId }
    });

    if (!response.ok) {
      this.fail(response.error.message);
      throw new Error(response.error.message);
    }
  }

  async resolveApproval(
    approvalId: string | undefined,
    decision: ApprovalDecision
  ): Promise<void> {
    if (!approvalId) {
      return;
    }

    const threadId = this.state.currentThread?.id;
    const turnId = this.state.currentThread?.turns.at(-1)?.id;

    if (!threadId || !turnId) {
      throw new Error("Cannot resolve approval without an active thread and turn");
    }

    const response = await this.client.request({
      method: "approval/resolve",
      params: { threadId, turnId, approvalId, decision }
    });

    if (!response.ok) {
      this.fail(response.error.message);
      throw new Error(response.error.message);
    }
  }

  private applyNotification(notification: AppServerNotification): void {
    this.state = applyAppServerNotification(this.state, notification);

    if (notification.type === "turn/started") {
      this.connection = { ...this.connection, status: "running", message: undefined };
    }

    if (notification.type === "turn/completed") {
      this.connection = { ...this.connection, status: "connected", message: undefined };
    }

    if (notification.type === "turn/failed") {
      this.connection = {
        ...this.connection,
        status: "failed",
        message: notification.error.message
      };
    }

    this.emit();
  }

  private fail(cause: unknown): void {
    this.setConnection({
      status: "failed",
      message: readErrorMessage(cause)
    });
  }

  private setConnection(
    next: Omit<WebUiConnectionState, "mode"> & Partial<Pick<WebUiConnectionState, "mode">>
  ): void {
    this.connection = {
      mode: this.connection.mode,
      ...next
    };
    this.emit();
  }

  private disconnectFromServerOnly(): void {
    this.unsubscribeFromServer?.();
    this.unsubscribeFromServer = undefined;
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

export type BrowserAppServerTransportClientOptions = {
  readonly fetch?: typeof fetch;
  readonly createEventSource?: (
    url: string
  ) => WebUiEventSource;
  readonly onSubscriptionStatus?: (
    status: "connected" | "disconnected" | "failed",
    error?: unknown
  ) => void;
};

export type WebUiEventSource = {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void
  ): void;
  close(): void;
};

export class BrowserAppServerTransportClient implements AppServerClient {
  private readonly fetchImpl: typeof fetch;
  private readonly createEventSource: (url: string) => WebUiEventSource;
  private readonly onSubscriptionStatus?: BrowserAppServerTransportClientOptions["onSubscriptionStatus"];

  constructor(options: BrowserAppServerTransportClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.createEventSource =
      options.createEventSource ??
      ((url) => new globalThis.EventSource(url) as WebUiEventSource);
    this.onSubscriptionStatus = options.onSubscriptionStatus;
  }

  async request(request: AppServerRequestInput): Promise<AppServerResponse> {
    const response = await this.fetchImpl("/request", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });

    const body = await response.text();

    if (!response.ok) {
      throw new Error(`App Server request failed with HTTP ${response.status}: ${body}`);
    }

    return JSON.parse(body) as AppServerResponse;
  }

  subscribe(listener: AppServerNotificationListener): AppServerSubscription {
    const events = this.createEventSource("/events");

    events.onopen = () => {
      this.onSubscriptionStatus?.("connected");
    };
    events.onerror = (event) => {
      this.onSubscriptionStatus?.("failed", event);
    };
    events.addEventListener("notification", (event) => {
      listener(JSON.parse(event.data) as AppServerNotification);
    });

    return () => {
      events.close();
      this.onSubscriptionStatus?.("disconnected");
    };
  }
}

function readThreadResponse(
  response: AppServerResponse,
  method: "thread/start" | "thread/read"
) {
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
