import { UserBrowserDocumentChangedBeforeDispatchError } from "./capabilities/user-browser-provider.js";
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
  inspectUntilStable: <T>(operation: () => Promise<T>) => Promise<T> = (
    operation,
  ) => operation(),
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
  const invoke = (
    name: string,
    args: Record<string, unknown> = {},
    callId = `ci-${name}`,
  ) =>
    registry.invoke(`browser_connected_${name}`, {
      name,
      callId,
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
    // This probe measures each inspection attempt separately, including its
    // pre-dispatch retry boundary. Do not consume one in open's follow-up read.
    await invoke("open", { url: fixtureUrl, observe: false });
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
    const attempts: Array<{ callId: string; knownPreDispatch: boolean }> = [];
    await inspectUntilStable(async () => {
      const attempt = {
        callId: `ci-inspect-${attempts.length + 1}`,
        knownPreDispatch: false,
      };
      attempts.push(attempt);
      try {
        return await invoke("inspect", { tabId: target.tabId }, attempt.callId);
      } catch (error) {
        // Only the caller's existing bounded pre-dispatch lifecycle policy may
        // retry inspection. Unknown/timeout/abort/foreign identity are propagated.
        attempt.knownPreDispatch =
          error instanceof UserBrowserDocumentChangedBeforeDispatchError;
        throw error;
      }
    });
    let previousSequence = 0;
    const operationIds = new Set<string>();
    for (const [index, attempt] of attempts.entries()) {
      const activities = events.flatMap(({ event }) =>
        event.type === "activity" && event.callId === attempt.callId
          ? [event]
          : [],
      );
      const final = index === attempts.length - 1;
      assert.equal(attempt.knownPreDispatch, !final);
      assert.deepEqual(
        activities.map((event) => event.phase),
        ["started", final ? "completed" : "failed"],
      );
      assert.ok(activities[0]!.operationSequence > previousSequence);
      previousSequence = activities[0]!.operationSequence;
      assert.ok(!operationIds.has(activities[0]!.operationId));
      operationIds.add(activities[0]!.operationId);
      for (const event of activities) {
        assert.equal(event.targetId, target.id);
        assert.equal(event.threadId, threadId);
        assert.equal(event.operationId, activities[0]!.operationId);
        assert.equal(event.operationSequence, activities[0]!.operationSequence);
        assert.equal(event.sessionEpoch, opened[0]!.sessionEpoch);
      }
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
        attempts: attempts.length,
        knownPreDispatchFailures: attempts.filter(
          (attempt) => attempt.knownPreDispatch,
        ).length,
        phases: ["started", "completed"],
        operationSequence: previousSequence,
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
