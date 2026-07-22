import { describe, expect, it } from 'vitest';

import {
  closeWithBoundedRetry,
  DesktopLifecycle,
  installShutdownSignals,
  type DesktopStartup,
} from '../apps/zenx/src/lifecycle.js';

describe('DesktopLifecycle', () => {
  it('closes acquired resources after a partial startup failure', async () => {
    const calls: string[] = [];
    const lifecycle = new DesktopLifecycle();

    await expect(
      lifecycle.start({
        createComposition: async () => ({
          close: async () => {
            calls.push('composition');
          },
        }),
        createTransport: async () => {
          throw new Error('bind failed');
        },
        createHost: async () => {
          throw new Error('unreachable');
        },
        createWindow: async () => {
          throw new Error('unreachable');
        },
      })
    ).rejects.toThrow('bind failed');

    await lifecycle.close();
    expect(calls).toEqual(['composition']);
  });

  it('quiesces, drains, and closes every resource exactly once despite repeated shutdown', async () => {
    const calls: string[] = [];
    const lifecycle = new DesktopLifecycle();
    await lifecycle.start(startup(calls));

    await Promise.all([lifecycle.close(), lifecycle.close(), lifecycle.close()]);

    expect(calls).toEqual([
      'transport:quiesce',
      'host:quiesce',
      'composition:close',
      'transport:close',
      'host:close',
      'window:close',
    ]);
  });

  it('continues closing sibling resources when one close fails', async () => {
    const calls: string[] = [];
    const lifecycle = new DesktopLifecycle();
    await lifecycle.start(
      startup(calls, {
        close: async () => {
          calls.push('transport:close');
          throw new Error('socket failure');
        },
      })
    );

    await expect(lifecycle.close()).rejects.toThrow('Production shutdown failed');
    expect(calls).toContain('host:close');
    expect(calls).toContain('window:close');
  });

  it('shares an in-flight close, re-arms after rejection, and stays closed after retry success', async () => {
    const calls: string[] = [];
    const firstClose = deferred<void>();
    let compositionAttempts = 0;
    const lifecycle = new DesktopLifecycle();
    await lifecycle.start({
      ...startup(calls),
      createComposition: async () => ({
        close: async () => {
          compositionAttempts += 1;
          calls.push(`composition:close:${compositionAttempts}`);
          if (compositionAttempts === 1) {
            await firstClose.promise;
            throw new Error('transient credential persistence failure');
          }
        },
      }),
    });

    const first = lifecycle.close();
    const concurrent = lifecycle.close();
    expect(concurrent).toBe(first);
    firstClose.resolve(undefined);
    await expect(first).rejects.toThrow('Production shutdown failed');
    await expect(concurrent).rejects.toThrow('Production shutdown failed');

    const retry = lifecycle.close();
    await expect(retry).resolves.toBeUndefined();
    expect(lifecycle.close()).toBe(retry);
    expect(compositionAttempts).toBe(2);
  });

  it('performs a bounded retry and retains every terminal shutdown failure', async () => {
    const observed: Array<{ readonly attempt: number; readonly message: string }> = [];
    let attempts = 0;
    await expect(
      closeWithBoundedRetry(
        async () => {
          attempts += 1;
          throw new Error(`failure-${attempts}`);
        },
        {
          attempts: 2,
          onFailure: (cause, attempt) =>
            observed.push({ attempt, message: (cause as Error).message }),
        }
      )
    ).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [
        expect.objectContaining({ message: 'failure-1' }),
        expect.objectContaining({ message: 'failure-2' }),
      ],
    });
    expect(attempts).toBe(2);
    expect(observed).toEqual([
      { attempt: 1, message: 'failure-1' },
      { attempt: 2, message: 'failure-2' },
    ]);
  });

  it('bounds each close attempt by a real deadline when a resource never settles', async () => {
    const observed: Array<{ readonly attempt: number; readonly message: string }> = [];
    let attempts = 0;

    await expect(
      closeWithBoundedRetry(
        async () => {
          attempts += 1;
          await new Promise<void>(() => undefined);
        },
        {
          attempts: 2,
          attemptTimeoutMs: 10,
          onFailure: (cause, attempt) =>
            observed.push({ attempt, message: (cause as Error).message }),
        }
      )
    ).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [
        expect.objectContaining({ message: 'Production shutdown attempt timed out after 10ms' }),
        expect.objectContaining({ message: 'Production shutdown attempt timed out after 10ms' }),
      ],
    });
    expect(attempts).toBe(2);
    expect(observed).toEqual([
      { attempt: 1, message: 'Production shutdown attempt timed out after 10ms' },
      { attempt: 2, message: 'Production shutdown attempt timed out after 10ms' },
    ]);
  });

  it('collapses repeated SIGINT and SIGTERM requests to one shutdown', () => {
    const listeners = new Map<string, () => void>();
    let shutdowns = 0;
    const dispose = installShutdownSignals(
      {
        on: (event, listener) => listeners.set(event, listener),
        off: (event) => listeners.delete(event),
      },
      () => {
        shutdowns += 1;
      }
    );

    listeners.get('SIGINT')?.();
    listeners.get('SIGTERM')?.();
    expect(shutdowns).toBe(1);
    dispose();
    expect(listeners.size).toBe(0);
  });
});

function startup(
  calls: string[],
  transportOverrides: Partial<{ close: () => Promise<void> }> = {}
): DesktopStartup {
  return {
    createComposition: async () => ({
      close: async () => {
        calls.push('composition:close');
      },
    }),
    createTransport: async () => ({
      quiesce: async () => {
        calls.push('transport:quiesce');
      },
      close:
        transportOverrides.close ??
        (async () => {
          calls.push('transport:close');
        }),
    }),
    createHost: async () => ({
      quiesce: async () => {
        calls.push('host:quiesce');
      },
      close: async () => {
        calls.push('host:close');
      },
    }),
    createWindow: async () => ({
      close: () => {
        calls.push('window:close');
      },
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
