import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserZenXCapabilityPackage,
  type BrowserInspection,
  type BrowserTabSummary,
  type BrowserLiveObservationEvent,
} from "../src/main/capabilities/browser-provider.js";
import type { BrowserThreadEvent } from "../src/main/capabilities/browser-thread-observation.js";
import { connectUserBrowserCdp } from "../src/main/capabilities/user-browser-provider.js";
import {
  createFakeCdpServer,
  nextTurn,
  waitUntil,
} from "./fixtures/user-browser-cdp.js";

const fakeImageDecoder = async (encoded: Buffer) => ({
  isEmpty: () => false,
  getSize: () => ({ width: 800, height: 600 }),
  resize: () => {
    throw new Error("fixture does not resize");
  },
  toJPEG: () => encoded,
});

test("confirmed release retires a failed public session without replaying its unknown action", async () => {
  const cdp = await createFakeCdpServer();
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  const capability = new BrowserZenXCapabilityPackage(connection.backend);
  const events: BrowserThreadEvent[] = [];
  const stopCatalog = capability.observeThread(
    { threadId: "thread", frames: false },
    (event) => events.push(event),
  );
  const invoke = (
    name: string,
    args: Record<string, unknown> = {},
    signal = new AbortController().signal,
  ) =>
    capability.invoke(name, {
      name,
      callId: name,
      threadId: "thread",
      cwd: process.cwd(),
      arguments: { sessionId: "task", observe: false, ...args },
      signal,
    });
  try {
    const tabs = (await invoke("browser_list_tabs")) as BrowserTabSummary[];
    const tabId = tabs[0]!.tabId;
    const before = (await invoke("browser_inspect", {
      tabId,
    })) as BrowserInspection;
    const oldAttachment = cdp.latestSessionId();
    cdp.holdNextActionReply();
    const controller = new AbortController();
    const action = invoke(
      "browser_click",
      {
        tabId,
        observationId: before.observationId,
        targetId: before.targets[0]!.targetId,
      },
      controller.signal,
    );
    await cdp.heldActionStarted();
    const expression = cdp.requests("Runtime.evaluate").at(-1)!.expression;
    controller.abort();
    await assert.rejects(action, /outcome is unknown/u);
    const closing = invoke("browser_close_session");
    const receipt = assert.rejects(closing, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "BrowserSessionReleasedWithUnknownEffectsError");
      assert.match(error.message, /session was released/u);
      assert.match(error.message, /earlier.*outcome is unknown/u);
      assert.match(error.message, /do not repeat/u);
      assert.doesNotMatch(error.message, /session close outcome is unknown/u);
      return true;
    });
    await nextTurn();
    assert.equal(cdp.count("Target.detachFromTarget"), 0);
    cdp.releaseLateActionReply();
    await receipt;
    assert.equal(cdp.count("Target.detachFromTarget"), 1);
    assert.deepEqual(cdp.detachedSessionIds(), [oldAttachment]);
    const ended = events.findLast((event) => event.type === "turn-ended");
    assert.equal(ended?.type, "turn-ended");
    if (ended?.type === "turn-ended") {
      assert.equal(ended.failed, true);
      assert.match(ended.message ?? "", /session was released/u);
      assert.match(ended.message ?? "", /earlier.*outcome is unknown/u);
    }
    const cleared = events.findLast((event) => event.type === "targets");
    assert.equal(cleared?.type, "targets");
    if (cleared?.type === "targets") {
      assert.deepEqual(cleared.targets, []);
      assert.equal(cleared.selectedId, undefined);
    }

    await invoke("browser_list_tabs");
    const after = (await invoke("browser_inspect", {
      tabId,
    })) as BrowserInspection;
    assert.notEqual(cdp.latestSessionId(), oldAttachment);
    assert.notEqual(after.observationId, before.observationId);
    await assert.rejects(
      invoke("browser_click", {
        tabId,
        observationId: before.observationId,
        targetId: before.targets[0]!.targetId,
      }),
      /expired|stale|unknown/u,
    );
    assert.equal(
      cdp
        .requests("Runtime.evaluate")
        .filter((request) => request.expression === expression).length,
      1,
    );
    assert.equal(
      cdp.count("Target.closeTarget"),
      0,
      "a pre-existing human page is never closed",
    );
  } finally {
    stopCatalog();
    // The original unknown-effect receipt remains recorded even after a fresh session.
    await capability.close().catch(() => undefined);
    await cdp.close();
  }
});

