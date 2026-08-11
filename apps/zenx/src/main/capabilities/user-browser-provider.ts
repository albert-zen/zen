import { randomUUID } from "node:crypto";
import path from "node:path";

import WebSocket from "ws";

import {
  browserActionScript,
  browserInspectScript,
  redactBrowserUrl,
  resolveBrowserObservedTarget,
  type BrowserInspection,
  type BrowserObservation,
  type BrowserTabSummary,
  type BrowserTargetFingerprint,
  type ZenXBrowserBackend,
} from "./browser-provider.js";

export interface UserBrowserCdpTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

export interface UserBrowserCdpClient {
  listTargets(signal?: AbortSignal): Promise<UserBrowserCdpTarget[]>;
  createTarget(url: string, signal?: AbortSignal): Promise<string>;
  navigate(targetId: string, url: string, signal?: AbortSignal): Promise<void>;
  evaluate(
    targetId: string,
    expression: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(): Promise<void> | void;
}

interface UserBrowserSession {
  targetIds: Set<string>;
  ignoredTargetIds: Set<string>;
}

interface UserBrowserTabState {
  documentVersion: number;
  url: string;
  documentIdentity?: string;
  observation?: BrowserObservation;
  actionInFlight: boolean;
}

export const userBrowserDocumentIdentityScript = `(() => {
    const key = "__zenxCapabilityDocumentIdentity";
    let state = document[key];
    if (typeof state !== "object" || state === null || typeof state.id !== "string" || typeof state.activation !== "number") {
      state = { id: String(Date.now()) + ":" + String(Math.random()), activation: 0 };
      Object.defineProperty(document, key, { value: state, configurable: false, enumerable: false });
      addEventListener("pageshow", (event) => { if (event.persisted) state.activation += 1; });
      addEventListener("popstate", () => { state.activation += 1; });
      addEventListener("hashchange", () => { state.activation += 1; });
    }
    return JSON.stringify({ href: location.href, origin: location.origin, id: state.id, activation: state.activation });
  })()`;

export class UserBrowserCdpBackend implements ZenXBrowserBackend {
  readonly #client: UserBrowserCdpClient;
  readonly #sessions = new Map<string, UserBrowserSession>();
  readonly #tabs = new Map<string, UserBrowserTabState>();

  constructor(client: UserBrowserCdpClient) {
    this.#client = client;
  }

  async listTabs(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary[]> {
    const session = this.#session(sessionId);
    const targets = (await this.#client.listTargets(signal)).filter(
      (target) =>
        target.type === "page" &&
        isInspectableUrl(target.url) &&
        !session.ignoredTargetIds.has(target.targetId),
    );
    const live = new Set(targets.map((target) => target.targetId));
    for (const targetId of session.targetIds) {
      if (!live.has(targetId)) {
        session.targetIds.delete(targetId);
        this.#tabs.delete(targetId);
      }
    }
    for (const target of targets) {
      session.targetIds.add(target.targetId);
      const tab = this.#tabs.get(target.targetId);
      if (tab === undefined) {
        this.#tabs.set(target.targetId, {
          documentVersion: 1,
          url: target.url,
          actionInFlight: false,
        });
      } else if (tab.url !== target.url) {
        tab.url = target.url;
        tab.documentVersion += 1;
        tab.documentIdentity = undefined;
        tab.observation = undefined;
      }
    }
    return targets
      .slice(0, 24)
      .map((target) => summarizeTarget(sessionId, target));
  }

