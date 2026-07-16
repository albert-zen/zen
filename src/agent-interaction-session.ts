import type {
  AppServerClient,
  AppServerNotificationListener,
  AppServerSubscription
} from "./app-server.js";
import type {
  JsonValue,
  ProtocolItem,
  ThreadSnapshot,
  TurnSnapshot
} from "./app-server-protocol.js";
import {
  InteractionProjection,
  type ReadonlyInteractionSequence,
  type TimelineRow,
  type WebUiState
} from "./web-ui-state.js";

export type AgentInteractionSessionOptions = {
  readonly client: AppServerClient;
};

export type AgentInteractionSnapshot = {
  readonly state: WebUiState;
  readonly thread?: AgentInteractionThread;
  readonly timelineRows: ReadonlyInteractionSequence<TimelineRow>;
  readonly recoverableTurn?: AgentRecoverableTurn;
};

export type AgentInteractionThread = Omit<ThreadSnapshot, "items"> & {
  readonly items: ReadonlyInteractionSequence<ProtocolItem>;
};

export type AgentRecoverableTurn = {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: "failed" | "canceled";
  readonly input?: JsonValue;
  readonly reason: string;
  readonly retryAvailable: boolean;
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
  private readonly projection = new InteractionProjection();
  private subscription?: AppServerSubscription;
  private readonly listeners: AgentInteractionSessionListener[] = [];
  private readonly completionWaiters = new Map<string, Array<{ resolve: () => void; reject: (cause: Error) => void }>>();

  constructor(private readonly options: AgentInteractionSessionOptions) {}

  getSnapshot(): AgentInteractionSnapshot {
    const state = this.projection.getSnapshot();
    return {
      state,
      thread: state.currentThread
        ? {
            id: state.currentThread.id,
            status: state.currentThread.status,
            turns: state.currentThread.turns,
            items: state.items
          }
        : undefined,
      timelineRows: state.timelineRows,
      recoverableTurn: findRecoverableTurn(state)
    };
  }

  async start(): Promise<AgentInteractionSnapshot> {
    this.subscribeOnce();
    const list = await this.options.client.request({ method: "thread/list" });

    if (list.ok && list.method === "thread/list" && list.result.threads.length > 0) {
      this.projection.replaceSnapshot(list.result.threads[0]);
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

    this.projection.replaceSnapshot(response.result.thread);

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

    if (this.projection.replaceSnapshot(response.result.thread)) {
      this.emit({ type: "state", snapshot: this.getSnapshot() });
    }

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

  async resolveApproval(input: {
    readonly approvalId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly decision: "approveOnce" | "decline";
  }): Promise<void> {
    const response = await this.options.client.request({ method: "approval/resolve", params: input });
    if (!response.ok || response.method !== "approval/resolve") {
      throw new Error(response.ok ? "Unexpected approval/resolve response" : response.error.message);
    }
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

  async retryLatestRecoverableTurn(): Promise<AgentInteractionSnapshot> {
    this.subscribeOnce();
    const recoverableTurn = this.getSnapshot().recoverableTurn;

    if (!recoverableTurn?.retryAvailable) {
      throw new Error("No recoverable turn available for retry");
    }

    const completion = this.waitForNextTurnCompletion(recoverableTurn.threadId);
    const response = await this.options.client.request({
      method: "turn/retry",
      params: {
        threadId: recoverableTurn.threadId,
        turnId: recoverableTurn.turnId
      }
    });

    if (!response.ok || response.method !== "turn/retry") {
      throw new Error(response.ok ? "Unexpected turn/retry response" : response.error.message);
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
    const currentThread = this.projection.getSnapshot().currentThread;
    if (currentThread) {
      return { id: currentThread.id };
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
      const previousRows = this.projection.getSnapshot().timelineRows;
      const previousRowKeys = new Set(previousRows.map(toTimelineRowKey));
      const changed = this.projection.apply(notification);
      if (!changed) return;
      const snapshot = this.getSnapshot();
      const nextRows = snapshot.timelineRows.filter(
        (row) => !previousRowKeys.has(toTimelineRowKey(row))
      );

      if (nextRows.length > 0) {
        this.emit({ type: "rows", rows: nextRows, snapshot });
      }

      this.emit({ type: "state", snapshot });
      if (notification.type === "turn/completed" || notification.type === "turn/failed") {
        const waiters = this.completionWaiters.get(notification.threadId) ?? [];
        this.completionWaiters.delete(notification.threadId);
        waiters.forEach((waiter) => notification.type === "turn/failed"
          ? waiter.reject(new Error(notification.error.message))
          : waiter.resolve());
      }
    };

    this.subscription = this.options.client.subscribe(listener);
  }

  private waitForNextTurnCompletion(threadId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiters = this.completionWaiters.get(threadId) ?? [];
      waiters.push({ resolve, reject });
      this.completionWaiters.set(threadId, waiters);
    });
  }

  private emit(event: AgentInteractionSessionEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
}

function toTimelineRowKey(row: TimelineRow): string {
  return `${row.type}:${row.itemId}`;
}

function findRecoverableTurn(state: WebUiState): AgentRecoverableTurn | undefined {
  const currentThread = state.currentThread;
  const latestTurn = currentThread?.turns.at(-1);

  if (!currentThread || !latestTurn || !isRecoverableTurn(latestTurn)) {
    return undefined;
  }

  const input = latestUserInputForTurn(state.items, latestTurn.id);

  return {
    threadId: currentThread.id,
    turnId: latestTurn.id,
    status: latestTurn.status,
    input,
    reason: readTurnErrorReason(latestTurn.error),
    retryAvailable: input !== undefined
  };
}

function isRecoverableTurn(
  turn: TurnSnapshot
): turn is TurnSnapshot & { readonly status: "failed" | "canceled" } {
  return turn.status === "failed" || turn.status === "canceled";
}

function latestUserInputForTurn(
  items: Iterable<ProtocolItem>,
  turnId: string
): JsonValue | undefined {
  const orderedItems = [...items];
  for (let index = orderedItems.length - 1; index >= 0; index -= 1) {
    const item = orderedItems[index];

    if (item?.turnId !== turnId || item.type !== "user.message.completed") {
      continue;
    }

    const content = readPayloadField(item.payload, "content");

    if (content !== undefined) {
      return content;
    }
  }

  return undefined;
}

function readTurnErrorReason(error: JsonValue | undefined): string {
  if (error === undefined) {
    return "Turn did not complete";
  }

  const message = readPayloadField(error, "message");

  if (typeof message === "string" && message.length > 0) {
    return message;
  }

  return stringifyJson(error);
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

function readPayloadField(payload: JsonValue, key: string): JsonValue | undefined {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return payload[key];
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

function stringifyJson(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
