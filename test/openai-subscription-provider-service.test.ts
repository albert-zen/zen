import * as nodeFiles from 'node:fs/promises';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OpenAISubscriptionProviderClosedError,
  OpenAISubscriptionProviderService,
  type OpenAISubscriptionFileSystem,
  type OpenAISubscriptionOAuthCredential,
  type OpenAISubscriptionProvider,
  type OpenAISubscriptionProviderInteraction,
} from '../packages/framework/src/adapters/node/openai-subscription-provider-service.js';

const services: OpenAISubscriptionProviderService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  vi.unstubAllGlobals();
});

describe('OpenAISubscriptionProviderService', () => {
  it('never imports Codex auth and starts only from a Zen-owned credential', async () => {
    const root = await temporaryRoot();
    const codexAuthPath = join(root, 'codex-auth.json');
    await writeFile(
      codexAuthPath,
      JSON.stringify({
        tokens: {
          access_token: 'codex-access-secret',
          refresh_token: 'seed-refresh-secret',
        },
      })
    );
    const service = createService(root);

    await expect(service.status()).resolves.toMatchObject({
      account: { state: 'unauthenticated' },
      auth: { state: 'unauthenticated' },
    });
    await expect(service.resolveAccessToken()).rejects.toThrow('not authenticated');
    await expect(fileExists(service.credentialPath)).resolves.toBe(false);

    const source = await readFile(
      new URL(
        '../packages/framework/src/adapters/node/openai-subscription-provider-service.ts',
        import.meta.url
      ),
      'utf8'
    );
    expect(source).not.toMatch(/\.codex[\\/]auth\.json|readCodexSeed|codexAuthPath/);
  });

  it('serializes near-expiry refreshes and atomically persists the rotated credential', async () => {
    const root = await temporaryRoot();
    const now = Date.parse('2026-07-21T00:00:00.000Z');
    const provider = new FakeProvider();
    const refreshStarted = deferred<void>();
    const finishRefresh = deferred<OpenAISubscriptionOAuthCredential>();
    provider.refreshCredential = async () => {
      provider.refreshCalls += 1;
      refreshStarted.resolve();
      return await finishRefresh.promise;
    };
    const closedSessions: string[] = [];
    const service = createService(root, {
      provider,
      now: () => now,
      closeSession: (sessionId) => closedSessions.push(sessionId),
    });
    await seedZenCredential(service, {
      type: 'oauth',
      access: 'expiring-access-secret',
      refresh: 'old-refresh-secret',
      expires: now + 30_000,
      accountId: 'account-refresh',
    });

    const resolutions = [
      service.resolveAccessToken(),
      service.resolveAccessToken(),
      service.resolveAccessToken(),
    ];
    service.registerSession('refresh-session');
    await refreshStarted.promise;
    expect(provider.refreshCalls).toBe(1);
    finishRefresh.resolve({
      type: 'oauth',
      access: 'rotated-access-secret',
      refresh: 'rotated-refresh-secret',
      expires: now + 60 * 60_000,
      accountId: 'account-refresh',
    });

    await expect(Promise.all(resolutions)).resolves.toEqual([
      'rotated-access-secret',
      'rotated-access-secret',
      'rotated-access-secret',
    ]);
    expect(provider.refreshCalls).toBe(1);
    expect(closedSessions).toEqual(['refresh-session']);
    expect(await readFile(service.credentialPath, 'utf8')).toContain('rotated-refresh-secret');
    expect(await readFile(service.credentialPath, 'utf8')).not.toContain('old-refresh-secret');
  });

  it.each([
    ['chatgpt' as const, 'browser', { type: 'auth_url' as const }],
    ['chatgptDeviceCode' as const, 'device_code', { type: 'device_code' as const }],
  ])('bridges %s Pi login events before background completion', async (type, selection, event) => {
    const root = await temporaryRoot();
    const provider = new FakeProvider();
    const completion = deferred<OpenAISubscriptionOAuthCredential>();
    provider.loginCredential = completion.promise;
    const service = createService(root, {
      provider,
      createLoginId: () => `login-${selection}`,
    });

    const login = await service.startLogin({ type });

    expect(provider.selections).toEqual([selection]);
    expect(login).toMatchObject(
      event.type === 'auth_url'
        ? {
            type: 'chatgpt',
            loginId: 'login-browser',
            authUrl: 'https://auth.openai.test/authorize',
          }
        : {
            type: 'chatgptDeviceCode',
            loginId: 'login-device_code',
            verificationUrl: 'https://auth.openai.test/device',
            userCode: 'ABCD-EFGH',
          }
    );
    await expect(fileExists(service.credentialPath)).resolves.toBe(false);

    completion.resolve(validCredential());
    await eventually(async () => await fileExists(service.credentialPath));
    await eventually(async () => {
      try {
        return (await service.resolveAccessToken()) === 'login-access-secret';
      } catch {
        return false;
      }
    });
  });

  it('cancels only the matching owned login and never persists its late completion', async () => {
    const root = await temporaryRoot();
    const provider = new FakeProvider();
    const completion = deferred<OpenAISubscriptionOAuthCredential>();
    provider.loginCredential = completion.promise;
    const service = createService(root, { provider, createLoginId: () => 'owned-login' });
    await service.startLogin({ type: 'chatgptDeviceCode' });

    await expect(service.cancelLogin('some-other-login')).resolves.toEqual({ status: 'notFound' });
    expect(provider.loginAborted).toBe(false);
    await expect(service.cancelLogin('owned-login')).resolves.toEqual({ status: 'canceled' });
    expect(provider.loginAborted).toBe(true);
    completion.resolve(validCredential());
    await eventually(async () => (await service.status()).login === undefined);
    expect(JSON.stringify(await service.status())).not.toContain('login-access-secret');
    await expect(fileExists(service.credentialPath)).resolves.toBe(false);
  });

  it('waits for an in-flight login write, rolls it back, and preserves the prior credential', async () => {
    const root = await temporaryRoot();
    const credentialPath = join(root, 'openai-subscription-auth.json');
    const persistence = deferredCredentialWrite(credentialPath);
    const provider = new FakeProvider();
    const completion = deferred<OpenAISubscriptionOAuthCredential>();
    provider.loginCredential = completion.promise;
    const service = createService(root, {
      provider,
      files: persistence.files,
      createLoginId: () => 'transactional-login',
    });
    const prior = {
      ...validCredential(),
      access: 'prior-access-secret',
      refresh: 'prior-refresh-secret',
      accountId: 'prior-account',
    };
    await seedZenCredential(service, prior);
    await expect(service.resolveAccessToken()).resolves.toBe('prior-access-secret');

    const login = await service.startLogin({ type: 'chatgpt' });
    persistence.deferNextWrite();
    completion.resolve({
      ...validCredential(),
      access: 'canceled-access-secret',
      refresh: 'canceled-refresh-secret',
      accountId: 'canceled-account',
    });
    await persistence.writeStarted;

    let cancelSettled = false;
    const canceled = service.cancelLogin(login.loginId).finally(() => {
      cancelSettled = true;
    });
    await Promise.resolve();
    expect(cancelSettled).toBe(false);

    persistence.releaseWrite();
    await expect(canceled).resolves.toEqual({ status: 'canceled' });
    await expect(service.resolveAccessToken()).resolves.toBe('prior-access-secret');
    const stored = await readFile(service.credentialPath, 'utf8');
    expect(stored).toContain('prior-refresh-secret');
    expect(stored).not.toContain('canceled-refresh-secret');
    await expect(service.status()).resolves.toMatchObject({
      account: { state: 'authenticated', accountId: 'prior-account' },
      auth: { state: 'authenticated' },
    });
  });

  it('retains a failed cancellation rollback as dirty prior-credential persistence', async () => {
    const root = await temporaryRoot();
    const credentialPath = join(root, 'openai-subscription-auth.json');
    const persistence = deferredCredentialWrite(credentialPath);
    const provider = new FakeProvider();
    const completion = deferred<OpenAISubscriptionOAuthCredential>();
    provider.loginCredential = completion.promise;
    const service = createService(root, {
      provider,
      files: persistence.files,
      createLoginId: () => 'rollback-failure-login',
    });
    const prior = {
      ...validCredential(),
      access: 'rollback-prior-access',
      refresh: 'rollback-prior-refresh',
      accountId: 'rollback-prior-account',
    };
    await seedZenCredential(service, prior);
    await expect(service.resolveAccessToken()).resolves.toBe('rollback-prior-access');

    const login = await service.startLogin({ type: 'chatgpt' });
    persistence.deferNextWrite();
    completion.resolve({
      ...validCredential(),
      access: 'rollback-canceled-access',
      refresh: 'rollback-canceled-refresh',
      accountId: 'rollback-canceled-account',
    });
    await persistence.writeStarted;
    persistence.failRollbackWrites();
    const canceled = service.cancelLogin(login.loginId);
    persistence.releaseWrite();

    await expect(canceled).rejects.toThrow('credential persistence failed');
    expect(await readFile(service.credentialPath, 'utf8')).toContain('rollback-canceled-refresh');
    await expect(service.status()).resolves.toMatchObject({
      state: 'error',
      account: { state: 'authenticated', accountId: 'rollback-prior-account' },
      auth: { state: 'authenticated' },
      error: 'OpenAI subscription credential persistence pending',
    });
    await expect(service.resolveAccessToken()).resolves.toBe('rollback-prior-access');

    persistence.allowRollbackWrites();
    await service.close();
    const reopened = createService(root);
    await expect(reopened.resolveAccessToken()).resolves.toBe('rollback-prior-access');
    const restored = await readFile(reopened.credentialPath, 'utf8');
    expect(restored).toContain('rollback-prior-refresh');
    expect(restored).not.toContain('rollback-canceled-refresh');
  });

  it('retains a failed cancellation rollback to the logged-out state', async () => {
    const root = await temporaryRoot();
    const credentialPath = join(root, 'openai-subscription-auth.json');
    const persistence = deferredCredentialWrite(credentialPath);
    const provider = new FakeProvider();
    const completion = deferred<OpenAISubscriptionOAuthCredential>();
    provider.loginCredential = completion.promise;
    const service = createService(root, {
      provider,
      files: persistence.files,
      createLoginId: () => 'logged-out-rollback-login',
    });
    await expect(service.status()).resolves.toMatchObject({
      account: { state: 'unauthenticated' },
      auth: { state: 'unauthenticated' },
    });

    const login = await service.startLogin({ type: 'chatgpt' });
    persistence.deferNextWrite();
    completion.resolve({
      ...validCredential(),
      access: 'logged-out-canceled-access',
      refresh: 'logged-out-canceled-refresh',
      accountId: 'logged-out-canceled-account',
    });
    await persistence.writeStarted;
    persistence.failRollbackDeletes();
    const canceled = service.cancelLogin(login.loginId);
    persistence.releaseWrite();

    await expect(canceled).rejects.toThrow('credential persistence failed');
    expect(await readFile(service.credentialPath, 'utf8')).toContain('logged-out-canceled-refresh');
    const inMemoryStatus = await service.status();
    expect(inMemoryStatus).toMatchObject({
      state: 'error',
      account: { state: 'unauthenticated' },
      auth: { state: 'unauthenticated' },
      error: 'OpenAI subscription credential persistence pending',
    });
    expect(JSON.stringify(inMemoryStatus)).not.toContain('logged-out-canceled-account');
    await expect(service.resolveAccessToken()).rejects.toThrow('not authenticated');

    persistence.allowRollbackDeletes();
    await service.close();
    await expect(fileExists(service.credentialPath)).resolves.toBe(false);
    const reopened = createService(root);
    const restartedStatus = await reopened.status();
    expect(restartedStatus).toMatchObject({
      account: { state: 'unauthenticated' },
      auth: { state: 'unauthenticated' },
    });
    expect(JSON.stringify(restartedStatus)).not.toContain('logged-out-canceled-account');
  });

  it('logs out by deleting only the Zen credential', async () => {
    const root = await temporaryRoot();
    const provider = new FakeProvider();
    const service = createService(root, { provider });
    await seedZenCredential(service, validCredential());

    await expect(service.logout()).resolves.toEqual({});

    expect(provider.logoutCalls).toBe(0);
    await expect(fileExists(service.credentialPath)).resolves.toBe(false);
    await expect(service.resolveAccessToken()).rejects.toThrow('not authenticated');
  });

  it('invalidates every owned session on account switch and logout', async () => {
    const root = await temporaryRoot();
    const provider = new FakeProvider();
    const completion = deferred<OpenAISubscriptionOAuthCredential>();
    const closedSessions: string[] = [];
    provider.loginCredential = completion.promise;
    const service = createService(root, {
      provider,
      closeSession: (sessionId) => closedSessions.push(sessionId),
    });
    await seedZenCredential(service, validCredential());
    await service.status();
    service.registerSession('account-session');

    await service.startLogin({ type: 'chatgpt' });
    completion.resolve({
      ...validCredential(),
      access: 'new-account-access',
      refresh: 'new-account-refresh',
      accountId: 'account-new',
    });
    await eventually(async () => (await service.resolveAccessToken()) === 'new-account-access');
    expect(closedSessions).toEqual(['account-session']);

    service.registerSession('logout-session');
    await service.logout();
    expect(closedSessions).toEqual(['account-session', 'account-session', 'logout-session']);
  });

  it('revokes every old authentication lease on account switch and logout', async () => {
    const root = await temporaryRoot();
    const provider = new FakeProvider();
    const completion = deferred<OpenAISubscriptionOAuthCredential>();
    provider.loginCredential = completion.promise;
    const service = createService(root, { provider });
    await seedZenCredential(service, validCredential());

    const original = await service.acquireAccessLease();
    await service.startLogin({ type: 'chatgpt' });
    completion.resolve({
      ...validCredential(),
      access: 'switched-access-secret',
      refresh: 'switched-refresh-secret',
      accountId: 'switched-account',
    });
    await eventually(async () => original.signal.aborted);
    const switched = await service.acquireAccessLease();

    expect(switched.generation).toBeGreaterThan(original.generation);
    expect(switched.accessToken).toBe('switched-access-secret');
    expect(switched.signal.aborted).toBe(false);

    await service.logout();
    expect(switched.signal.aborted).toBe(true);
    await expect(service.acquireAccessLease()).rejects.toThrow('not authenticated');
  });

  it('exposes sanitized account, auth, model, and websocket-first transport status', async () => {
    const root = await temporaryRoot();
    const now = Date.parse('2026-07-21T00:00:00.000Z');
    const provider = new FakeProvider();
    provider.models = [
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    ];
    const service = createService(root, { provider, now: () => now });
    await seedZenCredential(service, {
      type: 'oauth',
      access: jwt({
        exp: Math.floor((now + 60 * 60_000) / 1000),
        email: 'person@example.test',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'account-status',
          chatgpt_plan_type: 'plus',
        },
      }),
      refresh: 'status-refresh-secret',
      expires: now + 60 * 60_000,
      accountId: 'account-status',
      idToken: jwt({ email: 'person@example.test' }),
    });

    const status = await service.refresh();

    expect(status).toMatchObject({
      state: 'ready',
      refreshing: false,
      provider: { id: 'openai-codex', auth: 'oauth' },
      transport: {
        identity: 'openai-codex-responses',
        preferred: 'websocket',
        fallback: 'http',
      },
      account: {
        state: 'authenticated',
        type: 'chatgpt',
        accountId: 'account-status',
        email: 'person@example.test',
        plan: 'plus',
      },
      auth: { state: 'authenticated', expiresAt: now + 60 * 60_000 },
      models: {
        state: 'ready',
        defaultModel: 'gpt-5.6-terra',
        items: [
          { id: 'gpt-5.4', model: 'gpt-5.4', displayName: 'GPT-5.4', hidden: false },
          {
            id: 'gpt-5.6-terra',
            model: 'gpt-5.6-terra',
            displayName: 'GPT-5.6 Terra',
            hidden: false,
          },
        ],
      },
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('status-refresh-secret');
    expect(serialized).not.toMatch(/"(?:access|refresh|idToken)":/);
  });

  it('reads the current static model catalog from Pi and prefers gpt-5.6-terra', async () => {
    const root = await temporaryRoot();
    const service = new OpenAISubscriptionProviderService({
      appDataRoot: root,
    });
    services.push(service);

    const status = await service.status();

    expect(service.defaultModelId).toBe('gpt-5.6-terra');
    expect(status.models.defaultModel).toBe('gpt-5.6-terra');
    expect(status.models.items).toContainEqual({
      id: 'gpt-5.6-terra',
      model: 'gpt-5.6-terra',
      displayName: 'GPT-5.6 Terra',
      hidden: false,
    });
  });

  it('closes owned login work, rejects later operations, and has no child-process dependency', async () => {
    const root = await temporaryRoot();
    const provider = new FakeProvider();
    provider.loginCredential = new Promise((_resolve, reject) => {
      provider.onLoginAbort = () => reject(new Error('canceled'));
    });
    const service = createService(root, { provider });
    await service.startLogin({ type: 'chatgpt' });

    await service.close();

    expect(provider.loginAborted).toBe(true);
    await expect(service.status()).rejects.toBeInstanceOf(OpenAISubscriptionProviderClosedError);
    await expect(service.refresh()).rejects.toBeInstanceOf(OpenAISubscriptionProviderClosedError);
    await expect(service.resolveAccessToken()).rejects.toBeInstanceOf(
      OpenAISubscriptionProviderClosedError
    );
    await expect(service.startLogin({ type: 'chatgpt' })).rejects.toBeInstanceOf(
      OpenAISubscriptionProviderClosedError
    );
    await expect(service.logout()).rejects.toBeInstanceOf(OpenAISubscriptionProviderClosedError);

    const source = await readFile(
      new URL(
        '../packages/framework/src/adapters/node/openai-subscription-provider-service.ts',
        import.meta.url
      ),
      'utf8'
    );
    expect(source).not.toMatch(/node:child_process|\bspawn\b|\bexecFile\b|codex\.exe/i);
  });

  it('keeps a timed-out caller on the same refresh flight and persists its late success', async () => {
    const root = await temporaryRoot();
    const provider = new FakeProvider();
    const refresh = deferred<OpenAISubscriptionOAuthCredential>();
    const started = deferred<void>();
    provider.refreshCredential = async () => {
      provider.refreshCalls += 1;
      started.resolve();
      return await refresh.promise;
    };
    const service = createService(root, {
      provider,
    });
    await seedZenCredential(service, {
      ...validCredential(),
      expires: Date.now() + 1,
    });

    const caller = new AbortController();
    const first = service.resolveAccessToken(caller.signal);
    await started.promise;
    caller.abort(new Error('caller timed out'));
    await expect(first).rejects.toThrow('caller timed out');

    const second = service.resolveAccessToken();
    expect(provider.refreshCalls).toBe(1);
    refresh.resolve({
      ...validCredential(),
      access: 'late-access-secret',
      refresh: 'late-refresh-secret',
    });
    await expect(second).resolves.toBe('late-access-secret');
    expect(provider.refreshCalls).toBe(1);
    expect(await readFile(service.credentialPath, 'utf8')).toContain('late-refresh-secret');
  });

  it('lets logout fence an in-flight refresh and rejects its late rotated credential', async () => {
    const root = await temporaryRoot();
    const provider = new FakeProvider();
    const refreshStarted = deferred<void>();
    const refresh = deferred<OpenAISubscriptionOAuthCredential>();
    provider.refreshCredential = async () => {
      refreshStarted.resolve();
      return await refresh.promise;
    };
    const service = createService(root, { provider });
    await seedZenCredential(service, { ...validCredential(), expires: Date.now() + 1 });

    const oldResolution = service.resolveAccessToken();
    await refreshStarted.promise;
    await expect(service.logout()).resolves.toEqual({});
    expect(await fileExists(service.credentialPath)).toBe(false);

    refresh.resolve({
      ...validCredential(),
      access: 'stale-late-access',
      refresh: 'stale-late-refresh',
    });
    await expect(oldResolution).rejects.toThrow('not authenticated');
    expect(await fileExists(service.credentialPath)).toBe(false);
    await expect(service.status()).resolves.toMatchObject({ state: 'ready' });
  });

  it('aborts the owned refresh transport at its finite deadline', async () => {
    const root = await temporaryRoot();
    let refreshSignal: AbortSignal | undefined;
    const service = createService(root, {
      refreshTimeoutMs: 20,
      refreshCredential: async (_credential, signal) => {
        refreshSignal = signal;
        return await rejectOnAbort(signal);
      },
    });
    await seedZenCredential(service, { ...validCredential(), expires: Date.now() + 1 });

    await expect(service.resolveAccessToken()).rejects.toThrow('token refresh failed');
    expect(refreshSignal?.aborted).toBe(true);
  });

  it('uses the bounded abort signal on the production refresh fetch', async () => {
    const root = await temporaryRoot();
    const provider = new FakeProvider();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return await rejectOnAbort(requestSignal ?? new AbortController().signal);
      })
    );
    const service = new OpenAISubscriptionProviderService({
      appDataRoot: root,
      provider,
      refreshTimeoutMs: 20,
    });
    services.push(service);
    await seedZenCredential(service, { ...validCredential(), expires: Date.now() + 1 });

    await expect(service.resolveAccessToken()).rejects.toThrow('token refresh failed');
    expect(requestSignal?.aborted).toBe(true);
    expect(provider.refreshSignals).toEqual([]);
  });

  it('retains a rotated credential in memory and retries failed persistence', async () => {
    const root = await temporaryRoot();
    const credentialPath = join(root, 'openai-subscription-auth.json');
    const persistence = flakyPersistence(credentialPath);
    const provider = new FakeProvider();
    provider.refreshCredential = async () => {
      provider.refreshCalls += 1;
      return {
        ...validCredential(),
        access: 'fresh-memory-access',
        refresh: 'fresh-memory-refresh',
      };
    };
    const service = createService(root, { provider, files: persistence.files });
    await seedZenCredential(service, { ...validCredential(), expires: Date.now() + 1 });
    persistence.failWrites();

    await expect(service.resolveAccessToken()).resolves.toBe('fresh-memory-access');
    await expect(service.resolveAccessToken()).resolves.toBe('fresh-memory-access');
    expect(provider.refreshCalls).toBe(1);
    await expect(service.status()).resolves.toMatchObject({
      state: 'error',
      error: 'OpenAI subscription credential persistence pending',
    });

    persistence.allowWrites();
    await expect(service.status()).resolves.toMatchObject({ state: 'ready' });
    expect(await readFile(service.credentialPath, 'utf8')).toContain('fresh-memory-refresh');
  });

  it('fails logout until deletion is durable and close retries before reopen', async () => {
    const root = await temporaryRoot();
    const credentialPath = join(root, 'openai-subscription-auth.json');
    const persistence = flakyPersistence(credentialPath);
    const service = createService(root, { files: persistence.files });
    await seedZenCredential(service, validCredential());
    await service.status();
    persistence.failDeletes();

    await expect(service.logout()).rejects.toThrow('credential persistence failed');
    await expect(service.acquireAccessLease()).rejects.toThrow('not authenticated');
    expect(await fileExists(service.credentialPath)).toBe(true);

    persistence.allowDeletes();
    await service.close();
    expect(await fileExists(service.credentialPath)).toBe(false);

    const reopened = createService(root);
    await expect(reopened.acquireAccessLease()).rejects.toThrow('not authenticated');
  });

  it('reports dirty rotated writes on close and retries without losing the fresh credential', async () => {
    const root = await temporaryRoot();
    const credentialPath = join(root, 'openai-subscription-auth.json');
    const persistence = flakyPersistence(credentialPath);
    const provider = new FakeProvider();
    provider.refreshCredential = async () => ({
      ...validCredential(),
      access: 'close-fresh-access',
      refresh: 'close-fresh-refresh',
    });
    const service = createService(root, { provider, files: persistence.files });
    await seedZenCredential(service, { ...validCredential(), expires: Date.now() + 1 });
    persistence.failWrites();

    await expect(service.acquireAccessLease()).resolves.toMatchObject({
      accessToken: 'close-fresh-access',
    });
    await expect(service.close()).rejects.toThrow('provider shutdown failed');

    persistence.allowWrites();
    await service.close();
    const reopened = createService(root);
    await expect(reopened.acquireAccessLease()).resolves.toMatchObject({
      accessToken: 'close-fresh-access',
    });
    expect(await readFile(reopened.credentialPath, 'utf8')).toContain('close-fresh-refresh');
  });

  it('aborts refresh work on shutdown and releases every owned Pi session', async () => {
    const root = await temporaryRoot();
    const refreshStarted = deferred<void>();
    let refreshAborted = false;
    const closedSessions: string[] = [];
    const service = createService(root, {
      refreshCredential: async (_credential, signal) => {
        refreshStarted.resolve();
        try {
          return await rejectOnAbort(signal);
        } finally {
          refreshAborted = signal.aborted;
        }
      },
      closeSession: (sessionId) => closedSessions.push(sessionId),
    });
    await seedZenCredential(service, { ...validCredential(), expires: Date.now() + 1 });

    const resolution = service.resolveAccessToken();
    await refreshStarted.promise;
    service.registerSession('thread-a');
    service.registerSession('thread-b');
    expect(() => service.registerSession('thread-b')).toThrow('already owned');
    service.releaseSession('thread-a');
    service.releaseSession('thread-a');
    expect(closedSessions).toEqual(['thread-a']);
    await service.close();
    await expect(resolution).rejects.toBeInstanceOf(OpenAISubscriptionProviderClosedError);
    expect(refreshAborted).toBe(true);
    expect(closedSessions).toEqual(['thread-a', 'thread-b']);
  });
});

