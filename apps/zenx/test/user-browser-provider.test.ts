import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  deferred,
  nextTurn,
  waitUntil,
  listen,
  close,
  createFakeCdpServer,
} from "./fixtures/user-browser-cdp.js";

import {
  connectUserBrowserCdp,
  userBrowserDocumentEventInvalidates,
  UserBrowserCdpBackend,
  UserBrowserDocumentChangedAfterDispatchError,
  UserBrowserDocumentChangedBeforeDispatchError,
  UserBrowserMutationOutcomeUnknownError,
  UserBrowserScreenshotMalformedError,
  USER_BROWSER_MAX_LIVE_FRAME_BYTES,
  type UserBrowserCdpClient,
  validateUserBrowserVersion,
  windowsBrowserExecutableCandidates,
} from "../src/main/capabilities/user-browser-provider.js";
import type { ZenXBrowserBackend } from "../src/main/capabilities/browser-provider.js";

test("CDP lifecycle contract invalidates history, reload, activation, and top-frame navigation", () => {
  for (const method of [
    "Page.navigatedWithinDocument",
    "Page.frameStartedNavigating",
    "Page.frameStartedLoading",
    "Page.backForwardCacheNotUsed",
  ]) {
    assert.equal(
      userBrowserDocumentEventInvalidates(method, { frameId: "main" }, "main"),
      true,
      method,
    );
    assert.equal(
      userBrowserDocumentEventInvalidates(method, { frameId: "child" }, "main"),
      false,
      `${method} subframe`,
    );
  }
  assert.equal(
    userBrowserDocumentEventInvalidates("Page.frameNavigated", {
      frame: { id: "main", loaderId: "loader", url: "https://example.test" },
    }),
    true,
  );
  assert.equal(
    userBrowserDocumentEventInvalidates("Page.frameNavigated", {
      frame: { id: "child", parentId: "main" },
    }),
    false,
  );
  assert.equal(
    userBrowserDocumentEventInvalidates("Page.frameNavigated", {
      frame: { id: "main", url: "https://example.test" },
      type: "BackForwardCacheRestore",
    }),
    true,
  );
});

test("attached document acquisition enables Runtime before reading the frame tree", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    await connection.backend.inspect("work", "target-1");
    const methods = cdp.methods();
    assert.ok(
      methods.indexOf("Runtime.enable") > methods.indexOf("Page.enable"),
    );
    assert.ok(
      methods.indexOf("Runtime.enable") < methods.indexOf("Page.getFrameTree"),
    );
  } finally {
    await cdp.close();
  }
});

test("live observation acks every screencast frame and publishes only the bounded latest frame", async () => {
  const cdp = await createFakeCdpServer();
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  const backend = connection.backend;
  try {
    assert.equal(typeof backend.observeTab, "function");
    const events: unknown[] = [];

    await backend.listTabs("work");
    await backend.inspect("work", "target-1");
    let unsubscribe = backend.observeTab!("work", "target-1", (event) =>
      events.push(event),
    );
    await waitUntil(() => cdp.count("Page.startScreencast") === 1);

    for (let frame = 1; frame <= 64; frame += 1)
      cdp.emitScreencastFrame(`latest-${frame}`, frame);
    await waitUntil(() => cdp.count("Page.screencastFrameAck") === 64);
    await new Promise((resolve) => setTimeout(resolve, 140));

    const frames = events.filter(
      (event): event is { type: "frame"; frame: { data: string } } =>
        typeof event === "object" &&
        event !== null &&
        (event as { type?: unknown }).type === "frame",
    );
    assert.ok(frames.length > 0 && frames.length <= 2, JSON.stringify(frames));
    assert.equal(
      frames.at(-1)?.frame.data,
      Buffer.from("latest-64").toString("base64"),
    );

    unsubscribe();
    await waitUntil(() => cdp.count("Page.stopScreencast") === 1);
    await backend.closeSession("work");
    await backend.close();
  } finally {
    await cdp.close();
  }
});

test("live observation fences document changes and becomes unavailable on exact detach", async () => {
  const cdp = await createFakeCdpServer();
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  const backend = connection.backend;
  try {
    const events: unknown[] = [];
    await backend.listTabs("work");
    await backend.inspect("work", "target-1");
    let unsubscribe = backend.observeTab!("work", "target-1", (event) =>
      events.push(event),
    );
    await waitUntil(() => cdp.count("Page.startScreencast") === 1);

    cdp.emitMainDocumentChange();
    await waitUntil(
      () =>
        cdp.count("Page.stopScreencast") === 1 &&
        cdp.count("Page.startScreencast") === 2,
    );
    const statuses = () =>
      events
        .filter(
          (event): event is { type: "status"; status: string } =>
            typeof event === "object" &&
            event !== null &&
            (event as { type?: unknown }).type === "status",
        )
        .map((event) => event.status);
    assert.deepEqual(statuses().slice(-2), ["connecting", "live"]);

    cdp.detachSession();
    await waitUntil(() => statuses().at(-1) === "unavailable");
    const framesBefore = events.filter(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as { type?: unknown }).type === "frame",
    ).length;
    cdp.emitScreencastFrame("stale", 9);
    await waitUntil(() => cdp.count("Page.screencastFrameAck") === 1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(
      events.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "frame",
      ).length,
      framesBefore,
    );
    unsubscribe();
    await backend.closeSession("work");
    await backend.close();
  } finally {
    await cdp.close();
  }
});

test("live observation acks and rejects oversized frames then recovers on the next Agent operation", async () => {
  const cdp = await createFakeCdpServer();
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  const backend = connection.backend;
  try {
    const events: unknown[] = [];
    await backend.listTabs("work");
    await backend.inspect("work", "target-1");
    let unsubscribe = backend.observeTab!("work", "target-1", (event) =>
      events.push(event),
    );
    await waitUntil(() => cdp.count("Page.startScreencast") === 1);

    cdp.emitRawScreencastFrame(
      Buffer.alloc(USER_BROWSER_MAX_LIVE_FRAME_BYTES + 1).toString("base64"),
      1,
    );
    await waitUntil(
      () =>
        cdp.count("Page.screencastFrameAck") === 1 &&
        cdp.count("Page.stopScreencast") === 1,
    );
    const statuses = () =>
      events
        .filter(
          (event): event is { type: "status"; status: string } =>
            typeof event === "object" &&
            event !== null &&
            (event as { type?: unknown }).type === "status",
        )
        .map((event) => event.status);
    assert.equal(statuses().at(-1), "failed");
    assert.equal(
      events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "frame",
      ),
      false,
    );

    await backend.inspect("work", "target-1");
    unsubscribe();
    unsubscribe = backend.observeTab!("work", "target-1", (event) =>
      events.push(event),
    );
    await waitUntil(() => cdp.count("Page.startScreencast") === 2);
    assert.equal(statuses().at(-1), "live");
    cdp.emitScreencastFrame("recovered", 2);
    await waitUntil(() =>
      events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "frame",
      ),
    );

    unsubscribe();
    await backend.closeSession("work");
    await backend.close();
  } finally {
    await cdp.close();
  }
});

test("user browser mode inherits visible authenticated state without exposing session material", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);

  const tabs = await backend.listTabs("work");
  assert.deepEqual(tabs, [
    {
      sessionId: "work",
      tabId: "target-1",
      title: "Account",
      url: "https://example.test/account",
      loading: false,
    },
  ]);

  const inspection = await backend.inspect("work", "target-1");
  assert.match(inspection.visibleText, /Signed in as Alice/u);
  assert.equal(inspection.screenshot.observationId, inspection.observationId);
  assert.ok(inspection.screenshot.bytes > 0);
  assert.equal(inspection.targets[0]?.name, "Continue");
  assert.doesNotMatch(
    JSON.stringify({ tabs, inspection }),
    /cookie|storageState|authorization|secret-cookie-value/iu,
  );

  const target = inspection.targets[0];
  assert.ok(target);
  await backend.click(
    "work",
    "target-1",
    inspection.observationId,
    target.targetId,
  );
  assert.equal(client.actionCount, 1);
  assert.equal(
    client.calls.some((call) =>
      /cookie|storage|authorization|network\./iu.test(call),
    ),
    false,
  );
});

test("attached browser rejects malformed screenshot data explicitly", async () => {
  const client = new FakeUserBrowserClient();
  client.captureScreenshot = async (_targetId, _owner, documentIdentity) => ({
    data: "not-base64",
    documentIdentity,
    status: "captured",
  });
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  await assert.rejects(
    backend.inspect("work", "target-1"),
    UserBrowserScreenshotMalformedError,
  );
  await backend.close();
});

