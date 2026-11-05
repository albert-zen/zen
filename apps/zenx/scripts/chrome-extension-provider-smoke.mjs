import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import WebSocket from "ws";
import {
  remoteFrameContractPage,
  remoteFrameFixtureFromUrl,
} from "../src/main/browser-remote-frame-smoke-fixture.js";
import { ZENX_CHROME_EXTENSION_ORIGIN } from "../src/main/chrome-extension-bridge.js";
import { BrowserInputOutcomeUnknownError } from "../src/main/capabilities/browser-targeted-input.js";
import { UserBrowserMutationOutcomeUnknownError } from "../src/main/capabilities/user-browser-provider.js";

const MAX_PENDING = 128;
const MAX_INPUTS = 64;
const MAX_ROUTES = 64;
const MAX_BYTES = 1024 * 1024;

export async function waitFor(read, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} exceeded its outcome deadline`);
}

/** The only substituted boundary is Native Messaging. Forward bytes, never CDP results. */
export class FixtureBridgeRelay {
  inputs = [];
  roots = new Map();
  routes = new Map();
  trees = new Map();
  tabs = new Set();
  pendingTrees = new Map();
  contexts = new Map();
  owners = new Map();
  expectedDocuments = new Map();
  diagnostics = new Map();
  failure;
  closed = false;
  constructor(
    socket,
    nativeUrl,
    connect = (url, options) => new WebSocket(url, options),
  ) {
    const url = new URL(nativeUrl);
    assert.equal(url.protocol, "ws:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.username + url.password + url.search + url.hash, "");
    assert.match(url.pathname, /^\/native\/[a-zA-Z0-9_-]+$/);
    this.socket = socket;
    this.upstream = connect(nativeUrl, {
      headers: { origin: ZENX_CHROME_EXTENSION_ORIGIN },
      handshakeTimeout: 5000,
      maxPayload: MAX_BYTES,
    });
    const queue = [];
    let queuedBytes = 0;
    const forward = (target, raw) => target.send(raw, { binary: false });
    this.upstream.on("open", () => {
      if (this.closed) return;
      for (const raw of queue.splice(0)) forward(this.upstream, raw);
      queuedBytes = 0;
    });
    socket.on("message", (raw) => {
      if (this.closed) return;
      try {
        assert.ok(raw.length <= MAX_BYTES);
        this.observeExtension(JSON.parse(String(raw)));
        if (this.upstream.readyState === WebSocket.OPEN)
          forward(this.upstream, raw);
        else {
          assert.ok(queue.length < 64 && queuedBytes + raw.length <= MAX_BYTES);
          queue.push(raw);
          queuedBytes += raw.length;
        }
      } catch (error) {
        this.fail(error);
      }
    });
    this.upstream.on("message", (raw) => {
      if (this.closed) return;
      try {
        assert.ok(raw.length <= MAX_BYTES);
        this.observeBridge(JSON.parse(String(raw)));
        forward(socket, raw);
      } catch (error) {
        this.fail(error);
      }
    });
    for (const source of [socket, this.upstream]) {
      source.on("error", (error) => this.fail(error));
      source.on("close", () => this.close());
    }
  }
  assertOpen() {
    if (this.failure) throw this.failure;
    assert.ok(!this.closed, "Synthetic native relay has retired");
  }
  fail(error) {
    this.failure ??= error;
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.diagnostics.values())
      pending.reject(new Error("Synthetic native relay retired"));
    this.diagnostics.clear();
    this.socket.close();
    this.upstream.close();
  }
  observeBridge(message) {
    if (message.type !== "cdp-command") return;
    const { tabId, rootSessionId, sessionId, method, params } = message;
    if (
      method === "Target.setAutoAttach" &&
      sessionId === undefined &&
      params.autoAttach
    ) {
      assert.ok(this.roots.size < MAX_ROUTES || this.roots.has(tabId));
      const old = this.roots.get(tabId);
      assert.ok(
        old === undefined || old === rootSessionId,
        "Physical root owner cannot change",
      );
      this.roots.set(tabId, rootSessionId);
    }
    if (["Page.getFrameTree", "DOM.getFrameOwner"].includes(method)) {
      assert.ok(this.pendingTrees.size < MAX_PENDING);
      this.pendingTrees.set(message.requestId, {
        tabId,
        sessionId,
        method,
        frameId: params.frameId,
      });
    }
    if (method.startsWith("Input.")) {
      assert.ok(this.inputs.length < MAX_INPUTS);
      const root = this.roots.get(tabId);
      assert.ok(root, "Provider input must follow an exact admitted root");
      if (sessionId !== undefined) {
        const route = this.routes.get(sessionId);
        assert.ok(
          route &&
            !route.retired &&
            route.tabId === tabId &&
            route.rootSessionId === root,
        );
        assert.equal(rootSessionId, root);
      }
      this.inputs.push({
        tabId,
        rootSessionId: root,
        sessionId,
        method,
        type: params.type,
        x: params.x,
        y: params.y,
      });
    }
  }
  observeExtension(message) {
    if (message.type === "browser-connected")
      for (const tab of message.tabs) this.tabs.add(tab.id);
    if (message.type === "tab-updated") this.tabs.add(message.tab.id);
    if (message.type === "tab-removed") this.tabs.delete(message.tabId);
    if (message.type === "cdp-result") {
      const tree = this.pendingTrees.get(message.requestId);
      if (tree) {
        this.pendingTrees.delete(message.requestId);
        if (
          tree.method === "DOM.getFrameOwner" &&
          message.result?.backendNodeId
        ) {
          assert.ok(
            this.owners.size < MAX_ROUTES ||
              this.owners.has(
                `${tree.tabId}/${tree.sessionId ?? "root"}/${tree.frameId}`,
              ),
          );
          this.owners.set(
            `${tree.tabId}/${tree.sessionId ?? "root"}/${tree.frameId}`,
            message.result.backendNodeId,
          );
        }
        if (message.result?.frameTree)
          this.trees.set(
            `${tree.tabId}/${tree.sessionId ?? "root"}`,
            message.result.frameTree,
          );
      }
      const diagnostic = this.diagnostics.get(message.requestId);
      if (diagnostic) {
        this.diagnostics.delete(message.requestId);
        if (message.error) diagnostic.reject(new Error(message.error.message));
        else diagnostic.resolve(message.result);
      }
    }
    if (message.type !== "cdp-event") return;
    const contextKey = `${message.tabId}/${message.sessionId ?? "root"}`;
    if (message.method === "Runtime.executionContextsCleared")
      this.contexts.delete(contextKey);
    if (message.method === "Runtime.executionContextDestroyed")
      this.contexts.get(contextKey)?.delete(message.params.executionContextId);
    if (
      message.method === "Runtime.executionContextCreated" &&
      message.params.context?.auxData?.isDefault
    ) {
      assert.ok(
        this.contexts.size < MAX_ROUTES || this.contexts.has(contextKey),
      );
      const contexts = this.contexts.get(contextKey) ?? new Map();
      assert.ok(contexts.size < MAX_ROUTES);
      contexts.set(message.params.context.id, message.params.context);
      this.contexts.set(contextKey, contexts);
    }
    if (message.method === "Target.attachedToTarget") {
      assert.equal(message.params.targetInfo.type, "iframe");
      assert.ok(this.routes.size < MAX_ROUTES);
      assert.ok(
        !this.routes.has(message.params.sessionId),
        "Native child IDs cannot be reused",
      );
      this.routes.set(message.params.sessionId, {
        tabId: message.tabId,
        rootSessionId: message.rootSessionId,
        parentSessionId: message.sessionId,
        targetId: message.params.targetInfo.targetId,
        url: message.params.targetInfo.url,
        retired: false,
      });
    }
    if (message.method === "Target.detachedFromTarget") {
      const retired = this.routes.get(message.params.sessionId);
      if (retired) retired.retired = true;
    }
  }
  /** Exact fixture-only reads/setup and physical closure, excluded from provider input evidence. */
  async command(tabId, method, params = {}, sessionId) {
    this.assertOpen();
    assert.ok(
      ["Runtime.evaluate", "DOM.describeNode", "Target.closeTarget"].includes(
        method,
      ),
    );
    assert.ok(this.diagnostics.size < MAX_PENDING);
    if (sessionId !== undefined) {
      const route = this.routes.get(sessionId);
      assert.ok(route && !route.retired && route.tabId === tabId);
      assert.equal(
        method,
        "DOM.describeNode",
        "Only owner identity reads may use a child diagnostic route",
      );
    }
    const requestId = randomUUID();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.diagnostics.delete(requestId);
        reject(new Error(`Fixture ${method} timed out; never replay`));
      }, 10_000);
      this.diagnostics.set(requestId, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(
        JSON.stringify({
          type: "cdp-command",
          requestId,
          tabId,
          method,
          params,
          ...(sessionId === undefined
            ? {}
            : { sessionId, rootSessionId: this.roots.get(tabId) }),
        }),
      );
    });
  }
  async evaluate(tabId, expression) {
    const result = await this.command(tabId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(
      result.exceptionDetails,
      undefined,
      "Fixture evaluation must complete",
    );
    return result.result?.value;
  }
}

export function serveProviderFixture(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  if (!["/input-contract", "/remote-frame-child"].includes(url.pathname))
    return false;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("Origin-Agent-Cluster", "?0");
  try {
    response.end(
      remoteFrameContractPage(
        url.pathname === "/input-contract" ? "parent" : "child",
        remoteFrameFixtureFromUrl(request.url),
      ),
    );
  } catch {
    response.writeHead(400).end("Invalid disposable fixture");
  }
  return true;
}

export function providerFixtureUrl(mode, rootPort, remotePort) {
  const url = new URL(`http://127.0.0.1:${rootPort}/input-contract`);
  const values = {
    mode,
    parentOrigin: url.origin,
    childOrigin: `http://localhost:${remotePort}`,
    nonce: randomUUID(),
  };
  if (mode.startsWith("nested-")) {
    values.outerAffine = "true";
    values.leafOrigin =
      mode === "nested-oopif"
        ? `http://nested.localhost:${remotePort}`
        : `http://localhost:${rootPort}`;
  }
  for (const [key, value] of Object.entries(values))
    url.searchParams.set(key, value);
  return url;
}

