import assert from "node:assert/strict";
import test from "node:test";
import { BrowserBackendRegistry } from "../src/main/capabilities/browser-backend-registry.js";
import type { ZenXBrowserBackend } from "../src/main/capabilities/browser-provider.js";

import type { BrowserThreadEvent as BrowserLiveObservationEvent } from "../src/main/capabilities/browser-thread-observation.js";
import type { BrowserObservationEnvelope } from "../src/main/browser-live-observation-ipc.js";
import { BrowserLiveObservationIpcBridge } from "../src/main/browser-live-observation-ipc.js";

class FakeRenderer {
  destroyed = false;
  readonly sent: Array<{
    channel: string;
    event: BrowserObservationEnvelope;
  }> = [];
  readonly #destroyedListeners = new Set<() => void>();

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, event: BrowserObservationEnvelope): void {
    this.sent.push({ channel, event });
  }

  on(event: "destroyed", listener: () => void): this {
    assert.equal(event, "destroyed");
    this.#destroyedListeners.add(listener);
    return this;
  }

  removeListener(event: "destroyed", listener: () => void): this {
    assert.equal(event, "destroyed");
    this.#destroyedListeners.delete(listener);
    return this;
  }

  destroy(): void {
    this.destroyed = true;
    for (const listener of [...this.#destroyedListeners]) listener();
  }
}

test("browser live observation is scoped to the subscribing renderer and cleans up", () => {
  const listeners = new Set<(event: BrowserLiveObservationEvent) => void>();
  let stops = 0;
  const bridge = new BrowserLiveObservationIpcBridge(
    {
      observeBrowserLive(_request, listener) {
        listeners.add(listener);
        listener({
          type: "status",
          status: "idle",
          message: "Waiting for the Agent to use a browser tab.",
        });
        return () => {
          if (listeners.delete(listener)) stops += 1;
        };
      },
    },
    "zenx:browser-live:event",
  );
  const first = new FakeRenderer();
  const second = new FakeRenderer();

  bridge.subscribe(first, "first-" + stops, {
    threadId: "thread-a",
    frames: true,
  });
  assert.equal(first.sent.length, 1);
  assert.equal(second.sent.length, 0);
  for (const listener of listeners) {
    listener({
      type: "frame",
      frame: {
        sequence: 1,
        mimeType: "image/jpeg",
        data: "ZmFrZQ==",
        width: 800,
        height: 500,
      },
    });
  }
  assert.equal(first.sent.length, 2);
  assert.equal(second.sent.length, 0);

  bridge.subscribe(first, "first-" + stops, {
    threadId: "thread-a",
    frames: true,
  });
  assert.equal(stops, 1);
  assert.equal(listeners.size, 1);
  bridge.unsubscribe(first);
  assert.equal(stops, 2);
  assert.equal(listeners.size, 0);

  bridge.subscribe(second, "second", { threadId: "thread-b", frames: true });
  second.destroy();
  assert.equal(stops, 3);
  assert.equal(listeners.size, 0);
});

test("switching threads fences late IPC frames and stale unsubscribe requests", () => {
  const callbacks: Array<(event: BrowserLiveObservationEvent) => void> = [];
  const bridge = new BrowserLiveObservationIpcBridge(
    {
      observeBrowserLive(_request, listener) {
        callbacks.push(listener);
        return () => {};
      },
    },
    "frames",
  );
  const renderer = new FakeRenderer();
  bridge.subscribe(renderer, "a", { threadId: "thread-a", frames: true });
  bridge.subscribe(renderer, "b", { threadId: "thread-b", frames: true });
  callbacks[0]!({ type: "status", status: "live", message: "late A" });
  bridge.unsubscribe(renderer, "a");
  callbacks[1]!({ type: "status", status: "live", message: "current B" });
  assert.equal(renderer.sent.length, 1);
  assert.equal(renderer.sent[0]!.event.subscriptionId, "b");
  bridge.close();
});

function externalFixture() {
  let receive!: (event: BrowserLiveObservationEvent) => void;
  let resolve!: (url: string) => void;
  const reads: string[][] = [];
  const opened: string[] = [];
  const bridge = new BrowserLiveObservationIpcBridge(
    {
      observeBrowserLive(_request, listener) {
        receive = listener;
        return () => {};
      },
      readBrowserTargetUrl(threadId: string, targetId: string) {
        reads.push([threadId, targetId]);
        return new Promise<string>((done) => {
          resolve = done;
        });
      },
    },
    "events",
  );
  const renderer = new FakeRenderer();
  const select = (id = "target-a") =>
    receive({
      type: "targets",
      selectedId: id,
      targets: [
        {
          id,
          sessionId: "session",
          tabId: "tab",
          title: "Page",
          url: "https://example.com/app",
          loading: false,
          mode: "live",
          canOpenExternally: true,
        },
      ],
    });
  const subscribe = (id = "sub-a", threadId = "thread-a", frames = true) => {
    bridge.subscribe(renderer, id, { threadId, frames });
    select();
    receive({ type: "status", status: "live", message: "Live" });
  };
  const open = () =>
    bridge.openExternal(renderer, "thread-a", "target-a", async (url) => {
      opened.push(url);
    });
  subscribe();
  return {
    bridge,
    renderer,
    reads,
    opened,
    select,
    subscribe,
    open,
    resolve: (url: string) => resolve(url),
    receive: (event: BrowserLiveObservationEvent) => receive(event),
  };
}

test("external opening resolves the exact selected Host target and preserves query/hash without sending raw URLs to the renderer", async () => {
  const f = externalFixture();
  const pending = f.open();
  assert.deepEqual(f.reads, [["thread-a", "target-a"]]);
  f.resolve("https://example.com/app?q=zen#/invoices/42");
  await pending;
  assert.deepEqual(f.opened, ["https://example.com/app?q=zen#/invoices/42"]);
  assert.ok(!JSON.stringify(f.renderer.sent).includes("invoices"));
  f.bridge.close();
});

test("external opening fails closed for unsupported schemes and duplicate pending requests", async () => {
  const f = externalFixture();
  for (const url of [
    "javascript:alert(1)",
    "file:///private",
    "mailto:a@example.com",
    "zenx://settings",
    "//example.com",
    "https://example.com/\nprivate",
  ]) {
    const pending = f.open();
    await assert.rejects(f.open(), /already pending/);
    f.resolve(url);
    await assert.rejects(pending, /HTTP\(S\)/);
  }
  assert.deepEqual(f.opened, []);
  f.bridge.close();
});

test("external opening rejects foreign targets and late reads after target, subscription, visibility or connection changes", async () => {
  for (const interrupt of [
    (f: ReturnType<typeof externalFixture>) => f.select("target-b"),
    (f: ReturnType<typeof externalFixture>) => f.subscribe("sub-b", "thread-b"),
    (f: ReturnType<typeof externalFixture>) =>
      f.subscribe("sub-b", "thread-a", false),
    (f: ReturnType<typeof externalFixture>) =>
      f.receive({
        type: "status",
        status: "unavailable",
        message: "Disconnected",
      }),
    (f: ReturnType<typeof externalFixture>) => f.renderer.destroy(),
  ]) {
    const f = externalFixture();
    await assert.rejects(
      f.bridge.openExternal(f.renderer, "thread-b", "target-a", async () => {}),
      /not current/,
    );
    await assert.rejects(
      f.bridge.openExternal(f.renderer, "thread-a", "foreign", async () => {}),
      /not current/,
    );
    const pending = f.open();
    interrupt(f);
    f.resolve("https://example.com/current?q=1#hash");
    await assert.rejects(pending, /no longer current/);
    assert.deepEqual(f.opened, []);
    f.bridge.close();
  }
});

test("catalog and frame bridges coexist without weakening frame authority or stale cleanup", async () => {
  const callbacks: Array<(event: BrowserLiveObservationEvent) => void> = [];
  const disposed: number[] = [];
  const source = {
    observeBrowserLive(
      _request: unknown,
      listener: (event: BrowserLiveObservationEvent) => void,
    ) {
      const id = callbacks.push(listener) - 1;
      return () => {
        disposed.push(id);
      };
    },
  };
  const catalog = new BrowserLiveObservationIpcBridge(source, "catalog", true);
  const frame = new BrowserLiveObservationIpcBridge(source, "frames");
  const renderer = new FakeRenderer();
  assert.throws(
    () => catalog.subscribe(renderer, "bad", { threadId: "a", frames: true }),
    /catalog/i,
  );
  catalog.subscribe(renderer, "catalog-a", { threadId: "a", frames: false });
  frame.subscribe(renderer, "frame-a", {
    threadId: "a",
    frames: true,
    targetId: "target",
  });
  assert.deepEqual(disposed, []);
  callbacks[0]!({ type: "targets", targets: [] });
  callbacks[1]!({ type: "status", status: "live", message: "live" });
  assert.deepEqual(
    renderer.sent.map((value) => value.channel),
    ["catalog", "frames"],
  );
  catalog.subscribe(renderer, "catalog-b", { threadId: "b", frames: false });
  catalog.unsubscribe(renderer, "catalog-a");
  callbacks[0]!({ type: "targets", targets: [] });
  callbacks[2]!({ type: "targets", targets: [] });
  callbacks[1]!({ type: "status", status: "live", message: "still live" });
  assert.deepEqual(disposed, [0]);
  assert.equal(renderer.sent.length, 4);
  await assert.rejects(
    catalog.openExternal(renderer, "b", "target", async () => {}),
    /not current/,
  );
  renderer.destroy();
  assert.deepEqual(disposed.sort(), [0, 1, 2]);
  callbacks[1]!({ type: "status", status: "live", message: "late" });
  callbacks[2]!({ type: "targets", targets: [] });
  assert.equal(renderer.sent.length, 4);
});

test("actual registry connected addresses cross catalog and fixed live IPC without weakening ownership", async () => {
  const connection = {
    connectionId: "11111111-1111-4111-8111-111111111111",
    generation: "22222222-2222-4222-8222-222222222222",
    browser: "chrome" as const,
    label: "Synthetic Chrome",
    state: "connected" as const,
  };
  let connectionChanged = () => {};
  const observed: string[] = [];
  const backend = (label: string) =>
    ({
      async listTabs(sessionId: string) {
        return [
          {
            sessionId,
            tabId: "native-tab",
            title: label,
            url: "https://example.test/",
            loading: false,
          },
        ];
      },
      observeTab(
        _sessionId: string,
        _tabId: string,
        send: (value: BrowserLiveObservationEvent) => void,
      ) {
        observed.push(label);
        send({ type: "status", status: "live", message: "live" });
        return () => {};
      },
      async readCurrentUrl() {
        return "https://example.test/";
      },
      async closeSession() {
        return 1;
      },
      async close() {},
    }) as unknown as ZenXBrowserBackend;
  const registry = new BrowserBackendRegistry(
    backend("Workspace"),
    undefined,
    undefined,
    {
      connections: () => [connection],
      connectInstance: async () => ({
        backend: backend("Connected"),
        product: "synthetic",
      }),
      onConnectionsChanged(listener) {
        connectionChanged = listener;
        return () => {};
      },
    },
  );
  const renderer = new FakeRenderer();
  const source = {
    observeBrowserLive: registry.observeThread.bind(registry),
    readBrowserTargetUrl: registry.readTargetUrl.bind(registry),
  };
  const catalog = new BrowserLiveObservationIpcBridge(source, "catalog", true);
  const live = new BrowserLiveObservationIpcBridge(source, "live");
  try {
    const invocation = {
      callId: "synthetic",
      name: "unused",
      threadId: "owner",
      cwd: "/tmp",
      signal: new AbortController().signal,
    };
    await registry.invoke("browser_workspace_list_tabs", {
      ...invocation,
      arguments: { sessionId: "work" },
    });
    await registry.invoke("browser_connected_list_tabs", {
      ...invocation,
      arguments: { sessionId: "work", connectionId: connection.connectionId },
      approvalScope: {
        key: `browser-instance:${connection.connectionId}`,
        label: connection.label,
        generation: connection.generation,
      },
    });
    catalog.subscribe(renderer, "catalog", {
      threadId: "owner",
      frames: false,
      catalog: true,
    });
    const catalogEvent = renderer.sent.findLast(
      (value) =>
        value.channel === "catalog" && value.event.event.type === "targets",
    )!.event.event;
    assert.equal(catalogEvent.type, "targets");
    if (catalogEvent.type !== "targets") throw Error("missing targets");
    const externalId = catalogEvent.targets.find(
      (target) => target.backendId === "connected",
    )!.id;
    const workspaceId = catalogEvent.targets.find(
      (target) => target.backendId === "workspace",
    )!.id;
    assert.equal(
      externalId.length,
      120,
      "production UUID identity components, not shortened test tokens",
    );
    for (const [targetId, label] of [
      [externalId, "Connected"],
      [workspaceId, "Workspace"],
    ]) {
      live.subscribe(renderer, "fixed", {
        threadId: "owner",
        frames: true,
        targetId,
      });
      assert.equal(observed.at(-1), label);
      assert.ok(
        renderer.sent.some(
          (value) =>
            value.channel === "live" &&
            value.event.subscriptionId === "fixed" &&
            value.event.event.type === "status" &&
            value.event.event.status === "live",
        ),
      );
    }
    const before = observed.length;
    live.subscribe(renderer, "foreign", {
      threadId: "foreign",
      frames: true,
      targetId: externalId,
    });
    assert.equal(
      observed.length,
      before,
      "foreign Thread cannot acquire the target",
    );
    await assert.rejects(
      live.openExternal(renderer, "foreign", externalId, async () => {
        throw Error("must not open");
      }),
      /not current/,
    );
    const forged = externalId.replace(
      connection.generation,
      "33333333-3333-4333-8333-333333333333",
    );
    live.subscribe(renderer, "forged", {
      threadId: "owner",
      frames: true,
      targetId: forged,
    });
    assert.equal(
      observed.length,
      before,
      "a different generation is not an alias",
    );
    live.subscribe(renderer, "current", {
      threadId: "owner",
      frames: true,
      targetId: externalId,
    });
    assert.equal(observed.length, before + 1);
    connection.generation = "44444444-4444-4444-8444-444444444444";
    connectionChanged();
    live.subscribe(renderer, "stale", {
      threadId: "owner",
      frames: true,
      targetId: externalId,
    });
    assert.equal(
      observed.length,
      before + 1,
      "retired generation cannot restart frames",
    );
    await assert.rejects(
      live.openExternal(renderer, "owner", externalId, async () => {
        throw Error("must not open");
      }),
      /not current/,
    );
  } finally {
    catalog.close();
    live.close();
    await registry.close();
  }
});

test("observation transport keeps bounded opaque IDs unchanged and rejects invalid sizes/types", () => {
  let calls = 0;
  const received: unknown[] = [];
  const bridge = new BrowserLiveObservationIpcBridge(
    {
      observeBrowserLive(request) {
        calls++;
        received.push(request.targetId);
        return () => {};
      },
    },
    "events",
  );
  const renderer = new FakeRenderer();
  const uuid = "11111111-1111-4111-8111-111111111111";
  for (const targetId of [
    uuid,
    "target-a",
    "a".repeat(80),
    "a".repeat(256),
    "connection-a:1",
    "页面:α / ? ! # % . 🖥",
    "  opaque target  ",
    " ",
    "a\n",
    "a\0",
    "unknown:target",
    "workspace:",
    "connected/other/generation:target",
    `workspace:${uuid}`,
    `connected:${uuid}`,
    `connected/${uuid}/${uuid}:${uuid}`,
    `connected/${uuid}/${uuid}:${"a".repeat(80)}`,
  ]) {
    const before = calls;
    bridge.subscribe(renderer, "valid", {
      threadId: "owner",
      frames: true,
      targetId,
    });
    assert.equal(calls, before + 1);
    assert.equal(
      received.at(-1),
      targetId,
      "opaque identities are never parsed, trimmed or normalized",
    );
  }
  for (const targetId of [
    "",
    "a".repeat(257),
    "🖥".repeat(129),
    123,
    null,
    false,
    {},
  ]) {
    const before = calls;
    assert.throws(
      () =>
        bridge.subscribe(renderer, "invalid", {
          threadId: "owner",
          frames: true,
          targetId: targetId as string,
        }),
      /Invalid Browser observation request/,
    );
    assert.equal(calls, before, "invalid requests never reach the source");
  }
  bridge.close();
});