test("concurrent first listings publish one exclusive logical target owner", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  client.holdListings = true;

  const listingA = backend.listTabs("A");
  const listingB = backend.listTabs("B");
  await waitUntil(
    () =>
      client.calls.filter((call) => call === "Target.getTargets").length === 2,
  );
  client.releaseList();
  const [tabsA, tabsB] = await Promise.all([listingA, listingB]);
  assert.equal(tabsA.length + tabsB.length, 1);

  const winner = tabsA.length === 1 ? "A" : "B";
  const loser = winner === "A" ? "B" : "A";
  await backend.inspect(winner, "target-1");
  await assert.rejects(
    backend.inspect(loser, "target-1"),
    /Unknown user browser tab/u,
  );
  assert.equal(await backend.closeSession(loser), 0);
  assert.deepEqual(client.detachedTargets, []);
  assert.equal(await backend.closeSession(winner), 1);
  assert.deepEqual(client.detachedTargets, ["target-1"]);
  await backend.close();
  assert.deepEqual(client.closedTargets, []);
});

test("closing user browser capability only detaches and never closes user targets", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");

  assert.equal(await backend.closeSession("work"), 1);
  await backend.close();

  assert.equal(client.closeCount, 1);
  assert.equal(client.closedTargets.length, 0);
});

test("detaching a user tab keeps it open and out of the logical ZenX session", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  await backend.closeTab("work", "target-1");
  assert.deepEqual(await backend.listTabs("work"), []);
  assert.deepEqual(client.closedTargets, []);
  assert.deepEqual(client.detachedTargets, ["target-1"]);
});

test("tab, session, and backend close coalesce a per-target detach lease", async () => {
  for (const closer of ["session", "backend"] as const) {
    const client = new FakeUserBrowserClient();
    const backend = new UserBrowserCdpBackend(client);
    await backend.listTabs("work");
    client.holdDetaches = true;
    const tabClose = backend.closeTab("work", "target-1");
    await client.detachStarted;
    const outerClose =
      closer === "session" ? backend.closeSession("work") : backend.close();
    await nextTurn();
    assert.deepEqual(client.detachedTargets, ["target-1"], closer);
    assert.equal(client.closeCount, 0, closer);
    client.releaseDetach();
    await tabClose;
    await outerClose;
    assert.deepEqual(client.closedTargets, []);
  }
});

test("concurrent session and backend close share detach and wait through errors", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  client.holdDetaches = true;
  client.detachFailure = new Error("detach failed");
  const sessionClose = backend.closeSession("work");
  await client.detachStarted;
  const backendClose = backend.close();
  await nextTurn();
  assert.deepEqual(client.detachedTargets, ["target-1"]);
  assert.equal(client.closeCount, 0);
  client.releaseDetach();
  await assert.rejects(sessionClose, /detach failed/u);
  await assert.rejects(backendClose, /detach failed/u);
  assert.equal(client.closeCount, 1);
  assert.deepEqual(client.closedTargets, []);
});

test("closeTab detach failure is observed by a racing session close", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  client.holdDetaches = true;
  client.detachFailure = new Error("detach failed");
  const tabClose = backend.closeTab("work", "target-1");
  await client.detachStarted;
  const sessionClose = backend.closeSession("work");
  client.releaseDetach();
  await assert.rejects(tabClose, /detach failed/u);
  await assert.rejects(sessionClose, /detach failed/u);
  assert.deepEqual(client.detachedTargets, ["target-1", "target-1"]);
});

test("closeTab detach uncertainty taints every later session operation before ownership removal", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  client.detachFailure = new Error("detach outcome was lost");

  await assert.rejects(
    backend.closeTab("work", "target-1"),
    /detach outcome was lost/u,
  );

  const laterOperations = [
    () => backend.listTabs("work"),
    () => backend.open("work", "https://example.test/new"),
    () => backend.inspect("work", "target-1"),
    () => backend.navigate("work", "target-1", "https://example.test/next"),
    () => backend.click("work", "target-1", "observation", "target"),
    () => backend.closeTab("work", "target-1"),
  ];
  for (const operation of laterOperations) {
    await assert.rejects(operation, /outcome is unknown|tainted/u);
  }
  client.detachFailure = undefined;
  await assert.rejects(
    backend.closeSession("work"),
    /outcome is unknown|tainted/u,
  );
  assert.deepEqual(client.detachedTargets, ["target-1", "target-1"]);
  await assert.rejects(backend.close(), /outcome is unknown|tainted/u);
  assert.equal(client.closeCount, 1);
});

test("outcome-unknown action survives closeSession cleanup and backend close", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  const inspection = await backend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);
  client.identityChangePhase = "during-evaluate";
  await assert.rejects(
    backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    ),
    /outcome is unknown/u,
  );

  await assert.rejects(
    backend.closeSession("work"),
    /outcome is unknown|tainted/u,
  );
  await assert.rejects(backend.close(), /outcome is unknown|tainted/u);
  assert.equal(client.closeCount, 1);
  assert.deepEqual(client.closedTargets, []);
});

test("outcome-unknown action retains the tab and session lease until late settlement", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  const inspection = await backend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);
  const settlement = deferred<void>();
  client.actionUnknownSettlement = settlement.promise;

  await assert.rejects(
    backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    ),
    /outcome is unknown/u,
  );
  const closing = backend.closeSession("work");
  for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
  assert.deepEqual(client.detachedTargets, []);

  settlement.resolve();
  await assert.rejects(closing, /outcome is unknown|tainted/u);
  assert.deepEqual(client.detachedTargets, ["target-1"]);
});

test("direct backend close reports action and navigation outcome-unknown taint", async () => {
  for (const mutation of ["action", "navigate"] as const) {
    const client = new FakeUserBrowserClient();
    const backend = new UserBrowserCdpBackend(client);
    await backend.listTabs("work");
    if (mutation === "action") {
      const inspection = await backend.inspect("work", "target-1");
      const target = inspection.targets[0];
      assert.ok(target);
      client.identityChangePhase = "during-evaluate";
      await assert.rejects(
        backend.click(
          "work",
          "target-1",
          inspection.observationId,
          target.targetId,
        ),
        /outcome is unknown/u,
      );
    } else {
      client.navigateFailureOnce = new Error("navigate response was lost");
      await assert.rejects(
        backend.navigate("work", "target-1", "https://example.test/lost"),
        /outcome is unknown/u,
      );
    }
    await assert.rejects(backend.close(), /outcome is unknown|tainted/u);
    assert.equal(client.closeCount, 1);
  }
});

test("closeTab is a session-tail operation that fences every later request", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  client.holdDetaches = true;
  const tabClose = backend.closeTab("work", "target-1");
  await client.detachStarted;
  let listSettled = false;
  const listing = backend.listTabs("work").then(
    (tabs) => {
      listSettled = true;
      return tabs;
    },
    (error: unknown) => {
      listSettled = true;
      throw error;
    },
  );
  const opening = backend.open("work", "https://example.test/later");
  await nextTurn();
  assert.equal(listSettled, false);
  assert.equal(client.calls.includes("Target.createTarget"), false);
  client.releaseDetach();
  await tabClose;
  assert.deepEqual(await listing, []);
  const opened = await opening;
  assert.equal(opened.url, "https://example.test/later");
});

test("closeTab orders later action, session close, and backend close", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  const inspection = await backend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);
  client.holdDetaches = true;
  const tabClose = backend.closeTab("work", "target-1");
  await client.detachStarted;
  const lateAction = backend.click(
    "work",
    "target-1",
    inspection.observationId,
    target.targetId,
  );
  const sessionClose = backend.closeSession("work");
  const backendClose = backend.close();
  await nextTurn();
  assert.equal(client.actionCount, 0);
  assert.equal(client.closeCount, 0);
  client.releaseDetach();
  await tabClose;
  await assert.rejects(lateAction, /detaching|closed/u);
  assert.equal(await sessionClose, 0);
  await backendClose;
  assert.equal(client.closeCount, 1);
});

test("lost createTarget reply is reconciled and retained for deterministic cleanup", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  client.rejectCreateAfterCreation = true;
  await assert.rejects(
    backend.open("work", "https://example.test/new"),
    /recovered provider target target-2/u,
  );
  await assert.rejects(
    backend.closeSession("work"),
    /outcome is unknown|tainted/u,
  );
  await assert.rejects(backend.close(), /outcome is unknown|tainted/u);
  assert.deepEqual(client.detachedTargets.sort(), ["target-1", "target-2"]);
  assert.deepEqual(client.closedTargets, []);
});