test("successful explicit close publishes a confirmed receipt and clears the old product target", async () => {
  const cdp = await createFakeCdpServer();
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  const capability = new BrowserZenXCapabilityPackage(connection.backend);
  const events: BrowserThreadEvent[] = [];
  const stopCatalog = capability.observeThread(
    { threadId: "thread", frames: false },
    (event) => events.push(event),
  );
  const invoke = (name: string) =>
    capability.invoke(name, {
      name,
      callId: name,
      threadId: "thread",
      cwd: process.cwd(),
      arguments: { sessionId: "task", observe: false },
      signal: new AbortController().signal,
    });
  try {
    await invoke("browser_list_tabs");
    const before = events.findLast((event) => event.type === "targets");
    assert.equal(before?.type, "targets");
    if (before?.type === "targets") assert.equal(before.targets.length, 1);
    assert.deepEqual(await invoke("browser_close_session"), {
      closed: true,
      sessionId: "task",
    });
    const ended = events.findLast((event) => event.type === "turn-ended");
    assert.equal(ended?.type, "turn-ended");
    if (ended?.type === "turn-ended") assert.equal(ended.failed, false);
    const cleared = events.findLast((event) => event.type === "targets");
    assert.equal(cleared?.type, "targets");
    if (cleared?.type === "targets") assert.deepEqual(cleared.targets, []);
    assert.equal(cdp.count("Target.closeTarget"), 0);
  } finally {
    stopCatalog();
    await capability.close();
    await cdp.close();
  }
});

test("closing a session stops live reads before its unsettled action can release", async () => {
  const cdp = await createFakeCdpServer();
  const connection = await connectUserBrowserCdp(cdp.endpoint, undefined, {
    liveFrameImageDecoder: fakeImageDecoder,
  });
  const events: BrowserLiveObservationEvent[] = [];
  try {
    await connection.backend.listTabs("work");
    const inspected = await connection.backend.inspect("work", "target-1");
    const stop = connection.backend.observeTab!("work", "target-1", (event) =>
      events.push(event),
    );
    await waitUntil(() => cdp.count("Page.startScreencast") === 1);
    cdp.holdNextActionReply();
    const controller = new AbortController();
    const action = connection.backend.click(
      "work",
      "target-1",
      inspected.observationId,
      inspected.targets[0]!.targetId,
      controller.signal,
    );
    await cdp.heldActionStarted();
    controller.abort();
    await assert.rejects(action, /outcome is unknown/u);
    const closing = Promise.resolve(connection.backend.closeSession("work"));
    const receipt = assert.rejects(closing, /outcome is unknown/u);
    assert.deepEqual(events.at(-1), {
      type: "status",
      status: "unavailable",
      message:
        "Live observation stopped because browser session cleanup was requested.",
    });
    await waitUntil(() => cdp.count("Page.stopScreencast") === 1);
    assert.equal(cdp.count("Target.detachFromTarget"), 0);
    const count = events.length;
    cdp.emitTargetInfoChanged(
      "target-1",
      "Late private title",
      "https://example.test/late",
    );
    cdp.emitScreencastFrame("late frame", 999);
    await nextTurn();
    assert.equal(
      events.length,
      count,
      "no metadata or frame from the retiring session reaches the observer",
    );
    cdp.releaseLateActionReply();
    await receipt;
    stop();
  } finally {
    cdp.releaseLateActionReply();
    await Promise.resolve(connection.backend.close()).catch(() => undefined);
    await cdp.close();
  }
});

test("finishing a session with a temporary page stops live reads before queued cleanup", async () => {
  const cdp = await createFakeCdpServer({ closeTargetsWithoutEvents: true });
  const connection = await connectUserBrowserCdp(cdp.endpoint, undefined, {
    liveFrameImageDecoder: fakeImageDecoder,
  });
  try {
    const tab = await connection.backend.open(
      "work",
      "https://example.test/temporary",
    );
    const inspected = await connection.backend.inspect("work", tab.tabId);
    const events: BrowserLiveObservationEvent[] = [];
    connection.backend.observeTab!("work", tab.tabId, (event) =>
      events.push(event),
    );
    await waitUntil(() => cdp.count("Page.startScreencast") === 1);
    cdp.holdNextActionReply();
    const controller = new AbortController();
    const action = connection.backend.click(
      "work",
      tab.tabId,
      inspected.observationId,
      inspected.targets[0]!.targetId,
      controller.signal,
    );
    await cdp.heldActionStarted();
    controller.abort();
    await assert.rejects(action, /outcome is unknown/u);
    const closing = Promise.resolve(connection.backend.finishSession!("work"));
    const receipt = assert.rejects(closing, /earlier.*outcome is unknown/u);
    assert.deepEqual(events.at(-1), {
      type: "status",
      status: "unavailable",
      message:
        "Live observation stopped because browser session cleanup was requested.",
    });
    await waitUntil(() => cdp.count("Page.stopScreencast") === 1);
    assert.equal(cdp.count("Target.closeTarget"), 0);
    cdp.releaseLateActionReply();
    await receipt;
    assert.equal(
      cdp.count("Target.closeTarget"),
      1,
      "only the known temporary page is disposable",
    );
  } finally {
    cdp.releaseLateActionReply();
    await Promise.resolve(connection.backend.close()).catch(() => undefined);
    await cdp.close();
  }
});