export function assertProviderFixturePoint(point, mode) {
  assert.deepEqual(point.localPoint, { x: 100, y: 30 });
  assert.equal(point.hitId, "canvas");
  const nested = mode.startsWith("nested-");
  assert.deepEqual(
    point.owners.map((owner) => owner.id),
    nested ? ["contract-frame", "nested-contract-frame"] : ["contract-frame"],
  );
  for (const owner of point.owners) {
    assert.equal(owner.hitId, owner.id);
    assert.equal(owner.scrollX, 0);
    assert.equal(owner.scrollY, 0);
  }
  assert.equal(point.childViewport.width, nested ? 400 : 620);
  assert.equal(point.childViewport.height, nested ? 300 : 480);
  assert.equal(point.childViewport.scrollX, 0);
  assert.equal(point.childViewport.scrollY, 0);
  // Independent authored forward transform, never provider geometry or AABBs.
  const cosine = Math.cos(Math.PI / 12),
    sine = Math.sin(Math.PI / 12);
  const expected = nested
    ? {
        x: 422 + cosine * (145 + 12 - 322) - sine * (85 + 16 - 256),
        y: 346 + sine * (145 + 12 - 322) + cosine * (85 + 16 - 256),
      }
    : { x: 132, y: 66 };
  if (nested) {
    assert.equal(point.outerAffine, true);
    assert.equal(point.reflected, false);
  }
  assert.ok(
    Math.abs(point.x - expected.x) < 0.01 &&
      Math.abs(point.y - expected.y) < 0.01,
    "Authored top point must preserve every owner offset and affine transform",
  );
}

