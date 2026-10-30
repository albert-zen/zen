import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceBrowser } from "../src/main/workspace-browser.js";

class Debugger extends EventEmitter {
  attached = false;
  commands: { method: string; params?: Record<string, unknown> }[] = [];
  programmable?: () => Promise<unknown>;
  runtimeEnabled = false;
  exposeMainContext = true;
  onRuntimeEnable?: () => void;
  isAttached() {
    return this.attached;
  }
  attach() {
    this.attached = true;
  }
  async sendCommand(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.commands.push({ method, params });
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld")
      return {
        executionContextId:
          params?.worldName === "zenx-browser-programmable-v1" ? 2 : 1,
      };
    if (method === "Runtime.enable") {
      this.onRuntimeEnable?.();
      if (!this.runtimeEnabled && this.exposeMainContext)
        this.emit("message", {}, "Runtime.executionContextCreated", {
          context: {
            id: 3,
            uniqueId: "synthetic-main-unique",
            auxData: { isDefault: true, frameId: "main" },
          },
        });
      this.runtimeEnabled = true;
      return {};
    }
    if (method === "Network.getResponseBody")
      return { body: "synthetic body", base64Encoded: false };
    if (method !== "Runtime.evaluate") return {};
    if (params?.uniqueContextId === "synthetic-main-unique")
      return { result: { value: 84 } };
    if (params?.contextId === 2)
      return this.programmable
        ? await this.programmable()
        : { result: { value: 42 } };
    if (
      String(params?.expression).includes("document.documentElement?.outerHTML")
    )
      return { result: { value: "<html>synthetic</html>" } };
    return {
      result: {
        value: { documentIdentity: "doc", visibleText: "fixture", targets: [] },
      },
    };
  }
}
class Web extends EventEmitter {
  readonly id = 1;
  readonly debugger = new Debugger();
  readonly session = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
  };
  readonly navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
  };
  destroyed = false;
  url = "about:blank";
  async loadURL(url: string) {
    this.emit("did-start-navigation", {}, url, false, true);
    this.url = url;
    this.emit("did-navigate", {}, url, 200, "OK");
    this.emit("did-finish-load");
    this.emit("did-stop-loading");
  }
  getURL() {
    return this.url;
  }
  getTitle() {
    return "Synthetic";
  }
  isLoading() {
    return false;
  }
  isDestroyed() {
    return this.destroyed;
  }
  setWindowOpenHandler() {}
  close() {
    this.destroyed = true;
    this.emit("destroyed");
  }
  send() {}
  async capturePage() {
    return {
      isEmpty: () => false,
      getSize: () => ({ width: 1, height: 1 }),
      toPNG: () =>
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
    };
  }
}
async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-workspace-ext-test-"),
  );
  const web = new Web();
  const view = {
    webContents: web,
    setVisible() {},
    setBounds() {},
    getBounds: () => ({ x: 0, y: 0, width: 640, height: 480 }),
  };
  const window = new EventEmitter() as EventEmitter & {
    webContents: Web;
    isDestroyed(): boolean;
    contentView: unknown;
  };
  window.webContents = web;
  window.isDestroyed = () => false;
  window.contentView = { addChildView() {}, removeChildView() {} };
  const browser = new WorkspaceBrowser({
    artifactDirectory: directory,
    dependencies: {
      createView: () => view as never,
      windowFor: () => window as never,
    },
  });
  browser.bindThreadSession("a", "thread-a");
  const tab = await browser.open("a", "https://example.test/synthetic");
  return {
    browser,
    web,
    tabId: tab.tabId,
    async close() {
      await browser.close();
      await browser.shutdown();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Workspace opt-in network and console persist across calls and isolate sessions", async () => {
  const f = await fixture();
  try {
    assert.equal(
      f.web.debugger.commands.some((c) => c.method === "Network.enable"),
      false,
    );
    await assert.rejects(
      f.browser.extension("a", f.tabId, "network_read", {}),
      /not been started/,
    );
    await f.browser.extension("a", f.tabId, "network_start", {});
    f.web.debugger.emit("message", {}, "Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.test/data" },
    });
    f.web.debugger.emit("message", {}, "Network.responseReceived", {
      requestId: "r1",
      response: { status: 200 },
    });
    const first = (await f.browser.extension("a", f.tabId, "network_read", {
      limit: 1,
    })) as { events: unknown[]; eventCursor: string; rawPath: string };
    assert.equal(first.events.length, 1);
    assert.equal(JSON.parse(await readFile(first.rawPath, "utf8")).length, 2);
    const second = (await f.browser.extension("a", f.tabId, "network_read", {
      eventCursor: first.eventCursor,
    })) as { events: unknown[] };
    assert.equal(second.events.length, 1);
    assert.deepEqual(
      await f.browser.extension("a", f.tabId, "network_response", {
        requestId: "r1",
      }),
      { body: "synthetic body", base64Encoded: false },
    );
    await assert.rejects(
      f.browser.extension("a", f.tabId, "network_response", {
        requestId: "forged",
      }),
      /not captured/,
    );
    f.browser.bindThreadSession("b", "thread-a");
    await assert.rejects(
      f.browser.extension("b", f.tabId, "network_read", {}),
      /not been started/,
    );
    await f.browser.extension("a", f.tabId, "console_start", {});
    f.web.debugger.emit("message", {}, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: "synthetic" }],
    });
    assert.equal(
      (
        (await f.browser.extension("a", f.tabId, "console_read", {})) as {
          events: unknown[];
        }
      ).events.length,
      1,
    );
    f.web.debugger.emit("detach", {}, "synthetic detach");
    await assert.rejects(
      f.browser.extension("a", f.tabId, "network_read", {}),
      /detached/,
    );
    f.browser.closeSession("a");
    assert.equal(
      f.web.destroyed,
      false,
      "session detach preserves shared user page",
    );
    await assert.rejects(
      f.browser.extension("a", f.tabId, "console_read", {}),
      /Unknown browser target/,
    );
  } finally {
    await f.close();
  }
});

