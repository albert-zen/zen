import { describe, expect, it } from 'vitest';

import type { Item, ItemAppendInput, ToolRuntime } from '../packages/framework/src/kernel/index.js';
import {
  ApprovalBroker,
  DEFAULT_ZEN_SYSTEM_PROMPT,
  threadToolDefinitions,
  type ThreadRecord,
  type TurnExecutorInput,
  type TurnRecord,
} from '../packages/framework/src/product/index.js';
import type {
  CodexAppServerNotification,
  CodexAppServerRequestHandler,
} from '../packages/framework/src/adapters/node/codex-app-server-client.js';
import {
  CodexAppServerClosedError,
  CodexProviderService,
  type CodexProviderClient,
} from '../packages/framework/src/adapters/node/index.js';
import { CodexTurnExecutor } from '../packages/framework/src/adapters/node/codex-turn-executor.js';

describe('CodexTurnExecutor', () => {
  it('creates one durable handle, streams completion, unloads it, and resumes it on the next Zen turn', async () => {
    const client = new FakeCodexClient();
    const service = new CodexProviderService({ clientFactory: async () => client });
    const executor = new CodexTurnExecutor({
      provider: service,
      cwd: 'D:\\workspace',
      model: 'thread-model',
      threadTools: completedToolRuntime(),
      threadToolDefinitions,
    });
    const first = createTurnInput('zen-thread', 'run-1', 'turn-1', 'first message');

    const firstRun = executor.run(first.input);
    await waitFor(() => client.startTurnInputs.length === 1);
    const firstProviderTurn = client.startTurnInputs[0]!;
    expect(firstProviderTurn).not.toHaveProperty('sandboxPolicy');
    client.emit({
      method: 'item/agentMessage/delta',
      params: { threadId: firstProviderTurn.threadId, turnId: 'provider-turn-1', delta: 'Hel' },
    });
    client.emit({
      method: 'turn/completed',
      params: {
        threadId: firstProviderTurn.threadId,
        turn: {
          id: 'provider-turn-1',
          status: 'completed',
          items: [{ type: 'agentMessage', id: 'agent-1', text: 'Hello' }],
        },
      },
    });
    await expect(firstRun).resolves.toEqual({ yielded: false });

    expect(client.startThreadInputs).toEqual([
      expect.objectContaining({
        cwd: 'D:\\workspace',
        model: 'thread-model',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        ephemeral: false,
      }),
    ]);
    expect(client.startThreadInputs[0]!.dynamicTools).toEqual(
      threadToolDefinitions.map((definition) => ({
        type: 'function',
        name: `zen_${definition.function.name.replace('.', '_')}`,
        description: definition.function.description,
        inputSchema: definition.function.parameters,
      }))
    );
    expect(client.startThreadInputs[0]!.dynamicTools).toHaveLength(8);
    expect(
      (client.startThreadInputs[0]!.dynamicTools as readonly { readonly name: string }[]).every(
        (tool) => /^[a-zA-Z0-9_-]+$/.test(tool.name)
      )
    ).toBe(true);
    expect(client.startThreadInputs[0]).toMatchObject({
      baseInstructions: DEFAULT_ZEN_SYSTEM_PROMPT,
      developerInstructions: DEFAULT_ZEN_SYSTEM_PROMPT,
    });
    expect(first.items.map((item) => item.type)).toEqual(
      expect.arrayContaining([
        'internal.codex.provider-thread',
        'assistant.message.delta',
        'assistant.message.completed',
        'turn.completed',
      ])
    );
    expect(client.unsubscribed).toEqual(['provider-thread-1']);
    expect(client.closeCalls).toBe(0);

    const second = createTurnInput('zen-thread', 'run-2', 'turn-2', 'second message', first.items);
    const secondRun = executor.run(second.input);
    await waitFor(() => client.startTurnInputs.length === 2);
    const secondProviderTurn = client.startTurnInputs[1]!;
    expect(client.resumeInputs).toEqual([
      expect.objectContaining({ threadId: 'provider-thread-1', model: 'thread-model' }),
    ]);
    expect(secondProviderTurn.input).toEqual([
      { type: 'text', text: 'second message', text_elements: [] },
    ]);
    client.emit({
      method: 'turn/completed',
      params: {
        threadId: secondProviderTurn.threadId,
        turn: { id: 'provider-turn-2', status: 'completed', items: [] },
      },
    });
    await expect(secondRun).resolves.toEqual({ yielded: false });
    expect(client.unsubscribed).toEqual(['provider-thread-1', 'provider-thread-1']);

    await service.close();
    expect(client.closeCalls).toBe(1);
  });

  it('buffers same-batch completion and dynamic-tool requests until startTurn routing is bound', async () => {
    const client = new FakeCodexClient();
    const service = new CodexProviderService({ clientFactory: async () => client });
    let earlyTool: Promise<unknown> | undefined;
    client.beforeStartTurnReturn = (input, providerTurnId) => {
      client.emit({
        method: 'item/agentMessage/delta',
        params: { threadId: input.threadId, turnId: providerTurnId, delta: 'Early' },
      });
      earlyTool = client.serverRequest('item/tool/call', {
        threadId: input.threadId,
        turnId: providerTurnId,
        callId: 'early-tool',
        tool: 'zen_thread_list',
        arguments: {},
      });
      client.emit({
        method: 'turn/completed',
        params: {
          threadId: input.threadId,
          turn: {
            id: providerTurnId,
            status: 'completed',
            items: [{ type: 'agentMessage', id: 'early-agent', text: 'Early completion' }],
          },
        },
      });
    };
    const executor = new CodexTurnExecutor({
      provider: service,
      cwd: 'D:\\workspace',
      threadTools: completedToolRuntime(),
      threadToolDefinitions,
    });
    const turn = createTurnInput('zen-early', 'run-early', 'turn-early', 'early');

    await expect(executor.run(turn.input)).resolves.toEqual({ yielded: false });
    await expect(earlyTool).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: '{"threadId":"zen-early"}' }],
    });
    expect(turn.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'assistant.message.delta' }),
        expect.objectContaining({
          type: 'assistant.message.completed',
          payload: { content: 'Early completion' },
        }),
        expect.objectContaining({ type: 'tool.call.started' }),
        expect.objectContaining({ type: 'tool.result.completed' }),
      ])
    );
    await service.close();
  });

  it('holds an early native approval request until startTurn routing is bound', async () => {
    const client = new FakeCodexClient();
    const service = new CodexProviderService({ clientFactory: async () => client });
    const broker = new ApprovalBroker({ generateId: () => 'early-approval' });
    let earlyApproval: Promise<unknown> | undefined;
    client.beforeStartTurnReturn = (input, providerTurnId) => {
      earlyApproval = client.serverRequest('item/commandExecution/requestApproval', {
        threadId: input.threadId,
        turnId: providerTurnId,
        itemId: 'early-command',
        command: 'git status',
        cwd: 'D:\\workspace',
      });
    };
    const executor = new CodexTurnExecutor({
      provider: service,
      cwd: 'D:\\workspace',
      threadTools: completedToolRuntime(),
      threadToolDefinitions,
      approvalBroker: broker,
    });
    const turn = createTurnInput('zen-early-approval', 'run-approval', 'turn-approval', 'approve');
    const running = executor.run(turn.input);

    await waitFor(() => turn.items.some((entry) => entry.type === 'approval.requested'));
    broker.resolve({
      approvalId: 'early-approval',
      threadId: 'zen-early-approval',
      turnId: 'turn-approval',
      decision: { type: 'approveOnce' },
    });
    await expect(earlyApproval).resolves.toEqual({ decision: 'accept' });
    client.emit({
      method: 'turn/completed',
      params: {
        threadId: 'provider-thread-1',
        turn: { id: 'provider-turn-1', status: 'completed', items: [] },
      },
    });
    await expect(running).resolves.toEqual({ yielded: false });
    await service.close();
  });

  it('replaces an invalid provider handle and rehydrates canonical Zen history only then', async () => {
    const client = new FakeCodexClient();
    client.resumeFailure = new Error('provider thread is gone');
    const service = new CodexProviderService({ clientFactory: async () => client });
    const executor = new CodexTurnExecutor({
      provider: service,
      cwd: 'D:\\workspace',
      threadTools: completedToolRuntime(),
      threadToolDefinitions,
    });
    const initial = [
      item('internal.codex.provider-thread', 'old-run', 'old-turn', {
        providerThreadId: 'stale-provider-thread',
      }),
      item('user.message.completed', 'old-run', 'old-turn', { content: 'earlier user message' }),
      item('assistant.message.completed', 'old-run', 'old-turn', { content: 'earlier answer' }),
    ];
    const turn = createTurnInput('zen-thread', 'run-3', 'turn-3', 'current message', initial);

    const running = executor.run(turn.input);
    await waitFor(() => client.startTurnInputs.length === 1);
    expect(client.resumeInputs).toEqual([
      expect.objectContaining({ threadId: 'stale-provider-thread' }),
    ]);
    expect(client.startThreadInputs).toHaveLength(1);
    expect(client.startTurnInputs[0]!.input).toEqual([
      {
        type: 'text',
        text: 'Zen canonical conversation history:\nUser: earlier user message\nAssistant: earlier answer',
        text_elements: [],
      },
      { type: 'text', text: 'current message', text_elements: [] },
    ]);
    client.emit({
      method: 'turn/completed',
      params: {
        threadId: 'provider-thread-1',
        turn: { id: 'provider-turn-1', status: 'completed', items: [] },
      },
    });
    await running;
    expect(
      turn.items.filter((entry) => entry.type === 'internal.codex.provider-thread')
    ).toHaveLength(2);
  });

  it('does not persist a replacement handle until its first rehydrating startTurn is accepted', async () => {
    const client = new FakeCodexClient();
    client.resumeFailure = new Error('provider thread is gone');
    client.startTurnFailure = new Error('turn/start rejected');
    const service = new CodexProviderService({ clientFactory: async () => client });
    const executor = new CodexTurnExecutor({
      provider: service,
      cwd: 'D:\\workspace',
      threadTools: completedToolRuntime(),
      threadToolDefinitions,
    });
    const initial = [
      item('internal.codex.provider-thread', 'old-run', 'old-turn', {
        providerThreadId: 'stale-provider-thread',
      }),
      item('user.message.completed', 'old-run', 'old-turn', { content: 'earlier message' }),
    ];
    const failed = createTurnInput(
      'zen-thread',
      'run-failed',
      'turn-failed',
      'first attempt',
      initial
    );

    await expect(executor.run(failed.input)).rejects.toThrow('turn/start rejected');
    expect(failed.items.filter((entry) => entry.type === 'internal.codex.provider-thread')).toEqual(
      [initial[0]]
    );

    const retry = createTurnInput(
      'zen-thread',
      'run-retry',
      'turn-retry',
      'retry attempt',
      failed.items
    );
    const retrying = executor.run(retry.input);
    await waitFor(() => client.startTurnInputs.length === 2);
    expect(client.resumeInputs).toEqual([
      expect.objectContaining({ threadId: 'stale-provider-thread' }),
      expect.objectContaining({ threadId: 'stale-provider-thread' }),
    ]);
    expect(client.startThreadInputs).toHaveLength(2);
    expect(client.startTurnInputs[1]!.input).toEqual([
      {
        type: 'text',
        text: 'Zen canonical conversation history:\nUser: earlier message\nUser: first attempt',
        text_elements: [],
      },
      { type: 'text', text: 'retry attempt', text_elements: [] },
    ]);
    client.emit({
      method: 'turn/completed',
      params: {
        threadId: 'provider-thread-2',
        turn: { id: 'provider-turn-2', status: 'completed', items: [] },
      },
    });
    await expect(retrying).resolves.toEqual({ yielded: false });
    expect(
      retry.items
        .filter((entry) => entry.type === 'internal.codex.provider-thread')
        .map((entry) => (entry.payload as { readonly providerThreadId: string }).providerThreadId)
    ).toEqual(['stale-provider-thread', 'provider-thread-2']);
    await service.close();
  });

  it('routes dynamic tools by provider thread and turn, preserves yielded waits, and interrupts on abort', async () => {
    const client = new FakeCodexClient();
    const service = new CodexProviderService({ clientFactory: async () => client });
    const routedToolNames: string[] = [];
    const first = createTurnInput('zen-one', 'run-1', 'turn-1', 'one');
    const second = createTurnInput('zen-two', 'run-2', 'turn-2', 'two');
    const firstExecutor = new CodexTurnExecutor({
      provider: service,
      cwd: 'D:\\one',
      threadTools: completedToolRuntime((name) => routedToolNames.push(name)),
      threadToolDefinitions,
    });
    const secondExecutor = new CodexTurnExecutor({
      provider: service,
      cwd: 'D:\\two',
      threadTools: yieldedToolRuntime(),
      threadToolDefinitions,
    });

    const firstRun = firstExecutor.run(first.input);
    const secondRun = secondExecutor.run(second.input);
    await waitFor(() => client.startTurnInputs.length === 2);

    await expect(
      client.serverRequest('item/tool/call', {
        threadId: 'provider-thread-1',
        turnId: 'provider-turn-1',
        callId: 'call-1',
        tool: 'zen_thread_list',
        arguments: {},
      })
    ).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: '{"threadId":"zen-one"}' }],
    });
    await expect(
      client.serverRequest('item/tool/call', {
        threadId: 'provider-thread-2',
        turnId: 'provider-turn-2',
        callId: 'call-2',
        tool: 'zen_thread_wait',
        arguments: {},
      })
    ).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: '{"waiting":true}' }],
    });
    expect(routedToolNames).toEqual(['thread.list']);
    expect(client.interrupts).toContainEqual({
      threadId: 'provider-thread-2',
      turnId: 'provider-turn-2',
    });

    client.emit({
      method: 'turn/completed',
      params: {
        threadId: 'provider-thread-1',
        turn: { id: 'provider-turn-1', status: 'completed', items: [] },
      },
    });
    client.emit({
      method: 'turn/completed',
      params: {
        threadId: 'provider-thread-2',
        turn: { id: 'provider-turn-2', status: 'interrupted', items: [] },
      },
    });
    await expect(firstRun).resolves.toEqual({ yielded: false });
    await expect(secondRun).resolves.toEqual({ yielded: true });
    expect(second.items.map((entry) => entry.type)).toContain('turn.yielded');

    const aborted = createTurnInput('zen-abort', 'run-3', 'turn-3', 'abort');
    const abortExecutor = new CodexTurnExecutor({
      provider: service,
      cwd: 'D:\\abort',
      threadTools: completedToolRuntime(),
      threadToolDefinitions,
    });
    const abortRun = abortExecutor.run(aborted.input);
    await waitFor(() => client.startTurnInputs.length === 3);
    aborted.controller.abort();
    await expect(abortRun).resolves.toEqual({ yielded: false });
    expect(client.interrupts).toContainEqual({
      threadId: 'provider-thread-3',
      turnId: 'provider-turn-3',
    });

    await expect(
      client.serverRequest('item/permissions/requestApproval', {
        threadId: 'provider-thread-3',
        turnId: 'provider-turn-3',
      })
    ).rejects.toThrow('Zen does not bridge this Codex approval request; request denied');

    await service.close();
  });

  it('bridges scoped command approval through the Zen ApprovalBroker', async () => {
    const client = new FakeCodexClient();
    const service = new CodexProviderService({ clientFactory: async () => client });
    const broker = new ApprovalBroker({ generateId: () => 'approval-1' });
    const executor = new CodexTurnExecutor({
      provider: service,
      cwd: 'D:\\workspace',
      threadTools: completedToolRuntime(),
      threadToolDefinitions,
      approvalBroker: broker,
    });
    const turn = createTurnInput('zen-approval', 'run-approval', 'turn-approval', 'approve');
    const running = executor.run(turn.input);
    await waitFor(() => client.startTurnInputs.length === 1);

    const approval = client.serverRequest('item/commandExecution/requestApproval', {
      threadId: 'provider-thread-1',
      turnId: 'provider-turn-1',
      itemId: 'command-item-1',
      command: 'git status',
      cwd: 'D:\\workspace',
      reason: 'Inspect status',
    });
    await waitFor(() => turn.items.some((entry) => entry.type === 'approval.requested'));
    broker.resolve({
      approvalId: 'approval-1',
      threadId: 'zen-approval',
      turnId: 'turn-approval',
      decision: { type: 'approveOnce' },
    });
    await expect(approval).resolves.toEqual({ decision: 'accept' });

    client.emit({
      method: 'turn/completed',
      params: {
        threadId: 'provider-thread-1',
        turn: { id: 'provider-turn-1', status: 'completed', items: [] },
      },
    });
    await running;
    await service.close();
  });

  it('fails an active Turn on child exit and lazily recreates one client for a later Turn', async () => {
    const firstClient = new FakeCodexClient();
    const secondClient = new FakeCodexClient();
    const clients = [firstClient, secondClient];
    let starts = 0;
    const service = new CodexProviderService({
      clientFactory: async () => clients[starts++]!,
    });
    const executor = new CodexTurnExecutor({
      provider: service,
      cwd: 'D:\\workspace',
      threadTools: completedToolRuntime(),
      threadToolDefinitions,
    });
    const interrupted = createTurnInput('zen-exit', 'run-exit', 'turn-exit', 'first');
    const running = executor.run(interrupted.input);
    await waitFor(() =>
      interrupted.items.some((entry) => entry.type === 'internal.codex.provider-thread')
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    firstClient.exit(new CodexAppServerClosedError('Codex App Server exited (code 17)'));

    await expect(running).rejects.toThrow('Codex App Server exited (code 17)');
    expect(starts).toBe(1);
    const later = createTurnInput(
      'zen-exit',
      'run-later',
      'turn-later',
      'second',
      interrupted.items
    );
    const laterRun = executor.run(later.input);
    await waitFor(() => secondClient.startTurnInputs.length === 1);
    secondClient.emit({
      method: 'turn/completed',
      params: {
        threadId: 'provider-thread-1',
        turn: { id: 'provider-turn-1', status: 'completed', items: [] },
      },
    });
    await expect(laterRun).resolves.toEqual({ yielded: false });
    expect(starts).toBe(2);
    expect(firstClient.closeCalls).toBe(0);
    await service.close();
    expect(secondClient.closeCalls).toBe(1);
  });
});

