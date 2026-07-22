import { describe, expect, it } from 'vitest';

import {
  appendToolExecutionItems,
  HookRuntime,
  InMemoryItemList,
  type ToolRuntime,
} from './test-exports.js';

describe('appendToolExecutionItems', () => {
  it('executes assistant-requested fake tools and appends start and completed result items', async () => {
    const items = createItems();
    const assistant = items.append({
      type: 'assistant.message.completed',
      runId: 'run-1',
      turnId: 'turn-1',
      payload: {
        content: 'Checking the weather.',
        toolCalls: [
          {
            id: 'call-weather-1',
            name: 'weather',
            input: { city: 'Shanghai' },
          },
        ],
      },
    });
    const runtime: ToolRuntime = {
      async *execute(call) {
        expect(call).toEqual({
          id: 'call-weather-1',
          name: 'weather',
          input: { city: 'Shanghai' },
        });

        yield {
          type: 'result.completed',
          content: 'Sunny and 24C',
        };
      },
    };

    await appendToolExecutionItems({
      itemList: items,
      toolRuntime: runtime,
      assistantItem: assistant,
    });

    expect(items.getItems()).toEqual([
      assistant,
      expect.objectContaining({
        id: 'item-2',
        type: 'tool.call.started',
        causeId: assistant.id,
        visibility: 'trace',
        payload: {
          toolCallId: 'call-weather-1',
          toolName: 'weather',
          input: { city: 'Shanghai' },
        },
      }),
      expect.objectContaining({
        id: 'item-3',
        type: 'tool.result.completed',
        causeId: 'item-2',
        targetId: 'item-2',
        payload: {
          toolCallId: 'call-weather-1',
          toolName: 'weather',
          input: { city: 'Shanghai' },
          content: 'Sunny and 24C',
        },
      }),
    ]);
  });

  it('appends tool output deltas as trace items targeting the started tool call', async () => {
    const items = createItems();
    const assistant = appendAssistantToolCall(items);
    const runtime: ToolRuntime = {
      async *execute() {
        yield { type: 'output.delta', delta: 'partial ' };
        yield { type: 'output.delta', delta: 'output' };
        yield { type: 'result.completed', content: 'partial output' };
      },
    };

    await appendToolExecutionItems({
      itemList: items,
      toolRuntime: runtime,
      assistantItem: assistant,
    });

    const snapshot = items.getItems();
    const started = snapshot.find((item) => item.type === 'tool.call.started');

    expect(snapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'item-3',
          type: 'tool.output.delta',
          causeId: started?.id,
          targetId: started?.id,
          visibility: 'trace',
          payload: expect.objectContaining({
            toolCallId: 'call-weather-1',
            toolName: 'weather',
            delta: 'partial ',
            index: 0,
          }),
        }),
        expect.objectContaining({
          id: 'item-4',
          type: 'tool.output.delta',
          causeId: started?.id,
          targetId: started?.id,
          visibility: 'trace',
          payload: expect.objectContaining({
            toolCallId: 'call-weather-1',
            toolName: 'weather',
            delta: 'output',
            index: 1,
          }),
        }),
      ])
    );
  });

  it('appends a tool error item with failure details while preserving prior trace', async () => {
    const items = createItems();
    const assistant = appendAssistantToolCall(items);
    const runtime: ToolRuntime = {
      async *execute() {
        yield { type: 'output.delta', delta: 'before failure' };
        throw new Error('fake tool failed');
      },
    };

    const result = await appendToolExecutionItems({
      itemList: items,
      toolRuntime: runtime,
      assistantItem: assistant,
    });

    expect(items.getItems().map((item) => item.type)).toEqual([
      'assistant.message.completed',
      'tool.call.started',
      'tool.output.delta',
      'tool.error',
      'tool.result.completed',
    ]);
    expect(result.completed).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(items.getItems()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'item-3',
          type: 'tool.output.delta',
          targetId: 'item-2',
          payload: expect.objectContaining({ delta: 'before failure' }),
        }),
        expect.objectContaining({
          id: 'item-4',
          type: 'tool.error',
          causeId: 'item-2',
          targetId: 'item-2',
          visibility: 'trace',
          payload: expect.objectContaining({
            toolCallId: 'call-weather-1',
            toolName: 'weather',
            message: 'fake tool failed',
            cause: { name: 'Error', message: 'fake tool failed' },
          }),
        }),
        expect.objectContaining({
          id: 'item-5',
          type: 'tool.result.completed',
          payload: {
            toolCallId: 'call-weather-1',
            toolName: 'weather',
            input: { city: 'Shanghai' },
            content: { error: 'fake tool failed' },
            isError: true,
          },
        }),
      ])
    );
  });

  it('returns appended tool execution items for one assistant tool-call batch', async () => {
    const items = createItems();
    const assistant = items.append({
      type: 'assistant.message.completed',
      runId: 'run-1',
      turnId: 'turn-1',
      payload: {
        content: 'Checking multiple tools.',
        toolCalls: [
          { id: 'call-weather-1', name: 'weather', input: { city: 'Shanghai' } },
          { id: 'call-time-1', name: 'time', input: { zone: 'Asia/Shanghai' } },
        ],
      },
    });
    const runtime: ToolRuntime = {
      async *execute(call) {
        yield {
          type: 'result.completed',
          content: `${call.name} result`,
        };
      },
    };

    const result = await appendToolExecutionItems({
      itemList: items,
      toolRuntime: runtime,
      assistantItem: assistant,
    });

    expect(result.started.map((item) => item.payload)).toEqual([
      {
        toolCallId: 'call-weather-1',
        toolName: 'weather',
        input: { city: 'Shanghai' },
      },
      {
        toolCallId: 'call-time-1',
        toolName: 'time',
        input: { zone: 'Asia/Shanghai' },
      },
    ]);
    expect(result.completed.map((item) => item.payload)).toEqual([
      expect.objectContaining({
        toolCallId: 'call-weather-1',
        content: 'weather result',
      }),
      expect.objectContaining({
        toolCallId: 'call-time-1',
        content: 'time result',
      }),
    ]);
    expect(result.errors).toEqual([]);
  });

  it('lets beforeToolCall hooks block a tool call with visible hook.effect evidence', async () => {
    const items = createItems();
    const assistant = appendAssistantToolCall(items);
    const hooks = new HookRuntime({
      itemList: items,
      hooks: {
        beforeToolCall({ call }) {
          return {
            decision: {
              type: 'block',
              reason: `blocked ${call.name}`,
            },
          };
        },
      },
    });
    let toolExecuted = false;
    const runtime: ToolRuntime = {
      async *execute() {
        toolExecuted = true;
        yield { type: 'result.completed', content: 'should not run' };
      },
    };

    const result = await appendToolExecutionItems({
      itemList: items,
      toolRuntime: runtime,
      assistantItem: assistant,
      hookRuntime: hooks,
    });

    expect(toolExecuted).toBe(false);
    expect(result.started).toHaveLength(1);
    expect(result.completed).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(items.getItems()).toEqual([
      assistant,
      expect.objectContaining({
        id: 'item-2',
        type: 'hook.effect',
        runId: 'run-1',
        turnId: 'turn-1',
        visibility: 'trace',
        payload: {
          hook: 'beforeToolCall',
          effect: 'block',
          reason: 'blocked weather',
          toolCallId: 'call-weather-1',
          toolName: 'weather',
        },
      }),
      expect.objectContaining({ type: 'tool.call.started' }),
      expect.objectContaining({ type: 'tool.error', visibility: 'trace' }),
      expect.objectContaining({
        type: 'tool.result.completed',
        payload: expect.objectContaining({
          toolCallId: 'call-weather-1',
          toolName: 'weather',
          content: { error: 'Tool call blocked by hook: blocked weather' },
          isError: true,
        }),
      }),
    ]);
  });

  it('does not evaluate an eager tool runtime after hooked durable start aborts', async () => {
    const items = createItems();
    const assistant = appendAssistantToolCall(items);
    const controller = new AbortController();
    let hookInvocations = 0;
    let toolInvocations = 0;
    const hooks = new HookRuntime({
      itemList: items,
      hooks: {
        beforeToolCall({ call }) {
          hookInvocations += 1;
          return {
            decision: {
              type: 'replace',
              call: { ...call, input: { city: 'Beijing' } },
            },
          };
        },
      },
    });
    const runtime: ToolRuntime = {
      execute() {
        toolInvocations += 1;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'result.completed' as const, content: 'unexpected' };
          },
        };
      },
    };

    await expect(
      appendToolExecutionItems({
        itemList: items,
        appendItem: async (input) => {
          const item = items.append(input);
          if (input.type === 'tool.call.started') controller.abort();
          return item;
        },
        toolRuntime: runtime,
        assistantItem: assistant,
        hookRuntime: hooks,
        signal: controller.signal,
      })
    ).rejects.toThrow('Async iterator consumption aborted');

    expect(hookInvocations).toBe(1);
    expect(toolInvocations).toBe(0);
    expect(items.getItems().map((item) => item.type)).toContain('hook.effect');
  });

  it('keeps hook replacements linked to the original assistant tool-call id', async () => {
    const items = createItems();
    const assistant = appendAssistantToolCall(items);
    const executedIds: string[] = [];
    const hooks = new HookRuntime({
      itemList: items,
      hooks: {
        beforeToolCall: () => ({
          decision: {
            type: 'replace',
            call: { id: 'replacement-id', name: 'weather', input: { city: 'Beijing' } },
          },
        }),
      },
    });

    await appendToolExecutionItems({
      itemList: items,
      assistantItem: assistant,
      hookRuntime: hooks,
      toolRuntime: {
        async *execute(call) {
          executedIds.push(call.id);
          yield { type: 'result.completed', content: 'sunny' };
        },
      },
    });

    const results = items.getItems().filter((item) => item.type === 'tool.result.completed');
    expect(executedIds).toEqual(['call-weather-1']);
    expect(results).toHaveLength(1);
    expect(results[0]?.payload).toMatchObject({ toolCallId: 'call-weather-1' });
    expect(JSON.stringify(results)).not.toContain('replacement-id');
  });

  it('pairs the active and unstarted calls when a multi-tool batch is interrupted', async () => {
    const items = createItems();
    const assistant = appendAssistantToolCalls(items);
    const controller = new AbortController();
    const started = deferred<void>();
    const execution = appendToolExecutionItems({
      itemList: items,
      assistantItem: assistant,
      signal: controller.signal,
      toolRuntime: {
        async *execute(_call, context) {
          started.resolve(undefined);
          await rejectOnAbort(context.signal ?? new AbortController().signal);
          yield { type: 'result.completed', content: 'unreachable' };
        },
      },
    });

    await started.promise;
    controller.abort();
    await expect(execution).rejects.toThrow('Async iterator consumption aborted');

    const results = items
      .getItems()
      .filter((item) => item.type === 'tool.result.completed')
      .map((item) => item.payload);
    expect(results).toEqual([
      expect.objectContaining({ toolCallId: 'call-weather-1', isError: true }),
      expect.objectContaining({ toolCallId: 'call-time-1', isError: true, canceled: true }),
    ]);
  });

  it('pairs unstarted calls when the first call yields execution', async () => {
    const items = createItems();
    const assistant = appendAssistantToolCalls(items);
    const executed: string[] = [];

    const result = await appendToolExecutionItems({
      itemList: items,
      assistantItem: assistant,
      toolRuntime: {
        async *execute(call) {
          executed.push(call.id);
          yield { type: 'execution.yielded', content: 'waiting' };
        },
      },
    });

    expect(executed).toEqual(['call-weather-1']);
    expect(result.yielded?.payload).toMatchObject({
      toolCallId: 'call-weather-1',
      executionYielded: true,
    });
    expect(result.completed.map((item) => item.payload)).toEqual([
      expect.objectContaining({ toolCallId: 'call-weather-1' }),
      expect.objectContaining({ toolCallId: 'call-time-1', isError: true, canceled: true }),
    ]);
  });

  it('does not start malformed or already-aborted tool work', async () => {
    const items = createItems();
    const controller = new AbortController();
    controller.abort();
    let executed = false;
    const runtime: ToolRuntime = {
      async *execute() {
        executed = true;
        yield { type: 'result.completed', content: 'unexpected' };
      },
    };
    const assistant = items.append({
      type: 'assistant.message.completed',
      runId: 'run-1',
      turnId: 'turn-1',
      payload: { content: 'bad tools', toolCalls: [{ id: 'missing-name' }, null] },
    });

    await expect(
      appendToolExecutionItems({
        itemList: items,
        toolRuntime: runtime,
        assistantItem: assistant,
        signal: controller.signal,
      })
    ).resolves.toEqual({ started: [], completed: [], errors: [] });
    expect(executed).toBe(false);
    expect(items.getItems()).toEqual([assistant]);
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

function appendAssistantToolCall(items: InMemoryItemList) {
  return items.append({
    type: 'assistant.message.completed',
    runId: 'run-1',
    turnId: 'turn-1',
    payload: {
      content: 'Checking the weather.',
      toolCalls: [
        {
          id: 'call-weather-1',
          name: 'weather',
          input: { city: 'Shanghai' },
        },
      ],
    },
  });
}

function appendAssistantToolCalls(items: InMemoryItemList) {
  return items.append({
    type: 'assistant.message.completed',
    runId: 'run-1',
    turnId: 'turn-1',
    payload: {
      content: 'Checking multiple tools.',
      toolCalls: [
        { id: 'call-weather-1', name: 'weather', input: { city: 'Shanghai' } },
        { id: 'call-time-1', name: 'time', input: { zone: 'Asia/Shanghai' } },
      ],
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('aborted'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
  });
}
