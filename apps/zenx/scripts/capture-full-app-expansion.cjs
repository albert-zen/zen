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
  return `(async()=>{try{const value=await (${expression});return {ok:true,value:JSON.parse(JSON.stringify(value??null,(_key,item)=>{if(typeof Node!=='undefined'&&item instanceof Node)throw Error('Diagnostic returned a DOM node; return a boolean or plain measurement');if(typeof item==='function'||typeof item==='symbol'||typeof item==='bigint')throw Error('Diagnostic returned a non-serializable value');return item}))}}catch(error){return {ok:false,error:{message:String(error?.message??error).slice(0,4000),stack:String(error?.stack??'').slice(0,4000)}}}})()`;
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
// Electron wheel delta sign is opposite to DOM deltaY (existing native capture contract).
function sidebarWheelDelta(row, viewport) {
  if (row.top >= viewport.top + 4 && row.bottom <= viewport.bottom - 4)
    return 0;
  if (row.bottom > viewport.bottom - 4)
    return -Math.ceil(
      Math.min(360, Math.max(80, row.bottom - viewport.bottom + 16)),
    );
  return Math.ceil(Math.min(360, Math.max(80, viewport.top - row.top + 16)));
}
async function revealThreadWithSidebarWheel(expression) {
  result.sidebarSelectionScroll = [];
  window.show();
  window.focus();
  window.webContents.focus();
  await until(
    async () => window.isFocused() && window.webContents.isFocused(),
    "Owned window focus for sidebar selection",
  );
  for (let attempt = 0; attempt < 6; attempt++) {
    const state = await evaluate(
      `(()=>{const row=${expression},scroller=row?.closest('.sidebar-scroll');if(!row||!scroller)throw Error('Thread row is not in the left sidebar scroller');const r=row.getBoundingClientRect(),v=scroller.getBoundingClientRect(),footer=document.querySelector('.sidebar-footer')?.getBoundingClientRect(),viewport={left:v.left,right:v.right,top:Math.max(0,v.top),bottom:Math.min(innerHeight,v.bottom,footer?.top??innerHeight)},x=Math.round((viewport.left+viewport.right)/2),y=Math.round((viewport.top+viewport.bottom)/2);if(!scroller.contains(document.elementFromPoint(x,y)))throw Error('Left sidebar wheel point is obscured');return {row:{top:r.top,bottom:r.bottom},viewport,point:{x,y},scrollTop:scroller.scrollTop,scrollLeft:scroller.scrollLeft}})()`,
    );
    const deltaY = sidebarWheelDelta(state.row, state.viewport);
    if (deltaY === 0) return;
    result.sidebarSelectionScroll.push({
      attempt,
      ...state,
      deltaX: 0,
      deltaY,
    });
    window.webContents.sendInputEvent({ type: "mouseMove", ...state.point });
    window.webContents.sendInputEvent({
      type: "mouseWheel",
      ...state.point,
      deltaX: 0,
      deltaY,
      canScroll: true,
      hasPreciseScrollingDeltas: true,
    });
    result.steps.push(
      "Diagnostic preparation: native vertical wheel in LEFT sidebar only",
    );
    await pause(300);
  }
  throw Error(
    "Created Thread was not fully visible after six bounded left-sidebar vertical wheel steps",
  );
}
const sidebarMeasure = `(()=>{const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}},scroll=document.querySelector('.sidebar-scroll');return {sidebar:rect(document.querySelector('.sidebar')),scroll:scroll?{bounds:rect(scroll),offsetWidth:scroll.offsetWidth,clientWidth:scroll.clientWidth,scrollHeight:scroll.scrollHeight,clientHeight:scroll.clientHeight,scrollTop:scroll.scrollTop,scrollLeft:scroll.scrollLeft,slack:scroll.clientHeight-scroll.scrollHeight,gutter:scroll.offsetWidth-scroll.clientWidth,borderLeft:getComputedStyle(scroll).borderLeftWidth,borderRight:getComputedStyle(scroll).borderRightWidth,scrollbarWidth:getComputedStyle(scroll).scrollbarWidth,scrollbarGutter:getComputedStyle(scroll).scrollbarGutter}:null,sections:[...document.querySelectorAll('.sidebar button[aria-controls]')].filter(e=>e.hasAttribute('aria-expanded')).map(e=>({controls:e.getAttribute('aria-controls'),expanded:e.getAttribute('aria-expanded'),bounds:rect(e)})),header:rect(document.querySelector('.sidebar-header')),footer:rect(document.querySelector('.sidebar-footer')),newThreadIcon:rect(document.querySelector('.new-thread-action svg')),viewActions:rect(document.querySelector('.sidebar-view-actions')),viewActionIcon:rect(document.querySelector('.sidebar-view-actions svg')),settingsIcon:rect(document.querySelector('.settings-nav-row svg')),viewport:{width:innerWidth,height:innerHeight,devicePixelRatio}}})()`;
async function screenshot(name) {
  await fs.writeFile(
    path.join(directory, name),
    (await window.webContents.capturePage()).toPNG(),
  );
}
const measure = `(()=>{const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}},desc=e=>{const s=getComputedStyle(e);return {tag:e.tagName,id:e.id,className:typeof e.className==='string'?e.className:e.className.baseVal,bounds:rect(e),visibility:s.visibility,zIndex:s.zIndex}},rail=document.querySelector('.auxiliary-heading [role=tablist]'),rr=rect(rail);return {time:performance.now(),motion:{reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,railTransition:rail?{property:getComputedStyle(rail).transitionProperty,duration:getComputedStyle(rail).transitionDuration}:null,panelTransition:document.querySelector('.auxiliary-panel')?{property:getComputedStyle(document.querySelector('.auxiliary-panel')).transitionProperty,duration:getComputedStyle(document.querySelector('.auxiliary-panel')).transitionDuration}:null,titlebarTransition:document.querySelector('.window-titlebar')?{property:getComputedStyle(document.querySelector('.window-titlebar')).transitionProperty,duration:getComputedStyle(document.querySelector('.window-titlebar')).transitionDuration}:null},sidebarCollapsed:document.querySelector('.app-shell').classList.contains('sidebar-collapsed'),shell:rect(document.querySelector('.app-shell')),panel:rect(document.querySelector('.auxiliary-panel')),url:location.href,platform:document.documentElement.dataset.platform,expanded:document.querySelector('.auxiliary-panel')?.dataset.expanded,rail:rr,scrollLeft:rail?.scrollLeft,scrollWidth:rail?.scrollWidth,clientWidth:rail?.clientWidth,tabs:[...document.querySelectorAll('.workspace-content-tab')].map(e=>{const tab=e.querySelector('[role=tab]'),icon=rect(tab.querySelector('svg')),hit=document.elementFromPoint(icon.left+icon.width/2,icon.top+icon.height/2);return {id:e.dataset.tabId,bounds:rect(e),icon,iconInsideRail:icon.left>=rr.left&&icon.right<=rr.right,hitInTab:tab.contains(hit),iconHitPoints:[[icon.left+icon.width/2,icon.top+icon.height/2],[icon.left+0.5,icon.top+0.5],[icon.right-0.5,icon.top+0.5],[icon.left+0.5,icon.bottom-0.5],[icon.right-0.5,icon.bottom-0.5]].map(([x,y])=>tab.contains(document.elementFromPoint(x,y))),hitStack:document.elementsFromPoint(icon.left+icon.width/2,icon.top+icon.height/2).slice(0,7).map(desc)}}),nativeSidebarToggle:(()=>{const e=document.querySelector('.sidebar-collapse-button');if(!e)return null;const r=rect(e);return {bounds:r,visibility:getComputedStyle(e).visibility,hit:e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}})(),chrome:['.window-titlebar','.window-titlebar-session','.window-titlebar-session > .workspace-header'].map(s=>{const e=document.querySelector(s);return {selector:s,...(e?desc(e):{})}})}})()`;
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
function assertExpandedTitleSurface(state) {
  assert.equal(
    state.tabs[0]?.id,
    "primary-conversation",
    "Current full App includes its leading conversation Tab",
  );
  assert.ok(
    state.tabs.some((tab) => tab.id.includes("zenx-subagents")),
    "Actual Subagents resource remains in the same strip",
  );
  for (const tab of state.tabs) {
    assert.equal(
      tab.iconInsideRail,
      true,
      `Whole icon stays inside rail: ${tab.id}`,
    );
    assert.equal(tab.hitInTab, true, `Icon center is not covered: ${tab.id}`);
    assert.ok(
      tab.iconHitPoints?.every(Boolean),
      `No icon corner is covered: ${tab.id}`,
    );
  }
  const session = state.chrome.find(
    (c) => c.selector === ".window-titlebar-session",
  );
  assert.equal(
    session?.visibility,
    "hidden",
    "Obsolete session surface is hidden",
  );
  assert.ok(
    session.bounds.width <= 0.5,
    "Expanded session track has no workspace width",
  );
  assert.equal(
    state.chrome.find(
      (c) => c.selector === ".window-titlebar-session > .workspace-header",
    )?.visibility,
    "hidden",
    "Padded workspace-header inherits the hidden session surface",
  );
  assert.equal(
    state.nativeSidebarToggle?.visibility,
    "visible",
    "Native sidebar control remains visible",
  );
  assert.equal(
    state.nativeSidebarToggle?.hit,
    true,
    "Native sidebar control remains hittable",
  );
}
// Scoped to the already-running, owned App renderer; never navigates or changes OS settings.
async function withMotionPreference(webContents, preference, action, receipt) {
  assert.equal(
    webContents.debugger.isAttached(),
    false,
    "Do not disturb another debugger owner",
  );
  let attached = false;
  try {
    webContents.debugger.attach("1.3");
    attached = true;
    await webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: preference }],
    });
    receipt.applied = true;
    return await action();
  } finally {
    if (attached) {
      try {
        await webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
          features: [],
        });
        receipt.restored = true;
      } finally {
        webContents.debugger.detach();
        receipt.detached = true;
      }
    }
  }
}
const dragMeasure = `(()=>{const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}},describe=e=>{const s=getComputedStyle(e);return {tag:e.tagName,className:typeof e.className==='string'?e.className:e.className.baseVal,bounds:rect(e),background:s.backgroundColor,zIndex:s.zIndex,visibility:s.visibility}},panel=document.querySelector('.auxiliary-panel'),p=rect(panel),title=document.querySelector('.window-titlebar'),t=rect(title),header=document.querySelector('.window-titlebar-session > .workspace-header'),h=rect(header),rail=document.querySelector('.auxiliary-heading [role=tablist]');return {time:performance.now(),panel:p,titlebar:t,session:rect(document.querySelector('.window-titlebar-session')),workspaceHeader:h,resizer:rect(document.querySelector('.browser-panel-resizer')),requestedWidth:Number(document.querySelector('.browser-panel-resizer').getAttribute('aria-valuenow')),reportedWidth:getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--workspace-panel-width'),titlebarOverlap:t.right-p.left,headerOverlap:h?h.right-p.left:null,railScrollLeft:rail.scrollLeft,expanded:panel.dataset.expanded,resizing:panel.dataset.resizing,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,panelTransition:{property:getComputedStyle(panel).transitionProperty,duration:getComputedStyle(panel).transitionDuration},titlebarTransition:{property:getComputedStyle(title).transitionProperty,duration:getComputedStyle(title).transitionDuration},dividerHits:[20,Math.min(innerHeight-20,100)].map(y=>({point:{x:p.left+1,y},stack:document.elementsFromPoint(p.left+1,y).slice(0,6).map(describe)}))}})()`;
async function nativeWidthDrag(targetWidth, label) {
  const item = { label, targetWidth, inputs: [] };
  result.widthDrags.push(item);
  item.before = await evaluate(dragMeasure);
  assert.equal(item.before.expanded, "false");
  assert.ok(targetWidth >= 360 && targetWidth <= 780);
  const p = await evaluate(
    `(()=>{const e=document.querySelector('.browser-panel-resizer'),r=e.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(Math.min(r.bottom-20,Math.max(r.top+20,200)));if(!e.contains(document.elementFromPoint(x,y)))throw Error('Normal pane resizer is obscured');return {x,y}})()`,
  );
  window.show();
  window.focus();
  window.webContents.focus();
  await until(
    async () => window.isFocused() && window.webContents.isFocused(),
    "Owned window focus before native resize",
  );
  const endX = Math.round(item.before.panel.right - targetWidth);
  await evaluate(
    `(()=>{const recording={active:true,frames:[]};window.__widthDrag=recording;const tick=()=>{recording.frames.push(${dragMeasure});if(recording.active)requestAnimationFrame(tick)};requestAnimationFrame(tick)})()`,
  );
  try {
    window.webContents.sendInputEvent({ type: "mouseMove", ...p });
    window.webContents.sendInputEvent({
      type: "mouseDown",
      button: "left",
      clickCount: 1,
      ...p,
    });
    try {
      for (let i = 1; i <= 12; i++) {
        const point = { x: Math.round(p.x + ((endX - p.x) * i) / 12), y: p.y };
        window.webContents.sendInputEvent({
          type: "mouseMove",
          button: "left",
          modifiers: ["leftButtonDown"],
          ...point,
        });
        item.inputs.push({
          ...point,
          time: await evaluate("performance.now()"),
        });
        if (i === 6) await screenshot(`${version}-drag-${label}-moving.png`);
        await pause(16);
      }
    } finally {
      window.webContents.sendInputEvent({
        type: "mouseUp",
        button: "left",
        clickCount: 1,
        x: endX,
        y: p.y,
      });
      item.mouseUpTime = await evaluate("performance.now()");
    }
    await pause(650);
    item.settled = await evaluate(dragMeasure);
    assert.equal(
      item.settled.requestedWidth,
      targetWidth,
      "Actual pointer drag reached requested width",
    );
    assert.equal(
      item.settled.railScrollLeft,
      item.before.railScrollLeft,
      "No Tab rail scrolling during width drag",
    );
    await screenshot(`${version}-drag-${label}-settled.png`);
  } catch (error) {
    item.failure = String(error.stack || error);
    throw error;
  } finally {
    try {
      item.frames = await evaluate(
        "(()=>{window.__widthDrag.active=false;return window.__widthDrag.frames})()",
      );
    } catch (error) {
      item.frameStopError = String(error);
      if (!item.failure) throw error;
    }
  }
}
async function captureNormalPaneDrags() {
  result.widthDrags = [];
  await pause(500);
  const initial = await evaluate(dragMeasure);
  result.dragMotion = {
    default: initial.reducedMotion,
    override: { requested: "no-preference" },
  };
  const width = initial.requestedWidth;
  const outward = width <= 650 ? width + 120 : width - 120;
  await nativeWidthDrag(outward, "default-outward");
  await nativeWidthDrag(width, "default-return");
  await withMotionPreference(
    window.webContents,
    "no-preference",
    async () => {
      const state = await evaluate(dragMeasure);
      assert.equal(
        state.reducedMotion,
        false,
        "Owned renderer media override took effect",
      );
      result.dragMotion.overridden = state;
      await nativeWidthDrag(outward, "no-preference-outward");
      await nativeWidthDrag(width, "no-preference-return");
    },
    result.dragMotion.override,
  );
  const restored = await evaluate(dragMeasure);
  assert.equal(
    restored.reducedMotion,
    initial.reducedMotion,
    "Original motion media restored",
  );
  assert.equal(restored.requestedWidth, width, "Original pane width restored");
  result.dragMotion.restored = restored;
  for (const item of result.widthDrags) assertSynchronizedDrag(item);
}