test("unreconciled create loss taints close while backend still disconnects", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  client.rejectCreateAfterCreation = true;
  client.failCreateRecovery = true;
  await assert.rejects(
    backend.open("work", "https://example.test/new"),
    /create outcome is unknown/u,
  );
  await assert.rejects(
    backend.close(),
    /outcome is unknown|backend is tainted/u,
  );
  assert.equal(client.closeCount, 1);
  assert.deepEqual(client.closedTargets, []);
});

test("open serializes list publication until the created target is navigated", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  client.holdNavigations = true;
  const opening = backend.open("work", "https://example.test/new");
  await client.navigationStarted;
  let listed = false;
  const listing = backend.listTabs("work").then((tabs) => {
    listed = true;
    return tabs;
  });
  await nextTurn();
  assert.equal(listed, false);
  client.releaseNavigation();
  const opened = await opening;
  assert.equal(opened.url, "https://example.test/new");
  const tabs = await listing;
  assert.ok(tabs.some((tab) => tab.tabId === opened.tabId));
  await backend.closeTab("work", opened.tabId);
});

test("two opens in one session dispatch and publish in order", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  client.holdNavigations = true;
  const first = backend.open("work", "https://example.test/first");
  await client.navigationStarted;
  const second = backend.open("work", "https://example.test/second");
  await nextTurn();
  assert.equal(
    client.calls.filter((call) => call === "Target.createTarget").length,
    1,
  );
  client.releaseNavigation();
  const [firstTab, secondTab] = await Promise.all([first, second]);
  assert.equal(firstTab.url, "https://example.test/first");
  assert.equal(secondTab.url, "https://example.test/second");
  assert.notEqual(firstTab.tabId, secondTab.tabId);
  assert.deepEqual(
    [...client.createdTargets.values()],
    ["https://example.test/first", "https://example.test/second"],
  );
});

test("a known read failure does not poison the operation tail", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  client.listFailureOnce = new Error("known list failure");
  await assert.rejects(backend.listTabs("work"), /known list failure/u);
  const tabs = await backend.listTabs("work");
  assert.equal(tabs[0]?.tabId, "target-1");
  assert.equal(await backend.closeSession("work"), 1);
});

test("marker-like user targets are never adopted across sessions", async () => {
  const client = new FakeUserBrowserClient();
  client.createdTargets.set(
    "user-owned",
    "about:blank#zenx-pending-user-owned",
  );
  const backend = new UserBrowserCdpBackend(client);
  const tabs = await backend.listTabs("work");
  assert.equal(
    tabs.some((tab) => tab.tabId === "user-owned"),
    false,
  );
  assert.equal(await backend.closeSession("work"), 1);
  assert.deepEqual(client.detachedTargets, ["target-1"]);
});

test("ambiguous duplicate create markers taint cleanup without adopting extras", async () => {
  const client = new FakeUserBrowserClient();
  client.duplicateCreatedMarker = true;
  const backend = new UserBrowserCdpBackend(client);
  await assert.rejects(
    backend.open("work", "https://example.test/new"),
    /marker reconciliation is ambiguous/u,
  );
  await assert.rejects(backend.closeSession("work"), /session is tainted/u);
  assert.deepEqual(client.detachedTargets, ["target-2"]);
  assert.equal(client.createdTargets.has("target-3"), true);
});

test("an exact create marker on a non-page target is ambiguous evidence", async () => {
  const client = new FakeUserBrowserClient();
  client.nonPageCreatedMarker = true;
  const backend = new UserBrowserCdpBackend(client);
  await assert.rejects(
    backend.open("work", "https://example.test/new"),
    /marker reconciliation is ambiguous/u,
  );
  await assert.rejects(
    backend.closeSession("work"),
    /outcome is unknown|tainted/u,
  );
  assert.deepEqual(client.closedTargets, []);
});

test("session-owned ignored-target and taint evidence is explicitly bounded", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  for (let index = 0; index < 128; index += 1) {
    const opened = await backend.open(
      "work",
      `https://example.test/bounded/${String(index)}`,
    );
    await backend.closeTab("work", opened.tabId);
  }
  const overflow = await backend.open(
    "work",
    "https://example.test/bounded/overflow",
  );
  await assert.rejects(
    backend.closeTab("work", overflow.tabId),
    /evidence exceeded its bound|tainted/u,
  );
  await assert.rejects(
    backend.closeSession("work"),
    /outcome is unknown|tainted/u,
  );
  await assert.rejects(backend.close(), /outcome is unknown|tainted/u);
  assert.deepEqual(client.closedTargets, []);
});

test("closeSession fences a pending open and waits until its created target is accounted for", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  client.holdCreates = true;
  const opened = backend.open("work", "https://example.test/new");
  await client.createStarted;

  let closed = false;
  const closing = backend.closeSession("work").then((count) => {
    closed = true;
    return count;
  });
  const lateListing = backend.listTabs("work");
  assert.equal(closed, false);
  client.releaseCreate();
  await opened;
  assert.equal(await closing, 2);
  await assert.rejects(lateListing, /session is detaching/u);
  assert.deepEqual(client.detachedTargets.sort(), ["target-1", "target-2"]);
});

test("caller abort after createTarget dispatch does not orphan an untracked target", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  client.holdCreates = true;
  const controller = new AbortController();
  const opened = backend.open(
    "work",
    "https://example.test/new",
    controller.signal,
  );
  await client.createStarted;
  controller.abort(new DOMException("cancelled", "AbortError"));
  client.releaseCreate();
  await assert.rejects(opened, /cancelled/u);
  await client.createSettled;
  await nextTurn();

  assert.ok(client.observedSignals.includes(controller.signal));
  assert.equal(await backend.closeSession("work"), 2);
  assert.deepEqual(client.detachedTargets.sort(), ["target-1", "target-2"]);
  assert.deepEqual(client.closedTargets, []);
});

test("backend close fences pending open before disconnecting CDP", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  client.holdCreates = true;
  const opened = backend.open("work", "https://example.test/new");
  await client.createStarted;
  let closed = false;
  const closing = backend.close().then(() => {
    closed = true;
  });
  assert.equal(closed, false);
  client.releaseCreate();
  await opened;
  await closing;
  assert.equal(client.closeCount, 1);
  assert.deepEqual(client.detachedTargets.sort(), ["target-1", "target-2"]);
  assert.deepEqual(client.closedTargets, []);
});

test("closeSession fences pending list and inspection publication", async () => {
  const listClient = new FakeUserBrowserClient();
  const listBackend = new UserBrowserCdpBackend(listClient);
  await listBackend.listTabs("work");
  listClient.holdListings = true;
  const listing = listBackend.listTabs("work");
  await listClient.listStarted;
  const listClose = listBackend.closeSession("work");
  listClient.releaseList();
  await listing;
  assert.equal(await listClose, 1);

  const inspectClient = new FakeUserBrowserClient();
  const inspectBackend = new UserBrowserCdpBackend(inspectClient);
  await inspectBackend.listTabs("work");
  inspectClient.holdInspections = true;
  const inspection = inspectBackend.inspect("work", "target-1");
  await inspectClient.inspectionStarted;
  const inspectClose = inspectBackend.closeSession("work");
  inspectClient.releaseInspection();
  await inspection;
  assert.equal(await inspectClose, 1);
});

test("external navigation makes an attached-tab observation fail closed", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  const inspection = await backend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);

  client.currentUrl = "https://example.test/other";
  client.documentToken = "document-b";
  await assert.rejects(
    backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    ),
    /document changed/u,
  );
  await assert.rejects(
    backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    ),
    /stale or unknown|tainted/u,
  );
});

test("listing after external navigation invalidates the old observation before dispatch", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  const inspection = await backend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);
  client.currentUrl = "https://example.test/other";
  await backend.listTabs("work");
  await assert.rejects(
    backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    ),
    /stale or unknown|tainted/u,
  );
  assert.equal(client.actionCount, 0);
});

test("cancelled action is outcome-unknown and its observation cannot be retried", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  const inspection = await backend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);
  client.holdActions = true;
  const controller = new AbortController();
  const action = backend.click(
    "work",
    "target-1",
    inspection.observationId,
    target.targetId,
    controller.signal,
  );
  await client.actionStarted;
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(action, /outcome is unknown/u);
  const queuedInspection = assert.rejects(
    backend.inspect("work", "target-1"),
    /tainted/u,
  );
  const queuedNavigation = assert.rejects(
    backend.navigate("work", "target-1", "https://example.test/retry"),
    /tainted/u,
  );
  await nextTurn();
  assert.equal(client.actionCount, 1);
  assert.equal(client.navigateCount, 0);
  await assert.rejects(
    backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    ),
    /stale or unknown|tainted/u,
  );
  client.releaseAction();
  await client.actionSettled;
  await queuedInspection;
  await queuedNavigation;
});

