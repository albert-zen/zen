import { randomUUID } from "node:crypto";
import { open, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  readZenXConnectionDescriptor,
  ZenXProtocolClient,
  type ModelSummary,
  type ServerNotificationMethod,
  type ServerNotificationParams,
  type Turn,
} from "../src/protocol-client/index.js";

const DEFAULT_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 1_800_000;
const MAX_TRIALS = 20;
const INTERRUPT_GRACE_MS = 10_000;
const taskFile = fileURLToPath(
  new URL("../evals/browser-computer/tasks.json", import.meta.url),
);

const notificationMethods = [
  "zen/thread/event",
  "model/catalog/updated",
  "thread/started",
  "thread/name/updated",
  "thread/archived",
  "thread/unarchived",
  "thread/settings/updated",
  "thread/queue/updated",
  "turn/started",
  "item/started",
  "item/agentMessage/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/completed",
  "serverRequest/resolved",
  "turn/completed",
  "error",
] as const satisfies readonly ServerNotificationMethod[];

interface EvaluationTask {
  id: string;
  prompt: string;
}

interface TaskFile {
  tasks: EvaluationTask[];
}

export interface RunnerOptions {
  descriptor: string;
  model: string;
  baseUrl: string;
  taskId: string;
  output: string;
  trials: number;
  timeoutMs: number;
}

interface TerminalEvent {
  method: "turn/completed";
  params: ServerNotificationParams["turn/completed"];
}

interface TrialResult {
  taskId: string;
  trial: number;
  runId: string;
  modelRequested: string;
  modelResolved: Pick<ModelSummary, "id" | "model" | "displayName">;
  startedAt: string;
  elapsedMs: number;
  threadId: string | null;
  turnId: string | null;
  terminalReceived: boolean;
  completed: boolean;
  timedOut: boolean;
  interruptRequested: boolean;
  interruptAcknowledged: boolean;
  terminalAfterInterrupt: boolean;
  terminalTurn: Turn | null;
  error: { name: string; message: string } | null;
  controlTimeout: string | null;
  threadSnapshot: unknown;
  eventsFile: string;
}

