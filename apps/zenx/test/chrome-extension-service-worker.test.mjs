import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

test("browser opt-in reconnects after ZenX restarts without replaying tab operations", async () => {
  const stored = {};
  const f = await workerFixture({ stored });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.ports.length, 0, "a fresh install never connects by itself");
  await connectFixture(f);
  assert.equal(stored.zenxBrowserAutoConnect, true);
  assert.equal(f.alarms.get("zenx-browser-reconnect")?.periodInMinutes, 0.5);
  f.ports[0].onDisconnect.emit();
  await waitFor(() => f.ports[0].disconnected);
  f.chrome.alarms.onAlarm.emit({ name: "unrelated" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.ports.length, 1);
  f.chrome.alarms.onAlarm.emit({ name: "zenx-browser-reconnect" });
  await waitFor(() =>
    f.ports[1]?.messages.some((m) => m.type === "browser-connected"),
  );
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.createCalls, []);
  assert.deepEqual(f.attachCalls, []);
  f.clicked.emit(tab(1));
  await waitFor(
    () => stored.zenxBrowserAutoConnect === false && f.ports[1].disconnected,
  );
  assert.equal(f.alarms.size, 0);
  f.chrome.alarms.onAlarm.emit({ name: "zenx-browser-reconnect" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.ports.length, 2, "manual disconnect cancels reconnection");
});

test("worker/browser restart restores opt-in and recreates a lost alarm, but preserves opt-out", async () => {
  const stored = { zenxBrowserAutoConnect: true };
  const f = await workerFixture({ stored });
  f.chrome.runtime.onStartup.emit();
  await waitFor(() =>
    f.ports[0]?.messages.some((m) => m.type === "browser-connected"),
  );
  assert.equal(
    f.ports.length,
    1,
    "startup and worker activation share one attempt",
  );
  assert.equal(f.alarms.size, 1);
  f.clicked.emit(tab(1));
  await waitFor(
    () => stored.zenxBrowserAutoConnect === false && f.ports[0].disconnected,
  );
  const restarted = await workerFixture({ stored });
  restarted.chrome.runtime.onStartup.emit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restarted.ports.length, 0);
  assert.equal(restarted.alarms.size, 0);
});

test("an unavailable ZenX host is retried only as a fresh connection on the next alarm", async () => {
  const options = {
    stored: { zenxBrowserAutoConnect: true },
    rejectConnection: true,
  };
  const f = await workerFixture(options);
  await waitFor(() => f.ports[0]?.disconnected);
  assert.equal(f.ports.length, 1);
  options.rejectConnection = false;
  f.chrome.alarms.onAlarm.emit({ name: "zenx-browser-reconnect" });
  await waitFor(() =>
    f.ports[1]?.messages.some((m) => m.type === "browser-connected"),
  );
  assert.deepEqual(f.createCalls, []);
});

test("cancelling Chrome debugger access revokes remembered connection intent", async () => {
  const stored = {};
  const f = await workerFixture({ stored });
  await connectFixture(f);
  f.ports[0].onMessage.emit({
    type: "cdp-command",
    requestId: "inspect",
    tabId: 1,
    method: "Page.enable",
  });
  await waitFor(() => f.commands.length === 1);
  f.chrome.debugger.onDetach.emit({ tabId: 1 }, "canceled_by_user");
  await waitFor(
    () => stored.zenxBrowserAutoConnect === false && f.ports[0].disconnected,
  );
  f.chrome.alarms.onAlarm.emit({ name: "zenx-browser-reconnect" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.ports.length, 1);
});

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
  assert.equal(Object.keys(stored).length, 2);
});

test("new inactive tabs share a connection/window group without touching user tabs or focus", async () => {
  const fixture = await workerFixture();
  await connectFixture(fixture);
  const [first, second] = await Promise.all([
    createFixtureTab(fixture, "first"),
    createFixtureTab(fixture, "second"),
  ]);
  assert.deepEqual(first.result.grouping, { status: "grouped", groupId: 10 });
  assert.deepEqual(second.result.grouping, first.result.grouping);
  assert.deepEqual(
    fixture.groupCalls.map((call) => [...call.tabIds]),
    [[100], [101]],
  );
  assert.deepEqual(fixture.groupUpdates, [
    { id: 10, title: "ZenX", color: "blue" },
  ]);
  assert.equal(fixture.tabs.get(1).groupId, -1);
  assert.equal(fixture.tabs.get(2).groupId, -1);
  assert.equal(fixture.createCalls.length, 2);
  for (const properties of fixture.createCalls)
    assert.equal(properties.active, false);
  assert.deepEqual(fixture.commands, []);
  assert.deepEqual(fixture.attachCalls, []);
});

