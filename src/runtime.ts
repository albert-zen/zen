import { randomUUID } from "node:crypto";

import type {
  AgentMessageItem,
  ApprovalDecision,
  ApprovalPolicy,
  CanonicalItem,
  FailureItem,
  ModelUsageItem,
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
import {
  buildToolPresentation,
  type ToolPresentation,
  type ToolPresentationSnapshot,
} from "./tool-presentation.js";
import type { Thread } from "./thread.js";
import { renderToolOutput, type ToolOutputSpool } from "./tool-output-spool.js";
import {
  ToolEnvironment,
  ToolResultNormalizationError,
  UnawaitedNestedToolCallError,
  capturedToolOutput,
  toolProviderFromExecutor,
  type ApprovalHandler,
  type NestedToolObservation,
  type ToolExecutionMode,
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
  | {
      type: "reasoning_summary_delta";
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "reasoning_content_delta";
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
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
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

export const DEFAULT_MAX_CONCURRENT_TOOL_BODIES = 8;

export class AgentRuntime {
  readonly #tools: ToolEnvironment;
  readonly #id: () => string;
  readonly #now: () => string;
  readonly #maxToolRounds: number | undefined;
  readonly #toolDefinitionProjection: ToolDefinitionProjection | undefined;
  readonly #toolPresentation: ToolPresentation | undefined;
  readonly #toolOutputSpool: ToolOutputSpool | undefined;
  readonly #maxConcurrentToolBodies: number;

  constructor(options: {
    tools?: ToolExecutor;
    toolEnvironment?: ToolEnvironment;
    idFactory?: () => string;
    now?: () => string;
    maxToolRounds?: number;
    toolDefinitionProjection?: ToolDefinitionProjection;
    toolPresentation?: ToolPresentation;
    toolOutputSpool?: ToolOutputSpool;
    maxConcurrentToolBodies?: number;
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
    if (
      options.maxToolRounds !== undefined &&
      (!Number.isSafeInteger(options.maxToolRounds) ||
        options.maxToolRounds < 1)
    ) {
      throw new Error("Maximum tool rounds must be a positive safe integer");
    }
    this.#maxToolRounds = options.maxToolRounds;
    this.#toolDefinitionProjection = options.toolDefinitionProjection;
    this.#toolPresentation = options.toolPresentation;
    this.#toolOutputSpool = options.toolOutputSpool;
    const maxConcurrentToolBodies =
      options.maxConcurrentToolBodies ?? DEFAULT_MAX_CONCURRENT_TOOL_BODIES;
    if (
      !Number.isSafeInteger(maxConcurrentToolBodies) ||
      maxConcurrentToolBodies < 1
    ) {
      throw new Error(
        "Maximum concurrent tool bodies must be a positive safe integer",
      );
    }
    this.#maxConcurrentToolBodies = maxConcurrentToolBodies;
  }

  async runTurn(options: RunTurnOptions): Promise<void> {
    const turnId = options.turnId ?? this.#id();
    const scheduler = new TurnToolScheduler(this.#maxConcurrentToolBodies);
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
        if (this.#maxToolRounds !== undefined && round >= this.#maxToolRounds) {
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
        await this.#runToolBatch(
          turnId,
          toolCallItems,
          result.presentation,
          options,
          scheduler,
        );
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
    presentation: ToolPresentationSnapshot;
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
    const reasoningItems = new Map<string, string>();
    let latestUsage:
      | {
          inputTokens: number;
          cachedInputTokens?: number;
          outputTokens: number;
          reasoningOutputTokens?: number;
        }
      | undefined;

    const ensureReasoningItem = (reasoningId: string): string => {
      const existing = reasoningItems.get(reasoningId);
      if (existing !== undefined) return existing;
      const reasoningItemId = this.#id();
      reasoningItems.set(reasoningId, reasoningItemId);
      options.emit({
        type: "item_started",
        threadId: options.thread.id,
        turnId,
        itemId: reasoningItemId,
        itemType: "reasoning",
      });
      return reasoningItemId;
    };

    const messages = await options.prepareModelSample(itemId);
    const definitions =
      this.#toolDefinitionProjection?.(options.thread.items) ??
      this.#tools.definitions;
    const presentation = buildToolPresentation(
      definitions,
      this.#toolPresentation ??
        (definitions.some((definition) => definition.name === "run_code")
          ? "both"
          : "direct"),
    );

    try {
      for await (const event of options.modelAdapter.stream({
        model: options.configuration.model,
        reasoningEffort: options.configuration.reasoningEffort,
        messages,
        tools: presentation.modelTools.map((definition) =>
          structuredClone(definition),
        ),
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
        } else if (event.type === "reasoning_started") {
          ensureReasoningItem(event.reasoningId);
        } else if (
          event.type === "reasoning_summary_delta" ||
          event.type === "reasoning_content_delta"
        ) {
          if (event.delta.length === 0) continue;
          options.emit({
            type: event.type,
            threadId: options.thread.id,
            turnId,
            itemId: ensureReasoningItem(event.reasoningId),
            delta: event.delta,
          });
        } else if (event.type === "reasoning") {
          const reasoningItemId =
            event.reasoningId === undefined
              ? this.#id()
              : ensureReasoningItem(event.reasoningId);
          if (event.reasoningId === undefined) {
            options.emit({
              type: "item_started",
              threadId: options.thread.id,
              turnId,
              itemId: reasoningItemId,
              itemType: "reasoning",
            });
          }
          const reasoning: ReasoningItem = {
            id: reasoningItemId,
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
          await options.commit(reasoning);
          options.emit({ type: "item_completed", item: reasoning });
          if (event.reasoningId !== undefined) {
            reasoningItems.delete(event.reasoningId);
          }
        } else if (event.type === "tool_call") {
          toolCalls.push({
            callId: event.callId,
            name: event.name,
            arguments: event.arguments,
          });
        } else {
          latestUsage = {
            inputTokens: event.inputTokens,
            ...(event.cachedInputTokens === undefined
              ? {}
              : { cachedInputTokens: event.cachedInputTokens }),
            outputTokens: event.outputTokens,
            ...(event.reasoningOutputTokens === undefined
              ? {}
              : { reasoningOutputTokens: event.reasoningOutputTokens }),
          };
          options.emit({
            type: "token_usage",
            threadId: options.thread.id,
            turnId,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            ...(event.cachedInputTokens === undefined
              ? {}
              : { cachedInputTokens: event.cachedInputTokens }),
            ...(event.reasoningOutputTokens === undefined
              ? {}
              : { reasoningOutputTokens: event.reasoningOutputTokens }),
          });
        }
      }
    } finally {
      if (latestUsage !== undefined) {
        const usage: ModelUsageItem = {
          id: this.#id(),
          threadId: options.thread.id,
          turnId,
          createdAt: this.#now(),
          type: "model_usage",
          modelResponseId: itemId,
          ...latestUsage,
        };
        await options.commit(usage);
        options.emit({ type: "item_completed", item: usage });
      }
    }

    if (reasoningItems.size > 0) {
      throw new Error("Model stream ended with incomplete reasoning");
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
    return { itemId, text, toolCalls, presentation };
  }

  async #runToolBatch(
    turnId: string,
    toolCalls: readonly ToolCallItem[],
    presentation: ToolPresentationSnapshot,
    options: RunTurnOptions,
    scheduler: TurnToolScheduler,
  ): Promise<void> {
    const tickets: ScheduledToolCall[] = [];
    for (let index = 0; index < toolCalls.length; index += 1) {
      const toolCall = toolCalls[index];
      if (toolCall === undefined) continue;
      const ticket = this.#scheduleToolCall(
        "root",
        turnId,
        toolCall,
        options,
        {
          admission: "outer",
          signal: options.signal,
          allowedToolNames: presentation.modelToolNames,
          nestedToolNames: presentation.nestedToolNames,
        },
        scheduler,
      );
      tickets.push(ticket);
      try {
        if ((await ticket.ready) === "exclusive") {
          await ticket.committed;
        }
      } catch (error) {
        for (const abandoned of toolCalls.slice(index + 1)) {
          tickets.push(
            scheduler.schedule(
              "root",
              async () =>
                immediateScheduledExecution({
                  output:
                    "Tool call was abandoned because another call in the same model response did not complete.",
                  exitCode: 125,
                }),
              async (result) =>
                this.#completeToolResult(abandoned, result, options),
            ),
          );
        }
        await Promise.allSettled(
          tickets.map((candidate) => candidate.committed),
        );
        throw error;
      }
    }
    const settlements = await Promise.allSettled(
      tickets.map((ticket) => ticket.committed),
    );
    const failed = settlements.find(
      (settlement): settlement is PromiseRejectedResult =>
        settlement.status === "rejected",
    );
    if (failed !== undefined) throw failed.reason;
  }

  #scheduleToolCall(
    scope: string,
    turnId: string,
    toolCall: ToolCallItem,
    options: RunTurnOptions,
    execution: ScheduledToolCapability,
    scheduler: TurnToolScheduler,
    observation?: Promise<NestedToolObservation>,
  ): ScheduledToolCall {
    return scheduler.schedule(
      scope,
      async () => {
        if ((await observation) === "unawaited") {
          return immediateScheduledExecution({
            output:
              "Tool call was abandoned because run_code returned without awaiting it.",
            exitCode: 125,
          });
        }
        if (
          toolCall.parentCallId !== undefined &&
          toolCall.name === "run_code"
        ) {
          return immediateScheduledExecution({
            output: "Nested run_code is not supported.",
            exitCode: 1,
          });
        }
        return await this.#prepareToolCall(
          turnId,
          toolCall,
          options,
          execution,
          scheduler,
        );
      },
      async (result) => this.#completeToolResult(toolCall, result, options),
    );
  }

  async #prepareToolCall(
    turnId: string,
    toolCall: ToolCallItem,
    options: RunTurnOptions,
    execution: ScheduledToolCapability,
    scheduler: TurnToolScheduler,
  ): Promise<ScheduledToolExecution> {
    let prepared;
    try {
      if (!execution.allowedToolNames.has(toolCall.name)) {
        throw new Error(
          `Unsupported tool: ${toolCall.name} (not available in this model sample)`,
        );
      }
      prepared = this.#tools.prepare({
        callId: toolCall.callId,
        name: toolCall.name,
        arguments: toolCall.arguments,
        cwd: options.configuration.cwd,
        signal: execution.signal,
      });
    } catch (error) {
      const result = {
        output: `Tool preparation failed: ${describeError(error)}`,
        exitCode: execution.signal.aborted ? 130 : 1,
      };
      return immediateScheduledExecution(
        result,
        execution.signal.aborted ? error : undefined,
      );
    }

    let decision: ApprovalDecision;
    try {
      decision = await waitForAbort(
        execution.admission === "inherited"
          ? this.#tools.admitInherited(prepared)
          : this.#tools.admit(prepared, {
              policy: toolPolicyFromApprovalPolicy(
                options.configuration.approvalPolicy,
              ),
              approvalRequest: {
                threadId: options.thread.id,
                turnId,
                itemId: toolCall.id,
                callId: toolCall.callId,
                command: readCommand(toolCall),
                toolName: toolCall.name,
                toolArguments: toolCall.arguments,
                cwd: options.configuration.cwd,
                signal: execution.signal,
              },
              ...(options.requestApproval === undefined
                ? {}
                : { requestApproval: options.requestApproval }),
            }),
        execution.signal,
      );
    } catch (error) {
      const result = {
        output: `Tool admission failed: ${describeError(error)}`,
        exitCode: execution.signal.aborted ? 130 : 1,
      };
      return immediateScheduledExecution(
        result,
        execution.signal.aborted ? error : undefined,
      );
    }

    if (decision === "cancel") {
      const result = {
        output: "User cancelled this tool call.",
        exitCode: 130,
      };
      return immediateScheduledExecution(
        result,
        new DOMException("Cancelled by user", "AbortError"),
      );
    }

    if (decision === "decline") {
      return immediateScheduledExecution(
        { output: "User declined this tool call.", exitCode: 126 },
        undefined,
        prepared.executionMode,
      );
    }

    return {
      mode:
        toolCall.parentCallId === undefined && toolCall.name === "run_code"
          ? "exclusive"
          : prepared.executionMode,
      run: async (): Promise<ScheduledToolOutcome> => {
        let outcome: ScheduledToolOutcome;
        try {
          const operation = this.#tools.execute(
            prepared,
            this.#nestedPort(
              turnId,
              toolCall,
              options,
              execution.signal,
              scheduler,
              execution.nestedToolNames,
            ),
          );
          const result =
            execution.admission === "inherited"
              ? await waitForAbortGracefully(operation, execution.signal)
              : await operation;
          outcome = { result };
        } catch (error) {
          const interrupted = execution.signal.aborted;
          const unawaited =
            execution.signal.reason instanceof UnawaitedNestedToolCallError;
          const phase =
            error instanceof ToolResultNormalizationError
              ? "Tool result normalization failed"
              : "Tool execution failed";
          const failed = unawaited
            ? {
                output:
                  "Tool call was abandoned because run_code returned without awaiting it.",
                exitCode: 125,
              }
            : {
                output: `${phase}: ${describeError(error)}`,
                exitCode: interrupted ? 130 : 1,
              };
          outcome = {
            result: failed,
            ...(interrupted ? { controlError: error } : {}),
          };
        }

        if (execution.signal.reason instanceof UnawaitedNestedToolCallError) {
          outcome = {
            result: {
              output:
                "Tool call was abandoned because run_code returned without awaiting it.",
              exitCode: 125,
            },
          };
        }
        if (
          toolCall.parentCallId === undefined &&
          toolCall.name === "run_code"
        ) {
          await scheduler.drain(toolCall.callId);
        }
        return outcome;
      },
    };
  }

  #nestedPort(
    turnId: string,
    parent: ToolCallItem,
    options: RunTurnOptions,
    inheritedSignal: AbortSignal,
    scheduler: TurnToolScheduler,
    allowedToolNames: ReadonlySet<string>,
  ) {
    return {
      invoke: async (
        name: string,
        arguments_: Record<string, unknown>,
        signal: AbortSignal = inheritedSignal,
        observation?: Promise<NestedToolObservation>,
      ): Promise<ToolExecutionResult> => {
        const child: ToolCallItem = {
          id: this.#id(),
          threadId: options.thread.id,
          turnId: parent.turnId,
          createdAt: this.#now(),
          type: "tool_call",
          callId: this.#id(),
          parentCallId: parent.callId,
          name,
          arguments: structuredClone(arguments_),
        };
        await this.#completeItem(child, options);
        return await this.#scheduleToolCall(
          parent.callId,
          turnId,
          child,
          options,
          {
            admission: "inherited",
            signal,
            allowedToolNames,
            nestedToolNames: allowedToolNames,
          },
          scheduler,
          observation,
        ).result;
      },
    };
  }

  async #completeToolResult(
    toolCall: ToolCallItem,
    result: ToolExecutionResult,
    options: RunTurnOptions,
  ): Promise<void> {
    const capture =
      capturedToolOutput(result) ??
      (this.#toolOutputSpool === undefined
        ? undefined
        : await this.#toolOutputSpool.captureText(
            result.output,
            result.sourceTruncated === undefined
              ? {}
              : { sourceTruncated: result.sourceTruncated },
          ));
    const resultItem: ToolResultItem = {
      id: this.#id(),
      threadId: options.thread.id,
      turnId: toolCall.turnId,
      createdAt: this.#now(),
      type: "tool_result",
      callId: toolCall.callId,
      output: capture === undefined ? result.output : renderToolOutput(capture),
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

interface ScheduledToolCapability {
  admission: "outer" | "inherited";
  signal: AbortSignal;
  allowedToolNames: ReadonlySet<string>;
  nestedToolNames: ReadonlySet<string>;
}

interface ScheduledToolOutcome {
  result: ToolExecutionResult;
  controlError?: unknown;
}

interface ScheduledToolExecution {
  mode: ToolExecutionMode;
  run(): Promise<ScheduledToolOutcome>;
}

interface ScheduledToolCall {
  /** Resolves after ordered preparation/admission and body scheduling. */
  ready: Promise<ToolExecutionMode>;
  /** Provider outcome, available before its ordered canonical commit. */
  result: Promise<ToolExecutionResult>;
  /** Provider outcome after its canonical result has committed. */
  committed: Promise<ToolExecutionResult>;
}

interface ToolSchedulingLane {
  admissionTail: Promise<void>;
  planningTail: Promise<void>;
  commitTail: Promise<void>;
  hasCommitFailure: boolean;
  commitFailure: unknown;
  barrier: Promise<void>;
  readonly activeBodies: Set<Promise<void>>;
}

class TurnToolScheduler {
  readonly #semaphore: ToolBodySemaphore;
  readonly #lanes = new Map<string, ToolSchedulingLane>();

  constructor(maxConcurrentBodies: number) {
    this.#semaphore = new ToolBodySemaphore(maxConcurrentBodies);
  }

  schedule(
    scope: string,
    prepare: () => Promise<ScheduledToolExecution>,
    commit: (result: ToolExecutionResult) => Promise<void>,
  ): ScheduledToolCall {
    const lane = this.#lane(scope);
    const admission = lane.admissionTail.then(prepare);
    lane.admissionTail = admission.then(
      () => undefined,
      () => undefined,
    );

    const outcome = deferred<ScheduledToolOutcome>();
    const priorPlanning = lane.planningTail;
    const ready = Promise.all([priorPlanning, admission]).then(
      async ([, execution]) => {
        const priorBarrier = lane.barrier;
        let operation: Promise<ScheduledToolOutcome>;
        if (execution.mode === "exclusive") {
          const priorBodies = [...lane.activeBodies];
          operation = (async () => {
            await Promise.allSettled(priorBodies);
            return await execution.run();
          })();
        } else {
          operation = (async () => {
            await priorBarrier;
            const release = await this.#semaphore.acquire();
            try {
              return await execution.run();
            } finally {
              release();
            }
          })();
        }

        const bodySettled = operation.then(
          () => undefined,
          () => undefined,
        );
        lane.activeBodies.add(bodySettled);
        if (execution.mode === "exclusive") lane.barrier = bodySettled;
        void bodySettled.then(() => lane.activeBodies.delete(bodySettled));
        void operation.then(outcome.resolve, outcome.reject);
        return execution.mode;
      },
    );
    lane.planningTail = ready.then(
      () => undefined,
      () => undefined,
    );
    void ready.catch(outcome.reject);

    const committedOutcome = lane.commitTail.then(async () => {
      if (lane.hasCommitFailure) throw lane.commitFailure;
      const value = await outcome.promise;
      await commit(value.result);
      return value;
    });
    lane.commitTail = committedOutcome.then(
      () => undefined,
      (error: unknown) => {
        if (!lane.hasCommitFailure) {
          lane.hasCommitFailure = true;
          lane.commitFailure = error;
        }
      },
    );

    const result = outcome.promise.then(unwrapScheduledOutcome);
    const committed = committedOutcome.then(unwrapScheduledOutcome);
    void result.catch(() => undefined);
    void committed.catch(() => undefined);
    return { ready, result, committed };
  }

  async drain(scope: string): Promise<void> {
    const lane = this.#lanes.get(scope);
    if (lane === undefined) return;
    await lane.admissionTail;
    await lane.planningTail;
    await lane.commitTail;
    if (lane.hasCommitFailure) throw lane.commitFailure;
  }

  #lane(scope: string): ToolSchedulingLane {
    const current = this.#lanes.get(scope);
    if (current !== undefined) return current;
    const lane: ToolSchedulingLane = {
      admissionTail: Promise.resolve(),
      planningTail: Promise.resolve(),
      commitTail: Promise.resolve(),
      hasCommitFailure: false,
      commitFailure: undefined,
      barrier: Promise.resolve(),
      activeBodies: new Set(),
    };
    this.#lanes.set(scope, lane);
    return lane;
  }
}

class ToolBodySemaphore {
  #available: number;
  readonly #waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.#available = capacity;
  }

  async acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
    } else {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#available += 1;
      else waiter();
    };
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function immediateScheduledExecution(
  result: ToolExecutionResult,
  controlError?: unknown,
  mode: ToolExecutionMode = "exclusive",
): ScheduledToolExecution {
  return {
    mode,
    run: async () => ({
      result,
      ...(controlError === undefined ? {} : { controlError }),
    }),
  };
}

function unwrapScheduledOutcome(
  outcome: ScheduledToolOutcome,
): ToolExecutionResult {
  if (outcome.controlError !== undefined) throw outcome.controlError;
  return outcome.result;
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
  if (
    toolCall.name === "run_code" &&
    typeof toolCall.arguments.code === "string"
  ) {
    return toolCall.arguments.code;
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

async function waitForAbortGracefully<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  graceMs = 300,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const abort = (): void => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        cleanup();
        reject(
          signal.reason ??
            new DOMException("The operation was aborted", "AbortError"),
        );
      }, graceMs);
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", abort);
      if (timer !== undefined) clearTimeout(timer);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
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
