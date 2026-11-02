/** Owns only a disposable CI Electron instance. No remote debugging or sandbox bypass. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, session, ipcMain } = require("electron");
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
  harnessVersion: "native-recent-order-v1-not-performance",
  version,
  platform: process.platform,
  electron: process.versions.electron,
  scope: "Production App, private production DomainThreadJournal history, native input and Send; no model network, no mock ACK or injected UI; Recent ordering and live running state asserted, not latency acceptance.",
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
  console.log("SYNTHETIC_SEND_STAGE "+JSON.stringify({phase:"wait",label,mainMs:performance.now()}));
  for (let i = 0; i < 400; i++) {
    if (await check()) {
      delete result.waitingFor;
      console.log("SYNTHETIC_SEND_STAGE "+JSON.stringify({phase:"ready",label,mainMs:performance.now()}));
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
  console.log("SYNTHETIC_SEND_STAGE "+JSON.stringify({phase:"native-input-dispatched",label,mainMs:performance.now()}));
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

// Instrument only the real protocol handler registration, preserving values/errors.
// Main-process durations are never subtracted from renderer performance.now().
result.ipc = [];
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function (channel, handler) {
  if (channel !== "zenx:protocol:request") return originalHandle(channel, handler);
  return originalHandle(channel, async (event, method, params) => {
    if (method !== "zen/turn/send") return handler(event, method, params);
    const record = {
      clockDomain: "electron-main",
      threadId: params.threadId,
      clientUserMessageId: params.clientUserMessageId,
      requestId: params.clientObservation?.requestId,
      receivedMs: performance.now(),
    };
    result.ipc.push(record);
    try {
      const receipt = await handler(event, method, params);
      record.finishedMs = performance.now();
      record.durationMs = record.finishedMs - record.receivedMs;
      record.receipt = structuredClone(receipt);
      console.log("SYNTHETIC_SEND_IPC_RECEIPT "+JSON.stringify(record));
      return receipt;
    } catch (error) {
      record.finishedMs = performance.now();
      record.durationMs = record.finishedMs - record.receivedMs;
      record.error = String(error);
      throw error;
    }
  });
};

async function screenshot(name) {
  await fs.writeFile(path.join(directory, name), (await window.webContents.capturePage()).toPNG());
}


const rowExpression = (id) =>
  'document.querySelector('+JSON.stringify('.recent-thread-group [data-thread-id="'+id+'"] > button.thread-row')+')';
async function recentState() {
  return await evaluate(`(async()=>{
    const summaries=await window.zenx.threads.list({archived:false});
    return {
      ids:[...document.querySelectorAll('.recent-thread-group .thread-row-shell')].map(e=>e.dataset.threadId),
      summaries:summaries.map(({threadId,recentActivityAt,updatedAt,status})=>({threadId,recentActivityAt,updatedAt,status})),
      running:[...document.querySelectorAll('.recent-thread-group .thread-row-shell')].filter(e=>e.querySelector('.thread-running-spinner')).map(e=>e.dataset.threadId),
      selected:document.querySelector('.recent-thread-group .thread-row[aria-current="page"]')?.closest('.thread-row-shell')?.dataset.threadId
    };
  })()`);
}
async function expectOrder(ids, label) {
  await until(async()=>JSON.stringify((await recentState()).ids)===JSON.stringify(ids),label);
  const state=await recentState();
  result.orderChecks.push({label,...state});
  return state;
}
async function nativeSend(id,text) {
  await revealThreadWithSidebarWheel(rowExpression(id));
  await click(rowExpression(id),"Select "+id+" in Recent");
  await until(async()=>await evaluate("Boolean("+rowExpression(id)+"?.getAttribute('aria-current')==='page' && document.querySelector('#thread-composer:not(:disabled)'))"),"Exact Thread selected and composer available");
  await click("document.querySelector('#thread-composer')","Focus native composer for "+id);
  await until(async()=>await evaluate("document.activeElement===document.querySelector('#thread-composer')"),"Composer focused");
  await window.webContents.insertText(text);
  await until(async()=>await evaluate("document.querySelector('#thread-composer').value==="+JSON.stringify(text)),"Native draft committed");
  await click("document.querySelector('.composer-send-control > button.action-orb.send:not(:disabled)')","Send "+id);
  await until(async()=>result.ipc.some(entry=>entry.threadId===id && entry.receipt?.turnId && !entry.error),"Actual send receipt for "+id);
  return result.ipc.find(entry=>entry.threadId===id && entry.receipt?.turnId);
}
async function acceptedTurn(receipt) {
  return await evaluate("window.__recentEvents.some(event=>event.threadId==="+JSON.stringify(receipt.threadId)+" && event.turnId==="+JSON.stringify(receipt.receipt.turnId)+" && event.type==='turn_completed' && event.status==='completed')");
}

async function run() {
  await networkReady;
  await until(async () => {
    window = BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith("/renderer/index.html"));
    return Boolean(window);
  }, "production renderer");
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox,true);
  assert.equal(preferences.contextIsolation,true);
  assert.equal(preferences.nodeIntegration,false);
  result.runtimePreferences = {sandbox:preferences.sandbox,contextIsolation:preferences.contextIsolation,nodeIntegration:preferences.nodeIntegration};
  window.setSize(1280,820); window.show(); window.focus();
  result.nativeWindow = {bounds:window.getBounds(),contentBounds:window.getContentBounds()};
  await until(async()=>await evaluate("Boolean(document.querySelector('.app-shell') && window.zenx?.protocol)"),"App mounted");
  await until(async()=>await evaluate("window.zenx.protocol.getStatus().then(s=>s.type==='ready')"),"fake Host ready");
  const settings = await evaluate("window.zenx.settings.get()");
  assert.equal(settings.profile.defaultModel.providerProfileId,"fake");
  assert.equal(settings.profile.defaultModel.modelId,"fake");
  const configuredProvider=settings.profile.providerProfiles.find(p=>p.providerProfileId==="fake");
  assert.equal(configuredProvider.type,"fake");
  assert.equal(configuredProvider.models.find(m=>m.id==="fake").contextWindow,100000000);
  assert.equal(settings.hasApiKey,false);
  assert.equal(settings.subscription.authenticated,false);
  result.fixtureModel={provider:"fake",modelId:"fake",contextWindow:100000000};

  result.orderChecks=[];
  await evaluate("(()=>{window.__recentEvents=[];window.__stopRecent=window.zenx.protocol.onNotification((method,params)=>{if(method!=='zen/thread/event')return;const item=params.event?.item;if(params.event?.type==='item_completed'&&item)window.__recentEvents.push({threadId:params.threadId,turnId:item.turnId,type:item.type,status:item.status,id:item.id,clientId:item.clientId,createdAt:item.createdAt});});})()");
  result.seed=JSON.parse(await fs.readFile(path.join(temporary,"seed-manifest.json"),"utf8"));
  assert.deepEqual(result.seed.threadIds,["recent-a","recent-b","recent-c"]);
  await expectOrder(["recent-c","recent-b","recent-a"],"Original receipt/final order beats newer non-message instruction");
  await revealThreadWithSidebarWheel(rowExpression("recent-a"));
  result.dynamicCoverage = "The tool call precedes B; the 1.8-second stable interval has no guaranteed intermediate canonical event. This run proves live running state and receipt/final ordering, not isolated post-B tool-result suppression. Type-specific suppression is covered by Core tests.";
  await screenshot("recent-01-cold-original-message-order.png");
  // All writes below are ordinary native UI input to the disposable product.
  const receiptA=await nativeSend("recent-a",'!shell node -e "setTimeout(() => process.stdout.write(\'Synthetic Recent tool finished\'), 12000)"');
  await until(async()=>await evaluate("window.__recentEvents.some(event=>event.threadId==='recent-a' && event.turnId==="+JSON.stringify(receiptA.receipt.turnId)+" && event.type==='tool_call')"),"Exact A receipt Turn commits a real tool call");
  await until(async()=> (await recentState()).running.includes("recent-a"),"A real tool Turn is running");
  await expectOrder(["recent-a","recent-c","recent-b"],"A original user arrival bumps once");
  const beforeB=await recentState();
  const aReceipt=beforeB.summaries.find(s=>s.threadId==="recent-a").recentActivityAt;
  assert(aReceipt);
  const receiptB=await nativeSend("recent-b","Synthetic recent B final answer");
  await until(async()=> await acceptedTurn(receiptB),"Exact B receipt Turn is canonically completed");
  await expectOrder(["recent-b","recent-a","recent-c"],"Newer B final precedes running A");
  let observed=0;
  const untilMs=performance.now()+1800;
  while(performance.now()<untilMs) {
    const state=await recentState();
    assert.deepEqual(state.ids,["recent-b","recent-a","recent-c"]);
    assert(state.running.includes("recent-a"),"A retains live running indicator");
    assert.equal(state.summaries.find(s=>s.threadId==="recent-a").recentActivityAt,aReceipt);
    observed++;
    await pause(150);
  }
  result.backgroundStableObservations=observed;
  await screenshot("recent-02-background-tool-does-not-reorder.png");
  await until(async()=> await acceptedTurn(receiptA),"Exact A receipt Turn is canonically completed");
  const final=await expectOrder(["recent-a","recent-b","recent-c"],"A accepted final bumps once at complete message");
  assert(Date.parse(final.summaries.find(s=>s.threadId==="recent-a").recentActivityAt)>Date.parse(aReceipt));
  assert.equal(final.selected,"recent-b","Background final never changes the selected Thread");
  await screenshot("recent-03-final-bumps-without-stealing-selection.png");
  result.canonicalEvents=await evaluate("(()=>{window.__stopRecent();return window.__recentEvents})()");
  window.webContents.reload();
  await until(async()=>await evaluate("Boolean(document.querySelector('.app-shell') && window.zenx?.protocol)"),"Reloaded actual App");
  await expectOrder(["recent-a","recent-b","recent-c"],"Reload preserves canonical recent order");
  await screenshot("recent-04-reload-preserves-order.png");
  assert.equal(result.ipc.length,2,"Two native sends, no protocol mutation injection");
  result.ok=true;
}
void import(pathToFileURL(path.join(__dirname,"../out/main/index.js")).href)
  .then(run).catch(async error=>{
    result.error=String(error.stack||error);
    if(window&&!window.isDestroyed())try{result.inputFailureState=await evaluate("(()=>{const e=document.querySelector('#thread-composer'),a=document.activeElement;return {activeTag:a?.tagName,activeId:a?.id,activeClass:typeof a?.className==='string'?a.className:null,composerExists:Boolean(e),composerDisabled:e?.disabled,composerValue:e?.value,hasComposerFocus:a===e}})()");}catch{}
    console.error("SYNTHETIC_SEND_CAPTURE_ERROR "+JSON.stringify({error:result.error,waitingFor:result.waitingFor,pendingOperation:result.pendingOperation}));
    if(window&&!window.isDestroyed())try{await screenshot("recent-order-failure.png")}catch{}
  }).finally(async()=>{
    await fs.writeFile(path.join(directory,"full-app-measurements.json"),JSON.stringify(result,null,2));
    process.exitCode=result.ok?0:1;
    app.quit();
  });
