import { describe, expect, it } from 'vitest';

import { createWindowOptions, installWindowPolicy } from '../desktop/window-policy.js';

describe('desktop window policy', () => {
  it('uses the required hardened BrowserWindow options', () => {
    expect(createWindowOptions('C:\\app\\preload.js').webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
    expect(createWindowOptions('C:\\app\\preload.js').show).toBe(false);
  });

  it('denies navigation and only delegates external http(s) popups', async () => {
    let navigationListener: ((event: { preventDefault(): void }) => void) | undefined;
    let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined;
    const opened: string[] = [];
    installWindowPolicy(
      {
        webContents: {
          on: (_event, listener) => {
            navigationListener = listener;
          },
          setWindowOpenHandler: (handler) => {
            openHandler = handler;
          },
        },
      },
      {
        openExternal: async (url) => {
          opened.push(url);
        },
      }
    );

    let prevented = false;
    navigationListener?.({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(openHandler?.({ url: 'https://example.test/docs' })).toEqual({ action: 'deny' });
    expect(openHandler?.({ url: 'file:///tmp/nope' })).toEqual({ action: 'deny' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(opened).toEqual(['https://example.test/docs']);
  });
});