function createTurnInput(
  threadId: string,
  runId: string,
  turnId: string,
  content: string,
  initial: readonly Item[] = []
): {
  readonly input: TurnExecutorInput & { readonly signal: AbortSignal };
  readonly items: Item[];
  readonly controller: AbortController;
} {
  const items = [...initial];
  const turn: TurnRecord = { id: turnId, runId, status: 'inProgress', itemIds: [] };
  const thread: ThreadRecord = { id: threadId, status: 'running', turns: [turn], items };
  let next = items.length + 1;
  const controller = new AbortController();
  const input: TurnExecutorInput & { signal: AbortSignal } = {
    threadSnapshot: { id: threadId, status: 'running', turns: [turn], items: [] },
    threadRecord: thread,
    turnSnapshot: turn,
    turnRecord: turn,
    input: content,
    signal: controller.signal,
    appendItem: async (entry: ItemAppendInput) => {
      const appended = item(entry.type, entry.runId, entry.turnId, entry.payload, {
        id: `item-${next++}`,
        visibility: entry.visibility,
        causeId: entry.causeId,
        targetId: entry.targetId,
      });
      items.push(appended);
      return appended;
    },
  };
  return { input, items, controller };
}

function item(
  type: string,
  runId: string,
  turnId: string,
  payload: unknown,
  overrides: Partial<Item> = {}
): Item {
  return {
    id: overrides.id ?? `${type}-${runId}-${turnId}`,
    type,
    createdAtMs: 0,
    seq: 0,
    runId,
    turnId,
    payload,
    ...(overrides.visibility === undefined ? {} : { visibility: overrides.visibility }),
    ...(overrides.causeId === undefined ? {} : { causeId: overrides.causeId }),
    ...(overrides.targetId === undefined ? {} : { targetId: overrides.targetId }),
  };
}

