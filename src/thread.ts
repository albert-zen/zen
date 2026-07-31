import type {
  ApprovalPolicy,
  CanonicalItem,
  SandboxMode,
  ThreadMetadataItem,
} from "./item.js";

export type DerivedTurnStatus =
  "inProgress" | "completed" | "failed" | "interrupted";

export interface DerivedTurn {
  id: string;
  items: CanonicalItem[];
  status: DerivedTurnStatus;
  model: string;
}

export interface EffectiveThreadConfiguration {
  cwd: string;
  model: string;
  provider: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
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
    if (item.type === "thread_configuration_changed") {
      const current = this.effectiveConfiguration();
      if (current.model !== item.model.from) {
        throw new Error(
          `Stale model change from ${item.model.from}; current model is ${current.model}`,
        );
      }
      if (item.model.from === item.model.to) {
        throw new Error("Model change must change the effective model");
      }
    }
    this.#items.push(deepFreeze(structuredClone(item)));
  }

  deriveTurns(options: { activeTurnId?: string } = {}): DerivedTurn[] {
    const turns: DerivedTurn[] = [];
    const byId = new Map<string, DerivedTurn>();
    let configuration: EffectiveThreadConfiguration | undefined;

    for (const item of this.#items) {
      if (item.type === "thread_metadata") {
        configuration = configurationFromMetadata(item);
        continue;
      }
      if (item.type === "thread_configuration_changed") {
        if (configuration === undefined) {
          throw new Error(
            `Thread ${this.id} changed configuration before metadata`,
          );
        }
        configuration = { ...configuration, model: item.model.to };
        continue;
      }
      if (item.turnId === undefined) {
        continue;
      }
      let turn = byId.get(item.turnId);
      if (turn === undefined) {
        if (configuration === undefined) {
          throw new Error(`Thread ${this.id} has a Turn before metadata`);
        }
        turn = {
          id: item.turnId,
          items: [],
          status: "inProgress",
          model: configuration.model,
        };
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

  effectiveConfiguration(): EffectiveThreadConfiguration {
    let configuration: EffectiveThreadConfiguration | undefined;
    for (const item of this.#items) {
      if (item.type === "thread_metadata") {
        configuration = configurationFromMetadata(item);
      } else if (item.type === "thread_configuration_changed") {
        if (configuration === undefined) {
          throw new Error(
            `Thread ${this.id} changed configuration before metadata`,
          );
        }
        if (configuration.model !== item.model.from) {
          throw new Error(
            `Thread ${this.id} has a stale model change from ${item.model.from}`,
          );
        }
        configuration = { ...configuration, model: item.model.to };
      }
    }
    if (configuration === undefined) {
      throw new Error(`Thread ${this.id} has no metadata item`);
    }
    return configuration;
  }
}

function configurationFromMetadata(
  item: ThreadMetadataItem,
): EffectiveThreadConfiguration {
  return {
    cwd: item.cwd,
    model: item.model,
    provider: item.provider,
    sandbox: item.sandbox,
    approvalPolicy: item.approvalPolicy,
  };
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
