import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  FixtureBridgeRelay,
  assertForegroundSample,
  assertProviderFixturePoint,
  expectedProviderDocuments,
  verifyProviderFrameOwners,
  assertNativeProviderPair,
  assertNativeProviderRoute,
  providerFixtureUrl,
} from "../scripts/chrome-extension-provider-smoke.mjs";
import { ZENX_CHROME_EXTENSION_ORIGIN } from "../src/main/chrome-extension-bridge.js";

class Socket extends EventEmitter {
  readyState = 0;
  sent = [];
  send(raw, options) {
    this.sent.push({ raw, options });
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}
function fixture() {
  const socket = new Socket();
  const upstream = new Socket();
  let connection;
  const relay = new FixtureBridgeRelay(
    socket,
    "ws://127.0.0.1:1234/native/disposable",
    (url, options) => {
      connection = { url, options };
      return upstream;
    },
  );
  return { socket, upstream, relay, connection };
}
const rootCommand = {
  type: "cdp-command",
  requestId: "root-enable",
  tabId: 7,
  rootSessionId: "owned-root",
  method: "Target.setAutoAttach",
  params: { autoAttach: true },
};
const attach = (sessionId, targetId, parentSessionId) => ({
  type: "cdp-event",
  tabId: 7,
  rootSessionId: "owned-root",
  sessionId: parentSessionId,
  method: "Target.attachedToTarget",
  params: {
    sessionId,
    targetInfo: {
      type: "iframe",
      targetId,
      url: "http://localhost:1234/remote-frame-child",
    },
  },
});
const pair = (sessionId, x = 100, y = 30) =>
  ["mousePressed", "mouseReleased"].map((type) => ({
    tabId: 7,
    rootSessionId: "owned-root",
    sessionId,
    method: "Input.dispatchMouseEvent",
    type,
    x,
    y,
  }));

test("native relay preserves both directions byte-for-byte and uses the production origin", () => {
  const f = fixture();
  assert.equal(
    f.connection.options.headers.origin,
    ZENX_CHROME_EXTENSION_ORIGIN,
  );
  const hello = Buffer.from('{ "type" : "hello", "protocolVersion" : 3 }');
  f.socket.emit("message", hello);
  assert.equal(f.upstream.sent.length, 0);
  f.upstream.readyState = 1;
  f.upstream.emit("open");
  assert.equal(f.upstream.sent[0].raw, hello);
  assert.deepEqual(f.upstream.sent[0].options, { binary: false });
  const ready = Buffer.from('{ "type" : "ready", "protocolVersion" : 3 }');
  f.upstream.emit("message", ready);
  assert.equal(f.socket.sent[0].raw, ready);
  f.relay.close();
});

test("relay refuses non-loopback descriptors, bounds startup bytes, and cannot resume after retirement", async () => {
  for (const url of [
    "ws://external.test/native/a",
    "wss://127.0.0.1/native/a",
    "ws://127.0.0.1/other/a",
    "ws://secret@127.0.0.1/native/a",
  ]) {
    assert.throws(
      () =>
        new FixtureBridgeRelay(new Socket(), url, () => {
          throw Error("Must not connect");
        }),
    );
  }
  const f = fixture();
  for (let i = 0; i < 65; i++)
    f.socket.emit("message", Buffer.from('{"type":"hello"}'));
  assert.ok(f.relay.failure);
  assert.equal(f.relay.closed, true);
  f.upstream.readyState = 1;
  f.upstream.emit("open");
  assert.equal(f.upstream.sent.length, 0);
  await assert.rejects(f.relay.command(7, "Runtime.evaluate"));
  assert.equal(f.socket.sent.length, 0);
});

test("relay records only real bridge input while diagnostic replies remain byte-preserving", async () => {
  const f = fixture();
  f.upstream.readyState = 1;
  f.upstream.emit("open");
  f.upstream.emit("message", Buffer.from(JSON.stringify(rootCommand)));
  f.socket.emit(
    "message",
    Buffer.from(JSON.stringify(attach("child", "frame"))),
  );
  f.upstream.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "cdp-command",
        requestId: "press",
        tabId: 7,
        rootSessionId: "owned-root",
        sessionId: "child",
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: 100, y: 30 },
      }),
    ),
  );
  assert.equal(f.relay.inputs.length, 1);
  const pending = f.relay.evaluate(7, "window.contract.state()");
  const command = JSON.parse(f.socket.sent.at(-1).raw);
  const response = Buffer.from(
    JSON.stringify({
      type: "cdp-result",
      requestId: command.requestId,
      result: { result: { value: { fixture: true } } },
    }),
  );
  f.socket.emit("message", response);
  assert.deepEqual(await pending, { fixture: true });
  assert.equal(f.upstream.sent.at(-1).raw, response);
  assert.equal(f.relay.inputs.length, 1);
  await assert.rejects(f.relay.command(7, "Input.dispatchMouseEvent"));
  f.relay.close();
});

