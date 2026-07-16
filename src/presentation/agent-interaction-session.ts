import type {
  AppServerClient,
  AppServerNotificationListener,
  AppServerSubscription
} from "../product/index.js";
import type {
  JsonValue,
  ProtocolItem,
  ThreadSnapshot,
  TurnSnapshot
} from "../product/index.js";
import {
  InteractionProjection,
  type ReadonlyInteractionSequence,
  type TimelineRow,
  type WebUiState
} from "./web-ui-state.js";

export type AgentInteractionSessionOptions = {
  readonly client: AppServerClient;
};

export class AgentInteractionSessionDisposedError extends Error {
  constructor() {
    super("Agent interaction session is disposed");
    this.name = "AgentInteractionSessionDisposedError";
  }
}

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

type CompletionWaiter = {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(cause: Error): void;
  discard(): void;
};

export class AgentInteractionSession {
  private readonly projection = new InteractionProjection();
  private subscription?: AppServerSubscription;
  private readonly listeners: AgentInteractionSessionListener[] = [];
  private readonly completionWaiters = new Map<string, Set<CompletionWaiter>>();
  private disposed = false;

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
    this.assertActive();
    this.subscribeOnce();
    const list = await this.options.client.request({ method: "thread/list" });
    this.assertActive();

    if (list.ok && list.method === "thread/list" && list.result.threads.length > 0) {
      this.projection.replaceSnapshot(list.result.threads[0]);
      return this.getSnapshot();
    }

    await this.newThread();

