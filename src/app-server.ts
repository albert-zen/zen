import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  ApprovalPolicy,
  CanonicalItem,
  SandboxMode,
  ThreadMetadataItem,
} from "./item.js";
import type { ThreadJournal } from "./journal.js";
import { AgentRuntime, type RuntimeEvent } from "./runtime.js";
import { Thread, type DerivedTurn } from "./thread.js";
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
}

export interface TurnHandle {
  id: string;
  done: Promise<void>;
}

export class ZenAppServer {
  readonly #journal: ThreadJournal;
  readonly #runtime: AgentRuntime;
  readonly #defaults: AppServerDefaults;
  readonly #id: () => string;
  readonly #now: () => string;
  readonly #threads = new Map<string, Thread>();
  readonly #activeTurns = new Map<
    string,
    { turnId: string; controller: AbortController; done: Promise<void> }
  >();
  readonly #subscribers = new Set<(event: RuntimeEvent) => void>();

  constructor(options: {
    journal: ThreadJournal;
    runtime: AgentRuntime;
    defaults: AppServerDefaults;
    idFactory?: () => string;
    now?: () => string;
  }) {
    this.#journal = options.journal;
    this.#runtime = options.runtime;
    this.#defaults = {
      ...options.defaults,
      cwd: path.resolve(options.defaults.cwd),
    };
    this.#id = options.idFactory ?? randomUUID;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  async startThread(input: StartThreadInput = {}): Promise<ThreadSnapshot> {
    const threadId = this.#id();
    const thread = new Thread(threadId);
    const metadata: ThreadMetadataItem = {
      id: this.#id(),
      threadId,
      createdAt: this.#now(),
      type: "thread_metadata",
      cwd: path.resolve(input.cwd ?? this.#defaults.cwd),
      model: input.model ?? this.#defaults.model,
      provider: this.#runtime.provider,
      sandbox: input.sandbox ?? this.#defaults.sandbox,
      approvalPolicy: input.approvalPolicy ?? this.#defaults.approvalPolicy,
    };
    await this.#commit(thread, metadata);
    this.#threads.set(threadId, thread);
    return this.#snapshot(thread);
  }

  async listThreads(): Promise<ThreadSnapshot[]> {
    const threadIds = await this.#journal.listThreadIds();
    const snapshots: ThreadSnapshot[] = [];
    for (const threadId of threadIds) {
      const thread = await this.#loadThread(threadId);
      if (thread !== undefined) {
        snapshots.push(
          this.#snapshot(thread, this.#activeTurns.get(threadId)?.turnId),
        );
      }
    }
    return snapshots;
  }

  async readThread(threadId: string): Promise<ThreadSnapshot> {
    const thread = await this.#requireThread(threadId);
    return this.#snapshot(thread, this.#activeTurns.get(threadId)?.turnId);
  }

  async startTurn(
    threadId: string,
    text: string,
    options: { clientId?: string; requestApproval?: ApprovalHandler } = {},
  ): Promise<TurnHandle> {
    if (text.length === 0) {
      throw new AppServerError("invalid_request", "Turn input cannot be empty");
    }
    if (this.#activeTurns.has(threadId)) {
      throw new AppServerError(
        "thread_busy",
        `Thread ${threadId} already has a running turn`,
      );
    }

    const thread = await this.#requireThread(threadId);
    if (this.#activeTurns.has(threadId)) {
      throw new AppServerError(
        "thread_busy",
        `Thread ${threadId} already has a running turn`,
      );
    }
    const metadata = requireMetadata(thread);
    if (metadata.provider !== this.#runtime.provider) {
      throw new AppServerError(
        "provider_unavailable",
        `Thread ${threadId} requires provider ${metadata.provider}, but this host provides ${this.#runtime.provider}`,
      );
    }
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
                cwd: metadata.cwd,
                model: metadata.model,
                sandbox: metadata.sandbox,
                approvalPolicy: metadata.approvalPolicy,
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
    await this.#journal.append(item);
    thread.append(item);
  }

  #snapshot(thread: Thread, activeTurnId?: string): ThreadSnapshot {
    const metadata = requireMetadata(thread);
    return {
      id: thread.id,
      items: thread.items,
      turns: thread.deriveTurns(
        activeTurnId === undefined ? {} : { activeTurnId },
      ),
      cwd: metadata.cwd,
      model: metadata.model,
      provider: metadata.provider,
      sandbox: metadata.sandbox,
      approvalPolicy: metadata.approvalPolicy,
    };
  }

  #emit(event: RuntimeEvent): void {
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

function requireMetadata(thread: Thread): ThreadMetadataItem {
  const metadata = [...thread.items]
    .reverse()
    .find(
      (item): item is ThreadMetadataItem => item.type === "thread_metadata",
    );
  if (metadata === undefined) {
    throw new AppServerError(
      "invalid_thread",
      `Thread ${thread.id} has no metadata item`,
    );
  }
  return metadata;
}
