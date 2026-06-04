import { ContextCompiler, type ModelContext } from "./context-compiler.js";
import { HookRuntime, type HookHandlers } from "./hook-runtime.js";
import type { Item, ItemAppendInput, ItemList } from "./item-list.js";
import {
  appendModelResponseItems,
  type ModelGateway,
  type ModelOptions
} from "./model-gateway.js";
import {
  appendToolExecutionItems,
  type ToolRuntime
} from "./tool-runtime.js";

export type AgentLoopOptions = {
  readonly itemList: ItemList;
  readonly model: ModelGateway;
  readonly toolRuntime?: ToolRuntime;
  readonly contextCompiler?: ContextCompiler;
  readonly hooks?: HookHandlers;
};

export type AgentRunInput = {
  readonly input: unknown;
  readonly runId: string;
  readonly turnId: string;
  readonly modelOptions?: ModelOptions;
  readonly signal?: AbortSignal;
};

export type AgentRunResult = {
  readonly items: readonly Item[];
  readonly finalContext: ModelContext;
};

export class AgentLoop {
  private readonly itemList: ItemList;
  private readonly model: ModelGateway;
  private readonly toolRuntime?: ToolRuntime;
  private readonly contextCompiler: ContextCompiler;
  private readonly hookRuntime?: HookRuntime;

  constructor(options: AgentLoopOptions) {
    this.itemList = options.itemList;
    this.model = options.model;
    this.toolRuntime = options.toolRuntime;
    this.contextCompiler = options.contextCompiler ?? new ContextCompiler();
    this.hookRuntime = options.hooks
      ? new HookRuntime({ itemList: options.itemList, hooks: options.hooks })
      : undefined;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    await this.append({
      type: "run.started",
      runId: input.runId,
      turnId: input.turnId,
      visibility: "trace",
      payload: {}
    });
    await this.append({
      type: "turn.started",
      runId: input.runId,
      turnId: input.turnId,
      visibility: "trace",
      payload: {}
    });
    await this.append({
      type: "user.message.completed",
      runId: input.runId,
      turnId: input.turnId,
      payload: { content: input.input }
    });

    let shouldContinue = true;

    while (shouldContinue) {
      throwIfAborted(input.signal);
      const context = this.contextCompiler.compile(this.itemList.getItems());
      const modelItems = await appendModelResponseItems({
        itemList: this.itemList,
        appendItem: (item) => this.append(item),
        model: this.model,
        context,
        options: input.modelOptions,
        signal: input.signal,
        runId: input.runId,
        turnId: input.turnId
      });

      if (
        !modelItems.completed ||
        !this.toolRuntime ||
        !hasToolCalls(modelItems.completed)
      ) {
        shouldContinue = false;
        continue;
      }

      await appendToolExecutionItems({
        itemList: this.itemList,
        appendItem: (item) => this.append(item),
        toolRuntime: this.toolRuntime,
        assistantItem: modelItems.completed,
        hookRuntime: this.hookRuntime,
        signal: input.signal
      });
    }

    throwIfAborted(input.signal);
    await this.append({
      type: "turn.completed",
      runId: input.runId,
      turnId: input.turnId,
      visibility: "trace",
      payload: { status: "completed" }
    });
    await this.append({
      type: "run.completed",
      runId: input.runId,
      turnId: input.turnId,
      visibility: "trace",
      payload: { status: "completed" }
    });

    const items = this.itemList.getItems();

    return {
      items,
      finalContext: this.contextCompiler.compile(items)
    };
  }

  private async append(input: ItemAppendInput): Promise<Item | undefined> {
    if (this.hookRuntime) {
      return this.hookRuntime.append(input);
    }

    return this.itemList.append(input);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Turn interrupted");
  }
}

function hasToolCalls(item: Item): boolean {
  const payload = item.payload;

  return (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { readonly toolCalls?: unknown }).toolCalls) &&
    (payload as { readonly toolCalls: readonly unknown[] }).toolCalls.length > 0
  );
}