test("grouping follows the created window and never moves tabs into another window", async () => {
  let windowId = 1;
  const fixture = await workerFixture({ createWindowId: () => windowId });
  await connectFixture(fixture);
  const first = await createFixtureTab(fixture, "window-one");
  windowId = 2;
  const second = await createFixtureTab(fixture, "window-two");
  windowId = 1;
  const third = await createFixtureTab(fixture, "window-one-again");
  assert.equal(first.result.grouping.groupId, 10);
  assert.equal(second.result.grouping.groupId, 11);
  assert.equal(third.result.grouping.groupId, 10);
  assert.deepEqual(
    fixture.groupCalls.map((call) => JSON.parse(JSON.stringify(call))),
    [
      { tabIds: [100], createProperties: { windowId: 1 } },
      { tabIds: [101], createProperties: { windowId: 2 } },
      { tabIds: [102], groupId: 10 },
    ],
  );
});

test("renamed groups and manually removed tabs stay as the user left them", async () => {
  const fixture = await workerFixture();
  await connectFixture(fixture);
  await createFixtureTab(fixture, "first");
  await createFixtureTab(fixture, "second");
  fixture.groups.get(10).title = "My research";
  fixture.groups.get(10).color = "red";
  const moved = fixture.tabs.get(100);
  moved.groupId = -1;
  fixture.chrome.tabs.onUpdated.emit(100, { groupId: -1 }, moved);
  await createFixtureTab(fixture, "third");
  assert.equal(moved.groupId, -1);
  assert.equal(fixture.groups.get(10).title, "My research");
  assert.equal(fixture.groups.get(10).color, "red");
  assert.equal(fixture.groupUpdates.length, 1);
  assert.deepEqual(
    fixture.groupCalls.map((call) => [...call.tabIds]),
    [[100], [101], [102]],
  );
});

test("groups without remaining agent tabs are not reclaimed and deleted groups are forgotten", async () => {
  const fixture = await workerFixture();
  await connectFixture(fixture);
  await createFixtureTab(fixture, "first");
  fixture.tabs.get(100).groupId = -1;
  fixture.tabs.get(1).groupId = 10; // User now keeps their own tab in the old group.
  const second = await createFixtureTab(fixture, "second");
  assert.equal(second.result.grouping.groupId, 11);
  assert.equal(fixture.tabs.get(1).groupId, 10);
  await fixture.chrome.tabs.remove(101);
  fixture.groups.delete(11);
  fixture.chrome.tabGroups.onRemoved.emit({ id: 11, windowId: 1 });
  const third = await createFixtureTab(fixture, "third");
  assert.equal(third.result.grouping.groupId, 12);
});

test("moving an existing group to another window does not pull new tabs across windows", async () => {
  const fixture = await workerFixture();
  await connectFixture(fixture);
  await createFixtureTab(fixture, "first");
  fixture.groups.get(10).windowId = 2;
  fixture.tabs.get(100).windowId = 2;
  const second = await createFixtureTab(fixture, "second");
  assert.equal(second.result.grouping.groupId, 11);
  assert.equal(fixture.tabs.get(100).windowId, 2);
  assert.equal(fixture.tabs.get(101).windowId, 1);
});

test("a new connection does not inherit or rename the previous connection's group", async () => {
  const fixture = await workerFixture();
  await connectFixture(fixture);
  await createFixtureTab(fixture, "first");
  fixture.groups.get(10).title = "Keep me";
  fixture.clicked.emit(tab(1));
  await waitFor(() => fixture.ports[0].disconnected);
  await connectFixture(fixture, 1);
  const second = await createFixtureTab(fixture, "second");
  assert.equal(second.result.grouping.groupId, 11);
  assert.equal(fixture.groups.get(10).title, "Keep me");
  assert.equal(fixture.tabs.get(100).groupId, 10);
});

test("group failure keeps the successful target and does not poison subsequent creation", async () => {
  let fail = true;
  const fixture = await workerFixture({
    group: async () => {
      if (fail) throw new Error("Group denied ".repeat(40));
    },
  });
  await connectFixture(fixture);
  const first = await createFixtureTab(fixture, "failed-group");
  assert.equal(first.error, undefined);
  assert.equal(first.result.targetId, "chrome-tab-100");
  assert.equal(first.result.grouping.status, "failed");
  assert.ok(first.result.grouping.reason.length <= 160);
  assert.equal(fixture.createCalls.length, 1);
  assert.equal(fixture.tabs.has(100), true);
  assert.deepEqual(fixture.removed, []);
  fail = false;
  const second = await createFixtureTab(fixture, "next-group");
  assert.equal(second.result.grouping.status, "grouped");
  assert.equal(fixture.createCalls.length, 2);
});

