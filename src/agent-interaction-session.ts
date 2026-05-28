import type {
  AppServerClient,
  AppServerNotificationListener,
  AppServerSubscription
} from "./app-server.js";
import type { JsonValue, ThreadSnapshot } from "./app-server-protocol.js";
import {
  applyAppServerNotification,
  createWebUiState,
  type TimelineRow,
  type WebUiState
} from "./web-ui-state.js";

export type AgentInteractionSessionOptions = {
  readonly client: AppServerClient;
};

export type AgentInteractionSnapshot = {
  readonly state: WebUiState;
  readonly thread?: ThreadSnapshot;
  readonly timelineRows: readonly TimelineRow[];
};

export class AgentInteractionSession {
  private state: WebUiState = createWebUiState();
  private subscription?: AppServerSubscription;

  constructor(private readonly options: AgentInteractionSessionOptions) {}

  getSnapshot(): AgentInteractionSnapshot {
    return {
      state: this.state,
      thread: this.state.currentThread
        ? {
            id: this.state.currentThread.id,
            status: this.state.currentThread.status,
            turns: this.state.currentThread.turns,
            items: this.state.items
          }
        : undefined,
      timelineRows: this.state.timelineRows
    };
  }

  async start(): Promise<AgentInteractionSnapshot> {
    this.subscribeOnce();
    await this.newThread();

    return this.getSnapshot();
  }

  async newThread(): Promise<AgentInteractionSnapshot> {
    this.subscribeOnce();
    const response = await this.options.client.request({ method: "thread/start" });

    if (!response.ok || response.method !== "thread/start") {
      throw new Error(response.ok ? "Unexpected thread/start response" : response.error.message);
    }

    this.state = createWebUiState(response.result.thread);

    return this.getSnapshot();
  }

  async submit(input: JsonValue): Promise<AgentInteractionSnapshot> {
    this.subscribeOnce();
    const currentThread = await this.ensureThread();
    const response = await this.options.client.request({
      method: "turn/start",
      params: {
        threadId: currentThread.id,
        input
      }
    });

    if (!response.ok || response.method !== "turn/start") {
      throw new Error(response.ok ? "Unexpected turn/start response" : response.error.message);
    }

    return this.getSnapshot();
  }

  dispose(): void {
    this.subscription?.();
    this.subscription = undefined;
  }

  private async ensureThread(): Promise<{ readonly id: string }> {
    if (this.state.currentThread) {
      return { id: this.state.currentThread.id };
    }

    const snapshot = await this.newThread();

    if (!snapshot.thread) {
      throw new Error("Thread did not start");
    }

    return { id: snapshot.thread.id };
  }

  private subscribeOnce(): void {
    if (this.subscription) {
      return;
    }

    const listener: AppServerNotificationListener = (notification) => {
      this.state = applyAppServerNotification(this.state, notification);
    };

    this.subscription = this.options.client.subscribe(listener);
  }
}
