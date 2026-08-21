import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  AgentMessageItem,
  ApprovalPolicy,
  CanonicalItem,
  SandboxMode,
  ThreadConfigurationChangedItem,
  ThreadMetadataItem,
  TurnAbortedItem,
  TurnCompletedItem,
  TurnReplacementRequestedItem,
  UserMessageItem,
} from "./item.js";
import type { ThreadJournal } from "./journal.js";
import { compileModelMessages } from "./model.js";
import {
  ProviderRegistryError,
  type ProviderModel,
  type ProviderRegistry,
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
    runtime: AgentRuntime;
    providerRegistry: ProviderRegistry;
    threadMetadata: ThreadMetadataStore;
    threadSummaryProjection?: ThreadSummaryProjection;
    defaults: AppServerDefaults;
    idFactory?: () => string;
    now?: () => string;
  }) {
    this.#journal = options.journal;
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
    text: string,
    options: {
      clientId?: string;
      selection?: ProviderSelectionInput;
      model?: string;
      requestApproval?: ApprovalHandler;
    } = {},
  ): Promise<TurnHandle> {
    return await this.#launchTurn(threadId, text, options);
  }

  async #launchTurn(
    threadId: string,
    text: string,
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
    if (text.length === 0) {
      throw new AppServerError("invalid_request", "Turn input cannot be empty");
    }
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

      const done = new Promise<void>((resolve, reject) => {
        setImmediate(() => {
          void (async () => {
            try {
              await this.#runtime.runTurn({
                thread,
                turnId,
                text,
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
                  ),
                initialInputCommitted: () => {
                  ready.resolve();
                },
                emit: (event) => {
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

      this.#activeTurns.set(threadId, { turnId, controller, done });
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
    text: string,
    options: ReplaceTurnOptions,
  ): Promise<ReplaceTurnResult> {
    if (text.length === 0) {
      throw new AppServerError(
        "invalid_request",
        "Replacement input cannot be empty",
      );
    }
    if (options.clientId.length === 0) {
      throw new AppServerError(
        "invalid_request",
        "Replacement client id cannot be empty",
      );
    }

    const planned = await this.#withThreadMutation(threadId, async () => {
      const thread = await this.#requireThread(threadId);
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
        if (existing.turnId !== expectedTurnId || existing.text !== text) {
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
          text,
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
          replacementIntent.text,
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
    text: string,
    options: SteerTurnOptions = {},
  ): Promise<TurnHandle> {
    if (text.length === 0) {
      throw new AppServerError(
        "invalid_request",
        "Steer input cannot be empty",
      );
    }
    return await this.#withThreadMutation(threadId, async () => {
      const thread = await this.#requireThread(threadId);
      if (options.clientId !== undefined) {
        const duplicate = thread.items.find(
          (item): item is UserMessageItem =>
            item.type === "user_message" && item.clientId === options.clientId,
        );
        if (duplicate !== undefined) {
          if (duplicate.turnId === expectedTurnId && duplicate.text === text) {
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

      const message: UserMessageItem = {
        id: this.#id(),
        threadId,
        turnId: expectedTurnId,
        createdAt: this.#now(),
        type: "user_message",
        text,
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
      return true;
    });
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
      preview:
        thread.items.find((item) => item.type === "user_message")?.text ?? "",
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
