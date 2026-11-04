import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  autoAttach,
  browserArguments,
  currentDefaultContext,
  fixturePage,
  fixtureUrls,
  FixtureNativeConnection,
  nativePortWrapper,
  prepareExtension,
  RECONNECT_DEADLINE_MS,
} from "../scripts/smoke-chrome-debugger-children.mjs";

function wrapperFixture() {
  const sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    listeners = new Map();
    sent = [];
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    addEventListener(name, handler) {
      this.listeners.set(name, handler);
    }
    emit(name, data) {
      this.listeners.get(name)?.(data);
    }
    send(raw) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = 3;
      this.emit("close");
    }
  }
  const debuggerApi = { attach() {}, sendCommand() {}, onEvent: {} };
  const storage = {},
    alarms = {},
    imports = [];
  const chrome = {
    runtime: {
      connectNative: () => {
        throw new Error("Real native messaging must not run in this fixture");
      },
    },
    debugger: debuggerApi,
    storage,
    alarms,
  };
  vm.runInNewContext(
    nativePortWrapper("ws://127.0.0.1:1234/fixture/test-token"),
    {
      chrome,
      WebSocket: Socket,
      importScripts(file) {
        imports.push(file);
      },
    },
  );
  return { chrome, sockets, debuggerApi, storage, alarms, imports };
}

test("native-port wrapper changes only connectNative and loads unchanged production entry", () => {
  const f = wrapperFixture();
  assert.equal(f.chrome.debugger, f.debuggerApi);
  assert.equal(f.chrome.storage, f.storage);
  assert.equal(f.chrome.alarms, f.alarms);
  assert.deepEqual(f.imports, ["service-worker.js"]);
  assert.throws(
    () => f.chrome.runtime.connectNative("unapproved-host"),
    /Unexpected fixture/,
  );
  const port = f.chrome.runtime.connectNative("com.zenx.chrome_bridge");
  const messages = [];
  let disconnects = 0;
  port.onMessage.addListener((message) => messages.push(message));
  port.onDisconnect.addListener(() => disconnects++);
  port.postMessage({ type: "hello" });
  assert.equal(f.sockets[0].sent.length, 0);
  f.sockets[0].readyState = 1;
  f.sockets[0].emit("open");
  assert.deepEqual(f.sockets[0].sent, [{ type: "hello" }]);
  f.sockets[0].emit("message", {
    data: JSON.stringify({ type: "cdp-command", sessionId: "native-child" }),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { type: "cdp-command", sessionId: "native-child" },
  ]);
  f.sockets[0].emit("error");
  f.sockets[0].emit("close");
  port.disconnect();
  assert.equal(disconnects, 1);
  assert.throws(() => port.postMessage({}), /closed/);
});

test("synthetic port has bounded startup buffering and rejects non-loopback endpoints", () => {
  const f = wrapperFixture();
  const port = f.chrome.runtime.connectNative("com.zenx.chrome_bridge");
  for (let i = 0; i < 64; i++) port.postMessage({ i });
  assert.throws(() => port.postMessage({}), /exceeded its bound/);
  port.disconnect();
  f.sockets[0].readyState = 1;
  f.sockets[0].emit("open");
  assert.equal(f.sockets[0].sent.length, 0);
  for (const url of [
    "wss://127.0.0.1/fixture/a",
    "ws://external.test/fixture/a",
    "ws://127.0.0.1/other",
    "ws://user:secret@127.0.0.1/fixture/a",
  ])
    assert.throws(() => nativePortWrapper(url));
});

