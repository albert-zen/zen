import { randomUUID } from "node:crypto";
import {
  type ToolOutputSpool,
  DEFAULT_TOOL_OUTPUT_CAPTURE_BYTES,
  renderToolOutput,
} from "./tool-output-spool.js";
import {
  attachToolOutputCapture,
  capturedToolOutput,
  toolOutputSuffix,
  ToolOutputWindow,
  type ToolInvocation,
  type ToolRuntime,
  type ToolExecutionResult,
} from "./tool.js";

export interface ToolTaskPolicy {
  yieldTimeMs?: number;
  timeoutMs?: number;
  /** Optional tool-schema fields exposing generic timing controls. */
  timingArguments?: { yieldTimeMs?: string; timeoutMs?: string };
  /** Independent processes may coexist; otherwise the retained owner stays fenced. */
  resourceScope?: "independent" | "runtime" | "bundle";
  /** Only adapters which confirm the underlying operation has stopped may opt in. */
  cancellation?: "confirmed-on-settle" | "unconfirmed";
}
export interface ToolTaskOptions {
  yieldTimeMs?: number;
  timeoutMs?: number;
  maxTasks?: number;
  maxRunningTasks?: number;
  retentionMs?: number;
  shutdownWaitMs?: number;
  maxOutputBytes?: number;
  toolOutputSpool?: ToolOutputSpool;
}
export const TOOL_TASK_CONTENT_TYPE = "application/vnd.zen.tool-task+json";
export const MAX_TOOL_YIELD_TIME_MS = 180000;
type Status =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancel_requested"
  | "cancellation_unconfirmed"
  | "cancelled";