class FakeProvider implements OpenAISubscriptionProvider {
  readonly id = 'openai-codex';
  readonly auth = {
    oauth: {
      login: async (interaction: OpenAISubscriptionProviderInteraction) => {
        const selection = await interaction.prompt({
          type: 'select',
          message: 'Select method',
          options: [
            { id: 'browser', label: 'Browser' },
            { id: 'device_code', label: 'Device code' },
          ],
        });
        this.selections.push(selection);
        if (selection === 'browser') {
          interaction.notify({
            type: 'auth_url',
            url: 'https://auth.openai.test/authorize',
          });
        } else {
          interaction.notify({
            type: 'device_code',
            userCode: 'ABCD-EFGH',
            verificationUri: 'https://auth.openai.test/device',
          });
        }
        interaction.signal?.addEventListener(
          'abort',
          () => {
            this.loginAborted = true;
            this.onLoginAbort?.();
          },
          { once: true }
        );
        return await this.loginCredential;
      },
      refresh: async (credential: OpenAISubscriptionOAuthCredential, signal?: AbortSignal) => {
        this.refreshSignals.push(signal);
        return await this.refreshCredential(credential);
      },
    },
  };
  models: { readonly id: string; readonly name: string }[] = [{ id: 'gpt-5.4', name: 'GPT-5.4' }];
  loginCredential: Promise<OpenAISubscriptionOAuthCredential> = Promise.resolve(validCredential());
  refreshCredential = async (
    credential: OpenAISubscriptionOAuthCredential
  ): Promise<OpenAISubscriptionOAuthCredential> => credential;
  refreshCalls = 0;
  refreshSignals: (AbortSignal | undefined)[] = [];
  logoutCalls = 0;
  loginAborted = false;
  onLoginAbort: (() => void) | undefined;
  readonly selections: string[] = [];
  readonly stream = async function* () {} as unknown as OpenAISubscriptionProvider['stream'];

