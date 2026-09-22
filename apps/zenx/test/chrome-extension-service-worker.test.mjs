import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

test("one browser connection discovers all web tabs without attaching debuggers", async () => {
  const fixture = await workerFixture();
  fixture.clicked.emit(tab(1));
  await waitFor(() =>
    fixture.ports[0]?.messages.some(
      (message) => message.type === "browser-connected",
    ),
  );
  const connected = fixture.ports[0].messages.find(
    (message) => message.type === "browser-connected",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(connected.tabs)).map((entry) => entry.id),
    [1, 2],
  );
  assert.deepEqual(fixture.attachCalls, []);
  fixture.clicked.emit(tab(2));
  await waitFor(() => fixture.ports[0].disconnected);
  assert.deepEqual(fixture.removed, []);
});

test("commands attach lazily to independent tabs, discover new tabs, and create provider tabs", async () => {
  const fixture = await workerFixture();
  fixture.clicked.emit(tab(1));
  await waitFor(() =>
    fixture.ports[0]?.messages.some(
      (message) => message.type === "browser-connected",
    ),
  );
  const port = fixture.ports[0];
  for (const id of [1, 2])
    port.onMessage.emit({
      type: "cdp-command",
      requestId: `inspect-${id}`,
      tabId: id,
      method: "Page.enable",
    });
  await waitFor(() => fixture.commands.length === 2);
  assert.deepEqual(fixture.attachCalls.sort(), [1, 2]);
  fixture.chrome.tabs.onCreated.emit(tab(4));
  assert.equal(port.messages.at(-1).tab.id, 4);
  port.onMessage.emit({
    type: "cdp-command",
    requestId: "create",
    method: "Target.createTarget",
    params: { url: "about:blank#zenx-pending-1234-abcd" },
  });
  await waitFor(() =>
    port.messages.some((message) => message.requestId === "create"),
  );
  assert.equal(
    port.messages.find((message) => message.requestId === "create").result
      .targetId,
    "chrome-tab-100",
  );
  assert.equal(
    port.messages.some(
      (message) => message.type === "tab-updated" && message.tab.id === 100,
    ),
    true,
  );
  fixture.chrome.tabs.onRemoved.emit(1);
  await waitFor(() => !fixture.attached.has(1));
  assert.equal(fixture.attached.has(2), true);
  fixture.clicked.emit(tab(4));
  await waitFor(() => port.disconnected && fixture.attached.size === 0);
  assert.deepEqual(fixture.removed, []);
});

test("tab update deltas replace stale same-tab navigation metadata", async () => {
  const fixture = await workerFixture();
  fixture.clicked.emit(tab(1));
  await waitFor(() =>
    fixture.ports[0]?.messages.some(
      (message) => message.type === "browser-connected",
    ),
  );
  const port = fixture.ports[0];
  const stale = tab(1);
  fixture.chrome.tabs.onUpdated.emit(
    1,
    {
      url: "https://tab-1.test/next",
    },
    stale,
  );
  fixture.chrome.tabs.onUpdated.emit(1, { title: "Next page" }, stale);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        port.messages
          .filter(
            (message) => message.type === "tab-updated" && message.tab.id === 1,
          )
          .map((message) => message.tab),
      ),
    ),
    [
      {
        id: 1,
        title: "Tab 1",
        url: "https://tab-1.test/next",
      },
      {
        id: 1,
        title: "Next page",
        url: "https://tab-1.test/next",
      },
    ],
  );
});

test("Chrome debugger cancel revokes all tabs and reconnect rejects late old-port results", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = await workerFixture({
    command: async (_tabId, method) =>
      method === "Runtime.evaluate" ? await pending : {},
  });
  fixture.clicked.emit(tab(1));
  await waitFor(() =>
    fixture.ports[0]?.messages.some(
      (message) => message.type === "browser-connected",
    ),
  );
  const old = fixture.ports[0];
  old.onMessage.emit({
    type: "cdp-command",
    requestId: "late",
    tabId: 1,
    method: "Runtime.evaluate",
  });
  old.onMessage.emit({
    type: "cdp-command",
    requestId: "other",
    tabId: 2,
    method: "Page.enable",
  });
  await waitFor(() => fixture.commands.length === 2);
  fixture.chrome.debugger.onDetach.emit({ tabId: 1 }, "canceled_by_user");
  await waitFor(() => old.disconnected && fixture.attached.size === 0);
  fixture.clicked.emit(tab(2));
  await waitFor(() =>
    fixture.ports[1]?.messages.some(
      (message) => message.type === "browser-connected",
    ),
  );
  old.onDisconnect.emit();
  release({ secret: "old-generation" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fixture.ports[1].disconnected, false);
  assert.equal(
    old.messages.some((message) => message.requestId === "late"),
    false,
  );
  assert.equal(
    fixture.ports[1].messages.some((message) => message.requestId === "late"),
    false,
  );
  fixture.clicked.emit(tab(1));
  await waitFor(() => fixture.ports[1].disconnected);
});

