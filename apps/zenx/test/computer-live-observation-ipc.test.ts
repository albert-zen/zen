import assert from "node:assert/strict";
import test from "node:test";

import {
  ComputerLiveObservationIpcBridge,
  type ComputerObservationEnvelope,
} from "../src/main/computer-live-observation-ipc.js";
import type { ComputerThreadEvent } from "../src/main/capabilities/computer-thread-observation.js";

class FakeRenderer {
  destroyed = false;
  sent: ComputerObservationEnvelope[] = [];
  listeners = new Set<() => void>();
  isDestroyed() {
    return this.destroyed;
  }
  send(_channel: string, envelope: ComputerObservationEnvelope) {
    this.sent.push(envelope);
  }
  on(_event: "destroyed", listener: () => void) {
    this.listeners.add(listener);
    return this;
  }
  removeListener(_event: "destroyed", listener: () => void) {
    this.listeners.delete(listener);
    return this;
  }
}

test("Computer IPC observation replaces and fences renderer subscriptions", () => {
  const callbacks: Array<(event: ComputerThreadEvent) => void> = [];
  let stops = 0;
  const bridge = new ComputerLiveObservationIpcBridge(
    {
      observeComputerLive(_request, listener) {
        callbacks.push(listener);
        return () => {
          stops += 1;
        };
      },
    },
    "computer:event",
  );
  const renderer = new FakeRenderer();
  bridge.subscribe(renderer, "first", { threadId: "thread-a", frames: true });
  bridge.subscribe(renderer, "second", { threadId: "thread-b", frames: true });
  callbacks[0]!({ type: "status", status: "live", message: "late" });
  callbacks[1]!({ type: "status", status: "idle", message: "current" });
  assert.equal(renderer.sent.length, 1);
  assert.equal(renderer.sent[0]?.subscriptionId, "second");
  assert.equal(stops, 1);
  bridge.unsubscribe(renderer, "second");
  assert.equal(stops, 2);
});
