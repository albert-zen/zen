import type {
  AgentAppNotification,
  ApprovalDecision,
  JsonObject,
  ProtocolItem,
  ThreadSnapshot,
} from '../product/index.js';

export type WebUiState = {
  readonly currentThread?: {
    readonly id: string;
    readonly status: ThreadSnapshot['status'];
    readonly turns: ThreadSnapshot['turns'];
  };
  readonly items: ReadonlyInteractionSequence<ProtocolItem>;
  readonly timelineRows: ReadonlyInteractionSequence<TimelineRow>;
};

export type ReadonlyInteractionSequence<T> = Iterable<T> & {
  readonly length: number;
  at(index: number): T | undefined;
  find<S extends T>(predicate: (value: T, index: number) => value is S): S | undefined;
  find(predicate: (value: T, index: number) => boolean): T | undefined;
  map<U>(callback: (value: T, index: number) => U): U[];
  filter<S extends T>(predicate: (value: T, index: number) => value is S): S[];
  filter(predicate: (value: T, index: number) => boolean): T[];
  reduce<U>(callback: (accumulator: U, value: T, index: number) => U, initial: U): U;
};

type SequenceOperation<T> =
  | { readonly type: 'append'; readonly slot: number; readonly value: T }
  | { readonly type: 'replace'; readonly slot: number; readonly value: T }
  | { readonly type: 'remove'; readonly slot: number };

/** Immutable version view backed by an append/patch log. */
class InteractionSequence<T> implements ReadonlyInteractionSequence<T> {
  private constructor(
    private readonly base: readonly T[],
    private readonly parent: InteractionSequence<T> | undefined,
    private readonly operation: SequenceOperation<T> | undefined,
    private readonly metrics: SequenceMetrics,
    readonly slots: number,
    readonly length: number
  ) {}

  static empty<T>(metrics: SequenceMetrics): InteractionSequence<T> {
    return new InteractionSequence([], undefined, undefined, metrics, 0, 0);
  }

  static from<T>(values: Iterable<T>, metrics: SequenceMetrics): InteractionSequence<T> {
    const base = [...values];
    metrics.sequenceCopies += 1;
    return new InteractionSequence(base, undefined, undefined, metrics, base.length, base.length);
  }

  append(value: T): InteractionSequence<T> {
    return new InteractionSequence(
      this.base,
      this,
      { type: 'append', slot: this.slots, value },
      this.metrics,
      this.slots + 1,
      this.length + 1
    );
  }

  replace(slot: number, value: T): InteractionSequence<T> {
    return new InteractionSequence(
      this.base,
      this,
      { type: 'replace', slot, value },
      this.metrics,
      this.slots,
      this.length
    );
  }

  remove(slot: number): InteractionSequence<T> {
    return new InteractionSequence(
      this.base,
      this,
      { type: 'remove', slot },
      this.metrics,
      this.slots,
      this.length - 1
    );
  }

  at(index: number): T | undefined {
    return this.materialize()[index];
  }

  find<S extends T>(predicate: (value: T, index: number) => value is S): S | undefined;
  find(predicate: (value: T, index: number) => boolean): T | undefined;
  find(predicate: (value: T, index: number) => boolean): T | undefined {
    return this.materialize().find(predicate);
  }

  map<U>(callback: (value: T, index: number) => U): U[] {
    return this.materialize().map(callback);
  }

  filter<S extends T>(predicate: (value: T, index: number) => value is S): S[];
  filter(predicate: (value: T, index: number) => boolean): T[];
  filter(predicate: (value: T, index: number) => boolean): T[] {
    return this.materialize().filter(predicate);
  }

  reduce<U>(callback: (accumulator: U, value: T, index: number) => U, initial: U): U {
    return this.materialize().reduce(callback, initial);
  }

  [Symbol.iterator](): Iterator<T> {
    return this.materialize()[Symbol.iterator]();
  }

