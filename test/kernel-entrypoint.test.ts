import { describe, expect, it } from 'vitest';

describe('kernel public entry point', () => {
  it('loads through the source entry point', async () => {
    const kernel = await import('../packages/framework/src/kernel/index.js');

    expect(kernel.kernelEntrypoint).toBe('@zen/framework');
    expect('ThreadManager' in kernel).toBe(false);
    expect('ApprovalBroker' in kernel).toBe(false);
    expect('PolicyToolRuntime' in kernel).toBe(false);
    expect('createWebUiState' in kernel).toBe(false);
  });
});
