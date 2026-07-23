import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

import type { AgentAppClient, AgentAppResponse } from '@zen/framework/product';

import type { ImZenConfig } from './config.js';
import { ImZenStateStore } from './state-store.js';
import type {
  ConversationBinding,
  PendingInboundJob,
  QQInboundMessage,
  QQOutboundMessage,
} from './types.js';

type Deliver = (message: QQOutboundMessage) => Promise<void>;

const DEFAULT_PAIRING_TTL_MS = 10 * 60_000;
const DEFAULT_PAIRING_MAX_FAILED_ATTEMPTS = 5;

export type ImZenBridgeOptions = {
  readonly client: AgentAppClient;
  readonly config: ImZenConfig;
  readonly deliver: Deliver;
  readonly clock?: () => number;
  readonly pairingCode?: string;
  readonly pairingCodeMaxFailedAttempts?: number;
  readonly pairingCodeTtlMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly state: ImZenStateStore;
};

export class ImZenBridge {
  private readonly active = new Set<Promise<void>>();
  private readonly conversationTails = new Map<string, Promise<void>>();
  private readonly stopController = new AbortController();
  private readonly pairingIssuedAtMs: number;
  private pairingFailedAttempts = 0;
  private pairingClosed = false;
  private stopped = false;

  constructor(private readonly options: ImZenBridgeOptions) {
    this.pairingIssuedAtMs = (options.clock ?? Date.now)();
    if (
      options.pairingCodeTtlMs !== undefined &&
      (!Number.isFinite(options.pairingCodeTtlMs) || options.pairingCodeTtlMs <= 0)
    ) {
      throw new Error('pairingCodeTtlMs must be a positive finite number');
    }
    if (
      options.pairingCodeMaxFailedAttempts !== undefined &&
      (!Number.isInteger(options.pairingCodeMaxFailedAttempts) ||
        options.pairingCodeMaxFailedAttempts <= 0)
    ) {
      throw new Error('pairingCodeMaxFailedAttempts must be a positive integer');
    }
  }

  async start(): Promise<void> {
    await this.resolveProjectId();
    for (const job of this.options.state.pendingJobs()) this.schedule(job);
  }

  async accept(message: QQInboundMessage): Promise<'accepted' | 'ignored' | 'paired'> {
    if (!this.options.state.authorize(message.userId, this.options.config.allowedUserIds)) {
      if (!(await this.tryPair(message))) return 'ignored';
      return 'paired';
    }
    if (message.text === '/help') {
      await this.reply(message, 'IMZen commands: /threads, /bind <threadId>, /new, /status, /help');
      return 'accepted';
    }
    if (message.text === '/status') {
      await this.replyWithStatus(message);
      return 'accepted';
    }
    if (message.text === '/new' || message.text.startsWith('/new ')) {
      await this.enqueueConversationTask(message.conversationId, async () => {
        await this.createAndBindThread(message, message.text.slice('/new'.length).trim());
      });
      await this.reply(message, 'Created a new Zen thread for this conversation.');
      return 'accepted';
    }
    if (message.text === '/threads') {
      await this.enqueueConversationTask(message.conversationId, async () => {
        await this.replyWithThreads(message);
      });
      return 'accepted';
    }
    if (message.text === '/bind' || message.text.startsWith('/bind ')) {
      const threadId = message.text.slice('/bind'.length).trim();
      if (!threadId || threadId.includes(' ')) {
        await this.reply(message, 'Usage: /bind <threadId>');
        return 'accepted';
      }
      await this.enqueueConversationTask(message.conversationId, async () => {
        await this.bindExistingThread(message, threadId);
      });
      return 'accepted';
    }
    if (!message.text.trim()) return 'ignored';
    const enqueued = await this.options.state.enqueue(message);
    if (enqueued) {
      const job = this.options.state
        .pendingJobs()
        .find((entry) => entry.messageId === message.messageId);
      if (job) this.schedule(job);
    }
    return 'accepted';
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopController.abort();
    await Promise.allSettled([...this.active]);
  }

