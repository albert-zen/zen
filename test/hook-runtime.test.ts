import { describe, expect, it } from 'vitest';

import { HookRuntime, InMemoryItemList, type Item } from './test-exports.js';

describe('HookRuntime', () => {
  it('lets a hook observe an item before it is appended', async () => {
    const itemList = createItems();
    const observed: Array<{ itemType: string; snapshotLength: number }> = [];
    const hooks = new HookRuntime({
      itemList,
      hooks: {
        onItemAppending({ item, items }) {
          observed.push({
            itemType: item.type,
            snapshotLength: items.length,
          });
        },
      },
    });

    const appended = await hooks.append({
      type: 'user.message.completed',
      runId: 'run-1',
      turnId: 'turn-1',
      payload: { content: 'hello' },
    });

    expect(appended).toEqual(expect.objectContaining({ id: 'item-1' }));
    expect(observed).toEqual([{ itemType: 'user.message.completed', snapshotLength: 0 }]);
    expect(itemList.getItems()).toEqual([appended]);
  });

  it('appends hook-produced follow-up items through normal append semantics', async () => {
    const itemList = createItems();
    const hooks = new HookRuntime({
      itemList,
      hooks: {
        onItemAppended({ item }) {
          if (item.type !== 'user.message.completed') {
            return;
          }

          return {
            append: [
              {
                type: 'hook.followup',
                runId: item.runId,
                turnId: item.turnId,
                causeId: item.id,
                visibility: 'trace',
                payload: { observedType: item.type },
              },
            ],
          };
        },
      },
    });

    const appended = await hooks.append({
      type: 'user.message.completed',
      runId: 'run-1',
      turnId: 'turn-1',
      payload: { content: 'hello' },
    });
    expect(appended).toBeDefined();
    const appendedItem = appended as Item;

    expect(itemList.getItems()).toEqual([
      appendedItem,
      expect.objectContaining({
        id: 'item-2',
        seq: 2,
        type: 'hook.followup',
        causeId: appendedItem.id,
        visibility: 'trace',
        payload: { observedType: 'user.message.completed' },
      }),
    ]);
  });

  it('records a hook.effect item when a hook blocks an append', async () => {
    const itemList = createItems();
    const hooks = new HookRuntime({
      itemList,
      hooks: {
        onItemAppending() {
          return {
            decision: {
              type: 'block',
              reason: 'policy denied user item',
            },
          };
        },
      },
    });

    const appended = await hooks.append({
      type: 'user.message.completed',
      runId: 'run-1',
      turnId: 'turn-1',
      payload: { content: 'blocked' },
    });

    expect(appended).toBeUndefined();
    expect(itemList.getItems()).toEqual([
      expect.objectContaining({
        id: 'item-1',
        type: 'hook.effect',
        runId: 'run-1',
        turnId: 'turn-1',
        visibility: 'trace',
        payload: {
          hook: 'onItemAppending',
          effect: 'block',
          reason: 'policy denied user item',
          itemType: 'user.message.completed',
        },
      }),
    ]);
  });

  it('does not let hooks mutate the item list through exposed snapshots', async () => {
    const itemList = createItems();
    const existing = itemList.append({
      type: 'user.message.completed',
      runId: 'run-1',
      turnId: 'turn-1',
      payload: { content: 'original' },
    });
    const hooks = new HookRuntime({
      itemList,
      hooks: {
        onItemAppending({ item: candidate, items }) {
          const mutableItems = items as Item[];
          const mutableCandidate = candidate as { type: string };
          const firstPayload = mutableItems[0]?.payload as { content: string };

          mutableItems.reverse();
          mutableItems.push(item({ id: 'external', seq: 999 }));
          firstPayload.content = 'changed through snapshot';
          mutableCandidate.type = 'changed.candidate';
        },
      },
    });

    await hooks.append({
      type: 'assistant.message.completed',
      runId: 'run-1',
      turnId: 'turn-1',
      payload: { content: 'reply' },
    });

    expect(itemList.getItems()).toEqual([
      existing,
      expect.objectContaining({
        id: 'item-2',
        type: 'assistant.message.completed',
        payload: { content: 'reply' },
      }),
    ]);
  });

  it('records hook errors as hook.effect items without appending the candidate item', async () => {
    const itemList = createItems();
    const hooks = new HookRuntime({
      itemList,
      hooks: {
        onItemAppending() {
          throw new Error('hook failed');
        },
      },
    });

    await expect(
      hooks.append({
        type: 'user.message.completed',
        runId: 'run-1',
        turnId: 'turn-1',
        payload: { content: 'hello' },
      })
    ).rejects.toThrow('hook failed');

    expect(itemList.getItems()).toEqual([
      expect.objectContaining({
        id: 'item-1',
        type: 'hook.effect',
        runId: 'run-1',
        turnId: 'turn-1',
        visibility: 'trace',
        payload: {
          hook: 'onItemAppending',
          effect: 'error',
          message: 'hook failed',
          cause: { name: 'Error', message: 'hook failed' },
          itemType: 'user.message.completed',
        },
      }),
    ]);
  });

  it('applies replace and block tool-call policies as auditable public decisions', async () => {
    const itemList = createItems();
    const assistant = item({ id: 'assistant-1', type: 'assistant.message.completed' });
    const replace = new HookRuntime({
      itemList,
      hooks: {
        beforeToolCall() {
          return {
            decision: {
              type: 'replace',
              reason: 'normalize command',
              call: { id: 'tool-2', name: 'shell', input: { command: 'safe' } },
            },
          };
        },
      },
    });

    await expect(
      replace.beforeToolCall({ call: { id: 'tool-1', name: 'shell' }, assistantItem: assistant })
    ).resolves.toEqual({
      type: 'continue',
      call: { id: 'tool-2', name: 'shell', input: { command: 'safe' } },
    });

    const block = new HookRuntime({
      itemList,
      hooks: { beforeToolCall: () => ({ decision: { type: 'block', reason: 'denied' } }) },
    });
    await expect(
      block.beforeToolCall({ call: { id: 'tool-3', name: 'shell' }, assistantItem: assistant })
    ).resolves.toEqual({ type: 'block' });
    expect(itemList.getItems().map((entry) => entry.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ effect: 'replace', replacementToolCallId: 'tool-2' }),
        expect.objectContaining({ effect: 'block', reason: 'denied' }),
      ])
    );
  });

  it('records a tool hook failure and preserves the original failure for callers', async () => {
    const itemList = createItems();
    const hooks = new HookRuntime({
      itemList,
      hooks: {
        beforeToolCall: () => {
          throw new Error('tool policy unavailable');
        },
      },
    });
    const assistant = item({ id: 'assistant-1', type: 'assistant.message.completed' });

    await expect(
      hooks.beforeToolCall({ call: { id: 'tool-1', name: 'shell' }, assistantItem: assistant })
    ).rejects.toThrow('tool policy unavailable');
    expect(itemList.getItems()).toEqual([
      expect.objectContaining({
        type: 'hook.effect',
        causeId: 'assistant-1',
        payload: expect.objectContaining({ hook: 'beforeToolCall', effect: 'error' }),
      }),
    ]);
  });
});

function createItems(): InMemoryItemList {
  return new InMemoryItemList({
    generateId: (() => {
      let nextId = 0;
      return () => `item-${++nextId}`;
    })(),
    clock: () => 1000,
  });
}

function item(overrides: Partial<Item>): Item {
  return {
    id: 'item-0',
    type: 'user.message.completed',
    createdAtMs: 1000,
    seq: 0,
    runId: 'run-1',
    turnId: 'turn-1',
    payload: {},
    ...overrides,
  };
}
