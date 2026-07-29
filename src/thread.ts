import type { CanonicalItem } from "./item.js";

export type DerivedTurnStatus =
  "inProgress" | "completed" | "failed" | "interrupted";

export interface DerivedTurn {
  id: string;
  items: CanonicalItem[];
  status: DerivedTurnStatus;
}

export class Thread {
  readonly id: string;
  readonly #items: CanonicalItem[];

  constructor(id: string, items: readonly CanonicalItem[] = []) {
    this.id = id;
    this.#items = [];
    for (const item of items) {
      this.append(item);
    }
  }

  get items(): readonly CanonicalItem[] {
    return Object.freeze([...this.#items]);
  }

  append(item: CanonicalItem): void {
    if (item.threadId !== this.id) {
      throw new Error(
        `Item ${item.id} belongs to ${item.threadId}, not ${this.id}`,
      );
    }
    if (this.#items.some((existing) => existing.id === item.id)) {
      throw new Error(`Duplicate item id ${item.id}`);
    }
    this.#items.push(deepFreeze(structuredClone(item)));
  }

  deriveTurns(options: { activeTurnId?: string } = {}): DerivedTurn[] {
    const turns: DerivedTurn[] = [];
    const byId = new Map<string, DerivedTurn>();

    for (const item of this.#items) {
      if (item.turnId === undefined) {
        continue;
      }
      let turn = byId.get(item.turnId);
      if (turn === undefined) {
        turn = { id: item.turnId, items: [], status: "inProgress" };
        byId.set(item.turnId, turn);
        turns.push(turn);
      }
      turn.items.push(item);
      if (item.type === "turn_completed") {
        turn.status = item.status;
      } else if (item.type === "turn_aborted") {
        turn.status = "interrupted";
      }
    }

    for (const turn of turns) {
      if (turn.status === "inProgress" && turn.id !== options.activeTurnId) {
        turn.status = "interrupted";
      }
    }
    return turns;
  }

  latestMetadata(): CanonicalItem | undefined {
    return [...this.#items]
      .reverse()
      .find((item) => item.type === "thread_metadata");
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}
