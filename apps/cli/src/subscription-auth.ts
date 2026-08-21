import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  rename,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";

import {
  extractChatGptAccountId,
  type OpenAiSubscriptionAccessLease,
} from "../../../src/model/openai-subscription.js";

const providerId = "openai-codex";
const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const authorizeUrl = "https://auth.openai.com/oauth/authorize";
const tokenUrl = "https://auth.openai.com/oauth/token";
const redirectUri = "http://localhost:1455/auth/callback";
const oauthScope = "openid profile email offline_access";
const refreshSkewMs = 60_000;
const lockPollIntervalMs = 25;
const lockStaleAfterMs = 5 * 60_000;
const lockWaitTimeoutMs = 2 * 60_000;
const lockHeartbeatIntervalMs = 10_000;

export interface SubscriptionManualCodeRequest {
  message: string;
  placeholder?: string;
  signal: AbortSignal;
}

export interface SubscriptionLoginInteraction {
  notifyAuthUrl(url: string): void;
  readManualCode(request: SubscriptionManualCodeRequest): Promise<string>;
  signal?: AbortSignal;
}

export interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

interface StoredProfile {
  version: 1;
  provider: typeof providerId;
  credential: OAuthCredential;
}

export interface OpenAiSubscriptionStatus {
  authenticated: boolean;
  expired: boolean;
  expiresAt?: number;
  accountId?: string;
}

export interface OpenAiSubscriptionAuthProfileOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  tokenEndpoint?: string;
}

/**
 * Host-owned ChatGPT OAuth profile. It never reads or writes Codex's profile
 * and is intentionally separate from Zen Thread journals.
 */
export class OpenAiSubscriptionAuthProfile {
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #store: SubscriptionCredentialStore;
  readonly #tokenEndpoint: string;

  constructor(
    profilePath: string,
    options: OpenAiSubscriptionAuthProfileOptions = {},
  ) {
    this.#store = new SubscriptionCredentialStore(profilePath);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#tokenEndpoint = options.tokenEndpoint ?? tokenUrl;
  }

  async login(interaction: SubscriptionLoginInteraction): Promise<void> {
    const flow = createAuthorizationFlow();
    const callback = await startLocalOAuthServer(flow.state);
    const manualAbort = new AbortController();
    const promptSignal =
      interaction.signal === undefined
        ? manualAbort.signal
        : AbortSignal.any([interaction.signal, manualAbort.signal]);
    let manualCode: string | undefined;
    let manualError: unknown;

    interaction.notifyAuthUrl(flow.url);

    const manualPromise = interaction
      .readManualCode({
        message:
          "Complete login in your browser, or paste the authorization code / redirect URL here:",
        placeholder: redirectUri,
        signal: promptSignal,
      })
      .then((value) => {
        manualCode = value;
        callback?.cancelWait();
      })
      .catch((error: unknown) => {
        if (!manualAbort.signal.aborted) {
          manualError = error;
        }
        callback?.cancelWait();
      });

    try {
      const callbackResult =
        callback === undefined ? null : await callback.waitForCode();
      let code = callbackResult?.code;
      if (code !== undefined) {
        manualAbort.abort();
      } else {
        await manualPromise;
        if (manualError !== undefined) {
          throw manualError;
        }
        const parsed = parseAuthorizationInput(manualCode ?? "");
        if (parsed.state !== undefined && parsed.state !== flow.state) {
          throw new Error("OpenAI subscription OAuth state mismatch");
        }
        code = parsed.code;
      }
      if (code === undefined || code.length === 0) {
        throw new Error("OpenAI subscription OAuth code was missing");
      }

      const credential = await exchangeAuthorizationCode(
        code,
        flow.verifier,
        this.#fetch,
        this.#tokenEndpoint,
        interaction.signal,
        this.#now,
      );
      await this.#store.modify(async () => credential, interaction.signal);
    } finally {
      manualAbort.abort();
      callback?.close();
    }
  }

  async logout(): Promise<void> {
    await this.#store.delete();
  }

  async status(): Promise<OpenAiSubscriptionStatus> {
    const credential = await this.#store.read();
    if (credential === undefined) {
      return { authenticated: false, expired: false };
    }
    return {
      authenticated: true,
      expired: this.#now() >= credential.expires,
      expiresAt: credential.expires,
      accountId: credential.accountId,
    };
  }

