import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentAppClient,
  AgentAppErrorCode,
  AgentAppRequest,
  AgentAppResponse,
} from '@zen/framework/product';
import { afterEach, describe, expect, it } from 'vitest';

import type { ImZenConfig } from '../src/config.js';
import { ImZenStateStore } from '../src/state-store.js';
import type { QQInboundMessage, QQOutboundMessage } from '../src/types.js';
import { ImZenBridge } from '../src/zen-bridge.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))
  );
});

describe('ImZenBridge', () => {
  it('requires pairing and uses one durable Zen Turn for duplicate QQ delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imzen-bridge-'));
    roots.push(root);
    const state = await ImZenStateStore.open(join(root, 'state.json'));
    const fake = new FakeAgentAppClient(root);
    const delivered: QQOutboundMessage[] = [];
    const bridge = new ImZenBridge({
      client: fake,
      config: config(root),
      deliver: async (message) => {
        delivered.push(message);
      },
      pairingCode: '123456',
      pollIntervalMs: 1,
      sleep: async () => undefined,
      state,
    });
    await bridge.start();

    await expect(bridge.accept(message('intruder', 'ignored', 'hello'))).resolves.toBe('ignored');
    await expect(bridge.accept(message('owner', 'pair', '/pair 123456'))).resolves.toBe('paired');
    const input = message('owner', 'message-1', 'do the work');
    await expect(bridge.accept(input)).resolves.toBe('accepted');
    await expect(bridge.accept(input)).resolves.toBe('accepted');
    await waitUntil(() => state.pendingJobs().length === 0);

    expect(fake.methods.filter((method) => method === 'turn/start')).toHaveLength(1);
    expect(delivered.map((entry) => entry.text)).toEqual([
      'IMZen paired. This QQ identity now owns the bridge.',
      'answer from Zen',
    ]);
    await bridge.stop();
  });

  it('matches an existing Project root and never creates a Project from QQ', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imzen-bridge-'));
    roots.push(root);
    const state = await ImZenStateStore.open(join(root, 'state.json'));
    const fake = new FakeAgentAppClient(root);
    const bridge = new ImZenBridge({
      client: fake,
      config: { ...config(root), allowedUserIds: new Set(['owner']) },
      deliver: async () => undefined,
      pollIntervalMs: 1,
      sleep: async () => undefined,
      state,
    });
    await bridge.start();
    await bridge.accept(message('owner', 'message-2', 'hello'));
    await waitUntil(() => state.pendingJobs().length === 0);

    expect(fake.methods).toContain('project/list');
    expect(fake.methods).not.toContain('project/create');
    expect(state.binding('c2c:owner')).toEqual({ projectId: 'project-1', threadId: 'thread-1' });
    await bridge.stop();
  });

  it('lists Project Threads and binds the conversation only after App Server validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imzen-bridge-'));
    roots.push(root);
    const state = await ImZenStateStore.open(join(root, 'state.json'));
    const fake = new FakeAgentAppClient(root, {
      listedThreads: [
        {
          threadId: 'thread-from-zenx',
          status: 'completed',
          objective: 'Started in ZenX',
        },
      ],
    });
    const delivered: QQOutboundMessage[] = [];
    const bridge = new ImZenBridge({
      client: fake,
      config: { ...config(root), allowedUserIds: new Set(['owner']) },
      deliver: async (outbound) => {
        delivered.push(outbound);
      },
      pollIntervalMs: 1,
      sleep: async () => undefined,
      state,
    });
    await bridge.start();

    await expect(bridge.accept(message('owner', 'threads', '/threads'))).resolves.toBe('accepted');
    await expect(bridge.accept(message('owner', 'bind', '/bind thread-from-zenx'))).resolves.toBe(
      'accepted'
    );
    expect(state.binding('c2c:owner')).toEqual({
      projectId: 'project-1',
      threadId: 'thread-from-zenx',
    });

    await bridge.accept(message('owner', 'continued', 'continue from QQ'));
    await waitUntil(() => state.pendingJobs().length === 0);

    expect(delivered.map((entry) => entry.text)).toEqual([
      'Zen threads:\nthread-from-zenx [completed] Started in ZenX',
      'Bound this QQ conversation to Zen thread thread-from-zenx.',
      'answer from Zen',
    ]);
    expect(fake.requests.find((request) => request.method === 'turn/start')?.params.threadId).toBe(
      'thread-from-zenx'
    );
    await bridge.stop();
  });

  it('does not persist /bind when the selected Thread cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imzen-bridge-'));
    roots.push(root);
    const state = await ImZenStateStore.open(join(root, 'state.json'));
    const bridge = new ImZenBridge({
      client: new FakeAgentAppClient(root),
      config: { ...config(root), allowedUserIds: new Set(['owner']) },
      deliver: async () => undefined,
      state,
    });
    await bridge.start();

    await expect(
      bridge.accept(message('owner', 'bind-missing', '/bind missing-thread'))
    ).rejects.toThrow('missing');
    expect(state.binding('c2c:owner')).toBeUndefined();
    await bridge.stop();
  });

  it('serializes /new behind an older auto-binding job', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imzen-bridge-'));
    roots.push(root);
    const state = await ImZenStateStore.open(join(root, 'state.json'));
    let releaseProjectList!: () => void;
    const projectListReleased = new Promise<void>((resolvePromise) => {
      releaseProjectList = resolvePromise;
    });
    const fake = new FakeAgentAppClient(root, { projectListGate: projectListReleased });
    const bridge = new ImZenBridge({
      client: fake,
      config: { ...config(root), allowedUserIds: new Set(['owner']) },
      deliver: async () => undefined,
      pollIntervalMs: 1,
      sleep: async () => undefined,
      state,
    });
    await bridge.start();
    await bridge.accept(message('owner', 'message-before-new', 'hello'));
    await waitUntil(() => fake.methods.filter((method) => method === 'project/list').length === 2);

    let newAcknowledged = false;
    const newMessage = bridge.accept(message('owner', 'new-message', '/new reset objective'));
    void newMessage.then(() => {
      newAcknowledged = true;
    });
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(newAcknowledged).toBe(false);

    releaseProjectList();
    await expect(newMessage).resolves.toBe('accepted');
    expect(state.binding('c2c:owner')).toEqual({ projectId: 'project-1', threadId: 'thread-2' });
    await bridge.stop();
  });

  it('closes pairing after failed-attempt exhaustion and expiry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imzen-bridge-'));
    roots.push(root);
    const state = await ImZenStateStore.open(join(root, 'state.json'));
    let now = 1_000;
    const bridge = new ImZenBridge({
      client: new FakeAgentAppClient(root),
      config: config(root),
      deliver: async () => undefined,
      clock: () => now,
      pairingCode: '123456',
      pairingCodeMaxFailedAttempts: 2,
      pairingCodeTtlMs: 100,
      state,
    });

    await expect(bridge.accept(message('intruder-1', 'wrong-1', '/pair 000000'))).resolves.toBe(
      'ignored'
    );
    await expect(bridge.accept(message('intruder-2', 'wrong-2', '/pair 111111'))).resolves.toBe(
      'ignored'
    );
    await expect(
      bridge.accept(message('owner', 'right-after-exhaustion', '/pair 123456'))
    ).resolves.toBe('ignored');
    expect(state.ownerUserId()).toBeUndefined();
    await bridge.stop();

    const expiredState = await ImZenStateStore.open(join(root, 'expired-state.json'));
    const expiredBridge = new ImZenBridge({
      client: new FakeAgentAppClient(root),
      config: config(root),
      deliver: async () => undefined,
      clock: () => now,
      pairingCode: '123456',
      pairingCodeTtlMs: 100,
      state: expiredState,
    });
    now = 2_101;
    await expect(expiredBridge.accept(message('owner', 'expired', '/pair 123456'))).resolves.toBe(
      'ignored'
    );
    expect(expiredState.ownerUserId()).toBeUndefined();
    await expiredBridge.stop();
  });

  it('does not recreate a binding when its Project is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imzen-bridge-'));
    roots.push(root);
    const state = await ImZenStateStore.open(join(root, 'state.json'));
    await state.bind('c2c:owner', { projectId: 'project-1', threadId: 'old-thread' });
    const fake = new FakeAgentAppClient(root, { threadReadError: 'PROJECT_NOT_FOUND' });
    const bridge = new ImZenBridge({
      client: fake,
      config: { ...config(root), allowedUserIds: new Set(['owner']) },
      deliver: async () => undefined,
      sleep: async () => undefined,
      state,
    });
    await bridge.start();
    await bridge.accept(message('owner', 'message-3', 'hello'));
    await waitUntil(() => (state.pendingJobs()[0]?.attempts ?? 0) > 0);
    await bridge.stop();

    expect(fake.methods).not.toContain('thread/create');
    expect(fake.methods).toContain('project/list');
  });

  it('replaces a missing Thread only inside the stored Project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imzen-bridge-'));
    roots.push(root);
    const state = await ImZenStateStore.open(join(root, 'state.json'));
    await state.bind('c2c:owner', { projectId: 'project-1', threadId: 'old-thread' });
    const fake = new FakeAgentAppClient(root, { threadReadError: 'THREAD_NOT_FOUND' });
    const bridge = new ImZenBridge({
      client: fake,
      config: { ...config(root), allowedUserIds: new Set(['owner']) },
      deliver: async () => undefined,
      pollIntervalMs: 1,
      sleep: async () => undefined,
      state,
    });
    await bridge.start();
    await bridge.accept(message('owner', 'message-4', 'hello'));
    await waitUntil(() => state.pendingJobs().length === 0);
    await bridge.stop();

    expect(
      fake.requests.find((request) => request.method === 'thread/create')?.params.projectId
    ).toBe('project-1');
    expect(state.binding('c2c:owner')).toEqual({ projectId: 'project-1', threadId: 'thread-1' });
  });

  it('rejects an archived configured Project before creating a Thread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imzen-bridge-'));
    roots.push(root);
    const state = await ImZenStateStore.open(join(root, 'state.json'));
    const fake = new FakeAgentAppClient(root, { projectStatus: 'archived' });
    const bridge = new ImZenBridge({
      client: fake,
      config: { ...config(root), allowedUserIds: new Set(['owner']), projectId: 'project-1' },
      deliver: async () => undefined,
      state,
    });
    await expect(bridge.start()).rejects.toThrow('archived');
    expect(fake.methods).not.toContain('thread/create');
    await bridge.stop();
  });

  it('fails startup when the App Server rejects the selected Project request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imzen-bridge-'));
    roots.push(root);
    const state = await ImZenStateStore.open(join(root, 'state.json'));
    const fake = new FakeAgentAppClient(root, {
      projectReadError: new Error('App Server capability is invalid'),
    });
    const bridge = new ImZenBridge({
      client: fake,
      config: { ...config(root), allowedUserIds: new Set(['owner']), projectId: 'project-1' },
      deliver: async () => undefined,
      state,
    });

    await expect(bridge.start()).rejects.toThrow('capability is invalid');
    expect(fake.methods).toEqual(['project/read']);
    await bridge.stop();
  });

  it('fails startup when the selected Project is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imzen-bridge-'));
    roots.push(root);
    const state = await ImZenStateStore.open(join(root, 'state.json'));
    const fake = new FakeAgentAppClient(root, { projectReadErrorCode: 'PROJECT_NOT_FOUND' });
    const bridge = new ImZenBridge({
      client: fake,
      config: { ...config(root), allowedUserIds: new Set(['owner']), projectId: 'project-1' },
      deliver: async () => undefined,
      state,
    });

    await expect(bridge.start()).rejects.toThrow('missing: PROJECT_NOT_FOUND');
    expect(fake.methods).toEqual(['project/read']);
    await bridge.stop();
  });
});

