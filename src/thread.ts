import type {
  ApprovalPolicy,
  CanonicalProviderSelection,
  CanonicalItem,
  SandboxMode,
  ThreadMetadataItem,
  ThreadDeletedItem,
} from "./item.js";
import {
  isAgenticContextCompaction,
  validateContextCompactionItem,
} from "./context-compaction.js";
import { codeStateFromItems, validateCodeStateWrite } from "./code-state.js";

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

  /** Only a trailing tombstone is deleted; only exact restoration can follow it. */
  get deletion(): ThreadDeletedItem | undefined {
    const last = this.#items.at(-1);
    return last?.type === "thread_deleted" ? last : undefined;
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
    const metadata = this.#items[0];
    if (
      metadata?.type === "thread_metadata" &&
      metadata.purpose !== undefined &&
      [
        "turn_started",
        "turn_completed",
        "turn_aborted",
        "turn_replacement_requested",
        "user_message",
        "user_message_queued",
        "user_message_queue_edited",
        "host_message",
        "host_message_queued",
        "thread_message",
        "thread_message_queued",
        "agent_message",
        "reasoning",
        "tool_call",
        "tool_result",
        "failure",
        "context_compaction",
      ].includes(item.type)
    )
      throw new Error(
        "System model-operation history cannot accept conversation messages",
      );
    const deletion = this.deletion;
    if (deletion !== undefined && item.type !== "thread_restored") {
      throw new Error(
        `Thread ${this.id} is deleted; restore it before appending`,
      );
    }
    if (item.type === "thread_deleted" && this.#items.length === 0) {
      throw new Error("Cannot delete a Thread without its canonical history");
    }
    if (
      item.type === "thread_restored" &&
      deletion?.id !== item.deletionItemId
    ) {
      throw new Error("Restoration must reference the current deletion Item");
    }
    if (
      (item.type === "turn_completed" || item.type === "turn_aborted") &&
      this.#items.some(
        (existing) =>
          existing.turnId === item.turnId &&
          (existing.type === "turn_completed" ||
            existing.type === "turn_aborted"),
      )
    ) {
      throw new Error(`Turn ${item.turnId} already has a terminal Item`);
    }
    if (
      item.type === "context_format" &&
      this.#items.some((prior) => prior.type === "context_format")
    )
      throw new Error("Duplicate canonical content format marker");
    if (item.type === "model_operation") {
      const sources = item.sourceItemIds.map((id) =>
        this.#items.find((source) => source.id === id),
      );
      if (
        sources.length !== 1 ||
        !sources[0] ||
        sources[0].type === "model_operation_completed"
      )
        throw new Error(
          "Model operation requires one earlier canonical source",
        );
      if (item.kind === "title" && sources[0].type !== "user_message")
        throw new Error("Title operation requires a human message source");
      if (
        item.kind === "image-capability-probe" &&
        !(
          sources[0].type === "thread_metadata" &&
          sources[0].purpose === "image-capability-probe"
        )
      )
        throw new Error(
          "Image probe requires trusted operation Thread provenance",
        );
      if (!this.#items.some((prior) => prior.type === "context_format"))
        throw new Error(
          "Model operation requires the canonical content format gate",
        );
    }
    if (item.type === "model_operation_completed") {
      const operation = this.#items.find(
        (source) => source.id === item.operationItemId,
      );
      if (operation?.type !== "model_operation")
        throw new Error("Operation result requires its preceding admission");
      if (
        this.#items.some(
          (prior) =>
            prior.type === "model_operation_completed" &&
            prior.operationItemId === item.operationItemId,
        )
      )
        throw new Error("Model operation already has a terminal result");
      if (
        item.status === "completed" &&
        (item.error !== undefined || item.incomplete !== undefined)
      )
        throw new Error(
          "Completed model operation cannot carry a failure diagnostic",
        );
      if (
        item.status !== "completed" &&
        item.content !== undefined &&
        item.incomplete !== true
      )
        throw new Error("Partial model output requires incomplete provenance");
      if (item.content?.some((part) => part.type !== "text"))
        throw new Error(
          "Auxiliary result must contain only observed model text",
        );
      if (item.probeOutcome === "supported" && item.status !== "completed")
        throw new Error("Supported probe requires successful completion");
      if (item.probeOutcome === "unsupported" && item.status !== "failed")
        throw new Error("Unsupported probe requires a failed response");
      if (
        item.probeOutcome !== undefined &&
        operation.kind !== "image-capability-probe"
      )
        throw new Error("Probe outcome requires an image probe operation");
    }
    if (item.type === "context_message") {
      const sources = item.sourceItemIds.map((id) =>
        this.#items.find((source) => source.id === id),
      );
      if (
        !sources.length ||
        sources.some(
          (source) => source === undefined || source.type === "context_message",
        )
      )
        throw new Error(
          "Context content requires preceding canonical source facts",
        );
      if (
        item.role === "tool" &&
        !sources.some((source) => source?.type === "tool_result")
      )
        throw new Error("Tool context must retain its tool result source");
      if (
        item.role === "system" &&
        (item.origin !== "host" ||
          item.purpose !== "provider-instructions" ||
          sources.length !== 1 ||
          !(
            sources[0]?.type === "turn_started" ||
            sources[0]?.type === "thread_metadata" ||
            sources[0]?.type === "model_operation" ||
            (sources[0]?.type === "thread_configuration_changed" &&
              !("permissions" in sources[0]))
          ))
      )
        throw new Error(
          "Only explicit provider instructions may use system context",
        );
      const first = sources[0];
      const generatedPurposes = new Set([
        "provider-instructions",
        "auxiliary-title",
        "auxiliary-image-probe",
        "workspace-instructions",
        "compaction-summary",
        "file-permissions",
        "compaction-notice",
        "compaction-instruction",
        "compaction-excerpt",
      ]);
      if (item.purpose !== first?.type && !generatedPurposes.has(item.purpose))
        throw new Error("Unknown canonical context purpose");
      if (
        generatedPurposes.has(item.purpose) &&
        item.purpose !== "provider-instructions" &&
        (item.origin !== "host" || item.role !== "user")
      )
        throw new Error(
          "Generated context must retain Host user-role provenance",
        );
      if (
        item.purpose === "auxiliary-title" ||
        item.purpose === "auxiliary-image-probe"
      ) {
        if (
          first?.type !== "model_operation" ||
          (item.purpose === "auxiliary-title"
            ? first.kind !== "title"
            : first.kind !== "image-capability-probe")
        )
          throw new Error(
            "Auxiliary context requires its matching operation admission",
          );
        const expectedSources =
          first.kind === "title"
            ? [first.id, ...first.sourceItemIds]
            : [first.id];
        if (
          JSON.stringify(item.sourceItemIds) !== JSON.stringify(expectedSources)
        )
          throw new Error(
            "Auxiliary context must preserve the exact admitted source binding",
          );
      }
      if (
        item.purpose === "workspace-instructions" &&
        !(
          first?.type === "turn_started" || first?.type === "context_compaction"
        )
      )
        throw new Error("Workspace context requires its instruction snapshot");
      if (
        item.purpose === "compaction-summary" &&
        first?.type !== "context_compaction"
      )
        throw new Error("Compaction summary requires its source fact");
      if (
        item.purpose === "file-permissions" &&
        !(
          first?.type === "thread_metadata" ||
          first?.type === "thread_configuration_changed"
        )
      )
        throw new Error("File permissions require a canonical policy fact");
      const expected =
        first?.type === "user_message"
          ? ["human", "user"]
          : first?.type === "thread_message"
            ? ["agent", "user"]
            : first?.type === "agent_message"
              ? ["model", "assistant"]
              : first?.type === "tool_result"
                ? ["tool", "tool"]
                : first?.type === "reasoning"
                  ? ["model", "reasoning"]
                  : undefined;
      if (
        item.purpose === first?.type &&
        expected === undefined &&
        (item.origin !== "host" ||
          !(
            item.role === "user" ||
            (first?.type === "failure" && item.role === "assistant")
          ))
      )
        throw new Error("Host context cannot change source authority");
      if (
        item.purpose === first?.type &&
        expected &&
        (item.origin !== expected[0] || item.role !== expected[1])
      )
        throw new Error(
          "Canonical content cannot change source role or authority",
        );
      if (
        (item.purpose === "compaction-excerpt" ||
          item.purpose === "compaction-instruction" ||
          item.purpose === "compaction-notice") &&
        (item.origin !== "host" || item.role !== "user")
      )
        throw new Error("Compaction context cannot promote source authority");
      if (item.origin === "human" && sources[0]?.type !== "user_message")
        throw new Error("Non-human context cannot claim human provenance");
      if (item.origin === "agent" && sources[0]?.type !== "thread_message")
        throw new Error("Agent context requires verified source provenance");
      if (
        sources[0]?.type === "thread_message" &&
        item.origin !== "agent" &&
        item.purpose !== "compaction-excerpt"
      )
        throw new Error("Agent source cannot be promoted to another origin");
      const key = (value: typeof item) =>
        JSON.stringify([
          value.sourceItemIds,
          value.role,
          value.origin,
          value.purpose,
          value.compilerPolicyVersion,
          value.variant,
        ]);
      if (
        this.#items.some(
          (prior) =>
            prior.type === "context_message" && key(prior) === key(item),
        )
      )
        throw new Error("Duplicate canonical context materialization");
    }
    if (item.type === "failure" && item.recovery !== undefined) {
      const recovery = item.recovery;
      const previous = this.#items.filter(
        (existing) =>
          existing.type === "failure" &&
          existing.turnId === item.turnId &&
          existing.recovery !== undefined,
      );
      const boundary = this.#items.findIndex(
        (existing) => existing.id === recovery.contextBoundaryItemId,
      );
      if (
        recovery.attempt !== previous.length + 1 ||
        recovery.attempt > 3 ||
        boundary < 0 ||
        recovery.sampleAttempt < 2 ||
        recovery.sampleAttempt > 3 ||
        this.#items.some(
          (existing) =>
            existing.turnId === item.turnId &&
            (existing.type === "turn_completed" ||
              existing.type === "turn_aborted"),
        )
      )
        throw new Error("Invalid recovery attempt or context boundary");
      if (recovery.publicPartial !== undefined) {
        const sourceIndex = this.#items.findIndex(
          (existing) => existing.id === recovery.sampleId,
        );
        const source = this.#items[sourceIndex];
        if (
          sourceIndex <= boundary ||
          source?.type !== "agent_message" ||
          source.turnId !== item.turnId ||
          source.incomplete !== true ||
          ("contentVisibility" in source &&
            source.contentVisibility !== "public")
        )
          throw new Error(
            "Recovery draft must reference this failed sample public incomplete message",
          );
      }
      const seen = new Set<string>();
      for (const occurrence of recovery.withheldMedia) {
        const index = this.#items.findIndex(
          (existing) => existing.id === occurrence.itemId,
        );
        const source = this.#items[index];
        const content =
          source?.type === "user_message" && occurrence.field === "content"
            ? source.content
            : source?.type === "tool_result" &&
                occurrence.field === "modelContent"
              ? source.modelContent
              : undefined;
        const part = content?.[occurrence.partIndex];
        const key = JSON.stringify([
          occurrence.itemId,
          occurrence.field,
          occurrence.partIndex,
        ]);
        if (
          index < 0 ||
          index > boundary ||
          part === undefined ||
          part.type === "text" ||
          part.attachment.sha256 !== occurrence.sha256 ||
          seen.has(key)
        )
          throw new Error(
            "Recovery media must reference an exact earlier canonical occurrence",
          );
        seen.add(key);
      }
    }
    if (item.type === "model_usage") {
      validateModelUsage(item);
    }
    if (item.type === "code_state") {
      if (
        !this.#items.some(
          (parent) =>
            parent.type === "tool_call" &&
            parent.name === "run_code" &&
            parent.callId === item.callId &&
            parent.turnId === item.turnId,
        )
      )
        throw new Error(
          "Code state requires an earlier run_code call in this Turn",
        );
      validateCodeStateWrite(
        codeStateFromItems(this.#items),
        item.key,
        item.value,
      );
    }
    if (item.type === "tool_call" && item.parentCallId !== undefined) {
      if (
        typeof item.parentCallId !== "string" ||
        item.parentCallId.length === 0
      ) {
        throw new Error("Nested tool call requires a non-empty parentCallId");
      }
      if (item.parentCallId === item.callId) {
        throw new Error("Nested tool call cannot be its own parent");
      }
      const parents = this.#items.filter(
        (
          candidate,
        ): candidate is Extract<CanonicalItem, { type: "tool_call" }> =>
          candidate.type === "tool_call" &&
          candidate.turnId === item.turnId &&
          candidate.callId === item.parentCallId,
      );
      if (parents.length !== 1) {
        throw new Error(
          `Nested tool call must have exactly one earlier parent in this Turn: ${item.parentCallId}`,
        );
      }
      if (parents[0]?.name !== "run_code") {
        throw new Error("Nested tool call requires a run_code parent");
      }
    }
    if (item.type === "context_compaction") {
      validateContextCompactionItem(this.#items, item);
      if (isAgenticContextCompaction(item)) return;
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
      if ("permissions" in item) {
        if (
          current.sandbox !== item.permissions.from.sandbox ||
          current.approvalPolicy !== item.permissions.from.approvalPolicy
        )
          throw new Error("Stale permission change");
        if (
          current.sandbox === item.permissions.to.sandbox &&
          current.approvalPolicy === item.permissions.to.approvalPolicy
        )
          throw new Error("Permission change must change configuration");
      } else if ("selection" in item) {
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
  if ("permissions" in item) {
    if (
      configuration.sandbox !== item.permissions.from.sandbox ||
      configuration.approvalPolicy !== item.permissions.from.approvalPolicy
    )
      throw new Error(`Thread ${threadId} has a stale permission change`);
    return { ...configuration, ...item.permissions.to };
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
