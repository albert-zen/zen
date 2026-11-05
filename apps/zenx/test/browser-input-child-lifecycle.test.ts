import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { register } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import {
  ChromeExtensionBridge,
  ZENX_CHROME_EXTENSION_ORIGIN,
} from "../src/main/chrome-extension-bridge.js";
import {
  browserInputLifecycleEventInvalidates,
  ElectronBrowserBackend,
  type ZenXBrowserBackend,
} from "../src/main/capabilities/browser-provider.js";
import { connectUserBrowserCdp } from "../src/main/capabilities/user-browser-provider.js";
import { WorkspaceBrowser } from "../src/main/workspace-browser.js";
import {
  createFakeCdpServer,
  fakeBrowserInputSnapshot,
  fakeInputScreenshotData,
  waitUntil,
} from "./fixtures/user-browser-cdp.js";

interface Command {
  method: string;
  params: Record<string, unknown>;
}
interface LifecycleEvent {
  method: string;
  params: Record<string, unknown>;
}
const childEvents: LifecycleEvent[] = [
  {
    method: "Page.frameStartedNavigating",
    params: { frameId: "child", navigationType: "differentDocument" },
  },
  { method: "Page.frameStartedLoading", params: { frameId: "child" } },
  {
    method: "Page.documentOpened",
    params: {
      frame: {
        id: "child",
        parentId: "main",
        loaderId: "child-loader",
        url: "https://example.test/child",
      },
    },
  },
  {
    method: "Page.frameNavigated",
    params: {
      frame: { id: "child", parentId: "main", loaderId: "new-child-loader" },
    },
  },
  {
    method: "Page.frameDetached",
    params: { frameId: "child", reason: "remove" },
  },
  {
    method: "Page.navigatedWithinDocument",
    params: { frameId: "child", url: "https://example.test/child#new" },
  },
  {
    method: "Runtime.executionContextCreated",
    params: {
      context: {
        id: 250,
        uniqueId: "new-child-context",
        auxData: { isDefault: true, frameId: "child" },
      },
    },
  },
  {
    method: "Runtime.executionContextDestroyed",
    params: { executionContextId: 249 },
  },
  {
    method: "Runtime.executionContextDestroyed",
    params: { executionContextUniqueId: "old-child-context" },
  },
];

test("input-only lifecycle classification excludes observer-world preparation and ordinary events", () => {
  for (const event of childEvents)
    assert.equal(
      browserInputLifecycleEventInvalidates(event.method, event.params),
      true,
    );
  assert.equal(
    browserInputLifecycleEventInvalidates("Runtime.executionContextsCleared"),
    true,
  );
  assert.equal(
    browserInputLifecycleEventInvalidates("Runtime.executionContextCreated", {
      context: { auxData: { isDefault: false } },
    }),
    false,
  );
  assert.equal(
    browserInputLifecycleEventInvalidates("Page.screencastFrame"),
    false,
  );
  assert.equal(
    browserInputLifecycleEventInvalidates("Runtime.consoleAPICalled"),
    false,
  );
});

interface Fixture {
  backend: ZenXBrowserBackend;
  tabId: string;
  commands(): Command[];
  hook(
    callback?: (
      command: Command,
      emit: (event: LifecycleEvent) => void,
    ) => void,
  ): void;
  updateTabUrl?(url: string): Promise<void>;
  close(): Promise<void>;
}

async function attachedFixture(): Promise<Fixture> {
  const cdp = await createFakeCdpServer({ targetedInput: true });
  const { backend } = await connectUserBrowserCdp(cdp.endpoint);
  await backend.listTabs("work");
  return {
    backend,
    tabId: "target-1",
    commands: () => cdp.commandRequests(),
    hook(callback) {
      cdp.interceptRequests(
        callback
          ? (command, emit) =>
              callback(command, (event) =>
                emit({ ...event, sessionId: command.sessionId }),
              )
          : undefined,
      );
    },
    async close() {
      await Promise.resolve(backend.close()).catch(() => undefined);
      await cdp.close();
    },
  };
}

