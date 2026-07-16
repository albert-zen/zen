import {
  type AppServerError,
  type AppServerNotification,
  type JsonValue,
  type ThreadSnapshot,
  type ThreadStatus,
  type TurnSnapshot,
  type TurnStatus,
  toProtocolItem,
  toThreadSnapshot
} from "./app-server-protocol.js";
import { AgentLoop, type AgentLoopOptions } from "./agent-loop.js";
import { type ContextCompiler } from "./context-compiler.js";
import {
  InMemoryItemList,
  type Clock,
  type IdGenerator,
  type Item,
  type ItemAppendInput
} from "./item-list.js";
import { type ModelGateway, type ModelOptions } from "./model-gateway.js";
import { type ToolRuntime } from "./tool-runtime.js";
import { type ApprovalBroker } from "./approval-runtime.js";

export type { ModelGateway, ModelOptions, ToolRuntime };

export type ThreadRuntime = {
  readonly model: ModelGateway;
  readonly toolRuntime?: ToolRuntime;
  readonly contextCompiler?: ContextCompiler;
  readonly systemPrompt?: string;
};

export type ThreadRuntimeFactoryInput = {
  readonly thread: ThreadRecord;
  readonly turn: TurnRecord;
  readonly approvalBroker?: ApprovalBroker;
};

export type ThreadRuntimeFactory = (
  input: ThreadRuntimeFactoryInput
) => ThreadRuntime;

export type ThreadManagerOptions = {
  readonly generateThreadId?: IdGenerator;
  readonly generateRunId?: IdGenerator;
  readonly generateTurnId?: IdGenerator;
  readonly generateItemId?: IdGenerator;
  readonly clock?: Clock;
  readonly runtimeFactory?: ThreadRuntimeFactory;
  readonly initialThreads?: readonly ThreadSnapshot[];
  readonly repairOnLoad?: boolean;
  readonly persistenceObserver?: (threadId: string, item: Item) => void;
  readonly persistenceFailures?: readonly import("./app-server-protocol.js").ThreadPersistenceFailure[];
  readonly approvalBroker?: ApprovalBroker;
};

export type TurnStartInput = {
  readonly threadId: string;
  readonly input: JsonValue;
  readonly modelOptions?: ModelOptions;
};

export type TurnRetryInput = {
  readonly threadId: string;
  readonly turnId?: string;
  readonly modelOptions?: ModelOptions;
};

export type ThreadRecord = {
  readonly id: string;
  readonly status: ThreadStatus;
  readonly turns: readonly TurnRecord[];
  readonly items: readonly Item[];
};

export type TurnRecord = {
  readonly id: string;
  readonly runId: string;
  readonly status: TurnStatus;
  readonly itemIds: readonly string[];
  readonly error?: JsonValue;
};

export type ThreadManagerEvent = AppServerNotification;
export type ThreadManagerObserver = (event: ThreadManagerEvent) => void;

type ThreadState = {
  readonly id: string;
  readonly itemList: InMemoryItemList;
};

type ActiveTurn = {
  readonly turnId: string;
  readonly controller: AbortController;
};

const STALE_TURN_REPAIR_CODE = "TURN_REPAIRED_ON_STARTUP";
const STALE_TURN_REPAIR_MESSAGE =
  "Turn was still in progress when the previous process stopped";

export class ThreadManager {
  private readonly threads = new Map<string, ThreadState>();
  private readonly observers: ThreadManagerObserver[] = [];
  private readonly generateThreadId: IdGenerator;
  private readonly generateRunId: IdGenerator;
  private readonly generateTurnId: IdGenerator;
  private readonly generateItemId: IdGenerator;
  private readonly clock: Clock;
  private readonly runtimeFactory: ThreadRuntimeFactory;
  private readonly turnTails = new Map<string, Promise<void>>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly approvalBroker?: ApprovalBroker;
  private readonly persistenceObserver?: ThreadManagerOptions["persistenceObserver"];
  private readonly persistenceFailuresByThread = new Map<string, import("./app-server-protocol.js").ThreadPersistenceFailure>();
  private readonly persistenceFailures: readonly import("./app-server-protocol.js").ThreadPersistenceFailure[];
  private closing = false;

