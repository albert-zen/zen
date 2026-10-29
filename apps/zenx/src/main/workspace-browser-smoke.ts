import { BrowserInputUnsupportedError } from "./capabilities/browser-targeted-input.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rm,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  app,
  BrowserWindow,
  nativeImage,
  nativeTheme,
  screen,
  type WebContentsView,
} from "electron";

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

let smokePhase = "startup";
const captureTrace: unknown[] = [];
let captureSequence = 0;
/** Diagnostic-only wrapping of the exact capture call; no retries or API changes. */
function traceCaptures(view: WebContentsView): void {
  const capture = view.webContents.capturePage.bind(view.webContents);
  const record = (
    stage: "start" | "success" | "failed",
    sequence: number,
    phase: string,
  ) => {
    try {
      captureTrace.push({
        phase,
        stage,
        sequence,
        webContentsId: view.webContents.id,
        destroyed: view.webContents.isDestroyed(),
        visible: view.getVisible(),
        bounds: view.getBounds(),
        focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
        windows: BrowserWindow.getAllWindows()
          .slice(0, 8)
          .map((window) => ({
            id: window.id,
            visible: window.isVisible(),
            minimized: window.isMinimized(),
            attached: window.contentView.children.includes(view),
          })),
      });
      if (captureTrace.length > 24) captureTrace.shift();
    } catch {
      /* A destroyed view cannot alter the capture outcome via diagnostics. */
    }
  };
  view.webContents.capturePage = async (
    ...args: Parameters<typeof capture>
  ) => {
    const sequence = ++captureSequence;
    const phase = smokePhase;
    record("start", sequence, phase);
    try {
      const image = await capture(...args);
      record("success", sequence, phase);
      return image;
    } catch (error) {
      record("failed", sequence, phase);
      throw error;
    }
  };
}