test("disconnect waits for a pending attach before allowing the next browser connection", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = await workerFixture({ attach: async () => await pending });
  fixture.clicked.emit(tab(1));
  await waitFor(() =>
    fixture.ports[0]?.messages.some(
      (message) => message.type === "browser-connected",
    ),
  );
  fixture.ports[0].onMessage.emit({
    type: "cdp-command",
    requestId: "late",
    tabId: 1,
    method: "Page.enable",
  });
  await waitFor(() => fixture.attachCalls.length === 1);
  fixture.chrome.tabs.onRemoved.emit(1); // Starts detach while attach is pending.
  fixture.clicked.emit(tab(2));
  fixture.clicked.emit(tab(2));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fixture.ports.length, 1);
  release();
  await waitFor(() =>
    fixture.ports[1]?.messages.some(
      (message) => message.type === "browser-connected",
    ),
  );
  assert.equal(fixture.attached.size, 0);
  assert.equal(fixture.commands.length, 0);
  fixture.clicked.emit(tab(2));
  await waitFor(() => fixture.ports[1].disconnected);
});

async function workerFixture(options = {}) {
  const clicked = event();
  const ports = [];
  const attachCalls = [];
  const detachCalls = [];
  const removed = [];
  const commands = [];
  const attached = new Set();
  const debuggerDetached = event();
  const tabs = new Map(
    [tab(1), tab(2), { ...tab(3), url: "chrome://settings/" }].map((entry) => [
      entry.id,
      entry,
    ]),
  );
  const chrome = {
    action: {
      onClicked: clicked,
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async () => {},
      setTitle: async () => {},
    },
    debugger: {
      onEvent: event(),
      onDetach: debuggerDetached,
      attach: async ({ tabId }) => {
        attachCalls.push(tabId);
        await options.attach?.(tabId);
        attached.add(tabId);
      },
      detach: async ({ tabId }) => {
        detachCalls.push(tabId);
        attached.delete(tabId);
        debuggerDetached.emit({ tabId }, "canceled_by_user");
      },
      sendCommand: async ({ tabId }, method, params) => {
        commands.push({ tabId, method, params });
        return (await options.command?.(tabId, method)) ?? {};
      },
    },
    runtime: {
      connectNative: () => {
        const port = nativePort();
        ports.push(port);
        return port;
      },
      getManifest: () => ({ version: "2.0.0" }),
    },
    tabs: {
      onCreated: event(),
      onUpdated: event(),
      onRemoved: event(),
      query: async () => [...tabs.values()],
      get: async (id) => {
        if (!tabs.has(id)) throw new Error("Tab closed");
        return tabs.get(id);
      },
      create: async ({ url }) => {
        const entry = { ...tab(100), url: "", pendingUrl: url };
        tabs.set(entry.id, entry);
        chrome.tabs.onCreated.emit(entry);
        return entry;
      },
      remove: async (id) => {
        removed.push(id);
        tabs.delete(id);
        chrome.tabs.onRemoved.emit(id);
      },
    },
  };
  const source = await readFile(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../resources/chrome-extension/service-worker.js",
    ),
    "utf8",
  );
  vm.runInNewContext(source, { chrome, clearTimeout, setTimeout, URL });
  return {
    clicked,
    ports,
    attachCalls,
    detachCalls,
    attached,
    removed,
    commands,
    chrome,
    tabs,
  };
}

function event() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...arguments_) {
      for (const listener of [...listeners]) listener(...arguments_);
    },
  };
}

function nativePort() {
  const onMessage = event();
  const onDisconnect = event();
  return {
    onMessage,
    onDisconnect,
    disconnected: false,
    messages: [],
    postMessage(message) {
      this.messages.push(message);
      if (message?.type === "hello") {
        queueMicrotask(() =>
          onMessage.emit({
            type: "ready",
            protocolVersion: 2,
            scope: "browser",
          }),
        );
      }
    },
    disconnect() {
      this.disconnected = true;
    },
  };
}

function tab(id) {
  return { id, title: `Tab ${id}`, url: `https://tab-${id}.test/` };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for fixture");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
