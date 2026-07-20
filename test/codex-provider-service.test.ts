import { describe, expect, it } from 'vitest';

import {
  CodexAppServerClosedError,
  CodexProviderService,
  type CodexAccount,
  type CodexProviderClient,
} from '../src/adapters/node/index.js';

describe('CodexProviderService', () => {
  it('starts lazily, coalesces status work, and caches the account and catalog in memory', async () => {
    const client = new FakeProviderClient();
    let starts = 0;
    const service = new CodexProviderService({
      clientFactory: async () => {
        starts += 1;
        return client;
      },
    });

    expect(service.peekStatus()).toMatchObject({
      state: 'idle',
      cli: { state: 'idle' },
      account: { state: 'unknown' },
      models: { state: 'unknown', items: [] },
    });
    expect(starts).toBe(0);

    const [first, second] = await Promise.all([service.status(), service.status()]);

    expect(starts).toBe(1);
    expect(client.accountReads).toBe(1);
    expect(client.modelReads).toBe(1);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      state: 'ready',
      cli: { state: 'ready', command: 'C:\\Codex\\codex.exe' },
      account: { state: 'authenticated', account: { type: 'chatgpt' } },
      models: { state: 'ready', items: [{ id: 'gpt-5.4' }] },
    });

    client.account = { account: null, requiresOpenaiAuth: true };
    await expect(service.refresh()).resolves.toMatchObject({
      state: 'ready',
      account: { state: 'unauthenticated', requiresOpenaiAuth: true },
    });
    expect(client.accountReads).toBe(2);
    expect(client.modelReads).toBe(2);

    await service.close();
    expect(client.closeCalls).toBe(1);
    await expect(service.getClient()).rejects.toBeInstanceOf(CodexAppServerClosedError);
  });

  it('reports startup errors and closes a client that resolves after the service closes', async () => {
    const unavailable = new CodexProviderService({
      clientFactory: async () => {
        throw new Error('Codex executable was not found');
      },
    });
    await expect(unavailable.status()).resolves.toMatchObject({
      state: 'error',
      cli: { state: 'error' },
      error: 'Codex executable was not found',
    });

    const client = new FakeProviderClient();
    let resolveFactory: ((client: CodexProviderClient) => void) | undefined;
    const service = new CodexProviderService({
      clientFactory: async () =>
        await new Promise<CodexProviderClient>((resolve) => {
          resolveFactory = resolve;
        }),
    });
    const pendingClient = service.getClient();
    const closing = service.close();
    resolveFactory?.(client);

    await expect(pendingClient).rejects.toBeInstanceOf(CodexAppServerClosedError);
    await closing;
    expect(client.closeCalls).toBe(1);
  });

  it('delegates interactive account operations without retaining credentials', async () => {
    const client = new FakeProviderClient();
    const service = new CodexProviderService({ clientFactory: async () => client });

    await expect(service.startLogin({ type: 'chatgptDeviceCode' })).resolves.toEqual({
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.example/device',
      userCode: 'ABCDE',
    });
    await expect(service.cancelLogin('login-1')).resolves.toEqual({ status: 'canceled' });
    await expect(service.logout()).resolves.toEqual({});
    expect(client.loginInputs).toEqual([{ type: 'chatgptDeviceCode' }]);
    expect(client.canceledLogins).toEqual(['login-1']);
    expect(client.logoutCalls).toBe(1);

    await service.close();
  });

  it('fails active routes on child exit and coalesces one later replacement client', async () => {
    const first = new FakeProviderClient();
    const second = new FakeProviderClient();
    const clients = [first, second];
    let starts = 0;
    const service = new CodexProviderService({
      clientFactory: async () => clients[starts++]!,
    });

    await expect(service.getClient()).resolves.toBe(first);
    const failures: Error[] = [];
    const registration = service.registerPendingTurnRoute({
      providerThreadId: 'provider-thread',
      bindProviderTurn: () => undefined,
      onNotification: () => undefined,
      onDynamicToolCall: async () => ({ success: true, contentItems: [] }),
      onNativeApproval: async () => ({ decision: 'decline' }),
      onProviderFailure: (cause) => failures.push(cause),
    });
    registration.bind('provider-turn');

    first.exit(new CodexAppServerClosedError('Codex child exited (code 17)'));

    expect(failures.map((cause) => cause.message)).toEqual(['Codex child exited (code 17)']);
    expect(service.peekStatus()).toMatchObject({
      state: 'error',
      cli: { state: 'error' },
      account: { state: 'unknown' },
      models: { state: 'unknown', items: [] },
      error: 'Codex child exited (code 17)',
    });
    const [replacementA, replacementB] = await Promise.all([
      service.getClient(),
      service.getClient(),
    ]);
    expect(replacementA).toBe(second);
    expect(replacementB).toBe(second);
    expect(starts).toBe(2);
    await expect(service.refresh()).resolves.toMatchObject({
      state: 'ready',
      cli: { command: 'C:\\Codex\\codex.exe' },
      account: { state: 'authenticated' },
      models: { state: 'ready', items: [{ id: 'gpt-5.4' }] },
    });

    await service.close();
    expect(first.closeCalls).toBe(0);
    expect(second.closeCalls).toBe(1);
  });
});

class FakeProviderClient implements CodexProviderClient {
  readonly command = 'C:\\Codex\\codex.exe';
  account: { readonly account: CodexAccount | null; readonly requiresOpenaiAuth: boolean } = {
    account: { type: 'chatgpt', email: 'user@example.test' },
    requiresOpenaiAuth: true,
  };
  models = [
    {
      id: 'gpt-5.4',
      model: 'gpt-5.4',
      displayName: 'GPT-5.4',
      hidden: false,
    },
  ];
  accountReads = 0;
  modelReads = 0;
  closeCalls = 0;
  logoutCalls = 0;
  readonly loginInputs: unknown[] = [];
  readonly canceledLogins: string[] = [];
  private readonly exitListeners = new Set<(cause: Error) => void>();

  async readAccount() {
    this.accountReads += 1;
    return this.account;
  }

  async listModels() {
    this.modelReads += 1;
    return this.models;
  }

  async startLogin(input: { readonly type: string }) {
    this.loginInputs.push(input);
    return {
      type: 'chatgptDeviceCode' as const,
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.example/device',
      userCode: 'ABCDE',
    };
  }

  async cancelLogin(loginId: string) {
    this.canceledLogins.push(loginId);
    return { status: 'canceled' as const };
  }

  async logout() {
    this.logoutCalls += 1;
    return {} as Readonly<Record<string, never>>;
  }

  async startThread() {
    return { thread: { id: 'provider-thread' } };
  }

  async resumeThread() {
    return { thread: { id: 'provider-thread' } };
  }

  async startTurn() {
    return { turn: { id: 'provider-turn' } };
  }

  async interruptTurn() {
    return {} as Readonly<Record<string, never>>;
  }

  async unsubscribeThread() {
    return { status: 'unsubscribed' };
  }

  subscribe() {
    return () => undefined;
  }

  registerServerRequestHandler() {
    return () => undefined;
  }

  onExit(listener: (cause: Error) => void) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async close() {
    this.closeCalls += 1;
  }

  exit(cause: Error): void {
    [...this.exitListeners].forEach((listener) => listener(cause));
  }
}