test("provider-owned lifecycle invalidates same-document history reload and activation observations", async () => {
  for (const lifecycle of [
    "pushState",
    "replaceState-same-url",
    "history-back-same-url-restoration",
    "reload",
    "bfcache-activation",
    "main-frame-navigation",
  ]) {
    const client = new FakeUserBrowserClient();
    const backend = new UserBrowserCdpBackend(client);
    await backend.listTabs("work");
    const inspection = await backend.inspect("work", "target-1");
    const target = inspection.targets[0];
    assert.ok(target);
    client.advanceDocument(lifecycle);
    await assert.rejects(
      backend.click(
        "work",
        "target-1",
        inspection.observationId,
        target.targetId,
      ),
      /document changed/u,
    );
    assert.equal(client.actionCount, 0, lifecycle);
  }
});

test("document identity changes during evaluate or post-confirmation are outcome-unknown", async () => {
  for (const phase of ["during-evaluate", "post-confirmation"] as const) {
    const client = new FakeUserBrowserClient();
    const backend = new UserBrowserCdpBackend(client);
    await backend.listTabs("work");
    const inspection = await backend.inspect("work", "target-1");
    const target = inspection.targets[0];
    assert.ok(target);
    client.identityChangePhase = phase;
    await assert.rejects(
      backend.click(
        "work",
        "target-1",
        inspection.observationId,
        target.targetId,
      ),
      /outcome is unknown/u,
      phase,
    );
    assert.equal(client.actionCount, 1, phase);
    await assert.rejects(backend.inspect("work", "target-1"), /tainted/u);
  }
});

test("inspection refuses publication when its execution document invalidates", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  client.invalidateInspection = true;
  await assert.rejects(
    backend.inspect("work", "target-1"),
    /document changed during inspection/u,
  );
});

test("target disappearance and disconnect are known before action dispatch", async () => {
  for (const failure of ["target disappeared", "CDP disconnected"]) {
    const client = new FakeUserBrowserClient();
    const backend = new UserBrowserCdpBackend(client);
    await backend.listTabs("work");
    const inspection = await backend.inspect("work", "target-1");
    const target = inspection.targets[0];
    assert.ok(target);
    client.identityFailure = new Error(failure);
    await assert.rejects(
      backend.click(
        "work",
        "target-1",
        inspection.observationId,
        target.targetId,
      ),
      new RegExp(failure, "u"),
    );
    assert.equal(client.actionCount, 0, failure);
    assert.equal(await backend.closeSession("work"), 1);
  }
});

test("post-confirmation cancellation retains the tab fence until confirmation settles", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  const inspection = await backend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);
  client.holdPostConfirmation = true;
  const controller = new AbortController();
  const action = backend.click(
    "work",
    "target-1",
    inspection.observationId,
    target.targetId,
    controller.signal,
  );
  await client.postConfirmationStarted;
  controller.abort();
  await assert.rejects(action, /outcome is unknown/u);
  const queuedInspection = assert.rejects(
    backend.inspect("work", "target-1"),
    /tainted/u,
  );
  const queuedNavigation = assert.rejects(
    backend.navigate("work", "target-1", "https://example.test/retry"),
    /tainted/u,
  );
  await nextTurn();
  assert.equal(client.navigateCount, 0);
  client.releasePostConfirmation();
  await client.postConfirmationSettled;
  await queuedInspection;
  await queuedNavigation;
  assert.equal(client.actionCount, 1);
});

test("navigate is exclusive and detach waits for an already dispatched action", async () => {
  const navigationClient = new FakeUserBrowserClient();
  const navigationBackend = new UserBrowserCdpBackend(navigationClient);
  await navigationBackend.listTabs("work");
  navigationClient.holdNavigations = true;
  const firstNavigate = navigationBackend.navigate(
    "work",
    "target-1",
    "https://example.test/next",
  );
  await navigationClient.navigationStarted;
  const secondNavigate = navigationBackend.navigate(
    "work",
    "target-1",
    "https://example.test/other",
  );
  assert.equal(navigationClient.navigateCount, 1);
  navigationClient.releaseNavigation();
  await firstNavigate;
  await secondNavigate;
  assert.equal(navigationClient.navigateCount, 2);

  const actionClient = new FakeUserBrowserClient();
  const actionBackend = new UserBrowserCdpBackend(actionClient);
  await actionBackend.listTabs("work");
  const inspection = await actionBackend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);
  actionClient.holdActions = true;
  const action = actionBackend.click(
    "work",
    "target-1",
    inspection.observationId,
    target.targetId,
  );
  await actionClient.actionStarted;
  let detached = false;
  const detach = actionBackend.closeSession("work").then((count) => {
    detached = true;
    return count;
  });
  const lateInspection = actionBackend.inspect("work", "target-1");
  const lateOpen = actionBackend.open("work", "https://example.test/late");
  assert.equal(detached, false);
  assert.equal(actionClient.actionCount, 1);
  assert.equal(actionClient.calls.includes("Target.createTarget"), false);
  actionClient.releaseAction();
  await action;
  assert.equal(await detach, 1);
  await assert.rejects(lateInspection, /session is detaching/u);
  await assert.rejects(lateOpen, /session is detaching/u);
  assert.equal(actionClient.actionCount, 1);
  assert.deepEqual(actionClient.closedTargets, []);
});

test("closeTab fences the tab immediately and waits for its held mutation", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  const inspection = await backend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);
  client.holdActions = true;
  const action = backend.click(
    "work",
    "target-1",
    inspection.observationId,
    target.targetId,
  );
  await client.actionStarted;
  let detached = false;
  const closeTab = backend.closeTab("work", "target-1").then(() => {
    detached = true;
  });
  const lateNavigation = backend.navigate(
    "work",
    "target-1",
    "https://example.test/late",
  );
  assert.equal(detached, false);
  assert.equal(client.navigateCount, 0);
  client.releaseAction();
  await action;
  await closeTab;
  await assert.rejects(lateNavigation, /detaching|closed/u);
  assert.equal(client.actionCount, 1);
  assert.deepEqual(client.closedTargets, []);
});

test("disconnect makes action outcome unknown and concurrent observation reuse dispatches once", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  const inspection = await backend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);
  client.holdActions = true;
  const first = backend.click(
    "work",
    "target-1",
    inspection.observationId,
    target.targetId,
  );
  await client.actionStarted;
  await assert.rejects(
    backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    ),
    /stale or unknown|already in flight/u,
  );
  client.rejectAction(new Error("CDP disconnected"));
  await assert.rejects(first, /outcome is unknown/u);
  assert.equal(client.actionCount, 1);
  await assert.rejects(
    backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    ),
    /stale or unknown|tainted/u,
  );
});

test("password and autocomplete metadata do not block ordinary text dispatch", async () => {
  for (const metadata of [
    { type: "password", autocomplete: "" },
    { type: "text", autocomplete: "current-password" },
    { type: "text", autocomplete: "new-password" },
    { type: "text", autocomplete: "one-time-code" },
  ]) {
    const client = new FakeUserBrowserClient();
    client.inspectionTarget = {
      ...client.inspectionTarget,
      ...metadata,
      actions: ["type"],
    };
    const backend = new UserBrowserCdpBackend(client);
    await backend.listTabs("work");
    const inspection = await backend.inspect("work", "target-1");
    const target = inspection.targets[0];
    assert.ok(target);
    await backend.type(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
      "ordinary argument",
      false,
    );
    assert.equal(client.actionCount, 1);
  }
});

test("user browser contract accepts only supported Chrome Edge or Chromium products", () => {
  assert.equal(
    validateUserBrowserVersion({ Browser: "Chrome/140.0.7339.1" }),
    "Chrome/140.0.7339.1",
  );
  assert.equal(
    validateUserBrowserVersion({ Browser: "Edg/140.0.7339.1" }),
    "Edg/140.0.7339.1",
  );
  assert.equal(
    validateUserBrowserVersion({ Browser: "Chromium/140.0.7339.1" }),
    "Chromium/140.0.7339.1",
  );
  assert.throws(
    () => validateUserBrowserVersion({ Browser: "Firefox/141.0" }),
    /supported Chrome, Edge, or Chromium/u,
  );
  assert.throws(
    () => validateUserBrowserVersion({ Browser: "Chrome/99.0.1.2" }),
    /supported Chrome, Edge, or Chromium/u,
  );
});

test("user browser attachment rejects remote or credential-bearing CDP endpoints", async () => {
  await assert.rejects(
    connectUserBrowserCdp("https://example.test:9222"),
    /unauthenticated loopback http/u,
  );
  await assert.rejects(
    connectUserBrowserCdp("http://user:secret@127.0.0.1:9222"),
    /unauthenticated loopback http/u,
  );
  await assert.rejects(
    connectUserBrowserCdp("http://localhost:9222"),
    /unauthenticated loopback http/u,
  );
});

