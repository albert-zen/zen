import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

type JsonObject = Readonly<Record<string, unknown>>;
type RpcId = string | number;
type RpcError = { readonly code: number; readonly message: string; readonly data?: unknown };

export const DEFAULT_CODEX_APP_SERVER_STARTUP_TIMEOUT_MS = 10_000;
export const DEFAULT_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;

export type CodexAppServerLineTransport = {
  writeLine(line: string): void;
  onLine(listener: (line: string) => void): () => void;
  onExit(listener: (exit: CodexAppServerExit) => void): () => void;
  terminate(): void;
};

export type CodexAppServerExit = {
  readonly code: number | null;
  readonly signal: string | null;
  readonly error?: Error;
};

export type CodexAppServerChildFactory = (input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}) => CodexAppServerLineTransport;

export type CodexAppServerCommandResolver = (input: { readonly command?: string }) => string;

export type CodexAppServerCommandDiscoveryOptions = {
  readonly command?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly pathValue?: string;
  readonly localAppData?: string;
  readonly exists?: (candidate: string) => boolean;
  readonly readDirectory?: (directory: string) => readonly string[];
  readonly modifiedTimeMs?: (candidate: string) => number;
};

const VERSIONED_CODEX_INSTALL_DIRECTORY = /^[a-f0-9]{16}$/i;

function findVersionedLocalCodexCommands(
  binDirectory: string,
  exists: (candidate: string) => boolean,
  readDirectory: (directory: string) => readonly string[],
  modifiedTimeMs: (candidate: string) => number
): readonly string[] {
  let directoryNames: readonly string[];
  try {
    directoryNames = readDirectory(binDirectory);
  } catch {
    return [];
  }

  return directoryNames
    .filter((directoryName) => VERSIONED_CODEX_INSTALL_DIRECTORY.test(directoryName))
    .map((directoryName) => join(binDirectory, directoryName, 'codex.exe'))
    .filter((candidate) => exists(candidate))
    .map((candidate) => {
      try {
        const value = modifiedTimeMs(candidate);
        return {
          candidate,
          modifiedTimeMs: Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY,
        };
      } catch {
        return { candidate, modifiedTimeMs: Number.NEGATIVE_INFINITY };
      }
    })
    .sort(
      (left, right) =>
        right.modifiedTimeMs - left.modifiedTimeMs || left.candidate.localeCompare(right.candidate)
    )
    .map(({ candidate }) => candidate);
}

export type CodexAppServerClientOptions = {
  readonly childFactory?: CodexAppServerChildFactory;
  readonly command?: string;
  readonly commandResolver?: CodexAppServerCommandResolver;
  readonly cwd?: string;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly clientInfo?: {
    readonly name: string;
    readonly title: string;
    readonly version: string;
  };
};

export type CodexAppServerNotification = {
  readonly method: string;
  readonly params: unknown;
};

export type CodexAppServerServerRequest = {
  readonly id: RpcId;
  readonly method: string;
  readonly params: unknown;
};

export type CodexAppServerRequestHandlerResult =
  { readonly result: unknown } | { readonly error: RpcError };

export type CodexAppServerRequestHandler = (
  request: CodexAppServerServerRequest
) => Promise<CodexAppServerRequestHandlerResult> | CodexAppServerRequestHandlerResult;

export type CodexAppServerDynamicToolOutputContentItem =
  | { readonly type: 'inputText'; readonly text: string }
  | { readonly type: 'inputImage'; readonly imageUrl: string };

export type CodexAppServerDynamicToolSpec = {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly deferLoading?: boolean;
};

export type CodexAppServerDynamicToolOutput = {
  readonly contentItems: readonly CodexAppServerDynamicToolOutputContentItem[];
  readonly success: boolean;
};

export type CodexAccount = Readonly<Record<string, unknown>> & { readonly type: string };

export type CodexModel = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly hidden: boolean;
};

export type CodexAppServerLoginInput =
  | {
      readonly type: 'chatgpt';
      readonly codexStreamlinedLogin?: boolean;
      readonly useHostedLoginSuccessPage?: boolean;
      readonly appBrand?: 'codex' | 'chatgpt' | null;
    }
  | { readonly type: 'chatgptDeviceCode' };