export function expectedProviderDocuments(rootUrl) {
  const config = remoteFrameFixtureFromUrl(rootUrl);
  const child = new URL("/remote-frame-child", config.childOrigin);
  for (const [key, value] of Object.entries(config))
    child.searchParams.set(key, value);
  let leaf;
  if (config.leafOrigin) {
    leaf = new URL("/remote-frame-child", config.leafOrigin);
    for (const [key, value] of Object.entries({
      ...config,
      parentOrigin: config.childOrigin,
      childOrigin: config.leafOrigin,
      leafOrigin: "",
    }))
      leaf.searchParams.set(key, value);
  }
  return { root: String(rootUrl), child: child.href, leaf: leaf?.href };
}

function assertFrameContext(relay, tabId, sessionId, frame) {
  const contexts = [
    ...(relay.contexts.get(`${tabId}/${sessionId ?? "root"}`)?.values() ?? []),
  ].filter((context) => context.auxData.frameId === frame.id);
  assert.equal(
    contexts.length,
    1,
    "Frame must have one current default context on its exact native route",
  );
  assert.ok(
    typeof contexts[0].uniqueId === "string" && contexts[0].uniqueId.length > 0,
  );
}

function providerFrameChain(relay, tabId, mode, sessionId) {
  const expected = relay.expectedDocuments.get(tabId);
  assert.ok(expected, "Exact nonce-bound fixture URLs are required");
  const root = relay.trees.get(`${tabId}/root`)?.frame;
  assert.equal(root?.url, expected.root);
  assertFrameContext(relay, tabId, undefined, root);
  const selectedRoute = relay.routes.get(sessionId);
  assert.ok(
    selectedRoute && !selectedRoute.retired && selectedRoute.tabId === tabId,
  );
  assert.equal(selectedRoute.rootSessionId, relay.roots.get(tabId));
  const childSession =
    mode === "nested-oopif" ? selectedRoute.parentSessionId : sessionId;
  const childRoute = relay.routes.get(childSession);
  assert.ok(childRoute && !childRoute.retired && childRoute.tabId === tabId);
  assert.equal(childRoute.parentSessionId, undefined);
  assert.equal(childRoute.rootSessionId, relay.roots.get(tabId));
  const childTree = relay.trees.get(`${tabId}/${childSession}`);
  assert.equal(childTree?.frame.url, expected.child);
  assertFrameContext(relay, tabId, childSession, childTree.frame);
  const chain = [
    {
      parentSession: undefined,
      parent: root,
      frame: childTree.frame,
      ownerId: "contract-frame",
      url: expected.child,
    },
  ];
  if (mode.startsWith("nested-")) {
    const leafSession = mode === "nested-oopif" ? sessionId : childSession;
    const leaf =
      mode === "nested-oopif"
        ? relay.trees.get(`${tabId}/${leafSession}`)?.frame
        : childTree.childFrames?.[0]?.frame;
    assert.equal(leaf?.url, expected.leaf);
    assertFrameContext(relay, tabId, leafSession, leaf);
    if (mode === "nested-same-process") {
      assert.equal(childTree.childFrames.length, 1);
      for (const [key, contexts] of relay.contexts)
        if (key.startsWith(`${tabId}/`) && key !== `${tabId}/${childSession}`)
          assert.ok(
            ![...contexts.values()].some(
              (context) => context.auxData.frameId === leaf.id,
            ),
            "Mixed leaf cannot belong to a different renderer route",
          );
    }
    chain.push({
      parentSession: childSession,
      parent: childTree.frame,
      frame: leaf,
      ownerId: "nested-contract-frame",
      url: expected.leaf,
    });
  }
  for (const entry of chain) {
    if (entry.frame.parentId !== undefined)
      assert.equal(entry.frame.parentId, entry.parent.id);
    const owner = relay.owners.get(
      `${tabId}/${entry.parentSession ?? "root"}/${entry.frame.id}`,
    );
    assert.ok(
      Number.isSafeInteger(owner) && owner > 0,
      "Native frame must join its exact parent owner, never targetId",
    );
    entry.backendNodeId = owner;
  }
  return chain;
}