class Debugger extends EventEmitter {
  attached = false;
  commands: Command[] = [];
  snapshot = fakeBrowserInputSnapshot();
  hook?: (command: Command, emit: (event: LifecycleEvent) => void) => void;
  nativeNavigation?: () => void;
  isAttached() {
    return this.attached;
  }
  attach() {
    this.attached = true;
  }
  async sendCommand(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const command = { method, params };
    this.commands.push(command);
    this.hook?.(command, (event) => {
      if (event.method === "Electron.did-start-navigation")
        this.nativeNavigation?.();
      else this.emit("message", {}, event.method, event.params);
    });
    if (method === "Page.getFrameTree")
      return {
        frameTree: {
          frame: {
            id: "main",
            loaderId: "loader-1",
            url: "https://example.test/input",
          },
        },
      };
    if (method === "Page.createIsolatedWorld") {
      // Some adapters may report observer-world setup repeatedly. This is not a
      // default child context replacement and must never poison the first input.
      this.emit("message", {}, "Runtime.executionContextCreated", {
        context: { id: 42, auxData: { isDefault: false, frameId: "main" } },
      });
      return { executionContextId: 42 };
    }
    if (method === "Page.captureScreenshot")
      return { data: fakeInputScreenshotData() };
    if (method.startsWith("Input.")) {
      this.snapshot.inputRevision++;
      return {};
    }
    if (method === "DOM.describeNode")
      return {
        node: {
          backendNodeId:
            params.backendNodeId ??
            (String(params.objectId).includes("hitNode") ? 102 : 101),
          nodeType: 1,
          localName: "input",
          attributes: [],
        },
      };
    if (method === "Runtime.evaluate") {
      if (params.returnByValue === false)
        return {
          result: {
            subtype: "node",
            objectId: String(params.expression).includes("state?.hitNode")
              ? "hitNode"
              : "focusNode",
          },
        };
      const expression = String(params.expression);
      if (expression.includes("ok:true,value:"))
        return { result: { value: { ok: true, value: 7 } } };
      const snapshot = structuredClone(this.snapshot);
      if (expression.includes("const hit = resolveHit"))
        snapshot.pointerPoint = { x: 1, y: 1 };
      return {
        result: {
          value: expression.includes("visibleText:")
            ? {
                visibleText: "fixture",
                targets: [],
                inputSnapshot: snapshot,
                documentIdentity: snapshot.documentKey,
              }
            : snapshot,
        },
      };
    }
    return {};
  }
}
class Contents extends EventEmitter {
  readonly id = 1;
  readonly debugger = new Debugger();
  readonly session = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    async clearStorageData() {},
    async clearCache() {},
    async clearAuthCache() {},
    flushStorageData() {},
  };
  readonly navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
  };
  url = "about:blank";
  destroyed = false;
  constructor() {
    super();
    this.debugger.nativeNavigation = () =>
      this.emit(
        "did-start-navigation",
        {},
        "https://example.test/child",
        false,
        false,
      );
  }
  async loadURL(url: string) {
    this.emit("did-start-navigation", {}, url, false, true);
    this.url = url;
    this.emit("did-navigate", {}, url);
    this.emit("did-finish-load");
    this.emit("did-stop-loading");
  }
  getURL() {
    return this.url;
  }
  getTitle() {
    return "fixture";
  }
  isLoading() {
    return false;
  }
  isDestroyed() {
    return this.destroyed;
  }
  async capturePage() {
    return {
      isEmpty: () => false,
      getSize: () => ({ width: 800, height: 600 }),
      toPNG: () => Buffer.from(fakeInputScreenshotData(), "base64"),
    };
  }
  setWindowOpenHandler() {}
  async executeJavaScript() {}
  close() {
    this.destroyed = true;
    this.emit("destroyed");
  }
}
async function workspaceFixture(): Promise<Fixture> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-input-child-lifecycle-"),
  );
  const contents = new Contents();
  const view = {
    webContents: contents,
    setVisible() {},
    setBackgroundColor() {},
    setBounds() {},
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  };
  const backend = new WorkspaceBrowser({
    artifactDirectory: directory,
    dependencies: { createView: () => view as never, windowFor: () => null },
  });
  backend.bindThreadSession("work", "thread");
  const tab = await backend.open("work", "https://example.test/input");
  return {
    backend,
    tabId: tab.tabId,
    commands: () => contents.debugger.commands,
    hook(callback) {
      contents.debugger.hook = callback;
    },
    async close() {
      await backend.shutdown();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

class NativeWindow extends EventEmitter {
  static latest: NativeWindow;
  readonly webContents = new Contents();
  constructor() {
    super();
    NativeWindow.latest = this;
  }
  async loadURL(url: string) {
    await this.webContents.loadURL(url);
  }
  getTitle() {
    return this.webContents.getTitle();
  }
  isDestroyed() {
    return this.webContents.isDestroyed();
  }
  destroy() {
    this.webContents.close();
    this.emit("closed");
  }
}
let electronRegistered = false;
async function electronFixture(): Promise<Fixture> {
  if (!electronRegistered) {
    electronRegistered = true;
    (
      globalThis as typeof globalThis & {
        __zenxChildLifecycleWindow?: typeof NativeWindow;
      }
    ).__zenxChildLifecycleWindow = NativeWindow;
    register(
      `data:text/javascript,${encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        return specifier === 'electron'
          ? { url: 'zenx-test:child-lifecycle-electron', shortCircuit: true }
          : next(specifier, context);
      }
      export async function load(url, context, next) {
        return url === 'zenx-test:child-lifecycle-electron'
          ? { format: 'module', source: 'export const BrowserWindow = globalThis.__zenxChildLifecycleWindow;', shortCircuit: true }
          : next(url, context);
      }
    `)}`,
      import.meta.url,
    );
  }
  const backend = new ElectronBrowserBackend();
  const tab = await backend.open("work", "https://example.test/input");
  const debuggerApi = NativeWindow.latest.webContents.debugger;
  return {
    backend,
    tabId: tab.tabId,
    commands: () => debuggerApi.commands,
    hook(callback) {
      debuggerApi.hook = callback;
    },
    async close() {
      await backend.close();
    },
  };
}

async function bridgeFixture(): Promise<Fixture> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-input-child-bridge-"),
  );
  const bridge = await ChromeExtensionBridge.start({
    runtimeDirectory: directory,
    multiInstance: true,
  });
  const descriptor = JSON.parse(
    await readFile(path.join(directory, "chrome-bridge.json"), "utf8"),
  ) as { nativeWebSocketUrl: string };
  const socket = new WebSocket(descriptor.nativeWebSocketUrl, {
    origin: ZENX_CHROME_EXTENSION_ORIGIN,
  });
  const debuggerApi = new Debugger();
  socket.on("message", async (raw) => {
    const command = JSON.parse(raw.toString()) as Command & {
      type: string;
      requestId: string;
    };
    if (command.type !== "cdp-command") return;
    const result = await debuggerApi.sendCommand(
      command.method,
      command.params,
    );
    socket.send(
      JSON.stringify({
        type: "cdp-result",
        requestId: command.requestId,
        result,
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const instanceId = "33333333-3333-4333-8333-333333333333";
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 3,
      scope: "browser",
      instanceId,
      browser: "chrome",
    }),
  );
  socket.send(
    JSON.stringify({
      type: "browser-connected",
      tabs: [{ id: 7, title: "fixture", url: "https://example.test/input" }],
    }),
  );
  await waitUntil(() =>
    bridge
      .connections()
      .some(
        (connection) =>
          connection.connectionId === instanceId &&
          connection.state === "connected",
      ),
  );
  const generation = bridge
    .connections()
    .find((connection) => connection.connectionId === instanceId)!.generation;
  const { backend } = await bridge.connectInstance(instanceId, generation);
  await backend.listTabs("work");
  return {
    backend,
    tabId: "chrome-tab-7",
    commands: () => debuggerApi.commands,
    hook(callback) {
      debuggerApi.hook = callback
        ? (command) =>
            callback(command, (event) =>
              socket.send(
                JSON.stringify({ type: "cdp-event", tabId: 7, ...event }),
              ),
            )
        : undefined;
    },
    async updateTabUrl(url) {
      socket.send(
        JSON.stringify({
          type: "tab-updated",
          tab: { id: 7, title: "fixture", url },
        }),
      );
      await new Promise<void>((resolve, reject) => {
        socket.once("pong", () => resolve());
        socket.ping(undefined, undefined, (error) => {
          if (error) reject(error);
        });
      });
    },
    async close() {
      await Promise.resolve(backend.close()).catch(() => undefined);
      socket.close();
      await bridge.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function input(f: Fixture, observationId: string, kind: "click" | "key") {
  return kind === "click"
    ? await f.backend.pointerClick!("work", f.tabId, observationId, 1, 1)
    : await f.backend.keyPress!("work", f.tabId, observationId, "Enter");
}

for (const [provider, create] of [
  ["attached", attachedFixture],
  ["Workspace", workspaceFixture],
  ["Electron", electronFixture],
  ["Chrome bridge", bridgeFixture],
] as const) {
  for (const kind of ["click", "key"] as const) {
    test(`${provider} ${kind} fences child lifecycle after the final probe, before both sends`, async (t) => {
      const baseline = await create();
      let boundaries: number[];
      try {
        const observed = await baseline.backend.inspect("work", baseline.tabId);
        assert.ok(
          observed.inputViewport,
          "synthetic screenshot has coherent input metadata",
        );
        const start = baseline.commands().length;
        await input(baseline, observed.observationId, kind);
        const commands = baseline.commands().slice(start);
        const sends = commands.flatMap((command, index) =>
          command.method.startsWith("Input.") ? [index] : [],
        );
        assert.equal(sends.length, 2);
        boundaries = sends.map((send) => {
          const index = commands
            .slice(0, send)
            .findLastIndex(
              (command) =>
                command.method === "Runtime.evaluate" &&
                command.params.returnByValue === true,
            );
          assert.ok(index >= 0, "each send has a final JS probe");
          return index;
        });
      } finally {
        await baseline.close();
      }
      const events =
        provider === "Workspace" || provider === "Electron"
          ? [
              ...childEvents,
              { method: "Electron.did-start-navigation", params: {} },
            ]
          : childEvents;
      for (const event of events) {
        for (const [phase, boundary] of boundaries!.entries()) {
          await t.test(
            `${event.method} ${Object.keys(event.params).join(",")} before ${phase === 0 ? "down" : "up"}`,
            async () => {
              const f = await create();
              try {
                const observed = await f.backend.inspect("work", f.tabId);
                const start = f.commands().length;
                let index = 0;
                let interrupted = false;
                f.hook((_command, emit) => {
                  if (index++ !== boundary) return;
                  interrupted = true;
                  emit(event);
                });
                // The synthetic JS snapshot intentionally stays unchanged. Only
                // the Host lifecycle fence can reject this final-probe race.
                await assert.rejects(
                  input(f, observed.observationId, kind),
                  phase === 0
                    ? /frame lifecycle changed/
                    : /outcome is unknown.*frame lifecycle changed/,
                );
                assert.equal(interrupted, true);
                f.hook();
                const sent = () =>
                  f
                    .commands()
                    .slice(start)
                    .filter((command) => command.method.startsWith("Input."));
                assert.equal(
                  sent().length,
                  phase,
                  "no successor release or replay",
                );
                const fresh = await f.backend.inspect("work", f.tabId);
                assert.equal(
                  fresh.documentVersion,
                  observed.documentVersion,
                  "child events do not invalidate the main document authority",
                );
                const tabs = await f.backend.listTabs("work");
                assert.equal(
                  tabs.length,
                  1,
                  "attachment ownership is preserved",
                );
                assert.equal(
                  tabs[0]?.url,
                  observed.url,
                  "child navigation never overwrites the top tab URL",
                );
                if (phase === 0) {
                  assert.ok(fresh.inputViewport);
                  await input(f, fresh.observationId, kind);
                  assert.equal(
                    sent().length,
                    2,
                    "a deliberate fresh action may run after a prepress rejection",
                  );
                } else {
                  assert.equal(fresh.inputViewport, undefined);
                  await assert.rejects(
                    input(f, fresh.observationId, kind),
                    /input is blocked|held input|outcome is unknown/,
                  );
                  assert.equal(sent().length, 1);
                }
                const executable = await f.backend.inspect("work", f.tabId);
                await f.backend.extension?.("work", f.tabId, "evaluate", {
                  expression:
                    "(() => { const expected = 7; return expected; })()",
                  world: "isolated",
                  observationId: executable.observationId,
                });
                assert.equal(
                  sent().length,
                  phase === 0 ? 2 : 1,
                  "programmatic evaluation is preserved without input recovery",
                );
              } finally {
                await f.close();
              }
            },
          );
        }
      }
    });
  }
}

test("Chrome bridge still accepts authoritative tab-updated URL metadata", async () => {
  const f = await bridgeFixture();
  try {
    await f.updateTabUrl!("https://example.test/top-next");
    assert.equal(
      (await f.backend.listTabs("work"))[0]?.url,
      "https://example.test/top-next",
    );
  } finally {
    await f.close();
  }
});
