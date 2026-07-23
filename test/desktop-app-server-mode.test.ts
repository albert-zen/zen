import { describe, expect, it } from 'vitest';

import { resolveDesktopAppServerMode } from '../apps/zenx/src/app-server-mode.js';

describe('desktop App Server mode', () => {
  it('uses private mode when no shared endpoint is configured', () => {
    expect(resolveDesktopAppServerMode({})).toEqual({ type: 'private' });
  });

  it('accepts only a complete trusted loopback shared endpoint', () => {
    const capability = 'x'.repeat(32);
    expect(
      resolveDesktopAppServerMode({
        ZEN_APP_SERVER_URL: 'http://127.0.0.1:32177',
        ZEN_APP_SERVER_CAPABILITY: capability,
      })
    ).toEqual({
      type: 'external',
      url: 'http://127.0.0.1:32177/',
      capability,
    });

    expect(() =>
      resolveDesktopAppServerMode({ ZEN_APP_SERVER_URL: 'http://127.0.0.1:32177' })
    ).toThrow('Set both ZEN_APP_SERVER_URL and ZEN_APP_SERVER_CAPABILITY');
    expect(() =>
      resolveDesktopAppServerMode({
        ZEN_APP_SERVER_URL: 'http://example.com:32177',
        ZEN_APP_SERVER_CAPABILITY: capability,
      })
    ).toThrow('loopback HTTP');
    expect(() =>
      resolveDesktopAppServerMode({
        ZEN_APP_SERVER_URL: 'http://127.0.0.1:32177/path',
        ZEN_APP_SERVER_CAPABILITY: capability,
      })
    ).toThrow('origin URL');
    expect(() =>
      resolveDesktopAppServerMode({
        ZEN_APP_SERVER_URL: 'http://127.0.0.1:32177',
        ZEN_APP_SERVER_CAPABILITY: 'too-short',
      })
    ).toThrow('at least 32 bytes');
  });
});
