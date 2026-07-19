import {
  type AppServerError,
  type AppServerNotification,
  type JsonValue,
  type ThreadSnapshot,
  type ThreadStatus,
  type TurnSnapshot,
  type TurnStatus,
  toProtocolItem,
  toThreadSnapshot,
} from './app-server-protocol.js';
import { AgentLoop, type AgentLoopOptions, type ContextCompiler } from '../kernel/index.js';
import {
  InMemoryItemList,
  type Clock,
  type IdGenerator,
  type Item,
  type ItemAppendInput,
} from '../kernel/index.js';
import { type ModelGateway, type ModelOptions, type ToolRuntime } from '../kernel/index.js';
import {
  type ApprovalBroker,
  type ApprovalDecision,
  type ApprovalRequest,
} from './approval-runtime.js';

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

export type ThreadRuntimeFactory = (input: ThreadRuntimeFactoryInput) => ThreadRuntime;

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
  readonly itemCommitBarrier?: (threadId: string, item: Item) => Promise<void>;
  readonly persistenceFailures?: readonly import('./app-server-protocol.js').ThreadPersistenceFailure[];
  readonly approvalBroker?: ApprovalBroker;
  readonly acquireExecutionLease?: (input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly signal: AbortSignal;
  }) => Promise<{ settle(turn: TurnSnapshot): Promise<void> }>;
};

export type TurnStartInput = {
  readonly threadId: string;
  readonly input: JsonValue;
  readonly modelOptions?: ModelOptions;
  readonly commandId?: string;
};

export type TurnRetryInput = {
  readonly threadId: string;
  readonly turnId?: string;
  readonly modelOptions?: ModelOptions;
  readonly commandId?: string;
};