export type CodexAppServerLoginResult =
  | { readonly type: 'chatgpt'; readonly loginId: string; readonly authUrl: string }
  | {
      readonly type: 'chatgptDeviceCode';
      readonly loginId: string;
      readonly verificationUrl: string;
      readonly userCode: string;
    };

export type CodexAppServerCancelLoginResult = {
  readonly status: 'canceled' | 'notFound';
};

export type CodexInputItem =
  | {
      readonly type: 'text';
      readonly text: string;
      readonly text_elements: readonly unknown[];
    }
  | { readonly type: 'image'; readonly url: string; readonly detail?: string }
  | { readonly type: 'localImage'; readonly path: string; readonly detail?: string }
  | { readonly type: 'skill'; readonly name: string; readonly path: string }
  | { readonly type: 'mention'; readonly name: string; readonly path: string };

export type CodexAppServerStartThreadInput = {
  readonly model?: string;
  readonly modelProvider?: string;
  readonly cwd?: string;
  readonly approvalPolicy?: string;
  readonly sandbox?: string;
  readonly serviceName?: string;
  readonly baseInstructions?: string;
  readonly developerInstructions?: string;
  readonly dynamicTools?: readonly CodexAppServerDynamicToolSpec[] | null;
  readonly personality?: string;
  readonly ephemeral?: boolean;
};

export type CodexAppServerResumeThreadInput = Omit<
  CodexAppServerStartThreadInput,
  'serviceName' | 'ephemeral'
> & {
  readonly threadId: string;
};

export type CodexAppServerStartTurnInput = {
  readonly threadId: string;
  readonly input: readonly CodexInputItem[];
  readonly cwd?: string;
  readonly approvalPolicy?: string;
  readonly approvalsReviewer?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly summary?: string;
  readonly personality?: string;
  readonly outputSchema?: unknown;
};

export type CodexAppServerThreadResult = Readonly<Record<string, unknown>> & {
  readonly thread: Readonly<Record<string, unknown>> & { readonly id: string };
};

export type CodexAppServerTurnResult = Readonly<Record<string, unknown>> & {
  readonly turn: Readonly<Record<string, unknown>> & { readonly id: string };
};

export class CodexAppServerClosedError extends Error {
  constructor(message = 'Codex App Server client is closed') {
    super(message);
    this.name = 'CodexAppServerClosedError';
  }
}

export class CodexAppServerProtocolError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'CodexAppServerProtocolError';
  }
}

export class CodexAppServerRequestError extends Error {
  constructor(
    readonly method: string,
    readonly error: RpcError
  ) {
    super(`Codex App Server ${method} failed (${error.code}): ${error.message}`);
    this.name = 'CodexAppServerRequestError';
  }
}

export class CodexAppServerTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number
  ) {
    super(`Codex App Server ${method} timed out after ${timeoutMs}ms`);
    this.name = 'CodexAppServerTimeoutError';
  }
}