export function parseRunnerArgs(args: readonly string[]): RunnerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") throw new HelpRequested();
    if (!flag?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${flag ?? "<missing>"}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (values.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    values.set(flag, value);
    index += 1;
  }

  const known = new Set([
    "--descriptor",
    "--model",
    "--base-url",
    "--task",
    "--output",
    "--trials",
    "--timeout-ms",
  ]);
  for (const flag of values.keys()) {
    if (!known.has(flag)) throw new Error(`Unknown option: ${flag}`);
  }

  const trials = parseBoundedInteger(
    values.get("--trials") ?? "1",
    "--trials",
    1,
    MAX_TRIALS,
  );
  const timeoutMs = parseBoundedInteger(
    values.get("--timeout-ms") ?? String(DEFAULT_TIMEOUT_MS),
    "--timeout-ms",
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const baseUrl = requireOption(values, "--base-url");
  validateFixtureUrl(baseUrl);

  return {
    descriptor: path.resolve(requireOption(values, "--descriptor")),
    model: requireOption(values, "--model"),
    baseUrl: baseUrl.replace(/\/$/, ""),
    taskId: requireOption(values, "--task"),
    output: path.resolve(requireOption(values, "--output")),
    trials,
    timeoutMs,
  };
}

export function resolveRequestedModel(
  models: readonly ModelSummary[],
  requested: string,
): ModelSummary {
  const matches = models.filter(
    (candidate) =>
      candidate.id === requested ||
      candidate.model === requested ||
      candidate.displayName === requested,
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    const available = models
      .map((candidate) => `${candidate.displayName} (${candidate.id})`)
      .join(", ");
    throw new Error(
      `Model ${JSON.stringify(requested)} did not exactly match a model/list label or id. Available: ${available || "<none>"}`,
    );
  }
  throw new Error(
    `Model ${JSON.stringify(requested)} is ambiguous across ${String(matches.length)} model/list entries; pass an exact unique id`,
  );
}

export function buildEvaluationPrompt(
  task: EvaluationTask,
  baseUrl: string,
  sessionId: string,
): string {
  const taskPrompt = task.prompt.replaceAll("{baseUrl}", baseUrl);
  if (taskPrompt.includes("{baseUrl}")) {
    throw new Error(`Task ${task.id} contains an unresolved {baseUrl}`);
  }
  return [
    taskPrompt,
    "",
    "Evaluation constraints: Do not use shell commands, direct HTTP requests, fixture-source file reads, or arbitrary page JavaScript to solve this task. Use the normal Browser tools to observe and act.",
    "If this harness routes Browser tool calls through code execution, use code only as transport for those Browser calls. You may view screenshots produced by Browser observations.",
    `Use a fresh browser session with sessionId ${sessionId}.`,
    "After acting, make a final Browser observation and report what it shows.",
  ].join("\n");
}

async function main(): Promise<void> {
  let options: RunnerOptions;
  try {
    options = parseRunnerArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      console.log(usage());
      return;
    }
    throw error;
  }

  const task = await readBrowserTask(options.taskId);
  await mkdir(options.output);
  const evaluationWorkspace = path.join(options.output, "workspace");
  await mkdir(evaluationWorkspace);
  const descriptor = await readZenXConnectionDescriptor(options.descriptor);
  const client = await connectWithTimeout(
    {
      url: descriptor.url,
      bearerTokenFile: descriptor.authentication.tokenFile,
      clientInfo: {
        name: "zenx-browser-computer-model-eval",
        title: "ZenX browser/computer model evaluation",
        version: "0.1.0",
      },
      reconnect: { maxAttempts: 1 },
    },
    controlTimeoutMs(options),
  );

  const results: TrialResult[] = [];
  try {
    const catalog = await within(
      client.request("model/list", {}),
      controlTimeoutMs(options),
      "model/list",
    );
    const resolvedModel = resolveRequestedModel(catalog.data, options.model);
    await writeJsonExclusive(path.join(options.output, "run.json"), {
      taskId: task.id,
      trials: options.trials,
      timeoutMs: options.timeoutMs,
      modelRequested: options.model,
      modelResolved: modelIdentity(resolvedModel),
      workspace: "workspace",
      createdAt: new Date().toISOString(),
      note: "Protocol evidence only; semantic pass/fail requires evaluator review.",
    });

    for (let trial = 1; trial <= options.trials; trial += 1) {
      const result = await runTrial(
        client,
        options,
        task,
        resolvedModel,
        trial,
        evaluationWorkspace,
      );
      results.push(result);
      console.log(
        JSON.stringify({
          taskId: result.taskId,
          trial: result.trial,
          threadId: result.threadId,
          turnId: result.turnId,
          elapsedMs: result.elapsedMs,
          terminalReceived: result.terminalReceived,
          completed: result.completed,
          timedOut: result.timedOut,
          interruptRequested: result.interruptRequested,
          resultFile: path.join(
            options.output,
            `${artifactStem(task.id, trial)}.result.json`,
          ),
        }),
      );
      if (
        (result.timedOut && !result.terminalReceived) ||
        result.controlTimeout !== null
      )
        break;
    }

    await writeJsonExclusive(path.join(options.output, "summary.json"), {
      taskId: task.id,
      modelRequested: options.model,
      modelResolved: modelIdentity(resolvedModel),
      trials: results.map((result) => ({
        trial: result.trial,
        threadId: result.threadId,
        turnId: result.turnId,
        elapsedMs: result.elapsedMs,
        completed: result.completed,
        timedOut: result.timedOut,
        interruptRequested: result.interruptRequested,
        terminalTurnStatus: result.terminalTurn?.status ?? null,
        terminalReceived: result.terminalReceived,
        error: result.error,
        controlTimeout: result.controlTimeout,
      })),
      stoppedEarly:
        results.length < options.trials
          ? "A trial did not reach a safe terminal protocol state; later trials were not started."
          : null,
      note: "No semantic outcome is assigned automatically.",
    });
  } finally {
    client.close();
  }
}

