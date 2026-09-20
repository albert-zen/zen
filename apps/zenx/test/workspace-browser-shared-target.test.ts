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

class FakeDebugger {
  attached = false;
  evaluations = 0;
  isAttached() {
    return this.attached;
  }
  attach() {
    this.attached = true;
  }
  async sendCommand(method: string) {
    assert.equal(method, "Runtime.evaluate");
    this.evaluations += 1;
    return { result: { value: { visibleText: "fixture", targets: [] } } };
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
  constructor(readonly id = 1) {
    super();
  }
  async loadURL(url: string) {
    this.emit("did-start-navigation", {}, url, false, true);
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