  private async tryPair(message: QQInboundMessage): Promise<boolean> {
    const pairingCode = this.options.pairingCode;
    if (this.options.config.allowedUserIds.size > 0 || !pairingCode || this.pairingClosed) {
      return false;
    }
    const text = message.text.trim();
    if (!text.startsWith('/pair ')) return false;
    if (this.isPairingExpired()) {
      this.pairingClosed = true;
      return false;
    }
    if (this.pairingFailedAttempts >= this.maxPairingFailedAttempts()) {
      this.pairingClosed = true;
      return false;
    }
    if (text !== `/pair ${pairingCode}`) {
      this.pairingFailedAttempts += 1;
      if (this.pairingFailedAttempts >= this.maxPairingFailedAttempts()) {
        this.pairingClosed = true;
      }
      return false;
    }
    if (!(await this.options.state.claimOwner(message.userId))) return false;
    this.pairingClosed = true;
    await this.reply(message, 'IMZen paired. This QQ identity now owns the bridge.');
    return true;
  }

  private schedule(job: PendingInboundJob): void {
    if (this.stopped) return;
    const task = this.enqueueConversationTask(job.conversationId, async () => {
      await this.runJob(job);
    });
    const settled = task.catch((cause: unknown) => {
      if (!this.stopController.signal.aborted) {
        console.error(`IMZen job failed message=${job.messageId}: ${errorMessage(cause)}`);
      }
    });
    void settled;
  }

  private enqueueConversationTask<T>(
    conversationId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.conversationTails.get(conversationId) ?? Promise.resolve();
    const task = previous.then(operation);
    const tail = task.then(
      () => undefined,
      () => undefined
    );
    this.conversationTails.set(conversationId, tail);
    this.active.add(tail);
    void tail.finally(() => {
      this.active.delete(tail);
      if (this.conversationTails.get(conversationId) === tail) {
        this.conversationTails.delete(conversationId);
      }
    });
    return task;
  }

  private isPairingExpired(): boolean {
    return (this.options.clock ?? Date.now)() >= this.pairingIssuedAtMs + this.pairingTtlMs();
  }

  private pairingTtlMs(): number {
    return this.options.pairingCodeTtlMs ?? DEFAULT_PAIRING_TTL_MS;
  }

  private maxPairingFailedAttempts(): number {
    return this.options.pairingCodeMaxFailedAttempts ?? DEFAULT_PAIRING_MAX_FAILED_ATTEMPTS;
  }

