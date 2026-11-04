import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import WebSocket, { WebSocketServer } from "ws";
import { observeOwnedChild } from "../src/main/owned-child-process.js";

const runFile = promisify(execFile);
const sourceDirectory = fileURLToPath(
  new URL("../resources/chrome-extension/", import.meta.url),
);
const EXTENSION_ID = "jenndkelhapgbokkmmfifkmiadkeflci";
const MAX_MESSAGES = 1024;
const HOSTS = [
  "root.zenx.test",
  "child.zenx-child.test",
  "nested.zenx-nested.test",
];
export const RECONNECT_DEADLINE_MS = 45_000;
export const autoAttach = (autoAttach = true) => ({
  autoAttach,
  flatten: true,
  waitForDebuggerOnStart: false,
  ...(autoAttach
    ? { filter: [{ type: "iframe", exclude: false }, { exclude: true }] }
    : {}),
});

/** Synthetic transport only. The imported production worker and debugger APIs stay unchanged. */
export function nativePortWrapper(endpoint) {
  const url = new URL(endpoint);
  assert.equal(url.protocol, "ws:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.username + url.password + url.search + url.hash, "");
  assert.match(url.pathname, /^\/fixture\/[a-zA-Z0-9_-]+$/);
  return `"use strict";
(() => {
  const endpoint = ${JSON.stringify(endpoint)};
  const connectNative = (host) => {
    if (host !== "com.zenx.chrome_bridge") throw new Error("Unexpected fixture native host");
    const ws = new WebSocket(endpoint);
    const messages = new Set(), disconnected = new Set();
    const queued = [];
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      queued.length = 0;
      for (const listener of [...disconnected]) listener();
    };
    ws.addEventListener("open", () => {
      if (closed) return;
      for (const value of queued.splice(0)) ws.send(value);
    });
    ws.addEventListener("message", (event) => {
      if (closed) return;
      let value;
      try { value = JSON.parse(event.data); }
      catch { ws.close(); finish(); return; }
      for (const listener of [...messages]) listener(value);
    });
    ws.addEventListener("close", finish);
    ws.addEventListener("error", finish);
    return {
      onMessage: { addListener: (listener) => messages.add(listener) },
      onDisconnect: { addListener: (listener) => disconnected.add(listener) },
      postMessage(value) {
        if (closed) throw new Error("Synthetic native port is closed");
        const raw = JSON.stringify(value);
        if (raw.length > 1024 * 1024 || queued.length >= 64)
          throw new Error("Synthetic native port exceeded its bound");
        if (ws.readyState === WebSocket.OPEN) ws.send(raw); else queued.push(raw);
      },
      disconnect() { ws.close(); finish(); },
    };
  };
  Object.defineProperty(chrome.runtime, "connectNative", { value: connectNative, configurable: true });
  if (chrome.runtime.connectNative !== connectNative) throw new Error("Native port fixture could not install");
})();
importScripts("service-worker.js");
`;
}

export async function prepareExtension(destination, endpoint) {
  await cp(sourceDirectory, destination, { recursive: true });
  const production = await readFile(
    path.join(sourceDirectory, "service-worker.js"),
  );
  assert.equal(
    Buffer.compare(
      production,
      await readFile(path.join(destination, "service-worker.js")),
    ),
    0,
  );
  const manifestFile = path.join(destination, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const id = createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest()
    .subarray(0, 16)
    .toString("hex")
    .replace(/[0-9a-f]/g, (value) =>
      String.fromCharCode(97 + parseInt(value, 16)),
    );
  assert.equal(id, EXTENSION_ID);
  manifest.background = { service_worker: "fixture-service-worker.js" };
  await writeFile(manifestFile, JSON.stringify(manifest));
  await writeFile(
    path.join(destination, "fixture-service-worker.js"),
    nativePortWrapper(endpoint),
  );
  return createHash("sha256").update(production).digest("hex");
}

export function fixtureUrls(port) {
  assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536);
  return HOSTS.map(
    (host, index) =>
      `http://${host}:${port}/${["root", "child", "nested"][index]}`,
  );
}

export function fixturePage(role, urls) {
  assert.ok(["root", "child", "nested"].includes(role));
  const inner =
    role === "root"
      ? `<iframe id="child" src="${urls[1]}"></iframe>`
      : role === "child"
        ? `<iframe id="nested" src="${urls[2]}"></iframe>`
        : "";
  return `<!doctype html><title>Owned debugger ${role}</title><h1>${role}</h1>${inner}<script>globalThis.fixtureRole=${JSON.stringify(role)}</script>`;
}

export function browserArguments(profile, extension, rootUrl) {
  return [
    `--user-data-dir=${profile}`,
    `--load-extension=${extension}`,
    `--disable-extensions-except=${extension}`,
    "--site-per-process",
    `--host-resolver-rules=${HOSTS.map((host) => `MAP ${host} 127.0.0.1`).join(",")}`,
    "--no-first-run",
    "--no-default-browser-check",
    rootUrl,
  ];
}

export class FixtureNativeConnection {
  messages = [];
  closed = false;
  failure;
  constructor(socket) {
    this.socket = socket;
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw));
        assert.ok(
          message !== null &&
            typeof message === "object" &&
            !Array.isArray(message),
        );
        assert.ok(
          this.messages.length < MAX_MESSAGES,
          "Native fixture message bound exceeded",
        );
        this.messages.push(message);
        if (message.type === "hello") {
          assert.equal(message.protocolVersion, 3);
          assert.equal(message.scope, "browser");
          assert.equal(message.capabilities?.iframeSessions, true);
          socket.send(
            JSON.stringify({
              type: "ready",
              protocolVersion: 3,
              scope: "browser",
            }),
          );
        }
      } catch (error) {
        this.failure = error;
        socket.close();
      }
    });
    socket.on("close", () => {
      this.closed = true;
    });
    socket.on("error", (error) => {
      this.failure = error;
    });
  }
  async command(tabId, rootSessionId, method, params = {}, sessionId) {
    if (this.failure) throw this.failure;
    assert.ok(!this.closed, "Synthetic native connection closed");
    const requestId = randomUUID();
    this.socket.send(
      JSON.stringify({
        type: "cdp-command",
        requestId,
        tabId,
        rootSessionId,
        method,
        params,
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    );
    return await until(
      () => {
        if (this.failure) throw this.failure;
        if (this.closed)
          throw new Error(
            "Synthetic native connection closed before command result",
          );
        return this.messages.find(
          (message) =>
            message.type === "cdp-result" && message.requestId === requestId,
        );
      },
      `native ${method} response`,
      10_000,
    );
  }
  async success(...args) {
    const message = await this.command(...args);
    assert.equal(
      message.error,
      undefined,
      `Native debugger command failed: ${message.error?.message}`,
    );
    return message.result;
  }
  async child(root, parent, after = 0) {
    return await until(
      () => {
        if (this.failure) throw this.failure;
        if (this.closed)
          throw new Error(
            "Synthetic native connection closed before child event",
          );
        return this.messages
          .slice(after)
          .find(
            (message) =>
              message.type === "cdp-event" &&
              message.rootSessionId === root &&
              message.sessionId === parent &&
              message.method === "Target.attachedToTarget" &&
              message.params?.targetInfo?.type === "iframe",
          );
      },
      "real iframe attachment",
      10_000,
    );
  }
}

export function currentDefaultContext(
  messages,
  tabId,
  root,
  sessionId,
  expectedOrigin,
) {
  const contexts = new Map();
  for (const message of messages) {
    if (
      message.type !== "cdp-event" ||
      message.tabId !== tabId ||
      message.sessionId !== sessionId ||
      (sessionId !== undefined && message.rootSessionId !== root)
    )
      continue;
    if (message.method === "Runtime.executionContextsCleared") contexts.clear();
    else if (message.method === "Runtime.executionContextDestroyed")
      contexts.delete(message.params.executionContextId);
    else if (
      message.method === "Runtime.executionContextCreated" &&
      message.params.context?.auxData?.isDefault === true &&
      (expectedOrigin === undefined ||
        message.params.context.origin === expectedOrigin)
    )
      contexts.set(message.params.context.id, message.params.context);
  }
  return [...contexts.values()].at(-1);
}

async function readyContext(connection, tabId, root, sessionId, expectedUrl) {
  await connection.success(tabId, root, "Runtime.enable", {}, sessionId);
  const context = await until(
    () => {
      if (connection.failure) throw connection.failure;
      if (connection.closed)
        throw new Error(
          "Synthetic native connection closed before frame context",
        );
      return currentDefaultContext(
        connection.messages,
        tabId,
        root,
        sessionId,
        new URL(expectedUrl).origin,
      );
    },
    "trusted native default execution context",
    10_000,
  );
  assert.ok(Number.isSafeInteger(context.id));
  return context.id;
}

async function frameValue(
  connection,
  tabId,
  root,
  sessionId,
  role,
  url,
  contextId,
) {
  return await until(
    async () => {
      const value = await connection.success(
        tabId,
        root,
        "Runtime.evaluate",
        {
          expression: "({role:globalThis.fixtureRole,url:location.href})",
          returnByValue: true,
          contextId,
        },
        sessionId,
      );
      return value.result?.value?.role === role &&
        value.result.value.url === url
        ? value.result.value
        : undefined;
    },
    `real ${role} frame document readiness`,
    10_000,
  );
}

async function until(read, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined && result !== false) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} exceeded its outcome deadline`);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server.address().port;
}

async function deadline(operation, ms, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded its outcome deadline`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runChromeDebuggerSmoke() {
  assert.equal(
    process.platform,
    "win32",
    "This acceptance entry runs only in the existing Windows hosted job",
  );
  assert.equal(
    process.env.GITHUB_ACTIONS,
    "true",
    "Only disposable hosted acceptance is supported",
  );
  const executable = process.env.ZENX_USER_BROWSER_EXECUTABLE;
  assert.ok(
    executable && process.env.RUNNER_TEMP,
    "The existing pinned Chromium fixture is required",
  );
  await access(executable);
  const directory = await mkdtemp(
    path.join(process.env.RUNNER_TEMP, "zenx-debugger-children-"),
  );
  const connections = [];
  let urls,
    browser,
    observation,
    http,
    nativeServer,
    phase = "prepare",
    failure,
    cleanupFailure;
  let stderrBytes = 0;
  let stopping = false;
  const checks = {};
  const report = {
    realChromeDebugger: false,
    nativeMessaging: false,
    packagedNativeHost: false,
    productionServiceWorkerUnchanged: false,
    disposableProfile: true,
    registryChanged: false,
    outcome: "running",
    checks,
  };
  const setPhase = (value) => {
    phase = value;
  };
  try {
    http = createServer((request, response) => {
      const index = ["/root", "/child", "/nested"].indexOf(request.url);
      if (index < 0 || request.headers.host !== new URL(urls[index]).host) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html",
        "cache-control": "no-store",
      });
      response.end(fixturePage(["root", "child", "nested"][index], urls));
    });
    urls = fixtureUrls(await listen(http));
    nativeServer = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      maxPayload: 1024 * 1024,
    });
    await new Promise((resolve, reject) => {
      nativeServer.once("listening", resolve);
      nativeServer.once("error", reject);
    });
    const token = randomBytes(24).toString("base64url");
    nativeServer.on("connection", (socket, request) => {
      if (
        stopping ||
        request.url !== `/fixture/${token}` ||
        ![
          `chrome-extension://${EXTENSION_ID}`,
          `chrome-extension://${EXTENSION_ID}/`,
        ].includes(request.headers.origin) ||
        connections.length >= 2
      ) {
        socket.close(1008, "Fixture scope mismatch");
        return;
      }
      connections.push(new FixtureNativeConnection(socket));
    });
    const extension = path.join(directory, "extension");
    report.productionWorkerSha256 = await prepareExtension(
      extension,
      `ws://127.0.0.1:${nativeServer.address().port}/fixture/${token}`,
    );
    report.productionServiceWorkerUnchanged = true;
    setPhase("launch");
    browser = spawn(
      executable,
      browserArguments(path.join(directory, "profile"), extension, urls[0]),
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: false },
    );
    observation = observeOwnedChild(browser);
    browser.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
    });
    await deadline(
      (async () => {
        const current = await until(() => {
          if (stopping) throw new Error("Debugger fixture has stopped");
          if (observation.outcome())
            throw new Error("Owned Chromium exited before extension startup");
          const candidate = connections[0];
          if (candidate?.failure) throw candidate.failure;
          return candidate?.messages.some(
            (message) => message.type === "browser-connected",
          )
            ? candidate
            : undefined;
        }, "production extension browser connection");
        const tabId = await until(() => {
          if (stopping) throw new Error("Debugger fixture has stopped");
          for (const message of current.messages) {
            const tabs =
              message.type === "browser-connected"
                ? message.tabs
                : message.type === "tab-updated"
                  ? [message.tab]
                  : [];
            const tab = tabs?.find((tab) => tab.url === urls[0]);
            if (tab) return tab.id;
          }
        }, "owned root tab publication");
        const root = randomUUID();
        const successor = randomUUID();
        setPhase("root-enable");
        await current.success(tabId, root, "Page.enable");
        report.realChromeDebugger = true;
        const rootContext = await readyContext(
          current,
          tabId,
          root,
          undefined,
          urls[0],
        );
        const ua = await current.success(tabId, root, "Runtime.evaluate", {
          expression: "navigator.userAgent",
          returnByValue: true,
          contextId: rootContext,
        });
        report.chromiumVersion = /(?:Chrome|Chromium)\/[\d.]+/.exec(
          ua.result.value,
        )?.[0];
        assert.ok(report.chromiumVersion);
        await current.success(
          tabId,
          root,
          "Target.setAutoAttach",
          autoAttach(),
        );
        setPhase("child-route");
        const childEvent = await current.child(root);
        assert.equal(childEvent.tabId, tabId);
        const child = childEvent.params.sessionId;
        assert.ok(typeof child === "string" && child.length > 0);
        assert.equal(childEvent.sessionId, undefined);
        await current.success(tabId, root, "Page.enable", {}, child);
        const childContext = await readyContext(
          current,
          tabId,
          root,
          child,
          urls[1],
        );
        assert.deepEqual(
          await frameValue(
            current,
            tabId,
            root,
            child,
            "child",
            urls[1],
            childContext,
          ),
          { role: "child", url: urls[1] },
        );
        await until(
          () =>
            current.messages.find(
              (message) =>
                message.method === "Runtime.executionContextCreated" &&
                message.sessionId === child &&
                message.rootSessionId === root,
            ),
          "child DebuggerSession source envelope",
        );
        checks.childSessionEnvelope = true;
        setPhase("nested-route");
        await current.success(
          tabId,
          root,
          "Target.setAutoAttach",
          autoAttach(),
          child,
        );
        const nestedEvent = await current.child(root, child);
        assert.equal(nestedEvent.tabId, tabId);
        const nested = nestedEvent.params.sessionId;
        assert.notEqual(nested, child);
        const nestedContext = await readyContext(
          current,
          tabId,
          root,
          nested,
          urls[2],
        );
        assert.deepEqual(
          await frameValue(
            current,
            tabId,
            root,
            nested,
            "nested",
            urls[2],
            nestedContext,
          ),
          { role: "nested", url: urls[2] },
        );
        checks.nestedParentEnvelope = true;
        setPhase("route-denials");
        assert.match(
          (
            await current.command(
              tabId,
              root,
              "Page.enable",
              {},
              `unknown-${randomUUID()}`,
            )
          ).error.message,
          /Unknown or retired/,
        );
        assert.match(
          (
            await current.command(
              tabId,
              root,
              "Input.dispatchMouseEvent",
              { type: "mouseMoved", x: 1, y: 1 },
              child,
            )
          ).error.message,
          /root tab/,
        );
        checks.unknownSessionRejected = checks.childInputRejected = true;
        setPhase("child-retirement");
        await current.success(
          tabId,
          root,
          "Target.detachFromTarget",
          { sessionId: nested },
          child,
        );
        assert.match(
          (await current.command(tabId, root, "Page.enable", {}, nested)).error
            .message,
          /Unknown or retired/,
        );
        const removedAt = current.messages.length;
        await current.success(tabId, root, "Runtime.evaluate", {
          expression: "document.getElementById('child').remove();true",
          returnByValue: true,
        });
        await until(
          () =>
            current.messages
              .slice(removedAt)
              .find(
                (message) =>
                  message.method === "Target.detachedFromTarget" &&
                  message.params?.sessionId === child &&
                  message.sessionId === undefined,
              ),
          "native child removal event",
        );
        assert.match(
          (await current.command(tabId, root, "Page.enable", {}, child)).error
            .message,
          /Unknown or retired/,
        );
        const rootValue = await current.success(
          tabId,
          root,
          "Runtime.evaluate",
          { expression: "location.href", returnByValue: true },
        );
        assert.equal(rootValue.result.value, urls[0]);
        checks.childDetachPreservesRoot = true;
        setPhase("same-owner-resubscribe");
        await current.success(
          tabId,
          root,
          "Target.setAutoAttach",
          autoAttach(false),
        );
        const attachAt = current.messages.length;
        await current.success(tabId, root, "Runtime.evaluate", {
          expression: `(()=>{const f=document.createElement('iframe');f.id='child';f.src=${JSON.stringify(urls[1])};document.body.append(f);return true})()`,
          returnByValue: true,
        });
        await current.success(
          tabId,
          root,
          "Target.setAutoAttach",
          autoAttach(),
        );
        const resubscribed = (await current.child(root, undefined, attachAt))
          .params.sessionId;
        assert.notEqual(resubscribed, child);
        checks.sameRootResubscribe = true;
        await current.success(
          tabId,
          root,
          "Target.setAutoAttach",
          autoAttach(false),
        );
        assert.match(
          (
            await current.command(
              tabId,
              successor,
              "Target.setAutoAttach",
              autoAttach(),
            )
          ).error.message,
          /pinned.*reconnect/,
        );
        checks.successorRootPinned = true;
        setPhase("native-retirement-and-alarm-reconnect");
        current.socket.close();
        const next = await until(
          () => {
            if (stopping) throw new Error("Debugger fixture has stopped");
            const candidate = connections[1];
            if (candidate?.failure) throw candidate.failure;
            return candidate?.messages.some(
              (message) => message.type === "browser-connected",
            )
              ? candidate
              : undefined;
          },
          "unchanged production reconnect alarm",
          RECONNECT_DEADLINE_MS,
        );
        assert.notEqual(next, current);
        await next.success(tabId, successor, "Page.enable");
        await next.success(
          tabId,
          successor,
          "Target.setAutoAttach",
          autoAttach(),
        );
        const newChild = (await next.child(successor)).params.sessionId;
        assert.notEqual(newChild, resubscribed);
        assert.match(
          (
            await next.command(
              tabId,
              successor,
              "Page.enable",
              {},
              resubscribed,
            )
          ).error.message,
          /Unknown or retired/,
        );
        const newChildContext = await readyContext(
          next,
          tabId,
          successor,
          newChild,
          urls[1],
        );
        assert.deepEqual(
          await frameValue(
            next,
            tabId,
            successor,
            newChild,
            "child",
            urls[1],
            newChildContext,
          ),
          { role: "child", url: urls[1] },
        );
        checks.freshTransportAcceptsNewRoot =
          checks.oldTransportSessionRejected = true;
        report.nativePortConnections = connections.length;
      })(),
      100_000,
      "real debugger child acceptance",
    );
    report.outcome = "passed";
  } catch (error) {
    failure = error;
    report.outcome = "failed";
    report.failedPhase = phase;
    report.error = String(error.message ?? error).slice(0, 512);
  } finally {
    stopping = true;
    const cleanupErrors = [];
    const cleanup = async (action) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    for (const connection of connections) {
      connection.failure ??= new Error("Debugger fixture cleanup started");
      connection.socket.close();
    }
    await cleanup(async () => {
      if (
        browser &&
        observation?.outcome() === undefined &&
        browser.pid !== undefined
      ) {
        await runFile(
          "taskkill.exe",
          ["/PID", String(browser.pid), "/T", "/F"],
          { windowsHide: true, timeout: 5000 },
        ).catch(() => {
          browser.kill("SIGKILL");
        });
        await deadline(
          observation.terminal,
          5000,
          "owned Chromium process cleanup",
        );
      }
    });
    await cleanup(async () => {
      if (nativeServer) {
        for (const socket of nativeServer.clients) socket.terminate();
        await deadline(
          new Promise((resolve) => nativeServer.close(resolve)),
          5000,
          "synthetic native listener cleanup",
        );
      }
    });
    await cleanup(async () => {
      if (http?.listening) {
        http.closeAllConnections();
        await deadline(
          new Promise((resolve) => http.close(resolve)),
          5000,
          "owned HTTP fixture cleanup",
        );
      }
    });
    await cleanup(async () => {
      if (browser && observation?.outcome() === undefined)
        throw new Error(
          "Owned Chromium closure is unconfirmed; its disposable profile was retained",
        );
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    });
    report.cleanupCompleted = cleanupErrors.length === 0;
    if (cleanupErrors.length > 0) {
      cleanupFailure = cleanupErrors[0];
      report.outcome = "failed";
      report.cleanupError = String(
        cleanupFailure.message ?? cleanupFailure,
      ).slice(0, 256);
    }
    report.browserStderrBytes = stderrBytes;
    const artifact = process.env.ZENX_CHROME_DEBUGGER_ARTIFACT_DIR;
    if (artifact) {
      try {
        await mkdir(artifact, { recursive: true });
        await writeFile(
          path.join(artifact, "chrome-debugger-child-acceptance.json"),
          `${JSON.stringify(report, null, 2)}\n`,
        );
      } catch (error) {
        cleanupFailure ??= error;
        report.outcome = "failed";
        report.artifactError = String(error.message ?? error).slice(0, 256);
      }
    }
    console.log(JSON.stringify(report, null, 2));
  }
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  return report;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await runChromeDebuggerSmoke();
