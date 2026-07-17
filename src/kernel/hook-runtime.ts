import type { Item, ItemAppendInput, ItemList } from './item-list.js';

export type ToolCallHookPayload = {
  readonly id: string;
  readonly name: string;
  readonly input?: unknown;
};

export type HookName =
  | 'onItemAppending'
  | 'onItemAppended'
  | 'beforeContextCompile'
  | 'afterContextCompile'
  | 'beforeModelRequest'
  | 'onModelEvent'
  | 'beforeToolCall'
  | 'afterToolResult'
  | 'onRunFinished';

export type ItemAppendingHookContext = {
  readonly hookName: 'onItemAppending';
  readonly item: ItemAppendInput;
  readonly items: readonly Item[];
};

export type ItemAppendedHookContext = {
  readonly hookName: 'onItemAppended';
  readonly item: Item;
  readonly items: readonly Item[];
};

export type BeforeToolCallHookContext = {
  readonly hookName: 'beforeToolCall';
  readonly call: ToolCallHookPayload;
  readonly assistantItem: Item;
  readonly items: readonly Item[];
};

export type HookBlockDecision = {
  readonly type: 'block';
  readonly reason?: string;
};

export type HookReplaceDecision = {
  readonly type: 'replace';
  readonly reason?: string;
  readonly item: ItemAppendInput;
};

export type HookToolCallReplaceDecision = {
  readonly type: 'replace';
  readonly reason?: string;
  readonly call: ToolCallHookPayload;
};

export type HookItemDecision = HookBlockDecision | HookReplaceDecision;

export type HookToolCallDecision = HookBlockDecision | HookToolCallReplaceDecision;

export type HookDecision = HookBlockDecision | HookReplaceDecision | HookToolCallReplaceDecision;

export type HookResponse<TDecision extends HookDecision = HookDecision> = {
  readonly append?: readonly ItemAppendInput[];
  readonly decision?: TDecision;
};

export type HookResult<TDecision extends HookDecision = HookDecision> =
  void | HookResponse<TDecision> | Promise<void | HookResponse<TDecision>>;

export type HookHandlers = {
  readonly onItemAppending?: (context: ItemAppendingHookContext) => HookResult<HookItemDecision>;
  readonly onItemAppended?: (context: ItemAppendedHookContext) => HookResult<never>;
  readonly beforeToolCall?: (
    context: BeforeToolCallHookContext
  ) => HookResult<HookToolCallDecision>;
};

export type HookRuntimeOptions = {
  readonly itemList: ItemList;
  readonly hooks?: HookHandlers;
};

export class HookRuntime {
  private readonly itemList: ItemList;
  private readonly hooks: HookHandlers;

  constructor(options: HookRuntimeOptions) {
    this.itemList = options.itemList;
    this.hooks = options.hooks ?? {};
  }

  async append(input: ItemAppendInput): Promise<Item | undefined> {
    let beforeAppendResult: Awaited<HookResult<HookItemDecision>>;

    try {
      beforeAppendResult = await this.hooks.onItemAppending?.({
        hookName: 'onItemAppending',
        item: cloneAppendInput(input),
        items: this.getHookItemsSnapshot(),
      });
    } catch (cause) {
      this.appendHookError('onItemAppending', input, cause);
      throw cause;
    }

    await this.appendHookItems(beforeAppendResult);

    if (beforeAppendResult?.decision) {
      this.appendHookEffect('onItemAppending', input, beforeAppendResult.decision);

      if (beforeAppendResult.decision.type === 'block') {
        return undefined;
      }

      return this.append(beforeAppendResult.decision.item);
    }

    const appended = this.itemList.append(input);

    try {
      await this.appendHookItems(
        await this.hooks.onItemAppended?.({
          hookName: 'onItemAppended',
          item: cloneItem(appended),
          items: this.getHookItemsSnapshot(),
        })
      );
    } catch (cause) {
      this.appendHookError('onItemAppended', appended, cause);
      throw cause;
    }

    return appended;
  }

