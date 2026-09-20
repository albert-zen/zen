import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceBrowser } from "../src/main/workspace-browser.js";

test("Workspace Browser human view and Agent backend operate the exact same target", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-shared-browser-"),
  );
  const sender = new FakeWebContents(99);
  const window = new FakeWindow(sender);
  const views: FakeView[] = [];
  const browser = new WorkspaceBrowser({
    artifactDirectory: directory,
    dependencies: {
      createView: () => {
        const view = new FakeView();
        views.push(view);
        return view as never;
      },
      windowFor: () => window as never,
    },
  });
  try {
    const humanTabs = browser.command(
      sender as never,
      "thread-a",
      "new",
      undefined,
      "https://example.test/start",
    );
    const tabId = humanTabs[0]!.id;
    await new Promise((resolve) => setImmediate(resolve));
    browser.bindThreadSession("agent-session", "thread-a");

    assert.throws(
      () =>
        browser.command(
          sender as never,
          "thread-a",
          "new",
          undefined,
          "file:///tmp/not-allowed",
        ),
      /HTTP or HTTPS/u,
    );
    await assert.rejects(
      browser.open("agent-session", "file:///tmp/not-allowed"),
      /HTTP or HTTPS/u,
    );
    assert.equal(
      browser.command(sender as never, "thread-a", "list").length,
      1,
      "invalid navigation must not leave a blank shared target",
    );

    const agentTabs = await browser.listTabs("agent-session");
    assert.equal(agentTabs[0]?.tabId, tabId);
    assert.equal(agentTabs[0]?.url, "https://example.test/start");

    await browser.navigate(
      "agent-session",
      tabId,
      "https://example.test/agent",
    );
    assert.equal(
      browser.command(sender as never, "thread-a", "list")[0]?.url,
      "https://example.test/agent",
    );

    browser.mount(sender as never, {
      threadId: "thread-a",
      tabId,
      lease: "lease-a",
      bounds: { x: 0, y: 0, width: 640, height: 480 },
    });
    assert.equal(window.contentView.added[0], views[0]);

    const inspection = await browser.inspect("agent-session", tabId);
    assert.equal(inspection.tabId, tabId);
    assert.equal(views[0]?.webContents.debuggerApi.evaluations, 1);

    assert.equal(browser.closeSession("agent-session"), 0);
    assert.equal(
      browser.command(sender as never, "thread-a", "list").length,
      1,
      "detaching the Agent must preserve the user's shared page",
    );
  } finally {
    await browser.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an aborted current Agent navigation fails instead of reporting success", async () => {
  const fixture = await sharedFixture();
  try {
    fixture.browser.bindThreadSession("agent-session", "thread-a");
    const opened = await fixture.browser.open(
      "agent-session",
      "https://example.test/start",
    );
    const load = deferred<void>();
    fixture.views[0]!.webContents.nextLoad = load;
    const navigating = fixture.browser.navigate(
      "agent-session",
      opened.tabId,
      "https://example.test/interrupted",
    );
    const error = Object.assign(new Error("aborted"), { code: "ERR_ABORTED" });
    load.reject(error);
    await assert.rejects(navigating, /interrupted/u);
  } finally {
    await fixture.close();
  }
});

test("human navigation fences an in-flight Agent inspection and action without waiting", async () => {
  const fixture = await sharedFixture();
  try {
    const humanTabs = fixture.browser.command(
      fixture.sender as never,
      "thread-a",
      "new",
      undefined,
      "https://example.test/start",
    );
    await new Promise((resolve) => setImmediate(resolve));
    const tabId = humanTabs[0]!.id;
    const web = fixture.views[0]!.webContents;
    fixture.browser.bindThreadSession("agent-session", "thread-a");

    const inspectionEvaluation = deferred<unknown>();
    web.debuggerApi.nextEvaluation = inspectionEvaluation;
    const inspecting = fixture.browser.inspect("agent-session", tabId);
    const humanLoad = deferred<void>();
    web.nextLoad = humanLoad;
    fixture.browser.command(
      fixture.sender as never,
      "thread-a",
      "navigate",
      tabId,
      "https://example.test/human",
    );
    assert.equal(
      web.loadCalls.at(-1),
      "https://example.test/human",
      "human navigation must start while inspect is still pending",
    );
    inspectionEvaluation.resolve({ visibleText: "old", targets: [] });
    await assert.rejects(inspecting, /stale/u);
    humanLoad.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    web.debuggerApi.defaultValue = {
      visibleText: "fixture",
      targets: [
        {
          selector: "button",
          role: "button",
          name: "Act",
          actions: ["click"],
          state: {},
        },
      ],
    };
    const inspection = await fixture.browser.inspect("agent-session", tabId);
    const actionEvaluation = deferred<unknown>();
    web.debuggerApi.nextEvaluation = actionEvaluation;
    const acting = fixture.browser.click(
      "agent-session",
      tabId,
      inspection.observationId,
      inspection.targets[0]!.targetId,
    );
    const laterHumanLoad = deferred<void>();
    web.nextLoad = laterHumanLoad;
    fixture.browser.command(
      fixture.sender as never,
      "thread-a",
      "navigate",
      tabId,
      "https://example.test/later-human",
    );
    assert.equal(
      web.loadCalls.at(-1),
      "https://example.test/later-human",
      "human navigation must not queue behind an Agent action",
    );
    actionEvaluation.resolve({ ok: true });
    await assert.rejects(acting, /stale/u);
    laterHumanLoad.resolve();
  } finally {
    await fixture.close();
  }
});