test("user browser attachment binds the WebSocket to the probed HTTP authority", async () => {
  for (const mismatch of ["port", "host", "path"] as const) {
    let endpoint = "";
    let socketUrl = "";
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          Browser: "Chrome/140.0.1.2",
          webSocketDebuggerUrl: socketUrl,
        }),
      );
    });
    const port = await listen(server);
    endpoint = `http://127.0.0.1:${String(port)}`;
    socketUrl =
      mismatch === "port"
        ? "ws://127.0.0.1:1/devtools/browser/id"
        : mismatch === "host"
          ? `ws://127.0.0.2:${String(port)}/devtools/browser/id`
          : `ws://127.0.0.1:${String(port)}/not-a-browser-socket`;
    await assert.rejects(
      connectUserBrowserCdp(endpoint),
      /same loopback authority/u,
    );
    await close(server);
  }
});

test("user browser attachment rejects redirects and query-authenticated WebSockets", async () => {
  const redirect = createServer((_request, response) => {
    response.statusCode = 302;
    response.setHeader("location", "http://127.0.0.1:1/json/version");
    response.end();
  });
  const redirectPort = await listen(redirect);
  await assert.rejects(
    connectUserBrowserCdp(`http://127.0.0.1:${String(redirectPort)}`),
    /fetch|redirect|failed/u,
  );
  await close(redirect);

  let queryPort = 0;
  const querySocket = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        Browser: "Chrome/140.0.1.2",
        webSocketDebuggerUrl: `ws://127.0.0.1:${String(queryPort)}/devtools/browser/id?token=secret`,
      }),
    );
  });
  queryPort = await listen(querySocket);
  await assert.rejects(
    connectUserBrowserCdp(`http://127.0.0.1:${String(queryPort)}`),
    /same loopback authority/u,
  );
  await close(querySocket);
});

test("CDP target attachments detach, reap, and reattach after destroy and reconnect", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const first = await connectUserBrowserCdp(cdp.endpoint);
    assert.equal(cdp.count("Target.setDiscoverTargets"), 1);
    await first.backend.listTabs("one");
    await first.backend.inspect("one", "target-1");
    assert.equal(cdp.count("Target.attachToTarget"), 1);

    await first.backend.closeTab("one", "target-1");
    assert.equal(cdp.count("Target.detachFromTarget"), 1);
    assert.equal(cdp.count("Target.closeTarget"), 0);

    await first.backend.listTabs("two");
    await first.backend.inspect("two", "target-1");
    assert.equal(cdp.count("Target.attachToTarget"), 2);

    cdp.detachSession();
    await first.backend.listTabs("two");
    await first.backend.inspect("two", "target-1");
    assert.equal(cdp.count("Target.attachToTarget"), 3);

    cdp.destroyTarget("target-1");
    await first.backend.listTabs("two");
    await first.backend.inspect("two", "target-1");
    assert.equal(cdp.count("Target.attachToTarget"), 4);

    cdp.invalidateNextAttachment();
    cdp.detachSession();
    await first.backend.listTabs("two");
    await assert.rejects(
      first.backend.inspect("two", "target-1"),
      /detached during attachment/u,
    );
    await first.backend.inspect("two", "target-1");
    assert.equal(cdp.count("Target.attachToTarget"), 6);

    cdp.disconnect();
    await nextTurn();
    await assert.rejects(
      first.backend.inspect("two", "target-1"),
      /connection|unavailable|closed/u,
    );

    const second = await connectUserBrowserCdp(cdp.endpoint);
    await second.backend.listTabs("three");
    await second.backend.inspect("three", "target-1");
    assert.equal(cdp.count("Target.attachToTarget"), 7);
    await second.backend.closeSession("three");
    assert.equal(cdp.count("Target.detachFromTarget"), 2);
    await second.backend.close();
    assert.equal(cdp.count("Target.closeTarget"), 0);
  } finally {
    await cdp.close();
  }
});

test("frameStartedNavigating during evaluate or confirmation makes action outcome unknown", async () => {
  for (const phase of ["evaluate", "confirmation"] as const) {
    const cdp = await createFakeCdpServer();
    try {
      const connection = await connectUserBrowserCdp(cdp.endpoint);
      await connection.backend.listTabs("work");
      const inspection = await connection.backend.inspect("work", "target-1");
      const target = inspection.targets[0];
      assert.ok(target);
      cdp.invalidateActionAt(phase);
      await assert.rejects(
        connection.backend.click(
          "work",
          "target-1",
          inspection.observationId,
          target.targetId,
        ),
        /outcome is unknown/u,
        phase,
      );
      await assert.rejects(
        connection.backend.inspect("work", "target-1"),
        /tainted/u,
      );
    } finally {
      await cdp.close();
    }
  }
});

test("matching execution-context invalidation after action dispatch remains outcome-unknown and tainted", async () => {
  for (const event of [
    {
      method: "Runtime.executionContextDestroyed",
      params: { executionContextId: 100 },
    },
    { method: "Runtime.executionContextsCleared", params: {} },
    {
      method: "Runtime.executionContextCreated",
      params: {
        context: {
          id: 101,
          name: "__zenx_user_browser_document__",
          auxData: { frameId: "main", isDefault: false },
        },
      },
    },
  ]) {
    const cdp = await createFakeCdpServer();
    try {
      const connection = await connectUserBrowserCdp(cdp.endpoint);
      await connection.backend.listTabs("work");
      const inspection = await connection.backend.inspect("work", "target-1");
      const target = inspection.targets[0];
      assert.ok(target);
      const evaluationsBefore = cdp.count("Runtime.evaluate");
      cdp.invalidateActionAt("evaluate", event);
      await assert.rejects(
        connection.backend.click(
          "work",
          "target-1",
          inspection.observationId,
          target.targetId,
        ),
        /outcome is unknown/u,
        event.method,
      );
      assert.equal(cdp.count("Runtime.evaluate"), evaluationsBefore + 1);
      await assert.rejects(
        connection.backend.inspect("work", "target-1"),
        /tainted/u,
      );
    } finally {
      await cdp.close();
    }
  }
});

test("timed-out Runtime.evaluate retains detach until its late response settles", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    const inspection = await connection.backend.inspect("work", "target-1");
    const target = inspection.targets[0];
    assert.ok(target);
    cdp.holdNextActionReply();
    const action = connection.backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    );
    await cdp.heldActionStarted();
    await assert.rejects(action, /outcome is unknown/u);

    const closing = Promise.resolve(connection.backend.closeSession("work"));
    for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
    assert.equal(cdp.count("Target.detachFromTarget"), 0);
    cdp.releaseLateActionReply();
    await assert.rejects(closing, /outcome is unknown|tainted/u);
    assert.equal(cdp.actionResponseSent(), true);
    assert.equal(cdp.count("Target.detachFromTarget"), 1);
  } finally {
    await cdp.close();
  }
});

test("timed-out post-confirmation retains detach until its late response settles", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    const inspection = await connection.backend.inspect("work", "target-1");
    const target = inspection.targets[0];
    assert.ok(target);
    cdp.holdNextConfirmationReply();
    const action = connection.backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    );
    await cdp.heldConfirmationStarted();
    await assert.rejects(action, /outcome is unknown/u);

    const closing = Promise.resolve(connection.backend.closeSession("work"));
    for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
    assert.equal(cdp.count("Target.detachFromTarget"), 0);
    cdp.releaseLateConfirmationReply();
    await assert.rejects(closing, /outcome is unknown|tainted/u);
    assert.equal(cdp.confirmationResponseSent(), true);
    assert.equal(cdp.count("Target.detachFromTarget"), 1);
  } finally {
    await cdp.close();
  }
});

test("cancelled and invalidated dispatched action retains detach until late settlement", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    const inspection = await connection.backend.inspect("work", "target-1");
    const target = inspection.targets[0];
    assert.ok(target);
    cdp.invalidateActionAt("evaluate");
    cdp.holdNextActionReply();
    const controller = new AbortController();
    const action = connection.backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
      controller.signal,
    );
    await cdp.heldActionStarted();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(action, /outcome is unknown/u);

    const closing = Promise.resolve(connection.backend.closeSession("work"));
    for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
    assert.equal(cdp.count("Target.detachFromTarget"), 0);
    cdp.releaseLateActionReply();
    await assert.rejects(closing, /outcome is unknown|tainted/u);
    assert.equal(cdp.actionResponseSent(), true);
    assert.equal(cdp.count("Target.detachFromTarget"), 1);
  } finally {
    await cdp.close();
  }
});