  async beforeToolCall(input: {
    readonly call: ToolCallHookPayload;
    readonly assistantItem: Item;
  }): Promise<
    { readonly type: 'continue'; readonly call: ToolCallHookPayload } | { readonly type: 'block' }
  > {
    let result: Awaited<HookResult<HookToolCallDecision>>;

    try {
      result = await this.hooks.beforeToolCall?.({
        hookName: 'beforeToolCall',
        call: clonePlain(input.call),
        assistantItem: cloneItem(input.assistantItem),
        items: this.getHookItemsSnapshot(),
      });
    } catch (cause) {
      this.appendToolHookError(input.call, input.assistantItem, cause);
      throw cause;
    }

    await this.appendHookItems(result);

    if (!result?.decision) {
      return { type: 'continue', call: input.call };
    }

    this.appendToolHookEffect(input.call, input.assistantItem, result.decision);

    if (result.decision.type === 'block') {
      return { type: 'block' };
    }

    return { type: 'continue', call: result.decision.call };
  }

  private async appendHookItems(result: Awaited<HookResult>): Promise<void> {
    for (const item of result?.append ?? []) {
      await this.append(item);
    }
  }

  private appendHookEffect(
    hookName: HookName,
    input: ItemAppendInput,
    decision: HookItemDecision
  ): Item {
    const payload: Record<string, unknown> = {
      hook: hookName,
      effect: decision.type,
      itemType: input.type,
    };

    if (decision.reason) {
      payload.reason = decision.reason;
    }

    if (decision.type === 'replace') {
      payload.replacementType = decision.item.type;
    }

    return this.itemList.append({
      type: 'hook.effect',
      runId: input.runId,
      turnId: input.turnId,
      visibility: 'trace',
      payload,
    });
  }

  private appendToolHookEffect(
    call: ToolCallHookPayload,
    assistantItem: Item,
    decision: HookToolCallDecision
  ): Item {
    const payload: Record<string, unknown> = {
      hook: 'beforeToolCall',
      effect: decision.type,
      toolCallId: call.id,
      toolName: call.name,
    };

    if (decision.reason) {
      payload.reason = decision.reason;
    }

    if (decision.type === 'replace') {
      payload.replacementToolCallId = decision.call.id;
      payload.replacementToolName = decision.call.name;
    }

    return this.itemList.append({
      type: 'hook.effect',
      runId: assistantItem.runId,
      turnId: assistantItem.turnId,
      causeId: assistantItem.id,
      visibility: 'trace',
      payload,
    });
  }

  private appendHookError(hookName: HookName, input: ItemAppendInput, cause: unknown): Item {
    return this.itemList.append({
      type: 'hook.effect',
      runId: input.runId,
      turnId: input.turnId,
      visibility: 'trace',
      payload: {
        hook: hookName,
        effect: 'error',
        message: readErrorMessage(cause),
        cause: serializeErrorCause(cause),
        itemType: input.type,
      },
    });
  }

  private appendToolHookError(
    call: ToolCallHookPayload,
    assistantItem: Item,
    cause: unknown
  ): Item {
    return this.itemList.append({
      type: 'hook.effect',
      runId: assistantItem.runId,
      turnId: assistantItem.turnId,
      causeId: assistantItem.id,
      visibility: 'trace',
      payload: {
        hook: 'beforeToolCall',
        effect: 'error',
        message: readErrorMessage(cause),
        cause: serializeErrorCause(cause),
        toolCallId: call.id,
        toolName: call.name,
      },
    });
  }

  private getHookItemsSnapshot(): readonly Item[] {
    return this.itemList.getItems().map(cloneItem);
  }
}

function cloneAppendInput(input: ItemAppendInput): ItemAppendInput {
  return clonePlain(input) as ItemAppendInput;
}

function cloneItem(item: Item): Item {
  return clonePlain(item) as Item;
}

function clonePlain<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }

  if (value === undefined) {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as T;
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
