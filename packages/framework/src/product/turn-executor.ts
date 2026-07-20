import type { JsonValue, ThreadSnapshot, TurnSnapshot } from './app-server-protocol.js';
import type {
  ContextCompiler,
  Item,
  ItemAppendInput,
  ModelGateway,
  ModelOptions,
  ToolRuntime,
} from '../kernel/index.js';
import type { ApprovalBroker } from './approval-runtime.js';
import type { ThreadRecord, TurnRecord } from './thread-manager.js';

export type TurnExecutorAppendItem = (input: ItemAppendInput) => Promise<Item | undefined>;

export type TurnExecutorInput = {
  /**
   * The executor sees the current public snapshot and the internal records at
   * turn start. ThreadManager remains the source of truth for lifecycle,
   * journaling, and terminal reconciliation.
   */
  readonly threadSnapshot: ThreadSnapshot;
  readonly threadRecord: ThreadRecord;
  readonly turnSnapshot: TurnSnapshot;
  readonly turnRecord: TurnRecord;
  readonly input: JsonValue;
  readonly modelOptions?: ModelOptions;
  readonly signal: AbortSignal;
  readonly appendItem: TurnExecutorAppendItem;
};

export type TurnExecutorResult = {
  readonly yielded: boolean;
};

/**
 * Provider-neutral turn body.
 *
 * ThreadManager owns queueing, per-thread serialization, scheduler leases,
 * cancellation authority, journaling, terminal detection, restart repair, and
 * notifications. A TurnExecutor may append canonical Items and then report
 * whether execution yielded back to the manager.
 */
export interface TurnExecutor {
  run(input: TurnExecutorInput): Promise<TurnExecutorResult>;
}

export type AgentLoopThreadRuntime = {
  readonly model: ModelGateway;
  readonly toolRuntime?: ToolRuntime;
  readonly contextCompiler?: ContextCompiler;
  readonly systemPrompt?: string;
};

export type ExecutorThreadRuntime = {
  readonly executor: TurnExecutor;
};

/**
 * Legacy AgentLoop runtimes stay compatible; executor runtimes opt in by
 * exposing a TurnExecutor. ThreadManager chooses the executor branch when the
 * property is present and applies the same terminal/failure/cancel rules.
 */
export type ThreadRuntime = AgentLoopThreadRuntime | ExecutorThreadRuntime;

export type ThreadRuntimeFactoryInput = {
  readonly thread: ThreadRecord;
  readonly turn: TurnRecord;
  readonly approvalBroker?: ApprovalBroker;
};

export type ThreadRuntimeFactory = (input: ThreadRuntimeFactoryInput) => ThreadRuntime;

export function hasTurnExecutor(runtime: ThreadRuntime): runtime is ExecutorThreadRuntime {
  return 'executor' in runtime;
}