type PendingRequest = {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (cause: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};

export class CodexAppServerClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notifications = new Set<(notification: CodexAppServerNotification) => void>();
  private readonly requestHandlers = new Map<string, Set<CodexAppServerRequestHandler>>();
  private readonly exitListeners = new Set<(cause: Error) => void>();
  private readonly unsubscribeLine: () => void;
  private readonly unsubscribeExit: () => void;
  private nextRequestId = 1;
  private closed = false;
  private unexpectedExit: Error | undefined;
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly transport: CodexAppServerLineTransport,
    readonly command: string,
    private readonly requestTimeoutMs: number
  ) {
    this.unsubscribeLine = transport.onLine((line) => this.handleLine(line));
    this.unsubscribeExit = transport.onExit((exit) => this.handleExit(exit));
  }

  static async start(options: CodexAppServerClientOptions = {}): Promise<CodexAppServerClient> {
    const requestTimeoutMs = requireTimeoutMs(
      options.requestTimeoutMs ?? DEFAULT_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
      'request timeout'
    );
    const startupTimeoutMs = requireTimeoutMs(
      options.startupTimeoutMs ?? DEFAULT_CODEX_APP_SERVER_STARTUP_TIMEOUT_MS,
      'startup timeout'
    );
    const command = (options.commandResolver ?? resolveCodexAppServerCommand)({
      command: options.command,
    });
    const args = ['app-server', '--listen', 'stdio://'];
    const transport = (options.childFactory ?? createNodeChildTransport)({
      command,
      args,
      cwd: options.cwd,
    });
    const client = new CodexAppServerClient(transport, command, requestTimeoutMs);

    try {
      await client.request(
        'initialize',
        {
          clientInfo: options.clientInfo ?? {
            name: 'zen',
            title: 'Zen',
            version: '0.0.0',
          },
          capabilities: { experimentalApi: true },
        },
        {
          timeoutMs: startupTimeoutMs,
        }
      );
      client.notify('initialized');
      return client;
    } catch (cause) {
      await client.close();
      throw cause;
    }
  }

  async request(
    method: string,
    params: JsonObject | undefined = undefined,
    options: { readonly timeoutMs?: number } = {}
  ): Promise<unknown> {
    if (this.closed) throw new CodexAppServerClosedError();
    const id = this.nextRequestId++;
    const key = requestKey(id);
    const message = {
      method,
      id,
      ...(params === undefined ? {} : { params }),
    };

    const timeoutMs = requireTimeoutMs(
      options.timeoutMs ?? this.requestTimeoutMs,
      'request timeout'
    );

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(key)) reject(new CodexAppServerTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(key, { method, resolve, reject, timeout });
      try {
        this.write(message);
      } catch (cause) {
        this.closeFromFailure(
          new CodexAppServerProtocolError('Codex App Server transport write failed', cause)
        );
      }
    });
  }

  async readAccount(options: { readonly refreshToken?: boolean } = {}): Promise<{
    readonly account: CodexAccount | null;
    readonly requiresOpenaiAuth: boolean;
  }> {
    const result = requireRecord(
      await this.request('account/read', options),
      'account/read result'
    );
    const account = result.account;
    if (account !== null && !isRecord(account)) {
      throw new CodexAppServerProtocolError(
        'Codex App Server account/read returned an invalid account'
      );
    }
    if (typeof result.requiresOpenaiAuth !== 'boolean') {
      throw new CodexAppServerProtocolError(
        'Codex App Server account/read returned an invalid requiresOpenaiAuth value'
      );
    }
    return {
      account: account === null ? null : requireAccount(account),
      requiresOpenaiAuth: result.requiresOpenaiAuth,
    };
  }

  async startLogin(input: CodexAppServerLoginInput): Promise<CodexAppServerLoginResult> {
    const result = requireRecord(
      await this.request('account/login/start', input),
      'account/login/start result'
    );
    if (result.type === 'chatgpt') {
      if (typeof result.loginId !== 'string' || typeof result.authUrl !== 'string') {
        throw new CodexAppServerProtocolError(
          'Codex App Server account/login/start returned an invalid ChatGPT login result'
        );
      }
      return { type: 'chatgpt', loginId: result.loginId, authUrl: result.authUrl };
    }
    if (result.type === 'chatgptDeviceCode') {
      if (
        typeof result.loginId !== 'string' ||
        typeof result.verificationUrl !== 'string' ||
        typeof result.userCode !== 'string'
      ) {
        throw new CodexAppServerProtocolError(
          'Codex App Server account/login/start returned an invalid device-code login result'
        );
      }
      return {
        type: 'chatgptDeviceCode',
        loginId: result.loginId,
        verificationUrl: result.verificationUrl,
        userCode: result.userCode,
      };
    }
    throw new CodexAppServerProtocolError(
      'Codex App Server account/login/start returned an unsupported login result'
    );
  }

  async cancelLogin(loginId: string): Promise<CodexAppServerCancelLoginResult> {
    const result = requireRecord(
      await this.request('account/login/cancel', { loginId }),
      'account/login/cancel result'
    );
    if (result.status !== 'canceled' && result.status !== 'notFound') {
      throw new CodexAppServerProtocolError(
        'Codex App Server account/login/cancel returned an invalid status'
      );
    }
    return { status: result.status };
  }

  async logout(): Promise<Readonly<Record<string, never>>> {
    return requireEmptyResult(await this.request('account/logout'), 'account/logout');
  }

  async listModels(
    options: { readonly includeHidden?: boolean; readonly limit?: number } = {}
  ): Promise<readonly CodexModel[]> {
    const models: CodexModel[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null | undefined;

    do {
      if (typeof cursor === 'string' && !seenCursors.add(cursor)) {
        throw new CodexAppServerProtocolError(
          'Codex App Server model/list repeated a pagination cursor'
        );
      }

      const result = requireRecord(
        await this.request('model/list', {
          ...(cursor === undefined ? {} : { cursor }),
          ...(options.includeHidden === undefined ? {} : { includeHidden: options.includeHidden }),
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        }),
        'model/list result'
      );
      if (!Array.isArray(result.data)) {
        throw new CodexAppServerProtocolError('Codex App Server model/list returned invalid data');
      }
      models.push(...result.data.map((model) => requireModel(model)));
      if (result.nextCursor !== null && typeof result.nextCursor !== 'string') {
        throw new CodexAppServerProtocolError(
          'Codex App Server model/list returned invalid nextCursor'
        );
      }
      cursor = result.nextCursor;
    } while (cursor !== null);

    return models;
  }

  async startThread(input: CodexAppServerStartThreadInput): Promise<CodexAppServerThreadResult> {
    return requireThreadResult(await this.request('thread/start', input), 'thread/start result');
  }

  async resumeThread(input: CodexAppServerResumeThreadInput): Promise<CodexAppServerThreadResult> {
    return requireThreadResult(await this.request('thread/resume', input), 'thread/resume result');
  }

  async startTurn(input: CodexAppServerStartTurnInput): Promise<CodexAppServerTurnResult> {
    return requireTurnResult(await this.request('turn/start', input), 'turn/start result');
  }

  async interruptTurn(threadId: string, turnId: string): Promise<Readonly<Record<string, never>>> {
    return requireEmptyResult(
      await this.request('turn/interrupt', { threadId, turnId }),
      'turn/interrupt'
    );
  }

  async deleteThread(threadId: string): Promise<Readonly<Record<string, never>>> {
    return requireEmptyResult(await this.request('thread/delete', { threadId }), 'thread/delete');
  }

  async unsubscribeThread(threadId: string): Promise<{ readonly status: string }> {
    const result = requireRecord(
      await this.request('thread/unsubscribe', { threadId }),
      'thread/unsubscribe result'
    );
    if (typeof result.status !== 'string') {
      throw new CodexAppServerProtocolError(
        'Codex App Server thread/unsubscribe returned invalid status'
      );
    }
    return { status: result.status };
  }

  subscribe(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  registerServerRequestHandler(method: string, handler: CodexAppServerRequestHandler): () => void {
    const handlers = this.requestHandlers.get(method) ?? new Set<CodexAppServerRequestHandler>();
    handlers.add(handler);
    this.requestHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.requestHandlers.delete(method);
    };
  }

  /** Observes unexpected transport failure or child exit, never intentional close. */
  onExit(listener: (cause: Error) => void): () => void {
    if (this.unexpectedExit) {
      let subscribed = true;
      queueMicrotask(() => {
        if (!subscribed) return;
        try {
          listener(this.unexpectedExit!);
        } catch {
          // Lifecycle observers cannot break client teardown.
        }
      });
      return () => {
        subscribed = false;
      };
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return await this.closePromise;
  }

  private notify(method: string, params?: JsonObject): void {
    if (this.closed) throw new CodexAppServerClosedError();
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  private handleLine(line: string): void {
    if (this.closed) return;
    try {
      const value = JSON.parse(line) as unknown;
      if (!isRecord(value))
        throw new CodexAppServerProtocolError('Codex App Server emitted non-object JSON');
      if (typeof value.method === 'string') {
        if (isRpcId(value.id)) {
          void this.handleServerRequest({
            id: value.id,
            method: value.method,
            params: value.params,
          });
        } else {
          this.notifications.forEach((listener) => {
            try {
              listener({ method: value.method as string, params: value.params });
            } catch {
              // Notification observers are projections and cannot break the provider transport.
            }
          });
        }
        return;
      }
      if (isRpcId(value.id)) {
        this.handleResponse(value.id, value);
        return;
      }
      throw new CodexAppServerProtocolError(
        'Codex App Server emitted an unrecognized JSONL message'
      );
    } catch (cause) {
      this.closeFromFailure(
        cause instanceof CodexAppServerProtocolError
          ? cause
          : new CodexAppServerProtocolError('Codex App Server emitted invalid JSONL', cause)
      );
    }
  }

  private handleResponse(id: RpcId, value: Readonly<Record<string, unknown>>): void {
    const pending = this.pending.get(requestKey(id));
    if (!pending) return;
    this.pending.delete(requestKey(id));
    clearTimeout(pending.timeout);
    if (
      isRecord(value.error) &&
      typeof value.error.code === 'number' &&
      typeof value.error.message === 'string'
    ) {
      pending.reject(
        new CodexAppServerRequestError(pending.method, {
          code: value.error.code,
          message: value.error.message,
          ...(value.error.data === undefined ? {} : { data: value.error.data }),
        })
      );
      return;
    }
    if (!('result' in value)) {
      pending.reject(
        new CodexAppServerProtocolError(`Codex App Server ${pending.method} omitted result`)
      );
      return;
    }
    pending.resolve(value.result);
  }

  private async handleServerRequest(request: CodexAppServerServerRequest): Promise<void> {
    const handler = [...(this.requestHandlers.get(request.method) ?? [])].at(-1);
    const response = handler
      ? await Promise.resolve(handler(request)).catch(
          (cause: unknown): CodexAppServerRequestHandlerResult => ({
            error: {
              code: -32000,
              message: cause instanceof Error ? cause.message : String(cause),
            },
          })
        )
      : {
          error: {
            code: -32601,
            message: `Zen has no handler for Codex App Server request: ${request.method}`,
          },
        };
    try {
      this.write({ id: request.id, ...response });
    } catch (cause) {
      this.closeFromFailure(
        new CodexAppServerProtocolError(
          'Codex App Server server-request response write failed',
          cause
        )
      );
    }
  }

  private handleExit(exit: CodexAppServerExit): void {
    if (this.closed) return;
    const description = exit.error
      ? `Codex App Server exited: ${exit.error.message}`
      : exit.signal
        ? `Codex App Server exited (signal ${exit.signal})`
        : `Codex App Server exited (code ${String(exit.code)})`;
    this.closeFromFailure(new CodexAppServerClosedError(description), false);
  }

  private closeFromFailure(cause: Error, terminate = true): void {
    if (this.closed) return;
    this.closed = true;
    this.unexpectedExit = cause;
    this.unsubscribeLine();
    this.unsubscribeExit();
    this.rejectPending(cause);
    if (terminate) this.transport.terminate();
    const listeners = [...this.exitListeners];
    this.exitListeners.clear();
    listeners.forEach((listener) => {
      try {
        listener(cause);
      } catch {
        // Lifecycle observers cannot break client teardown.
      }
    });
  }

  private async closeResources(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeLine();
    this.unsubscribeExit();
    this.rejectPending(new CodexAppServerClosedError());
    this.exitListeners.clear();
    this.transport.terminate();
  }

  private rejectPending(cause: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(cause);
    }
    this.pending.clear();
  }

  private write(message: unknown): void {
    this.transport.writeLine(`${JSON.stringify(message)}\n`);
  }
}

function createNodeChildTransport(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}): CodexAppServerLineTransport {
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: false,
    windowsHide: true,
  });
  if (!child.stdin || !child.stdout) {
    child.kill();
    throw new Error('Codex App Server child did not expose stdio pipes');
  }
  return new NodeChildLineTransport(child);
}

