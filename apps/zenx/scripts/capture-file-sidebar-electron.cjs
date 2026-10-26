/** Native macOS Electron diagnostic, owned synthetic window/profile only. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { mkdtempSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { app, BrowserWindow, screen } = require("electron");

assert.equal(
  process.platform,
  "darwin",
  "Requires actual macOS, not a renderer platform marker",
);
assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "Runs only on the disposable CI runner",
);
assert.ok(process.versions.electron, "Requires the installed Electron runtime");
const directory = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2], "Pass the built synthetic preview directory");
let window;
let profile;
let finishing = false;
const evidence = {
  scope:
    "Actual file sidebar components in macOS Electron, synthetic memory-only CJK files; owned-window Electron sendInputEvent and capturePage. No Host, user profile, private file, desktop capture, AX, or physical trackpad acceptance.",
  versions: process.versions,
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  cases: [],
  rendererErrors: [],
  blockedRequests: [],
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (expression) => {
  const result = await window.webContents.executeJavaScript(
    `(() => { try { return {ok:true,value:(${expression})}; } catch(error) { return {ok:false,error:String(error.stack||error)}; } })()`,
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
async function until(expression, label) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
}
const selector = '.auxiliary-content[role="tabpanel"]:not([hidden])';
const measure = `(() => {
  const root=document.querySelector(${JSON.stringify(selector)});
  const style=e=>{if(!e)return null;const s=getComputedStyle(e),r=e.getBoundingClientRect();return {tag:e.tagName,className:e.className,x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,scrollTop:e.scrollTop,scrollLeft:e.scrollLeft,overflowX:s.overflowX,overflowY:s.overflowY,outline:s.outline,border:s.border,focusVisible:e.matches(':focus-visible')};};
  const scroller=root?.querySelector('.cm-scroller'),r=scroller?.getBoundingClientRect();
  const nodes=[...root?.querySelectorAll('.markdown-live-editor,.cm-editor,.cm-scroller,.cm-content')||[]].map(style);
  const ancestors=[];for(let e=scroller?.parentElement;e;e=e.parentElement)ancestors.push(style(e));
  const tree=document.querySelector('.workspace-file-navigation');
  return {scroller:style(scroller),nodes,ancestors,treeVisible:!!tree?.getClientRects().length,tree:style(tree),panel:style(document.querySelector('.auxiliary-panel')),heading:style(document.querySelector('.auxiliary-heading')),location:style(root?.querySelector('.file-location')),titlebar:style(document.querySelector('.window-titlebar')),titlebarSession:style(document.querySelector('.window-titlebar-session')),activeElement:document.activeElement?.outerHTML.slice(0,500),renderedTail:root?.querySelector('.cm-editor')?.textContent.slice(-600),hitStack:r?document.elementsFromPoint(r.x+r.width/2,r.y+r.height/2).map(e=>e.tagName+'.'+e.className):[],wheelEvents:window.__nativeFileWheelEvents||[],page:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,widthLimit:innerWidth,heightLimit:innerHeight},navigatorPlatform:navigator.platform,devicePixelRatio,platformMarker:document.documentElement.dataset.platform};
})()`;
function requireFocus() {
  assert.ok(window.isFocused(), "Owned BrowserWindow must have OS focus");
  assert.ok(window.webContents.isFocused(), "Owned renderer must have focus");
}
function input(event) {
  requireFocus();
  window.webContents.sendInputEvent(event);
}
async function key(keyCode, modifiers = []) {
  input({ type: "keyDown", keyCode, modifiers });
  input({ type: "keyUp", keyCode, modifiers });
  await pause(60);
}
async function pointFor(target) {
  return evaluate(
    `(() => {const e=document.querySelector(${JSON.stringify(target)});if(!e)throw Error('Missing target');const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);if(!r.width||!r.height||!hit||!e.contains(hit))throw Error('Hidden/obscured target: '+${JSON.stringify(target)}+' hit='+hit?.className);return {x,y};})()`,
  );
}
async function click(target) {
  const point = await pointFor(target);
  input({ type: "mouseMove", ...point });
  input({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  input({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  await pause(100);
}
async function screenshot(name) {
  const image = await window.webContents.capturePage();
  assert.ok(!image.isEmpty(), "Nonempty owned-renderer capture");
  await fs.writeFile(path.join(directory, `${name}.png`), image.toPNG());
}
function bounded(state) {
  assert.ok(state.treeVisible, "File tree remains visible");
  const r = state.scroller;
  assert.ok(r.width > 0 && r.height > 0 && r.bottom <= state.panel.bottom + 1);
  assert.ok(r.x >= state.panel.x && r.right <= state.panel.right);
  assert.ok(
    state.page.width <= state.page.widthLimit &&
      state.page.height <= state.page.heightLimit,
  );
  // The CodeMirror scroller owns vertical movement, not an outer clipped pane.
  for (const e of state.ancestors)
    assert.equal(e.scrollTop, 0, `Unexpected outer scroll: ${e.className}`);
}
async function wheel(precise) {
  const point = await pointFor(`${selector} .cm-scroller`);
  input({ type: "mouseMove", ...point });
  // Electron wheel deltas have the opposite sign to DOM deltaY; validate the
  // delivered DOM event below instead of assuming the CDP transport convention.
  input({
    type: "mouseWheel",
    ...point,
    deltaX: 0,
    deltaY: -720,
    canScroll: true,
    hasPreciseScrollingDeltas: precise,
  });
  await pause(500);
}
async function runCase(width, precise) {
  const receipt = {
    name: `macos-cjk-${width}-${precise ? "precise" : "wheel"}`,
    width,
    precise,
    status: "running",
  };
  evidence.cases.push(receipt);
  await window.loadFile(path.join(directory, "file-sidebar.html"), {
    query: { lang: "zh-CN", theme: "light", diagnostic: "true" },
  });
  window.show();
  window.focus();
  window.webContents.focus();
  await until(
    "document.body?.dataset.previewReady==='true' && document.querySelector('.cm-scroller')",
    "component ready",
  );
  await until(
    `(() => {const p=document.querySelector('.auxiliary-panel').getBoundingClientRect(),b=document.querySelector('.window-titlebar').getBoundingClientRect();return Math.abs(b.right-p.x)<1;})()`,
    "integrated titlebar settled",
  );
  receipt.phase = "desktop-viewport";
  receipt.viewport = await evaluate("({width:innerWidth,height:innerHeight})");
  assert.equal(
    receipt.viewport.width,
    1400,
    "CI window must preserve desktop CSS viewport",
  );
  receipt.phase = "select-markdown";
  await click('.auxiliary-heading [id="aux-tab-file:docs/long-notes.md"]');
  await until(
    `document.querySelector(${JSON.stringify(selector)})?.id==='aux-content-file:docs/long-notes.md'`,
    "Markdown active",
  );
  receipt.phase = "resize-panel";
  await click(".auxiliary-panel > .browser-panel-resizer");
  for (let i = 0; i < 4; i++) await key("Left");
  await pause(300);
  const beforeResize = await evaluate(measure);
  receipt.phase = "resize-tree";
  const handle = await pointFor(".workspace-file-resizer");
  const end = {
    x: Math.round(handle.x + beforeResize.scroller.width - width),
    y: handle.y,
  };
  input({ type: "mouseMove", ...handle });
  input({ type: "mouseDown", button: "left", clickCount: 1, ...handle });
  input({
    type: "mouseMove",
    button: "left",
    modifiers: ["leftButtonDown"],
    ...end,
  });
  input({ type: "mouseUp", button: "left", clickCount: 1, ...end });
  await pause(300);
  await evaluate(
    `(() => {window.__nativeFileWheelEvents=[];document.addEventListener('wheel',event=>{const e={target:event.target?.className,deltaX:event.deltaX,deltaY:event.deltaY,deltaMode:event.deltaMode,defaultPreventedAtCapture:event.defaultPrevented};window.__nativeFileWheelEvents.push(e);setTimeout(()=>e.defaultPreventedAfterDispatch=event.defaultPrevented,0);},{capture:true,passive:true});})()`,
  );
  receipt.before = await evaluate(measure);
  assert.ok(
    Math.abs(receipt.before.scroller.width - width) <= 3,
    `Requested width ${width}, actual ${receipt.before.scroller.width}`,
  );
  bounded(receipt.before);
  await screenshot(`${receipt.name}-before`);
  receipt.phase = "wheel";
  await wheel(precise);
  receipt.unfocusedWheel = await evaluate(measure);
  assert.ok(
    receipt.unfocusedWheel.scroller.scrollTop >
      receipt.before.scroller.scrollTop + 100,
    "Wheel moves editor before content focus",
  );
  assert.ok(
    receipt.unfocusedWheel.wheelEvents.some((e) => e.deltaY > 0),
    "Actual DOM downward delta observed",
  );
  await click(`${selector} .cm-scroller`);
  receipt.focused = await evaluate(measure);
  assert.ok(
    receipt.focused.nodes.some((e) => e.className.includes("cm-focused")),
    "Editor truly focused",
  );
  await screenshot(`${receipt.name}-focused`);
  receipt.phase = "wheel";
  await wheel(precise);
  receipt.scrolled = await evaluate(measure);
  assert.ok(
    receipt.scrolled.scroller.scrollTop >
      receipt.unfocusedWheel.scroller.scrollTop + 100,
    "Wheel moves editor after focus",
  );
  bounded(receipt.scrolled);
  await screenshot(`${receipt.name}-scrolled`);
  receipt.phase = "meta-down";
  await key("Down", ["meta"]);
  await pause(500);
  receipt.end = await evaluate(measure);
  assert.ok(
    receipt.end.renderedTail.includes("LAST_MARKDOWN_SECTION"),
    "Meta+ArrowDown reaches final synthetic marker",
  );
  assert.ok(
    receipt.end.scroller.scrollTop > receipt.scrolled.scroller.scrollTop,
  );
  bounded(receipt.end);
  await screenshot(`${receipt.name}-end`);
  receipt.status = "passed";
}
async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  evidence.status = error ? "failed" : "passed";
  if (error) {
    evidence.failure = String(error.stack || error);
    try {
      evidence.failureState = await evaluate(measure);
      await screenshot("macos-file-failure");
    } catch (captureError) {
      evidence.captureError = String(captureError);
    }
  }
  try {
    await fs.writeFile(
      path.join(directory, "electron-measurements.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  } finally {
    window?.destroy();
    // Do not delete a profile while Chromium subprocesses may still hold it.
    // The disposable runner removes this temp profile after process teardown.
    app.exit(error ? 1 : 0);
  }
}
const watchdog = setTimeout(
  () => void finish(new Error("Owned Electron diagnostic exceeded 90 seconds")),
  90000,
);
(async () => {
  profile = mkdtempSync(path.join(os.tmpdir(), "zenx-file-editor-"));
  mkdirSync(path.join(profile, "session"));
  app.setPath("userData", profile);
  app.setPath("sessionData", path.join(profile, "session"));
  await app.whenReady();
  evidence.displays = screen
    .getAllDisplays()
    .map((d) => ({ bounds: d.bounds, scaleFactor: d.scaleFactor }));
  const source = JSON.parse(
    await fs.readFile(path.join(directory, "source.json"), "utf8"),
  );
  evidence.source = source;
  evidence.driverSha256 = createHash("sha256")
    .update(await fs.readFile(__filename))
    .digest("hex");
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    useContentSize: true,
    // Keep the requested desktop layout on CI's 1024px display without
    // changing display resolution or any macOS setting. Owned window only.
    enableLargerThanScreen: true,
    show: false,
    backgroundColor: "#0b0d10",
    title: "ZenX synthetic file diagnostic",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#00000000", symbolColor: "#737b8a", height: 44 },
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      evidence.blockedRequests.push(details.url);
      callback({ cancel: true });
    },
  );
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") evidence.rendererErrors.push(event.message);
  });
  window.webContents.on(
    "render-process-gone",
    (_event, details) =>
      void finish(new Error(`Renderer gone: ${details.reason}`)),
  );
  for (const width of [256, 384])
    for (const precise of [false, true]) await runCase(width, precise);
  assert.equal(evidence.rendererErrors.length, 0, "No renderer errors");
  assert.equal(evidence.blockedRequests.length, 0, "No external requests");
  await finish();
})().catch((error) => void finish(error));