let markSlowRequestStarted!: () => void;
const slowRequestStarted = new Promise<void>((resolve) => {
  markSlowRequestStarted = resolve;
});
const fixture = createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/blank-theme-site") {
    response.end(
      "<!doctype html><title>Website appearance fixture</title><style>html,body{margin:0;width:100%;height:100%;background:rgb(80,80,80)}</style>",
    );
    return;
  }
  if (request.url === "/input") {
    response.end(`<!doctype html><title>Targeted input fixture</title><style>body{margin:0;min-height:2200px}canvas{position:absolute;left:10px;top:100px;background:#adc}form{position:absolute;left:10px;top:200px}#file{position:absolute;left:10px;top:300px}</style>
      <output id="result">No canvas click</output><p id="focus">Focus none</p>
      <canvas width="200" height="80" tabindex="0" onclick="this.focus();document.querySelector('#result').textContent='Canvas clicked '+event.isTrusted"></canvas>
      <form onsubmit="event.preventDefault();document.querySelector('#result').textContent='Submitted '+document.querySelector('#text').value"><input id="text" aria-label="Targeted text"><button type="button" id="next">Next</button></form><input type="file" id="file"><label for="file" style="position:absolute;left:10px;top:350px"><span>Choose native file</span></label>
      <script>document.addEventListener('focusin',()=>document.querySelector('#focus').textContent='Focus '+(document.activeElement.id||document.activeElement.tagName));</script>`);
    return;
  }
  if (request.url === "/capture-marker") {
    response.end(`<!doctype html><title>Capture pixel fixture</title>
      <style>html,body{margin:0;background:rgb(24,48,72)}
      #capture-marker{position:fixed;left:16px;top:80px;width:96px;height:96px;background:rgb(12,180,64)}</style>
      <label>Human value <input aria-label="Human value"></label>
      <div id="capture-marker"></div>`);
    return;
  }
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
    <style>html,body{margin:0;background:rgb(24,48,72)}
      #capture-marker{position:fixed;left:16px;top:80px;width:96px;height:96px;background:rgb(12,180,64)}</style>
    <div id="capture-marker"></div>
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
  let captureCalls = 0;
  let frameSubscriptions = 0;
  let frameCallbacks = 0;
  let frameStops = 0;
  let activeFrameSubscription: number | undefined;
  let lastFrameSubscription = 0;
  let subscriptionNotice: { id: number; complete(): void } | undefined;
  let phase = "setup";
  let layoutStarted = false;
  const traceStarted = Date.now();
  const sharedTrace: Array<Record<string, unknown>> = [];
  let sharedTraceDropped = 0;
  const traceCleanup: Array<() => void> = [];
  const traceShared = (event: string) => {
    try {
      if (sharedTrace.length === 48) {
        sharedTrace.shift();
        sharedTraceDropped++;
      }
      sharedTrace.push({
        event,
        phase,
        elapsedMs: Date.now() - traceStarted,
        captureCalls,
        frameSubscriptions,
        frameCallbacks,
        frameStops,
        ownerVisible:
          owner && !owner.isDestroyed() ? owner.isVisible() : undefined,
        ownerMinimized:
          owner && !owner.isDestroyed() ? owner.isMinimized() : undefined,
        ownerHasView:
          owner && !owner.isDestroyed() && createdView
            ? owner.contentView.children.includes(createdView)
            : undefined,
        viewBounds:
          createdView && !createdView.webContents.isDestroyed()
            ? createdView.getBounds()
            : undefined,
      });
    } catch {
      /* Fixture diagnostics never replace operation failures. */
    }
  };
  const browser = createElectronWorkspaceBrowser({
    artifactDirectory: path.join(directory, "artifacts"),
    onCreateView: (view) => {
      createdView = view;
      const started = () => traceShared("document-navigation-start");
      const inPage = () => traceShared("document-in-page-navigation");
      const finished = () => traceShared("document-load-finished");
      view.webContents.on("did-start-navigation", started);
      view.webContents.on("did-navigate-in-page", inPage);
      view.webContents.on("did-finish-load", finished);
      traceCleanup.push(() => {
        view.webContents.removeListener("did-start-navigation", started);
        view.webContents.removeListener("did-navigate-in-page", inPage);
        view.webContents.removeListener("did-finish-load", finished);
      });
      const begin = view.webContents.beginFrameSubscription.bind(
        view.webContents,
      );
      const end = view.webContents.endFrameSubscription.bind(view.webContents);
      type FrameCallback = Parameters<typeof begin>[0];
      view.webContents.beginFrameSubscription = (
        dirtyOrCallback: boolean | FrameCallback,
        callback?: FrameCallback,
      ) => {
        const id = ++frameSubscriptions;
        activeFrameSubscription = id;
        const handler =
          typeof dirtyOrCallback === "function" ? dirtyOrCallback : callback;
        assert.ok(handler);
        begin(
          typeof dirtyOrCallback === "boolean" ? dirtyOrCallback : false,
          (image, rect) => {
            if (activeFrameSubscription === id) {
              frameCallbacks++;
              lastFrameSubscription = id;
            }
            handler(image, rect);
          },
        );
        // Notify only after this exact native subscription is installed.
        if (subscriptionNotice?.id === id) {
          const notice = subscriptionNotice;
          subscriptionNotice = undefined;
          notice.complete();
        }
      };
      view.webContents.endFrameSubscription = () => {
        activeFrameSubscription = undefined;
        frameStops++;
        end();
      };
      const capture = view.webContents.capturePage.bind(view.webContents);
      view.webContents.capturePage = async (
        ...args: Parameters<typeof capture>
      ) => {
        const call = ++captureCalls;
        traceShared("capture-begin");
        try {
          if (!owner?.contentView.children.includes(view)) {
            assert.ok(frameSubscriptions > 0);
            assert.equal(
              lastFrameSubscription,
              frameSubscriptions,
              "Unmounted capture must follow a frame from its current render lease",
            );
            assert.equal(
              frameStops,
              frameSubscriptions,
              "The readiness subscription must stop before native capture",
            );
          }
          const image = await capture(...args);
          traceShared("capture-image");
          return image;
        } catch (error) {
          try {
            console.error("Owned shared-browser capture failed", {
              phase,
              call,
              frameSubscriptions,
              frameCallbacks,
              frameStops,
              destroyed: view.webContents.isDestroyed(),
              loading: view.webContents.isLoading(),
              viewVisible: view.getVisible(),
              viewBounds: view.getBounds(),
              parents: BrowserWindow.getAllWindows()
                .slice(0, 8)
                .filter((window) => window.contentView.children.includes(view))
                .map((window) => ({
                  visible: window.isVisible(),
                  minimized: window.isMinimized(),
                  bounds: window.getBounds(),
                })),
            });
          } catch {
            // Failure-only fixture reads never replace the native error.
          }
          throw error;
        }
      };
    },
  });
  try {
    const port = await listen();
    await assertBlankThemePixels(port);
    const url = `http://127.0.0.1:${String(port)}/shared`;
    owner = new BrowserWindow({ show: false, width: 900, height: 700 });
    const ownerShow = () => traceShared("owner-show");
    const ownerHide = () => traceShared("owner-hide");
    const ownerRestore = () => traceShared("owner-restore");
    const ownerMinimize = () => traceShared("owner-minimize");
    owner.on("show", ownerShow);
    owner.on("hide", ownerHide);
    owner.on("restore", ownerRestore);
    owner.on("minimize", ownerMinimize);
    traceCleanup.push(() => {
      owner?.removeListener("show", ownerShow);
      owner?.removeListener("hide", ownerHide);
      owner?.removeListener("restore", ownerRestore);
      owner?.removeListener("minimize", ownerMinimize);
    });
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
    phase = "unmounted-live-observation";
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
    phase = "unmounted-inspection";
    const unmountedInspection = await browser.inspect("shared-session", tabId);
    assert.match(unmountedInspection.visibleText, /Human value/u);
    assert.ok(
      unmountedInspection.screenshot.bytes > 0,
      "Agent inspection must capture an unmounted Browser tab",
    );
    const assertUnmountedPixels = async (
      inspection: BrowserInspection,
      marker: number[],
    ) => {
      assert.equal(
        createdView!.webContents.getZoomFactor(),
        1,
        "Owned pixel fixture starts at default zoom",
      );
      const scale =
        await createdView!.webContents.executeJavaScript("devicePixelRatio");
      const encoded = readFileSync(inspection.screenshot.artifactPath).toString(
        "base64",
      );
      const pixels = await owner!.webContents.executeJavaScript(`(async()=>{
        const image=await createImageBitmap(new Blob([Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0))],{type:'image/png'}));
        try {
          const context=new OffscreenCanvas(image.width,image.height).getContext('2d'); context.drawImage(image,0,0);
          const samples=[[32,96],[64,128],[96,160],[320,240],[500,400]].map(([x,y])=>
            [...context.getImageData(Math.floor(x*image.width/1280),Math.floor(y*image.height/800),1,1).data]);
          return {width:image.width,height:image.height,samples};
        } finally { image.close(); }
      })()`);
      // capturePage uses float32 SizeF multiplication before ceil.
      assertCapturePixels(
        pixels,
        {
          width: Math.ceil(Math.fround(1280 * Math.fround(Math.max(1, scale)))),
          height: Math.ceil(Math.fround(800 * Math.fround(Math.max(1, scale)))),
        },
        marker,
      );
      assert.equal(owner!.isVisible(), false);
      assert.equal(owner!.isMinimized(), false);
    };
    await assertUnmountedPixels(unmountedInspection, [12, 180, 64]);
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
    await createdView.webContents.executeJavaScript(
      "document.querySelector('#capture-marker').style.backgroundColor='rgb(210,40,160)'",
    );
    phase = "unmounted-action-inspection";
    const afterHiddenAction = await browser.inspect("shared-session", tabId);
    await assertUnmountedPixels(afterHiddenAction, [210, 40, 160]);
    console.log(
      JSON.stringify({
        unmountedCapture: "passed",
        frameSubscriptions,
        frameCallbacks,
        frameStops,
        freshOpaqueGenerations: 2,
      }),
    );
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
    phase = "unmounted-to-owner-handoff-inspection";
    const capturesBeforeHandoff = captureCalls;
    const handoffSubscription = frameSubscriptions + 1;
    let subscriptionTimer: ReturnType<typeof setTimeout> | undefined;
    const subscribed = new Promise<void>((resolve, reject) => {
      subscriptionTimer = setTimeout(
        () =>
          reject(
            new Error(
              "Handoff subscription was not installed within five seconds",
            ),
          ),
        5_000,
      );
      subscriptionNotice = {
        id: handoffSubscription,
        complete: () => {
          clearTimeout(subscriptionTimer);
          resolve();
        },
      };
    });
    const handoffInspection = browser.inspect("shared-session", tabId);
    try {
      await Promise.race([
        subscribed,
        handoffInspection.then(() => {
          throw new Error("Inspection completed before the fixture handoff");
        }),
      ]);
      assert.equal(
        BrowserWindow.getAllWindows().length,
        2,
        "the Agent inspection must start on the temporary renderer",
      );
      assert.equal(
        captureCalls,
        capturesBeforeHandoff,
        "fixture handoff must precede native capture dispatch",
      );
      traceShared("handoff-mount-request");
      browser.mount(owner.webContents, {
        threadId: "shared-thread",
        tabId,
        lease: "shared-smoke",
        bounds: { x: 20, y: 20, width: 700, height: 500 },
      });
      traceShared("handoff-mounted");
      owner.showInactive();
      traceShared("handoff-owner-show-requested");
      await handoffInspection;
      traceShared("handoff-inspection-accepted");
    } finally {
      clearTimeout(subscriptionTimer);
      if (subscriptionNotice?.id === handoffSubscription)
        subscriptionNotice = undefined;
    }
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
    phase = "mounted-initial-inspection";
    let inspection = await browser.inspect("shared-session", tabId);
    assert.equal(inspection.url, url);
    assert.match(inspection.visibleText, /Human value/u);

    await createdView.webContents.executeJavaScript(
      "document.querySelector('input').focus();document.querySelector('input').select()",
    );
    createdView.webContents.insertText("typed by human");
    phase = "mounted-human-input-inspection";
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

    phase = "before-human-route-inspection";
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

    phase = "before-agent-navigation-inspection";
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
    phase = "background-inspect-existing-human-page";
    traceShared("background-existing-page-ready");
    const originalProfile = createdView.webContents.session;
    // A closed sidebar must stay closed: the same page can be inspected through
    // the non-activating compositor without asking the renderer to reveal it.
    browser.mount(owner.webContents, { lease: "shared-smoke" });
    assert.equal(owner.contentView.children.length, 0);
    browser.closeSession("shared-session");
    browser.bindThreadSession("shared-session", "shared-thread");
    const focusedBeforeBackgroundInspect = BrowserWindow.getFocusedWindow();
    const originalSend = owner.webContents.send;
    const sentChannels: string[] = [];
    owner.webContents.send = (channel: string, ...args: unknown[]) => {
      sentChannels.push(channel);
      return originalSend.call(owner!.webContents, channel, ...args);
    };
    let humanObservation: BrowserInspection;
    try {
      humanObservation = await browser.inspect("shared-session", tabId);
      phase = "background-inspection-returned";
      traceShared("background-inspection-returned");
    } finally {
      owner.webContents.send = originalSend;
    }
    assert.equal(
      Object.hasOwn(humanObservation, "automaticPresentation"),
      false,
    );
    assert.ok(
      sentChannels.every(
        (channel) => channel === "zenx:workspace-browser:changed",
      ),
    );
    assert.equal(
      owner.contentView.children.length,
      0,
      "inspection cannot reopen the sidebar",
    );
    assert.equal(
      BrowserWindow.getFocusedWindow(),
      focusedBeforeBackgroundInspect,
      "background inspection cannot transfer OS focus",
    );
    assert.equal(createdView.webContents.id, originalWebContentsId);
    assert.equal(
      createdView.webContents.session,
      originalProfile,
      "background inspection must preserve the actual Chromium profile object",
    );
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
    phase = "returned-control-inspection";
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
    phase = "human-confirmation-inspection";
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
    await assertHiddenMountedCapture(port);
    smokePhase = "targeted-setup";
    await assertTargetedBackgroundInput(port);
    layoutStarted = true;
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
          "targeted click/key default behaviors preserve a sentinel focused window and physical pointer for unmounted, hidden-mounted, and minimized-mounted pages",
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
          "background inspection leaves the sidebar closed and focus unchanged, sends no presentation request, and preserves WebContents/profile/login/form identity",
          "all human-owned Agent mutations reject; return requires fresh observation",
          "human confirmation occurs exactly once and is never replayed on return",
          "old no-reference close remains fenced even after a fresh inspection",
          "production permission switch preserves native viewport geometry at 320/390/900px in English and Chinese",
        ],
      }),
    );
  } catch (error) {
    try {
      console.error("Owned shared-browser phase trace", {
        phase,
        sharedTrace,
        sharedTraceDropped,
      });
    } catch {
      /* Keep the original failure. */
    }
    if (smokePhase.startsWith("targeted-"))
      console.error(JSON.stringify({ smokePhase, captureTrace }));
    const failures = [error];
    if (!layoutStarted) {
      layoutStarted = true;
      try {
        await assertStableControlLayout();
      } catch (layoutError) {
        failures.push(layoutError);
      }
    }
    console.error(
      "ZenX shared Workspace Browser smoke failed",
      failures.length === 1
        ? error
        : new AggregateError(failures, "Capture and layout phases both failed"),
    );
    process.exitCode = 1;
  } finally {
    for (const cleanup of traceCleanup) {
      try {
        cleanup();
      } catch {
        /* Diagnostic listeners cannot change cleanup. */
      }
    }
    await browser.shutdown();
    owner?.destroy();
    await closeFixture();
    rm(directory, { recursive: true, force: true }, () => {
      const exitCode = process.exitCode;
      app.exit(typeof exitCode === "number" ? exitCode : exitCode ? 1 : 0);
    });
  }
});

