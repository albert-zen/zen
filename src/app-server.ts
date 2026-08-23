import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  AttachmentStoreError,
  InMemoryAttachmentStore,
  type AttachmentRef,
  type AttachmentStore,
} from "./attachment.js";
import {
  CONTEXT_COMPACTION_ALGORITHM_VERSION,
  CONTEXT_COMPACTION_SUMMARY_INSTRUCTION,
  latestCompaction,
  latestEligibleCompactionBoundary,
} from "./context-compaction.js";
import type {
  AgentMessageItem,
  ApprovalPolicy,
  CanonicalItem,
  ContextCompactionItem,
  SandboxMode,
  ThreadConfigurationChangedItem,
  ThreadMetadataItem,
  TurnAbortedItem,
  TurnCompletedItem,
  TurnReplacementRequestedItem,
  UserInput,
  UserMessageItem,
} from "./item.js";
import {
  contentFromUserMessage,
  normalizeUserInput,
  previewFromUserMessage,
  sameUserInput,
} from "./item.js";
import type { ThreadJournal } from "./journal.js";
import {
  compileModelMessages,
  type ModelAdapter,
  type ModelEvent,
  type ModelMessage,
} from "./model.js";
import {
  ProviderRegistryError,
  type ProviderModel,
  type ProviderRegistry,
  type ResolvedProviderSelection,
  type ProviderSelection,
  type ProviderSelectionInput,
} from "./provider-registry.js";
import { AgentRuntime, type RuntimeEvent } from "./runtime.js";
import {
  Thread,
  type DerivedTurn,
  type EffectiveThreadConfiguration,
} from "./thread.js";
import {
  normalizeThreadName,
  type ThreadProductMetadata,
  type ThreadMetadataStore,
} from "./thread-metadata.js";
import {
  InMemoryThreadSummaryProjection,
  type NativeThreadSummary,
  type ThreadSummary,
  type ThreadSummaryListOptions,
  type ThreadSummaryProjection,
  type UnavailableThreadSummary,
} from "./thread-summary.js";
import type { ApprovalHandler } from "./tool.js";

export interface AppServerDefaults {
  cwd: string;
  providerProfileId: string;
  modelId: string;
  reasoningEffort: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
}

export interface StartThreadInput {
  cwd?: string;
  selection?: ProviderSelectionInput;
  /** Compatibility input for single-profile Core callers. */
  model?: string;
  reasoningEffort?: string;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
}

export interface ThreadSnapshot {
  id: string;
  items: readonly CanonicalItem[];
  turns: DerivedTurn[];
  cwd: string;
  providerProfileId: string;
  modelId: string;
  reasoningEffort: string;
  /** Compatibility projections for existing product callers. */
  model: string;
  provider: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  name?: string;
  archived: boolean;
}

export interface UnavailableThreadSnapshot {
  id: string;
  status: "systemError";
  error: string;
  name?: string;
  archived: boolean;
}

export type ThreadListEntry = ThreadSnapshot | UnavailableThreadSnapshot;

export interface TurnHandle {
  id: string;
  done: Promise<void>;
}

export interface CompactThreadOptions {
  signal?: AbortSignal;
}

export interface CompactThreadResult {
  compactionItemId: string;
}

export interface SteerTurnOptions {
  clientId?: string;
}

export interface ReplaceTurnOptions {
  clientId: string;
  requestApproval?: ApprovalHandler;
}

export interface ReplaceTurnResult {
  interruptedTurnId: string;
  turn: TurnHandle;
}

export interface ThreadSettingsUpdatedEvent {
  type: "thread_settings_updated";
  threadId: string;
  settings: EffectiveThreadConfiguration;
}

export interface ThreadNameUpdatedEvent {
  type: "thread_name_updated";
  threadId: string;
  name: string;
}

export interface ThreadArchivedUpdatedEvent {
  type: "thread_archived_updated";
  threadId: string;
  archived: boolean;
}

export type AppServerEvent =
  | RuntimeEvent
  | ThreadSettingsUpdatedEvent
  | ThreadNameUpdatedEvent
  | ThreadArchivedUpdatedEvent;

export interface UpdateThreadSettingsInput {
  selection?: ProviderSelectionInput;
  /** Compatibility input for single-profile Core callers. */
  model?: string;
  reasoningEffort?: string;
}

export interface ListedProviderModel extends ProviderModel {
  isDefault: boolean;
}

export class ZenAppServer {
  readonly #attachments: AttachmentStore;
  readonly #journal: ThreadJournal;
  readonly #runtime: AgentRuntime;
  readonly #providerRegistry: ProviderRegistry;
  readonly #threadMetadata: ThreadMetadataStore;
  readonly #threadSummaryProjection: ThreadSummaryProjection;
  readonly #defaults: AppServerDefaults;
  readonly #id: () => string;
  readonly #now: () => string;
  readonly #threads = new Map<string, Thread>();
  readonly #activeTurns = new Map<
    string,
    {
      turnId: string;
      controller: AbortController;
      done: Promise<void>;
      inputModalities: readonly string[] | null;
      deliveryAnchorId?: string;
    }
  >();
  readonly #subscribers = new Set<(event: AppServerEvent) => void>();
  readonly #mutationChains = new Map<string, Promise<void>>();
  readonly #replacementOperations = new Map<
    string,
    { clientId: string; result: Promise<ReplaceTurnResult> }
  >();
  #threadSummaries: Map<string, NativeThreadSummary> | undefined;
  #threadSummaryLoad: Promise<void> | undefined;
  #threadSummaryWrites: Promise<void> = Promise.resolve();

