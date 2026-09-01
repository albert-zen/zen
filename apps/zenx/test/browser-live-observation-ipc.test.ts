import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserLiveObservationEvent } from "../src/main/capabilities/browser-provider.js";
import { BrowserLiveObservationIpcBridge } from "../src/main/browser-live-observation-ipc.js";

class FakeRenderer {
  destroyed = false;
  readonly sent: Array<{
    channel: string;
    event: BrowserLiveObservationEvent;
  }> = [];
  readonly #destroyedListeners = new Set<() => void>();

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, event: BrowserLiveObservationEvent): void {
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
      observeBrowserLive(listener) {
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

  bridge.subscribe(first);
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

  bridge.subscribe(first);
  assert.equal(stops, 1);
  assert.equal(listeners.size, 1);
  bridge.unsubscribe(first);
  assert.equal(stops, 2);
  assert.equal(listeners.size, 0);

  bridge.subscribe(second);
  second.destroy();
  assert.equal(stops, 3);
  assert.equal(listeners.size, 0);
});
