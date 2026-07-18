import { describe, expect, it } from 'vitest';

import {
  AgentLoop,
  InMemoryItemList,
  type ModelContext,
  type ModelEvent,
  type ModelGateway,
  type ToolRuntime,
} from './test-exports.js';

describe('AgentLoop', () => {
  it('records a configured system prompt as a model-visible item once', async () => {
    const itemList = createItems();
    const observedContexts: ModelContext[] = [];
    let modelCalls = 0;
    const model: ModelGateway = {
      async *generate(context) {
        observedContexts.push(context);
        modelCalls += 1;
        yield {
          type: 'message.completed',
          content: modelCalls === 1 ? 'First answer' : 'Second answer',
        };
      },
    };
    const agent = new AgentLoop({
      itemList,
      model,
      systemPrompt: 'You are Zen.',
    });

    await agent.run({
      input: 'First',
      runId: 'run-1',
      turnId: 'turn-1',
    });
    await agent.run({
      input: 'Second',
      runId: 'run-2',
      turnId: 'turn-2',
    });

    expect(itemList.getItems().filter((item) => item.type === 'system.message.completed')).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        turnId: 'turn-1',
        payload: { content: 'You are Zen.' },
      }),
    ]);
    expect(observedContexts[0]?.parts).toEqual([
      { type: 'message', role: 'system', content: 'You are Zen.' },
      { type: 'message', role: 'user', content: 'First' },
    ]);
    expect(observedContexts[1]?.parts).toEqual([
      { type: 'message', role: 'system', content: 'You are Zen.' },
      { type: 'message', role: 'user', content: 'First' },
      { type: 'message', role: 'assistant', content: 'First answer' },
      { type: 'message', role: 'user', content: 'Second' },
    ]);
  });

  it('appends a new system prompt item when configured prompt changes', async () => {
    const itemList = createItems();
    const observedContexts: ModelContext[] = [];
    const model: ModelGateway = {
      async *generate(context) {
        observedContexts.push(context);
        yield { type: 'message.completed', content: 'ok' };
      },
    };

    await new AgentLoop({
      itemList,
      model,
      systemPrompt: 'Initial prompt.',
    }).run({
      input: 'First',
      runId: 'run-1',
      turnId: 'turn-1',
    });
    await new AgentLoop({
      itemList,
      model,
      systemPrompt: 'Updated prompt.',
    }).run({
      input: 'Second',
      runId: 'run-2',
      turnId: 'turn-2',
    });

    expect(
      itemList
        .getItems()
        .filter((item) => item.type === 'system.message.completed')
        .map((item) => item.payload)
    ).toEqual([{ content: 'Initial prompt.' }, { content: 'Updated prompt.' }]);
    expect(observedContexts.at(-1)?.parts.at(0)).toEqual({
      type: 'message',
      role: 'system',
      content: 'Updated prompt.',
    });
  });

  it('places a newly added system prompt before existing resumed conversation context', async () => {
    const itemList = new InMemoryItemList({
      generateId: (() => {
        let nextId = 2;
        return () => `item-${++nextId}`;
      })(),
      clock: () => 1000,
      initialItems: [
        {
          id: 'item-1',
          type: 'user.message.completed',
          createdAtMs: 1000,
          seq: 1,
          runId: 'run-0',
          turnId: 'turn-0',
          payload: { content: 'Earlier user' },
        },
        {
          id: 'item-2',
          type: 'assistant.message.completed',
          createdAtMs: 1000,
          seq: 2,
          runId: 'run-0',
          turnId: 'turn-0',
          payload: { content: 'Earlier assistant' },
        },
      ],
    });
    const observedContexts: ModelContext[] = [];
    const model = fakeModel(
      [{ type: 'message.completed', content: 'Current answer' }],
      observedContexts
    );

    await new AgentLoop({
      itemList,
      model,
      systemPrompt: 'You are Zen.',
    }).run({
      input: 'Current user',
      runId: 'run-1',
      turnId: 'turn-1',
    });

    expect(observedContexts[0]?.parts).toEqual([
      { type: 'message', role: 'system', content: 'You are Zen.' },
      { type: 'message', role: 'user', content: 'Earlier user' },
      { type: 'message', role: 'assistant', content: 'Earlier assistant' },
      { type: 'message', role: 'user', content: 'Current user' },
    ]);
  });

  it('runs a full fake model turn without a tool call through the public API', async () => {
    const itemList = createItems();
    const observedContexts: ModelContext[] = [];
    const model = fakeModel(
      [{ type: 'message.completed', content: 'Hello from fake model' }],
      observedContexts
    );
    const agent = new AgentLoop({ itemList, model });

    const result = await agent.run({
      input: 'Hello',
      runId: 'run-1',
      turnId: 'turn-1',
    });

    expect(observedContexts).toEqual([
      {
        parts: [{ type: 'message', role: 'user', content: 'Hello' }],
      },
    ]);
    expect(result.items.map((item) => item.type)).toEqual([
      'run.started',
      'turn.started',
      'user.message.completed',
      'model.request.started',
      'assistant.message.started',
      'assistant.message.completed',
      'model.request.completed',
      'turn.completed',
      'run.completed',
    ]);
    expect(result.items).toEqual(itemList.getItems());
    expect(result.finalContext.parts).toEqual([
      { type: 'message', role: 'user', content: 'Hello' },
      { type: 'message', role: 'assistant', content: 'Hello from fake model' },
    ]);
  });

  it('does not append completed lifecycle facts after a model error', async () => {
    const itemList = createItems();
    const agent = new AgentLoop({
      itemList,
      model: fakeModel([{ type: 'error', error: new Error('model execution failed') }]),
    });

    const result = await agent.run({
      input: 'Fail this turn',
      runId: 'run-1',
      turnId: 'turn-1',
    });

    expect(result.items.map((item) => item.type)).toEqual([
      'run.started',
      'turn.started',
      'user.message.completed',
      'model.request.started',
      'assistant.message.started',
      'assistant.message.error',
      'model.request.completed',
    ]);
  });

  it('executes one fake tool call and exposes the result to a follow-up model step', async () => {
    const itemList = createItems();
    const observedContexts: ModelContext[] = [];
    let modelCalls = 0;
    const model: ModelGateway = {
      async *generate(context) {
        observedContexts.push(context);
        modelCalls += 1;

        if (modelCalls === 1) {
          yield {
            type: 'message.completed',
            content: 'Checking the weather.',
            toolCalls: [
              {
                id: 'call-weather-1',
                name: 'weather',
                input: { city: 'Shanghai' },
              },
            ],
          };
          return;
        }

        yield {
          type: 'message.completed',
          content: 'It is sunny in Shanghai.',
        };
      },
    };
    const toolRuntime: ToolRuntime = {
      async *execute(call) {
        expect(call).toEqual({
          id: 'call-weather-1',
          name: 'weather',
          input: { city: 'Shanghai' },
        });
        yield { type: 'result.completed', content: 'Sunny and 24C' };
      },
    };
    const agent = new AgentLoop({ itemList, model, toolRuntime });

    const result = await agent.run({
      input: 'What is the weather?',
      runId: 'run-1',
      turnId: 'turn-1',
    });

    expect(result.items.map((item) => item.type)).toEqual([
      'run.started',
      'turn.started',
      'user.message.completed',
      'model.request.started',
      'assistant.message.started',
      'assistant.message.completed',
      'model.request.completed',
      'tool.call.started',
      'tool.result.completed',
      'model.request.started',
      'assistant.message.started',
      'assistant.message.completed',
      'model.request.completed',
      'turn.completed',
      'run.completed',
    ]);
    expect(observedContexts[1]?.parts).toEqual([
      { type: 'message', role: 'user', content: 'What is the weather?' },
      {
        type: 'message',
        role: 'assistant',
        content: 'Checking the weather.',
        toolCalls: [
          {
            id: 'call-weather-1',
            name: 'weather',
            input: { city: 'Shanghai' },
          },
        ],
      },
      {
        type: 'toolResult',
        toolCallId: 'call-weather-1',
        toolName: 'weather',
        content: 'Sunny and 24C',
      },
    ]);
    expect(result.finalContext.parts).toEqual([
      { type: 'message', role: 'user', content: 'What is the weather?' },
      {
        type: 'message',
        role: 'assistant',
        content: 'Checking the weather.',
        toolCalls: [
          {
            id: 'call-weather-1',
            name: 'weather',
            input: { city: 'Shanghai' },
          },
        ],
      },
      {
        type: 'toolResult',
        toolCallId: 'call-weather-1',
        toolName: 'weather',
        content: 'Sunny and 24C',
      },
      { type: 'message', role: 'assistant', content: 'It is sunny in Shanghai.' },
    ]);
  });

  it('keeps completed assistant output authoritative when streamed deltas differ', async () => {
    const itemList = createItems();
    const model = fakeModel([
      { type: 'text.delta', text: 'draft ' },
      { type: 'text.delta', text: 'answer' },
      { type: 'message.completed', content: 'final answer' },
    ]);
    const agent = new AgentLoop({ itemList, model });

    const result = await agent.run({
      input: 'Answer with a rewrite',
      runId: 'run-1',
      turnId: 'turn-1',
    });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'assistant.message.delta',
          payload: { delta: 'draft ', index: 0 },
        }),
        expect.objectContaining({
          type: 'assistant.message.delta',
          payload: { delta: 'answer', index: 1 },
        }),
        expect.objectContaining({
          type: 'assistant.message.completed',
          payload: { content: 'final answer' },
        }),
      ])
    );
    expect(result.finalContext.parts).toEqual([
      { type: 'message', role: 'user', content: 'Answer with a rewrite' },
      { type: 'message', role: 'assistant', content: 'final answer' },
    ]);
  });

  it('lets hooks add auditable effects without hidden state mutation', async () => {
    const itemList = createItems();
    const model = fakeModel([{ type: 'message.completed', content: 'Hook-visible answer' }]);
    const agent = new AgentLoop({
      itemList,
      model,
      hooks: {
        onItemAppended({ item }) {
          if (item.type !== 'user.message.completed') {
            return;
          }

          return {
            append: [
              {
                type: 'hook.effect',
                runId: item.runId,
                turnId: item.turnId,
                causeId: item.id,
                visibility: 'trace',
                payload: {
                  hook: 'onItemAppended',
                  effect: 'audit',
                  itemType: item.type,
                },
              },
            ],
          };
        },
      },
    });

    const result = await agent.run({
      input: 'Record hook evidence',
      runId: 'run-1',
      turnId: 'turn-1',
    });

    const userItem = result.items.find((item) => item.type === 'user.message.completed');

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'hook.effect',
          causeId: userItem?.id,
          visibility: 'trace',
          payload: {
            hook: 'onItemAppended',
            effect: 'audit',
            itemType: 'user.message.completed',
          },
        }),
      ])
    );
    expect(result.finalContext.parts).toEqual([
      { type: 'message', role: 'user', content: 'Record hook evidence' },
      { type: 'message', role: 'assistant', content: 'Hook-visible answer' },
    ]);
  });

  it('runs model and tool item appends through hooks in the full fake path', async () => {
    const itemList = createItems();
    let modelCalls = 0;
    const model: ModelGateway = {
      async *generate() {
        modelCalls += 1;

        if (modelCalls === 1) {
          yield {
            type: 'message.completed',
            content: 'Calling fake tool.',
            toolCalls: [{ id: 'call-tool-1', name: 'fake-tool' }],
          };
          return;
        }

        yield { type: 'message.completed', content: 'Fake tool returned.' };
      },
    };
    const toolRuntime: ToolRuntime = {
      async *execute() {
        yield { type: 'result.completed', content: 'fake result' };
      },
    };
    const agent = new AgentLoop({
      itemList,
      model,
      toolRuntime,
      hooks: {
        onItemAppended({ item }) {
          if (item.type !== 'model.request.started' && item.type !== 'tool.result.completed') {
            return;
          }

          return {
            append: [
              {
                type: 'hook.effect',
                runId: item.runId,
                turnId: item.turnId,
                causeId: item.id,
                visibility: 'trace',
                payload: {
                  hook: 'onItemAppended',
                  effect: 'audit',
                  itemType: item.type,
                },
              },
            ],
          };
        },
      },
    });

    const result = await agent.run({
      input: 'Use a fake tool',
      runId: 'run-1',
      turnId: 'turn-1',
    });

    const auditedItems = result.items.filter(
      (item) => item.type === 'model.request.started' || item.type === 'tool.result.completed'
    );

    expect(
      result.items
        .filter((item) => item.type === 'hook.effect')
        .map((item) => ({
          causeId: item.causeId,
          payload: item.payload,
        }))
    ).toEqual([
      {
        causeId: auditedItems[0]?.id,
        payload: {
          hook: 'onItemAppended',
          effect: 'audit',
          itemType: 'model.request.started',
        },
      },
      {
        causeId: auditedItems[1]?.id,
        payload: {
          hook: 'onItemAppended',
          effect: 'audit',
          itemType: 'tool.result.completed',
        },
      },
      {
        causeId: auditedItems[2]?.id,
        payload: {
          hook: 'onItemAppended',
          effect: 'audit',
          itemType: 'model.request.started',
        },
      },
    ]);
  });

  it('keeps the injected appender authoritative when hooks are enabled', async () => {
    const itemList = createItems();
    let modelCalls = 0;
    let toolCalls = 0;
    const agent = new AgentLoop({
      itemList,
      appendItem: async (input) => {
        const item = itemList.append(input);
        if (item.type === 'tool.call.started') throw new Error('tool start is not durable');
        return item;
      },
      model: {
        async *generate() {
          modelCalls += 1;
          yield modelCalls === 1
            ? {
                type: 'message.completed' as const,
                content: 'Calling tool',
                toolCalls: [{ id: 'call-1', name: 'test' }],
              }
            : { type: 'message.completed' as const, content: 'Done' };
        },
      },
      toolRuntime: {
        async *execute() {
          toolCalls += 1;
          yield { type: 'result.completed', content: 'unexpected' };
        },
      },
      hooks: { onItemAppending: () => undefined },
    });

    await expect(agent.run({ input: 'run', runId: 'run-1', turnId: 'turn-1' })).rejects.toThrow(
      'tool start is not durable'
    );
    expect(toolCalls).toBe(0);
  });

  it('notifies observers in the same appended item order as the item list', async () => {
    const observed: string[] = [];
    const itemList = createItems();

    itemList.observe((item) => {
      observed.push(`${item.seq}:${item.type}`);
    });

    const model = fakeModel([
      { type: 'text.delta', text: 'Hello' },
      { type: 'message.completed', content: 'Hello' },
    ]);
    const agent = new AgentLoop({ itemList, model });

    const result = await agent.run({
      input: 'Observe the run',
      runId: 'run-1',
      turnId: 'turn-1',
    });

    expect(observed).toEqual(result.items.map((item) => `${item.seq}:${item.type}`));
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

function fakeModel(
  events: readonly ModelEvent[],
  observedContexts: ModelContext[] = []
): ModelGateway {
  return {
    async *generate(context) {
      observedContexts.push(context);
      yield* events;
    },
  };
}
