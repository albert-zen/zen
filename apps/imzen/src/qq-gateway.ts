import { createHash } from 'node:crypto';

import type { QQBotCredential } from './config.js';
import type { QQInboundMessage, QQOutboundMessage } from './types.js';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com';
const INTENTS = (1 << 1) | (1 << 12) | (1 << 25) | (1 << 30);
const SUPPORTED_EVENTS = new Set(['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE']);
const MENTION_PREFIX = /^(?:<@!?\w+>\s*)+/u;
const MAX_REPLY_CHARS = 1_800;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_FRAME_DRAIN_TIMEOUT_MS = 10_000;

export type QQGatewayOptions = {
  readonly apiBase: string;
  readonly clock?: () => number;
  readonly credential: QQBotCredential;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
  readonly shutdownFrameDrainTimeoutMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly startupTimeoutMs?: number;
  readonly websocketFactory?: (url: string) => WebSocket;
};

export class QQGateway {
  private accessToken?: string;
  private accessTokenExpiresAtMs = 0;
  private apiBase: string;
  private currentSocket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastSequence: number | null = null;
  private onInbound?: (message: QQInboundMessage) => Promise<unknown>;
  private readyResolve?: () => void;
  private readonly stopController = new AbortController();
  private runner?: Promise<void>;
  private sessionId?: string;

