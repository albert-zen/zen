import { randomUUID } from 'node:crypto';
import * as nodeFiles from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  OAuthCredential,
  Provider,
} from '@earendil-works/pi-ai';
import { closeOpenAICodexWebSocketSessions } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { DEFAULT_OPENAI_SUBSCRIPTION_MODEL_ID } from './openai-subscription-contract.js';

const providerId = 'openai-codex';
const refreshWindowMs = 5 * 60_000;
const defaultRefreshTimeoutMs = 15_000;
const codexAuthClaim = 'https://api.openai.com/auth';
const openAiOAuthTokenUrl = 'https://auth.openai.com/oauth/token';
const openAiOAuthClientId = 'app_EMoamEEZ73f0CkXaXp7hrann';

export type OpenAISubscriptionOAuthCredential = OAuthCredential;
export type OpenAISubscriptionProviderInteraction = AuthInteraction;

export type OpenAISubscriptionProvider = {
  readonly id: string;
  readonly auth: {
    readonly oauth?: {
      login(interaction: AuthInteraction): Promise<OAuthCredential>;
      refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential>;
    };
  };
  getModels(): readonly { readonly id: string; readonly name: string }[];
  stream: Provider<'openai-codex-responses'>['stream'];
};

export type OpenAISubscriptionProviderModel = {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly hidden: boolean;
};

export type OpenAISubscriptionLoginInput = {
  readonly type: 'chatgpt' | 'chatgptDeviceCode';
};

export type OpenAISubscriptionLogin =
  | { readonly type: 'chatgpt'; readonly loginId: string; readonly authUrl: string }
  | {
      readonly type: 'chatgptDeviceCode';
      readonly loginId: string;
      readonly verificationUrl: string;
      readonly userCode: string;
    };

export type OpenAISubscriptionProviderStatus = {
  readonly state: 'ready' | 'error';
  readonly refreshing: boolean;
  readonly provider: {
    readonly id: 'openai-codex';
    readonly auth: 'oauth';
  };
  readonly transport: {
    readonly identity: 'openai-codex-responses';
    readonly preferred: 'websocket';
    readonly fallback: 'http';
  };
  readonly account: {
    readonly state: 'authenticated' | 'unauthenticated';
    readonly type?: 'chatgpt';
    readonly accountId?: string;
    readonly email?: string;
    readonly plan?: string;
  };
  readonly auth: {
    readonly state: 'authenticated' | 'expired' | 'unauthenticated';
    readonly expiresAt?: number;
  };
  readonly models: {
    readonly state: 'ready';
    readonly items: readonly OpenAISubscriptionProviderModel[];
    readonly defaultModel?: string;
  };
  readonly login?: OpenAISubscriptionLogin;
  readonly error?: string;
};

export type OpenAISubscriptionFileSystem = {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(
    path: string,
    data: string,
    options: { readonly encoding: 'utf8'; readonly mode: number; readonly flag: 'wx' }
  ): Promise<void>;
  mkdir(
    path: string,
    options: { readonly recursive: true; readonly mode: number }
  ): Promise<string | undefined>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  unlink(path: string): Promise<void>;
};

export type OpenAISubscriptionProviderServiceOptions = {
  readonly appDataRoot: string;
  readonly credentialPath?: string;
  readonly provider?: OpenAISubscriptionProvider;
  readonly files?: OpenAISubscriptionFileSystem;
  readonly now?: () => number;
  readonly createLoginId?: () => string;
  /** Test seam. Implementations must stop their transport when signal is aborted. */
  readonly refreshCredential?: OpenAISubscriptionCredentialRefresher;
  readonly refreshTimeoutMs?: number;
  /** Injection point for lifecycle tests; production closes Pi's cached session socket. */
  readonly closeSession?: (sessionId: string) => void;
};

export type OpenAISubscriptionCredentialRefresher = (
  credential: OAuthCredential,
  signal: AbortSignal
) => Promise<OAuthCredential>;

