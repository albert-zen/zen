import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context as PiContext,
  Model as PiModel,
  OpenAICodexResponsesOptions,
  TSchema,
  Tool as PiTool,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import type { ModelContext, ModelContextPart } from '../../kernel/index.js';
import type { ModelEvent, ModelGateway, ModelOptions } from '../../kernel/index.js';
import { DEFAULT_OPENAI_SUBSCRIPTION_MODEL_ID } from './openai-subscription-contract.js';

export { DEFAULT_OPENAI_SUBSCRIPTION_MODEL_ID } from './openai-subscription-contract.js';

const providerToolNamePattern = /^[a-zA-Z0-9_-]+$/;
const providerToolNameMaxLength = 64;

export type OpenAiSubscriptionToolDefinition = Readonly<{
  readonly type: 'function';
  readonly function: Readonly<{
    readonly name: string;
    readonly description?: string;
    readonly parameters: unknown;
  }>;
}>;

export type OpenAiSubscriptionAccessLease = Readonly<{
  readonly accessToken: string;
  readonly generation: number;
  readonly signal: AbortSignal;
}>;

export type OpenAiSubscriptionAccessLeaseAcquirer = (
  signal?: AbortSignal
) => Promise<OpenAiSubscriptionAccessLease>;

export type OpenAiSubscriptionModelStream = (
  model: PiModel<'openai-codex-responses'>,
  context: PiContext,
  options: OpenAICodexResponsesOptions
) => AsyncIterable<AssistantMessageEvent>;

export type OpenAiSubscriptionProvider = Readonly<{
  getModels(): readonly PiModel<'openai-codex-responses'>[];
  stream: OpenAiSubscriptionModelStream;
}>;

export type OpenAiSubscriptionModelGatewayOptions = Readonly<{
  readonly modelId?: string;
  readonly sessionId: string;
  readonly tools?: readonly OpenAiSubscriptionToolDefinition[];
  readonly acquireAccessLease: OpenAiSubscriptionAccessLeaseAcquirer;
  readonly provider?: OpenAiSubscriptionProvider;
  readonly stream?: OpenAiSubscriptionModelStream;
}>;

export class OpenAiSubscriptionModelGateway implements ModelGateway {
  private readonly model: PiModel<'openai-codex-responses'>;
  private readonly sessionId: string;
  private readonly toolDefinitions: readonly OpenAiSubscriptionToolDefinition[];
  private readonly acquireAccessLease: OpenAiSubscriptionAccessLeaseAcquirer;
  private readonly stream: OpenAiSubscriptionModelStream;
  private continuation: OpenAiSubscriptionContinuation | undefined;

  constructor(options: OpenAiSubscriptionModelGatewayOptions) {
    if (options.sessionId.trim().length === 0) {
      throw new Error('OpenAI subscription sessionId must be non-empty');
    }

    const provider = options.provider ?? openaiCodexProvider();
    const modelId = options.modelId ?? DEFAULT_OPENAI_SUBSCRIPTION_MODEL_ID;
    const model = provider.getModels().find((candidate) => candidate.id === modelId);

    if (!model) {
      throw new Error(`Unknown OpenAI subscription model: ${modelId}`);
    }

    this.model = model;
    this.sessionId = options.sessionId;
    this.toolDefinitions = options.tools ?? [];
    this.acquireAccessLease = options.acquireAccessLease;
    this.stream =
      options.stream ??
      ((streamModel, context, streamOptions) =>
        provider.stream(streamModel, context, streamOptions));
  }

  async *generate(
    context: ModelContext,
    options?: ModelOptions,
    signal?: AbortSignal
  ): AsyncIterable<ModelEvent> {
    let requestSignal = signal;
    try {
      throwIfAborted(signal);
      const lease = await this.acquireAccessLease(signal);
      requestSignal = combineAbortSignals(signal, lease.signal);
      throwIfAborted(requestSignal);

      if (lease.accessToken.trim().length === 0) {
        throw new Error('OpenAI subscription access lease returned an empty token');
      }

      const sessionGeneration = lease.generation;
      if (this.continuation?.sessionGeneration !== sessionGeneration) {
        this.continuation = undefined;
      }

      const toolNames = createProviderToolNameMap(this.toolDefinitions, context.parts);
      const tools = toPiTools(this.toolDefinitions, toolNames);
      const piContext =
        continuePiContext(context.parts, tools, this.model, toolNames, this.continuation) ??
        toPiContext(context.parts, tools, this.model, toolNames);
      this.continuation = undefined;
      const events = this.stream(this.model, piContext, {
        ...toPiModelOptions(options),
        apiKey: lease.accessToken,
        sessionId: this.sessionId,
        signal: requestSignal,
        transport: 'auto',
      });

      let terminal: Extract<AssistantMessageEvent, { type: 'done' | 'error' }> | undefined;
      let terminalFailure: Error | undefined;

      for await (const event of events) {
        throwIfAborted(requestSignal);

        if (terminal) {
          terminalFailure = new Error(
            'OpenAI subscription stream emitted more than one terminal event'
          );
          break;
        }

        if (event.type === 'text_delta') {
          yield { type: 'text.delta', text: event.delta };
          continue;
        }

        if (event.type === 'done') {
          terminal = event;
          continue;
        }

        if (event.type === 'error') {
          terminal = event;
        }
      }

      if (terminalFailure) throw terminalFailure;
      if (!terminal) {
        throw new Error('OpenAI subscription stream ended without exactly one terminal event');
      }
      throwIfAborted(requestSignal);
      if (terminal.type === 'error') {
        yield {
          type: 'error',
          error: toModelError(terminal.error, terminal.reason === 'aborted'),
        };
        return;
      }

      const completed = toCompletedEvent(terminal.message, toolNames, requestSignal);
      this.continuation = {
        requestParts: context.parts,
        requestContext: piContext,
        response: terminal.message,
        responsePart: toAssistantContextPart(completed),
        sessionGeneration,
      };
      yield completed;
    } catch (error) {
      yield {
        type: 'error',
        error: requestSignal?.aborted ? abortError(requestSignal) : toModelError(error, false),
      };
    }
  }
}