  constructor(options: {
    journal: ThreadJournal;
    attachments?: AttachmentStore;
    runtime: AgentRuntime;
    providerRegistry: ProviderRegistry;
    threadMetadata: ThreadMetadataStore;
    threadSummaryProjection?: ThreadSummaryProjection;
    defaults: AppServerDefaults;
    idFactory?: () => string;
    now?: () => string;
  }) {
    this.#journal = options.journal;
    this.#attachments = options.attachments ?? new InMemoryAttachmentStore();
    this.#runtime = options.runtime;
    this.#providerRegistry = options.providerRegistry;
    this.#threadMetadata = options.threadMetadata;
    this.#threadSummaryProjection =
      options.threadSummaryProjection ?? new InMemoryThreadSummaryProjection();
    this.#defaults = {
      ...options.defaults,
      cwd: path.resolve(options.defaults.cwd),
    };
    this.#id = options.idFactory ?? randomUUID;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#requireSelection(this.#defaults);
  }

  subscribe(listener: (event: AppServerEvent) => void): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  listModels(): readonly ListedProviderModel[] {
    return this.#providerRegistry.listModels().map((entry) => ({
      ...entry,
      isDefault:
        entry.providerProfileId === this.#defaults.providerProfileId &&
        entry.model.id === this.#defaults.modelId,
    }));
  }

  completeProviderSelection(
    current: ProviderSelection,
    input: ProviderSelectionInput,
  ): ProviderSelection {
    return this.#requireSelection(input, current.reasoningEffort).selection;
  }

  async startThread(input: StartThreadInput = {}): Promise<ThreadSnapshot> {
    const threadId = this.#id();
    const thread = new Thread(threadId);
    const selection = this.#selectionFromInput(this.#defaults, input);
    this.#requireSelection(selection);
    const metadata: ThreadMetadataItem = {
      id: this.#id(),
      threadId,
      createdAt: this.#now(),
      type: "thread_metadata",
      cwd: path.resolve(input.cwd ?? this.#defaults.cwd),
      ...selection,
      sandbox: input.sandbox ?? this.#defaults.sandbox,
      approvalPolicy: input.approvalPolicy ?? this.#defaults.approvalPolicy,
    };
    await this.#commit(thread, metadata);
    this.#threads.set(threadId, thread);
    return await this.#snapshot(thread);
  }

  async listThreads(
    options: { archived?: boolean } = {},
  ): Promise<ThreadListEntry[]> {
    const threadIds = await this.#journal.listThreadIds();
    const snapshots: ThreadListEntry[] = [];
    for (const threadId of threadIds) {
      try {
        const thread = await this.#loadThread(threadId);
        if (thread !== undefined) {
          snapshots.push(
            await this.#snapshot(
              thread,
              this.#activeTurns.get(threadId)?.turnId,
            ),
          );
        }
      } catch (error) {
        console.warn(`Could not load Thread ${threadId}`, error);
        snapshots.push(await this.#unavailableSnapshot(threadId, error));
      }
    }
    const archived = options.archived ?? false;
    return snapshots.filter((snapshot) => snapshot.archived === archived);
  }

  async listThreadSummaries(
    options: ThreadSummaryListOptions = {},
  ): Promise<NativeThreadSummary[]> {
    await this.#ensureThreadSummaries();
    const archived = options.archived ?? false;
    return structuredClone(
      [...this.#threadSummaries!.values()]
        .filter((summary) => summary.archived === archived)
        .sort((left, right) => left.threadId.localeCompare(right.threadId)),
    );
  }

  async readThread(threadId: string): Promise<ThreadSnapshot> {
    const thread = await this.#requireThread(threadId);
    return await this.#snapshot(
      thread,
      this.#activeTurns.get(threadId)?.turnId,
    );
  }

  async updateThreadSettings(
    threadId: string,
    input: UpdateThreadSettingsInput,
  ): Promise<ThreadSnapshot> {
    return await this.#withThreadMutation(threadId, async () => {
      const thread = await this.#requireThread(threadId);
      const current = thread.effectiveConfiguration();
      const selection = this.#selectionFromInput(current, input);
      if (sameSelection(selection, current)) {
        return await this.#snapshot(
          thread,
          this.#activeTurns.get(threadId)?.turnId,
        );
      }
      this.#requireSelection(selection);
      return await this.#updateThreadSettingsUnlocked(thread, { selection });
    });
  }

  async setThreadName(
    threadId: string,
    requestedName: string,
  ): Promise<ThreadSnapshot> {
    return await this.#withThreadMutation(threadId, async () => {
      const thread = await this.#requireThread(threadId);
      let name: string;
      try {
        name = normalizeThreadName(requestedName);
      } catch (error) {
        throw new AppServerError(
          "invalid_request",
          error instanceof Error ? error.message : String(error),
        );
      }
      await this.#ensureThreadSummaries();
      await this.#threadMetadata.setName(threadId, name);
      await this.#refreshThreadSummary(thread);
      this.#emit({ type: "thread_name_updated", threadId, name });
      return await this.#snapshot(
        thread,
        this.#activeTurns.get(threadId)?.turnId,
      );
    });
  }

  async setThreadArchived(
    threadId: string,
    archived: boolean,
  ): Promise<ThreadSnapshot> {
    return await this.#withThreadMutation(threadId, async () => {
      const thread = await this.#requireThread(threadId);
      const current = await this.#threadMetadata.read(threadId);
      if ((current.archived ?? false) === archived) {
        return await this.#snapshot(
          thread,
          this.#activeTurns.get(threadId)?.turnId,
        );
      }
      const active = this.#activeTurns.get(threadId);
      if (
        archived &&
        ((active !== undefined && !this.#isTerminal(thread, active.turnId)) ||
          this.#pendingReplacement(thread) !== undefined)
      ) {
        throw new AppServerError(
          "thread_busy",
          `Thread ${threadId} already has a running turn`,
        );
      }
      await this.#threadMetadata.setArchived(threadId, archived);
      await this.#refreshThreadSummary(thread);
      this.#emit({
        type: "thread_archived_updated",
        threadId,
        archived,
      });
      return await this.#snapshot(
        thread,
        this.#activeTurns.get(threadId)?.turnId,
      );
    });
  }

  async startTurn(
    threadId: string,
    input: string | UserInput,
    options: {
      clientId?: string;
      selection?: ProviderSelectionInput;
      model?: string;
      requestApproval?: ApprovalHandler;
    } = {},
  ): Promise<TurnHandle> {
    return await this.#launchTurn(threadId, input, options);
  }

  async compactThread(
    threadId: string,
    options: CompactThreadOptions = {},
  ): Promise<CompactThreadResult> {
    return await this.#withThreadMutation(threadId, async () => {
      const signal = options.signal ?? new AbortController().signal;
      if (signal.aborted) {
        throw new AppServerError(
          "compaction_aborted",
          describeCompactionError(
            signal.reason,
            "Context compaction was aborted",
          ),
        );
      }
      const thread = await this.#requireThread(threadId);
      if (this.#activeTurns.has(threadId)) {
        throw new AppServerError(
          "thread_busy",
          `Thread ${threadId} already has a running turn`,
        );
      }

      let boundary: ReturnType<typeof latestEligibleCompactionBoundary>;
      try {
        boundary = latestEligibleCompactionBoundary(thread.items);
      } catch (error) {
        throw new AppServerError(
          "compaction_incomplete_turn",
          describeCompactionError(error, "Thread has an incomplete Turn"),
        );
      }
      if (boundary === undefined) {
        throw new AppServerError(
          "compaction_not_available",
          `Thread ${threadId} has no eligible completed Turn boundary`,
        );
      }
      const previous = latestCompaction(thread.items);
      if (previous?.coveredThroughItemId === boundary.item.id) {
        throw new AppServerError(
          "compaction_not_available",
          `Thread ${threadId} is already compacted through its latest eligible boundary`,
        );
      }

      const configuration = thread.effectiveConfiguration();
      const resolved = this.#requireSelection(configuration);
      const item = await this.#appendContextCompaction({
        thread,
        boundary,
        selection: resolved,
        signal,
      });
      return { compactionItemId: item.id };
    });
  }

  async importLocalImage(filename: string): Promise<AttachmentRef> {
    try {
      return await this.#attachments.importLocalImage(filename);
    } catch (error) {
      throw attachmentAppServerError(error);
    }
  }

  async importImageBytes(
    bytes: Uint8Array,
    declaredMediaType?: string,
  ): Promise<AttachmentRef> {
    try {
      return await this.#attachments.importBytes(bytes, declaredMediaType);
    } catch (error) {
      throw attachmentAppServerError(error);
    }
  }

  async #launchTurn(
    threadId: string,
    requestedInput: string | UserInput,
    options: {
      clientId?: string;
      selection?: ProviderSelectionInput;
      model?: string;
      requestApproval?: ApprovalHandler;
    },
    internal: {
      turnId?: string;
      replacementClientId?: string;
    } = {},
  ): Promise<TurnHandle> {
    const input = normalizeAppServerInput(requestedInput, "Turn");
    const launch = await this.#withThreadMutation(threadId, async () => {
      const thread = await this.#requireThread(threadId);
      const predecessor = this.#activeTurns.get(threadId);
      if (predecessor !== undefined) {
        if (!this.#isTerminal(thread, predecessor.turnId)) {
          throw new AppServerError(
            "thread_busy",
            `Thread ${threadId} already has a running turn`,
          );
        }
        // A terminal Item is externally observable before the execution
        // handle's finalizer removes it. Preserve idle => startable semantics
        // by awaiting that exact predecessor instead of racing its finalizer.
        // The predecessor's caller owns its outcome; admission needs only
        // outcome-neutral writer quiescence after canonical terminal state.
        await Promise.allSettled([predecessor.done]);
      }
      const pendingReplacement = this.#pendingReplacement(thread);
      if (
        pendingReplacement !== undefined &&
        (internal.replacementClientId !== pendingReplacement.clientId ||
          internal.turnId !== pendingReplacement.successorTurnId)
      ) {
        throw new AppServerError(
          "replacement_pending",
          `Thread ${threadId} has an unfinished replacement operation`,
        );
      }
      const currentConfiguration = thread.effectiveConfiguration();
      const prospectiveSelection = this.#selectionFromInput(
        currentConfiguration,
        options,
      );
      const prospective = this.#requireSelection(prospectiveSelection);
      await this.#validateInput(input, prospective.model.inputModalities);
      if (options.selection !== undefined || options.model !== undefined) {
        await this.#updateThreadSettingsUnlocked(thread, {
          ...(options.selection === undefined
            ? {}
            : { selection: options.selection }),
          ...(options.model === undefined ? {} : { model: options.model }),
        });
      }
      const configuration = thread.effectiveConfiguration();
      const resolved = this.#requireSelection(configuration);
      const turnId = internal.turnId ?? this.#id();
      const controller = new AbortController();
      const ready = deferred<void>();
      let highestInputTokens: number | undefined;

      const done = new Promise<void>((resolve, reject) => {
        setImmediate(() => {
          void (async () => {
            try {
              await this.#runtime.runTurn({
                thread,
                turnId,
                input,
                ...(options.clientId === undefined
                  ? {}
                  : { clientId: options.clientId }),
                configuration: {
                  cwd: configuration.cwd,
                  providerProfileId: configuration.providerProfileId,
                  model: configuration.modelId,
                  reasoningEffort: configuration.reasoningEffort,
                  sandbox: configuration.sandbox,
                  approvalPolicy: configuration.approvalPolicy,
                },
                modelAdapter: resolved.adapter,
                signal: controller.signal,
                commit: async (item) => {
                  await this.#withThreadMutation(threadId, async () => {
                    await this.#commit(thread, item);
                  });
                },
                prepareModelSample: async (modelResponseId) =>
                  await this.#withThreadMutation(threadId, async () => {
                    const active = this.#activeTurns.get(threadId);
                    if (active?.turnId !== turnId) {
                      throw new AppServerError(
                        "turn_not_running",
                        `Turn ${turnId} is not running on thread ${threadId}`,
                      );
                    }
                    active.deliveryAnchorId = modelResponseId;
                    return compileModelMessages(thread.items);
                  }),
                commitFinal: async (message, modelResponseId) =>
                  await this.#commitFinalResponse(
                    thread,
                    turnId,
                    message,
                    modelResponseId,
                    {
                      resolved,
                      highestInputTokens: () => highestInputTokens,
                      signal: controller.signal,
                    },
                  ),
                initialInputCommitted: () => {
                  ready.resolve();
                },
                emit: (event) => {
                  if (
                    event.type === "token_usage" &&
                    Number.isSafeInteger(event.inputTokens) &&
                    event.inputTokens >= 0 &&
                    Number.isSafeInteger(event.outputTokens) &&
                    event.outputTokens >= 0
                  ) {
                    highestInputTokens = Math.max(
                      highestInputTokens ?? 0,
                      event.inputTokens,
                    );
                  }
                  this.#emit(event);
                },
                ...(options.requestApproval === undefined
                  ? {}
                  : { requestApproval: options.requestApproval }),
              });
              resolve();
            } catch (error) {
              const normalized =
                error instanceof Error ? error : new Error(String(error));
              ready.reject(normalized);
              reject(normalized);
            } finally {
              const active = this.#activeTurns.get(threadId);
              if (active?.turnId === turnId) {
                this.#activeTurns.delete(threadId);
              }
            }
          })();
        });
      });

      this.#activeTurns.set(threadId, {
        turnId,
        controller,
        done,
        inputModalities: resolved.model.inputModalities,
      });
      return { handle: { id: turnId, done }, ready: ready.promise };
    });
    try {
      await launch.ready;
    } catch (error) {
      await launch.handle.done.catch(() => undefined);
      throw error;
    }
    return launch.handle;
  }

  async replaceTurn(
    threadId: string,
    expectedTurnId: string,
    requestedInput: string | UserInput,
    options: ReplaceTurnOptions,
  ): Promise<ReplaceTurnResult> {
    const input = normalizeAppServerInput(requestedInput, "Replacement");
    if (options.clientId.length === 0) {
      throw new AppServerError(
        "invalid_request",
        "Replacement client id cannot be empty",
      );
    }

    const planned = await this.#withThreadMutation(threadId, async () => {
      const thread = await this.#requireThread(threadId);
      const resolved = this.#requireSelection(thread.effectiveConfiguration());
      await this.#validateInput(input, resolved.model.inputModalities);
      const existing = thread.items.find(
        (item): item is TurnReplacementRequestedItem =>
          item.type === "turn_replacement_requested" &&
          item.clientId === options.clientId,
      );
      const existingUserMessage = thread.items.find(
        (item): item is UserMessageItem =>
          item.type === "user_message" && item.clientId === options.clientId,
      );
      if (existing === undefined && existingUserMessage !== undefined) {
        throw new AppServerError(
          "idempotency_conflict",
          `clientUserMessageId ${options.clientId} was already used for a user message`,
        );
      }
      if (existing !== undefined) {
        if (
          existing.turnId !== expectedTurnId ||
          !sameUserInput(inputFromReplacement(existing), input)
        ) {
          throw new AppServerError(
            "idempotency_conflict",
            `clientUserMessageId ${options.clientId} was already used for a different replacement`,
          );
        }
        const runningDuplicate = this.#replacementOperations.get(threadId);
        if (runningDuplicate !== undefined) {
          if (runningDuplicate.clientId !== options.clientId) {
            throw new AppServerError(
              "replacement_pending",
              `Thread ${threadId} already has a replacement in progress`,
            );
          }
          return { pending: runningDuplicate.result };
        }
        const successorInput = thread.items.find(
          (item): item is UserMessageItem =>
            item.type === "user_message" &&
            item.turnId === existing.successorTurnId &&
            item.clientId === options.clientId,
        );
        if (successorInput !== undefined) {
          const successor = this.#activeTurns.get(threadId);
          return {
            complete: {
              interruptedTurnId: expectedTurnId,
              turn: {
                id: existing.successorTurnId,
                done:
                  successor?.turnId === existing.successorTurnId
                    ? successor.done
                    : Promise.resolve(),
              },
            },
          };
        }
        if (
          thread.items.some(
            (item) =>
              item.type === "turn_started" &&
              item.turnId === existing.successorTurnId,
          )
        ) {
          throw new AppServerError(
            "replacement_incomplete",
            `Replacement successor ${existing.successorTurnId} started without a durable user message`,
          );
        }
      }

      const inFlight = this.#replacementOperations.get(threadId);
      if (inFlight !== undefined) {
        if (inFlight.clientId !== options.clientId) {
          throw new AppServerError(
            "replacement_pending",
            `Thread ${threadId} already has a replacement in progress`,
          );
        }
        return { pending: inFlight.result };
      }

      let intent = existing;
      let oldDone: Promise<void> = Promise.resolve();
      if (intent === undefined) {
        const active = this.#activeTurns.get(threadId);
        if (
          active === undefined ||
          active.turnId !== expectedTurnId ||
          active.controller.signal.aborted ||
          this.#isTerminal(thread, expectedTurnId)
        ) {
          throw new AppServerError(
            "turn_not_running",
            `Turn ${expectedTurnId} is not running on thread ${threadId}`,
          );
        }
        intent = {
          id: this.#id(),
          threadId,
          turnId: expectedTurnId,
          successorTurnId: this.#id(),
          createdAt: this.#now(),
          type: "turn_replacement_requested",
          input,
          clientId: options.clientId,
        };
        await this.#commit(thread, intent);
        this.#emit({ type: "item_completed", item: intent });
        active.controller.abort(
          new DOMException("Replaced by user", "AbortError"),
        );
        oldDone = active.done;
      } else {
        const active = this.#activeTurns.get(threadId);
        if (active?.turnId === expectedTurnId) {
          active.controller.abort(
            new DOMException("Replaced by user", "AbortError"),
          );
          oldDone = active.done;
        } else if (active !== undefined) {
          throw new AppServerError(
            "replacement_pending",
            `Thread ${threadId} is running a different Turn`,
          );
        } else if (!this.#isTerminal(thread, expectedTurnId)) {
          const aborted: TurnAbortedItem = {
            id: this.#id(),
            threadId,
            turnId: expectedTurnId,
            createdAt: this.#now(),
            type: "turn_aborted",
            reason: "Replacement continued by explicit client retry",
          };
          await this.#commit(thread, aborted);
          this.#emit({
            type: "turn_completed",
            threadId,
            turnId: expectedTurnId,
            status: "interrupted",
          });
        }
      }

      const replacementIntent = intent;
      const result = Promise.resolve().then(async () => {
        await oldDone;
        const turn = await this.#launchTurn(
          threadId,
          inputFromReplacement(replacementIntent),
          {
            clientId: replacementIntent.clientId,
            ...(options.requestApproval === undefined
              ? {}
              : { requestApproval: options.requestApproval }),
          },
          {
            turnId: replacementIntent.successorTurnId,
            replacementClientId: replacementIntent.clientId,
          },
        );
        return { interruptedTurnId: expectedTurnId, turn };
      });
      this.#replacementOperations.set(threadId, {
        clientId: options.clientId,
        result,
      });
      void result.then(
        () => this.#clearReplacementOperation(threadId, result),
        () => this.#clearReplacementOperation(threadId, result),
      );
      return { pending: result };
    });
    if ("complete" in planned && planned.complete !== undefined) {
      return planned.complete;
    }
    if ("pending" in planned && planned.pending !== undefined) {
      return await planned.pending;
    }
    throw new Error("Turn replacement did not produce a result");
  }

  async steerTurn(
    threadId: string,
    expectedTurnId: string,
    requestedInput: string | UserInput,
    options: SteerTurnOptions = {},
  ): Promise<TurnHandle> {
    const input = normalizeAppServerInput(requestedInput, "Steer");
    return await this.#withThreadMutation(threadId, async () => {
      const thread = await this.#requireThread(threadId);
      if (options.clientId !== undefined) {
        const duplicate = thread.items.find(
          (item): item is UserMessageItem =>
            item.type === "user_message" && item.clientId === options.clientId,
        );
        if (duplicate !== undefined) {
          if (
            duplicate.turnId === expectedTurnId &&
            sameUserInput(contentFromUserMessage(duplicate), input)
          ) {
            const duplicateActive = this.#activeTurns.get(threadId);
            return {
              id: expectedTurnId,
              done:
                duplicateActive?.turnId === expectedTurnId
                  ? duplicateActive.done
                  : Promise.resolve(),
            };
          }
          throw new AppServerError(
            "idempotency_conflict",
            `clientUserMessageId ${options.clientId} was already used for different input`,
          );
        }
      }

      const active = this.#activeTurns.get(threadId);
      if (
        active === undefined ||
        active.turnId !== expectedTurnId ||
        active.controller.signal.aborted
      ) {
        throw new AppServerError(
          "turn_not_running",
          `Turn ${expectedTurnId} is not running on thread ${threadId}`,
        );
      }
      if (
        thread.items.some(
          (item) =>
            item.turnId === expectedTurnId &&
            (item.type === "turn_completed" || item.type === "turn_aborted"),
        )
      ) {
        throw new AppServerError(
          "turn_not_running",
          `Turn ${expectedTurnId} is already terminal on thread ${threadId}`,
        );
      }
      await this.#validateInput(input, active.inputModalities);

      const message: UserMessageItem = {
        id: this.#id(),
        threadId,
        turnId: expectedTurnId,
        createdAt: this.#now(),
        type: "user_message",
        content: input,
        ...(options.clientId === undefined
          ? {}
          : { clientId: options.clientId }),
        ...(active.deliveryAnchorId === undefined
          ? {}
          : { deliveryAfter: active.deliveryAnchorId }),
      };
      await this.#commit(thread, message);
      this.#emit({ type: "item_completed", item: message });
      return { id: expectedTurnId, done: active.done };
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const activeHandle = await this.#withThreadMutation(threadId, async () => {
      const active = this.#activeTurns.get(threadId);
      if (active === undefined || active.turnId !== turnId) {
        throw new AppServerError(
          "turn_not_running",
          `Turn ${turnId} is not running on thread ${threadId}`,
        );
      }
      active.controller.abort(
        new DOMException("Interrupted by user", "AbortError"),
      );
      return { done: active.done };
    });
    await activeHandle.done;
  }

  async #commitFinalResponse(
    thread: Thread,
    turnId: string,
    message: AgentMessageItem,
    modelResponseId: string,
    automaticCompaction: {
      resolved: ResolvedProviderSelection;
      highestInputTokens: () => number | undefined;
      signal: AbortSignal;
    },
  ): Promise<boolean> {
    return await this.#withThreadMutation(thread.id, async () => {
      const active = this.#activeTurns.get(thread.id);
      if (active?.turnId !== turnId) {
        throw new AppServerError(
          "turn_not_running",
          `Turn ${turnId} is not running on thread ${thread.id}`,
        );
      }
      if (active.controller.signal.aborted) {
        throw active.controller.signal.reason;
      }
      await this.#commit(thread, message);
      const pendingSteer = thread.items.some(
        (item) =>
          item.type === "user_message" &&
          item.turnId === turnId &&
          item.deliveryAfter === modelResponseId,
      );
      if (pendingSteer) {
        return false;
      }
      const completed: TurnCompletedItem = {
        id: this.#id(),
        threadId: thread.id,
        turnId,
        createdAt: this.#now(),
        type: "turn_completed",
        status: "completed",
      };
      await this.#commit(thread, completed);
      await this.#compactCompletedTurnAutomatically({
        thread,
        completed,
        ...automaticCompaction,
      });
      return true;
    });
  }

  async #compactCompletedTurnAutomatically(options: {
    thread: Thread;
    completed: TurnCompletedItem;
    resolved: ResolvedProviderSelection;
    highestInputTokens: () => number | undefined;
    signal: AbortSignal;
  }): Promise<void> {
    const contextWindow = options.resolved.model.contextWindow;
    const inputTokens = options.highestInputTokens();
    if (
      contextWindow === null ||
      inputTokens === undefined ||
      inputTokens < automaticCompactionThreshold(contextWindow)
    ) {
      return;
    }

    let boundary: ReturnType<typeof latestEligibleCompactionBoundary>;
    try {
      boundary = latestEligibleCompactionBoundary(options.thread.items);
    } catch (error) {
      throw new AppServerError(
        "automatic_compaction_failed",
        describeCompactionError(
          error,
          "Automatic context compaction could not resolve the completed Turn boundary",
        ),
      );
    }
    if (boundary?.item.id !== options.completed.id) {
      throw new AppServerError(
        "automatic_compaction_failed",
        `Automatic context compaction boundary did not match completed Turn ${options.completed.turnId}`,
      );
    }
    if (
      latestCompaction(options.thread.items)?.coveredThroughItemId ===
      boundary.item.id
    ) {
      return;
    }

    try {
      await this.#appendContextCompaction({
        thread: options.thread,
        boundary,
        selection: options.resolved,
        signal: options.signal,
      });
    } catch (error) {
      throw new AppServerError(
        "automatic_compaction_failed",
        `Automatic context compaction failed: ${describeCompactionError(
          error,
          "unknown compaction error",
        )}`,
      );
    }
  }

  async #appendContextCompaction(options: {
    thread: Thread;
    boundary: NonNullable<ReturnType<typeof latestEligibleCompactionBoundary>>;
    selection: ResolvedProviderSelection;
    signal: AbortSignal;
  }): Promise<ContextCompactionItem> {
    const sourceMessages = compileModelMessages(
      options.thread.items.slice(0, options.boundary.index + 1),
    );
    const summary = await generateContextCompactionSummary({
      adapter: options.selection.adapter,
      model: options.selection.selection.modelId,
      reasoningEffort: options.selection.selection.reasoningEffort,
      messages: sourceMessages,
      signal: options.signal,
    });
    const item: ContextCompactionItem = {
      id: this.#id(),
      threadId: options.thread.id,
      createdAt: this.#now(),
      type: "context_compaction",
      coveredThroughItemId: options.boundary.item.id,
      summary: summary.text,
      retainedItemIds: options.boundary.retainedItemIds,
      providerProfileId: options.selection.selection.providerProfileId,
      modelId: options.selection.selection.modelId,
      reasoningEffort: options.selection.selection.reasoningEffort,
      algorithmVersion: CONTEXT_COMPACTION_ALGORITHM_VERSION,
      tokenUsage: summary.tokenUsage,
    };
    try {
      await this.#commit(options.thread, item);
    } catch (error) {
      throw new AppServerError(
        "compaction_persistence_failed",
        describeCompactionError(
          error,
          "Context compaction could not be appended to the Thread journal",
        ),
      );
    }
    return item;
  }

  #pendingReplacement(
    thread: Thread,
  ): TurnReplacementRequestedItem | undefined {
    const intents = thread.items.filter(
      (item): item is TurnReplacementRequestedItem =>
        item.type === "turn_replacement_requested",
    );
    for (const intent of intents.reverse()) {
      const successorInput = thread.items.some(
        (item) =>
          item.type === "user_message" &&
          item.turnId === intent.successorTurnId &&
          item.clientId === intent.clientId,
      );
      if (!successorInput) {
        return intent;
      }
    }
    return undefined;
  }

  #isTerminal(thread: Thread, turnId: string): boolean {
    return thread.items.some(
      (item) =>
        item.turnId === turnId &&
        (item.type === "turn_completed" || item.type === "turn_aborted"),
    );
  }

  #clearReplacementOperation(
    threadId: string,
    result: Promise<ReplaceTurnResult>,
  ): void {
    if (this.#replacementOperations.get(threadId)?.result === result) {
      this.#replacementOperations.delete(threadId);
    }
  }

  async #loadThread(threadId: string): Promise<Thread | undefined> {
    const cached = this.#threads.get(threadId);
    if (cached !== undefined) {
      return cached;
    }
    const items = await this.#journal.read(threadId);
    if (items.length === 0) {
      return undefined;
    }
    const concurrentlyLoaded = this.#threads.get(threadId);
    if (concurrentlyLoaded !== undefined) {
      return concurrentlyLoaded;
    }
    const thread = new Thread(threadId, items);
    this.#threads.set(threadId, thread);
    return thread;
  }

  async #requireThread(threadId: string): Promise<Thread> {
    const thread = await this.#loadThread(threadId);
    if (thread === undefined) {
      throw new AppServerError(
        "thread_not_found",
        `Unknown thread: ${threadId}`,
      );
    }
    return thread;
  }

  async #commit(thread: Thread, item: CanonicalItem): Promise<void> {
    await this.#ensureThreadSummaries();
    thread.validateAppend(item);
    await this.#journal.append(item);
    thread.append(item);
    await this.#refreshThreadSummary(thread);
  }

  async #snapshot(
    thread: Thread,
    activeTurnId?: string,
  ): Promise<ThreadSnapshot> {
    const configuration = thread.effectiveConfiguration();
    let productMetadata: ThreadProductMetadata = {};
    try {
      productMetadata = await this.#threadMetadata.read(thread.id);
    } catch (error) {
      console.warn(
        `Could not read product metadata for Thread ${thread.id}`,
        error,
      );
    }
    return {
      id: thread.id,
      items: thread.items,
      turns: thread.deriveTurns(
        activeTurnId === undefined ? {} : { activeTurnId },
      ),
      cwd: configuration.cwd,
      providerProfileId: configuration.providerProfileId,
      modelId: configuration.modelId,
      reasoningEffort: configuration.reasoningEffort,
      model: configuration.modelId,
      provider: configuration.providerProfileId,
      sandbox: configuration.sandbox,
      approvalPolicy: configuration.approvalPolicy,
      archived: productMetadata.archived ?? false,
      ...(productMetadata.name === undefined
        ? {}
        : { name: productMetadata.name }),
    };
  }

  async #unavailableSnapshot(
    threadId: string,
    error: unknown,
  ): Promise<UnavailableThreadSnapshot> {
    let productMetadata: ThreadProductMetadata = {};
    try {
      productMetadata = await this.#threadMetadata.read(threadId);
    } catch (metadataError) {
      console.warn(
        `Could not read product metadata for unavailable Thread ${threadId}`,
        metadataError,
      );
    }
    return {
      id: threadId,
      status: "systemError",
      error: error instanceof Error ? error.message : String(error),
      archived: productMetadata.archived ?? false,
      ...(productMetadata.name === undefined
        ? {}
        : { name: productMetadata.name }),
    };
  }

  async #ensureThreadSummaries(): Promise<void> {
    if (this.#threadSummaries !== undefined) return;
    if (this.#threadSummaryLoad !== undefined) {
      await this.#threadSummaryLoad;
      return;
    }
    const load = this.#loadOrRebuildThreadSummaries();
    this.#threadSummaryLoad = load;
    try {
      await load;
    } finally {
      if (this.#threadSummaryLoad === load) this.#threadSummaryLoad = undefined;
    }
  }

  async #loadOrRebuildThreadSummaries(): Promise<void> {
    const threadIds = await this.#journal.listThreadIds();
    let persisted: NativeThreadSummary[] | undefined;
    try {
      persisted = await this.#threadSummaryProjection.load();
    } catch (error) {
      console.warn("Could not load native Thread summary projection", error);
    }
    const rebuilt = new Map<string, NativeThreadSummary>();
    for (const threadId of threadIds) {
      try {
        const thread = await this.#loadThread(threadId);
        if (thread !== undefined) {
          rebuilt.set(threadId, await this.#summary(thread));
        }
      } catch (error) {
        console.warn(`Could not rebuild Thread summary ${threadId}`, error);
        rebuilt.set(threadId, await this.#unavailableSummary(threadId, error));
      }
    }
    this.#threadSummaries = rebuilt;
    const persistedForRestart = persisted?.map((summary) =>
      summary.status === "active"
        ? { ...summary, status: "idle" as const }
        : summary,
    );
    if (
      persistedForRestart === undefined ||
      !sameSummaries(persistedForRestart, [...rebuilt.values()])
    ) {
      await this.#persistThreadSummaries();
    }
  }

  async #refreshThreadSummary(thread: Thread): Promise<void> {
    await this.#ensureThreadSummaries();
    const update = this.#threadSummaryWrites.then(async () => {
      this.#threadSummaries!.set(thread.id, await this.#summary(thread));
      await this.#saveThreadSummaries();
    });
    this.#threadSummaryWrites = update.catch(() => undefined);
    await update;
  }

  async #persistThreadSummaries(): Promise<void> {
    const update = this.#threadSummaryWrites.then(async () => {
      await this.#saveThreadSummaries();
    });
    this.#threadSummaryWrites = update.catch(() => undefined);
    await update;
  }

  async #saveThreadSummaries(): Promise<void> {
    try {
      await this.#threadSummaryProjection.replace(
        [...this.#threadSummaries!.values()].sort((left, right) =>
          left.threadId.localeCompare(right.threadId),
        ),
      );
    } catch (error) {
      console.warn("Could not persist native Thread summary projection", error);
    }
  }

  async #summary(thread: Thread): Promise<ThreadSummary> {
    const configuration = thread.effectiveConfiguration();
    let productMetadata: ThreadProductMetadata = {};
    try {
      productMetadata = await this.#threadMetadata.read(thread.id);
    } catch (error) {
      console.warn(
        `Could not read product metadata for Thread summary ${thread.id}`,
        error,
      );
    }
    const metadata = thread.items.find(
      (item): item is ThreadMetadataItem => item.type === "thread_metadata",
    );
    if (metadata === undefined) {
      throw new Error(`Thread ${thread.id} has no metadata item`);
    }
    return {
      threadId: thread.id,
      currentMetadata: configuration,
      archived: productMetadata.archived ?? false,
      ...(productMetadata.name === undefined
        ? {}
        : { name: productMetadata.name }),
      createdAt: metadata.createdAt,
      updatedAt: thread.items.at(-1)?.createdAt ?? metadata.createdAt,
      preview: firstUserMessagePreview(thread.items),
      status: thread
        .deriveTurns(
          this.#activeTurns.get(thread.id)?.turnId === undefined
            ? {}
            : { activeTurnId: this.#activeTurns.get(thread.id)!.turnId },
        )
        .some((turn) => turn.status === "inProgress")
        ? "active"
        : "idle",
    };
  }

  async #unavailableSummary(
    threadId: string,
    error: unknown,
  ): Promise<UnavailableThreadSummary> {
    let productMetadata: ThreadProductMetadata = {};
    try {
      productMetadata = await this.#threadMetadata.read(threadId);
    } catch (metadataError) {
      console.warn(
        `Could not read product metadata for unavailable Thread summary ${threadId}`,
        metadataError,
      );
    }
    return {
      threadId,
      archived: productMetadata.archived ?? false,
      ...(productMetadata.name === undefined
        ? {}
        : { name: productMetadata.name }),
      createdAt: null,
      updatedAt: null,
      preview: "Thread journal could not be loaded.",
      status: "systemError",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  async #updateThreadSettingsUnlocked(
    thread: Thread,
    input: UpdateThreadSettingsInput,
  ): Promise<ThreadSnapshot> {
    const current = thread.effectiveConfiguration();
    const selection = this.#selectionFromInput(current, input);
    this.#requireSelection(selection);
    if (sameSelection(selection, current)) {
      return await this.#snapshot(thread);
    }
    const changed: ThreadConfigurationChangedItem = {
      id: this.#id(),
      threadId: thread.id,
      createdAt: this.#now(),
      type: "thread_configuration_changed",
      selection: {
        from: selectionFrom(current),
        to: selection,
      },
    };
    await this.#commit(thread, changed);
    const settings = thread.effectiveConfiguration();
    this.#emit({
      type: "thread_settings_updated",
      threadId: thread.id,
      settings,
    });
    return await this.#snapshot(thread);
  }

  #requireSelection(
    selection: ProviderSelectionInput,
    fallbackReasoningEffort?: string,
  ) {
    try {
      return this.#providerRegistry.resolve(selection, fallbackReasoningEffort);
    } catch (error) {
      if (error instanceof ProviderRegistryError) {
        throw new AppServerError(error.code, error.message);
      }
      throw error;
    }
  }

  async #validateInput(
    input: UserInput,
    inputModalities: readonly string[] | null,
  ): Promise<void> {
    const attachments = input.flatMap((part) =>
      part.type === "image" ? [part.attachment] : [],
    );
    if (attachments.length === 0) return;
    if (inputModalities !== null && !inputModalities.includes("image")) {
      throw new AppServerError(
        "image_input_unsupported",
        "The selected model does not support image input",
      );
    }
    for (const attachment of attachments) {
      try {
        await this.#attachments.read(attachment);
      } catch (error) {
        throw attachmentAppServerError(error);
      }
    }
  }

  #selectionFromInput(
    current: ProviderSelection,
    input: {
      selection?: ProviderSelectionInput;
      model?: string;
      reasoningEffort?: string;
    },
  ): ProviderSelection {
    if (input.selection !== undefined) {
      if (input.model !== undefined || input.reasoningEffort !== undefined) {
        throw new AppServerError(
          "invalid_request",
          "A provider selection cannot be combined with legacy model fields",
        );
      }
      return this.#requireSelection(input.selection, current.reasoningEffort)
        .selection;
    }
    if (input.model === undefined && input.reasoningEffort === undefined) {
      return structuredClone(current);
    }
    return this.#requireSelection(
      {
        providerProfileId: current.providerProfileId,
        modelId: input.model ?? current.modelId,
        ...(input.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: input.reasoningEffort }),
      },
      current.reasoningEffort,
    ).selection;
  }

  async #withThreadMutation<T>(
    threadId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#mutationChains.get(threadId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(async () => {
      await gate;
    });
    this.#mutationChains.set(threadId, chain);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#mutationChains.get(threadId) === chain) {
        this.#mutationChains.delete(threadId);
      }
    }
  }

  #emit(event: AppServerEvent): void {
    for (const subscriber of this.#subscribers) {
      subscriber(event);
    }
  }
}

