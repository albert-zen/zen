import type { Item, ItemList } from "./item-list.js";

export type ToolCallPayload = {
  readonly id: string;
  readonly name: string;
  readonly input?: unknown;
};

export type ToolOutputDeltaEvent = {
  readonly type: "output.delta";
  readonly delta: unknown;
};

export type ToolResultCompletedEvent = {
  readonly type: "result.completed";
  readonly content: unknown;
};

export type ToolErrorEvent = {
  readonly type: "error";
  readonly error: unknown;
};

export type ToolRuntimeEvent =
  | ToolOutputDeltaEvent
  | ToolResultCompletedEvent
  | ToolErrorEvent;

export type ToolExecutionContext = {
  readonly runId: string;
  readonly turnId: string;
  readonly assistantItem: Item;
  readonly startedItem: Item;
};

export interface ToolRuntime {
  execute(
    call: ToolCallPayload,
    context: ToolExecutionContext
  ): AsyncIterable<ToolRuntimeEvent>;
}

export type AppendToolExecutionItemsInput = {
  readonly itemList: ItemList;
  readonly toolRuntime: ToolRuntime;
  readonly assistantItem: Item;
};

export type ToolExecutionItems = {
  readonly started: readonly Item[];
  readonly completed: readonly Item[];
  readonly errors: readonly Item[];
};

export async function appendToolExecutionItems(
  input: AppendToolExecutionItemsInput
): Promise<ToolExecutionItems> {
  const started: Item[] = [];
  const completed: Item[] = [];
  const errors: Item[] = [];

  for (const call of readToolCalls(input.assistantItem.payload)) {
    const startedItem = input.itemList.append({
      type: "tool.call.started",
      runId: input.assistantItem.runId,
      turnId: input.assistantItem.turnId,
      causeId: input.assistantItem.id,
      visibility: "trace",
      payload: createToolCallPayload(call)
    });
    let deltaIndex = 0;

    started.push(startedItem);

    try {
      for await (const event of input.toolRuntime.execute(call, {
        runId: input.assistantItem.runId,
        turnId: input.assistantItem.turnId,
        assistantItem: input.assistantItem,
        startedItem
      })) {
        if (event.type === "output.delta") {
          input.itemList.append({
            type: "tool.output.delta",
            runId: input.assistantItem.runId,
            turnId: input.assistantItem.turnId,
            causeId: startedItem.id,
            targetId: startedItem.id,
            visibility: "trace",
            payload: {
              ...createToolCallPayload(call),
              delta: event.delta,
              index: deltaIndex++
            }
          });
        }

        if (event.type === "result.completed") {
          completed.push(
            input.itemList.append({
              type: "tool.result.completed",
              runId: input.assistantItem.runId,
              turnId: input.assistantItem.turnId,
              causeId: startedItem.id,
              targetId: startedItem.id,
              payload: {
                ...createToolCallPayload(call),
                content: event.content
              }
            })
          );
        }

        if (event.type === "error") {
          errors.push(appendToolError(input.itemList, startedItem, call, event.error));
          break;
        }
      }
    } catch (caughtError) {
      errors.push(appendToolError(input.itemList, startedItem, call, caughtError));
    }
  }

  return { started, completed, errors };
}

function appendToolError(
  itemList: ItemList,
  startedItem: Item,
  call: ToolCallPayload,
  cause: unknown
): Item {
  return itemList.append({
    type: "tool.error",
    runId: startedItem.runId,
    turnId: startedItem.turnId,
    causeId: startedItem.id,
    targetId: startedItem.id,
    visibility: "trace",
    payload: {
      ...createToolCallPayload(call),
      message: readErrorMessage(cause),
      cause: serializeErrorCause(cause)
    }
  });
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

function createToolCallPayload(
  call: ToolCallPayload
): Readonly<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    toolCallId: call.id,
    toolName: call.name
  };

  if ("input" in call) {
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
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
