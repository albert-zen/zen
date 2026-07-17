import type { HookRuntime } from './hook-runtime.js';
import type { Item, ItemAppendInput, ItemList } from './item-list.js';
import {
  consumeAbortableAsyncIterator,
  isAsyncIteratorAbortedError,
} from './abortable-async-iterator.js';

export type ToolCallPayload = {
  readonly id: string;
  readonly name: string;
  readonly input?: unknown;
};

export type ToolOutputDeltaEvent = {
  readonly type: 'output.delta';
  readonly delta: unknown;
};

export type ToolApprovalRequestedEvent = {
  readonly type: 'approval.requested';
  readonly request: {
    readonly id: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly runId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input?: unknown;
    readonly reason?: string;
  };
};

export type ToolApprovalResolvedEvent = {
  readonly type: 'approval.resolved';
  readonly request: ToolApprovalRequestedEvent['request'];
  readonly decision: {
    readonly type: 'approveOnce' | 'decline';
    readonly reason?: string;
  };
};

export type ToolResultCompletedEvent = {
  readonly type: 'result.completed';
  readonly content: unknown;
};

export type ToolErrorEvent = {
  readonly type: 'error';
  readonly error: unknown;
};

export type ToolRuntimeEvent =
  | ToolOutputDeltaEvent
  | ToolApprovalRequestedEvent
  | ToolApprovalResolvedEvent
  | ToolResultCompletedEvent
  | ToolErrorEvent;

export type ToolExecutionContext = {
  readonly threadId?: string;
  readonly runId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
  readonly assistantItem: Item;
  readonly startedItem: Item;
};

export interface ToolRuntime {
  execute(call: ToolCallPayload, context: ToolExecutionContext): AsyncIterable<ToolRuntimeEvent>;
}

export type AppendToolExecutionItemsInput = {
  readonly itemList: ItemList;
  readonly threadId?: string;
  readonly appendItem?: ItemAppender;
  readonly toolRuntime: ToolRuntime;
  readonly assistantItem: Item;
  readonly hookRuntime?: HookRuntime;
  readonly signal?: AbortSignal;
};

export type ItemAppender = (input: ItemAppendInput) => Item | undefined | Promise<Item | undefined>;

export type ToolExecutionItems = {
  readonly started: readonly Item[];
  readonly completed: readonly Item[];
  readonly errors: readonly Item[];
};

