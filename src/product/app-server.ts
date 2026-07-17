import {
  toProtocolItem,
  type AppServerNotification,
  AppServerRequest,
  AppServerResponse,
  JsonValue,
  ThreadPersistenceFailure,
} from './app-server-protocol.js';
import {
  ThreadManager,
  type ThreadManagerEvent,
  type ThreadManagerOptions,
  type TurnRetryInput,
  type TurnStartInput,
} from './thread-manager.js';
import type { ThreadJournal } from './thread-journal.js';
import { ApprovalBroker, type ApprovalResolveInput } from './approval-runtime.js';

export type AppServerRequestInput =
  | AppServerRequest
  | {
      readonly method: string;
      readonly params?: unknown;
    };

export type AppServerOptions = {
  readonly threadManagerOptions?: ThreadManagerOptions;
  readonly threadJournal?: ThreadJournal;
  readonly approvalBroker?: ApprovalBroker;
  readonly persistenceFailures?: readonly ThreadPersistenceFailure[];
};

export type AppServerSubscription = () => void;

export interface AppServerClient {
  request(request: AppServerRequestInput): Promise<AppServerResponse>;
  subscribe(listener: AppServerNotificationListener): AppServerSubscription;
}

export type AppServerNotificationListener = (notification: AppServerNotification) => void;

export class AppServer implements AppServerClient {
  private readonly threadManager: ThreadManager;
  private readonly threadJournal?: ThreadJournal;
  private readonly approvalBroker: ApprovalBroker;
  private readonly listeners: AppServerNotificationListener[] = [];
  private readonly eventTails = new Map<string, Promise<void>>();
  private readonly eventOperations = new Map<string, Promise<void>>();
  private persistenceFailure?: ThreadPersistenceOperationError;
  private lifecycle: 'open' | 'closing' | 'closed' = 'open';
  private closePromise?: Promise<void>;

  constructor(options: AppServerOptions = {}) {
    this.threadJournal = options.threadJournal;
    this.approvalBroker = options.approvalBroker ?? new ApprovalBroker();
    this.threadManager = new ThreadManager({
      ...options.threadManagerOptions,
      repairOnLoad: false,
      persistenceFailures: options.persistenceFailures,
      persistenceObserver: (threadId, item) => {
        this.queueEvent({
          type: 'item/appended',
          threadId,
          turnId: item.turnId,
          item: toProtocolItem(item),
        });
      },
      itemCommitBarrier: async (threadId) => await this.settleThread(threadId),
      approvalBroker: this.approvalBroker,
    });
    this.threadManager.observe((event) => {
      this.queueEvent(event);
    });
    this.threadManager.repairLoadedThreads();
  }