class FakeAgentAppClient implements AgentAppClient {
  readonly methods: string[] = [];
  readonly requests: AgentAppRequest[] = [];
  private threadCreated = false;
  private threadCreateCount = 0;
  private readonly projectStatus: 'active' | 'archived';
  private readonly projectListGate?: Promise<void>;
  private readonly projectReadError?: Error;
  private readonly projectReadErrorCode?: AgentAppErrorCode;
  private readonly threadReadError?: AgentAppErrorCode;
  private readonly listedThreads: readonly Record<string, unknown>[];

  constructor(
    private readonly root: string,
    options: {
      projectListGate?: Promise<void>;
      projectReadError?: Error;
      projectReadErrorCode?: AgentAppErrorCode;
      projectStatus?: 'active' | 'archived';
      threadReadError?: AgentAppErrorCode;
      listedThreads?: readonly Record<string, unknown>[];
    } = {}
  ) {
    this.projectStatus = options.projectStatus ?? 'active';
    this.projectListGate = options.projectListGate;
    this.projectReadError = options.projectReadError;
    this.projectReadErrorCode = options.projectReadErrorCode;
    this.threadReadError = options.threadReadError;
    this.listedThreads = options.listedThreads ?? [];
  }

  async request(request: AgentAppRequest): Promise<AgentAppResponse> {
    this.methods.push(request.method);
    this.requests.push(request);
    if (request.method === 'project/read') {
      if (this.projectReadError) throw this.projectReadError;
      if (this.projectReadErrorCode) {
        return {
          method: request.method,
          ok: false,
          error: {
            code: this.projectReadErrorCode,
            message: `missing: ${this.projectReadErrorCode}`,
          },
        };
      }
      return ok(request.method, {
        project: { id: 'project-1', rootPath: this.root, status: this.projectStatus },
      });
    }
    if (request.method === 'project/list') {
      if (
        this.projectListGate &&
        this.methods.filter((method) => method === 'project/list').length > 1
      ) {
        await this.projectListGate;
      }
      return ok(request.method, {
        projects: [{ id: 'project-1', rootPath: this.root, status: this.projectStatus }],
      });
    }
    if (request.method === 'thread/create') {
      this.threadCreated = true;
      this.threadCreateCount += 1;
      return ok(request.method, {
        thread: threadSnapshot('idle', `thread-${this.threadCreateCount}`),
      });
    }
    if (request.method === 'thread/list') {
      return ok(request.method, { threads: this.listedThreads });
    }
    if (request.method === 'thread/read') {
      if (this.threadReadError && !this.threadCreated) {
        return {
          method: request.method,
          ok: false,
          error: { code: this.threadReadError, message: `missing: ${this.threadReadError}` },
        };
      }
      if (!this.threadCreated) {
        const listed = this.listedThreads.find(
          (thread) => thread.threadId === request.params.threadId
        );
        if (listed) {
          return ok(request.method, {
            thread: threadSnapshot('completed', String(listed.threadId)),
          });
        }
        return {
          method: request.method,
          ok: false,
          error: { code: 'THREAD_NOT_FOUND', message: 'missing' },
        };
      }
      return ok(request.method, { thread: threadSnapshot('completed') });
    }
    if (request.method === 'turn/start') {
      return ok(request.method, {
        turn: { id: 'turn-1', runId: 'run-1', status: 'queued', itemIds: [] },
      });
    }
    throw new Error(`Unexpected method: ${request.method}`);
  }

