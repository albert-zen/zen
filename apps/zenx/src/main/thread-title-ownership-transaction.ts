const DEFAULT_QUIESCENCE_DEADLINE_MS = 250;

export interface ZenXThreadTitleOwnershipTransactionOptions {
  deadlineMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

interface RetirementFailure {
  readonly transactionOrder: number;
  readonly ancestry: readonly number[];
  readonly occurrence: number;
  readonly error: unknown;
}

type RetirementOutcome =
  { readonly ok: true } | { readonly ok: false; readonly error: unknown };

class RootRetirementClosure {
  readonly #failures: RetirementFailure[] = [];
  readonly #observations = new Map<number, Promise<RetirementOutcome>>();
  #nextOccurrence = 0;

  observe(
    transactionOrder: number,
    retirement: Promise<void>,
  ): Promise<RetirementOutcome> {
    const existing = this.#observations.get(transactionOrder);
    if (existing !== undefined) return existing;
    const outcome = retirement.then<RetirementOutcome, RetirementOutcome>(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error }),
    );
    this.#observations.set(transactionOrder, outcome);
    return outcome;
  }

  record(
    transactionOrder: number,
    ancestry: readonly number[],
    error: unknown,
  ): void {
    this.#failures.push({
      transactionOrder,
      ancestry,
      occurrence: this.#nextOccurrence++,
      error,
    });
  }

  failuresFor(transactionOrder: number): unknown[] {
    return this.#failures
      .filter((failure) => failure.ancestry.includes(transactionOrder))
      .sort(
        (left, right) =>
          left.transactionOrder - right.transactionOrder ||
          left.occurrence - right.occurrence,
      )
      .map((failure) => failure.error);
  }

  get healthy(): boolean {
    return this.#failures.length === 0;
  }
}

let nextTransactionOrder = 0;

/**
 * A transient title-work owner. Every transaction belongs to one root-owned
 * retirement closure. Child retirement is synchronously registered there
 * before abort, hooks, scheduling, or cleanup can reject.
 */
export class ZenXThreadTitleOwnershipTransaction {
  readonly #order = ++nextTransactionOrder;
  readonly id = `title-owner-${String(this.#order)}`;
  readonly #abort = new AbortController();
  readonly #deadlineMs: number;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelScheduled: (handle: unknown) => void;
  readonly #tracked = new Set<Promise<void>>();
  readonly #retirementHooks = new Set<() => void>();
  readonly #children: ZenXThreadTitleOwnershipTransaction[] = [];
  readonly #parent: ZenXThreadTitleOwnershipTransaction | undefined;
  readonly #closure: RootRetirementClosure;
  readonly #ancestry: readonly number[];
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
    if (parent === undefined) {
      this.#closure = new RootRetirementClosure();
      this.#ancestry = [this.#order];
    } else {
      this.#closure = parent.#closure;
      this.#ancestry = [...parent.#ancestry, this.#order];
      parent.#children.push(this);
    }
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
      this.#closure.healthy &&
      (this.#parent?.isCurrent() ?? true)
    );
  }

  retirementFailure(): AggregateError | undefined {
    const failures = this.#closure.failuresFor(this.#order);
    if (failures.length === 0) return undefined;
    return aggregateRetirementFailures(failures);
  }

  fork(
    options: ZenXThreadTitleOwnershipTransactionOptions = {},
  ): ZenXThreadTitleOwnershipTransaction {
    if (!this.isCurrent())
      throw new Error("Cannot fork retired title ownership");
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

    let resolveRetirement!: () => void;
    let rejectRetirement!: (error: unknown) => void;
    const retirement = new Promise<void>((resolve, reject) => {
      resolveRetirement = resolve;
      rejectRetirement = reject;
    });
    this.#retirement = retirement;

    // Registration and a rejection observer exist before retirement work runs.
    this.#closure.observe(this.#order, retirement);
    void this.#retireNow().then(resolveRetirement, rejectRetirement);
    return retirement;
  }

  async #retireNow(): Promise<void> {
    const childOutcomes = this.#children.map((child) => {
      const retirement = child.retire();
      return this.#closure.observe(child.#order, retirement);
    });

    try {
      this.#abort.abort();
    } catch (error) {
      this.#record(error);
    }
    for (const hook of this.#retirementHooks) {
      try {
        hook();
      } catch (error) {
        this.#record(error);
      }
    }
    this.#retirementHooks.clear();

    for (const error of await this.#finishQuiescence()) this.#record(error);
    await Promise.all(childOutcomes);

    const failures = this.#closure.failuresFor(this.#order);
    if (failures.length > 0) throw aggregateRetirementFailures(failures);
  }

  async #finishQuiescence(): Promise<unknown[]> {
    const errors: unknown[] = [];
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
    return errors;
  }

  #record(error: unknown): void {
    this.#closure.record(this.#order, this.#ancestry, error);
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

function aggregateRetirementFailures(failures: unknown[]): AggregateError {
  return new AggregateError(
    failures,
    `Could not fully retire title ownership transaction: ${failures
      .map(describeError)
      .join("; ")}`,
  );
}