test("closing a shared tab makes an in-flight Agent inspection unknown", async () => {
  const fixture = await sharedFixture();
  try {
    const humanTabs = fixture.browser.command(
      fixture.sender as never,
      "thread-a",
      "new",
      undefined,
      "https://example.test/start",
    );
    await new Promise((resolve) => setImmediate(resolve));
    const tabId = humanTabs[0]!.id;
    fixture.browser.bindThreadSession("agent-session", "thread-a");
    const evaluation = deferred<unknown>();
    fixture.views[0]!.webContents.debuggerApi.nextEvaluation = evaluation;
    const inspecting = fixture.browser.inspect("agent-session", tabId);
    fixture.browser.command(
      fixture.sender as never,
      "thread-a",
      "close",
      tabId,
    );
    evaluation.resolve({ visibleText: "old", targets: [] });
    await assert.rejects(inspecting, /Unknown browser target/u);
  } finally {
    await fixture.close();
  }
});

test("detaching an Agent session makes its in-flight inspection unknown without closing the page", async () => {
  const fixture = await sharedFixture();
  try {
    const humanTabs = fixture.browser.command(
      fixture.sender as never,
      "thread-a",
      "new",
      undefined,
      "https://example.test/start",
    );
    await new Promise((resolve) => setImmediate(resolve));
    const tabId = humanTabs[0]!.id;
    fixture.browser.bindThreadSession("agent-session", "thread-a");
    const evaluation = deferred<unknown>();
    fixture.views[0]!.webContents.debuggerApi.nextEvaluation = evaluation;
    const inspecting = fixture.browser.inspect("agent-session", tabId);
    assert.equal(fixture.browser.closeSession("agent-session"), 0);
    evaluation.resolve({ visibleText: "old", targets: [] });
    await assert.rejects(inspecting, /Unknown browser target/u);
    assert.equal(
      fixture.browser.command(fixture.sender as never, "thread-a", "list")
        .length,
      1,
    );
  } finally {
    await fixture.close();
  }
});

async function sharedFixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-shared-browser-race-"),
  );
  const sender = new FakeWebContents(99);
  const window = new FakeWindow(sender);
  const views: FakeView[] = [];
  const browser = new WorkspaceBrowser({
    artifactDirectory: directory,
    dependencies: {
      createView: () => {
        const view = new FakeView();
        views.push(view);
        return view as never;
      },
      windowFor: () => window as never,
    },
  });
  return {
    browser,
    sender,
    views,
    close: async () => {
      await browser.shutdown();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

class FakeDebugger {
  attached = false;
  evaluations = 0;
  defaultValue: unknown = { visibleText: "fixture", targets: [] };
  nextEvaluation?: ReturnType<typeof deferred<unknown>>;
  isAttached() {
    return this.attached;
  }
  attach() {
    this.attached = true;
  }
  async sendCommand(method: string) {
    assert.equal(method, "Runtime.evaluate");
    this.evaluations += 1;
    const next = this.nextEvaluation;
    this.nextEvaluation = undefined;
    return {
      result: {
        value: next === undefined ? this.defaultValue : await next.promise,
      },
    };
  }
}

class FakeImage {
  isEmpty() {
    return false;
  }
  getSize() {
    return { width: 640, height: 480 };
  }
  toPNG() {
    return Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
  }
  toJPEG() {
    return Buffer.from("frame");
  }
  resize() {
    return this;
  }
}

class FakeWebContents extends EventEmitter {
  readonly debuggerApi = new FakeDebugger();
  readonly debugger = this.debuggerApi;
  readonly session = {
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
  };
  readonly navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => undefined,
    goForward: () => undefined,
  };
  #url = "about:blank";
  #destroyed = false;
  readonly loadCalls: string[] = [];
  nextLoad?: ReturnType<typeof deferred<void>>;
  constructor(readonly id = 1) {
    super();
  }
  async loadURL(url: string) {
    this.loadCalls.push(url);
    this.emit("did-start-navigation", {}, url, false, true);
    const next = this.nextLoad;
    this.nextLoad = undefined;
    if (next !== undefined) await next.promise;
    this.#url = url;
    this.emit("did-navigate");
    this.emit("did-stop-loading");
  }
  getURL() {
    return this.#url;
  }
  getTitle() {
    return "Fixture";
  }
  isLoading() {
    return false;
  }
  isDestroyed() {
    return this.#destroyed;
  }
  capturePage() {
    return Promise.resolve(new FakeImage());
  }
  setWindowOpenHandler() {
    return undefined;
  }
  reload() {
    return undefined;
  }
  send() {
    return undefined;
  }
  focus() {
    return undefined;
  }
  close() {
    this.#destroyed = true;
    this.emit("destroyed");
  }
}

class FakeView {
  readonly webContents = new FakeWebContents();
  setVisible() {
    return undefined;
  }
  setBounds() {
    return undefined;
  }
}

class FakeWindow extends EventEmitter {
  readonly contentView = {
    added: [] as FakeView[],
    addChildView: (view: FakeView) => this.contentView.added.push(view),
    removeChildView: () => undefined,
  };
  constructor(readonly webContents: FakeWebContents) {
    super();
  }
  isDestroyed() {
    return false;
  }
  getContentSize() {
    return [1200, 800] as const;
  }
}
