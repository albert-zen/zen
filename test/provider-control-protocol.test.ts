import { describe, expect, it, vi } from 'vitest';

import {
  AgentAppServer,
  type ProviderControl,
  type ProjectManager,
  type ProjectSnapshot,
} from './test-exports.js';

describe('Provider control protocol', () => {
  it('dispatches provider status reads globally without consulting project lookup', async () => {
    const control = providerControl();
    const fixture = createServer(control);

    const read = await fixture.server.request({
      method: 'provider/read',
      params: {
        projectId: 'ignored-project',
        note: 'global',
      },
    });
    const refresh = await fixture.server.request({
      method: 'provider/refresh',
      params: {
        projectId: 'ignored-project',
        note: 'global',
      },
    });

    expect(read).toEqual({
      method: 'provider/read',
      ok: true,
      result: {
        status: {
          state: 'ready',
          account: { name: 'Zen', provider: 'mock' },
        },
      },
    });
    expect(refresh).toEqual({
      method: 'provider/refresh',
      ok: true,
      result: {
        status: {
          state: 'refreshed',
          account: { name: 'Zen', provider: 'mock' },
        },
      },
    });
    expect(control.read).toHaveBeenCalledTimes(1);
    expect(control.refresh).toHaveBeenCalledTimes(1);
    expect(fixture.projectManagerRead).not.toHaveBeenCalled();
    expect(fixture.createRuntime).not.toHaveBeenCalled();
  });

  it('deduplicates provider/login/cancel by idempotency key and conflicts on a different digest', async () => {
    const gate = deferred<void>();
    const control = providerControl({
      loginCancel: vi.fn(async (input) => {
        await gate.promise;
        return { status: 'canceled', loginId: String(input.loginId) };
      }),
    });
    const fixture = createServer(control);

    const first = fixture.server.request({
      method: 'provider/login/cancel',
      params: {
        projectId: 'ignored-project',
        loginId: 'login-1',
        idempotencyKey: 'login-cancel',
      },
    });
    const conflict = fixture.server.request({
      method: 'provider/login/cancel',
      params: {
        projectId: 'ignored-project',
        loginId: 'login-2',
        idempotencyKey: 'login-cancel',
      },
    });

    await expect(conflict).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: {
          code: 'IDEMPOTENCY_CONFLICT',
          message: expect.stringContaining('provider/login/cancel'),
        },
      })
    );

    gate.resolve();
    const firstResponse = await first;
    expect(firstResponse).toEqual({
      method: 'provider/login/cancel',
      ok: true,
      result: {
        result: {
          status: 'canceled',
          loginId: 'login-1',
        },
      },
    });

    const replay = await fixture.server.request({
      method: 'provider/login/cancel',
      params: {
        projectId: 'ignored-project',
        loginId: 'login-1',
        idempotencyKey: 'login-cancel',
      },
    });

    expect(replay).toEqual(firstResponse);
    expect(control.loginCancel).toHaveBeenCalledTimes(1);
    expect(fixture.projectManagerRead).not.toHaveBeenCalled();
    expect(fixture.createRuntime).not.toHaveBeenCalled();
  });

  it('deduplicates provider/login/start by idempotency key and conflicts on a different digest', async () => {
    const gate = deferred<void>();
    const control = providerControl({
      loginStart: vi.fn(async (input) => {
        await gate.promise;
        return { state: 'login-started', loginId: String(input.loginId) };
      }),
    });
    const fixture = createServer(control);

    const first = fixture.server.request({
      method: 'provider/login/start',
      params: {
        projectId: 'ignored-project',
        loginId: 'login-1',
        note: 'first',
        idempotencyKey: 'login-start',
      },
    });
    const conflict = fixture.server.request({
      method: 'provider/login/start',
      params: {
        projectId: 'ignored-project',
        loginId: 'login-2',
        note: 'second',
        idempotencyKey: 'login-start',
      },
    });

    await expect(conflict).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: {
          code: 'IDEMPOTENCY_CONFLICT',
          message: expect.stringContaining('provider/login/start'),
        },
      })
    );

    gate.resolve();
    const firstResponse = await first;
    expect(firstResponse).toEqual({
      method: 'provider/login/start',
      ok: true,
      result: {
        result: {
          state: 'login-started',
          loginId: 'login-1',
        },
      },
    });

    const replay = await fixture.server.request({
      method: 'provider/login/start',
      params: {
        projectId: 'ignored-project',
        loginId: 'login-1',
        note: 'first',
        idempotencyKey: 'login-start',
      },
    });

    expect(replay).toEqual(firstResponse);
    expect(control.loginStart).toHaveBeenCalledTimes(1);
    expect(fixture.projectManagerRead).not.toHaveBeenCalled();
    expect(fixture.createRuntime).not.toHaveBeenCalled();
  });

  it('returns INVALID_REQUEST when provider control is unavailable', async () => {
    const fixture = createServer();

    await expect(
      fixture.server.request({
        method: 'provider/read',
        params: {
          projectId: 'ignored-project',
        },
      })
    ).resolves.toEqual({
      method: 'provider/read',
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'Unsupported provider control method: provider/read',
      },
    });
    expect(fixture.projectManagerRead).not.toHaveBeenCalled();
    expect(fixture.createRuntime).not.toHaveBeenCalled();
  });

  it('denies provider methods for agent callers', async () => {
    const control = providerControl();
    const fixture = createServer(control);

    await expect(
      fixture.server.requestFromAgent(
        {
          method: 'provider/read',
          params: {
            projectId: 'ignored-project',
          },
        },
        {
          actor: 'agent',
          projectId: 'project-1',
          sourceThreadId: 'thread-1',
          executionProject: projectSnapshot(),
        }
      )
    ).resolves.toEqual({
      method: 'unknown',
      ok: false,
      error: {
        code: 'POLICY_DENIED',
        message: 'Agents may only use thread coordination methods',
      },
    });
    expect(control.read).not.toHaveBeenCalled();
    expect(fixture.projectManagerRead).not.toHaveBeenCalled();
    expect(fixture.createRuntime).not.toHaveBeenCalled();
  });
});