test("missing late Runtime.evaluate settlement expires to explicit unknown without detach", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    const inspection = await connection.backend.inspect("work", "target-1");
    const target = inspection.targets[0];
    assert.ok(target);
    cdp.holdNextActionReply();
    const action = connection.backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    );
    await cdp.heldActionStarted();
    await assert.rejects(action, /outcome is unknown/u);

    await assert.rejects(
      async () => await connection.backend.closeSession("work"),
      /late settlement was not observed|outcome is unknown|tainted/u,
    );
    assert.equal(cdp.actionResponseSent(), false);
    assert.equal(cdp.count("Target.detachFromTarget"), 0);
  } finally {
    await cdp.close();
  }
});

test("document setup invalidation between frame tree and isolated world dispatches zero page code", async () => {
  for (const operation of ["inspect", "click", "type"] as const) {
    const cdp = await createFakeCdpServer();
    try {
      const connection = await connectUserBrowserCdp(cdp.endpoint);
      await connection.backend.listTabs("work");
      const inspection =
        operation === "inspect"
          ? undefined
          : await connection.backend.inspect("work", "target-1");
      const target = inspection?.targets[0];
      if (operation !== "inspect") assert.ok(target);
      const evaluationsBefore = cdp.count("Runtime.evaluate");
      cdp.invalidateSetupAt("after-frame-tree");
      const pending =
        operation === "inspect"
          ? connection.backend.inspect("work", "target-1")
          : operation === "click"
            ? connection.backend.click(
                "work",
                "target-1",
                inspection!.observationId,
                target!.targetId,
              )
            : connection.backend.type(
                "work",
                "target-1",
                inspection!.observationId,
                target!.targetId,
                "updated",
                false,
              );
      await assert.rejects(pending, /document changed|invalidated/u, operation);
      assert.equal(cdp.count("Runtime.evaluate"), evaluationsBefore, operation);
    } finally {
      await cdp.close();
    }
  }
});

test("main-frame loading before frame binding rejects inspect click and type without page code", async () => {
  for (const operation of ["inspect", "click", "type"] as const) {
    const cdp = await createFakeCdpServer();
    try {
      const connection = await connectUserBrowserCdp(cdp.endpoint);
      await connection.backend.listTabs("work");
      const inspection =
        operation === "inspect"
          ? undefined
          : await connection.backend.inspect("work", "target-1");
      const target = inspection?.targets[0];
      if (operation !== "inspect") assert.ok(target);
      const evaluationsBefore = cdp.count("Runtime.evaluate");
      cdp.invalidateSetupAt("before-frame-tree-response", {
        method: "Page.frameStartedLoading",
        params: { frameId: "main" },
      });
      const pending =
        operation === "inspect"
          ? connection.backend.inspect("work", "target-1")
          : operation === "click"
            ? connection.backend.click(
                "work",
                "target-1",
                inspection!.observationId,
                target!.targetId,
              )
            : connection.backend.type(
                "work",
                "target-1",
                inspection!.observationId,
                target!.targetId,
                "updated",
                false,
              );
      await assert.rejects(pending, /document changed|invalidated/u, operation);
      assert.equal(cdp.count("Runtime.evaluate"), evaluationsBefore, operation);
    } finally {
      await cdp.close();
    }
  }
});

test("subframe loading before frame binding does not invalidate inspect click or type", async () => {
  for (const operation of ["inspect", "click", "type"] as const) {
    const cdp = await createFakeCdpServer();
    try {
      const connection = await connectUserBrowserCdp(cdp.endpoint);
      await connection.backend.listTabs("work");
      const inspection =
        operation === "inspect"
          ? undefined
          : await connection.backend.inspect("work", "target-1");
      const target = inspection?.targets[0];
      if (operation !== "inspect") assert.ok(target);
      cdp.invalidateSetupAt("before-frame-tree-response", {
        method: "Page.frameStartedLoading",
        params: { frameId: "child" },
      });
      if (operation === "inspect") {
        const result = await connection.backend.inspect("work", "target-1");
        assert.match(result.visibleText, /Signed in as Alice/u);
      } else if (operation === "click") {
        await connection.backend.click(
          "work",
          "target-1",
          inspection!.observationId,
          target!.targetId,
        );
      } else {
        await connection.backend.type(
          "work",
          "target-1",
          inspection!.observationId,
          target!.targetId,
          "updated",
          false,
        );
      }
    } finally {
      await cdp.close();
    }
  }
});

test("isolated execution-context invalidation rejects inspect click and type without page code", async () => {
  const invalidations = [
    {
      name: "destroyed",
      method: "Runtime.executionContextDestroyed",
      params: { executionContextId: 100 },
    },
    {
      name: "cleared",
      method: "Runtime.executionContextsCleared",
      params: {},
    },
    {
      name: "replacement",
      method: "Runtime.executionContextCreated",
      params: {
        context: {
          id: 101,
          name: "__zenx_user_browser_document__",
          auxData: { frameId: "main", isDefault: false },
        },
      },
    },
  ];
  for (const invalidation of invalidations) {
    for (const operation of ["inspect", "click", "type"] as const) {
      const cdp = await createFakeCdpServer();
      try {
        const connection = await connectUserBrowserCdp(cdp.endpoint);
        await connection.backend.listTabs("work");
        const inspection =
          operation === "inspect"
            ? undefined
            : await connection.backend.inspect("work", "target-1");
        const target = inspection?.targets[0];
        if (operation !== "inspect") assert.ok(target);
        const evaluationsBefore = cdp.count("Runtime.evaluate");
        cdp.invalidateSetupAt("after-isolated-world", invalidation);
        const pending =
          operation === "inspect"
            ? connection.backend.inspect("work", "target-1")
            : operation === "click"
              ? connection.backend.click(
                  "work",
                  "target-1",
                  inspection!.observationId,
                  target!.targetId,
                )
              : connection.backend.type(
                  "work",
                  "target-1",
                  inspection!.observationId,
                  target!.targetId,
                  "updated",
                  false,
                );
        await assert.rejects(
          pending,
          /document changed|invalidated|execution context/u,
          `${invalidation.name}:${operation}`,
        );
        assert.equal(
          cdp.count("Runtime.evaluate"),
          evaluationsBefore,
          `${invalidation.name}:${operation}`,
        );
      } finally {
        await cdp.close();
      }
    }
  }
});

test("unrelated subframe execution-context events do not invalidate the main fence", async () => {
  for (const event of [
    {
      method: "Runtime.executionContextDestroyed",
      params: { executionContextId: 999 },
    },
    {
      method: "Runtime.executionContextCreated",
      params: {
        context: {
          id: 101,
          name: "__zenx_user_browser_document__",
          auxData: { frameId: "child", isDefault: false },
        },
      },
    },
  ]) {
    const cdp = await createFakeCdpServer();
    try {
      const connection = await connectUserBrowserCdp(cdp.endpoint);
      await connection.backend.listTabs("work");
      cdp.invalidateSetupAt("after-isolated-world", event);
      const inspection = await connection.backend.inspect("work", "target-1");
      assert.match(inspection.visibleText, /Signed in as Alice/u);
    } finally {
      await cdp.close();
    }
  }
});

test("document setup invalidation after isolated world response dispatches zero page code", async () => {
  for (const lifecycle of [
    {
      name: "same-url-pushState",
      method: "Page.navigatedWithinDocument",
      params: {
        frameId: "main",
        url: "https://example.test/account",
        navigationType: "historyApi",
      },
    },
    {
      name: "same-url-replaceState",
      method: "Page.navigatedWithinDocument",
      params: {
        frameId: "main",
        url: "https://example.test/account",
        navigationType: "historyApi",
      },
    },
    {
      name: "same-url-back-restoration",
      method: "Page.navigatedWithinDocument",
      params: {
        frameId: "main",
        url: "https://example.test/account",
        navigationType: "fragment",
      },
    },
    {
      name: "reload",
      method: "Page.frameStartedNavigating",
      params: {
        frameId: "main",
        url: "https://example.test/account",
        navigationType: "reload",
      },
    },
    {
      name: "main-frame-started-loading-after-bind",
      method: "Page.frameStartedLoading",
      params: { frameId: "main" },
    },
    {
      name: "main-frame-navigation",
      method: "Page.frameNavigated",
      params: {
        frame: {
          id: "main",
          loaderId: "loader-next",
          url: "https://example.test/next",
        },
      },
    },
    {
      name: "bfcache-restore",
      method: "Page.frameNavigated",
      params: {
        frame: {
          id: "main",
          loaderId: "loader",
          url: "https://example.test/account",
        },
        type: "BackForwardCacheRestore",
      },
    },
  ]) {
    const cdp = await createFakeCdpServer();
    try {
      const connection = await connectUserBrowserCdp(cdp.endpoint);
      await connection.backend.listTabs("work");
      cdp.invalidateSetupAt("after-isolated-world", lifecycle);
      await assert.rejects(
        connection.backend.inspect("work", "target-1"),
        /document changed|invalidated/u,
        lifecycle.name,
      );
      assert.equal(cdp.count("Runtime.evaluate"), 0, lifecycle.name);
    } finally {
      await cdp.close();
    }
  }
});