/** Host-local executions, output windows, cancellation evidence and retained resources. */
export class ToolTaskManager {
  readonly #tasks = new Map<string, Task>();
  readonly #resources = new Map<unknown, Task>();
  readonly #options: Required<Omit<ToolTaskOptions, "toolOutputSpool">> &
    Pick<ToolTaskOptions, "toolOutputSpool">;
  #closed = false;
  readonly #invocations = new WeakSet<ToolInvocation>();
  ownsInvocation(invocation: ToolInvocation) {
    return this.#invocations.has(invocation);
  }
  constructor(options: ToolTaskOptions = {}) {
    this.#options = {
      yieldTimeMs: integer(
        options.yieldTimeMs ?? 10000,
        "yieldTimeMs",
        MAX_TOOL_YIELD_TIME_MS,
      ),
      timeoutMs: integer(options.timeoutMs ?? 600000, "timeoutMs", 86400000),
      maxRunningTasks: integer(
        options.maxRunningTasks ?? 8,
        "maxRunningTasks",
        1024,
      ),
      maxTasks: integer(options.maxTasks ?? 64, "maxTasks", 1024),
      retentionMs: integer(
        options.retentionMs ?? 300000,
        "retentionMs",
        86400000,
      ),
      shutdownWaitMs: integer(
        options.shutdownWaitMs ?? 500,
        "shutdownWaitMs",
        60000,
      ),
      maxOutputBytes: integer(
        options.maxOutputBytes ?? DEFAULT_TOOL_OUTPUT_CAPTURE_BYTES,
        "maxOutputBytes",
        1024 * 1024 * 1024,
      ),
      ...(options.toolOutputSpool === undefined
        ? {}
        : { toolOutputSpool: options.toolOutputSpool }),
    };
  }
  hasActiveTasks(threadId: string): boolean {
    return [...this.#tasks.values()].some(
      (task) => task.threadId === threadId && !task.terminal,
    );
  }

  get activeTaskCount(): number {
    return [...this.#tasks.values()].filter((task) => !task.terminal).length;
  }

  async run(
    runtime: ToolRuntime,
    invocation: ToolInvocation,
    execute: (invocation: ToolInvocation) => Promise<ToolExecutionResult>,
    options: { resourceKey?: unknown; release?: () => void } = {},
  ): Promise<ToolExecutionResult> {
    if (this.#closed) throw new Error("Tool task manager is closed");
    invocation.signal.throwIfAborted();
    if (this.#tasks.size >= this.#options.maxTasks)
      throw new Error(
        `Tool task limit reached (${this.#options.maxTasks}); wait for or cancel an existing task`,
      );
    if (
      !("executeComposite" in runtime) &&
      [...this.#tasks.values()].filter(
        (task) => !task.terminal && !task.coordinator,
      ).length >= this.#options.maxRunningTasks
    )
      throw new Error(
        "Tool execution capacity is busy; wait for or cancel an existing task",
      );
    if (
      options.resourceKey !== undefined &&
      this.#resources.has(options.resourceKey)
    )
      throw new Error(
        "Tool resource is busy with a running or unconfirmed task; use wait before starting a conflicting operation",
      );
    const policy = runtime.taskPolicy;
    const timing = invocation.task;
    const yieldMs = integer(
      timing?.yieldTimeMs ??
        (policy?.timingArguments?.yieldTimeMs === undefined
          ? undefined
          : invocation.arguments[policy.timingArguments.yieldTimeMs]) ??
        policy?.yieldTimeMs ??
        this.#options.yieldTimeMs,
      "yield_time_ms",
      MAX_TOOL_YIELD_TIME_MS,
    );
    const timeoutMs = integer(
      timing?.timeoutMs ??
        (policy?.timingArguments?.timeoutMs === undefined
          ? undefined
          : invocation.arguments[policy.timingArguments.timeoutMs]) ??
        policy?.timeoutMs ??
        this.#options.timeoutMs,
      "timeout_ms",
      86400000,
    );
    const task = new Task(runtime, invocation, execute, {
      ...this.#options,
      timeoutMs,
      onRelease: () => {
        if (
          options.resourceKey !== undefined &&
          this.#resources.get(options.resourceKey) === task
        )
          this.#resources.delete(options.resourceKey);
        options.release?.();
      },
      onExpire: () => this.#tasks.delete(task.id),
    });
    this.#tasks.set(task.id, task);
    if (options.resourceKey !== undefined)
      this.#resources.set(options.resourceKey, task);
    this.#invocations.add(invocation);
    const releaseObservation = task.acquireObservation();
    try {
      task.start();
      if (invocation.task?.waitForCompletion) await task.completion;
      else await task.observe(yieldMs, true);
      if (invocation.threadId === undefined && !task.terminal) {
        task.cancel(false);
        await task.observe(this.#options.shutdownWaitMs);
        // A missing thread must never create an inaccessible running operation.
        if (!task.terminal)
          throw new Error(
            "Long-running tool calls require a thread id; cancellation was requested but is unconfirmed",
          );
      }
      try {
        const result = await task.drain(!task.yielded && task.directResult);
        if (!task.yielded || finalResult(result)) await this.#consume(task);
        return result;
      } catch (error) {
        if (task.terminal) await this.#consume(task);
        throw error;
      }
    } finally {
      releaseObservation();
    }
  }
  async wait(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    invocation.signal.throwIfAborted();
    const id = invocation.arguments.task_id;
    if (typeof id !== "string" || id.length === 0)
      throw new Error("wait.task_id must be a non-empty string");
    const task = this.#tasks.get(id);
    if (
      task === undefined ||
      invocation.threadId === undefined ||
      task.threadId !== invocation.threadId
    )
      throw new Error("Tool task not found for this thread");
    const yieldMs = integer(
      invocation.arguments.yield_time_ms ?? this.#options.yieldTimeMs,
      "wait.yield_time_ms",
      MAX_TOOL_YIELD_TIME_MS,
    );
    const terminate = invocation.arguments.terminate ?? false;
    if (typeof terminate !== "boolean")
      throw new Error("wait.terminate must be a boolean");
    if (terminate) task.cancel(false);
    if (task.observed) {
      if (terminate)
        return task.snapshot(
          "Cancellation requested; the existing wait owns incremental output.",
        );
      throw new Error(
        "Tool task is already being observed; await the existing wait before waiting again",
      );
    }
    const releaseObservation = task.acquireObservation();
    const abort = () => task.cancel(false);
    invocation.signal.addEventListener("abort", abort, { once: true });
    try {
      await task.observe(yieldMs, terminate);
      const result = await task.drain(false);
      if (!task.yielded || finalResult(result)) await this.#consume(task);
      return result;
    } finally {
      invocation.signal.removeEventListener("abort", abort);
      releaseObservation();
    }
  }
  async #consume(task: Task) {
    await task.shutdown();
    this.#tasks.delete(task.id);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const tasks = [...this.#tasks.values()];
    for (const task of tasks) task.cancel(false);
    await Promise.all(
      tasks.map((task) => task.observe(this.#options.shutdownWaitMs)),
    );
    for (const task of tasks) await task.shutdown();
    this.#tasks.clear();
    this.#resources.clear();
  }
}

class Task {
  readonly completion: Promise<void>;
  #complete!: () => void;
  #yieldRequested = false;
  readonly id = randomUUID();
  readonly threadId: string | undefined;
  readonly #runtime: ToolRuntime;
  readonly #invocation: ToolInvocation;
  readonly #execute: (
    invocation: ToolInvocation,
  ) => Promise<ToolExecutionResult>;
  readonly #options: Required<Omit<ToolTaskOptions, "toolOutputSpool">> &
    Pick<ToolTaskOptions, "toolOutputSpool"> & {
      onRelease(): void;
      onExpire(): void;
    };
  readonly #controller = new AbortController();
  readonly #listeners = new Set<() => void>();
  #window: ToolOutputWindow;
  #result: ToolExecutionResult | undefined;
  #error: unknown;
  #settled = false;
  #cancelReason: "timeout" | "cancel" | undefined;
  #deadline: NodeJS.Timeout | undefined;
  #expiry: NodeJS.Timeout | undefined;
  #released = false;
  #closed = false;
  #observed = false;
  #diagnosticReported = false;
  #drainTail = Promise.resolve();
  readonly #abort = () => this.cancel(false);
  yielded = false;
  constructor(
    runtime: ToolRuntime,
    invocation: ToolInvocation,
    execute: (invocation: ToolInvocation) => Promise<ToolExecutionResult>,
    options: Required<Omit<ToolTaskOptions, "toolOutputSpool">> &
      Pick<ToolTaskOptions, "toolOutputSpool"> & {
        onRelease(): void;
        onExpire(): void;
      },
  ) {
    this.#runtime = runtime;
    this.#invocation = invocation;
    this.#execute = execute;
    this.#options = options;
    this.threadId = invocation.threadId;
    this.#window = this.#newWindow();
    this.completion = new Promise((resolve) => {
      this.#complete = resolve;
    });
  }
  get coordinator() {
    return "executeComposite" in this.#runtime;
  }
  get observed() {
    return this.#observed;
  }
  acquireObservation() {
    if (this.#observed) throw new Error("Tool task is already being observed");
    this.#observed = true;
    this.dispose();
    return () => {
      this.#observed = false;
      this.#retainCompleted();
    };
  }
  #retainCompleted() {
    if (!this.terminal || this.#observed || this.#closed) return;
    this.dispose();
    this.#expiry = setTimeout(() => {
      void this.shutdown();
      this.#options.onExpire();
    }, this.#options.retentionMs);
    this.#expiry.unref();
  }
  get status(): Status {
    if (this.#cancelReason !== undefined) {
      if (
        this.#settled &&
        this.#runtime.taskPolicy?.cancellation === "confirmed-on-settle"
      )
        return this.#cancelReason === "timeout" ? "timed_out" : "cancelled";
      if (
        this.#settled &&
        this.#error === undefined &&
        this.#result !== undefined
      )
        return this.#result.exitCode === 0 ? "completed" : "failed";
      return this.#runtime.taskPolicy?.cancellation === "confirmed-on-settle"
        ? "cancel_requested"
        : "cancellation_unconfirmed";
    }
    return !this.#settled
      ? "running"
      : this.#error !== undefined || this.#result?.exitCode !== 0
        ? "failed"
        : "completed";
  }
  get directResult() {
    return this.#settled && this.#cancelReason === undefined;
  }
  get terminal() {
    return ["completed", "failed", "timed_out", "cancelled"].includes(
      this.status,
    );
  }
  start() {
    this.#invocation.signal.addEventListener("abort", this.#abort, {
      once: true,
    });
    this.#deadline = setTimeout(
      () => this.cancel(true),
      this.#options.timeoutMs,
    );
    this.#deadline.unref();
    Promise.resolve(
      this.#execute({
        ...this.#invocation,
        signal: this.#controller.signal,
        taskContext: {
          requestYield: () => {
            this.#yieldRequested = true;
            this.#notify();
          },
          onOutput: (text) => {
            if (this.#closed) return;
            this.#window.write(text);
            this.#notify();
          },
        },
      }),
    )
      .then(
        (result) => {
          this.#result = result;
        },
        (error) => {
          this.#error = error;
        },
      )
      .finally(() => {
        this.#settled = true;
        if (this.#deadline !== undefined) clearTimeout(this.#deadline);
        this.#invocation.signal.removeEventListener("abort", this.#abort);
        if (this.terminal) {
          this.#release();
          this.#retainCompleted();
        }
        this.#notify();
        this.#complete();
      });
    if (this.#invocation.signal.aborted) this.cancel(false);
  }
  cancel(timeout: boolean) {
    if (this.terminal || this.#cancelReason !== undefined) return;
    this.#cancelReason = timeout ? "timeout" : "cancel";
    this.#controller.abort(
      new Error(
        timeout
          ? "Tool execution timed out"
          : "Tool execution cancellation requested",
      ),
    );
    this.#notify();
  }
  async observe(ms: number, cancelRequested = false): Promise<void> {
    if (
      this.terminal ||
      this.#yieldRequested ||
      (cancelRequested && this.status === "cancellation_unconfirmed")
    )
      return;
    const previousStatus = this.status;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      const changed = () => {
        if (
          this.terminal ||
          this.#yieldRequested ||
          (previousStatus !== "cancellation_unconfirmed" &&
            this.status === "cancellation_unconfirmed")
        )
          done();
      };
      const self = this;
      function done() {
        clearTimeout(timer);
        self.#listeners.delete(changed);
        resolve();
      }
      this.#listeners.add(changed);
    });
  }
  async drain(quiet: boolean): Promise<ToolExecutionResult> {
    let release!: () => void;
    const previous = this.#drainTail;
    this.#drainTail = new Promise((r) => {
      release = r;
    });
    await previous;
    try {
      const status = this.status;
      this.#yieldRequested = false;
      const terminal = this.terminal;
      if (quiet && this.#error !== undefined && !this.#window.hasOutput)
        throw this.#error;
      const result = terminal ? this.#result : undefined;
      const window = this.#window;
      this.#window = this.#newWindow();
      if (quiet && result !== undefined && !window.hasOutput) {
        await window.discard();
        return result;
      }
      if (result !== undefined) {
        const originalCapture = capturedToolOutput(result);
        window.write(
          (originalCapture === undefined
            ? result.output
            : renderToolOutput(originalCapture)) +
            (toolOutputSuffix(result) ?? ""),
        );
      }
      if (this.#error !== undefined && !this.#diagnosticReported) {
        this.#diagnosticReported = true;
        window.write(
          this.#error instanceof Error
            ? this.#error.message
            : String(this.#error),
        );
      }
      const capture = await window.finish(result?.sourceTruncated ?? false);
      if (quiet && result !== undefined && !window.hasOutput) return result;
      if (quiet && result !== undefined) {
        return attachToolOutputCapture(
          { ...result, output: capture.output },
          capture.metadata,
        );
      }
      this.yielded = true;
      return this.#receipt(status, capture, result);
    } finally {
      release();
    }
  }
  snapshot(output: string): ToolExecutionResult {
    return this.#receipt(this.status, { output });
  }
  #receipt(
    status: Status,
    capture: Awaited<ReturnType<ToolOutputWindow["finish"]>>,
    result?: ToolExecutionResult,
  ): ToolExecutionResult {
    const terminal = ["completed", "failed", "timed_out", "cancelled"].includes(
      status,
    );
    const exitCode = terminal
      ? status === "timed_out"
        ? 124
        : status === "cancelled"
          ? 130
          : (result?.exitCode ?? this.#result?.exitCode ?? 1)
      : 0;
    const cancellation =
      this.#runtime.taskPolicy?.cancellation === "confirmed-on-settle"
        ? "confirmable"
        : "best_effort";
    const resourceScope =
      this.#runtime.taskPolicy?.resourceScope ??
      (this.#runtime.executionMode === "parallel_safe"
        ? "independent"
        : "bundle");
    const control = `\n[tool task ${status}]\ntask_id: ${this.id}\ntool_name: ${this.#runtime.name}\ntimeout_ms: ${this.#options.timeoutMs}\ncancellation: ${cancellation}\nresource_scope: ${resourceScope}\nlifetime: host_instance${terminal ? `\nexit_code: ${exitCode}` : ""}${status === "cancellation_unconfirmed" ? "\nCancellation is unconfirmed; the underlying operation may still be running." : ""}`;
    return attachToolOutputCapture(
      {
        output: capture.output,
        exitCode,
        contentType: TOOL_TASK_CONTENT_TYPE,
        structuredContent: {
          status,
          task_id: this.id,
          tool_name: this.#runtime.name,
          timeout_ms: this.#options.timeoutMs,
          cancellation,
          resource_scope: resourceScope,
          lifetime: "host_instance",
          exit_code: terminal ? exitCode : null,
          ...(result?.structuredContent === undefined
            ? {}
            : { result: result.structuredContent }),
          ...(result?.contentType === undefined
            ? {}
            : { result_content_type: result.contentType }),
        },
        ...(result?.modelContent === undefined
          ? {}
          : { modelContent: result.modelContent }),
        ...(result?.sourceTruncated === undefined
          ? {}
          : { sourceTruncated: result.sourceTruncated }),
      },
      capture.metadata,
      control,
    );
  }

  #release() {
    if (!this.#released) {
      this.#released = true;
      this.#options.onRelease();
    }
  }
  dispose() {
    if (this.#expiry !== undefined) clearTimeout(this.#expiry);
  }
  async shutdown() {
    this.#closed = true;
    this.dispose();
    if (this.#deadline !== undefined) clearTimeout(this.#deadline);
    this.#invocation.signal.removeEventListener("abort", this.#abort);
    await this.#window.discard();
    this.#release();
  }
  #newWindow() {
    return new ToolOutputWindow(
      this.#options.maxOutputBytes,
      this.#options.toolOutputSpool,
      this.#invocation.task?.previewBytes,
    );
  }
  #notify() {
    for (const listener of this.#listeners) listener();
  }
}
export class ToolWaitRuntime implements ToolRuntime {
  readonly name: string;
  readonly executionMode = "parallel_safe";
  readonly specification;
  readonly #manager: ToolTaskManager;
  constructor(manager: ToolTaskManager) {
    this.#manager = manager;
    this.name = "wait";
    this.specification = {
      name: this.name,
      description:
        "Tools, including run_code programs, automatically return task_id when they exceed their yield time; no separate background mode is required. wait returns when the task completes or yield_time_ms expires, with output produced since the previous receipt. Expiry does not stop the task; its execution deadline remains separate. Program-side await tools.* waits for the actual result. terminate requests cancellation; receipts report confirmable or best_effort cancellation and resource_scope. Running bundle/runtime resources stay busy; independent tasks can coexist. Only cancelled/timed_out confirm cancellation. Tasks belong to this Host instance and do not resume after restart.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          yield_time_ms: {
            type: "integer",
            minimum: 1,
            maximum: MAX_TOOL_YIELD_TIME_MS,
          },
          terminate: { type: "boolean" },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    };
  }
  async execute(invocation: ToolInvocation) {
    return await this.#manager.wait(invocation);
  }
}
function integer(value: unknown, name: string, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  )
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  return value;
}

function finalResult(result: ToolExecutionResult): boolean {
  if (result.contentType !== TOOL_TASK_CONTENT_TYPE) return true;
  const data = result.structuredContent;
  return (
    typeof data === "object" &&
    data !== null &&
    "status" in data &&
    typeof data.status === "string" &&
    ["completed", "failed", "timed_out", "cancelled"].includes(data.status)
  );
}
