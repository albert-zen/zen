/** Owned hosted-macOS native acceptance; no user profile or external website. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { app, BrowserWindow, ipcMain, type WebContentsView } from "electron";
import { createElectronWorkspaceBrowser } from "../src/main/workspace-browser-electron.js";

assert.equal(process.platform, "darwin", "Actual macOS required");
assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "Disposable hosted runner only",
);
assert.ok(process.versions.electron);
const directory = path.resolve(process.argv[2]!);
assert.ok(process.argv[2], "Evidence directory required");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const report: any = {
  scope:
    "Production React components and production WorkspaceBrowser mounting a real native WebContentsView. Targeted owned-WebContents Electron sendInputEvent plus explicit contentView attachment checks; not OS/window hit-test routing. synthetic in-memory conversation chunks and loopback page. Not physical trackpad, actual user history, full App/Host, or user-machine acceptance. Parent-renderer and native-view captures are separate, not a fabricated composited screenshot.",
  platform: process.platform,
  versions: process.versions,
  cases: [],
  mounts: [],
  errors: [],
  status: "running",
};
let owner: BrowserWindow | undefined;
let view: WebContentsView | undefined;
let browser: ReturnType<typeof createElectronWorkspaceBrowser> | undefined;
let nativeId: string | undefined;
const profile = mkdtempSync(path.join(os.tmpdir(), "zenx-fullscreen-native-"));
mkdirSync(path.join(profile, "user-data"), { recursive: true });
mkdirSync(path.join(profile, "session-data"), { recursive: true });
app.setPath("userData", path.join(profile, "user-data"));
app.setPath("sessionData", path.join(profile, "session-data"));
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(
    `<!doctype html><title>Owned native Browser fixture</title><style>body{margin:0;min-height:4000px;background:#dcefe4;font:24px sans-serif}header{padding:40px}#marker{height:140px;background:#0cb440}</style><header>REAL WebContentsView · SYNTHETIC LOOPBACK PAGE</header><div id="marker"></div><p>Native wheel target</p><script>window.wheels=[];addEventListener('wheel',e=>wheels.push({trusted:e.isTrusted,deltaY:e.deltaY}));</script>`,
  );
});
const evaluate = (source: string): Promise<any> =>
  owner!.webContents.executeJavaScript(source);
async function until(check: () => Promise<boolean> | boolean, label: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(50);
  }
  throw Error(`Timed out: ${label}; no input replay`);
}
const measure = `(() => {
 const root=document.querySelector('#primary-conversation-content'), v=root.querySelector('.messages'), r=v.getBoundingClientRect();
 const rows=[...v.querySelectorAll('[data-transcript-row-key]')].filter(e=>e.getBoundingClientRect().bottom>r.top).sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top);
 const row=rows[0],editor=root.querySelector('textarea,.cm-content');
 return {top:v.scrollTop,range:v.scrollHeight-v.clientHeight,x:r.x,y:r.y,width:r.width,height:r.height,key:row?.dataset.transcriptRowKey,offset:row?.getBoundingClientRect().top-r.top,visibility:getComputedStyle(root).visibility,primary:document.querySelector('.auxiliary-panel').dataset.primaryActive,paused:!!root.querySelector('.back-live'),draft:editor?.value??editor?.textContent,wheelCount:window.__nativeWheelCount??0,streamCount:(root.textContent.match(/Synthetic streamed text chunk/g)||[]).length};
})()`;
async function click(selector: string) {
  const point = await evaluate(
    `(() => {const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!r.width||!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded fixture target');return {x,y}})()`,
  );
  owner!.focus();
  owner!.webContents.focus();
  await until(
    () => owner!.isFocused() && owner!.webContents.isFocused(),
    "owned renderer focused",
  );
  owner!.webContents.sendInputEvent({
    type: "mouseDown",
    button: "left",
    clickCount: 1,
    ...point,
  });
  owner!.webContents.sendInputEvent({
    type: "mouseUp",
    button: "left",
    clickCount: 1,
    ...point,
  });
  await pause(200);
}
async function wheel(deltaY: number) {
  const before = await evaluate(measure);
  owner!.focus();
  owner!.webContents.focus();
  await until(
    () => owner!.isFocused() && owner!.webContents.isFocused(),
    "owned renderer focused",
  );
  owner!.webContents.sendInputEvent({
    type: "mouseWheel",
    x: Math.round(before.x + before.width / 2),
    y: Math.round(before.y + 100),
    deltaX: 0,
    deltaY,
    canScroll: true,
    hasPreciseScrollingDeltas: true,
  });
  await until(
    async () => (await evaluate(measure)).wheelCount > before.wheelCount,
    "native renderer wheel delivered",
  );
  await pause(350);
}
function attached() {
  return (
    !!view && owner!.contentView.children.includes(view) && view.getVisible()
  );
}
function detached() {
  return (
    !!view && !owner!.contentView.children.includes(view) && !view.getVisible()
  );
}
function sameReading(actual: any, expected: any, label: string) {
  assert.equal(actual.key, expected.key, `${label}: visible row`);
  assert.ok(
    Math.abs(actual.offset - expected.offset) <= 2,
    `${label}: row offset`,
  );
  assert.ok(
    Math.abs(actual.top - expected.top) <= 2,
    `${label}: native scrollTop`,
  );
  assert.equal(actual.draft, expected.draft, `${label}: draft`);
  assert.ok(actual.paused, `${label}: remains paused`);
}
async function capture(name: string, native: boolean) {
  const renderer = await owner!.webContents.capturePage();
  assert.ok(!renderer.isEmpty());
  await writeFile(
    path.join(directory, `${name}-parent-renderer.png`),
    renderer.toPNG(),
  );
  if (native) {
    assert.ok(attached());
    const page = await view!.webContents.capturePage();
    assert.ok(!page.isEmpty());
    await writeFile(
      path.join(directory, `${name}-native-webcontentsview.png`),
      page.toPNG(),
    );
  }
}
async function run() {
  await mkdir(directory, { recursive: true });
  app.on("window-all-closed", () => undefined);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  await app.whenReady();
  browser = createElectronWorkspaceBrowser({
    artifactDirectory: path.join(profile, "artifacts"),
    onCreateView(created) {
      assert.equal(
        view,
        undefined,
        "One native page, never recreated for tab returns",
      );
      view = created;
      created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      created.webContents.session.setPermissionRequestHandler(
        (_wc, _permission, callback) => callback(false),
      );
      created.webContents.session.webRequest.onBeforeRequest(
        (details, callback) =>
          callback({
            cancel: !details.url.startsWith(url + "/") && details.url !== url,
          }),
      );
    },
  });
  owner = new BrowserWindow({
    width: 1280,
    height: 900,
    useContentSize: true,
    show: true,
    webPreferences: {
      preload: path.join(directory, "native-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  owner.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  owner.webContents.on("console-message", (_event: any, ...args: any[]) => {
    if (args[0] === 3) report.errors.push(String(args[1]));
  });
  ipcMain.handle("fixture:fullscreen-mount", (event, request) => {
    assert.equal(event.sender, owner!.webContents, "Owned renderer only");
    assert.equal(event.senderFrame, event.sender.mainFrame, "Main frame only");
    if (request.threadId !== undefined)
      assert.equal(request.threadId, "thread-a");
    if (request.tabId !== undefined)
      assert.equal(request.tabId, "page-thread-a");
    assert.ok(nativeId);
    browser!.mount(event.sender, {
      ...request,
      ...(request.tabId ? { tabId: nativeId } : {}),
    });
    report.mounts.push({
      lease: request.lease,
      tabId: request.tabId,
      bounds: request.bounds,
      attached: attached(),
      nativeId,
    });
  });
  await owner.loadURL("about:blank");
  nativeId = browser.command(
    owner.webContents,
    "thread-a",
    "new",
    undefined,
    url,
  )[0]?.id;
  assert.ok(nativeId && view);
  await until(
    async () =>
      await view!.webContents.executeJavaScript(
        "document.readyState==='complete' && !!document.querySelector('#marker')",
      ),
    "owned native page loaded",
  );
  await owner.loadFile(path.join(directory, "fullscreen-primary-chat.html"), {
    query: { native: "1", platform: "darwin", owner: "thread-a" },
  });
  await until(
    async () => await evaluate("document.body.dataset.previewReady==='true'"),
    "production preview ready",
  );
  await evaluate(
    "window.__nativeWheelCount=0; document.addEventListener('wheel',e=>{if(e.isTrusted)window.__nativeWheelCount++},true)",
  );
  await click(".auxiliary-heading > button[aria-pressed]");
  await click("#aux-tab-primary-conversation");
  await until(() => detached(), "native page detached on primary return");
  for (const [index, width] of [1280, 1000].entries()) {
    owner.setContentSize(width, 900);
    await pause(500);
    if (await evaluate("!!document.querySelector('.back-live')"))
      await click(".back-live");
    await until(async () => {
      const m = await evaluate(measure);
      return m.range - m.top <= 4;
    }, "live edge before native wheel");
    const live = await evaluate(measure);
    await wheel(live.range * 0.5);
    const saved = await evaluate(measure);
    assert.ok(saved.paused && saved.top > 50 && saved.top < saved.range - 50);
    const sequence = index * 10 + 1;
    await evaluate(
      `window.__fullscreenPrimaryPreview.preview('thread-a',${sequence})`,
    );
    await until(
      async () => attached() && (await evaluate(measure)).primary === "false",
      "native activity preview attached",
    );
    const hidden = await evaluate(measure);
    sameReading(hidden, saved, "hidden native preview");
    assert.equal(hidden.visibility, "hidden");
    const bounds = view!.getBounds();
    const addressRect = await evaluate(
      "document.querySelector('.workspace-browser-address').getBoundingClientRect().bottom",
    );
    assert.ok(
      bounds.y >= addressRect - 1 && bounds.width > 300 && bounds.height > 100,
      "Native page stays below address row",
    );
    await capture(`${width}-activity-preview`, true);
    const nativeBefore = await view!.webContents.executeJavaScript(
      "({top:scrollY,wheels:wheels.length})",
    );
    view!.webContents.focus();
    await until(() => view!.webContents.isFocused(), "native page focused");
    view!.webContents.sendInputEvent({
      type: "mouseWheel",
      x: 100,
      y: 200,
      deltaX: 0,
      deltaY: -400,
      canScroll: true,
      hasPreciseScrollingDeltas: true,
    });
    await until(
      async () =>
        await view!.webContents.executeJavaScript(
          `scrollY>${nativeBefore.top} && wheels.length>${nativeBefore.wheels}`,
        ),
      "real WebContentsView wheel scroll",
    );
    const chunksBefore = await evaluate(
      "Number(document.querySelector('.app-shell').dataset.streamedChunks)",
    );
    for (let chunk = 0; chunk < 12; chunk++) {
      await evaluate("window.__fullscreenPrimaryPreview.stream('thread-a')");
      await pause(30);
    }
    await until(
      async () =>
        (await evaluate(
          "Number(document.querySelector('.app-shell').dataset.streamedChunks)",
        )) ===
        chunksBefore + 12,
      "all synthetic stream chunks committed to React",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.app-shell').dataset.streamStatus",
      ),
      "inProgress",
    );
    sameReading(await evaluate(measure), saved, "background streamed content");
    await evaluate(
      "window.__fullscreenPrimaryPreview.stream('thread-a', true)",
    );
    await until(
      async () =>
        (await evaluate(
          "document.querySelector('.app-shell').dataset.streamStatus",
        )) === "completed",
      "stream completion rendered",
    );
    sameReading(await evaluate(measure), saved, "background stream completion");
    const resized = width === 1280 ? 1180 : 1040;
    owner.setContentSize(resized, 820);
    await pause(700);
    const resizedHidden = await evaluate(measure);
    assert.equal(
      resizedHidden.key,
      saved.key,
      "hidden resize retains reading row",
    );
    assert.ok(resizedHidden.top > 50 && resizedHidden.paused);
    const resizedBounds = view!.getBounds();
    assert.ok(
      resizedBounds.width !== bounds.width,
      "native bounds follow resize",
    );
    const latestMount = report.mounts.filter((m: any) => m.tabId).at(-1).bounds;
    for (const dimension of ["x", "y", "width", "height"] as const)
      assert.ok(
        Math.abs(resizedBounds[dimension] - latestMount[dimension]) <= 1,
        `native resized ${dimension} matches renderer mount`,
      );
    const lease = report.mounts.filter((m: any) => m.tabId).at(-1).lease;
    await click("#aux-tab-primary-conversation");
    await until(() => detached(), "same native lease detached");
    assert.equal(report.mounts.at(-1).lease, lease);
    const returned = await evaluate(measure);
    sameReading(returned, resizedHidden, "return after stream and resize");
    await capture(`${width}-returned`, false);
    const browserTop: number =
      await view!.webContents.executeJavaScript("scrollY");
    await wheel(140);
    assert.ok(
      (await evaluate(measure)).top < returned.top,
      "native wheel reaches restored transcript",
    );
    assert.equal(
      await view!.webContents.executeJavaScript("scrollY"),
      browserTop,
      "targeted parent wheel leaves detached native page unchanged",
    );
    await evaluate(
      `window.__fullscreenPrimaryPreview.preview('thread-a',${sequence})`,
    );
    await pause(250);
    assert.equal(attached(), false, "dismissed event does not remount");
    const beforeRetire = await evaluate(measure);
    await evaluate(
      `window.__fullscreenPrimaryPreview.preview('thread-a',${sequence + 1})`,
    );
    await until(() => attached(), "newer activity remounts same native view");
    await evaluate(
      `window.__fullscreenPrimaryPreview.retire('thread-a',${sequence + 1})`,
    );
    await until(() => detached(), "retirement detaches native view");
    sameReading(await evaluate(measure), beforeRetire, "retired preview");
    report.cases.push({
      width,
      saved,
      hidden,
      resizedHidden,
      returned,
      bounds,
      resizedBounds,
      status: "passed",
    });
  }
  assert.equal(report.errors.length, 0, "No renderer error");
  report.status = "passed";
}
void run()
  .catch((error) => {
    report.status = "failed";
    report.error = String(error.stack ?? error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await browser?.close();
      if (owner && !owner.isDestroyed()) owner.destroy();
      ipcMain.removeHandler("fixture:fullscreen-mount");
      server.close();
      if (profile) await rm(profile, { recursive: true, force: true });
      report.cleanupCompleted = true;
    } catch (error) {
      report.cleanupError = String(error);
      process.exitCode = 1;
    }
    try {
      report.rendererSource = JSON.parse(
        await readFile(path.join(directory, "source.json"), "utf8"),
      );
      report.nativeSource = JSON.parse(
        await readFile(path.join(directory, "native-source.json"), "utf8"),
      );
      for (const [name, expected] of Object.entries(
        report.nativeSource.outputs,
      )) {
        assert.equal(
          createHash("sha256")
            .update(await readFile(path.join(directory, name)))
            .digest("hex"),
          expected,
          `executed artifact hash: ${name}`,
        );
      }
      await writeFile(
        path.join(directory, "native-measurements.json"),
        JSON.stringify(report, null, 2),
      );
    } catch (error) {
      process.exitCode = 1;
      console.error("Native evidence finalization failed", error);
    } finally {
      app.exit(process.exitCode ? 1 : 0);
    }
  });
