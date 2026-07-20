import { describe, expect, it, vi } from 'vitest';

import {
  CodexAppServerClosedError,
  CodexAppServerClient,
  CodexAppServerTimeoutError,
  resolveCodexAppServerCommand,
  type CodexAppServerChildFactory,
  type CodexAppServerLineTransport,
} from '../packages/framework/src/adapters/node/codex-app-server-client.js';

describe('CodexAppServerClient', () => {
  it('initializes an owned stdio child, reuses ChatGPT account state, and paginates models', async () => {
    const fixture = createFixture();
    fixture.transport.onWrite((message) => {
      if (message.method === 'initialize') {
        fixture.transport.reply(message.id, {
          userAgent: 'zen-test/1.0.0',
          platformFamily: 'windows',
          platformOs: 'windows',
        });
      }
      if (message.method === 'account/read') {
        fixture.transport.reply(message.id, {
          account: { type: 'chatgpt', email: 'user@example.test' },
          requiresOpenaiAuth: true,
        });
      }
      if (message.method === 'model/list' && !('cursor' in message.params)) {
        fixture.transport.reply(message.id, {
          data: [model('gpt-5.4')],
          nextCursor: 'page-2',
        });
      }
      if (message.method === 'model/list' && message.params.cursor === 'page-2') {
        fixture.transport.reply(message.id, {
          data: [model('gpt-5.4-codex')],
          nextCursor: null,
        });
      }
    });

    const client = await CodexAppServerClient.start({
      childFactory: fixture.factory,
      command: 'codex',
      clientInfo: { name: 'zen-test', title: 'Zen Test', version: '1.0.0' },
    });

    await expect(client.readAccount()).resolves.toMatchObject({
      account: { type: 'chatgpt', email: 'user@example.test' },
      requiresOpenaiAuth: true,
    });
    await expect(client.listModels({ limit: 1 })).resolves.toEqual([
      model('gpt-5.4'),
      model('gpt-5.4-codex'),
    ]);

    expect(fixture.spawned).toEqual([
      {
        command: 'codex',
        args: ['app-server', '--listen', 'stdio://'],
      },
    ]);
    expect(fixture.transport.writes.slice(0, 2)).toEqual([
      {
        method: 'initialize',
        id: 1,
        params: {
          clientInfo: { name: 'zen-test', title: 'Zen Test', version: '1.0.0' },
          capabilities: { experimentalApi: true },
        },
      },
      { method: 'initialized' },
    ]);

    await client.close();
  });

  it('multiplexes turn and thread requests using the generated v2 parameter shapes', async () => {
    const fixture = createInitializedFixture();
    fixture.transport.onWrite((message) => {
      if (message.method === 'thread/start') {
        fixture.transport.reply(message.id, threadResponse('thread-1'));
      }
      if (message.method === 'thread/resume') {
        fixture.transport.reply(message.id, threadResponse('thread-1'));
      }
      if (message.method === 'turn/start') {
        fixture.transport.reply(message.id, { turn: { id: 'turn-1', status: 'inProgress' } });
      }
      if (
        message.method === 'turn/interrupt' ||
        message.method === 'thread/delete' ||
        message.method === 'thread/unsubscribe'
      ) {
        fixture.transport.reply(
          message.id,
          message.method === 'thread/unsubscribe' ? { status: 'unsubscribed' } : {}
        );
      }
    });

    const client = await fixture.client;
    const started = client.startThread({
      model: 'gpt-5.4',
      cwd: 'D:\\workspace',
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
    const resumed = client.resumeThread({ threadId: 'thread-1', model: 'gpt-5.4' });

    await expect(started).resolves.toMatchObject({ thread: { id: 'thread-1' } });
    await expect(resumed).resolves.toMatchObject({ thread: { id: 'thread-1' } });
    await expect(
      client.startTurn({
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'Inspect the project.', text_elements: [] }],
        cwd: 'D:\\workspace',
        model: 'gpt-5.4',
      })
    ).resolves.toMatchObject({ turn: { id: 'turn-1', status: 'inProgress' } });
    await expect(client.interruptTurn('thread-1', 'turn-1')).resolves.toEqual({});
    await expect(client.unsubscribeThread('thread-1')).resolves.toEqual({ status: 'unsubscribed' });
    await expect(client.deleteThread('thread-1')).resolves.toEqual({});

    expect(fixture.transport.writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'turn/start',
          params: {
            threadId: 'thread-1',
            input: [{ type: 'text', text: 'Inspect the project.', text_elements: [] }],
            cwd: 'D:\\workspace',
            model: 'gpt-5.4',
          },
        }),
        expect.objectContaining({
          method: 'turn/interrupt',
          params: { threadId: 'thread-1', turnId: 'turn-1' },
        }),
      ])
    );

    await client.close();
  });

  it('delivers notifications and routes server requests to registered handlers', async () => {
    const fixture = createInitializedFixture();
    const client = await fixture.client;
    const notifications: unknown[] = [];
    const unsubscribe = client.subscribe((notification) => notifications.push(notification));
    client.registerServerRequestHandler('item/tool/call', async (request) => {
      expect(request.params).toEqual({ threadId: 'thread-1', tool: 'zen.read_file' });
      return { result: { contentItems: [{ type: 'inputText', text: 'contents' }] } };
    });

    fixture.transport.emit({ method: 'item/agentMessage/delta', params: { delta: 'hello' } });
    fixture.transport.emit({
      method: 'item/tool/call',
      id: 'server-request-1',
      params: { threadId: 'thread-1', tool: 'zen.read_file' },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(notifications).toEqual([
      { method: 'item/agentMessage/delta', params: { delta: 'hello' } },
    ]);
    expect(fixture.transport.writes).toContainEqual({
      id: 'server-request-1',
      result: { contentItems: [{ type: 'inputText', text: 'contents' }] },
    });

    unsubscribe();
    fixture.transport.emit({ method: 'turn/completed', params: { turn: { id: 'turn-1' } } });
    expect(notifications).toHaveLength(1);

    await client.close();
  });

  it('fails pending requests when its child exits and only terminates its owned child on close', async () => {
    const fixture = createInitializedFixture();
    const client = await fixture.client;
    const exits: Error[] = [];
    client.onExit((cause) => exits.push(cause));
    const pending = client.request('model/list', { includeHidden: false });

    fixture.transport.exit({ code: 17, signal: null });

    await expect(pending).rejects.toThrow('Codex App Server exited (code 17)');
    expect(exits.map((cause) => cause.message)).toEqual(['Codex App Server exited (code 17)']);
    await expect(client.readAccount()).rejects.toBeInstanceOf(CodexAppServerClosedError);
    await client.close();
    expect(fixture.transport.terminateCount).toBe(0);

    const openFixture = createInitializedFixture();
    const openClient = await openFixture.client;
    const intentionalExits: Error[] = [];
    openClient.onExit((cause) => intentionalExits.push(cause));
    const openPending = openClient.request('model/list', { includeHidden: false });
    await openClient.close();
    await expect(openPending).rejects.toBeInstanceOf(CodexAppServerClosedError);
    expect(openFixture.transport.terminateCount).toBe(1);
    expect(intentionalExits).toEqual([]);
  });

  it('uses direct executable discovery and bounds startup and request waits', async () => {
    expect(
      resolveCodexAppServerCommand({
        command: 'D:\\Tools\\codex.exe',
        platform: 'win32',
        exists: () => false,
      })
    ).toBe('D:\\Tools\\codex.exe');
    expect(
      resolveCodexAppServerCommand({
        platform: 'win32',
        pathValue: 'C:\\missing;C:\\Codex',
        localAppData: undefined,
        exists: (candidate) => candidate === 'C:\\Codex\\codex.exe',
        readDirectory: () => [],
      })
    ).toBe('C:\\Codex\\codex.exe');
    const npmNative =
      'D:\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
    expect(
      resolveCodexAppServerCommand({
        platform: 'win32',
        arch: 'x64',
        pathValue: 'D:\\npm;C:\\Program Files\\WindowsApps\\OpenAI.Codex\\resources',
        localAppData: undefined,
        exists: (candidate) =>
          candidate === npmNative ||
          candidate === 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\resources\\codex.exe',
        readDirectory: () => [],
      })
    ).toBe(npmNative);
    const npmNativeArm64 =
      'D:\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\bin\\codex.exe';
    expect(
      resolveCodexAppServerCommand({
        platform: 'win32',
        arch: 'arm64',
        pathValue: 'D:\\npm',
        localAppData: undefined,
        exists: (candidate) => candidate === npmNativeArm64,
        readDirectory: () => [],
      })
    ).toBe(npmNativeArm64);
    const localInstall = 'C:\\Users\\person\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe';
    expect(
      resolveCodexAppServerCommand({
        platform: 'win32',
        arch: 'x64',
        pathValue: 'D:\\npm;C:\\Program Files\\WindowsApps\\OpenAI.Codex\\resources',
        localAppData: 'C:\\Users\\person\\AppData\\Local',
        exists: (candidate) =>
          candidate === localInstall ||
          candidate === npmNative ||
          candidate === 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\resources\\codex.exe',
        readDirectory: () => [],
      })
    ).toBe(npmNative);

    vi.useFakeTimers();
    try {
      const hanging = createFixture();
      const starting = CodexAppServerClient.start({
        childFactory: hanging.factory,
        startupTimeoutMs: 5,
      });
      const startupExpectation = expect(starting).rejects.toBeInstanceOf(
        CodexAppServerTimeoutError
      );
      await vi.advanceTimersByTimeAsync(5);
      await startupExpectation;
      expect(hanging.transport.terminateCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }

    const fixture = createInitializedFixture();
    const client = await fixture.client;
    vi.useFakeTimers();
    try {
      const pending = client.request('account/read', {}, { timeoutMs: 5 });
      const requestExpectation = expect(pending).rejects.toBeInstanceOf(CodexAppServerTimeoutError);
      await vi.advanceTimersByTimeAsync(5);
      await requestExpectation;
    } finally {
      vi.useRealTimers();
    }
    await client.close();
  });

  it('prefers the newest usable versioned LocalAppData install', () => {
    const localAppData = 'C:\\Users\\person\\AppData\\Local';
    const localBin = `${localAppData}\\OpenAI\\Codex\\bin`;
    const olderVersioned = `${localBin}\\aaaaaaaaaaaaaaaa\\codex.exe`;
    const newerVersioned = `${localBin}\\bbbbbbbbbbbbbbbb\\codex.exe`;
    const staleUnversioned = `${localBin}\\codex.exe`;
    const npmNative =
      'D:\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
    const windowsApps = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\resources\\codex.exe';
    const readDirectory = vi.fn(() => ['not-an-install', 'bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa']);

    expect(
      resolveCodexAppServerCommand({
        platform: 'win32',
        arch: 'x64',
        pathValue: 'D:\\npm;C:\\Program Files\\WindowsApps\\OpenAI.Codex\\resources',
        localAppData,
        exists: (candidate) =>
          candidate === olderVersioned ||
          candidate === newerVersioned ||
          candidate === staleUnversioned ||
          candidate === npmNative ||
          candidate === windowsApps,
        readDirectory,
        modifiedTimeMs: (candidate) => (candidate === newerVersioned ? 200 : 100),
      })
    ).toBe(newerVersioned);
    expect(readDirectory).toHaveBeenCalledWith(localBin);
  });

  it('uses the generated interactive account login, cancellation, and logout shapes', async () => {
    const fixture = createInitializedFixture();
    fixture.transport.onWrite((message) => {
      if (message.method === 'account/login/start') {
        fixture.transport.reply(message.id, {
          type: 'chatgpt',
          loginId: 'login-1',
          authUrl: 'https://auth.openai.example/login',
        });
      }
      if (message.method === 'account/login/cancel') {
        fixture.transport.reply(message.id, { status: 'canceled' });
      }
      if (message.method === 'account/logout') fixture.transport.reply(message.id, {});
    });

    const client = await fixture.client;
    await expect(client.startLogin({ type: 'chatgpt', appBrand: 'codex' })).resolves.toEqual({
      type: 'chatgpt',
      loginId: 'login-1',
      authUrl: 'https://auth.openai.example/login',
    });
    await expect(client.cancelLogin('login-1')).resolves.toEqual({ status: 'canceled' });
    await expect(client.logout()).resolves.toEqual({});
    expect(fixture.transport.writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'account/login/start',
          params: { type: 'chatgpt', appBrand: 'codex' },
        }),
        expect.objectContaining({
          method: 'account/login/cancel',
          params: { loginId: 'login-1' },
        }),
        expect.objectContaining({ method: 'account/logout' }),
      ])
    );

    await client.close();
  });
});

