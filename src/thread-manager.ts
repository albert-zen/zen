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

  constructor(options: ThreadManagerOptions = {}) {
    this.generateThreadId = options.generateThreadId ?? createSequence("thread");
    this.generateRunId = options.generateRunId ?? createSequence("run");
    this.generateTurnId = options.generateTurnId ?? createSequence("turn");
    this.generateItemId = options.generateItemId ?? createSequence("item");
    this.clock = options.clock ?? Date.now;
    this.runtimeFactory = options.runtimeFactory ?? createDefaultRuntime;
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
      id: this.generateThreadId(),
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

  async startTurn(input: TurnStartInput): Promise<TurnSnapshot> {
    const thread = this.getThread(input.threadId);
    const turn: MutableTurnRecord = {
      id: this.generateTurnId(),
      runId: this.generateRunId(),
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
        modelOptions: input.modelOptions
      });
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
      return this.failTurn(thread, turn, {
        code: "TURN_FAILED",
        message: readErrorMessage(cause),
        details: serializeError(cause)
      });
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