  subscribe(): () => void {
    return () => undefined;
  }
}

function threadSnapshot(turnStatus: string, id = 'thread-1'): Record<string, unknown> {
  return {
    id,
    status: 'idle',
    turns:
      turnStatus === 'completed'
        ? [{ id: 'turn-1', runId: 'run-1', status: 'completed', itemIds: ['assistant-1'] }]
        : [],
    items:
      turnStatus === 'completed'
        ? [
            {
              id: 'assistant-1',
              type: 'assistant.message.completed',
              createdAtMs: 1,
              seq: 1,
              runId: 'run-1',
              turnId: 'turn-1',
              payload: { content: 'answer from Zen' },
            },
          ]
        : [],
  };
}

function ok(method: AgentAppRequest['method'], result: Record<string, unknown>): AgentAppResponse {
  return { method, ok: true, result } as AgentAppResponse;
}

function config(root: string): ImZenConfig {
  return {
    allowedUserIds: new Set(),
    appServerCapability: 'x'.repeat(32),
    appServerUrl: 'http://127.0.0.1:3000/',
    dataDir: root,
    projectRoot: root,
    qqApiBase: 'https://api.sgroup.qq.com',
    qqCredential: { appId: '1', appSecret: 'secret' },
    qqSecretFile: join(root, 'secret.json'),
  };
}

function message(userId: string, messageId: string, text: string): QQInboundMessage {
  return {
    conversationId: `c2c:${userId}`,
    kind: 'c2c',
    messageId,
    receivedAtMs: Date.now(),
    text,
    userId,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error('Timed out waiting for bridge work');
}