export type PreparedTurn = {
  readonly turn: TurnSnapshot;
  activate(): Promise<TurnSnapshot>;
  abandon(): void;
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

export type ThreadManagerEvent = Exclude<AppServerNotification, { readonly type: 'sync/reset' }>;
export type ThreadManagerObserver = (event: ThreadManagerEvent) => void;

type ThreadState = {
  readonly id: string;
  readonly itemList: InMemoryItemList;
};

type ActiveTurn = {
  readonly turnId: string;
  readonly controller: AbortController;
};

const STALE_TURN_REPAIR_CODE = 'TURN_REPAIRED_ON_STARTUP';
const STALE_TURN_REPAIR_MESSAGE = 'Turn was still in progress when the previous process stopped';

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
  private readonly persistenceObserver?: ThreadManagerOptions['persistenceObserver'];
  private readonly itemCommitBarrier?: ThreadManagerOptions['itemCommitBarrier'];
  private readonly acquireExecutionLease?: ThreadManagerOptions['acquireExecutionLease'];
  private readonly pendingTurnActivations = new Set<() => void>();
  private readonly persistenceFailuresByThread = new Map<
    string,
    import('./app-server-protocol.js').ThreadPersistenceFailure
  >();
  private readonly persistenceFailures: readonly import('./app-server-protocol.js').ThreadPersistenceFailure[];
  private closing = false;
  private fenced = false;

  constructor(options: ThreadManagerOptions = {}) {
    this.generateThreadId = options.generateThreadId ?? createSequence('thread');
    this.generateRunId = options.generateRunId ?? createSequence('run');
    this.generateTurnId = options.generateTurnId ?? createSequence('turn');
    this.generateItemId = options.generateItemId ?? createSequence('item');
    this.clock = options.clock ?? Date.now;
    this.runtimeFactory = options.runtimeFactory ?? createDefaultRuntime;
    this.approvalBroker = options.approvalBroker;
    this.persistenceObserver = options.persistenceObserver;
    this.itemCommitBarrier = options.itemCommitBarrier;
    this.acquireExecutionLease = options.acquireExecutionLease;
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

  reserveThreadId(): string {
    return this.generateUniqueThreadId();
  }

  startThread(id = this.generateUniqueThreadId()): ThreadSnapshot {
    if (this.threads.has(id)) throw new Error(`Thread already exists: ${id}`);
    const created: Item = {
      id: `thread-created:${id}`,
      type: 'thread.created',
      createdAtMs: 0,
      seq: 0,
      runId: id,
      turnId: id,
      visibility: 'internal',
      payload: { threadId: id },
    };
    const thread: ThreadState = {
      id,
      itemList: new InMemoryItemList({
        generateId: createUniqueIdGenerator(this.generateItemId, new Set([created.id])),
        clock: this.clock,
        initialItems: [created],
      }),
    };

    this.threads.set(thread.id, thread);
    this.attachItemObserver(thread);
    this.persistenceObserver?.(thread.id, created);

    const snapshot = this.snapshotThread(thread);

    this.emit({ type: 'thread/started', thread: snapshot });

    return snapshot;
  }

  readThread(threadId: string): ThreadSnapshot {
    return this.snapshotThread(this.getThread(threadId));
  }

  listThreads(): readonly ThreadSnapshot[] {
    return [...this.threads.values()].map((thread) => this.snapshotThread(thread));
  }

  async flushThread(threadId: string): Promise<void> {
    const thread = this.getThread(threadId);
    const item = thread.itemList.getItems().at(-1);
    if (item) await this.itemCommitBarrier?.(threadId, item);
  }

  async fenceThread(threadId: string): Promise<ThreadSnapshot> {
    const thread = this.getThread(threadId);
    const active = this.activeTurns.get(threadId);
    if (active) active.controller.abort();
    const cancellable = this.snapshotThread(thread).turns.filter(
      (turn) => turn.status === 'queued' || turn.id === active?.turnId
    );
    await Promise.all(cancellable.map(async (turn) => await this.cancelTurn(thread, turn)));
    await this.flushThread(threadId);
    return this.snapshotThread(thread);
  }

  loadThread(snapshot: ThreadSnapshot, options: { readonly emit?: boolean } = {}): ThreadSnapshot {
    const thread = this.createThreadState(snapshot);

    this.threads.set(thread.id, thread);
    this.attachItemObserver(thread);

    const loaded = this.snapshotThread(thread);

    if (options.emit ?? true) {
      this.emit({ type: 'thread/started', thread: loaded });
    }

    return loaded;
  }

  listPersistenceFailures(): readonly import('./app-server-protocol.js').ThreadPersistenceFailure[] {
    return this.persistenceFailures;
  }

  persistenceFailure(
    threadId: string
  ): import('./app-server-protocol.js').ThreadPersistenceFailure | undefined {
    return this.persistenceFailuresByThread.get(threadId);
  }

  repairLoadedThreads(): void {
    this.threads.forEach((thread) => this.repairStaleTurns(thread));
  }

  async shutdown(): Promise<void> {
    const failures: unknown[] = [];
    this.closing = true;
    this.abandonPendingTurns();
    for (const pending of this.approvalBroker?.listPending() ?? []) {
      this.approvalBroker?.declineTurn(
        pending.request.threadId,
        pending.request.turnId,
        'Server closing'
      );
    }
    if (this.fenced) {
      for (const active of this.activeTurns.values()) active.controller.abort();
      collectRejected(await Promise.allSettled([...this.turnTails.values()]), failures);
      if (failures.length > 0) throw new AggregateError(failures, 'ThreadManager shutdown failed');
      return;
    }
    const cancellations: Promise<TurnSnapshot>[] = [];
    for (const thread of this.threads.values()) {
      const active = this.activeTurns.get(thread.id);
      for (const turn of this.snapshotThread(thread).turns) {
        if (turn.status === 'queued') cancellations.push(this.cancelTurn(thread, turn));
      }
      if (active) active.controller.abort();
    }
    collectRejected(await Promise.allSettled(cancellations), failures);
    collectRejected(await Promise.allSettled([...this.turnTails.values()]), failures);
    if (failures.length > 0) throw new AggregateError(failures, 'ThreadManager shutdown failed');
  }

  failStop(): void {
    if (this.fenced) return;
    this.fenced = true;
    this.closing = true;
    this.abandonPendingTurns();
    for (const pending of this.approvalBroker?.listPending() ?? []) {
      this.approvalBroker?.declineTurn(
        pending.request.threadId,
        pending.request.turnId,
        'Persistence unavailable'
      );
    }
    for (const active of this.activeTurns.values()) {
      active.controller.abort();
    }
  }

  enqueueTurn(input: TurnStartInput): TurnSnapshot {
    const { preparation, appendError } = this.createPreparedTurn(input);
    void preparation.activate();
    if (appendError) throw appendError;
    return preparation.turn;
  }

  async startTurn(input: TurnStartInput): Promise<TurnSnapshot> {
    const { preparation, appendError } = this.createPreparedTurn(input);
    const completion = preparation.activate();
    if (appendError) throw appendError;
    return await completion;
  }

  prepareTurn(input: TurnStartInput): PreparedTurn {
    const { preparation, appendError } = this.createPreparedTurn(input);
    if (appendError) {
      preparation.abandon();
      throw appendError;
    }
    return preparation;
  }

  interruptTurn(threadId: string): TurnSnapshot {
    const active = this.activeTurns.get(threadId);

    if (!active) {
      throw new Error(`No active turn for thread: ${threadId}`);
    }

    // Resolve before aborting so the waiting tool emits its audit resolution and error.
    this.approvalBroker?.declineTurn(threadId, active.turnId, 'Turn interrupted');
    active.controller.abort();

    return this.getTurnSnapshot(this.getThread(threadId), active.turnId);
  }

  async recordApprovalResolution(
    request: ApprovalRequest,
    decision: ApprovalDecision
  ): Promise<void> {
    const thread = this.getThread(request.threadId);
    const payload: Record<string, unknown> = {
      approvalId: request.id,
      threadId: request.threadId,
      turnId: request.turnId,
      runId: request.runId,
      toolCallId: request.call.id,
      toolName: request.call.name,
      decision: decision.type,
    };
    if (request.call.input !== undefined) payload.input = request.call.input;
    if (request.reason !== undefined) payload.reason = request.reason;
    if (decision.reason !== undefined) payload.decisionReason = decision.reason;
    await this.appendItem(thread, {
      type: 'approval.resolved',
      runId: request.runId,
      turnId: request.turnId,
      causeId: request.startedItemId,
      targetId: request.startedItemId,
      visibility: 'trace',
      payload,
    });
  }

  retryTurn(input: TurnRetryInput): TurnSnapshot {
    return this.enqueuePreparedRetry(input);
  }

  prepareRetry(input: TurnRetryInput): PreparedTurn {
    return this.prepareTurn(this.retryStartInput(input));
  }

  private enqueuePreparedRetry(input: TurnRetryInput): TurnSnapshot {
    return this.enqueueTurn(this.retryStartInput(input));
  }

  private retryStartInput(input: TurnRetryInput): TurnStartInput {
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

    return {
      threadId: thread.id,
      input: readUserInputForTurn(thread, retrySource),
      modelOptions: input.modelOptions,
      commandId: input.commandId,
    };
  }

  private createPreparedTurn(input: TurnStartInput): {
    readonly preparation: PreparedTurn;
    readonly appendError?: unknown;
  } {
    if (this.closing) throw new Error('Thread manager is closing');
    const thread = this.getThread(input.threadId);
    const current = this.snapshotThread(thread);
    if (input.commandId) {
      const queued = thread.itemList
        .getItems()
        .find(
          (item) =>
            item.type === 'turn.queued' &&
            readObjectProperty(item.payload, 'commandId') === input.commandId
        );
      if (queued) {
        const existing = this.getTurnSnapshot(thread, queued.turnId);
        const previousInput = readObjectProperty(queued.payload, 'input');
        if (JSON.stringify(previousInput) !== JSON.stringify(input.input)) {
          throw new Error(`Turn command idempotency conflict: ${input.commandId}`);
        }
        if (existing.status !== 'queued') {
          return {
            preparation: {
              turn: existing,
              activate: async () => this.getTurnSnapshot(thread, existing.id),
              abandon: () => undefined,
            },
          };
        }
        return { preparation: this.createActivationPreparation(thread, existing.id, input) };
      }
    }
    const turnId = generateUniqueId(
      this.generateTurnId,
      new Set(current.turns.map((turn) => turn.id))
    );
    const runId = generateUniqueId(
      this.generateRunId,
      new Set(current.turns.map((turn) => turn.runId))
    );
    const reservation = this.reserveTurnActivation(thread, turnId, input);
    let appendError: unknown;
    try {
      this.appendQueuedTurn(thread, turnId, runId, input.input, input.commandId);
    } catch (cause) {
      appendError = cause;
    }
    try {
      return {
        preparation: this.preparedTurn(thread, turnId, reservation),
        ...(appendError === undefined ? {} : { appendError }),
      };
    } catch (cause) {
      reservation.abandon();
      throw appendError ?? cause;
    }
  }

  private createActivationPreparation(
    thread: ThreadState,
    turnId: string,
    input: TurnStartInput
  ): PreparedTurn {
    return this.preparedTurn(thread, turnId, this.reserveTurnActivation(thread, turnId, input));
  }

  private reserveTurnActivation(
    thread: ThreadState,
    turnId: string,
    input: TurnStartInput
  ): {
    readonly completion: Promise<TurnSnapshot>;
    readonly activate: () => void;
    readonly abandon: () => void;
  } {
    let activate!: (value: boolean) => void;
    const activation = new Promise<boolean>((resolve) => {
      activate = resolve;
    });
    const completion = this.scheduleTurn(thread, turnId, input, activation);
    let state: 'pending' | 'active' | 'abandoned' = 'pending';
    const abandon = () => {
      if (state !== 'pending') return;
      state = 'abandoned';
      this.pendingTurnActivations.delete(abandon);
      activate(false);
    };
    this.pendingTurnActivations.add(abandon);
    return {
      completion,
      activate: () => {
        if (state === 'pending') {
          state = 'active';
          this.pendingTurnActivations.delete(abandon);
          activate(true);
        }
      },
      abandon,
    };
  }

  private preparedTurn(
    thread: ThreadState,
    turnId: string,
    reservation: ReturnType<ThreadManager['reserveTurnActivation']>
  ): PreparedTurn {
    return {
      turn: this.getTurnSnapshot(thread, turnId),
      activate: () => {
        reservation.activate();
        return reservation.completion;
      },
      abandon: reservation.abandon,
    };
  }

  private appendQueuedTurn(
    thread: ThreadState,
    turnId: string,
    runId: string,
    input: JsonValue,
    commandId?: string
  ): void {
    thread.itemList.append({
      type: 'turn.queued',
      runId,
      turnId,
      visibility: 'trace',
      payload: { input, ...(commandId ? { commandId } : {}) },
    });
  }

  private abandonPendingTurns(): void {
    for (const abandon of [...this.pendingTurnActivations]) abandon();
  }

  private scheduleTurn(
    thread: ThreadState,
    turnId: string,
    input: TurnStartInput,
    activation: Promise<boolean>
  ): Promise<TurnSnapshot> {
    const previous = this.turnTails.get(thread.id) ?? Promise.resolve();
    const result = previous.then(async () => {
      if (!(await activation) || this.fenced) return this.getTurnSnapshot(thread, turnId);
      return await this.runTurn(thread, turnId, input);
    });
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
    if (isTerminalTurnStatus(existing.status)) return existing;
    if (this.closing) {
      return isTerminalTurnStatus(existing.status)
        ? existing
        : await this.cancelTurn(thread, existing);
    }
    const controller = new AbortController();

    this.activeTurns.set(thread.id, { turnId, controller });

    let lease: { settle(turn: TurnSnapshot): Promise<void> } | undefined;
    try {
      lease = await this.acquireExecutionLease?.({
        threadId: thread.id,
        turnId,
        signal: controller.signal,
      });
      const turn = this.getTurnSnapshot(thread, turnId);
      const runtime = this.runtimeFactory({
        thread: toThreadRecord(thread),
        turn,
        approvalBroker: this.approvalBroker,
      });
      const loop = new AgentLoop(
        createAgentLoopOptions(thread, runtime, (item) => this.appendItem(thread, item))
      );
      const result = await loop.run({
        threadId: thread.id,
        input: input.input,
        runId: turn.runId,
        turnId: turn.id,
        modelOptions: input.modelOptions,
        signal: controller.signal,
      });

      const terminal = this.getTurnSnapshot(thread, turn.id);

      if (result.yielded && terminal.status === 'waiting') {
        this.emit({
          type: 'turn/completed',
          threadId: thread.id,
          turn: terminal,
        });
        return terminal;
      }

      if (terminal.status === 'completed') {
        this.emit({
          type: 'turn/completed',
          threadId: thread.id,
          turn: terminal,
        });

        return terminal;
      }

      if (controller.signal.aborted) {
        return await this.cancelTurn(thread, turn);
      }

      const failureItem = result.items.find(
        (item) =>
          item.turnId === turn.id &&
          (item.type === 'assistant.message.error' || item.type === 'tool.error')
      );

      if (failureItem) {
        return await this.failTurn(thread, turn, {
          code: 'TURN_FAILED',
          message: readFailureMessage(failureItem.payload),
          details: toProtocolItem(failureItem).payload,
        });
      }

      return await this.failTurn(thread, turn, {
        code: 'TURN_FAILED',
        message: 'Turn ended without a terminal lifecycle item',
      });
    } catch (cause) {
      const turn = this.getTurnSnapshot(thread, turnId);

      if (this.fenced) {
        return turn;
      }

      if (isTerminalTurnStatus(turn.status)) {
        throw cause;
      }

      if (controller.signal.aborted) {
        return await this.cancelTurn(thread, turn);
      }

      return await this.failTurn(thread, turn, {
        code: 'TURN_FAILED',
        message: readErrorMessage(cause),
        details: serializeError(cause),
      });
    } finally {
      if (lease) await lease.settle(this.getTurnSnapshot(thread, turnId));
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
        generateId: createUniqueIdGenerator(this.generateItemId, existingItemIds),
        clock: this.clock,
        initialItems: snapshot.items.map((item) => ({ ...item })),
      }),
    };

    return thread;
  }

  private repairStaleTurns(thread: ThreadState): void {
    const error = {
      code: STALE_TURN_REPAIR_CODE,
      message: STALE_TURN_REPAIR_MESSAGE,
    };

    for (const turn of this.snapshotThread(thread).turns) {
      if (turn.status !== 'inProgress') continue;

      thread.itemList.append({
        type: 'turn.repaired',
        runId: turn.runId,
        turnId: turn.id,
        visibility: 'trace',
        payload: {
          previousStatus: turn.status,
          status: 'failed',
          reason: STALE_TURN_REPAIR_MESSAGE,
          error,
        },
      });
    }
  }

  private attachItemObserver(thread: ThreadState): void {
    thread.itemList.observe((item) => {
      if (item.visibility === 'internal') {
        return;
      }

      this.emit({
        type: 'item/appended',
        threadId: thread.id,
        turnId: item.turnId,
        item: toProtocolItem(item),
      });

      if (item.type === 'turn.started') {
        this.emit({
          type: 'turn/started',
          threadId: thread.id,
          turn: this.getTurnSnapshot(thread, item.turnId),
        });
      }

      if (item.type === 'approval.requested') {
        const approvalId = readStringPayloadField(item.payload, 'approvalId');
        if (approvalId)
          this.emit({
            type: 'approval/requested',
            threadId: thread.id,
            turnId: item.turnId,
            approvalId,
            item: toProtocolItem(item),
          });
      }
      if (item.type === 'approval.resolved') {
        const approvalId = readStringPayloadField(item.payload, 'approvalId');
        const decision = readApprovalDecision(item.payload);
        if (approvalId && decision)
          this.emit({
            type: 'approval/resolved',
            threadId: thread.id,
            turnId: item.turnId,
            approvalId,
            decision,
            item: toProtocolItem(item),
          });
      }
    });
  }

  private snapshotThread(thread: ThreadState): ThreadSnapshot {
    return toThreadSnapshot({
      threadId: thread.id,
      items: thread.itemList.getItems(),
    });
  }

  private getTurnSnapshot(thread: ThreadState, turnId: string): TurnSnapshot {
    const turn = this.snapshotThread(thread).turns.find((entry) => entry.id === turnId);

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

  private async failTurn(
    thread: ThreadState,
    turn: TurnSnapshot,
    error: AppServerError
  ): Promise<TurnSnapshot> {
    const terminal = await this.appendTerminalItem(thread, turn, {
      type: 'turn.failed',
      runId: turn.runId,
      turnId: turn.id,
      visibility: 'trace',
      payload: {
        status: 'failed',
        error: error.details ?? { code: error.code, message: error.message },
      },
    });

    if (!terminal.appended) {
      return terminal.turn;
    }

    this.emit({
      type: 'turn/failed',
      threadId: thread.id,
      turn: terminal.turn,
      error,
    });

    return terminal.turn;
  }

  private async cancelTurn(thread: ThreadState, turn: TurnSnapshot): Promise<TurnSnapshot> {
    const error = { code: 'TURN_INTERRUPTED', message: 'Turn interrupted' };

    const terminal = await this.appendTerminalItem(thread, turn, {
      type: 'turn.canceled',
      runId: turn.runId,
      turnId: turn.id,
      visibility: 'trace',
      payload: { status: 'canceled', error },
    });

    if (!terminal.appended) {
      return terminal.turn;
    }

    this.emit({
      type: 'turn/completed',
      threadId: thread.id,
      turn: terminal.turn,
    });

    return terminal.turn;
  }

  private async appendTerminalItem(
    thread: ThreadState,
    turn: TurnSnapshot,
    item: ItemAppendInput
  ): Promise<{ readonly turn: TurnSnapshot; readonly appended: boolean }> {
    const current = this.getTurnSnapshot(thread, turn.id);

    if (isTerminalTurnStatus(current.status)) {
      return { turn: current, appended: false };
    }

    await this.appendItem(thread, item);

    return {
      turn: this.getTurnSnapshot(thread, turn.id),
      appended: true,
    };
  }

  private async appendItem(thread: ThreadState, input: ItemAppendInput): Promise<Item> {
    const item = thread.itemList.append(input);
    await this.itemCommitBarrier?.(thread.id, item);
    return item;
  }
}

