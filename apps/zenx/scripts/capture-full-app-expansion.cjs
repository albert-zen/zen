/** Owns only a disposable CI Electron instance. No remote debugging or sandbox bypass. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, session } = require("electron");
assert.ok(["win32", "darwin"].includes(process.platform));
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.ok(process.versions.electron);
assert.ok(
  !process.argv.some(
    (a) => a === "--no-sandbox" || a.startsWith("--remote-debugging"),
  ),
);
const [directory, version, temporary] = process.argv.slice(2, 5);
assert.ok(directory && temporary && ["before", "current"].includes(version));
app.setPath("userData", path.join(temporary, "profile"));
app.setPath("home", path.join(temporary, "home"));
// The private Windows profile has no OS-registered Documents known folder.
// Point only this owned Electron app at the directory created by its launcher.
app.setPath("documents", path.join(temporary, "home", "Documents"));
const result = {
  ok: false,
  version,
  platform: process.platform,
  electron: process.versions.electron,
  scope:
    "Actual production App and local fake Host; thread/start initialization, then actual UI selection/open/maximize. Target Thread must remain at zero Turns; fake provider only.",
  steps: [],
  blockedExternalRequests: 0,
};
let window;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// Catch renderer exceptions before Electron replaces them with an opaque IPC rejection.
// JSON-normalize successes too: only plain data crosses this diagnostic boundary.
function diagnosticEvaluation(expression) {
  return `(async()=>{try{const value=await (${expression});return {ok:true,value:JSON.parse(JSON.stringify(value??null))}}catch(error){return {ok:false,error:{message:String(error?.message??error).slice(0,4000),stack:String(error?.stack??'').slice(0,4000)}}}})()`;
}
const evaluate = async (expression) => {
  const reply = await window.webContents.executeJavaScript(
    diagnosticEvaluation(expression),
    true,
  );
  if (!reply.ok) {
    const failure = {
      operation:
        result.pendingOperation ?? result.waitingFor ?? "read-only diagnostic",
      ...reply.error,
    };
    (result.rendererErrors ??= []).push(failure);
    throw new Error("Renderer diagnostic failed: " + JSON.stringify(failure));
  }
  return reply.value;
};
async function until(check, label) {
  result.waitingFor = label;
  for (let i = 0; i < 400; i++) {
    if (await check()) {
      delete result.waitingFor;
      return;
    }
    await pause(100);
  }
  throw Error("Timed out: " + label);
}
async function click(expression, label) {
  result.pendingOperation = label;
  await until(
    async () => Boolean(await evaluate(`Boolean(${expression})`)),
    label,
  );
  const p = await evaluate(
    `(()=>{const e=${expression},r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(!e.contains(document.elementFromPoint(x,y))){const describe=n=>{const b=n.getBoundingClientRect(),s=getComputedStyle(n);return {tag:n.tagName,id:n.id,className:typeof n.className==='string'?n.className:n.className.baseVal,bounds:{left:b.left,top:b.top,width:b.width,height:b.height},zIndex:s.zIndex,visibility:s.visibility,pointerEvents:s.pointerEvents}};throw Error('Obscured target: '+${JSON.stringify(label)}+' '+JSON.stringify({target:describe(e),point:{x,y},hitStack:document.elementsFromPoint(x,y).slice(0,5).map(describe)}))}return {x:Math.round(x),y:Math.round(y)}})()`,
  );
  window.show();
  window.focus();
  window.webContents.focus();
  await until(
    async () => window.isFocused() && window.webContents.isFocused(),
    "Owned native window and renderer focus",
  );
  window.webContents.sendInputEvent({
    type: "mouseDown",
    button: "left",
    clickCount: 1,
    ...p,
  });
  window.webContents.sendInputEvent({
    type: "mouseUp",
    button: "left",
    clickCount: 1,
    ...p,
  });
  result.steps.push(label);
  delete result.pendingOperation;
}
async function screenshot(name) {
  await fs.writeFile(
    path.join(directory, name),
    (await window.webContents.capturePage()).toPNG(),
  );
}
const measure = `(()=>{const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}},desc=e=>{const s=getComputedStyle(e);return {tag:e.tagName,id:e.id,className:typeof e.className==='string'?e.className:e.className.baseVal,bounds:rect(e),visibility:s.visibility,zIndex:s.zIndex}},rail=document.querySelector('.auxiliary-heading [role=tablist]'),rr=rect(rail);return {time:performance.now(),motion:{reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,railTransition:rail?{property:getComputedStyle(rail).transitionProperty,duration:getComputedStyle(rail).transitionDuration}:null,panelTransition:document.querySelector('.auxiliary-panel')?{property:getComputedStyle(document.querySelector('.auxiliary-panel')).transitionProperty,duration:getComputedStyle(document.querySelector('.auxiliary-panel')).transitionDuration}:null,titlebarTransition:document.querySelector('.window-titlebar')?{property:getComputedStyle(document.querySelector('.window-titlebar')).transitionProperty,duration:getComputedStyle(document.querySelector('.window-titlebar')).transitionDuration}:null},sidebarCollapsed:document.querySelector('.app-shell').classList.contains('sidebar-collapsed'),shell:rect(document.querySelector('.app-shell')),panel:rect(document.querySelector('.auxiliary-panel')),url:location.href,platform:document.documentElement.dataset.platform,expanded:document.querySelector('.auxiliary-panel')?.dataset.expanded,rail:rr,scrollLeft:rail?.scrollLeft,scrollWidth:rail?.scrollWidth,clientWidth:rail?.clientWidth,tabs:[...document.querySelectorAll('.workspace-content-tab')].map(e=>{const tab=e.querySelector('[role=tab]'),icon=rect(tab.querySelector('svg')),hit=document.elementFromPoint(icon.left+icon.width/2,icon.top+icon.height/2);return {id:e.dataset.tabId,bounds:rect(e),icon,iconInsideRail:icon.left>=rr.left&&icon.right<=rr.right,hitInTab:tab.contains(hit),hitStack:document.elementsFromPoint(icon.left+icon.width/2,icon.top+icon.height/2).slice(0,7).map(desc)}}),chrome:['.window-titlebar','.window-titlebar-session'].map(s=>{const e=document.querySelector(s);return {selector:s,...(e?desc(e):{})}})}})()`;
const networkReady = app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const u = new URL(details.url);
      allowed =
        ["file:", "data:", "blob:", "about:", "devtools:"].includes(
          u.protocol,
        ) ||
        (["http:", "https:", "ws:", "wss:"].includes(u.protocol) &&
          ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname));
    } catch {}
    if (!allowed) result.blockedExternalRequests++;
    callback({ cancel: !allowed });
  });
});
async function run() {
  await networkReady;
  await until(async () => {
    window = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().endsWith("/renderer/index.html"),
    );
    return Boolean(window);
  }, "real production renderer URL");
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  assert.equal(
    window.webContents.getLastWebPreferences().contextIsolation,
    true,
  );
  result.runtimePreferences = {
    sandbox: window.webContents.getLastWebPreferences().sandbox,
    contextIsolation:
      window.webContents.getLastWebPreferences().contextIsolation,
    nodeIntegration: window.webContents.getLastWebPreferences().nodeIntegration,
  };
  window.setSize(1280, 820);
  window.show();
  window.focus();
  await until(
    async () =>
      Boolean(
        await evaluate(
          "Boolean(document.querySelector('.app-shell') && window.zenx?.protocol)",
        ),
      ),
    "production App mounted",
  );
  await until(
    async () =>
      await evaluate(
        "window.zenx.protocol.getStatus().then(s=>s.type==='ready')",
      ),
    "local fake Host ready",
  );
  const started = await evaluate(
    `window.zenx.protocol.request('thread/start',{cwd:${JSON.stringify(path.join(temporary, "workspace"))}})`,
  );
  assert.ok(started.thread?.id);
  result.steps.push(
    "Real protocol thread/start only; synthetic idle Thread initialized",
  );
  await click(
    `document.querySelector(${JSON.stringify(".thread-row-shell[data-thread-id=" + JSON.stringify(started.thread.id) + "] > button.thread-row")})`,
    "Select created idle Thread",
  );
  await click(
    "document.querySelector('#thread-browser-toggle:not(:disabled)')",
    "Open right workspace",
  );
  await click(
    "[...document.querySelectorAll('.workspace-tab-types button')].find(e=>e.textContent.includes('Subagents'))",
    "Open actual Subagents contribution",
  );
  await until(
    async () =>
      Boolean(
        await evaluate(
          "document.querySelector('.workspace-content-tab[data-tab-id*=\"zenx-subagents\"]')",
        ),
      ),
    "Subagents resource tab",
  );
  await until(
    async () =>
      Boolean(
        await evaluate(
          "document.querySelector('.auxiliary-plugin[data-plugin-surface=\"zenx-subagents:subagents-panel\"] .subagents-panel')",
        ),
      ),
    "Actual trusted Subagents body mounted",
  );
  result.steps.push(
    "Verified real bundled Subagents body, not unavailable placeholder",
  );
  result.cases = [];
  for (const sidebarState of ["open", "collapsed"]) {
    if (
      await evaluate(
        "document.querySelector('.auxiliary-panel')?.dataset.expanded === 'true'",
      )
    ) {
      await click(
        "document.querySelector('.auxiliary-heading > button[aria-pressed=\"true\"]')",
        "Restore right pane before next sidebar case",
      );
      await until(
        async () =>
          await evaluate(
            "document.querySelector('.auxiliary-panel')?.dataset.expanded === 'false'",
          ),
        "Right pane restored",
      );
    }
    const collapsed = await evaluate(
      "document.querySelector('.app-shell').classList.contains('sidebar-collapsed')",
    );
    if (collapsed !== (sidebarState === "collapsed")) {
      await click(
        "document.querySelector('.sidebar-collapse-button')",
        "Set left sidebar " + sidebarState,
      );
      await until(
        async () =>
          (await evaluate(
            "document.querySelector('.app-shell').classList.contains('sidebar-collapsed')",
          )) ===
          (sidebarState === "collapsed"),
        "Left sidebar state committed",
      );
    }
    const item = { sidebarState };
    result.cases.push(item);
    await pause(350);
    item.before = await evaluate(measure);
    assert.equal(item.before.expanded, "false");
    assert.equal(item.before.tabs.length, 1);
    await screenshot(`${version}-full-app-${sidebarState}-before.png`);
    await evaluate(
      `(()=>{window.__fullAppFrames=[];window.__fullAppStart=performance.now();const tick=()=>{window.__fullAppFrames.push(${measure});if(performance.now()-window.__fullAppStart<900)requestAnimationFrame(tick)};requestAnimationFrame(tick)})()`,
    );
    await click(
      "document.querySelector('.auxiliary-heading > button[aria-pressed=\"false\"]')",
      "Click right-pane internal maximize",
    );
    item.transition = [];
    for (const targetMs of [0, 70, 160]) {
      const elapsed = await evaluate("performance.now()-window.__fullAppStart");
      if (elapsed < targetMs) await pause(targetMs - elapsed);
      const sample = await evaluate(measure);
      const file = `${version}-full-app-${sidebarState}-transition-${targetMs}.png`;
      await screenshot(file);
      item.transition.push({
        file,
        targetMs,
        sample,
        captureFinishedElapsedMs: await evaluate(
          "performance.now()-window.__fullAppStart",
        ),
      });
    }
    await pause(950);
    item.settled = await evaluate(measure);
    item.frames = await evaluate("window.__fullAppFrames");
    await screenshot(`${version}-full-app-${sidebarState}-settled.png`);
    assert.equal(item.settled.expanded, "true");
    assert.equal(item.settled.platform, process.platform);
    assert.equal(item.settled.tabs.length, version === "current" ? 2 : 1);
  }
  const read = await evaluate(
    `window.zenx.protocol.request('thread/read',{threadId:${JSON.stringify(started.thread.id)},includeTurns:true})`,
  );
  assert.equal(read.thread.turns.length, 0, "No Turn must be created");
  result.turnCount = 0;
  result.ok = true;
}
// Import the real built production main, which creates the real production App window/preload.
void import(pathToFileURL(path.join(__dirname, "../out/main/index.js")).href)
  .then(run)
  .catch(async (error) => {
    result.error = String(error.stack || error);
    if (window && !window.isDestroyed())
      try {
        await screenshot(`${version}-full-app-failure.png`);
      } catch {}
  })
  .finally(async () => {
    await fs.writeFile(
      path.join(directory, "full-app-measurements.json"),
      JSON.stringify(result, null, 2),
    );
    process.exitCode = result.ok ? 0 : 1;
    app.quit();
  });
