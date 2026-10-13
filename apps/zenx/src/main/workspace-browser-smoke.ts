import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rm } from "node:fs";
import os from "node:os";
import path from "node:path";

import { app, BrowserWindow, type WebContentsView } from "electron";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceBrowserPanel } from "../renderer/src/workspace-browser-panel.js";
import { i18n } from "../renderer/src/i18n.js";
import type { WorkspaceBrowserTab } from "./workspace-browser.js";

import type { BrowserInspection } from "./capabilities/browser-provider.js";
import { createElectronWorkspaceBrowser } from "./workspace-browser-electron.js";

const directory = mkdtempSync(
  path.join(os.tmpdir(), "zenx-shared-workspace-browser-smoke-"),
);
app.setPath("userData", path.join(directory, "user-data"));
app.on("window-all-closed", () => undefined);

let markSlowRequestStarted!: () => void;
const slowRequestStarted = new Promise<void>((resolve) => {
  markSlowRequestStarted = resolve;
});
const fixture = createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/handoff") {
    response.end(`<!doctype html><title>Synthetic handoff fixture</title>
      <main><h1>Local test only</h1>
      <button id="login" onclick="sessionStorage.setItem('fixture-login','yes');document.querySelector('#login-state').textContent='Signed in to local fixture'">Synthetic sign in</button>
      <p id="login-state">Signed out</p>
      <label>Draft <input aria-label="Draft"></label>
      <button id="confirm" onclick="document.querySelector('output').textContent='Confirmed '+document.querySelector('input').value;this.dataset.count=String(Number(this.dataset.count||0)+1)">Confirm local draft</button>
      <output>Unconfirmed</output></main>`);
    return;
  }
  if (request.url === "/slow") {
    markSlowRequestStarted();
    setTimeout(
      () => response.end("<!doctype html><title>Old slow page</title>"),
      250,
    );
    return;
  }
  if (request.url === "/fast") {
    response.end("<!doctype html><title>Latest fast page</title>");
    return;
  }
  if (request.url === "/agent-destination") {
    response.end("<!doctype html><title>Agent destination</title>");
    return;
  }
  response.end(`<!doctype html>
    <title>Shared browser fixture</title>
    <main>
      <label>Human value <input aria-label="Human value"></label>
      <button onclick="document.querySelector('output').textContent='Agent clicked'">Agent action</button>
      <a href="/agent-destination">Agent navigation</a>
      <output>Waiting</output>
    </main>`);
});

