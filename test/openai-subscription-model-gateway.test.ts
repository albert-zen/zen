import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context as PiContext,
  Model as PiModel,
  OpenAICodexResponsesOptions,
} from '@earendil-works/pi-ai';
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OPENAI_SUBSCRIPTION_MODEL_ID,
  OpenAiSubscriptionModelGateway,
  type OpenAiSubscriptionModelStream,
} from '../packages/framework/src/adapters/node/openai-subscription-model-gateway.js';

describe('OpenAiSubscriptionModelGateway', () => {
  it('converts Zen context and tools into Pi protocol values for a multi-step loop', async () => {
    const requests: CapturedRequest[] = [];
    const stream = captureStream(requests, [doneEvent('finished')]);
    const gateway = new OpenAiSubscriptionModelGateway({
      sessionId: 'thread-stable-1',
      acquireAccessLease: async () => accessLease(),
      tools: [
        {
          type: 'function',
          function: {
            name: 'shell',
            description: 'Run a command.',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' } },
              required: ['command'],
              additionalProperties: false,
            },
          },
        },
      ],
      stream,
    });

    await collect(
      gateway.generate({
        parts: [
          { type: 'message', role: 'system', content: 'You are Zen.' },
          { type: 'message', role: 'user', content: { request: 'inspect' } },
          {
            type: 'message',
            role: 'assistant',
            content: 'Calling a tool.',
            toolCalls: [
              {
                id: 'call-1|item-1',
                name: 'shell',
                input: { command: 'Get-Location' },
              },
            ],
          },
          {
            type: 'toolResult',
            toolCallId: 'call-1|item-1',
            content: { stdout: 'D:\\desktop\\zen' },
          },
        ],
      })
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].context).toEqual({
      systemPrompt: 'You are Zen.',
      messages: [
        expect.objectContaining({
          role: 'user',
          content: '{"request":"inspect"}',
        }),
        expect.objectContaining({
          role: 'assistant',
          content: [
            { type: 'text', text: 'Calling a tool.' },
            {
              type: 'toolCall',
              id: 'call-1|item-1',
              name: 'shell',
              arguments: { command: 'Get-Location' },
            },
          ],
          stopReason: 'toolUse',
        }),
        expect.objectContaining({
          role: 'toolResult',
          toolCallId: 'call-1|item-1',
          toolName: 'shell',
          content: [{ type: 'text', text: '{"stdout":"D:\\\\desktop\\\\zen"}' }],
          isError: false,
        }),
      ],
      tools: [
        {
          name: 'shell',
          description: 'Run a command.',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
            additionalProperties: false,
          },
        },
      ],
    });
  });

  it('maps text deltas and final text/tool calls without exposing reasoning', async () => {
    const final = assistantMessage([
      { type: 'thinking', thinking: 'private chain of thought' },
      { type: 'text', text: 'Answer' },
      {
        type: 'toolCall',
        id: 'call-2|item-2',
        name: 'thread.read',
        arguments: { threadId: 'thread-2' },
      },
    ]);
    const gateway = new OpenAiSubscriptionModelGateway({
      sessionId: 'thread-stable-2',
      acquireAccessLease: async () => accessLease(),
      stream: eventStream([
        { type: 'thinking_delta', contentIndex: 0, delta: 'private', partial: final },
        { type: 'text_delta', contentIndex: 1, delta: 'Ans', partial: final },
        { type: 'text_delta', contentIndex: 1, delta: 'wer', partial: final },
        { type: 'done', reason: 'toolUse', message: final },
      ]),
    });

    await expect(collect(gateway.generate({ parts: [] }))).resolves.toEqual([
      { type: 'text.delta', text: 'Ans' },
      { type: 'text.delta', text: 'wer' },
      expect.objectContaining({
        type: 'message.completed',
        content: 'Answer',
        toolCalls: [
          {
            id: 'call-2|item-2',
            name: 'thread.read',
            input: { threadId: 'thread-2' },
          },
        ],
        validitySignal: expect.any(AbortSignal),
      }),
    ]);
  });

  it('maps dotted, colliding, and long tool names provider-side and reverses model tool calls', async () => {
    const requests: CapturedRequest[] = [];
    const longName = `workspace.${'nested-segment.'.repeat(8)}read`;
    const definitions = ['thread.list', 'thread_list', longName].map((name) => ({
      type: 'function' as const,
      function: {
        name,
        description: `Tool ${name}`,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    }));
    const stream: OpenAiSubscriptionModelStream = (model, context, options) => {
      requests.push({ model, context, options });
      const mappedDottedName = context.tools?.[0]?.name;
      if (!mappedDottedName) throw new Error('Missing mapped dotted tool');
      return eventStream([
        {
          type: 'done',
          reason: 'toolUse',
          message: assistantMessage([
            {
              type: 'toolCall',
              id: 'provider-call',
              name: mappedDottedName,
              arguments: {},
            },
          ]),
        },
      ])(model, context, options);
    };
    const gateway = new OpenAiSubscriptionModelGateway({
      sessionId: 'thread-tool-name-map',
      acquireAccessLease: async () => accessLease(),
      tools: definitions,
      stream,
    });
    const history = {
      parts: [
        {
          type: 'message' as const,
          role: 'assistant' as const,
          content: '',
          toolCalls: [
            { id: 'history-dotted', name: 'thread.list', input: {} },
            { id: 'history-safe', name: 'thread_list', input: {} },
            { id: 'history-legacy', name: 'legacy.read', input: {} },
          ],
        },
        {
          type: 'toolResult' as const,
          toolCallId: 'history-dotted',
          toolName: 'thread.list',
          content: 'dotted result',
        },
        {
          type: 'toolResult' as const,
          toolCallId: 'history-safe',
          toolName: 'thread_list',
          content: 'safe result',
        },
        {
          type: 'toolResult' as const,
          toolCallId: 'history-legacy',
          toolName: 'legacy.read',
          content: 'legacy result',
        },
      ],
    };

    const first = await collect(gateway.generate(history));
    await collect(gateway.generate(history));

    const firstNames = requests[0].context.tools?.map((tool) => tool.name) ?? [];
    const secondNames = requests[1].context.tools?.map((tool) => tool.name) ?? [];
    expect(secondNames).toEqual(firstNames);
    expect(new Set(firstNames).size).toBe(firstNames.length);
    expect(firstNames.every((name) => /^[a-zA-Z0-9_-]+$/.test(name))).toBe(true);
    expect(firstNames.every((name) => name.length <= 64)).toBe(true);
    expect(firstNames[1]).toBe('thread_list');
    expect(firstNames[0]).not.toBe(firstNames[1]);
    expect(firstNames[2]).toMatch(/^workspace_/);

    const messages = requests[0].context.messages;
    const assistant = messages.find((message) => message.role === 'assistant');
    const historyNames =
      assistant?.role === 'assistant'
        ? assistant.content.flatMap((block) => (block.type === 'toolCall' ? [block.name] : []))
        : [];
    expect(historyNames.slice(0, 2)).toEqual(firstNames.slice(0, 2));
    expect(historyNames[2]).toMatch(/^legacy_read__/);
    expect(
      messages.filter((message) => message.role === 'toolResult').map((message) => message.toolName)
    ).toEqual(historyNames);
    expect(first).toEqual([
      expect.objectContaining({
        type: 'message.completed',
        content: '',
        toolCalls: [{ id: 'provider-call', name: 'thread.list', input: {} }],
        validitySignal: expect.any(AbortSignal),
      }),
    ]);
  });

  it('replays raw text and reasoning signatures so Pi sees an exact cross-Turn prefix', async () => {
    const requests: CapturedRequest[] = [];
    const firstResponse = assistantMessage([
      {
        type: 'thinking',
        thinking: 'summary',
        thinkingSignature: JSON.stringify({
          type: 'reasoning',
          id: 'rs_real_1',
          summary: [{ type: 'summary_text', text: 'summary' }],
          encrypted_content: 'opaque-reasoning-1',
        }),
      },
      {
        type: 'text',
        text: 'Remembered answer',
        textSignature: JSON.stringify({
          v: 1,
          id: 'msg_real_1',
          phase: 'final_answer',
        }),
      },
    ]);
    firstResponse.responseId = 'resp_real_1';
    const gateway = new OpenAiSubscriptionModelGateway({
      sessionId: 'thread-continuation-text',
      acquireAccessLease: async () => accessLease(),
      stream: captureSequentialResponses(requests, [firstResponse, assistantMessage([])]),
    });
    const firstParts = [
      { type: 'message' as const, role: 'system' as const, content: 'You are Zen.' },
      { type: 'message' as const, role: 'user' as const, content: 'Remember this.' },
    ];

    await collect(gateway.generate({ parts: firstParts }));
    await collect(
      gateway.generate({
        parts: [
          ...firstParts,
          { type: 'message', role: 'assistant', content: 'Remembered answer' },
          { type: 'message', role: 'user', content: 'What did I ask?' },
        ],
      })
    );

    const replayed = requests[1].context.messages.find((message) => message.role === 'assistant');
    expect(replayed).toEqual(firstResponse);
    expectExactPiContinuationPrefix(requests[0], firstResponse, requests[1]);
  });

  it('discards opaque continuation when credential generation changes during token resolution', async () => {
    const requests: CapturedRequest[] = [];
    const firstResponse = assistantMessage([
      {
        type: 'text',
        text: 'Old-account answer',
        textSignature: JSON.stringify({ v: 1, id: 'msg_old_account' }),
      },
    ]);
    let generation = 0;
    let resolutions = 0;
    const gateway = new OpenAiSubscriptionModelGateway({
      sessionId: 'thread-account-switch',
      acquireAccessLease: async () => {
        resolutions += 1;
        if (resolutions === 2) generation += 1;
        return accessLease(`access-${generation}`, generation);
      },
      stream: captureSequentialResponses(requests, [firstResponse, assistantMessage([])]),
    });
    const firstParts = [
      { type: 'message' as const, role: 'user' as const, content: 'First account prompt' },
    ];

    await collect(gateway.generate({ parts: firstParts }));
    await collect(
      gateway.generate({
        parts: [
          ...firstParts,
          { type: 'message', role: 'assistant', content: 'Old-account answer' },
          { type: 'message', role: 'user', content: 'Continue after account switch' },
        ],
      })
    );

    const reconstructed = requests[1].context.messages.find(
      (message) => message.role === 'assistant'
    );
    expect(reconstructed).not.toEqual(firstResponse);
    expect(reconstructed?.content).toEqual([{ type: 'text', text: 'Old-account answer' }]);
  });

  it('replays the provider function-call id and signatures through a tool loop', async () => {
    const requests: CapturedRequest[] = [];
    let firstResponse: AssistantMessage | undefined;
    const stream: OpenAiSubscriptionModelStream = (model, context, options) => {
      requests.push({ model, context, options });
      if (!firstResponse) {
        const providerToolName = context.tools?.[0]?.name;
        if (!providerToolName) throw new Error('Missing provider tool name');
        firstResponse = assistantMessage([
          {
            type: 'thinking',
            thinking: '',
            thinkingSignature: JSON.stringify({
              type: 'reasoning',
              id: 'rs_tool_1',
              summary: [],
              encrypted_content: 'opaque-tool-reasoning',
            }),
          },
          {
            type: 'toolCall',
            id: 'call_real_1|fc_real_1',
            name: providerToolName,
            arguments: {},
          },
        ]);
        firstResponse.responseId = 'resp_tool_1';
        return eventStream([{ type: 'done', reason: 'toolUse', message: firstResponse }])(
          model,
          context,
          options
        );
      }
      return eventStream([doneEvent('Tool complete')])(model, context, options);
    };
    const gateway = new OpenAiSubscriptionModelGateway({
      sessionId: 'thread-continuation-tool',
      acquireAccessLease: async () => accessLease(),
      tools: [
        {
          type: 'function',
          function: {
            name: 'thread.list',
            description: 'List threads.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
      ],
      stream,
    });
    const firstParts = [
      { type: 'message' as const, role: 'user' as const, content: 'List threads.' },
    ];

    await collect(gateway.generate({ parts: firstParts }));
    await collect(
      gateway.generate({
        parts: [
          ...firstParts,
          {
            type: 'message',
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_real_1|fc_real_1', name: 'thread.list', input: {} }],
          },
          {
            type: 'toolResult',
            toolCallId: 'call_real_1|fc_real_1',
            toolName: 'thread.list',
            content: 'No threads.',
          },
        ],
      })
    );

    expect(firstResponse).toBeDefined();
    const replayed = requests[1].context.messages.find((message) => message.role === 'assistant');
    expect(replayed).toEqual(firstResponse);
    expectExactPiContinuationPrefix(requests[0], firstResponse!, requests[1]);
  });

  it('falls back to reconstructed full context after divergence or gateway restart', async () => {
    const firstResponse = assistantMessage([
      {
        type: 'text',
        text: 'Original answer',
        textSignature: JSON.stringify({ v: 1, id: 'msg_original' }),
      },
    ]);
    firstResponse.responseId = 'resp_original';
    const requests: CapturedRequest[] = [];
    const gateway = new OpenAiSubscriptionModelGateway({
      sessionId: 'thread-diverged',
      acquireAccessLease: async () => accessLease(),
      stream: captureSequentialResponses(requests, [firstResponse, assistantMessage([])]),
    });

    await collect(
      gateway.generate({
        parts: [{ type: 'message', role: 'user', content: 'Original prompt' }],
      })
    );
    const divergedParts = [
      { type: 'message' as const, role: 'user' as const, content: 'Compacted prompt' },
      { type: 'message' as const, role: 'assistant' as const, content: 'Original answer' },
      { type: 'message' as const, role: 'user' as const, content: 'Continue' },
    ];
    await collect(gateway.generate({ parts: divergedParts }));

    const divergedAssistant = requests[1].context.messages.find(
      (message) => message.role === 'assistant'
    );
    expect(divergedAssistant?.role).toBe('assistant');
    expect(divergedAssistant?.content).toEqual([{ type: 'text', text: 'Original answer' }]);

    const restartedRequests: CapturedRequest[] = [];
    const restarted = new OpenAiSubscriptionModelGateway({
      sessionId: 'thread-diverged',
      acquireAccessLease: async () => accessLease(),
      stream: captureStream(restartedRequests, [doneEvent('Restarted')]),
    });
    await collect(restarted.generate({ parts: divergedParts }));
    const restartedAssistant = restartedRequests[0].context.messages.find(
      (message) => message.role === 'assistant'
    );
    expect(restartedAssistant?.role).toBe('assistant');
    expect(restartedAssistant?.content).toEqual([{ type: 'text', text: 'Original answer' }]);
  });

  it('uses the default model and stable auto transport options across requests', async () => {
    const requests: CapturedRequest[] = [];
    const acquireAccessLease = vi
      .fn<(signal?: AbortSignal) => Promise<ReturnType<typeof accessLease>>>()
      .mockResolvedValueOnce(accessLease('token-1'))
      .mockResolvedValueOnce(accessLease('token-2'));
    const gateway = new OpenAiSubscriptionModelGateway({
      sessionId: 'logical-thread-42',
      acquireAccessLease,
      stream: captureStream(requests, [doneEvent('ok')]),
    });
    const firstSignal = new AbortController().signal;

    await collect(
      gateway.generate(
        { parts: [] },
        {
          reasoningEffort: 'high',
          reasoningSummary: 'concise',
          serviceTier: 'priority',
          verbosity: 'medium',
          temperature: 0.2,
          maxTokens: 2048,
          transport: 'sse',
          sessionId: 'attempted-override',
        },
        firstSignal
      )
    );
    await collect(gateway.generate({ parts: [] }));

    expect(requests.map((request) => request.model.id)).toEqual([
      DEFAULT_OPENAI_SUBSCRIPTION_MODEL_ID,
      DEFAULT_OPENAI_SUBSCRIPTION_MODEL_ID,
    ]);
    expect(requests[0].options).toEqual({
      reasoningEffort: 'high',
      reasoningSummary: 'concise',
      serviceTier: 'priority',
      textVerbosity: 'medium',
      temperature: 0.2,
      maxTokens: 2048,
      apiKey: 'token-1',
      sessionId: 'logical-thread-42',
      signal: expect.any(AbortSignal),
      transport: 'auto',
    });
    expect(requests[1].options).toEqual({
      apiKey: 'token-2',
      sessionId: 'logical-thread-42',
      signal: expect.any(AbortSignal),
      transport: 'auto',
    });
    expect(acquireAccessLease).toHaveBeenNthCalledWith(1, firstSignal);
    expect(acquireAccessLease).toHaveBeenNthCalledWith(2, undefined);
  });

  it('maps provider failures and aborts to Zen error events', async () => {
    const providerFailure = assistantMessage([]);
    providerFailure.errorMessage = 'subscription quota exhausted';
    providerFailure.stopReason = 'error';
    const failedGateway = new OpenAiSubscriptionModelGateway({
      sessionId: 'thread-error',
      acquireAccessLease: async () => accessLease(),
      stream: eventStream([{ type: 'error', reason: 'error', error: providerFailure }]),
    });

    const [failed] = await collect(failedGateway.generate({ parts: [] }));
    expect(failed).toMatchObject({
      type: 'error',
      error: expect.objectContaining({ message: 'subscription quota exhausted' }),
    });

    const controller = new AbortController();
    controller.abort();
    const resolver = vi.fn(async () => accessLease('unused-token'));
    const stream = vi.fn<OpenAiSubscriptionModelStream>();
    const abortedGateway = new OpenAiSubscriptionModelGateway({
      sessionId: 'thread-abort',
      acquireAccessLease: resolver,
      stream,
    });

    const [aborted] = await collect(
      abortedGateway.generate({ parts: [] }, undefined, controller.signal)
    );
    expect(aborted).toMatchObject({
      type: 'error',
      error: expect.objectContaining({ name: 'AbortError' }),
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it.each(['delayed WebSocket connect on logout', 'HTTP fallback on account switch'])(
    'aborts old-generation transport during %s',
    async () => {
      const authentication = new AbortController();
      const streamStarted = deferred<void>();
      let requestSignal: AbortSignal | undefined;
      const gateway = new OpenAiSubscriptionModelGateway({
        sessionId: 'thread-auth-fence',
        acquireAccessLease: async () => ({
          accessToken: 'old-account-token',
          generation: 1,
          signal: authentication.signal,
        }),
        stream: async function* (_model, _context, options) {
          requestSignal = options.signal;
          streamStarted.resolve();
          await rejectOnAbort(options.signal ?? new AbortController().signal);
          yield doneEvent('unreachable');
        },
      });

      const result = collect(gateway.generate({ parts: [] }));
      await streamStarted.promise;
      authentication.abort(new Error('authentication changed'));

      await expect(result).resolves.toEqual([
        expect.objectContaining({
          type: 'error',
          error: expect.objectContaining({ message: 'authentication changed' }),
        }),
      ]);
      expect(requestSignal?.aborted).toBe(true);
    }
  );

  it.each([
    ['silent EOF', []],
    ['duplicate terminal events', [doneEvent('first'), doneEvent('second')]],
  ])('rejects %s instead of recording a completed model request', async (_label, events) => {
    const gateway = new OpenAiSubscriptionModelGateway({
      sessionId: 'thread-invalid-terminal',
      acquireAccessLease: async () => accessLease(),
      stream: eventStream(events),
    });

    const result = await collect(gateway.generate({ parts: [] }));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'error',
      error: expect.objectContaining({ message: expect.stringContaining('terminal') }),
    });
  });

  it('contains no process-spawning API', async () => {
    const sourcePath = fileURLToPath(
      new URL(
        '../packages/framework/src/adapters/node/openai-subscription-model-gateway.ts',
        import.meta.url
      )
    );
    const source = await readFile(sourcePath, 'utf8');

    expect(source).not.toMatch(/node:child_process/);
    expect(source).not.toMatch(/\b(?:spawn|exec|execFile|fork)\s*\(/);
  });
});

type CapturedRequest = {
  readonly model: PiModel<'openai-codex-responses'>;
  readonly context: PiContext;
  readonly options: OpenAICodexResponsesOptions;
};

function captureStream(
  requests: CapturedRequest[],
  events: readonly AssistantMessageEvent[]
): OpenAiSubscriptionModelStream {
  return (model, context, options) => {
    requests.push({ model, context, options });
    return eventStream(events)(model, context, options);
  };
}

function captureSequentialResponses(
  requests: CapturedRequest[],
  responses: readonly AssistantMessage[]
): OpenAiSubscriptionModelStream {
  let index = 0;
  return (model, context, options) => {
    requests.push({ model, context, options });
    const message = responses[index++];
    if (!message) throw new Error('Missing sequential provider response');
    return eventStream([{ type: 'done', reason: completedReason(message), message }])(
      model,
      context,
      options
    );
  };
}

function completedReason(message: AssistantMessage): 'stop' | 'length' | 'toolUse' {
  if (
    message.stopReason === 'stop' ||
    message.stopReason === 'length' ||
    message.stopReason === 'toolUse'
  ) {
    return message.stopReason;
  }
  throw new Error(`Sequential response is not completed: ${message.stopReason}`);
}

function expectExactPiContinuationPrefix(
  previous: CapturedRequest,
  response: AssistantMessage,
  current: CapturedRequest
): void {
  const providers = new Set(['openai', 'openai-codex', 'opencode']);
  const previousInput = convertResponsesMessages(previous.model, previous.context, providers, {
    includeSystemPrompt: false,
  });
  const responseItems = convertResponsesMessages(
    previous.model,
    { messages: [response] },
    providers,
    { includeSystemPrompt: false }
  ).filter((item) => item.type !== 'function_call_output');
  const currentInput = convertResponsesMessages(current.model, current.context, providers, {
    includeSystemPrompt: false,
  });
  const baseline = [...previousInput, ...responseItems];

  expect(currentInput.slice(0, baseline.length)).toEqual(baseline);
  expect(currentInput.length).toBeGreaterThan(baseline.length);
}

function eventStream(events: readonly AssistantMessageEvent[]): OpenAiSubscriptionModelStream {
  return async function* () {
    yield* events;
  };
}

function accessLease(accessToken = 'access-token', generation = 0) {
  return {
    accessToken,
    generation,
    signal: new AbortController().signal,
  } as const;
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

function doneEvent(text: string): AssistantMessageEvent {
  return { type: 'done', reason: 'stop', message: assistantMessage([{ type: 'text', text }]) };
}

function assistantMessage(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: DEFAULT_OPENAI_SUBSCRIPTION_MODEL_ID,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  };
}

async function collect<T>(events: AsyncIterable<T>): Promise<readonly T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