async function assertHiddenMountedCapture(port: number): Promise<void> {
  let view: WebContentsView | undefined;
  const browser = createElectronWorkspaceBrowser({
    artifactDirectory: path.join(directory, "hidden-capture-artifacts"),
    onCreateView: (created) => {
      view = created;
    },
  });
  const owner = new BrowserWindow({ show: false, width: 900, height: 700 });
  const guard = new BrowserWindow({ show: true, width: 320, height: 160 });
  let phase = "setup";
  const cases: string[] = [];
  const started = Date.now();
  const trace: object[] = [];
  let droppedTraceEntries = 0;
  const record = (event: string) => {
    try {
      if (trace.length === 48) {
        droppedTraceEntries++;
        return;
      }
      trace.push({
        event,
        phase,
        elapsedMs: Date.now() - started,
        visible: owner.isVisible(),
        minimized: owner.isMinimized(),
        attached: view ? owner.contentView.children.includes(view) : false,
      });
    } catch {
      // Failure-only fixture diagnostics must not alter capture or event handling.
    }
  };
  const onShow = () => record("owner:show");
  const onHide = () => record("owner:hide");
  const onRestore = () => record("owner:restore");
  const onMinimize = () => record("owner:minimize");
  owner.on("show", onShow);
  owner.on("hide", onHide);
  owner.on("restore", onRestore);
  owner.on("minimize", onMinimize);
  try {
    await owner.loadURL("about:blank");
    await guard.loadURL(
      "data:text/html,<input autofocus aria-label='User guard'>",
    );
    guard.show();
    guard.focus();
    guard.webContents.focus(); // Owned fixture setup only.
    browser.bindThreadSession("hidden-session", "hidden-thread");
    const tab = await browser.open(
      "hidden-session",
      `http://127.0.0.1:${port}/capture-marker`,
    );
    assert.ok(view);
    let captureScale = 0;
    const originalCapture = view.webContents.capturePage.bind(view.webContents);
    view.webContents.capturePage = async (
      ...args: Parameters<typeof originalCapture>
    ) => {
      captureScale =
        await view!.webContents.executeJavaScript("devicePixelRatio");
      return await originalCapture(...args);
    };
    const originalId = view.webContents.id;
    const bounds = { x: 20, y: 30, width: 640, height: 480 };
    const mount = (lease: string, nextBounds = bounds) =>
      browser.mount(owner.webContents, {
        threadId: "hidden-thread",
        tabId: tab.tabId,
        lease,
        bounds: nextBounds,
      });
    const assertGuard = () => {
      assert.equal(
        BrowserWindow.getFocusedWindow()?.id,
        guard.id,
        "Capture stole fixture window focus",
      );
      assert.equal(view!.webContents.id, originalId);
    };
    for (const mode of ["hidden", "minimized"] as const) {
      phase = mode;
      mount(mode);
      if (mode === "minimized") {
        owner.showInactive();
        owner.minimize();
        await eventually(async () => assert.equal(owner.isMinimized(), true));
        guard.focus(); // Scenario setup, before capture acceptance begins.
      } else owner.hide();
      const visible = owner.isVisible(),
        minimized = owner.isMinimized();
      for (const marker of [
        [12, 180, 64],
        [210, 40, 160],
      ]) {
        await view.webContents.executeJavaScript(
          `document.querySelector('#capture-marker').style.backgroundColor=${JSON.stringify(`rgb(${marker.join(",")})`)}`,
        );
        const observation = await browser.inspect("hidden-session", tab.tabId);
        assert.ok(Number.isFinite(captureScale) && captureScale > 0);
        const png = readFileSync(observation.screenshot.artifactPath);
        const pixels = await guard.webContents.executeJavaScript(`(async()=>{
          const encoded=${JSON.stringify(png.toString("base64"))};
          const image=await createImageBitmap(new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type:'image/png'}));
          try {
            const canvas=new OffscreenCanvas(image.width,image.height);
            const context=canvas.getContext('2d'); context.drawImage(image,0,0);
            const samples=[[32,96],[64,128],[96,160],[320,240],[500,400]].map(([x,y])=>
              [...context.getImageData(Math.floor(x*image.width/640),Math.floor(y*image.height/480),1,1).data]);
            return {width:image.width,height:image.height,samples};
          } finally { image.close(); }
        })()`);
        // This is capturePage ceil, distinct from FrameSubscriber round.
        const expected = {
          width: Math.ceil(
            Math.fround(640 * Math.fround(Math.max(1, captureScale))),
          ),
          height: Math.ceil(
            Math.fround(480 * Math.fround(Math.max(1, captureScale))),
          ),
        };
        assertCapturePixels(pixels, expected, marker);
        assert.deepEqual(
          {
            width: observation.screenshot.width,
            height: observation.screenshot.height,
          },
          expected,
        );
        cases.push(
          `${mode}:fresh-opaque-marker-${marker.join("-")}-${pixels.width}x${pixels.height}`,
        );
        assert.ok(observation.screenshot.bytes > 0);
        assert.match(observation.visibleText, /Human value/u);
        assert.equal(owner.isVisible(), visible);
        assert.equal(owner.isMinimized(), minimized);
        assert.ok(owner.contentView.children.includes(view));
        assert.deepEqual(view.getBounds(), bounds);
        assert.deepEqual(
          await view.webContents.executeJavaScript("[innerWidth,innerHeight]"),
          [640, 480],
        );
        assertGuard();
        cases.push(`${mode}:real-capture-exact-owner-restored`);
      }
    }
    phase = "restore-before-pending-capture";
    const restored = once(owner, "restore", {
      signal: AbortSignal.timeout(5_000),
    });
    record("setup:restore-request");
    owner.restore();
    await restored;
    await eventually(async () => assert.equal(owner.isMinimized(), false));
    record("setup:hide-request");
    await hideFixtureOwner(owner);
    record("setup:hidden-state");
    guard.focus();
    const nativeCapture = view.webContents.capturePage.bind(view.webContents);
    try {
      for (const change of [
        "show",
        "new-lease",
        "hide",
        "take-control",
        "return-control",
        "deadline",
      ] as const) {
        phase = `pending-capture-${change}`;
        record("pending:hide-request");
        await hideFixtureOwner(owner);
        mount(`before-${change}`);
        if (change === "return-control")
          browser.command(
            owner.webContents,
            "hidden-thread",
            "take-control",
            tab.tabId,
          );
        let entered!: () => void, finish!: () => void;
        const captured = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          finish = resolve;
        });
        view.webContents.capturePage = async (
          ...args: Parameters<typeof nativeCapture>
        ) => {
          record("native-capture:begin");
          const image = await nativeCapture(...args);
          record("native-capture:image-ready");
          entered(); // A real native image exists, but its Host result is pending.
          await gate;
          return image;
        };
        record("inspect:begin");
        const pending = browser.inspect("hidden-session", tab.tabId);
        const rejected = assert.rejects(
          pending,
          change === "deadline"
            ? /native capture timed out/u
            : /changed|superseded|view/iu,
        );
        try {
          await Promise.race([captured, pending.then(() => undefined)]);
          record("native-capture:gate-entered");
          if (change === "show") {
            owner.showInactive();
            await eventually(async () =>
              assert.ok(owner.contentView.children.includes(view!)),
            );
          } else if (change === "new-lease") {
            const newer = { x: 7, y: 8, width: 600, height: 400 };
            mount("new-owner-lease", newer);
            assert.ok(owner.contentView.children.includes(view));
            assert.deepEqual(view.getBounds(), newer);
          } else if (change === "take-control" || change === "return-control") {
            browser.command(
              owner.webContents,
              "hidden-thread",
              change,
              tab.tabId,
            );
            assert.ok(
              owner.contentView.children.includes(view),
              "Control must immediately restore the existing mount",
            );
            mount(`before-${change}`);
            assert.ok(owner.contentView.children.includes(view));
            assert.deepEqual(view.getBounds(), bounds);
          } else if (change === "hide") {
            browser.mount(owner.webContents, { lease: "before-hide" });
            assert.equal(owner.contentView.children.includes(view), false);
          } else {
            await rejected; // Exercise the production 10s read-only deadline.
            assert.ok(owner.contentView.children.includes(view));
            assert.deepEqual(view.getBounds(), bounds);
          }
          if (change !== "deadline") {
            finish();
            await rejected;
          }
          assertGuard();
          cases.push(
            `${change}:pending-result-rejected-without-overwriting-user`,
          );
        } finally {
          finish();
          await pending.catch(() => undefined);
          if (change === "take-control")
            browser.command(
              owner.webContents,
              "hidden-thread",
              "return-control",
              tab.tabId,
            );
        }
      }
    } finally {
      view.webContents.capturePage = nativeCapture;
    }
    console.log(
      JSON.stringify({
        hiddenMountedCapture: "passed",
        cases,
        webContentsId: originalId,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        hiddenMountedCapture: "failed",
        phase,
        cases,
        ownerVisible: owner.isVisible(),
        ownerMinimized: owner.isMinimized(),
        ownerAttached: view ? owner.contentView.children.includes(view) : false,
        focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
        trace,
        droppedTraceEntries,
      }),
    );
    throw error;
  } finally {
    owner.removeListener("show", onShow);
    owner.removeListener("hide", onHide);
    owner.removeListener("restore", onRestore);
    owner.removeListener("minimize", onMinimize);
    await browser.shutdown();
    owner.destroy();
    guard.destroy();
  }
}