  private materialize(): T[] {
    this.metrics.fullMaterializations += 1;
    this.metrics.sequenceTraversals += 1;
    const operations: SequenceOperation<T>[] = [];
    if (this.operation) operations.push(this.operation);
    let cursor = this.parent;
    while (cursor?.parent) {
      this.metrics.sequenceTraversals += 1;
      if (cursor.operation) operations.push(cursor.operation);
      cursor = cursor.parent;
    }
    this.metrics.sequenceCopies += 1;
    const slots = [...(cursor?.base ?? this.base)];
    for (const operation of operations.reverse()) {
      if (operation.type === 'append') slots.push(operation.value);
      if (operation.type === 'replace') slots[operation.slot] = operation.value;
      if (operation.type === 'remove') slots[operation.slot] = undefined as T;
    }
    return slots.filter((value): value is T => value !== undefined);
  }
}

type SequenceMetrics = {
  fullMaterializations: number;
  sequenceCopies: number;
  sequenceTraversals: number;
};

export type TimelineRow =
  | UserTimelineRow
  | AssistantTimelineRow
  | AssistantProgressTimelineRow
  | ShellTimelineRow
  | ToolCallTimelineRow
  | ToolResultTimelineRow
  | ToolErrorTimelineRow
  | ApprovalPendingTimelineRow
  | ApprovalResolvedTimelineRow
  | TraceTimelineRow;

export type UserTimelineRow = {
  readonly type: 'user';
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly content?: unknown;
};

export type AssistantTimelineRow = {
  readonly type: 'assistant';
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly content?: unknown;
};

export type AssistantProgressTimelineRow = {
  readonly type: 'assistant-progress';
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly content: string;
};

export type TraceTimelineRow = {
  readonly type: 'trace';
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly event: string;
};

export type ShellTimelineRow = {
  readonly type: 'shell';
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly toolCallId?: string;
  readonly command: string;
  readonly status: 'running' | 'completed' | 'failed' | 'interrupted';
  readonly exitCode?: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
};

export type ToolCallTimelineRow = {
  readonly type: 'tool-call';
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly input?: unknown;
};

export type ToolResultTimelineRow = {
  readonly type: 'tool-result';
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly content?: unknown;
};

export type ToolErrorTimelineRow = {
  readonly type: 'tool-error';
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly message?: string;
};

export type ApprovalPendingTimelineRow = {
  readonly type: 'approval-pending';
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly approvalId: string;
  readonly threadId: string;
  readonly toolCallId?: string;
  readonly reason?: string;
};

export type ApprovalResolvedTimelineRow = {
  readonly type: 'approval-resolved';
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly approvalId?: string;
  readonly decision?: ApprovalDecision;
};

export type InteractionProjectionListener = () => void;

export type InteractionProjectionWork = {
  readonly fastPathOperations: number;
  readonly rebuilds: number;
  readonly sequenceCopies: number;
  readonly fullMaterializations: number;
  readonly sequenceTraversals: number;
  readonly mapClones: number;
  readonly indexRebuilds: number;
};

/**
 * The single interaction projection for presentation clients. Ordered facts update
 * their indexed row directly; replacements and out-of-order facts deliberately
 * take the deterministic rebuild path.
 */
export class InteractionProjection {
  private readonly sequenceMetrics: SequenceMetrics = {
    fullMaterializations: 0,
    sequenceCopies: 0,
    sequenceTraversals: 0,
  };
  private readonly listeners = new Set<InteractionProjectionListener>();
  private itemsById = new Map<string, ProtocolItem>();
  private orderedItems = InteractionSequence.empty<ProtocolItem>(this.sequenceMetrics);
  private rows = InteractionSequence.empty<TimelineRow>(this.sequenceMetrics);
  private rowSlotByKey = new Map<string, number>();
  private currentRowsBySlot = new Map<number, TimelineRow>();
  private shellRowKeyByTarget = new Map<string, string>();
  private assistantStarted = new Set<string>();
  private assistantProgress = new Map<string, string>();
  private approvalRowKeyById = new Map<string, string>();
  private lastSeq = -Infinity;
  private fastPathOperations = 0;
  private rebuilds = 0;
  private mapClones = 0;
  private indexRebuilds = 0;
  private snapshot: WebUiState = {
    items: InteractionSequence.empty<ProtocolItem>(this.sequenceMetrics),
    timelineRows: InteractionSequence.empty<TimelineRow>(this.sequenceMetrics),
  };

