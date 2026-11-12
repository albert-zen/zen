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
  "DOM.getBoxModel",
  "DOM.getFrameOwner",
  "DOM.getNodeForLocation",
  "DOM.resolveNode",
  "Runtime.callFunctionOn",
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
  "Page.frameAttached",
  "Page.documentOpened",
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
  tabId: number;
  rootSessionId: string;
  parentSessionId?: string;
  nativeSessionId?: string;
  autoAttach: boolean;
  depth: number;
}

const MAX_CHILD_SESSIONS = 64;
const MAX_CHILD_SESSION_HISTORY = 256;
const MAX_CHILD_DEPTH = 8;
const IFRAME_SESSION_LIMITATION =
  "Chrome 125 or newer and a current ZenX extension are required for child iframe sessions";

interface PendingCommand {
  socket: WebSocket;
  id: number;
  sessionId?: string;
  tabId?: number;
  navigatedUrl?: string;
  settled?: (failed: boolean) => void;
  silent?: boolean;
}

interface BridgeConnection {
  id: string;
  readonly generation: string;
  browser: "chrome" | "edge";
  native?: WebSocket;
  nativeReady: boolean;
  browserConnected: boolean;
  iframeSessions: boolean;
  childOwners: Map<number, string>;
  childUnavailable: Set<number>;
  childSessionsSeen: Map<number, Set<string>>;
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
    iframeSessions: false,
    childOwners: new Map(),
    childUnavailable: new Set(),
    childSessionsSeen: new Map(),
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
      connection.iframeSessions =
        asRecord(message.capabilities)?.iframeSessions === true;
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
      pending.settled?.(message.error !== undefined);
      if (pending.silent) return;
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
        (!ALLOWED_TAB_EVENTS.has(method) &&
          method !== "Target.attachedToTarget" &&
          method !== "Target.detachedFromTarget")
      )
        return;
      const nativeSessionId = stringValue(message.sessionId);
      if (message.sessionId !== undefined && nativeSessionId === undefined)
        return;
      const rootSessionId = connection.childOwners.get(tabId);
      const parent =
        nativeSessionId === undefined
          ? rootSessionId === undefined
            ? undefined
            : connection.sessions.get(rootSessionId)
          : [...connection.sessions.values()].find(
              (route) =>
                route.tabId === tabId &&
                route.nativeSessionId === nativeSessionId &&
                route.rootSessionId === rootSessionId,
            );
      if (
        method === "Target.attachedToTarget" ||
        method === "Target.detachedFromTarget"
      ) {
        if (parent === undefined || message.rootSessionId !== rootSessionId)
          return;
        const parentId =
          nativeSessionId === undefined
            ? rootSessionId!
            : [...connection.sessions].find(
                ([, route]) => route === parent,
              )![0];
        const childId = stringValue(params.sessionId);
        if (
          childId === undefined ||
          childId.length === 0 ||
          childId.length > 512
        )
          return;
        if (method === "Target.detachedFromTarget") {
          const detached = [...connection.sessions].find(
            ([, route]) =>
              route.parentSessionId === parentId &&
              route.nativeSessionId === childId,
          );
          if (detached !== undefined)
            this.#retireSession(
              connection,
              detached[0],
              "Chrome iframe detached",
            );
          return;
        }
        const info = asRecord(params.targetInfo);
        const childTargetId = stringValue(info?.targetId);
        const seen =
          connection.childSessionsSeen.get(tabId) ?? new Set<string>();
        if (
          !parent.autoAttach ||
          seen.has(childId) ||
          seen.size >= MAX_CHILD_SESSION_HISTORY ||
          info?.type !== "iframe" ||
          childTargetId === undefined ||
          childTargetId.length === 0 ||
          childTargetId.length > 512 ||
          parent.depth >= MAX_CHILD_DEPTH ||
          [...connection.sessions.values()].filter(
            (route) =>
              route.tabId === tabId && route.nativeSessionId !== undefined,
          ).length >= MAX_CHILD_SESSIONS ||
          [...connection.sessions.values()].some(
            (route) =>
              route.tabId === tabId && route.nativeSessionId === childId,
          )
        )
          return;
        seen.add(childId);
        connection.childSessionsSeen.set(tabId, seen);
        const virtualId = randomUUID();
        connection.sessions.set(virtualId, {
          socket: parent.socket,
          targetId: childTargetId,
          tabId,
          rootSessionId: parent.rootSessionId,
          parentSessionId: parentId,
          nativeSessionId: childId,
          autoAttach: false,
          depth: parent.depth + 1,
        });
        sendJson(parent.socket, {
          method,
          params: { ...params, sessionId: virtualId },
          sessionId: parentId,
        });
        return;
      }
      if (nativeSessionId !== undefined) {
        if (parent === undefined || message.rootSessionId !== rootSessionId)
          return;
        const virtualId = [...connection.sessions].find(
          ([, route]) => route === parent,
        )![0];
        if (method === "Inspector.detached") {
          this.#retireSession(
            connection,
            virtualId,
            "Chrome iframe inspector detached",
          );
          return;
        }
        sendJson(parent.socket, { method, params, sessionId: virtualId });
        return;
      }
      const navigatedUrl = mainFrameUrlFromEvent(method, params);
      if (navigatedUrl !== undefined)
        this.#updateTab(connection, { ...currentTab, url: navigatedUrl });
      for (const [sessionId, session] of connection.sessions) {
        if (session.tabId !== tabId || session.nativeSessionId !== undefined)
          continue;
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
    if (request.sessionId !== undefined && sessionId === undefined) {
      this.#reply(socket, id, undefined, {
        code: -32000,
        message: "Invalid Chrome session route",
      });
      return;
    }
    if (
      sessionId !== undefined &&
      (method === "ZenX.getCapabilities" ||
        (method.startsWith("Target.") &&
          method !== "Target.setAutoAttach" &&
          method !== "Target.detachFromTarget"))
    ) {
      this.#reply(
        socket,
        id,
        undefined,
        {
          code: -32000,
          message: "Browser discovery commands require the browser route",
        },
        sessionId,
      );
      return;
    }
    if (method === "ZenX.getCapabilities") {
      this.#reply(socket, id, {
        iframeSessions: connection.iframeSessions,
        ...(!connection.iframeSessions
          ? { limitation: IFRAME_SESSION_LIMITATION }
          : {}),
      });
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
          params: {
            url: params.url,
            ...(typeof params.zenxSessionId === "string" &&
            params.zenxSessionId.length <= 512
              ? { zenxSessionId: params.zenxSessionId }
              : {}),
          },
        }),
      );
      return;
    }
    if (method === "Target.closeTarget") {
      const tab = [...connection.tabs.values()].find(
        (tab) => targetId(tab) === params.targetId,
      );
      if (!tab || connection.native?.readyState !== WebSocket.OPEN) {
        this.#reply(socket, id, undefined, {
          code: -32000,
          message: "Created Chrome page is unavailable",
        });
        return;
      }
      const requestId = randomUUID();
      // Do not attach this receipt to the retiring tab: onRemoved is expected
      // before Chrome resolves tabs.remove, and must not turn success into error.
      connection.pending.set(requestId, { socket, id });
      connection.native.send(
        JSON.stringify({
          type: "cdp-command",
          requestId,
          method,
          tabId: tab.id,
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
        tabId: [...connection.tabs.values()].find(
          (tab) => targetId(tab) === requestedTarget,
        )!.id,
        rootSessionId: nextSession,
        autoAttach: false,
        depth: 0,
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
      if (
        sessionId !== undefined &&
        sessionId !== detached &&
        existing.parentSessionId !== sessionId
      ) {
        this.#reply(
          socket,
          id,
          undefined,
          { code: -32000, message: "Chrome iframe parent route changed" },
          sessionId,
        );
        return;
      }
      if (existing.nativeSessionId === undefined) {
        this.#retireSession(
          connection,
          detached,
          "Chrome root lease retired",
          false,
        );
        this.#releaseChildOwner(connection, existing, {
          socket,
          id,
          sessionId,
        });
      } else {
        const parent = connection.sessions.get(existing.parentSessionId!);
        this.#retireSession(
          connection,
          detached,
          "Chrome iframe lease retired",
          false,
        );
        if (
          parent === undefined ||
          connection.native?.readyState !== WebSocket.OPEN
        ) {
          this.#reply(
            socket,
            id,
            undefined,
            { code: -32000, message: "Chrome iframe parent route changed" },
            sessionId,
          );
          return;
        }
        const requestId = randomUUID();
        connection.pending.set(requestId, {
          socket,
          id,
          sessionId,
          tabId: existing.tabId,
        });
        connection.native.send(
          JSON.stringify({
            type: "cdp-command",
            requestId,
            tabId: existing.tabId,
            rootSessionId: existing.rootSessionId,
            ...(parent.nativeSessionId === undefined
              ? {}
              : { sessionId: parent.nativeSessionId }),
            method,
            params: { sessionId: existing.nativeSessionId },
          }),
        );
      }
      return;
    }
    const session =
      sessionId === undefined ? undefined : connection.sessions.get(sessionId);
    const tab =
      session === undefined ? undefined : connection.tabs.get(session.tabId);
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
    if (method === "Target.setAutoAttach") {
      if (
        connection.childUnavailable.has(tab.id) &&
        params.autoAttach !== false
      ) {
        this.#reply(
          socket,
          id,
          undefined,
          {
            code: -32000,
            message:
              "Chrome iframe cleanup is unconfirmed; reconnect this browser before enabling child sessions",
          },
          sessionId,
        );
        return;
      }
      if (!connection.iframeSessions || !iframeAutoAttachParams(params)) {
        this.#reply(
          socket,
          id,
          undefined,
          {
            code: -32000,
            message: !connection.iframeSessions
              ? IFRAME_SESSION_LIMITATION
              : "Only flattened, non-pausing iframe auto-attach is supported",
          },
          sessionId,
        );
        return;
      }
      if (
        [...connection.pending.values()].some(
          (pending) =>
            pending.sessionId === sessionId && pending.settled !== undefined,
        )
      ) {
        this.#reply(
          socket,
          id,
          undefined,
          {
            code: -32000,
            message: "Chrome iframe subscription change is still pending",
          },
          sessionId,
        );
        return;
      }
      const owner = connection.childOwners.get(tab.id);
      if (
        (owner !== undefined && owner !== session.rootSessionId) ||
        (session.nativeSessionId !== undefined &&
          owner !== session.rootSessionId)
      ) {
        this.#reply(
          socket,
          id,
          undefined,
          {
            code: -32000,
            message:
              "Chrome iframe routing is pinned to another root lease until native tab retirement or browser reconnect",
          },
          sessionId,
        );
        return;
      }
      if (params.autoAttach === false && owner === undefined) {
        this.#reply(socket, id, {}, undefined, sessionId);
        return;
      }
      connection.childOwners.set(tab.id, session.rootSessionId);
      session.autoAttach = params.autoAttach === true;
      if (!session.autoAttach)
        this.#retireDescendants(
          connection,
          sessionId,
          "Chrome iframe subscription disabled",
        );
      const requestId = randomUUID();
      connection.pending.set(requestId, {
        socket,
        id,
        sessionId,
        tabId: tab.id,
        settled: (failed) => {
          if (failed) {
            connection.childUnavailable.add(tab.id);
            session.autoAttach = false;
            this.#retireDescendants(
              connection,
              sessionId,
              "Chrome iframe setup failed",
            );
          }
          // Even confirmed disable does not transfer the shared native debugger
          // attachment to another root lease. Only native/tab retirement can.
        },
      });
      connection.native.send(
        JSON.stringify({
          type: "cdp-command",
          requestId,
          tabId: tab.id,
          rootSessionId: session.rootSessionId,
          ...(session.nativeSessionId === undefined
            ? {}
            : { sessionId: session.nativeSessionId }),
          method,
          params,
        }),
      );
      return;
    }
    if (
      session.nativeSessionId !== undefined &&
      method.startsWith("Input.") &&
      (method !== "Input.dispatchMouseEvent" || !iframeMouseParams(params))
    ) {
      this.#reply(
        socket,
        id,
        undefined,
        {
          code: -32000,
          message:
            "Chrome child input only supports a validated left-button press or release",
        },
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
      ...(session.nativeSessionId === undefined &&
      method === "Page.navigate" &&
      typeof params.url === "string"
        ? { navigatedUrl: params.url }
        : {}),
    });
    connection.native.send(
      JSON.stringify({
        type: "cdp-command",
        requestId,
        tabId: tab.id,
        ...(session.nativeSessionId === undefined
          ? {}
          : {
              sessionId: session.nativeSessionId,
              rootSessionId: session.rootSessionId,
            }),
        method,
        params,
      }),
    );
  }

  #retireDescendants(
    connection: BridgeConnection,
    parentId: string,
    reason: string,
  ): void {
    for (const [id, route] of [...connection.sessions])
      if (route.parentSessionId === parentId)
        this.#retireSession(connection, id, reason);
  }

  #retireSession(
    connection: BridgeConnection,
    id: string,
    reason: string,
    notify = true,
  ): void {
    const route = connection.sessions.get(id);
    if (route === undefined) return;
    this.#retireDescendants(connection, id, reason);
    connection.sessions.delete(id);
    for (const [requestId, pending] of [...connection.pending]) {
      if (pending.sessionId !== id || pending.settled !== undefined) continue;
      connection.pending.delete(requestId);
      this.#reply(
        pending.socket,
        pending.id,
        undefined,
        { code: -32000, message: reason },
        id,
      );
    }
    if (notify)
      sendJson(route.socket, {
        method: "Target.detachedFromTarget",
        params: { sessionId: id, targetId: route.targetId, reason },
        ...(route.parentSessionId === undefined
          ? {}
          : { sessionId: route.parentSessionId }),
      });
  }

  #releaseChildOwner(
    connection: BridgeConnection,
    root: CdpSession,
    reply?: Pick<PendingCommand, "socket" | "id" | "sessionId">,
  ): void {
    if (connection.childOwners.get(root.tabId) !== root.rootSessionId) {
      if (reply !== undefined)
        this.#reply(reply.socket, reply.id, {}, undefined, reply.sessionId);
      return;
    }
    if (connection.native?.readyState !== WebSocket.OPEN) {
      if (reply !== undefined)
        this.#reply(
          reply.socket,
          reply.id,
          undefined,
          { code: -32000, message: "Chrome iframe cleanup is unconfirmed" },
          reply.sessionId,
        );
      return;
    }
    const requestId = randomUUID();
    connection.pending.set(requestId, {
      socket: root.socket,
      id: reply?.id ?? -1,
      sessionId: reply?.sessionId,
      tabId: root.tabId,
      silent: reply === undefined,
      settled: (failed) => {
        if (failed) connection.childUnavailable.add(root.tabId);
      },
    });
    connection.native.send(
      JSON.stringify({
        type: "cdp-command",
        requestId,
        tabId: root.tabId,
        rootSessionId: root.rootSessionId,
        method: "Target.setAutoAttach",
        params: iframeAutoAttach(false),
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
      if (session.tabId !== tabId || session.nativeSessionId !== undefined)
        continue;
      this.#retireSession(connection, sessionId, reason);
    }
    connection.childOwners.delete(tabId);
    connection.childUnavailable.delete(tabId);
    connection.childSessionsSeen.delete(tabId);
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
    connection.iframeSessions = false;
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
    for (const [requestId, pending] of [...connection.pending]) {
      if (pending.socket === socket) {
        if (pending.settled !== undefined) pending.silent = true;
        else connection.pending.delete(requestId);
      }
    }
    for (const [sessionId, session] of [...connection.sessions]) {
      if (session.socket !== socket || session.nativeSessionId !== undefined)
        continue;
      this.#retireSession(
        connection,
        sessionId,
        "Chrome root socket retired",
        false,
      );
      this.#releaseChildOwner(connection, session);
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

// The Host chooses the existing exact renderer route; this transport only
// admits the current left-click pair and never derives or widens that route.
function iframeMouseParams(params: Record<string, unknown>): boolean {
  return (
    (params.type === "mousePressed" || params.type === "mouseReleased") &&
    typeof params.x === "number" &&
    Number.isFinite(params.x) &&
    typeof params.y === "number" &&
    Number.isFinite(params.y) &&
    params.button === "left" &&
    params.buttons === (params.type === "mousePressed" ? 1 : 0) &&
    params.clickCount === 1 &&
    Object.keys(params).every((key) =>
      ["type", "x", "y", "button", "buttons", "clickCount"].includes(key),
    )
  );
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
  // Same-document events include child frames and do not identify a main frame.
  // Forward the lifecycle event unchanged, but use the extension's authoritative
  // tab-updated metadata instead of assigning a child's URL to the owning tab.
  return undefined;
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function iframeAutoAttach(autoAttach: boolean): Record<string, unknown> {
  return {
    autoAttach,
    flatten: true,
    waitForDebuggerOnStart: false,
    ...(autoAttach
      ? { filter: [{ type: "iframe", exclude: false }, { exclude: true }] }
      : {}),
  };
}

function iframeAutoAttachParams(params: Record<string, unknown>): boolean {
  if (
    typeof params.autoAttach !== "boolean" ||
    params.flatten !== true ||
    params.waitForDebuggerOnStart !== false ||
    Object.keys(params).some(
      (key) =>
        !["autoAttach", "flatten", "waitForDebuggerOnStart", "filter"].includes(
          key,
        ),
    )
  )
    return false;
  // Native CDP rejects a nonempty target filter when auto-attach is disabled.
  if (!params.autoAttach)
    return (
      params.filter === undefined ||
      (Array.isArray(params.filter) && params.filter.length === 0)
    );
  if (!Array.isArray(params.filter) || params.filter.length !== 2) return false;
  const first = asRecord(params.filter[0]);
  const last = asRecord(params.filter[1]);
  return (
    first?.type === "iframe" &&
    (first.exclude === false || first.exclude === undefined) &&
    Object.keys(first).every((key) => key === "type" || key === "exclude") &&
    last?.exclude === true &&
    Object.keys(last).length === 1
  );
}