export type OpenAISubscriptionAccessLease = Readonly<{
  readonly accessToken: string;
  readonly generation: number;
  readonly signal: AbortSignal;
}>;

type StoredCredential = {
  readonly version: 1;
  readonly provider: 'openai-codex';
  readonly credential: OAuthCredential;
  readonly updatedAt: string;
};

type ActiveLogin = {
  readonly id: string;
  readonly generation: number;
  readonly controller: AbortController;
  readonly announced: Deferred<OpenAISubscriptionLogin>;
  result?: OpenAISubscriptionLogin;
  credentialMutation?: Promise<void>;
};

type PendingCredentialPersistence = {
  readonly credential: OAuthCredential | undefined;
};

export class OpenAISubscriptionProviderClosedError extends Error {
  constructor() {
    super('OpenAI subscription provider service is closed');
    this.name = 'OpenAISubscriptionProviderClosedError';
  }
}

/** Zen-owned OpenAI subscription credentials backed by Pi's provider OAuth SDK. */
export class OpenAISubscriptionProviderService {
  readonly credentialPath: string;
  readonly defaultModelId: string | undefined;

  private readonly provider: OpenAISubscriptionProvider;
  private readonly files: OpenAISubscriptionFileSystem;
  private readonly now: () => number;
  private readonly createLoginId: () => string;
  private readonly refreshCredential: OpenAISubscriptionCredentialRefresher;
  private readonly refreshTimeoutMs: number;
  private readonly closeSession: (sessionId: string) => void;
  private readonly models: readonly OpenAISubscriptionProviderModel[];
  private readonly sessionIds = new Set<string>();
  private readonly lifecycleController = new AbortController();
  private initialized = false;
  private initializing: Promise<void> | undefined;
  private credential: OAuthCredential | undefined;
  private credentialMutationTail: Promise<void> = Promise.resolve();
  private refreshingCredential: Promise<OAuthCredential> | undefined;
  private dirtyPersistence: PendingCredentialPersistence | undefined;
  private sessionsRequireInvalidation = false;
  private authenticationGeneration = 0;
  private authenticationController = new AbortController();
  private activeLogin: ActiveLogin | undefined;
  private loginGeneration = 0;
  private lastError: string | undefined;
  private closed = false;
  private closeComplete = false;
  private closing: Promise<void> | undefined;

  constructor(options: OpenAISubscriptionProviderServiceOptions) {
    const appDataRoot = resolve(options.appDataRoot);
    this.credentialPath = resolve(
      options.credentialPath ?? join(appDataRoot, 'openai-subscription-auth.json')
    );
    this.provider = options.provider ?? openaiCodexProvider();
    if (this.provider.id !== providerId || !this.provider.auth.oauth) {
      throw new Error('OpenAI subscription provider must expose openai-codex OAuth');
    }
    this.files = options.files ?? nodeFileSystem;
    this.now = options.now ?? Date.now;
    this.createLoginId = options.createLoginId ?? randomUUID;
    this.refreshCredential =
      options.refreshCredential ??
      (async (credential, signal) =>
        await refreshOpenAISubscriptionCredential(credential, signal, this.now()));
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? defaultRefreshTimeoutMs;
    this.closeSession = options.closeSession ?? closeOpenAICodexWebSocketSessions;
    if (!Number.isFinite(this.refreshTimeoutMs) || this.refreshTimeoutMs <= 0) {
      throw new Error('OpenAI subscription refreshTimeoutMs must be positive');
    }
    this.models = readProviderModels(this.provider);
    this.defaultModelId =
      this.models.find((model) => model.id === DEFAULT_OPENAI_SUBSCRIPTION_MODEL_ID)?.id ??
      this.models[0]?.id;
  }

  async status(): Promise<OpenAISubscriptionProviderStatus> {
    this.assertOpen();
    await this.ensureInitialized();
    this.assertOpen();
    await this.retryDirtyPersistence();
    return this.snapshot();
  }

