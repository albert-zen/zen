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
import type { ModelCatalog, ModelCatalogEntry } from "./model-catalog.js";
import { compileModelMessages } from "./model.js";
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
import type { ApprovalHandler } from "./tool.js";

export interface AppServerDefaults {
  cwd: string;
  model: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
}

export interface StartThreadInput {
  cwd?: string;
  model?: string;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
}

export interface ThreadSnapshot {
  id: string;
  items: readonly CanonicalItem[];
  turns: DerivedTurn[];
  cwd: string;
  model: string;
  provider: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  name?: string;
}

export interface UnavailableThreadSnapshot {
  id: string;
  status: "systemError";
  error: string;
  name?: string;
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

export type AppServerEvent =
  RuntimeEvent | ThreadSettingsUpdatedEvent | ThreadNameUpdatedEvent;

export interface UpdateThreadSettingsInput {
  model: string;
}

export class ZenAppServer {
  readonly #journal: ThreadJournal;
  readonly #runtime: AgentRuntime;
  readonly #modelCatalog: ModelCatalog;
  readonly #threadMetadata: ThreadMetadataStore;
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

  constructor(options: {
    journal: ThreadJournal;
    runtime: AgentRuntime;
    modelCatalog: ModelCatalog;
    threadMetadata: ThreadMetadataStore;
    defaults: AppServerDefaults;
    idFactory?: () => string;
    now?: () => string;
  }) {
    this.#journal = options.journal;
    this.#runtime = options.runtime;
    this.#modelCatalog = options.modelCatalog;
    this.#threadMetadata = options.threadMetadata;
    this.#defaults = {
      ...options.defaults,
      cwd: path.resolve(options.defaults.cwd),
    };
    this.#id = options.idFactory ?? randomUUID;
    this.#now = options.now ?? (() => new Date().toISOString());
    if (this.#modelCatalog.get(this.#defaults.model) === undefined) {
      throw new Error(
        `Default model ${this.#defaults.model} is absent from the model catalog`,
      );
    }
  }

  subscribe(listener: (event: AppServerEvent) => void): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  listModels(): readonly ModelCatalogEntry[] {
    return this.#modelCatalog.list();
  }

  async startThread(input: StartThreadInput = {}): Promise<ThreadSnapshot> {
    const threadId = this.#id();
    const thread = new Thread(threadId);
    const model = input.model ?? this.#defaults.model;
    this.#requireAvailableModel(model);
    const metadata: ThreadMetadataItem = {
      id: this.#id(),
      threadId,
      createdAt: this.#now(),
      type: "thread_metadata",
      cwd: path.resolve(input.cwd ?? this.#defaults.cwd),
      model,
      provider: this.#runtime.provider,
      sandbox: input.sandbox ?? this.#defaults.sandbox,
      approvalPolicy: input.approvalPolicy ?? this.#defaults.approvalPolicy,
    };
    await this.#commit(thread, metadata);
    this.#threads.set(threadId, thread);
    return await this.#snapshot(thread);
  }

  async listThreads(): Promise<ThreadListEntry[]> {
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
    return snapshots;
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
      if (input.model === thread.effectiveConfiguration().model) {
        return await this.#snapshot(
          thread,
          this.#activeTurns.get(threadId)?.turnId,
        );
      }
      this.#requireAvailableModel(input.model);
      if (
        this.#activeTurns.has(threadId) ||
        this.#pendingReplacement(thread) !== undefined
      ) {
        throw new AppServerError(
          "thread_busy",
          `Thread ${threadId} already has a running turn`,
        );
      }
      return await this.#updateThreadSettingsUnlocked(thread, input);
    });
  }

  async setThreadName(
    threadId: string,
    requestedName: string,
  ): Promise<ThreadSnapshot> {
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
    await this.#threadMetadata.setName(threadId, name);
    this.#emit({ type: "thread_name_updated", threadId, name });
    return await this.#snapshot(
      thread,
      this.#activeTurns.get(threadId)?.turnId,
    );
  }

  async startTurn(
    threadId: string,
    text: string,
    options: {
      clientId?: string;
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
      if (this.#activeTurns.has(threadId)) {
        throw new AppServerError(
          "thread_busy",
          `Thread ${threadId} already has a running turn`,
        );
      }

      const thread = await this.#requireThread(threadId);
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
      const initialConfiguration = thread.effectiveConfiguration();
      if (initialConfiguration.provider !== this.#runtime.provider) {
        throw new AppServerError(
          "provider_unavailable",
          `Thread ${threadId} requires provider ${initialConfiguration.provider}, but this host provides ${this.#runtime.provider}`,
        );
      }
      if (options.model !== undefined) {
        await this.#updateThreadSettingsUnlocked(thread, {
          model: options.model,
        });
      }
      const configuration = thread.effectiveConfiguration();
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
                  model: configuration.model,
                  sandbox: configuration.sandbox,
                  approvalPolicy: configuration.approvalPolicy,
                },
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
    thread.validateAppend(item);
    await this.#journal.append(item);
    thread.append(item);
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
      model: configuration.model,
      provider: configuration.provider,
      sandbox: configuration.sandbox,
      approvalPolicy: configuration.approvalPolicy,
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
      ...(productMetadata.name === undefined
        ? {}
        : { name: productMetadata.name }),
    };
  }

  async #updateThreadSettingsUnlocked(
    thread: Thread,
    input: UpdateThreadSettingsInput,
  ): Promise<ThreadSnapshot> {
    this.#requireAvailableModel(input.model);
    const current = thread.effectiveConfiguration();
    if (input.model === current.model) {
      return await this.#snapshot(thread);
    }
    const changed: ThreadConfigurationChangedItem = {
      id: this.#id(),
      threadId: thread.id,
      createdAt: this.#now(),
      type: "thread_configuration_changed",
      model: { from: current.model, to: input.model },
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

  #requireAvailableModel(model: string): void {
    if (this.#modelCatalog.get(model) === undefined) {
      throw new AppServerError(
        "model_unavailable",
        `Model is not available from this Zen host: ${model}`,
      );
    }
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
