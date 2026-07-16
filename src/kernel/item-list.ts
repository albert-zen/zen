export type ItemVisibility = "model" | "trace" | "ui" | "internal";

export type Item = {
  readonly id: string;
  readonly type: string;
  readonly createdAtMs: number;
  readonly seq: number;
  readonly runId: string;
  readonly turnId: string;
  readonly parentId?: string;
  readonly causeId?: string;
  readonly targetId?: string;
  readonly visibility?: ItemVisibility;
  readonly payload: unknown;
  readonly meta?: Readonly<Record<string, unknown>>;
};

export type ItemAppendInput = Omit<Item, "id" | "createdAtMs" | "seq">;

export type IdGenerator = () => string;

export type Clock = () => number;

export type ItemObserver = (item: Item) => void;

export type ItemObserverFailure = {
  readonly observerIndex: number;
  readonly item: Item;
  readonly cause: unknown;
};

export class ItemObserverError extends Error {
  readonly item: Item;
  readonly failures: readonly ItemObserverFailure[];

  constructor(item: Item, failures: readonly ItemObserverFailure[]) {
    super(createObserverErrorMessage(failures), {
      cause: failures.length === 1 ? failures[0]?.cause : failures
    });
    this.name = "ItemObserverError";
    this.item = cloneItem(item);
    this.failures = failures.map((failure) => ({
      observerIndex: failure.observerIndex,
      item: cloneItem(failure.item),
      cause: failure.cause
    }));
  }
}

export type InMemoryItemListOptions = {
  readonly generateId?: IdGenerator;
  readonly clock?: Clock;
  readonly observers?: readonly ItemObserver[];
  readonly initialItems?: readonly Item[];
};

export interface ItemList {
  append(input: ItemAppendInput): Item;
  getItems(): readonly Item[];
}

export class InMemoryItemList implements ItemList {
  private readonly items: Item[] = [];
  private readonly observers: ItemObserver[] = [];
  private readonly generateId: IdGenerator;
  private readonly clock: Clock;
  private nextSeq = 1;

  constructor(options: InMemoryItemListOptions = {}) {
    this.generateId = options.generateId ?? createDefaultIdGenerator();
    this.clock = options.clock ?? Date.now;
    this.observers = [...(options.observers ?? [])];
    this.items = [...(options.initialItems ?? [])].map(cloneItem);
    this.nextSeq =
      this.items.reduce((nextSeq, item) => Math.max(nextSeq, item.seq + 1), 1);
  }

  observe(observer: ItemObserver): () => void {
    this.observers.push(observer);

    return () => {
      const index = this.observers.indexOf(observer);

      if (index >= 0) {
        this.observers.splice(index, 1);
      }
    };
  }

  append(input: ItemAppendInput): Item {
    const item: Item = {
      ...input,
      id: this.generateId(),
      createdAtMs: this.clock(),
      seq: this.nextSeq++
    };

    this.items.push(item);

    const observerFailures: ItemObserverFailure[] = [];

    this.observers.forEach((observer, observerIndex) => {
      try {
        const observerResult = observer(cloneItem(item)) as unknown;

        if (isPromiseLike(observerResult)) {
          Promise.resolve(observerResult).catch(() => undefined);
          observerFailures.push({
            observerIndex,
            item: cloneItem(item),
            cause: new TypeError(
              "Async item observers are not supported by synchronous append"
            )
          });
        }
      } catch (cause) {
        observerFailures.push({
          observerIndex,
          item: cloneItem(item),
          cause
        });
      }
    });

    if (observerFailures.length > 0) {
      throw new ItemObserverError(item, observerFailures);
    }

    return cloneItem(item);
  }

  getItems(): readonly Item[] {
    return this.items.map(cloneItem);
  }
}

function cloneItem(item: Item): Item {
  return clonePlain(item) as Item;
}

function clonePlain<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // Fall through for values like functions that cannot be structured-cloned.
    }
  }

  return clonePlainFallback(value);
}

function clonePlainFallback<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(clonePlainFallback) as T;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      clonePlainFallback(entryValue)
    ])
  ) as T;
}

function createObserverErrorMessage(
  failures: readonly ItemObserverFailure[]
): string {
  const failureCount = failures.length;

  return `${failureCount} item observer${failureCount === 1 ? "" : "s"} failed`;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function createDefaultIdGenerator(): IdGenerator {
  let nextId = 1;

  return () => {
    const randomUUID = globalThis.crypto?.randomUUID;

    return randomUUID ? randomUUID.call(globalThis.crypto) : `item-${nextId++}`;
  };
}