  async open(
    sessionId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const session = this.#session(sessionId);
    const targetId = await this.#client.createTarget(url, signal);
    session.targetIds.add(targetId);
    this.#tabs.set(targetId, {
      documentVersion: 1,
      url,
      actionInFlight: false,
    });
    return await this.#summary(sessionId, targetId, signal);
  }

  async navigate(
    sessionId: string,
    tabId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const tab = this.#tab(sessionId, tabId);
    if (tab.actionInFlight) {
      throw new Error("User browser action is already in flight for this tab");
    }
    await this.#client.navigate(tabId, url, signal);
    tab.documentVersion += 1;
    tab.url = url;
    tab.documentIdentity = undefined;
    tab.observation = undefined;
    return await this.#summary(sessionId, tabId, signal);
  }

  async inspect(
    sessionId: string,
    tabId: string,
    signal?: AbortSignal,
  ): Promise<BrowserInspection> {
    const tab = this.#tab(sessionId, tabId);
    if (tab.actionInFlight) {
      throw new Error("User browser action is already in flight for this tab");
    }
    const envelope = asRecord(
      await this.#client.evaluate(
        tabId,
        `(() => ({ documentIdentity: ${userBrowserDocumentIdentityScript}, inspection: ${browserInspectScript} }))()`,
        signal,
      ),
    );
    const raw = asRecord(envelope?.inspection);
    if (
      typeof envelope?.documentIdentity !== "string" ||
      raw === undefined ||
      typeof raw.visibleText !== "string" ||
      !Array.isArray(raw.targets)
    ) {
      throw new Error(
        "User browser CDP inspection returned an unsupported shape",
      );
    }
    const fingerprints = raw.targets.map(requireFingerprint).slice(0, 80);
    const targets = new Map<string, BrowserTargetFingerprint>();
    const projected = fingerprints.map((fingerprint) => {
      const targetId = randomUUID();
      targets.set(targetId, fingerprint);
      return {
        targetId,
        role: fingerprint.role,
        name: fingerprint.name,
        actions: [...fingerprint.actions],
        ...(fingerprint.secure ? { secure: true as const } : {}),
        ...(fingerprint.value === undefined
          ? {}
          : { value: fingerprint.value }),
      };
    });
    const observationId = randomUUID();
    tab.documentIdentity = envelope.documentIdentity;
    tab.observation = {
      id: observationId,
      documentVersion: tab.documentVersion,
      targets,
    };
    const summary = await this.#summary(sessionId, tabId, signal);
    return {
      ...summary,
      observationId,
      documentVersion: tab.documentVersion,
      visibleText: raw.visibleText.slice(0, 8_000),
      targets: projected,
    };
  }

  async click(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    return await this.#act(
      sessionId,
      tabId,
      observationId,
      targetId,
      "click",
      "",
      false,
      signal,
    );
  }

  async type(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    text: string,
    submit: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    return await this.#act(
      sessionId,
      tabId,
      observationId,
      targetId,
      "type",
      text,
      submit,
      signal,
    );
  }

  closeTab(sessionId: string, tabId: string): void {
    const session = this.#requireSession(sessionId);
    if (!session.targetIds.delete(tabId)) {
      throw new Error(`Unknown user browser tab: ${tabId}`);
    }
    session.ignoredTargetIds.add(tabId);
    this.#tabs.delete(tabId);
  }

  closeSession(sessionId: string): number {
    const session = this.#requireSession(sessionId);
    const count = session.targetIds.size;
    for (const targetId of session.targetIds) this.#tabs.delete(targetId);
    this.#sessions.delete(sessionId);
    return count;
  }

  async close(): Promise<void> {
    this.#sessions.clear();
    this.#tabs.clear();
    await this.#client.close();
  }

  async #act(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    action: "click" | "type",
    text: string,
    submit: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const tab = this.#tab(sessionId, tabId);
    if (tab.actionInFlight) {
      throw new Error("User browser action is already in flight for this tab");
    }
    const target = resolveBrowserObservedTarget(
      tab.observation,
      tab.documentVersion,
      observationId,
      targetId,
      action,
    );
    const expectedDocumentIdentity = tab.documentIdentity;
    tab.observation = undefined;
    tab.documentIdentity = undefined;
    tab.actionInFlight = true;
    let response: Record<string, unknown> | undefined;
    try {
      response = asRecord(
        await this.#client.evaluate(
          tabId,
          userBrowserActionScript(
            expectedDocumentIdentity,
            target,
            action,
            text,
            submit,
          ),
          signal,
        ),
      );
    } catch (error) {
      throw new Error(
        `User browser action outcome is unknown after cancellation or connection failure; inspect the current tab before another action (${describeError(error)})`,
      );
    } finally {
      tab.actionInFlight = false;
    }
    if (response?.ok !== true) {
      throw new Error(
        `User browser target changed or action was rejected (${String(response?.reason ?? "unknown")}); inspect again`,
      );
    }
    tab.documentVersion += 1;
    try {
      return await this.#summary(sessionId, tabId, signal);
    } catch (error) {
      throw new Error(
        `User browser action outcome is unknown because post-action confirmation failed; inspect the current tab before another action (${describeError(error)})`,
      );
    }
  }

  #session(sessionId: string): UserBrowserSession {
    let session = this.#sessions.get(sessionId);
    if (session === undefined) {
      session = { targetIds: new Set(), ignoredTargetIds: new Set() };
      this.#sessions.set(sessionId, session);
    }
    return session;
  }

  #requireSession(sessionId: string): UserBrowserSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown user browser session: ${sessionId}`);
    }
    return session;
  }

  #tab(sessionId: string, tabId: string): UserBrowserTabState {
    const session = this.#requireSession(sessionId);
    if (!session.targetIds.has(tabId)) {
      throw new Error(`Unknown user browser tab: ${tabId}`);
    }
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) throw new Error("User browser tab was closed");
    return tab;
  }

  async #summary(
    sessionId: string,
    targetId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const target = (await this.#client.listTargets(signal)).find(
      (candidate) =>
        candidate.targetId === targetId && candidate.type === "page",
    );
    if (target === undefined) throw new Error("User browser tab was closed");
    return summarizeTarget(sessionId, target);
  }
}

