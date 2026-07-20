import type { Item, ToolCallPayload, ToolRuntime, ToolRuntimeEvent } from '../../kernel/index.js';
import {
  DEFAULT_ZEN_SYSTEM_PROMPT,
  type ApprovalBroker,
  type TurnExecutor,
  type TurnExecutorInput,
} from '../../product/index.js';
import type {
  CodexAppServerDynamicToolSpec,
  CodexAppServerDynamicToolOutput,
  CodexAppServerNotification,
  CodexInputItem,
} from './codex-app-server-client.js';
import { CodexProviderService, type CodexProviderClient } from './codex-provider-service.js';

const PROVIDER_THREAD_BINDING = 'internal.codex.provider-thread';

export type CodexTurnExecutorOptions = {
  readonly provider: CodexProviderService;
  readonly cwd: string;
  readonly model?: string;
  readonly threadTools: ToolRuntime;
  readonly threadToolDefinitions: readonly ZenThreadToolDefinition[];
  readonly approvalBroker?: ApprovalBroker;
};

export type ZenThreadToolDefinition = {
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  };
};

/** Maps one Zen Turn onto a resumable Codex provider turn. */
export class CodexTurnExecutor implements TurnExecutor {
  private readonly dynamicTools: CodexDynamicTools;

  constructor(private readonly options: CodexTurnExecutorOptions) {
    this.dynamicTools = createCodexDynamicTools(options.threadToolDefinitions);
  }

  async run(input: TurnExecutorInput): Promise<{ readonly yielded: boolean }> {
    const client = await this.options.provider.getClient();
    await appendLifecycle(input, 'run.started', {});
    await appendLifecycle(input, 'turn.started', {});
    await input.appendItem({
      type: 'user.message.completed',
      runId: input.turnSnapshot.runId,
      turnId: input.turnSnapshot.id,
      payload: { content: input.input },
    });

    const handle = await this.ensureProviderThread(client, input);
    const active = new ActiveCodexTurn({
      input,
      client,
      providerThreadId: handle.id,
      toolRuntime: this.options.threadTools,
      zenToolNameByCodexName: this.dynamicTools.zenNameByCodexName,
      approvalBroker: this.options.approvalBroker,
    });
    const registration = this.options.provider.registerPendingTurnRoute(active);

    try {
      const providerTurn = await client.startTurn({
        threadId: handle.id,
        input: handle.rehydrate ? rehydratedInput(input) : [textInput(input.input)],
        cwd: this.options.cwd,
        approvalPolicy: 'on-request',
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
      });
      const providerTurnId = requiredText(providerTurn.turn.id, 'Codex turn id');
      if (handle.persistBinding) await this.appendProviderThreadBinding(input, handle.id);
      registration.bind(providerTurnId);
      const terminal = await active.waitForTerminal();
      if (terminal.status === 'failed') {
        throw new Error(terminal.message ?? 'Codex provider turn failed');
      }
      if (input.signal.aborted) return { yielded: false };
      if (terminal.status === 'interrupted' && !active.yielded) {
        throw new Error(terminal.message ?? 'Codex provider turn was interrupted');
      }
      if (active.yielded) {
        await appendLifecycle(input, 'turn.yielded', { status: 'waiting' });
        await appendLifecycle(input, 'run.completed', { status: 'yielded' });
        return { yielded: true };
      }
      await appendLifecycle(input, 'turn.completed', { status: 'completed' });
      await appendLifecycle(input, 'run.completed', { status: 'completed' });
      return { yielded: false };
    } finally {
      registration.unregister();
      await client.unsubscribeThread(handle.id).catch(() => undefined);
    }
  }

  private async ensureProviderThread(
    client: CodexProviderClient,
    input: TurnExecutorInput
  ): Promise<{
    readonly id: string;
    readonly rehydrate: boolean;
    readonly persistBinding: boolean;
  }> {
    const previous = providerThreadHandle(input.threadRecord.items);
    if (previous) {
      try {
        const resumed = await client.resumeThread({
          threadId: previous,
          cwd: this.options.cwd,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
          ...(this.options.model === undefined ? {} : { model: this.options.model }),
        });
        return {
          id: requiredText(resumed.thread.id, 'Codex resumed thread id'),
          rehydrate: false,
          persistBinding: false,
        };
      } catch {
        // A persisted provider handle is replaceable, never Zen identity.
      }
    }

    const started = await client.startThread({
      cwd: this.options.cwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      ephemeral: false,
      baseInstructions: DEFAULT_ZEN_SYSTEM_PROMPT,
      developerInstructions: DEFAULT_ZEN_SYSTEM_PROMPT,
      dynamicTools: this.dynamicTools.specs,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
    });
    const id = requiredText(started.thread.id, 'Codex started thread id');
    return { id, rehydrate: true, persistBinding: true };
  }

