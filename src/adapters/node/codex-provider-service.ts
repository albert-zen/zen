import {
  CodexAppServerClient,
  CodexAppServerClosedError,
  type CodexAccount,
  type CodexAppServerCancelLoginResult,
  type CodexAppServerClientOptions,
  type CodexAppServerDynamicToolOutput,
  type CodexAppServerLoginInput,
  type CodexAppServerLoginResult,
  type CodexAppServerNotification,
  type CodexAppServerRequestHandler,
  type CodexAppServerResumeThreadInput,
  type CodexAppServerStartThreadInput,
  type CodexAppServerStartTurnInput,
  type CodexAppServerThreadResult,
  type CodexAppServerTurnResult,
  type CodexModel,
} from './codex-app-server-client.js';

export type CodexProviderClient = {
  readonly command: string;
  readAccount(options?: { readonly refreshToken?: boolean }): Promise<{
    readonly account: CodexAccount | null;
    readonly requiresOpenaiAuth: boolean;
  }>;
  listModels(options?: {
    readonly includeHidden?: boolean;
    readonly limit?: number;
  }): Promise<readonly CodexModel[]>;
  startLogin(input: CodexAppServerLoginInput): Promise<CodexAppServerLoginResult>;
  cancelLogin(loginId: string): Promise<CodexAppServerCancelLoginResult>;
  logout(): Promise<Readonly<Record<string, never>>>;
  startThread(input: CodexAppServerStartThreadInput): Promise<CodexAppServerThreadResult>;
  resumeThread(input: CodexAppServerResumeThreadInput): Promise<CodexAppServerThreadResult>;
  startTurn(input: CodexAppServerStartTurnInput): Promise<CodexAppServerTurnResult>;
  interruptTurn(threadId: string, turnId: string): Promise<Readonly<Record<string, never>>>;
  unsubscribeThread(threadId: string): Promise<{ readonly status: string }>;
  subscribe(listener: (notification: CodexAppServerNotification) => void): () => void;
  registerServerRequestHandler(method: string, handler: CodexAppServerRequestHandler): () => void;
  onExit(listener: (cause: Error) => void): () => void;
  close(): Promise<void>;
};

export type CodexProviderTurnRoute = {
  readonly providerThreadId: string;
  bindProviderTurn(providerTurnId: string): void;
  onNotification(notification: CodexAppServerNotification): void;
  onDynamicToolCall(
    params: Readonly<Record<string, unknown>>
  ): Promise<CodexAppServerDynamicToolOutput>;
  onNativeApproval(
    method: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval',
    params: Readonly<Record<string, unknown>>
  ): Promise<unknown>;
  onProviderFailure(cause: Error): void;
};

export type CodexProviderTurnRegistration = {
  bind(providerTurnId: string): void;
  unregister(): void;
};

export type CodexProviderClientFactory = (
  options: CodexAppServerClientOptions
) => Promise<CodexProviderClient>;

export type CodexProviderServiceOptions = {
  readonly clientFactory?: CodexProviderClientFactory;
  readonly clientOptions?: CodexAppServerClientOptions;
};

export type CodexProviderStatus = {
  readonly state: 'idle' | 'ready' | 'error' | 'closed';
  readonly cli: {
    readonly state: 'idle' | 'ready' | 'error' | 'closed';
    readonly command?: string;
  };
  readonly account: {
    readonly state: 'unknown' | 'authenticated' | 'unauthenticated';
    readonly account?: CodexAccount;
    readonly requiresOpenaiAuth?: boolean;
  };
  readonly models: {
    readonly state: 'unknown' | 'ready';
    readonly items: readonly CodexModel[];
  };
  readonly error?: string;
};

/** A single process-level owner for one lazy Codex App Server client. */
export class CodexProviderService {
  private readonly clientFactory: CodexProviderClientFactory;
  private readonly turnRoutes = new Map<string, CodexProviderTurnRouteState>();
  private client: CodexProviderClient | undefined;
  private starting: Promise<CodexProviderClient> | undefined;
  private refreshing: Promise<CodexProviderStatus> | undefined;
  private closing: Promise<void> | undefined;
  private account:
    { readonly account: CodexAccount | null; readonly requiresOpenaiAuth: boolean } | undefined;
  private models: readonly CodexModel[] | undefined;
  private error: Error | undefined;
  private closed = false;
  private removeClientRouting: (() => void) | undefined;

  constructor(private readonly options: CodexProviderServiceOptions = {}) {
    this.clientFactory = options.clientFactory ?? CodexAppServerClient.start;
  }

  peekStatus(): CodexProviderStatus {
    return this.snapshot();
  }

  async status(): Promise<CodexProviderStatus> {
    return await this.refresh();
  }

  async refresh(): Promise<CodexProviderStatus> {
    if (this.closed) return this.snapshot();
    this.refreshing ??= this.refreshStatus().finally(() => {
      this.refreshing = undefined;
    });
    return await this.refreshing;
  }

