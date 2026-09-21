import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import WebSocket, { WebSocketServer } from "ws";

import {
  connectUserBrowserCdp,
  type UserBrowserConnection,
} from "./capabilities/user-browser-provider.js";

const ALLOWED_TAB_COMMANDS = new Set([
  "Page.captureScreenshot",
  "Page.createIsolatedWorld",
  "Page.enable",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.navigate",
  "Page.screencastFrameAck",
  "Page.startScreencast",
  "Page.stopScreencast",
  "Runtime.enable",
  "Runtime.evaluate",
]);
const ALLOWED_TAB_EVENTS = new Set([
  "Inspector.detached",
  "Page.backForwardCacheNotUsed",
  "Page.frameNavigated",
  "Page.frameStartedLoading",
  "Page.frameStartedNavigating",
  "Page.navigatedWithinDocument",
  "Page.screencastFrame",
  "Runtime.executionContextCreated",
  "Runtime.executionContextDestroyed",
  "Runtime.executionContextsCleared",
]);

export const ZENX_CHROME_EXTENSION_ID = "jenndkelhapgbokkmmfifkmiadkeflci";
export const ZENX_CHROME_EXTENSION_ORIGIN = `chrome-extension://${ZENX_CHROME_EXTENSION_ID}/`;
export const ZENX_CHROME_NATIVE_HOST_NAME = "com.zenx.chrome_bridge";

export interface ChromeExtensionBridgeStatus {
  state: "waiting" | "connected";
  tabCount: number;
}

export interface ChromeBridgeSettingsSnapshot {
  configuredMode: "isolated" | "user-session";
  effectiveMode: "isolated" | "user-session";
  environmentOverride: boolean;
  connector: "chrome-extension" | "external-cdp" | "inactive";
  packaged: boolean;
  nativeHostRegistered: boolean;
  extensionDirectory: string;
  extensionId: string;
  connection: ChromeExtensionBridgeStatus;
}

interface ConnectedTab {
  id: number;
  title: string;
  url: string;
}

interface CdpSession {
  socket: WebSocket;
  targetId: string;
}

interface PendingCommand {
  socket: WebSocket;
  id: number;
  sessionId?: string;
  tabId?: number;
  navigatedUrl?: string;
}

export class ChromeExtensionBridge {
  readonly endpoint: string;
  readonly #authorization: string;
  readonly #runtimeDirectory: string;
  readonly #server: ReturnType<typeof createServer>;
  readonly #nativeServer: WebSocketServer;
  readonly #cdpServer: WebSocketServer;
  readonly #cdpSockets = new Set<WebSocket>();
  readonly #sessions = new Map<string, CdpSession>();
  readonly #pending = new Map<string, PendingCommand>();
  #native?: WebSocket;
  readonly #tabs = new Map<number, ConnectedTab>();
  #browserConnected = false;
  #nativeReady = false;
  #closed = false;

  private constructor(options: {
    endpoint: string;
    authorization: string;
    runtimeDirectory: string;
    server: ReturnType<typeof createServer>;
    nativeServer: WebSocketServer;
    cdpServer: WebSocketServer;
  }) {
    this.endpoint = options.endpoint;
    this.#authorization = options.authorization;
    this.#runtimeDirectory = options.runtimeDirectory;
    this.#server = options.server;
    this.#nativeServer = options.nativeServer;
    this.#cdpServer = options.cdpServer;
  }