  constructor(snapshot?: ThreadSnapshot) {
    if (snapshot) {
      this.replaceSnapshot(snapshot, false);
    }
  }

  getSnapshot(): WebUiState {
    return this.snapshot;
  }

  subscribe(listener: InteractionProjectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Narrow deterministic seam for append-complexity regression tests. */
  getWork(): InteractionProjectionWork {
    return {
      fastPathOperations: this.fastPathOperations,
      rebuilds: this.rebuilds,
      sequenceCopies: this.sequenceMetrics.sequenceCopies,
      fullMaterializations: this.sequenceMetrics.fullMaterializations,
      sequenceTraversals: this.sequenceMetrics.sequenceTraversals,
      mapClones: this.mapClones,
      indexRebuilds: this.indexRebuilds,
    };
  }

  replaceSnapshot(snapshot: ThreadSnapshot, notify = true): boolean {
    return this.replaceState(createStateFromSnapshot(snapshot, this.sequenceMetrics), notify);
  }

  private clearSnapshot(): boolean {
    return this.replaceState(createStateFromParts(undefined, [], this.sequenceMetrics));
  }

  private replaceState(next: WebUiState, notify = true): boolean {
    if (sameState(this.snapshot, next)) {
      return false;
    }
    this.resetIndexes(next);
    this.publish(next, notify);
    return true;
  }

  apply(notification: AgentAppNotification): boolean {
    if (notification.type === 'sync/reset') {
      const currentThreadId = this.snapshot.currentThread?.id;
      const thread = currentThreadId
        ? notification.threads.find((candidate) => candidate.id === currentThreadId)
        : notification.threads[0];
      return thread ? this.replaceSnapshot(thread) : this.clearSnapshot();
    }
    if (notification.type === 'thread/started') {
      return this.replaceSnapshot(notification.thread);
    }

    if (isTurnNotification(notification)) {
      if (!isForCurrentThread(this.snapshot, notification.threadId)) return false;
      return this.updateTurn(notification.threadId, notification.turn);
    }

    const item =
      notification.type === 'item/appended' || notification.type === 'approval/requested'
        ? notification.item
        : notification.type === 'approval/resolved'
          ? notification.item
          : undefined;
    const threadId = 'threadId' in notification ? notification.threadId : undefined;
    if (!item || !threadId || !isForCurrentThread(this.snapshot, threadId)) return false;

    const existing = this.itemsById.get(item.id);
    if (existing && sameItem(existing, item)) return false;
    if (existing || item.seq <= this.lastSeq) {
      return this.rebuildWithItem(item);
    }
    return this.appendOrdered(item);
  }

  private appendOrdered(item: ProtocolItem): boolean {
    this.itemsById.set(item.id, item);
    this.orderedItems = this.orderedItems.append(item);
    this.lastSeq = item.seq;
    this.applyItemRow(item);
    this.fastPathOperations += 1;
    this.publish(this.nextSnapshot());
    return true;
  }

  private rebuildWithItem(item: ProtocolItem): boolean {
    const items = new Map(this.itemsById);
    this.mapClones += 1;
    items.set(item.id, item);
    const next = createStateFromParts(
      this.snapshot.currentThread,
      [...items.values()],
      this.sequenceMetrics
    );
    this.resetIndexes(next);
    this.rebuilds += 1;
    this.publish(next);
    return true;
  }

  private updateTurn(threadId: string, turn: ThreadSnapshot['turns'][number]): boolean {
    const current = this.snapshot.currentThread ?? {
      id: threadId,
      status: 'idle' as const,
      turns: [],
    };
    const index = current.turns.findIndex((entry) => entry.id === turn.id);
    const turns =
      index < 0
        ? [...current.turns, cloneTurn(turn)]
        : current.turns.map((entry, position) => (position === index ? cloneTurn(turn) : entry));
    const next = {
      ...this.snapshot,
      currentThread: { id: current.id, status: deriveThreadStatus(turns), turns },
    };
    if (sameState(this.snapshot, next)) return false;
    this.publish(next);
    return true;
  }

  private applyItemRow(item: ProtocolItem): void {
    if (item.type === 'assistant.message.started') {
      this.assistantStarted.add(item.id);
      return;
    }
    if (
      item.type === 'assistant.message.delta' &&
      item.targetId &&
      this.assistantStarted.has(item.targetId)
    ) {
      const content = `${this.assistantProgress.get(item.targetId) ?? ''}${readStringPayloadField(item.payload, 'delta')}`;
      this.assistantProgress.set(item.targetId, content);
      const started = this.itemsById.get(item.targetId);
      if (started)
        this.upsertRow(`assistant:${item.targetId}`, {
          type: 'assistant-progress',
          itemId: item.targetId,
          seq: started.seq,
          turnId: started.turnId,
          content,
        });
      return;
    }
    if (item.type === 'assistant.message.completed' && item.targetId) {
      this.removeRow(`assistant:${item.targetId}`);
      this.assistantProgress.delete(item.targetId);
    }
    if (
      item.type === 'tool.call.started' &&
      readStringPayloadField(item.payload, 'toolName') === 'shell'
    ) {
      const key = `shell:${item.id}`;
      this.shellRowKeyByTarget.set(item.id, key);
      this.upsertRow(key, {
        type: 'shell',
        itemId: item.id,
        seq: item.seq,
        turnId: item.turnId,
        toolCallId: readOptionalStringPayloadField(item.payload, 'toolCallId'),
        command: readCommand(readPayloadField(item.payload, 'input')),
        status: 'running',
        stdout: '',
        stderr: '',
      });
      return;
    }
    if (item.targetId && this.shellRowKeyByTarget.has(item.targetId) && isShellChildType(item)) {
      this.updateShellRow(item);
      return;
    }
    const approvalType = readApprovalEventType(item);
    if (approvalType === 'approval.requested') {
      const approvalId = readStringPayloadField(readApprovalPayload(item), 'approvalId');
      const key = `approval:${approvalId}`;
      this.approvalRowKeyById.set(approvalId, key);
      this.upsertRow(key, toTimelineRow(item));
      return;
    }
    if (approvalType === 'approval.resolved') {
      this.removeRow(
        this.approvalRowKeyById.get(
          readStringPayloadField(readApprovalPayload(item), 'approvalId')
        ) ?? ''
      );
    }
    if (item.type !== 'system.message.completed' && item.type !== 'assistant.message.delta')
      this.upsertRow(`item:${item.id}`, toTimelineRow(item));
  }

  private updateShellRow(item: ProtocolItem): void {
    const key = this.shellRowKeyByTarget.get(item.targetId as string);
    const slot = key === undefined ? undefined : this.rowSlotByKey.get(key);
    const current =
      slot === undefined
        ? undefined
        : (this.currentRowsBySlot.get(slot) as ShellTimelineRow | undefined);
    if (key === undefined || slot === undefined || !current) return;
    let next = current;
    if (item.type === 'tool.output.delta') {
      const delta = readShellOutputDelta(item.payload);
      if (delta)
        next = {
          ...current,
          stdout: delta.stream === 'stdout' ? current.stdout + delta.chunk : current.stdout,
          stderr: delta.stream === 'stderr' ? current.stderr + delta.chunk : current.stderr,
        };
    } else if (item.type === 'tool.result.completed') {
      const result = parseShellResult(readPayloadField(item.payload, 'content'));
      next = {
        ...current,
        status: result.exitCode !== undefined && result.exitCode !== 0 ? 'failed' : 'completed',
        exitCode: result.exitCode,
        stdout: result.stdout ?? current.stdout,
        stderr: result.stderr ?? current.stderr,
      };
    } else if (item.type === 'tool.error') {
      const error = readOptionalStringPayloadField(item.payload, 'message') ?? 'failed';
      next = {
        ...current,
        status: isInterruptedShellMessage(error) ? 'interrupted' : 'failed',
        error,
      };
    }
    this.upsertRow(key, next);
  }

  private upsertRow(key: string, row: TimelineRow): void {
    const slot = this.rowSlotByKey.get(key);
    if (slot === undefined) {
      const nextSlot = this.rows.slots;
      this.rowSlotByKey.set(key, nextSlot);
      this.currentRowsBySlot.set(nextSlot, row);
      this.rows = this.rows.append(row);
      return;
    }
    this.currentRowsBySlot.set(slot, row);
    this.rows = this.rows.replace(slot, row);
  }

  private removeRow(key: string): void {
    const slot = this.rowSlotByKey.get(key);
    if (slot === undefined) return;
    this.rows = this.rows.remove(slot);
    this.currentRowsBySlot.delete(slot);
    this.rowSlotByKey.delete(key);
  }

  private nextSnapshot(): WebUiState {
    return { ...this.snapshot, items: this.orderedItems, timelineRows: this.rows };
  }

  private resetIndexes(state: WebUiState): void {
    this.indexRebuilds += 1;
    this.snapshot = state;
    this.itemsById = new Map(state.items.map((item) => [item.id, item]));
    this.orderedItems = InteractionSequence.from(state.items, this.sequenceMetrics);
    this.rows = InteractionSequence.from(state.timelineRows, this.sequenceMetrics);
    this.rowSlotByKey = new Map([...this.rows].map((row, index) => [rowKey(row), index]));
    this.currentRowsBySlot = new Map([...this.rows].map((row, index) => [index, row]));
    this.shellRowKeyByTarget = new Map(
      this.rows
        .filter((row): row is ShellTimelineRow => row.type === 'shell')
        .map((row) => [row.itemId, rowKey(row)])
    );
    this.assistantStarted = new Set(
      state.items.filter((item) => item.type === 'assistant.message.started').map((item) => item.id)
    );
    this.assistantProgress = new Map(
      this.rows
        .filter((row): row is AssistantProgressTimelineRow => row.type === 'assistant-progress')
        .map((row) => [row.itemId, row.content])
    );
    this.approvalRowKeyById = new Map(
      this.rows
        .filter((row): row is ApprovalPendingTimelineRow => row.type === 'approval-pending')
        .map((row) => [row.approvalId, rowKey(row)])
    );
    this.lastSeq = state.items.at(-1)?.seq ?? -Infinity;
  }

  private publish(snapshot: WebUiState, notify = true): void {
    this.snapshot = snapshot;
    if (notify) this.listeners.forEach((listener) => listener());
  }
}

const projections = new WeakMap<WebUiState, InteractionProjection>();

export function createWebUiState(snapshot?: ThreadSnapshot): WebUiState {
  const projection = new InteractionProjection(snapshot);
  const state = projection.getSnapshot();
  projections.set(state, projection);
  return state;
}

export function applyAppServerNotification(
  state: WebUiState,
  notification: AgentAppNotification
): WebUiState {
  const projection = projections.get(state) ?? new InteractionProjection(toSnapshot(state));
  projection.apply(notification);
  const next = projection.getSnapshot();
  projections.set(next, projection);
  return next;
}

function isForCurrentThread(state: WebUiState, threadId: string): boolean {
  return !state.currentThread || state.currentThread.id === threadId;
}

function isTurnNotification(
  notification: AgentAppNotification
): notification is Extract<
  AgentAppNotification,
  { readonly type: 'turn/started' | 'turn/completed' | 'turn/failed' }
> {
  return (
    notification.type === 'turn/started' ||
    notification.type === 'turn/completed' ||
    notification.type === 'turn/failed'
  );
}

function createStateFromSnapshot(snapshot: ThreadSnapshot, metrics: SequenceMetrics): WebUiState {
  return createStateFromParts(
    { id: snapshot.id, status: snapshot.status, turns: snapshot.turns.map(cloneTurn) },
    snapshot.items,
    metrics
  );
}

function createStateFromParts(
  currentThread: WebUiState['currentThread'],
  items: readonly ProtocolItem[],
  metrics: SequenceMetrics
): WebUiState {
  const sortedItems = [...items].sort(compareItems);
  return {
    currentThread,
    items: InteractionSequence.from(sortedItems, metrics),
    timelineRows: InteractionSequence.from(buildTimelineRows(sortedItems), metrics),
  };
}

function toSnapshot(state: WebUiState): ThreadSnapshot | undefined {
  return state.currentThread
    ? {
        id: state.currentThread.id,
        status: state.currentThread.status,
        turns: state.currentThread.turns,
        items: [...state.items],
      }
    : undefined;
}

function rowKey(row: TimelineRow): string {
  if (row.type === 'assistant-progress') return `assistant:${row.itemId}`;
  if (row.type === 'shell') return `shell:${row.itemId}`;
  if (row.type === 'approval-pending') return `approval:${row.approvalId}`;
  return `item:${row.itemId}`;
}

function sameItem(left: ProtocolItem, right: ProtocolItem): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function sameState(left: WebUiState, right: WebUiState): boolean {
  return (
    left === right ||
    (left.currentThread?.id === right.currentThread?.id &&
      JSON.stringify(left.currentThread) === JSON.stringify(right.currentThread) &&
      JSON.stringify([...left.items]) === JSON.stringify([...right.items]))
  );
}

function cloneTurn(turn: ThreadSnapshot['turns'][number]): ThreadSnapshot['turns'][number] {
  return {
    ...turn,
    itemIds: [...turn.itemIds],
  };
}

function deriveThreadStatus(
  turns: readonly ThreadSnapshot['turns'][number][]
): ThreadSnapshot['status'] {
  if (turns.some((turn) => turn.status === 'queued' || turn.status === 'inProgress')) {
    return 'running';
  }

  if (turns.at(-1)?.status === 'failed') {
    return 'failed';
  }

  return 'idle';
}

function compareItems(left: ProtocolItem, right: ProtocolItem): number {
  return left.seq - right.seq || left.createdAtMs - right.createdAtMs;
}

function buildTimelineRows(items: readonly ProtocolItem[]): readonly TimelineRow[] {
  const sortedItems = [...items].sort(compareItems);
  const shellRows = buildShellRows(sortedItems);
  const assistantCompletedTargets = new Set(
    sortedItems
      .filter((item) => item.type === 'assistant.message.completed')
      .map((item) => item.targetId)
      .filter((targetId): targetId is string => Boolean(targetId))
  );
  const assistantDeltaTextByTarget = new Map<string, string>();
  const resolvedApprovalIds = new Set(
    sortedItems
      .filter((item) => readApprovalEventType(item) === 'approval.resolved')
      .map((item) => readStringPayloadField(readApprovalPayload(item), 'approvalId'))
      .filter((approvalId) => approvalId.length > 0)
  );

  for (const item of sortedItems) {
    if (item.type !== 'assistant.message.delta' || !item.targetId) {
      continue;
    }

    assistantDeltaTextByTarget.set(
      item.targetId,
      `${assistantDeltaTextByTarget.get(item.targetId) ?? ''}${readStringPayloadField(
        item.payload,
        'delta'
      )}`
    );
  }

  return sortedItems.flatMap((item): TimelineRow[] => {
    if (item.type === 'system.message.completed') {
      return [];
    }

    const shellRow = shellRows.get(item.id);

    if (shellRow) {
      return [shellRow];
    }

    if (isShellChildItem(item, shellRows)) {
      return [];
    }

    if (item.type === 'assistant.message.started' && !assistantCompletedTargets.has(item.id)) {
      const progress = assistantDeltaTextByTarget.get(item.id);

      if (progress) {
        return [
          {
            type: 'assistant-progress',
            itemId: item.id,
            seq: item.seq,
            turnId: item.turnId,
            content: progress,
          },
        ];
      }
    }

    if (item.type === 'assistant.message.delta') {
      return [];
    }

    if (
      readApprovalEventType(item) === 'approval.requested' &&
      resolvedApprovalIds.has(readStringPayloadField(readApprovalPayload(item), 'approvalId'))
    ) {
      return [];
    }

    return [toTimelineRow(item)];
  });
}

function buildShellRows(
  sortedItems: readonly ProtocolItem[]
): ReadonlyMap<string, ShellTimelineRow> {
  const rows = new Map<string, ShellTimelineRow>();

  for (const item of sortedItems) {
    if (
      item.type !== 'tool.call.started' ||
      readStringPayloadField(item.payload, 'toolName') !== 'shell'
    ) {
      continue;
    }

    rows.set(item.id, {
      type: 'shell',
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      toolCallId: readOptionalStringPayloadField(item.payload, 'toolCallId'),
      command: readCommand(readPayloadField(item.payload, 'input')),
      status: 'running',
      stdout: '',
      stderr: '',
    });
  }

  for (const item of sortedItems) {
    const targetId = item.targetId;

    if (!targetId) {
      continue;
    }

    const existing = rows.get(targetId);

    if (!existing) {
      continue;
    }

    if (item.type === 'tool.output.delta') {
      const delta = readShellOutputDelta(item.payload);

      if (!delta) {
        continue;
      }

      rows.set(targetId, {
        ...existing,
        stdout: delta.stream === 'stdout' ? `${existing.stdout}${delta.chunk}` : existing.stdout,
        stderr: delta.stream === 'stderr' ? `${existing.stderr}${delta.chunk}` : existing.stderr,
      });
    }

    if (item.type === 'tool.result.completed') {
      const result = parseShellResult(readPayloadField(item.payload, 'content'));

      rows.set(targetId, {
        ...existing,
        status: result.exitCode !== undefined && result.exitCode !== 0 ? 'failed' : 'completed',
        exitCode: result.exitCode,
        stdout: result.stdout ?? existing.stdout,
        stderr: result.stderr ?? existing.stderr,
      });
    }

    if (item.type === 'tool.error') {
      const message = readOptionalStringPayloadField(item.payload, 'message') ?? 'failed';

      rows.set(targetId, {
        ...existing,
        status: isInterruptedShellMessage(message) ? 'interrupted' : 'failed',
        error: message,
      });
    }
  }

  return rows;
}

function isShellChildItem(
  item: ProtocolItem,
  shellRows: ReadonlyMap<string, ShellTimelineRow>
): boolean {
  if (readApprovalEventType(item)) {
    return false;
  }

  return (
    Boolean(item.targetId && shellRows.has(item.targetId)) &&
    (item.type === 'tool.output.delta' ||
      item.type === 'tool.result.completed' ||
      item.type === 'tool.error')
  );
}

function isShellChildType(item: ProtocolItem): boolean {
  return (
    !readApprovalEventType(item) &&
    (item.type === 'tool.output.delta' ||
      item.type === 'tool.result.completed' ||
      item.type === 'tool.error')
  );
}

function toTimelineRow(item: ProtocolItem): TimelineRow {
  if (item.type === 'user.message.completed') {
    return {
      type: 'user',
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      content: readPayloadField(item.payload, 'content'),
    };
  }

  if (item.type === 'assistant.message.completed') {
    return {
      type: 'assistant',
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      content: readPayloadField(item.payload, 'content'),
    };
  }

  if (item.type === 'tool.call.started') {
    return {
      type: 'tool-call',
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      toolCallId: readOptionalStringPayloadField(item.payload, 'toolCallId'),
      toolName: readOptionalStringPayloadField(item.payload, 'toolName'),
      input: readPayloadField(item.payload, 'input'),
    };
  }

  if (item.type === 'tool.result.completed') {
    return {
      type: 'tool-result',
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      toolCallId: readOptionalStringPayloadField(item.payload, 'toolCallId'),
      toolName: readOptionalStringPayloadField(item.payload, 'toolName'),
      content: readPayloadField(item.payload, 'content'),
    };
  }

  if (item.type === 'tool.error') {
    return {
      type: 'tool-error',
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      toolCallId: readOptionalStringPayloadField(item.payload, 'toolCallId'),
      toolName: readOptionalStringPayloadField(item.payload, 'toolName'),
      message: readOptionalStringPayloadField(item.payload, 'message'),
    };
  }

  if (readApprovalEventType(item) === 'approval.requested') {
    const approvalPayload = readApprovalPayload(item);

    return {
      type: 'approval-pending',
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      approvalId: readStringPayloadField(approvalPayload, 'approvalId'),
      threadId: readStringPayloadField(approvalPayload, 'threadId') || item.turnId,
      toolCallId: readOptionalStringPayloadField(approvalPayload, 'toolCallId'),
      reason: readOptionalStringPayloadField(approvalPayload, 'reason'),
    };
  }

  if (readApprovalEventType(item) === 'approval.resolved') {
    const approvalPayload = readApprovalPayload(item);

    return {
      type: 'approval-resolved',
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      approvalId: readOptionalStringPayloadField(approvalPayload, 'approvalId'),
      decision: readApprovalDecision(approvalPayload),
    };
  }

  return {
    type: 'trace',
    itemId: item.id,
    seq: item.seq,
    turnId: item.turnId,
    event: item.type,
  };
}

function readPayloadField(payload: ProtocolItem['payload'], key: string): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return undefined;
  }

  return payload[key];
}