function assertStableSidebar(before, after) {
  assert.ok(
    before.scroll.gutter > 0,
    "Classic scrollbar space is reserved before the first Thread",
  );
  for (const key of ["clientWidth", "offsetWidth", "gutter"])
    assert.ok(
      Math.abs(before.scroll[key] - after.scroll[key]) <= 1,
      `First Thread preserves sidebar scroll ${key}`,
    );
  for (const key of [
    "sidebar",
    "header",
    "footer",
    "newThreadIcon",
    "viewActions",
    "viewActionIcon",
    "settingsIcon",
  ]) {
    assert.ok(
      before[key] && after[key],
      `Measured ${key} exists in both states`,
    );
    for (const field of ["left", "right", "width"])
      assert.ok(
        Math.abs(before[key][field] - after[key][field]) <= 1,
        `First Thread preserves ${key}.${field}`,
      );
  }
  for (const key of ["newThreadIcon", "viewActionIcon", "settingsIcon"])
    assert.equal(
      before[key].height,
      after[key].height,
      `${key} intrinsic height is unchanged`,
    );
}
function assertSynchronizedDrag(item) {
  assert.ok(item.frames.length > 0, "Real drag frames were sampled");
  for (const frame of item.frames) {
    assert.ok(
      Math.abs(frame.titlebarOverlap) <= 1,
      `${item.label}: titlebar follows actual panel boundary (${frame.titlebarOverlap}px)`,
    );
    assert.ok(
      Math.abs(frame.headerOverlap) <= 1,
      `${item.label}: workspace header follows actual panel boundary (${frame.headerOverlap}px)`,
    );
    assert.equal(
      frame.dividerHits[0].stack[0].className,
      "browser-panel-resizer",
      `${item.label}: title-row divider is not covered by conversation chrome`,
    );
    assert.ok(
      frame.titlebarTransition.duration
        .split(",")
        .every((value) => Number.parseFloat(value) === 0),
      "Following titlebar has no second width tween",
    );
    if (frame.resizing === "true")
      assert.ok(
        !frame.panelTransition.property
          .split(",")
          .some((value) =>
            ["all", "width", "min-width", "flex-basis"].includes(value.trim()),
          ),
        "Only active resize geometry skips the panel tween",
      );
  }
  assert.ok(
    item.frames.some((frame) => frame.resizing === "true"),
    "Actual native pointer capture activated resizing",
  );
  assert.equal(
    item.settled.resizing,
    "false",
    "Pointer release ends resize mode",
  );
}

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
  await until(
    async () =>
      await evaluate(
        "Boolean(document.querySelector('.sidebar-scroll')) && !document.querySelector('.sidebar-scroll > .sidebar-empty[role=status]')",
      ),
    "Initial active Thread list finished loading",
  );
  result.nativeWindow = {
    requestedSize: { width: 1280, height: 820 },
    bounds: window.getBounds(),
    contentBounds: window.getContentBounds(),
  };
  result.sidebarInitial = await evaluate(sidebarMeasure);
  await until(
    async () =>
      await evaluate(
        "Boolean(document.querySelector('#sidebar-room-conversations .room-conversation-empty')) && !document.querySelector('#sidebar-room-conversations .room-conversation-row')",
      ),
    "Empty Room section ready",
  );
  await click(
    'document.querySelector(\'button[aria-controls="sidebar-room-conversations"][aria-expanded="true"]\')',
    "Collapse empty Room section through actual UI",
  );
  await until(
    async () =>
      await evaluate(
        "document.querySelector('button[aria-controls=\"sidebar-room-conversations\"]')?.getAttribute('aria-expanded') === 'false' && document.querySelector('#sidebar-room-conversations')?.hidden === true",
      ),
    "Room section collapse committed",
  );
  await pause(350);
  result.sidebarBeforeThread = await evaluate(sidebarMeasure);
  await screenshot(`${version}-sidebar-empty-room-collapsed.png`);
  const started = await evaluate(
    `window.zenx.protocol.request('thread/start',{cwd:${JSON.stringify(path.join(temporary, "workspace"))}})`,
  );
  assert.ok(started.thread?.id);
  result.steps.push(
    "Real protocol thread/start only; synthetic idle Thread initialized",
  );
  const threadTarget = `document.querySelector(${JSON.stringify(".thread-row-shell[data-thread-id=" + JSON.stringify(started.thread.id) + "] > button.thread-row")})`;
  await until(
    async () =>
      await evaluate(
        `Boolean(${threadTarget}) && !document.querySelector('.sidebar-scroll > .sidebar-empty[role=status]')`,
      ),
    "Created Thread row ready after list load",
  );
  await pause(350);
  result.sidebarAfterThreadBeforeScroll = await evaluate(sidebarMeasure);
  const emptyScroll = result.sidebarBeforeThread.scroll;
  const firstScroll = result.sidebarAfterThreadBeforeScroll.scroll;
  result.sidebarThreshold = {
    crossed:
      emptyScroll.scrollHeight <= emptyScroll.clientHeight &&
      firstScroll.scrollHeight > firstScroll.clientHeight,
    emptySlack: emptyScroll.slack,
    firstSlack: firstScroll.slack,
    gutterDelta: firstScroll.gutter - emptyScroll.gutter,
    status:
      emptyScroll.scrollHeight <= emptyScroll.clientHeight &&
      firstScroll.scrollHeight > firstScroll.clientHeight
        ? "Observed first-Thread overflow threshold crossing; inspect geometry and pixels"
        : "Inconclusive: this native viewport did not cross the first-Thread overflow threshold",
    preparation:
      "Actual empty Room section collapsed before baseline; no CSS, width, or scrollbar override",
  };
  await screenshot(`${version}-sidebar-first-thread-room-collapsed.png`);
  assertStableSidebar(
    result.sidebarBeforeThread,
    result.sidebarAfterThreadBeforeScroll,
  );
  await revealThreadWithSidebarWheel(threadTarget);
  await click(threadTarget, "Select created idle Thread");
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
          "Boolean(document.querySelector('.workspace-content-tab[data-tab-id*=\"zenx-subagents\"]'))",
        ),
      ),
    "Subagents resource tab",
  );
  await until(
    async () =>
      Boolean(
        await evaluate(
          "Boolean(document.querySelector('.auxiliary-plugin[data-plugin-surface=\"zenx-subagents:subagents-panel\"] .subagents-panel'))",
        ),
      ),
    "Actual trusted Subagents body mounted",
  );
  result.steps.push(
    "Verified real bundled Subagents body, not unavailable placeholder",
  );
  await captureNormalPaneDrags();
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
    if (version === "current") assertExpandedTitleSurface(item.settled);
  }
  await click(
    "document.querySelector('.auxiliary-heading > button[aria-pressed=\"true\"]')",
    "Restore pane after expanded acceptance",
  );
  await until(
    async () =>
      await evaluate(
        "document.querySelector('.auxiliary-panel')?.dataset.expanded === 'false'",
      ),
    "Final pane restore committed",
  );
  await pause(350);
  result.restored = await evaluate(measure);
  await screenshot(`${version}-full-app-restored.png`);
  assert.equal(
    result.restored.chrome.find(
      (c) => c.selector === ".window-titlebar-session",
    )?.visibility,
    "visible",
    "Conversation session returns after restore",
  );
  assert.equal(
    result.restored.chrome.find(
      (c) => c.selector === ".window-titlebar-session > .workspace-header",
    )?.visibility,
    "visible",
    "Conversation header returns after restore",
  );
  assert.equal(
    result.restored.nativeSidebarToggle?.hit,
    true,
    "Sidebar control remains usable after restore",
  );
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