test("passive owner replies and context retirement keep exact native request and route identity", () => {
  const f = fixture();
  f.relay.observeBridge({
    ...rootCommand,
    method: "DOM.getFrameOwner",
    requestId: "owner-request",
    params: { frameId: "child-frame" },
  });
  f.relay.observeExtension({
    type: "cdp-result",
    requestId: "unrelated",
    result: { backendNodeId: 999 },
  });
  assert.equal(f.relay.owners.size, 0);
  f.relay.observeExtension({
    type: "cdp-result",
    requestId: "owner-request",
    result: { backendNodeId: 101 },
  });
  assert.equal(f.relay.owners.get("7/root/child-frame"), 101);
  const context = {
    id: 5,
    uniqueId: "unique-5",
    auxData: { frameId: "child-frame", isDefault: true },
  };
  f.relay.observeExtension({
    type: "cdp-event",
    tabId: 7,
    sessionId: "child",
    method: "Runtime.executionContextCreated",
    params: { context },
  });
  assert.equal(f.relay.contexts.get("7/child").get(5), context);
  f.relay.observeExtension({
    type: "cdp-event",
    tabId: 7,
    sessionId: "other-child",
    method: "Runtime.executionContextsCleared",
    params: {},
  });
  assert.equal(f.relay.contexts.get("7/child").size, 1);
  f.relay.observeExtension({
    type: "cdp-event",
    tabId: 7,
    sessionId: "child",
    method: "Runtime.executionContextDestroyed",
    params: { executionContextId: 5 },
  });
  assert.equal(f.relay.contexts.get("7/child").size, 0);
  f.relay.close();
});

test("relay rejects replacement root ownership and cross-root native child input", () => {
  const f = fixture();
  f.relay.observeBridge(rootCommand);
  assert.throws(
    () =>
      f.relay.observeBridge({ ...rootCommand, rootSessionId: "other-root" }),
    /owner cannot change/,
  );
  f.relay.observeExtension(attach("child", "frame"));
  assert.throws(() =>
    f.relay.observeBridge({
      ...rootCommand,
      method: "Input.dispatchMouseEvent",
      sessionId: "child",
      rootSessionId: "other-root",
      params: { type: "mousePressed" },
    }),
  );
  assert.equal(f.relay.inputs.length, 0);
  f.relay.close();
});