export async function verifyProviderFrameOwners(relay, tabId, mode) {
  const expected = relay.expectedDocuments.get(tabId);
  const rendererUrl = mode === "nested-oopif" ? expected.leaf : expected.child;
  const candidates = [...relay.routes].filter(
    ([sessionId, route]) =>
      !route.retired &&
      route.tabId === tabId &&
      relay.trees.get(`${tabId}/${sessionId}`)?.frame.url === rendererUrl,
  );
  assert.equal(
    candidates.length,
    1,
    "One exact nonce-bound renderer must own the point",
  );
  const sessionId = candidates[0][0];
  for (const entry of providerFrameChain(relay, tabId, mode, sessionId)) {
    const { node } = await relay.command(
      tabId,
      "DOM.describeNode",
      { backendNodeId: entry.backendNodeId, depth: 0 },
      entry.parentSession,
    );
    assert.equal(node.localName, "iframe");
    assert.equal(node.backendNodeId, entry.backendNodeId);
    if (node.frameId !== undefined) assert.equal(node.frameId, entry.frame.id);
    const attributes = new Map();
    for (let i = 0; i < node.attributes.length; i += 2)
      attributes.set(node.attributes[i], node.attributes[i + 1]);
    assert.equal(attributes.get("id"), entry.ownerId);
    assert.equal(
      attributes.get("src"),
      entry.url,
      "Native owner must identify the complete authored nonce URL",
    );
  }
  return sessionId;
}

