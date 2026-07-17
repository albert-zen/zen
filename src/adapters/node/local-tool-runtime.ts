import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { OwnedProcessTree } from './owned-process-cleanup.js';
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
    const terminateOwnedTree = () => {
      terminationRequested = true;
      if (process.platform !== 'win32') {
        processHolder.child?.kill('SIGTERM');
        return;
      }
      void processHolder.ownership?.terminateVerified();
    };
    const cancel = () => {
      canceled = true;
      terminateOwnedTree();
    };

    // Register cancellation before spawn; the holder safely no-ops until ownership is captured.
    context.signal?.addEventListener('abort', cancel, { once: true });
    const child = spawn('powershell', ['-NoProfile', '-Command', command], {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ownership = new OwnedProcessTree(child.pid ?? 0);
    processHolder.child = child;
    processHolder.ownership = ownership;
    void ownership.captureRoot().then(() => {
      if (terminationRequested) void processHolder.ownership?.terminateVerified();
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateOwnedTree();
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
      finish();
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
        terminateOwnedTree();
      }
    }

    if (spawnError) {
      yield { type: 'error', error: spawnError };
      return;
    }

    if (canceled) {
      yield { type: 'error', error: new Error('Shell command canceled') };
      return;
    }

    if (timedOut) {
      yield {
        type: 'error',
        error: new Error(`Shell command timed out after ${this.shellTimeoutMs}ms`),
      };
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