  constructor(options: ThreadManagerOptions = {}) {
    this.generateThreadId = options.generateThreadId ?? createSequence("thread");
    this.generateRunId = options.generateRunId ?? createSequence("run");
    this.generateTurnId = options.generateTurnId ?? createSequence("turn");
    this.generateItemId = options.generateItemId ?? createSequence("item");
    this.clock = options.clock ?? Date.now;
    this.runtimeFactory = options.runtimeFactory ?? createDefaultRuntime;
    this.approvalBroker = options.approvalBroker;
    this.persistenceObserver = options.persistenceObserver;
    this.persistenceFailures = [...(options.persistenceFailures ?? [])];
    for (const failure of this.persistenceFailures) {
      if (failure.threadId) this.persistenceFailuresByThread.set(failure.threadId, failure);
    }

    for (const snapshot of options.initialThreads ?? []) {
      this.loadThread(snapshot, { emit: false });
    }
    if (options.repairOnLoad ?? true) this.repairLoadedThreads();
  }

  observe(observer: ThreadManagerObserver): () => void {
    this.observers.push(observer);

    return () => {
      const index = this.observers.indexOf(observer);

      if (index >= 0) {
        this.observers.splice(index, 1);
      }
    };
  }

  startThread(): ThreadSnapshot {
    const id = this.generateUniqueThreadId();
    const created: Item = {
      id: `thread-created:${id}`,
      type: "thread.created",
      createdAtMs: 0,
      seq: 0,
      runId: id,
      turnId: id,
      visibility: "internal",
      payload: { threadId: id }
    };
    const thread: ThreadState = {
      id,
      itemList: new InMemoryItemList({
        generateId: createUniqueIdGenerator(this.generateItemId, new Set([created.id])),
        clock: this.clock,
        initialItems: [created]
      })
    };

    this.threads.set(thread.id, thread);
    this.attachItemObserver(thread);
    this.persistenceObserver?.(thread.id, created);

    const snapshot = this.snapshotThread(thread);

    this.emit({ type: "thread/started", thread: snapshot });

    return snapshot;
  }

  readThread(threadId: string): ThreadSnapshot {
    return this.snapshotThread(this.getThread(threadId));
  }

  listThreads(): readonly ThreadSnapshot[] {
    return [...this.threads.values()].map((thread) => this.snapshotThread(thread));
  }

  loadThread(
    snapshot: ThreadSnapshot,
    options: { readonly emit?: boolean } = {}
  ): ThreadSnapshot {
    const thread = this.createThreadState(snapshot);

    this.threads.set(thread.id, thread);
    this.attachItemObserver(thread);

    const loaded = this.snapshotThread(thread);

    if (options.emit ?? true) {
      this.emit({ type: "thread/started", thread: loaded });
    }

    return loaded;
  }

  listPersistenceFailures(): readonly import("./app-server-protocol.js").ThreadPersistenceFailure[] {
    return this.persistenceFailures;
  }

  persistenceFailure(threadId: string): import("./app-server-protocol.js").ThreadPersistenceFailure | undefined {
    return this.persistenceFailuresByThread.get(threadId);
  }

  repairLoadedThreads(): void {
    this.threads.forEach((thread) => this.repairStaleTurns(thread));
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    for (const pending of this.approvalBroker?.listPending() ?? []) {
      this.approvalBroker?.declineTurn(
        pending.request.threadId,
        pending.request.turnId,
        "Server closing"
      );
    }
    for (const thread of this.threads.values()) {
      const active = this.activeTurns.get(thread.id);
      for (const turn of this.snapshotThread(thread).turns) {
        if (turn.status === "queued") this.cancelTurn(thread, turn);
      }
      if (active) active.controller.abort();
    }
    await Promise.all([...this.turnTails.values()]);
  }

  enqueueTurn(input: TurnStartInput): TurnSnapshot {
    const { turn, completion } = this.queueTurn(input);

    void completion;

    return turn;
  }

  async startTurn(input: TurnStartInput): Promise<TurnSnapshot> {
    return await this.queueTurn(input).completion;
  }

  interruptTurn(threadId: string): TurnSnapshot {
    const active = this.activeTurns.get(threadId);

    if (!active) {
      throw new Error(`No active turn for thread: ${threadId}`);
    }

    // Resolve before aborting so the waiting tool emits its audit resolution and error.
    this.approvalBroker?.declineTurn(threadId, active.turnId, "Turn interrupted");
    active.controller.abort();

    return this.getTurnSnapshot(this.getThread(threadId), active.turnId);
  }