  async refresh(): Promise<OpenAISubscriptionProviderStatus> {
    this.assertOpen();
    await this.ensureInitialized();
    this.assertOpen();
    await this.retryDirtyPersistence();
    if (this.credential && shouldRefresh(this.credential, this.now())) {
      await this.resolveAccessToken().catch(() => undefined);
    }
    return this.snapshot();
  }

  async resolveAccessToken(signal?: AbortSignal): Promise<string> {
    return (await this.acquireAccessLease(signal)).accessToken;
  }

  async acquireAccessLease(signal?: AbortSignal): Promise<OpenAISubscriptionAccessLease> {
    this.assertOpen();
    await this.ensureInitialized();
    this.assertOpen();
    throwIfAborted(signal);
    await this.retryDirtyPersistence();

    while (true) {
      const lease = await this.withCredentialMutation(async () => {
        this.assertOpen();
        throwIfAborted(signal);
        this.invalidateSessionsIfRequired();
        const current = this.credential;
        if (!current) throw new Error('OpenAI subscription is not authenticated');
        if (shouldRefresh(current, this.now())) return undefined;
        return {
          accessToken: current.access,
          generation: this.authenticationGeneration,
          signal: this.authenticationController.signal,
        } satisfies OpenAISubscriptionAccessLease;
      });
      if (lease) return lease;

      if (!this.refreshingCredential) {
        const refresh = this.refreshOwnedCredential();
        this.refreshingCredential = refresh;
        void refresh
          .finally(() => {
            if (this.refreshingCredential === refresh) this.refreshingCredential = undefined;
          })
          .catch(() => undefined);
      }
      await awaitWithAbort(this.refreshingCredential, signal);
    }
  }

  /** The model gateway shares this provider instance and the Pi cache keyed by this id. */
  registerSession(sessionId: string): void {
    this.assertOpen();
    if (sessionId.trim().length === 0)
      throw new Error('OpenAI subscription sessionId must be non-empty');
    if (this.sessionIds.has(sessionId)) {
      throw new Error(`OpenAI subscription session is already owned: ${sessionId}`);
    }
    this.sessionIds.add(sessionId);
  }

  /** Releases one owned Pi WebSocket session and its continuation metadata. */
  releaseSession(sessionId: string): void {
    if (!this.sessionIds.has(sessionId)) return;
    this.closeSession(sessionId);
    this.sessionIds.delete(sessionId);
  }

  get modelProvider(): Pick<Provider<'openai-codex-responses'>, 'getModels' | 'stream'> {
    return this.provider as unknown as Pick<
      Provider<'openai-codex-responses'>,
      'getModels' | 'stream'
    >;
  }

  /** Changes whenever cached provider continuation state must be discarded. */
  get sessionGeneration(): number {
    return this.authenticationGeneration;
  }

  async startLogin(input: OpenAISubscriptionLoginInput): Promise<OpenAISubscriptionLogin> {
    this.assertOpen();
    await this.ensureInitialized();
    this.assertOpen();
    if (this.activeLogin) throw new Error('An OpenAI subscription login is already active');

    const oauth = this.requireOAuth();
    const announced = deferred<OpenAISubscriptionLogin>();
    const login: ActiveLogin = {
      id: this.createLoginId(),
      generation: ++this.loginGeneration,
      controller: new AbortController(),
      announced,
    };
    this.activeLogin = login;
    this.lastError = undefined;
    const interaction: AuthInteraction = {
      signal: login.controller.signal,
      prompt: async (prompt) => await this.answerLoginPrompt(input.type, prompt, login),
      notify: (event) => this.bridgeLoginEvent(input.type, event, login, announced),
    };

    void oauth
      .login(interaction)
      .then(async (credential) => {
        const validated = readOAuthCredential(credential);
        if (!validated) throw new Error('OpenAI subscription login returned an invalid credential');
        const mutation = this.withCredentialMutation(async () => {
          if (!this.ownsLogin(login) || login.controller.signal.aborted || this.closed) return;
          await this.acceptLoginCredential(login, validated);
        });
        login.credentialMutation = mutation;
        await mutation;
        if (!login.result) {
          announced.reject(new Error('OpenAI subscription login completed before authorization'));
        }
      })
      .catch(() => {
        if (this.ownsLogin(login) && !login.controller.signal.aborted && !this.closed) {
          this.lastError = 'OpenAI subscription login failed';
          announced.reject(new Error(this.lastError));
        }
      })
      .finally(() => {
        if (this.ownsLogin(login)) this.activeLogin = undefined;
      });

    return await announced.promise;
  }