test("unavailable grouping returns the created target without claiming a group", async () => {
  const fixture = await workerFixture({ groupingUnavailable: true });
  await connectFixture(fixture);
  const result = await createFixtureTab(fixture, "unsupported");
  assert.equal(result.result.targetId, "chrome-tab-100");
  assert.equal(result.result.grouping.status, "unavailable");
  assert.deepEqual(fixture.groupCalls, []);
  assert.equal(fixture.createCalls.length, 1);
});

test("a group title update failure keeps successful grouping and an initial user title is preserved", async () => {
  const fixture = await workerFixture({
    groupUpdate: async () => {
      throw new Error("Title unavailable");
    },
  });
  await connectFixture(fixture);
  const result = await createFixtureTab(fixture, "title-failure");
  assert.equal(result.result.targetId, "chrome-tab-100");
  assert.equal(result.result.grouping.status, "grouped");
  assert.equal(result.result.grouping.groupId, 10);
  assert.match(result.result.grouping.reason, /Title unavailable/);
  const renamed = await workerFixture({ newGroupTitle: "User named first" });
  await connectFixture(renamed);
  await createFixtureTab(renamed, "user-title");
  assert.deepEqual(renamed.groupUpdates, []);
  assert.equal(renamed.groups.get(10).title, "User named first");
});

test("a tab moved while its grouping waits is left alone", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = await workerFixture({ group: async () => await pending });
  await connectFixture(fixture);
  const first = createFixtureTab(fixture, "first");
  await waitFor(() => fixture.groupCalls.length === 1);
  const second = createFixtureTab(fixture, "second");
  await waitFor(() => fixture.tabs.has(101));
  fixture.tabs.get(101).windowId = 2;
  release();
  await first;
  const moved = await second;
  assert.equal(moved.result.targetId, "chrome-tab-101");
  assert.equal(moved.result.grouping.status, "unavailable");
  assert.equal(fixture.groupCalls.length, 1);
  assert.equal(fixture.tabs.get(101).groupId, -1);
});

test("disconnect prevents queued grouping and late group metadata mutation", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = await workerFixture({ group: async () => await pending });
  await connectFixture(fixture);
  const port = fixture.ports[0];
  for (const requestId of ["first", "second"])
    port.onMessage.emit({
      type: "cdp-command",
      requestId,
      method: "Target.createTarget",
      params: { url: "about:blank#zenx-pending-1234-abcd" },
    });
  await waitFor(() => fixture.groupCalls.length === 1 && fixture.tabs.has(101));
  fixture.clicked.emit(tab(1));
  await waitFor(() => port.disconnected);
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fixture.groupCalls.length, 1);
  assert.deepEqual(fixture.groupUpdates, []);
  assert.equal(
    port.messages.some(
      (message) =>
        message.requestId === "first" || message.requestId === "second",
    ),
    false,
  );
  assert.equal(fixture.tabs.has(100), true);
  assert.equal(fixture.tabs.has(101), true);
});

test("extension declares the tabGroups permission used for group metadata", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../resources/chrome-extension/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(manifest.permissions.includes("tabGroups"));
});

async function connectFixture(fixture, portIndex = 0) {
  fixture.clicked.emit(tab(1));
  await waitFor(() =>
    fixture.ports[portIndex]?.messages.some(
      (message) => message.type === "browser-connected",
    ),
  );
}

async function createFixtureTab(fixture, requestId) {
  const port = fixture.ports.at(-1);
  port.onMessage.emit({
    type: "cdp-command",
    requestId,
    method: "Target.createTarget",
    params: { url: "about:blank#zenx-pending-1234-abcd" },
  });
  await waitFor(() =>
    port.messages.some((message) => message.requestId === requestId),
  );
  return JSON.parse(
    JSON.stringify(
      port.messages.find((message) => message.requestId === requestId),
    ),
  );
}

