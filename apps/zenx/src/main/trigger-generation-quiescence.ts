const DEFAULT_QUIESCENCE_DEADLINE_MS = 250;

export interface ZenXTriggerGenerationQuiescenceOptions {
  deadlineMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

export class ZenXTriggerGenerationQuiescence {
  readonly #abort = new AbortController();
  readonly #deadlineMs: number;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelScheduled: (handle: unknown) => void;
  readonly #tracked = new Set<Promise<void>>();
  readonly #retirementHooks = new Set<() => void>();
  #active = true;
  #retirement: Promise<void> | undefined;

  constructor(options: ZenXTriggerGenerationQuiescenceOptions = {}) {
    this.#deadlineMs = validDeadline(
      options.deadlineMs ?? DEFAULT_QUIESCENCE_DEADLINE_MS,
    );
    this.#schedule = options.schedule ?? setTimeout;
    this.#cancelScheduled =
      options.cancelScheduled ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  isCurrent(): boolean {
    return this.#active;
  }

  track<T>(operation: Promise<T>): Promise<T> {
    if (!this.#active) return operation;
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#tracked.add(settled);
    void settled.finally(() => this.#tracked.delete(settled));
    return operation;
  }

  onRetire(callback: () => void): () => void {
    if (!this.#active) {
      callback();
      return () => undefined;
    }
    this.#retirementHooks.add(callback);
    return () => this.#retirementHooks.delete(callback);
  }

  retire(): Promise<void> {
    if (this.#retirement !== undefined) return this.#retirement;
    this.#active = false;
    const errors: unknown[] = [];
    try {
      this.#abort.abort();
    } catch (error) {
      errors.push(error);
    }
    for (const hook of this.#retirementHooks) {
      try {
        hook();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#retirementHooks.clear();
    this.#retirement = this.#finishRetirement(errors);
    return this.#retirement;
  }

  async #finishRetirement(errors: unknown[]): Promise<void> {
    const work = Promise.all([...this.#tracked]).then(() => undefined);
    let deadlineHandle: unknown;
    let resolveDeadline!: () => void;
    const deadline = new Promise<void>((resolve) => {
      resolveDeadline = resolve;
    });
    try {
      deadlineHandle = this.#schedule(resolveDeadline, this.#deadlineMs);
    } catch (error) {
      errors.push(error);
      resolveDeadline();
    }
    const outcome = await Promise.race([
      work.then(() => "settled" as const),
      deadline.then(() => "deadline" as const),
    ]);
    if (outcome === "settled" && deadlineHandle !== undefined) {
      try {
        this.#cancelScheduled(deadlineHandle);
      } catch (error) {
        errors.push(error);
      }
    }
    this.#tracked.clear();
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Could not fully retire Trigger generation: ${errors
          .map(describeError)
          .join("; ")}`,
      );
    }
  }
}

function validDeadline(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(
      "Trigger quiescence deadline must be a finite non-negative number",
    );
  return value;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