  async acquireAccessLease(
    signal: AbortSignal,
  ): Promise<OpenAiSubscriptionAccessLease> {
    signal.throwIfAborted();
    const credential = await this.#store.modify(async (current) => {
      if (current === undefined) {
        throw new Error(
          "OpenAI subscription is not authenticated; run `zen auth login`",
        );
      }
      if (current.expires > this.#now() + refreshSkewMs) {
        return undefined;
      }
      return await refreshCredential(
        current.refresh,
        this.#fetch,
        this.#tokenEndpoint,
        signal,
        this.#now,
      );
    }, signal);
    signal.throwIfAborted();
    if (credential === undefined) {
      throw new Error(
        "OpenAI subscription is not authenticated; run `zen auth login`",
      );
    }
    return { accessToken: credential.access };
  }

  async renewAccessLease(
    rejectedAccessToken: string,
    signal: AbortSignal,
  ): Promise<OpenAiSubscriptionAccessLease> {
    signal.throwIfAborted();
    const credential = await this.#store.modify(async (current) => {
      if (current === undefined) {
        throw new Error(
          "OpenAI subscription is not authenticated; run `zen auth login`",
        );
      }
      if (current.access !== rejectedAccessToken) {
        return undefined;
      }
      return await refreshCredential(
        current.refresh,
        this.#fetch,
        this.#tokenEndpoint,
        signal,
        this.#now,
      );
    }, signal);
    signal.throwIfAborted();
    if (credential === undefined) {
      throw new Error(
        "OpenAI subscription is not authenticated; run `zen auth login`",
      );
    }
    return { accessToken: credential.access };
  }
}

export class SubscriptionCredentialStore {
  readonly #profilePath: string;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(profilePath: string) {
    this.#profilePath = path.resolve(profilePath);
  }

  async read(): Promise<OAuthCredential | undefined> {
    return (await this.#readProfile())?.credential;
  }

  async modify(
    change: (
      current: OAuthCredential | undefined,
    ) => Promise<OAuthCredential | undefined>,
    signal?: AbortSignal,
  ): Promise<OAuthCredential | undefined> {
    return await this.#serialize(async () => {
      return await this.#withProfileLock(async () => {
        signal?.throwIfAborted();
        const current = (await this.#readProfile())?.credential;
        const next = await change(current);
        if (next === undefined) {
          return current;
        }
        assertOAuthCredential(next);
        await this.#writeProfile({
          version: 1,
          provider: providerId,
          credential: next,
        });
        return next;
      }, signal);
    }, signal);
  }

  async delete(): Promise<void> {
    await this.#serialize(async () => {
      await this.#withProfileLock(async () => {
        await removeOptionalFile(this.#profilePath);
      });
    });
  }

  async #serialize<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.#mutationTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#mutationTail = previous.then(
      async () => await gate,
      async () => await gate,
    );
    try {
      await waitForAbort(previous, signal);
      signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  async #readProfile(): Promise<StoredProfile | undefined> {
    let handle;
    try {
      handle = await open(this.#profilePath, "r");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }

    let contents: string;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new Error("OpenAI subscription profile is not a regular file");
      }
      if (process.platform !== "win32" && (metadata.mode & 0o044) !== 0) {
        throw new Error(
          `OpenAI subscription profile is readable by group or others; run chmod 600 ${this.#profilePath}`,
        );
      }
      contents = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }

    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw new Error("OpenAI subscription profile is invalid");
    }
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.provider !== providerId
    ) {
      throw new Error("OpenAI subscription profile is invalid");
    }
    assertOAuthCredential(value.credential);
    return {
      version: 1,
      provider: providerId,
      credential: value.credential,
    };
  }

  async #withProfileLock<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const directory = path.dirname(this.#profilePath);
    const lockPath = `${this.#profilePath}.lock`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + lockWaitTimeoutMs;

    while (true) {
      signal?.throwIfAborted();
      try {
        await mkdir(lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
        await removeStaleLock(lockPath);
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for OpenAI subscription profile");
        }
        await delay(lockPollIntervalMs, signal);
      }
    }

    const heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(lockPath, now, now).catch(() => undefined);
    }, lockHeartbeatIntervalMs);
    heartbeat.unref();

    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      clearInterval(heartbeat);
      await rmdir(lockPath).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      });
    }
  }

  async #writeProfile(profile: StoredProfile): Promise<void> {
    const directory = path.dirname(this.#profilePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#profilePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await restrictPermissions(temporaryPath);
      await rename(temporaryPath, this.#profilePath);
      await restrictPermissions(this.#profilePath);
    } catch (error) {
      await removeOptionalFile(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

interface OAuthServer {
  close(): void;
  cancelWait(): void;
  waitForCode(): Promise<{ code: string } | null>;
}

async function startLocalOAuthServer(
  state: string,
): Promise<OAuthServer | undefined> {
  let settle: ((value: { code: string } | null) => void) | undefined;
  const result = new Promise<{ code: string } | null>((resolve) => {
    let settled = false;
    settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
  });

  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        response.writeHead(404, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("Callback route not found.");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        response.writeHead(400, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("OAuth state mismatch.");
        return;
      }
      const code = url.searchParams.get("code");
      if (code === null || code.length === 0) {
        response.writeHead(400, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("Authorization code missing.");
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        "OpenAI authentication completed. You can close this window.",
      );
      settle?.({ code });
    } catch {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("OAuth callback failed.");
    }
  });

  const listening = await listenForOAuth(server);
  if (!listening) {
    server.close();
    return undefined;
  }
  return {
    close: () => server.close(),
    cancelWait: () => settle?.(null),
    waitForCode: async () => await result,
  };
}

async function listenForOAuth(server: Server): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const error = (): void => {
      resolve(false);
    };
    server.once("error", error);
    server.listen(1455, "127.0.0.1", () => {
      server.off("error", error);
      resolve(true);
    });
  });
}