  async cancelLogin(loginId: string): Promise<{ readonly status: 'canceled' | 'notFound' }> {
    this.assertOpen();
    const login = this.activeLogin;
    if (!login || login.id !== loginId) return { status: 'notFound' };
    this.activeLogin = undefined;
    login.announced.reject(new Error('OpenAI subscription login was canceled'));
    login.controller.abort();
    await login.credentialMutation;
    return { status: 'canceled' };
  }

  async logout(): Promise<Readonly<Record<string, never>>> {
    this.assertOpen();
    await this.ensureInitialized();
    this.assertOpen();
    this.cancelActiveLogin();
    await this.withCredentialMutation(async () => {
      this.replaceCredential(undefined);
      this.dirtyPersistence = { credential: undefined };
      this.invalidateSessionsIfRequired();
      await this.persistDirtyCredential(true);
    });
    return {};
  }

  async close(): Promise<void> {
    if (this.closeComplete) return;
    if (this.closing) return await this.closing;
    this.closed = true;
    this.lifecycleController.abort();
    this.authenticationController.abort(new Error('OpenAI subscription provider closed'));
    this.cancelActiveLogin();
    const closing = this.closeResources();
    this.closing = closing;
    try {
      await closing;
      this.closeComplete = true;
    } finally {
      if (this.closing === closing) this.closing = undefined;
    }
  }

  private async closeResources(): Promise<void> {
    await this.refreshingCredential?.catch(() => undefined);
    await this.credentialMutationTail;
    const failures: unknown[] = [];

    try {
      await this.withCredentialMutation(async () => await this.persistDirtyCredential(true));
    } catch (cause) {
      failures.push(cause);
    }

    for (const sessionId of [...this.sessionIds]) {
      try {
        this.closeSession(sessionId);
        this.sessionIds.delete(sessionId);
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'OpenAI subscription provider shutdown failed');
    }
  }

  private async ensureInitialized(): Promise<void> {
    this.assertOpen();
    if (this.initialized) return;
    this.initializing ??= this.initializeCredential().finally(() => {
      this.initializing = undefined;
    });
    await this.initializing;
  }

  private async initializeCredential(): Promise<void> {
    const owned = await readStoredCredential(this.files, this.credentialPath);
    if (owned) this.credential = owned;
    this.initialized = true;
  }

  private async refreshOwnedCredential(): Promise<OAuthCredential> {
    let refreshSource:
      | Readonly<{
          credential: OAuthCredential;
          generation: number;
          signal: AbortSignal;
        }>
      | undefined;
    try {
      const source = await this.withCredentialMutation(async () => {
        this.assertOpen();
        const current = this.credential;
        if (!current) throw new Error('OpenAI subscription is not authenticated');
        if (!shouldRefresh(current, this.now())) return current;
        return {
          credential: current,
          generation: this.authenticationGeneration,
          signal: this.authenticationController.signal,
        };
      });
      if ('access' in source) return source;
      refreshSource = source;

      const refreshed = readOAuthCredential(
        await this.runBoundedRefresh(source.credential, source.signal)
      );
      return await this.withCredentialMutation(async () => {
        this.assertOpen();
        if (!refreshed) throw new Error('OpenAI subscription refresh returned invalid credentials');
        if (
          source.generation !== this.authenticationGeneration ||
          source.credential !== this.credential
        ) {
          const current = this.credential;
          if (!current) throw new Error('OpenAI subscription is not authenticated');
          return current;
        }
        await this.acceptCredential(refreshed);
        return refreshed;
      });
    } catch {
      if (this.closed) throw new OpenAISubscriptionProviderClosedError();
      if (refreshSource && refreshSource.generation !== this.authenticationGeneration) {
        const current = this.credential;
        if (current) return current;
        throw new Error('OpenAI subscription is not authenticated');
      }
      this.lastError = 'OpenAI subscription token refresh failed';
      throw new Error(this.lastError);
    }
  }

