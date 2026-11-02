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
  harnessVersion: "native-steer-recall-v1-not-performance",
  version,
  platform: process.platform,
  electron: process.versions.electron,
  scope: "Production App, private production DomainThreadJournal history, native input and Send; no model network, no mock ACK or injected UI; actual product pending and canonical feedback measured separately.",
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


const crypto=require("node:crypto"),childProcess=require("node:child_process");
const {syncBuiltinESMExports}=require("node:module");
const controlNonce=crypto.randomUUID(),waiters=new Map();
let ownedBackend,notificationGate=false,heldNotifications=[],recallReplyGate;
result.ipc=[];result.hostEvents=[];result.resumeRequests=[];result.recoveryReads=[];
let recallCommitted=false;
const originalFork=childProcess.fork;
childProcess.fork=function(modulePath,args,options){
 const owned=String(modulePath).replaceAll("\\","/").endsWith("/app-server-host.js");
 const child=Reflect.apply(originalFork,this,[modulePath,args,owned?{...options,env:{...(options?.env??process.env),ZENX_SYNTHETIC_STEER_GATE:"1",ZENX_SYNTHETIC_STEER_GATE_NONCE:controlNonce}}:options]);
 if(owned){assert.equal(ownedBackend,undefined);ownedBackend=child;child.on("message",m=>{if(m?.type!=="zenx-synthetic-steer-gate-result")return;const w=waiters.get(m.id);if(!w)return;waiters.delete(m.id);clearTimeout(w.timer);m.ok?w.resolve(m.result):w.reject(Error(m.error));});}
 return child;
};
syncBuiltinESMExports();
async function control(operation,extra={}){
 assert(ownedBackend?.connected);
 const id=crypto.randomUUID();
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiters.delete(id);reject(Error("Synthetic gate control timeout "+operation));},20000);waiters.set(id,{resolve,reject,timer});ownedBackend.send({type:"zenx-synthetic-steer-gate",nonce:controlNonce,id,operation,...extra},e=>{if(e){clearTimeout(timer);waiters.delete(id);reject(e);}});});
}
function releaseNotifications(){notificationGate=false;for(const send of heldNotifications)send();heldNotifications=[];}
const originalHandle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=function(channel,handler){
 if(channel!=="zenx:protocol:request")return originalHandle(channel,handler);
 return originalHandle(channel,async(event,method,params)=>{
  if(["zen/thread/resume","thread/resume"].includes(method))result.resumeRequests.push({method,threadId:params?.threadId});

  if(result.caseId==="lost-reply"&&recallCommitted&&method==="zen/thread/read"&&params?.threadId===result.threadId){
   const recovery={method,threadId:params.threadId,replyDropped:result.recoveryReads.length===0};result.recoveryReads.push(recovery);
   const actual=await handler(event,method,params);
   recovery.realReadCompleted=true;
   if(recovery.replyDropped)throw Error("SYNTHETIC transport reply unavailable");
   recovery.replyDelivered=true;return actual;
  }
  if(!["zen/turn/send","zen/thread/steer/recall"].includes(method))return handler(event,method,params);
  const record={method,params:structuredClone(params)};result.ipc.push(record);
  try{const receipt=await handler(event,method,params);record.realHandlerReceipt=structuredClone(receipt);if(method==="zen/thread/steer/recall"&&result.caseId==="lost-reply"){recallCommitted=true;throw Error("SYNTHETIC transport reply unavailable");}if(method==="zen/thread/steer/recall"&&recallReplyGate)await recallReplyGate.wait;record.receipt=structuredClone(receipt);return receipt;}
  catch(error){record.error=String(error);throw error;}
 });
};
async function screenshot(name){await fs.writeFile(path.join(directory,name),(await window.webContents.capturePage()).toPNG());}
async function typeNative(text){
 await click("document.querySelector('#thread-composer:not(:disabled)')","Native composer focus");
 await until(async()=>await evaluate("document.activeElement===document.querySelector('#thread-composer')"),"actual textarea focus");
 await window.webContents.insertText(text);
 await until(async()=>await evaluate("document.querySelector('#thread-composer')?.value==="+JSON.stringify(text)),"native draft committed");
}
async function sendNative(text,mode){
 await typeNative(text);const index=result.ipc.length;
 const selector=mode==="steer"?".composer-actions .action-orb.steer:not(:disabled)":".composer-send-control > button.action-orb.send:not(:disabled)";
 await click("document.querySelector("+JSON.stringify(selector)+")","Actual native "+mode);
 await until(async()=>result.ipc.length===index+1&&Boolean(result.ipc[index].receipt),"actual send receipt");
 const record=result.ipc[index];assert.equal(record.method,"zen/turn/send");assert.equal(record.params.threadId,result.threadId);
 assert.equal(record.params.mode,undefined,"Production soft-send omits mode: idle starts, active Turn stages steer");
 await until(async()=>await evaluate("document.querySelector('#thread-composer')?.value===''"),"native send clears draft");
 return record;
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
  result.before = {turns:before.thread.turns.length,messages:beforeMessages.length,baselineKind:"existing selected idle Thread; initial production thread/read verified and warmed before timing",rendered:await evaluate("({userRows:document.querySelectorAll('article.user-row').length,assistantRows:document.querySelectorAll('article.agent-copy').length,turnBlocks:document.querySelectorAll('section.turn').length})")};

  assert.equal(manifest.userMessageCount,0);
  assert.equal(await evaluate("document.querySelector('#thread-composer') instanceof HTMLTextAreaElement"),true);
  result.threadId=threadId;result.caseId=process.env.SYNTHETIC_RECALL_CASE;
  assert(["recall-wins","claim-wins","navigation","lost-reply"].includes(result.caseId));
  const originalSend=window.webContents.send.bind(window.webContents);
  window.webContents.send=function(channel,...args){
   if(channel==="zenx:protocol:notification"&&args[0]==="zen/thread/event"&&args[1]?.threadId===threadId){
    assert(result.hostEvents.length<2000,"bounded real native events");
    result.hostEvents.push(structuredClone(args[1]));
    if(notificationGate){heldNotifications.push(()=>originalSend(channel,...args));return;}
   }
   return originalSend(channel,...args);
  };
  const nonces=["Synthetic initial ","Synthetic steer one ","Synthetic steer two "].map(s=>s+crypto.randomUUID());
  result.nonces=nonces;
  let newerDraft="Synthetic current unsent draft "+crypto.randomUUID();result.newerDraft=newerDraft;
  await control("arm",{caseId:result.caseId,threadId,nonces,gateOrdinals:[1,2]});
  const initial=await sendNative(nonces[0],"start");
  result.turnId=initial.receipt.turnId;assert.equal(typeof result.turnId,"string");
  await until(async()=>{const s=await control("status");return s.requests.length===1&&s.heldOrdinals.includes(1);},"actual first provider request held");
  const sends=[initial];
  for(let index=1;index<=2;index++){
   const record=await sendNative(nonces[index],"steer");sends.push(record);
   await until(async()=>result.hostEvents.some(n=>n.event?.type==="item_completed"&&n.event.item?.type==="user_message_queued"&&n.event.item.clientId===record.params.clientUserMessageId),"actual durable staged steer fact");
   const facts=result.hostEvents.filter(n=>n.event?.item?.type==="user_message_queued"&&n.event.item.clientId===record.params.clientUserMessageId).map(n=>n.event.item);
   assert.equal(facts.length,1);assert.equal(facts[0].deliveryMode,"steer");assert.equal(facts[0].expectedTurnId,result.turnId);
  }
  result.sends=sends;
  await until(async()=>await evaluate("Boolean(document.querySelector('.pending-steer-heading button:not(:disabled)'))"),"actual whole-batch recall enabled");
  await typeNative(newerDraft);
  await screenshot(result.caseId+"-two-pending-newer-draft.png");
  if(result.caseId==="claim-wins"){
   notificationGate=true;
   await control("release",{ordinal:1});
   await until(async()=>{const s=await control("status");return s.requests.length===2&&s.heldOrdinals.includes(2);},"actual model request after native staged claim");
   result.claimedProvider=await control("status");
   assert.deepEqual(result.claimedProvider.requests[1].noncePresent,[true,true,true]);
   for(const record of sends.slice(1))assert(result.hostEvents.some(n=>n.event?.item?.type==="user_message"&&n.event.item.clientId===record.params.clientUserMessageId),"actual claim before stale UI recall");
  }
  if(result.caseId==="lost-reply")notificationGate=true;
  if(result.caseId==="navigation"){notificationGate=true;let release;const wait=new Promise(done=>{release=done});recallReplyGate={wait,release};}
  const recallIndex=result.ipc.length;
  await click("document.querySelector('.pending-steer-heading button:not(:disabled)')","Actual whole-batch Recall");

  if(result.caseId==="navigation"){
   await until(async()=>Boolean(result.ipc[recallIndex]?.realHandlerReceipt?.receipt),"real recall committed while reply and notifications held");
   await click("document.querySelector('.new-thread-action:not(:disabled)')","Native navigate to different draft before recall reply");
   await until(async()=>await evaluate("Boolean(document.querySelector('.new-thread-composer-context'))"),"actual new-thread draft surface");
   result.navigationDraft="Synthetic other thread draft "+crypto.randomUUID();
   await typeNative(result.navigationDraft);
   result.navigationResumeBaseline=result.resumeRequests.filter(r=>r.threadId===threadId).length;
   recallReplyGate.release();releaseNotifications();
  }
  await until(async()=>result.ipc.length===recallIndex+1&&Boolean(result.ipc[recallIndex].receipt||result.ipc[recallIndex].error),"actual native whole-batch recall reply or generic transport failure");
  if(result.caseId==="navigation"){
   await pause(200);
   assert.equal(await evaluate("Boolean(document.querySelector('.new-thread-composer-context'))"),true,"late recall does not navigate");
   assert.equal(await evaluate("document.querySelector('#thread-composer')?.value"),result.navigationDraft,"late recall cannot overwrite another draft");
   assert.equal(result.resumeRequests.filter(r=>r.threadId===threadId).length,result.navigationResumeBaseline,"late recall ACK must not request original Thread resume");
   await screenshot("navigation-other-draft-preserved.png");
   await revealThreadWithSidebarWheel(threadTarget);
   await click(threadTarget,"Native return to original recalled Thread");
   await until(async()=>await evaluate("Boolean(document.querySelector('.steer-recovery button:not(:disabled)'))"),"actual durable recall recovery available");
   assert.equal(await evaluate("document.querySelector('#thread-composer')?.value"),newerDraft,"return does not silently restore recalled messages");
   await click("document.querySelector('.steer-recovery button:not(:disabled)')","Native explicit recall recovery request");
   await until(async()=>await evaluate("document.querySelectorAll('.steer-recovery button').length===2"),"actual recovery confirmation");
   await click("document.querySelector('.steer-recovery button:not(:disabled)')","Native confirm whole recalled batch merge");
  }

  const recall=result.ipc[recallIndex];result.recall=recall;
  const recallOutcome=recall.realHandlerReceipt??recall.receipt;
  if(result.caseId==="lost-reply"){
   assert.equal(recall.receipt,undefined,"durable success reply was NOT delivered");
   assert.match(recall.error,/SYNTHETIC transport reply unavailable/);
   await until(async()=>await evaluate("Array.from(document.querySelectorAll('.pending-steer-panel [role=status]')).some(e=>{const r=e.getBoundingClientRect();return /Recall outcome is unconfirmed|撤回结果尚未确认/.test(e.textContent??'')&&r.width>0&&r.height>0&&r.top<innerHeight&&r.bottom>0})"),"honest unknown after lost recall and automatic read replies");
   assert.equal(result.recoveryReads.length,1);
   assert.equal(result.recoveryReads[0].realReadCompleted,true);
   assert.equal(result.recoveryReads[0].replyDropped,true);
   assert.equal(await evaluate("document.querySelector('#thread-composer')?.value"),newerDraft,"unknown does not restore by itself");
   assert.equal(result.ipc.filter(r=>r.method==="zen/thread/steer/recall").length,1,"unknown never retries mutation");
   assert.equal(result.ipc.filter(r=>r.method==="zen/turn/send").length,3,"unknown never resends");
   await screenshot("lost-recall-reply-unknown.png");
   const suffix=" More current draft "+crypto.randomUUID();
   await click("document.querySelector('#thread-composer:not(:disabled)')","Native edit latest draft while recall unknown");
   await until(async()=>await evaluate("document.activeElement===document.querySelector('#thread-composer')"),"actual unknown-state draft focus");
   window.webContents.selectAll();
   await until(async()=>await evaluate("(()=>{const e=document.querySelector('#thread-composer');return document.activeElement===e&&e.selectionStart===0&&e.selectionEnd===e.value.length})()"),"actual native selection spans current draft");
   await window.webContents.insertText(newerDraft+suffix);
   newerDraft+=suffix;result.newerDraft=newerDraft;
   await until(async()=>await evaluate("document.querySelector('#thread-composer')?.value==="+JSON.stringify(newerDraft)),"latest draft stays editable while recall unknown");
   await click("document.querySelector('.pending-steer-panel > button:not(:disabled)')","Native read-only recall receipt Check");
   await until(async()=>result.recoveryReads.length===2&&result.recoveryReads[1].replyDelivered===true,"actual second read-only receipt response");
   await until(async()=>await evaluate("document.querySelector('#thread-composer')?.value==="+JSON.stringify(nonces[1]+"\n\n"+nonces[2]+"\n\n"+newerDraft)),"read-only recovery merges once with latest draft");
   assert.equal(result.ipc.filter(r=>r.method==="zen/thread/steer/recall").length,1,"check is not another recall mutation");

   assert.equal(await evaluate("Array.from(document.querySelectorAll('.pending-steer-panel [role=status]')).some(e=>/Recall outcome is unconfirmed|撤回结果尚未确认/.test(e.textContent??''))"),false,"authoritative read-only success must clear stale unknown warning");
   assert.equal(notificationGate,true,"real target notifications remain held during read-only recovery assertions");
   assert(heldNotifications.length>0);
   assert(result.hostEvents.some(n=>n.event?.item?.type==="user_message_steer_recalled"&&n.event.item.recallId===recall.params.recallId),"actual durable recall event is among captured Host events");
   const actionable=await evaluate("(()=>{const ids="+JSON.stringify(recall.params.targets.map(t=>t.queuedItemId))+";return {recallButton:Boolean(document.querySelector('.pending-steer-heading button:not(:disabled)')),legacyRows:Array.from(document.querySelectorAll('[data-queue-id]')).filter(row=>ids.includes(row.dataset.queueId)&&row.querySelector('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[role=button]')).length}})()");
   assert.equal(actionable.recallButton,false,"known recalled batch cannot be recalled again before event delivery");
   assert.equal(actionable.legacyRows,0,"known withdrawn entries must not remain actionable legacy queue rows");
   result.lostReplyRecoveryCheckpoint={notificationsStillHeld:true,heldCount:heldNotifications.length,actionable,mergedExactlyOnce:true};
   releaseNotifications();
   await pause(200);
   assert.equal(await evaluate("document.querySelector('#thread-composer')?.value"),nonces[1]+"\n\n"+nonces[2]+"\n\n"+newerDraft,"later real recall notification cannot duplicate restored text");
   await screenshot("lost-recall-reply-readonly-recovered.png");
  }

  assert.equal(recall.method,"zen/thread/steer/recall");
  assert.equal(recall.params.threadId,threadId);assert.equal(recall.params.targets.length,2);
  assert.deepEqual(recall.params.targets.map(t=>t.clientId),sends.slice(1).map(s=>s.params.clientUserMessageId));
  if(result.caseId!=="claim-wins"){
   assert.equal(recallOutcome.receipt?.type,"user_message_steer_recalled");
   await until(async()=>await evaluate("document.querySelector('#thread-composer')?.value==="+JSON.stringify(nonces[1]+"\n\n"+nonces[2]+"\n\n"+newerDraft)),"whole ordered batch restored before newer draft");
   assert.equal(await evaluate("document.querySelector('.pending-steer-heading')===null"),true,"withdrawn shelf removed");
   assert.equal(await evaluate("document.querySelectorAll('[data-queue-id]').length"),0,"withdrawn legacy queue rows removed");
   await screenshot("recall-wins-restored-current-draft.png");
   await control("release",{ordinal:1});
  }else{
   assert.equal(recall.receipt.type,"zenx.queue-edit-rejection.v1");
   assert.equal(recall.receipt.data?.zenCode,"steer_recall_conflict");
   await until(async()=>await evaluate("Array.from(document.querySelectorAll('.pending-steer-panel [role=status]')).some(e=>{const r=e.getBoundingClientRect();return /did not partially remove the batch|没有部分撤回/.test(e.textContent??'')&&r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight})"),"actual renderer-visible whole-batch conflict");
   assert.equal(await evaluate("document.querySelector('#thread-composer')?.value"),newerDraft,"conflict does not restore or replace current draft");
   await screenshot("claim-wins-real-conflict-stale-ui.png");
   releaseNotifications();
   await control("release",{ordinal:2});
  }
  await until(async()=>result.hostEvents.some(n=>n.event?.type==="turn_completed"&&n.event.turnId===result.turnId&&n.event.status==="completed"),"exact actual native Turn completes normally");
  const finalProvider=await control("status");result.provider=finalProvider;
  assert(finalProvider.requests.every(r=>r.finished&&!r.aborted));
  assert.deepEqual(finalProvider.requests[0].noncePresent,[true,false,false]);
  assert(finalProvider.requests.every(r=>r.threadId===threadId&&r.turnId===result.turnId),"every actual model request belongs to exact selected Thread and Turn");
  if(result.caseId!=="claim-wins"){
   assert.equal(finalProvider.requests.length,1);
   assert(finalProvider.requests.every(r=>!r.noncePresent[1]&&!r.noncePresent[2]),"withdrawn text absent every actual model request");
  }else assert.equal(finalProvider.requests.length,2);
  assert.equal(result.ipc.filter(r=>r.method==="zen/turn/send").length,3,"no automatic resend");
  result.finalProjection=await evaluate("window.zenx.protocol.request('zen/thread/read',{threadId:"+JSON.stringify(threadId)+"})");
  result.finalDraft=await evaluate("document.querySelector('#thread-composer')?.value");
  await control("disarm");
  await screenshot(result.caseId+"-final-complete-app.png");
  result.ok=true;
}
void import(pathToFileURL(path.join(__dirname,"../out/main/index.js")).href)
 .then(run).catch(async error=>{
  result.error=String(error.stack||error);
  console.error("SYNTHETIC_RECALL_CAPTURE_ERROR "+JSON.stringify({error:result.error,waitingFor:result.waitingFor,pendingOperation:result.pendingOperation}));
  if(window&&!window.isDestroyed())try{await screenshot("recall-failure.png")}catch{}
 }).finally(async()=>{
  recallReplyGate?.release();
  releaseNotifications();
  if(ownedBackend?.connected)try{await control("disarm")}catch(error){result.cleanupGate=String(error);}
  await fs.writeFile(path.join(directory,"full-app-measurements.json"),JSON.stringify(result,null,2));
  process.exitCode=result.ok?0:1;app.quit();
 });
