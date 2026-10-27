import type {
  ShellSessionSummary,
  ShellSessionRead,
  ShellTerminalControl,
} from "./shell-session.js";
import { randomUUID } from "node:crypto";
import { validateUserInput, type UserInput } from "./item.js";
import {
  type ToolOutputSpool,
  DEFAULT_TOOL_OUTPUT_CAPTURE_BYTES,
} from "./tool-output-spool.js";
import {
  attachToolOutputCapture,
  carryToolResultReferences,
  capturedToolOutput,
  toolOutputSuffix,
  ToolOutputWindow,
  type ToolInvocation,
  type ShellLifecycleFacts,
  type ToolRuntime,
  type ToolExecutionResult,
} from "./tool.js";
import { TOOL_TASK_CONTENT_TYPE } from "./tool-task-content.js";

export { TOOL_TASK_CONTENT_TYPE } from "./tool-task-content.js";

export interface ToolTaskPolicy {
  yieldTimeMs?: number;
  timeoutMs?: number;
  /** Optional tool-schema fields exposing generic timing controls. */
  timingArguments?: { yieldTimeMs?: string; timeoutMs?: string };
  /** Independent processes may coexist; otherwise the retained owner stays fenced. */
  resourceScope?: "independent" | "runtime" | "bundle";
  /** Opt in to bounded FIFO waiting when execution capacity or a resource is busy. */
  resourceQueue?: "fifo";
  /** Only adapters which confirm the underlying operation has stopped may opt in. */
  cancellation?: "confirmed-on-settle" | "unconfirmed";
  /** Trusted native cleanup join policy; expiry is failure, never proof of cleanup. */
  shutdownWaitMs?: number;
}
export interface ToolResourceClaim {
  /** Host-owned identity compared with JavaScript Map key equality. */
  readonly key: unknown;
  readonly access: "shared" | "exclusive";
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
export const MAX_TOOL_YIELD_TIME_MS = 180000;
type Status =
  | "queued"
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
  // Completed observations only; these records cannot execute, wait or cancel.
  readonly #shellHistory = new Map<
    string,
    { view: ShellSessionRead; expires: number }
  >();