function normalizeAppServerInput(
  input: string | UserInput,
  label: string,
): UserInput {
  try {
    return normalizeUserInput(input);
  } catch (error) {
    throw new AppServerError(
      "invalid_request",
      `${label} input is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function inputFromReplacement(item: TurnReplacementRequestedItem): UserInput {
  return item.input ?? [{ type: "text", text: item.text }];
}

function firstUserMessagePreview(items: readonly CanonicalItem[]): string {
  const item = items.find(
    (candidate): candidate is UserMessageItem =>
      candidate.type === "user_message",
  );
  return item === undefined ? "" : previewFromUserMessage(item);
}

function attachmentAppServerError(error: unknown): Error {
  return error instanceof AttachmentStoreError
    ? new AppServerError(error.code, error.message)
    : error instanceof Error
      ? error
      : new Error(String(error));
}

export class AppServerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AppServerError";
    this.code = code;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sameSummaries(
  left: readonly NativeThreadSummary[],
  right: readonly NativeThreadSummary[],
): boolean {
  const sorted = (values: readonly NativeThreadSummary[]) =>
    [...values].sort((first, second) =>
      first.threadId.localeCompare(second.threadId),
    );
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function selectionFrom(selection: ProviderSelection): ProviderSelection {
  return {
    providerProfileId: selection.providerProfileId,
    modelId: selection.modelId,
    reasoningEffort: selection.reasoningEffort,
  };
}

function sameSelection(
  left: ProviderSelection,
  right: ProviderSelection,
): boolean {
  return (
    left.providerProfileId === right.providerProfileId &&
    left.modelId === right.modelId &&
    left.reasoningEffort === right.reasoningEffort
  );
}

function automaticCompactionThreshold(contextWindow: number): number {
  const quotient = Math.floor(contextWindow / 5);
  const remainder = contextWindow % 5;
  return quotient * 4 + Math.ceil((remainder * 4) / 5);
}

async function generateContextCompactionSummary(options: {
  adapter: ModelAdapter;
  model: string;
  reasoningEffort: string;
  messages: ModelMessage[];
  signal: AbortSignal;
}): Promise<{
  text: string;
  tokenUsage: { inputTokens: number; outputTokens: number };
}> {
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const messages: ModelMessage[] = [
    ...options.messages,
    { role: "user", text: CONTEXT_COMPACTION_SUMMARY_INSTRUCTION },
  ];
  try {
    for await (const event of options.adapter.stream({
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      messages,
      tools: [],
      signal: options.signal,
    })) {
      options.signal.throwIfAborted();
      if (event.type === "text_delta") {
        text += event.delta;
      } else if (event.type === "usage") {
        validateCompactionUsage(event);
        inputTokens += event.inputTokens;
        outputTokens += event.outputTokens;
        if (
          !Number.isSafeInteger(inputTokens) ||
          !Number.isSafeInteger(outputTokens)
        ) {
          throw new CompactionSummaryValidationError(
            "Context compaction token usage exceeded safe integer range",
          );
        }
      } else if (event.type === "tool_call") {
        throw new CompactionSummaryValidationError(
          "Context compaction summary generation must not call tools",
        );
      }
    }
  } catch (error) {
    if (options.signal.aborted || isCompactionAbort(error)) {
      throw new AppServerError(
        "compaction_aborted",
        describeCompactionError(
          options.signal.reason ?? error,
          "Context compaction was aborted",
        ),
      );
    }
    if (error instanceof CompactionSummaryValidationError) {
      throw new AppServerError("compaction_invalid_summary", error.message);
    }
    if (error instanceof AppServerError) throw error;
    throw new AppServerError(
      "compaction_generation_failed",
      describeCompactionError(error, "Context compaction generation failed"),
    );
  }
  if (text.trim().length === 0) {
    throw new AppServerError(
      "compaction_invalid_summary",
      "Context compaction Provider returned an empty summary",
    );
  }
  return { text, tokenUsage: { inputTokens, outputTokens } };
}

class CompactionSummaryValidationError extends Error {}

function validateCompactionUsage(
  event: Extract<ModelEvent, { type: "usage" }>,
): void {
  if (
    !Number.isSafeInteger(event.inputTokens) ||
    event.inputTokens < 0 ||
    !Number.isSafeInteger(event.outputTokens) ||
    event.outputTokens < 0
  ) {
    throw new CompactionSummaryValidationError(
      "Context compaction Provider returned invalid token usage",
    );
  }
}

function isCompactionAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function describeCompactionError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return fallback;
}
