import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ImZenStateStore } from '../src/state-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))
  );
});

describe('ImZenStateStore', () => {
  it('persists pairing, bindings, and pending jobs without duplicating an inbound message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imzen-state-'));
    roots.push(root);
    const path = join(root, 'state.json');
    const store = await ImZenStateStore.open(path);
    expect(store.authorize('user-a', new Set())).toBe(false);
    await expect(store.claimOwner('user-a')).resolves.toBe(true);
    expect(store.authorize('user-a', new Set())).toBe(true);
    expect(store.authorize('user-b', new Set())).toBe(false);
    await store.bind('c2c:user-a', { projectId: 'project', threadId: 'thread' });
    const inbound = {
      conversationId: 'c2c:user-a',
      kind: 'c2c' as const,
      messageId: 'message-1',
      receivedAtMs: 1,
      text: 'hello',
      userId: 'user-a',
    };
    await expect(store.enqueue(inbound)).resolves.toBe(true);
    await expect(store.enqueue(inbound)).resolves.toBe(false);

    const restored = await ImZenStateStore.open(path);
    expect(restored.ownerUserId()).toBe('user-a');
    expect(restored.binding('c2c:user-a')).toEqual({ projectId: 'project', threadId: 'thread' });
    expect(restored.pendingJobs()).toHaveLength(1);
    expect(await readFile(path, 'utf8')).not.toContain('appsecret');
  });
});