export function resolveCodexAppServerCommand(
  options: CodexAppServerCommandDiscoveryOptions = {}
): string {
  if (options.command !== undefined) {
    if (options.command.trim().length === 0) {
      throw new Error('Codex App Server command override cannot be empty');
    }
    return options.command;
  }

  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return 'codex';

  const pathValue = options.pathValue ?? process.env.PATH ?? '';
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  const pathDirectories = pathValue
    .split(';')
    .map((directory) => directory.trim())
    .map((directory) => directory.replace(/^"(.*)"$/, '$1'))
    .filter((directory) => directory.length > 0);
  const exists = options.exists ?? existsSync;
  const readDirectory =
    options.readDirectory ??
    ((directory: string) =>
      readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name));
  const modifiedTimeMs =
    options.modifiedTimeMs ?? ((candidate: string) => statSync(candidate).mtimeMs);
  const npmNativeRelativePath = windowsNpmNativeCodexPath(options.arch ?? process.arch);
  const localBinDirectory =
    localAppData === undefined ? undefined : join(localAppData, 'OpenAI', 'Codex', 'bin');
  const candidates = [
    ...(localBinDirectory === undefined
      ? []
      : findVersionedLocalCodexCommands(localBinDirectory, exists, readDirectory, modifiedTimeMs)),
    ...(npmNativeRelativePath === undefined
      ? []
      : pathDirectories.map((directory) => join(directory, npmNativeRelativePath))),
    ...(localAppData === undefined
      ? []
      : [
          join(localAppData, 'OpenAI', 'Codex', 'bin', 'codex.exe'),
          join(localAppData, 'Programs', 'Codex', 'codex.exe'),
        ]),
    ...pathDirectories.map((directory) => join(directory, 'codex.exe')),
  ];
  return candidates.find((candidate) => exists(candidate)) ?? 'codex';
}