  retryTurn(input: TurnRetryInput): TurnSnapshot {
    const thread = this.getThread(input.threadId);
    const turns = this.snapshotThread(thread).turns;
    const retrySource = input.turnId
      ? turns.find((turn) => turn.id === input.turnId)
      : latestRecoverableTurn(turns);

    if (!retrySource) {
      throw new Error(
        input.turnId
          ? `Unknown turn for retry: ${input.turnId}`
          : `No recoverable turn for thread: ${thread.id}`
      );
    }

    if (!isRecoverableTurnStatus(retrySource.status)) {
      throw new Error(`Turn is not recoverable: ${retrySource.id}`);
    }

    return this.enqueueTurn({
      threadId: thread.id,
      input: readUserInputForTurn(thread, retrySource),
      modelOptions: input.modelOptions
    });
  }

  private queueTurn(input: TurnStartInput): {
    readonly turn: TurnSnapshot;
    readonly completion: Promise<TurnSnapshot>;
  } {
    if (this.closing) throw new Error("Thread manager is closing");
    const thread = this.getThread(input.threadId);
    const current = this.snapshotThread(thread);
    const turnId = generateUniqueId(
      this.generateTurnId,
      new Set(current.turns.map((turn) => turn.id))
    );
    const runId = generateUniqueId(
      this.generateRunId,
      new Set(current.turns.map((turn) => turn.runId))
    );
    const completion = this.scheduleTurn(thread, turnId, input);

    this.appendQueuedTurn(thread, turnId, runId, input.input);

    return {
      turn: this.getTurnSnapshot(thread, turnId),
      completion
    };
  }

  private appendQueuedTurn(
    thread: ThreadState,
    turnId: string,
    runId: string,
    input: JsonValue
  ): void {
    thread.itemList.append({
      type: "turn.queued",
      runId,
      turnId,
      visibility: "trace",
      payload: { input }
    });
  }

  private scheduleTurn(
    thread: ThreadState,
    turnId: string,
    input: TurnStartInput
  ): Promise<TurnSnapshot> {
    const previous = this.turnTails.get(thread.id) ?? Promise.resolve();
    const result = previous.then(() => this.runTurn(thread, turnId, input));
    const tail = result.then(
      () => undefined,
      () => undefined
    );

    this.turnTails.set(thread.id, tail);
    void tail.finally(() => {
      if (this.turnTails.get(thread.id) === tail) {
        this.turnTails.delete(thread.id);
      }
    });

    return result;
  }

  private async runTurn(
    thread: ThreadState,
    turnId: string,
    input: TurnStartInput
  ): Promise<TurnSnapshot> {
    const existing = this.getTurnSnapshot(thread, turnId);
    if (this.closing) {
      return isTerminalTurnStatus(existing.status)
        ? existing
        : this.cancelTurn(thread, existing);
    }
    const controller = new AbortController();

    this.activeTurns.set(thread.id, { turnId, controller });

    try {
      const turn = this.getTurnSnapshot(thread, turnId);
      const runtime = this.runtimeFactory({
        thread: toThreadRecord(thread),
        turn,
        approvalBroker: this.approvalBroker
      });
      const loop = new AgentLoop(createAgentLoopOptions(thread, runtime));
      const result = await loop.run({
        threadId: thread.id,
        input: input.input,
        runId: turn.runId,
        turnId: turn.id,
        modelOptions: input.modelOptions,
        signal: controller.signal
      });

      const terminal = this.getTurnSnapshot(thread, turn.id);

      if (terminal.status === "completed") {
        this.emit({
          type: "turn/completed",
          threadId: thread.id,
          turn: terminal
        });

        return terminal;
      }

      if (controller.signal.aborted) {
        return this.cancelTurn(thread, turn);
      }

      const failureItem = result.items.find(
        (item) =>
          item.turnId === turn.id &&
          (item.type === "assistant.message.error" || item.type === "tool.error")
      );

      if (failureItem) {
        return this.failTurn(thread, turn, {
          code: "TURN_FAILED",
          message: readFailureMessage(failureItem.payload),
          details: toProtocolItem(failureItem).payload
        });
      }

      return this.failTurn(thread, turn, {
        code: "TURN_FAILED",
        message: "Turn ended without a terminal lifecycle item"
      });
    } catch (cause) {
      const turn = this.getTurnSnapshot(thread, turnId);

      if (isTerminalTurnStatus(turn.status)) {
        throw cause;
      }

      if (controller.signal.aborted) {
        return this.cancelTurn(thread, turn);
      }

      return this.failTurn(thread, turn, {
        code: "TURN_FAILED",
        message: readErrorMessage(cause),
        details: serializeError(cause)
      });
    } finally {
      if (this.activeTurns.get(thread.id)?.turnId === turnId) {
        this.activeTurns.delete(thread.id);
      }
    }
  }