function collectRejected(
  results: readonly PromiseSettledResult<unknown>[],
  failures: unknown[]
): void {
  for (const result of results) {
    if (result.status === 'rejected') failures.push(...flattenAggregateError(result.reason));
  }
}

function flattenAggregateError(cause: unknown): readonly unknown[] {
  if (!(cause instanceof AggregateError)) return [cause];
  return cause.errors.flatMap((nested) => flattenAggregateError(nested));
}

function readStringPayloadField(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null || !(key in payload)) return undefined;
  const value = (payload as Readonly<Record<string, unknown>>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readApprovalDecision(payload: unknown): 'approveOnce' | 'decline' | undefined {
  const decision = readStringPayloadField(payload, 'decision');
  return decision === 'approveOnce' || decision === 'decline' ? decision : undefined;
}

function toThreadRecord(thread: ThreadState): ThreadRecord {
  const snapshot = toThreadSnapshot({
    threadId: thread.id,
    items: thread.itemList.getItems(),
  });

  return {
    id: snapshot.id,
    status: snapshot.status,
    turns: snapshot.turns,
    items: thread.itemList.getItems(),
  };
}

function latestRecoverableTurn(turns: readonly TurnSnapshot[]): TurnSnapshot | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];

    if (turn && isRecoverableTurnStatus(turn.status)) {
      return turn;
    }
  }

  return undefined;
}