function windowsNpmNativeCodexPath(arch: NodeJS.Architecture): string | undefined {
  const target =
    arch === 'x64'
      ? { packageArch: 'x64', rustTarget: 'x86_64-pc-windows-msvc' }
      : arch === 'arm64'
        ? { packageArch: 'arm64', rustTarget: 'aarch64-pc-windows-msvc' }
        : undefined;
  return target === undefined
    ? undefined
    : join(
        'node_modules',
        '@openai',
        'codex',
        'node_modules',
        '@openai',
        `codex-win32-${target.packageArch}`,
        'vendor',
        target.rustTarget,
        'bin',
        'codex.exe'
      );
}

function requireTimeoutMs(timeoutMs: number, label: string): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`Codex App Server ${label} must be a positive finite number`);
  }
  return timeoutMs;
}

class NodeChildLineTransport implements CodexAppServerLineTransport {
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(exit: CodexAppServerExit) => void>();
  private exited = false;

  constructor(
    private readonly child: {
      readonly stdin: { write(line: string): boolean };
      readonly stdout: NodeJS.ReadableStream;
      once(
        event: 'exit',
        listener: (code: number | null, signal: NodeJS.Signals | null) => void
      ): unknown;
      once(event: 'error', listener: (error: Error) => void): unknown;
      kill(): boolean;
    }
  ) {
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on('line', (line) => this.lineListeners.forEach((listener) => listener(line)));
    child.once('exit', (code, signal) => this.emitExit({ code, signal }));
    child.once('error', (error) => this.emitExit({ code: null, signal: null, error }));
  }