  getModels() {
    return this.models;
  }
}

function createService(
  root: string,
  overrides: Partial<ConstructorParameters<typeof OpenAISubscriptionProviderService>[0]> = {}
): OpenAISubscriptionProviderService {
  const provider = overrides.provider ?? new FakeProvider();
  const service = new OpenAISubscriptionProviderService({
    appDataRoot: root,
    provider,
    refreshCredential:
      overrides.refreshCredential ??
      (async (credential, signal) => await provider.auth.oauth!.refresh(credential, signal)),
    ...overrides,
  });
  services.push(service);
  return service;
}

async function seedZenCredential(
  service: OpenAISubscriptionProviderService,
  credential: OpenAISubscriptionOAuthCredential
): Promise<void> {
  await writeFile(
    service.credentialPath,
    JSON.stringify({
      version: 1,
      provider: 'openai-codex',
      credential,
      updatedAt: '2026-07-21T00:00:00.000Z',
    })
  );
}

function validCredential(): OpenAISubscriptionOAuthCredential {
  return {
    type: 'oauth',
    access: 'login-access-secret',
    refresh: 'login-refresh-secret',
    expires: Date.now() + 60 * 60_000,
    accountId: 'account-login',
  };
}

function jwt(payload: Readonly<Record<string, unknown>>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

async function temporaryRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'zen-openai-subscription-'));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (isNodeError(cause) && cause.code === 'ENOENT') return false;
    throw cause;
  }
}

