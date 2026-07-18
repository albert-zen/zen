import { describe, expect, it } from 'vitest';

import {
  AppServer,
  createDemoAppServer,
  ZenTuiApp,
  type AppServerClient,
  type AppServerNotificationListener,
  type AppServerRequestInput,
  type AppServerResponse,
  type ModelGateway,
  type ThreadSnapshot,
  type ToolRuntime,
} from './test-exports.js';
import { VirtualTerminalDevice, waitForRender } from './virtual-terminal.js';

async function waitForText(terminal: VirtualTerminalDevice, value: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (terminal.textOutput().includes(value)) return;
    await waitForRender();
  }
  throw new Error(`Timed out waiting for terminal text: ${value}`);
}

describe('ZenTuiApp', () => {
  it('starts a session-backed terminal app and handles slash commands', async () => {
    const terminal = new VirtualTerminalDevice(100, 20);
    const app = new ZenTuiApp({
      client: createDemoAppServer(),
      terminal,
    });
    const run = app.run();

    await waitForText(terminal, 'Zen Agent');
    expect(terminal.textOutput()).toContain('Zen Agent');
    expect(terminal.textOutput()).toContain('thread-1');

    terminal.sendInput('/status');
    terminal.sendInput('\r');
    await waitForRender();

    expect(terminal.textOutput()).toContain('Notice: thread: thread-1');

    terminal.sendInput('/exit');
    terminal.sendInput('\r');
    await run;
  });

  it('dispatches approval commands with the exact pending row tuple', async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const client = new ApprovalCommandClient();
    const app = new ZenTuiApp({ client, terminal });
    const run = app.run();

    await waitForRender();
    terminal.sendInput('/approve approval-1');
    terminal.sendInput('\r');
    await waitForRender();
    terminal.sendInput('/decline approval-1');
    terminal.sendInput('\r');
    await waitForRender();

    expect(client.approvalRequests).toEqual([
      { approvalId: 'approval-1', threadId: 'thread-1', turnId: 'turn-1', decision: 'approveOnce' },
      { approvalId: 'approval-1', threadId: 'thread-1', turnId: 'turn-1', decision: 'decline' },
    ]);

    terminal.sendInput('/exit');
    terminal.sendInput('\r');
    await run;
  });

  it('shows slash command suggestions while typing a command prefix', async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const app = new ZenTuiApp({
      client: createDemoAppServer(),
      terminal,
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput('/');
    await waitForRender();

    expect(terminal.textOutput()).toContain('Commands');
    expect(terminal.textOutput()).toContain('/status');
    expect(terminal.textOutput()).toContain('/resume');

    terminal.clearOutput();
    terminal.sendInput('res');
    await waitForRender();

    const text = terminal.textOutput();
    expect(text).toContain('/resume [query|number|thread-id]');
    expect(text).not.toContain('/interrupt');

    terminal.sendInput('\u0003');
    await run;
  });

  it('uses the slash command registry for help output', async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const app = new ZenTuiApp({
      client: createDemoAppServer(),
      terminal,
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput('/help');
    terminal.sendInput('\r');
    await waitForRender();

    expect(terminal.textOutput()).toContain('Notice: Commands');
    expect(terminal.textOutput()).toContain('/interrupt');
    expect(terminal.textOutput()).toContain('Cancel the active turn');

    terminal.sendInput('/exit');
    terminal.sendInput('\r');
    await run;
  });

  it('streams demo turn rows into the rendered transcript', async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const app = new ZenTuiApp({
      client: createDemoAppServer(),
      terminal,
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput('hello');
    terminal.sendInput('\r');
    await waitForText(terminal, 'hello');

    const text = terminal.textOutput();
    expect(text).toContain('You');
    expect(text).toContain('hello');
    expect(text).toContain('Zen');

    terminal.sendInput('/exit');
    terminal.sendInput('\r');
    await run;
  });

  it('does not expose protocol trace rows in the terminal transcript', async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const app = new ZenTuiApp({
      client: createDemoAppServer(),
      terminal,
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput('hello');
    terminal.sendInput('\r');
    await waitForText(terminal, 'hello');

    expect(terminal.textOutput()).not.toContain('assistant.message.started');
    expect(terminal.textOutput()).not.toContain('model.request.started');

    terminal.sendInput('/exit');
    terminal.sendInput('\r');
    await run;
  });

  it('renders collapsed shell rows while a command runs and completes', async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const shell = createShellAppServer();
    const app = new ZenTuiApp({
      client: shell.server,
      terminal,
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput('run tests');
    terminal.sendInput('\r');
    await shell.waitForStarted();
    await waitForText(terminal, 'Shell running: npm test');

    expect(terminal.textOutput()).toContain('Shell running: npm test');
    expect(terminal.textOutput()).toContain('stdout: started');

    terminal.clearOutput();
    shell.release();
    await waitForText(terminal, 'Shell completed (exit 0): npm test');

    expect(terminal.textOutput()).toContain('Shell completed (exit 0): npm test');
    expect(terminal.textOutput()).toContain('stdout: started done');

    terminal.sendInput('/exit');
    terminal.sendInput('\r');
    await run;
  });

  it('renders expanded shell output through the tools toggle', async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const shell = createShellAppServer({
      stderr: 'warn\n',
    });
    const app = new ZenTuiApp({
      client: shell.server,
      terminal,
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput('run tests');
    terminal.sendInput('\r');
    await shell.waitForStarted();
    shell.release();
    await waitForText(terminal, 'Shell completed (exit 0)');
    terminal.clearOutput();

    terminal.sendInput('/tools');
    terminal.sendInput('\r');
    await waitForRender();

    const text = terminal.textOutput();
    expect(text).toContain('Shell completed (exit 0)');
    expect(text).toContain('npm test');
    expect(text).toContain('stdout');
    expect(text).toContain('started');
    expect(text).toContain('done');
    expect(text).toContain('stderr');
    expect(text).toContain('warn');
    expect(text).not.toContain('toolCallId');
    expect(text).not.toContain('"content"');

    terminal.sendInput('/exit');
    terminal.sendInput('\r');
    await run;
  });

  it('shows queued input while a turn is running', async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const app = new ZenTuiApp({
      client: createSlowAppServer(60),
      terminal,
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput('first');
    terminal.sendInput('\r');
    terminal.sendInput('second');
    terminal.sendInput('\r');
    await waitForRender();

    expect(terminal.textOutput()).toContain('queued 1');

    terminal.sendInput('/exit');
    terminal.sendInput('\r');
    await run;
  });

  it('interrupts the active turn', async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const app = new ZenTuiApp({
      client: createSlowAppServer(1_000),
      terminal,
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput('slow');
    terminal.sendInput('\r');
    await waitForRender();
    terminal.sendInput('/interrupt');
    terminal.sendInput('\r');
    await waitForText(terminal, 'Interrupted current turn');

    expect(terminal.textOutput()).toContain('Interrupted current turn');

    terminal.sendInput('/exit');
    terminal.sendInput('\r');
    await run;
  });

  it('shows failed turn recovery and retries it with /retry', async () => {
    const terminal = new VirtualTerminalDevice(120, 40);
    const app = new ZenTuiApp({
      client: createFailThenRecoverAppServer(),
      terminal,
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput('recover me');
    terminal.sendInput('\r');
    await waitForText(terminal, 'Recoverable failed turn: model overloaded');

    let text = terminal.textOutput();
    expect(text).toContain('Recoverable failed turn: model overloaded');
    expect(text).toContain('Retry with /retry');

    terminal.clearOutput();
    terminal.sendInput('/retry');
    terminal.sendInput('\r');
    await waitForText(terminal, 'Recovered after retry');

    text = terminal.textOutput();
    expect(text).toContain('Retrying failed turn');
    expect(text).toContain('turns 2');
    expect(text).toContain('Recovered after retry');

    terminal.sendInput('/exit');
    terminal.sendInput('\r');
    await run;
  });

  it('retries an interrupted turn with /retry', async () => {
    const terminal = new VirtualTerminalDevice(120, 40);
    const app = new ZenTuiApp({
      client: createInterruptThenRecoverAppServer(),
      terminal,
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput('interrupt me');
    terminal.sendInput('\r');
    await waitForRender();
    terminal.sendInput('/interrupt');
    terminal.sendInput('\r');
    await waitForText(terminal, 'Recoverable canceled turn');

    expect(terminal.textOutput()).toContain('Recoverable canceled turn');
    expect(terminal.textOutput()).toContain('Retry with /retry');

    terminal.clearOutput();
    terminal.sendInput('/retry');
    terminal.sendInput('\r');
    await waitForText(terminal, 'Recovered interrupted turn');

    const text = terminal.textOutput();
    expect(text).toContain('Retrying canceled turn');
    expect(text).toContain('Recovered interrupted turn');
    expect(text).toContain('turns 2');

    terminal.sendInput('/exit');
    terminal.sendInput('\r');
    await run;
  });

  it('shows and accepts resume choices', async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const app = new ZenTuiApp({
      client: createDemoAppServer(),
      terminal,
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput('/new');
    terminal.sendInput('\r');
    await waitForRender();
    terminal.sendInput('/resume');
    terminal.sendInput('\r');
    await waitForRender();

    expect(terminal.textOutput()).toContain('Resume');
    expect(terminal.textOutput()).toContain('/resume <number>');

    terminal.sendInput('/resume 1');
    terminal.sendInput('\r');
    await waitForRender();

    expect(terminal.textOutput()).toContain('Resumed');

    terminal.sendInput('/exit');
    terminal.sendInput('\r');
    await run;
  });

  it('shows resume metadata and filters choices by query', async () => {
    const terminal = new VirtualTerminalDevice(120, 40);
    const app = new ZenTuiApp({
      client: new AppServer({
        threadManagerOptions: {
          initialThreads: [
            threadWithMessages({
              id: 'parser-thread',
              user: 'Fix parser bug',
              assistant: 'Parser patch is ready',
              updatedAtMs: 1000,
            }),
            threadWithMessages({
              id: 'resume-thread',
              user: 'Add resume picker',
              assistant: 'Thread history search is ready',
              updatedAtMs: 2000,
            }),
          ],
        },
      }),
      terminal,
    });
    const run = app.run();

    await waitForRender();
    terminal.clearOutput();
    terminal.sendInput('/resume picker');
    terminal.sendInput('\r');
    await waitForRender();

    const filtered = terminal.textOutput();
    expect(filtered).toContain('Resume');
    expect(filtered).toContain('1. resume-thread');
    expect(filtered).toContain('you: Add resume picker');
    expect(filtered).toContain('zen: Thread history search is ready');
    expect(filtered).not.toContain('2. parser-thread');

    terminal.clearOutput();
    terminal.sendInput('/resume 1');
    terminal.sendInput('\r');
    await waitForRender();

    const resumed = terminal.textOutput();
    expect(resumed).toContain('resume-thread | idle');
    expect(resumed).toContain('Resumed resume-thread');

    terminal.sendInput('/exit');
    terminal.sendInput('\r');
    await run;
  });

  it('renders helpful resume notices for empty and failed listings', async () => {
    const emptyTerminal = new VirtualTerminalDevice(100, 30);
    const emptyApp = new ZenTuiApp({
      client: new ResumeListClient({
        listResponse: {
          method: 'thread/list',
          ok: true,
          result: { threads: [], persistenceFailures: [] },
        },
      }),
      terminal: emptyTerminal,
    });
    const emptyRun = emptyApp.run();

    await waitForRender();
    emptyTerminal.sendInput('/resume');
    emptyTerminal.sendInput('\r');
    await waitForRender();

    expect(emptyTerminal.textOutput()).toContain(
      'No saved threads found. Unreadable saved thread files are skipped.'
    );

    emptyTerminal.sendInput('/exit');
    emptyTerminal.sendInput('\r');
    await emptyRun;

    const failedTerminal = new VirtualTerminalDevice(100, 30);
    const failedApp = new ZenTuiApp({
      client: new ResumeListClient({
        listResponse: {
          method: 'thread/list',
          ok: false,
          error: {
            code: 'REQUEST_FAILED',
            message: 'Could not read saved thread history',
          },
        },
      }),
      terminal: failedTerminal,
    });
    const failedRun = failedApp.run();

    await waitForRender();
    failedTerminal.sendInput('/resume');
    failedTerminal.sendInput('\r');
    await waitForRender();

    expect(failedTerminal.textOutput()).toContain(
      'Could not list saved threads: Could not read saved thread history'
    );

    failedTerminal.sendInput('/exit');
    failedTerminal.sendInput('\r');
    await failedRun;
  });
});

function createFailThenRecoverAppServer(): AppServer {
  let modelCalls = 0;
  const model: ModelGateway = {
    async *generate() {
      modelCalls += 1;

      if (modelCalls === 1) {
        yield { type: 'error', error: new Error('model overloaded') };
        return;
      }

      yield {
        type: 'message.completed',
        content: 'Recovered after retry',
      };
    },
  };

  return new AppServer({
    threadManagerOptions: {
      runtimeFactory: () => ({ model }),
    },
  });
}

function createInterruptThenRecoverAppServer(): AppServer {
  let modelCalls = 0;
  const model: ModelGateway = {
    async *generate(_context, _options, signal) {
      modelCalls += 1;

      if (modelCalls === 1) {
        await delay(1_000, signal);
        yield {
          type: 'message.completed',
          content: 'Should not complete before interrupt',
        };
        return;
      }

      yield {
        type: 'message.completed',
        content: 'Recovered interrupted turn',
      };
    },
  };

  return new AppServer({
    threadManagerOptions: {
      runtimeFactory: () => ({ model }),
    },
  });
}

function createSlowAppServer(delayMs: number): AppServer {
  const model: ModelGateway = {
    async *generate(_context, _options, signal) {
      await delay(delayMs, signal);
      yield {
        type: 'message.completed',
        content: 'done',
      };
    },
  };

  return new AppServer({
    threadManagerOptions: {
      runtimeFactory: () => ({ model }),
    },
  });
}

class ApprovalCommandClient implements AppServerClient {
  readonly approvalRequests: Array<{
    readonly approvalId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly decision: 'approveOnce' | 'decline';
  }> = [];

  async request(request: AppServerRequestInput): Promise<AppServerResponse> {
    if (request.method === 'thread/list') {
      return {
        method: 'thread/list',
        ok: true,
        result: { threads: [approvalThread()], persistenceFailures: [] },
      };
    }
    if (request.method === 'approval/resolve') {
      const params = request.params as {
        readonly approvalId: string;
        readonly threadId: string;
        readonly turnId: string;
        readonly decision: 'approveOnce' | 'decline';
      };
      this.approvalRequests.push(params);
      return {
        method: 'approval/resolve',
        ok: true,
        result: { approvalId: params.approvalId, decision: params.decision },
      };
    }
    return {
      method: request.method,
      ok: false,
      error: { code: 'UNKNOWN_METHOD', message: 'Unknown method' },
    };
  }

  subscribe(_listener: AppServerNotificationListener): () => void {
    return () => undefined;
  }
}

function approvalThread(): ThreadSnapshot {
  return {
    id: 'thread-1',
    status: 'running',
    turns: [{ id: 'turn-1', runId: 'run-1', status: 'inProgress', itemIds: ['approval-item'] }],
    items: [
      {
        id: 'approval-item',
        type: 'approval.requested',
        createdAtMs: 1000,
        seq: 1,
        runId: 'run-1',
        turnId: 'turn-1',
        payload: {
          approvalId: 'approval-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          runId: 'run-1',
          toolCallId: 'tool-1',
          toolName: 'shell',
          reason: 'Run command?',
        },
      },
    ],
  };
}

class ResumeListClient implements AppServerClient {
  private readonly thread: ThreadSnapshot = {
    id: 'current-thread',
    status: 'idle',
    turns: [],
    items: [],
  };

  constructor(
    private readonly options: {
      readonly listResponse: AppServerResponse;
    }
  ) {}

  async request(request: AppServerRequestInput): Promise<AppServerResponse> {
    if (request.method === 'thread/list') {
      return this.options.listResponse;
    }

    if (request.method === 'thread/start') {
      return {
        method: 'thread/start',
        ok: true,
        result: { thread: this.thread },
      };
    }

    if (request.method === 'thread/read') {
      return {
        method: 'thread/read',
        ok: true,
        result: { thread: this.thread },
      };
    }

    return {
      method: request.method,
      ok: false,
      error: {
        code: 'UNKNOWN_METHOD',
        message: `Unknown method: ${request.method}`,
      },
    };
  }

  subscribe(_listener: AppServerNotificationListener): () => void {
    return () => undefined;
  }
}

function threadWithMessages(options: {
  readonly id: string;
  readonly user: string;
  readonly assistant: string;
  readonly updatedAtMs: number;
}): ThreadSnapshot {
  const turnId = `${options.id}-turn`;
  const runId = `${options.id}-run`;

  return {
    id: options.id,
    status: 'idle',
    turns: [
      {
        id: turnId,
        runId,
        status: 'completed',
        itemIds: [`${options.id}-user`, `${options.id}-assistant`],
      },
    ],
    items: [
      {
        id: `${options.id}-user`,
        type: 'user.message.completed',
        createdAtMs: options.updatedAtMs - 1,
        seq: 1,
        runId,
        turnId,
        payload: { content: options.user },
      },
      {
        id: `${options.id}-assistant`,
        type: 'assistant.message.completed',
        createdAtMs: options.updatedAtMs,
        seq: 2,
        runId,
        turnId,
        payload: { content: options.assistant },
      },
    ],
  };
}

function createShellAppServer(options: { readonly stderr?: string } = {}): {
  readonly server: AppServer;
  readonly waitForStarted: () => Promise<void>;
  readonly release: () => void;
} {
  let generatedToolCall = false;
  const started = deferred<void>();
  const completion = deferred<void>();
  const model: ModelGateway = {
    async *generate() {
      if (!generatedToolCall) {
        generatedToolCall = true;
        yield {
          type: 'message.completed',
          content: 'Running tests.',
          toolCalls: [
            {
              id: 'call-shell-1',
              name: 'shell',
              input: { command: 'npm test' },
            },
          ],
        };
        return;
      }

      yield {
        type: 'message.completed',
        content: 'Done.',
      };
    },
  };
  const toolRuntime: ToolRuntime = {
    async *execute() {
      yield {
        type: 'output.delta',
        delta: { stream: 'stdout', chunk: 'started\n' },
      };
      started.resolve();
      await completion.promise;
      yield {
        type: 'output.delta',
        delta: { stream: 'stdout', chunk: 'done\n' },
      };
      if (options.stderr) {
        yield {
          type: 'output.delta',
          delta: { stream: 'stderr', chunk: options.stderr },
        };
      }
      yield {
        type: 'result.completed',
        content: [
          'exitCode: 0',
          'stdout:',
          'started',
          'done',
          options.stderr ? `stderr:\n${options.stderr.trimEnd()}` : undefined,
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n'),
      };
    },
  };

  return {
    server: new AppServer({
      threadManagerOptions: {
        runtimeFactory: () => ({ model, toolRuntime }),
      },
    }),
    waitForStarted: () => started.promise,
    release: () => completion.resolve(),
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function delay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new Error('aborted'));
      },
      { once: true }
    );
  });
}