test("inspect click and type share the post-isolated-world dispatch fence", async () => {
  for (const operation of ["inspect", "click", "type"] as const) {
    const cdp = await createFakeCdpServer();
    try {
      const connection = await connectUserBrowserCdp(cdp.endpoint);
      await connection.backend.listTabs("work");
      const inspection =
        operation === "inspect"
          ? undefined
          : await connection.backend.inspect("work", "target-1");
      const target = inspection?.targets[0];
      if (operation !== "inspect") assert.ok(target);
      const evaluationsBefore = cdp.count("Runtime.evaluate");
      cdp.invalidateSetupAt("after-isolated-world");
      const pending =
        operation === "inspect"
          ? connection.backend.inspect("work", "target-1")
          : operation === "click"
            ? connection.backend.click(
                "work",
                "target-1",
                inspection!.observationId,
                target!.targetId,
              )
            : connection.backend.type(
                "work",
                "target-1",
                inspection!.observationId,
                target!.targetId,
                "updated",
                false,
              );
      await assert.rejects(pending, /document changed|invalidated/u, operation);
      assert.equal(cdp.count("Runtime.evaluate"), evaluationsBefore, operation);
    } finally {
      await cdp.close();
    }
  }
});

test("detach destroy inspector detach and disconnect across setup reject before page code", async () => {
  for (const event of [
    {
      method: "Target.detachedFromTarget",
      params: {},
      expected: /document changed|detached/u,
    },
    {
      method: "Target.targetDestroyed",
      params: { targetId: "target-1" },
      expected: /document changed|disappeared/u,
    },
    {
      method: "Inspector.detached",
      params: { reason: "target_closed" },
      expected: /document changed|detached/u,
    },
    {
      method: "__disconnect",
      params: {},
      expected: /connection|closed|unavailable/u,
    },
  ]) {
    for (const phase of ["after-frame-tree", "after-isolated-world"] as const) {
      const cdp = await createFakeCdpServer();
      try {
        const connection = await connectUserBrowserCdp(cdp.endpoint);
        await connection.backend.listTabs("work");
        cdp.invalidateSetupAt(phase, event);
        await assert.rejects(
          connection.backend.inspect("work", "target-1"),
          event.expected,
          `${event.method}:${phase}`,
        );
        assert.equal(
          cdp.count("Runtime.evaluate"),
          0,
          `${event.method}:${phase}`,
        );
      } finally {
        await cdp.close();
      }
    }
  }
});

test("subframe setup lifecycle does not invalidate the main document fence", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    cdp.invalidateSetupAt("after-frame-tree", {
      method: "Page.frameStartedNavigating",
      params: {
        frameId: "child",
        url: "https://example.test/frame",
        navigationType: "differentDocument",
      },
    });
    const inspection = await connection.backend.inspect("work", "target-1");
    assert.match(inspection.visibleText, /Signed in as Alice/u);
    assert.equal(cdp.count("Runtime.evaluate"), 2);
  } finally {
    await cdp.close();
  }
});

test("repeated setup invalidations retire their fences without unbounded live state", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    for (let index = 0; index < 64; index += 1) {
      cdp.invalidateSetupAt(
        index % 2 === 0 ? "after-frame-tree" : "after-isolated-world",
      );
      await assert.rejects(
        connection.backend.inspect("work", "target-1"),
        /document changed|invalidated/u,
      );
    }
    assert.equal(cdp.count("Runtime.evaluate"), 0);
    const inspection = await connection.backend.inspect("work", "target-1");
    assert.match(inspection.visibleText, /Signed in as Alice/u);
    assert.equal(cdp.count("Runtime.evaluate"), 2);
    await connection.backend.closeSession("work");
    await connection.backend.close();
  } finally {
    await cdp.close();
  }
});

test("repeated isolated-context invalidations remain bounded and recover", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    for (let index = 0; index < 64; index += 1) {
      cdp.invalidateSetupAt("after-isolated-world", {
        method: "Runtime.executionContextDestroyed",
        params: { executionContextId: 100 },
      });
      await assert.rejects(
        connection.backend.inspect("work", "target-1"),
        /document changed|invalidated|execution context/u,
      );
    }
    assert.equal(cdp.count("Runtime.evaluate"), 0);
    const inspection = await connection.backend.inspect("work", "target-1");
    assert.match(inspection.visibleText, /Signed in as Alice/u);
    assert.equal(cdp.count("Runtime.evaluate"), 2);
  } finally {
    await cdp.close();
  }
});

test("settled late isolated-context invalidation does not poison recovery", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    cdp.invalidateSetupAt("before-post-isolated-world-barrier-response", {
      method: "Runtime.executionContextDestroyed",
      params: { executionContextId: 100 },
    });
    await assert.rejects(
      connection.backend.inspect("work", "target-1"),
      /document changed|invalidated|execution context/u,
    );
    assert.equal(cdp.count("Runtime.evaluate"), 0);

    const inspection = await connection.backend.inspect("work", "target-1");
    assert.match(inspection.visibleText, /Signed in as Alice/u);
    assert.equal(cdp.count("Runtime.evaluate"), 2);
  } finally {
    await cdp.close();
  }
});

test("Windows browser discovery covers machine and per-user Chrome Edge and Chromium", () => {
  const candidates = windowsBrowserExecutableCandidates({
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  });
  assert.ok(
    candidates.includes(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ),
  );
  assert.ok(
    candidates.includes(
      "C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
    ),
  );
  assert.ok(
    candidates.includes("C:\\Program Files\\Chromium\\Application\\chrome.exe"),
  );
  assert.ok(
    candidates.includes(
      "C:\\Users\\me\\AppData\\Local\\Chromium\\Application\\chrome.exe",
    ),
  );
});

test("tainted mutation survives target disappearance and map cleanup", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  client.navigateFailureOnce = new Error("navigate outcome was lost");
  await assert.rejects(
    backend.navigate("work", "target-1", "https://example.test/lost"),
    /outcome is unknown/u,
  );
  client.primaryTargetPresent = false;
  await assert.rejects(backend.listTabs("work"), /outcome is unknown|tainted/u);
  assert.deepEqual(client.detachedTargets, ["target-1"]);
  await assert.rejects(
    backend.closeSession("work"),
    /outcome is unknown|tainted/u,
  );
  await assert.rejects(backend.close(), /outcome is unknown|tainted/u);
});

test("logical user-browser session admission is explicitly bounded", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  const sessionIds = Array.from(
    { length: 32 },
    (_, index) => `bounded-session-${String(index)}`,
  );
  for (const sessionId of sessionIds) await backend.listTabs(sessionId);
  await assert.rejects(
    backend.listTabs("bounded-session-overflow"),
    /session.*bound|capacity/u,
  );
  for (const sessionId of sessionIds) await backend.closeSession(sessionId);
  await backend.listTabs("bounded-session-after-close");
  await backend.closeSession("bounded-session-after-close");
  await backend.close();
});

class FakeUserBrowserClient implements UserBrowserCdpClient {
  captureScreenshot?: UserBrowserCdpClient["captureScreenshot"];
  actionCount = 0;
  navigateCount = 0;
  closeCount = 0;
  readonly closedTargets: string[] = [];
  readonly detachedTargets: string[] = [];
  readonly calls: string[] = [];
  readonly observedSignals: AbortSignal[] = [];
  currentUrl = "https://example.test/account";
  primaryTargetPresent = true;
  documentToken = "document-a";
  identityFailure?: Error;
  listFailureOnce?: Error;
  navigateFailureOnce?: Error;
  actionUnknownSettlement?: Promise<void>;
  holdActions = false;
  holdNavigations = false;
  holdPostConfirmation = false;
  holdCreates = false;
  holdListings = false;
  holdInspections = false;
  holdDetaches = false;
  detachFailure?: Error;
  rejectCreateAfterCreation = false;
  failCreateRecovery = false;
  duplicateCreatedMarker = false;
  nonPageCreatedMarker = false;
  createdUrl?: string;
  readonly createdTargets = new Map<string, string>();
  nextCreatedTarget = 2;
  identityChangePhase?: "during-evaluate" | "post-confirmation";
  invalidateInspection = false;
  inspectionTarget = {
    selector: "#continue",
    tag: "button",
    role: "button",
    name: "Continue",
    type: "",
    id: "continue",
    fieldName: "",
    autocomplete: "",
    href: "",
    actions: ["click"] as Array<"click" | "type">,
  };
  readonly #actionStarted = deferred<void>();
  #heldAction = deferred<void>();
  readonly #actionSettled = deferred<void>();
  readonly #navigationStarted = deferred<void>();
  readonly #heldNavigation = deferred<void>();
  readonly #postConfirmationStarted = deferred<void>();
  readonly #heldPostConfirmation = deferred<void>();
  readonly #postConfirmationSettled = deferred<void>();
  readonly #createStarted = deferred<void>();
  readonly #heldCreate = deferred<void>();
  readonly #createSettled = deferred<void>();
  readonly #listStarted = deferred<void>();
  readonly #heldList = deferred<void>();
  readonly #inspectionStarted = deferred<void>();
  readonly #heldInspection = deferred<void>();
  readonly #detachStarted = deferred<void>();
  readonly #heldDetach = deferred<void>();