export async function appendToolExecutionItems(
  input: AppendToolExecutionItemsInput
): Promise<ToolExecutionItems> {
  const appendItem = createAppender(input);
  const started: Item[] = [];
  const completed: Item[] = [];
  const errors: Item[] = [];

  for (const requestedCall of readToolCalls(input.assistantItem.payload)) {
    if (input.signal?.aborted) {
      break;
    }

    const hookDecision = await input.hookRuntime?.beforeToolCall({
      call: requestedCall,
      assistantItem: input.assistantItem,
    });

    if (hookDecision?.type === 'block') {
      continue;
    }

    const call = hookDecision?.call ?? requestedCall;
    const startedItem = await appendRequired(appendItem, {
      type: 'tool.call.started',
      runId: input.assistantItem.runId,
      turnId: input.assistantItem.turnId,
      causeId: input.assistantItem.id,
      visibility: 'trace',
      payload: createToolCallPayload(call),
    });
    let deltaIndex = 0;

    started.push(startedItem);

    try {
      await consumeAbortableAsyncIterator(
        input.toolRuntime.execute(call, {
          threadId: input.threadId ?? '',
          runId: input.assistantItem.runId,
          turnId: input.assistantItem.turnId,
          signal: input.signal,
          assistantItem: input.assistantItem,
          startedItem,
        }),
        input.signal,
        async (event) => {
          if (event.type === 'approval.requested') {
            await appendRequired(appendItem, {
              type: 'approval.requested',
              runId: input.assistantItem.runId,
              turnId: input.assistantItem.turnId,
              causeId: startedItem.id,
              targetId: startedItem.id,
              visibility: 'trace',
              payload: approvalRequestPayload(event.request),
            });
          }

          if (event.type === 'approval.resolved') {
            await appendRequired(appendItem, {
              type: 'approval.resolved',
              runId: input.assistantItem.runId,
              turnId: input.assistantItem.turnId,
              causeId: startedItem.id,
              targetId: startedItem.id,
              visibility: 'trace',
              payload: {
                ...approvalRequestPayload(event.request),
                decision: event.decision.type,
                ...(event.decision.reason === undefined ? {} : { reason: event.decision.reason }),
              },
            });
          }

          if (event.type === 'output.delta') {
            await appendItem({
              type: 'tool.output.delta',
              runId: input.assistantItem.runId,
              turnId: input.assistantItem.turnId,
              causeId: startedItem.id,
              targetId: startedItem.id,
              visibility: 'trace',
              payload: {
                ...createToolCallPayload(call),
                delta: event.delta,
                index: deltaIndex++,
              },
            });
          }

          if (event.type === 'result.completed') {
            completed.push(
              await appendRequired(appendItem, {
                type: 'tool.result.completed',
                runId: input.assistantItem.runId,
                turnId: input.assistantItem.turnId,
                causeId: startedItem.id,
                targetId: startedItem.id,
                payload: {
                  ...createToolCallPayload(call),
                  content: event.content,
                },
              })
            );
          }

          if (event.type === 'error') {
            errors.push(await appendToolError(appendItem, startedItem, call, event.error));
            return false;
          }
        }
      );
    } catch (caughtError) {
      if (isAsyncIteratorAbortedError(caughtError)) throw caughtError;
      errors.push(await appendToolError(appendItem, startedItem, call, caughtError));
    }

    if (input.signal?.aborted) {
      break;
    }
  }

  return { started, completed, errors };
}

function approvalRequestPayload(
  request: ToolApprovalRequestedEvent['request']
): Readonly<Record<string, unknown>> {
  return {
    approvalId: request.id,
    threadId: request.threadId,
    turnId: request.turnId,
    runId: request.runId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    ...(request.input === undefined ? {} : { input: request.input }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  };
}

function appendToolError(
  appendItem: ItemAppender,
  startedItem: Item,
  call: ToolCallPayload,
  cause: unknown
): Promise<Item> {
  return appendRequired(appendItem, {
    type: 'tool.error',
    runId: startedItem.runId,
    turnId: startedItem.turnId,
    causeId: startedItem.id,
    targetId: startedItem.id,
    visibility: 'trace',
    payload: {
      ...createToolCallPayload(call),
      message: readErrorMessage(cause),
      cause: serializeErrorCause(cause),
    },
  });
}

function createAppender(input: AppendToolExecutionItemsInput): ItemAppender {
  return input.appendItem ?? ((item) => input.itemList.append(item));
}

async function appendRequired(appendItem: ItemAppender, item: ItemAppendInput): Promise<Item> {
  const appended = await appendItem(item);

  if (!appended) {
    throw new Error(`Required item append was blocked: ${item.type}`);
  }

  return appended;
}

function readToolCalls(payload: unknown): readonly ToolCallPayload[] {
  if (!isRecord(payload) || !Array.isArray(payload.toolCalls)) {
    return [];
  }

  return payload.toolCalls.flatMap((call): ToolCallPayload[] => {
    if (!isRecord(call)) {
      return [];
    }

    const id = readString(call.id);
    const name = readString(call.name);

    if (!id || !name) {
      return [];
    }

    return [{ id, name, input: call.input }];
  });
}

function createToolCallPayload(call: ToolCallPayload): Readonly<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    toolCallId: call.id,
    toolName: call.name,
  };

  if ('input' in call) {
    payload.input = call.input;
  }

  return payload;
}

function readErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function serializeErrorCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }

  return cause;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
