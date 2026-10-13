import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { register } from "node:module";
import {
  BrowserZenXCapabilityPackage,
  ElectronBrowserBackend,
} from "../src/main/capabilities/browser-provider.js";
import { BrowserLiveObservationIpcBridge } from "../src/main/browser-live-observation-ipc.js";
import type { BrowserThreadEvent } from "../src/main/capabilities/browser-thread-observation.js";
import { WorkspaceBrowser } from "../src/main/workspace-browser.js";
import { PlaywrightCliBrowserBackend } from "../src/main/capabilities/playwright-browser-provider.js";
import type { ExternalProviderProcessRunner } from "../src/main/capabilities/external-provider.js";

import {
  UserBrowserCdpBackend,
  type UserBrowserCdpClient,
  type UserBrowserCdpTarget,
} from "../src/main/capabilities/user-browser-provider.js";

const FULL_URL =
  "https://example.test/account?tab=billing&return=%2Fa%3Fb#details";

test("Electron human URL read returns native current URL and rejects stale ownership", async () => {
  // Node's test runner isolates this file; register works on the Node 22.13
  // engine floor, unlike the newer synchronous registerHooks API.
  register(
    `data:text/javascript,${encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        return specifier === 'electron'
          ? { url: 'zenx-test:current-url-electron', shortCircuit: true }
          : next(specifier, context);
      }
      export async function load(url, context, next) {
        return url === 'zenx-test:current-url-electron'
          ? { format: 'module', source: 'export const BrowserWindow = globalThis.__zenxCurrentUrlWindow;', shortCircuit: true }
          : next(url, context);
      }
    `)}`,
    import.meta.url,
  );
  const nativeFixture = globalThis as typeof globalThis & {
    __zenxCurrentUrlWindow?: typeof NativeWindow;
  };
  nativeFixture.__zenxCurrentUrlWindow = NativeWindow;
  const backend = new ElectronBrowserBackend();
  try {
    const opened = await backend.open("owner", FULL_URL);
    const web = NativeWindow.created.at(-1)!.webContents;
    assert.equal(opened.url, "https://example.test/account");
    const loadCount = web.loadCalls.length;
    const events: Array<{ type: string; loading?: boolean }> = [];
    const stop = backend.observeTab("owner", opened.tabId, (event) =>
      events.push(event),
    );
    await new Promise((resolve) => setImmediate(resolve));
    web.loading = true;
    web.emit("did-start-loading");
    assert.equal(
      events.findLast((event) => event.type === "metadata")?.loading,
      true,
    );
    await assert.rejects(
      backend.readCurrentUrl("owner", opened.tabId),
      /loading/,
    );
    web.loading = false;
    web.emit("did-stop-loading");
    assert.equal(
      events.findLast((event) => event.type === "metadata")?.loading,
      false,
    );
    stop();
    const count = events.length;
    web.emit("did-start-loading");
    assert.equal(events.length, count);
    assert.equal(await backend.readCurrentUrl("owner", opened.tabId), FULL_URL);
    assert.equal(web.loadCalls.length, loadCount);
    web.url = "https://example.test/native?new=1#current";
    assert.equal(await backend.readCurrentUrl("owner", opened.tabId), web.url);
    await assert.rejects(
      backend.readCurrentUrl("wrong", opened.tabId),
      /target/,
    );
    await assert.rejects(backend.readCurrentUrl("owner", "missing"), /target/);
    web.onRead = () =>
      web.emit("did-start-navigation", {}, web.url, false, true);
    await assert.rejects(
      backend.readCurrentUrl("owner", opened.tabId),
      /changed/,
    );
    web.onRead = () => NativeWindow.created.at(-1)!.destroy();
    await assert.rejects(
      backend.readCurrentUrl("owner", opened.tabId),
      /target|closed/,
    );
  } finally {
    await backend.close();
    delete nativeFixture.__zenxCurrentUrlWindow;
  }
});

test("Workspace human URL read keeps native query/hash and session incarnation fences", async () => {
  const views: NativeView[] = [];
  const backend = new WorkspaceBrowser({
    dependencies: {
      createView: () => {
        const view = new NativeView();
        views.push(view);
        return view as never;
      },
      windowFor: () => null,
    },
  });
  try {
    backend.bindThreadSession("owner", "thread-a");
    backend.bindThreadSession("wrong", "thread-b");
    const opened = await backend.open("owner", FULL_URL);
    const web = views[0]!.webContents;
    assert.equal(opened.url, "https://example.test/account");
    const loadCount = web.loadCalls.length;
    assert.equal(await backend.readCurrentUrl("owner", opened.tabId), FULL_URL);
    assert.equal(web.loadCalls.length, loadCount);
    web.url = "https://example.test/native?new=1#current";
    assert.equal(await backend.readCurrentUrl("owner", opened.tabId), web.url);
    await assert.rejects(
      backend.readCurrentUrl("wrong", opened.tabId),
      /target/,
    );
    await assert.rejects(backend.readCurrentUrl("owner", "missing"), /target/);
    web.onRead = () =>
      web.emit("did-start-navigation", {}, web.url, false, true);
    await assert.rejects(
      backend.readCurrentUrl("owner", opened.tabId),
      /changed|stale/,
    );
    web.onRead = () => {
      backend.closeSession("owner");
      backend.bindThreadSession("owner", "thread-a");
    };
    await assert.rejects(
      backend.readCurrentUrl("owner", opened.tabId),
      /session|stale/,
    );
    web.onRead = () => web.close();
    await assert.rejects(
      backend.readCurrentUrl("owner", opened.tabId),
      /target|closed/,
    );
  } finally {
    await backend.shutdown();
  }
});

test("Playwright human URL read uses stable tab identity without selecting a page", async () => {
  const runner = new UrlPlaywrightRunner();
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/fixture/playwright-cli",
    runner,
    cwd: "/tmp",
  });
  try {
    const opened = await backend.open("owner", FULL_URL);
    assert.equal(opened.url, "https://example.test/account");
    runner.pages[0]!.current = false;
    runner.pages[0]!.index = 1;
    runner.pages.push({
      index: 0,
      tabKey: "page-b",
      documentKey: "document-b",
      title: "Other",
      url: "https://example.test/other",
      current: true,
    });
    const before = runner.calls.length;
    assert.equal(await backend.readCurrentUrl("owner", opened.tabId), FULL_URL);
    assert.deepEqual(
      runner.calls.slice(before).map((args) => args[2]),
      ["run-code"],
    );
    runner.pages[0]!.url = "https://example.test/current?exact=1#latest";
    runner.pages[0]!.documentKey = "new-document";
    assert.equal(
      await backend.readCurrentUrl("owner", opened.tabId),
      runner.pages[0]!.url,
    );
    await assert.rejects(
      backend.readCurrentUrl("wrong", opened.tabId),
      /session/,
    );
    await backend.open("other-owner", FULL_URL);
    await assert.rejects(
      backend.readCurrentUrl("other-owner", opened.tabId),
      /tab/,
    );
    await assert.rejects(backend.readCurrentUrl("owner", "missing"), /tab/);
    runner.pages.shift();
    await assert.rejects(
      backend.readCurrentUrl("owner", opened.tabId),
      /closed/,
    );
  } finally {
    await backend.close();
  }
});

test("Playwright discards a pending human URL read when its session is retired", async () => {
  const runner = new UrlPlaywrightRunner();
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/fixture/playwright-cli",
    runner,
    cwd: "/tmp",
  });
  try {
    const opened = await backend.open("owner", FULL_URL);
    const gate = runner.holdNextPages();
    const read = backend.readCurrentUrl("owner", opened.tabId);
    const rejected = assert.rejects(read, /closing|closed|stale/);
    await gate.started.promise;
    const closing = backend.closeSession("owner");
    await assert.rejects(
      backend.readCurrentUrl("owner", opened.tabId),
      /closing|closed/,
    );
    gate.release.resolve();
    await rejected;
    await closing;
    await assert.rejects(
      backend.readCurrentUrl("owner", opened.tabId),
      /session/,
    );
  } finally {
    await backend.close();
  }
});

test("CDP human URL read preserves query/hash while tool summaries stay redacted", async () => {
  const client = new UrlCdpClient();
  const backend = new UserBrowserCdpBackend(client);
  try {
    const tabs = await backend.listTabs("owner");
    assert.equal(tabs[0]?.url, "https://example.test/account");
    const before = client.calls.length;
    assert.equal(await backend.readCurrentUrl("owner", "page-a"), FULL_URL);
    assert.deepEqual(client.calls.slice(before), ["listTargets"]);
    client.targets[0]!.url = "https://example.test/latest?state=%23updated#new";
    assert.equal(
      await backend.readCurrentUrl("owner", "page-a"),
      client.targets[0]!.url,
      "read native metadata rather than a cached tool summary",
    );
    await assert.rejects(backend.readCurrentUrl("wrong", "page-a"), /session/);
    await backend.listTabs("other-owner");
    await assert.rejects(
      backend.readCurrentUrl("other-owner", "page-a"),
      /tab/,
    );
    await assert.rejects(backend.readCurrentUrl("owner", "missing"), /tab/);
    client.targets = [];
    await assert.rejects(backend.readCurrentUrl("owner", "page-a"), /closed/);
    client.targets = [
      {
        targetId: "page-a",
        type: "worker",
        title: "Replacement",
        url: FULL_URL,
      },
    ];
    await assert.rejects(backend.readCurrentUrl("owner", "page-a"), /closed/);
  } finally {
    await backend.close();
  }
});

test("CDP discards a pending human URL read when its session is retired", async () => {
  const client = new UrlCdpClient();
  const backend = new UserBrowserCdpBackend(client);
  try {
    await backend.listTabs("owner");
    const gate = client.holdNextList();
    const read = backend.readCurrentUrl("owner", "page-a");
    const rejected = assert.rejects(read, /closing|detaching|closed/);
    await gate.started.promise;
    const closing = backend.closeSession("owner");
    await assert.rejects(
      backend.readCurrentUrl("owner", "page-a"),
      /closing|detaching/,
    );
    gate.release.resolve();
    await rejected;
    await closing;
    await assert.rejects(backend.readCurrentUrl("owner", "page-a"), /session/);
  } finally {
    await backend.close();
  }
});

test("CDP checks attachment ownership again after asynchronous URL metadata read", async () => {
  const client = new UrlCdpClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("owner");
  const gate = client.holdNextList();
  const read = backend.readCurrentUrl("owner", "page-a");
  const rejected = assert.rejects(read, /tainted/);
  await gate.started.promise;
  client.problem = "attachment owner was retired";
  gate.release.resolve();
  await rejected;
  await assert.rejects(backend.close(), /tainted/);
});

class UrlCdpClient implements UserBrowserCdpClient {
  targets: UserBrowserCdpTarget[] = [
    { targetId: "page-a", type: "page", title: "Account", url: FULL_URL },
  ];
  readonly calls: string[] = [];
  problem?: string;
  #nextList?: ReturnType<typeof heldRead>;
  holdNextList() {
    return (this.#nextList = heldRead());
  }
  async listTargets() {
    this.calls.push("listTargets");
    const targets = this.targets.map((target) => ({ ...target }));
    const next = this.#nextList;
    this.#nextList = undefined;
    if (next !== undefined) {
      next.started.resolve();
      await next.release.promise;
    }
    return targets;
  }
  async createTarget(): Promise<string> {
    throw new Error("unexpected create");
  }
  async findTargetsByUrl(): Promise<UserBrowserCdpTarget[]> {
    throw new Error("unexpected find");
  }
  async navigate(): Promise<void> {
    throw new Error("unexpected navigate");
  }
  async evaluateDocument(): Promise<{
    value: unknown;
    documentIdentity: string;
  }> {
    throw new Error("unexpected evaluate");
  }
  async getDocumentIdentity(): Promise<string> {
    throw new Error("unexpected document acquisition");
  }
  async detachTarget() {
    this.calls.push("detachTarget");
  }
  closureProblem() {
    return this.problem;
  }
  async close() {}
}

class UrlPlaywrightRunner implements ExternalProviderProcessRunner {
  readonly calls: string[][] = [];
  pages = [
    {
      index: 0,
      tabKey: "page-a",
      documentKey: "document-a",
      title: "Account",
      url: FULL_URL,
      current: true,
    },
  ];
  #nextPages?: ReturnType<typeof heldRead>;
  holdNextPages() {
    return (this.#nextPages = heldRead());
  }
  async run(_executable: string, args: readonly string[]) {
    this.calls.push([...args]);
    const command = args[2];
    let response: unknown;
    if (command === "open")
      response = { session: args[1]!.slice(3), result: {} };
    else if (command === "run-code") {
      response = { result: JSON.stringify(this.pages) };
      const next = this.#nextPages;
      this.#nextPages = undefined;
      if (next !== undefined) {
        next.started.resolve();
        await next.release.promise;
      }
    } else if (command === "close") response = {};
    else throw new Error(`unexpected command: ${command}`);
    return { stdout: JSON.stringify(response), stderr: "" };
  }
}

class NativeWebContents extends EventEmitter {
  url = "about:blank";
  destroyed = false;
  loading = false;
  onRead?: () => void;
  readonly loadCalls: string[] = [];
  readonly navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
  };
  readonly debugger = {
    attach() {},
    async sendCommand() {
      return {};
    },
  };
  readonly session = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    async clearStorageData() {},
    async clearCache() {},
    async clearAuthCache() {},
    flushStorageData() {},
  };
  async loadURL(url: string) {
    this.loadCalls.push(url);
    this.emit("did-start-navigation", {}, url, false, true);
    this.url = url;
    this.emit("did-navigate", {}, url, 200, "OK");
    this.emit("did-finish-load");
    this.emit("did-stop-loading");
  }
  getURL() {
    const url = this.url;
    const onRead = this.onRead;
    this.onRead = undefined;
    onRead?.();
    return url;
  }
  getTitle() {
    return "Account";
  }
  isLoading() {
    return this.loading;
  }
  async capturePage() {
    return {
      isEmpty: () => false,
      getSize: () => ({ width: 100, height: 80 }),
      toJPEG: () => Buffer.from("fixture"),
    };
  }
  isDestroyed() {
    return this.destroyed;
  }
  setWindowOpenHandler() {}
  close() {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

class NativeWindow extends EventEmitter {
  static readonly created: NativeWindow[] = [];
  readonly webContents = new NativeWebContents();
  constructor() {
    super();
    NativeWindow.created.push(this);
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

class NativeView {
  readonly webContents = new NativeWebContents();
  setVisible() {}
}

function heldRead() {
  return { started: deferred(), release: deferred() };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("Attached native loading follows real page events without another Agent call and retires with its subscription", async () => {
  const views: NativeView[] = [];
  const backend = new WorkspaceBrowser({
    dependencies: {
      createView: () => {
        const view = new NativeView();
        views.push(view);
        return view as never;
      },
      windowFor: () => null,
    },
  });
  const capability = new BrowserZenXCapabilityPackage(backend, undefined, {
    ownsBackend: false,
  });
  const invoke = (name: string, args = {}) =>
    capability.invoke(name, {
      name,
      arguments: { sessionId: "work", ...args },
      callId: crypto.randomUUID(),
      threadId: "thread-a",
      cwd: "/tmp",
      signal: new AbortController().signal,
    });
  const bridge = new BrowserLiveObservationIpcBridge(
    {
      observeBrowserLive: (request, listener) =>
        capability.observeThread(request, listener),
      readBrowserTargetUrl: (threadId, targetId) =>
        capability.readTargetUrl(threadId, targetId),
    },
    "events",
  );
  const events: BrowserThreadEvent[] = [];
  const renderer = {
    isDestroyed: () => false,
    on() {},
    removeListener() {},
    send(_channel: string, envelope: { event: BrowserThreadEvent }) {
      events.push(envelope.event);
    },
  };
  const selected = () => {
    const event = events.findLast((value) => value.type === "targets")!;
    assert.equal(event.type, "targets");
    return event.type === "targets" ? event : undefined!;
  };
  const opened: string[] = [];
  const open = () =>
    bridge.openExternal(
      renderer,
      "thread-a",
      selected().selectedId!,
      async (url) => {
        opened.push(url);
      },
    );
  try {
    await invoke("browser_open", { url: FULL_URL });
    const web = views[0]!.webContents;
    web.loading = true;
    await invoke("browser_list_tabs");
    bridge.subscribe(renderer, "initial", {
      threadId: "thread-a",
      frames: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(selected().targets[0]!.loading, true);
    await assert.rejects(open(), /not current/);
    web.loading = false;
    web.emit("did-stop-loading");
    assert.equal(selected().targets[0]!.loading, false);
    await open();
    assert.equal(opened.at(-1), FULL_URL);
    web.loading = true;
    // Final native read also guards a load that has not reached UI metadata yet.
    await assert.rejects(open(), /loading/);
    web.emit("did-start-loading");
    assert.equal(selected().targets[0]!.loading, true);
    await assert.rejects(open(), /not current/);
    web.loading = false;
    web.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", web.url, true);
    web.emit("did-stop-loading");
    assert.equal(selected().targets[0]!.loading, false);
    await open();
    // Reopening reads native state even if the historical tool summary disagrees.
    bridge.unsubscribe(renderer);
    web.loading = true;
    const count = events.length;
    web.emit("did-start-loading");
    assert.equal(events.length, count);
    bridge.subscribe(renderer, "reopened", {
      threadId: "thread-a",
      frames: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(selected().targets[0]!.loading, true);
    web.loading = false;
    web.emit("did-stop-loading");
    await open();
    bridge.subscribe(renderer, "other-thread", {
      threadId: "thread-b",
      frames: true,
    });
    const otherCount = events.length;
    web.emit("did-start-loading");
    assert.equal(events.length, otherCount);
    assert.deepEqual(selected().targets, []);
  } finally {
    bridge.close();
    await capability.close();
    await backend.shutdown();
  }
});
