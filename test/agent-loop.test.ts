import type { AssistantMessage, Context as PiContext } from '@earendil-works/pi-ai';
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { describe, expect, it } from 'vitest';

import {
  AgentLoop,
  InMemoryItemList,
  OpenAiSubscriptionModelGateway,
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

  it.each(['tool.call.started', 'tool.result.completed'] as const)(
    'keeps one model-visible tool result when onItemAppended fails after %s',
    async (failureType) => {
      const itemList = createItems();
      const observedContexts: ModelContext[] = [];
      let modelCalls = 0;
      const agent = new AgentLoop({
        itemList,
        model: {
          async *generate(context) {
            observedContexts.push(context);
            modelCalls += 1;
            yield modelCalls === 1
              ? {
                  type: 'message.completed' as const,
                  content: 'Calling tool',
                  toolCalls: [{ id: 'provider-call-1', name: 'fake-tool' }],
                }
              : { type: 'message.completed' as const, content: 'Tool complete' };
          },
        },
        toolRuntime: {
          async *execute() {
            yield { type: 'result.completed', content: 'one result' };
          },
        },
        hooks: {
          onItemAppended({ item }) {
            if (item.type === failureType) throw new Error(`observer failed after ${failureType}`);
          },
        },
      });

      const result = await agent.run({
        input: 'run tool',
        runId: `run-${failureType}`,
        turnId: `turn-${failureType}`,
      });
      const itemResults = result.items.filter((item) => item.type === 'tool.result.completed');
      const contextResults =
        observedContexts[1]?.parts.filter((part) => part.type === 'toolResult') ?? [];

      expect(itemResults).toHaveLength(1);
      expect(contextResults).toEqual([
        expect.objectContaining({ toolCallId: 'provider-call-1', content: 'one result' }),
      ]);
      await expect(countFunctionCallOutputs(observedContexts[1]!)).resolves.toBe(1);
      expect(
        result.items.filter(
          (item) =>
            item.type === 'hook.effect' &&
            (item.payload as { readonly itemType?: unknown }).itemType === failureType
        )
      ).toHaveLength(1);
    }
  );

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

  it('pairs failed tool calls for the model and completes after model recovery', async () => {
    const itemList = createItems();
    const observedContexts: ModelContext[] = [];
    let modelCalls = 0;
    const agent = new AgentLoop({
      itemList,
      model: {
        async *generate(context) {
          observedContexts.push(context);
          modelCalls += 1;
          yield modelCalls === 1
            ? {
                type: 'message.completed' as const,
                content: 'Run shell',
                toolCalls: [{ id: 'call-failed', name: 'shell', input: { command: 'bad' } }],
              }
            : { type: 'message.completed' as const, content: 'Recovered from tool error' };
        },
      },
      toolRuntime: {
        async *execute() {
          yield { type: 'error', error: new Error('approval declined') };
        },
      },
    });

    const result = await agent.run({
      input: 'Try it',
      runId: 'run-recover',
      turnId: 'turn-recover',
    });

    expect(observedContexts[1]?.parts).toContainEqual({
      type: 'toolResult',
      toolCallId: 'call-failed',
      toolName: 'shell',
      content: { error: 'approval declined' },
      isError: true,
    });
    expect(result.items.map((item) => item.type)).toEqual(
      expect.arrayContaining(['tool.error', 'tool.result.completed', 'turn.completed'])
    );
  });

  it('does not execute an old-auth response tool call after its lease is revoked', async () => {
    const itemList = createItems();
    const authentication = new AbortController();
    let toolCalls = 0;
    const agent = new AgentLoop({
      itemList,
      model: {
        async *generate() {
          yield {
            type: 'message.completed' as const,
            content: 'Use a tool',
            toolCalls: [{ id: 'old-auth-call', name: 'shell', input: { command: 'secret' } }],
            validitySignal: authentication.signal,
          };
          authentication.abort(new Error('account switched'));
        },
      },
      toolRuntime: {
        async *execute() {
          toolCalls += 1;
          yield { type: 'result.completed', content: 'must not execute' };
        },
      },
    });

    await expect(
      agent.run({ input: 'run', runId: 'run-auth', turnId: 'turn-auth' })
    ).rejects.toThrow('Async iterator consumption aborted');
    expect(toolCalls).toBe(0);
    expect(
      itemList.getItems().find((item) => item.type === 'tool.result.completed')?.payload
    ).toMatchObject({ toolCallId: 'old-auth-call', isError: true, canceled: true });
  });

  it('replays a fully paired batch after the first tool yields', async () => {
    const itemList = createItems();
    const contexts: ModelContext[] = [];
    let modelCalls = 0;
    const agent = new AgentLoop({
      itemList,
      model: {
        async *generate(context) {
          contexts.push(context);
          modelCalls += 1;
          yield modelCalls === 1
            ? {
                type: 'message.completed' as const,
                content: 'Start two tasks',
                toolCalls: [
                  { id: 'yield-call', name: 'thread.wait' },
                  { id: 'abandoned-call', name: 'thread.send' },
                ],
              }
            : { type: 'message.completed' as const, content: 'Resumed safely' };
        },
      },
      toolRuntime: {
        async *execute() {
          yield { type: 'execution.yielded', content: 'waiting' };
        },
      },
    });

    await expect(
      agent.run({ input: 'wait', runId: 'run-yield-1', turnId: 'turn-yield-1' })
    ).resolves.toMatchObject({ yielded: true });
    await expect(
      agent.run({ input: 'resume', runId: 'run-yield-2', turnId: 'turn-yield-2' })
    ).resolves.toMatchObject({ yielded: false });

    const toolResults = contexts[1]?.parts.filter((part) => part.type === 'toolResult') ?? [];
    expect(toolResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: 'yield-call' }),
        expect.objectContaining({ toolCallId: 'abandoned-call', isError: true }),
      ])
    );
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

async function countFunctionCallOutputs(context: ModelContext): Promise<number> {
  const model = openaiCodexProvider()
    .getModels()
    .find((candidate) => candidate.id === 'gpt-5.6-terra');
  if (!model) throw new Error('OpenAI subscription test model is unavailable');
  let providerContext: PiContext | undefined;
  const gateway = new OpenAiSubscriptionModelGateway({
    sessionId: 'hook-output-count',
    tools: [
      {
        type: 'function',
        function: {
          name: 'fake-tool',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    ],
    acquireAccessLease: async () => ({
      accessToken: 'test-token',
      generation: 1,
      signal: new AbortController().signal,
    }),
    provider: {
      getModels: () => [model],
      stream: async function* (_model, streamContext) {
        providerContext = streamContext;
        yield {
          type: 'done',
          reason: 'stop',
          message: completedAssistant(model.id),
        };
      },
    },
  });

  for await (const event of gateway.generate(context)) {
    // Consume the request so the injected provider captures its protocol context.
    void event;
  }
  if (!providerContext) throw new Error('Provider context was not captured');
  return convertResponsesMessages(model, providerContext, new Set(['openai-codex']), {
    includeSystemPrompt: false,
  }).filter((item) => item.type === 'function_call_output').length;
}

function completedAssistant(model: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'complete' }],
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
  };
}
