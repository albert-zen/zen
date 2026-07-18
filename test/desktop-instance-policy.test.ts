import { describe, expect, it } from 'vitest';

import { acquireSingleInstance } from '../desktop/instance-policy.js';

describe('single instance policy', () => {
  it('quits startup ownership when another instance already owns the lock', () => {
    let installed = false;
    expect(
      acquireSingleInstance(
        {
          requestSingleInstanceLock: () => false,
          on: () => {
            installed = true;
          },
        },
        () => undefined
      )
    ).toBe(false);
    expect(installed).toBe(false);
  });

  it('focuses the owned window for second instances', () => {
    let listener: (() => void) | undefined;
    let focused = 0;
    expect(
      acquireSingleInstance(
        {
          requestSingleInstanceLock: () => true,
          on: (_event, callback) => {
            listener = callback;
          },
        },
        () => {
          focused += 1;
        }
      )
    ).toBe(true);
    listener?.();
    expect(focused).toBe(1);
  });
});