function createInitializedFixture(): {
  readonly transport: FakeLineTransport;
  readonly client: Promise<CodexAppServerClient>;
} & Fixture {
  const fixture = createFixture();
  fixture.transport.onWrite((message) => {
    if (message.method === 'initialize')
      fixture.transport.reply(message.id, { userAgent: 'zen-test' });
  });
  return {
    ...fixture,
    client: CodexAppServerClient.start({ childFactory: fixture.factory }),
  };
}

function createFixture(): Fixture {
  const transport = new FakeLineTransport();
  const spawned: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  const factory: CodexAppServerChildFactory = ({ command, args }) => {
    spawned.push({ command, args });
    return transport;
  };
  return { transport, spawned, factory };
}

type Fixture = {
  readonly transport: FakeLineTransport;
  readonly spawned: Array<{ readonly command: string; readonly args: readonly string[] }>;
  readonly factory: CodexAppServerChildFactory;
};

class FakeLineTransport implements CodexAppServerLineTransport {
  readonly writes: unknown[] = [];
  terminateCount = 0;
  private readonly lines = new Set<(line: string) => void>();
  private readonly exits = new Set<
    (exit: { readonly code: number | null; readonly signal: string | null }) => void
  >();
  private readonly writers = new Set<(message: RpcMessage) => void>();

