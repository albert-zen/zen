import type {
  ToolCallPayload,
  ToolExecutionContext,
  ToolRuntime,
  ToolRuntimeEvent,
} from '../kernel/index.js';
import { AgentScheduler } from './agent-scheduler.js';
import { ProjectCoordinator } from './project-coordinator.js';

export type ThreadCapability =
  | 'createChildThread'
  | 'messageChild'
  | 'messagePeer'
  | 'interruptPeer'
  | 'cancelThread'
  | 'archiveThread'
  | 'handoffThread'
  | 'readProjectThreads';

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
  readonly capabilities: ReadonlySet<ThreadCapability>;
};

export type ThreadToolRuntimeOptions = {
  readonly coordinator: ProjectCoordinator;
  readonly scheduler: AgentScheduler;
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
  toolDefinition('thread.wait', ['threadIds', 'mode']),
  toolDefinition('thread.cancel', ['threadId', 'idempotencyKey']),
  toolDefinition('thread.archive', ['threadId', 'idempotencyKey']),
  toolDefinition('thread.handoff', ['threadId', 'content', 'idempotencyKey']),
] as const;

export class ThreadToolRuntime implements ToolRuntime {
  private readonly coordinator: ProjectCoordinator;
  private readonly scheduler: AgentScheduler;
  private readonly resolveExecutionContext: ThreadToolRuntimeOptions['resolveExecutionContext'];
  private readonly fallback?: ToolRuntime;

  constructor(options: ThreadToolRuntimeOptions) {
    this.coordinator = options.coordinator;
    this.scheduler = options.scheduler;
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
      requireCapability(execution, call.name, objectInput(call.input), this.coordinator);
      const result = await this.dispatch(
        call.name,
        objectInput(call.input),
        execution,
        context.signal
      );
      yield { type: 'result.completed', content: result };
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
    if (name === 'thread.create') {
      return await this.coordinator.createThread({
        projectId: execution.projectId,
        sourceThreadId: execution.sourceThreadId,
        objective: optionalString(input.objective, 'objective'),
        idempotencyKey: requiredString(input.idempotencyKey, 'idempotencyKey'),
      });
    }
    if (name === 'thread.list') return this.coordinator.listThreadSummaries(execution.projectId);
    if (name === 'thread.read') {
      const snapshot = this.coordinator.readThread(
        execution.projectId,
        requiredString(input.threadId, 'threadId')
      );
      return {
        id: snapshot.id,
        status: snapshot.status,
        turns: snapshot.turns.map((turn) => ({ id: turn.id, status: turn.status })),
      };
    }
    if (name === 'thread.send') {
      return await this.coordinator.sendMessage({
        projectId: execution.projectId,
        sourceThreadId: execution.sourceThreadId,
        targetThreadId: requiredString(input.threadId, 'threadId'),
        content: requiredString(input.content, 'content'),
        idempotencyKey: requiredString(input.idempotencyKey, 'idempotencyKey'),
        interrupt: optionalBoolean(input.interrupt, 'interrupt') ?? false,
      });
    }
    if (name === 'thread.wait') {
      await this.coordinator.assertWaitWithinLimit(
        execution.projectId,
        requiredStringArray(input.threadIds, 'threadIds')
      );
      return await this.scheduler.waitFor({
        projectId: execution.projectId,
        threadId: execution.sourceThreadId,
        targets: requiredStringArray(input.threadIds, 'threadIds'),
        mode: requiredMode(input.mode),
        signal,
      });
    }
    if (name === 'thread.cancel') {
      await this.coordinator.cancelThread({
        projectId: execution.projectId,
        threadId: requiredString(input.threadId, 'threadId'),
        idempotencyKey: requiredString(input.idempotencyKey, 'idempotencyKey'),
      });
      return { ok: true };
    }
    if (name === 'thread.archive') {
      await this.coordinator.archiveThread({
        projectId: execution.projectId,
        threadId: requiredString(input.threadId, 'threadId'),
        idempotencyKey: requiredString(input.idempotencyKey, 'idempotencyKey'),
      });
      return { ok: true };
    }
    return await this.coordinator.handoff({
      projectId: execution.projectId,
      sourceThreadId: execution.sourceThreadId,
      targetThreadId: requiredString(input.threadId, 'threadId'),
      content: requiredString(input.content, 'content'),
      idempotencyKey: requiredString(input.idempotencyKey, 'idempotencyKey'),
    });
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

function requireCapability(
  context: ThreadToolExecutionContext,
  tool: string,
  input: Readonly<Record<string, unknown>>,
  coordinator: ProjectCoordinator
): void {
  const capability = capabilityForTool(context, tool, input, coordinator);
  if (!context.capabilities.has(capability)) {
    throw new ThreadToolError('FORBIDDEN', `Capability denied: ${capability}`);
  }
}

function capabilityForTool(
  context: ThreadToolExecutionContext,
  tool: string,
  input: Readonly<Record<string, unknown>>,
  coordinator: ProjectCoordinator
): ThreadCapability {
  if (tool === 'thread.create') return 'createChildThread';
  if (tool === 'thread.list' || tool === 'thread.read') return 'readProjectThreads';
  if (tool === 'thread.wait') return 'readProjectThreads';
  if (tool === 'thread.cancel' || tool === 'thread.archive' || tool === 'thread.handoff') {
    const target = requiredString(input.threadId, 'threadId');
    if (target === context.sourceThreadId) {
      throw new ThreadToolError(
        'FORBIDDEN',
        'Agents cannot terminate or hand off their active thread'
      );
    }
    return tool === 'thread.cancel'
      ? 'cancelThread'
      : tool === 'thread.archive'
        ? 'archiveThread'
        : 'handoffThread';
  }
  const target = requiredString(input.threadId, 'threadId');
  const relation = coordinator.relation(context.projectId, context.sourceThreadId, target);
  if (relation === 'ancestor' || relation === 'self') {
    throw new ThreadToolError('FORBIDDEN', 'Agents cannot message themselves or ancestors');
  }
  if (input.interrupt === true) return 'interruptPeer';
  return relation === 'child' ? 'messageChild' : 'messagePeer';
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
