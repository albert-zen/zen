import type {
  ApprovalPolicy,
  CanonicalProviderSelection,
  CanonicalItem,
  SandboxMode,
  ThreadMetadataItem,
} from "./item.js";
import { validateContextCompactionItem } from "./context-compaction.js";

export type DerivedTurnStatus =
  "inProgress" | "completed" | "failed" | "interrupted";

export interface DerivedTurn {
  id: string;
  items: CanonicalItem[];
  status: DerivedTurnStatus;
  selection: CanonicalProviderSelection;
  /** Compatibility projection for callers that only display a model id. */
  model: string;
}

export interface EffectiveThreadConfiguration extends CanonicalProviderSelection {
  cwd: string;
  /** Compatibility projections; canonical identity is the selection tuple. */
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

  validateAppend(item: CanonicalItem): void {
    if (item.threadId !== this.id) {
      throw new Error(
        `Item ${item.id} belongs to ${item.threadId}, not ${this.id}`,
      );
    }
    if (this.#items.some((existing) => existing.id === item.id)) {
      throw new Error(`Duplicate item id ${item.id}`);
    }
    if (item.type === "model_usage") {
      validateModelUsage(item);
    }
    if (item.type === "context_compaction") {
      validateContextCompactionItem(this.#items, item);
      const current = this.effectiveConfiguration();
      const boundaryTurn = this.deriveTurns().find((turn) =>
        turn.items.some(
          (candidate) => candidate.id === item.coveredThroughItemId,
        ),
      );
      if (
        !sameSelection(current, item) &&
        (boundaryTurn === undefined ||
          !sameSelection(boundaryTurn.selection, item))
      ) {
        throw new Error(
          "Context compaction selection must match the effective Thread or covered Turn selection",
        );
      }
    }
    if (item.type === "thread_configuration_changed") {
      const current = this.effectiveConfiguration();
      if ("selection" in item) {
        if (!sameSelection(current, item.selection.from)) {
          throw new Error("Stale provider selection change");
        }
        if (sameSelection(item.selection.from, item.selection.to)) {
          throw new Error(
            "Provider selection change must change configuration",
          );
        }
      } else {
        if (current.modelId !== item.model.from) {
          throw new Error(
            `Stale model change from ${item.model.from}; current model is ${current.modelId}`,
          );
        }
        if (item.model.from === item.model.to) {
          throw new Error("Model change must change the effective model");
        }
      }
    }
  }

  append(item: CanonicalItem): void {
    this.validateAppend(item);
    this.#items.push(deepFreeze(structuredClone(item)));
  }

  deriveTurns(options: { activeTurnId?: string } = {}): DerivedTurn[] {
    const turns: DerivedTurn[] = [];
    const byId = new Map<string, DerivedTurn>();
    let configuration: EffectiveThreadConfiguration | undefined;

    for (const item of this.#items) {
      if (isConfigurationItem(item)) {
        configuration = applyConfigurationItem(this.id, configuration, item);
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
        const turnSelection =
          item.type === "turn_started" && item.selection !== undefined
            ? item.selection
            : selectionFrom(configuration);
        turn = {
          id: item.turnId,
          items: [],
          status: "inProgress",
          selection: selectionFrom(turnSelection),
          model: turnSelection.modelId,
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

  effectiveConfiguration(): EffectiveThreadConfiguration {
    let configuration: EffectiveThreadConfiguration | undefined;
    for (const item of this.#items) {
      if (isConfigurationItem(item)) {
        configuration = applyConfigurationItem(this.id, configuration, item);
      }
    }
    if (configuration === undefined) {
      throw new Error(`Thread ${this.id} has no metadata item`);
    }
    return configuration;
  }
}

function validateModelUsage(
  item: Extract<CanonicalItem, { type: "model_usage" }>,
): void {
  if (item.modelResponseId.length === 0) {
    throw new Error("Model usage requires a model response id");
  }
  for (const [name, value] of [
    ["inputTokens", item.inputTokens],
    ["outputTokens", item.outputTokens],
    ["cachedInputTokens", item.cachedInputTokens],
    ["reasoningOutputTokens", item.reasoningOutputTokens],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Model usage ${name} must be a non-negative integer`);
    }
  }
  if (
    item.cachedInputTokens !== undefined &&
    item.cachedInputTokens > item.inputTokens
  ) {
    throw new Error("Cached input tokens cannot exceed total input tokens");
  }
  if (
    item.reasoningOutputTokens !== undefined &&
    item.reasoningOutputTokens > item.outputTokens
  ) {
    throw new Error("Reasoning output tokens cannot exceed output tokens");
  }
}

type ConfigurationItem = Extract<
  CanonicalItem,
  { type: "thread_metadata" | "thread_configuration_changed" }
>;

function isConfigurationItem(item: CanonicalItem): item is ConfigurationItem {
  return (
    item.type === "thread_metadata" ||
    item.type === "thread_configuration_changed"
  );
}

function applyConfigurationItem(
  threadId: string,
  configuration: EffectiveThreadConfiguration | undefined,
  item: ConfigurationItem,
): EffectiveThreadConfiguration {
  if (item.type === "thread_metadata") {
    return configurationFromMetadata(item);
  }
  if (configuration === undefined) {
    throw new Error(`Thread ${threadId} changed configuration before metadata`);
  }
  if ("selection" in item) {
    if (!sameSelection(configuration, item.selection.from)) {
      throw new Error(
        `Thread ${threadId} has a stale provider selection change`,
      );
    }
    return configurationWithSelection(configuration, item.selection.to);
  }
  if (configuration.modelId !== item.model.from) {
    throw new Error(
      `Thread ${threadId} has a stale model change from ${item.model.from}`,
    );
  }
  return configurationWithSelection(configuration, {
    ...selectionFrom(configuration),
    modelId: item.model.to,
  });
}

function configurationFromMetadata(
  item: ThreadMetadataItem,
): EffectiveThreadConfiguration {
  const selection: CanonicalProviderSelection =
    "providerProfileId" in item
      ? {
          providerProfileId: item.providerProfileId,
          modelId: item.modelId,
          reasoningEffort: item.reasoningEffort,
        }
      : {
          providerProfileId: item.provider,
          modelId: item.model,
          reasoningEffort: "medium",
        };
  return {
    cwd: item.cwd,
    ...selection,
    model: selection.modelId,
    provider: selection.providerProfileId,
    sandbox: item.sandbox,
    approvalPolicy: item.approvalPolicy,
  };
}

function configurationWithSelection(
  configuration: EffectiveThreadConfiguration,
  selection: CanonicalProviderSelection,
): EffectiveThreadConfiguration {
  return {
    ...configuration,
    ...selection,
    model: selection.modelId,
    provider: selection.providerProfileId,
  };
}

function selectionFrom(
  configuration: CanonicalProviderSelection,
): CanonicalProviderSelection {
  return {
    providerProfileId: configuration.providerProfileId,
    modelId: configuration.modelId,
    reasoningEffort: configuration.reasoningEffort,
  };
}

function sameSelection(
  left: CanonicalProviderSelection,
  right: CanonicalProviderSelection,
): boolean {
  return (
    left.providerProfileId === right.providerProfileId &&
    left.modelId === right.modelId &&
    left.reasoningEffort === right.reasoningEffort
  );
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