void app.whenReady().then(async () => {
  let owner: BrowserWindow | undefined;
  let createdView: WebContentsView | undefined;
  const browser = createElectronWorkspaceBrowser({
    artifactDirectory: path.join(directory, "artifacts"),
    onCreateView: (view) => {
      createdView = view;
    },
  });
  try {
    const port = await listen();
    const url = `http://127.0.0.1:${String(port)}/shared`;
    owner = new BrowserWindow({ show: false, width: 900, height: 700 });
    await owner.loadURL("about:blank");

    const humanTabs = browser.command(
      owner.webContents,
      "shared-thread",
      "new",
      undefined,
      url,
    );
    const tabId = humanTabs[0]?.id;
    assert.ok(tabId, "Human navigation must create a shared tab");
    browser.bindThreadSession("shared-session", "shared-thread");
    await eventually(async () => {
      const current = (await browser.listTabs("shared-session"))[0];
      assert.equal(current?.url, url);
      assert.equal(current?.loading, false);
    });
    assert.ok(createdView);
    let liveFrameCount = 0;
    let liveFrameError: string | undefined;
    const stopLiveObservation = browser.observeTab(
      "shared-session",
      tabId,
      (event) => {
        if (event.type === "frame") {
          if (
            event.frame.mimeType !== "image/jpeg" ||
            event.frame.data.length < 1_000
          )
            liveFrameError = "Invalid unmounted Browser live frame";
          liveFrameCount += 1;
        }
        if (event.type === "status" && event.status === "failed")
          liveFrameError = event.message;
      },
    );
    try {
      await eventually(async () => {
        assert.equal(liveFrameError, undefined);
        assert.ok(liveFrameCount >= 2, "Expected two unmounted live frames");
      });
    } finally {
      stopLiveObservation();
    }
    assert.equal(
      BrowserWindow.getAllWindows().length,
      1,
      "live capture must release its temporary renderer",
    );
    const unmountedInspection = await browser.inspect("shared-session", tabId);
    assert.match(unmountedInspection.visibleText, /Human value/u);
    assert.ok(
      unmountedInspection.screenshot.bytes > 0,
      "Agent inspection must capture an unmounted Browser tab",
    );
    const hiddenInput = requiredTarget(
      unmountedInspection,
      "Human value",
      "type",
    );
    await browser.type(
      "shared-session",
      tabId,
      unmountedInspection.observationId,
      hiddenInput.targetId,
      "Agent hidden",
      false,
    );
    const afterHiddenAction = await browser.inspect("shared-session", tabId);
    assert.equal(
      requiredTarget(afterHiddenAction, "Human value", "type").value,
      "Agent hidden",
      "the Agent must use the same unmounted page for actions",
    );
    assert.equal(
      BrowserWindow.getAllWindows().length,
      1,
      "the temporary renderer must close after each Agent operation",
    );
    await assert.rejects(
      browser.scroll("shared-session", tabId, "stale", "down", 100),
      /stale or unknown/u,
    );
    assert.equal(
      BrowserWindow.getAllWindows().length,
      1,
      "the temporary renderer must close when an operation fails",
    );
    const handoffInspection = browser.inspect("shared-session", tabId);
    await eventually(async () => {
      assert.equal(
        BrowserWindow.getAllWindows().length,
        2,
        "the Agent inspection must start on the temporary renderer",
      );
    });
    browser.mount(owner.webContents, {
      threadId: "shared-thread",
      tabId,
      lease: "shared-smoke",
      bounds: { x: 20, y: 20, width: 700, height: 500 },
    });
    owner.showInactive();
    await handoffInspection;
    assert.equal(
      BrowserWindow.getAllWindows().length,
      1,
      "mounting for the user must close the temporary renderer",
    );
    assert.ok(createdView, "Electron factory must create a WebContentsView");
    assert.equal(owner.contentView.children[0], createdView);
    assert.equal(
      owner.contentView.children[0]?.webContents.id,
      createdView.webContents.id,
      "The mounted human view must be the Agent target WebContents",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    let inspection = await browser.inspect("shared-session", tabId);
    assert.equal(inspection.url, url);
    assert.match(inspection.visibleText, /Human value/u);

    await createdView.webContents.executeJavaScript(
      "document.querySelector('input').focus();document.querySelector('input').select()",
    );
    createdView.webContents.insertText("typed by human");
    inspection = await browser.inspect("shared-session", tabId);
    assert.equal(
      requiredTarget(inspection, "Human value", "type").value,
      "typed by human",
    );
    browser.mount(owner.webContents, {
      threadId: "shared-thread",
      tabId,
      lease: "shared-smoke",
      bounds: { x: 20, y: 20, width: 700, height: 500 },
    });

    const action = requiredTarget(inspection, "Agent action", "click");
    await browser.click(
      "shared-session",
      tabId,
      inspection.observationId,
      action.targetId,
    );
    assert.equal(
      await createdView.webContents.executeJavaScript(
        "document.querySelector('output').textContent",
      ),
      "Agent clicked",
      "Agent action must mutate the mounted human page",
    );

    inspection = await browser.inspect("shared-session", tabId);
    const beforeHumanRoute = requiredTarget(
      inspection,
      "Agent navigation",
      "click",
    );
    await createdView.webContents.executeJavaScript(
      "history.pushState({}, '', '/human-route')",
    );
    await assert.rejects(
      browser.click(
        "shared-session",
        tabId,
        inspection.observationId,
        beforeHumanRoute.targetId,
      ),
      /observation is stale or unknown/u,
      "a human SPA route change must invalidate the earlier observation",
    );

    inspection = await browser.inspect("shared-session", tabId);
    const agentNavigation = requiredTarget(
      inspection,
      "Agent navigation",
      "click",
    );
    await browser.click(
      "shared-session",
      tabId,
      inspection.observationId,
      agentNavigation.targetId,
    );
    const agentDestination = `http://127.0.0.1:${String(port)}/agent-destination`;
    await eventually(async () =>
      assert.equal(
        (await browser.listTabs("shared-session"))[0]?.url,
        agentDestination,
      ),
    );

    const superseded = browser.navigate(
      "shared-session",
      tabId,
      `http://127.0.0.1:${String(port)}/slow`,
    );
    await slowRequestStarted;
    const supersededFailure = assert.rejects(
      superseded,
      /superseded|interrupted/u,
    );
    await browser.navigate(
      "shared-session",
      tabId,
      `http://127.0.0.1:${String(port)}/fast`,
    );
    await supersededFailure;
    assert.equal(
      (await browser.listTabs("shared-session"))[0]?.url,
      `http://127.0.0.1:${String(port)}/fast`,
      "Chromium must cancel the older load and retain the latest navigation",
    );

    // Local synthetic login and confirmation only: no real account, secret,
    // external form submission, profile export, or permission grant.
    await browser.navigate(
      "shared-session",
      tabId,
      `http://127.0.0.1:${String(port)}/handoff`,
    );
    browser.command(owner.webContents, "shared-thread", "take-control", tabId);
    const originalWebContentsId = createdView.webContents.id;
    await createdView.webContents.executeJavaScript(
      "document.querySelector('#login').click();document.querySelector('input').focus()",
    );
    createdView.webContents.insertText("human draft");
    const humanObservation = await browser.inspect("shared-session", tabId);
    assert.match(humanObservation.visibleText, /Signed in to local fixture/u);
    assert.equal(
      requiredTarget(humanObservation, "Draft", "type").value,
      "human draft",
    );
    await assert.rejects(
      browser.click(
        "shared-session",
        tabId,
        humanObservation.observationId,
        requiredTarget(humanObservation, "Confirm local draft", "click")
          .targetId,
      ),
      /human control/u,
    );
    assert.equal(
      await createdView.webContents.executeJavaScript(
        "document.querySelector('output').textContent",
      ),
      "Unconfirmed",
    );
    browser.command(
      owner.webContents,
      "shared-thread",
      "return-control",
      tabId,
    );
    await assert.rejects(
      browser.navigate("shared-session", tabId, url),
      /fresh observation/u,
    );
    let handedBack = await browser.inspect("shared-session", tabId);
    await assert.rejects(
      browser.closeTab(
        "shared-session",
        tabId,
        undefined,
        humanObservation.observationId,
      ),
      /stale/u,
    );
    await browser.type(
      "shared-session",
      tabId,
      handedBack.observationId,
      requiredTarget(handedBack, "Draft", "type").targetId,
      "Agent reviewed draft",
      false,
    );
    browser.command(owner.webContents, "shared-thread", "take-control", tabId);
    browser.command(owner.webContents, "shared-thread", "take-control", tabId);
    await createdView.webContents.executeJavaScript(
      "document.querySelector('#confirm').click()",
    );
    browser.command(
      owner.webContents,
      "shared-thread",
      "return-control",
      tabId,
    );
    handedBack = await browser.inspect("shared-session", tabId);
    assert.match(handedBack.visibleText, /Confirmed Agent reviewed draft/u);
    assert.equal(
      await createdView.webContents.executeJavaScript(
        "document.querySelector('#confirm').dataset.count",
      ),
      "1",
      "handing back never replays confirmation",
    );
    assert.equal(
      await createdView.webContents.executeJavaScript(
        "sessionStorage.getItem('fixture-login')",
      ),
      "yes",
    );
    assert.equal(
      createdView.webContents.id,
      originalWebContentsId,
      "login and form stay on the same actual page",
    );
    await assert.rejects(
      browser.closeTab("shared-session", tabId),
      /fresh observation/u,
      "a queued no-reference close stays fenced even after inspect",
    );

    assert.equal(browser.closeSession("shared-session"), 0);
    assert.equal(
      browser.command(owner.webContents, "shared-thread", "list").length,
      1,
      "Ending the Agent session must preserve the shared human page",
    );
    await assertStableControlLayout();
    console.log(
      JSON.stringify({
        passed: true,
        tabId,
        webContentsId: createdView.webContents.id,
        url,
        unmountedScreenshot: {
          width: unmountedInspection.screenshot.width,
          height: unmountedInspection.screenshot.height,
          bytes: unmountedInspection.screenshot.bytes,
        },
        checks: [
          "unmounted live observation delivers frames and releases its renderer",
          "unmounted Agent inspect captures a screenshot and visible targets",
          "unmounted Agent action changes the same page",
          "temporary rendering closes on success and failure",
          "a user mount takes the same WebContents from a pending Agent render",
          "an unchanged UI mount preserves the Agent observation",
          "human navigation is visible to Browser inspect",
          "human Chromium input is visible to Browser inspect",
          "Browser click mutates the mounted human page",
          "human mount and Agent target share one WebContents id",
          "human SPA navigation invalidates the earlier Agent observation",
          "Agent click navigation succeeds on the same shared WebContents",
          "Chromium cancels an older load and the provider reports it stale",
          "synthetic login and form state survive explicit same-page human takeover/return",
          "all human-owned Agent mutations reject; return requires fresh observation",
          "human confirmation occurs exactly once and is never replayed on return",
          "old no-reference close remains fenced even after a fresh inspection",
          "production control status preserves native viewport geometry at 320/390/900px in English and Chinese",
        ],
      }),
    );
  } catch (error) {
    console.error("ZenX shared Workspace Browser smoke failed", error);
    process.exitCode = 1;
  } finally {
    await browser.shutdown();
    owner?.destroy();
    await closeFixture();
    rm(directory, { recursive: true, force: true }, () => {
      const exitCode = process.exitCode;
      app.exit(typeof exitCode === "number" ? exitCode : exitCode ? 1 : 0);
    });
  }
});

function requiredTarget(
  inspection: BrowserInspection,
  name: string,
  action: "click" | "type",
): BrowserInspection["targets"][number] {
  const target = inspection.targets.find(
    (candidate) =>
      candidate.name === name && candidate.actions.includes(action),
  );
  assert.ok(target, `Missing ${action} target ${name}`);
  return target;
}

async function eventually(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

async function listen(): Promise<number> {
  return await new Promise((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", () => {
      fixture.removeListener("error", reject);
      const address = fixture.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Shared browser fixture did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeFixture(): Promise<void> {
  if (!fixture.listening) return;
  await new Promise<void>((resolve, reject) =>
    fixture.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

/** Real Chromium layout, with production panel markup and the actual stylesheet.
 * This development smoke is invoked from apps/zenx by its package script. */
async function assertStableControlLayout(): Promise<void> {
  const css = readFileSync(path.resolve("src/renderer/src/styles.css"), "utf8");
  const layout = new BrowserWindow({ show: false, width: 900, height: 700 });
  try {
    await layout.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`<style>${css}</style><main style="height:700px;width:900px" id="fixture"></main>`)}`,
    );
    layout.showInactive();
    const tab: WorkspaceBrowserTab = {
      id: "layout",
      threadId: "layout-thread",
      title: "Local fixture",
      url: "http://localhost/fixture",
      loading: false,
      canGoBack: true,
      canGoForward: false,
      sharedWithAgent: true,
      control: "agent",
      agentActionsInFlight: 0,
      agentActionOutcomeUnknown: false,
      requiresFreshObservation: false,
    };
    for (const language of ["en", "zh-CN"]) {
      await i18n.changeLanguage(language);
      for (const width of [320, 390, 900]) {
        // Exercise real narrow workspace columns without depending on the
        // desktop window manager honoring asynchronous native window resizing.
        let expected: unknown;
        let buttonsVisible = true;
        let statusesReadable = true;
        for (const state of [
          {},
          { control: "human", requiresFreshObservation: true },
          { requiresFreshObservation: true },
          { agentActionsInFlight: 1, requiresFreshObservation: true },
          { agentActionOutcomeUnknown: true, requiresFreshObservation: true },
          {},
        ] as Partial<WorkspaceBrowserTab>[]) {
          const markup = renderToStaticMarkup(
            React.createElement(WorkspaceBrowserPanel, {
              threadId: tab.threadId,
              tab: { ...tab, ...state },
              open: true,
            }),
          );
          const measured = await layout.webContents
            .executeJavaScript(`(async()=>{
            document.querySelector('#fixture').style.width=${width}+'px';
            document.querySelector('#fixture').innerHTML=${JSON.stringify(markup)};
            await new Promise(requestAnimationFrame);
            const viewport=document.querySelector('.workspace-browser-viewport').getBoundingClientRect();
            const control=document.querySelector('.workspace-browser-control').getBoundingClientRect();
            const button=document.querySelector('.workspace-browser-control button').getBoundingClientRect();
            const status=document.querySelector('[role="status"]');
            return {viewport:[viewport.x,viewport.y,viewport.width,viewport.height],
              buttonVisible:button.x>=control.x&&button.right<=control.right&&button.y>=control.y&&button.bottom<=control.bottom,
              statusKeyboardScrollable:status.tabIndex===0&&status.clientHeight>0&&getComputedStyle(status).overflowY==='auto'};
          })()`);
          assert.equal(
            measured.viewport[2],
            width,
            "Fixture must exercise the requested actual panel width",
          );
          expected ??= measured.viewport;
          assert.deepEqual(
            measured.viewport,
            expected,
            `Status changed native viewport at ${width}px/${language}: ${JSON.stringify(state)}`,
          );
          buttonsVisible &&= measured.buttonVisible;
          statusesReadable &&= measured.statusKeyboardScrollable;
        }
        assert.equal(
          buttonsVisible,
          true,
          "Control action must stay visible without scrolling status",
        );
        assert.equal(
          statusesReadable,
          true,
          "Overflowing notices remain keyboard-readable",
        );
      }
    }
  } finally {
    await i18n.changeLanguage("en");
    layout.destroy();
  }
}
