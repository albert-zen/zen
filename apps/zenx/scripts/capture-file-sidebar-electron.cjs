/** Native macOS Electron diagnostic, owned synthetic window/profile only. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { mkdtempSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createServer } = require("node:http");
const { pathToFileURL } = require("node:url");
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
let previousDocumentNonce;
let policyProbeActive = false;
let originProbeUrl;
const evidence = {
  scope:
    "Actual file sidebar components in macOS Electron, synthetic memory-only CJK files; owned-window Electron sendInputEvent and capturePage. No Host, user profile, private file, desktop capture, AX, or physical trackpad acceptance.",
  versions: process.versions,
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  cases: [],
  rendererErrors: [],
  expectedPolicyErrors: [],
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
  const style=e=>{if(!e)return null;const s=getComputedStyle(e),r=e.getBoundingClientRect();return {tag:e.tagName,className:e.className,x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,scrollTop:e.scrollTop,scrollLeft:e.scrollLeft,overflowX:s.overflowX,overflowY:s.overflowY,outline:s.outline,border:s.border,inlineStyle:e.getAttribute("style"),navigationWidth:s.getPropertyValue("--file-navigation-width"),workspaceWidth:s.getPropertyValue("--workspace-panel-width"),focusVisible:e.matches(':focus-visible')};};
  const scroller=root?.querySelector('.cm-scroller'),r=scroller?.getBoundingClientRect();
  const nodes=[...root?.querySelectorAll('.markdown-live-editor,.cm-editor,.cm-scroller,.cm-content')||[]].map(style);
  const ancestors=[];for(let e=scroller?.parentElement;e;e=e.parentElement)ancestors.push(style(e));
  const tree=document.querySelector('.workspace-file-navigation');
  return {scroller:style(scroller),nodes,ancestors,treeVisible:!!tree?.getClientRects().length,tree:style(tree),panel:style(document.querySelector('.auxiliary-panel')),heading:style(document.querySelector('.auxiliary-heading')),location:style(root?.querySelector('.file-location')),titlebar:style(document.querySelector('.window-titlebar')),titlebarSession:style(document.querySelector('.window-titlebar-session')),activeElement:document.activeElement?.outerHTML.slice(0,500),renderedTail:root?.querySelector('.cm-editor')?.textContent.slice(-600),hitStack:r?document.elementsFromPoint(r.x+r.width/2,r.y+r.height/2).map(e=>e.tagName+'.'+e.className):[],wheelEvents:window.__nativeFileWheelEvents||[],keyEvents:window.__nativeFileKeyEvents||[],cspViolations:window.__fileCspViolations||[],page:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,widthLimit:innerWidth,heightLimit:innerHeight},navigatorPlatform:navigator.platform,devicePixelRatio,platformMarker:document.documentElement.dataset.platform};
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
    `(() => {const e=document.querySelector(${JSON.stringify(target)});if(!e)throw Error('Missing target');const r=e.getBoundingClientRect(),x=Math.round((Math.max(0,r.x)+Math.min(innerWidth,r.right))/2),y=Math.round((Math.max(0,r.y)+Math.min(innerHeight,r.bottom))/2),hit=document.elementFromPoint(x,y);if(!r.width||!r.height||!hit||!e.contains(hit))throw Error('Hidden/obscured target: '+${JSON.stringify(target)}+' hit='+hit?.className);return {x,y};})()`,
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
async function verifyOriginIsolation() {
  const marker = path.join(profile, "synthetic-file-denial-marker.txt");
  await fs.writeFile(marker, "SYNTHETIC_FILE_READ_MUST_BE_DENIED");
  const targets = [
    {
      name: "entry",
      url: pathToFileURL(
        path.join(directory, "file-sidebar-production-csp.html"),
      ).href,
    },
    {
      name: "adjacent-asset",
      url: pathToFileURL(path.join(directory, "file-sidebar-production.css"))
        .href,
    },
    { name: "outside-resource-root", url: pathToFileURL(marker).href },
  ];
  const server = createServer((_request, response) =>
    response.end("<!doctype html><title>Synthetic non-file origin</title>"),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  originProbeUrl = `http://127.0.0.1:${server.address().port}/`;
  const probe = new BrowserWindow({
    show: false,
    webPreferences: {
      session: window.webContents.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  probe.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  evidence.originIsolation = [];
  try {
    for (const origin of [
      "data:text/html,<title>Synthetic opaque origin</title>",
      originProbeUrl,
    ]) {
      await probe.loadURL(origin);
      const result = await probe.webContents.executeJavaScript(`(async()=>{
        const results=[];
        for(const target of ${JSON.stringify(targets)})for(const mode of ['cors','no-cors']){
          try{const response=await fetch(target.url,{mode});const text=await response.text();results.push({target:target.name,mode,readable:response.type!=='opaque'&&text.length>0,responseType:response.type});}
          catch{results.push({target:target.name,mode,readable:false,blocked:true});}
        }
        return results;
      })()`);
      evidence.originIsolation.push({
        origin: origin.startsWith("data:") ? "opaque-data" : "loopback-http",
        results: result,
      });
      assert.ok(
        result.every((item) => !item.readable),
        "Non-file document must not gain file reads through main's handler",
      );
    }
  } finally {
    probe.destroy();
    await new Promise((resolve) => server.close(resolve));
    originProbeUrl = undefined;
  }
}
async function runCase(width, precise, productionCsp = false) {
  const receipt = {
    name: `macos-cjk-${width}-${precise ? "precise" : "wheel"}${productionCsp ? "-production-csp" : ""}`,
    productionCsp,
    width,
    precise,
    status: "running",
  };
  evidence.cases.push(receipt);
  await window.loadFile(
    path.join(
      directory,
      productionCsp ? "file-sidebar-production-csp.html" : "file-sidebar.html",
    ),
    productionCsp
      ? {}
      : { query: { lang: "zh-CN", theme: "light", diagnostic: "true" } },
  );
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
  if (productionCsp) {
    const nonce = await evaluate(
      `document.querySelector('meta[name="zenx-style-nonce"]')?.content`,
    );
    assert.ok(
      typeof nonce === "string" && nonce.length === 32,
      "Trusted document nonce present",
    );
    assert.ok(
      nonce !== previousDocumentNonce,
      "Navigation creates a fresh nonce",
    );
    previousDocumentNonce = nonce;
    receipt.freshDocumentNonce = true;
    assert.equal(
      (await evaluate("window.__fileCspViolations||[]")).length,
      0,
      "Runtime editor styles pass strict CSP",
    );
    receipt.sourceBefore = await evaluate(measure);
    bounded(receipt.sourceBefore);
    await wheel(false);
    receipt.sourceAfter = await evaluate(measure);
    assert.ok(
      receipt.sourceAfter.scroller.scrollTop > 100,
      "Source editor also scrolls under strict CSP",
    );
    await click("[data-native-composer-diagnostic] .cm-content");
    input({ type: "char", keyCode: "x" });
    await until(
      `document.querySelector('[data-native-composer-diagnostic] .cm-content').textContent.includes('x')`,
      "Composer native character input",
    );
    receipt.composerInput = true;
    if (evidence.cases.length === 1) {
      policyProbeActive = true;
      try {
        receipt.policyProbes = await evaluate(`(() => {
          const nonce=document.querySelector('meta[name="zenx-style-nonce"]').content;
          const probes=[['none',null],['wrong','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],['valid',nonce]];
          const result={};const elements=[];
          for(const [name,value] of probes){const e=document.createElement('style');if(value)e.nonce=value;e.textContent='html { --zenx-policy-'+name+': accepted; }';document.head.appendChild(e);elements.push(e);}
          for(const [name] of probes)result[name]=getComputedStyle(document.documentElement).getPropertyValue('--zenx-policy-'+name).trim();
          elements.forEach(e=>e.remove());return result;
        })()`);
        await pause(150);
        assert.equal(receipt.policyProbes.none, "");
        assert.equal(receipt.policyProbes.wrong, "");
        assert.equal(receipt.policyProbes.valid, "accepted");
        receipt.policyProbeViolations = await evaluate(
          "window.__fileCspViolations",
        );
        assert.equal(
          receipt.policyProbeViolations.length,
          2,
          "Both unauthorized inline styles remain blocked",
        );
      } finally {
        policyProbeActive = false;
      }
    }
  }
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
    `(() => {window.__nativeFileWheelEvents=[];window.__nativeFileKeyEvents=[];document.addEventListener('keydown',event=>{const e={key:event.key,code:event.code,metaKey:event.metaKey,ctrlKey:event.ctrlKey,altKey:event.altKey,shiftKey:event.shiftKey,target:event.target?.className};window.__nativeFileKeyEvents.push(e);setTimeout(()=>e.defaultPrevented=event.defaultPrevented,0);},{capture:true,passive:true});document.addEventListener('wheel',event=>{const e={target:event.target?.className,deltaX:event.deltaX,deltaY:event.deltaY,deltaMode:event.deltaMode,defaultPreventedAtCapture:event.defaultPrevented};window.__nativeFileWheelEvents.push(e);setTimeout(()=>e.defaultPreventedAfterDispatch=event.defaultPrevented,0);},{capture:true,passive:true});})()`,
  );
  receipt.afterResize = await evaluate(measure);
  receipt.nativeWindow = {
    focused: window.isFocused(),
    visible: window.isVisible(),
    minimized: window.isMinimized(),
    bounds: window.getBounds(),
    contentBounds: window.getContentBounds(),
  };
  // React/ResizeObserver/Chromium layout must converge before checking geometry.
  // Preserve the exact width contract; a timeout retains all pre-wait evidence.
  await until(
    `Math.abs(document.querySelector(${JSON.stringify(selector)}).querySelector('.cm-scroller').getBoundingClientRect().width-${width})<=3`,
    "resized editor layout committed",
  );
  receipt.before = await evaluate(measure);
  assert.ok(
    Math.abs(receipt.before.scroller.width - width) <= 3,
    `Requested width ${width}, actual ${receipt.before.scroller.width}`,
  );
  try {
    bounded(receipt.before);
  } catch (error) {
    if (!productionCsp) throw error;
    // Retain the failed layout contract, but still measure one native wheel
    // over the visible editor portion to diagnose the reported symptom.
    receipt.initialLayoutFailure = String(error);
  }
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
  await key("Down", ["command"]);
  await until(
    `document.querySelector(${JSON.stringify(selector)}).querySelector('.cm-editor').textContent.includes('LAST_MARKDOWN_SECTION')`,
    "native document-end layout committed",
  );
  receipt.end = await evaluate(measure);
  assert.ok(
    receipt.end.keyEvents.some((e) => e.key === "ArrowDown" && e.metaKey),
    "Native Command+Down must arrive as DOM metaKey ArrowDown",
  );
  assert.ok(
    receipt.end.renderedTail.includes("LAST_MARKDOWN_SECTION"),
    "Meta+ArrowDown reaches final synthetic marker",
  );
  assert.ok(
    receipt.end.scroller.scrollTop > receipt.scrolled.scroller.scrollTop,
  );
  bounded(receipt.end);
  await screenshot(`${receipt.name}-end`);
  assert.ok(
    !receipt.initialLayoutFailure,
    "Production layout contract must also pass",
  );
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
      if (originProbeUrl && details.url.startsWith(originProbeUrl)) {
        callback({ cancel: false });
        return;
      }
      evidence.blockedRequests.push(details.url);
      callback({ cancel: true });
    },
  );
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") {
      const message = event.message.replace(
        /'nonce-[^']+'/gu,
        "'nonce-[redacted]'",
      );
      (policyProbeActive
        ? evidence.expectedPolicyErrors
        : evidence.rendererErrors
      ).push(message);
    }
  });
  window.webContents.on(
    "render-process-gone",
    (_event, details) =>
      void finish(new Error(`Renderer gone: ${details.reason}`)),
  );
  const { installRendererFileProtocol } =
    await import("../out/main/renderer-file-protocol.js");
  installRendererFileProtocol(
    window.webContents.session,
    path.join(directory, "file-sidebar-production-csp.html"),
  );
  await verifyOriginIsolation();
  evidence.runtimeSecurity =
    "Production file handler, exact generated strict-CSP entry, fresh document style nonce";
  for (const width of [256, 384]) {
    for (const precise of [false, true]) {
      try {
        await runCase(width, precise, true);
      } catch (error) {
        const receipt = evidence.cases.at(-1);
        receipt.status = "failed";
        receipt.failure = String(error.stack || error);
        receipt.failureState = await evaluate(measure);
        await screenshot(`${receipt.name}-failure`);
      }
    }
  }
  assert.ok(
    evidence.cases.every((c) => c.status === "passed"),
    "All native cases must pass; see per-case failure evidence",
  );
  assert.equal(evidence.rendererErrors.length, 0, "No renderer errors");
  assert.equal(evidence.blockedRequests.length, 0, "No external requests");
  await finish();
})().catch((error) => void finish(error));
