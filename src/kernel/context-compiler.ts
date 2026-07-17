import type { Item } from './item-list.js';

export type ModelMessageRole = 'system' | 'user' | 'assistant';

export type ModelMessagePart = {
  readonly type: 'message';
  readonly role: ModelMessageRole;
  readonly content: unknown;
  readonly toolCalls?: readonly Readonly<{
    readonly id: string;
    readonly name: string;
    readonly input?: unknown;
  }>[];
};

export type ModelToolResultPart = {
  readonly type: 'toolResult';
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly content: unknown;
};

export type ModelContextPart = ModelMessagePart | ModelToolResultPart;

export type ModelContext = {
  readonly parts: readonly ModelContextPart[];
};

export class ContextCompiler {
  compile(items: readonly Item[]): ModelContext {
    const sortedItems = [...items].sort((left, right) => left.seq - right.seq);
    const systemPart = latestSystemMessagePart(sortedItems);
    const parts = sortedItems.flatMap((item): ModelContextPart[] => {
      if (!isModelVisible(item)) {
        return [];
      }

      if (item.type === 'user.message.completed') {
        return [toMessagePart('user', item)];
      }

      if (item.type === 'system.message.completed') {
        return [];
      }

      if (item.type === 'assistant.message.completed') {
        return [toMessagePart('assistant', item)];
      }

      if (item.type === 'tool.result.completed') {
        return toToolResultPart(item);
      }

      return [];
    });

    return { parts: systemPart ? [systemPart, ...parts] : parts };
  }
}

function latestSystemMessagePart(items: readonly Item[]): ModelMessagePart | undefined {
  const latest = [...items]
    .reverse()
    .find((item) => item.type === 'system.message.completed' && isModelVisible(item));

  return latest ? toMessagePart('system', latest) : undefined;
}

function toMessagePart(role: ModelMessageRole, item: Item): ModelMessagePart {
  const part: ModelMessagePart = {
    type: 'message',
    role,
    content: readContent(item.payload),
  };
  const toolCalls = readToolCalls(item.payload);

  return toolCalls.length > 0 ? { ...part, toolCalls } : part;
}

function toToolResultPart(item: Item): ModelToolResultPart[] {
  const payload = isRecord(item.payload) ? item.payload : {};
  const linkedToolCallId = readString(payload.toolCallId) ?? item.targetId ?? item.causeId;

  if (!linkedToolCallId) {
    return [];
  }

  const toolResult: ModelToolResultPart = {
    type: 'toolResult',
    toolCallId: linkedToolCallId,
    content: readContent(item.payload),
  };
  const toolName = readString(payload.toolName);

  if (toolName) {
    return [{ ...toolResult, toolName }];
  }

  return [toolResult];
}

function readContent(payload: unknown): unknown {
  if (isRecord(payload) && 'content' in payload) {
    return payload.content;
  }

  return payload;
}

function readToolCalls(
  payload: unknown
): readonly Readonly<{ id: string; name: string; input?: unknown }>[] {
  if (!isRecord(payload) || !Array.isArray(payload.toolCalls)) {
    return [];
  }

  return payload.toolCalls.flatMap((call) => {
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isModelVisible(item: Item): boolean {
  return item.visibility === undefined || item.visibility === 'model';
}
