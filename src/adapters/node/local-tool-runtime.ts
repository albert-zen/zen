import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { OwnedProcessTree, type OwnedProcessIdentity } from './owned-process-cleanup.js';
import {
  ApprovalBroker,
  ToolApprovalDeniedError,
  toToolApprovalRequest,
} from '../../product/index.js';
import type {
  ToolCallPayload,
  ToolExecutionContext,
  ToolRuntime,
  ToolRuntimeEvent,
} from '../../kernel/index.js';

export type LocalToolRuntimeOptions = {
  readonly cwd?: string;
  readonly shellTimeoutMs?: number;
  /** Required for real shell execution; injected by AppServer's provider runtime. */
  readonly approvalBroker?: ApprovalBroker;
};

export const localToolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description:
        'Run a PowerShell command in the workspace. Use this for reading files, searching with rg, editing files, and running tests.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
] as const;

export class LocalToolRuntime implements ToolRuntime {
  private readonly cwd: string;
  private readonly shellTimeoutMs: number;
  private readonly approvalBroker?: ApprovalBroker;

  constructor(options: LocalToolRuntimeOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.shellTimeoutMs = options.shellTimeoutMs ?? 30_000;
    this.approvalBroker = options.approvalBroker;
  }

  async *execute(
    call: ToolCallPayload,
    context: ToolExecutionContext
  ): AsyncIterable<ToolRuntimeEvent> {
    try {
      yield* this.executeCall(call, context);
    } catch (error) {
      yield { type: 'error', error };
    }
  }

  private async *executeCall(
    call: ToolCallPayload,
    context: ToolExecutionContext
  ): AsyncIterable<ToolRuntimeEvent> {
    const input = readObject(call.input);

    if (call.name === 'shell') {
      const command = readString(input.command, 'command');
      const broker = this.approvalBroker;
      if (!broker) {
        throw new Error('LocalToolRuntime requires an ApprovalBroker before shell execution');
      }
      const pending = broker.request({
        threadId: context.threadId ?? '',
        call,
        runId: context.runId,
        turnId: context.turnId,
        startedItemId: context.startedItem.id,
        reason: 'Shell commands require explicit approval',
      });
      yield { type: 'approval.requested', request: toToolApprovalRequest(pending.request) };
      const decision = await pending.decision;
      yield {
        type: 'approval.resolved',
        request: toToolApprovalRequest(pending.request),
        decision,
      };
      if (decision.type === 'decline') {
        yield {
          type: 'error',
          error: new ToolApprovalDeniedError(decision.reason ?? 'approval declined'),
        };
        return;
      }
      yield* this.runShell(command, context);
      return;
    }

    throw new Error(`Unknown tool: ${call.name}`);
  }

