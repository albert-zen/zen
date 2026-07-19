import { describe, expect, it } from 'vitest';
import {
  InMemoryProjectCommandStore,
  ProjectCommandConflictError,
  ProjectCommandLedger,
} from './test-exports.js';

describe('APP-010 durable command ledger', () => {
  it('persists pending before execution and replays one completed response after restart', async () => {
    const store = new InMemoryProjectCommandStore();
    const first = await ProjectCommandLedger.open(store);
    await expect(
      first.begin({ scope: 'project-1', method: 'turn/start', idempotencyKey: 'one', digest: 'a' })
    ).resolves.toEqual({ state: 'started' });
    const pending = await ProjectCommandLedger.open(store);
    await expect(
      pending.begin({
        scope: 'project-1',
        method: 'turn/start',
        idempotencyKey: 'one',
        digest: 'a',
      })
    ).resolves.toEqual({ state: 'pending' });

    const response = {
      method: 'turn/start' as const,
      ok: true as const,
      result: { turn: { id: 'turn-1' } },
    };
    await pending.complete({
      scope: 'project-1',
      method: 'turn/start',
      idempotencyKey: 'one',
      response,
    });
    const replay = await ProjectCommandLedger.open(store);
    await expect(
      replay.begin({
        scope: 'project-1',
        method: 'turn/start',
        idempotencyKey: 'one',
        digest: 'a',
      })
    ).resolves.toEqual({ state: 'completed', response });
  });

  it('rejects a same-scope/method/key command with a different digest', async () => {
    const ledger = await ProjectCommandLedger.open();
    await ledger.begin({
      scope: 'project-1',
      method: 'thread/send',
      idempotencyKey: 'same',
      digest: 'first',
    });
    await expect(
      ledger.begin({
        scope: 'project-1',
        method: 'thread/send',
        idempotencyKey: 'same',
        digest: 'second',
      })
    ).rejects.toBeInstanceOf(ProjectCommandConflictError);
  });
});
