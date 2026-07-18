import { WaitGraph, type WaitMode, type WaitResult } from './wait-graph.js';

export type AgentLease = {
  readonly id: string;
  readonly projectId: string;
  readonly threadId: string;
};

export type AgentSchedulerOptions = {
  readonly maxConcurrentAgents: (projectId: string) => number;
  readonly onEvent?: (event: AgentSchedulerEvent) => Promise<void> | void;
};

export type AgentSchedulerEvent = {
  readonly type:
    | 'agent.lease.queued'
    | 'agent.lease.granted'
    | 'agent.lease.released'
    | 'thread.wait.started'
    | 'thread.wait.resolved'
    | 'thread.wait.failed';
  readonly projectId: string;
  readonly threadId: string;
  readonly targets?: readonly string[];
};

export class AgentScheduler {
  private readonly maxConcurrentAgents: AgentSchedulerOptions['maxConcurrentAgents'];
  private readonly onEvent?: AgentSchedulerOptions['onEvent'];
  private readonly queues = new Map<
    string,
    Array<{
      threadId: string;
      resolve: (lease: AgentLease) => void;
      reject: (cause: unknown) => void;
    }>
  >();
  private readonly active = new Map<string, Map<string, AgentLease>>();
  private readonly waitGraph = new WaitGraph();
  private nextId = 1;
  private closed = false;

  constructor(options: AgentSchedulerOptions) {
    this.maxConcurrentAgents = options.maxConcurrentAgents;
    this.onEvent = options.onEvent;
  }

  async acquire(projectId: string, threadId: string): Promise<AgentLease> {
    if (this.closed) throw new Error('Agent scheduler is closed');
    await this.emit({ type: 'agent.lease.queued', projectId, threadId });
    return await new Promise<AgentLease>((resolve, reject) => {
      const queue = this.queues.get(projectId) ?? [];
      queue.push({ threadId, resolve, reject });
      this.queues.set(projectId, queue);
      void this.pump(projectId);
    });
  }

  async release(lease: AgentLease): Promise<void> {
    const active = this.active.get(lease.projectId);
    if (!active?.delete(lease.id)) return;
    await this.emit({
      type: 'agent.lease.released',
      projectId: lease.projectId,
      threadId: lease.threadId,
    });
    await this.pump(lease.projectId);
  }

  async wait(
    lease: AgentLease,
    targets: readonly string[],
    mode: WaitMode,
    signal?: AbortSignal
  ): Promise<{ readonly lease: AgentLease; readonly result: WaitResult }> {
    await this.release(lease);
    await this.emit({
      type: 'thread.wait.started',
      projectId: lease.projectId,
      threadId: lease.threadId,
      targets,
    });
    try {
      const result = await this.waitGraph.wait({
        source: scoped(lease.projectId, lease.threadId),
        targets: targets.map((target) => scoped(lease.projectId, target)),
        mode,
        signal,
      });
      await this.emit({
        type: 'thread.wait.resolved',
        projectId: lease.projectId,
        threadId: lease.threadId,
        targets,
      });
      return { lease: await this.acquire(lease.projectId, lease.threadId), result };
    } catch (cause) {
      await this.emit({
        type: 'thread.wait.failed',
        projectId: lease.projectId,
        threadId: lease.threadId,
        targets,
      });
      throw cause;
    }
  }

  async waitFor(input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly targets: readonly string[];
    readonly mode: WaitMode;
    readonly signal?: AbortSignal;
  }): Promise<WaitResult> {
    await this.emit({
      type: 'thread.wait.started',
      projectId: input.projectId,
      threadId: input.threadId,
      targets: input.targets,
    });
    try {
      const result = await this.waitGraph.wait({
        source: scoped(input.projectId, input.threadId),
        targets: input.targets.map((target) => scoped(input.projectId, target)),
        mode: input.mode,
        signal: input.signal,
      });
      await this.emit({
        type: 'thread.wait.resolved',
        projectId: input.projectId,
        threadId: input.threadId,
        targets: input.targets,
      });
      return result;
    } catch (cause) {
      await this.emit({
        type: 'thread.wait.failed',
        projectId: input.projectId,
        threadId: input.threadId,
        targets: input.targets,
      });
      throw cause;
    }
  }

  settle(projectId: string, result: WaitResult): void {
    this.waitGraph.settle(scoped(projectId, result.threadId), result);
  }

  cancel(projectId: string, threadId: string): void {
    this.waitGraph.cancelThread(scoped(projectId, threadId));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.waitGraph.dispose();
    for (const queue of this.queues.values()) {
      for (const pending of queue) pending.reject(new Error('Agent scheduler is closed'));
    }
    this.queues.clear();
    this.active.clear();
  }

  private async pump(projectId: string): Promise<void> {
    const active = this.active.get(projectId) ?? new Map<string, AgentLease>();
    this.active.set(projectId, active);
    const queue = this.queues.get(projectId) ?? [];
    while (!this.closed && active.size < this.maxConcurrentAgents(projectId) && queue.length > 0) {
      const pending = queue.shift();
      if (!pending) return;
      const lease: AgentLease = {
        id: `lease-${this.nextId++}`,
        projectId,
        threadId: pending.threadId,
      };
      active.set(lease.id, lease);
      await this.emit({ type: 'agent.lease.granted', projectId, threadId: lease.threadId });
      pending.resolve(lease);
    }
  }

  private async emit(event: AgentSchedulerEvent): Promise<void> {
    await this.onEvent?.(event);
  }
}

function scoped(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`;
}
