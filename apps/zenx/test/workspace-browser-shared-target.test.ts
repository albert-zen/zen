import { BrowserInputUnsupportedError } from "../src/main/capabilities/browser-targeted-input.js";
import { BrowserBackendRegistry } from "../src/main/capabilities/browser-backend-registry.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { WorkspaceBrowser } from "../src/main/workspace-browser.js";
import { BrowserZenXCapabilityPackage } from "../src/main/capabilities/browser-provider.js";
import { OBSERVATION_CAPTURE } from "../src/main/capabilities/observation-capture.js";

test("closing an expired workspace tab is idempotent but cannot close another Thread's page", async () => {
  const f = await sharedFixture();
  try {
    assert.deepEqual(
      f.browser.command(f.sender as never, "thread-a", "close", "expired"),
      [],
    );
    const [tab] = f.browser.command(f.sender as never, "thread-b", "new");
    assert.throws(
      () => f.browser.command(f.sender as never, "thread-a", "close", tab!.id),
      /not in this Thread/,
    );
    assert.equal(
      f.browser.command(f.sender as never, "thread-b", "list").length,
      1,
    );
    assert.throws(
      () =>
        f.browser.command(
          f.sender as never,
          "thread-a",
          "navigate",
          "expired",
          "https://example.test",
        ),
      /not in this Thread/,
    );
  } finally {
    await f.close();
  }
});

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

test("navigation ignores a prior document finish even when native loadURL resolves early", async () => {
  const f = await sharedFixture();
  try {
    f.browser.bindThreadSession("a", "thread-a");
    const opened = await f.browser.open("a", "https://example.test/prior");
    const web = f.views[0]!.webContents;
    const before = web.listenerCount("did-finish-load");
    web.loadURL = async (url) => {
      web.emit("did-start-navigation", {}, url, false, true);
      // Confirmed Electron 43 ordering: the prior document's late finish
      // resolves loadURL while getURL still names the prior page.
      web.emit("did-finish-load");
    };
    let settled = false;
    const next = f.browser.navigate(
      "a",
      opened.tabId,
      "https://example.test/next",
    );
    void next.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      settled,
      false,
      "prior-page completion must not fulfill navigate",
    );
    assert.equal(web.getURL(), "https://example.test/prior");
    web.finishLoad("https://example.test/redirected");
    assert.equal(
      (await next).url,
      "https://example.test/redirected",
      "final redirect URL remains valid",
    );
    assert.equal(web.listenerCount("did-finish-load"), before);
  } finally {
    await f.close();
  }
});

test("early native completion still rejects superseded, closed and stopped navigation", async () => {
  for (const ending of ["superseded", "closed", "stopped"] as const) {
    const f = await sharedFixture();
    try {
      f.browser.bindThreadSession("a", "thread-a");
      const opened = await f.browser.open("a", "https://example.test/prior");
      const web = f.views[0]!.webContents;
      const before = web.listenerCount("did-finish-load");
      web.loadURL = async (url) => {
        web.emit("did-start-navigation", {}, url, false, true);
        web.emit("did-finish-load");
      };
      const first = f.browser.navigate(
        "a",
        opened.tabId,
        "https://example.test/slow",
      );
      const rejected = assert.rejects(
        first,
        /superseded|no longer available|stopped/u,
      );
      await new Promise((resolve) => setImmediate(resolve));
      if (ending === "superseded") {
        const second = f.browser.navigate(
          "a",
          opened.tabId,
          "https://example.test/fast",
        );
        web.finishLoad("https://example.test/fast");
        assert.equal((await second).url, "https://example.test/fast");
      } else if (ending === "closed") web.close();
      else web.emit("did-stop-loading");
      await rejected;
      assert.equal(web.listenerCount("did-finish-load"), before);
    } finally {
      await f.close();
    }
  }
});