test("Workspace evaluate consumes latest observation in separate world and returns actual value", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.browser.extension("a", f.tabId, "evaluate", { expression: "40+2" }),
      /observationId/,
    );
    const observation = await f.browser.inspect("a", f.tabId);
    const result = (await f.browser.extension("a", f.tabId, "evaluate", {
      expression: "40+2",
      observationId: observation.observationId,
    })) as { value: unknown };
    assert.equal(result.value, 42);
    const dispatched = f.web.debugger.commands.find(
      (c) => c.method === "Runtime.evaluate" && c.params?.expression === "40+2",
    );
    assert.equal(dispatched?.params?.contextId, 2);
    await assert.rejects(
      f.browser.extension("a", f.tabId, "evaluate", {
        expression: "40+2",
        observationId: observation.observationId,
      }),
      /observation/i,
    );
    assert.equal(
      (
        (await f.browser.extension("a", f.tabId, "content", {})) as {
          html: string;
        }
      ).html,
      "<html>synthetic</html>",
    );
  } finally {
    await f.close();
  }
});

test("Workspace cancellation after evaluate dispatch reports unknown and never replays", async () => {
  const f = await fixture();
  try {
    const observation = await f.browser.inspect("a", f.tabId);
    const abort = new AbortController();
    f.web.debugger.programmable = async () => {
      abort.abort(new Error("synthetic cancellation"));
      return { result: { value: 42 } };
    };
    await assert.rejects(
      f.browser.extension(
        "a",
        f.tabId,
        "evaluate",
        { expression: "42", observationId: observation.observationId },
        abort.signal,
      ),
      /outcome is unknown/,
    );
    assert.equal(
      f.web.debugger.commands.filter(
        (c) => c.method === "Runtime.evaluate" && c.params?.contextId === 2,
      ).length,
      1,
    );
    assert.equal(
      (await f.browser.listTabs("a"))[0]?.agentActionOutcomeUnknown,
      true,
    );
  } finally {
    await f.close();
  }
});

test("Workspace human takeover blocks programmable mutation and return requires fresh inspection", async () => {
  const f = await fixture();
  try {
    const old = await f.browser.inspect("a", f.tabId);
    f.browser.command(f.web as never, "thread-a", "take-control", f.tabId);
    await assert.rejects(
      f.browser.extension("a", f.tabId, "evaluate", {
        expression: "42",
        observationId: old.observationId,
      }),
      /human control/,
    );
    f.browser.command(f.web as never, "thread-a", "return-control", f.tabId);
    await assert.rejects(
      f.browser.extension("a", f.tabId, "evaluate", {
        expression: "42",
        observationId: old.observationId,
      }),
      /fresh observation/,
    );
    const fresh = await f.browser.inspect("a", f.tabId);
    assert.equal(
      (
        (await f.browser.extension("a", f.tabId, "evaluate", {
          expression: "42",
          observationId: fresh.observationId,
        })) as { value: unknown }
      ).value,
      42,
    );
  } finally {
    await f.close();
  }
});

