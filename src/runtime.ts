import { randomUUID } from "node:crypto";

import type {
  AgentMessageItem,
  ApprovalDecision,
  ApprovalPolicy,
  CanonicalItem,
  FailureItem,
  ReasoningItem,
  SandboxMode,
  ToolCallItem,
  ToolResultItem,
  TurnAbortedItem,
  TurnCompletedItem,
  TurnStartedItem,
  UserInput,
  UserMessageItem,
} from "./item.js";
import type { ModelAdapter, ModelMessage, ModelTool } from "./model.js";
import type { Thread } from "./thread.js";
import {
  ToolEnvironment,
  toolProviderFromExecutor,
  type ApprovalHandler,
  type ToolExecutionResult,
  type ToolExecutor,
  type ToolPolicy,
} from "./tool.js";

export interface RuntimeConfiguration {
  cwd: string;
  providerProfileId: string;
  model: string;
  reasoningEffort: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
}

export type RuntimeEvent =
  | { type: "turn_started"; threadId: string; turnId: string }
  | {
      type: "item_started";
      threadId: string;
      turnId: string;
      itemId: string;
      itemType: CanonicalItem["type"];
    }
  | {
      type: "item_delta";
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | { type: "item_completed"; item: CanonicalItem }
  | {
      type: "token_usage";
      threadId: string;
      turnId: string;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      type: "turn_completed";
      threadId: string;
      turnId: string;
      status: "completed" | "failed" | "interrupted";
    };

export interface RunTurnOptions {
  thread: Thread;
  turnId?: string;
  input: UserInput;
  clientId?: string;
  configuration: RuntimeConfiguration;
  modelAdapter: ModelAdapter;
  signal: AbortSignal;
  commit: (item: CanonicalItem) => Promise<void>;
  prepareModelSample: (modelResponseId: string) => Promise<ModelMessage[]>;
  commitFinal: (
    message: AgentMessageItem,
    modelResponseId: string,
  ) => Promise<boolean>;
  emit: (event: RuntimeEvent) => void;
  initialInputCommitted?: () => void;
  requestApproval?: ApprovalHandler;
}

export type ToolDefinitionProjection = (
  items: readonly CanonicalItem[],
) => readonly ModelTool[];

export class AgentRuntime {
  readonly #tools: ToolEnvironment;
  readonly #id: () => string;
  readonly #now: () => string;
  readonly #maxToolRounds: number;
  readonly #toolDefinitionProjection: ToolDefinitionProjection | undefined;

  constructor(options: {
    tools?: ToolExecutor;
    toolEnvironment?: ToolEnvironment;
    idFactory?: () => string;
    now?: () => string;
    maxToolRounds?: number;
    toolDefinitionProjection?: ToolDefinitionProjection;
  }) {
    if (options.tools !== undefined && options.toolEnvironment !== undefined) {
      throw new Error("Provide tools or toolEnvironment, not both");
    }
    if (options.toolEnvironment !== undefined) {
      this.#tools = options.toolEnvironment;
    } else if (options.tools !== undefined) {
      this.#tools = new ToolEnvironment({
        providers: [toolProviderFromExecutor(options.tools)],
      });
    } else {
      throw new Error("AgentRuntime requires a Tool Environment");
    }
    this.#id = options.idFactory ?? randomUUID;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#maxToolRounds = options.maxToolRounds ?? 8;
    this.#toolDefinitionProjection = options.toolDefinitionProjection;
  }

  async runTurn(options: RunTurnOptions): Promise<void> {
    const turnId = options.turnId ?? this.#id();
    const started: TurnStartedItem = {
      id: this.#id(),
      threadId: options.thread.id,
      turnId,
      createdAt: this.#now(),
      type: "turn_started",
      selection: {
        providerProfileId: options.configuration.providerProfileId,
        modelId: options.configuration.model,
        reasoningEffort: options.configuration.reasoningEffort,
      },
    };
    await options.commit(started);
    options.emit({ type: "turn_started", threadId: options.thread.id, turnId });

    let initialInputCommitted = false;
    try {
      this.#assertSandbox(options.configuration.sandbox);
      const userItem: UserMessageItem = {
        id: this.#id(),
        threadId: options.thread.id,
        turnId,
        createdAt: this.#now(),
        type: "user_message",
        content: options.input,
        ...(options.clientId === undefined
          ? {}
          : { clientId: options.clientId }),
      };
      await this.#completeItem(userItem, options);
      initialInputCommitted = true;
      options.initialInputCommitted?.();

      for (let round = 0; ; round += 1) {
        options.signal.throwIfAborted();
        const result = await this.#runModel(turnId, options);
        if (result.toolCalls.length === 0) {
          const agentItem: AgentMessageItem = {
            id: result.itemId,
            threadId: options.thread.id,
            turnId,
            createdAt: this.#now(),
            type: "agent_message",
            text: result.text,
          };
          const terminal = await options.commitFinal(agentItem, result.itemId);
          options.emit({ type: "item_completed", item: agentItem });
          if (!terminal) {
            continue;
          }
          options.emit({
            type: "turn_completed",
            threadId: options.thread.id,
            turnId,
            status: "completed",
          });
          return;
        }
        if (round >= this.#maxToolRounds) {
          throw new Error(
            `Model exceeded ${String(this.#maxToolRounds)} tool rounds`,
          );
        }

        if (result.text.length > 0) {
          const preToolMessage: AgentMessageItem = {
            id: result.itemId,
            threadId: options.thread.id,
            turnId,
            createdAt: this.#now(),
            type: "agent_message",
            text: result.text,
          };
          await options.commit(preToolMessage);
          options.emit({ type: "item_completed", item: preToolMessage });
        }

        const toolCallItems: ToolCallItem[] = [];
        for (const toolCall of result.toolCalls) {
          const toolCallItem: ToolCallItem = {
            id: this.#id(),
            threadId: options.thread.id,
            turnId,
            createdAt: this.#now(),
            type: "tool_call",
            callId: toolCall.callId,
            modelResponseId: result.itemId,
            name: toolCall.name,
            arguments: toolCall.arguments,
          };
          await this.#completeItem(toolCallItem, options);
          toolCallItems.push(toolCallItem);
        }
        for (let index = 0; index < toolCallItems.length; index += 1) {
          const toolCallItem = toolCallItems[index];
          if (toolCallItem === undefined) {
            continue;
          }
          try {
            await this.#runTool(turnId, toolCallItem, options);
          } catch (error) {
            for (const abandoned of toolCallItems.slice(index + 1)) {
              await this.#completeToolResult(
                abandoned,
                {
                  output:
                    "Tool call was abandoned because another call in the same model response did not complete.",
                  exitCode: 125,
                },
                options,
              );
            }
            throw error;
          }
        }
      }
    } catch (error) {
      if (!initialInputCommitted) throw error;
      if (
        options.thread.items.some(
          (item) =>
            item.type === "turn_completed" &&
            item.turnId === turnId &&
            item.status === "completed",
        )
      ) {
        throw error;
      }
      if (options.signal.aborted || isAbortError(error)) {
        const interruption: TurnAbortedItem = {
          id: this.#id(),
          threadId: options.thread.id,
          turnId,
          createdAt: this.#now(),
          type: "turn_aborted",
          reason: describeError(options.signal.reason ?? error),
        };
        await options.commit(interruption);
        options.emit({
          type: "turn_completed",
          threadId: options.thread.id,
          turnId,
          status: "interrupted",
        });
        return;
      }

      const failure: FailureItem = {
        id: this.#id(),
        threadId: options.thread.id,
        turnId,
        createdAt: this.#now(),
        type: "failure",
        code:
          error instanceof UnsupportedSandboxError
            ? "unsupported_sandbox"
            : "runtime_error",
        message: describeError(error),
      };
      await this.#completeItem(failure, options);
      const completed: TurnCompletedItem = {
        id: this.#id(),
        threadId: options.thread.id,
        turnId,
        createdAt: this.#now(),
        type: "turn_completed",
        status: "failed",
      };
      await options.commit(completed);
      options.emit({
        type: "turn_completed",
        threadId: options.thread.id,
        turnId,
        status: "failed",
      });
    }
  }

  async #runModel(
    turnId: string,
    options: RunTurnOptions,
  ): Promise<{
    itemId: string;
    text: string;
    toolCalls: Array<{
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
    }>;
  }> {
    const itemId = this.#id();
    let started = false;
    let text = "";
    const toolCalls: Array<{
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
    }> = [];

    const messages = await options.prepareModelSample(itemId);

    for await (const event of options.modelAdapter.stream({
      model: options.configuration.model,
      reasoningEffort: options.configuration.reasoningEffort,
      messages,
      tools: (
        this.#toolDefinitionProjection?.(options.thread.items) ??
        this.#tools.definitions
      ).map((definition) => structuredClone(definition)),
      signal: options.signal,
      sessionId: options.thread.id,
    })) {
      if (event.type === "text_delta") {
        if (!started) {
          started = true;
          options.emit({
            type: "item_started",
            threadId: options.thread.id,
            turnId,
            itemId,
            itemType: "agent_message",
          });
        }
        text += event.delta;
        options.emit({
          type: "item_delta",
          threadId: options.thread.id,
          turnId,
          itemId,
          delta: event.delta,
        });
      } else if (event.type === "reasoning") {
        const reasoning: ReasoningItem = {
          id: this.#id(),
          threadId: options.thread.id,
          turnId,
          createdAt: this.#now(),
          type: "reasoning",
          reasoningContent: event.reasoningContent,
          contentVisibility: event.contentVisibility,
          ...(event.summary === undefined ? {} : { summary: event.summary }),
          ...(event.providerItemId === undefined
            ? {}
            : { providerItemId: event.providerItemId }),
        };
        await this.#completeItem(reasoning, options);
      } else if (event.type === "tool_call") {
        toolCalls.push({
          callId: event.callId,
          name: event.name,
          arguments: event.arguments,
        });
      } else {
        options.emit({
          type: "token_usage",
          threadId: options.thread.id,
          turnId,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        });
      }
    }

    if (!started && toolCalls.length === 0) {
      options.emit({
        type: "item_started",
        threadId: options.thread.id,
        turnId,
        itemId,
        itemType: "agent_message",
      });
    }
    return { itemId, text, toolCalls };
  }

  async #runTool(
    turnId: string,
    toolCall: ToolCallItem,
    options: RunTurnOptions,
  ): Promise<void> {
    let prepared;
    try {
      prepared = this.#tools.prepare({
        callId: toolCall.callId,
        name: toolCall.name,
        arguments: toolCall.arguments,
        cwd: options.configuration.cwd,
        signal: options.signal,
      });
    } catch (error) {
      await this.#completeToolResult(
        toolCall,
        {
          output: `Tool preparation failed: ${describeError(error)}`,
          exitCode: options.signal.aborted || isAbortError(error) ? 130 : 1,
        },
        options,
      );
      throw error;
    }

    let decision: ApprovalDecision;
    try {
      decision = await waitForAbort(
        this.#tools.admit(prepared, {
          policy: toolPolicyFromApprovalPolicy(
            options.configuration.approvalPolicy,
          ),
          approvalRequest: {
            threadId: options.thread.id,
            turnId,
            itemId: toolCall.id,
            callId: toolCall.callId,
            command: readCommand(toolCall),
            cwd: options.configuration.cwd,
            signal: options.signal,
          },
          ...(options.requestApproval === undefined
            ? {}
            : { requestApproval: options.requestApproval }),
        }),
        options.signal,
      );
    } catch (error) {
      await this.#completeToolResult(
        toolCall,
        {
          output: `Tool approval did not complete: ${describeError(error)}`,
          exitCode: options.signal.aborted || isAbortError(error) ? 130 : 1,
        },
        options,
      );
      throw error;
    }

    if (decision === "cancel") {
      await this.#completeToolResult(
        toolCall,
        { output: "User cancelled this tool call.", exitCode: 130 },
        options,
      );
      throw new DOMException("Cancelled by user", "AbortError");
    }

    let result: ToolExecutionResult;
    if (decision === "decline") {
      result = { output: "User declined this tool call.", exitCode: 126 };
    } else {
      try {
        result = await this.#tools.execute(prepared);
      } catch (error) {
        const interrupted = options.signal.aborted || isAbortError(error);
        await this.#completeToolResult(
          toolCall,
          {
            output: `Tool execution failed: ${describeError(error)}`,
            exitCode: interrupted ? 130 : 1,
          },
          options,
        );
        throw error;
      }
    }

    await this.#completeToolResult(toolCall, result, options);
  }

  async #completeToolResult(
    toolCall: ToolCallItem,
    result: ToolExecutionResult,
    options: RunTurnOptions,
  ): Promise<void> {
    const resultItem: ToolResultItem = {
      id: this.#id(),
      threadId: options.thread.id,
      turnId: toolCall.turnId,
      createdAt: this.#now(),
      type: "tool_result",
      callId: toolCall.callId,
      output: result.output,
      exitCode: result.exitCode,
      ...(result.contentType === undefined
        ? {}
        : {
            contentType: result.contentType,
            structuredContent: result.structuredContent,
          }),
    };
    await this.#completeItem(resultItem, options);
  }

  async #completeItem(
    item: CanonicalItem,
    options: RunTurnOptions,
  ): Promise<void> {
    if (item.turnId !== undefined) {
      options.emit({
        type: "item_started",
        threadId: item.threadId,
        turnId: item.turnId,
        itemId: item.id,
        itemType: item.type,
      });
    }
    await options.commit(item);
    options.emit({ type: "item_completed", item });
  }

  #assertSandbox(sandbox: string): asserts sandbox is SandboxMode {
    if (sandbox !== "danger-full-access") {
      throw new UnsupportedSandboxError(sandbox);
    }
  }
}

function toolPolicyFromApprovalPolicy(policy: ApprovalPolicy): ToolPolicy {
  return policy === "never" ? "full_access" : "ask_unknown";
}

export class UnsupportedSandboxError extends Error {
  constructor(sandbox: string) {
    super(`Unsupported sandbox mode: ${sandbox}`);
    this.name = "UnsupportedSandboxError";
  }
}

function readCommand(toolCall: {
  name: string;
  arguments: Record<string, unknown>;
}): string {
  if (
    toolCall.name === "shell" &&
    typeof toolCall.arguments.command === "string"
  ) {
    return toolCall.arguments.command;
  }
  return `${toolCall.name} ${JSON.stringify(toolCall.arguments)}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      cleanup();
      reject(
        signal.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", abort);
    };

    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