async function eventually(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('condition was not met');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('aborted'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function flakyPersistence(credentialPath: string): {
  readonly files: OpenAISubscriptionFileSystem;
  failWrites(): void;
  allowWrites(): void;
  failDeletes(): void;
  allowDeletes(): void;
} {
  let writesFailing = false;
  let deletesFailing = false;
  return {
    files: {
      readFile: async (path, encoding) => await nodeFiles.readFile(path, encoding),
      writeFile: async (path, data, options) => {
        await nodeFiles.writeFile(path, data, options);
      },
      mkdir: async (path, options) => await nodeFiles.mkdir(path, options),
      rename: async (from, to) => {
        if (writesFailing && to === credentialPath) {
          throw Object.assign(new Error('simulated persistence failure'), { code: 'EIO' });
        }
        await nodeFiles.rename(from, to);
      },
      chmod: async (path, mode) => await nodeFiles.chmod(path, mode),
      unlink: async (path) => {
        if (deletesFailing && path === credentialPath) {
          throw Object.assign(new Error('simulated deletion failure'), { code: 'EIO' });
        }
        await nodeFiles.unlink(path);
      },
    },
    failWrites: () => {
      writesFailing = true;
    },
    allowWrites: () => {
      writesFailing = false;
    },
    failDeletes: () => {
      deletesFailing = true;
    },
    allowDeletes: () => {
      deletesFailing = false;
    },
  };
}

function deferredCredentialWrite(credentialPath: string): {
  readonly files: OpenAISubscriptionFileSystem;
  readonly writeStarted: Promise<void>;
  deferNextWrite(): void;
  releaseWrite(): void;
  failRollbackWrites(): void;
  allowRollbackWrites(): void;
  failRollbackDeletes(): void;
  allowRollbackDeletes(): void;
} {
  const started = deferred<void>();
  const release = deferred<void>();
  let shouldDefer = false;
  let candidatePersisted = false;
  let rollbackWritesFailing = false;
  let rollbackDeletesFailing = false;
  return {
    files: {
      readFile: async (path, encoding) => await nodeFiles.readFile(path, encoding),
      writeFile: async (path, data, options) => await nodeFiles.writeFile(path, data, options),
      mkdir: async (path, options) => await nodeFiles.mkdir(path, options),
      rename: async (from, to) => {
        if (shouldDefer && to === credentialPath) {
          shouldDefer = false;
          started.resolve();
          await release.promise;
          await nodeFiles.rename(from, to);
          candidatePersisted = true;
          return;
        }
        if (candidatePersisted && rollbackWritesFailing && to === credentialPath) {
          throw Object.assign(new Error('simulated rollback persistence failure'), {
            code: 'EIO',
          });
        }
        await nodeFiles.rename(from, to);
      },
      chmod: async (path, mode) => await nodeFiles.chmod(path, mode),
      unlink: async (path) => {
        if (candidatePersisted && rollbackDeletesFailing && path === credentialPath) {
          throw Object.assign(new Error('simulated rollback deletion failure'), { code: 'EIO' });
        }
        await nodeFiles.unlink(path);
      },
    },
    writeStarted: started.promise,
    deferNextWrite: () => {
      shouldDefer = true;
    },
    releaseWrite: () => release.resolve(),
    failRollbackWrites: () => {
      rollbackWritesFailing = true;
    },
    allowRollbackWrites: () => {
      rollbackWritesFailing = false;
    },
    failRollbackDeletes: () => {
      rollbackDeletesFailing = true;
    },
    allowRollbackDeletes: () => {
      rollbackDeletesFailing = false;
    },
  };
}

function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error;
}