function readCommand(input: unknown): string {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const command = readPayloadField(input as JsonObject, 'command');

    if (typeof command === 'string') {
      return command;
    }
  }

  return stringify(input);
}

function readShellOutputDelta(
  payload: ProtocolItem['payload']
): { readonly stream: 'stdout' | 'stderr'; readonly chunk: string } | undefined {
  const delta = readPayloadField(payload, 'delta');

  if (typeof delta !== 'object' || delta === null || Array.isArray(delta)) {
    return undefined;
  }

  const stream = readPayloadField(delta as JsonObject, 'stream');
  const chunk = readPayloadField(delta as JsonObject, 'chunk');

  if ((stream !== 'stdout' && stream !== 'stderr') || typeof chunk !== 'string') {
    return undefined;
  }

  return { stream, chunk };
}

function parseShellResult(content: unknown): {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
} {
  if (typeof content !== 'string') {
    return {};
  }

  const exitCodeText = content.match(/^exitCode:\s*([^\r\n]+)/m)?.[1]?.trim();
  const exitCode =
    exitCodeText === undefined ? undefined : exitCodeText === 'null' ? null : Number(exitCodeText);

  return {
    exitCode: Number.isNaN(exitCode) ? undefined : exitCode,
    stdout: readShellSection(content, 'stdout'),
    stderr: readShellSection(content, 'stderr'),
  };
}