  static async start(options: {
    runtimeDirectory: string;
  }): Promise<ChromeExtensionBridge> {
    const nativeToken = randomBytes(32).toString("base64url");
    const cdpToken = randomBytes(32).toString("base64url");
    const authorization = `Bearer ${cdpToken}`;
    const nativeServer = new WebSocketServer({ noServer: true });
    const cdpServer = new WebSocketServer({ noServer: true });
    let bridge: ChromeExtensionBridge | undefined;
    const server = createServer((request, response) => {
      if (bridge !== undefined) bridge.#handleHttp(request, response);
    });
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        url.pathname === `/native/${nativeToken}` &&
        request.headers.origin === ZENX_CHROME_EXTENSION_ORIGIN
      ) {
        nativeServer.handleUpgrade(request, socket, head, (webSocket) =>
          nativeServer.emit("connection", webSocket, request),
        );
        return;
      }
      if (
        /^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(url.pathname) &&
        request.headers.authorization === authorization
      ) {
        cdpServer.handleUpgrade(request, socket, head, (webSocket) =>
          cdpServer.emit("connection", webSocket, request),
        );
        return;
      }
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Chrome bridge did not bind a loopback port"));
        } else resolve(address.port);
      });
    });
    bridge = new ChromeExtensionBridge({
      endpoint: `http://127.0.0.1:${String(port)}`,
      authorization,
      runtimeDirectory: options.runtimeDirectory,
      server,
      nativeServer,
      cdpServer,
    });
    nativeServer.on("connection", (socket) => bridge!.#acceptNative(socket));
    cdpServer.on("connection", (socket) => bridge!.#acceptCdp(socket));
    await bridge.#writeDescriptor(
      `ws://127.0.0.1:${String(port)}/native/${nativeToken}`,
    );
    return bridge;
  }

  status(): ChromeExtensionBridgeStatus {
    return {
      state: this.#browserConnected ? "connected" : "waiting",
      tabCount: this.#tabs.size,
    };
  }

  async connectProvider(signal?: AbortSignal): Promise<UserBrowserConnection> {
    return await connectUserBrowserCdp(this.endpoint, signal, {
      authorization: this.#authorization,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#native?.close(1001, "ZenX closed");
    for (const socket of this.#cdpSockets) socket.close(1001, "ZenX closed");
    await Promise.all([
      closeWebSocketServer(this.#nativeServer),
      closeWebSocketServer(this.#cdpServer),
      new Promise<void>((resolve, reject) =>
        this.#server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      ),
    ]);
    await unlink(path.join(this.#runtimeDirectory, "chrome-bridge.json")).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      },
    );
  }

  #handleHttp(request: IncomingMessage, response: ServerResponse): void {
    if (request.headers.authorization !== this.#authorization) {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/json/version") {
      response.end(
        JSON.stringify({
          Browser: "Chrome/136.0.0.0+ZenX",
          ProtocolVersion: "1.3",
          webSocketDebuggerUrl: `${this.endpoint.replace("http:", "ws:")}/devtools/browser/${randomUUID()}`,
        }),
      );
      return;
    }
    if (request.url === "/json/list") {
      response.end(JSON.stringify([...this.#tabs.values()].map(target)));
      return;
    }
    response.writeHead(404).end();
  }

  #acceptNative(socket: WebSocket): void {
    const previous = this.#native;
    if (previous !== undefined) {
      this.#native = undefined;
      this.#disconnectBrowser("Extension connection was replaced");
      previous.close(1008, "Replaced by a new ZenX extension connection");
    }
    this.#native = socket;
    socket.on("message", (data) =>
      this.#receiveNative(socket, data.toString()),
    );
    socket.once("close", () => {
      if (this.#native !== socket) return;
      this.#native = undefined;
      this.#disconnectBrowser("Extension disconnected");
    });
    socket.once("error", () => socket.close());
  }

  #receiveNative(socket: WebSocket, raw: string): void {
    if (this.#native !== socket) return;
    let message: Record<string, unknown>;
    try {
      message = asRecord(JSON.parse(raw)) ?? {};
    } catch {
      socket.close(1007, "Invalid JSON");
      return;
    }
    if (message.type === "hello") {
      if (message.protocolVersion !== 2 || message.scope !== "browser") {
        socket.close(
          1008,
          "Reload the ZenX Browser Bridge extension to connect Chrome",
        );
        return;
      }
      this.#nativeReady = true;
      socket.send(
        JSON.stringify({ type: "ready", protocolVersion: 2, scope: "browser" }),
      );
      return;
    }
    if (!this.#nativeReady) return;
    if (message.type === "browser-connected") {
      if (this.#browserConnected || !Array.isArray(message.tabs)) {
        socket.close(1007, "Invalid browser connection");
        return;
      }
      const tabs = message.tabs.map(readTab);
      if (tabs.some((tab) => tab === undefined)) {
        socket.close(1007, "Invalid tab metadata");
        return;
      }
      this.#browserConnected = true;
      for (const tab of tabs) this.#updateTab(tab!);
      return;
    }
    if (!this.#browserConnected) return;
    if (message.type === "tab-updated") {
      const tab = readTab(message.tab);
      if (tab !== undefined) this.#updateTab(tab);
      return;
    }
    if (message.type === "tab-removed") {
      const tabId = numberValue(message.tabId);
      if (tabId !== undefined)
        this.#detachTab(tabId, "Chrome tab is unavailable");
      return;
    }
    if (message.type === "cdp-result") {
      const requestId = stringValue(message.requestId);
      if (requestId === undefined) return;
      const pending = this.#pending.get(requestId);
      if (pending === undefined) return;
      this.#pending.delete(requestId);
      if (message.error !== undefined) {
        const error = asRecord(message.error);
        this.#reply(
          pending.socket,
          pending.id,
          undefined,
          {
            code: typeof error?.code === "number" ? error.code : -32000,
            message:
              typeof error?.message === "string"
                ? error.message.slice(0, 512)
                : "Chrome debugger command failed",
          },
          pending.sessionId,
        );
      } else {
        const tab =
          pending.tabId === undefined
            ? undefined
            : this.#tabs.get(pending.tabId);
        if (pending.navigatedUrl !== undefined && tab !== undefined) {
          this.#updateTab({ ...tab, url: pending.navigatedUrl });
        }
        this.#reply(
          pending.socket,
          pending.id,
          message.result ?? {},
          undefined,
          pending.sessionId,
        );
      }
      return;
    }
    if (message.type === "cdp-event") {
      const tabId = numberValue(message.tabId);
      const method = stringValue(message.method);
      const params = asRecord(message.params) ?? {};
      const currentTab =
        tabId === undefined ? undefined : this.#tabs.get(tabId);
      if (
        currentTab === undefined ||
        tabId !== currentTab.id ||
        method === undefined ||
        !ALLOWED_TAB_EVENTS.has(method)
      )
        return;
      const navigatedUrl = mainFrameUrlFromEvent(method, params);
      if (navigatedUrl !== undefined)
        this.#updateTab({ ...currentTab, url: navigatedUrl });
      for (const [sessionId, session] of this.#sessions) {
        if (session.targetId !== targetId(currentTab)) continue;
        sendJson(session.socket, { method, params, sessionId });
      }
    }
  }

  #acceptCdp(socket: WebSocket): void {
    this.#cdpSockets.add(socket);
    socket.on("message", (data) => this.#receiveCdp(socket, data.toString()));
    socket.once("close", () => this.#dropCdp(socket));
    socket.once("error", () => socket.close());
  }

  #receiveCdp(socket: WebSocket, raw: string): void {
    let request: Record<string, unknown>;
    try {
      request = asRecord(JSON.parse(raw)) ?? {};
    } catch {
      socket.close(1007, "Invalid JSON");
      return;
    }
    const id = numberValue(request.id);
    const method = stringValue(request.method);
    const params = asRecord(request.params) ?? {};
    const sessionId = stringValue(request.sessionId);
    if (id === undefined || method === undefined) {
      socket.close(1007, "Invalid CDP request");
      return;
    }
    if (method === "Target.setDiscoverTargets") {
      this.#reply(socket, id, {});
      return;
    }
    if (method === "Target.getTargets") {
      this.#reply(socket, id, {
        targetInfos: [...this.#tabs.values()].map(targetInfo),
      });
      return;
    }
    if (method === "Target.createTarget") {
      if (
        !this.#browserConnected ||
        this.#native?.readyState !== WebSocket.OPEN
      ) {
        this.#reply(socket, id, undefined, {
          code: -32000,
          message: "Chrome browser is not connected",
        });
        return;
      }
      if (
        typeof params.url !== "string" ||
        !/^about:blank#zenx-pending-[a-f0-9-]+$/u.test(params.url)
      ) {
        this.#reply(socket, id, undefined, {
          code: -32000,
          message: "Invalid ZenX browser creation marker",
        });
        return;
      }
      const requestId = randomUUID();
      this.#pending.set(requestId, { socket, id });
      this.#native.send(
        JSON.stringify({
          type: "cdp-command",
          requestId,
          method,
          params: { url: params.url },
        }),
      );
      return;
    }
    if (method === "Target.attachToTarget") {
      const requestedTarget = stringValue(params.targetId);
      if (
        requestedTarget === undefined ||
        ![...this.#tabs.values()].some(
          (tab) => targetId(tab) === requestedTarget,
        )
      ) {
        this.#reply(socket, id, undefined, {
          code: -32000,
          message: "Chrome tab is not connected",
        });
        return;
      }
      const nextSession = randomUUID();
      this.#sessions.set(nextSession, { socket, targetId: requestedTarget });
      this.#reply(socket, id, { sessionId: nextSession });
      return;
    }
    if (method === "Target.detachFromTarget") {
      const detached = stringValue(params.sessionId) ?? sessionId;
      const existing =
        detached === undefined ? undefined : this.#sessions.get(detached);
      if (detached === undefined || existing?.socket !== socket) {
        this.#reply(socket, id, undefined, {
          code: -32000,
          message: "Unknown Chrome tab session",
        });
        return;
      }
      this.#sessions.delete(detached);
      this.#reply(socket, id, {});
      return;
    }
    const session =
      sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    const tab = [...this.#tabs.values()].find(
      (tab) => targetId(tab) === session?.targetId,
    );
    if (
      sessionId === undefined ||
      session?.socket !== socket ||
      tab === undefined ||
      this.#native?.readyState !== WebSocket.OPEN
    ) {
      this.#reply(
        socket,
        id,
        undefined,
        { code: -32000, message: "Chrome tab connection is unavailable" },
        sessionId,
      );
      return;
    }
    if (!ALLOWED_TAB_COMMANDS.has(method)) {
      this.#reply(
        socket,
        id,
        undefined,
        {
          code: -32601,
          message: `Chrome tab command is outside the ZenX browser surface: ${method}`,
        },
        sessionId,
      );
      return;
    }
    const requestId = randomUUID();
    this.#pending.set(requestId, {
      socket,
      id,
      sessionId,
      tabId: tab.id,
      ...(method === "Page.navigate" && typeof params.url === "string"
        ? { navigatedUrl: params.url }
        : {}),
    });
    this.#native.send(
      JSON.stringify({
        type: "cdp-command",
        requestId,
        tabId: tab.id,
        method,
        params,
      }),
    );
  }

  #reply(
    socket: WebSocket,
    id: number,
    result?: unknown,
    error?: { code: number; message: string },
    sessionId?: string,
  ): void {
    sendJson(socket, {
      id,
      ...(error === undefined ? { result: result ?? {} } : { error }),
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }

  #detachTab(tabId: number, reason: string): void {
    const previous = this.#tabs.get(tabId);
    if (previous === undefined) return;
    const previousTargetId = targetId(previous);
    this.#tabs.delete(tabId);
    for (const [sessionId, session] of [...this.#sessions]) {
      if (session.targetId !== previousTargetId) continue;
      this.#sessions.delete(sessionId);
      sendJson(session.socket, {
        method: "Target.detachedFromTarget",
        params: { sessionId, targetId: previousTargetId, reason },
      });
    }
    for (const [requestId, pending] of [...this.#pending]) {
      if (pending.tabId !== tabId) continue;
      this.#pending.delete(requestId);
      this.#reply(
        pending.socket,
        pending.id,
        undefined,
        {
          code: -32000,
          message: reason,
        },
        pending.sessionId,
      );
    }
    this.#broadcast({
      method: "Target.targetDestroyed",
      params: { targetId: previousTargetId },
    });
  }

  #updateTab(tab: ConnectedTab): void {
    const existed = this.#tabs.has(tab.id);
    this.#tabs.set(tab.id, tab);
    this.#broadcast({
      method: existed ? "Target.targetInfoChanged" : "Target.targetCreated",
      params: { targetInfo: targetInfo(tab) },
    });
  }

  #disconnectBrowser(reason: string): void {
    this.#browserConnected = false;
    this.#nativeReady = false;
    for (const tabId of [...this.#tabs.keys()]) this.#detachTab(tabId, reason);
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      this.#reply(
        pending.socket,
        pending.id,
        undefined,
        { code: -32000, message: reason },
        pending.sessionId,
      );
    }
  }

  #dropCdp(socket: WebSocket): void {
    this.#cdpSockets.delete(socket);
    for (const [sessionId, session] of [...this.#sessions]) {
      if (session.socket === socket) this.#sessions.delete(sessionId);
    }
    for (const [requestId, pending] of [...this.#pending]) {
      if (pending.socket === socket) this.#pending.delete(requestId);
    }
  }

  #broadcast(message: unknown): void {
    for (const socket of this.#cdpSockets) sendJson(socket, message);
  }

  async #writeDescriptor(nativeWebSocketUrl: string): Promise<void> {
    await mkdir(this.#runtimeDirectory, { recursive: true, mode: 0o700 });
    const file = path.join(this.#runtimeDirectory, "chrome-bridge.json");
    const temporary = `${file}.${String(process.pid)}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ protocolVersion: 1, nativeWebSocketUrl })}\n`,
        { mode: 0o600 },
      );
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
}

function targetId(tab: ConnectedTab): string {
  return `chrome-tab-${String(tab.id)}`;
}

function targetInfo(tab: ConnectedTab) {
  return {
    targetId: targetId(tab),
    type: "page",
    title: tab.title,
    url: tab.url,
    attached: false,
    canAccessOpener: false,
  };
}

function target(tab: ConnectedTab) {
  return { id: targetId(tab), type: "page", title: tab.title, url: tab.url };
}

function readTab(value: unknown): ConnectedTab | undefined {
  const tab = asRecord(value);
  const id = numberValue(tab?.id);
  const title = stringValue(tab?.title);
  const url = stringValue(tab?.url);
  if (
    id === undefined ||
    !Number.isInteger(id) ||
    id < 0 ||
    title === undefined ||
    title.length > 4096 ||
    url === undefined ||
    url.length > 32_768
  )
    return undefined;
  return { id, title, url };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function mainFrameUrlFromEvent(
  method: string,
  params: Record<string, unknown>,
): string | undefined {
  if (method === "Page.frameNavigated") {
    const frame = asRecord(params.frame);
    return frame?.parentId === undefined ? stringValue(frame?.url) : undefined;
  }
  return method === "Page.navigatedWithinDocument"
    ? stringValue(params.url)
    : undefined;
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
