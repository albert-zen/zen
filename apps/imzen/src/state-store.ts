import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { ConversationBinding, PendingInboundJob, QQInboundMessage } from './types.js';

type PersistedState = {
  readonly bindings: Record<string, ConversationBinding>;
  readonly jobs: Record<string, PendingInboundJob>;
  readonly ownerUserId?: string;
  readonly version: 1;
};

const EMPTY_STATE: PersistedState = { bindings: {}, jobs: {}, version: 1 };
const MAX_PENDING_JOBS = 256;

export class ImZenStateStore {
  private tail = Promise.resolve();

  private constructor(
    readonly path: string,
    private state: PersistedState
  ) {}

  static async open(path: string): Promise<ImZenStateStore> {
    const absolutePath = resolve(path);
    let state = EMPTY_STATE;
    try {
      state = parseState(JSON.parse(await readFile(absolutePath, 'utf8')) as unknown);
    } catch (cause) {
      if (!isFileNotFound(cause)) throw cause;
    }
    return new ImZenStateStore(absolutePath, state);
  }

  ownerUserId(): string | undefined {
    return this.state.ownerUserId;
  }

  binding(conversationId: string): ConversationBinding | undefined {
    return this.state.bindings[conversationId];
  }

  pendingJobs(): readonly PendingInboundJob[] {
    return Object.values(this.state.jobs).sort(
      (left, right) => left.enqueuedAtMs - right.enqueuedAtMs
    );
  }

  authorize(userId: string, allowlist: ReadonlySet<string>): boolean {
    if (allowlist.size > 0) return allowlist.has(userId);
    return this.state.ownerUserId === userId;
  }

  async claimOwner(userId: string): Promise<boolean> {
    return await this.mutate((state) => {
      if (state.ownerUserId && state.ownerUserId !== userId) return [state, false];
      return [{ ...state, ownerUserId: userId }, true];
    });
  }

  async bind(conversationId: string, binding: ConversationBinding): Promise<void> {
    await this.mutate((state) => [
      { ...state, bindings: { ...state.bindings, [conversationId]: binding } },
      undefined,
    ]);
  }

  async enqueue(message: QQInboundMessage): Promise<boolean> {
    return await this.mutate((state) => {
      if (state.jobs[message.messageId]) return [state, false];
      if (Object.keys(state.jobs).length >= MAX_PENDING_JOBS) {
        throw new Error(`IMZen pending job limit reached (${MAX_PENDING_JOBS})`);
      }
      return [
        {
          ...state,
          jobs: {
            ...state.jobs,
            [message.messageId]: {
              ...message,
              attempts: 0,
              enqueuedAtMs: Date.now(),
            },
          },
        },
        true,
      ];
    });
  }

  async updateJob(messageId: string, change: Partial<PendingInboundJob>): Promise<void> {
    await this.mutate((state) => {
      const current = state.jobs[messageId];
      if (!current) return [state, undefined];
      return [
        { ...state, jobs: { ...state.jobs, [messageId]: { ...current, ...change } } },
        undefined,
      ];
    });
  }

  async completeJob(messageId: string): Promise<void> {
    await this.mutate((state) => {
      if (!state.jobs[messageId]) return [state, undefined];
      const jobs = { ...state.jobs };
      delete jobs[messageId];
      return [{ ...state, jobs }, undefined];
    });
  }

  private async mutate<T>(
    operation: (state: PersistedState) => readonly [PersistedState, T]
  ): Promise<T> {
    let result!: T;
    const task = this.tail.then(async () => {
      const [next, value] = operation(this.state);
      result = value;
      if (next === this.state) return;
      await writeState(this.path, next);
      this.state = next;
    });
    this.tail = task.catch(() => undefined);
    await task;
    return result;
  }
}

async function writeState(path: string, state: PersistedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await file.sync();
    await file.close();
    await rename(temporaryPath, path);
  } catch (cause) {
    await file.close().catch(() => undefined);
    throw cause;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function parseState(value: unknown): PersistedState {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.bindings) ||
    !isRecord(value.jobs)
  ) {
    throw new Error('IMZen state file is invalid');
  }
  const bindings = Object.fromEntries(
    Object.entries(value.bindings).map(([key, binding]) => {
      if (
        !isRecord(binding) ||
        typeof binding.projectId !== 'string' ||
        typeof binding.threadId !== 'string'
      ) {
        throw new Error('IMZen state contains an invalid conversation binding');
      }
      return [key, { projectId: binding.projectId, threadId: binding.threadId }];
    })
  );
  const jobs = Object.fromEntries(
    Object.entries(value.jobs).map(([key, job]) => [key, parseJob(job)])
  );
  return {
    version: 1,
    bindings,
    jobs,
    ...(typeof value.ownerUserId === 'string' ? { ownerUserId: value.ownerUserId } : {}),
  };
}

function parseJob(value: unknown): PendingInboundJob {
  if (
    !isRecord(value) ||
    (value.kind !== 'c2c' && value.kind !== 'group') ||
    typeof value.conversationId !== 'string' ||
    typeof value.messageId !== 'string' ||
    typeof value.receivedAtMs !== 'number' ||
    typeof value.text !== 'string' ||
    typeof value.userId !== 'string' ||
    typeof value.attempts !== 'number' ||
    typeof value.enqueuedAtMs !== 'number'
  ) {
    throw new Error('IMZen state contains an invalid pending job');
  }
  return value as unknown as PendingInboundJob;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileNotFound(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}