  private async runBoundedRefresh(
    credential: OAuthCredential,
    authenticationSignal: AbortSignal
  ): Promise<OAuthCredential> {
    const controller = new AbortController();
    const abortForShutdown = () => controller.abort(abortError(this.lifecycleController.signal));
    const abortForAuthenticationChange = () => controller.abort(abortError(authenticationSignal));
    this.lifecycleController.signal.addEventListener('abort', abortForShutdown, { once: true });
    authenticationSignal.addEventListener('abort', abortForAuthenticationChange, { once: true });
    if (this.lifecycleController.signal.aborted) abortForShutdown();
    if (authenticationSignal.aborted) abortForAuthenticationChange();
    const timeout = setTimeout(() => {
      controller.abort(new Error('OpenAI subscription token refresh timed out'));
    }, this.refreshTimeoutMs);
    timeout.unref?.();

    try {
      return await this.refreshCredential(credential, controller.signal);
    } finally {
      clearTimeout(timeout);
      this.lifecycleController.signal.removeEventListener('abort', abortForShutdown);
      authenticationSignal.removeEventListener('abort', abortForAuthenticationChange);
    }
  }

  private async answerLoginPrompt(
    type: OpenAISubscriptionLoginInput['type'],
    prompt: AuthPrompt,
    login: ActiveLogin
  ): Promise<string> {
    if (prompt.type === 'select') {
      const selection = type === 'chatgptDeviceCode' ? 'device_code' : 'browser';
      if (!prompt.options.some((option) => option.id === selection)) {
        throw new Error('OpenAI subscription provider omitted the requested login method');
      }
      return selection;
    }
    if (prompt.type === 'manual_code') {
      return await waitForLoginCancellation(login.controller.signal, prompt.signal);
    }
    throw new Error('OpenAI subscription provider requested unsupported interactive input');
  }

  private bridgeLoginEvent(
    type: OpenAISubscriptionLoginInput['type'],
    event: AuthEvent,
    login: ActiveLogin,
    announced: Deferred<OpenAISubscriptionLogin>
  ): void {
    if (!this.ownsLogin(login) || login.result) return;
    if (type === 'chatgpt' && event.type === 'auth_url') {
      login.result = { type, loginId: login.id, authUrl: event.url };
    } else if (type === 'chatgptDeviceCode' && event.type === 'device_code') {
      login.result = {
        type,
        loginId: login.id,
        verificationUrl: event.verificationUri,
        userCode: event.userCode,
      };
    }
    if (login.result) announced.resolve(login.result);
  }