function isRecoverableTurnStatus(status: TurnStatus): boolean {
  return status === 'failed' || status === 'canceled';
}

function isTerminalTurnStatus(status: TurnStatus): boolean {
  return (
    status === 'waiting' || status === 'completed' || status === 'failed' || status === 'canceled'
  );
}

function readUserInputForTurn(thread: ThreadState, turn: TurnSnapshot): JsonValue {
  const items = thread.itemList.getItems();
  const userItem = items.find(
    (item) => item.turnId === turn.id && item.type === 'user.message.completed'
  );
  const queuedItem = items.find((item) => item.turnId === turn.id && item.type === 'turn.queued');
  const input = userItem
    ? readObjectProperty(userItem.payload, 'content')
    : readObjectProperty(queuedItem?.payload, 'input');

  if (!isJsonValue(input)) {
    throw new Error(`Cannot retry turn without JSON user input: ${turn.id}`);
  }

  return input;
}

function readObjectProperty(payload: unknown, key: string): unknown {
  if (typeof payload === 'object' && payload !== null && key in payload) {
    return payload[key as keyof typeof payload];
  }

  return undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return typeof value === 'object' && value !== null && Object.values(value).every(isJsonValue);
}

function createAgentLoopOptions(
  thread: ThreadState,
  runtime: ThreadRuntime,
  appendItem: NonNullable<AgentLoopOptions['appendItem']>
): AgentLoopOptions {
  return {
    itemList: thread.itemList,
    appendItem,
    model: runtime.model,
    toolRuntime: runtime.toolRuntime,
    contextCompiler: runtime.contextCompiler,
    systemPrompt: runtime.systemPrompt,
  };
}

function createDefaultRuntime(): ThreadRuntime {
  return {
    model: {
      async *generate() {
        yield {
          type: 'message.completed' as const,
          content: 'Fake response',
        };
      },
    },
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

function generateUniqueId(generateId: IdGenerator, existingIds: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const id = generateId();

    if (!existingIds.has(id)) {
      return id;
    }
  }

  throw new Error('Unable to generate a unique id');
}

function readFailureMessage(payload: unknown): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'message' in payload &&
    typeof payload.message === 'string'
  ) {
    return payload.message;
  }

  return 'Turn failed';
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
    typeof cause === 'string' ||
    typeof cause === 'number' ||
    typeof cause === 'boolean'
  ) {
    return cause;
  }

  return String(cause);
}