test("Workspace abort returns promptly while unresolved native evaluation retains mutation fencing", async () => {
  const f = await fixture();
  let settle!: (value: unknown) => void;
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  const native = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  try {
    const observation = await f.browser.inspect("a", f.tabId);
    const abort = new AbortController();
    f.web.debugger.programmable = () => {
      started();
      return native;
    };
    const evaluation = f.browser.extension(
      "a",
      f.tabId,
      "evaluate",
      {
        expression: "new Promise(() => {})",
        observationId: observation.observationId,
      },
      abort.signal,
    );
    await dispatched;
    abort.abort(new Error("synthetic abort while unresolved"));
    await assert.rejects(evaluation, /outcome is unknown.*still in flight/);
    assert.equal((await f.browser.listTabs("a"))[0]?.agentActionsInFlight, 1);
    assert.equal(
      (await f.browser.listTabs("a"))[0]?.agentActionOutcomeUnknown,
      true,
    );
    await assert.rejects(
      f.browser.navigate("a", f.tabId, "https://example.test/blocked"),
      /still in flight/,
    );
    assert.equal(
      f.web.debugger.commands.filter(
        (c) => c.method === "Runtime.evaluate" && c.params?.contextId === 2,
      ).length,
      1,
    );
    // Only actual native settlement releases mutation ownership; the late rejection
    // from the already-aborted operation must be observed rather than unhandled.
    settle({ result: { value: 42 } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await f.browser.listTabs("a"))[0]?.agentActionsInFlight, 0);
  } finally {
    settle({ result: { value: 42 } });
    await f.close();
  }
});

test("Workspace explicit main-world evaluation pins page global access to captured unique context", async () => {
  const f = await fixture();
  try {
    // Runtime already enabled: main-world lookup must use the persistent context
    // lifecycle listener, not assume repeated enable replays all contexts.
    await f.browser.extension("a", f.tabId, "console_start", {});
    const observation = await f.browser.inspect("a", f.tabId);
    const result = (await f.browser.extension("a", f.tabId, "evaluate", {
      world: "main",
      expression: "window.syntheticPageGlobal",
      observationId: observation.observationId,
    })) as { value: unknown; world: string };
    assert.equal(result.value, 84);
    assert.equal(result.world, "main");
    const command = f.web.debugger.commands.find(
      (c) =>
        c.method === "Runtime.evaluate" &&
        c.params?.expression === "window.syntheticPageGlobal",
    );
    assert.equal(command?.params?.uniqueContextId, "synthetic-main-unique");
    assert.equal(command?.params?.contextId, undefined);
    assert.equal(
      f.web.debugger.commands.some(
        (c) => c.method === "Runtime.evaluate" && c.params?.contextId === 1,
      ),
      true,
      "trusted observation remains isolated",
    );
  } finally {
    await f.close();
  }
});

test("Workspace main-world missing or navigation-invalidated context rejects without default dispatch", async () => {
  for (const scenario of ["missing", "navigation"] as const) {
    const f = await fixture();
    try {
      const observation = await f.browser.inspect("a", f.tabId);
      if (scenario === "missing") f.web.debugger.exposeMainContext = false;
      else
        f.web.debugger.onRuntimeEnable = () =>
          f.web.emit(
            "did-start-navigation",
            {},
            "https://example.test/new",
            false,
            true,
          );
      await assert.rejects(
        f.browser.extension("a", f.tabId, "evaluate", {
          world: "main",
          expression: "window.syntheticPageGlobal",
          observationId: observation.observationId,
        }),
        scenario === "missing"
          ? /main-world execution context is unavailable/
          : /became stale/,
      );
      assert.equal(
        f.web.debugger.commands.some(
          (c) =>
            c.method === "Runtime.evaluate" &&
            c.params?.expression === "window.syntheticPageGlobal",
        ),
        false,
      );
    } finally {
      await f.close();
    }
  }
});
