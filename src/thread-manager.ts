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
  type Item
} from "./item-list.js";
import { type ModelGateway, type ModelOptions } from "./model-gateway.js";
import { type ToolRuntime } from "./tool-runtime.js";

export type { ModelGateway, ModelOptions, ToolRuntime };

export type ThreadRuntime = {
  readonly model: ModelGateway;
  readonly toolRuntime?: ToolRuntime;
  readonly contextCompiler?: ContextCompiler;
};

export type ThreadRuntimeFactoryInput = {
  readonly thread: ThreadRecord;
  readonly turn: TurnRecord;
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
};

export type TurnStartInput = {
  readonly threadId: string;
  readonly input: JsonValue;
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

type MutableThreadRecord = {
  readonly id: string;
  status: ThreadStatus;
  readonly itemList: InMemoryItemList;
  readonly turns: MutableTurnRecord[];
};

type MutableTurnRecord = {
  readonly id: string;
  readonly runId: string;
  status: TurnStatus;
  itemIds: string[];
  error?: JsonValue;
};

export class ThreadManager {
  private readonly threads = new Map<string, MutableThreadRecord>();
  private readonly observers: ThreadManagerObserver[] = [];
  private readonly generateThreadId: IdGenerator;
  private readonly generateRunId: IdGenerator;
  private readonly generateTurnId: IdGenerator;
  private readonly generateItemId: IdGenerator;
  private readonly clock: Clock;
  private readonly runtimeFactory: ThreadRuntimeFactory;
  private readonly activeTurns = new Map<
    string,
    {
      readonly thread: MutableThreadRecord;
      readonly turn: MutableTurnRecord;
      readonly controller: AbortController;
    }
  >();

  constructor(options: ThreadManagerOptions = {}) {
    this.generateThreadId = options.generateThreadId ?? createSequence("thread");
    this.generateRunId = options.generateRunId ?? createSequence("run");
    this.generateTurnId = options.generateTurnId ?? createSequence("turn");
    this.generateItemId = options.generateItemId ?? createSequence("item");
    this.clock = options.clock ?? Date.now;
    this.runtimeFactory = options.runtimeFactory ?? createDefaultRuntime;

    for (const snapshot of options.initialThreads ?? []) {
      this.loadThread(snapshot, { emit: false });
    }
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
    const thread: MutableThreadRecord = {
      id: this.generateUniqueThreadId(),
      status: "idle",
      itemList: new InMemoryItemList({
        generateId: this.generateItemId,
        clock: this.clock
      }),
      turns: []
    };

    thread.itemList.observe((item) => {
      const turn = thread.turns.find((entry) => entry.id === item.turnId);

      if (!turn) {
        return;
      }

      turn.itemIds.push(item.id);

      if (item.visibility === "internal") {
        return;
      }

      this.emit({
        type: "item/appended",
        threadId: thread.id,
        turnId: item.turnId,
        item: toProtocolItem(item)
      });
    });

    this.threads.set(thread.id, thread);

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
    const thread = this.createThreadRecord(snapshot);

    this.threads.set(thread.id, thread);
    this.attachItemObserver(thread);

    const loaded = this.snapshotThread(thread);

    if (options.emit ?? true) {
      this.emit({ type: "thread/started", thread: loaded });
    }

    return loaded;
  }

  enqueueTurn(input: TurnStartInput): TurnSnapshot {
    const thread = this.getThread(input.threadId);
    const turn = this.createTurn(thread);

    queueMicrotask(() => {
      void this.runTurn(thread, turn, input);
    });

    return toTurnSnapshot(turn);
  }

  async startTurn(input: TurnStartInput): Promise<TurnSnapshot> {
    const thread = this.getThread(input.threadId);
    const turn = this.createTurn(thread);

    return await this.runTurn(thread, turn, input);
  }

  interruptTurn(threadId: string): TurnSnapshot {
    const thread = this.getThread(threadId);
    const active = [...this.activeTurns.values()]
      .filter((entry) => entry.thread.id === threadId)
      .at(-1);

    if (!active) {
      throw new Error(`No active turn for thread: ${threadId}`);
    }

    active.controller.abort();

    return toTurnSnapshot(active.turn);
  }

  private createTurn(thread: MutableThreadRecord): MutableTurnRecord {
    const turn: MutableTurnRecord = {
      id: this.generateUniqueTurnId(thread),
      runId: this.generateUniqueRunId(thread),
      status: "inProgress",
      itemIds: []
    };

    thread.turns.push(turn);
    thread.status = "running";

    this.emit({
      type: "turn/started",
      threadId: thread.id,
      turn: toTurnSnapshot(turn)
    });

    return turn;
  }

  private createThreadRecord(snapshot?: ThreadSnapshot): MutableThreadRecord {
    const thread: MutableThreadRecord = {
      id: snapshot?.id ?? this.generateThreadId(),
      status: snapshot?.status === "running" ? "idle" : snapshot?.status ?? "idle",
      itemList: new InMemoryItemList({
        generateId: createUniqueIdGenerator(
          this.generateItemId,
          new Set(snapshot?.items.map((item) => item.id) ?? [])
        ),
        clock: this.clock,
        initialItems: snapshot?.items.map((item) => ({ ...item }))
      }),
      turns: snapshot?.turns.map((turn) => ({
        id: turn.id,
        runId: turn.runId,
        status: turn.status === "inProgress" || turn.status === "queued" ? "failed" : turn.status,
        itemIds: [...turn.itemIds],
        error: turn.error
      })) ?? []
    };

    return thread;
  }

  private generateUniqueThreadId(): string {
    return generateUniqueId(this.generateThreadId, new Set(this.threads.keys()));
  }

  private generateUniqueTurnId(thread: MutableThreadRecord): string {
    return generateUniqueId(
      this.generateTurnId,
      new Set(thread.turns.map((turn) => turn.id))
    );
  }

  private generateUniqueRunId(thread: MutableThreadRecord): string {
    return generateUniqueId(
      this.generateRunId,
      new Set(thread.turns.map((turn) => turn.runId))
    );
  }

  private attachItemObserver(thread: MutableThreadRecord): void {
    thread.itemList.observe((item) => {
      const turn = thread.turns.find((entry) => entry.id === item.turnId);

      if (!turn) {
        return;
      }

      turn.itemIds.push(item.id);

      if (item.visibility === "internal") {
        return;
      }

      this.emit({
        type: "item/appended",
        threadId: thread.id,
        turnId: item.turnId,
        item: toProtocolItem(item)
      });
    });
  }

  private async runTurn(
    thread: MutableThreadRecord,
    turn: MutableTurnRecord,
    input: TurnStartInput
  ): Promise<TurnSnapshot> {
    const controller = new AbortController();
    this.activeTurns.set(turn.id, { thread, turn, controller });

    try {
      const runtime = this.runtimeFactory({
        thread: toThreadRecord(thread),
        turn: toTurnRecord(turn)
      });
      const loop = new AgentLoop(createAgentLoopOptions(thread, runtime));
      const result = await loop.run({
        input: input.input,
        runId: turn.runId,
        turnId: turn.id,
        modelOptions: input.modelOptions,
        signal: controller.signal
      });
      if (controller.signal.aborted) {
        return this.cancelTurn(thread, turn);
      }
      const failureItem = result.items.find(
        (item) =>
          item.turnId === turn.id &&
          (item.type === "assistant.message.error" || item.type === "tool.error")
      );

      if (failureItem) {
        if (controller.signal.aborted) {
          return this.cancelTurn(thread, turn);
        }
        return this.failTurn(thread, turn, {
          code: "TURN_FAILED",
          message: readFailureMessage(failureItem.payload),
          details: toProtocolItem(failureItem).payload
        });
      }

      turn.status = "completed";
      thread.status = "idle";

      const snapshot = toTurnSnapshot(turn);

      this.emit({
        type: "turn/completed",
        threadId: thread.id,
        turn: snapshot
      });

      return snapshot;
    } catch (cause) {
      if (controller.signal.aborted) {
        return this.cancelTurn(thread, turn);
      }
      return this.failTurn(thread, turn, {
        code: "TURN_FAILED",
        message: readErrorMessage(cause),
        details: serializeError(cause)
      });
    } finally {
      this.activeTurns.delete(turn.id);
    }
  }

  private snapshotThread(thread: MutableThreadRecord): ThreadSnapshot {
    return toThreadSnapshot({
      threadId: thread.id,
      status: thread.status,
      turns: thread.turns.map(toTurnSnapshot),
      items: thread.itemList.getItems()
    });
  }

  private getThread(threadId: string): MutableThreadRecord {
    const thread = this.threads.get(threadId);

    if (!thread) {
      throw new Error(`Unknown thread: ${threadId}`);
    }

    return thread;
  }

  private emit(event: ThreadManagerEvent): void {
    this.observers.forEach((observer) => observer(event));
  }

  private failTurn(
    thread: MutableThreadRecord,
    turn: MutableTurnRecord,
    error: AppServerError
  ): TurnSnapshot {
    turn.status = "failed";
    turn.error = error.details ?? { code: error.code, message: error.message };
    thread.status = "failed";

    const snapshot = toTurnSnapshot(turn);

    this.emit({
      type: "turn/failed",
      threadId: thread.id,
      turn: snapshot,
      error
    });

    return snapshot;
  }

  private cancelTurn(
    thread: MutableThreadRecord,
    turn: MutableTurnRecord
  ): TurnSnapshot {
    turn.status = "canceled";
    turn.error = { code: "TURN_INTERRUPTED", message: "Turn interrupted" };
    thread.status = "idle";

    const snapshot = toTurnSnapshot(turn);

    this.emit({
      type: "turn/completed",
      threadId: thread.id,
      turn: snapshot
    });

    return snapshot;
  }
}

function toTurnSnapshot(turn: MutableTurnRecord): TurnSnapshot {
  return {
    id: turn.id,
    runId: turn.runId,
    status: turn.status,
    itemIds: [...turn.itemIds],
    error: turn.error
  };
}

function toThreadRecord(thread: MutableThreadRecord): ThreadRecord {
  return {
    id: thread.id,
    status: thread.status,
    turns: thread.turns.map(toTurnSnapshot),
    items: thread.itemList.getItems()
  };
}

function toTurnRecord(turn: MutableTurnRecord): TurnRecord {
  return toTurnSnapshot(turn);
}

function createAgentLoopOptions(
  thread: MutableThreadRecord,
  runtime: ThreadRuntime
): AgentLoopOptions {
  return {
    itemList: thread.itemList,
    model: runtime.model,
    toolRuntime: runtime.toolRuntime,
    contextCompiler: runtime.contextCompiler
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
    typeof (payload as { readonly message?: unknown }).message === "string"
  ) {
    return (payload as { readonly message: string }).message;
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