    return this.getSnapshot();
  }

  async newThread(): Promise<AgentInteractionSnapshot> {
    this.assertActive();
    this.subscribeOnce();
    const response = await this.options.client.request({ method: "thread/start" });
    this.assertActive();

    if (!response.ok || response.method !== "thread/start") {
      throw new Error(response.ok ? "Unexpected thread/start response" : response.error.message);
    }

    this.projection.replaceSnapshot(response.result.thread);

    return this.getSnapshot();
  }

  async listThreads(): Promise<readonly AgentThreadListEntry[]> {
    this.assertActive();
    const response = await this.options.client.request({ method: "thread/list" });
    this.assertActive();

    if (!response.ok || response.method !== "thread/list") {
      throw new Error(response.ok ? "Unexpected thread/list response" : response.error.message);
    }

    return response.result.threads.map(toThreadListEntry);
  }

  async resumeThread(threadId: string): Promise<AgentInteractionSnapshot> {
    this.assertActive();
    this.subscribeOnce();
    const response = await this.options.client.request({
      method: "thread/read",
      params: {
        threadId
      }
    });

    this.assertActive();
    if (!response.ok || response.method !== "thread/read") {
      throw new Error(response.ok ? "Unexpected thread/read response" : response.error.message);
    }

    if (this.projection.replaceSnapshot(response.result.thread)) {
      this.emit({ type: "state", snapshot: this.getSnapshot() });
    }

    return this.getSnapshot();
  }

  async interrupt(): Promise<AgentInteractionSnapshot> {
    this.assertActive();
    const currentThread = await this.ensureThread();
    const response = await this.options.client.request({
      method: "turn/interrupt",
      params: {
        threadId: currentThread.id
      }
    });

    this.assertActive();
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
    this.assertActive();
    const response = await this.options.client.request({ method: "approval/resolve", params: input });
    this.assertActive();
    if (!response.ok || response.method !== "approval/resolve") {
      throw new Error(response.ok ? "Unexpected approval/resolve response" : response.error.message);
    }
  }

  async submit(input: JsonValue): Promise<AgentInteractionSnapshot> {
    this.assertActive();
    this.subscribeOnce();
    const currentThread = await this.ensureThread();
    const completion = this.createCompletionWaiter(currentThread.id);
    try {
      const response = await this.options.client.request({
        method: "turn/start",
        params: {
          threadId: currentThread.id,
          input
        }
      });

      this.assertActive();
      if (!response.ok || response.method !== "turn/start") {
        throw new Error(response.ok ? "Unexpected turn/start response" : response.error.message);
      }
    } catch (cause) {
      completion.discard();
      throw cause;
    }

    await completion.promise;
    this.assertActive();

    return this.getSnapshot();
  }

  async retryLatestRecoverableTurn(): Promise<AgentInteractionSnapshot> {
    this.assertActive();
    this.subscribeOnce();
    const recoverableTurn = this.getSnapshot().recoverableTurn;

    if (!recoverableTurn?.retryAvailable) {
      throw new Error("No recoverable turn available for retry");
    }

    const completion = this.createCompletionWaiter(recoverableTurn.threadId);
    try {
      const response = await this.options.client.request({
        method: "turn/retry",
        params: {
          threadId: recoverableTurn.threadId,
          turnId: recoverableTurn.turnId
        }
      });

      this.assertActive();
      if (!response.ok || response.method !== "turn/retry") {
        throw new Error(response.ok ? "Unexpected turn/retry response" : response.error.message);
      }
    } catch (cause) {
      completion.discard();
      throw cause;
    }

    await completion.promise;
    this.assertActive();

    return this.getSnapshot();
  }

  observe(listener: AgentInteractionSessionListener): () => void {
    if (this.disposed) {
      return () => undefined;
    }
    this.listeners.push(listener);

    return () => {
      const index = this.listeners.indexOf(listener);

      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.subscription?.();
    this.subscription = undefined;
    const error = new AgentInteractionSessionDisposedError();
    this.completionWaiters.forEach((waiters) => {
      [...waiters].forEach((waiter) => waiter.reject(error));
    });
    this.completionWaiters.clear();
    this.listeners.splice(0);
  }

  private async ensureThread(): Promise<{ readonly id: string }> {
    this.assertActive();
    const currentThread = this.projection.getSnapshot().currentThread;
    if (currentThread) {
      return { id: currentThread.id };
    }

    const snapshot = await this.newThread();
    this.assertActive();

    if (!snapshot.thread) {
      throw new Error("Thread did not start");
    }

    return { id: snapshot.thread.id };
  }

  private subscribeOnce(): void {
    this.assertActive();
    if (this.subscription) {
      return;
    }

    const listener: AppServerNotificationListener = (notification) => {
      if (this.disposed) {
        return;
      }
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
        const waiters = [...(this.completionWaiters.get(notification.threadId) ?? [])];
        waiters.forEach((waiter) => notification.type === "turn/failed"
          ? waiter.reject(new Error(notification.error.message))
          : waiter.resolve());
      }
    };

    this.subscription = this.options.client.subscribe(listener);
  }

  getPendingCompletionWaiterCountForTest(): number {
    return [...this.completionWaiters.values()].reduce((count, waiters) => count + waiters.size, 0);
  }

  private createCompletionWaiter(threadId: string): CompletionWaiter {
    this.assertActive();
    let settled = false;
    let resolvePromise: () => void = () => undefined;
    let rejectPromise: (cause: Error) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const waiters = this.completionWaiters.get(threadId) ?? new Set<CompletionWaiter>();
    const remove = () => {
      waiters.delete(waiter);
      if (waiters.size === 0) this.completionWaiters.delete(threadId);
    };
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      remove();
      action();
    };
    const waiter: CompletionWaiter = {
      promise,
      resolve: () => settle(resolvePromise),
      reject: (cause) => settle(() => rejectPromise(cause)),
      discard: () => settle(() => undefined)
    };
    promise.catch(() => undefined);
    waiters.add(waiter);
    this.completionWaiters.set(threadId, waiters);
    return waiter;
  }

  private emit(event: AgentInteractionSessionEvent): void {
    if (this.disposed) {
      return;
    }
    this.listeners.forEach((listener) => listener(event));
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new AgentInteractionSessionDisposedError();
    }
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
