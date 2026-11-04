// Opt-in experiment. Nothing in the production application imports this module.
require("tsx/cjs");
const { randomBytes } = require("node:crypto");
const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");
const { chromium } = require("playwright-core");
const { PlaywrightTargetTransport } = require("./target-transport.ts");

const leases = new WeakSet();
async function attachPlaywrightToWebContents(
  webContents,
  { exclusiveDebuggerLease } = {},
) {
  if (
    exclusiveDebuggerLease !== true ||
    leases.has(webContents) ||
    webContents.debugger.listenerCount("message") !== 0
  ) {
    throw new Error(
      "Experiment requires an exclusive synthetic-page debugger lease; sharing a live Host debugger is not implemented",
    );
  }

  const debuggerApi = webContents.debugger;
  // The Host owns this attachment. Never detach it on experiment disconnect.
  if (!debuggerApi.isAttached())
    throw new Error(
      "Playwright experiment requires an existing Host-owned debugger attachment",
    );
  const { targetInfo } = await debuggerApi.sendCommand("Target.getTargetInfo");
  leases.add(webContents);
  const route = "/" + randomBytes(24).toString("hex");
  const authorization = "Bearer " + randomBytes(32).toString("hex");
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 32 * 1024 * 1024,
  });
  let transport;
  let activeSocket;
  server.on("upgrade", (request, socket, head) => {
    if (
      request.url !== route ||
      request.headers.authorization !== authorization ||
      request.headers.origin ||
      activeSocket
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (accepted) =>
      sockets.emit("connection", accepted),
    );
  });
  sockets.on("connection", (socket) => {
    activeSocket = socket;
    transport = new PlaywrightTargetTransport({
      version: {
        product: `Chrome/${process.versions.chrome}`,
        userAgent: webContents.getUserAgent(),
        protocolVersion: "1.3",
        revision: "",
        jsVersion: process.versions.v8,
      },
      target: {
        targetId: targetInfo.targetId,
        url: webContents.getURL(),
        title: webContents.getTitle(),
      },
      emit: (message) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(message));
      },
      cdp: {
        send: (method, params, sessionId) =>
          debuggerApi.sendCommand(method, params, sessionId),
        subscribe(listener) {
          const onMessage = (_event, method, params, sessionId) =>
            listener(method, params, sessionId || undefined);
          debuggerApi.on("message", onMessage);
          return () => debuggerApi.removeListener("message", onMessage);
        },
      },
    });
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        socket.close(1007);
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        socket.close(1007);
        return;
      }
      void transport.receive(message);
    });
    socket.on("close", () => {
      void stop().catch((error) =>
        console.error("Playwright attachment cleanup failed", error),
      );
    });
  });
  let stopPromise;
  const stop = () => {
    if (stopPromise) return stopPromise;
    webContents.removeListener("destroyed", onDestroyed);
    debuggerApi.removeListener("detach", onDetached);
    const cleanup = transport?.close();
    stopPromise = Promise.resolve(cleanup).then(() =>
      leases.delete(webContents),
    );
    stopPromise.catch((error) =>
      console.error("Playwright attachment cleanup failed", error),
    );
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    if (server.listening) server.close();
    return stopPromise;
  };
  const onDestroyed = () => {
    void stop();
  };
  const onDetached = () => {
    void stop();
  };
  webContents.once("destroyed", onDestroyed);
  debuggerApi.once("detach", onDetached);
  let browser;
  try {
    if (stopPromise) throw new Error("Target retired before relay startup");
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        if (stopPromise) server.close();
        resolve();
      });
    });
    if (stopPromise) throw new Error("Target retired during relay startup");
    browser = await chromium.connectOverCDP(
      `ws://127.0.0.1:${server.address().port}${route}`,
      { headers: { authorization }, noDefaults: true, timeout: 15000 },
    );
    if (stopPromise)
      throw new Error("Target retired during Playwright attachment");
    const pages = browser.contexts().flatMap((context) => context.pages());
    if (pages.length !== 1)
      throw Error(
        `Scoped attachment exposed ${pages.length} pages, expected one`,
      );
    return {
      page: pages[0],
      async close() {
        webContents.removeListener("destroyed", onDestroyed);
        debuggerApi.removeListener("detach", onDetached);
        try {
          await browser.close();
        } finally {
          await stop();
        }
      },
    };
  } catch (error) {
    webContents.removeListener("destroyed", onDestroyed);
    debuggerApi.removeListener("detach", onDetached);
    if (browser) await browser.close().catch(() => {});
    await stop();
    throw error;
  }
}
module.exports = { attachPlaywrightToWebContents };