  private async appendProviderThreadBinding(
    input: TurnExecutorInput,
    providerThreadId: string
  ): Promise<void> {
    const binding = await input.appendItem({
      type: PROVIDER_THREAD_BINDING,
      runId: input.turnSnapshot.runId,
      turnId: input.turnSnapshot.id,
      visibility: 'internal',
      payload: { providerThreadId },
    });
    if (!binding) throw new Error('Zen rejected the Codex provider thread binding');
  }
}

type ActiveCodexTurnOptions = {
  readonly input: TurnExecutorInput;
  readonly client: CodexProviderClient;
  readonly providerThreadId: string;
  readonly toolRuntime: ToolRuntime;
  readonly zenToolNameByCodexName: ReadonlyMap<string, string>;
  readonly approvalBroker?: ApprovalBroker;
};

type ProviderTerminal = {
  readonly status: 'completed' | 'failed' | 'interrupted';
  readonly message?: string;
};

class ActiveCodexTurn {
  readonly providerThreadId: string;
  private providerTurnId: string | undefined;
  private readonly completion = deferred<ProviderTerminal>();
  private notificationTail = Promise.resolve();
  private assistantStarted: Item | undefined;
  private readonly completedAgentItemIds = new Set<string>();
  private completed = false;
  yielded = false;

  constructor(private readonly options: ActiveCodexTurnOptions) {
    this.providerThreadId = options.providerThreadId;
  }

  bindProviderTurn(providerTurnId: string): void {
    if (this.providerTurnId !== undefined) {
      throw new Error(`Codex provider Turn is already bound: ${this.providerTurnId}`);
    }
    this.providerTurnId = providerTurnId;
  }

  onNotification(notification: CodexAppServerNotification): void {
    this.notificationTail = this.notificationTail
      .then(async () => await this.applyNotification(notification))
      .catch((cause: unknown) => this.complete({ status: 'failed', message: errorMessage(cause) }));
  }

  async onDynamicToolCall(
    params: Readonly<Record<string, unknown>>
  ): Promise<CodexAppServerDynamicToolOutput> {
    const codexName = requiredText(params.tool, 'Codex dynamic tool name');
    const name = this.options.zenToolNameByCodexName.get(codexName);
    if (!name) throw new Error(`Unknown Codex dynamic tool: ${codexName}`);
    const call: ToolCallPayload = {
      id: requiredText(params.callId, 'Codex dynamic tool call id'),
      name,
      ...(params.arguments === undefined ? {} : { input: params.arguments }),
    };
    const started = await this.options.input.appendItem({
      type: 'tool.call.started',
      runId: this.options.input.turnSnapshot.runId,
      turnId: this.options.input.turnSnapshot.id,
      visibility: 'trace',
      payload: {
        toolCallId: call.id,
        toolName: call.name,
        ...(call.input === undefined ? {} : { input: call.input }),
      },
    });
    if (!started) throw new Error('Zen rejected dynamic tool lifecycle item');

    let content: unknown = {};
    try {
      for await (const event of this.options.toolRuntime.execute(call, {
        threadId: this.options.input.threadSnapshot.id,
        runId: this.options.input.turnSnapshot.runId,
        turnId: this.options.input.turnSnapshot.id,
        signal: this.options.input.signal,
        assistantItem: started,
        startedItem: started,
      })) {
        content = await this.applyToolEvent(event, started, call, content);
      }
      return dynamicToolResult(true, content);
    } catch (cause) {
      await this.options.input.appendItem({
        type: 'tool.error',
        runId: this.options.input.turnSnapshot.runId,
        turnId: this.options.input.turnSnapshot.id,
        causeId: started.id,
        targetId: started.id,
        visibility: 'trace',
        payload: { toolCallId: call.id, toolName: call.name, message: errorMessage(cause) },
      });
      return dynamicToolResult(false, { error: errorMessage(cause) });
    }
  }

