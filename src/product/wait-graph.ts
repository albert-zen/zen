export type WaitMode = 'any' | 'all';

export class WaitCycleError extends Error {
  constructor(readonly path: readonly string[]) {
    super(`Thread wait cycle: ${path.join(' -> ')}`);
    this.name = 'WaitCycleError';
  }
}

export class WaitGraph {
  private readonly edges = new Map<string, Set<string>>();
  private readonly waiters = new Map<
    string,
    {
      readonly source: string;
      readonly targets: Set<string>;
      readonly mode: WaitMode;
      readonly resolve: (value: WaitResult) => void;
      readonly reject: (cause: unknown) => void;
      readonly cleanup?: () => void;
    }
  >();
  private readonly results = new Map<string, WaitResult>();
  private nextId = 1;

  wait(input: {
    readonly source: string;
    readonly targets: readonly string[];
    readonly mode: WaitMode;
    readonly signal?: AbortSignal;
  }): Promise<WaitResult> {
    if (input.targets.length === 0) throw new Error('Thread wait requires at least one target');
    if (new Set(input.targets).size !== input.targets.length)
      throw new Error('Thread wait targets must be unique');
    for (const target of input.targets) {
      const path = this.path(target, input.source);
      if (path) throw new WaitCycleError([input.source, ...path]);
    }
    const id = `wait-${this.nextId++}`;
    const targets = new Set(input.targets);
    this.edges.set(input.source, targets);
    if (input.signal?.aborted) {
      this.edges.delete(input.source);
      return Promise.reject(new DOMException('Thread wait aborted', 'AbortError'));
    }
    return new Promise<WaitResult>((resolve, reject) => {
      const abort = () => {
        this.remove(id);
        reject(new DOMException('Thread wait aborted', 'AbortError'));
      };
      input.signal?.addEventListener('abort', abort, { once: true });
      this.waiters.set(id, {
        source: input.source,
        targets,
        mode: input.mode,
        resolve,
        reject,
        cleanup: () => input.signal?.removeEventListener('abort', abort),
      });
      this.tryResolve(id);
    });
  }

  settle(threadId: string, result: WaitResult): void {
    this.results.set(threadId, result);
    for (const id of [...this.waiters.keys()]) this.tryResolve(id);
  }

  cancelThread(threadId: string, cause = new Error(`Thread canceled: ${threadId}`)): void {
    for (const [id, waiter] of this.waiters) {
      if (waiter.source === threadId || waiter.targets.has(threadId)) {
        this.remove(id);
        waiter.reject(cause);
      }
    }
    this.edges.delete(threadId);
    for (const targets of this.edges.values()) targets.delete(threadId);
  }

  dispose(cause = new Error('Wait graph disposed')): void {
    for (const [id, waiter] of this.waiters) {
      this.remove(id);
      waiter.reject(cause);
    }
  }

  private tryResolve(id: string): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    const values = [...waiter.targets].map((target) => this.results.get(target));
    const resolved =
      waiter.mode === 'all'
        ? values.every((value) => value !== undefined)
          ? values[0]
          : undefined
        : values.find((value): value is WaitResult => value !== undefined);
    if (!resolved) return;
    this.remove(id);
    if (resolved) waiter.resolve(resolved);
  }

  private remove(id: string): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    waiter.cleanup?.();
    this.edges.delete(waiter.source);
  }

  private path(
    from: string,
    target: string,
    seen = new Set<string>()
  ): readonly string[] | undefined {
    if (from === target) return [from];
    if (seen.has(from)) return undefined;
    seen.add(from);
    for (const next of this.edges.get(from) ?? []) {
      const found = this.path(next, target, seen);
      if (found) return [from, ...found];
    }
    return undefined;
  }
}

export type WaitResult = {
  readonly threadId: string;
  readonly status: 'completed' | 'failed' | 'canceled' | 'archived';
  readonly summary?: string;
};