  private snapshot(): OpenAISubscriptionProviderStatus {
    const credential = this.credential;
    const metadata = credential ? readCredentialMetadata(credential) : undefined;
    const expiresAt = credential ? credentialExpiry(credential) : undefined;
    const expired = expiresAt !== undefined ? expiresAt <= this.now() : false;
    return {
      state: this.lastError ? 'error' : 'ready',
      refreshing: this.refreshingCredential !== undefined,
      provider: { id: providerId, auth: 'oauth' },
      transport: {
        identity: 'openai-codex-responses',
        preferred: 'websocket',
        fallback: 'http',
      },
      account: credential
        ? {
            state: 'authenticated',
            type: 'chatgpt',
            ...(metadata?.accountId ? { accountId: metadata.accountId } : {}),
            ...(metadata?.email ? { email: metadata.email } : {}),
            ...(metadata?.plan ? { plan: metadata.plan } : {}),
          }
        : { state: 'unauthenticated' },
      auth: credential
        ? {
            state: expired ? 'expired' : 'authenticated',
            expiresAt,
          }
        : { state: 'unauthenticated' },
      models: {
        state: 'ready',
        items: this.models,
        ...(this.defaultModelId ? { defaultModel: this.defaultModelId } : {}),
      },
      ...(this.activeLogin?.result ? { login: this.activeLogin.result } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  private async persistCredential(credential: OAuthCredential): Promise<void> {
    const stored: StoredCredential = {
      version: 1,
      provider: providerId,
      credential,
      updatedAt: new Date(this.now()).toISOString(),
    };
    await atomicWrite(this.files, this.credentialPath, `${JSON.stringify(stored, null, 2)}\n`);
  }

  private async acceptCredential(credential: OAuthCredential): Promise<void> {
    this.replaceCredential(credential);
    this.dirtyPersistence = { credential };
    this.invalidateSessionsIfRequired();
    await this.persistDirtyCredential();
  }

  private async acceptLoginCredential(
    login: ActiveLogin,
    credential: OAuthCredential
  ): Promise<void> {
    const priorCredential = this.credential;
    let persistenceFailed = false;
    try {
      await this.persistCredential(credential);
    } catch {
      persistenceFailed = true;
    }

    if (!this.ownsLogin(login) || login.controller.signal.aborted || this.closed) {
      this.dirtyPersistence = { credential: priorCredential };
      this.lastError = 'OpenAI subscription credential persistence pending';
      await this.persistDirtyCredential(true);
      return;
    }

    this.replaceCredential(credential);
    this.dirtyPersistence = persistenceFailed ? { credential } : undefined;
    this.lastError = persistenceFailed
      ? 'OpenAI subscription credential persistence pending'
      : undefined;
    if (this.ownsLogin(login)) this.activeLogin = undefined;
    this.invalidateSessionsIfRequired();
  }

  private replaceCredential(credential: OAuthCredential | undefined): void {
    this.authenticationController.abort(new Error('OpenAI subscription authentication changed'));
    this.authenticationController = new AbortController();
    this.authenticationGeneration += 1;
    this.credential = credential;
    this.sessionsRequireInvalidation = true;
  }

  private async retryDirtyPersistence(): Promise<void> {
    if (!this.dirtyPersistence) return;
    await this.withCredentialMutation(async () => await this.persistDirtyCredential());
  }

  private async persistDirtyCredential(throwOnFailure = false): Promise<void> {
    const pending = this.dirtyPersistence;
    if (!pending) return;

    try {
      if (pending.credential) {
        await this.persistCredential(pending.credential);
      } else {
        await removeFile(this.files, this.credentialPath);
      }
      if (this.dirtyPersistence === pending) this.dirtyPersistence = undefined;
      this.lastError = undefined;
    } catch (cause) {
      this.lastError = 'OpenAI subscription credential persistence pending';
      if (throwOnFailure) {
        throw new Error('OpenAI subscription credential persistence failed', { cause });
      }
    }
  }

  private invalidateSessionsIfRequired(): void {
    if (!this.sessionsRequireInvalidation) return;
    const failures: unknown[] = [];
    for (const sessionId of this.sessionIds) {
      try {
        this.closeSession(sessionId);
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'OpenAI subscription session invalidation failed');
    }
    this.sessionsRequireInvalidation = false;
  }

  private requireOAuth(): NonNullable<OpenAISubscriptionProvider['auth']['oauth']> {
    const oauth = this.provider.auth.oauth;
    if (!oauth) throw new Error('OpenAI subscription OAuth is unavailable');
    return oauth;
  }

  private ownsLogin(login: ActiveLogin): boolean {
    return this.activeLogin?.id === login.id && this.activeLogin.generation === login.generation;
  }

  private cancelActiveLogin(): void {
    const login = this.activeLogin;
    this.activeLogin = undefined;
    if (login) {
      login.announced.reject(new Error('OpenAI subscription login was canceled'));
      login.controller.abort();
    }
  }

  private async withCredentialMutation<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.credentialMutationTail;
    let release!: () => void;
    this.credentialMutationTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new OpenAISubscriptionProviderClosedError();
  }
}

const nodeFileSystem: OpenAISubscriptionFileSystem = {
  readFile: async (path, encoding) => await nodeFiles.readFile(path, encoding),
  writeFile: async (path, data, options) => await nodeFiles.writeFile(path, data, options),
  mkdir: async (path, options) => await nodeFiles.mkdir(path, options),
  rename: async (from, to) => await nodeFiles.rename(from, to),
  chmod: async (path, mode) => await nodeFiles.chmod(path, mode),
  unlink: async (path) => await nodeFiles.unlink(path),
};

function readProviderModels(
  provider: OpenAISubscriptionProvider
): readonly OpenAISubscriptionProviderModel[] {
  return provider.getModels().map((model) => ({
    id: model.id,
    model: model.id,
    displayName: model.name,
    hidden: false,
  }));
}

async function refreshOpenAISubscriptionCredential(
  credential: OAuthCredential,
  signal: AbortSignal,
  now: number
): Promise<OAuthCredential> {
  let response: Response;
  try {
    response = await fetch(openAiOAuthTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credential.refresh,
        client_id: openAiOAuthClientId,
      }),
      signal,
    });
  } catch (cause) {
    if (signal.aborted) throw abortError(signal);
    throw new Error('OpenAI subscription token refresh transport failed', { cause });
  }

  if (!response.ok) {
    throw new Error(`OpenAI subscription token refresh failed (${response.status})`);
  }

  const body = asRecord(await response.json().catch(() => undefined));
  const access = nonEmptyText(body.access_token);
  const refresh = nonEmptyText(body.refresh_token);
  const expiresIn = finiteNumber(body.expires_in);
  if (!access || !refresh || expiresIn === undefined || expiresIn <= 0) {
    throw new Error('OpenAI subscription token refresh returned invalid credentials');
  }
  const accountId = nonEmptyText(asRecord(decodeJwt(access)?.[codexAuthClaim]).chatgpt_account_id);
  if (!accountId) {
    throw new Error('OpenAI subscription token refresh omitted account identity');
  }
  const idToken = nonEmptyText(body.id_token);

  return {
    type: 'oauth',
    access,
    refresh,
    expires: now + expiresIn * 1000,
    accountId,
    ...(idToken ? { idToken } : {}),
  };
}

