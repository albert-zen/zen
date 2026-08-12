const DEFAULT_QUIESCENCE_DEADLINE_MS = 250;
const MAX_NESTED_RETIREMENT_TRANSACTIONS = 128;
const MAX_RETIREMENT_OUTCOMES = MAX_NESTED_RETIREMENT_TRANSACTIONS + 1;
const MAX_RETIREMENT_FAILURE_EVIDENCE = 64;
const MAX_RETIREMENT_FAILURE_LISTENERS = 64;
const MAX_RETIREMENT_HOOKS = 64;
const MAX_TRACKED_RETIREMENT_WORK = 128;
const MAX_RETIREMENT_ERROR_DESCRIPTION_LENGTH = 160;

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
  readonly #rootOrder: number;
  readonly #failures: RetirementFailure[] = [];
  readonly #observations = new Map<number, Promise<RetirementOutcome>>();
  readonly #failureListeners = new Set<(failure: AggregateError) => void>();
  #nestedTransactions = 0;
  #failureEvidenceSaturated = false;
  #nextOccurrence = 0;

  constructor(rootOrder: number) {
    this.#rootOrder = rootOrder;
  }

  registerChild(transactionOrder: number, ancestry: readonly number[]): void {
    if (this.#nestedTransactions >= MAX_NESTED_RETIREMENT_TRANSACTIONS) {
      const failure = new Error(
        `Title ownership retirement reached its bounded capacity of ${String(
          MAX_NESTED_RETIREMENT_TRANSACTIONS,
        )} nested transactions`,
      );
      this.record(transactionOrder, ancestry, failure);
      throw failure;
    }
    this.#nestedTransactions += 1;
  }

  observe(
    transactionOrder: number,
    ancestry: readonly number[],
    retirement: Promise<void>,
  ): Promise<RetirementOutcome> {
    const existing = this.#observations.get(transactionOrder);
    if (existing !== undefined) return existing;
    const outcome = retirement.then<RetirementOutcome, RetirementOutcome>(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error }),
    );
    if (this.#observations.size >= MAX_RETIREMENT_OUTCOMES) {
      this.record(
        transactionOrder,
        ancestry,
        new Error(
          `Title ownership retirement reached its bounded capacity of ${String(
            MAX_RETIREMENT_OUTCOMES,
          )} observed outcomes`,
        ),
      );
      return outcome;
    }
    this.#observations.set(transactionOrder, outcome);
    return outcome;
  }

  record(
    transactionOrder: number,
    ancestry: readonly number[],
    error: unknown,
  ): void {
    if (this.#failureEvidenceSaturated) return;
    const occurrence = this.#nextOccurrence++;
    if (this.#failures.length < MAX_RETIREMENT_FAILURE_EVIDENCE - 1) {
      this.#failures.push({
        transactionOrder,
        ancestry,
        occurrence,
        error,
      });
    } else {
      this.#failureEvidenceSaturated = true;
      this.#failures.push({
        transactionOrder,
        ancestry,
        occurrence,
        error: new Error(
          `Title ownership retirement reached its bounded capacity of ${String(
            MAX_RETIREMENT_FAILURE_EVIDENCE,
          )} failure evidence records; additional failures were omitted`,
        ),
      });
    }
    this.#notifyFailureListeners();
  }

  failuresFor(transactionOrder: number): unknown[] {
    return this.#failureRecordsFor(transactionOrder).map(
      (failure) => failure.error,
    );
  }

  addFailureListener(
    transactionOrder: number,
    ancestry: readonly number[],
    listener: (failure: AggregateError) => void,
  ): () => void {
    if (this.#failureListeners.size >= MAX_RETIREMENT_FAILURE_LISTENERS) {
      this.record(
        transactionOrder,
        ancestry,
        new Error(
          `Title ownership retirement reached its bounded capacity of ${String(
            MAX_RETIREMENT_FAILURE_LISTENERS,
          )} failure listeners`,
        ),
      );
      this.#notifyListener(listener);
      return () => undefined;
    }
    this.#failureListeners.add(listener);
    if (!this.healthy) this.#notifyListener(listener);
    return () => this.#failureListeners.delete(listener);
  }

  get healthy(): boolean {
    return this.#failures.length === 0;
  }

  #failureRecordsFor(transactionOrder: number): RetirementFailure[] {
    return this.#failures
      .filter((failure) => failure.ancestry.includes(transactionOrder))
      .sort(
        (left, right) =>
          left.transactionOrder - right.transactionOrder ||
          left.occurrence - right.occurrence,
      );
  }

  #notifyFailureListeners(): void {
    for (const listener of this.#failureListeners)
      this.#notifyListener(listener);
  }

  #notifyListener(listener: (failure: AggregateError) => void): void {
    const failures = this.failuresFor(this.#rootOrder);
    if (failures.length === 0) return;
    try {
      listener(aggregateRetirementFailures(failures));
    } catch {
      // Failure observers are best-effort notifications. The root remains
      // poisoned even if an observer itself is unavailable.
    }
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
      this.#closure = new RootRetirementClosure(this.#order);
      this.#ancestry = [this.#order];
    } else {
      const parentAlreadyFenced = !parent.isCurrent();
      this.#closure = parent.#closure;
      this.#ancestry = [...parent.#ancestry, this.#order];
      this.#closure.registerChild(this.#order, this.#ancestry);
      parent.#children.push(this);
      if (parentAlreadyFenced) void this.retire();
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

  onRetirementFailure(listener: (failure: AggregateError) => void): () => void {
    const root = this.root;
    return this.#closure.addFailureListener(
      root.#order,
      root.#ancestry,
      listener,
    );
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
      if (this.#tracked.size >= MAX_TRACKED_RETIREMENT_WORK) {
        this.#record(
          new Error(
            `Title ownership retirement reached its bounded capacity of ${String(
              MAX_TRACKED_RETIREMENT_WORK,
            )} tracked operations`,
          ),
        );
      } else {
        this.#tracked.add(settled);
        void settled.finally(() => this.#tracked.delete(settled));
      }
    }
    if (this.root !== this) this.root.track(operation);
    return operation;
  }

  onRetire(callback: () => void): () => void {
    if (!this.isCurrent()) {
      callback();
      return () => undefined;
    }
    if (this.#retirementHooks.size >= MAX_RETIREMENT_HOOKS) {
      this.#record(
        new Error(
          `Title ownership retirement reached its bounded capacity of ${String(
            MAX_RETIREMENT_HOOKS,
          )} hooks`,
        ),
      );
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
    this.#closure.observe(this.#order, this.#ancestry, retirement);
    void this.#retireNow().then(resolveRetirement, rejectRetirement);
    return retirement;
  }

  async #retireNow(): Promise<void> {
    const childOutcomes = this.#children.map((child) => {
      const retirement = child.retire();
      return this.#closure.observe(child.#order, child.#ancestry, retirement);
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
  const message = error instanceof Error ? error.message : String(error);
  if (message.length <= MAX_RETIREMENT_ERROR_DESCRIPTION_LENGTH) return message;
  return `${message.slice(0, MAX_RETIREMENT_ERROR_DESCRIPTION_LENGTH - 1)}…`;
}

function aggregateRetirementFailures(failures: unknown[]): AggregateError {
  return new AggregateError(
    failures,
    `Could not fully retire title ownership transaction: ${failures
      .map(describeError)
      .join("; ")}`,
  );
}
