import type { TurnStatus } from './app-server-protocol.js';

export type AgentLease = {
  readonly id: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly turnId: string;
};

export type AgentSchedulerOptions = {
  readonly maxActiveExecutions: (projectId: string) => number;
  readonly onEvent?: (event: AgentSchedulerEvent) => Promise<void> | void;
};

export type AgentSchedulerEvent = {
  readonly type: 'agent.lease.queued' | 'agent.lease.granted' | 'agent.lease.released';
  readonly projectId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly leaseId?: string;
  readonly status?: TurnStatus;
};

type PendingExecution = {
  readonly threadId: string;
  readonly turnId: string;
  readonly resolve: (lease: AgentLease) => void;
  readonly reject: (cause: unknown) => void;
  readonly signal?: AbortSignal;
  abort?: () => void;
};

/** Resource governor for short-lived Turn executors. Idle Threads never enter this class. */
export class AgentScheduler {
  private readonly queues = new Map<string, PendingExecution[]>();
  private readonly active = new Map<string, Map<string, AgentLease>>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: AgentSchedulerOptions) {}

  async acquire(
    projectId: string,
    threadId: string,
    turnId: string,
    signal?: AbortSignal
  ): Promise<AgentLease> {
    if (this.closed) throw new Error('Agent scheduler is closed');
    if (signal?.aborted) throw new DOMException('Turn execution acquisition aborted', 'AbortError');
    await this.emit({ type: 'agent.lease.queued', projectId, threadId, turnId });
    return await new Promise<AgentLease>((resolve, reject) => {
      const queue = this.queues.get(projectId) ?? [];
      const pending: PendingExecution = { threadId, turnId, resolve, reject, signal };
      if (signal) {
        pending.abort = () => {
          const index = queue.indexOf(pending);
          if (index >= 0) queue.splice(index, 1);
          reject(new DOMException('Turn execution acquisition aborted', 'AbortError'));
        };
        signal.addEventListener('abort', pending.abort, { once: true });
      }
      queue.push(pending);
      this.queues.set(projectId, queue);
      void this.pump(projectId);
    });
  }

  async release(lease: AgentLease, status: TurnStatus): Promise<void> {
    const active = this.active.get(lease.projectId);
    if (!active?.delete(lease.id)) return;
    await this.emit({
      type: 'agent.lease.released',
      projectId: lease.projectId,
      threadId: lease.threadId,
      turnId: lease.turnId,
      leaseId: lease.id,
      status,
    });
    await this.pump(lease.projectId);
  }

  activeExecutionCount(projectId: string): number {
    return this.active.get(projectId)?.size ?? 0;
  }

  queuedExecutionCount(projectId: string): number {
    return this.queues.get(projectId)?.length ?? 0;
  }

  /** Re-evaluate queued Turns after an atomic Project execution-policy update. */
  async refresh(projectId: string): Promise<void> {
    if (this.closed) throw new Error('Agent scheduler is closed');
    await this.pump(projectId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const queue of this.queues.values()) {
      for (const pending of queue) {
        pending.signal?.removeEventListener('abort', pending.abort!);
        pending.reject(new Error('Agent scheduler is closed'));
      }
    }
    this.queues.clear();
    this.active.clear();
  }

  private async pump(projectId: string): Promise<void> {
    const active = this.active.get(projectId) ?? new Map<string, AgentLease>();
    this.active.set(projectId, active);
    const queue = this.queues.get(projectId) ?? [];
    while (
      !this.closed &&
      active.size < this.options.maxActiveExecutions(projectId) &&
      queue.length > 0
    ) {
      const pending = queue.shift();
      if (!pending) return;
      pending.signal?.removeEventListener('abort', pending.abort!);
      if (pending.signal?.aborted) {
        pending.reject(new DOMException('Turn execution acquisition aborted', 'AbortError'));
        continue;
      }
      const lease: AgentLease = {
        id: `execution-${this.nextId++}`,
        projectId,
        threadId: pending.threadId,
        turnId: pending.turnId,
      };
      active.set(lease.id, lease);
      try {
        await this.emit({
          type: 'agent.lease.granted',
          projectId,
          threadId: lease.threadId,
          turnId: lease.turnId,
          leaseId: lease.id,
        });
        pending.resolve(lease);
      } catch (cause) {
        active.delete(lease.id);
        pending.reject(cause);
      }
    }
  }

  private async emit(event: AgentSchedulerEvent): Promise<void> {
    await this.options.onEvent?.(event);
  }
}