  writeLine(line: string): void {
    const message = JSON.parse(line) as RpcMessage;
    this.writes.push(message);
    this.writers.forEach((writer) => writer(message));
  }

  onLine(listener: (line: string) => void): () => void {
    this.lines.add(listener);
    return () => this.lines.delete(listener);
  }

  onExit(
    listener: (exit: { readonly code: number | null; readonly signal: string | null }) => void
  ): () => void {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  onWrite(listener: (message: RpcMessage) => void): void {
    this.writers.add(listener);
  }

  reply(id: unknown, result: unknown): void {
    this.emit({ id, result });
  }

  emit(message: unknown): void {
    const line = JSON.stringify(message);
    queueMicrotask(() => this.lines.forEach((listener) => listener(line)));
  }

  exit(exit: { readonly code: number | null; readonly signal: string | null }): void {
    this.exits.forEach((listener) => listener(exit));
  }
}

type RpcMessage = {
  readonly method: string;
  readonly id?: unknown;
  readonly params: Record<string, unknown>;
};

function model(id: string): Record<string, unknown> {
  return {
    id,
    model: id,
    displayName: id,
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text'],
    supportsPersonality: true,
    isDefault: id === 'gpt-5.4',
  };
}

function threadResponse(id: string): Record<string, unknown> {
  return {
    thread: { id, ephemeral: true },
    model: 'gpt-5.4',
    modelProvider: 'openai',
    cwd: 'D:\\workspace',
  };
}