function completedToolRuntime(onCall?: (name: string) => void): ToolRuntime {
  return {
    async *execute(call, context) {
      onCall?.(call.name);
      yield { type: 'result.completed', content: { threadId: context.threadId } };
    },
  };
}

function yieldedToolRuntime(): ToolRuntime {
  return {
    async *execute() {
      yield { type: 'execution.yielded', content: { waiting: true } };
    },
  };
}

class FakeCodexClient implements CodexProviderClient {
  readonly command = 'C:\\Codex\\codex.exe';
  readonly startThreadInputs: Record<string, unknown>[] = [];
  readonly resumeInputs: Record<string, unknown>[] = [];
  readonly startTurnInputs: Record<string, unknown>[] = [];
  readonly unsubscribed: string[] = [];
  readonly interrupts: Array<{ readonly threadId: string; readonly turnId: string }> = [];
  closeCalls = 0;
  resumeFailure: Error | undefined;
  startTurnFailure: Error | undefined;
  beforeStartTurnReturn:
    ((input: Record<string, unknown>, providerTurnId: string) => void) | undefined;
  private threadCount = 0;
  private turnCount = 0;
  private readonly notifications = new Set<(notification: CodexAppServerNotification) => void>();
  private readonly handlers = new Map<string, CodexAppServerRequestHandler>();
  private readonly exitListeners = new Set<(cause: Error) => void>();

