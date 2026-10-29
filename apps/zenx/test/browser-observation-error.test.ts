import assert from "node:assert/strict";
import test from "node:test";
import {
  browserObservationSubscribeReply,
  subscribeBrowserObservation,
} from "../src/preload/browser-observation-ipc.js";
import {
  BrowserLiveObservationIpcBridge,
  type BrowserObservationEnvelope,
} from "../src/main/browser-live-observation-ipc.js";
import { ipcChannels } from "../src/preload/ipc.js";
import type { BrowserThreadEvent } from "../src/main/capabilities/browser-thread-observation.js";
import { BrowserThreadObservation } from "../src/main/capabilities/browser-thread-observation.js";
import type { ZenXBrowserBackend } from "../src/main/capabilities/browser-provider.js";
import {
  UserBrowserCdpBackend,
  type UserBrowserCdpClient,
} from "../src/main/capabilities/user-browser-provider.js";
import { localErrorDetail } from "../src/local-error-detail.js";

function reason() {
  return Object.assign(
    new Error("<img src=x onerror=alert(1)> preview failed", {
      cause: Object.assign(new Error("original connection cause"), {
        code: "E_SYNTHETIC",
        config: { diagnostic: "attached provider evidence" },
      }),
    }),
    {
      request: { headers: { authorization: "synthetic-authentication-value" } },
    },
  );
}

test("actual main subscribe failure crosses a plain-data reply into preload status without dropping nested cause", async () => {
  const events: BrowserThreadEvent[] = [];
  const callbacks = new Map<
    string,
    (event: unknown, value: BrowserObservationEnvelope) => void
  >();
  const renderer = {
    isDestroyed: () => false,
    on() {},
    removeListener() {},
    send(channel: string, value: BrowserObservationEnvelope) {
      callbacks.get(channel)?.({}, structuredClone(value));
    },
  };
  const bridge = new BrowserLiveObservationIpcBridge(
    {
      observeBrowserLive() {
        throw reason();
      },
    },
    ipcChannels.browserLiveEvent,
  );
  const port = {
    async invoke(channel: string, ...args: unknown[]) {
      if (channel === ipcChannels.browserLiveSubscribe) {
        // Electron's successful reply is plain structured-clone data, not a thrown Error.
        return structuredClone(
          browserObservationSubscribeReply(() =>
            bridge.subscribe(renderer, args[0] as string, args[1] as any),
          ),
        );
      }
      bridge.unsubscribe(renderer, args[0] as string);
    },
    on(
      channel: string,
      callback: (event: unknown, value: BrowserObservationEnvelope) => void,
    ) {
      callbacks.set(channel, callback);
    },
    off(channel: string) {
      callbacks.delete(channel);
    },
  };
  const stop = subscribeBrowserObservation(
    port,
    { threadId: "owner", frames: true },
    (event) => events.push(event),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  const failed = events[0]!;
  assert.equal(failed.type, "status");
  if (failed.type !== "status") throw Error("missing status");
  assert.equal(failed.status, "failed");
  assert.equal(failed.message, "The live browser view could not be connected.");
  assert.match(failed.details!, /original connection cause/);
  assert.match(failed.details!, /E_SYNTHETIC/);
  assert.match(failed.details!, /attached provider evidence/);
  assert.match(failed.details!, /browser-observation-error.test/);
  assert.match(failed.details!, /<img src=x onerror=alert\(1\)>/);
  assert.doesNotMatch(failed.details!, /synthetic-authentication-value/);
  stop();
  bridge.close();
});

test("preload transport rejection retains local cause and a retired subscription ignores late error replies", async () => {
  let reject!: (error: unknown) => void;
  const events: BrowserThreadEvent[] = [];
  const port = {
    invoke(channel: string) {
      return channel === ipcChannels.browserLiveSubscribe
        ? new Promise((_, fail) => {
            reject = fail;
          })
        : Promise.resolve();
    },
    on() {},
    off() {},
  };
  let stop = subscribeBrowserObservation(
    port,
    { threadId: "owner", frames: true },
    (event) => events.push(event),
  );
  reject(reason());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events[0]?.type, "status");
  if (events[0]?.type === "status")
    assert.match(events[0].details!, /original connection cause/);
  stop();
  stop = subscribeBrowserObservation(
    port,
    { threadId: "next", frames: true },
    (event) => events.push(event),
  );
  stop();
  reject(reason());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
});

test("bounded original-error projection preserves diagnostic fields and aggregates without executing accessors", () => {
  const errors = Array.from({ length: 40 }, () => reason());
  const failure = new AggregateError(errors, "aggregate");
  Object.defineProperty(failure, "code", {
    get() {
      throw Error("must not execute");
    },
  });
  Object.assign(failure, {
    reason: "provider reported failure",
    errno: -1,
    syscall: "connect",
    path: "/synthetic/socket",
    details: "available native details",
    data: { phase: "subscribe" },
  });
  const details = localErrorDetail(failure);
  assert.match(details, /original connection cause/);
  assert.match(details, /accessor not evaluated/);
  assert.match(details, /limit reached/);
  assert.doesNotMatch(details, /synthetic-authentication-value/);
  const original = localErrorDetail(
    Object.assign(new Error("original"), {
      reason: "provider reported failure",
      errno: -1,
      syscall: "connect",
      path: "/synthetic/socket",
      details: "available native details",
      data: { phase: "subscribe" },
    }),
  );
  for (const field of [
    "reason",
    "errno",
    "syscall",
    "path",
    "details",
    "data",
  ]) {
    assert.ok(
      field in JSON.parse(original),
      `${field} remains available to the owner`,
    );
  }
  const nativeDetail = "original native diagnostic\ncode: SYNTHETIC";
  const nativeReply = browserObservationSubscribeReply(() => {
    throw Object.assign(new Error("wrapper"), {
      localDiagnosticDetail: nativeDetail,
    });
  });
  assert.equal(nativeReply?.details, nativeDetail);
  const objectReply = browserObservationSubscribeReply(() => {
    throw {
      reason: "original object failure",
      details: "native details",
      data: { phase: "capture" },
    };
  });
  assert.match(objectReply?.details ?? "", /original object failure/);
  assert.match(objectReply?.details ?? "", /native details/);
  assert.match(objectReply?.details ?? "", /capture/);
  assert.match(
    localErrorDetail(new Error("x".repeat(100_000))),
    /limit reached/,
  );
});