  private async *runShell(
    command: string,
    context: ToolExecutionContext
  ): AsyncIterable<ToolRuntimeEvent> {
    if (context.signal?.aborted) {
      yield { type: 'error', error: new Error('Shell command canceled') };
      return;
    }

    const queue: ToolRuntimeEvent[] = [];
    let wake: (() => void) | undefined;
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let done = false;
    let spawnError: unknown;
    let canceled = false;
    let timedOut = false;
    const processHolder: {
      child?: ReturnType<typeof spawn>;
      ownership?: OwnedProcessTree;
    } = {};
    let terminationRequested = false;
    let cleanupRequiresCapturedOwnership = false;
    const rootCapture: { task?: Promise<boolean> } = {};
    let bootstrapBuffer = '';
    let resolveBootstrap: ((captured: boolean) => void) | undefined;
    let cleanupTask: Promise<void> | undefined;
    let cleanupFailure: unknown;

    const wakeConsumer = () => {
      wake?.();
      wake = undefined;
    };
    const push = (event: ToolRuntimeEvent) => {
      queue.push(event);
      wakeConsumer();
    };
    const onStdout = (chunk: Buffer | string) => {
      const text = stringifyOutput(chunk);
      if (resolveBootstrap) {
        bootstrapBuffer += text;
        const newline = bootstrapBuffer.indexOf('\n');
        if (newline < 0) return;
        const frame = bootstrapBuffer.slice(0, newline).trim();
        const remainder = bootstrapBuffer.slice(newline + 1);
        const resolve = resolveBootstrap;
        resolveBootstrap = undefined;
        try {
          const encoded = frame.startsWith('__ZEN_OWNER__:') ? frame.slice(14) : '';
          const identity = readAttestedIdentity(
            JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')),
            ownerMarker,
            child.pid ?? 0,
            powershellPath
          );
          resolve(
            identity !== undefined && (processHolder.ownership?.captureAttested(identity) ?? false)
          );
        } catch {
          resolve(false);
        }
        if (!remainder) return;
        stdout += remainder;
        push({ type: 'output.delta', delta: { stream: 'stdout', chunk: remainder } });
        return;
      }
      stdout += text;
      push({ type: 'output.delta', delta: { stream: 'stdout', chunk: text } });
    };
    const onStderr = (chunk: Buffer | string) => {
      const text = stringifyOutput(chunk);
      stderr += text;
      push({ type: 'output.delta', delta: { stream: 'stderr', chunk: text } });
    };
    const finish = () => {
      done = true;
      if (timeout) clearTimeout(timeout);
      wakeConsumer();
    };
    const startCleanup = (requiresCapturedOwnership: boolean): Promise<void> => {
      terminationRequested ||= requiresCapturedOwnership;
      cleanupRequiresCapturedOwnership ||= requiresCapturedOwnership;
      if (!processHolder.child) return Promise.resolve();
      cleanupTask ??= (async () => {
        if (process.platform !== 'win32') {
          processHolder.child?.kill('SIGTERM');
          return;
        }
        if (cleanupRequiresCapturedOwnership) processHolder.child?.kill('SIGTERM');
        const captured = await rootCapture.task;
        if (!captured) {
          if (cleanupRequiresCapturedOwnership) {
            throw new Error('Shell cleanup could not capture the owned PowerShell root identity');
          }
          return;
        }
        await processHolder.ownership?.terminateVerified();
      })();
      // Event handlers cannot await cleanup. Retain the error and wake the generator;
      // the terminal path below always awaits this same task before reporting success.
      cleanupTask.catch((error: unknown) => {
        cleanupFailure ??= error;
        finish();
      });
      return cleanupTask;
    };
    const cancel = () => {
      canceled = true;
      startCleanup(true).catch(() => undefined);
    };

    // Register cancellation before spawn; the holder safely no-ops until ownership is captured.
    context.signal?.addEventListener('abort', cancel, { once: true });
    const ownerMarker = `zen-local-${randomUUID()}`;
    const powershellPath = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const encodedCommand = Buffer.from(command, 'utf8').toString('base64');
    const wrappedCommand = `$m='${ownerMarker}';$c='${encodedCommand}';$p=[Diagnostics.Process]::GetCurrentProcess();$parentPid=(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId;$o=[ordered]@{marker=$m;pid=$PID;parentPid=$parentPid;createdAt=$p.StartTime.ToUniversalTime().ToString('o');creationToken=$p.StartTime.ToUniversalTime().Ticks.ToString();executable=$p.MainModule.FileName;commandLine=[Environment]::CommandLine};[Console]::Out.WriteLine('__ZEN_OWNER__:'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($o|ConvertTo-Json -Compress))));[Console]::Out.Flush();$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($c));& ([ScriptBlock]::Create($s))`;
    const child = spawn(powershellPath, ['-NoProfile', '-Command', wrappedCommand], {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ownership = new OwnedProcessTree({
      pid: child.pid ?? 0,
      marker: ownerMarker,
      executable: powershellPath,
    });
    processHolder.child = child;
    processHolder.ownership = ownership;
    rootCapture.task = new Promise<boolean>((resolve) => {
      resolveBootstrap = resolve;
    });
    rootCapture.task.catch((error: unknown) => {
      cleanupFailure ??= error;
      if (terminationRequested) finish();
    });
    if (terminationRequested) startCleanup(true).catch(() => undefined);
    const timeout = setTimeout(() => {
      timedOut = true;
      startCleanup(true).catch(() => undefined);
    }, this.shellTimeoutMs);

    if (!child.stdout || !child.stderr) {
      throw new Error('PowerShell child did not expose output streams');
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('error', (error) => {
      spawnError = error;
      finish();
    });
    child.on('close', (code) => {
      exitCode = code;
      resolveBootstrap?.(false);
      resolveBootstrap = undefined;
      finish();
      startCleanup(false).catch(() => undefined);
    });
    try {
      while (!done || queue.length > 0) {
        const event = queue.shift();

        if (event) {
          yield event;
          continue;
        }

        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener('abort', cancel);

      if (!done) {
        try {
          await startCleanup(true);
        } catch (error) {
          cleanupFailure ??= error;
        }
      }
    }

    if (cleanupTask) {
      try {
        await cleanupTask;
      } catch (error) {
        cleanupFailure ??= error;
      }
    }

    if (spawnError) {
      if (cleanupFailure) {
        yield {
          type: 'error',
          error: new AggregateError([spawnError, cleanupFailure], 'Shell spawn and cleanup failed'),
        };
        return;
      }
      yield { type: 'error', error: spawnError };
      return;
    }

    if (canceled) {
      if (cleanupFailure) {
        yield {
          type: 'error',
          error: new AggregateError(
            [new Error('Shell command canceled'), cleanupFailure],
            'Shell cancellation cleanup failed'
          ),
        };
        return;
      }
      yield { type: 'error', error: new Error('Shell command canceled') };
      return;
    }

    if (timedOut) {
      if (cleanupFailure) {
        yield {
          type: 'error',
          error: new AggregateError(
            [new Error(`Shell command timed out after ${this.shellTimeoutMs}ms`), cleanupFailure],
            'Shell timeout cleanup failed'
          ),
        };
        return;
      }
      yield {
        type: 'error',
        error: new Error(`Shell command timed out after ${this.shellTimeoutMs}ms`),
      };
      return;
    }

    if (cleanupFailure) {
      yield { type: 'error', error: cleanupFailure };
      return;
    }

    yield {
      type: 'result.completed',
      content: formatShellResult({ exitCode, stdout, stderr }),
    };
  }
}

type ExecFileResult = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function formatShellResult(result: ExecFileResult): string {
  return [
    `exitCode: ${result.exitCode}`,
    result.stdout ? `stdout:\n${result.stdout.trimEnd()}` : undefined,
    result.stderr ? `stderr:\n${result.stderr.trimEnd()}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function readObject(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function readString(value: unknown, label: string): string {
  if (typeof value === 'string') {
    return value;
  }

  throw new Error(`${label} must be a string`);
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }

  return value === undefined || value === null ? '' : String(value);
}

function readAttestedIdentity(
  value: unknown,
  marker: string,
  pid: number,
  executable: string
): OwnedProcessIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const integer = (key: string) =>
    typeof record[key] === 'number' && Number.isSafeInteger(record[key]) ? record[key] : undefined;
  const text = (key: string) =>
    typeof record[key] === 'string' && record[key] ? record[key] : undefined;
  const attestedPid = integer('pid');
  const parentPid = integer('parentPid');
  const createdAt = text('createdAt');
  const creationToken = text('creationToken');
  const frameExecutable = text('executable');
  const commandLine = text('commandLine');
  if (
    record.marker !== marker ||
    attestedPid !== pid ||
    parentPid === undefined ||
    !createdAt ||
    !creationToken ||
    !/^\d+$/.test(creationToken) ||
    !frameExecutable ||
    !commandLine?.includes(marker) ||
    frameExecutable.toLowerCase() !== executable.toLowerCase()
  )
    return undefined;
  return {
    pid: attestedPid,
    parentPid,
    createdAt,
    creationToken,
    executable: frameExecutable,
    commandLine,
  };
}