  private createThreadState(snapshot: ThreadSnapshot): ThreadState {
    const existingItemIds = new Set(snapshot.items.map((item) => item.id));
    const thread: ThreadState = {
      id: snapshot.id,
      itemList: new InMemoryItemList({
        generateId: createUniqueIdGenerator(
          this.generateItemId,
          existingItemIds
        ),
        clock: this.clock,
        initialItems: snapshot.items.map((item) => ({ ...item }))
      })
    };

    return thread;
  }

  private repairStaleTurns(thread: ThreadState): void {
    const error = {
      code: STALE_TURN_REPAIR_CODE,
      message: STALE_TURN_REPAIR_MESSAGE
    };

    for (const turn of this.snapshotThread(thread).turns) {
      if (turn.status !== "inProgress" && turn.status !== "queued") {
        continue;
      }

      thread.itemList.append({
        type: "turn.repaired",
        runId: turn.runId,
        turnId: turn.id,
        visibility: "trace",
        payload: {
          previousStatus: turn.status,
          status: "failed",
          reason: STALE_TURN_REPAIR_MESSAGE,
          error
        }
      });
    }
  }

  private attachItemObserver(thread: ThreadState): void {
    thread.itemList.observe((item) => {
      if (item.visibility === "internal") {
        return;
      }

      this.emit({
        type: "item/appended",
        threadId: thread.id,
        turnId: item.turnId,
        item: toProtocolItem(item)
      });

      if (item.type === "turn.started") {
        this.emit({
          type: "turn/started",
          threadId: thread.id,
          turn: this.getTurnSnapshot(thread, item.turnId)
        });
      }

      if (item.type === "approval.requested") {
        const approvalId = readStringPayloadField(item.payload, "approvalId");
        if (approvalId) this.emit({ type: "approval/requested", threadId: thread.id, turnId: item.turnId, approvalId, item: toProtocolItem(item) });
      }
      if (item.type === "approval.resolved") {
        const approvalId = readStringPayloadField(item.payload, "approvalId");
        const decision = readApprovalDecision(item.payload);
        if (approvalId && decision) this.emit({ type: "approval/resolved", threadId: thread.id, turnId: item.turnId, approvalId, decision, item: toProtocolItem(item) });
      }
    });
  }

  private snapshotThread(thread: ThreadState): ThreadSnapshot {
    return toThreadSnapshot({
      threadId: thread.id,
      items: thread.itemList.getItems()
    });
  }

  private getTurnSnapshot(
    thread: ThreadState,
    turnId: string
  ): TurnSnapshot {
    const turn = this.snapshotThread(thread).turns.find(
      (entry) => entry.id === turnId
    );

    if (!turn) {
      throw new Error(`Unknown turn: ${turnId}`);
    }

    return turn;
  }

  private getThread(threadId: string): ThreadState {
    const thread = this.threads.get(threadId);

    if (!thread) {
      throw new Error(`Unknown thread: ${threadId}`);
    }

    return thread;
  }

  private generateUniqueThreadId(): string {
    return generateUniqueId(this.generateThreadId, new Set(this.threads.keys()));
  }

  private emit(event: ThreadManagerEvent): void {
    this.observers.forEach((observer) => observer(event));
  }

  private failTurn(
    thread: ThreadState,
    turn: TurnSnapshot,
    error: AppServerError
  ): TurnSnapshot {
    const terminal = this.appendTerminalItem(thread, turn, {
      type: "turn.failed",
      runId: turn.runId,
      turnId: turn.id,
      visibility: "trace",
      payload: {
        status: "failed",
        error: error.details ?? { code: error.code, message: error.message }
      }
    });

    if (!terminal.appended) {
      return terminal.turn;
    }

    this.emit({
      type: "turn/failed",
      threadId: thread.id,
      turn: terminal.turn,
      error
    });

    return terminal.turn;
  }

