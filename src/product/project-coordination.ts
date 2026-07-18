import type { Clock, IdGenerator } from '../kernel/index.js';

export type ProjectCoordinationItemType =
  | 'project.thread.created'
  | 'thread.message.sent'
  | 'thread.message.delivered'
  | 'thread.message.failed'
  | 'agent.lease.queued'
  | 'agent.lease.granted'
  | 'agent.lease.released'
  | 'thread.wait.started'
  | 'thread.wait.resolved'
  | 'thread.wait.failed'
  | 'thread.canceled'
  | 'thread.archived'
  | 'thread.handoff';

/** Project-scoped coordination facts intentionally do not impersonate kernel Items. */
export type ProjectCoordinationItem = {
  readonly version: 1;
  readonly id: string;
  readonly type: ProjectCoordinationItemType;
  readonly projectId: string;
  readonly createdAtMs: number;
  readonly seq: number;
  readonly sourceThreadId?: string;
  readonly targetThreadId?: string;
  readonly messageId?: string;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly parentId?: string;
  readonly causeId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type ProjectCoordinationAppendInput = Omit<
  ProjectCoordinationItem,
  'version' | 'id' | 'createdAtMs' | 'seq'
>;

export interface ProjectCoordinationJournal {
  append(item: ProjectCoordinationItem): Promise<void>;
  replay(): Promise<readonly ProjectCoordinationItem[]>;
  close(): Promise<void>;
}

export class ProjectCoordinationJournalCorruptionError extends Error {
  constructor(
    readonly path: string,
    readonly recordNumber: number,
    message: string
  ) {
    super(`Project coordination journal corruption at ${path}, record ${recordNumber}: ${message}`);
    this.name = 'ProjectCoordinationJournalCorruptionError';
  }
}

export class InMemoryProjectCoordinationJournal implements ProjectCoordinationJournal {
  private readonly items: ProjectCoordinationItem[];
  private closed = false;

  constructor(initialItems: readonly ProjectCoordinationItem[] = []) {
    this.items = initialItems.map(cloneCoordinationItem);
  }

  async append(item: ProjectCoordinationItem): Promise<void> {
    if (this.closed) throw new Error('Project coordination journal is closed');
    this.items.push(cloneCoordinationItem(item));
  }

  async replay(): Promise<readonly ProjectCoordinationItem[]> {
    return this.items.map(cloneCoordinationItem);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class ProjectCoordinationList {
  private readonly items: ProjectCoordinationItem[];
  private readonly generateId: IdGenerator;
  private readonly clock: Clock;
  private readonly nextSeqByProject = new Map<string, number>();

  constructor(
    options: {
      readonly generateId?: IdGenerator;
      readonly clock?: Clock;
      readonly initialItems?: readonly ProjectCoordinationItem[];
    } = {}
  ) {
    this.generateId = options.generateId ?? defaultId;
    this.clock = options.clock ?? Date.now;
    this.items = (options.initialItems ?? []).map(cloneCoordinationItem);
    for (const item of this.items) {
      this.nextSeqByProject.set(
        item.projectId,
        Math.max(this.nextSeqByProject.get(item.projectId) ?? 1, item.seq + 1)
      );
    }
  }

  create(input: ProjectCoordinationAppendInput): ProjectCoordinationItem {
    const seq = this.nextSeqByProject.get(input.projectId) ?? 1;
    return {
      ...input,
      version: 1,
      id: this.generateId(),
      createdAtMs: this.clock(),
      seq,
      payload: clonePayload(input.payload),
    };
  }

  commit(item: ProjectCoordinationItem): void {
    this.items.push(cloneCoordinationItem(item));
    this.nextSeqByProject.set(
      item.projectId,
      Math.max(this.nextSeqByProject.get(item.projectId) ?? 1, item.seq + 1)
    );
  }

  getItems(projectId?: string): readonly ProjectCoordinationItem[] {
    return this.items
      .filter((item) => projectId === undefined || item.projectId === projectId)
      .map(cloneCoordinationItem);
  }
}

export function cloneCoordinationItem(item: ProjectCoordinationItem): ProjectCoordinationItem {
  return { ...item, payload: clonePayload(item.payload) };
}

function clonePayload(
  payload: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return structuredClone(payload);
}

function defaultId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `coordination-${Date.now()}-${Math.random()}`;
}
