import {
  aggregateTitleOwnershipFailures,
  MAX_TITLE_OWNERSHIP_FAILURE_EVIDENCE,
  normalizeTitleOwnershipFailure,
} from "./thread-title-failure.js";

const DEFAULT_QUIESCENCE_DEADLINE_MS = 250;
const MAX_NESTED_RETIREMENT_TRANSACTIONS = 128;
const MAX_RETIREMENT_OUTCOMES = MAX_NESTED_RETIREMENT_TRANSACTIONS + 1;
const MAX_RETIREMENT_FAILURE_EVIDENCE = MAX_TITLE_OWNERSHIP_FAILURE_EVIDENCE;
const MAX_RETIREMENT_FAILURE_LISTENERS = 64;
const MAX_RETIREMENT_HOOKS = 64;
const MAX_SAFE_ABORT_LISTENERS = 64;
const MAX_TRACKED_RETIREMENT_WORK = 128;

export interface ZenXThreadTitleOwnershipTransactionOptions {
  deadlineMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

interface RetirementFailure {
  readonly transactionOrder: number;
  readonly ancestry: readonly number[];
  readonly occurrence: number;
  readonly error: Error;
}

type RetirementOutcome = { readonly ok: true } | { readonly ok: false };

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
      (reason: unknown) => {
        if (this.#failureRecordsFor(transactionOrder).length === 0)
          this.record(transactionOrder, ancestry, reason);
        return { ok: false };
      },
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
        error: normalizeTitleOwnershipFailure(error),
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

  failuresFor(transactionOrder: number): Error[] {
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
      const result = (listener as (failure: AggregateError) => unknown)(
        aggregateRetirementFailures(failures),
      );
      observeAuxiliaryFailure(result, (error) => {
        this.#failureListeners.delete(listener);
        this.record(this.#rootOrder, [this.#rootOrder], error);
      });
    } catch (error) {
      this.#failureListeners.delete(listener);
      this.record(this.#rootOrder, [this.#rootOrder], error);
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
  readonly #abort: OwnedSafeAbortController;
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
    this.#abort = new OwnedSafeAbortController((error) => this.#record(error));
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

  poison(error: unknown): void {
    this.#record(error);
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
      try {
        const result = (callback as () => unknown)();
        this.#observeRetirementAuxiliary(result);
      } catch (error) {
        this.#record(error);
      }
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
    void this.#retireNow().then(resolveRetirement, (error: unknown) => {
      if (this.#closure.failuresFor(this.#order).length === 0)
        this.#record(error);
      rejectRetirement(
        this.retirementFailure() ?? normalizeTitleOwnershipFailure(error),
      );
    });
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
    await Promise.resolve();
    for (const hook of this.#retirementHooks) {
      try {
        const result = (hook as () => unknown)();
        this.#observeRetirementAuxiliary(result);
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
        const result = (this.#cancelScheduled as (handle: unknown) => unknown)(
          deadlineHandle,
        );
        void observeAuxiliaryFailure(result, (error) => this.#record(error));
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

  #observeRetirementAuxiliary(result: unknown): void {
    const observation = observeAuxiliaryFailure(result, (error) =>
      this.#record(error),
    );
    if (this.#tracked.size >= MAX_TRACKED_RETIREMENT_WORK) {
      this.#record(
        new Error(
          `Title ownership retirement reached its bounded capacity of ${String(
            MAX_TRACKED_RETIREMENT_WORK,
          )} tracked operations`,
        ),
      );
      return;
    }
    this.#tracked.add(observation);
    void observation.finally(() => this.#tracked.delete(observation));
  }
}

type SafeAbortListener = EventListenerOrEventListenerObject;

interface SafeAbortRegistration {
  readonly type: string;
  readonly listener: SafeAbortListener;
  readonly capture: boolean;
  readonly wrapped: EventListener;
}

/** Keeps a native-branded signal for model/fetch adapters while ensuring that
 * every listener registered through this owned signal surface is isolated. */
class OwnedSafeAbortController {
  readonly #controller = new AbortController();
  readonly #registrations: SafeAbortRegistration[] = [];
  readonly #record: (error: unknown) => void;
  #onabort: EventHandler | null = null;

  readonly signal: AbortSignal;

  constructor(record: (error: unknown) => void) {
    this.#record = record;
    const signal = this.#controller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    Object.defineProperties(signal, {
      addEventListener: {
        configurable: false,
        value: (
          type: string,
          listener: SafeAbortListener | null,
          options?: boolean | AddEventListenerOptions,
        ) => {
          if (listener === null) return;
          const capture = safeEventOption(options, "capture", this.#record);
          const once = safeEventOption(options, "once", this.#record);
          if (
            this.#registrations.some(
              (entry) =>
                entry.type === type &&
                entry.listener === listener &&
                entry.capture === capture,
            )
          )
            return;
          if (this.#registrations.length >= MAX_SAFE_ABORT_LISTENERS) {
            this.#record(
              new Error(
                `Title ownership abort notification reached its bounded capacity of ${String(
                  MAX_SAFE_ABORT_LISTENERS,
                )} listeners`,
              ),
            );
            return;
          }
          const wrapped: EventListener = (event) => {
            if (once) this.#forget(type, listener, capture, remove);
            this.#invoke(listener, event);
          };
          this.#registrations.push({ type, listener, capture, wrapped });
          try {
            add(type, wrapped, { capture, once: false });
          } catch (error) {
            this.#forget(type, listener, capture, remove);
            this.#record(error);
          }
        },
      },
      removeEventListener: {
        configurable: false,
        value: (
          type: string,
          listener: SafeAbortListener | null,
          options?: boolean | EventListenerOptions,
        ) => {
          if (listener === null) return;
          const capture = safeEventOption(options, "capture", this.#record);
          const registration = this.#registrations.find(
            (entry) =>
              entry.type === type &&
              entry.listener === listener &&
              entry.capture === capture,
          );
          if (registration === undefined) return;
          const index = this.#registrations.indexOf(registration);
          this.#registrations.splice(index, 1);
          try {
            remove(type, registration.wrapped, capture);
          } catch (error) {
            this.#record(error);
          }
        },
      },
      onabort: {
        configurable: false,
        get: () => this.#onabort,
        set: (listener: EventHandler | null) => {
          if (this.#onabort !== null)
            signal.removeEventListener("abort", this.#onabort);
          this.#onabort = listener;
          if (listener !== null) signal.addEventListener("abort", listener);
        },
      },
    });
    this.signal = signal;
  }

  abort(): void {
    this.#controller.abort(
      normalizeTitleOwnershipFailure("Title ownership transaction retired"),
    );
  }

  #invoke(listener: SafeAbortListener, event: Event): void {
    try {
      let result: unknown;
      if (typeof listener === "function") {
        result = Reflect.apply(listener, this.signal, [event]);
      } else {
        const handleEvent = Reflect.get(listener, "handleEvent");
        if (typeof handleEvent !== "function") return;
        result = Reflect.apply(handleEvent, listener, [event]);
      }
      void observeAuxiliaryFailure(result, this.#record);
    } catch (error) {
      this.#record(error);
    }
  }

  #forget(
    type: string,
    listener: SafeAbortListener,
    capture: boolean,
    remove: AbortSignal["removeEventListener"],
  ): void {
    const registration = this.#registrations.find(
      (entry) =>
        entry.type === type &&
        entry.listener === listener &&
        entry.capture === capture,
    );
    if (registration === undefined) return;
    this.#registrations.splice(this.#registrations.indexOf(registration), 1);
    try {
      remove(type, registration.wrapped, capture);
    } catch (error) {
      this.#record(error);
    }
  }
}

type EventHandler = (this: AbortSignal, event: Event) => unknown;

function safeEventOption(
  options: boolean | EventListenerOptions | AddEventListenerOptions | undefined,
  key: "capture" | "once",
  record: (error: unknown) => void,
): boolean {
  if (typeof options === "boolean") return key === "capture" && options;
  if (options === undefined) return false;
  try {
    return Boolean(Reflect.get(options, key));
  } catch (error) {
    record(error);
    return false;
  }
}

async function observeAuxiliaryFailure(
  result: unknown,
  record: (error: unknown) => void,
): Promise<void> {
  try {
    await result;
  } catch (error) {
    try {
      record(error);
    } catch {
      // The normalizer/closure record path is designed to be total. This last
      // guard prevents an observation boundary from creating a process escape.
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

function aggregateRetirementFailures(
  failures: readonly Error[],
): AggregateError {
  return aggregateTitleOwnershipFailures(
    failures,
    "Could not fully retire title ownership transaction",
  );
}
