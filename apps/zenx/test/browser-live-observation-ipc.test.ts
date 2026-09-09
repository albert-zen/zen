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