function createServer(providerControl?: ProviderControl) {
  const projectManagerRead = vi.fn(async () => {
    throw new Error('project lookup should not run for provider control requests');
  });
  const createRuntime = vi.fn(async () => {
    throw new Error('runtime creation should not run for provider control requests');
  });
  const projectManager = {
    create: vi.fn(async () => {
      throw new Error('project create should not run for provider control requests');
    }),
    list: vi.fn(async () => {
      throw new Error('project list should not run for provider control requests');
    }),
    read: projectManagerRead,
    update: vi.fn(async () => {
      throw new Error('project update should not run for provider control requests');
    }),
    archive: vi.fn(async () => {
      throw new Error('project archive should not run for provider control requests');
    }),
  } as unknown as ProjectManager;

  return {
    server: new AgentAppServer({
      projectManager,
      createRuntime,
      providerControl,
    }),
    projectManagerRead,
    createRuntime,
  };
}

function providerControl(overrides: Partial<ProviderControl> = {}): ProviderControl {
  return {
    read: vi.fn(async () => ({
      state: 'ready',
      account: { name: 'Zen', provider: 'mock' },
    })),
    refresh: vi.fn(async () => ({
      state: 'refreshed',
      account: { name: 'Zen', provider: 'mock' },
    })),
    loginStart: vi.fn(async (input) => ({
      state: 'login-started',
      provider: 'mock',
      note: String(input.note ?? ''),
    })),
    loginCancel: vi.fn(async (input) => ({
      status: 'canceled',
      loginId: String(input.loginId ?? ''),
    })),
    logout: vi.fn(async () => ({
      status: 'logged-out',
    })),
    ...overrides,
  };
}

function projectSnapshot(): ProjectSnapshot {
  return {
    id: 'project-1',
    name: 'Project One',
    status: 'active',
    rootPath: 'C:\\project',
    createdAtMs: 0,
    updatedAtMs: 0,
    policy: {
      maxActiveExecutions: 2,
      maxThreadDepth: 4,
      maxThreads: 100,
      maxQueuedMessages: 100,
      maxWaitTargets: 16,
      maxMessageBytes: 16_384,
      idempotencyRetention: 1_000,
      agentCanCreateThreads: true,
      agentCanMessagePeers: true,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