test("unknown detach keeps the public lease fail-closed while stopping live reads", async () => {
  const cdp = await createFakeCdpServer();
  const connection = await connectUserBrowserCdp(cdp.endpoint, undefined, {
    liveFrameImageDecoder: fakeImageDecoder,
  });
  const capability = new BrowserZenXCapabilityPackage(connection.backend);
  const events: BrowserThreadEvent[] = [];
  const stopCatalog = capability.observeThread(
    { threadId: "thread", frames: false },
    (event) => events.push(event),
  );
  const invoke = (name: string, args: Record<string, unknown> = {}) =>
    capability.invoke(name, {
      name,
      callId: name,
      threadId: "thread",
      cwd: process.cwd(),
      arguments: { sessionId: "task", observe: false, ...args },
      signal: new AbortController().signal,
    });
  try {
    const tabs = (await invoke("browser_list_tabs")) as BrowserTabSummary[];
    await invoke("browser_inspect", { tabId: tabs[0]!.tabId });
    const target = events
      .flatMap((event) => (event.type === "targets" ? event.targets : []))
      .at(-1)!;
    const liveEvents: BrowserThreadEvent[] = [];
    const stopLive = capability.observeThread(
      { threadId: "thread", frames: true, targetId: target.id },
      (event) => liveEvents.push(event),
    );
    await waitUntil(() => cdp.count("Page.startScreencast") === 1);
    cdp.dropNextDetachReply();
    await assert.rejects(invoke("browser_close_session"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.notEqual(
        error.name,
        "BrowserSessionReleasedWithUnknownEffectsError",
      );
      assert.match(error.message, /detach.*outcome is unknown/u);
      return true;
    });
    await waitUntil(() => cdp.count("Page.stopScreencast") === 1);
    assert.deepEqual(liveEvents.at(-1), {
      type: "status",
      status: "unavailable",
      message:
        "Live observation stopped because browser session cleanup was requested.",
    });
    await assert.rejects(
      invoke("browser_list_tabs"),
      /outcome is unknown|tainted/u,
    );
    assert.equal(
      cdp.count("Target.attachToTarget"),
      1,
      "no successor lease can silently attach after uncertain cleanup",
    );
    const latest = events.filter((event) => event.type === "targets").at(-1)!;
    assert.equal(latest.type, "targets");
    if (latest.type === "targets")
      assert.equal(latest.targets[0]!.id, target.id);
    assert.equal(
      events.some((event) => event.type === "turn-ended"),
      false,
    );
    const count = liveEvents.length;
    cdp.emitTargetInfoChanged(
      "target-1",
      "Late synthetic metadata",
      "https://example.test/late",
    );
    await nextTurn();
    assert.equal(
      liveEvents.length,
      count,
      "failed close cannot leak later metadata",
    );
    stopLive();
    assert.equal(cdp.count("Target.closeTarget"), 0);
  } finally {
    stopCatalog();
    await capability.close().catch(() => undefined);
    await cdp.close();
  }
});