function readShellSection(content: string, section: 'stdout' | 'stderr'): string | undefined {
  const nextSection = section === 'stdout' ? 'stderr' : undefined;
  const pattern =
    nextSection === undefined
      ? new RegExp(`^${section}:\\n([\\s\\S]*)`, 'm')
      : new RegExp(`^${section}:\\n([\\s\\S]*?)(?=^${nextSection}:\\n)`, 'm');
  const value = content.match(pattern)?.[1];

  return value === undefined ? undefined : value.trimEnd();
}

function isInterruptedShellMessage(message: string): boolean {
  return /\b(abort|aborted|cancel|canceled|cancelled|interrupt|interrupted)\b/i.test(message);
}

function readStringPayloadField(payload: ProtocolItem['payload'], key: string): string {
  const value = readPayloadField(payload, key);

  return typeof value === 'string' ? value : '';
}

function readOptionalStringPayloadField(
  payload: ProtocolItem['payload'],
  key: string
): string | undefined {
  const value = readStringPayloadField(payload, key);

  return value.length > 0 ? value : undefined;
}

function readApprovalDecision(payload: ProtocolItem['payload']): ApprovalDecision | undefined {
  const value = readStringPayloadField(payload, 'decision');

  if (value === 'approveOnce' || value === 'decline') {
    return value;
  }

  return undefined;
}

function readApprovalEventType(
  item: ProtocolItem
): 'approval.requested' | 'approval.resolved' | undefined {
  if (item.type === 'approval.requested' || item.type === 'approval.resolved') {
    return item.type;
  }

  const delta = readPayloadField(item.payload, 'delta');

  if (typeof delta !== 'object' || delta === null || Array.isArray(delta)) {
    return undefined;
  }

  const type = readPayloadField(delta as JsonObject, 'type');

  return type === 'approval.requested' || type === 'approval.resolved' ? type : undefined;
}

function readApprovalPayload(item: ProtocolItem): ProtocolItem['payload'] {
  return item.payload;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === undefined || value === null) {
    return '';
  }

  return JSON.stringify(value);
}
