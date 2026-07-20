import type {
  ToolCallPayload,
  ToolExecutionContext,
  ToolRuntime,
  ToolRuntimeEvent,
} from '../kernel/index.js';
import type { JsonObject } from './app-server-protocol.js';
import type { AgentAppRequest, AgentAppResponse } from './agent-app-protocol.js';

type ThreadToolName =
  | 'thread.create'
  | 'thread.list'
  | 'thread.read'
  | 'thread.send'
  | 'thread.wait'
  | 'thread.cancel'
  | 'thread.archive'
  | 'thread.handoff';

export type ThreadToolExecutionContext = {
  /** Only the server/runtime creates this value. Tool payload is never authority. */
  readonly actor?: 'human' | 'agent';
  readonly projectId: string;
  readonly sourceThreadId: string;
};

export type ThreadToolRuntimeOptions = {
  readonly request: (
    request: AgentAppRequest,
    context: ThreadToolExecutionContext & { readonly signal?: AbortSignal }
  ) => Promise<AgentAppResponse>;
  readonly resolveExecutionContext: (
    context: ToolExecutionContext
  ) => ThreadToolExecutionContext | undefined;
  readonly fallback?: ToolRuntime;
};

export class ThreadToolError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'RESOURCE_EXHAUSTED',
    message: string
  ) {
    super(message);
    this.name = 'ThreadToolError';
  }
}

export const threadToolDefinitions = [
  toolDefinition('thread.create', ['idempotencyKey']),
  toolDefinition('thread.list', []),
  toolDefinition('thread.read', ['threadId']),
  toolDefinition('thread.send', ['threadId', 'content', 'idempotencyKey']),
  toolDefinition('thread.wait', ['threadIds', 'mode', 'idempotencyKey']),
  toolDefinition('thread.cancel', ['threadId', 'idempotencyKey']),
  toolDefinition('thread.archive', ['threadId', 'idempotencyKey']),
  toolDefinition('thread.handoff', ['threadId', 'content', 'idempotencyKey']),
] as const;

export class ThreadToolRuntime implements ToolRuntime {
  private readonly request: ThreadToolRuntimeOptions['request'];
  private readonly resolveExecutionContext: ThreadToolRuntimeOptions['resolveExecutionContext'];
  private readonly fallback?: ToolRuntime;

  constructor(options: ThreadToolRuntimeOptions) {
    this.request = options.request;
    this.resolveExecutionContext = options.resolveExecutionContext;
    this.fallback = options.fallback;
  }

  async *execute(
    call: ToolCallPayload,
    context: ToolExecutionContext
  ): AsyncIterable<ToolRuntimeEvent> {
    if (!isThreadTool(call.name)) {
      if (this.fallback) {
        yield* this.fallback.execute(call, context);
        return;
      }
      yield {
        type: 'error',
        error: new ThreadToolError('NOT_FOUND', `Unknown tool: ${call.name}`),
      };
      return;
    }
    try {
      const execution = this.resolveExecutionContext(context);
      if (!execution)
        throw new ThreadToolError('FORBIDDEN', 'Thread tool execution context is unavailable');
      const result = await this.dispatch(
        call.name,
        objectInput(call.input),
        execution,
        context.signal
      );
      yield {
        type: call.name === 'thread.wait' ? 'execution.yielded' : 'result.completed',
        content: result,
      };
    } catch (error) {
      yield { type: 'error', error };
    }
  }