  async getClient(): Promise<CodexProviderClient> {
    if (this.closed) throw new CodexAppServerClosedError('Codex provider service is closed');
    if (this.client) return this.client;

    this.starting ??= this.startClient().finally(() => {
      this.starting = undefined;
    });
    return await this.starting;
  }

  async startLogin(input: CodexAppServerLoginInput): Promise<CodexAppServerLoginResult> {
    const result = await (await this.getClient()).startLogin(input);
    this.error = undefined;
    return result;
  }

  async cancelLogin(loginId: string): Promise<CodexAppServerCancelLoginResult> {
    return await (await this.getClient()).cancelLogin(loginId);
  }

  async logout(): Promise<Readonly<Record<string, never>>> {
    const result = await (await this.getClient()).logout();
    this.account = undefined;
    this.error = undefined;
    return result;
  }

  registerPendingTurnRoute(route: CodexProviderTurnRoute): CodexProviderTurnRegistration {
    const threadId = route.providerThreadId;
    if (this.turnRoutes.has(threadId)) {
      throw new Error(`Codex provider thread already has an active Zen Turn: ${threadId}`);
    }
    const state = new CodexProviderTurnRouteState(route);
    this.turnRoutes.set(threadId, state);
    return {
      bind: (providerTurnId) => {
        try {
          state.bind(providerTurnId);
        } catch (cause) {
          if (this.turnRoutes.get(threadId) === state) this.turnRoutes.delete(threadId);
          state.fail(asError(cause));
          throw cause;
        }
      },
      unregister: () => {
        if (this.turnRoutes.get(threadId) === state) this.turnRoutes.delete(threadId);
        state.unregister();
      },
    };
  }

  async close(): Promise<void> {
    this.closing ??= this.closeOwnedClient();
    return await this.closing;
  }

  private async startClient(): Promise<CodexProviderClient> {
    try {
      const client = await this.clientFactory(this.options.clientOptions ?? {});
      if (this.closed) {
        await client.close();
        throw new CodexAppServerClosedError('Codex provider service is closed');
      }
      this.client = client;
      this.installClientRouting(client);
      this.error = undefined;
      return client;
    } catch (cause) {
      this.error = asError(cause);
      throw this.error;
    }
  }

  private async refreshStatus(): Promise<CodexProviderStatus> {
    try {
      const client = await this.getClient();
      const [account, models] = await Promise.all([client.readAccount(), client.listModels()]);
      this.account = account;
      this.models = models;
      this.error = undefined;
    } catch (cause) {
      this.error = asError(cause);
    }
    return this.snapshot();
  }

  private async closeOwnedClient(): Promise<void> {
    this.closed = true;
    await this.starting?.catch(() => undefined);
    this.removeClientRouting?.();
    this.removeClientRouting = undefined;
    this.failTurnRoutes(new CodexAppServerClosedError('Codex provider service is closed'));
    const client = this.client;
    this.client = undefined;
    if (client) await client.close();
  }

  private installClientRouting(client: CodexProviderClient): void {
    const removeNotification = client.subscribe((notification) => {
      const identity = providerTurnIdentity(asRecord(notification.params));
      if (!identity) return;
      this.turnRoutes.get(identity.threadId)?.onNotification(identity.turnId, notification);
    });
    const registrations = [
      client.registerServerRequestHandler('item/tool/call', async (request) => {
        const params = asRecord(request.params);
        const threadId = text(params.threadId);
        const turnId = text(params.turnId);
        if (!threadId || !turnId) {
          return {
            error: { code: -32602, message: 'Codex dynamic tool request omitted threadId/turnId' },
          };
        }
        const routed = this.turnRoutes
          .get(threadId)
          ?.onRequest(turnId, async (route) => await route.onDynamicToolCall(params));
        if (!routed) {
          return {
            error: {
              code: -32001,
              message: `No active Zen execution for Codex turn ${threadId}/${turnId}`,
            },
          };
        }
        return { result: await routed };
      }),
      ...nativeApprovalMethods.map((method) =>
        client.registerServerRequestHandler(method, async (request) => {
          const params = asRecord(request.params);
          const identity = providerTurnIdentity(params);
          const routed = identity
            ? this.turnRoutes
                .get(identity.threadId)
                ?.onRequest(
                  identity.turnId,
                  async (route) => await route.onNativeApproval(method, params)
                )
            : undefined;
          if (!routed) {
            return {
              error: {
                code: -32001,
                message: 'No active Zen execution for Codex approval request',
              },
            };
          }
          return { result: await routed };
        })
      ),
      ...failClosedApprovalMethods.map((method) =>
        client.registerServerRequestHandler(
          method,
          (): ReturnType<CodexAppServerRequestHandler> => ({
            error: {
              code: -32001,
              message: 'Zen does not bridge this Codex approval request; request denied',
            },
          })
        )
      ),
    ];
    const removeExit = client.onExit((cause) => this.invalidateClient(client, cause));
    this.removeClientRouting = () => {
      removeExit();
      removeNotification();
      registrations.forEach((remove) => remove());
    };
  }

