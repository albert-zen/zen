import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceBrowser } from "../src/main/workspace-browser.js";
import { BrowserZenXCapabilityPackage } from "../src/main/capabilities/browser-provider.js";
import { OBSERVATION_CAPTURE } from "../src/main/capabilities/observation-capture.js";

test("Workspace Browser human view and Agent backend operate the exact same target", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-shared-browser-"),
  );
  const sender = new FakeWebContents(99);
  const window = new FakeWindow(sender);
  const views: FakeView[] = [];
  const browser = new WorkspaceBrowser({
    artifactDirectory: directory,
    dependencies: {
      createView: () => {
        const view = new FakeView();
        views.push(view);
        return view as never;
      },
      windowFor: () => window as never,
    },
  });
  try {
    const humanTabs = browser.command(
      sender as never,
      "thread-a",
      "new",
      undefined,
      "https://example.test/start",
    );
    const tabId = humanTabs[0]!.id;
    await new Promise((resolve) => setImmediate(resolve));
    browser.bindThreadSession("agent-session", "thread-a");

    assert.throws(
      () =>
        browser.command(
          sender as never,
          "thread-a",
          "new",
          undefined,
          "file:///tmp/not-allowed",
        ),
      /HTTP or HTTPS/u,
    );
    await assert.rejects(
      browser.open("agent-session", "file:///tmp/not-allowed"),
      /HTTP or HTTPS/u,
    );
    assert.equal(
      browser.command(sender as never, "thread-a", "list").length,
      1,
      "invalid navigation must not leave a blank shared target",
    );

    const agentTabs = await browser.listTabs("agent-session");
    assert.equal(agentTabs[0]?.tabId, tabId);
    assert.equal(agentTabs[0]?.url, "https://example.test/start");

    await browser.navigate(
      "agent-session",
      tabId,
      "https://example.test/agent",
    );
    assert.equal(
      browser.command(sender as never, "thread-a", "list")[0]?.url,
      "https://example.test/agent",
    );

    browser.mount(sender as never, {
      threadId: "thread-a",
      tabId,
      lease: "lease-a",
      bounds: { x: 0, y: 0, width: 640, height: 480 },
    });
    assert.equal(window.contentView.added[0], views[0]);

    const inspection = await browser.inspect("agent-session", tabId);
    assert.equal(inspection.tabId, tabId);
    assert.equal(views[0]?.webContents.debuggerApi.evaluations, 1);

    assert.equal(browser.closeSession("agent-session"), 0);
    assert.equal(
      browser.command(sender as never, "thread-a", "list").length,
      1,
      "detaching the Agent must preserve the user's shared page",
    );
  } finally {
    await browser.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an aborted current Agent navigation fails instead of reporting success", async () => {
  const fixture = await sharedFixture();
  try {
    fixture.browser.bindThreadSession("agent-session", "thread-a");
    const opened = await fixture.browser.open(
      "agent-session",
      "https://example.test/start",
    );
    const load = deferred<void>();
    fixture.views[0]!.webContents.nextLoad = load;
    const navigating = fixture.browser.navigate(
      "agent-session",
      opened.tabId,
      "https://example.test/interrupted",
    );
    const error = Object.assign(new Error("aborted"), { code: "ERR_ABORTED" });
    load.reject(error);
    await assert.rejects(navigating, /interrupted/u);
  } finally {
    await fixture.close();
  }
});