test("native route assertions join exact frames, contexts and owners without assuming target identity", async () => {
  const f = fixture();
  f.relay.observeBridge(rootCommand);
  const rootUrl = "http://127.0.0.1:1234/input-contract?nonce=exact";
  const childUrl = "http://localhost:1234/remote-frame-child?nonce=exact";
  const leafUrl = "http://nested.localhost:1234/remote-frame-child?nonce=exact";
  f.relay.expectedDocuments.set(7, {
    root: rootUrl,
    child: childUrl,
    leaf: leafUrl,
  });
  const context = (session, frameId, id) => {
    const key = `7/${session ?? "root"}`;
    const values = f.relay.contexts.get(key) ?? new Map();
    values.set(id, {
      id,
      uniqueId: `unique-${id}`,
      auxData: { frameId, isDefault: true },
    });
    f.relay.contexts.set(key, values);
  };
  f.relay.trees.set("7/root", { frame: { id: "root-frame", url: rootUrl } });
  context(undefined, "root-frame", 1);
  f.relay.observeExtension(attach("child", "different-child-target"));
  f.relay.trees.set("7/child", {
    frame: { id: "child-frame", parentId: "root-frame", url: childUrl },
  });
  context("child", "child-frame", 2);
  f.relay.owners.set("7/root/child-frame", 101);
  const point = { localPoint: { x: 100, y: 30 } };
  assertNativeProviderPair(
    f.relay,
    7,
    "cross-origin-oopif",
    pair("child"),
    "click",
    point,
  );
  assert.throws(
    () =>
      assertNativeProviderPair(
        f.relay,
        7,
        "cross-origin-oopif",
        pair("child", 132, 66),
        "click",
        point,
      ),
    /renderer root/,
  );
  f.relay.trees.get("7/child").frame.url = childUrl.replace("exact", "wrong");
  assert.throws(() =>
    assertNativeProviderPair(
      f.relay,
      7,
      "cross-origin-oopif",
      pair("child"),
      "click",
      point,
    ),
  );
  f.relay.trees.get("7/child").frame.url = childUrl;
  f.relay.observeExtension(attach("leaf", "different-leaf-target", "child"));
  f.relay.trees.set("7/leaf", {
    frame: { id: "leaf-frame", parentId: "child-frame", url: leafUrl },
  });
  context("leaf", "leaf-frame", 3);
  f.relay.owners.set("7/child/leaf-frame", 102);
  const described = [];
  f.relay.command = async (tabId, method, params, sessionId) => {
    described.push({
      tabId,
      method,
      backendNodeId: params.backendNodeId,
      sessionId,
    });
    const child = params.backendNodeId === 101;
    return {
      node: {
        localName: "iframe",
        backendNodeId: params.backendNodeId,
        frameId: child ? "child-frame" : "leaf-frame",
        attributes: [
          "id",
          child ? "contract-frame" : "nested-contract-frame",
          "src",
          child ? childUrl : leafUrl,
        ],
      },
    };
  };
  assert.equal(
    await verifyProviderFrameOwners(f.relay, 7, "nested-oopif"),
    "leaf",
  );
  assert.deepEqual(
    described.map((entry) => entry.sessionId),
    [undefined, "child"],
  );
  const readOwner = f.relay.command;
  f.relay.command = async (...args) => {
    const result = await readOwner(...args);
    result.node.attributes[3] += "-forged";
    return result;
  };
  await assert.rejects(
    verifyProviderFrameOwners(f.relay, 7, "nested-oopif"),
    /nonce URL/,
  );
  f.relay.command = readOwner;
  assertNativeProviderPair(
    f.relay,
    7,
    "nested-oopif",
    pair("leaf"),
    "click",
    point,
  );
  assert.throws(() =>
    assertNativeProviderPair(
      f.relay,
      7,
      "nested-oopif",
      pair("child"),
      "click",
      point,
    ),
  );
  f.relay.owners.delete("7/child/leaf-frame");
  assert.throws(
    () =>
      assertNativeProviderPair(
        f.relay,
        7,
        "nested-oopif",
        pair("leaf"),
        "click",
        point,
      ),
    /parent owner/,
  );
  f.relay.owners.set("7/child/leaf-frame", 102);
  f.relay.routes.get("leaf").retired = true;
  const localUrl = "http://localhost:4321/remote-frame-child?nonce=exact";
  f.relay.expectedDocuments.get(7).leaf = localUrl;
  f.relay.trees.get("7/child").childFrames = [
    { frame: { id: "local-frame", parentId: "child-frame", url: localUrl } },
  ];
  context("child", "local-frame", 4);
  f.relay.owners.set("7/child/local-frame", 103);
  assertNativeProviderPair(
    f.relay,
    7,
    "nested-same-process",
    pair("child", 145, 85),
    "click",
    point,
  );
  assert.throws(
    () =>
      assertNativeProviderPair(
        f.relay,
        7,
        "nested-same-process",
        pair("child"),
        "click",
        point,
      ),
    /renderer root/,
  );
  assertNativeProviderRoute(
    f.relay,
    7,
    "nested-same-process",
    pair("child", 145, 85).slice(0, 1),
    "click",
    point,
  );
  const keys = ["keyDown", "keyUp"].map((type) => ({
    tabId: 7,
    rootSessionId: "owned-root",
    method: "Input.dispatchKeyEvent",
    type,
  }));
  assertNativeProviderPair(f.relay, 7, "nested-oopif", keys, "key");
  assert.throws(
    () =>
      assertNativeProviderPair(
        f.relay,
        7,
        "nested-oopif",
        keys.map((value) => ({ ...value, sessionId: "child" })),
        "key",
      ),
    /root/,
  );
  f.relay.close();
});