test("temporary extension copy preserves production bytes and keyed identity", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-extension-fixture-test-"),
  );
  try {
    const hash = await prepareExtension(
      path.join(directory, "extension"),
      "ws://127.0.0.1:1234/fixture/test-token",
    );
    assert.match(hash, /^[a-f0-9]{64}$/);
    const original = await readFile(
      new URL(
        "../resources/chrome-extension/service-worker.js",
        import.meta.url,
      ),
      "utf8",
    );
    assert.equal(
      await readFile(
        path.join(directory, "extension/service-worker.js"),
        "utf8",
      ),
      original,
    );
    const manifest = JSON.parse(
      await readFile(path.join(directory, "extension/manifest.json"), "utf8"),
    );
    const sourceManifest = JSON.parse(
      await readFile(
        new URL("../resources/chrome-extension/manifest.json", import.meta.url),
        "utf8",
      ),
    );
    assert.deepEqual(manifest, {
      ...sourceManifest,
      background: { service_worker: "fixture-service-worker.js" },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owned nested sites and launch flags stay within the disposable Chromium process", () => {
  const urls = fixtureUrls(1234);
  assert.equal(new Set(urls.map((url) => new URL(url).hostname)).size, 3);
  assert.ok(urls.every((url) => new URL(url).port === "1234"));
  assert.match(fixturePage("root", urls), /id="child"/);
  assert.match(fixturePage("child", urls), /id="nested"/);
  assert.doesNotMatch(fixturePage("nested", urls), /iframe/);
  const args = browserArguments(
    "C:\\fixture\\profile",
    "C:\\fixture\\extension",
    urls[0],
  );
  assert.equal(args[0], "--user-data-dir=C:\\fixture\\profile");
  assert.ok(args.includes("--site-per-process"));
  assert.ok(args.includes("--load-extension=C:\\fixture\\extension"));
  assert.doesNotMatch(
    args.join(" "),
    /no-sandbox|disable-web-security|remote-debugging|ignore-certificate|user-agent|disable-features/,
  );
  assert.match(
    args.find((arg) => arg.startsWith("--host-resolver-rules=")),
    /MAP root\.zenx\.test 127\.0\.0\.1/,
  );
  assert.ok(RECONNECT_DEADLINE_MS > 30_000 && RECONNECT_DEADLINE_MS <= 60_000);
});

test("synthetic host validates handshake and matches real command result by exact request ID", async () => {
  const socket = new EventEmitter();
  socket.sent = [];
  socket.close = () => socket.emit("close");
  socket.send = (raw) => {
    const message = JSON.parse(raw);
    socket.sent.push(message);
    if (message.type === "cdp-command") {
      socket.emit(
        "message",
        JSON.stringify({
          type: "cdp-result",
          requestId: "unrelated",
          result: { wrong: true },
        }),
      );
      socket.emit(
        "message",
        JSON.stringify({
          type: "cdp-result",
          requestId: message.requestId,
          result: { route: message.sessionId },
        }),
      );
    }
  };
  const port = new FixtureNativeConnection(socket);
  socket.emit(
    "message",
    JSON.stringify({
      type: "hello",
      protocolVersion: 3,
      scope: "browser",
      capabilities: { iframeSessions: true },
    }),
  );
  assert.deepEqual(socket.sent[0], {
    type: "ready",
    protocolVersion: 3,
    scope: "browser",
  });
  assert.deepEqual(
    await port.success(7, "root", "Page.enable", {}, "native-child"),
    { route: "native-child" },
  );
  const command = socket.sent.at(-1);
  assert.equal(command.tabId, 7);
  assert.equal(command.rootSessionId, "root");
  assert.equal(command.sessionId, "native-child");
  socket.emit(
    "message",
    JSON.stringify({ type: "hello", protocolVersion: 2, scope: "browser" }),
  );
  assert.ok(port.failure);
  assert.equal(port.closed, true);
});

test("CI adds one explicit debugger-only acceptance step without registry or native-host claims", async () => {
  const ci = await readFile(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const source = await readFile(
    new URL("../scripts/smoke-chrome-debugger-children.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(
    ci.split(
      "run: node --import tsx apps/zenx/scripts/smoke-chrome-debugger-children.mjs",
    ).length - 1,
    1,
  );
  assert.ok(
    ci.indexOf('"ZENX_USER_BROWSER_EXECUTABLE=$browserExecutable"') <
      ci.indexOf(
        "run: node --import tsx apps/zenx/scripts/smoke-chrome-debugger-children.mjs",
      ),
  );
  assert.match(source, /realChromeDebugger: false/);
  assert.match(source, /report.realChromeDebugger = true/);
  assert.match(source, /nativeMessaging: false/);
  assert.match(source, /packagedNativeHost: false/);
  assert.match(source, /productionServiceWorkerUnchanged/);
  assert.doesNotMatch(
    source,
    /reg\.exe|HKCU|HKEY|registerChromeNativeHost|chrome\.alarms\.|chrome\.storage\./,
  );
});

test("retirement forbids later native commands even before socket close notification", async () => {
  const socket = new EventEmitter();
  const sent = [];
  socket.send = (value) => sent.push(value);
  socket.close = () => {};
  const port = new FixtureNativeConnection(socket);
  port.failure = new Error("Debugger fixture cleanup started");
  await assert.rejects(
    port.command(7, "root", "Runtime.evaluate", {}),
    /cleanup started/,
  );
  await assert.rejects(port.child("root"), /cleanup started/);
  assert.equal(sent.length, 0);
});

test("native readiness uses a current exact-route default context before evaluation", () => {
  const events = [];
  const emit = (
    method,
    params,
    sessionId = "child",
    rootSessionId = "root",
    tabId = 7,
  ) =>
    events.push({
      type: "cdp-event",
      method,
      params,
      tabId,
      sessionId,
      rootSessionId,
    });
  const context = (id, isDefault = true) => ({
    id,
    uniqueId: `unique-${id}`,
    auxData: { isDefault, frameId: "child-frame" },
  });
  emit(
    "Runtime.executionContextCreated",
    { context: context(1) },
    "other-child",
  );
  emit(
    "Runtime.executionContextCreated",
    { context: context(2) },
    "child",
    "other-root",
  );
  emit("Runtime.executionContextCreated", { context: context(3, false) });
  assert.equal(currentDefaultContext(events, 7, "root", "child"), undefined);
  emit("Runtime.executionContextCreated", { context: context(4) });
  assert.equal(currentDefaultContext(events, 7, "root", "child").id, 4);
  emit("Runtime.executionContextDestroyed", { executionContextId: 4 });
  assert.equal(currentDefaultContext(events, 7, "root", "child"), undefined);
  emit("Runtime.executionContextCreated", { context: context(5) });
  emit("Runtime.executionContextsCleared", {});
  assert.equal(currentDefaultContext(events, 7, "root", "child"), undefined);
});

test("frame readiness excludes an inherited blank context from the wrong origin", () => {
  const event = (id, origin) => ({
    type: "cdp-event",
    tabId: 7,
    rootSessionId: "root",
    sessionId: "child",
    method: "Runtime.executionContextCreated",
    params: { context: { id, origin, auxData: { isDefault: true } } },
  });
  const messages = [event(1, "http://root.zenx.test:1234")];
  assert.equal(
    currentDefaultContext(
      messages,
      7,
      "root",
      "child",
      "http://child.zenx-child.test:1234",
    ),
    undefined,
  );
  messages.push(event(2, "http://child.zenx-child.test:1234"));
  assert.equal(
    currentDefaultContext(
      messages,
      7,
      "root",
      "child",
      "http://child.zenx-child.test:1234",
    ).id,
    2,
  );
});

test("hosted native commands keep enable iframe-only and omit filter on disable", () => {
  assert.deepEqual(autoAttach(), {
    autoAttach: true,
    flatten: true,
    waitForDebuggerOnStart: false,
    filter: [{ type: "iframe", exclude: false }, { exclude: true }],
  });
  assert.deepEqual(autoAttach(false), {
    autoAttach: false,
    flatten: true,
    waitForDebuggerOnStart: false,
  });
});
