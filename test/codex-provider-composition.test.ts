import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  CodexAppServerCancelLoginResult,
  CodexAppServerLoginInput,
  CodexAppServerLoginResult,
  CodexAppServerNotification,
  CodexAppServerRequestHandler,
  CodexAppServerResumeThreadInput,
  CodexAppServerStartThreadInput,
  CodexAppServerStartTurnInput,
  CodexAppServerThreadResult,
  CodexAppServerTurnResult,
} from '../packages/framework/src/adapters/node/codex-app-server-client.js';
import {
  CodexProviderService,
  createAgentAppProductionComposition,
  type CodexProviderClient,
} from './test-exports.js';

describe('Codex provider production composition', () => {
  it('owns one lazy provider client across project threads and closes it with the composition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zen-codex-composition-'));
    const client = new AutoCompletingCodexClient();
    let starts = 0;
    const provider = new CodexProviderService({
      clientFactory: async () => {
        starts += 1;
        return client;
      },
    });
    const composition = await createAgentAppProductionComposition({
      appDataRoot: join(root, 'app-data'),
      codexProviderService: provider,
    });

    try {
      await expect(
        composition.agentAppServer.request({ method: 'provider/read', params: {} })
      ).resolves.toEqual({
        method: 'provider/read',
        ok: true,
        result: {
          status: {
            state: 'ready',
            cli: { state: 'ready', command: 'C:\\Codex\\codex.exe' },
            account: {
              state: 'authenticated',
              account: { type: 'chatgpt', email: 'person@example.com' },
              requiresOpenaiAuth: true,
            },
            models: {
              state: 'ready',
              items: [
                {
                  id: 'gpt-5-codex',
                  model: 'gpt-5-codex',
                  displayName: 'GPT-5 Codex',
                  hidden: false,
                },
              ],
            },
          },
        },
      });
      expect(starts).toBe(1);
      await expect(
        composition.agentAppServer.request({ method: 'provider/refresh', params: {} })
      ).resolves.toMatchObject({
        method: 'provider/refresh',
        ok: true,
        result: {
          status: {
            state: 'ready',
            account: { account: { type: 'chatgpt', email: 'person@example.com' } },
            models: { items: [{ id: 'gpt-5-codex' }] },
          },
        },
      });
      expect(starts).toBe(1);

      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      const project = await composition.agentAppServer.request({
        method: 'project/create',
        params: {
          name: 'Codex',
          rootPath: workspace,
          policy: policy({ defaultModelProfile: 'project-model' }),
          idempotencyKey: 'project',
        },
      });
      const projectId = value(project, 'project', 'id');
      const first = await composition.agentAppServer.request({
        method: 'thread/create',
        params: {
          projectId,
          modelProfile: 'thread-model',
          idempotencyKey: 'thread-1',
        },
      });
      const second = await composition.agentAppServer.request({
        method: 'thread/create',
        params: { projectId, idempotencyKey: 'thread-2' },
      });

      await composition.agentAppServer.request({
        method: 'turn/start',
        params: {
          projectId,
          threadId: value(first, 'thread', 'id'),
          input: 'first',
          idempotencyKey: 'turn-1',
        },
      });
      await composition.agentAppServer.request({
        method: 'turn/start',
        params: {
          projectId,
          threadId: value(second, 'thread', 'id'),
          input: 'second',
          idempotencyKey: 'turn-2',
        },
      });
      await waitFor(() => client.startThreadInputs.length === 2);

      expect(starts).toBe(1);
      expect(client.startThreadInputs.map((input) => input.model)).toEqual([
        'thread-model',
        'project-model',
      ]);
      expect(client.closeCalls).toBe(0);
    } finally {
      await composition.close();
      expect(client.closeCalls).toBe(1);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('forwards only supported login controls through the shared provider client', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zen-codex-provider-control-'));
    const client = new AutoCompletingCodexClient();
    let starts = 0;
    const composition = await createAgentAppProductionComposition({
      appDataRoot: join(root, 'app-data'),
      codexProviderService: new CodexProviderService({
        clientFactory: async () => {
          starts += 1;
          return client;
        },
      }),
    });

    try {
      await expect(
        composition.agentAppServer.request({
          method: 'provider/login/start',
          params: {
            type: 'chatgpt',
            codexStreamlinedLogin: true,
            appBrand: 'chatgpt',
            idempotencyKey: 'login-start',
          },
        })
      ).resolves.toMatchObject({ ok: true });
      await expect(
        composition.agentAppServer.request({
          method: 'provider/login/cancel',
          params: { loginId: 'login', idempotencyKey: 'login-cancel' },
        })
      ).resolves.toMatchObject({ ok: true });
      await expect(
        composition.agentAppServer.request({
          method: 'provider/login/start',
          params: { type: 'chatgptDeviceCode', idempotencyKey: 'device-login-start' },
        })
      ).resolves.toMatchObject({ ok: true });
      await expect(
        composition.agentAppServer.request({
          method: 'provider/logout',
          params: { idempotencyKey: 'logout' },
        })
      ).resolves.toMatchObject({ ok: true });

      expect(client.loginInputs).toEqual([
        { type: 'chatgpt', codexStreamlinedLogin: true, appBrand: 'chatgpt' },
        { type: 'chatgptDeviceCode' },
      ]);
      expect(client.canceledLogins).toEqual(['login']);
      expect(client.logoutCalls).toBe(1);
      expect(starts).toBe(1);

      await expect(
        composition.agentAppServer.request({
          method: 'provider/login/start',
          params: { type: 'apiKey', apiKey: 'must-not-forward', idempotencyKey: 'invalid-login' },
        })
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      });
      await expect(
        composition.agentAppServer.request({
          method: 'provider/login/cancel',
          params: { idempotencyKey: 'missing-login-id' },
        })
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      });
      expect(client.loginInputs).toHaveLength(2);
    } finally {
      await composition.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps an explicit createModel override on the legacy execution path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zen-codex-model-override-'));
    const client = new AutoCompletingCodexClient();
    let starts = 0;
    let modelCalls = 0;
    const composition = await createAgentAppProductionComposition({
      appDataRoot: join(root, 'app-data'),
      codexProviderService: new CodexProviderService({
        clientFactory: async () => {
          starts += 1;
          return client;
        },
      }),
      createModel: () => ({
        async *generate() {
          modelCalls += 1;
          yield { type: 'message.completed' as const, content: 'legacy' };
        },
      }),
    });

    try {
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      const project = await composition.agentAppServer.request({
        method: 'project/create',
        params: {
          name: 'Legacy',
          rootPath: workspace,
          policy: policy(),
          idempotencyKey: 'project',
        },
      });
      const projectId = value(project, 'project', 'id');
      const thread = await composition.agentAppServer.request({
        method: 'thread/create',
        params: { projectId, idempotencyKey: 'thread' },
      });
      await composition.agentAppServer.request({
        method: 'turn/start',
        params: {
          projectId,
          threadId: value(thread, 'thread', 'id'),
          input: 'legacy',
          idempotencyKey: 'turn',
        },
      });
      await waitFor(() => modelCalls === 1);
      expect(starts).toBe(0);
    } finally {
      await composition.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

class AutoCompletingCodexClient implements CodexProviderClient {
  readonly command = 'C:\\Codex\\codex.exe';
  readonly startThreadInputs: CodexAppServerStartThreadInput[] = [];
  readonly loginInputs: CodexAppServerLoginInput[] = [];
  readonly canceledLogins: string[] = [];
  closeCalls = 0;
  logoutCalls = 0;
  private nextThread = 1;
  private nextTurn = 1;
  private readonly notifications = new Set<(notification: CodexAppServerNotification) => void>();

  async readAccount() {
    return {
      account: {
        type: 'chatgpt',
        email: 'person@example.com',
        accessToken: 'must-not-reach-zen-protocol',
      },
      requiresOpenaiAuth: true,
    };
  }

  async listModels() {
    return [
      {
        id: 'gpt-5-codex',
        model: 'gpt-5-codex',
        displayName: 'GPT-5 Codex',
        hidden: false,
      },
    ];
  }

  async startLogin(input: CodexAppServerLoginInput): Promise<CodexAppServerLoginResult> {
    this.loginInputs.push(input);
    return { type: 'chatgptDeviceCode', loginId: 'login', verificationUrl: '', userCode: '' };
  }

  async cancelLogin(loginId: string): Promise<CodexAppServerCancelLoginResult> {
    this.canceledLogins.push(loginId);
    return { status: 'canceled' };
  }

  async logout() {
    this.logoutCalls += 1;
    return {} as Readonly<Record<string, never>>;
  }

  async startThread(input: CodexAppServerStartThreadInput): Promise<CodexAppServerThreadResult> {
    this.startThreadInputs.push(input);
    return { thread: { id: `provider-thread-${this.nextThread++}` } };
  }

  async resumeThread(input: CodexAppServerResumeThreadInput): Promise<CodexAppServerThreadResult> {
    return { thread: { id: input.threadId } };
  }

  async startTurn(input: CodexAppServerStartTurnInput): Promise<CodexAppServerTurnResult> {
    const id = `provider-turn-${this.nextTurn++}`;
    queueMicrotask(() => {
      this.notifications.forEach((listener) =>
        listener({
          method: 'turn/completed',
          params: { threadId: input.threadId, turn: { id, status: 'completed', items: [] } },
        })
      );
    });
    return { turn: { id } };
  }

  async interruptTurn() {
    return {} as Readonly<Record<string, never>>;
  }

  async unsubscribeThread() {
    return { status: 'unsubscribed' };
  }

  subscribe(listener: (notification: CodexAppServerNotification) => void) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  registerServerRequestHandler(_method: string, _handler: CodexAppServerRequestHandler) {
    return () => undefined;
  }

  onExit(_listener: (cause: Error) => void) {
    return () => undefined;
  }

  async close() {
    this.closeCalls += 1;
  }
}

function policy(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    maxActiveExecutions: 2,
    maxThreadDepth: 4,
    agentCanCreateThreads: true,
    agentCanMessagePeers: true,
    ...overrides,
  };
}

function value(response: unknown, parent: string, child: string): string {
  const result = response as { readonly ok?: boolean; readonly result?: Record<string, unknown> };
  if (!result.ok || typeof result.result?.[parent] !== 'object' || result.result[parent] === null) {
    throw new Error(`Missing ${parent} response`);
  }
  const nested = result.result[parent] as Record<string, unknown>;
  if (typeof nested[child] !== 'string') throw new Error(`Missing ${parent}.${child}`);
  return nested[child];
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for Codex composition execution');
}
