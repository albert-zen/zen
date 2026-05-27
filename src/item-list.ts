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

export type InMemoryItemListOptions = {
  readonly generateId?: IdGenerator;
  readonly clock?: Clock;
};

export interface ItemList {
  append(input: ItemAppendInput): Item;
  getItems(): readonly Item[];
}

export class InMemoryItemList implements ItemList {
  private readonly items: Item[] = [];
  private readonly generateId: IdGenerator;
  private readonly clock: Clock;
  private nextSeq = 1;

  constructor(options: InMemoryItemListOptions = {}) {
    this.generateId = options.generateId ?? createDefaultIdGenerator();
    this.clock = options.clock ?? Date.now;
  }

  append(input: ItemAppendInput): Item {
    const item: Item = {
      ...input,
      id: this.generateId(),
      createdAtMs: this.clock(),
      seq: this.nextSeq++
    };

    this.items.push(item);

    return cloneItem(item);
  }

  getItems(): readonly Item[] {
    return this.items.map(cloneItem);
  }
}

function cloneItem(item: Item): Item {
  const cloned = { ...item };

  if (item.meta) {
    cloned.meta = { ...item.meta };
  }

  return cloned;
}

function createDefaultIdGenerator(): IdGenerator {
  let nextId = 1;

  return () => {
    const randomUUID = globalThis.crypto?.randomUUID;

    return randomUUID ? randomUUID.call(globalThis.crypto) : `item-${nextId++}`;
  };
}