async function workerFixture(options = {}) {
  const clicked = event();
  const ports = [];
  const attachCalls = [];
  const detachCalls = [];
  const removed = [];
  const commands = [];
  const createCalls = [];
  const groupCalls = [];
  const groupUpdates = [];
  const groups = new Map();
  let nextTabId = 100;
  let nextGroupId = 10;
  const attached = new Set();
  const debuggerDetached = event();
  const tabs = new Map(
    [tab(1), tab(2), { ...tab(3), url: "chrome://settings/" }].map((entry) => [
      entry.id,
      entry,
    ]),
  );
  const stored = options.stored ?? {};
  const alarms = new Map();
  const chrome = {
    alarms: {
      onAlarm: event(),
      get: async (name) => alarms.get(name),
      create: async (name, info) => alarms.set(name, info),
      clear: async (name) => alarms.delete(name),
    },
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
      onStartup: event(),
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
      query: async (query = {}) =>
        [...tabs.values()].filter(
          (entry) =>
            query.groupId === undefined || entry.groupId === query.groupId,
        ),
      get: async (id) => {
        if (!tabs.has(id)) throw new Error("Tab closed");
        return { ...tabs.get(id) };
      },
      create: async (properties) => {
        createCalls.push(properties);
        const entry = {
          ...tab(nextTabId++),
          windowId: options.createWindowId?.() ?? 1,
          url: "",
          pendingUrl: properties.url,
        };
        tabs.set(entry.id, entry);
        chrome.tabs.onCreated.emit(entry);
        return { ...entry };
      },
      group: async (properties) => {
        groupCalls.push(properties);
        await options.group?.(properties);
        const groupId = properties.groupId ?? nextGroupId++;
        if (properties.groupId !== undefined && !groups.has(groupId))
          throw new Error("Group removed");
        if (!groups.has(groupId))
          groups.set(groupId, {
            id: groupId,
            windowId: properties.createProperties.windowId,
            title: options.newGroupTitle ?? "",
            color: "grey",
          });
        for (const id of properties.tabIds) {
          const entry = tabs.get(id);
          if (!entry) throw new Error("Tab closed");
          entry.groupId = groupId;
          chrome.tabs.onUpdated.emit(id, { groupId }, entry);
        }
        return groupId;
      },
      remove: async (id) => {
        removed.push(id);
        tabs.delete(id);
        chrome.tabs.onRemoved.emit(id);
      },
    },
    tabGroups: {
      onRemoved: event(),
      get: async (id) => {
        if (!groups.has(id)) throw new Error("Group removed");
        return { ...groups.get(id) };
      },
      update: async (id, properties) => {
        groupUpdates.push({ id, ...properties });
        await options.groupUpdate?.(id, properties);
        if (!groups.has(id)) throw new Error("Group removed");
        Object.assign(groups.get(id), properties);
        return { ...groups.get(id) };
      },
    },
  };
  if (options.groupingUnavailable) delete chrome.tabGroups;
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
    createCalls,
    groupCalls,
    groupUpdates,
    groups,
    chrome,
    tabs,
    alarms,
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
  return {
    id,
    title: `Tab ${id}`,
    url: `https://tab-${id}.test/`,
    windowId: 1,
    groupId: -1,
  };
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

test("a stalled group never hides successful creation and late completion performs no follow-up", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = await workerFixture({ group: async () => await gate });
  await connectFixture(fixture);
  const first = await createFixtureTab(fixture, "group-timeout");
  assert.equal(first.result.targetId, "chrome-tab-100");
  assert.equal(first.result.grouping.status, "unknown");
  assert.match(
    first.result.grouping.reason,
    /may still finish.*do not recreate/,
  );
  assert.equal(fixture.createCalls.length, 1);
  assert.equal(fixture.groupCalls.length, 1);
  const second = await createFixtureTab(fixture, "while-stalled");
  assert.equal(second.result.targetId, "chrome-tab-101");
  assert.equal(second.result.grouping.status, "unavailable");
  assert.equal(fixture.groupCalls.length, 1);
  fixture.tabs.get(100).windowId = 2;
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fixture.groupCalls.length, 1);
  assert.deepEqual(
    fixture.groupUpdates,
    [],
    "late result must never rename or regroup after timeout/takeover",
  );
  assert.equal(fixture.createCalls.length, 2);
  assert.deepEqual(fixture.removed, []);
});

test("queued grouping expires without issuing another group after the blocked request settles", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = await workerFixture({ group: async () => await gate });
  await connectFixture(fixture);
  const first = createFixtureTab(fixture, "pending-first");
  await waitFor(() => fixture.groupCalls.length === 1);
  const second = createFixtureTab(fixture, "pending-second");
  const results = await Promise.all([first, second]);
  assert.ok(
    results.every((result) => result.result.grouping.status === "unknown"),
  );
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fixture.groupCalls.length, 1);
  assert.deepEqual(fixture.groupUpdates, []);
  assert.equal(fixture.tabs.get(101).groupId, -1);
  assert.equal(fixture.createCalls.length, 2);
});