async function runTrial(
  client: ZenXProtocolClient,
  options: RunnerOptions,
  task: EvaluationTask,
  resolvedModel: ModelSummary,
  trial: number,
  evaluationWorkspace: string,
): Promise<TrialResult> {
  const stem = artifactStem(task.id, trial);
  const eventsPath = path.join(options.output, `${stem}.events.jsonl`);
  const resultPath = path.join(options.output, `${stem}.result.json`);
  const eventLog = await open(eventsPath, "wx");
  const runId = `${task.id.toLowerCase()}-${trial}-${randomUUID()}`;
  const startedAtDate = new Date();
  const startedAtMs = Date.now();
  let threadId: string | null = null;
  let turnId: string | null = null;
  let terminalReceived = false;
  let completed = false;
  let timedOut = false;
  let interruptRequested = false;
  let interruptAcknowledged = false;
  let terminalAfterInterrupt = false;
  let terminalTurn: Turn | null = null;
  let resultError: Error | null = null;
  let controlTimeout: string | null = null;
  let threadSnapshot: unknown = null;
  const terminal = deferred<TerminalEvent>();
  const disposers: Array<() => void> = [];
  let eventWrites = Promise.resolve();
  let eventWriteError: Error | null = null;
  const bufferedNotifications: Array<{
    threadId: string | null;
    line: string;
  }> = [];

  try {
    for (const method of notificationMethods) {
      disposers.push(
        registerNotification(client, method, async (params) => {
          const sourceThreadId = notificationThreadId(params);
          const line = `${JSON.stringify({ at: new Date().toISOString(), method, params })}\n`;
          if (threadId === null) {
            bufferedNotifications.push({ threadId: sourceThreadId, line });
            return;
          }
          if (sourceThreadId !== threadId) return;
          eventWrites = eventWrites
            .then(async () => {
              await eventLog.appendFile(line, "utf8");
            })
            .catch((error: unknown) => {
              eventWriteError ??= asError(error);
            });
          await eventWrites;
          if (method === "turn/completed") {
            const completedParams =
              params as ServerNotificationParams["turn/completed"];
            if (turnId === null || completedParams.turn.id === turnId) {
              terminal.resolve({ method, params: completedParams });
            }
          }
        }),
      );
    }

    const started = await within(
      client.request("thread/start", {
        cwd: evaluationWorkspace,
        model: resolvedModel.model,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
      controlTimeoutMs(options),
      "thread/start",
    );
    threadId = started.thread.id;
    for (const notification of bufferedNotifications) {
      if (notification.threadId !== threadId) continue;
      eventWrites = eventWrites
        .then(async () => {
          await eventLog.appendFile(notification.line, "utf8");
        })
        .catch((error: unknown) => {
          eventWriteError ??= asError(error);
        });
    }
    bufferedNotifications.length = 0;

    const prompt = buildEvaluationPrompt(task, options.baseUrl, runId);
    const startedTurn = await within(
      client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        clientUserMessageId: runId,
      }),
      controlTimeoutMs(options),
      "turn/start",
    );
    turnId = startedTurn.turn.id;

    const deadline = await raceWithTimeout(terminal.promise, options.timeoutMs);
    if (deadline.timedOut) {
      timedOut = true;
      interruptRequested = true;
      try {
        await within(
          client.request("turn/interrupt", { threadId, turnId }),
          controlTimeoutMs(options),
          "turn/interrupt",
        );
        interruptAcknowledged = true;
      } catch (error) {
        resultError = asError(error);
        if (error instanceof ControlTimeoutError)
          controlTimeout = error.operation;
      }
      const afterInterrupt = await raceWithTimeout(
        terminal.promise,
        INTERRUPT_GRACE_MS,
      );
      if (!afterInterrupt.timedOut) {
        terminalAfterInterrupt = true;
        terminalReceived = true;
        terminalTurn = afterInterrupt.value.params.turn;
      }
    } else {
      terminalReceived = true;
      terminalTurn = deadline.value.params.turn;
    }
    completed = terminalTurn?.status === "completed";
  } catch (error) {
    resultError = asError(error);
    if (error instanceof ControlTimeoutError) controlTimeout = error.operation;
  } finally {
    if (threadId !== null) {
      try {
        threadSnapshot = await within(
          client.request("thread/read", {
            threadId,
            includeTurns: true,
          }),
          controlTimeoutMs(options),
          "thread/read",
        );
      } catch (error) {
        resultError ??= asError(error);
        if (error instanceof ControlTimeoutError)
          controlTimeout ??= error.operation;
      }
    }
    for (const dispose of disposers) dispose();
    await eventWrites;
    resultError ??= eventWriteError;
    await eventLog.close();
  }

  const result: TrialResult = {
    taskId: task.id,
    trial,
    runId,
    modelRequested: options.model,
    modelResolved: modelIdentity(resolvedModel),
    startedAt: startedAtDate.toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    threadId,
    turnId,
    terminalReceived,
    completed,
    timedOut,
    interruptRequested,
    interruptAcknowledged,
    terminalAfterInterrupt,
    terminalTurn,
    error:
      resultError === null
        ? null
        : { name: resultError.name, message: resultError.message },
    controlTimeout,
    threadSnapshot,
    eventsFile: path.basename(eventsPath),
  };
  await writeJsonExclusive(resultPath, result);
  return result;
}

