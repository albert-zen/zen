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

test("stale tab objects cannot expose or revive internal and file navigations", async () => {
  const fixture = await workerFixture();
  fixture.clicked.emit(tab(1));
  await waitFor(() =>
    fixture.ports[0]?.messages.some(
      (message) => message.type === "browser-connected",
    ),
  );
  const port = fixture.ports[0];
  for (const [tabId, url] of [
    [1, "chrome://settings/"],
    [2, "file:///tmp/private.html"],
  ]) {
    const stale = tab(tabId);
    fixture.chrome.tabs.onUpdated.emit(tabId, { url }, stale);
    fixture.chrome.tabs.onUpdated.emit(
      tabId,
      { title: "Late private title" },
      stale,
    );
  }
  assert.deepEqual(
    port.messages
      .filter((message) => message.type === "tab-removed")
      .map((message) => message.tabId),
    [1, 2],
  );
  assert.equal(
    port.messages.some(
      (message) =>
        message.type === "tab-updated" &&
        (message.tab.id === 1 || message.tab.id === 2),
    ),
    false,
  );
  fixture.chrome.tabs.onUpdated.emit(
    1,
    { url: "https://tab-1.test/returned" },
    tab(1),
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        port.messages.findLast(
          (message) => message.type === "tab-updated" && message.tab.id === 1,
        ).tab,
      ),
    ),
    {
      id: 1,
      title: "Tab 1",
      url: "https://tab-1.test/returned",
    },
  );
});

test("removed tab updates stay fenced until a new onCreated lifecycle", async () => {
  const fixture = await workerFixture();
  fixture.clicked.emit(tab(1));
  await waitFor(() =>
    fixture.ports[0]?.messages.some(
      (message) => message.type === "browser-connected",
    ),
  );
  const port = fixture.ports[0];
  const stale = tab(1);
  fixture.chrome.tabs.onRemoved.emit(1);
  fixture.chrome.tabs.onUpdated.emit(1, { title: "Late title" }, stale);
  fixture.chrome.tabs.onUpdated.emit(
    1,
    { url: "https://tab-1.test/late" },
    stale,
  );
  assert.equal(
    port.messages.filter(
      (message) => message.type === "tab-removed" && message.tabId === 1,
    ).length,
    1,
  );
  assert.equal(
    port.messages.some(
      (message) => message.type === "tab-updated" && message.tab.id === 1,
    ),
    false,
  );
  fixture.chrome.tabs.onCreated.emit({
    ...tab(1),
    title: "Recreated",
    url: "https://tab-1.test/recreated",
  });
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        port.messages.findLast(
          (message) => message.type === "tab-updated" && message.tab.id === 1,
        ).tab,
      ),
    ),
    {
      id: 1,
      title: "Recreated",
      url: "https://tab-1.test/recreated",
    },
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

test("browser instance identity survives reconnect and worker restart but differs per install", async () => {
  const stored = {};
  const first = await workerFixture({ stored, browser: "edge" });
  first.clicked.emit(tab(1));
  await waitFor(() =>
    first.ports[0]?.messages.some(
      (message) => message.type === "browser-connected",
    ),
  );
  const hello = first.ports[0].messages.find(
    (message) => message.type === "hello",
  );
  assert.match(hello.instanceId, /^[a-f0-9-]{36}$/);
  assert.equal(hello.browser, "edge");
  first.clicked.emit(tab(1));
  await waitFor(() => first.ports[0].disconnected);
  const next = await workerFixture({ stored, browser: "edge" });
  const other = await workerFixture();
  next.clicked.emit(tab(1));
  other.clicked.emit(tab(1));
  await waitFor(
    () =>
      next.ports[0]?.messages.some(
        (message) => message.type === "browser-connected",
      ) &&
      other.ports[0]?.messages.some(
        (message) => message.type === "browser-connected",
      ),
  );
  assert.equal(next.ports[0].messages[0].instanceId, hello.instanceId);
  assert.notEqual(other.ports[0].messages[0].instanceId, hello.instanceId);
  assert.equal(Object.keys(stored).length, 1);
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
  const stored = options.stored ?? {};
  const chrome = {
    storage: {
      local: {
        setAccessLevel: async ({ accessLevel }) =>
          assert.equal(accessLevel, "TRUSTED_CONTEXTS"),
        get: async (key) => ({ [key]: stored[key] }),
        set: async (value) => Object.assign(stored, value),
      },
    },
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
        const port = nativePort(options);
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
  vm.runInNewContext(source, {
    chrome,
    clearTimeout,
    setTimeout,
    URL,
    crypto: globalThis.crypto,
    navigator: {
      userAgent: options.browser === "edge" ? "Edg/130.0" : "Chrome/130.0",
    },
  });
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

function nativePort(options = {}) {
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
          onMessage.emit(
            options.rejectConnection
              ? {
                  type: "connection-rejected",
                  message:
                    "Another browser is connected. Disconnect its ZenX extension before connecting this browser.",
                }
              : {
                  type: "ready",
                  protocolVersion: message.protocolVersion,
                  scope: "browser",
                },
          ),
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

test("a rejected competing browser reports the conflict without discovering or attaching tabs", async () => {
  const fixture = await workerFixture({ rejectConnection: true });
  const titles = [];
  fixture.chrome.action.setTitle = async (value) => {
    titles.push(value.title);
  };
  fixture.clicked.emit(tab(1));
  await waitFor(() =>
    titles.some((title) => /Another browser is connected/.test(title)),
  );
  assert.equal(fixture.ports[0].disconnected, true);
  assert.equal(
    fixture.ports[0].messages.some(
      (message) => message.type === "browser-connected",
    ),
    false,
  );
  assert.deepEqual(fixture.attachCalls, []);
  assert.deepEqual(fixture.removed, []);
});
