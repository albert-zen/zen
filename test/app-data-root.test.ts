import { describe, expect, it } from 'vitest';

import { resolveAgentAppDataRoot } from './test-exports.js';

describe('production Agent App data root', () => {
  it('uses an explicit absolute override and rejects workspace-relative state', () => {
    expect(resolveAgentAppDataRoot({ ZEN_APP_DATA_ROOT: 'D:\\state' }, 'win32', 'C:\\home')).toBe(
      'D:\\state'
    );
    expect(() =>
      resolveAgentAppDataRoot({ ZEN_APP_DATA_ROOT: '.zen' }, 'win32', 'C:\\home')
    ).toThrow('absolute');
  });

  it('uses OS app-data/state boundaries on Windows, macOS, and Linux', () => {
    expect(
      resolveAgentAppDataRoot({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32')
    ).toBe('C:\\Users\\me\\AppData\\Local\\Zen Agent');
    expect(resolveAgentAppDataRoot({}, 'darwin', '/Users/me')).toBe(
      '/Users/me/Library/Application Support/Zen Agent'
    );
    expect(resolveAgentAppDataRoot({ XDG_STATE_HOME: '/state' }, 'linux', '/home/me')).toBe(
      '/state/zen-agent'
    );
    expect(resolveAgentAppDataRoot({}, 'linux', '/home/me')).toBe(
      '/home/me/.local/state/zen-agent'
    );
  });
});