  async onNativeApproval(
    method: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval',
    params: Readonly<Record<string, unknown>>
  ): Promise<unknown> {
    const broker = this.options.approvalBroker;
    if (!broker) return { decision: 'decline' };
    const call: ToolCallPayload = {
      id: text(params.approvalId) ?? requiredText(params.itemId, 'Codex approval item id'),
      name:
        method === 'item/commandExecution/requestApproval' ? 'codex.command' : 'codex.fileChange',
      input: params,
    };
    const started = await this.options.input.appendItem({
      type: 'tool.call.started',
      runId: this.options.input.turnSnapshot.runId,
      turnId: this.options.input.turnSnapshot.id,
      visibility: 'trace',
      payload: { toolCallId: call.id, toolName: call.name, input: params },
    });
    if (!started) throw new Error('Zen rejected native approval lifecycle item');
    const pending = broker.request({
      threadId: this.options.input.threadSnapshot.id,
      runId: this.options.input.turnSnapshot.runId,
      turnId: this.options.input.turnSnapshot.id,
      startedItemId: started.id,
      call,
      ...(text(params.reason) === undefined ? {} : { reason: text(params.reason) }),
    });
    await this.options.input.appendItem({
      type: 'approval.requested',
      runId: this.options.input.turnSnapshot.runId,
      turnId: this.options.input.turnSnapshot.id,
      causeId: started.id,
      targetId: started.id,
      visibility: 'trace',
      payload: {
        approvalId: pending.request.id,
        threadId: pending.request.threadId,
        turnId: pending.request.turnId,
        runId: pending.request.runId,
        toolCallId: call.id,
        toolName: call.name,
        input: params,
        ...(pending.request.reason === undefined ? {} : { reason: pending.request.reason }),
      },
    });
    const decision = await pending.decision;
    return { decision: decision.type === 'approveOnce' ? 'accept' : 'decline' };
  }

  onProviderFailure(cause: Error): void {
    this.complete({ status: 'failed', message: cause.message });
  }

  async waitForTerminal(): Promise<ProviderTerminal> {
    const abort = deferred<ProviderTerminal>();
    const interrupt = () => {
      const providerTurnId = this.requiredProviderTurnId();
      void this.options.client
        .interruptTurn(this.providerThreadId, providerTurnId)
        .catch(() => undefined);
      abort.resolve({ status: 'interrupted', message: 'Zen turn interrupted' });
    };
    if (this.options.input.signal.aborted) interrupt();
    else this.options.input.signal.addEventListener('abort', interrupt, { once: true });
    try {
      const terminal = await Promise.race([this.completion.promise, abort.promise]);
      await this.notificationTail;
      return terminal;
    } finally {
      this.options.input.signal.removeEventListener('abort', interrupt);
    }
  }

  private async applyNotification(notification: CodexAppServerNotification): Promise<void> {
    const params = record(notification.params);
    if (notification.method === 'item/agentMessage/delta') {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (delta.length === 0) return;
      const started = await this.ensureAssistantStarted();
      await this.options.input.appendItem({
        type: 'assistant.message.delta',
        runId: this.options.input.turnSnapshot.runId,
        turnId: this.options.input.turnSnapshot.id,
        causeId: started.id,
        targetId: started.id,
        visibility: 'trace',
        payload: { delta },
      });
      return;
    }
    if (notification.method === 'item/completed') {
      await this.appendAgentMessage(record(params.item));
      return;
    }
    if (notification.method === 'turn/completed') {
      const turn = record(params.turn);
      const items = Array.isArray(turn.items) ? turn.items : [];
      for (const item of items) await this.appendAgentMessage(record(item));
      const status = turn.status;
      this.complete({
        status:
          status === 'completed'
            ? 'completed'
            : status === 'interrupted'
              ? 'interrupted'
              : 'failed',
        ...(status === 'failed' ? { message: readTurnError(turn) } : {}),
      });
    }
  }

  private async appendAgentMessage(item: Readonly<Record<string, unknown>>): Promise<void> {
    if (item.type !== 'agentMessage') return;
    const id = typeof item.id === 'string' ? item.id : undefined;
    if (id && this.completedAgentItemIds.has(id)) return;
    if (id) this.completedAgentItemIds.add(id);
    const started = await this.ensureAssistantStarted();
    await this.options.input.appendItem({
      type: 'assistant.message.completed',
      runId: this.options.input.turnSnapshot.runId,
      turnId: this.options.input.turnSnapshot.id,
      causeId: started.id,
      targetId: started.id,
      payload: { content: typeof item.text === 'string' ? item.text : '' },
    });
  }

  private async ensureAssistantStarted(): Promise<Item> {
    if (this.assistantStarted) return this.assistantStarted;
    const started = await this.options.input.appendItem({
      type: 'assistant.message.started',
      runId: this.options.input.turnSnapshot.runId,
      turnId: this.options.input.turnSnapshot.id,
      visibility: 'trace',
      payload: {},
    });
    if (!started) throw new Error('Zen rejected assistant lifecycle item');
    this.assistantStarted = started;
    return started;
  }