type OpenAiSubscriptionContinuation = Readonly<{
  readonly requestParts: readonly ModelContextPart[];
  readonly requestContext: PiContext;
  readonly response: AssistantMessage;
  readonly responsePart: ModelContextPart;
  readonly sessionGeneration?: number;
}>;

function continuePiContext(
  parts: readonly ModelContextPart[],
  tools: readonly PiTool[],
  model: PiModel<'openai-codex-responses'>,
  toolNameMap: ProviderToolNameMap,
  continuation: OpenAiSubscriptionContinuation | undefined
): PiContext | undefined {
  if (!continuation) return undefined;

  const requestLength = continuation.requestParts.length;
  if (
    parts.length <= requestLength ||
    !isDeepStrictEqual(parts.slice(0, requestLength), continuation.requestParts) ||
    !isDeepStrictEqual(parts[requestLength], continuation.responsePart)
  ) {
    return undefined;
  }

  const tail = toPiContext(parts.slice(requestLength + 1), [], model, toolNameMap);
  return {
    ...(continuation.requestContext.systemPrompt
      ? { systemPrompt: continuation.requestContext.systemPrompt }
      : {}),
    messages: [...continuation.requestContext.messages, continuation.response, ...tail.messages],
    ...(tools.length > 0 ? { tools: [...tools] } : {}),
  };
}

function toPiContext(
  parts: readonly ModelContextPart[],
  tools: readonly PiTool[],
  model: PiModel<'openai-codex-responses'>,
  toolNameMap: ProviderToolNameMap
): PiContext {
  const systemPrompts: string[] = [];
  const messages: PiContext['messages'] = [];
  const toolNames = new Map<string, string>();

  for (const [index, part] of parts.entries()) {
    if (part.type === 'message' && part.role === 'system') {
      systemPrompts.push(stringifyContent(part.content));
      continue;
    }

    if (part.type === 'message' && part.role === 'user') {
      messages.push({
        role: 'user',
        content: stringifyContent(part.content),
        timestamp: index,
      });
      continue;
    }

    if (part.type === 'message') {
      const content: AssistantMessage['content'] = [];
      const text = stringifyContent(part.content);

      if (text.length > 0) {
        content.push({ type: 'text', text });
      }

      for (const call of part.toolCalls ?? []) {
        const providerName = toolNameMap.toProvider(call.name);
        toolNames.set(call.id, providerName);
        content.push({
          type: 'toolCall',
          id: call.id,
          name: providerName,
          arguments: toToolArguments(call.input),
        });
      }

      messages.push({
        role: 'assistant',
        content,
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        model: model.id,
        usage: emptyUsage(),
        stopReason: part.toolCalls?.length ? 'toolUse' : 'stop',
        timestamp: index,
      });
      continue;
    }

    messages.push({
      role: 'toolResult',
      toolCallId: part.toolCallId,
      toolName:
        (part.toolName ? toolNameMap.toProvider(part.toolName) : undefined) ??
        toolNames.get(part.toolCallId) ??
        '',
      content: [{ type: 'text', text: stringifyContent(part.content) }],
      isError: part.isError === true,
      timestamp: index,
    });
  }

  return {
    ...(systemPrompts.length > 0 ? { systemPrompt: systemPrompts.join('\n\n') } : {}),
    messages,
    ...(tools.length > 0 ? { tools: [...tools] } : {}),
  };
}

function toPiTools(
  definitions: readonly OpenAiSubscriptionToolDefinition[],
  toolNameMap: ProviderToolNameMap
): readonly PiTool[] {
  return definitions.map((definition) => ({
    name: toolNameMap.toProvider(definition.function.name),
    description: definition.function.description ?? '',
    parameters: definition.function.parameters as TSchema,
  }));
}