export function assertNativeProviderRoute(
  relay,
  tabId,
  mode,
  inputs,
  kind,
  point,
) {
  const root = relay.roots.get(tabId);
  for (const input of inputs) {
    assert.equal(input.tabId, tabId);
    assert.equal(input.rootSessionId, root);
    assert.equal(
      input.method,
      kind === "click" ? "Input.dispatchMouseEvent" : "Input.dispatchKeyEvent",
    );
    if (kind === "key")
      assert.equal(
        input.sessionId,
        undefined,
        "Keys stay on the native tab root",
      );
    else {
      providerFrameChain(relay, tabId, mode, input.sessionId);
      const expected =
        mode === "nested-same-process"
          ? { x: point.localPoint.x + 45, y: point.localPoint.y + 55 }
          : point.localPoint;
      assert.ok(
        Math.abs(input.x - expected.x) < 0.01 &&
          Math.abs(input.y - expected.y) < 0.01,
        "Input must use the selected renderer root, not top-level or leaf coordinates",
      );
    }
  }
}

export function assertNativeProviderPair(
  relay,
  tabId,
  mode,
  pair,
  kind,
  point,
) {
  assert.equal(
    pair.length,
    2,
    "Only the exact provider input pair may dispatch",
  );
  assert.deepEqual(
    pair.map((input) => input.type),
    kind === "click" ? ["mousePressed", "mouseReleased"] : ["keyDown", "keyUp"],
  );
  assertNativeProviderRoute(relay, tabId, mode, pair, kind, point);
  assert.equal(pair[0].sessionId, pair[1].sessionId);
}