  private async applyToolEvent(
    event: ToolRuntimeEvent,
    started: Item,
    call: ToolCallPayload,
    previous: unknown
  ): Promise<unknown> {
    if (event.type === 'output.delta') {
      await this.options.input.appendItem({
        type: 'tool.output.delta',
        runId: started.runId,
        turnId: started.turnId,
        causeId: started.id,
        targetId: started.id,
        visibility: 'trace',
        payload: { toolCallId: call.id, toolName: call.name, delta: event.delta },
      });
      return event.delta;
    }
    if (event.type === 'approval.requested' || event.type === 'approval.resolved') {
      throw new Error('Dynamic Zen coordination tools cannot request Codex-native approval');
    }
    if (event.type === 'error') throw event.error;
    if (event.type === 'execution.yielded') this.yielded = true;
    if (event.type === 'result.completed' || event.type === 'execution.yielded') {
      await this.options.input.appendItem({
        type: 'tool.result.completed',
        runId: started.runId,
        turnId: started.turnId,
        causeId: started.id,
        targetId: started.id,
        payload: {
          toolCallId: call.id,
          toolName: call.name,
          content: event.content,
          ...(event.type === 'execution.yielded' ? { executionYielded: true } : {}),
        },
      });
      if (event.type === 'execution.yielded') {
        const providerTurnId = this.requiredProviderTurnId();
        void this.options.client
          .interruptTurn(this.providerThreadId, providerTurnId)
          .catch(() => undefined);
      }
      return event.content;
    }
    return previous;
  }

  private complete(terminal: ProviderTerminal): void {
    if (this.completed) return;
    this.completed = true;
    this.completion.resolve(terminal);
  }

  private requiredProviderTurnId(): string {
    return requiredText(this.providerTurnId, 'Codex active turn id');
  }
}

function providerThreadHandle(items: readonly Item[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type !== PROVIDER_THREAD_BINDING) continue;
    const id = record(item.payload).providerThreadId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}

function rehydratedInput(input: TurnExecutorInput): readonly CodexInputItem[] {
  const history = input.threadRecord.items
    .filter(
      (item) =>
        item.turnId !== input.turnSnapshot.id &&
        (item.type === 'user.message.completed' || item.type === 'assistant.message.completed')
    )
    .map((item) => {
      const role = item.type.startsWith('user.') ? 'User' : 'Assistant';
      return `${role}: ${toText(record(item.payload).content)}`;
    })
    .filter((entry) => !entry.endsWith(': '));
  return [
    ...(history.length === 0
      ? []
      : [textInput(`Zen canonical conversation history:\n${history.join('\n')}`)]),
    textInput(input.input),
  ];
}

function textInput(value: unknown): CodexInputItem {
  return { type: 'text', text: toText(value), text_elements: [] };
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

function dynamicToolResult(success: boolean, content: unknown): CodexAppServerDynamicToolOutput {
  return {
    success,
    contentItems: [{ type: 'inputText', text: JSON.stringify(content) }],
  };
}

type CodexDynamicTools = {
  readonly specs: readonly CodexAppServerDynamicToolSpec[];
  readonly zenNameByCodexName: ReadonlyMap<string, string>;
};

function createCodexDynamicTools(
  definitions: readonly ZenThreadToolDefinition[]
): CodexDynamicTools {
  const zenNameByCodexName = new Map<string, string>();
  const specs = definitions.map((definition): CodexAppServerDynamicToolSpec => {
    const name = `zen_${definition.function.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    if (zenNameByCodexName.has(name)) {
      throw new Error(`Zen tool names collide after Codex normalization: ${name}`);
    }
    zenNameByCodexName.set(name, definition.function.name);
    return {
      type: 'function',
      name,
      description: definition.function.description,
      inputSchema: definition.function.parameters,
    };
  });
  return { specs, zenNameByCodexName };
}

async function appendLifecycle(
  input: TurnExecutorInput,
  type: 'run.started' | 'turn.started' | 'turn.completed' | 'turn.yielded' | 'run.completed',
  payload: Readonly<Record<string, unknown>>
): Promise<void> {
  await input.appendItem({
    type,
    runId: input.turnSnapshot.runId,
    turnId: input.turnSnapshot.id,
    visibility: 'trace',
    payload,
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readTurnError(turn: Readonly<Record<string, unknown>>): string {
  const error = record(turn.error);
  return typeof error.message === 'string' ? error.message : 'Codex provider turn failed';
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
