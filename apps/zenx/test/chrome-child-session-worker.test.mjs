import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const mouse = (type = "mousePressed") => ({
  type,
  x: 12.75,
  y: 3.5,
  button: "left",
  buttons: type === "mousePressed" ? 1 : 0,
  clickCount: 1,
});
const autoAttach = (autoAttach = true) => ({
  autoAttach,
  flatten: true,
  waitForDebuggerOnStart: false,
  ...(autoAttach
    ? { filter: [{ type: "iframe", exclude: false }, { exclude: true }] }
    : {}),
});
function event() {
  const listeners = [];
  return {
    addListener: (listener) => listeners.push(listener),
    emit: (...args) => {
      for (const listener of listeners) listener(...args);
    },
  };
}
async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Synthetic Chrome event timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}
async function fixture(
  version = 130,
  nativeCommand = async () => ({}),
  nativeDetach = async () => {},
) {
  const messages = [],
    commands = [],
    attachments = [];
  const stored = { zenxBrowserAutoConnect: true };
  const port = {
    onMessage: event(),
    onDisconnect: event(),
    disconnected: false,
    postMessage(message) {
      messages.push(JSON.parse(JSON.stringify(message)));
      if (message.type === "hello")
        queueMicrotask(() =>
          port.onMessage.emit({
            type: "ready",
            protocolVersion: 3,
            scope: "browser",
          }),
        );
    },
    disconnect() {
      port.disconnected = true;
    },
  };
  const chrome = {
    action: {
      onClicked: event(),
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async () => {},
      setTitle: async () => {},
    },
    storage: {
      local: {
        setAccessLevel: async () => {},
        get: async (key) => ({ [key]: stored[key] }),
        set: async (data) => Object.assign(stored, data),
      },
    },
    alarms: { onAlarm: event(), get: async () => ({}), clear: async () => {} },
    runtime: {
      onStartup: event(),
      connectNative: () => port,
      getManifest: () => ({ version: "test" }),
    },
    tabs: {
      onCreated: event(),
      onUpdated: event(),
      onRemoved: event(),
      query: async () => [{ id: 7, title: "Root", url: "https://root.test/" }],
      get: async () => ({ id: 7, title: "Root", url: "https://root.test/" }),
    },
    debugger: {
      onEvent: event(),
      onDetach: event(),
      attach: async (target) => {
        attachments.push(target);
      },
      detach: nativeDetach,
      sendCommand: async (target, method, params) => {
        commands.push(JSON.parse(JSON.stringify({ target, method, params })));
        // Match the native protocol rejection observed in the hosted Chrome run.
        if (
          method === "Target.setAutoAttach" &&
          params.autoAttach === false &&
          params.filter?.length
        )
          throw new Error(
            '{"code":-32602,"message":"Target filter should be empty when disabling auto-attach"}',
          );
        return await nativeCommand(target, method, params);
      },
    },
  };
  const source = await readFile(
    new URL("../resources/chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  vm.runInNewContext(source, {
    chrome,
    clearTimeout,
    setTimeout,
    URL,
    crypto: globalThis.crypto,
    navigator: { userAgent: `Chrome/${version}.0` },
  });
  await waitFor(() =>
    messages.some((message) => message.type === "browser-connected"),
  );
  let nextId = 0;
  const send = (method, params = {}, sessionId, rootSessionId = "root-a") => {
    const requestId = `request-${++nextId}`;
    port.onMessage.emit({
      type: "cdp-command",
      requestId,
      tabId: 7,
      method,
      params,
      rootSessionId,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    return requestId;
  };
  const result = async (requestId) => {
    await waitFor(() =>
      messages.some((message) => message.requestId === requestId),
    );
    return messages.find((message) => message.requestId === requestId);
  };
  const emit = (method, params = {}, sessionId) =>
    chrome.debugger.onEvent.emit(
      { tabId: 7, ...(sessionId === undefined ? {} : { sessionId }) },
      method,
      params,
    );
  const attach = (id, parent, type = "iframe") =>
    emit(
      "Target.attachedToTarget",
      { sessionId: id, targetInfo: { targetId: `target-${id}`, type } },
      parent,
    );
  const enable = async (sessionId, root = "root-a") =>
    assert.deepEqual(
      (
        await result(
          send("Target.setAutoAttach", autoAttach(), sessionId, root),
        )
      ).result,
      {},
    );
  return {
    messages,
    commands,
    attachments,
    chrome,
    port,
    stored,
    send,
    result,
    emit,
    attach,
    enable,
  };
}

test("Chrome120 extension advertises no child routing while retaining root debugger access", async () => {
  const f = await fixture(120);
  assert.equal(f.messages[0].capabilities.iframeSessions, false);
  assert.deepEqual((await f.result(f.send("Page.enable"))).result, {});
  assert.match(
    (await f.result(f.send("Target.setAutoAttach", autoAttach()))).error
      .message,
    /Chrome 125/,
  );
  assert.equal(f.commands.length, 1);
  assert.deepEqual(f.commands[0].target, { tabId: 7 });
  const manifest = JSON.parse(
    await readFile(
      new URL("../resources/chrome-extension/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.minimum_chrome_version, "120");
});

test("extension preserves DebuggerSession IDs only for trusted iframe descendants", async () => {
  const f = await fixture();
  await f.enable();
  const before = f.messages.length;
  f.attach("worker", undefined, "worker");
  f.attach("foreign", "unknown");
  assert.equal(f.messages.length, before);
  f.attach("child");
  assert.equal(f.messages.at(-1).params.sessionId, "child");
  assert.equal(f.messages.at(-1).rootSessionId, "root-a");
  f.emit(
    "Page.frameNavigated",
    { frame: { id: "frame", url: "https://child.test/" } },
    "child",
  );
  assert.equal(f.messages.at(-1).sessionId, "child");
  await f.enable("child");
  f.attach("grandchild", "child");
  assert.equal(f.messages.at(-1).sessionId, "child");
  const response = await f.result(
    f.send("Runtime.evaluate", { expression: "1" }, "grandchild"),
  );
  assert.deepEqual(response.result, {});
  assert.deepEqual(f.commands.at(-1).target, {
    tabId: 7,
    sessionId: "grandchild",
  });
  const count = f.commands.length;
  for (const [child, root] of [
    ["arbitrary-native", "root-a"],
    ["child", "root-b"],
  ])
    assert.match(
      (await f.result(f.send("Runtime.evaluate", {}, child, root))).error
        .message,
      /Unknown or retired/,
    );
  assert.match(
    (await f.result(f.send("Input.dispatchMouseEvent", {}, "child"))).error
      .message,
    /validated left-button/,
  );
  assert.equal(f.commands.length, count);
  f.emit("Target.detachedFromTarget", { sessionId: "child" });
  assert.equal(f.messages.at(-1).params.sessionId, "child");
  for (const child of ["child", "grandchild"])
    assert.match(
      (await f.result(f.send("Page.enable", {}, child))).error.message,
      /Unknown or retired/,
    );
  assert.equal(f.port.disconnected, false);
  assert.equal(f.stored.zenxBrowserAutoConnect, true);
  assert.deepEqual((await f.result(f.send("Page.enable"))).result, {});
});

test("child onDetach retires only its subtree and cannot revoke the root browser connection", async () => {
  const f = await fixture();
  await f.enable();
  f.attach("child");
  await f.enable("child");
  f.attach("grandchild", "child");
  f.chrome.debugger.onDetach.emit(
    { tabId: 7, sessionId: "child" },
    "target_closed",
  );
  assert.equal(f.messages.at(-1).method, "Target.detachedFromTarget");
  assert.equal(f.messages.at(-1).params.sessionId, "child");
  assert.equal(f.messages.at(-1).sessionId, undefined);
  f.chrome.debugger.onDetach.emit(
    { tabId: 7, sessionId: "unknown" },
    "canceled_by_user",
  );
  assert.equal(f.port.disconnected, false);
  assert.equal(f.stored.zenxBrowserAutoConnect, true);
  assert.match(
    (await f.result(f.send("Runtime.evaluate", {}, "grandchild"))).error
      .message,
    /Unknown or retired/,
  );
});

test("shared native attachment keeps its owner after serialized confirmed disable", async () => {
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const f = await fixture(130, async (_target, method, params) => {
    if (method === "Target.setAutoAttach" && !params.autoAttach) await gate;
    return {};
  });
  await f.enable();
  f.attach("old-child");
  assert.match(
    (
      await f.result(
        f.send("Target.setAutoAttach", autoAttach(), undefined, "root-b"),
      )
    ).error.message,
    /another root/,
  );
  const disable = f.send("Target.setAutoAttach", autoAttach(false));
  await waitFor(() =>
    f.commands.some((command) => command.params.autoAttach === false),
  );
  const transfer = f.send(
    "Target.setAutoAttach",
    autoAttach(),
    undefined,
    "root-b",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    f.messages.some((message) => message.requestId === transfer),
    false,
  );
  assert.match(
    (await f.result(f.send("Page.enable", {}, "old-child"))).error.message,
    /Unknown or retired/,
  );
  finish();
  assert.deepEqual((await f.result(disable)).result, {});
  assert.match((await f.result(transfer)).error.message, /pinned.*reconnect/);
  await f.enable();
  f.attach("new-child");
  assert.equal(f.messages.at(-1).rootSessionId, "root-a");
  assert.equal(f.attachments.length, 1);
});

test("failed native teardown keeps ownership reserved and does not widen Target access", async () => {
  const f = await fixture(130, async (_target, method, params) => {
    if (method === "Target.setAutoAttach" && !params.autoAttach)
      throw new Error("Synthetic cleanup failed");
    return {};
  });
  await f.enable();
  f.attach("child");
  assert.match(
    (await f.result(f.send("Target.setAutoAttach", autoAttach(false)))).error
      .message,
    /cleanup failed/,
  );
  assert.match(
    (
      await f.result(
        f.send("Target.setAutoAttach", autoAttach(), undefined, "root-b"),
      )
    ).error.message,
    /reconnect/,
  );
  const count = f.commands.length;
  assert.match(
    (await f.result(f.send("Target.getTargets"))).error.message,
    /outside/,
  );
  assert.match(
    (
      await f.result(
        f.send("Target.setAutoAttach", {
          ...autoAttach(),
          filter: [{ exclude: false }],
        }),
      )
    ).error.message,
    /Only flattened/,
  );
  assert.equal(f.commands.length, count);
});

test("explicit child detach uses exact known native parent and retires descendants before response", async () => {
  const f = await fixture();
  await f.enable();
  f.attach("child");
  await f.enable("child");
  f.attach("grandchild", "child");
  assert.ok(
    (
      await f.result(
        f.send("Target.detachFromTarget", { sessionId: "grandchild" }),
      )
    ).error,
  );
  assert.deepEqual(
    (
      await f.result(
        f.send("Target.detachFromTarget", { sessionId: "grandchild" }, "child"),
      )
    ).result,
    {},
  );
  assert.deepEqual(f.commands.at(-1).target, { tabId: 7, sessionId: "child" });
  assert.deepEqual(f.commands.at(-1).params, { sessionId: "grandchild" });
  assert.match(
    (await f.result(f.send("Page.enable", {}, "grandchild"))).error.message,
    /Unknown or retired/,
  );
});

test("same live root re-enables without reviving retired native IDs", async () => {
  const f = await fixture();
  await f.enable();
  f.attach("child");
  await f.result(f.send("Target.setAutoAttach", autoAttach(false)));
  await f.enable();
  const before = f.messages.length;
  f.attach("child");
  f.emit("Runtime.executionContextsCleared", {}, "child");
  assert.equal(f.messages.length, before);
  f.attach("fresh-child");
  assert.equal(f.messages.at(-1).rootSessionId, "root-a");
  assert.equal(f.messages.at(-1).params.sessionId, "fresh-child");
});

test("failed native attachment retirement retains quarantine when a tab becomes supported again", async () => {
  let attempted = false;
  const f = await fixture(
    130,
    async () => ({}),
    async () => {
      attempted = true;
      throw new Error("Detach outcome unknown");
    },
  );
  await f.enable();
  f.attach("child");
  f.chrome.tabs.onUpdated.emit(
    7,
    { url: "chrome://settings/" },
    { id: 7, title: "Internal", url: "chrome://settings/" },
  );
  await waitFor(() => attempted);
  await new Promise((resolve) => setImmediate(resolve));
  f.chrome.tabs.onUpdated.emit(
    7,
    { url: "https://root.test/again" },
    { id: 7, title: "Root", url: "https://root.test/again" },
  );
  assert.match(
    (
      await f.result(
        f.send("Target.setAutoAttach", autoAttach(), undefined, "root-b"),
      )
    ).error.message,
    /reconnect/,
  );
  assert.equal(f.port.disconnected, false);
});

test("extension accepts absent or empty disable filters on exact root and child routes", async () => {
  for (const emptyFilter of [false, true]) {
    const f = await fixture();
    await f.enable();
    f.attach("child");
    await f.enable("child");
    f.attach("grandchild", "child");
    const params = {
      ...autoAttach(false),
      ...(emptyFilter ? { filter: [] } : {}),
    };
    assert.deepEqual(
      (await f.result(f.send("Target.setAutoAttach", params, "child"))).result,
      {},
    );
    assert.deepEqual(f.commands.at(-1), {
      target: { tabId: 7, sessionId: "child" },
      method: "Target.setAutoAttach",
      params,
    });
    assert.match(
      (await f.result(f.send("Page.enable", {}, "grandchild"))).error.message,
      /Unknown or retired/,
    );
    assert.deepEqual(
      (await f.result(f.send("Page.enable", {}, "child"))).result,
      {},
    );
    assert.deepEqual(
      (await f.result(f.send("Target.setAutoAttach", params))).result,
      {},
    );
    assert.deepEqual(f.commands.at(-1).target, { tabId: 7 });
    assert.deepEqual(f.commands.at(-1).params, params);
    assert.match(
      (await f.result(f.send("Page.enable", {}, "child"))).error.message,
      /Unknown or retired/,
    );
    await f.enable();
  }
});

test("extension rejects nonempty disable filters without weakening enable scope or retiring children", async () => {
  const f = await fixture();
  await f.enable();
  f.attach("child");
  const count = f.commands.length;
  for (const params of [
    { ...autoAttach(), filter: undefined },
    { ...autoAttach(), filter: [] },
    { ...autoAttach(), filter: [{ exclude: false }] },
    { ...autoAttach(false), filter: autoAttach().filter },
    { ...autoAttach(false), filter: [{ exclude: true }] },
    { ...autoAttach(false), filter: null },
    { ...autoAttach(false), filter: {} },
    { ...autoAttach(false), flatten: false },
    { ...autoAttach(false), waitForDebuggerOnStart: true },
    { ...autoAttach(false), unrelated: true },
  ]) {
    assert.match(
      (await f.result(f.send("Target.setAutoAttach", params))).error.message,
      /Only flattened/,
    );
    assert.equal(f.commands.length, count);
  }
  assert.deepEqual(
    (await f.result(f.send("Page.enable", {}, "child"))).result,
    {},
  );
});

test("extension dispatches validated left-click pairs only to exact owned iframe routes", async () => {
  const f = await fixture();
  await f.enable();
  f.attach("child");
  await f.enable("child");
  f.attach("grandchild", "child");
  for (const sessionId of ["child", "grandchild"]) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      const params = mouse(type);
      assert.deepEqual(
        (await f.result(f.send("Input.dispatchMouseEvent", params, sessionId)))
          .result,
        {},
      );
      assert.deepEqual(f.commands.at(-1), {
        target: { tabId: 7, sessionId },
        method: "Input.dispatchMouseEvent",
        params,
      });
    }
  }
});

test("extension rejects malformed child mouse commands and unsupported Input before native send", async () => {
  const f = await fixture();
  await f.enable();
  f.attach("child");
  const count = f.commands.length;
  const missing = Object.keys(mouse()).map((removed) =>
    Object.fromEntries(
      Object.entries(mouse()).filter(([key]) => key !== removed),
    ),
  );
  for (const params of [
    ...missing,
    null,
    [],
    { ...mouse(), x: null },
    { ...mouse(), x: "12" },
    { ...mouse(), x: NaN },
    { ...mouse(), y: Infinity },
    { ...mouse(), y: -Infinity },
    { ...mouse(), button: "right" },
    { ...mouse(), buttons: 0 },
    { ...mouse("mouseReleased"), buttons: 1 },
    { ...mouse(), clickCount: 2 },
    { ...mouse(), type: "mouseMoved" },
    { ...mouse(), type: "mouseWheel", deltaY: 1 },
    { ...mouse(), modifiers: 0 },
    { ...mouse(), pointerType: "mouse" },
    { ...mouse(), sessionId: "root-a" },
    { ...mouse(), rootSessionId: "root-a" },
    { ...mouse(), targetId: "chrome-tab-7" },
  ]) {
    assert.match(
      (await f.result(f.send("Input.dispatchMouseEvent", params, "child")))
        .error.message,
      /validated left-button/,
    );
    assert.equal(f.commands.length, count);
  }
  for (const method of [
    "Input.dispatchKeyEvent",
    "Input.insertText",
    "Input.dispatchTouchEvent",
    "Input.dispatchDragEvent",
    "Input.synthesizeScrollGesture",
  ]) {
    assert.match(
      (await f.result(f.send(method, mouse(), "child"))).error.message,
      /validated left-button/,
    );
    assert.equal(f.commands.length, count);
  }
  assert.deepEqual(
    (
      await f.result(
        f.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a" }),
      )
    ).result,
    {},
  );
  assert.deepEqual(f.commands.at(-1).target, { tabId: 7 });
});

test("extension rejects forged owners and retired mouse routes without transferring the root", async () => {
  const f = await fixture();
  await f.enable();
  f.attach("child");
  f.attach("worker", undefined, "worker");
  f.attach("unknown-parent", "unknown");
  const count = f.commands.length;
  for (const [sessionId, root] of [
    ["child", "root-b"],
    ["arbitrary-native", "root-a"],
    ["worker", "root-a"],
    ["unknown-parent", "root-a"],
  ]) {
    assert.match(
      (
        await f.result(
          f.send("Input.dispatchMouseEvent", mouse(), sessionId, root),
        )
      ).error.message,
      /Unknown or retired/,
    );
    assert.equal(f.commands.length, count);
  }
  assert.deepEqual(
    (await f.result(f.send("Input.dispatchMouseEvent", mouse(), "child")))
      .result,
    {},
  );
  f.emit("Target.detachedFromTarget", { sessionId: "child" });
  f.attach("child");
  f.attach("replacement");
  const retiredCount = f.commands.length;
  assert.match(
    (
      await f.result(
        f.send("Input.dispatchMouseEvent", mouse("mouseReleased"), "child"),
      )
    ).error.message,
    /Unknown or retired/,
  );
  assert.equal(f.commands.length, retiredCount);
  assert.deepEqual(
    (await f.result(f.send("Target.setAutoAttach", autoAttach(false)))).result,
    {},
  );
  const disabledCount = f.commands.length;
  assert.match(
    (await f.result(f.send("Input.dispatchMouseEvent", mouse(), "replacement")))
      .error.message,
    /Unknown or retired/,
  );
  assert.match(
    (
      await f.result(
        f.send("Target.setAutoAttach", autoAttach(), undefined, "root-b"),
      )
    ).error.message,
    /pinned.*reconnect/,
  );
  assert.equal(f.commands.length, disabledCount);
});

test("extension rechecks child retirement after awaited tab validation before mouse release", async () => {
  const f = await fixture();
  await f.enable();
  f.attach("child");
  assert.deepEqual(
    (await f.result(f.send("Input.dispatchMouseEvent", mouse(), "child")))
      .result,
    {},
  );
  let entered = false;
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  f.chrome.tabs.get = async () => {
    entered = true;
    await gate;
    return { id: 7, title: "Root", url: "https://root.test/" };
  };
  const count = f.commands.length;
  const release = f.send(
    "Input.dispatchMouseEvent",
    mouse("mouseReleased"),
    "child",
  );
  await waitFor(() => entered);
  f.emit("Target.detachedFromTarget", { sessionId: "child" });
  f.attach("child");
  f.attach("replacement");
  finish();
  assert.match((await f.result(release)).error.message, /Unknown or retired/);
  assert.equal(f.commands.length, count);
});