// Same read-only Win32 observation used by the existing native input fixture.
// No activation, input injection, registration, permissions or persistent helper.
const foregroundScript = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ForegroundWitness {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
$window = [ForegroundWitness]::GetForegroundWindow()
[uint32]$owner = 0
[void][ForegroundWitness]::GetWindowThreadProcessId($window, [ref]$owner)
@{pid=$owner;hwnd=$window.ToInt64().ToString()} | ConvertTo-Json -Compress`;
export async function readWin32Foreground() {
  assert.equal(process.platform, "win32");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const { stdout } = await promisify(execFile)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", foregroundScript],
    { windowsHide: true, timeout: 5000, maxBuffer: 4096 },
  );
  return JSON.parse(stdout.trim());
}
export function assertForegroundSample(sample, browserPid, previous) {
  assert.equal(
    sample.pid,
    browserPid,
    "Native foreground must remain the owned Chromium process",
  );
  assert.match(sample.hwnd, /^[1-9][0-9]*$/);
  if (previous)
    assert.deepEqual(
      sample,
      previous,
      "Native foreground HWND/PID must stay unchanged",
    );
  return sample;
}

const sentinelExpression = `({visible:document.visibilityState,focused:document.hasFocus(),active:document.activeElement?.id,value:document.querySelector('#provider-sentinel')?.value,events:[...globalThis.providerSentinelEvents]})`;
export const prepareSentinelExpression = `(()=>{document.body.innerHTML='<input id="provider-sentinel" value="owned-visible-sentinel">';const input=document.querySelector('#provider-sentinel');input.focus({preventScroll:true});globalThis.providerSentinelEvents=[];for(const type of ['input','keydown','keyup','pointerdown','pointerup','blur','visibilitychange'])window.addEventListener(type,event=>providerSentinelEvents.push(event.type),true);return ${sentinelExpression}})()`;

/** Actual backend -> bridge -> unchanged worker -> real debugger. No raw-CDP input route. */
export async function runExtensionProviderAcceptance({
  bridge,
  relay,
  sentinelTabId,
  rootPort,
  browserPid,
  setPhase,
  oldNativeSessions,
  publishReceipt,
}) {
  const remote = createServer((request, response) => {
    if (!serveProviderFixture(request, response)) response.writeHead(404).end();
  });
  let backend;
  const owned = new Map();
  const reports = [];
  const session = `extension-provider-${randomUUID()}`;
  const receipt = {
    transport:
      "UserBrowserCdpBackend -> ChromeExtensionBridge -> synthetic Native Port -> unchanged service worker -> real chrome.debugger",
    nativeMessaging: false,
    packagedNativeHost: false,
    nativeOsForegroundObserved: false,
    foregroundEvidence:
      "Win32 HWND/PID sampled around actions, plus separate visible fixture DOM focus/value/event history; no continuous native sampler",
    nativeForegroundSamples: 0,
    outcome: "running",
    scenarios: reports,
  };
  publishReceipt?.(receipt);
  let failure;
  let healthy;
  let nativeWindow;
  const guard = async (native = false) => {
    if (native) {
      nativeWindow = assertForegroundSample(
        await readWin32Foreground(),
        browserPid,
        nativeWindow,
      );
      receipt.nativeOsForegroundObserved = true;
      receipt.nativeForegroundSamples++;
    }
    relay.assertOpen();
    assert.deepEqual(
      await relay.evaluate(sentinelTabId, sentinelExpression),
      {
        visible: "visible",
        focused: true,
        active: "provider-sentinel",
        value: "owned-visible-sentinel",
        events: [],
      },
      "The separate visible fixture must remain untouched",
    );
  };
  try {
    await new Promise((resolve, reject) => {
      remote.once("error", reject);
      remote.listen(0, "127.0.0.1", resolve);
    });
    backend = (await bridge.connectProvider()).backend;
    assert.ok(backend.pointerClick && backend.keyPress);
    await guard(true);
    const open = async (mode) => {
      const url = providerFixtureUrl(mode, rootPort, remote.address().port);
      const tab = await backend.open(session, url.href);
      const match = /^chrome-tab-(\d+)$/.exec(tab.tabId);
      assert.ok(match, "Bridge must return its actual Chrome tab identity");
      const tabId = Number(match[1]);
      owned.set(tabId, tab.tabId);
      relay.expectedDocuments.set(tabId, expectedProviderDocuments(url.href));
      await waitFor(
        () => relay.evaluate(tabId, `window.contract?.ready === true`),
        "real fixture document readiness",
      );
      return {
        tab,
        tabId,
        url,
        read: (expression) => relay.evaluate(tabId, expression),
      };
    };
    const inspect = async (tab) =>
      await waitFor(async () => {
        const count = relay.inputs.length;
        const observation = await backend.inspect(session, tab.tabId);
        assert.equal(observation.screenshot.status, "captured");
        assert.equal(
          relay.inputs.length,
          count,
          "Read-only frame discovery must not dispatch input",
        );
        await guard();
        return observation.inputViewport ? observation : undefined;
      }, "coherent provider frame capture (read-only)");
    const settle = async (read, before, kind, id) =>
      await waitFor(async () => {
        const after = await read("window.contract.state()");
        assert.equal(
          after.documentId,
          before.documentId,
          "Successful input must stay in the captured fixture document",
        );
        assert.deepEqual(
          after.events.slice(0, before.events.length),
          before.events,
        );
        const events = after.events.slice(before.events.length);
        const expected = (
          kind === "click" ? ["pointerdown", "pointerup"] : ["keydown", "keyup"]
        ).map((type) => ({ type, trusted: true, target: id }));
        assert.deepEqual(events, expected.slice(0, events.length));
        assert.ok(events.length <= 2);
        assert.equal(after.visibility, "hidden");
        assert.equal(after.childVisibility, "hidden");
        assert.deepEqual(after.rootEvents, before.rootEvents);
        await guard();
        if (
          events.length !== 2 ||
          (kind === "click" && after.clicks !== before.clicks + 1) ||
          (kind === "key" && after.values[id] !== before.values[id] + " ")
        )
          return;
        return after;
      }, "already-issued trusted pair and exact effect");
    for (const mode of [
      "cross-origin-oopif",
      "nested-oopif",
      "nested-same-process",
    ]) {
      setPhase(`provider:${mode}`);
      const { tab, tabId, read } = await open(mode);
      healthy ??= { tab, tabId, read };
      const cases = [];
      for (const kind of ["click", "key"]) {
        const id = kind === "click" ? "canvas" : "text-a";
        if (kind === "key")
          assert.equal(
            (await read("window.contract.focus('text-a')")).inner,
            id,
          );
        const position =
          kind === "click"
            ? await read("window.contract.point('canvas')")
            : undefined;
        if (position) assertProviderFixturePoint(position, mode);
        setPhase(`provider:${mode}:${kind}:capture`);
        const observed = await inspect(tab);
        const verifiedNativeSession =
          kind === "click"
            ? await verifyProviderFrameOwners(relay, tabId, mode)
            : undefined;
        const before = await read("window.contract.state()");
        assert.equal(before.visibility, "hidden");
        assert.equal(before.childVisibility, "hidden");
        const start = relay.inputs.length;
        await guard(true);
        setPhase(`provider:${mode}:${kind}:dispatch`);
        if (kind === "click")
          await backend.pointerClick(
            session,
            tab.tabId,
            observed.observationId,
            position.x,
            position.y,
          );
        else
          await backend.keyPress(
            session,
            tab.tabId,
            observed.observationId,
            "Space",
          );
        const pair = relay.inputs.slice(start);
        if (kind === "click")
          assert.ok(
            pair.every((input) => input.sessionId === verifiedNativeSession),
            "Both native events must use the pre-dispatch verified renderer",
          );
        assertNativeProviderPair(relay, tabId, mode, pair, kind, position);
        assert.ok(
          pair.every((input) => !oldNativeSessions.has(input.sessionId)),
          "Provider must use fresh native child routes",
        );
        setPhase(`provider:${mode}:${kind}:effect`);
        await settle(read, before, kind, id);
        await guard(true);
        cases.push({
          kind,
          trustedPairAndEffect: true,
          nativeRoute:
            kind === "key"
              ? "root"
              : mode === "nested-same-process"
                ? "remote-parent-renderer"
                : "remote-leaf-renderer",
          rendererPoint:
            pair[0].x === undefined
              ? undefined
              : { x: pair[0].x, y: pair[0].y },
        });
      }
      await read("window.contract.focus('text-a')");
      const stale = await inspect(tab);
      await read("window.contract.focus('text-b')");
      const beforeStale = await read("window.contract.state()");
      const count = relay.inputs.length;
      await guard(true);
      await assert.rejects(
        backend.keyPress(session, tab.tabId, stale.observationId, "Space"),
        /changed|stale|inspect again/i,
      );
      assert.equal(relay.inputs.length, count);
      assert.deepEqual(
        (await read("window.contract.state()")).events,
        beforeStale.events,
      );
      await guard(true);
      reports.push({
        mode,
        status: "passed",
        hidden: true,
        affine: mode.startsWith("nested-"),
        staleInputDispatches: 0,
        cases,
      });
    }
    setPhase("provider:isolated-held-input-quarantine");
    const { tab, tabId, read } = await open("nested-oopif");
    await inspect(tab);
    const before = await read("window.contract.state()");
    assert.equal(before.visibility, "hidden");
    assert.equal(before.childVisibility, "hidden");
    const point = await read("window.contract.point('canvas')");
    assertProviderFixturePoint(point, "nested-oopif");
    assert.deepEqual(await read("window.contract.armReplace()"), {
      armed: true,
    });
    const observed = await inspect(tab);
    const interruptedNativeSession = await verifyProviderFrameOwners(
      relay,
      tabId,
      "nested-oopif",
    );
    const start = relay.inputs.length;
    await guard(true);
    await assert.rejects(
      backend.pointerClick(
        session,
        tab.tabId,
        observed.observationId,
        point.x,
        point.y,
      ),
      (error) => {
        const rawUnknown =
          error instanceof UserBrowserMutationOutcomeUnknownError &&
          error.message.startsWith(
            "Browser targeted input outcome is unknown (",
          );
        assert.ok(
          error instanceof BrowserInputOutcomeUnknownError || rawUnknown,
        );
        if (error instanceof BrowserInputOutcomeUnknownError)
          assert.equal(error.inputMayRemainPressed, true);
        return true;
      },
    );
    const dispatched = relay.inputs.slice(start);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, "mousePressed");
    assert.equal(dispatched[0].tabId, tabId);
    assert.equal(dispatched[0].rootSessionId, relay.roots.get(tabId));
    assert.equal(dispatched[0].sessionId, interruptedNativeSession);
    assert.ok(
      Math.abs(dispatched[0].x - point.localPoint.x) < 0.01 &&
        Math.abs(dispatched[0].y - point.localPoint.y) < 0.01,
    );
    await guard(true);
    const after = await read("window.contract.state()");
    assert.notEqual(after.documentId, before.documentId);
    assert.deepEqual(
      after.events.slice(0, before.events.length),
      before.events,
    );
    assert.deepEqual(after.events.slice(before.events.length), [
      { type: "pointerdown", trusted: true, target: "canvas" },
    ]);
    assert.equal(after.clicks, before.clicks);
    assert.equal(after.visibility, "hidden");
    assert.equal(after.childVisibility, "hidden");
    assert.deepEqual(after.rootEvents, before.rootEvents);
    const fresh = await backend.inspect(session, tab.tabId);
    assert.equal(fresh.screenshot.status, "captured");
    assert.equal(fresh.inputViewport, undefined);
    await guard(true);
    await assert.rejects(
      backend.keyPress(session, tab.tabId, fresh.observationId, "Space"),
      /blocked|held|pressed|close.*tab/i,
    );
    assert.equal(
      relay.inputs.length,
      start + 1,
      "Quarantine must not replay or release on a successor document",
    );
    assert.deepEqual(
      (await read("window.contract.state()")).events,
      after.events,
    );
    await guard(true);
    reports.push({
      mode: "nested-oopif-document-open-after-press",
      status: "passed",
      pressDispatches: 1,
      releaseDispatches: 0,
      rootQuarantined: true,
    });
    setPhase("provider:other-root-still-usable");
    await healthy.read("window.contract.focus('text-a')");
    const healthyCapture = await inspect(healthy.tab);
    const healthyBefore = await healthy.read("window.contract.state()");
    const healthyStart = relay.inputs.length;
    await guard(true);
    await backend.keyPress(
      session,
      healthy.tab.tabId,
      healthyCapture.observationId,
      "Space",
    );
    assertNativeProviderPair(
      relay,
      healthy.tabId,
      "cross-origin-oopif",
      relay.inputs.slice(healthyStart),
      "key",
    );
    await settle(healthy.read, healthyBefore, "key", "text-a");
    await guard(true);
    receipt.otherRootRemainsUsable = true;
    receipt.outcome = "passed";
    return receipt;
  } catch (error) {
    failure = error;
    receipt.outcome = "failed";
    receipt.error = String(error.message ?? error).slice(0, 512);
    receipt.providerNativeInputCount = relay.inputs.length;
    throw error;
  } finally {
    const failures = [];
    for (const [tabId, providerTabId] of owned) {
      try {
        await backend.closeTab(session, providerTabId);
      } catch (error) {
        failures.push(error);
      }
      // Logical detach is not physical closure. This exact tab was created by this connection.
      try {
        assert.deepEqual(await relay.command(tabId, "Target.closeTarget"), {
          success: true,
        });
        await waitFor(
          () => !relay.tabs.has(tabId),
          "physical fixture tab removal",
        );
        owned.delete(tabId);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await backend?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await guard(true);
    } catch (error) {
      failures.push(error);
    }
    await new Promise((resolve) => {
      remote.closeAllConnections();
      remote.close(resolve);
    });
    receipt.physicalTabsClosed = owned.size === 0;
    receipt.cleanupCompleted = failures.length === 0;
    if (failures.length) {
      receipt.outcome = "failed";
      receipt.cleanupError = String(failures[0].message ?? failures[0]).slice(
        0,
        256,
      );
      if (!failure) throw failures[0];
    }
  }
}