test("independent authored pointer oracle rejects missing owners, leaf or top-coordinate confusion", () => {
  const point = {
    localPoint: { x: 100, y: 30 },
    x: 132,
    y: 66,
    hitId: "canvas",
    childViewport: { width: 620, height: 480, scrollX: 0, scrollY: 0 },
    owners: [
      { id: "contract-frame", hitId: "contract-frame", scrollX: 0, scrollY: 0 },
    ],
  };
  assertProviderFixturePoint(point, "cross-origin-oopif");
  assert.throws(() =>
    assertProviderFixturePoint(
      { ...point, x: 100, y: 30 },
      "cross-origin-oopif",
    ),
  );
  assert.throws(() =>
    assertProviderFixturePoint({ ...point, owners: [] }, "cross-origin-oopif"),
  );
  const cosine = Math.cos(Math.PI / 12),
    sine = Math.sin(Math.PI / 12);
  const nested = {
    ...point,
    x: 422 + cosine * -165 - sine * -155,
    y: 346 + sine * -165 + cosine * -155,
    outerAffine: true,
    reflected: false,
    childViewport: { ...point.childViewport, width: 400, height: 300 },
    owners: [
      ...point.owners,
      {
        id: "nested-contract-frame",
        hitId: "nested-contract-frame",
        scrollX: 0,
        scrollY: 0,
      },
    ],
  };
  assertProviderFixturePoint(nested, "nested-same-process");
  assert.throws(() =>
    assertProviderFixturePoint(
      { ...nested, x: 145, y: 85 },
      "nested-same-process",
    ),
  );
});

test("native foreground samples retain exact owned HWND and PID without an activation fallback", () => {
  const initial = { pid: 123, hwnd: "456" };
  assert.deepEqual(assertForegroundSample(initial, 123), initial);
  assert.deepEqual(
    assertForegroundSample({ ...initial }, 123, initial),
    initial,
  );
  assert.throws(() =>
    assertForegroundSample({ pid: 124, hwnd: "456" }, 123, initial),
  );
  assert.throws(() =>
    assertForegroundSample({ pid: 123, hwnd: "457" }, 123, initial),
  );
  assert.throws(() => assertForegroundSample({ pid: 123, hwnd: "0" }, 123));
});

test("provider fixtures reuse nonce-bound loopback documents with affine mixed ancestry", () => {
  const mixed = providerFixtureUrl("nested-same-process", 1000, 2000);
  assert.equal(mixed.origin, "http://127.0.0.1:1000");
  assert.equal(mixed.searchParams.get("childOrigin"), "http://localhost:2000");
  assert.equal(mixed.searchParams.get("leafOrigin"), "http://localhost:1000");
  assert.equal(mixed.searchParams.get("outerAffine"), "true");
  const expected = expectedProviderDocuments(mixed.href);
  assert.equal(expected.root, mixed.href);
  assert.equal(
    new URL(expected.child).searchParams.get("nonce"),
    mixed.searchParams.get("nonce"),
  );
  assert.equal(
    new URL(expected.leaf).searchParams.get("nonce"),
    mixed.searchParams.get("nonce"),
  );
  assert.equal(
    new URL(expected.leaf).searchParams.get("parentOrigin"),
    mixed.searchParams.get("childOrigin"),
  );
  assert.match(mixed.searchParams.get("nonce"), /^[a-f0-9-]{36}$/);
  assert.equal(
    providerFixtureUrl("nested-oopif", 1000, 2000).searchParams.get(
      "leafOrigin",
    ),
    "http://nested.localhost:2000",
  );
});

test("provider acceptance uses actual bridge backend and native foreground samples, with explicit native-host gaps", async () => {
  const helper = await readFile(
    new URL("../scripts/chrome-extension-provider-smoke.mjs", import.meta.url),
    "utf8",
  );
  const entry = await readFile(
    new URL("../scripts/smoke-chrome-debugger-children.mjs", import.meta.url),
    "utf8",
  );
  assert.match(helper, /await bridge\.connectProvider\(\)/);
  assert.match(helper, /receipt.nativeOsForegroundObserved = true/);
  assert.match(helper, /GetForegroundWindow/);
  assert.doesNotMatch(
    helper,
    /SetForegroundWindow|SendInput|ShowWindow|ExecutionPolicy/,
  );
  assert.match(helper, /nativeMessaging: false/);
  assert.match(helper, /packagedNativeHost: false/);
  assert.match(helper, /await backend\.pointerClick/);
  assert.match(helper, /await backend\.keyPress/);
  assert.match(helper, /physical fixture tab removal/);
  assert.match(helper, /otherRootRemainsUsable = true/);
  assert.ok(
    entry.indexOf("next.socket.close()") <
      entry.indexOf("fresh production Native Port handshake with real bridge"),
  );
  assert.doesNotMatch(
    helper,
    /remote-debugging-port|Target\.attachToTarget|registerChromeNativeHost|reg\.exe|HKCU|HKEY/,
  );
});