async function readStoredCredential(
  files: OpenAISubscriptionFileSystem,
  path: string
): Promise<OAuthCredential | undefined> {
  const contents = await readOptionalFile(files, path);
  if (contents === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error('Zen OpenAI subscription credential file is invalid');
  }
  const record = asRecord(value);
  if (record.version !== 1 || record.provider !== providerId) {
    throw new Error('Zen OpenAI subscription credential file is invalid');
  }
  const credential = readOAuthCredential(record.credential);
  if (!credential) throw new Error('Zen OpenAI subscription credential file is invalid');
  return credential;
}

function readOAuthCredential(value: unknown): OAuthCredential | undefined {
  const record = asRecord(value);
  const access = nonEmptyText(record.access);
  const refresh = nonEmptyText(record.refresh);
  const expires = finiteNumber(record.expires);
  if (record.type !== 'oauth' || !access || !refresh || expires === undefined) return undefined;
  const accountId = nonEmptyText(record.accountId);
  const idToken = nonEmptyText(record.idToken);
  return {
    type: 'oauth',
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
    ...(idToken ? { idToken } : {}),
  };
}

function readCredentialMetadata(credential: OAuthCredential): {
  readonly accountId?: string;
  readonly email?: string;
  readonly plan?: string;
} {
  const access = decodeJwt(credential.access);
  const idToken = decodeJwt(nonEmptyText(credential.idToken));
  const auth = asRecord(access?.[codexAuthClaim]);
  const accountId = nonEmptyText(credential.accountId) ?? nonEmptyText(auth.chatgpt_account_id);
  const email =
    nonEmptyText(idToken?.email) ??
    nonEmptyText(access?.email) ??
    nonEmptyText(auth.chatgpt_account_user_email);
  const plan =
    nonEmptyText(auth.chatgpt_plan_type) ??
    nonEmptyText(auth.plan_type) ??
    nonEmptyText(access?.plan);
  return {
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
  };
}