export interface UserBrowserConnection {
  backend: ZenXBrowserBackend;
  product: string;
}

export async function connectUserBrowserCdp(
  endpoint: string,
  signal?: AbortSignal,
): Promise<UserBrowserConnection> {
  const base = validateCdpEndpoint(endpoint);
  const timeout = AbortSignal.timeout(5_000);
  const probeSignal =
    signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const response = await fetch(new URL("/json/version", base), {
    signal: probeSignal,
    headers: { accept: "application/json" },
    redirect: "error",
  });
  const finalUrl = validateCdpEndpoint(response.url);
  if (finalUrl.pathname !== "/json/version") {
    throw new Error("User browser CDP version response URL is invalid");
  }
  if (!response.ok) {
    throw new Error(
      `User browser CDP version probe failed with HTTP ${String(response.status)}`,
    );
  }
  const version = asRecord(await response.json());
  if (version === undefined) {
    throw new Error("User browser CDP version response is invalid");
  }
  const product = validateUserBrowserVersion(version);
  const webSocketDebuggerUrl = version.webSocketDebuggerUrl;
  if (typeof webSocketDebuggerUrl !== "string") {
    throw new Error(
      "User browser CDP version response is missing webSocketDebuggerUrl",
    );
  }
  const socketUrl = new URL(webSocketDebuggerUrl);
  if (
    socketUrl.protocol !== "ws:" ||
    !isLoopbackHostname(socketUrl.hostname) ||
    socketUrl.username.length > 0 ||
    socketUrl.password.length > 0 ||
    socketUrl.search.length > 0 ||
    socketUrl.hash.length > 0
  ) {
    throw new Error(
      "User browser CDP WebSocket must be an unauthenticated loopback ws:// endpoint",
    );
  }
  const client = await JsonRpcUserBrowserCdpClient.connect(
    socketUrl.toString(),
    probeSignal,
  );
  return { backend: new UserBrowserCdpBackend(client), product };
}

export function validateUserBrowserVersion(
  value: Record<string, unknown>,
): string {
  const product = value.Browser;
  const match =
    typeof product === "string"
      ? /^(?:Chrome|Chromium|Edg)\/(\d+)(?:\.\d+){1,3}(?:[-+].*)?$/u.exec(
          product,
        )
      : null;
  if (
    typeof product !== "string" ||
    match === null ||
    Number.parseInt(match[1] ?? "0", 10) < 100
  ) {
    throw new Error(
      "User browser CDP endpoint must report a supported Chrome, Edge, or Chromium product",
    );
  }
  return product;
}

