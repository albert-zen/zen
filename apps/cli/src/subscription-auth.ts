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

function openAiLoginCallbackPage(
  nonce: string,
  state: "success" | "state-mismatch" | "missing-code",
): string {
  const isSuccess = state === "success";
  const pageTitle = isSuccess
    ? "Sign-in received"
    : state === "state-mismatch"
      ? "Sign-in could not be verified"
      : "Sign-in was not completed";
  const documentTitle = isSuccess ? "OpenAI sign-in received" : pageTitle;
  const detail =
    state === "state-mismatch"
      ? "OAuth state mismatch."
      : "Authorization code missing.";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${documentTitle} · Zen</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --color-canvas: #090a0c;
      --color-surface: #15171c;
      --color-surface-subtle: #1b1e24;
      --color-border: #292c34;
      --color-text-primary: #f0f1f3;
      --color-text-secondary: #b4b6bd;
      --color-focus-ring: #8ea9ff;
      --color-status-error: #ff9b9b;
      --color-status-error-soft: rgb(255 155 155 / 9%);
      --color-shadow: rgb(0 0 0 / 35%);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-synthesis: none;
    }
    * { box-sizing: border-box; }
    html { min-width: 0; background: var(--color-canvas); }
    body {
      min-width: 0;
      min-height: 100vh;
      min-height: 100svh;
      margin: 0;
      padding: 24px;
      display: grid;
      place-items: center;
      color: var(--color-text-primary);
      background: var(--color-canvas);
    }
    .confirmation {
      width: min(100%, 520px);
      overflow: hidden;
      border: 1px solid var(--color-border);
      border-radius: 14px;
      background: var(--color-surface);
      box-shadow: 0 18px 48px var(--color-shadow);
    }
    .brand {
      min-height: 56px;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      gap: 9px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface-subtle);
    }
    .brand svg { width: 26px; height: 26px; flex: 0 0 auto; color: var(--color-text-primary); }
    .brand-name { font-size: 13px; font-weight: 680; letter-spacing: 0.1em; }
    .content {
      padding: 30px;
      text-align: center;
    }
    .provider-context {
      margin: 0 0 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      color: var(--color-text-secondary);
      font-size: 14px;
      font-weight: 620;
      line-height: 1.4;
    }
    .openai-mark {
      width: 24px;
      height: 24px;
      flex: 0 0 auto;
      filter: invert(1);
    }
    h1 {
      margin: 0;
      font-size: 27px;
      font-weight: 640;
      line-height: 1.2;
      letter-spacing: -0.02em;
      text-wrap: balance;
    }
    .lead {
      margin: 10px 0 0;
      color: var(--color-text-secondary);
      font-size: 15px;
      line-height: 1.55;
    }
    button {
      min-height: 44px;
      margin-top: 22px;
      padding: 10px 17px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--color-border);
      border-radius: 999px;
      color: var(--color-text-primary);
      background: var(--color-surface-subtle);
      font: inherit;
      font-size: 14px;
      font-weight: 620;
      cursor: pointer;
      touch-action: manipulation;
      transition: background-color 160ms ease, border-color 160ms ease;
    }
    button:hover {
      border-color: color-mix(in srgb, var(--color-text-primary) 22%, var(--color-border));
      background: color-mix(in srgb, var(--color-text-primary) 7%, var(--color-surface-subtle));
    }
    button:active {
      background: color-mix(in srgb, var(--color-text-primary) 11%, var(--color-surface-subtle));
    }
    button:focus-visible {
      outline: 2px solid var(--color-focus-ring);
      outline-offset: 3px;
    }
    button:disabled { cursor: default; opacity: 0.72; }
    [role="status"] {
      margin: 18px 0 0;
      color: var(--color-text-secondary);
      font-size: 14px;
      line-height: 1.5;
    }
    .error-detail {
      margin: 18px 0 0;
      padding: 11px 13px;
      border: 1px solid color-mix(in srgb, var(--color-status-error) 30%, transparent);
      border-radius: 8px;
      color: var(--color-text-primary);
      background: var(--color-status-error-soft);
      font-size: 14px;
      line-height: 1.45;
    }
    [hidden] { display: none; }
    @media (prefers-color-scheme: light) {
      :root {
        --color-canvas: #e8eaf1;
        --color-surface: #fbfcff;
        --color-surface-subtle: #f0f2f8;
        --color-border: #cbd0dc;
        --color-text-primary: #1c2029;
        --color-text-secondary: #4d5361;
        --color-focus-ring: #526fb9;
        --color-status-error: #a33e3e;
        --color-status-error-soft: rgb(163 62 62 / 8%);
        --color-shadow: rgb(45 52 73 / 14%);
      }
      .openai-mark { filter: none; }
    }
    @media (max-width: 480px) {
      body { padding: 16px; place-items: start center; }
      .confirmation { border-radius: 12px; }
      .brand { min-height: 52px; padding: 11px 18px; }
      .brand svg { width: 24px; height: 24px; }
      .content { padding: 24px 22px 26px; }
      h1 { font-size: 25px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
    }
  </style>
</head>
<body>
  <main class="confirmation" aria-labelledby="confirmation-title">
    <header class="brand">
      <svg viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
        <path d="M 196.529 17.500 C 188.341 22.175, 181.518 26, 181.368 26 C 181.218 26, 175.032 29.937, 167.622 34.750 C 160.211 39.563, 149.053 46.753, 142.824 50.730 C 136.596 54.706, 124.300 62.687, 115.500 68.466 C 106.700 74.244, 99.050 79.130, 98.500 79.323 C 97.185 79.784, 98.772 84.102, 105.498 98.361 L 110.896 109.806 119.198 115.291 C 123.764 118.308, 136.002 126.706, 146.392 133.955 C 172.471 152.147, 194.479 167, 195.356 167 C 196.162 167, 195.171 160.393, 194.007 158 C 191.110 152.048, 191.487 151.399, 200.500 146.826 C 205.177 144.453, 208.854 142.059, 208.672 141.506 C 208.489 140.953, 206.714 139.375, 204.728 138 C 202.741 136.625, 195.352 131.534, 188.308 126.687 C 181.264 121.840, 172.800 115.958, 169.500 113.616 C 166.200 111.275, 155.513 103.832, 145.750 97.078 C 135.988 90.323, 128.014 84.505, 128.030 84.148 C 128.065 83.420, 175.916 47.951, 182.356 43.881 C 184.635 42.440, 187.607 39.744, 188.959 37.888 C 190.312 36.033, 195.683 29.787, 200.896 24.008 C 215.359 7.974, 214.540 9, 212.883 9 C 212.077 9, 204.718 12.825, 196.529 17.500" transform="translate(0 5) scale(.29)"/>
        <path d="M 25.696 45.637 C 25.411 45.922, 26.263 48.608, 27.589 51.606 C 30.892 59.073, 30.848 59.193, 23.500 62.850 C 19.925 64.629, 17 66.248, 17 66.448 C 17 66.648, 21.387 69.927, 26.750 73.735 C 32.112 77.543, 45.877 87.318, 57.337 95.457 C 74.362 107.546, 77.930 110.483, 76.837 111.507 C 76.102 112.196, 65.600 120.181, 53.500 129.251 C 36.054 142.327, 30.051 147.451, 24.500 154.002 C 20.650 158.546, 14.913 165.175, 11.750 168.733 C 3.421 178.103, 3.876 179.205, 13.500 172.976 C 18.989 169.424, 28.805 163.685, 38.207 158.532 C 40.246 157.414, 44.296 154.888, 47.207 152.917 C 53.139 148.901, 85.736 128.357, 104.302 116.933 C 106.943 115.308, 108.908 113.645, 108.668 113.239 C 108.428 112.833, 105.548 106.847, 102.269 99.939 C 97.266 89.402, 95.722 85.242, 92.685 85.242 C 90.694 84.067, 78.627 75.856, 65.870 66.995 C 53.112 58.135, 41.285 50.609, 39.587 50.272 C 37.889 49.935, 34.186 48.637, 31.357 47.389 C 28.528 46.141, 25.981 45.353, 25.696 45.637" transform="translate(0 5) scale(.29)"/>
      </svg>
      <span class="brand-name">ZEN</span>
    </header>
    <section class="content">
      <div class="provider-context">
        <svg class="openai-mark" viewBox="146.694 227.042 267.198 264.812" aria-hidden="true">
          <path d="M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 361.305 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z" fill="#000"/>
        </svg>
        <span>OpenAI sign-in</span>
      </div>
      <h1 id="confirmation-title">${pageTitle}</h1>
      ${
        isSuccess
          ? `<p class="lead">Return to Zen to continue.</p>
      <button id="close-tab" type="button" autofocus>Close this tab</button>
      <p id="close-status" role="status" aria-live="polite" hidden>Your browser kept this tab open. Use Ctrl+W or Command+W, then return to Zen.</p>`
          : `<p class="lead">Return to Zen and start OpenAI sign-in again.</p>
      <p class="error-detail">${detail}</p>`
      }
    </section>
  </main>
  ${
    isSuccess
      ? `<script nonce="${nonce}">
    const closeButton = document.querySelector("#close-tab");
    const closeStatus = document.querySelector("#close-status");
    closeButton.addEventListener("click", () => {
      closeButton.disabled = true;
      window.close();
      window.setTimeout(() => {
        closeButton.hidden = true;
        closeStatus.hidden = false;
      }, 150);
    });
  </script>`
      : ""
  }
</body>
</html>`;
}

async function startLocalOAuthServer(
  state: string,
): Promise<OAuthServer | undefined> {
  const nonce = randomBytes(16).toString("base64");
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
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
        response.end(openAiLoginCallbackPage(nonce, "state-mismatch"));
        return;
      }
      const code = url.searchParams.get("code");
      if (code === null || code.length === 0) {
        response.writeHead(400, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
        response.end(openAiLoginCallbackPage(nonce, "missing-code"));
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      response.end(openAiLoginCallbackPage(nonce, "success"));
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