  #pruneShellHistory() {
    for (const [id, entry] of this.#shellHistory)
      if (entry.expires <= Date.now()) this.#shellHistory.delete(id);
  }
  #archiveShell(task: Task) {
    if (!task.isShell) return;
    this.#pruneShellHistory();
    const view = task.shellRead(undefined, 65536);
    view.session.retained = true;
    view.session.inputAvailable = false;
    this.#shellHistory.set(task.id, {
      view,
      expires: Date.now() + this.#options.retentionMs,
    });
    while (this.#shellHistory.size > this.#options.maxTasks)
      this.#shellHistory.delete(this.#shellHistory.keys().next().value!);
  }
  listShellSessions(threadId: string): ShellSessionSummary[] {
    this.#pruneShellHistory();
    return [
      ...[...this.#tasks.values()]
        .filter((task) => task.isShell && task.threadId === threadId)
        .map((task) => task.shellSummary()),
      ...[...this.#shellHistory.values()]
        .filter(({ view }) => view.session.threadId === threadId)
        .map(({ view }) => structuredClone(view.session)),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  readShellSession(
    threadId: string,
    taskId: string,
    cursor?: unknown,
  ): ShellSessionRead {
    validateShellCursor(cursor);
    this.#pruneShellHistory();
    const task = this.#tasks.get(taskId);
    if (task?.isShell && task.threadId === threadId)
      return task.shellRead(cursor);
    const retained = this.#shellHistory.get(taskId)?.view;
    if (!retained || retained.session.threadId !== threadId)
      throw new Error("Shell session not found for this thread");
    return sliceShellView(retained, cursor);
  }
  #shellTask(threadId: string, taskId: string): Task {
    const task = this.#tasks.get(taskId);
    if (!task?.isShell || task.threadId !== threadId)
      throw new Error("Shell session not found for this thread");
    return task;
  }
  writeShellSession(threadId: string, taskId: string, data: unknown): void {
    if (
      typeof data !== "string" ||
      data.length === 0 ||
      Buffer.byteLength(data) > 65536
    )
      throw new Error("Shell input must be 1–65536 bytes");
    this.#shellTask(threadId, taskId).shellInput().write(data);
  }
  resizeShellSession(
    threadId: string,
    taskId: string,
    cols: unknown,
    rows: unknown,
  ): void {
    this.#shellTask(threadId, taskId)
      .shellInput()
      .resize(integer(cols, "cols", 500), integer(rows, "rows", 200));
  }
  async stopShellSession(
    threadId: string,
    taskId: string,
  ): Promise<ShellSessionSummary> {
    const task = this.#shellTask(threadId, taskId);
    task.cancel(false);
    await task.observe(this.#options.shutdownWaitMs, true);
    return task.shellSummary();
  }

  readonly #resources = new Map<
    unknown,
    Map<Task, ToolResourceClaim["access"]>
  >();
  readonly #queue: { task: Task; claims: readonly ToolResourceClaim[] }[] = [];
  readonly #options: Required<Omit<ToolTaskOptions, "toolOutputSpool">> &
    Pick<ToolTaskOptions, "toolOutputSpool">;
  #closed = false;
  #closing: Promise<void> | undefined;
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

  /** Observation-only receipt; never consumes incremental output or a task. */
  status(threadId: string, taskId: string): ToolExecutionResult {
    const task = this.#tasks.get(taskId);
    if (task === undefined || task.threadId !== threadId)
      throw new Error("Tool task not found for this thread");
    return task.snapshot("");
  }

  /** Resolve and validate timing with the same precedence used by execution. */
  resolveTiming(
    runtime: ToolRuntime,
    invocation: Pick<ToolInvocation, "arguments" | "task">,
  ): { yieldTimeMs: number; timeoutMs: number } {
    const policy = runtime.taskPolicy;
    const timing = invocation.task;
    return {
      yieldTimeMs: integer(
        timing?.yieldTimeMs ??
          (policy?.timingArguments?.yieldTimeMs === undefined
            ? undefined
            : invocation.arguments[policy.timingArguments.yieldTimeMs]) ??
          policy?.yieldTimeMs ??
          this.#options.yieldTimeMs,
        "yield_time_ms",
        MAX_TOOL_YIELD_TIME_MS,
      ),
      timeoutMs: integer(
        timing?.timeoutMs ??
          (policy?.timingArguments?.timeoutMs === undefined
            ? undefined
            : invocation.arguments[policy.timingArguments.timeoutMs]) ??
          policy?.timeoutMs ??
          this.#options.timeoutMs,
        "timeout_ms",
        86400000,
      ),
    };
  }

  async run(
    runtime: ToolRuntime,
    invocation: ToolInvocation,
    execute: (invocation: ToolInvocation) => Promise<ToolExecutionResult>,
    options: {
      resourceKey?: unknown;
      resourceClaims?: readonly ToolResourceClaim[];
      release?: () => void;
    } = {},
  ): Promise<ToolExecutionResult> {
    if (this.#closed) throw new Error("Tool task manager is closed");
    invocation.signal.throwIfAborted();
    if (this.#tasks.size >= this.#options.maxTasks)
      throw new Error(
        `Tool task limit reached (${this.#options.maxTasks}); wait for or cancel an existing task`,
      );
    const policy = runtime.taskPolicy;
    const claims = normalizeResourceClaims(
      options.resourceClaims ??
        (options.resourceKey === undefined
          ? []
          : [{ key: options.resourceKey, access: "exclusive" }]),
    );
    const capacityBusy = this.#capacityBusy(runtime);
    const resourceBusy = !this.#claimsAvailable(claims);
    const queuedConflict = this.#queue.some((entry) =>
      claimsConflict(entry.claims, claims),
    );
    if (policy?.resourceQueue !== "fifo") {
      if (capacityBusy)
        throw new Error(
          "Tool execution capacity is busy; wait for or cancel an existing task",
        );
      if (resourceBusy || queuedConflict)
        throw new Error(
          "Tool resource is busy with a running or unconfirmed task; use wait before starting a conflicting operation",
        );
    }
    const { yieldTimeMs: yieldMs, timeoutMs } = this.resolveTiming(
      runtime,
      invocation,
    );
    // Observe the task's own signal so parent abort, terminate and deadline
    // cancellation all bound the guest wait without changing normal awaits.
    let task!: Task;
    task = new Task(runtime, invocation, execute, {
      ...this.#options,
      timeoutMs,
      onRelease: () => {
        this.#releaseClaims(task);
        this.#removeQueued(task);
        options.release?.();
        this.#dispatchQueued();
      },
      onExpire: () => {
        this.#archiveShell(task);
        this.#tasks.delete(task.id);
      },
    });
    this.#tasks.set(task.id, task);
    this.#invocations.add(invocation);
    const releaseObservation = task.acquireObservation();
    try {
      task.arm();
      if (!capacityBusy && !resourceBusy && !queuedConflict) {
        this.#dispatch(task, claims);
      } else {
        this.#queue.push({ task, claims });
        this.#dispatchQueued();
      }
      if (invocation.task?.waitForCompletion) {
        await new Promise<void>((resolve) => {
          let timer: NodeJS.Timeout | undefined;
          const done = () => {
            task.executionSignal.removeEventListener("abort", abort);
            if (timer !== undefined) clearTimeout(timer);
            resolve();
          };
          const abort = () => {
            timer ??= setTimeout(
              done,
              Math.min(300, this.#options.shutdownWaitMs),
            );
          };
          task.executionSignal.addEventListener("abort", abort, { once: true });
          if (task.executionSignal.aborted) abort();
          void task.completion.then(done);
        });
      } else await task.observe(yieldMs, true);
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
    if (terminate && task.humanTerminal)
      throw new Error(
        "Human terminals are read-only to the Agent; use the Terminal panel to stop this session",
      );
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
    const abort = () => {
      if (!task.humanTerminal) task.cancel(false);
    };
    invocation.signal.addEventListener("abort", abort, { once: true });
    try {
      if (task.humanTerminal) {
        await task.observe(yieldMs, terminate, invocation.signal);
        invocation.signal.throwIfAborted();
      } else await task.observe(yieldMs, terminate);
      const result = await task.drain(false);
      if (!task.yielded || finalResult(result)) await this.#consume(task);
      return result;
    } finally {
      invocation.signal.removeEventListener("abort", abort);
      releaseObservation();
    }
  }
  async #consume(task: Task) {
    this.#archiveShell(task);
    await task.shutdown();
    this.#tasks.delete(task.id);
  }
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    this.#closing = this.#closeTasks();
    return this.#closing;
  }
  async #closeTasks(): Promise<void> {
    const tasks = [...this.#tasks.values()];
    const started = Date.now();
    for (const task of tasks) task.cancel(false);
    const results = await Promise.all(
      tasks.map((task) => task.joinShutdown(started + task.shutdownWaitMs)),
    );
    const failures = tasks.flatMap((task, index) =>
      task.requiresCleanupJoin && (!results[index] || !task.terminal)
        ? [
            new Error(
              "Shell cleanup is unconfirmed; native ownership or cleanup did not settle successfully before the Host deadline",
            ),
          ]
        : [],
    );
    for (const task of tasks) await task.shutdown();
    this.#tasks.clear();
    this.#shellHistory.clear();
    this.#queue.splice(0);
    this.#resources.clear();
    if (failures.length > 0)
      throw new AggregateError(failures, "Host tool cleanup is unconfirmed");
  }

  #capacityBusy(runtime: ToolRuntime): boolean {
    return (
      !("executeComposite" in runtime) &&
      [...this.#tasks.values()].filter(
        (task) => task.dispatched && !task.terminal && !task.coordinator,
      ).length >= this.#options.maxRunningTasks
    );
  }

  #claimsAvailable(claims: readonly ToolResourceClaim[]): boolean {
    return claims.every((claim) => {
      const owners = this.#resources.get(claim.key);
      if (owners === undefined) return true;
      return [...owners.values()].every(
        (access) => access === "shared" && claim.access === "shared",
      );
    });
  }

  #dispatch(task: Task, claims: readonly ToolResourceClaim[]): void {
    if (this.#closed || task.terminal) return;
    for (const claim of claims) {
      let owners = this.#resources.get(claim.key);
      if (owners === undefined) {
        owners = new Map();
        this.#resources.set(claim.key, owners);
      }
      owners.set(task, claim.access);
    }
    task.dispatch();
  }

  #dispatchQueued(): void {
    if (this.#closed) return;
    for (let index = 0; index < this.#queue.length;) {
      const entry = this.#queue[index]!;
      if (entry.task.terminal) {
        this.#queue.splice(index, 1);
        continue;
      }
      const blockedByEarlierConflict = this.#queue
        .slice(0, index)
        .some((earlier) => claimsConflict(earlier.claims, entry.claims));
      if (
        !blockedByEarlierConflict &&
        !this.#capacityBusy(entry.task.runtime) &&
        this.#claimsAvailable(entry.claims)
      ) {
        this.#queue.splice(index, 1);
        this.#dispatch(entry.task, entry.claims);
        continue;
      }
      index++;
    }
  }

  #releaseClaims(task: Task): void {
    for (const [key, owners] of this.#resources) {
      owners.delete(task);
      if (owners.size === 0) this.#resources.delete(key);
    }
  }

  #removeQueued(task: Task): void {
    const index = this.#queue.findIndex((entry) => entry.task === task);
    if (index !== -1) this.#queue.splice(index, 1);
  }
}

