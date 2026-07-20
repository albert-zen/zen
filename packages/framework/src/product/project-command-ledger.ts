import type { AgentAppMethod, AgentAppResponse } from './agent-app-protocol.js';

export type ProjectCommandState = 'pending' | 'completed';
export type ProjectCommandRecord = {
  readonly version: 1;
  readonly scope: string;
  readonly method: AgentAppMethod;
  readonly idempotencyKey: string;
  readonly digest: string;
  readonly state: ProjectCommandState;
  readonly response?: AgentAppResponse;
};

export interface ProjectCommandStore {
  load(): Promise<readonly ProjectCommandRecord[]>;
  save(records: readonly ProjectCommandRecord[]): Promise<void>;
}

export class InMemoryProjectCommandStore implements ProjectCommandStore {
  private records: readonly ProjectCommandRecord[];
  constructor(records: readonly ProjectCommandRecord[] = []) {
    this.records = structuredClone(records);
  }
  async load(): Promise<readonly ProjectCommandRecord[]> {
    return structuredClone(this.records);
  }
  async save(records: readonly ProjectCommandRecord[]): Promise<void> {
    this.records = structuredClone(records);
  }
}

export class ProjectCommandConflictError extends Error {
  constructor(scope: string, method: AgentAppMethod, key: string) {
    super(`Agent App command idempotency conflict: ${scope}/${method}/${key}`);
    this.name = 'ProjectCommandConflictError';
  }
}

export type ProjectCommandBegin =
  | { readonly state: 'started' }
  | { readonly state: 'pending' }
  | { readonly state: 'completed'; readonly response: AgentAppResponse };

export class ProjectCommandLedger {
  private readonly records = new Map<string, ProjectCommandRecord>();
  private writeTail: Promise<void> = Promise.resolve();
  private constructor(private readonly store: ProjectCommandStore) {}

  static inMemory(): ProjectCommandLedger {
    return new ProjectCommandLedger(new InMemoryProjectCommandStore());
  }

  static async open(
    store: ProjectCommandStore = new InMemoryProjectCommandStore()
  ): Promise<ProjectCommandLedger> {
    const ledger = new ProjectCommandLedger(store);
    for (const record of await store.load()) {
      assertRecord(record);
      const identity = commandIdentity(record.scope, record.method, record.idempotencyKey);
      if (ledger.records.has(identity)) throw new Error(`Duplicate Agent App command: ${identity}`);
      ledger.records.set(identity, structuredClone(record));
    }
    return ledger;
  }

  async begin(input: {
    readonly scope: string;
    readonly method: AgentAppMethod;
    readonly idempotencyKey: string;
    readonly digest: string;
  }): Promise<ProjectCommandBegin> {
    return await this.enqueue(async () => {
      const identity = commandIdentity(input.scope, input.method, input.idempotencyKey);
      const existing = this.records.get(identity);
      if (existing) {
        if (existing.digest !== input.digest) {
          throw new ProjectCommandConflictError(input.scope, input.method, input.idempotencyKey);
        }
        return existing.state === 'completed'
          ? { state: 'completed' as const, response: structuredClone(existing.response!) }
          : { state: 'pending' as const };
      }
      const pending: ProjectCommandRecord = { version: 1, ...input, state: 'pending' };
      await this.persist([...this.records.values(), pending]);
      this.records.set(identity, pending);
      return { state: 'started' as const };
    });
  }

  async complete(input: {
    readonly scope: string;
    readonly method: AgentAppMethod;
    readonly idempotencyKey: string;
    readonly response: AgentAppResponse;
  }): Promise<void> {
    await this.enqueue(async () => {
      const identity = commandIdentity(input.scope, input.method, input.idempotencyKey);
      const current = this.records.get(identity);
      if (!current) throw new Error(`Unknown Agent App command: ${identity}`);
      if (current.state === 'completed') return;
      const completed: ProjectCommandRecord = {
        ...current,
        state: 'completed',
        response: structuredClone(input.response),
      };
      await this.persist(
        [...this.records.entries()].map(([key, record]) => (key === identity ? completed : record))
      );
      this.records.set(identity, completed);
    });
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation);
    this.writeTail = result.then(
      () => undefined,
      () => undefined
    );
    return await result;
  }

  private async persist(records: readonly ProjectCommandRecord[]): Promise<void> {
    await this.store.save(structuredClone(records));
  }
}

function commandIdentity(scope: string, method: AgentAppMethod, key: string): string {
  return `${scope}\u0000${method}\u0000${key}`;
}

function assertRecord(record: ProjectCommandRecord): void {
  if (
    record.version !== 1 ||
    !record.scope ||
    !record.method ||
    !record.idempotencyKey ||
    !record.digest ||
    (record.state !== 'pending' && record.state !== 'completed') ||
    (record.state === 'completed' && record.response === undefined)
  ) {
    throw new Error('Invalid Agent App command record');
  }
}