test("failed temporary-page cleanup never becomes a confirmed release receipt", async () => {
  const cdp = await createFakeCdpServer();
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  const capability = new BrowserZenXCapabilityPackage(connection.backend);
  const invoke = (
    name: string,
    args: Record<string, unknown> = {},
    signal = new AbortController().signal,
  ) =>
    capability.invoke(name, {
      name,
      callId: name,
      threadId: "thread",
      cwd: process.cwd(),
      arguments: { sessionId: "task", observe: false, ...args },
      signal,
    });
  cdp.interceptRequests((request, emit) => {
    if (request.method === "Target.closeTarget")
      emit({
        id: request.id,
        error: {
          code: -32000,
          message: "Synthetic temporary-page cleanup failure",
        },
      });
  });
  try {
    const tab = (await invoke("browser_open", {
      url: "https://example.test/temporary",
    })) as BrowserTabSummary;
    const inspected = (await invoke("browser_inspect", {
      tabId: tab.tabId,
    })) as BrowserInspection;
    cdp.holdNextActionReply();
    const controller = new AbortController();
    const action = invoke(
      "browser_click",
      {
        tabId: tab.tabId,
        observationId: inspected.observationId,
        targetId: inspected.targets[0]!.targetId,
      },
      controller.signal,
    );
    await cdp.heldActionStarted();
    controller.abort();
    await assert.rejects(action, /outcome is unknown/u);
    const closing = invoke("browser_close_session");
    const receipt = assert.rejects(closing, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.notEqual(
        error.name,
        "BrowserSessionReleasedWithUnknownEffectsError",
      );
      assert.match(error.message, /temporary.page cleanup/u);
      return true;
    });
    await nextTurn();
    assert.equal(cdp.count("Target.closeTarget"), 0);
    cdp.releaseLateActionReply();
    await receipt;
    assert.equal(cdp.count("Target.closeTarget"), 1);
    assert.equal(cdp.count("Target.detachFromTarget"), 1);
    await assert.rejects(
      invoke("browser_list_tabs"),
      /outcome is unknown|tainted/u,
    );
    assert.equal(cdp.count("Target.attachToTarget"), 1);
  } finally {
    cdp.releaseLateActionReply();
    await capability.close().catch(() => undefined);
    await cdp.close();
  }
});

test("session finish waits for accepted creates before selecting temporary pages", async () => {
  const cdp = await createFakeCdpServer({ closeTargetsWithoutEvents: true });
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  const capability = new BrowserZenXCapabilityPackage(connection.backend);
  const invoke = (name: string, args: Record<string, unknown> = {}) =>
    capability.invoke(name, {
      name,
      callId: name,
      threadId: "thread",
      cwd: process.cwd(),
      arguments: { sessionId: "task", observe: false, ...args },
      signal: new AbortController().signal,
    });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  cdp.interceptRequests(async (request) => {
    if (request.method === "Target.createTarget") await held;
  });
  try {
    await invoke("browser_list_tabs");
    const opened = invoke("browser_open", {
      url: "https://example.test/temporary",
    });
    await waitUntil(() => cdp.count("Target.createTarget") === 1);
    // This create was accepted before finish, but has not reached the wire yet.
    const queued = invoke("browser_open", {
      url: "https://example.test/queued",
    });
    const closing = invoke("browser_close_session");
    await nextTurn();
    assert.equal(cdp.count("Target.closeTarget"), 0);
    release();
    const tabsCreated = (await Promise.all([
      opened,
      queued,
    ])) as BrowserTabSummary[];
    await closing;
    const tabs = (await invoke("browser_list_tabs")) as BrowserTabSummary[];
    assert.equal(
      cdp.count("Target.createTarget"),
      2,
      "accepted creates execute once",
    );
    assert.equal(
      cdp.count("Target.closeTarget"),
      2,
      "all known temporary pages are closed",
    );
    assert.deepEqual(
      tabs.map((tab) => tab.tabId),
      ["target-1"],
      "the original human page remains open",
    );
    assert.ok(
      tabsCreated.every(
        (created) => !tabs.some((tab) => tab.tabId === created.tabId),
      ),
    );
  } finally {
    release();
    await capability.close().catch(() => undefined);
    await cdp.close();
  }
});

test("session finish rejects new creates after its cleanup request", async () => {
  const cdp = await createFakeCdpServer({ closeTargetsWithoutEvents: true });
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  const capability = new BrowserZenXCapabilityPackage(connection.backend);
  const invoke = (name: string, args: Record<string, unknown> = {}) =>
    capability.invoke(name, {
      name,
      callId: name,
      threadId: "thread",
      cwd: process.cwd(),
      arguments: { sessionId: "task", observe: false, ...args },
      signal: new AbortController().signal,
    });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  cdp.interceptRequests(async (request) => {
    if (request.method === "Target.createTarget") await held;
  });
  try {
    await invoke("browser_list_tabs");
    const opened = invoke("browser_open", {
      url: "https://example.test/temporary",
    });
    await waitUntil(() => cdp.count("Target.createTarget") === 1);
    const closing = invoke("browser_close_session");
    const rejected = assert.rejects(
      invoke("browser_open", { url: "https://example.test/too-late" }),
      /session is detaching/u,
    );
    await nextTurn();
    release();
    await opened;
    await closing;
    await rejected;
    assert.equal(
      cdp.count("Target.createTarget"),
      1,
      "no create after the cleanup admission boundary",
    );
    assert.equal(cdp.count("Target.closeTarget"), 1);
  } finally {
    release();
    await capability.close().catch(() => undefined);
    await cdp.close();
  }
});
