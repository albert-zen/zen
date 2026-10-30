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
  "Network.enable",
  "Network.getResponseBody",
  "DOM.describeNode",
  "Runtime.releaseObject",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
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
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
  "Inspector.detached",
  "Page.backForwardCacheNotUsed",
  "Page.frameNavigated",
  "Page.frameDetached",
  "Page.frameStartedLoading",
  "Page.frameStartedNavigating",
  "Page.navigatedWithinDocument",
  "Page.javascriptDialogOpening",
  "Page.javascriptDialogClosed",
  "Page.screencastFrame",
  "Runtime.executionContextCreated",
  "Runtime.executionContextDestroyed",
  "Runtime.executionContextsCleared",
]);

export const ZENX_CHROME_EXTENSION_ID = "jenndkelhapgbokkmmfifkmiadkeflci";
export const ZENX_CHROME_EXTENSION_ORIGIN = `chrome-extension://${ZENX_CHROME_EXTENSION_ID}/`;
export const ZENX_CHROME_NATIVE_HOST_NAME = "com.zenx.chrome_bridge";

export interface BrowserConnectionSnapshot {
  connectionId: string;
  generation: string;
  browser: "chrome" | "edge";
  label: string;
  state: "waiting" | "connected";
}

export interface ChromeExtensionBridgeStatus {
  connections?: BrowserConnectionSnapshot[];
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
  edgeNativeHostRegistered?: boolean;
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

interface BridgeConnection {
  id: string;
  readonly generation: string;
  browser: "chrome" | "edge";
  native?: WebSocket;
  nativeReady: boolean;
  browserConnected: boolean;
  cdpSockets: Set<WebSocket>;
  sessions: Map<string, CdpSession>;
  pending: Map<string, PendingCommand>;
  tabs: Map<number, ConnectedTab>;
}

function createBridgeConnection(
  id: string,
  browser: "chrome" | "edge",
): BridgeConnection {
  return {
    id,
    browser,
    generation: randomUUID(),
    nativeReady: false,
    browserConnected: false,
    cdpSockets: new Set(),
    sessions: new Map(),
    pending: new Map(),
    tabs: new Map(),
  };
}

export class ChromeExtensionBridge {
  readonly endpoint: string;
  readonly #authorization: string;
  readonly #runtimeDirectory: string;
  readonly #server: ReturnType<typeof createServer>;
  readonly #nativeServer: WebSocketServer;
  readonly #cdpServer: WebSocketServer;
  readonly #multiInstance: boolean;
  readonly #legacy = createBridgeConnection("legacy", "chrome");
  readonly #connections = new Map<string, BridgeConnection>();
  readonly #nativeSockets = new Set<WebSocket>();
  readonly #listeners = new Set<() => void>();
  #closed = false;

  private constructor(options: {
    endpoint: string;
    multiInstance: boolean;
    authorization: string;
    runtimeDirectory: string;
    server: ReturnType<typeof createServer>;
    nativeServer: WebSocketServer;
    cdpServer: WebSocketServer;
  }) {
    this.endpoint = options.endpoint;
    this.#multiInstance = options.multiInstance;
    this.#authorization = options.authorization;
    this.#runtimeDirectory = options.runtimeDirectory;
    this.#server = options.server;
    this.#nativeServer = options.nativeServer;
    this.#cdpServer = options.cdpServer;
  }

  static async start(options: {
    runtimeDirectory: string;
    multiInstance?: boolean;
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
        bridge !== undefined &&
        bridge.#connectionForPath(url.pathname) !== undefined &&
        url.pathname.includes("/devtools/browser/") &&
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
      multiInstance: options.multiInstance ?? false,
      authorization,
      runtimeDirectory: options.runtimeDirectory,
      server,
      nativeServer,
      cdpServer,
    });
    nativeServer.on("connection", (socket) => bridge!.#acceptNative(socket));
    cdpServer.on("connection", (socket, request) => {
      const connection = bridge!.#connectionForPath(request.url ?? "");
      if (connection === undefined) {
        socket.close(1008, "Browser connection changed");
        return;
      }
      bridge!.#acceptCdp(connection, socket);
    });
    await bridge.#writeDescriptor(
      `ws://127.0.0.1:${String(port)}/native/${nativeToken}`,
    );
    return bridge;
  }

