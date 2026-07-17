import { describe, expect, it } from 'vitest';

import { ItemRetentionPolicy, type Item, type RetentionClass } from './test-exports.js';

describe('ItemRetentionPolicy', () => {
  it('keeps completed semantic items in default retention', () => {
    const policy = new ItemRetentionPolicy();

    expect(
      classifications(policy, [
        item({ type: 'user.message.completed' }),
        item({ type: 'assistant.message.completed' }),
        item({ type: 'tool.result.completed' }),
      ])
    ).toEqual(['default', 'default', 'default']);
  });

  it('keeps lifecycle items in default retention', () => {
    const policy = new ItemRetentionPolicy();

    expect(
      classifications(policy, [
        item({ type: 'run.started', visibility: 'trace' }),
        item({ type: 'turn.started', visibility: 'trace' }),
        item({ type: 'model.request.completed', visibility: 'trace' }),
        item({ type: 'turn.completed', visibility: 'trace' }),
        item({ type: 'run.completed', visibility: 'trace' }),
      ])
    ).toEqual(['default', 'default', 'default', 'default', 'default']);
  });

  it('treats delta and progress items as extended retention candidates', () => {
    const policy = new ItemRetentionPolicy();
    const deltasAndProgress = [
      item({ type: 'assistant.message.delta', visibility: 'trace' }),
      item({ type: 'tool.output.delta', visibility: 'trace' }),
      item({ type: 'tool.output.progress', visibility: 'trace' }),
    ];

    expect(classifications(policy, deltasAndProgress)).toEqual([
      'extended',
      'extended',
      'extended',
    ]);
    expect(deltasAndProgress.map((candidate) => policy.shouldRetain(candidate))).toEqual([
      false,
      false,
      false,
    ]);
    expect(
      deltasAndProgress.map((candidate) => policy.shouldRetain(candidate, { mode: 'extended' }))
    ).toEqual([true, true, true]);
  });

  it('discards internal items even in extended retention', () => {
    const policy = new ItemRetentionPolicy();
    const internalItems = [
      item({ type: 'hook.effect', visibility: 'internal' }),
      item({ type: 'internal.debug.snapshot' }),
    ];

    expect(classifications(policy, internalItems)).toEqual(['discard', 'discard']);
    expect(
      internalItems.map((candidate) => policy.shouldRetain(candidate, { mode: 'extended' }))
    ).toEqual([false, false]);
  });
});

function classifications(policy: ItemRetentionPolicy, items: readonly Item[]): RetentionClass[] {
  return items.map((item) => policy.classify(item));
}

function item(overrides: Partial<Item>): Item {
  return {
    id: 'item-1',
    type: 'user.message.completed',
    createdAtMs: 1000,
    seq: 1,
    runId: 'run-1',
    turnId: 'turn-1',
    payload: {},
    ...overrides,
  };
}