function registerNotification<M extends ServerNotificationMethod>(
  client: ZenXProtocolClient,
  method: M,
  handler: (params: ServerNotificationParams[M]) => void | Promise<void>,
): () => void {
  return client.onNotification(method, handler);
}

async function readBrowserTask(taskId: string): Promise<EvaluationTask> {
  if (!/^B\d+$/.test(taskId)) {
    throw new Error(`Only browser task ids such as B1 or B6 are supported`);
  }
  const parsed = JSON.parse(await readFile(taskFile, "utf8")) as TaskFile;
  const task = parsed.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined || typeof task.prompt !== "string") {
    throw new Error(`Browser task ${taskId} was not found in ${taskFile}`);
  }
  return task;
}

function modelIdentity(
  model: ModelSummary,
): Pick<ModelSummary, "id" | "model" | "displayName"> {
  return { id: model.id, model: model.model, displayName: model.displayName };
}

function notificationThreadId(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const direct = (params as { threadId?: unknown }).threadId;
  if (typeof direct === "string") return direct;
  const thread = (params as { thread?: { id?: unknown } }).thread;
  return typeof thread?.id === "string" ? thread.id : null;
}

async function connectWithTimeout(
  options: Parameters<typeof ZenXProtocolClient.connect>[0],
  timeoutMs: number,
): Promise<ZenXProtocolClient> {
  let abandoned = false;
  const connecting = ZenXProtocolClient.connect(options).then((client) => {
    if (abandoned) client.close();
    return client;
  });
  try {
    return await within(connecting, timeoutMs, "connect");
  } catch (error) {
    abandoned = true;
    void connecting.catch(() => undefined);
    if (error instanceof ControlTimeoutError) {
      // connect() does not expose its client until initialization finishes, so
      // a stuck initialization has no handle to close. This CLI must exit to
      // let the OS close that pending socket and preserve the runtime bound.
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ControlTimeoutError(operation, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function controlTimeoutMs(options: RunnerOptions): number {
  return Math.min(30_000, options.timeoutMs);
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function parseBoundedInteger(
  raw: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${String(minimum)} through ${String(maximum)}`,
    );
  }
  return value;
}

function requireOption(values: Map<string, string>, name: string): string {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}

function validateFixtureUrl(raw: string): void {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--base-url must use http:// or https://");
  }
  if (url.username || url.password) {
    throw new Error("--base-url must not contain credentials");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("--base-url must identify the loopback evaluation fixture");
  }
}

function artifactStem(taskId: string, trial: number): string {
  return `${taskId.toLowerCase()}-trial-${String(trial).padStart(2, "0")}`;
}

async function writeJsonExclusive(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class HelpRequested extends Error {}

class ControlTimeoutError extends Error {
  constructor(
    readonly operation: string,
    timeoutMs: number,
  ) {
    super(`${operation} timed out after ${String(timeoutMs)} ms`);
    this.name = "ControlTimeoutError";
  }
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx apps/zenx/scripts/browser-computer-model-eval.ts \\",
    "    --descriptor <app-server.json> --model <exact label-or-id> \\",
    "    --base-url <fixture-url> --task <B task id> --output <private-directory> \\",
    "    [--trials 1] [--timeout-ms 600000]",
  ].join("\n");
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    console.error(asError(error).message);
    process.exitCode = 1;
  });
}