test("provider screencast connection errors remain local observation data, with original nested cause", async () => {
  const client = {
    closureProblem: () => undefined,
    listTargets: async () => [
      {
        targetId: "native",
        type: "page",
        title: "Synthetic",
        url: "https://example.test/",
      },
    ],
    observeScreencast: async () => {
      throw reason();
    },
    detachTarget: async () => {},
    close: async () => {},
  } as unknown as UserBrowserCdpClient;
  const backend = new UserBrowserCdpBackend(client);
  const events: BrowserThreadEvent[] = [];
  await backend.listTabs("work");
  const stop = backend.observeTab("work", "native", (event) =>
    events.push(event as BrowserThreadEvent),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const failed = events.findLast(
    (event) => event.type === "status" && event.status === "failed",
  );
  assert.equal(failed?.type, "status");
  if (failed?.type === "status") {
    assert.match(failed.details!, /original connection cause/);
    assert.doesNotMatch(failed.details!, /synthetic-authentication-value/);
  }
  stop();
  await backend.close();
});

test("unavailable observer and snapshot failures retain details without changing lifecycle classification", async () => {
  for (const live of [true, false]) {
    const backend = (
      live
        ? {
            observeTab() {
              throw reason();
            },
          }
        : {}
    ) as ZenXBrowserBackend;
    const observation = new BrowserThreadObservation(backend);
    const session = observation.session("owner", "work");
    observation.publish(session, "browser_inspect", {
      sessionId: "work",
      tabId: "native",
      title: "Synthetic",
      url: "https://example.test/",
      loading: false,
      ...(!live
        ? {
            screenshot: {
              observationId: "synthetic",
              artifactPath: `/tmp/zenx-synthetic-preview-missing-${crypto.randomUUID()}.png`,
              status: "fallback",
              width: 1,
              height: 1,
              bytes: 1,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          }
        : {}),
    });
    const events: BrowserThreadEvent[] = [];
    let unavailable!: () => void;
    const received = new Promise<void>((resolve) => {
      unavailable = resolve;
    });
    const stop = observation.observe(
      {
        threadId: "owner",
        frames: true,
        targetId: session.targets.get("native")!.summary.id,
      },
      (event) => {
        events.push(event);
        if (event.type === "status" && event.status === "unavailable")
          unavailable();
      },
    );
    await received;
    const failed = events.findLast(
      (event) => event.type === "status" && event.status === "unavailable",
    );
    assert.equal(failed?.type, "status");
    if (failed?.type === "status")
      assert.match(
        failed.details!,
        live ? /original connection cause/ : /ENOENT/,
      );
    stop();
    observation.close();
  }
});

test("preload preserves catalog/frame events and legacy void success while fencing late structured rejection", async () => {
  for (const catalog of [false, true]) {
    let settle!: (reply: unknown) => void;
    let callback!: (
      event: unknown,
      envelope: BrowserObservationEnvelope,
    ) => void;
    let subscriptionId = "";
    const events: BrowserThreadEvent[] = [];
    const eventChannel = catalog
      ? ipcChannels.browserCatalogEvent
      : ipcChannels.browserLiveEvent;
    const subscribeChannel = catalog
      ? ipcChannels.browserCatalogSubscribe
      : ipcChannels.browserLiveSubscribe;
    const port = {
      invoke(channel: string, ...args: unknown[]) {
        if (channel !== subscribeChannel) return Promise.resolve();
        subscriptionId = args[0] as string;
        return new Promise((resolve) => {
          settle = resolve;
        });
      },
      on(channel: string, listener: typeof callback) {
        assert.equal(channel, eventChannel);
        callback = listener;
      },
      off() {},
    };
    const request = {
      threadId: "owner",
      frames: !catalog,
      ...(catalog ? { catalog: true as const } : {}),
    };
    let stop = subscribeBrowserObservation(port, request, (event) =>
      events.push(event),
    );
    const event: BrowserThreadEvent = catalog
      ? { type: "targets", targets: [] }
      : {
          type: "frame",
          frame: {
            sequence: 1,
            mimeType: "image/jpeg",
            data: "YQ==",
            width: 1,
            height: 1,
          },
        };
    callback({}, { subscriptionId: "foreign", event });
    assert.equal(events.length, 0);
    callback({}, { subscriptionId, event });
    settle(undefined); // Compatible with old successful main handlers.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([...events], [event]);
    stop();
    callback({}, { subscriptionId, event });
    assert.equal(events.length, 1);
    stop = subscribeBrowserObservation(port, request, (event) =>
      events.push(event),
    );
    stop();
    settle(
      structuredClone(
        browserObservationSubscribeReply(() => {
          throw reason();
        }),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([...events], [event]);
  }
});
