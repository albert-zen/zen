import type { ModelContext } from './context-compiler.js';
import type { Item, ItemAppendInput, ItemList } from './item-list.js';
import {
  consumeAbortableAsyncIterator,
  isAsyncIteratorAbortedError,
} from './abortable-async-iterator.js';
import { assertEffectPermitted } from './effect-permission.js';

export type ModelOptions = Readonly<Record<string, unknown>>;

export type ModelTextDeltaEvent = {
  readonly type: 'text.delta';
  readonly text: string;
};

export type ModelMessageCompletedEvent = {
  readonly type: 'message.completed';
  readonly content: unknown;
  /** Ephemeral authority for effects derived from this response; never persisted in Items. */
  readonly validitySignal?: AbortSignal;
  readonly toolCalls?: readonly Readonly<{
    readonly id: string;
    readonly name: string;
    readonly input?: unknown;
  }>[];
};

export type ModelErrorEvent = {
  readonly type: 'error';
  readonly error: unknown;
};

export type ModelEvent = ModelTextDeltaEvent | ModelMessageCompletedEvent | ModelErrorEvent;

export interface ModelGateway {
  generate(
    context: ModelContext,
    options?: ModelOptions,
    signal?: AbortSignal
  ): AsyncIterable<ModelEvent>;
}

export type AppendModelResponseItemsInput = {
  readonly itemList: ItemList;
  readonly appendItem?: ItemAppender;
  readonly model: ModelGateway;
  readonly context: ModelContext;
  readonly options?: ModelOptions;
  readonly signal?: AbortSignal;
  readonly runId: string;
  readonly turnId: string;
};

export type ItemAppender = (input: ItemAppendInput) => Item | undefined | Promise<Item | undefined>;

export type ModelResponseItems = {
  readonly requestStarted: Item;
  readonly assistantStarted: Item;
  readonly completed?: Item;
  readonly error?: Item;
  readonly requestCompleted: Item;
  readonly executionSignal?: AbortSignal;
};

export async function appendModelResponseItems(
  input: AppendModelResponseItemsInput
): Promise<ModelResponseItems> {
  const appendItem = createAppender(input);
  const requestStarted = await appendRequired(appendItem, {
    type: 'model.request.started',
    runId: input.runId,
    turnId: input.turnId,
    visibility: 'trace',
    payload: {
      options: input.options ?? {},
      contextPartCount: input.context.parts.length,
    },
  });
  const assistantStarted = await appendRequired(appendItem, {
    type: 'assistant.message.started',
    runId: input.runId,
    turnId: input.turnId,
    causeId: requestStarted.id,
    visibility: 'trace',
    payload: {},
  });
  let completed: Item | undefined;
  let error: Item | undefined;
  let deltaIndex = 0;
  let terminalSeen = false;
  let executionSignal: AbortSignal | undefined;

  try {
    assertEffectPermitted(input.signal);
    const events = input.model.generate(input.context, input.options, input.signal);
    await consumeAbortableAsyncIterator(events, input.signal, async (event) => {
      if (terminalSeen) {
        throw new Error('Model gateway emitted more than one terminal event');
      }

      if (event.type === 'text.delta') {
        await appendItem({
          type: 'assistant.message.delta',
          runId: input.runId,
          turnId: input.turnId,
          causeId: requestStarted.id,
          targetId: assistantStarted.id,
          visibility: 'trace',
          payload: { delta: event.text, index: deltaIndex++ },
        });
      }

      if (event.type === 'message.completed') {
        terminalSeen = true;
        executionSignal = event.validitySignal;
        const payload: Record<string, unknown> = { content: event.content };

        if (event.toolCalls) {
          payload.toolCalls = event.toolCalls;
        }

        completed = await appendRequired(appendItem, {
          type: 'assistant.message.completed',
          runId: input.runId,
          turnId: input.turnId,
          causeId: requestStarted.id,
          targetId: assistantStarted.id,
          payload,
        });
      }

      if (event.type === 'error') {
        terminalSeen = true;
        error = await appendAssistantError(
          appendItem,
          input,
          requestStarted,
          assistantStarted,
          event.error
        );
        return false;
      }
    });

    if (!terminalSeen) {
      error = await appendAssistantError(
        appendItem,
        input,
        requestStarted,
        assistantStarted,
        new Error('Model gateway stream ended without a terminal event')
      );
    }
  } catch (caughtError) {
    if (isAsyncIteratorAbortedError(caughtError)) throw caughtError;
    error = await appendAssistantError(
      appendItem,
      input,
      requestStarted,
      assistantStarted,
      caughtError
    );
  }

  const requestCompleted = await appendRequired(appendItem, {
    type: 'model.request.completed',
    runId: input.runId,
    turnId: input.turnId,
    causeId: requestStarted.id,
    targetId: error?.id ?? completed?.id ?? assistantStarted.id,
    visibility: 'trace',
    payload: { status: error ? 'error' : 'completed' },
  });

  return {
    requestStarted,
    assistantStarted,
    completed,
    error,
    requestCompleted,
    ...(executionSignal ? { executionSignal } : {}),
  };
}

async function appendAssistantError(
  appendItem: ItemAppender,
  input: AppendModelResponseItemsInput,
  requestStarted: Item,
  assistantStarted: Item,
  cause: unknown
): Promise<Item> {
  return appendRequired(appendItem, {
    type: 'assistant.message.error',
    runId: input.runId,
    turnId: input.turnId,
    causeId: requestStarted.id,
    targetId: assistantStarted.id,
    visibility: 'trace',
    payload: {
      message: readErrorMessage(cause),
      cause: serializeErrorCause(cause),
    },
  });
}

function createAppender(input: AppendModelResponseItemsInput): ItemAppender {
  return input.appendItem ?? ((item) => input.itemList.append(item));
}

async function appendRequired(appendItem: ItemAppender, item: ItemAppendInput): Promise<Item> {
  const appended = await appendItem(item);

  if (!appended) {
    throw new Error(`Required item append was blocked: ${item.type}`);
  }

  return appended;
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