class Task {
  readonly #createdAt = new Date().toISOString();
  #shellOutput = "";
  #shellOffset = 0;
  #shellControl: ShellTerminalControl | undefined;
  get humanTerminal() {
    return this.isShell && this.#invocation.userTerminal !== undefined;
  }
  get isShell() {
    return this.#runtime.shellSession === true && this.threadId !== undefined;
  }
  shellSummary(): ShellSessionSummary {
    return {
      taskId: this.id,
      threadId: this.threadId!,
      origin: this.#invocation.userTerminal ? "user" : "agent",
      kind: this.#invocation.userTerminal ? "terminal" : "command",
      command: this.#invocation.userTerminal
        ? "Interactive shell"
        : String(this.#invocation.arguments.command ?? ""),
      cwd: this.#invocation.cwd,
      createdAt: this.#createdAt,
      status: this.status,
      exitCode: this.terminal
        ? this.status === "cancelled"
          ? 130
          : this.status === "timed_out"
            ? 124
            : (this.#result?.exitCode ?? 1)
        : null,
      ...(this.#shellLifecycle === undefined
        ? {}
        : { lifecycle: { ...this.#shellLifecycle } }),
      inputAvailable:
        this.#invocation.userTerminal !== undefined &&
        this.#shellControl !== undefined &&
        this.status === "running",
      retained: false,
    };
  }
  shellRead(cursor?: unknown, limit = 32768): ShellSessionRead {
    const full = {
      session: this.shellSummary(),
      output: this.#shellOutput,
      cursor: this.#shellOffset + this.#shellOutput.length,
      truncated: this.#shellOffset > 0,
    };
    return sliceShellView(full, cursor, limit);
  }
  shellInput(): ShellTerminalControl {
    if (
      !this.#invocation.userTerminal ||
      !this.#shellControl ||
      this.status !== "running"
    )
      throw new Error("Only a running human terminal accepts input");
    return this.#shellControl;
  }
  #appendShellOutput(text: string) {
    if (!this.isShell || this.#closed) return;
    this.#shellOutput += text;
    let trim = Math.max(0, this.#shellOutput.length - 65536);
    if (trim && /[\uDC00-\uDFFF]/u.test(this.#shellOutput[trim]!)) trim++;
    this.#shellOutput = this.#shellOutput.slice(trim);
    this.#shellOffset += trim;
  }
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
  #modelContent: UserInput[number][] = [];
  #result: ToolExecutionResult | undefined;
  #shellLifecycle: ShellLifecycleFacts | undefined;
  #error: unknown;
  #settled = false;
  #dispatched = false;
  #cancelReason: "timeout" | "cancel" | undefined;
  #cancellationUnconfirmed = false;
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
  get runtime() {
    return this.#runtime;
  }
  get dispatched() {
    return this.#dispatched;
  }
  get executionSignal() {
    return this.#controller.signal;
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
      if (this.#cancellationUnconfirmed) return "cancellation_unconfirmed";
      if (this.#settled && !this.#dispatched)
        return this.#cancelReason === "timeout" ? "timed_out" : "cancelled";
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
      ? this.#dispatched
        ? "running"
        : "queued"
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
  get requiresCleanupJoin() {
    return this.#runtime.taskPolicy?.shutdownWaitMs !== undefined;
  }
  get shutdownWaitMs() {
    return integer(
      this.#runtime.taskPolicy?.shutdownWaitMs ?? this.#options.shutdownWaitMs,
      "shutdownWaitMs",
      60000,
    );
  }
  async joinShutdown(deadline: number): Promise<boolean> {
    if (this.#settled) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => resolve(false),
        Math.max(0, deadline - Date.now()),
      );
      void this.completion.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
  arm() {
    this.#invocation.signal.addEventListener("abort", this.#abort, {
      once: true,
    });
    // A human's interactive terminal is owned until exit/Stop/Host disposal.
    // Ordinary Agent executions retain their existing deadline unchanged.
    if (!this.humanTerminal) {
      this.#deadline = setTimeout(
        () => this.cancel(true),
        this.#options.timeoutMs,
      );
      this.#deadline.unref();
    }
    if (this.#invocation.signal.aborted) this.cancel(false);
  }
  dispatch() {
    if (this.#settled || this.#dispatched) return;
    this.#dispatched = true;
    let execution: Promise<ToolExecutionResult>;
    try {
      execution = Promise.resolve(
        this.#execute({
          ...this.#invocation,
          signal: this.#controller.signal,
          taskContext: {
            onCancellationUnconfirmed: () => {
              if (this.#closed) return;
              this.#cancellationUnconfirmed = true;
              this.#notify();
            },
            onShellControl: (control) => {
              if (
                this.isShell &&
                this.#invocation.userTerminal &&
                !this.#closed
              )
                this.#shellControl = control;
            },
            onShellOutput: (text) => this.#appendShellOutput(text),
            onShellLifecycle: (facts) => {
              if (this.#closed) return;
              this.#shellLifecycle = { ...facts };
            },
            onModelContent: (content) => {
              if (this.#closed) return;
              validateUserInput(content, "$modelContent");
              this.#modelContent.push(...structuredClone(content));
              this.#notify();
            },
            requestYield: () => {
              this.#yieldRequested = true;
              this.#notify();
            },
            onOutput: (text) => {
              if (this.#closed) return;
              if (!this.isShell && this.#invocation.traceOutput)
                void this.#invocation.traceOutput.write(
                  "task-output",
                  text,
                  "task-decoded-text",
                );
              this.#window.write(text);
              this.#notify();
            },
          },
        }),
      );
    } catch (error) {
      execution = Promise.reject(error);
    }
    execution
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
    if (!this.#dispatched) {
      this.#settled = true;
      if (this.#deadline !== undefined) clearTimeout(this.#deadline);
      this.#invocation.signal.removeEventListener("abort", this.#abort);
      this.#release();
      this.#complete();
    }
    this.#notify();
  }
  async observe(
    ms: number,
    cancelRequested = false,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      signal?.aborted ||
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
        signal?.removeEventListener("abort", done);
        resolve();
      }
      this.#listeners.add(changed);
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) done();
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
      const shellLifecycle = this.#shellLifecycle;
      this.#yieldRequested = false;
      const terminal = this.terminal;
      if (
        quiet &&
        this.#error !== undefined &&
        !this.#window.hasOutput &&
        this.#modelContent.length === 0
      )
        throw this.#error;
      const pendingContent = this.#modelContent;
      this.#modelContent = [];
      const originalResult = terminal ? this.#result : undefined;
      const modelContent = [
        ...pendingContent,
        ...(originalResult?.modelContent ?? []),
      ];
      const result =
        originalResult === undefined
          ? undefined
          : carryToolResultReferences(originalResult, {
              ...originalResult,
              ...(modelContent.length === 0 ? {} : { modelContent }),
            });
      const window = this.#window;
      this.#window = this.#newWindow();
      if (quiet && result !== undefined && !window.hasOutput) {
        await window.discard();
        return result;
      }
      let sourceTruncated = result?.sourceTruncated ?? false;
      if (result !== undefined) {
        const originalCapture = capturedToolOutput(result);
        if (originalCapture === undefined) window.write(result.output);
        else
          sourceTruncated =
            (await window.appendCapture(originalCapture)) || sourceTruncated;
      }
      let diagnostic = "";
      if (this.#error !== undefined && !this.#diagnosticReported) {
        this.#diagnosticReported = true;
        diagnostic =
          this.#error instanceof Error
            ? this.#error.message
            : String(this.#error);
      }
      const capture = await window.finish(sourceTruncated);
      if (quiet && result !== undefined && !window.hasOutput) return result;
      if (quiet && result !== undefined) {
        return attachToolOutputCapture(
          carryToolResultReferences(result, {
            ...result,
            output: capture.output,
          }),
          capture.metadata,
          toolOutputSuffix(result) ?? "",
        );
      }
      this.yielded = true;
      return this.#receipt(
        status,
        shellLifecycle,
        capture,
        result,
        modelContent,
        diagnostic,
      );
    } finally {
      release();
    }
  }
  snapshot(output: string): ToolExecutionResult {
    return this.#receipt(
      this.status,
      this.#shellLifecycle,
      { output: "" },
      undefined,
      undefined,
      output,
    );
  }
  #receipt(
    status: Status,
    shellLifecycle: ShellLifecycleFacts | undefined,
    capture: Awaited<ReturnType<ToolOutputWindow["finish"]>>,
    result?: ToolExecutionResult,
    modelContent = result?.modelContent,
    diagnostic = "",
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
      !this.#cancellationUnconfirmed &&
      this.#runtime.taskPolicy?.cancellation === "confirmed-on-settle"
        ? "confirmable"
        : "best_effort";
    const resourceScope =
      this.#runtime.resourceClaims !== undefined
        ? "claims"
        : (this.#runtime.taskPolicy?.resourceScope ??
          (this.#runtime.executionMode === "parallel_safe"
            ? "independent"
            : "bundle"));
    const foregroundExited =
      status === "running" &&
      shellLifecycle?.foreground === "exited" &&
      shellLifecycle.stdio === "open";
    const shellFacts =
      shellLifecycle === undefined
        ? ""
        : `\nforeground: ${shellLifecycle.foreground}\nstdio: ${shellLifecycle.stdio}${shellLifecycle.foreground === "exited" ? `\nforeground_exit_code: ${shellLifecycle.foreground_exit_code}\nforeground_signal: ${shellLifecycle.foreground_signal}` : ""}${foregroundExited ? "\nThe foreground exited; output pipes remain open. Continue wait to collect output, or terminate to cancel the owned process group (including intentional background processes on POSIX). Pipe-holder identities are unavailable." : ""}`;
    const timeoutMs = this.humanTerminal ? null : this.#options.timeoutMs;
    const control = `\n[tool task ${status}${foregroundExited ? " (foreground_exited)" : ""}]\ntask_id: ${this.id}\ntool_name: ${this.#runtime.name}\ntimeout_ms: ${timeoutMs ?? "none"}\ncancellation: ${cancellation}\nresource_scope: ${resourceScope}\nlifetime: host_instance${terminal ? `\nexit_code: ${exitCode}` : ""}${status === "cancellation_unconfirmed" ? "\nCancellation is unconfirmed; the underlying operation may still be running." : ""}${shellFacts}`;
    const receipt = attachToolOutputCapture(
      {
        output: capture.output,
        exitCode,
        contentType: TOOL_TASK_CONTENT_TYPE,
        structuredContent: {
          status,
          task_id: this.id,
          tool_name: this.#runtime.name,
          timeout_ms: timeoutMs,
          cancellation,
          resource_scope: resourceScope,
          lifetime: "host_instance",
          exit_code: terminal ? exitCode : null,
          ...shellLifecycle,
          ...(result?.structuredContent === undefined
            ? {}
            : { result: result.structuredContent }),
          ...(result?.contentType === undefined
            ? {}
            : { result_content_type: result.contentType }),
        },
        ...(modelContent === undefined || modelContent.length === 0
          ? {}
          : { modelContent }),
        ...(result?.sourceTruncated === undefined
          ? {}
          : { sourceTruncated: result.sourceTruncated }),
      },
      capture.metadata,
      diagnostic +
        (result === undefined ? "" : (toolOutputSuffix(result) ?? "")) +
        control,
    );
    return result === undefined
      ? receipt
      : carryToolResultReferences(result, receipt);
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
        "Tools, including run_code programs, automatically return task_id when they are queued or exceed their yield time; no separate background mode is required. wait returns when the task completes or yield_time_ms expires, with output produced since the previous receipt. Expiry does not stop the task; its execution deadline remains separate. Program-side await tools.* waits for the actual result. terminate requests cancellation; receipts report queued/running state, confirmable or best_effort cancellation, and resource_scope without exposing resource keys. Running claims/bundle/runtime resources stay busy; independent tasks can coexist. Only cancelled/timed_out confirm cancellation. Tasks belong to this Host instance and do not resume after restart. Local shell receipts may include independent foreground/stdio observations; foreground_exit_code is available after the direct process exits, even while status is running. Only running + foreground=exited + stdio=open derives foreground_exited, a nonterminal label. EOF alone is not completion; forced pipe closure is not observed EOF. terminate/timeout follows the originating Shell runtime's declared ownership scope (POSIX process group; Windows direct child unless the Host declares an identity-verified adapter). Escaped descendants may survive, and unconfirmed cleanup remains explicitly unconfirmed.",
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

function normalizeResourceClaims(
  claims: readonly ToolResourceClaim[],
): readonly ToolResourceClaim[] {
  const normalized = new Map<unknown, ToolResourceClaim["access"]>();
  for (const claim of claims) {
    if (claim.key === undefined)
      throw new Error("Tool resource claim key must not be undefined");
    if (claim.access !== "shared" && claim.access !== "exclusive")
      throw new Error("Tool resource claim access must be shared or exclusive");
    const previous = normalized.get(claim.key);
    normalized.set(
      claim.key,
      previous === "exclusive" || claim.access === "exclusive"
        ? "exclusive"
        : "shared",
    );
  }
  return [...normalized].map(([key, access]) => ({ key, access }));
}

function claimsConflict(
  left: readonly ToolResourceClaim[],
  right: readonly ToolResourceClaim[],
): boolean {
  return left.some((a) =>
    right.some(
      (b) =>
        sameMapKey(a.key, b.key) &&
        (a.access === "exclusive" || b.access === "exclusive"),
    ),
  );
}

function sameMapKey(left: unknown, right: unknown): boolean {
  return (
    left === right ||
    (typeof left === "number" &&
      typeof right === "number" &&
      Number.isNaN(left) &&
      Number.isNaN(right))
  );
}

function validateShellCursor(
  cursor: unknown,
): asserts cursor is number | undefined {
  if (
    cursor !== undefined &&
    (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0)
  )
    throw new Error("Invalid Shell output cursor");
}
function sliceShellView(
  full: ShellSessionRead,
  cursor?: unknown,
  limit = 32768,
): ShellSessionRead {
  validateShellCursor(cursor);
  const start = full.cursor - full.output.length;
  if (cursor !== undefined && cursor > full.cursor)
    throw new Error("Shell output cursor is ahead of this session");
  const offset = Math.max(start, cursor ?? start);
  let end = Math.min(full.cursor, offset + limit);
  if (end < full.cursor && /[\uDC00-\uDFFF]/u.test(full.output[end - start]!))
    end--;
  return {
    session: structuredClone(full.session),
    output: full.output.slice(offset - start, end - start),
    cursor: end,
    truncated: (cursor ?? 0) < start,
  };
}