  get actionStarted(): Promise<void> {
    return this.#actionStarted.promise;
  }

  get actionSettled(): Promise<void> {
    return this.#actionSettled.promise;
  }

  get navigationStarted(): Promise<void> {
    return this.#navigationStarted.promise;
  }

  get postConfirmationStarted(): Promise<void> {
    return this.#postConfirmationStarted.promise;
  }

  get postConfirmationSettled(): Promise<void> {
    return this.#postConfirmationSettled.promise;
  }

  get createStarted(): Promise<void> {
    return this.#createStarted.promise;
  }

  get createSettled(): Promise<void> {
    return this.#createSettled.promise;
  }

  get listStarted(): Promise<void> {
    return this.#listStarted.promise;
  }

  get inspectionStarted(): Promise<void> {
    return this.#inspectionStarted.promise;
  }

  get detachStarted(): Promise<void> {
    return this.#detachStarted.promise;
  }

  advanceDocument(reason: string): void {
    this.documentToken = `${this.documentToken}:${reason}`;
  }

  releaseAction(): void {
    this.#heldAction.resolve();
  }

  releaseNavigation(): void {
    this.#heldNavigation.resolve();
  }

  releasePostConfirmation(): void {
    this.#heldPostConfirmation.resolve();
  }

  releaseCreate(): void {
    this.#heldCreate.resolve();
  }

  releaseList(): void {
    this.#heldList.resolve();
  }

  releaseInspection(): void {
    this.#heldInspection.resolve();
  }

  releaseDetach(): void {
    this.#heldDetach.resolve();
  }

  rejectAction(error: Error): void {
    this.#heldAction.reject(error);
  }

  async listTargets(signal?: AbortSignal) {
    if (signal !== undefined) this.observedSignals.push(signal);
    this.calls.push("Target.getTargets");
    if (this.listFailureOnce !== undefined) {
      const error = this.listFailureOnce;
      this.listFailureOnce = undefined;
      throw error;
    }
    if (this.holdListings) {
      this.#listStarted.resolve();
      await this.#heldList.promise;
      this.holdListings = false;
    }
    if (this.holdPostConfirmation && this.actionCount > 0) {
      this.#postConfirmationStarted.resolve();
      await this.#heldPostConfirmation.promise;
      this.#postConfirmationSettled.resolve();
      this.holdPostConfirmation = false;
    }
    return [
      ...(this.primaryTargetPresent
        ? [
            {
              targetId: "target-1",
              type: "page",
              title: "Account",
              url: this.currentUrl,
            },
          ]
        : []),
      ...[...this.createdTargets].map(([targetId, url]) => ({
        targetId,
        type: "page",
        title: "",
        url,
      })),
    ];
  }

  async createTarget(url: string, signal?: AbortSignal) {
    if (signal !== undefined) this.observedSignals.push(signal);
    this.calls.push("Target.createTarget");
    this.createdUrl = url;
    const targetId = `target-${String(this.nextCreatedTarget++)}`;
    this.createdTargets.set(targetId, url);
    if (this.duplicateCreatedMarker) {
      const duplicateId = `target-${String(this.nextCreatedTarget++)}`;
      this.createdTargets.set(duplicateId, url);
    }
    if (this.nonPageCreatedMarker) {
      this.createdTargets.set("worker-marker", url);
    }
    if (this.holdCreates) {
      this.#createStarted.resolve();
      await this.#heldCreate.promise;
      this.#createSettled.resolve();
      this.holdCreates = false;
    }
    if (this.rejectCreateAfterCreation) throw new Error("CDP response lost");
    return targetId;
  }

  async findTargetsByUrl(url: string, signal?: AbortSignal) {
    if (signal !== undefined) this.observedSignals.push(signal);
    if (this.failCreateRecovery) return [];
    return [...this.createdTargets]
      .filter(([, targetUrl]) => targetUrl === url)
      .map(([targetId]) => ({
        targetId,
        type: targetId === "worker-marker" ? "worker" : "page",
        title: "",
        url,
      }));
  }

  async detachTarget(targetId: string) {
    this.calls.push("Target.detachFromTarget");
    this.detachedTargets.push(targetId);
    if (this.holdDetaches) {
      this.#detachStarted.resolve();
      await this.#heldDetach.promise;
    }
    if (this.detachFailure !== undefined) throw this.detachFailure;
  }

  closureProblem(): string | undefined {
    return undefined;
  }

  async navigate(
    targetId: string,
    url: string,
    _owner: {
      logicalSessionId: string;
      logicalSessionIncarnation: number;
    },
    signal?: AbortSignal,
    onDispatched?: () => void,
  ) {
    if (signal !== undefined) this.observedSignals.push(signal);
    onDispatched?.();
    this.calls.push("Page.navigate");
    this.navigateCount += 1;
    if (this.holdNavigations) {
      this.#navigationStarted.resolve();
      await this.#heldNavigation.promise;
    }
    if (this.navigateFailureOnce !== undefined) {
      const error = this.navigateFailureOnce;
      this.navigateFailureOnce = undefined;
      throw new UserBrowserMutationOutcomeUnknownError(
        "Page.navigate",
        error.message,
      );
    }
    this.createdTargets.set(targetId, url);
  }

  async evaluateDocument(
    _targetId: string,
    expression: string,
    _owner: {
      logicalSessionId: string;
      logicalSessionIncarnation: number;
    },
    expectedDocumentIdentity?: string,
    _signal?: AbortSignal,
    onDispatched?: () => void,
  ): Promise<{ value: unknown; documentIdentity: string }> {
    this.calls.push("Runtime.evaluate");
    if (this.identityFailure !== undefined) throw this.identityFailure;
    const before = this.documentToken;
    if (
      expectedDocumentIdentity !== undefined &&
      before !== expectedDocumentIdentity
    ) {
      throw new UserBrowserDocumentChangedBeforeDispatchError();
    }
    if (!expression.includes("const expected =")) {
      if (this.holdInspections) {
        this.#inspectionStarted.resolve();
        await this.#heldInspection.promise;
        this.holdInspections = false;
      }
      const result = {
        value: {
          visibleText: "Signed in as Alice",
          targets: [this.inspectionTarget],
        },
        documentIdentity: this.documentToken,
      };
      if (this.invalidateInspection) {
        this.advanceDocument("inspection-evaluate");
        throw new UserBrowserDocumentChangedAfterDispatchError();
      }
      return result;
    }
    onDispatched?.();
    this.actionCount += 1;
    if (this.actionUnknownSettlement !== undefined) {
      throw new UserBrowserMutationOutcomeUnknownError(
        "Runtime.evaluate",
        "response remains pending",
        this.actionUnknownSettlement,
      );
    }
    if (this.identityChangePhase === "during-evaluate") {
      this.advanceDocument("during-evaluate");
    }
    if (this.holdActions) {
      this.#actionStarted.resolve();
      try {
        await this.#heldAction.promise;
      } catch (error) {
        throw new UserBrowserMutationOutcomeUnknownError(
          "Runtime.evaluate",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        this.#actionSettled.resolve();
      }
    }
    const response = { ok: true };
    if (this.identityChangePhase === "post-confirmation") {
      queueMicrotask(() => this.advanceDocument("post-confirmation"));
    }
    await nextTurn();
    if (this.documentToken !== before) {
      throw new UserBrowserDocumentChangedAfterDispatchError();
    }
    return { value: response, documentIdentity: this.documentToken };
  }

  async getDocumentIdentity() {
    return this.documentToken;
  }

  async close() {
    this.closeCount += 1;
  }
}
