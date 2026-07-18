import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalToolRuntime, localToolDefinitions } from './test-exports.js';
import { ApprovalBroker } from './test-exports.js';

const localToolTempPrefix = 'zen-tools-';
const localToolTempRoots = new Set<string>();

afterEach(async () => {
  const roots = [...localToolTempRoots];
  localToolTempRoots.clear();
  const results = await Promise.allSettled(
    roots.map(async (root) => await rm(root, { recursive: true, force: true }))
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0)
    throw new AggregateError(failures, 'Local tool test temp cleanup failed');
});

describe('LocalToolRuntime', () => {
  it('exposes shell as the only local workspace tool', () => {
    expect(localToolDefinitions.map((definition) => definition.function.name)).toEqual(['shell']);
  });

  it('runs shell commands in the workspace and returns command output', async () => {
    const cwd = createLocalToolTempRoot();
    const { runtime, broker } = createApprovedRuntime(cwd);

    await expect(runTool(runtime, broker, 'shell', { command: 'Write-Output ok' })).resolves.toBe(
      'exitCode: 0\nstdout:\nok'
    );
  });

  it('returns non-zero shell exits as normal tool results with stderr evidence', async () => {
    const { runtime, broker } = createApprovedRuntime(createLocalToolTempRoot());

    await expect(
      runTool(runtime, broker, 'shell', {
        command: 'Write-Error bad; exit 7',
      })
    ).resolves.toContain('exitCode: 7');
  });

  it('preserves comments, quotes, multiline blocks, and marker-like user output', async () => {
    const { runtime, broker } = createApprovedRuntime(createLocalToolTempRoot());
    const result = await runTool(runtime, broker, 'shell', {
      command:
        'Write-Output ok # trailing comment\n& { Write-Output "{ quoted zen-local-marker-like }" }',
    });

    expect(result).toContain('ok');
    expect(result).toContain('{ quoted zen-local-marker-like }');
    expect(result).not.toContain('__ZEN_OWNER__:');
  });

  it('streams shell stdout and stderr before the command completes', async () => {
    const { runtime, broker } = createApprovedRuntime(createLocalToolTempRoot());
    const execution = runtime.execute(
      {
        id: 'call-shell',
        name: 'shell',
        input: {
          command:
            "[Console]::Out.WriteLine('first'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 200; [Console]::Error.WriteLine('warn'); [Console]::Error.Flush(); [Console]::Out.WriteLine('second')",
        },
      },
      createContext()
    );
    const iterator = execution[Symbol.asyncIterator]();

    const requested = await iterator.next();
    expect(requested).toEqual({
      done: false,
      value: expect.objectContaining({ type: 'approval.requested' }),
    });
    resolvePending(broker);
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: expect.objectContaining({ type: 'approval.resolved' }),
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'output.delta',
        delta: { stream: 'stdout', chunk: expect.stringContaining('first') },
      },
    });
    const nextAfterFirst = iterator.next();

    await expect(
      Promise.race([nextAfterFirst.then(() => 'settled'), delay(50).then(() => 'pending')])
    ).resolves.toBe('pending');

    const remaining = await collectRemaining(iterator, nextAfterFirst);

    expect(
      remaining.filter((event) => event.type === 'output.delta').map((event) => event.delta)
    ).toEqual(
      expect.arrayContaining([
        { stream: 'stderr', chunk: expect.stringContaining('warn') },
        { stream: 'stdout', chunk: expect.stringContaining('second') },
      ])
    );
    expect(remaining.at(-1)).toEqual({
      type: 'result.completed',
      content: expect.stringContaining('exitCode: 0'),
    });
  });

  it('cancels a running shell command through the tool execution signal', async () => {
    const { runtime, broker } = createApprovedRuntime(createLocalToolTempRoot());
    const controller = new AbortController();
    const execution = runtime.execute(
      {
        id: 'call-shell',
        name: 'shell',
        input: {
          command:
            "[Console]::Out.WriteLine('started'); [Console]::Out.Flush(); Start-Sleep -Seconds 10",
        },
      },
      createContext({ signal: controller.signal })
    );
    const iterator = execution[Symbol.asyncIterator]();

    await iterator.next();
    resolvePending(broker);
    await iterator.next();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'output.delta',
        delta: { stream: 'stdout', chunk: expect.stringContaining('started') },
      },
    });

    controller.abort();

    const remaining = await collectRemaining(iterator);

    expect(remaining).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({ message: 'Shell command canceled' }),
      },
    ]);
  });

  it('reports unknown tool names as tool errors', async () => {
    const runtime = new LocalToolRuntime({
      cwd: createLocalToolTempRoot(),
    });

    const events = await collect(
      runtime.execute({ id: 'call-missing', name: 'missing', input: {} }, createContext())
    );

    expect(events).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({ message: 'Unknown tool: missing' }),
      },
    ]);
  });
});

function createLocalToolTempRoot(): string {
  const tempParent = resolve(tmpdir());
  const root = resolve(mkdtempSync(join(tempParent, localToolTempPrefix)));
  if (dirname(root) !== tempParent || !basename(root).startsWith(localToolTempPrefix)) {
    throw new Error(`Unsafe local tool test temp root: ${root}`);
  }
  localToolTempRoots.add(root);
  return root;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectRemaining<T>(
  iterator: AsyncIterator<T>,
  pending?: Promise<IteratorResult<T>>
): Promise<readonly T[]> {
  const events: T[] = [];
  const first = await pending;

  if (first && !first.done) {
    events.push(first.value);
  }

  while (true) {
    const next = await iterator.next();

    if (next.done) {
      return events;
    }

    events.push(next.value);
  }
}

async function collect<T>(events: AsyncIterable<T>): Promise<readonly T[]> {
  const collected: T[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}

async function runTool(
  runtime: LocalToolRuntime,
  broker: ApprovalBroker,
  name: string,
  input: unknown
): Promise<unknown> {
  const events = [];

  const execution = runtime.execute({ id: `call-${name}`, name, input }, createContext());
  const iterator = execution[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (!first.done && first.value.type === 'approval.requested') resolvePending(broker);
  for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
    events.push(event);
  }

  const result = events.find((event) => event.type === 'result.completed');

  if (!result || result.type !== 'result.completed') {
    throw new Error('tool did not complete');
  }

  return result.content;
}

function createContext(options: { readonly signal?: AbortSignal } = {}) {
  return {
    runId: 'run-1',
    turnId: 'turn-1',
    signal: options.signal,
    assistantItem: {
      id: 'assistant-1',
      type: 'assistant.message.completed',
      createdAtMs: 1000,
      seq: 1,
      runId: 'run-1',
      turnId: 'turn-1',
      payload: {},
    },
    startedItem: {
      id: 'tool-1',
      type: 'tool.call.started',
      createdAtMs: 1000,
      seq: 2,
      runId: 'run-1',
      turnId: 'turn-1',
      payload: {},
    },
  } as const;
}

function createApprovedRuntime(cwd: string): {
  readonly runtime: LocalToolRuntime;
  readonly broker: ApprovalBroker;
} {
  const broker = new ApprovalBroker();
  const runtime = new LocalToolRuntime({ cwd, approvalBroker: broker });
  return { runtime, broker };
}

function resolvePending(broker: ApprovalBroker): void {
  const pending = broker.listPending()[0]?.request;
  if (!pending) throw new Error('Expected a pending approval');
  broker.resolve({
    approvalId: pending.id,
    threadId: pending.threadId,
    turnId: pending.turnId,
    decision: { type: 'approveOnce' },
  });
}
