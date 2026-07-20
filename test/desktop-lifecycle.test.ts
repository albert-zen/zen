import { describe, expect, it } from 'vitest';

import {
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
