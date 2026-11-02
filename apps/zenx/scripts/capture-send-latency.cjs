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
  version,
  platform: process.platform,
  electron: process.versions.electron,
  scope: "Production App, private production DomainThreadJournal history, native input and Send; no model network, no mock ACK or optimistic bubble.",
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

// Passive renderer observer. It never changes App state, UI, requests, or receipts.
function installObservation(nonce) {
  const record = {clockDomain:"renderer", nonce, frames:[], notifications:[]};
  window.__sendLatency = record;
  let stopped = false, frameId;
  const editor = () => document.querySelector("#thread-composer");
  const value = () => {
    const e = editor();
    return e instanceof HTMLTextAreaElement ? e.value : e?.textContent ?? null;
  };
  const capture = (event) => {
    const button = event.target?.closest?.(".composer-send-control > button.action-orb");
    if (!button || record.clickMs !== undefined) return;
    record.clickMs = performance.now();
    record.trusted = event.isTrusted;
    record.disabledAtClick = button.disabled;
    record.draftAtClick = value();
  };
  document.addEventListener("click", capture, true);
  const findBubble = (root) => {
    if (!(root instanceof Element)) return;
    const rows = root.closest("article.user-row[data-sent-message-id]")
      ? [root.closest("article.user-row[data-sent-message-id]")] : root.matches("article.user-row[data-sent-message-id]")
      ? [root] : [...root.querySelectorAll("article.user-row[data-sent-message-id]")];
    for (const row of rows) {
      const bubble = row.querySelector(".user-bubble");
      if (bubble?.textContent?.trim() === nonce && record.bubbleDomMs === undefined) {
        record.bubbleDomMs = performance.now();
        record.messageId = row.dataset.sentMessageId;
        record.bubble = bubble;
      }
    }
  };
  const mutation = new MutationObserver((records) => {
    if (record.clickMs === undefined || record.bubbleDomMs !== undefined) return;
    for (const entry of records) {
      for (const node of entry.addedNodes) findBubble(node);
      if (entry.type === "characterData") findBubble(entry.target.parentElement?.closest("article.user-row") ?? null);
    }
  });
  mutation.observe(document.querySelector(".thread-view") ?? document.body, {subtree:true,childList:true,characterData:true});
  const off = window.zenx.protocol.onNotification((method, params) => {
    if (record.clickMs === undefined || method !== "zen/thread/event") return;
    const event = params.event;
    if (record.notifications.length >= 2000) return;
    record.notifications.push({
      atMs:performance.now(), type:event?.type,
      itemType:event?.item?.type, itemId:event?.item?.id,
      clientId:event?.item?.clientId, threadId:params.threadId,
      watermark:params.watermark,
    });
  });
  const frame = () => {
    if (stopped) return;
    const now = performance.now();
    if (record.clickMs !== undefined) {
      if (record.inputClearFrameMs === undefined && value() === "") record.inputClearFrameMs = now;
      if (record.bubble && record.bubbleVisibleFrameMs === undefined) {
        const r = record.bubble.getBoundingClientRect();
        const style = getComputedStyle(record.bubble);
        const viewport = record.bubble.closest(".messages")?.getBoundingClientRect() ?? {top:0,bottom:innerHeight,left:0,right:innerWidth};
        if (record.bubble.isConnected && r.width > 0 && r.height > 0 && r.bottom > Math.max(0,viewport.top) && r.top < Math.min(innerHeight,viewport.bottom) && r.right > Math.max(0,viewport.left) && r.left < Math.min(innerWidth,viewport.right) && style.visibility !== "hidden" && style.display !== "none") {
          record.bubbleVisibleFrameMs = now;
          record.bubbleBounds = {left:r.left,top:r.top,width:r.width,height:r.height};
          requestAnimationFrame(() => {record.followingFrameMs = performance.now();});
        }
      }
      if (record.frames.length < 1200) record.frames.push(now);
    }
    frameId = requestAnimationFrame(frame);
  };
  frameId = requestAnimationFrame(frame);
  record.stop = () => {
    stopped = true; cancelAnimationFrame(frameId); mutation.disconnect(); off();
    document.removeEventListener("click",capture,true);
    const {bubble,stop,...plain} = record;
    return plain;
  };
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
  const manifest = JSON.parse(await fs.readFile(path.join(temporary,"seed-manifest.json"),"utf8"));
  assert.ok(manifest.threadId && Number.isInteger(manifest.visibleMessageCount));
  result.seed = manifest;
  const threadId = manifest.threadId;
  await evaluate("(()=>{window.__baselineEvents=[];window.__stopBaseline=window.zenx.protocol.onNotification((method,params)=>{if(method==='zen/thread/event'&&params.threadId==="+JSON.stringify(threadId)+"){window.__baselineEvents.push({type:params.event?.type,itemType:params.event?.item?.type});}})})()");
  const threadTarget = 'document.querySelector('+JSON.stringify(".thread-row-shell[data-thread-id="+JSON.stringify(threadId)+"] > button.thread-row")+')';
  await until(async()=>await evaluate("Boolean("+threadTarget+")"),"seeded production Thread in sidebar");
  await revealThreadWithSidebarWheel(threadTarget);
  await click(threadTarget,"Select seeded production Thread");
  await until(async()=>await evaluate("Boolean(document.querySelector('#thread-composer:not(:disabled)'))"),"idle Thread composer");
  const before = await evaluate("window.zenx.protocol.request('thread/read',{threadId:"+JSON.stringify(threadId)+",includeTurns:true})");
  const beforeMessages = before.thread.turns.flatMap(t=>t.items).filter(i=>i.type==="userMessage"||i.type==="agentMessage");
  assert.equal(beforeMessages.length,manifest.visibleMessageCount,"Production Host projects every seeded message");
  assert.ok(before.thread.turns.every(t=>t.status!=="inProgress"),"No active Turn before ordinary send");
  result.before = {turns:before.thread.turns.length,messages:beforeMessages.length,baselineKind:"existing selected idle Thread; initial production thread/read verified and warmed before timing",rendered:await evaluate("({userRows:document.querySelectorAll('article.user-row').length,assistantRows:document.querySelectorAll('article.agent-copy').length,turnBlocks:document.querySelectorAll('.turn-block').length})")};
  await pause(500);
  result.samples=[];
  assert.equal(await evaluate("document.querySelector('#thread-composer') instanceof HTMLTextAreaElement"),true,"Baseline is native plain-text composer");
  result.frameMeaning="DOM visibility at a requestAnimationFrame opportunity, not proof of physical screen scanout; synthetic whole-window screenshots included";
  for(let repetition=0;repetition<3;repetition++) {
    const nonce = "Synthetic latency message "+manifest.visibleMessageCount+" "+repetition+" "+require("node:crypto").randomUUID();
    await click("document.querySelector('#thread-composer:not(:disabled)')","Focus actual composer");
    await window.webContents.insertText(nonce);
    await until(async()=>await evaluate("document.querySelector('#thread-composer')?.value === "+JSON.stringify(nonce)),"native text input committed");
    await until(async()=>await evaluate("Boolean(document.querySelector('.composer-send-control > button.action-orb.send:not(:disabled)'))"),"actual Send enabled");
    await evaluate("("+installObservation.toString()+")("+JSON.stringify(nonce)+")");
    await screenshot("messages-"+manifest.visibleMessageCount+"-sample-"+repetition+"-before.png");
    const ipcStart=result.ipc.length;
    await click("document.querySelector('.composer-send-control > button.action-orb.send:not(:disabled)')","Native Send ordinary text");
    try {
      await until(async()=>await evaluate("window.__sendLatency?.followingFrameMs !== undefined && window.__sendLatency?.inputClearFrameMs !== undefined"),"real visible bubble and cleared composer");
      await until(async()=>result.ipc.slice(ipcStart).some(r=>r.finishedMs!==undefined),"real protocol receipt");
      await until(async()=>await evaluate("window.__sendLatency.notifications.some(n=>n.type==='turn_completed' || n.itemType==='turn_completed')"),"real fake Turn terminal notification");
      const sample=await evaluate("window.__sendLatency.stop()");
      result.samples.push(sample);
      assert.equal(sample.trusted,true);
      assert.equal(sample.disabledAtClick,false);
      assert.equal(sample.draftAtClick,nonce);
      sample.clickToBubbleDomMs=sample.bubbleDomMs-sample.clickMs;
      sample.clickToVisibleFrameMs=sample.bubbleVisibleFrameMs-sample.clickMs;
      sample.clickToClearFrameMs=sample.inputClearFrameMs-sample.clickMs;
      sample.ipc=result.ipc.slice(ipcStart);
      assert.equal(sample.ipc.length,1,"One native click produces exactly one send request");
      assert.ok(sample.ipc[0].receipt?.turnId,"Real send returns admitted Turn");
      assert.equal(sample.ipc[0].error,undefined);
      assert.equal(sample.ipc[0].threadId,threadId);
      assert.ok(sample.ipc[0].requestId);
      await screenshot("messages-"+manifest.visibleMessageCount+"-sample-"+repetition+"-after.png");
      const after=await evaluate("window.zenx.protocol.request('thread/read',{threadId:"+JSON.stringify(threadId)+",includeTurns:true})");
      const matches=after.thread.turns.flatMap(t=>t.items).filter(i=>i.type==="userMessage" && i.content.some(p=>p.type==="text"&&p.text===nonce));
      assert.equal(matches.length,1,"Exactly one real durable canonical user message");
      assert.equal(matches[0].id,sample.messageId,"Visible bubble matches durable message");
      assert.equal(matches[0].clientId,sample.ipc[0].clientUserMessageId);
      assert.ok(sample.notifications.some(n=>n.itemId===sample.messageId && n.itemType==="user_message"),"Canonical native item event observed");
      assert.ok(!sample.notifications.some(n=>String(n.type).includes("compact")||String(n.itemType).includes("compact")),"Ordinary baseline must not compact");
      sample.durableVerification={itemId:matches[0].id,clientId:matches[0].clientId,turnId:sample.ipc[0].receipt.turnId};
    } catch(error) {
      result.failedSample=await evaluate("window.__sendLatency.stop()");
      throw error;
    }
    await pause(300);
  }
  result.baselineEvents=await evaluate("(()=>{window.__stopBaseline();return window.__baselineEvents})()");
  assert.ok(!result.baselineEvents.some(n=>String(n.type).includes("compact")||String(n.itemType).includes("compact")),"No compaction anywhere in observed baseline lifecycle");
  result.ok=true;
}
void import(pathToFileURL(path.join(__dirname,"../out/main/index.js")).href)
  .then(run).catch(async error=>{
    result.error=String(error.stack||error);
    if(window&&!window.isDestroyed())try{await screenshot("send-latency-failure.png")}catch{}
  }).finally(async()=>{
    await fs.writeFile(path.join(directory,"full-app-measurements.json"),JSON.stringify(result,null,2));
    process.exitCode=result.ok?0:1;
    app.quit();
  });