  constructor(private readonly options: QQGatewayOptions) {
    this.apiBase = options.apiBase;
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
    ) {
      throw new Error('requestTimeoutMs must be a positive finite number');
    }
    if (
      options.shutdownFrameDrainTimeoutMs !== undefined &&
      (!Number.isFinite(options.shutdownFrameDrainTimeoutMs) ||
        options.shutdownFrameDrainTimeoutMs <= 0)
    ) {
      throw new Error('shutdownFrameDrainTimeoutMs must be a positive finite number');
    }
  }

  async start(onInbound: (message: QQInboundMessage) => Promise<unknown>): Promise<void> {
    if (this.runner) throw new Error('QQ Gateway is already started');
    this.onInbound = onInbound;
    const ready = new Promise<void>((resolvePromise) => {
      this.readyResolve = resolvePromise;
    });
    this.runner = this.runForever();
    await Promise.race([
      ready,
      abortableSleep(this.options.startupTimeoutMs ?? 15_000, this.stopController.signal).then(
        () => {
          throw new Error('QQ Gateway did not become ready before the startup timeout');
        }
      ),
    ]);
  }

  async stop(): Promise<void> {
    if (this.stopController.signal.aborted) return;
    this.stopController.abort();
    this.clearHeartbeat();
    this.currentSocket?.close(1000, 'IMZen stopping');
    await Promise.allSettled([this.runner]);
  }

  async send(message: QQOutboundMessage): Promise<void> {
    let token: string;
    let refreshed = false;
    try {
      token = await this.getAccessToken();
    } catch (cause) {
      if (!isUnauthorized(cause)) throw cause;
      refreshed = true;
      this.invalidateAccessToken();
      token = await this.getAccessToken();
    }
    const chunks = splitText(message.text, MAX_REPLY_CHARS);
    for (let index = 0; index < chunks.length; index += 1) {
      const msgSeq = stableSequence(`${message.deliveryId}:${index}`);
      const replyAgeMs = (this.options.clock ?? Date.now)() - message.receivedAtMs;
      const passiveWindowMs = message.conversationId.startsWith('group:') ? 270_000 : 3_300_000;
      const replyTo = replyAgeMs <= passiveWindowMs ? message.replyToMessageId : undefined;
      try {
        await this.postMessage(
          message.conversationId,
          chunks[index]!,
          msgSeq,
          replyTo,
          token,
          true
        );
      } catch (cause) {
        if (refreshed || !isUnauthorized(cause)) throw cause;
        refreshed = true;
        this.invalidateAccessToken(token);
        token = await this.getAccessToken();
        await this.postMessage(
          message.conversationId,
          chunks[index]!,
          msgSeq,
          replyTo,
          token,
          true
        );
      }
    }
  }

  private async runForever(): Promise<void> {
    let failures = 0;
    let authRetryUsed = false;
    while (!this.stopController.signal.aborted) {
      let token: string | undefined;
      try {
        token = await this.getAccessToken();
        const gatewayUrl = await this.getGatewayUrl(token);
        await this.runSession(gatewayUrl, token);
        failures = 0;
        authRetryUsed = false;
      } catch (cause) {
        if (this.stopController.signal.aborted) return;
        if (isUnauthorized(cause)) {
          this.invalidateAccessToken(token);
          if (!authRetryUsed) {
            authRetryUsed = true;
            continue;
          }
        }
        authRetryUsed = false;
        failures += 1;
        console.error(`QQ Gateway reconnect attempt=${failures}: ${errorMessage(cause)}`);
      }
      if (!this.stopController.signal.aborted) {
        await this.sleep(Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6)));
      }
    }
  }

  private async runSession(url: string, token: string): Promise<void> {
    const socket = (this.options.websocketFactory ?? ((target) => new WebSocket(target)))(
      validateGatewayUrl(url)
    );
    const stopSignal = this.stopController.signal;
    let onAbort: (() => void) | undefined;
    this.currentSocket = socket;
    try {
      await new Promise<void>((resolvePromise, reject) => {
        let opened = false;
        let frameTail = Promise.resolve();
        let closing = false;
        let settled = false;
        let draining = false;
        let ignoreFrameFailure = false;
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        const clearDrainTimer = (): void => {
          if (!drainTimer) return;
          clearTimeout(drainTimer);
          drainTimer = undefined;
        };
        const resolveSession = (): void => {
          if (settled) return;
          settled = true;
          clearDrainTimer();
          resolvePromise();
        };
        const rejectSession = (cause: unknown): void => {
          if (settled) return;
          settled = true;
          clearDrainTimer();
          reject(cause);
        };
        const settleAfterFrames = (
          ignoreFailure: boolean,
          enforceShutdownDeadline: boolean
        ): void => {
          ignoreFrameFailure ||= ignoreFailure;
          if (!draining) {
            draining = true;
            void frameTail.then(resolveSession, (cause: unknown) => {
              if (ignoreFrameFailure) resolveSession();
              else rejectSession(cause);
            });
          }
          if (!enforceShutdownDeadline || drainTimer || settled) return;
          drainTimer = setTimeout(
            resolveSession,
            this.options.shutdownFrameDrainTimeoutMs ?? DEFAULT_SHUTDOWN_FRAME_DRAIN_TIMEOUT_MS
          );
          drainTimer.unref();
        };
        onAbort = (): void => {
          if (settled) return;
          closing = true;
          try {
            socket.close(1000, 'IMZen stopping');
          } catch {
            // The session still settles from its ordered frame chain.
          }
          settleAfterFrames(true, true);
        };
        socket.addEventListener('open', () => {
          opened = true;
        });
        socket.addEventListener('message', (event) => {
          if (closing) return;
          frameTail = frameTail.then(async () => {
            await this.handleFrame(String(event.data), socket, token);
          });
          void frameTail.catch((cause: unknown) => {
            if (closing) return;
            closing = true;
            try {
              socket.close(1011, 'frame handling failed');
            } catch {
              // Rejecting the session is sufficient to trigger reconnect.
            }
            rejectSession(cause);
          });
        });
        socket.addEventListener('error', () => {
          if (!opened) {
            closing = true;
            rejectSession(new Error('QQ Gateway websocket failed to connect'));
          }
        });
        socket.addEventListener('close', () => {
          if (settled) return;
          closing = true;
          settleAfterFrames(stopSignal.aborted, stopSignal.aborted);
        });
        stopSignal.addEventListener('abort', onAbort, { once: true });
        if (stopSignal.aborted) onAbort();
      });
    } finally {
      if (onAbort) stopSignal.removeEventListener('abort', onAbort);
      this.clearHeartbeat();
      if (this.currentSocket === socket) this.currentSocket = undefined;
    }
  }

  private async handleFrame(raw: string, socket: WebSocket, token: string): Promise<void> {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const op = payload.op;
    const sequence = typeof payload.s === 'number' ? payload.s : undefined;
    if (op === 10) {
      const data = record(payload.d);
      const interval =
        typeof data.heartbeat_interval === 'number' ? data.heartbeat_interval : 45_000;
      this.clearHeartbeat();
      this.heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ op: 1, d: this.lastSequence }));
        }
      }, interval);
      socket.send(JSON.stringify(this.resumeOrIdentify(token)));
      return;
    }
    if (op === 9) {
      this.sessionId = undefined;
      this.lastSequence = null;
      socket.close(1000, 'invalid session');
      return;
    }
    if (op === 7) {
      socket.close(1000, 'server reconnect');
      return;
    }
    if (op !== 0) return;
    const eventType = typeof payload.t === 'string' ? payload.t : '';
    const data = record(payload.d);
    if (eventType === 'READY') {
      this.sessionId = typeof data.session_id === 'string' ? data.session_id : undefined;
      if (sequence !== undefined) this.lastSequence = sequence;
      this.readyResolve?.();
      this.readyResolve = undefined;
      return;
    }
    if (eventType === 'RESUMED') {
      if (sequence !== undefined) this.lastSequence = sequence;
      this.readyResolve?.();
      this.readyResolve = undefined;
      return;
    }
    if (!SUPPORTED_EVENTS.has(eventType)) {
      if (sequence !== undefined) this.lastSequence = sequence;
      return;
    }
    const inbound = parseInbound(eventType, data, (this.options.clock ?? Date.now)());
    if (inbound) await this.onInbound?.(inbound);
    if (sequence !== undefined) this.lastSequence = sequence;
  }

  private resumeOrIdentify(token: string): Record<string, unknown> {
    if (this.sessionId && this.lastSequence !== null) {
      return {
        op: 6,
        d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSequence },
      };
    }
    return { op: 2, d: { token: `QQBot ${token}`, intents: INTENTS, shard: [0, 1] } };
  }

  private async getAccessToken(): Promise<string> {
    const now = (this.options.clock ?? Date.now)();
    if (this.accessToken && now < this.accessTokenExpiresAtMs - 60_000) return this.accessToken;
    const response = await this.fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appId: this.options.credential.appId,
        clientSecret: this.options.credential.appSecret,
      }),
    });
    if (!response.ok) {
      if (response.status === 401) throw new QQUnauthorizedError('QQ token request');
      throw new Error(`QQ token request failed with HTTP ${response.status}`);
    }
    const value = record(await response.json());
    if (typeof value.access_token !== 'string' || !value.access_token) {
      throw new Error('QQ token response did not include access_token');
    }
    const expiresIn = Number(value.expires_in ?? 7_200);
    this.accessToken = value.access_token;
    this.accessTokenExpiresAtMs = now + (Number.isFinite(expiresIn) ? expiresIn : 7_200) * 1_000;
    return this.accessToken;
  }

  private async getGatewayUrl(token: string): Promise<string> {
    for (const apiBase of this.apiBase === 'https://api.sgroup.qq.com'
      ? [this.apiBase, SANDBOX_API_BASE]
      : [this.apiBase]) {
      const response = await this.fetchWithTimeout(`${apiBase}/gateway`, {
        redirect: 'error',
        headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
      });
      if (response.ok) {
        const value = record(await response.json());
        if (typeof value.url !== 'string')
          throw new Error('QQ gateway response did not include url');
        this.apiBase = apiBase;
        return value.url;
      }
      if (apiBase !== 'https://api.sgroup.qq.com' || response.status !== 401) {
        if (response.status === 401) throw new QQUnauthorizedError('QQ gateway request');
        throw new Error(`QQ gateway request failed with HTTP ${response.status}`);
      }
    }
    throw new Error('QQ gateway request failed');
  }

  private async postMessage(
    conversationId: string,
    text: string,
    msgSeq: number,
    replyTo: string | undefined,
    token: string,
    markdown: boolean
  ): Promise<void> {
    const path = conversationPath(conversationId);
    const body = markdown
      ? {
          markdown: { content: text },
          msg_type: 2,
          msg_seq: msgSeq,
          ...(replyTo ? { msg_id: replyTo } : {}),
        }
      : { content: text, msg_type: 0, msg_seq: msgSeq, ...(replyTo ? { msg_id: replyTo } : {}) };
    const response = await this.fetchWithTimeout(`${this.apiBase}${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return;
    if (response.status === 401) throw new QQUnauthorizedError('QQ message delivery');
    const responseText = await response.text();
    if (/duplicate|消息被去重/iu.test(responseText)) return;
    if (markdown && (response.status === 400 || response.status === 403)) {
      await this.postMessage(conversationId, text, msgSeq, replyTo, token, false);
      return;
    }
    throw new Error(`QQ message delivery failed with HTTP ${response.status}`);
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async fetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit = {}
  ): Promise<Response> {
    const parentSignal = this.stopController.signal;
    if (parentSignal.aborted) throw parentSignal.reason;
    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort(parentSignal.reason);
    const timeout = setTimeout(() => {
      controller.abort(new Error('QQ request timed out'));
    }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    let onRequestAbort!: () => void;
    const cancellation = new Promise<never>((_, reject) => {
      onRequestAbort = (): void => reject(controller.signal.reason);
    });
    controller.signal.addEventListener('abort', onRequestAbort, { once: true });
    try {
      const request = Promise.resolve().then(() =>
        this.fetchImpl(input, { ...init, signal: controller.signal })
      );
      return await Promise.race([request, cancellation]);
    } finally {
      clearTimeout(timeout);
      parentSignal.removeEventListener('abort', onParentAbort);
      controller.signal.removeEventListener('abort', onRequestAbort);
    }
  }

  private invalidateAccessToken(token?: string): void {
    if (token === undefined || this.accessToken === token) {
      this.accessToken = undefined;
      this.accessTokenExpiresAtMs = 0;
    }
  }

  private async sleep(ms: number): Promise<void> {
    await (this.options.sleep ?? abortableSleep)(ms, this.stopController.signal);
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

export function parseInbound(
  eventType: string,
  payload: Record<string, unknown>,
  receivedAtMs: number
): QQInboundMessage | undefined {
  if (!SUPPORTED_EVENTS.has(eventType)) return undefined;
  const author = record(payload.author);
  const messageId = typeof payload.id === 'string' ? payload.id : '';
  const group = eventType === 'GROUP_AT_MESSAGE_CREATE';
  const userId = String(author[group ? 'member_openid' : 'user_openid'] ?? author.id ?? '');
  const routeId = group ? String(payload.group_openid ?? '') : userId;
  let text = typeof payload.content === 'string' ? payload.content.trim() : '';
  if (group) text = text.replace(MENTION_PREFIX, '').trim();
  if (!messageId || !userId || !routeId || !text) return undefined;
  return {
    conversationId: `${group ? 'group' : 'c2c'}:${routeId}`,
    kind: group ? 'group' : 'c2c',
    messageId,
    receivedAtMs,
    text,
    userId,
  };
}

function validateGatewayUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'wss:' ||
    url.username ||
    url.password ||
    !(url.hostname === 'qq.com' || url.hostname.endsWith('.qq.com'))
  ) {
    throw new Error('QQ Gateway URL is not a trusted QQ WSS endpoint');
  }
  return url.href;
}

function conversationPath(conversationId: string): string {
  if (conversationId.startsWith('c2c:')) {
    return `/v2/users/${encodeURIComponent(conversationId.slice(4))}/messages`;
  }
  if (conversationId.startsWith('group:')) {
    return `/v2/groups/${encodeURIComponent(conversationId.slice(6))}/messages`;
  }
  throw new Error('Unsupported QQ conversation id');
}

function stableSequence(deliveryId: string): number {
  const digest = createHash('sha256').update(deliveryId, 'utf8').digest();
  return (digest.readUInt32BE(0) % 2_147_483_647) + 1;
}

function splitText(text: string, limit: number): readonly string[] {
  const characters = [...text.trim()];
  if (characters.length === 0) return ['Zen completed without a text response.'];
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += limit) {
    chunks.push(characters.slice(offset, offset + limit).join(''));
  }
  return chunks;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

class QQUnauthorizedError extends Error {
  constructor(operation: string) {
    super(`${operation} failed with HTTP 401`);
    this.name = 'QQUnauthorizedError';
  }
}

function isUnauthorized(cause: unknown): boolean {
  return cause instanceof QQUnauthorizedError;
}