class JsonRpcUserBrowserCdpClient implements UserBrowserCdpClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  readonly #targetSessions = new Map<string, string>();
  #nextId = 1;
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => this.#receive(data.toString()));
    socket.on("close", () =>
      this.#failAll(new Error("User browser CDP connection closed")),
    );
    socket.on("error", (error) => this.#failAll(error));
  }

  static async connect(
    url: string,
    signal?: AbortSignal,
  ): Promise<JsonRpcUserBrowserCdpClient> {
    const socket = new WebSocket(url, { handshakeTimeout: 5_000 });
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        socket.close();
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("User browser CDP connection aborted"),
        );
      };
      socket.once("open", () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      });
      socket.once("error", (error) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) abort();
    });
    return new JsonRpcUserBrowserCdpClient(socket);
  }

  async listTargets(signal?: AbortSignal): Promise<UserBrowserCdpTarget[]> {
    const response = asRecord(
      await this.#send("Target.getTargets", {}, undefined, signal),
    );
    const infos = response?.targetInfos;
    if (!Array.isArray(infos))
      throw new Error("User browser CDP Target.getTargets response is invalid");
    return infos.map((value) => {
      const target = asRecord(value);
      if (
        target === undefined ||
        typeof target.targetId !== "string" ||
        typeof target.type !== "string" ||
        typeof target.title !== "string" ||
        typeof target.url !== "string"
      ) {
        throw new Error("User browser CDP target metadata is invalid");
      }
      return {
        targetId: target.targetId,
        type: target.type,
        title: target.title,
        url: target.url,
      };
    });
  }

  async createTarget(url: string, signal?: AbortSignal): Promise<string> {
    const response = asRecord(
      await this.#send("Target.createTarget", { url }, undefined, signal),
    );
    if (typeof response?.targetId !== "string")
      throw new Error("User browser CDP createTarget response is invalid");
    return response.targetId;
  }

  async navigate(
    targetId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const sessionId = await this.#attach(targetId, signal);
    await this.#send("Page.navigate", { url }, sessionId, signal);
  }

  async evaluate(
    targetId: string,
    expression: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const sessionId = await this.#attach(targetId, signal);
    const response = asRecord(
      await this.#send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
        signal,
      ),
    );
    if (response?.exceptionDetails !== undefined) {
      throw new Error("User browser CDP evaluation failed");
    }
    return asRecord(response?.result)?.value;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.close();
    this.#failAll(new Error("User browser CDP connection closed"));
  }

  async #attach(targetId: string, signal?: AbortSignal): Promise<string> {
    const existing = this.#targetSessions.get(targetId);
    if (existing !== undefined) return existing;
    const response = asRecord(
      await this.#send(
        "Target.attachToTarget",
        { targetId, flatten: true },
        undefined,
        signal,
      ),
    );
    if (typeof response?.sessionId !== "string")
      throw new Error("User browser CDP attach response is invalid");
    this.#targetSessions.set(targetId, response.sessionId);
    return response.sessionId;
  }

  async #send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("User browser CDP connection is unavailable");
    }
    const id = this.#nextId++;
    return await new Promise((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(id);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("User browser CDP command aborted"),
        );
      };
      this.#pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) {
        abort();
        return;
      }
      this.#socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      );
    });
  }

  #receive(raw: string): void {
    let message: Record<string, unknown> | undefined;
    try {
      message = asRecord(JSON.parse(raw));
    } catch {
      this.#failAll(new Error("User browser CDP returned invalid JSON"));
      return;
    }
    if (message === undefined || typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    const error = asRecord(message.error);
    if (error !== undefined) {
      pending.reject(
        new Error(
          `User browser CDP command failed: ${String(error.message ?? "unknown error")}`,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function validateCdpEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("User browser CDP endpoint is not a valid URL");
  }
  if (
    url.protocol !== "http:" ||
    !isLoopbackHostname(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      "User browser CDP endpoint must be an unauthenticated loopback http:// URL",
    );
  }
  return url;
}

export function windowsBrowserExecutableCandidates(
  environment: NodeJS.ProcessEnv,
): string[] {
  const roots = [
    environment.ProgramFiles,
    environment["ProgramFiles(x86)"],
    environment.LOCALAPPDATA,
  ].filter((entry): entry is string => entry !== undefined && entry.length > 0);
  return [
    ...roots.map((root) =>
      path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"),
    ),
    ...roots.map((root) =>
      path.win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    ),
    ...roots.map((root) =>
      path.win32.join(root, "Chromium", "Application", "chrome.exe"),
    ),
  ];
}

function userBrowserActionScript(
  expectedDocumentIdentity: string | undefined,
  target: BrowserTargetFingerprint,
  action: "click" | "type",
  text: string,
  submit: boolean,
): string {
  return `(() => {
    const expectedDocumentIdentity = ${JSON.stringify(expectedDocumentIdentity)};
    const actualDocumentIdentity = ${userBrowserDocumentIdentityScript};
    if (actualDocumentIdentity !== expectedDocumentIdentity) return { ok: false, reason: "document-changed" };
    return ${browserActionScript(target, action, text, submit)};
  })()`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
  );
}

function isInspectableUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function summarizeTarget(
  sessionId: string,
  target: UserBrowserCdpTarget,
): BrowserTabSummary {
  return {
    sessionId,
    tabId: target.targetId,
    title: target.title.slice(0, 256),
    url: redactBrowserUrl(target.url),
    loading: false,
  };
}

function requireFingerprint(value: unknown): BrowserTargetFingerprint {
  const target = asRecord(value);
  const actions = target?.actions;
  if (
    target === undefined ||
    ![
      "selector",
      "tag",
      "role",
      "name",
      "type",
      "id",
      "fieldName",
      "autocomplete",
      "href",
    ].every((key) => typeof target[key] === "string") ||
    typeof target.secure !== "boolean" ||
    !Array.isArray(actions) ||
    !actions.every((action) => action === "click" || action === "type") ||
    (target.value !== undefined && typeof target.value !== "string")
  ) {
    throw new Error("User browser CDP inspection target is invalid");
  }
  return {
    selector: target.selector as string,
    tag: target.tag as string,
    role: target.role as string,
    name: target.name as string,
    type: target.type as string,
    id: target.id as string,
    fieldName: target.fieldName as string,
    autocomplete: target.autocomplete as string,
    href: target.href as string,
    secure: target.secure,
    actions: [...actions],
    ...(target.value === undefined ? {} : { value: target.value }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