  private invalidateClient(client: CodexProviderClient, cause: Error): void {
    if (this.client !== client || this.closed) return;
    const removeRouting = this.removeClientRouting;
    this.removeClientRouting = undefined;
    removeRouting?.();
    this.client = undefined;
    this.account = undefined;
    this.models = undefined;
    this.error = cause;
    this.failTurnRoutes(cause);
  }

  private failTurnRoutes(cause: Error): void {
    const routes = [...this.turnRoutes.values()];
    this.turnRoutes.clear();
    routes.forEach((route) => route.fail(cause));
  }

  private snapshot(): CodexProviderStatus {
    const cliState = this.closed ? 'closed' : this.client ? 'ready' : this.error ? 'error' : 'idle';
    const account = this.account;
    return {
      state: this.closed ? 'closed' : this.error ? 'error' : this.client ? 'ready' : 'idle',
      cli: {
        state: cliState,
        ...(this.client === undefined ? {} : { command: this.client.command }),
      },
      account: {
        state:
          account === undefined
            ? 'unknown'
            : account.account === null
              ? 'unauthenticated'
              : 'authenticated',
        ...(account === undefined
          ? {}
          : account.account === null
            ? { requiresOpenaiAuth: account.requiresOpenaiAuth }
            : { account: account.account, requiresOpenaiAuth: account.requiresOpenaiAuth }),
      },
      models: {
        state: this.models === undefined ? 'unknown' : 'ready',
        items: this.models ?? [],
      },
      ...(this.error === undefined ? {} : { error: this.error.message }),
    };
  }
}

type PendingTurnRouteEvent =
  | {
      readonly type: 'notification';
      readonly turnId: string;
      readonly notification: CodexAppServerNotification;
    }
  | {
      readonly type: 'request';
      readonly turnId: string;
      readonly invoke: (route: CodexProviderTurnRoute) => Promise<unknown>;
      readonly resolve: (value: unknown) => void;
      readonly reject: (cause: unknown) => void;
    };

class CodexProviderTurnRouteState {
  private phase: 'pending' | 'bound' | 'removed' = 'pending';
  private providerTurnId: string | undefined;
  private pendingEvents: PendingTurnRouteEvent[] = [];

  constructor(private readonly route: CodexProviderTurnRoute) {}

  bind(providerTurnId: string): void {
    if (this.phase !== 'pending') {
      throw new Error(`Codex provider Turn route cannot bind while ${this.phase}`);
    }
    if (providerTurnId.length === 0) throw new Error('Codex provider Turn id cannot be empty');
    this.route.bindProviderTurn(providerTurnId);
    this.providerTurnId = providerTurnId;
    this.phase = 'bound';
    const events = this.pendingEvents;
    this.pendingEvents = [];
    events.forEach((event) => {
      if (event.turnId !== providerTurnId) {
        if (event.type === 'request') {
          event.reject(
            new Error(
              `No active Zen execution for Codex turn ${this.route.providerThreadId}/${event.turnId}`
            )
          );
        }
        return;
      }
      this.dispatch(event);
    });
  }

  onNotification(turnId: string, notification: CodexAppServerNotification): void {
    if (this.phase === 'removed') return;
    const event: PendingTurnRouteEvent = { type: 'notification', turnId, notification };
    if (this.phase === 'pending') {
      this.pendingEvents.push(event);
      return;
    }
    if (turnId === this.providerTurnId) this.dispatch(event);
  }

  onRequest(
    turnId: string,
    invoke: (route: CodexProviderTurnRoute) => Promise<unknown>
  ): Promise<unknown> | undefined {
    if (this.phase === 'removed') return undefined;
    if (this.phase === 'bound') {
      return turnId === this.providerTurnId ? invoke(this.route) : undefined;
    }
    return new Promise<unknown>((resolve, reject) => {
      this.pendingEvents.push({ type: 'request', turnId, invoke, resolve, reject });
    });
  }

  fail(cause: Error): void {
    if (this.phase === 'removed') return;
    this.phase = 'removed';
    this.rejectPending(cause);
    this.route.onProviderFailure(cause);
  }

  unregister(): void {
    if (this.phase === 'removed') return;
    this.phase = 'removed';
    this.rejectPending(new Error('Codex provider Turn route ended before request completion'));
  }

  private dispatch(event: PendingTurnRouteEvent): void {
    if (event.type === 'notification') {
      this.route.onNotification(event.notification);
      return;
    }
    void event.invoke(this.route).then(event.resolve, event.reject);
  }

  private rejectPending(cause: Error): void {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    events.forEach((event) => {
      if (event.type === 'request') event.reject(cause);
    });
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

const nativeApprovalMethods = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
] as const;

const failClosedApprovalMethods = [
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
] as const;

function providerTurnIdentity(
  params: Readonly<Record<string, unknown>>
): { readonly threadId: string; readonly turnId: string } | undefined {
  const threadId = text(params.threadId);
  const turnId = text(params.turnId) ?? text(asRecord(params.turn).id);
  return threadId && turnId ? { threadId, turnId } : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