  private cancelTurn(
    thread: ThreadState,
    turn: TurnSnapshot
  ): TurnSnapshot {
    const error = { code: "TURN_INTERRUPTED", message: "Turn interrupted" };

    const terminal = this.appendTerminalItem(thread, turn, {
      type: "turn.canceled",
      runId: turn.runId,
      turnId: turn.id,
      visibility: "trace",
      payload: { status: "canceled", error }
    });

    if (!terminal.appended) {
      return terminal.turn;
    }

    this.emit({
      type: "turn/completed",
      threadId: thread.id,
      turn: terminal.turn
    });

    return terminal.turn;
  }

  private appendTerminalItem(
    thread: ThreadState,
    turn: TurnSnapshot,
    item: ItemAppendInput
  ): { readonly turn: TurnSnapshot; readonly appended: boolean } {
    const current = this.getTurnSnapshot(thread, turn.id);

    if (isTerminalTurnStatus(current.status)) {
      return { turn: current, appended: false };
    }

    thread.itemList.append(item);

    return {
      turn: this.getTurnSnapshot(thread, turn.id),
      appended: true
    };
  }
}

function readStringPayloadField(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null || !(key in payload)) return undefined;
  const value = (payload as Readonly<Record<string, unknown>>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readApprovalDecision(payload: unknown): "approveOnce" | "decline" | undefined {
  const decision = readStringPayloadField(payload, "decision");
  return decision === "approveOnce" || decision === "decline" ? decision : undefined;
}

function toThreadRecord(thread: ThreadState): ThreadRecord {
  const snapshot = toThreadSnapshot({
    threadId: thread.id,
    items: thread.itemList.getItems()
  });

  return {
    id: snapshot.id,
    status: snapshot.status,
    turns: snapshot.turns,
    items: thread.itemList.getItems()
  };
}

function latestRecoverableTurn(
  turns: readonly TurnSnapshot[]
): TurnSnapshot | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];

    if (turn && isRecoverableTurnStatus(turn.status)) {
      return turn;
    }
  }

  return undefined;
}

function isRecoverableTurnStatus(status: TurnStatus): boolean {
  return status === "failed" || status === "canceled";
}

function isTerminalTurnStatus(status: TurnStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "canceled"
  );
}

function readUserInputForTurn(
  thread: ThreadState,
  turn: TurnSnapshot
): JsonValue {
  const items = thread.itemList.getItems();
  const userItem = items.find(
    (item) => item.turnId === turn.id && item.type === "user.message.completed"
  );
  const queuedItem = items.find(
    (item) => item.turnId === turn.id && item.type === "turn.queued"
  );
  const input = userItem
    ? readObjectProperty(userItem.payload, "content")
    : readObjectProperty(queuedItem?.payload, "input");

  if (!isJsonValue(input)) {
    throw new Error(`Cannot retry turn without JSON user input: ${turn.id}`);
  }

  return input;
}

function readObjectProperty(payload: unknown, key: string): unknown {
  if (typeof payload === "object" && payload !== null && key in payload) {
    return payload[key as keyof typeof payload];
  }

  return undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every(isJsonValue)
  );
}

function createAgentLoopOptions(
  thread: ThreadState,
  runtime: ThreadRuntime
): AgentLoopOptions {
  return {
    itemList: thread.itemList,
    model: runtime.model,
    toolRuntime: runtime.toolRuntime,
    contextCompiler: runtime.contextCompiler,
    systemPrompt: runtime.systemPrompt
  };
}

function createDefaultRuntime(): ThreadRuntime {
  return {
    model: {
      async *generate() {
        yield {
          type: "message.completed" as const,
          content: "Fake response"
        };
      }
    }
  };
}

function createSequence(prefix: string): IdGenerator {
  let nextId = 0;

  return () => `${prefix}-${++nextId}`;
}

function createUniqueIdGenerator(
  generateId: IdGenerator,
  existingIds: ReadonlySet<string>
): IdGenerator {
  const usedIds = new Set(existingIds);

  return () => {
    const id = generateUniqueId(generateId, usedIds);

    usedIds.add(id);

    return id;
  };
}

function generateUniqueId(
  generateId: IdGenerator,
  existingIds: ReadonlySet<string>
): string {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const id = generateId();

    if (!existingIds.has(id)) {
      return id;
    }
  }

  throw new Error("Unable to generate a unique id");
}

function readFailureMessage(payload: unknown): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return payload.message;
  }

  return "Turn failed";
}

function readErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function serializeError(cause: unknown): JsonValue {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }

  if (
    cause === null ||
    typeof cause === "string" ||
    typeof cause === "number" ||
    typeof cause === "boolean"
  ) {
    return cause;
  }

  return String(cause);
}
