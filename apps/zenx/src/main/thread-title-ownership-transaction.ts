const DEFAULT_QUIESCENCE_DEADLINE_MS = 250;

export interface ZenXThreadTitleOwnershipTransactionOptions {
  deadlineMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

let nextTransactionId = 0;

/**
 * A transient title-work owner. Store commits, inference, and native mirrors all
 * capture one instance so retirement is a synchronous authority fence even
 * when the underlying asynchronous operation cannot be cancelled.
 */
export class ZenXThreadTitleOwnershipTransaction {
  readonly id = `title-owner-${String(++nextTransactionId)}`;
  readonly #abort = new AbortController();
  readonly #deadlineMs: number;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelScheduled: (handle: unknown) => void;
  readonly #tracked = new Set<Promise<void>>();
  readonly #retirementHooks = new Set<() => void>();
  readonly #parent: ZenXThreadTitleOwnershipTransaction | undefined;
  readonly #disposeParentRetirement: (() => void) | undefined;
  #active = true;
  #retirement: Promise<void> | undefined;

  constructor(
    options: ZenXThreadTitleOwnershipTransactionOptions = {},
    parent?: ZenXThreadTitleOwnershipTransaction,
  ) {
    this.#deadlineMs = validDeadline(
      options.deadlineMs ?? DEFAULT_QUIESCENCE_DEADLINE_MS,
    );
    this.#schedule = options.schedule ?? setTimeout;
    this.#cancelScheduled =
      options.cancelScheduled ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#parent = parent;
    this.#disposeParentRetirement = parent?.onRetire(() => {
      void this.retire();
    });
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  get root(): ZenXThreadTitleOwnershipTransaction {
    return this.#parent?.root ?? this;
  }

  isCurrent(): boolean {
    return (
      this.#active &&
      !this.#abort.signal.aborted &&
      (this.#parent?.isCurrent() ?? true)
    );
  }

  fork(
    options: ZenXThreadTitleOwnershipTransactionOptions = {},
  ): ZenXThreadTitleOwnershipTransaction {
    return new ZenXThreadTitleOwnershipTransaction(options, this);
  }

  track<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    if (this.#active) {
      this.#tracked.add(settled);
      void settled.finally(() => this.#tracked.delete(settled));
    }
    if (this.root !== this) this.root.track(operation);
    return operation;
  }

  onRetire(callback: () => void): () => void {
    if (!this.isCurrent()) {
      callback();
      return () => undefined;
    }
    this.#retirementHooks.add(callback);
    return () => this.#retirementHooks.delete(callback);
  }

  retire(): Promise<void> {
    if (this.#retirement !== undefined) return this.#retirement;
    this.#active = false;
    this.#disposeParentRetirement?.();
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
        `Could not fully retire title ownership transaction: ${errors
          .map(describeError)
          .join("; ")}`,
      );
    }
  }
}

function validDeadline(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      "Title ownership quiescence deadline must be a finite non-negative number",
    );
  }
  return value;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
