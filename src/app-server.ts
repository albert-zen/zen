import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  ApprovalPolicy,
  CanonicalItem,
  SandboxMode,
  ThreadConfigurationChangedItem,
  ThreadMetadataItem,
} from "./item.js";
import type { ThreadJournal } from "./journal.js";
import type { ModelCatalog, ModelCatalogEntry } from "./model-catalog.js";
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

export interface TurnHandle {
  id: string;
  done: Promise<void>;
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
    { turnId: string; controller: AbortController; done: Promise<void> }
  >();
  readonly #subscribers = new Set<(event: AppServerEvent) => void>();
  readonly #mutationChains = new Map<string, Promise<void>>();

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

  async listThreads(): Promise<ThreadSnapshot[]> {
    const threadIds = await this.#journal.listThreadIds();
    const snapshots: ThreadSnapshot[] = [];
    for (const threadId of threadIds) {
      const thread = await this.#loadThread(threadId);
      if (thread !== undefined) {
        snapshots.push(
          await this.#snapshot(thread, this.#activeTurns.get(threadId)?.turnId),
        );
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
      if (this.#activeTurns.has(threadId)) {
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
    if (text.length === 0) {
      throw new AppServerError("invalid_request", "Turn input cannot be empty");
    }
    return await this.#withThreadMutation(threadId, async () => {
      if (this.#activeTurns.has(threadId)) {
        throw new AppServerError(
          "thread_busy",
          `Thread ${threadId} already has a running turn`,
        );
      }

      const thread = await this.#requireThread(threadId);
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
      const turnId = this.#id();
      const controller = new AbortController();

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
                  await this.#commit(thread, item);
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
              reject(error instanceof Error ? error : new Error(String(error)));
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
      return { id: turnId, done };
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
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
    await active.done;
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