  subscribe(listener: AppServerNotificationListener): AppServerSubscription {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  async request(request: AppServerRequestInput): Promise<AppServerResponse> {
    if (this.persistenceFailure) {
      return {
        method: request.method,
        ok: false,
        error: toRequestError(this.persistenceFailure),
      };
    }
    if (this.lifecycle !== 'open') {
      return {
        method: request.method,
        ok: false,
        error: { code: 'SERVER_CLOSING', message: 'App Server is closing or closed' },
      };
    }
    try {
      return await this.dispatch(request);
    } catch (cause) {
      return {
        method: request.method,
        ok: false,
        error: toRequestError(cause),
      };
    }
  }

  private async dispatch(request: AppServerRequestInput): Promise<AppServerResponse> {
    if (request.method === 'thread/start') {
      const thread = this.threadManager.startThread();
      await this.settleThread(thread.id);
      return {
        method: 'thread/start',
        ok: true,
        result: { thread: this.threadManager.readThread(thread.id) },
      };
    }

    if (request.method === 'thread/read') {
      const params = readParams(request.params);
      const threadId = readRequiredString(params, 'threadId');
      const persistenceFailure = this.threadManager.persistenceFailure(threadId);
      if (persistenceFailure) throw new KnownThreadJournalCorruptionError(persistenceFailure);
      await this.settleThread(threadId);

      return {
        method: 'thread/read',
        ok: true,
        result: { thread: this.threadManager.readThread(threadId) },
      };
    }

    if (request.method === 'thread/list') {
      await this.settleAllThreads();
      return {
        method: 'thread/list',
        ok: true,
        result: {
          threads: this.threadManager.listThreads(),
          persistenceFailures: this.threadManager.listPersistenceFailures(),
        },
      };
    }

    if (request.method === 'turn/start') {
      const params = readParams(request.params);
      const turnInput: TurnStartInput = {
        threadId: readRequiredString(params, 'threadId'),
        input: readJsonValue(params.input),
        modelOptions: isJsonObject(params.modelOptions) ? params.modelOptions : undefined,
      };

      const prepared = this.threadManager.prepareTurn(turnInput);
      try {
        await this.settleThread(turnInput.threadId);
      } catch (cause) {
        prepared.abandon();
        throw cause;
      }
      void prepared.activate().catch(() => undefined);
      return {
        method: 'turn/start',
        ok: true,
        result: { turn: prepared.turn },
      };
    }

    if (request.method === 'turn/interrupt') {
      const params = readParams(request.params);

      const turn = this.threadManager.interruptTurn(readRequiredString(params, 'threadId'));
      await this.settleThread(readRequiredString(params, 'threadId'));
      return {
        method: 'turn/interrupt',
        ok: true,
        result: {
          turn,
        },
      };
    }

    if (request.method === 'turn/retry') {
      const params = readParams(request.params);
      const retryInput: TurnRetryInput = {
        threadId: readRequiredString(params, 'threadId'),
        turnId:
          typeof params.turnId === 'string' && params.turnId.length > 0 ? params.turnId : undefined,
        modelOptions: isJsonObject(params.modelOptions) ? params.modelOptions : undefined,
      };

      const prepared = this.threadManager.prepareRetry(retryInput);
      try {
        await this.settleThread(retryInput.threadId);
      } catch (cause) {
        prepared.abandon();
        throw cause;
      }
      void prepared.activate().catch(() => undefined);
      return {
        method: 'turn/retry',
        ok: true,
        result: { turn: prepared.turn },
      };
    }

    if (request.method === 'approval/resolve') {
      const params = readParams(request.params);
      const decision = readRequiredApprovalDecision(params, 'decision');
      const input: ApprovalResolveInput = {
        approvalId: readRequiredString(params, 'approvalId'),
        threadId: readRequiredString(params, 'threadId'),
        turnId: readRequiredString(params, 'turnId'),
        decision: { type: decision },
      };
      const prepared = this.approvalBroker.prepareResolve(input);
      try {
        await this.threadManager.recordApprovalResolution(prepared.request, input.decision);
        prepared.commit({ resolutionRecorded: true });
      } catch (cause) {
        prepared.abandon('Persistence unavailable');
        throw cause;
      }
      return {
        method: 'approval/resolve',
        ok: true,
        result: { approvalId: input.approvalId, decision },
      };
    }

    return {
      method: request.method,
      ok: false,
      error: {
        code: 'UNKNOWN_METHOD',
        message: `Unknown App Server method: ${request.method}`,
      },
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.lifecycle = 'closing';
    this.closePromise = this.closeAfterProducerBarrier();
    return await this.closePromise;
  }

  private async closeAfterProducerBarrier(): Promise<void> {
    try {
      await this.threadManager.shutdown();
      await Promise.all([...this.eventTails.values()]);
      await this.threadJournal?.close();
    } finally {
      this.lifecycle = 'closed';
    }
  }

  private queueEvent(event: ThreadManagerEvent): void {
    if (!this.threadJournal) {
      this.publish(event);
      return;
    }
    const threadId = event.type === 'thread/started' ? event.thread.id : event.threadId;
    const previous = this.eventTails.get(threadId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (this.persistenceFailure) throw this.persistenceFailure;
      try {
        await this.commitAndPublish(event);
      } catch (cause) {
        const failure = new ThreadPersistenceOperationError(threadId, cause);
        this.tripPersistenceFailure(failure);
        throw failure;
      }
    });
    this.eventOperations.set(threadId, next);
    this.eventTails.set(
      threadId,
      next.catch(() => undefined)
    );
  }

  private async settleThread(threadId: string): Promise<void> {
    await (this.eventOperations.get(threadId) ?? Promise.resolve());
    if (this.persistenceFailure) throw this.persistenceFailure;
  }

  private async settleAllThreads(): Promise<void> {
    await Promise.all([...this.eventOperations.values()]);
    if (this.persistenceFailure) throw this.persistenceFailure;
  }

  private tripPersistenceFailure(failure: ThreadPersistenceOperationError): void {
    if (this.persistenceFailure) return;
    this.persistenceFailure = failure;
    this.threadManager.failStop();
  }

  private async commitAndPublish(event: ThreadManagerEvent): Promise<void> {
    if (this.threadJournal) {
      const threadId = event.type === 'thread/started' ? event.thread.id : event.threadId;
      if (event.type === 'item/appended') {
        if (event.item.type === 'thread.created') {
          await this.threadJournal.create(threadId, event.item);
        } else {
          await this.threadJournal.append(threadId, event.item);
        }
      }
      if (
        event.type === 'thread/started' ||
        event.type === 'turn/completed' ||
        event.type === 'turn/failed'
      ) {
        await this.threadJournal.flush(threadId);
      }
    }
    this.publish(event);
  }

  private publish(event: ThreadManagerEvent): void {
    if (event.type === 'item/appended' && event.item.type === 'thread.created') return;
    this.listeners.forEach((listener) => listener(event));
  }
}

function readRequiredApprovalDecision(
  params: Readonly<Record<string, unknown>>,
  key: string
): 'approveOnce' | 'decline' {
  const value = readRequiredString(params, key);
  if (value === 'approveOnce' || value === 'decline') return value;
  throw new Error(`${key} must be approveOnce or decline`);
}

function readParams(params: unknown): Readonly<Record<string, unknown>> {
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    return params as Readonly<Record<string, unknown>>;
  }

