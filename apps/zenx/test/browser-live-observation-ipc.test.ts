import assert from "node:assert/strict";
import test from "node:test";

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