test("same-document navigation completes without requiring a document load event", async () => {
  const f = await sharedFixture();
  try {
    f.browser.bindThreadSession("a", "thread-a");
    const opened = await f.browser.open("a", "https://example.test/page");
    const web = f.views[0]!.webContents;
    web.loadURL = async (url) => {
      web.emit("did-start-navigation", {}, url, true, true);
      web.finishLoad(url, true);
    };
    assert.equal(
      (
        await f.browser.navigate(
          "a",
          opened.tabId,
          "https://example.test/page#section",
        )
      ).url,
      "https://example.test/page",
    );
    assert.equal(web.getURL(), "https://example.test/page#section");
  } finally {
    await f.close();
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
    const mount = (appearance: "light" | "dark" = "light") =>
      fixture.browser.mount(fixture.sender as never, {
        threadId: "thread-a",
        tabId,
        lease: "lease-a",
        appearance,
        bounds: { x: 0, y: 0, width: 640, height: 480 },
      });
    mount();
    actionEvaluation.resolve({ ok: true });
    await assert.rejects(acting, /outcome is unknown/u);

    inspection = await fixture.browser.inspect("agent-session", tabId);
    mount("dark");
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
    window,
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

class FakeDebugger extends EventEmitter {
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
    if (method === "Page.enable" || method === "Page.captureScreenshot")
      return {};
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
  appearanceScripts: string[] = [];
  async executeJavaScript(script: string) {
    this.appearanceScripts.push(script);
  }
  frame?: (image: {
    isEmpty(): boolean;
    getSize(): { width: number; height: number };
  }) => void;
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
    this.finishLoad(url);
  }
  finishLoad(url: string, inPage = false) {
    this.#url = url;
    if (inPage) this.emit("did-navigate-in-page", {}, url, true);
    else {
      this.emit("did-navigate", {}, url, 200, "OK");
      this.emit("did-finish-load");
    }
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
  beginFrameSubscription(
    _dirty: boolean,
    callback: NonNullable<FakeWebContents["frame"]>,
  ) {
    this.frame = callback;
  }
  endFrameSubscription() {
    this.frame = undefined;
  }
  setWindowOpenHandler() {
    return undefined;
  }
  reload() {
    return undefined;
  }
  readonly sent: { channel: string; args: unknown[] }[] = [];
  send(channel: string, ...args: unknown[]) {
    this.sent.push({ channel, args });
  }
  focusCalls = 0;
  focus() {
    this.focusCalls += 1;
  }
  close() {
    this.#destroyed = true;
    this.emit("destroyed");
  }
}

class FakeView {
  backgroundColor = "#ffffff";
  setBackgroundColor(color: string) {
    this.backgroundColor = color;
  }
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
    children: [] as FakeView[],
    addChildView: (view: FakeView) => {
      this.contentView.added.push(view);
      this.contentView.children.push(view);
    },
    removeChildView: (view: FakeView) => {
      this.contentView.children = this.contentView.children.filter(
        (child) => child !== view,
      );
    },
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

test("concurrent routing preserves human takeover, fresh return and native navigation fences", async () => {
  const f = await sharedFixture();
  const registry = new BrowserBackendRegistry(f.browser);
  const invoke = (name: string, args: Record<string, unknown>) =>
    registry.invoke(name, {
      name,
      callId: "concurrent-call",
      threadId: "thread-a",
      cwd: "/tmp",
      signal: new AbortController().signal,
      arguments: { sessionId: "session", ...args },
    }) as Promise<{ tabId: string; observationId: string; backendId: string }>;
  try {
    const tab = await invoke("browser_workspace_open", {
      url: "https://example.test/start",
    });
    const nativeTab = f.browser.command(
      f.sender as never,
      "thread-a",
      "list",
    )[0]!;
    assert.equal(tab.tabId, `workspace:${nativeTab.id}`);
    const old = await invoke("browser_workspace_inspect", { tabId: tab.tabId });
    f.browser.command(
      f.sender as never,
      "thread-a",
      "take-control",
      nativeTab.id,
    );
    await assert.rejects(
      invoke("browser_workspace_navigate", {
        tabId: tab.tabId,
        url: "https://example.test/denied",
        observationId: old.observationId,
      }),
      /human|control/iu,
    );
    f.browser.command(
      f.sender as never,
      "thread-a",
      "return-control",
      nativeTab.id,
    );
    await assert.rejects(
      invoke("browser_workspace_navigate", {
        tabId: tab.tabId,
        url: "https://example.test/denied",
      }),
      /observation/iu,
    );
    await assert.rejects(
      invoke("browser_workspace_navigate", {
        tabId: tab.tabId,
        url: "https://example.test/denied",
        observationId: old.observationId,
      }),
      /observation|fresh/iu,
    );
    const fresh = await invoke("browser_workspace_inspect", {
      tabId: tab.tabId,
    });
    assert.notEqual(fresh.observationId, old.observationId);
    await invoke("browser_workspace_navigate", {
      tabId: tab.tabId,
      url: "https://example.test/allowed",
      observationId: fresh.observationId,
    });
    assert.equal(
      f.browser.command(f.sender as never, "thread-a", "list")[0]?.url,
      "https://example.test/allowed",
    );
    await invoke("browser_workspace_close_session", {});
    assert.equal(
      f.browser.command(f.sender as never, "thread-a", "list").length,
      1,
    );
  } finally {
    await registry.close();
    await f.close();
  }
});

test("Workspace targeted input publishes CSS viewport and consumes a coherent screenshot observation", async () => {
  const f = await sharedFixture();
  try {
    f.browser.bindThreadSession("a", "thread-a");
    const tab = await f.browser.open("a", "https://example.test/input");
    const input = installTargetedInputFixture(
      f.views[0]!.webContents.debuggerApi,
    );
    const observed = await f.browser.inspect("a", tab.tabId);
    assert.equal(observed.inputViewport?.width, 640);
    assert.equal(observed.inputViewport?.deviceScaleFactor, 2);
    await f.browser.pointerClick(
      "a",
      tab.tabId,
      observed.observationId,
      60,
      40,
    );
    assert.deepEqual(
      input.events.map((event) => event.params.type),
      ["mousePressed", "mouseReleased"],
    );
    await assert.rejects(
      f.browser.pointerClick("a", tab.tabId, observed.observationId, 60, 40),
      /stale|unknown/,
    );
    const fresh = await f.browser.inspect("a", tab.tabId);
    await f.browser.keyPress("a", tab.tabId, fresh.observationId, "Enter");
    assert.deepEqual(
      input.events.slice(-2).map((event) => event.params.type),
      ["keyDown", "keyUp"],
    );
    assert.equal(
      input.events.every((event) => event.method.startsWith("Input.dispatch")),
      true,
    );
  } finally {
    await f.close();
  }
});

test("Workspace rejects targeted input when screenshot has no coherent viewport or changed focus", async () => {
  const f = await sharedFixture();
  try {
    f.browser.bindThreadSession("a", "thread-a");
    const tab = await f.browser.open("a", "https://example.test/input");
    const unavailable = await f.browser.inspect("a", tab.tabId);
    await assert.rejects(
      f.browser.pointerClick("a", tab.tabId, unavailable.observationId, 20, 30),
      /coherent screenshot/,
    );
    const input = installTargetedInputFixture(
      f.views[0]!.webContents.debuggerApi,
    );
    const observed = await f.browser.inspect("a", tab.tabId);
    input.snapshot.focusId = "human-selected-other-field";
    await assert.rejects(
      f.browser.keyPress("a", tab.tabId, observed.observationId, "Enter"),
      /focus or input changed/,
    );
    assert.equal(input.events.length, 0);
  } finally {
    await f.close();
  }
});

test("Workspace takeover between targeted press and release blocks old release and quarantines input", async () => {
  const f = await sharedFixture();
  try {
    f.browser.bindThreadSession("a", "thread-a");
    const tab = await f.browser.open("a", "https://example.test/input");
    const input = installTargetedInputFixture(
      f.views[0]!.webContents.debuggerApi,
    );
    const observed = await f.browser.inspect("a", tab.tabId);
    input.afterInput = () => {
      f.browser.command(
        f.sender as never,
        "thread-a",
        "take-control",
        tab.tabId,
      );
      f.browser.command(
        f.sender as never,
        "thread-a",
        "return-control",
        tab.tabId,
      );
    };
    await assert.rejects(
      f.browser.pointerClick("a", tab.tabId, observed.observationId, 20, 30),
      /outcome is unknown/,
    );
    assert.equal(input.events.length, 1);
    const fresh = await f.browser.inspect("a", tab.tabId);
    assert.equal(fresh.agentActionOutcomeUnknown, true);
    assert.equal(fresh.inputViewport, undefined);
    await assert.rejects(
      f.browser.navigate(
        "a",
        tab.tabId,
        "https://example.test/no",
        undefined,
        fresh.observationId,
      ),
      /input is blocked/,
    );
    await assert.rejects(
      f.browser.keyPress("a", tab.tabId, fresh.observationId, "Enter"),
      /input is blocked/,
    );
    await f.browser.closeTab("a", tab.tabId, undefined, fresh.observationId);
    assert.equal((await f.browser.listTabs("a")).length, 0);
  } finally {
    await f.close();
  }
});

function installTargetedInputFixture(debuggerApi: FakeDebugger) {
  const snapshot = {
    documentKey: "0123456789abcdef0123456789abcdef|https://example.test/input",
    viewport: {
      width: 640,
      height: 480,
      deviceScaleFactor: 2,
      scrollX: 0,
      scrollY: 0,
      visualScale: 1,
      visualOffsetX: 0,
      visualOffsetY: 0,
    },
    focusId: "input-1",
    focusNeedsShadowEvidence: true,
    inputRevision: 0,
    layoutRevision: 0,
  };
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const state: {
    snapshot: typeof snapshot;
    events: typeof events;
    afterInput?: () => void;
  } = { snapshot, events };
  const original = debuggerApi.sendCommand.bind(debuggerApi);
  debuggerApi.sendCommand = async (method, params) => {
    if (method.startsWith("Input.")) {
      events.push({ method, params: params ?? {} });
      snapshot.inputRevision++;
      state.afterInput?.();
      return {} as never;
    }
    if (method === "DOM.describeNode")
      return {
        node: {
          backendNodeId: 101,
          nodeType: 1,
          localName: "input",
          attributes: ["type", "text"],
        },
      } as never;
    if (method === "Runtime.releaseObject") return {} as never;
    if (method === "Runtime.evaluate") {
      if (params?.returnByValue === false)
        return {
          result: { subtype: "node", objectId: "workspace:focus" },
        } as never;
      assert.equal(params?.contextId, 42);
      return {
        result: {
          value: String(params?.expression).includes("const elements =")
            ? { ...actionInspection, inputSnapshot: structuredClone(snapshot) }
            : structuredClone(snapshot),
        },
      } as never;
    }
    return await original(method, params);
  };
  return state;
}

test("Workspace zoom keeps DOM inspection while omitting unsupported targeted input", async () => {
  const f = await sharedFixture();
  try {
    f.browser.bindThreadSession("a", "thread-a");
    const tab = await f.browser.open("a", "https://example.test/input");
    const input = installTargetedInputFixture(
      f.views[0]!.webContents.debuggerApi,
    );
    input.snapshot.viewport.visualScale = 2;
    const observed = await f.browser.inspect("a", tab.tabId);
    assert.equal(observed.visibleText, "fixture");
    assert.ok(observed.targets.some((target) => target.name === "Act"));
    assert.equal(observed.inputViewport, undefined);
    await assert.rejects(
      f.browser.pointerClick("a", tab.tabId, observed.observationId, 60, 40),
      /coherent screenshot/,
    );
    assert.equal(input.events.length, 0);
  } finally {
    await f.close();
  }
});

test("Workspace native dialog blocks targeted input without accepting or activating it", async () => {
  const f = await sharedFixture();
  try {
    f.browser.bindThreadSession("a", "thread-a");
    const tab = await f.browser.open("a", "https://example.test/input");
    const debuggerApi = f.views[0]!.webContents.debuggerApi;
    const input = installTargetedInputFixture(debuggerApi);
    const observed = await f.browser.inspect("a", tab.tabId);
    debuggerApi.emit("message", {}, "Page.javascriptDialogOpening");
    await assert.rejects(
      f.browser.pointerClick("a", tab.tabId, observed.observationId, 20, 30),
      /native dialog requires human control/,
    );
    assert.equal(input.events.length, 0);
    debuggerApi.emit("message", {}, "Page.javascriptDialogClosed");
    await f.browser.pointerClick(
      "a",
      tab.tabId,
      observed.observationId,
      20,
      30,
    );
    assert.equal(input.events.length, 2);
  } finally {
    await f.close();
  }
});

test("Workspace preserves stable native refusal but never classifies an unknown Runtime exception", async () => {
  for (const known of [true, false]) {
    const f = await sharedFixture();
    try {
      f.browser.bindThreadSession("a", "thread-a");
      const tab = await f.browser.open("a", "https://example.test/input");
      const debuggerApi = f.views[0]!.webContents.debuggerApi;
      const input = installTargetedInputFixture(debuggerApi);
      const observed = await f.browser.inspect("a", tab.tabId);
      const send = debuggerApi.sendCommand.bind(debuggerApi);
      debuggerApi.sendCommand = async (method, params) => {
        if (
          method === "Runtime.evaluate" &&
          String(params?.expression).includes("const hit = resolveHit")
        )
          return (
            known
              ? {
                  result: {
                    value: { browserInputUnsupported: "native-surface" },
                  },
                }
              : {
                  exceptionDetails: {
                    text: "Uncaught",
                    exception: {
                      description: "BROWSER_INPUT_UNSUPPORTED:native-surface",
                    },
                  },
                }
          ) as never;
        return await send(method, params);
      };
      await assert.rejects(
        f.browser.pointerClick("a", tab.tabId, observed.observationId, 5, 5),
        (error) =>
          known
            ? error instanceof BrowserInputUnsupportedError &&
              error.reason === "native-surface"
            : !(error instanceof BrowserInputUnsupportedError) &&
              /evaluation failed/.test(String(error)),
      );
      assert.equal(input.events.length, 0);
    } finally {
      await f.close();
    }
  }
});

test("borrowed rendering respects unchanged mounts, new leases and stale hide requests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-render-lease-"));
  const sender = new FakeWebContents(99),
    window = new FakeWindow(sender),
    view = new FakeView();
  let witness:
    | import("../src/main/workspace-browser-renderer.js").WorkspaceBrowserRenderMount
    | undefined;
  const releases: Array<boolean | undefined> = [];
  const browser = new WorkspaceBrowser({
    artifactDirectory: directory,
    dependencies: {
      createView: () => view as never,
      windowFor: () => window as never,
      renderWhileUnmounted: async (_view, current, operation) => {
        witness = current();
        return await operation();
      },
      releaseUnmountedView: () => {
        releases.push(witness?.isCurrent());
        if (witness?.isCurrent()) witness.invalidate();
      },
    },
  });
  try {
    browser.bindThreadSession("session", "thread");
    const tab = await browser.open("session", "https://example.test/start");
    const bounds = { x: 20, y: 30, width: 640, height: 480 };
    const mount = (lease: string, next = bounds) =>
      browser.mount(sender as never, {
        threadId: "thread",
        tabId: tab.tabId,
        lease,
        bounds: next,
      });
    mount("old");
    await browser.inspect("session", tab.tabId);
    const first = witness!;
    assert.equal(first.isCurrent(), true);
    const count = releases.length;
    view.setBounds({ x: 0, y: 0, width: 640, height: 480 }); // Temporary compositor origin.
    mount("old");
    assert.equal(
      releases.length,
      count,
      "identical UI notification must not interrupt the borrow",
    );
    assert.equal(first.isCurrent(), true);
    assert.deepEqual(view.getBounds(), { x: 0, y: 0, width: 640, height: 480 });
    const newer = { x: 7, y: 8, width: 600, height: 400 };
    mount("new", newer);
    assert.equal(releases.length, count + 1);
    assert.equal(
      releases.at(-1),
      true,
      "return old view before publishing a newer mount",
    );
    assert.equal(first.isCurrent(), false);
    assert.deepEqual(view.getBounds(), newer);
    await browser.inspect("session", tab.tabId);
    const fresh = witness!;
    browser.mount(sender as never, { lease: "old" });
    assert.equal(fresh.isCurrent(), true);
    browser.mount(sender as never, { lease: "new" });
    assert.equal(fresh.isCurrent(), false);
    assert.equal(
      releases.at(-1),
      false,
      "hide invalidates before release so cleanup cannot reattach the view",
    );
  } finally {
    await browser.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

class PhysicalView extends FakeView {
  parent?: PhysicalWindow;
  visible = true;
  override setVisible(value = true) {
    this.visible = value;
    return undefined;
  }
  getVisible() {
    return this.visible;
  }
}
class PhysicalWindow extends EventEmitter {
  visible = false;
  destroyed = false;
  readonly children: PhysicalView[] = [];
  readonly contentView = {
    children: this.children,
    addChildView: (view: PhysicalView) => {
      view.parent?.contentView.removeChildView(view);
      this.children.push(view);
      view.parent = this;
    },
    removeChildView: (view: PhysicalView) => {
      const index = this.children.indexOf(view);
      if (index >= 0) this.children.splice(index, 1);
      if (view.parent === this) view.parent = undefined;
    },
  };
  constructor(readonly webContents = new FakeWebContents(99)) {
    super();
  }
  getContentSize() {
    return [1200, 800];
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return false;
  }
  setIgnoreMouseEvents(value: boolean) {
    assert.equal(value, true);
  }
  showInactive() {
    this.visible = true;
    for (const view of this.children) {
      const callback = view.webContents.frame;
      setTimeout(
        () =>
          callback?.({ isEmpty: () => false, getSize: () => view.getBounds() }),
        10,
      );
    }
  }
  destroy() {
    assert.equal(this.children.length, 0);
    this.destroyed = true;
    this.emit("closed");
  }
}

for (const command of ["take-control", "return-control"] as const) {
  for (const stage of ["compositor-wait", "capture-pending"] as const) {
    for (const issuer of ["mount-owner", "other-ui-owner"] as const) {
      test(`${command} from ${issuer} during ${stage} returns the physical view before invalidating observation`, async () => {
        const { WorkspaceBrowserRenderer } =
          await import("../src/main/workspace-browser-renderer.js");
        const directory = await mkdtemp(
          path.join(os.tmpdir(), "zenx-control-render-"),
        );
        const owner = new PhysicalWindow(),
          other = new PhysicalWindow(new FakeWebContents(100));
        const view = new PhysicalView(),
          temporary: PhysicalWindow[] = [];
        const renderer = new WorkspaceBrowserRenderer(
          () => {
            const window = new PhysicalWindow();
            temporary.push(window);
            return window as never;
          },
          () => 1,
        );
        const browser = new WorkspaceBrowser({
          artifactDirectory: directory,
          dependencies: {
            createView: () => view as never,
            windowFor: (sender) => (sender.id === 99 ? owner : other) as never,
            renderWhileUnmounted: (v, current, operation) =>
              renderer.render(v, current, operation),
            releaseUnmountedView: (v) => renderer.release(v),
            closeUnmountedRenderer: () => renderer.close(),
          },
        });
        const captured = deferred<void>(),
          finish = deferred<FakeImage>();
        const nativeCapture = view.webContents.capturePage.bind(
          view.webContents,
        );
        try {
          browser.bindThreadSession("session", "thread");
          const tab = await browser.open(
            "session",
            "https://example.test/start",
          );
          const bounds = { x: 20, y: 30, width: 640, height: 480 };
          const mount = (lease = "old") =>
            browser.mount(owner.webContents as never, {
              threadId: "thread",
              tabId: tab.tabId,
              lease,
              bounds,
            });
          mount();
          if (command === "return-control")
            browser.command(
              owner.webContents as never,
              "thread",
              "take-control",
              tab.tabId,
            );
          let captureCalls = 0;
          view.webContents.capturePage = () => {
            captureCalls++;
            captured.resolve();
            return finish.promise;
          };
          const pending = browser.inspect("session", tab.tabId);
          const rejected = assert.rejects(pending, /stale|changed/);
          if (stage === "capture-pending") await captured.promise;
          else await new Promise((resolve) => setImmediate(resolve));
          assert.equal(view.parent, temporary[0]);
          const sender = issuer === "mount-owner" ? owner : other;
          browser.command(
            sender.webContents as never,
            "thread",
            command,
            tab.tabId,
          );
          assert.equal(
            view.parent,
            owner,
            "control command must return immediately, before native settlement",
          );
          assert.deepEqual(view.getBounds(), bounds);
          finish.resolve(new FakeImage());
          await rejected;
          assert.equal(captureCalls, stage === "capture-pending" ? 1 : 0);
          assert.equal(temporary[0]!.destroyed, true);
          mount();
          assert.equal(view.parent, owner);
          mount("new");
          assert.equal(view.parent, owner);
          view.webContents.capturePage = nativeCapture;
          await browser.inspect("session", tab.tabId);
          assert.equal(view.parent, owner);
          assert.equal(owner.visible, false);
          // A later legitimate owner must not be overwritten by old cleanup.
          browser.mount(other.webContents as never, {
            threadId: "thread",
            tabId: tab.tabId,
            lease: "successor",
            bounds,
          });
          await browser.inspect("session", tab.tabId);
          assert.equal(view.parent, other);
          assert.equal(owner.children.length, 0);
        } finally {
          finish.resolve(new FakeImage());
          await browser.shutdown();
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  }
}

for (const action of ["inspect", "scroll", "click"] as const)
  test(`Workspace ${action} forwards cancellation into the pending compositor lease before dispatch`, async () => {
    const { WorkspaceBrowserRenderer } =
      await import("../src/main/workspace-browser-renderer.js");
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-frame-abort-"),
    );
    const owner = new PhysicalWindow(),
      view = new PhysicalView();
    const renderer = new WorkspaceBrowserRenderer(
      () => new PhysicalWindow() as never,
      () => 1,
    );
    let observedSignal: AbortSignal | undefined;
    const browser = new WorkspaceBrowser({
      artifactDirectory: directory,
      dependencies: {
        createView: () => view as never,
        windowFor: () => owner as never,
        renderWhileUnmounted: (target, current, operation, signal) => {
          observedSignal = signal;
          return renderer.render(target, current, operation, signal);
        },
        releaseUnmountedView: (target) => renderer.release(target),
        closeUnmountedRenderer: () => renderer.close(),
      },
    });
    try {
      browser.bindThreadSession("session", "thread");
      const tab = await browser.open("session", "https://example.test/start");
      browser.mount(owner.webContents as never, {
        threadId: "thread",
        tabId: tab.tabId,
        lease: "ui",
        bounds: { x: 20, y: 30, width: 640, height: 480 },
      });
      view.webContents.debuggerApi.defaultValue = actionInspection;
      const observation = await browser.inspect("session", tab.tabId);
      const evaluations = view.webContents.debuggerApi.evaluations;
      view.webContents.beginFrameSubscription = () => {
        view.webContents.frame = undefined;
      };
      const controller = new AbortController(),
        reason = new Error("cancel before frame");
      const pending =
        action === "inspect"
          ? browser.inspect("session", tab.tabId, controller.signal)
          : action === "scroll"
            ? browser.scroll(
                "session",
                tab.tabId,
                observation.observationId,
                "down",
                100,
                controller.signal,
              )
            : browser.click(
                "session",
                tab.tabId,
                observation.observationId,
                observation.targets[0]!.targetId,
                controller.signal,
              );
      const rejected = assert.rejects(pending, (error) => error === reason);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(observedSignal, controller.signal);
      assert.notEqual(view.parent, owner);
      controller.abort(reason);
      assert.equal(
        view.parent,
        owner,
        "cancel immediately returns the physical view",
      );
      await rejected;
      assert.equal(
        view.webContents.debuggerApi.evaluations,
        evaluations,
        "cancelled readiness dispatches no page code",
      );
      assert.equal(
        browser.command(owner.webContents as never, "thread", "list")[0]!
          .agentActionOutcomeUnknown,
        false,
        "no page action was dispatched",
      );
    } finally {
      await browser.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

for (const change of ["navigation", "control", "session", "mount"] as const) {
  test(`${change} during capture redraw prevents native copy and observation publication`, async () => {
    const f = await sharedFixture();
    const entered = deferred<void>(),
      release = deferred<void>();
    try {
      f.browser.bindThreadSession("a", "thread-a");
      const tab = await f.browser.open("a", "https://example.test/start");
      const view = f.views[0]!;
      const send = view.webContents.debuggerApi.sendCommand.bind(
        view.webContents.debuggerApi,
      );
      view.webContents.debuggerApi.sendCommand = async (method, params) => {
        if (method === "Page.captureScreenshot") {
          entered.resolve();
          await release.promise;
          return {};
        }
        return await send(method, params);
      };
      let copies = 0;
      view.webContents.capturePage = async () => {
        copies++;
        return new FakeImage();
      };
      const inspection = f.browser.inspect("a", tab.tabId);
      const rejected = assert.rejects(
        inspection,
        /stale|control|session|target|changed/iu,
      );
      await entered.promise;
      if (change === "navigation")
        await view.webContents.loadURL("https://example.test/new");
      if (change === "control")
        f.browser.command(
          f.sender as never,
          "thread-a",
          "take-control",
          tab.tabId,
        );
      if (change === "session") {
        await f.browser.closeSession("a");
        f.browser.bindThreadSession("a", "thread-a");
      }
      if (change === "mount")
        f.browser.mount(f.sender as never, {
          threadId: "thread-a",
          tabId: tab.tabId,
          lease: "new-render-owner",
          bounds: { x: 0, y: 0, width: 640, height: 480 },
        });
      release.resolve();
      await rejected;
      assert.equal(
        copies,
        0,
        "an expired witness cannot dispatch the native copy",
      );
    } finally {
      release.resolve();
      await f.close();
    }
  });
}

async function navigationFixture() {
  const f = await sharedFixture();
  const first = f.browser.command(f.sender as never, "thread-a", "new")[0]!;
  const target = f.browser
    .command(f.sender as never, "thread-a", "new")
    .at(-1)!;
  await new Promise((resolve) => setImmediate(resolve));
  f.browser.bindThreadSession("navigation-session", "thread-a");
  const mount = (tabId: string, lease = "human-selected-page") =>
    f.browser.mount(f.sender as never, {
      threadId: "thread-a",
      tabId,
      lease,
      bounds: { x: 10, y: 20, width: 640, height: 480 },
    });
  const snapshot = () =>
    f.browser.command(f.sender as never, "thread-a", "list");
  return { ...f, first, target, mount, snapshot };
}

for (const sidebarClosed of [false, true]) {
  test(`Agent inspect/click leave ${sidebarClosed ? "closed sidebar" : "different selected tab"} and focus unchanged`, async () => {
    const f = await navigationFixture();
    try {
      f.mount(f.first.id);
      if (sidebarClosed)
        f.browser.mount(f.sender as never, { lease: "human-selected-page" });
      const mountedBefore = [...f.window.contentView.children];
      const mountsBefore = f.window.contentView.added.length;
      f.sender.sent.length = 0;
      const web = f.views[1]!.webContents;
      const inspectionGate = deferred<unknown>();
      web.debuggerApi.nextEvaluation = inspectionGate;
      const inspecting = f.browser.inspect("navigation-session", f.target.id);
      assert.equal(
        f.snapshot().find((tab) => tab.id === f.target.id)!
          .agentInspectionsInFlight,
        1,
      );
      assert.equal(
        f.snapshot().find((tab) => tab.id === f.first.id)!
          .agentInspectionsInFlight,
        0,
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        web.debuggerApi.evaluations,
        1,
        "inspection starts without a renderer acknowledgement",
      );
      inspectionGate.resolve(actionInspection);
      const observed = await inspecting;
      assert.equal(Object.hasOwn(observed, "automaticPresentation"), false);
      assert.equal(observed.tabId, f.target.id);
      assert.equal(
        f.snapshot().find((tab) => tab.id === f.target.id)!
          .agentInspectionsInFlight,
        0,
      );

      const actionGate = deferred<unknown>();
      web.debuggerApi.nextEvaluation = actionGate;
      const action = f.browser.click(
        "navigation-session",
        f.target.id,
        observed.observationId,
        observed.targets[0]!.targetId,
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        f.snapshot().find((tab) => tab.id === f.target.id)!
          .agentActionsInFlight,
        1,
      );
      assert.equal(
        f.snapshot().find((tab) => tab.id === f.first.id)!.agentActionsInFlight,
        0,
      );
      actionGate.resolve({ ok: true });
      await action;
      assert.equal(
        web.debuggerApi.evaluations,
        2,
        "exact target executes once, without replay",
      );
      assert.equal(f.views[0]!.webContents.debuggerApi.evaluations, 0);
      assert.ok(
        f
          .snapshot()
          .every(
            (tab) =>
              tab.agentActionsInFlight === 0 &&
              tab.agentInspectionsInFlight === 0,
          ),
      );
      assert.deepEqual(f.window.contentView.children, mountedBefore);
      assert.equal(f.window.contentView.added.length, mountsBefore);
      assert.equal(
        f.sender.focusCalls +
          f.views.reduce((sum, view) => sum + view.webContents.focusCalls, 0),
        0,
      );
      assert.ok(f.sender.sent.length > 0, "busy state remains observable");
      assert.ok(
        f.sender.sent.every(
          ({ channel }) => channel === "zenx:workspace-browser:changed",
        ),
        "Agent activity publishes state only, never presentation or focus requests",
      );
      assert.equal(
        f.views.length,
        2,
        "reuse the original pages without URL recreation",
      );
    } finally {
      await f.close();
    }
  });
}

test("concurrent hidden inspections count each admitted call until its own settlement", async () => {
  const f = await navigationFixture();
  const firstGate = deferred<unknown>();
  const secondGate = deferred<unknown>();
  try {
    const web = f.views[1]!.webContents;
    const count = () =>
      f.snapshot().find((tab) => tab.id === f.target.id)!
        .agentInspectionsInFlight;
    web.debuggerApi.nextEvaluation = firstGate;
    const first = f.browser.inspect("navigation-session", f.target.id);
    await new Promise((resolve) => setImmediate(resolve));
    web.debuggerApi.nextEvaluation = secondGate;
    const second = f.browser.inspect("navigation-session", f.target.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(count(), 2);
    firstGate.resolve(actionInspection);
    await first;
    assert.equal(
      count(),
      1,
      "one completion cannot clear another admitted inspection",
    );
    secondGate.resolve(actionInspection);
    await second;
    assert.equal(count(), 0);
    assert.equal(web.debuggerApi.evaluations, 2);
    assert.deepEqual(f.window.contentView.children, []);
    assert.equal(f.window.contentView.added.length, 0);
  } finally {
    firstGate.resolve(actionInspection);
    secondGate.resolve(actionInspection);
    await f.close();
  }
});

test("Agent open never mounts or focuses its new target while a different human tab is selected", async () => {
  const f = await navigationFixture();
  try {
    f.mount(f.first.id);
    f.sender.sent.length = 0;
    const opened = await f.browser.open(
      "navigation-session",
      "https://example.test/agent-new",
    );
    assert.notEqual(opened.tabId, f.first.id);
    assert.deepEqual(f.window.contentView.children, [f.views[0]]);
    assert.equal(f.window.contentView.added.length, 1);
    assert.equal(
      f.sender.focusCalls +
        f.views.reduce((sum, view) => sum + view.webContents.focusCalls, 0),
      0,
    );
    assert.ok(
      f.sender.sent.every(
        ({ channel }) => channel === "zenx:workspace-browser:changed",
      ),
    );
    assert.equal(
      f.snapshot().find((tab) => tab.id === opened.tabId)!.agentActionsInFlight,
      0,
    );
  } finally {
    await f.close();
  }
});

test("explicit human mount and navigation retain exact ownership and stale lease cleanup safety", async () => {
  const f = await navigationFixture();
  try {
    f.mount(f.first.id);
    f.mount(f.target.id, "new-human-selection");
    f.browser.mount(f.sender as never, { lease: "human-selected-page" });
    assert.deepEqual(f.window.contentView.children, [f.views[1]]);
    f.browser.command(
      f.sender as never,
      "thread-a",
      "navigate",
      f.target.id,
      "https://example.test/human-request",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      (await f.browser.inspect("navigation-session", f.target.id)).url,
      "https://example.test/human-request",
    );
    assert.throws(
      () =>
        f.browser.mount(new FakeWebContents(100) as never, {
          threadId: "thread-a",
          tabId: f.target.id,
          lease: "forged",
          bounds: { x: 0, y: 0, width: 640, height: 480 },
        }),
      /owning window/,
    );
    assert.throws(
      () =>
        f.browser.mount(f.sender as never, {
          threadId: "thread-b",
          tabId: f.target.id,
          lease: "forged",
          bounds: { x: 0, y: 0, width: 640, height: 480 },
        }),
      /not in this Thread/,
    );
    assert.deepEqual(f.window.contentView.children, [f.views[1]]);
  } finally {
    await f.close();
  }
});

test("cancelled background inspection settles busy state without a display acknowledgement", async () => {
  const f = await navigationFixture();
  try {
    const web = f.views[1]!.webContents;
    const preAborted = new AbortController();
    preAborted.abort(new Error("cancel before inspection"));
    await assert.rejects(
      f.browser.inspect("navigation-session", f.target.id, preAborted.signal),
      /cancel before inspection/,
    );
    assert.equal(web.debuggerApi.evaluations, 0);
    const gate = deferred<unknown>();
    web.debuggerApi.nextEvaluation = gate;
    const controller = new AbortController();
    const inspecting = f.browser.inspect(
      "navigation-session",
      f.target.id,
      controller.signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("cancel background inspection"));
    gate.resolve(actionInspection);
    await assert.rejects(inspecting, /cancel background inspection/);
    assert.equal(
      f.snapshot().find((tab) => tab.id === f.target.id)!
        .agentInspectionsInFlight,
      0,
    );
    assert.equal(f.snapshot().length, 2);
    assert.deepEqual(f.window.contentView.children, []);
  } finally {
    await f.close();
  }
});

for (const change of ["session", "shutdown"] as const) {
  test(`${change} during background inspection settles without a display acknowledgement`, async () => {
    const f = await navigationFixture();
    try {
      const gate = deferred<unknown>();
      f.views[1]!.webContents.debuggerApi.nextEvaluation = gate;
      const inspecting = f.browser.inspect("navigation-session", f.target.id);
      await new Promise((resolve) => setImmediate(resolve));
      if (change === "session") {
        f.browser.closeSession("navigation-session");
        f.browser.bindThreadSession("navigation-session", "thread-a");
      } else await f.browser.shutdown();
      gate.resolve(actionInspection);
      await assert.rejects(
        inspecting,
        /session changed|Unknown browser target/,
      );
      assert.ok(
        f.snapshot().every((tab) => tab.agentInspectionsInFlight === 0),
      );
      assert.deepEqual(f.window.contentView.children, []);
    } finally {
      await f.close();
    }
  });
}

test("blank browser native background follows appearance without recoloring websites, loading or errors", async () => {
  const f = await sharedFixture();
  try {
    const [tab] = f.browser.command(f.sender as never, "thread-a", "new");
    await new Promise((resolve) => setImmediate(resolve));
    const view = f.views[0]!;
    const mount = (appearance: string) =>
      f.browser.mount(f.sender as never, {
        threadId: "thread-a",
        tabId: tab!.id,
        lease: "theme",
        appearance,
        bounds: { x: 0, y: 0, width: 640, height: 480 },
      });
    mount("dark");
    assert.equal(view.backgroundColor, "#000000");
    mount("light");
    assert.equal(view.backgroundColor, "#ffffff");
    const script = view.webContents.appearanceScripts.at(-1)!;
    const style: Record<string, string> = {};
    runInNewContext(script, {
      location: { href: "about:blank" },
      document: { documentElement: { style } },
    });
    assert.deepEqual(style, {
      colorScheme: "light",
      backgroundColor: "#ffffff",
    });
    const siteStyle = {};
    runInNewContext(script, {
      location: { href: "https://example.test/" },
      document: { documentElement: { style: siteStyle } },
    });
    assert.deepEqual(
      siteStyle,
      {},
      "navigation before execution cannot restyle a website",
    );
    mount("dark");
    const blankScripts = view.webContents.appearanceScripts.length;
    view.webContents.finishLoad("https://example.test/");
    assert.equal(view.webContents.appearanceScripts.length, blankScripts);
    assert.equal(
      view.backgroundColor,
      "#ffffff",
      "real page keeps native default background",
    );
    view.webContents.finishLoad("about:blank");
    assert.equal(view.backgroundColor, "#000000");
    view.webContents.isLoading = () => true;
    view.webContents.emit("did-start-loading");
    assert.equal(view.backgroundColor, "#ffffff", "loading is not blank");
    view.webContents.isLoading = () => false;
    view.webContents.emit("did-stop-loading");
    assert.equal(view.backgroundColor, "#000000");
    view.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    assert.equal(view.backgroundColor, "#ffffff", "error is not blank");
  } finally {
    await f.close();
  }
});

test("same-lease human mount and theme changes retain the captured observation", async () => {
  const f = await navigationFixture();
  try {
    const view = f.views[1]!;
    view.webContents.debuggerApi.defaultValue = actionInspection;
    const request = {
      threadId: "thread-a",
      tabId: f.target.id,
      lease: "combined",
      bounds: { x: 10, y: 20, width: 640, height: 480 },
    };
    f.browser.mount(f.sender as never, { ...request, appearance: "light" });
    const observation = await f.browser.inspect(
      "navigation-session",
      f.target.id,
    );
    f.browser.mount(f.sender as never, { ...request, appearance: "dark" });
    assert.equal(view.backgroundColor, "#000000");
    f.browser.mount(f.sender as never, { ...request, appearance: "light" });
    assert.equal(view.backgroundColor, "#ffffff");
    view.webContents.debuggerApi.defaultValue = { ok: true };
    await f.browser.click(
      "navigation-session",
      f.target.id,
      observation.observationId,
      observation.targets[0]!.targetId,
    );
    assert.equal(f.views.length, 2);
  } finally {
    await f.close();
  }
});

test("native materialization is idempotent without reloading, owner isolated, and tombstoned", async () => {
  const f = await sharedFixture();
  try {
    const create = (
      owner: string,
      intent: string,
      url = "https://example.test/same",
    ) =>
      f.browser
        .command(f.sender as never, owner, "materialize", intent, url)
        .at(-1)!;
    const first = create("thread-a", "room:r:intent-1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.views.length, 1);
    assert.equal(f.views[0]!.webContents.loadCalls.length, 1);
    const replay = create("thread-a", "room:r:intent-1");
    assert.equal(replay.id, first.id);
    assert.equal(f.views.length, 1);
    assert.equal(f.views[0]!.webContents.loadCalls.length, 1);
    assert.throws(
      () =>
        create("thread-a", "room:r:intent-1", "https://example.test/changed"),
      /URL changed/,
    );
    assert.equal(f.views.length, 1);
    const duplicate = create("thread-a", "room:r:intent-2");
    assert.notEqual(duplicate.id, first.id);
    assert.equal(f.views.length, 2);
    const privateIntent = create("thread-a", "thread:thread-a:intent-1");
    assert.notEqual(privateIntent.id, first.id);
    const otherOwner = create("thread-b", "room:r:intent-1");
    assert.notEqual(otherOwner.id, first.id);
    f.browser.command(f.sender as never, "thread-a", "close", first.id);
    assert.throws(() => create("thread-a", "room:r:intent-1"), /was closed/);
    assert.equal(create("thread-a", "room:r:intent-2").id, duplicate.id);
  } finally {
    await f.close();
  }
});

test("Board liveness is a pure exact Thread lookup independent of loading or human control", async () => {
  const fixture = await sharedFixture();
  try {
    fixture.browser.bindThreadSession("board-session", "thread-a");
    const tab = await fixture.browser.open(
      "board-session",
      "https://example.test/board",
    );
    const view = fixture.views[0]!.webContents;
    const loading = view.isLoading.bind(view);
    view.isLoading = () => true;
    assert.equal(fixture.browser.hasThreadTab("thread-a", tab.tabId), true);
    assert.equal(fixture.browser.hasTab("board-session", tab.tabId), true);
    assert.equal(fixture.browser.hasThreadTab("other", tab.tabId), false);
    assert.equal(fixture.browser.hasTab("unknown", tab.tabId), false);
    view.isLoading = loading;
    await fixture.browser.closeTab("board-session", tab.tabId);
    assert.equal(fixture.browser.hasThreadTab("thread-a", tab.tabId), false);
  } finally {
    await fixture.close();
  }
});