  status(): ChromeExtensionBridgeStatus {
    const connected = this.#multiInstance
      ? [...this.#connections.values()]
      : [this.#legacy];
    return {
      state: connected.some((value) => value.browserConnected)
        ? "connected"
        : "waiting",
      tabCount: connected.reduce((total, value) => total + value.tabs.size, 0),
      ...(this.#multiInstance ? { connections: this.connections() } : {}),
    };
  }

  connections(): BrowserConnectionSnapshot[] {
    return [...this.#connections.values()].map((value) => ({
      connectionId: value.id,
      generation: value.generation,
      browser: value.browser,
      label: `${value.browser === "edge" ? "Edge" : "Chrome"} · ${value.id.slice(0, 8)}`,
      state: value.browserConnected ? "connected" : "waiting",
    }));
  }

  onConnectionsChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot alter connection authority. */
      }
    }
  }

  async connectInstance(
    connectionId: string,
    generation: string,
    signal?: AbortSignal,
  ): Promise<UserBrowserConnection> {
    const connection = this.#connections.get(connectionId);
    if (!connection?.browserConnected || connection.generation !== generation)
      throw new Error(
        "Browser connection generation changed; discover connections again",
      );
    const result = await connectUserBrowserCdp(this.endpoint, signal, {
      authorization: this.#authorization,
      connectionPath: `/instances/${connectionId}/${generation}`,
    });
    if (
      this.#connections.get(connectionId) !== connection ||
      !connection.browserConnected
    ) {
      await result.backend.close();
      throw new Error(
        "Browser connection generation changed during connection",
      );
    }
    return result;
  }

  async connectProvider(signal?: AbortSignal): Promise<UserBrowserConnection> {
    if (this.#multiInstance)
      throw new Error(
        "An explicit browser connectionId and generation are required",
      );
    return await connectUserBrowserCdp(this.endpoint, signal, {
      authorization: this.#authorization,
    });
  }

  #connectionForPath(raw: string): BridgeConnection | undefined {
    const pathname = new URL(raw, this.endpoint).pathname;
    if (!this.#multiInstance)
      return /^\/(?:json\/(?:version|list)|devtools\/browser\/[A-Za-z0-9-]+)$/u.test(
        pathname,
      )
        ? this.#legacy
        : undefined;
    const match =
      /^\/instances\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/(?:json\/(?:version|list)|devtools\/browser\/[A-Za-z0-9-]+)$/u.exec(
        pathname,
      );
    if (match === null) return undefined;
    const connection = this.#connections.get(match[1]!);
    return connection !== undefined &&
      connection.generation === match[2] &&
      connection.browserConnected
      ? connection
      : undefined;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const socket of this.#nativeSockets) socket.close(1001, "ZenX closed");
    for (const connection of [this.#legacy, ...this.#connections.values()])
      for (const socket of connection.cdpSockets)
        socket.close(1001, "ZenX closed");
    this.#listeners.clear();
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
    const connection = this.#connectionForPath(request.url ?? "");
    if (connection === undefined) {
      response.writeHead(404).end();
      return;
    }
    const prefix = this.#multiInstance
      ? `/instances/${connection.id}/${connection.generation}`
      : "";
    response.setHeader("content-type", "application/json");
    if (request.url === `${prefix}/json/version`) {
      response.end(
        JSON.stringify({
          Browser: "Chrome/136.0.0.0+ZenX",
          ProtocolVersion: "1.3",
          webSocketDebuggerUrl: `${this.endpoint.replace("http:", "ws:")}${prefix}/devtools/browser/${randomUUID()}`,
        }),
      );
      return;
    }
    if (request.url === `${prefix}/json/list`) {
      response.end(JSON.stringify([...connection.tabs.values()].map(target)));
      return;
    }
    response.writeHead(404).end();
  }

  #acceptNative(socket: WebSocket): void {
    socket.once("error", () => socket.close());
    if (this.#nativeSockets.size >= 64) {
      socket.send(
        JSON.stringify({
          type: "connection-rejected",
          message:
            "ZenX has reached its browser connection limit. Disconnect an unused instance first.",
        }),
      );
      socket.close(1008, "Browser connection limit");
      return;
    }
    this.#nativeSockets.add(socket);
    const helloTimer = setTimeout(
      () => socket.close(1008, "Browser handshake timed out"),
      5_000,
    );
    helloTimer.unref();
    socket.once("message", () => clearTimeout(helloTimer));
    socket.once("close", () => clearTimeout(helloTimer));
    const connection = this.#multiInstance
      ? createBridgeConnection("pending", "chrome")
      : this.#legacy;
    if (!this.#multiInstance && connection.native !== undefined) {
      socket.send(
        JSON.stringify({
          type: "connection-rejected",
          message:
            "Another browser is connected. Disconnect its ZenX extension before connecting this browser.",
        }),
      );
      socket.close(1008, "Another browser is already connected");
      socket.once("close", () => this.#nativeSockets.delete(socket));
      return;
    }
    connection.native = socket;
    socket.on("message", (data) =>
      this.#receiveNative(connection, socket, data.toString()),
    );
    socket.once("close", () => {
      this.#nativeSockets.delete(socket);
      if (connection.native !== socket) return;
      connection.native = undefined;
      this.#disconnectBrowser(connection, "Extension disconnected");
      if (
        this.#multiInstance &&
        this.#connections.get(connection.id) === connection
      ) {
        this.#connections.delete(connection.id);
        for (const cdp of connection.cdpSockets)
          cdp.close(1001, "Browser disconnected");
        this.#changed();
      }
    });
  }

  #receiveNative(
    connection: BridgeConnection,
    socket: WebSocket,
    raw: string,
  ): void {
    if (connection.native !== socket) return;
    let message: Record<string, unknown>;
    try {
      message = asRecord(JSON.parse(raw)) ?? {};
    } catch {
      socket.close(1007, "Invalid JSON");
      return;
    }
    if (message.type === "hello") {
      if (
        connection.nativeReady ||
        message.scope !== "browser" ||
        (this.#multiInstance
          ? message.protocolVersion !== 3
          : ![2, 3].includes(Number(message.protocolVersion)))
      ) {
        socket.close(
          1008,
          "Reload the ZenX Browser Bridge extension to connect Chrome",
        );
        return;
      }
      if (this.#multiInstance) {
        const id = stringValue(message.instanceId);
        if (
          id === undefined ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id) ||
          !["chrome", "edge"].includes(String(message.browser))
        ) {
          socket.close(
            1008,
            "Reload the extension with a valid browser instance identity",
          );
          return;
        }
        if (this.#connections.has(id)) {
          socket.send(
            JSON.stringify({
              type: "connection-rejected",
              message:
                "This browser instance is already connected. Disconnect that instance before reconnecting.",
            }),
          );
          socket.close(1008, "Duplicate browser instance");
          return;
        }
        connection.id = id;
        connection.browser = message.browser as "chrome" | "edge";
        this.#connections.set(id, connection);
      }
      connection.nativeReady = true;
      socket.send(
        JSON.stringify({
          type: "ready",
          protocolVersion: message.protocolVersion,
          scope: "browser",
        }),
      );
      return;
    }
    if (!connection.nativeReady) return;
    if (message.type === "browser-connected") {
      if (connection.browserConnected || !Array.isArray(message.tabs)) {
        socket.close(1007, "Invalid browser connection");
        return;
      }
      const tabs = message.tabs.map(readTab);
      if (tabs.some((tab) => tab === undefined)) {
        socket.close(1007, "Invalid tab metadata");
        return;
      }
      connection.browserConnected = true;
      for (const tab of tabs) this.#updateTab(connection, tab!);
      if (this.#multiInstance) this.#changed();
      return;
    }
    if (!connection.browserConnected) return;
    if (message.type === "tab-updated") {
      const tab = readTab(message.tab);
      if (tab !== undefined) this.#updateTab(connection, tab);
      return;
    }
    if (message.type === "tab-removed") {
      const tabId = numberValue(message.tabId);
      if (tabId !== undefined)
        this.#detachTab(connection, tabId, "Chrome tab is unavailable");
      return;
    }
    if (message.type === "cdp-result") {
      const requestId = stringValue(message.requestId);
      if (requestId === undefined) return;
      const pending = connection.pending.get(requestId);
      if (pending === undefined) return;
      connection.pending.delete(requestId);
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
            : connection.tabs.get(pending.tabId);
        if (pending.navigatedUrl !== undefined && tab !== undefined) {
          this.#updateTab(connection, { ...tab, url: pending.navigatedUrl });
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
        tabId === undefined ? undefined : connection.tabs.get(tabId);
      if (
        currentTab === undefined ||
        tabId !== currentTab.id ||
        method === undefined ||
        !ALLOWED_TAB_EVENTS.has(method)
      )
        return;
      const navigatedUrl = mainFrameUrlFromEvent(method, params);
      if (navigatedUrl !== undefined)
        this.#updateTab(connection, { ...currentTab, url: navigatedUrl });
      for (const [sessionId, session] of connection.sessions) {
        if (session.targetId !== targetId(currentTab)) continue;
        sendJson(session.socket, { method, params, sessionId });
      }
    }
  }

  #acceptCdp(connection: BridgeConnection, socket: WebSocket): void {
    connection.cdpSockets.add(socket);
    socket.on("message", (data) =>
      this.#receiveCdp(connection, socket, data.toString()),
    );
    socket.once("close", () => this.#dropCdp(connection, socket));
    socket.once("error", () => socket.close());
  }

  #receiveCdp(
    connection: BridgeConnection,
    socket: WebSocket,
    raw: string,
  ): void {
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
        targetInfos: [...connection.tabs.values()].map(targetInfo),
      });
      return;
    }
    if (method === "Target.createTarget") {
      if (
        !connection.browserConnected ||
        connection.native?.readyState !== WebSocket.OPEN
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
      connection.pending.set(requestId, { socket, id });
      connection.native.send(
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
        ![...connection.tabs.values()].some(
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
      connection.sessions.set(nextSession, {
        socket,
        targetId: requestedTarget,
      });
      this.#reply(socket, id, { sessionId: nextSession });
      return;
    }
    if (method === "Target.detachFromTarget") {
      const detached = stringValue(params.sessionId) ?? sessionId;
      const existing =
        detached === undefined ? undefined : connection.sessions.get(detached);
      if (detached === undefined || existing?.socket !== socket) {
        this.#reply(socket, id, undefined, {
          code: -32000,
          message: "Unknown Chrome tab session",
        });
        return;
      }
      connection.sessions.delete(detached);
      this.#reply(socket, id, {});
      return;
    }
    const session =
      sessionId === undefined ? undefined : connection.sessions.get(sessionId);
    const tab = [...connection.tabs.values()].find(
      (tab) => targetId(tab) === session?.targetId,
    );
    if (
      sessionId === undefined ||
      session?.socket !== socket ||
      tab === undefined ||
      connection.native?.readyState !== WebSocket.OPEN
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
    connection.pending.set(requestId, {
      socket,
      id,
      sessionId,
      tabId: tab.id,
      ...(method === "Page.navigate" && typeof params.url === "string"
        ? { navigatedUrl: params.url }
        : {}),
    });
    connection.native.send(
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

  #detachTab(
    connection: BridgeConnection,
    tabId: number,
    reason: string,
  ): void {
    const previous = connection.tabs.get(tabId);
    if (previous === undefined) return;
    const previousTargetId = targetId(previous);
    connection.tabs.delete(tabId);
    for (const [sessionId, session] of [...connection.sessions]) {
      if (session.targetId !== previousTargetId) continue;
      connection.sessions.delete(sessionId);
      sendJson(session.socket, {
        method: "Target.detachedFromTarget",
        params: { sessionId, targetId: previousTargetId, reason },
      });
    }
    for (const [requestId, pending] of [...connection.pending]) {
      if (pending.tabId !== tabId) continue;
      connection.pending.delete(requestId);
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
    this.#broadcast(connection, {
      method: "Target.targetDestroyed",
      params: { targetId: previousTargetId },
    });
  }

  #updateTab(connection: BridgeConnection, tab: ConnectedTab): void {
    const existed = connection.tabs.has(tab.id);
    connection.tabs.set(tab.id, tab);
    this.#broadcast(connection, {
      method: existed ? "Target.targetInfoChanged" : "Target.targetCreated",
      params: { targetInfo: targetInfo(tab) },
    });
  }

  #disconnectBrowser(connection: BridgeConnection, reason: string): void {
    connection.browserConnected = false;
    connection.nativeReady = false;
    for (const tabId of [...connection.tabs.keys()])
      this.#detachTab(connection, tabId, reason);
    for (const [requestId, pending] of connection.pending) {
      connection.pending.delete(requestId);
      this.#reply(
        pending.socket,
        pending.id,
        undefined,
        { code: -32000, message: reason },
        pending.sessionId,
      );
    }
  }

  #dropCdp(connection: BridgeConnection, socket: WebSocket): void {
    connection.cdpSockets.delete(socket);
    for (const [sessionId, session] of [...connection.sessions]) {
      if (session.socket === socket) connection.sessions.delete(sessionId);
    }
    for (const [requestId, pending] of [...connection.pending]) {
      if (pending.socket === socket) connection.pending.delete(requestId);
    }
  }

  #broadcast(connection: BridgeConnection, message: unknown): void {
    for (const socket of connection.cdpSockets) sendJson(socket, message);
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