function decodeJwt(token: string | undefined): Readonly<Record<string, unknown>> | undefined {
  if (!token) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    return asRecord(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
  } catch {
    return undefined;
  }
}

function shouldRefresh(credential: OAuthCredential, now: number): boolean {
  return credentialExpiry(credential) <= now + refreshWindowMs;
}

function credentialExpiry(credential: OAuthCredential): number {
  const tokenExpiry = finiteNumber(decodeJwt(credential.access)?.exp);
  return tokenExpiry === undefined ? credential.expires : tokenExpiry * 1000;
}

async function atomicWrite(
  files: OpenAISubscriptionFileSystem,
  path: string,
  contents: string
): Promise<void> {
  await files.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await files.writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await restrictPermissions(files, temporaryPath);
    await files.rename(temporaryPath, path);
    await restrictPermissions(files, path);
  } catch (cause) {
    await removeFile(files, temporaryPath).catch(() => undefined);
    throw cause;
  }
}

async function restrictPermissions(
  files: OpenAISubscriptionFileSystem,
  path: string
): Promise<void> {
  try {
    await files.chmod(path, 0o600);
  } catch (cause) {
    if (!isUnsupportedPermissionError(cause)) throw cause;
  }
}

async function removeFile(files: OpenAISubscriptionFileSystem, path: string): Promise<void> {
  try {
    await files.unlink(path);
  } catch (cause) {
    if (!isMissingFileError(cause)) throw cause;
  }
}

async function readOptionalFile(
  files: OpenAISubscriptionFileSystem,
  path: string
): Promise<string | undefined> {
  try {
    return await files.readFile(path, 'utf8');
  } catch (cause) {
    if (isMissingFileError(cause)) return undefined;
    throw cause;
  }
}

function waitForLoginCancellation(
  loginSignal: AbortSignal,
  promptSignal?: AbortSignal
): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
    const abort = () => reject(new Error('OpenAI subscription login was canceled'));
    if (loginSignal.aborted || promptSignal?.aborted) {
      abort();
      return;
    }
    loginSignal.addEventListener('abort', abort, { once: true });
    promptSignal?.addEventListener('abort', abort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('OpenAI subscription operation aborted');
  error.name = 'AbortError';
  throw error;
}

function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const finish = (callback: () => void) => {
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => finish(() => rejectPromise(abortError(signal)));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => finish(() => resolvePromise(value)),
      (cause) => finish(() => rejectPromise(cause))
    );
  });
}

function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('OpenAI subscription operation aborted');
  error.name = 'AbortError';
  return error;
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isMissingFileError(cause: unknown): boolean {
  return isNodeError(cause) && cause.code === 'ENOENT';
}

function isUnsupportedPermissionError(cause: unknown): boolean {
  return isNodeError(cause) && ['ENOSYS', 'ENOTSUP', 'EPERM', 'EACCES'].includes(cause.code ?? '');
}

function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error;
}