  private async runJob(initial: PendingInboundJob): Promise<void> {
    let job = initial;
    while (!this.stopController.signal.aborted) {
      try {
        const binding = await this.ensureBinding(job);
        const turnId = job.turnId ?? (await this.startTurn(binding, job));
        if (!job.turnId) {
          await this.options.state.updateJob(job.messageId, { turnId });
          job = { ...job, turnId };
        }
        const text = await this.waitForTurn(binding, turnId);
        await this.options.deliver({
          conversationId: job.conversationId,
          deliveryId: `qq:${job.messageId}:${turnId}`,
          receivedAtMs: job.receivedAtMs,
          replyToMessageId: job.messageId,
          text,
        });
        await this.options.state.completeJob(job.messageId);
        return;
      } catch (cause) {
        if (this.stopController.signal.aborted) return;
        const attempts = job.attempts + 1;
        const lastError = errorMessage(cause).slice(0, 400);
        await this.options.state.updateJob(job.messageId, { attempts, lastError });
        job = { ...job, attempts, lastError };
        console.error(`IMZen retrying message=${job.messageId} attempt=${attempts}: ${lastError}`);
        await this.sleep(Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6)));
      }
    }
  }

  private async ensureBinding(message: QQInboundMessage): Promise<ConversationBinding> {
    const projectId = await this.resolveProjectId();
    const existing = this.options.state.binding(message.conversationId);
    if (existing) {
      if (existing.projectId !== projectId) {
        return await this.createAndBindThread(message, '', projectId);
      }
      const response = await this.request('thread/read', {
        projectId: existing.projectId,
        threadId: existing.threadId,
      });
      if (response.ok) return existing;
      if (response.error.code === 'PROJECT_NOT_FOUND') {
        throw new Error(response.error.message);
      }
      if (response.error.code !== 'THREAD_NOT_FOUND') {
        throw new Error(response.error.message);
      }
      return await this.createAndBindThread(message, '', projectId);
    }
    return await this.createAndBindThread(message, '', projectId);
  }

  private async createAndBindThread(
    message: QQInboundMessage,
    requestedObjective: string,
    projectId?: string
  ): Promise<ConversationBinding> {
    const targetProjectId = projectId ?? (await this.resolveProjectId());
    const objective =
      requestedObjective ||
      `QQ ${message.kind === 'c2c' ? 'direct message' : 'group'} conversation ${message.conversationId}`;
    const response = await this.request('thread/create', {
      projectId: targetProjectId,
      objective,
      idempotencyKey: message.text.startsWith('/new')
        ? `imzen:new:${message.messageId}`
        : `imzen:thread:${digest(message.conversationId)}`,
    });
    const thread = resultRecord(response, 'thread/create', 'thread');
    if (typeof thread.id !== 'string') throw new Error('thread/create returned an invalid thread');
    const binding = { projectId: targetProjectId, threadId: thread.id };
    await this.options.state.bind(message.conversationId, binding);
    return binding;
  }

  private async resolveProjectId(): Promise<string> {
    if (this.options.config.projectId) {
      const response = await this.request('project/read', {
        projectId: this.options.config.projectId,
      });
      const project = resultRecord(response, 'project/read', 'project');
      if (project.status !== 'active') {
        const status = typeof project.status === 'string' ? project.status : 'invalid';
        if (status === 'archived') {
          throw new Error(`Configured Zen Project is archived: ${this.options.config.projectId}`);
        }
        throw new Error(`Configured Zen Project has invalid status: ${status}`);
      }
      const projectId = stringField(project, 'id');
      if (projectId !== this.options.config.projectId) {
        throw new Error(
          `App Server returned Project ${projectId} for requested Project ${this.options.config.projectId}`
        );
      }
      return projectId;
    }
    const response = await this.request('project/list', {});
    if (
      !response.ok ||
      response.method !== 'project/list' ||
      !Array.isArray(response.result.projects)
    ) {
      throw new Error(
        response.ok ? 'project/list returned an invalid result' : response.error.message
      );
    }
    const wanted = normalizePath(this.options.config.projectRoot);
    const project = response.result.projects.find(
      (entry) =>
        isRecord(entry) &&
        normalizePath(String(entry.rootPath ?? '')) === wanted &&
        entry.status === 'active'
    );
    if (!isRecord(project) || typeof project.id !== 'string') {
      throw new Error(
        `No active Zen Project matches IMZEN_PROJECT_ROOT (${basename(this.options.config.projectRoot)}). ` +
          'Create it in ZenX or set IMZEN_PROJECT_ID.'
      );
    }
    return project.id;
  }

  private async startTurn(binding: ConversationBinding, job: PendingInboundJob): Promise<string> {
    const response = await this.request('turn/start', {
      projectId: binding.projectId,
      threadId: binding.threadId,
      input: job.text,
      idempotencyKey: `imzen:qq:${job.messageId}`,
    });
    return stringField(resultRecord(response, 'turn/start', 'turn'), 'id');
  }

  private async waitForTurn(binding: ConversationBinding, turnId: string): Promise<string> {
    while (!this.stopController.signal.aborted) {
      const response = await this.request('thread/read', {
        projectId: binding.projectId,
        threadId: binding.threadId,
      });
      const thread = resultRecord(response, 'thread/read', 'thread');
      const turns = Array.isArray(thread.turns) ? thread.turns : [];
      const turn = turns.find((entry) => isRecord(entry) && entry.id === turnId);
      if (!isRecord(turn)) throw new Error(`Turn disappeared from Thread history: ${turnId}`);
      if (turn.status === 'failed' || turn.status === 'canceled') {
        return `Zen turn ${turn.status}: ${boundedJson(turn.error)}`;
      }
      if (turn.status === 'completed') return assistantOutput(thread, turnId);
      await this.sleep(this.options.pollIntervalMs ?? 750);
    }
    throw new Error('IMZen stopped');
  }

  private async replyWithStatus(message: QQInboundMessage): Promise<void> {
    const binding = this.options.state.binding(message.conversationId);
    if (!binding) {
      await this.reply(message, 'No Zen thread is bound to this QQ conversation.');
      return;
    }
    const response = await this.request('thread/read', {
      projectId: binding.projectId,
      threadId: binding.threadId,
    });
    const thread = resultRecord(response, 'thread/read', 'thread');
    await this.reply(
      message,
      `Zen thread ${binding.threadId}: ${String(thread.status ?? 'unknown')}`
    );
  }

  private async replyWithThreads(message: QQInboundMessage): Promise<void> {
    const projectId = await this.resolveProjectId();
    const response = await this.request('thread/list', { projectId });
    if (
      !response.ok ||
      response.method !== 'thread/list' ||
      !Array.isArray(response.result.threads)
    ) {
      throw new Error(
        response.ok ? 'thread/list returned an invalid result' : response.error.message
      );
    }
    const lines = response.result.threads.map((entry) => {
      if (!isRecord(entry)) throw new Error('thread/list returned an invalid Thread');
      const threadId =
        typeof entry.threadId === 'string'
          ? entry.threadId
          : typeof entry.id === 'string'
            ? entry.id
            : undefined;
      if (!threadId) throw new Error('thread/list returned a Thread without an id');
      const status = typeof entry.status === 'string' ? entry.status : 'unknown';
      const objective =
        typeof entry.objective === 'string' && entry.objective.trim()
          ? ` ${entry.objective.trim()}`
          : '';
      return `${threadId} [${status}]${objective}`;
    });
    await this.reply(
      message,
      lines.length > 0
        ? `Zen threads:\n${lines.join('\n')}`
        : 'No Zen threads exist in this Project.'
    );
  }

  private async bindExistingThread(message: QQInboundMessage, threadId: string): Promise<void> {
    const projectId = await this.resolveProjectId();
    const response = await this.request('thread/read', { projectId, threadId });
    const thread = resultRecord(response, 'thread/read', 'thread');
    const returnedThreadId =
      typeof thread.id === 'string'
        ? thread.id
        : typeof thread.threadId === 'string'
          ? thread.threadId
          : undefined;
    if (returnedThreadId !== threadId) {
      throw new Error(`App Server returned Thread ${String(returnedThreadId)} for ${threadId}`);
    }
    await this.options.state.bind(message.conversationId, { projectId, threadId });
    await this.reply(message, `Bound this QQ conversation to Zen thread ${threadId}.`);
  }

  private async reply(message: QQInboundMessage, text: string): Promise<void> {
    await this.options.deliver({
      conversationId: message.conversationId,
      deliveryId: `qq:${message.messageId}:command`,
      receivedAtMs: message.receivedAtMs,
      replyToMessageId: message.messageId,
      text,
    });
  }

  private async request(
    method: Parameters<AgentAppClient['request']>[0]['method'],
    params: Record<string, unknown>
  ) {
    return await this.options.client.request({ method, params } as Parameters<
      AgentAppClient['request']
    >[0]);
  }

  private async sleep(ms: number): Promise<void> {
    await (this.options.sleep ?? abortableSleep)(ms, this.stopController.signal);
  }
}

function resultRecord(
  response: AgentAppResponse,
  method: string,
  field: string
): Record<string, unknown> {
  if (!response.ok) throw new Error(response.error.message);
  if (response.method !== method || !isRecord(response.result[field])) {
    throw new Error(`${method} returned an invalid result`);
  }
  return response.result[field];
}

function assistantOutput(thread: Record<string, unknown>, turnId: string): string {
  const items = Array.isArray(thread.items) ? thread.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!isRecord(item) || item.turnId !== turnId || item.type !== 'assistant.message.completed')
      continue;
    if (
      isRecord(item.payload) &&
      typeof item.payload.content === 'string' &&
      item.payload.content.trim()
    ) {
      return item.payload.content.trim();
    }
  }
  return 'Zen turn completed without a text response.';
}

function stringField(value: Record<string, unknown>, field: string): string {
  if (typeof value[field] !== 'string' || !value[field]) throw new Error(`Missing ${field}`);
  return value[field];
}

function normalizePath(value: string): string {
  const normalized = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

function boundedJson(value: unknown): string {
  const text = value === undefined ? 'unknown error' : JSON.stringify(value);
  return text.length <= 500 ? text : `${text.slice(0, 499)}...`;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