  private async dispatch(
    name: ThreadToolName,
    input: Readonly<Record<string, unknown>>,
    execution: ThreadToolExecutionContext,
    signal?: AbortSignal
  ): Promise<unknown> {
    const params = { projectId: execution.projectId } as Record<string, unknown>;
    if (name === 'thread.create') {
      params.sourceThreadId = execution.sourceThreadId;
      params.objective = optionalString(input.objective, 'objective');
      params.idempotencyKey = requiredString(input.idempotencyKey, 'idempotencyKey');
      return await this.call(name, params, execution, signal);
    }
    if (name === 'thread.list') return await this.call(name, params, execution, signal);
    if (name === 'thread.read') {
      params.threadId = requiredString(input.threadId, 'threadId');
      return await this.call(name, params, execution, signal);
    }
    if (name === 'thread.send') {
      params.sourceThreadId = execution.sourceThreadId;
      params.threadId = requiredString(input.threadId, 'threadId');
      params.content = requiredString(input.content, 'content');
      params.idempotencyKey = requiredString(input.idempotencyKey, 'idempotencyKey');
      params.interrupt = optionalBoolean(input.interrupt, 'interrupt') ?? false;
      return await this.call(name, params, execution, signal);
    }
    if (name === 'thread.wait') {
      params.threadId = execution.sourceThreadId;
      params.threadIds = requiredStringArray(input.threadIds, 'threadIds');
      params.mode = requiredMode(input.mode);
      params.idempotencyKey = requiredString(input.idempotencyKey, 'idempotencyKey');
      return await this.call(name, params, execution, signal);
    }
    if (name === 'thread.cancel') {
      params.threadId = requiredString(input.threadId, 'threadId');
      params.idempotencyKey = requiredString(input.idempotencyKey, 'idempotencyKey');
      return await this.call(name, params, execution, signal);
    }
    if (name === 'thread.archive') {
      params.threadId = requiredString(input.threadId, 'threadId');
      params.idempotencyKey = requiredString(input.idempotencyKey, 'idempotencyKey');
      return await this.call(name, params, execution, signal);
    }
    params.sourceThreadId = execution.sourceThreadId;
    params.threadId = requiredString(input.threadId, 'threadId');
    params.content = requiredString(input.content, 'content');
    params.idempotencyKey = requiredString(input.idempotencyKey, 'idempotencyKey');
    return await this.call(name, params, execution, signal);
  }

  private async call(
    method: ThreadToolName,
    params: Record<string, unknown>,
    execution: ThreadToolExecutionContext,
    signal?: AbortSignal
  ): Promise<unknown> {
    const response = await this.request(
      {
        method: method.replace('.', '/') as AgentAppRequest['method'],
        params: params as JsonObject,
      },
      { ...execution, signal }
    );
    if (!response.ok) {
      throw new ThreadToolError(
        response.error.code === 'RESOURCE_EXHAUSTED' ? 'RESOURCE_EXHAUSTED' : 'FORBIDDEN',
        response.error.message
      );
    }
    return response.result;
  }
}

function toolDefinition(name: ThreadToolName, required: readonly string[]) {
  return {
    type: 'function' as const,
    function: {
      name,
      description: `Coordinate project threads through ${name}.`,
      parameters: {
        type: 'object' as const,
        properties: {
          threadId: { type: 'string' as const },
          threadIds: { type: 'array' as const, items: { type: 'string' as const } },
          content: { type: 'string' as const },
          objective: { type: 'string' as const },
          idempotencyKey: { type: 'string' as const },
          mode: { type: 'string' as const, enum: ['any', 'all'] },
          interrupt: { type: 'boolean' as const },
        },
        required,
        additionalProperties: false,
      },
    },
  };
}

function isThreadTool(name: string): name is ThreadToolName {
  return threadToolDefinitions.some((definition) => definition.function.name === name);
}

function objectInput(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ThreadToolError('INVALID_INPUT', 'Tool input must be an object');
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ThreadToolError('INVALID_INPUT', `${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean')
    throw new ThreadToolError('INVALID_INPUT', `${label} must be boolean`);
  return value;
}

function requiredStringArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string') ||
    new Set(value).size !== value.length
  ) {
    throw new ThreadToolError('INVALID_INPUT', `${label} must be a non-empty string array`);
  }
  return value;
}

function requiredMode(value: unknown): 'any' | 'all' {
  if (value === 'any' || value === 'all') return value;
  throw new ThreadToolError('INVALID_INPUT', 'mode must be any or all');
}