  writeLine(line: string): void {
    if (this.exited) throw new Error('Codex App Server child has exited');
    this.child.stdin.write(line);
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  onExit(listener: (exit: CodexAppServerExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  terminate(): void {
    if (!this.exited) this.child.kill();
  }

  private emitExit(exit: CodexAppServerExit): void {
    if (this.exited) return;
    this.exited = true;
    this.exitListeners.forEach((listener) => listener(exit));
  }
}

function requestKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === 'string' || typeof value === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new CodexAppServerProtocolError(`Codex App Server ${label} must be an object`);
  return value;
}

function requireAccount(value: Record<string, unknown>): CodexAccount {
  if (typeof value.type !== 'string') {
    throw new CodexAppServerProtocolError('Codex App Server account/read account omitted type');
  }
  return value as CodexAccount;
}

function requireModel(value: unknown): CodexModel {
  const model = requireRecord(value, 'model/list model');
  if (
    typeof model.id !== 'string' ||
    typeof model.model !== 'string' ||
    typeof model.displayName !== 'string' ||
    typeof model.hidden !== 'boolean'
  ) {
    throw new CodexAppServerProtocolError('Codex App Server model/list returned an invalid model');
  }
  return model as CodexModel;
}

function requireThreadResult(value: unknown, label: string): CodexAppServerThreadResult {
  const result = requireRecord(value, label);
  const thread = requireRecord(result.thread, `${label} thread`);
  if (typeof thread.id !== 'string') {
    throw new CodexAppServerProtocolError(`Codex App Server ${label} thread omitted id`);
  }
  return result as CodexAppServerThreadResult;
}

function requireTurnResult(value: unknown, label: string): CodexAppServerTurnResult {
  const result = requireRecord(value, label);
  const turn = requireRecord(result.turn, `${label} turn`);
  if (typeof turn.id !== 'string') {
    throw new CodexAppServerProtocolError(`Codex App Server ${label} turn omitted id`);
  }
  return result as CodexAppServerTurnResult;
}

function requireEmptyResult(value: unknown, method: string): Readonly<Record<string, never>> {
  const result = requireRecord(value, `${method} result`);
  if (Object.keys(result).length > 0) {
    throw new CodexAppServerProtocolError(`Codex App Server ${method} returned a non-empty result`);
  }
  return result as Readonly<Record<string, never>>;
}