test("mounting during an Agent action fences its outcome while an unchanged mount preserves observation", async () => {
  const fixture = await sharedFixture();
  try {
    const humanTabs = fixture.browser.command(
      fixture.sender as never,
      "thread-a",
      "new",
      undefined,
      "https://example.test/start",
    );
    await new Promise((resolve) => setImmediate(resolve));
    const tabId = humanTabs[0]!.id;
    const web = fixture.views[0]!.webContents;
    fixture.browser.bindThreadSession("agent-session", "thread-a");
    web.debuggerApi.defaultValue = {
      visibleText: "fixture",
      targets: [
        {
          selector: "button",
          role: "button",
          name: "Act",
          actions: ["click"],
          state: {},
        },
      ],
    };
    let inspection = await fixture.browser.inspect("agent-session", tabId);
    const actionEvaluation = deferred<unknown>();
    web.debuggerApi.nextEvaluation = actionEvaluation;
    const acting = fixture.browser.click(
      "agent-session",
      tabId,
      inspection.observationId,
      inspection.targets[0]!.targetId,
    );
    const mount = () =>
      fixture.browser.mount(fixture.sender as never, {
        threadId: "thread-a",
        tabId,
        lease: "lease-a",
        bounds: { x: 0, y: 0, width: 640, height: 480 },
      });
    mount();
    actionEvaluation.resolve({ ok: true });
    await assert.rejects(acting, /outcome is unknown/u);

    inspection = await fixture.browser.inspect("agent-session", tabId);
    mount();
    web.debuggerApi.defaultValue = { ok: true };
    await fixture.browser.click(
      "agent-session",
      tabId,
      inspection.observationId,
      inspection.targets[0]!.targetId,
    );
  } finally {
    await fixture.close();
  }
});

test("human navigation fences an in-flight Agent inspection and action without waiting", async () => {
  const fixture = await sharedFixture();
  try {
    const humanTabs = fixture.browser.command(
      fixture.sender as never,
      "thread-a",
      "new",
      undefined,
      "https://example.test/start",
    );
    await new Promise((resolve) => setImmediate(resolve));
    const tabId = humanTabs[0]!.id;
    const web = fixture.views[0]!.webContents;
    fixture.browser.bindThreadSession("agent-session", "thread-a");

    const inspectionEvaluation = deferred<unknown>();
    web.debuggerApi.nextEvaluation = inspectionEvaluation;
    const inspecting = fixture.browser.inspect("agent-session", tabId);
    const humanLoad = deferred<void>();
    web.nextLoad = humanLoad;
    fixture.browser.command(
      fixture.sender as never,
      "thread-a",
      "navigate",
      tabId,
      "https://example.test/human",
    );
    assert.equal(
      web.loadCalls.at(-1),
      "https://example.test/human",
      "human navigation must start while inspect is still pending",
    );
    inspectionEvaluation.resolve({ visibleText: "old", targets: [] });
    await assert.rejects(inspecting, /stale/u);
    humanLoad.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    web.debuggerApi.defaultValue = {
      visibleText: "fixture",
      targets: [
        {
          selector: "button",
          role: "button",
          name: "Act",
          actions: ["click"],
          state: {},
        },
      ],
    };
    const inspection = await fixture.browser.inspect("agent-session", tabId);
    const actionEvaluation = deferred<unknown>();
    web.debuggerApi.nextEvaluation = actionEvaluation;
    const acting = fixture.browser.click(
      "agent-session",
      tabId,
      inspection.observationId,
      inspection.targets[0]!.targetId,
    );
    const laterHumanLoad = deferred<void>();
    web.nextLoad = laterHumanLoad;
    fixture.browser.command(
      fixture.sender as never,
      "thread-a",
      "navigate",
      tabId,
      "https://example.test/later-human",
    );
    assert.equal(
      web.loadCalls.at(-1),
      "https://example.test/later-human",
      "human navigation must not queue behind an Agent action",
    );
    actionEvaluation.resolve({ ok: true });
    await assert.rejects(acting, /stale/u);
    laterHumanLoad.resolve();
  } finally {
    await fixture.close();
  }
});

test("closing a shared tab makes an in-flight Agent inspection unknown", async () => {
  const fixture = await sharedFixture();
  try {
    const humanTabs = fixture.browser.command(
      fixture.sender as never,
      "thread-a",
      "new",
      undefined,
      "https://example.test/start",
    );
    await new Promise((resolve) => setImmediate(resolve));
    const tabId = humanTabs[0]!.id;
    fixture.browser.bindThreadSession("agent-session", "thread-a");
    const evaluation = deferred<unknown>();
    fixture.views[0]!.webContents.debuggerApi.nextEvaluation = evaluation;
    const inspecting = fixture.browser.inspect("agent-session", tabId);
    fixture.browser.command(
      fixture.sender as never,
      "thread-a",
      "close",
      tabId,
    );
    evaluation.resolve({ visibleText: "old", targets: [] });
    await assert.rejects(inspecting, /Unknown browser target/u);
  } finally {
    await fixture.close();
  }
});

