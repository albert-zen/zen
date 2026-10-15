import assert from "node:assert/strict";
import { BrowserBackendRegistry } from "./capabilities/browser-backend-registry.js";
import type { ZenXBrowserBackend } from "./capabilities/browser-provider.js";
import {
  BrowserLiveObservationIpcBridge,
  type BrowserObservationEnvelope,
} from "./browser-live-observation-ipc.js";

/** Real provider/Host/catalog bridge; the receiving renderer transport is instrumented.
 * This does not claim Electron IPC, DOM presentation, or native renderer E2E. */
export async function smokeConnectedActivity(
  backend: ZenXBrowserBackend,
  fixtureUrl: string,
): Promise<void> {
  // The caller owns the existing CI browser connection and its teardown.
  const borrowed = new Proxy(backend, {
    get(target, key) {
      if (key === "close") return async () => {};
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const registry = new BrowserBackendRegistry(borrowed, borrowed);
  const bridge = new BrowserLiveObservationIpcBridge(
    {
      observeBrowserLive: (request, listener) =>
        registry.observeThread(request, listener),
    },
    "ci-catalog",
    true,
  );
  const events: BrowserObservationEnvelope[] = [];
  const renderer = {
    isDestroyed: () => false,
    send: (_channel: string, envelope: BrowserObservationEnvelope) => {
      events.push(envelope);
    },
    on() {},
    removeListener() {},
  };
  const threadId = "ci-connected-activity";
  const invoke = (name: string, args: Record<string, unknown> = {}) =>
    registry.invoke(`browser_connected_${name}`, {
      name,
      callId: `ci-${name}`,
      canonicalToolCallId: `ci-canonical-${name}`,
      threadId,
      arguments: { sessionId: "ci-activity", ...args },
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
  bridge.subscribe(renderer, "ci-catalog-subscription", {
    threadId,
    catalog: true,
    frames: false,
  });
  try {
    // Open through this Host mapping, never borrow a target owned by another
    // provider session. The caller supplies only its existing CI fixture URL.
    await invoke("open", { url: fixtureUrl });
    const opened = events.flatMap(({ event }) =>
      event.type === "activity" && event.callId === "ci-open" ? [event] : [],
    );
    assert.deepEqual(
      opened.map((event) => event.phase),
      ["started", "completed"],
    );
    const targets = events.flatMap(({ event }) =>
      event.type === "targets" ? event.targets : [],
    );
    const target = targets.find(
      (value) =>
        value.backendId === "connected" && value.id === opened[0]!.targetId,
    );
    assert.ok(target, "Host-owned real connected target must be catalogued");
    const result = await invoke("inspect", { tabId: target.tabId });
    assert.ok(result);
    const activities = events.flatMap(({ event }) =>
      event.type === "activity" && event.callId === "ci-inspect" ? [event] : [],
    );
    assert.deepEqual(
      activities.map((event) => event.phase),
      ["started", "completed"],
    );
    assert.ok(activities[0]!.operationSequence > 0);
    for (const event of activities) {
      assert.equal(event.targetId, target.id);
      assert.equal(event.threadId, threadId);
      assert.equal(event.operationId, activities[0]!.operationId);
      assert.equal(event.operationSequence, activities[0]!.operationSequence);
      assert.equal(event.sessionEpoch, activities[0]!.sessionEpoch);
    }
    assert.ok(
      !events.some(({ event }) => event.type === "frame"),
      "catalog must not grant frames",
    );
    console.log(
      JSON.stringify({
        check: "connected-activity-host-catalog",
        provider: "caller-supplied-provider",
        transport: "instrumented-renderer-sink",
        phases: activities.map((event) => event.phase),
        operationSequence: activities[0]!.operationSequence,
      }),
    );
  } finally {
    bridge.unsubscribe(renderer);
    try {
      await invoke("close_session");
    } finally {
      await registry.close();
    }
  }
}
