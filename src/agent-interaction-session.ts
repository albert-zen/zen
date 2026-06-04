import type {
  AppServerClient,
  AppServerNotificationListener,
  AppServerSubscription
} from "./app-server.js";
import type {
  JsonValue,
  ProtocolItem,
  ThreadSnapshot
} from "./app-server-protocol.js";
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

export type AgentThreadListEntry = {
  readonly id: string;
  readonly status: ThreadSnapshot["status"];
  readonly turns: number;
  readonly items: number;
  readonly updatedAtMs?: number;
  readonly lastUserMessage?: string;
  readonly lastAssistantSummary?: string;
};

export type AgentInteractionSessionEvent =
  | {
      readonly type: "rows";
      readonly rows: readonly TimelineRow[];
      readonly snapshot: AgentInteractionSnapshot;
    }
  | {
      readonly type: "state";
      readonly snapshot: AgentInteractionSnapshot;
    };

export type AgentInteractionSessionListener = (
  event: AgentInteractionSessionEvent
) => void;

export class AgentInteractionSession {
  private state: WebUiState = createWebUiState();
  private subscription?: AppServerSubscription;
  private readonly listeners: AgentInteractionSessionListener[] = [];

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
    const list = await this.options.client.request({ method: "thread/list" });

    if (list.ok && list.method === "thread/list" && list.result.threads.length > 0) {
      this.state = createWebUiState(list.result.threads[0]);
      return this.getSnapshot();
    }

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

  async listThreads(): Promise<readonly AgentThreadListEntry[]> {
    const response = await this.options.client.request({ method: "thread/list" });

    if (!response.ok || response.method !== "thread/list") {
      throw new Error(response.ok ? "Unexpected thread/list response" : response.error.message);
    }

    return response.result.threads.map(toThreadListEntry);
  }

  async resumeThread(threadId: string): Promise<AgentInteractionSnapshot> {
    this.subscribeOnce();
    const response = await this.options.client.request({
      method: "thread/read",
      params: {
        threadId
      }
    });

    if (!response.ok || response.method !== "thread/read") {
      throw new Error(response.ok ? "Unexpected thread/read response" : response.error.message);
    }

    this.state = createWebUiState(response.result.thread);
    this.emit({ type: "state", snapshot: this.getSnapshot() });

    return this.getSnapshot();
  }

  async interrupt(): Promise<AgentInteractionSnapshot> {
    const currentThread = await this.ensureThread();
    const response = await this.options.client.request({
      method: "turn/interrupt",
      params: {
        threadId: currentThread.id
      }
    });

    if (!response.ok || response.method !== "turn/interrupt") {
      throw new Error(response.ok ? "Unexpected turn/interrupt response" : response.error.message);
    }

    return this.getSnapshot();
  }

  async submit(input: JsonValue): Promise<AgentInteractionSnapshot> {
    this.subscribeOnce();
    const currentThread = await this.ensureThread();
    const completion = this.waitForNextTurnCompletion(currentThread.id);
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

    await completion;

    return this.getSnapshot();
  }

  observe(listener: AgentInteractionSessionListener): () => void {
    this.listeners.push(listener);

    return () => {
      const index = this.listeners.indexOf(listener);

      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  dispose(): void {
    this.subscription?.();
    this.subscription = undefined;
    this.listeners.splice(0);
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
      const previousRows = this.state.timelineRows;
      const previousRowKeys = new Set(previousRows.map(toTimelineRowKey));
      this.state = applyAppServerNotification(this.state, notification);
      const snapshot = this.getSnapshot();
      const nextRows = this.state.timelineRows.filter(
        (row) => !previousRowKeys.has(toTimelineRowKey(row))
      );

      if (nextRows.length > 0) {
        this.emit({ type: "rows", rows: nextRows, snapshot });
      }

      this.emit({ type: "state", snapshot });
    };

    this.subscription = this.options.client.subscribe(listener);
  }

  private waitForNextTurnCompletion(threadId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const unsubscribe = this.options.client.subscribe((notification) => {
        if (
          notification.type !== "turn/completed" &&
          notification.type !== "turn/failed"
        ) {
          return;
        }

        if (notification.threadId !== threadId) {
          return;
        }

        unsubscribe();

        if (notification.type === "turn/failed") {
          reject(new Error(notification.error.message));
          return;
        }

        resolve();
      });
    });
  }

  private emit(event: AgentInteractionSessionEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
}

function toTimelineRowKey(row: TimelineRow): string {
  return `${row.type}:${row.itemId}`;
}

function toThreadListEntry(thread: ThreadSnapshot): AgentThreadListEntry {
  return {
    id: thread.id,
    status: thread.status,
    turns: thread.turns.length,
    items: thread.items.length,
    updatedAtMs: latestItemTimestamp(thread.items),
    lastUserMessage: latestContent(thread.items, "user.message.completed"),
    lastAssistantSummary: latestContent(
      thread.items,
      "assistant.message.completed"
    )
  };
}

function latestItemTimestamp(
  items: readonly ProtocolItem[]
): number | undefined {
  return items.reduce<number | undefined>(
    (latest, item) =>
      latest === undefined ? item.createdAtMs : Math.max(latest, item.createdAtMs),
    undefined
  );
}

function latestContent(
  items: readonly ProtocolItem[],
  type: string
): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];

    if (item?.type !== type) {
      continue;
    }

    const content = readPayloadContent(item.payload);

    if (content) {
      return content;
    }
  }

  return undefined;
}

function readPayloadContent(payload: JsonValue): string | undefined {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const content = payload.content;

    if (typeof content === "string") {
      return content;
    }
  }

  return undefined;
}