  throw new Error('Request params must be an object');
}

function readRequiredString(params: Readonly<Record<string, unknown>>, key: string): string {
  const value = params[key];

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required string param: ${key}`);
  }

  return value;
}

function readJsonValue(value: unknown): JsonValue {
  if (isJsonValue(value)) {
    return value;
  }

  throw new Error('Request input must be JSON-safe');
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return typeof value !== 'number' || Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isJsonObject(value);
}

function isJsonObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

function readErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

class KnownThreadJournalCorruptionError extends Error {
  constructor(readonly failure: ThreadPersistenceFailure) {
    super(failure.message);
  }
}

class ThreadPersistenceOperationError extends Error {
  constructor(
    readonly threadId: string,
    cause: unknown
  ) {
    super(readErrorMessage(cause), { cause });
  }
}

function toRequestError(cause: unknown): import('./app-server-protocol.js').AppServerError {
  if (cause instanceof KnownThreadJournalCorruptionError) {
    return {
      code: cause.failure.code,
      message: cause.failure.message,
      details: {
        path: cause.failure.path,
        recordNumber: cause.failure.recordNumber,
        threadId: cause.failure.threadId ?? null,
      },
    };
  }
  if (
    cause instanceof ThreadPersistenceOperationError ||
    (cause instanceof Error && cause.name === 'ThreadJournalError')
  ) {
    return { code: 'PERSISTENCE_FAILURE', message: cause.message };
  }
  return { code: 'REQUEST_FAILED', message: readErrorMessage(cause) };
}
