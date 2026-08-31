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

function openAiLoginSuccessPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>OpenAI sign-in recognized · Zen</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --color-canvas: #090a0c;
      --color-surface: #15171c;
      --color-surface-emphasis: #20232a;
      --color-border: #292c34;
      --color-text-primary: #f0f1f3;
      --color-text-secondary: #b4b6bd;
      --color-text-muted: #898c96;
      --color-accent: #8ea9ff;
      --color-accent-soft: rgb(142 169 255 / 13%);
      --color-focus-ring: #8ea9ff;
      --color-status-success: #73d2ad;
      --color-status-success-soft: rgb(115 210 173 / 10%);
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
      padding: 32px;
      display: grid;
      place-items: center;
      color: var(--color-text-primary);
      background: var(--color-canvas);
    }
    .confirmation {
      width: min(100%, 560px);
      overflow: hidden;
      border: 1px solid var(--color-border);
      border-radius: 18px;
      background: var(--color-surface);
      box-shadow: 0 24px 64px var(--color-shadow);
    }
    .brand {
      min-height: 88px;
      padding: 20px 28px;
      display: flex;
      align-items: center;
      gap: 14px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface-emphasis);
    }
    .brand svg { width: 48px; height: 48px; flex: 0 0 auto; color: var(--color-text-primary); }
    .brand-name { font-size: 18px; font-weight: 650; letter-spacing: 0.08em; }
    .content { padding: 42px 44px 36px; }
    .eyebrow {
      margin: 0 0 12px;
      color: var(--color-accent);
      font-size: 13px;
      font-weight: 650;
      letter-spacing: 0.09em;
      text-transform: uppercase;
    }
    h1 {
      max-width: 13ch;
      margin: 0;
      font-size: clamp(32px, 7vw, 46px);
      font-weight: 620;
      line-height: 1.08;
      letter-spacing: -0.035em;
      text-wrap: balance;
    }
    .lead {
      max-width: 43ch;
      margin: 20px 0 0;
      color: var(--color-text-secondary);
      font-size: 17px;
      line-height: 1.6;
    }
    .receipt {
      margin: 28px 0;
      padding: 14px 16px;
      display: flex;
      align-items: center;
      gap: 11px;
      border: 1px solid color-mix(in srgb, var(--color-status-success) 35%, transparent);
      border-radius: 10px;
      color: var(--color-text-primary);
      background: var(--color-status-success-soft);
      font-size: 15px;
      line-height: 1.45;
    }
    .receipt svg { width: 20px; height: 20px; flex: 0 0 auto; color: var(--color-status-success); }
    button {
      min-width: 152px;
      min-height: 48px;
      padding: 12px 22px;
      border: 1px solid transparent;
      border-radius: 10px;
      color: #10131b;
      background: var(--color-accent);
      font: inherit;
      font-weight: 650;
      cursor: pointer;
      touch-action: manipulation;
      transition: background-color 160ms ease, box-shadow 160ms ease;
    }
    button:hover { background: color-mix(in srgb, var(--color-accent) 88%, white); }
    button:active { background: color-mix(in srgb, var(--color-accent) 82%, black); }
    button:focus-visible {
      outline: 3px solid var(--color-focus-ring);
      outline-offset: 3px;
    }
    .shortcut {
      margin: 14px 0 0;
      color: var(--color-text-muted);
      font-size: 14px;
      line-height: 1.55;
    }
    .repeat-help { margin-top: 28px; border-top: 1px solid var(--color-border); padding-top: 14px; }
    button.repeat-trigger {
      width: auto;
      min-width: 0;
      min-height: 44px;
      padding: 8px 0;
      border: 0;
      border-radius: 4px;
      color: var(--color-text-secondary);
      background: transparent;
      font-size: 14px;
      font-weight: 600;
      text-align: left;
    }
    button.repeat-trigger:hover { color: var(--color-text-primary); background: transparent; }
    button.repeat-trigger:active { color: var(--color-accent); background: transparent; }
    .repeat-trigger svg { width: 14px; height: 14px; margin-right: 5px; vertical-align: -2px; transition: transform 160ms ease; }
    .repeat-trigger[aria-expanded="true"] svg { transform: rotate(90deg); }
    .repeat-guidance { margin: 4px 0 0; color: var(--color-text-muted); font-size: 14px; line-height: 1.55; }
    [role="status"] { margin-top: 14px; color: var(--color-text-secondary); font-size: 14px; line-height: 1.5; }
    [hidden] { display: none; }
    @media (prefers-color-scheme: light) {
      :root {
        --color-canvas: #e8eaf1;
        --color-surface: #fbfcff;
        --color-surface-emphasis: #f0f2f8;
        --color-border: #cbd0dc;
        --color-text-primary: #1c2029;
        --color-text-secondary: #4d5361;
        --color-text-muted: #616878;
        --color-accent: #526fb9;
        --color-accent-soft: rgb(82 111 185 / 13%);
        --color-focus-ring: #526fb9;
        --color-status-success: #287a60;
        --color-status-success-soft: rgb(40 122 96 / 11%);
        --color-shadow: rgb(45 52 73 / 14%);
      }
    }
    @media (max-width: 480px) {
      body { padding: 16px; place-items: start center; }
      .confirmation { border-radius: 14px; }
      .brand { min-height: 76px; padding: 14px 20px; }
      .brand svg { width: 42px; height: 42px; }
      .content { padding: 30px 24px 28px; }
      h1 { font-size: clamp(30px, 10vw, 38px); }
      .lead { font-size: 16px; }
      button { width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
    }
  </style>
</head>
<body>
  <main class="confirmation" aria-labelledby="confirmation-title">
    <header class="brand">
      <svg viewBox="0 0 64 64" fill="currentColor" role="img" aria-label="Zen logo">
        <path d="M 196.529 17.500 C 188.341 22.175, 181.518 26, 181.368 26 C 181.218 26, 175.032 29.937, 167.622 34.750 C 160.211 39.563, 149.053 46.753, 142.824 50.730 C 136.596 54.706, 124.300 62.687, 115.500 68.466 C 106.700 74.244, 99.050 79.130, 98.500 79.323 C 97.185 79.784, 98.772 84.102, 105.498 98.361 L 110.896 109.806 119.198 115.291 C 123.764 118.308, 136.002 126.706, 146.392 133.955 C 172.471 152.147, 194.479 167, 195.356 167 C 196.162 167, 195.171 160.393, 194.007 158 C 191.110 152.048, 191.487 151.399, 200.500 146.826 C 205.177 144.453, 208.854 142.059, 208.672 141.506 C 208.489 140.953, 206.714 139.375, 204.728 138 C 202.741 136.625, 195.352 131.534, 188.308 126.687 C 181.264 121.840, 172.800 115.958, 169.500 113.616 C 166.200 111.275, 155.513 103.832, 145.750 97.078 C 135.988 90.323, 128.014 84.505, 128.030 84.148 C 128.065 83.420, 175.916 47.951, 182.356 43.881 C 184.635 42.440, 187.607 39.744, 188.959 37.888 C 190.312 36.033, 195.683 29.787, 200.896 24.008 C 215.359 7.974, 214.540 9, 212.883 9 C 212.077 9, 204.718 12.825, 196.529 17.500" transform="translate(0 5) scale(.29)"/>
        <path d="M 25.696 45.637 C 25.411 45.922, 26.263 48.608, 27.589 51.606 C 30.892 59.073, 30.848 59.193, 23.500 62.850 C 19.925 64.629, 17 66.248, 17 66.448 C 17 66.648, 21.387 69.927, 26.750 73.735 C 32.112 77.543, 45.877 87.318, 57.337 95.457 C 74.362 107.546, 77.930 110.483, 76.837 111.507 C 76.102 112.196, 65.600 120.181, 53.500 129.251 C 36.054 142.327, 30.051 147.451, 24.500 154.002 C 20.650 158.546, 14.913 165.175, 11.750 168.733 C 3.421 178.103, 3.876 179.205, 13.500 172.976 C 18.989 169.424, 28.805 163.685, 38.207 158.532 C 40.246 157.414, 44.296 154.888, 47.207 152.917 C 53.139 148.901, 85.736 128.357, 104.302 116.933 C 106.943 115.308, 108.908 113.645, 108.668 113.239 C 108.428 112.833, 105.548 106.847, 102.269 99.939 C 97.266 89.402, 95.722 85.242, 92.685 85.242 C 90.694 84.067, 78.627 75.856, 65.870 66.995 C 53.112 58.135, 41.285 50.609, 39.587 50.272 C 37.889 49.935, 34.186 48.637, 31.357 47.389 C 28.528 46.141, 25.981 45.353, 25.696 45.637" transform="translate(0 5) scale(.29)"/>
      </svg>
      <span class="brand-name">ZEN</span>
    </header>
    <section class="content">
      <p class="eyebrow">OpenAI sign-in</p>
      <h1 id="confirmation-title">Zen recognized your OpenAI sign-in.</h1>
      <p class="lead">Return to Zen to continue. You can safely close this tab.</p>
      <div class="receipt">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>
        <span>Sign-in response received</span>
      </div>
      <button id="close-tab" type="button" autofocus>Close this tab</button>
      <p class="shortcut">If this tab stays open, use Ctrl+W or Command+W, then return to Zen.</p>
      <p id="close-status" role="status" hidden>Your browser kept this tab open. Close it with Ctrl+W or Command+W, then return to Zen.</p>
      <div class="repeat-help">
        <button class="repeat-trigger" id="repeat-trigger" type="button" aria-expanded="false" aria-controls="repeat-guidance">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>
          Opened this page again?
        </button>
        <p class="repeat-guidance" id="repeat-guidance" hidden>Zen already received the sign-in response. Close this copy and return to Zen.</p>
      </div>
    </section>
  </main>
  <script nonce="${nonce}">
    const closeButton = document.querySelector("#close-tab");
    const closeStatus = document.querySelector("#close-status");
    const repeatTrigger = document.querySelector("#repeat-trigger");
    const repeatGuidance = document.querySelector("#repeat-guidance");
    closeButton.addEventListener("click", () => {
      window.close();
      window.setTimeout(() => { closeStatus.hidden = false; }, 150);
    });
    repeatTrigger.addEventListener("click", () => {
      const expanded = repeatTrigger.getAttribute("aria-expanded") === "true";
      repeatTrigger.setAttribute("aria-expanded", String(!expanded));
      repeatGuidance.hidden = expanded;
    });
  </script>
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
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      response.end(openAiLoginSuccessPage(nonce));
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
