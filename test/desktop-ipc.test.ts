import { describe, expect, it } from 'vitest';

import { createDesktopBridge, registerDesktopIpc, validateNotification } from '../desktop/ipc.js';

describe('desktop IPC bridge', () => {
  it('exposes only picker and bounded notification capabilities', async () => {
    const invocations: unknown[][] = [];
    const bridge = createDesktopBridge({
      invoke: async (...args: unknown[]) => {
        invocations.push(args);
        return args[0] === 'zenDesktop:pickProjectDirectory' ? 'C:\\work' : undefined;
      },
      platform: 'win32',
      version: '1.2.3',
    });
    expect(await bridge.pickProjectDirectory()).toBe('C:\\work');
    await bridge.showNotification({ title: 'Done', body: 'Project created' });
    expect(invocations).toEqual([
      ['zenDesktop:pickProjectDirectory'],
      ['zenDesktop:showNotification', { title: 'Done', body: 'Project created' }],
    ]);
  });

  it('rejects malformed notifications and invalid picker results', async () => {
    expect(() => validateNotification({ title: '', body: 'x' })).toThrow('title');
    expect(() => validateNotification({ title: 'x'.repeat(81), body: 'x' })).toThrow('title');
    expect(() => validateNotification({ title: 'ok', body: 'x'.repeat(241) })).toThrow('body');

    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerDesktopIpc(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      {
        chooseDirectory: async () => 'relative/path',
        showNotification: () => undefined,
      }
    );
    await expect(handlers.get('zenDesktop:pickProjectDirectory')?.()).resolves.toBeUndefined();

    registerDesktopIpc(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      {
        chooseDirectory: async () => undefined,
        showNotification: () => undefined,
      }
    );
    await expect(handlers.get('zenDesktop:pickProjectDirectory')?.()).resolves.toBeUndefined();
  });
});