async function hideFixtureOwner(owner: BrowserWindow): Promise<void> {
  if (!owner.isVisible()) return;
  const hidden = once(owner, "hide", { signal: AbortSignal.timeout(5_000) });
  owner.hide();
  await hidden;
  await eventually(async () => assert.equal(owner.isVisible(), false));
}

function assertCapturePixels(
  pixels: { width: number; height: number; samples: number[][] },
  expected: { width: number; height: number },
  marker: readonly number[],
): void {
  assert.deepEqual(
    { width: pixels.width, height: pixels.height },
    expected,
    "Captured PNG dimensions must match the actual capture viewport and scale",
  );
  assert.equal(pixels.samples.length, 5);
  for (const [index, pixel] of pixels.samples.entries()) {
    assert.equal(pixel.length, 4);
    assert.equal(pixel[3], 255, "Captured fixture must not be transparent");
    const color = index < 3 ? marker : [24, 48, 72];
    for (let channel = 0; channel < 3; channel++)
      assert.ok(
        Math.abs(pixel[channel]! - color[channel]!) <= 8,
        `Captured marker/background pixel differs: sample=${index} actual=${pixel} expected=${color}`,
      );
  }
}

async function assertTargetedBackgroundInput(port: number): Promise<void> {
  const browser = createElectronWorkspaceBrowser({
    artifactDirectory: path.join(directory, "input-artifacts"),
    onCreateView: traceCaptures,
  });
  const owner = new BrowserWindow({
    show: false,
    width: 800,
    height: 650,
    focusable: false,
  });
  const sentinel = new BrowserWindow({ show: false, width: 400, height: 300 });
  try {
    await owner.loadURL("about:blank");
    await sentinel.loadURL(
      "data:text/html,<input autofocus aria-label='User sentinel'>",
    );
    sentinel.show();
    await eventually(async () =>
      assert.equal(BrowserWindow.getFocusedWindow(), sentinel),
    );
    const pointer = screen.getCursorScreenPoint();
    browser.bindThreadSession("input-session", "input-thread");
    const tab = await browser.open(
      "input-session",
      `http://127.0.0.1:${port}/input`,
    );
    for (const mode of [
      "unmounted",
      "hidden-mounted",
      "minimized-mounted",
    ] as const) {
      smokePhase = `targeted-${mode}-initial-inspect`;
      if (mode !== "unmounted") {
        browser.mount(owner.webContents, {
          threadId: "input-thread",
          tabId: tab.tabId,
          lease: "input-lease",
          bounds: { x: 0, y: 0, width: 700, height: 500 },
        });
        if (mode === "minimized-mounted") {
          owner.showInactive();
          owner.minimize();
          await eventually(async () => assert.equal(owner.isMinimized(), true));
        } else owner.hide();
      }
      await browser.navigate(
        "input-session",
        tab.tabId,
        `http://127.0.0.1:${port}/input`,
      );
      let inspected = await browser.inspect("input-session", tab.tabId);
      assert.equal(
        inspected.screenshot.status,
        "captured",
        `${mode}: requires real pixels`,
      );
      assert.ok(
        inspected.inputViewport,
        `${mode}: requires coherent input viewport`,
      );
      await browser.pointerClick(
        "input-session",
        tab.tabId,
        inspected.observationId,
        50,
        130,
      );
      smokePhase = `targeted-${mode}-after-canvas-click`;
      inspected = await browser.inspect("input-session", tab.tabId);
      assert.match(inspected.visibleText, /Canvas clicked true/u);
      await browser.keyPress(
        "input-session",
        tab.tabId,
        inspected.observationId,
        "ArrowDown",
      );
      smokePhase = `targeted-${mode}-after-arrow-scroll`;
      await eventually(async () => {
        inspected = await browser.inspect("input-session", tab.tabId);
        assert.ok((inspected.inputViewport?.scrollY ?? 0) > 0);
      });
      await browser.scroll(
        "input-session",
        tab.tabId,
        inspected.observationId,
        "up",
        2000,
      );
      smokePhase = `targeted-${mode}-after-dom-scroll-up`;
      inspected = await browser.inspect("input-session", tab.tabId);
      await browser.pointerClick(
        "input-session",
        tab.tabId,
        inspected.observationId,
        40,
        210,
      );
      inspected = await browser.inspect("input-session", tab.tabId);
      await browser.keyPress(
        "input-session",
        tab.tabId,
        inspected.observationId,
        "Space",
      );
      smokePhase = `targeted-${mode}-after-space-key`;
      inspected = await browser.inspect("input-session", tab.tabId);
      assert.equal(
        requiredTarget(inspected, "Targeted text", "type").value,
        " ",
      );
      await browser.type(
        "input-session",
        tab.tabId,
        inspected.observationId,
        requiredTarget(inspected, "Targeted text", "type").targetId,
        "background form",
        false,
      );
      smokePhase = `targeted-${mode}-after-dom-type`;
      inspected = await browser.inspect("input-session", tab.tabId);
      await browser.keyPress(
        "input-session",
        tab.tabId,
        inspected.observationId,
        "Enter",
      );
      smokePhase = `targeted-${mode}-after-enter-key`;
      inspected = await browser.inspect("input-session", tab.tabId);
      assert.match(inspected.visibleText, /Submitted background form/u);
      await browser.keyPress(
        "input-session",
        tab.tabId,
        inspected.observationId,
        "Tab",
      );
      smokePhase = `targeted-${mode}-after-tab-key`;
      inspected = await browser.inspect("input-session", tab.tabId);
      assert.match(inspected.visibleText, /Focus next/u);
      await assert.rejects(
        browser.pointerClick(
          "input-session",
          tab.tabId,
          inspected.observationId,
          30,
          310,
        ),
        (error: unknown) =>
          error instanceof BrowserInputUnsupportedError &&
          error.code === "BROWSER_INPUT_UNSUPPORTED" &&
          error.reason === "native-surface",
      );
      await assert.rejects(
        browser.pointerClick(
          "input-session",
          tab.tabId,
          inspected.observationId,
          30,
          360,
        ),
        (error: unknown) =>
          error instanceof BrowserInputUnsupportedError &&
          error.code === "BROWSER_INPUT_UNSUPPORTED" &&
          error.reason === "native-surface",
      );
      assert.equal(
        BrowserWindow.getFocusedWindow(),
        sentinel,
        `${mode}: must preserve the focused sentinel window`,
      );
      assert.deepEqual(
        screen.getCursorScreenPoint(),
        pointer,
        `${mode}: must not move the physical pointer`,
      );
      if (mode === "hidden-mounted") assert.equal(owner.isVisible(), false);
      if (mode === "minimized-mounted") assert.equal(owner.isMinimized(), true);
    }
  } finally {
    await browser.shutdown();
    owner.destroy();
    sentinel.destroy();
  }
}

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
  smokePhase = "permission-switch-layout";
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
        await layout.webContents.executeJavaScript(
          `document.querySelector('#fixture').style.width=${width}+'px'`,
        );
        // Reduced-motion CSS still permits a 0.01ms width transition. Settle
        // fixture sizing before testing status changes, without replaying them.
        await eventually(async () => {
          assert.equal(
            await layout.webContents.executeJavaScript(
              "document.querySelector('#fixture').getBoundingClientRect().width",
            ),
            width,
            "Fixture width transition must settle before status checks",
          );
        });
        let expected: unknown;
        for (const state of [
          {},
          { control: "human", requiresFreshObservation: true },
          { requiresFreshObservation: true },
          { agentActionsInFlight: 1, requiresFreshObservation: true },
          { agentInspectionsInFlight: 1 },
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
            document.querySelector('#fixture').innerHTML=${JSON.stringify(markup)};
            await new Promise(requestAnimationFrame);
            const viewport=document.querySelector('.workspace-browser-viewport').getBoundingClientRect();
            const toolbar=document.querySelector('.workspace-browser-address');
            const control=toolbar.getBoundingClientRect();
            const permission=document.querySelector('.browser-permission-switch[role="switch"]');
            const button=permission.getBoundingClientRect();
            const description=document.getElementById(permission.getAttribute('aria-describedby'));
            permission.focus();
            const geometry=(selector)=>{
              try {
                const element=document.querySelector(selector), style=getComputedStyle(element), rect=element.getBoundingClientRect();
                return {selector,tag:element.tagName,inlineWidth:element.style.width,width:style.width,minWidth:style.minWidth,maxWidth:style.maxWidth,
                  display:style.display,position:style.position,inlineSize:style.inlineSize,boxSizing:style.boxSizing,
                  transition:style.transition.slice(0,160),animation:style.animation.slice(0,160),rect:[rect.x,rect.y,rect.width,rect.height]};
              } catch { return {selector,unavailable:true}; }
            };
            const fixtureRules=()=>{
              try {
                const element=document.querySelector('#fixture'), matched=[];
                let visited=0, truncated=false;
                const visit=(rules,depth)=>{
                  for (const rule of rules) {
                    if (++visited>2000||matched.length>=16||depth>8) { truncated=true; return; }
                    if (rule.selectorText&&element.matches(rule.selectorText)&&rule.style?.length) {
                      const sizing=['width','inline-size','min-width','max-width','display','position','flex','grid-template-columns','transition','animation']
                        .filter((name)=>rule.style.getPropertyValue(name))
                        .map((name)=>[name,rule.style.getPropertyValue(name).slice(0,120),rule.style.getPropertyPriority(name)]);
                      if (sizing.length) matched.push({selector:rule.selectorText.slice(0,160),sizing});
                    }
                    if (rule.cssRules) visit(rule.cssRules,depth+1);
                    if (truncated) return;
                  }
                };
                for (const sheet of document.styleSheets) { visit(sheet.cssRules,0); if (truncated) break; }
                return {matched,visited,truncated,inline:element.style.cssText.slice(0,240),parent:element.parentElement?.tagName,
                  readyState:document.readyState,visibilityState:document.visibilityState};
              } catch { return {unavailable:true}; }
            };
            return {viewport:[viewport.x,viewport.y,viewport.width,viewport.height],
              layout:{compatMode:document.compatMode,innerWidth,fixtureCount:document.querySelectorAll('#fixture').length,styleSheetCount:document.styleSheets.length,
                geometry:['#fixture','.workspace-browser-panel','.workspace-browser-viewport'].map(geometry),fixtureRules:fixtureRules()},
              toolbarHeight:control.height, toolbarWidth:toolbar.clientWidth, toolbarScrollWidth:toolbar.scrollWidth,
              buttonVisible:button.width>0&&button.height>0&&button.x>=control.x&&button.right<=control.right&&button.y>=control.y&&button.bottom<=control.bottom,
              permissionInToolbar:permission.parentElement===toolbar&&toolbar.querySelector(':scope > button:last-of-type')===permission,
              permissionChecked:permission.getAttribute('aria-checked'), permissionLabel:permission.getAttribute('aria-label'),
              permissionFocusable:!permission.disabled&&permission.tabIndex===0&&document.activeElement===permission,
              permissionDetailsAccessible:!!permission.title&&description?.textContent===permission.title,
              legacyControlCount:document.querySelectorAll('.workspace-browser-control').length};
          })()`);
          assert.equal(
            measured.viewport[2],
            width,
            `Fixture must exercise the requested actual panel width: ${JSON.stringify({ ...measured.layout, windowVisible: layout.isVisible(), windowMinimized: layout.isMinimized() })}`,
          );
          expected ??= measured.viewport;
          assert.deepEqual(
            measured.viewport,
            expected,
            `Status changed native viewport at ${width}px/${language}: ${JSON.stringify(state)}`,
          );
          assert.equal(
            measured.toolbarHeight,
            44,
            "Permission uses the existing toolbar height",
          );
          assert.equal(
            measured.toolbarScrollWidth,
            measured.toolbarWidth,
            "Toolbar must not overflow at narrow widths",
          );
          assert.equal(
            measured.buttonVisible,
            true,
            "Permission switch must stay entirely visible",
          );
          assert.equal(
            measured.permissionInToolbar,
            true,
            "Permission switch must end the address toolbar",
          );
          assert.equal(
            measured.permissionChecked,
            String((state.control ?? tab.control) === "agent"),
          );
          assert.equal(
            measured.permissionLabel,
            i18n.t("panels:browserAgentPermission"),
          );
          assert.equal(
            measured.permissionFocusable,
            true,
            "Permission switch must remain keyboard-focusable",
          );
          assert.equal(
            measured.permissionDetailsAccessible,
            true,
            "Complete permission details must be available on hover and through the accessible description",
          );
          assert.equal(
            measured.legacyControlCount,
            0,
            "Permission must not add a separate control banner",
          );
        }
      }
    }
  } finally {
    await i18n.changeLanguage("en");
    layout.destroy();
  }
}

/** Actual Electron pixels, independent of the renderer-only visual fixture. */
async function assertBlankThemePixels(port: number): Promise<void> {
  const originalThemeSource = nativeTheme.themeSource;
  let view: WebContentsView | undefined;
  const browser = createElectronWorkspaceBrowser({
    onCreateView: (value) => {
      view = value;
    },
  });
  const owner = new BrowserWindow({ show: false, width: 640, height: 480 });
  const evidence = process.env.ZENX_BROWSER_BLANK_ARTIFACT_DIR;
  const records: Record<string, unknown>[] = [];
  const failures: unknown[] = [];
  let phase = "setup";
  let passed = false;
  try {
    await owner.loadURL("about:blank");
    browser.bindThreadSession("blank-theme-session", "blank-theme-thread");
    const tab = await browser.open("blank-theme-session", "about:blank");
    assert.ok(view);
    const contentsId = view.webContents.id;
    const lease = "blank-theme-stable-lease";
    owner.showInactive();
    const sample = async (
      name: string,
      appearance: "light" | "dark",
      expected: number,
    ) => {
      phase = name;
      const record: Record<string, unknown> = {
        name,
        appearance,
        expected,
        nativeThemeSource: nativeTheme.themeSource,
        nativeShouldUseDarkColors: nativeTheme.shouldUseDarkColors,
        pagePrefersDark: await view!.webContents.executeJavaScript(
          'matchMedia("(prefers-color-scheme: dark)").matches',
        ),
        status: "mounting",
        webContentsId: contentsId,
        tabId: tab.tabId,
        lease,
      };
      records.push(record);
      browser.mount(owner.webContents, {
        threadId: "blank-theme-thread",
        tabId: tab.tabId,
        lease,
        appearance,
        bounds: { x: 0, y: 0, width: 600, height: 400 },
      });
      assert.equal(view!.webContents.id, contentsId);
      assert.ok(owner.contentView.children.includes(view!));
      // Use the real product inspection path: it causally requests a fresh
      // compositor surface before its one capturePage call. A frame subscription
      // can initially deliver an old surface and is not a freshness witness.
      record.status = "inspecting";
      const inspection = await browser.inspect(
        "blank-theme-session",
        tab.tabId,
      );
      assert.equal(inspection.tabId, tab.tabId);
      assert.equal(view!.webContents.id, contentsId);
      assert.ok(owner.contentView.children.includes(view!));
      const png = readFileSync(inspection.screenshot.artifactPath);
      const image = nativeImage.createFromBuffer(png);
      record.status = "captured";
      record.observationId = inspection.observationId;
      record.url = view!.webContents.getURL();
      assert.equal(image.isEmpty(), false);
      const size = image.getSize();
      const bitmap = image.toBitmap();
      const offset =
        (Math.floor(size.height / 2) * size.width +
          Math.floor(size.width / 2)) *
        4;
      const pixel = [...bitmap.subarray(offset, offset + 4)];
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(path.join(evidence, `${name}.png`), png);
      }
      Object.assign(record, { pixel, size });
      assert.deepEqual(pixel, [expected, expected, expected, 255], name);
      record.status = "verified";
    };
    await sample("blank-light", "light", 255);
    await sample("blank-dark", "dark", 0);
    await sample("blank-light-return", "light", 255);
    // App appearance may be forced light while the OS/Electron theme is dark.
    // Test the native surface independently, without restyling any website.
    nativeTheme.themeSource = "dark";
    await sample("blank-light-system-dark", "light", 255);
    nativeTheme.themeSource = "light";
    await sample("blank-dark-system-light", "dark", 0);
    nativeTheme.themeSource = originalThemeSource;
    await browser.navigate(
      "blank-theme-session",
      tab.tabId,
      `http://127.0.0.1:${port}/blank-theme-site`,
    );
    await sample("website-dark", "dark", 80);
    await sample("website-light", "light", 80);
    await browser.navigate("blank-theme-session", tab.tabId, "about:blank");
    await sample("blank-dark-return", "dark", 0);
    passed = true;
    console.log("Native blank appearance pixels", JSON.stringify(records));
  } catch (error) {
    failures.push(error);
  } finally {
    nativeTheme.themeSource = originalThemeSource;
    try {
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(
          path.join(evidence, "receipt.json"),
          JSON.stringify(
            {
              head: process.env.GITHUB_SHA ?? null,
              phase,
              passed,
              records,
              failure: failures.map((error) =>
                error instanceof Error ? error.message : String(error),
              ),
            },
            null,
            2,
          ),
        );
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      await browser.shutdown();
    } catch (error) {
      failures.push(error);
    }
    try {
      owner.destroy();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Native blank appearance verification or cleanup failed",
    );
}