function createAuthorizationFlow(): {
  verifier: string;
  state: string;
  url: string;
} {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  const url = new URL(authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", oauthScope);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "zen");
  return { verifier, state, url: url.toString() };
}

function parseAuthorizationInput(input: string): {
  code?: string;
  state?: string;
} {
  const value = input.trim();
  if (value.length === 0) {
    return {};
  }
  try {
    const url = new URL(value);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    return {
      ...(code === null ? {} : { code }),
      ...(state === null ? {} : { state }),
    };
  } catch {
    // A raw code is also accepted for remote/headless terminals.
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return {
      ...(code === undefined ? {} : { code }),
      ...(state === undefined ? {} : { state }),
    };
  }
  if (value.includes("code=")) {
    const parameters = new URLSearchParams(value);
    const code = parameters.get("code");
    const state = parameters.get("state");
    return {
      ...(code === null ? {} : { code }),
      ...(state === null ? {} : { state }),
    };
  }
  return { code: value };
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  fetch: typeof globalThis.fetch,
  endpoint: string,
  signal: AbortSignal | undefined,
  now: () => number,
): Promise<OAuthCredential> {
  return await requestToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
    "exchange",
    fetch,
    endpoint,
    signal,
    now,
  );
}

async function refreshCredential(
  refreshToken: string,
  fetch: typeof globalThis.fetch,
  endpoint: string,
  signal: AbortSignal,
  now: () => number,
): Promise<OAuthCredential> {
  return await requestToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
    "refresh",
    fetch,
    endpoint,
    signal,
    now,
  );
}

async function requestToken(
  body: URLSearchParams,
  operation: "exchange" | "refresh",
  fetch: typeof globalThis.fetch,
  endpoint: string,
  signal: AbortSignal | undefined,
  now: () => number,
): Promise<OAuthCredential> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    signal?.throwIfAborted();
    throw new Error(`OpenAI subscription token ${operation} request failed`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `OpenAI subscription token ${operation} failed with HTTP ${response.status}`,
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(
      `OpenAI subscription token ${operation} response was invalid`,
    );
  }
  if (!isRecord(value)) {
    throw new Error(
      `OpenAI subscription token ${operation} response was invalid`,
    );
  }
  const access = value.access_token;
  const refresh = value.refresh_token;
  const expiresIn = value.expires_in;
  if (
    typeof access !== "string" ||
    access.length === 0 ||
    typeof refresh !== "string" ||
    refresh.length === 0 ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new Error(
      `OpenAI subscription token ${operation} response was missing required fields`,
    );
  }
  return {
    type: "oauth",
    access,
    refresh,
    expires: now() + expiresIn * 1000,
    accountId: extractChatGptAccountId(access),
  };
}

async function removeStaleLock(lockPath: string): Promise<void> {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (Date.now() - lockStat.mtimeMs < lockStaleAfterMs) {
    return;
  }

  const stalePath = `${lockPath}.stale.${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if (
      isNodeError(error) &&
      ["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code ?? "")
    ) {
      return;
    }
    throw error;
  }
  await rmdir(stalePath);
}

async function delay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await waitForAbort(
    new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
    signal,
  );
}

async function waitForAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) {
    return await operation;
  }
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      cleanup();
      reject(
        signal.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function assertOAuthCredential(
  value: unknown,
): asserts value is OAuthCredential {
  if (
    !isRecord(value) ||
    value.type !== "oauth" ||
    typeof value.access !== "string" ||
    value.access.length === 0 ||
    typeof value.refresh !== "string" ||
    value.refresh.length === 0 ||
    typeof value.expires !== "number" ||
    !Number.isFinite(value.expires) ||
    typeof value.accountId !== "string" ||
    value.accountId.length === 0
  ) {
    throw new Error("OpenAI subscription profile is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function restrictPermissions(filePath: string): Promise<void> {
  try {
    await chmod(filePath, 0o600);
  } catch (error) {
    if (
      !isNodeError(error) ||
      !["ENOSYS", "ENOTSUP", "EPERM", "EACCES"].includes(error.code ?? "")
    ) {
      throw error;
    }
  }
}

async function removeOptionalFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