test("detaching an Agent session makes its in-flight inspection unknown without closing the page", async () => {
  const fixture = await sharedFixture();
  try {
    const humanTabs = fixture.browser.command(
      fixture.sender as never,
      "thread-a",
      "new",
      undefined,
      "https://example.test/start",
    );
    await new Promise((resolve) => setImmediate(resolve));
    const tabId = humanTabs[0]!.id;
    fixture.browser.bindThreadSession("agent-session", "thread-a");
    const evaluation = deferred<unknown>();
    fixture.views[0]!.webContents.debuggerApi.nextEvaluation = evaluation;
    const inspecting = fixture.browser.inspect("agent-session", tabId);
    assert.equal(fixture.browser.closeSession("agent-session"), 0);
    evaluation.resolve({ visibleText: "old", targets: [] });
    await assert.rejects(inspecting, /Unknown browser target/u);
    assert.equal(
      fixture.browser.command(fixture.sender as never, "thread-a", "list")
        .length,
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("detaching an Agent session cannot deliver an in-flight live frame", async () => {
  const fixture = await sharedFixture();
  try {
    const humanTabs = fixture.browser.command(
      fixture.sender as never,
      "thread-a",
      "new",
      undefined,
      "https://example.test/start",
    );
    await new Promise((resolve) => setImmediate(resolve));
    const tabId = humanTabs[0]!.id;
    const web = fixture.views[0]!.webContents;
    fixture.browser.bindThreadSession("agent-session", "thread-a");
    const pendingCapture = deferred<FakeImage>();
    web.nextCapture = pendingCapture;
    let frames = 0;
    const stop = fixture.browser.observeTab("agent-session", tabId, (event) => {
      if (event.type === "frame") frames += 1;
    });
    try {
      fixture.browser.closeSession("agent-session");
      pendingCapture.resolve(new FakeImage());
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(frames, 0);
    } finally {
      stop();
    }
  } finally {
    await fixture.close();
  }
});

test("Workspace hidden capture retains fresh action IDs beyond the public cap and expires on mutation", async () => {
  const fixture = await sharedFixture();
  try {
    fixture.browser.bindThreadSession("agent-session", "thread-a");
    const tab = await fixture.browser.open(
      "agent-session",
      "https://example.test/start",
    );
    const web = fixture.views[0]!.webContents;
    const raw = {
      documentIdentity: "native-incarnation",
      visibleText: "x".repeat(20_000),
      itemTotal: 150,
      textTotal: 20_000,
      targets: Array.from({ length: 150 }, (_, index) => ({
        documentIdentity: "native-incarnation",
        nodeIdentity: `node-${index}`,
        selector: `#b${index}`,
        tag: "button",
        role: "button",
        name: `Button ${index}`,
        type: "",
        id: `b${index}`,
        fieldName: "",
        autocomplete: "",
        href: "",
        actions: ["click"],
      })),
    };
    web.debuggerApi.defaultValue = raw;
    const first = await fixture.browser.inspect("agent-session", tab.tabId);
    assert.equal(first.targets.length, 80);
    assert.equal(first.visibleText.length, 8_000);
    const capture = first[OBSERVATION_CAPTURE]!;
    assert.equal(capture.entries.length, 150);
    assert.equal(capture.text!.length, 20_000);
    assert.equal(capture.coverage.sourceComplete, true);
    assert.equal(capture.entries[100]!.identity, "node-100");
    assert.equal(JSON.stringify(first).includes("node-100"), false);
    capture.assertCurrent!();
    web.debuggerApi.defaultValue = { ok: true };
    await fixture.browser.click(
      "agent-session",
      tab.tabId,
      first.observationId,
      capture.entries[100]!.value.targetId,
    );
    assert.throws(() => capture.assertCurrent!(), /stale/);
    web.debuggerApi.defaultValue = raw;
    const second = await fixture.browser.inspect("agent-session", tab.tabId);
    assert.equal(second[OBSERVATION_CAPTURE]!.scopeKey, capture.scopeKey);
    assert.notEqual(
      second[OBSERVATION_CAPTURE]!.entries[100]!.value.targetId,
      capture.entries[100]!.value.targetId,
    );
    const third = await fixture.browser.inspect("agent-session", tab.tabId);
    assert.throws(() => second[OBSERVATION_CAPTURE]!.assertCurrent!(), /stale/);
    await fixture.browser.navigate(
      "agent-session",
      tab.tabId,
      "https://example.test/next",
    );
    assert.throws(
      () => third[OBSERVATION_CAPTURE]!.assertCurrent!(),
      /changed|stale/,
    );
    const current = await fixture.browser.inspect("agent-session", tab.tabId);
    fixture.browser.closeSession("agent-session");
    fixture.browser.bindThreadSession("agent-session", "thread-a");
    assert.throws(
      () => current[OBSERVATION_CAPTURE]!.assertCurrent!(),
      /stale/,
    );
    const rebound = await fixture.browser.inspect("agent-session", tab.tabId);
    assert.notEqual(
      rebound[OBSERVATION_CAPTURE]!.scopeKey,
      current[OBSERVATION_CAPTURE]!.scopeKey,
    );
  } finally {
    await fixture.close();
  }
});

test("explicit human control blocks Agent mutations and return requires a new observation", async () => {
  const fixture = await sharedFixture();
  try {
    const { browser, sender, views } = fixture;
    browser.bindThreadSession("agent-session", "thread-a");
    const tab = await browser.open(
      "agent-session",
      "https://example.test/start",
    );
    const prior = await browser.inspect("agent-session", tab.tabId);
    const take = () =>
      browser.command(sender as never, "thread-a", "take-control", tab.tabId);
    assert.equal(take()[0]?.control, "human");
    assert.equal(take()[0]?.control, "human", "takeover is idempotent");
    await assert.rejects(
      browser.navigate(
        "agent-session",
        tab.tabId,
        "https://example.test/forbidden",
      ),
      /human control/u,
    );
    await assert.rejects(
      browser.closeTab("agent-session", tab.tabId),
      /human control/u,
    );
    await assert.rejects(
      browser.click("agent-session", tab.tabId, prior.observationId, "old"),
      /human control/u,
    );
    assert.throws(
      () => prior[OBSERVATION_CAPTURE]!.assertCurrent!(),
      /stale|changed/u,
    );
    const during = await browser.inspect("agent-session", tab.tabId);
    assert.equal(
      during.control,
      "human",
      "read-only inspection remains available",
    );
    browser.command(sender as never, "thread-a", "return-control", tab.tabId);
    await assert.rejects(
      browser.navigate(
        "agent-session",
        tab.tabId,
        "https://example.test/forbidden",
      ),
      /fresh observation/u,
    );
    await assert.rejects(
      browser.closeTab("agent-session", tab.tabId),
      /fresh observation/u,
    );
    const returned = await browser.inspect("agent-session", tab.tabId);
    assert.equal(returned.requiresFreshObservation, false);
    browser.command(sender as never, "thread-a", "return-control", tab.tabId);
    assert.equal(
      (await browser.listTabs("agent-session"))[0]?.requiresFreshObservation,
      false,
      "repeated return does not expire the fresh observation",
    );
    await assert.rejects(
      browser.navigate(
        "agent-session",
        tab.tabId,
        "https://example.test/old-queued",
      ),
      /fresh observation/u,
    );
    await assert.rejects(
      browser.closeTab("agent-session", tab.tabId),
      /fresh observation/u,
    );
    await assert.rejects(
      browser.navigate(
        "agent-session",
        tab.tabId,
        "https://example.test/old-queued",
        undefined,
        prior.observationId,
      ),
      /stale/u,
    );
    await browser.navigate(
      "agent-session",
      tab.tabId,
      "https://example.test/resumed",
      undefined,
      returned.observationId,
    );
    assert.equal(
      views[0]!.webContents.loadCalls.length,
      2,
      "rejected work is never replayed",
    );
  } finally {
    await fixture.close();
  }
});

test("takeover blocks every mutation but leaves human navigation and unrelated tabs usable", async () => {
  const f = await sharedFixture();
  try {
    f.browser.bindThreadSession("a", "thread-a");
    f.browser.bindThreadSession("b", "thread-b");
    const tab = await f.browser.open("a", "https://example.test/start");
    const other = await f.browser.open("a", "https://example.test/other");
    f.browser.command(f.sender as never, "thread-a", "take-control", tab.tabId);
    for (const mutation of [
      () => f.browser.click("a", tab.tabId, "old", "target"),
      () => f.browser.type("a", tab.tabId, "old", "target", "text", true),
      () => f.browser.select("a", tab.tabId, "old", "target", "option"),
      () => f.browser.scroll("a", tab.tabId, "old", "down", 100),
      () =>
        f.browser.navigate("a", tab.tabId, "https://example.test/forbidden"),
      () => f.browser.closeTab("a", tab.tabId),
    ])
      await assert.rejects(mutation(), /human control/u);
    assert.throws(
      () =>
        f.browser.command(
          f.sender as never,
          "thread-b",
          "return-control",
          tab.tabId,
        ),
      /not in this Thread/u,
    );
    await assert.rejects(
      f.browser.inspect("b", tab.tabId),
      /Unknown browser target/u,
    );
    f.browser.command(
      f.sender as never,
      "thread-a",
      "navigate",
      tab.tabId,
      "https://example.test/human",
    );
    await f.browser.navigate(
      "a",
      other.tabId,
      "https://example.test/unrelated",
    );
    assert.equal(
      f.views[0]!.webContents.loadCalls.at(-1),
      "https://example.test/human",
    );
    f.browser.mount(f.sender as never, {
      threadId: "thread-a",
      tabId: other.tabId,
      lease: "other",
      bounds: { x: 0, y: 0, width: 640, height: 480 },
    });
    assert.equal((await f.browser.listTabs("a"))[0]?.control, "human");
    f.browser.closeSession("a");
    f.browser.bindThreadSession("a", "thread-a");
    await assert.rejects(f.browser.closeTab("a", tab.tabId), /human control/u);
    f.browser.command(f.sender as never, "thread-a", "close", tab.tabId);
    assert.throws(
      () =>
        f.browser.command(
          f.sender as never,
          "thread-a",
          "return-control",
          tab.tabId,
        ),
      /not in this Thread/u,
    );
  } finally {
    await f.close();
  }
});

test("control changes during CDP preparation reject before dispatch, even after return and a newer inspection", async () => {
  const f = await sharedFixture();
  try {
    f.browser.bindThreadSession("a", "thread-a");
    const tab = await f.browser.open("a", "https://example.test/start");
    const web = f.views[0]!.webContents;
    web.debuggerApi.defaultValue = actionInspection;
    const observation = await f.browser.inspect("a", tab.tabId);
    const gate = deferred<void>();
    web.debuggerApi.nextWorld = gate;
    const action = f.browser.click(
      "a",
      tab.tabId,
      observation.observationId,
      observation.targets[0]!.targetId,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const before = web.debuggerApi.evaluations;
    f.browser.command(f.sender as never, "thread-a", "take-control", tab.tabId);
    f.browser.command(
      f.sender as never,
      "thread-a",
      "return-control",
      tab.tabId,
    );
    const current = await f.browser.inspect("a", tab.tabId);
    gate.resolve();
    await assert.rejects(action, /control changed.*stale/u);
    assert.equal(
      web.debuggerApi.evaluations,
      before + 1,
      "only the fresh inspection dispatches",
    );
    assert.equal(
      (await f.browser.listTabs("a"))[0]?.agentActionOutcomeUnknown,
      false,
    );
    web.debuggerApi.defaultValue = { ok: true };
    const result = await f.browser.click(
      "a",
      tab.tabId,
      current.observationId,
      current.targets[0]!.targetId,
    );
    assert.equal(
      result.agentActionsInFlight,
      0,
      "settled results are not reported as pending",
    );
  } finally {
    await f.close();
  }
});

test("dispatched action survives takeover truthfully; return and inspection cannot authorize another mutation while it settles", async () => {
  const f = await sharedFixture();
  try {
    f.browser.bindThreadSession("a", "thread-a");
    const tab = await f.browser.open("a", "https://example.test/start");
    const web = f.views[0]!.webContents;
    web.debuggerApi.defaultValue = actionInspection;
    const observation = await f.browser.inspect("a", tab.tabId);
    const gate = deferred<unknown>();
    web.debuggerApi.nextEvaluation = gate;
    const action = f.browser.click(
      "a",
      tab.tabId,
      observation.observationId,
      observation.targets[0]!.targetId,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await f.browser.listTabs("a"))[0]?.agentActionsInFlight, 1);
    f.browser.command(f.sender as never, "thread-a", "take-control", tab.tabId);
    f.browser.command(
      f.sender as never,
      "thread-a",
      "return-control",
      tab.tabId,
    );
    const during = await f.browser.inspect("a", tab.tabId);
    assert.equal(during.requiresFreshObservation, true);
    await assert.rejects(
      f.browser.navigate(
        "a",
        tab.tabId,
        "https://example.test/no",
        undefined,
        during.observationId,
      ),
      /still in flight/u,
    );
    gate.resolve({ ok: true });
    await assert.rejects(action, /outcome is unknown.*dispatch/u);
    assert.equal((await f.browser.listTabs("a"))[0]?.agentActionsInFlight, 0);
    assert.equal(
      (await f.browser.listTabs("a"))[0]?.agentActionOutcomeUnknown,
      true,
    );
    await assert.rejects(
      f.browser.closeTab("a", tab.tabId, undefined, during.observationId),
      /fresh observation/u,
    );
    const after = await f.browser.inspect("a", tab.tabId);
    assert.equal(after.agentActionOutcomeUnknown, false);
    await f.browser.closeTab("a", tab.tabId, undefined, after.observationId);
    assert.equal((await f.browser.listTabs("a")).length, 0);
  } finally {
    await f.close();
  }
});

test("inspection started before takeover or return cannot renew action authority", async () => {
  const f = await sharedFixture();
  try {
    f.browser.bindThreadSession("a", "thread-a");
    const tab = await f.browser.open("a", "https://example.test/start");
    for (const command of ["take-control", "return-control"]) {
      const gate = deferred<unknown>();
      f.views[0]!.webContents.debuggerApi.nextEvaluation = gate;
      const inspecting = f.browser.inspect("a", tab.tabId);
      await new Promise((resolve) => setImmediate(resolve));
      f.browser.command(f.sender as never, "thread-a", command, tab.tabId);
      gate.resolve(actionInspection);
      await assert.rejects(inspecting, /stale/u);
    }
    await assert.rejects(
      f.browser.closeTab("a", tab.tabId),
      /fresh observation/u,
    );
  } finally {
    await f.close();
  }
});

test("initial navigation taken over or closed never reports cancellation or removes a human-owned tab", async () => {
  const f = await sharedFixture();
  try {
    f.browser.bindThreadSession("a", "thread-a");
    // The new tab becomes visible during the asynchronous initial navigation.
    const gate = deferred<void>();
    f.nextLoad = gate;
    const opening = f.browser.open("a", "https://example.test/slow");
    const [tab] = await f.browser.listTabs("a");
    assert.ok(tab);
    f.browser.command(f.sender as never, "thread-a", "take-control", tab.tabId);
    gate.resolve();
    await assert.rejects(opening, /outcome is unknown/u);
    assert.equal((await f.browser.listTabs("a"))[0]?.control, "human");
    f.browser.command(
      f.sender as never,
      "thread-a",
      "return-control",
      tab.tabId,
    );
    const fresh = await f.browser.inspect("a", tab.tabId);
    const load = deferred<void>();
    f.views[0]!.webContents.nextLoad = load;
    const navigation = f.browser.navigate(
      "a",
      tab.tabId,
      "https://example.test/slow-again",
      undefined,
      fresh.observationId,
    );
    f.browser.command(f.sender as never, "thread-a", "close", tab.tabId);
    load.resolve();
    await assert.rejects(navigation, /outcome is unknown/u);
    assert.equal((await f.browser.listTabs("a")).length, 0);
  } finally {
    await f.close();
  }
});

test("published capability forwards navigate/close observation references without replaying queued requests", async () => {
  const f = await sharedFixture();
  try {
    const capability = new BrowserZenXCapabilityPackage(f.browser);
    f.browser.bindThreadSession("a", "thread-a");
    const tab = await f.browser.open("a", "https://example.test/start");
    const invoke = (name: string, args: Record<string, unknown> = {}) =>
      capability.invoke(name, {
        name,
        callId: "fixture",
        cwd: process.cwd(),
        signal: new AbortController().signal,
        arguments: { sessionId: "a", tabId: tab.tabId, ...args },
      });
    f.browser.command(f.sender as never, "thread-a", "take-control", tab.tabId);
    f.browser.command(
      f.sender as never,
      "thread-a",
      "return-control",
      tab.tabId,
    );
    const inspected = (await invoke("browser_inspect")) as {
      observationId: string;
    };
    await assert.rejects(
      invoke("browser_navigate", { url: "https://example.test/queued" }),
      /fresh observation/u,
    );
    await assert.rejects(invoke("browser_close"), /fresh observation/u);
    await invoke("browser_navigate", {
      url: "https://example.test/next",
      observationId: inspected.observationId,
    });
    const after = (await invoke("browser_inspect")) as {
      observationId: string;
    };
    await invoke("browser_close", { observationId: after.observationId });
    assert.equal((await f.browser.listTabs("a")).length, 0);
  } finally {
    await f.close();
  }
});

test("cancellation before dispatch blocks the action; cancellation after dispatch remains uncertain", async () => {
  const f = await sharedFixture();
  try {
    f.browser.bindThreadSession("a", "thread-a");
    const tab = await f.browser.open("a", "https://example.test/start");
    const web = f.views[0]!.webContents;
    web.debuggerApi.defaultValue = actionInspection;
    for (const afterDispatch of [false, true]) {
      const observed = await f.browser.inspect("a", tab.tabId);
      const control = new AbortController();
      const gate = deferred<unknown>();
      const prepared = deferred<void>();
      if (afterDispatch) web.debuggerApi.nextEvaluation = gate;
      else web.debuggerApi.nextWorld = prepared;
      const before = web.debuggerApi.evaluations;
      const action = f.browser.click(
        "a",
        tab.tabId,
        observed.observationId,
        observed.targets[0]!.targetId,
        control.signal,
      );
      await new Promise((resolve) => setImmediate(resolve));
      control.abort(new Error("fixture cancellation"));
      gate.resolve({ ok: true });
      prepared.resolve();
      await assert.rejects(
        action,
        afterDispatch ? /outcome is unknown/u : /fixture cancellation/u,
      );
      assert.equal(
        web.debuggerApi.evaluations,
        before + (afterDispatch ? 1 : 0),
      );
      assert.equal(
        (await f.browser.listTabs("a"))[0]?.agentActionOutcomeUnknown,
        afterDispatch,
      );
    }
  } finally {
    await f.close();
  }
});

const actionInspection = {
  documentIdentity: "doc",
  visibleText: "fixture",
  targets: [
    {
      documentIdentity: "doc",
      selector: "button",
      role: "button",
      name: "Act",
      actions: ["click"],
      state: {},
    },
  ],
};

async function sharedFixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-shared-browser-race-"),
  );
  const sender = new FakeWebContents(99);
  const window = new FakeWindow(sender);
  const views: FakeView[] = [];
  let nextLoad: ReturnType<typeof deferred<void>> | undefined;
  const browser = new WorkspaceBrowser({
    artifactDirectory: directory,
    dependencies: {
      createView: () => {
        const view = new FakeView();
        view.webContents.nextLoad = nextLoad;
        nextLoad = undefined;
        views.push(view);
        return view as never;
      },
      windowFor: () => window as never,
    },
  });
  return {
    browser,
    set nextLoad(value: ReturnType<typeof deferred<void>>) {
      nextLoad = value;
    },
    sender,
    views,
    close: async () => {
      await browser.shutdown();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

class FakeDebugger {
  attached = false;
  evaluations = 0;
  defaultValue: unknown = { visibleText: "fixture", targets: [] };
  nextEvaluation?: ReturnType<typeof deferred<unknown>>;
  nextWorld?: ReturnType<typeof deferred<void>>;
  isAttached() {
    return this.attached;
  }
  attach() {
    this.attached = true;
  }
  async sendCommand(method: string, params?: Record<string, unknown>) {
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "main-frame" } } };
    if (method === "Page.createIsolatedWorld") {
      const gate = this.nextWorld;
      this.nextWorld = undefined;
      if (gate) await gate.promise;
      assert.equal(params?.worldName, "zenx-browser-observation-v1");
      assert.equal(params?.grantUniveralAccess, false);
      return { executionContextId: 42 };
    }
    assert.equal(method, "Runtime.evaluate");
    assert.equal(
      params?.contextId,
      42,
      "all page code must run in the isolated world",
    );
    this.evaluations += 1;
    const next = this.nextEvaluation;
    this.nextEvaluation = undefined;
    return {
      result: {
        value: next === undefined ? this.defaultValue : await next.promise,
      },
    };
  }
}

class FakeImage {
  isEmpty() {
    return false;
  }
  getSize() {
    return { width: 640, height: 480 };
  }
  toPNG() {
    return Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
  }
  toJPEG() {
    return Buffer.from("frame");
  }
  resize() {
    return this;
  }
}

class FakeWebContents extends EventEmitter {
  readonly debuggerApi = new FakeDebugger();
  readonly debugger = this.debuggerApi;
  readonly session = {
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
  };
  readonly navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => undefined,
    goForward: () => undefined,
  };
  #url = "about:blank";
  #destroyed = false;
  readonly loadCalls: string[] = [];
  nextLoad?: ReturnType<typeof deferred<void>>;
  nextCapture?: ReturnType<typeof deferred<FakeImage>>;
  constructor(readonly id = 1) {
    super();
  }
  async loadURL(url: string) {
    this.loadCalls.push(url);
    this.emit("did-start-navigation", {}, url, false, true);
    const next = this.nextLoad;
    this.nextLoad = undefined;
    if (next !== undefined) await next.promise;
    this.#url = url;
    this.emit("did-navigate");
    this.emit("did-stop-loading");
  }
  getURL() {
    return this.#url;
  }
  getTitle() {
    return "Fixture";
  }
  isLoading() {
    return false;
  }
  isDestroyed() {
    return this.#destroyed;
  }
  capturePage() {
    const next = this.nextCapture;
    this.nextCapture = undefined;
    if (next !== undefined) return next.promise;
    return Promise.resolve(new FakeImage());
  }
  setWindowOpenHandler() {
    return undefined;
  }
  reload() {
    return undefined;
  }
  send() {
    return undefined;
  }
  focus() {
    return undefined;
  }
  close() {
    this.#destroyed = true;
    this.emit("destroyed");
  }
}

class FakeView {
  readonly webContents = new FakeWebContents();
  #bounds = { x: 0, y: 0, width: 0, height: 0 };
  setVisible() {
    return undefined;
  }
  setBounds(bounds: { x: number; y: number; width: number; height: number }) {
    this.#bounds = bounds;
  }
  getBounds() {
    return this.#bounds;
  }
}

class FakeWindow extends EventEmitter {
  readonly contentView = {
    added: [] as FakeView[],
    addChildView: (view: FakeView) => this.contentView.added.push(view),
    removeChildView: () => undefined,
  };
  constructor(readonly webContents: FakeWebContents) {
    super();
  }
  isDestroyed() {
    return false;
  }
  getContentSize() {
    return [1200, 800] as const;
  }
}