  async readAccount() {
    return { account: null, requiresOpenaiAuth: true };
  }

  async listModels() {
    return [];
  }

  async startLogin() {
    return {
      type: 'chatgptDeviceCode' as const,
      loginId: 'login',
      verificationUrl: '',
      userCode: '',
    };
  }

  async cancelLogin() {
    return { status: 'canceled' as const };
  }

  async logout() {
    return {} as Readonly<Record<string, never>>;
  }

  async startThread(input: Record<string, unknown>) {
    this.startThreadInputs.push(input);
    this.threadCount += 1;
    return { thread: { id: `provider-thread-${this.threadCount}` } };
  }

  async resumeThread(input: Record<string, unknown>) {
    this.resumeInputs.push(input);
    if (this.resumeFailure) throw this.resumeFailure;
    return { thread: { id: input.threadId as string } };
  }

  async startTurn(input: Record<string, unknown>) {
    this.startTurnInputs.push(input);
    this.turnCount += 1;
    const providerTurnId = `provider-turn-${this.turnCount}`;
    if (this.startTurnFailure) {
      const failure = this.startTurnFailure;
      this.startTurnFailure = undefined;
      throw failure;
    }
    this.beforeStartTurnReturn?.(input, providerTurnId);
    return { turn: { id: providerTurnId } };
  }

  async interruptTurn(threadId: string, turnId: string) {
    this.interrupts.push({ threadId, turnId });
    return {} as Readonly<Record<string, never>>;
  }

  async unsubscribeThread(threadId: string) {
    this.unsubscribed.push(threadId);
    return { status: 'unsubscribed' };
  }

  subscribe(listener: (notification: CodexAppServerNotification) => void) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  registerServerRequestHandler(method: string, handler: CodexAppServerRequestHandler) {
    this.handlers.set(method, handler);
    return () => this.handlers.delete(method);
  }

  onExit(listener: (cause: Error) => void) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async close() {
    this.closeCalls += 1;
  }

  emit(notification: CodexAppServerNotification): void {
    this.notifications.forEach((listener) => listener(notification));
  }

  exit(cause: Error): void {
    [...this.exitListeners].forEach((listener) => listener(cause));
  }

  async serverRequest(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`No handler for ${method}`);
    const response = await handler({ id: 'request-1', method, params });
    if ('error' in response) throw new Error(response.error.message);
    return response.result;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for fake Codex client');
}