function toCompletedEvent(
  message: AssistantMessage,
  toolNameMap: ProviderToolNameMap,
  validitySignal: AbortSignal
): Extract<ModelEvent, { readonly type: 'message.completed' }> {
  const content = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const toolCalls = message.content.flatMap((block) =>
    block.type === 'toolCall'
      ? [{ id: block.id, name: toolNameMap.toZen(block.name), input: block.arguments }]
      : []
  );

  return {
    type: 'message.completed',
    content,
    validitySignal,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function toAssistantContextPart(
  event: Extract<ModelEvent, { readonly type: 'message.completed' }>
): ModelContextPart {
  return {
    type: 'message',
    role: 'assistant',
    content: event.content,
    ...(event.toolCalls ? { toolCalls: event.toolCalls } : {}),
  };
}

type ProviderToolNameMap = {
  toProvider(zenName: string): string;
  toZen(providerName: string): string;
};

function createProviderToolNameMap(
  definitions: readonly OpenAiSubscriptionToolDefinition[],
  parts: readonly ModelContextPart[]
): ProviderToolNameMap {
  const names = new Set(definitions.map((definition) => definition.function.name));
  for (const part of parts) {
    if (part.type === 'message') {
      for (const call of part.toolCalls ?? []) names.add(call.name);
    } else if (part.toolName) {
      names.add(part.toolName);
    }
  }

  const zenToProvider = new Map<string, string>();
  const providerToZen = new Map<string, string>();
  const sortedNames = [...names].sort();
  const directNames = sortedNames.filter(isProviderSafeToolName);
  for (const name of directNames) {
    zenToProvider.set(name, name);
    providerToZen.set(name, name);
  }

  for (const name of sortedNames) {
    if (zenToProvider.has(name)) continue;
    let collision = 0;
    let providerName = mappedProviderToolName(name, collision);
    while (providerToZen.has(providerName)) {
      collision += 1;
      providerName = mappedProviderToolName(name, collision);
    }
    zenToProvider.set(name, providerName);
    providerToZen.set(providerName, name);
  }

  return {
    toProvider: (name) => {
      const mapped = zenToProvider.get(name);
      if (!mapped) throw new Error(`OpenAI subscription tool name was not mapped: ${name}`);
      return mapped;
    },
    toZen: (name) => providerToZen.get(name) ?? name,
  };
}

function isProviderSafeToolName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= providerToolNameMaxLength &&
    providerToolNamePattern.test(name)
  );
}

function mappedProviderToolName(name: string, collision: number): string {
  const readable = name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 12);
  const collisionSuffix = collision === 0 ? '' : `_${collision.toString(36)}`;
  const suffix = `__${digest}${collisionSuffix}`;
  return `${readable.slice(0, providerToolNameMaxLength - suffix.length)}${suffix}`;
}

function toPiModelOptions(options?: ModelOptions): OpenAICodexResponsesOptions {
  if (!options) return {};

  return {
    ...(isReasoningEffort(options.reasoningEffort)
      ? { reasoningEffort: options.reasoningEffort }
      : {}),
    ...(isReasoningSummary(options.reasoningSummary)
      ? { reasoningSummary: options.reasoningSummary }
      : {}),
    ...(isServiceTier(options.serviceTier) ? { serviceTier: options.serviceTier } : {}),
    ...(isVerbosity(options.textVerbosity)
      ? { textVerbosity: options.textVerbosity }
      : isVerbosity(options.verbosity)
        ? { textVerbosity: options.verbosity }
        : {}),
    ...(isFiniteNumber(options.temperature) ? { temperature: options.temperature } : {}),
    ...(isFiniteNumber(options.maxTokens) ? { maxTokens: options.maxTokens } : {}),
  };
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  const serialized = JSON.stringify(value);
  return serialized ?? String(value ?? '');
}

function toToolArguments(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function emptyUsage(): AssistantMessage['usage'] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function combineAbortSignals(
  turnSignal: AbortSignal | undefined,
  authenticationSignal: AbortSignal
): AbortSignal {
  return turnSignal ? AbortSignal.any([turnSignal, authenticationSignal]) : authenticationSignal;
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Model request aborted');
  error.name = 'AbortError';
  return error;
}

function toModelError(error: unknown, aborted: boolean): Error {
  if (error instanceof Error) return error;
  const message =
    readErrorMessage(error) ?? (aborted ? 'Model request aborted' : 'Model request failed');
  const mapped = new Error(message);
  if (aborted) mapped.name = 'AbortError';
  return mapped;
}

function readErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.errorMessage === 'string' ? value.errorMessage : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isReasoningEffort(
  value: unknown
): value is NonNullable<OpenAICodexResponsesOptions['reasoningEffort']> {
  return (
    typeof value === 'string' &&
    ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)
  );
}

function isReasoningSummary(
  value: unknown
): value is NonNullable<OpenAICodexResponsesOptions['reasoningSummary']> {
  return (
    value === null ||
    (typeof value === 'string' && ['auto', 'concise', 'detailed', 'off', 'on'].includes(value))
  );
}

function isServiceTier(
  value: unknown
): value is NonNullable<OpenAICodexResponsesOptions['serviceTier']> {
  return typeof value === 'string' && ['auto', 'default', 'flex', 'priority'].includes(value);
}

function isVerbosity(
  value: unknown
): value is NonNullable<OpenAICodexResponsesOptions['textVerbosity']> {
  return typeof value === 'string' && ['low', 'medium', 'high'].includes(value);
}
