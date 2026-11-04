/** Review candidate: unmodified official T3 App, disposable native CI only.
 * No model credentials, no fake ACK, no raw SQLite writes, no source patching.
 * Node's built-in WebSocket talks to the same Chromium/Electron input endpoints.
 * This file has only been syntax-checked on Linux, NOT native-validated.
 */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile,rm,open,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Wire,delay,until,loadFixture,installObservation,assertOwnedInput,requireLiveBottom,stopOwnedProcess} from './short-run-common.mjs';
assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.platform,'darwin');
assert.equal(process.arch,'arm64');
const [executableArg,outArg,workspaceArg,fixtureArg]=process.argv.slice(2);
assert(executableArg&&outArg&&workspaceArg&&fixtureArg);
assert.equal(process.argv.length,6);
const fixture=await loadFixture(fixtureArg);
const executable=await realpath(executableArg), out=path.resolve(outArg), workspace=await realpath(workspaceArg);
assert.match(executable,/T3 Code \(Nightly\)\.app\/Contents\/MacOS\/T3 Code \(Nightly\)$/);
const host=()=>({platform:os.platform(),arch:os.arch(),release:os.release(),cpu:os.cpus()[0]?.model,cpuCount:os.cpus().length,load:os.loadavg(),freeMemory:os.freemem()});
const hostBefore=host();
await mkdir(out,{recursive:true});
const owned=await mkdtemp(path.join(os.tmpdir(),'t3-official-owned-'));
const home=path.join(owned,'home'),base=path.join(owned,'t3'),codex=path.join(owned,'codex');
for(const d of [home,base,codex,path.join(base,'userdata')]) await mkdir(d,{recursive:true,mode:0o700});
await writeFile(path.join(base,'userdata','client-settings.json'),JSON.stringify({onboardingCompletedAt:new Date().toISOString()}),{mode:0o600});
const count=100,session=randomUUID(),threadId='import:codex:'+session,projectId='official-t3-comparison';
const transcript=[{timestamp:fixture.turns[0].userAt,type:'session_meta',payload:{id:session,cwd:workspace,originator:'owned-comparison'}}];
for(const turn of fixture.turns)transcript.push(
 {timestamp:turn.userAt,type:'event_msg',payload:{type:'user_message',message:turn.user}},
 {timestamp:turn.assistantAt,type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:turn.assistant}]}}
);
const sessions=path.join(codex,'sessions','2026','11','04');await mkdir(sessions,{recursive:true,mode:0o700});
await writeFile(path.join(sessions,'rollout-'+session+'.jsonl'),transcript.map(x=>JSON.stringify(x)).join('\n')+'\n',{mode:0o600});
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|LANG|LC_ALL|TMPDIR|GITHUB_ACTIONS|CI|DISPLAY)$/.test(k)));
Object.assign(env,{HOME:home,USER_HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),T3CODE_HOME:base,CODEX_HOME:codex,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),T3CODE_DISABLE_AUTO_UPDATE:'true',T3CODE_TELEMETRY_ENABLED:'false',T3CODE_OTEL_SDK_DISABLED:'true',OTEL_SDK_DISABLED:'true'});
let child,closed,main,page,privateLog;
const lifecycle=[];const results=[];
async function launch(){
 privateLog=await open(path.join(owned,'process-'+lifecycle.length+'.log'),'wx',0o600);
 let logs='';
 child=spawn(executable,['--inspect=127.0.0.1:0','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0'],{env,cwd:workspace,stdio:['ignore','pipe','pipe'],detached:true});
 closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{logs=(logs+String(b)).slice(-131072);void privateLog.write(b).catch(()=>{});});
 const endpoints=await until(()=>{const a=/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/.exec(logs)?.[1],b=/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/.exec(logs)?.[1];return a&&b?{a,b}:null;},'official inspector and Chromium startup');
 main=new Wire(endpoints.a);await main.ready;
 const browser=new Wire(endpoints.b);await browser.ready;
 const target=await until(async()=>{const x=await browser.send('Target.getTargets'),matches=x.targetInfos.filter(t=>t.type==='page'&&/^t3code:\/\/app\//.test(t.url));assert(matches.length<=1);return matches[0];},'official main page');
 const port=new URL(endpoints.b).port;
 const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 const exact=targets.find(t=>t.id===target.targetId);assert(exact?.webSocketDebuggerUrl);
 page=new Wire(exact.webSocketDebuggerUrl);await page.ready;browser.close();
 await main.evaluate(`globalThis.__ownedComparisonElectron=(typeof require==='function'?require:process.mainModule.require.bind(process.mainModule))('electron');const ownedMatches=__ownedComparisonElectron.BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL()===${JSON.stringify(target.url)});if(ownedMatches.length!==1)throw Error('No unique exact official main Window');globalThis.__ownedComparisonWindow=ownedMatches[0];__ownedComparisonWindow.setSize(1280,820);__ownedComparisonWindow.show();__ownedComparisonWindow.focus();true`);
 await page.evaluate(`window.__ownedDocumentIdentity=crypto.randomUUID();true`);
 await until(()=>page.evaluate(`Boolean(window.desktopBridge?.getLocalEnvironmentBootstraps?.().some(b=>b.httpBaseUrl&&b.wsBaseUrl))`),'official local environment');
 lifecycle.push({phase:'launched',pid:child.pid,host:host()});
}
async function rpcSetup(){
 // Credentials stay entirely inside this owned renderer and are never returned or logged.
 await page.evaluate(`(async()=>{const b=window.desktopBridge.getLocalEnvironmentBootstraps().find(b=>b.id==='primary'&&b.httpBaseUrl);if(!b)throw Error('No primary local backend');const h=new URL(b.httpBaseUrl);if(!['localhost','127.0.0.1','[::1]'].includes(h.hostname))throw Error('Non-loopback backend refused');const token=await window.desktopBridge.getLocalEnvironmentBearerToken();const response=await fetch(new URL('/api/auth/websocket-ticket/rpc',h),{method:'POST',headers:{authorization:'Bearer '+token}});if(!response.ok)throw Error('Official ticket request status '+response.status);const ticket=await response.json(),u=new URL('/ws',b.wsBaseUrl);u.searchParams.set('orchestrationProtocol','2');u.searchParams.set('wsTicket',ticket.ticket);const socket=new WebSocket(u);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',()=>j(Error('Owned RPC open failed')),{once:true});});let id=0;const pending=new Map();socket.addEventListener('message',event=>{for(const m of [].concat(JSON.parse(event.data))){if(m._tag==='Ping'){socket.send(JSON.stringify({_tag:'Pong'}));continue;}if(m._tag==='Exit'&&pending.has(String(m.requestId))){const p=pending.get(String(m.requestId));clearTimeout(p.timer);pending.delete(String(m.requestId));m.exit._tag==='Success'?p.resolve(m.exit.value):p.reject(Error('Official RPC rejected '+m.exit._tag));}}});window.__ownedOfficialRpc=(tag,payload)=>new Promise((resolve,reject)=>{const n=String(++id),timer=setTimeout(()=>{pending.delete(n);reject(Error('Official RPC timeout '+tag));},30000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({_tag:'Request',id:n,tag,payload,headers:[]}));});window.__ownedOfficialRpcClose=()=>socket.close();return true;})()`);
}
async function rpc(tag,payload){return page.evaluate(`window.__ownedOfficialRpc(${JSON.stringify(tag)},${JSON.stringify(payload)})`);}
async function quit(){
 page?.close();main?.evaluate(`__ownedComparisonElectron.app.quit();true`).catch(()=>{});
 const result=await Promise.race([closed,delay(20000).then(()=>{throw Error('Official normal app quit did not finish');})]);
 try{assert.equal(result.code,0);assert.equal(result.signal,null);const group=await stopOwnedProcess(child,closed,main,page,privateLog,{normalCloseOnly:true});lifecycle.push({phase:'normal-close',...result,...group});}catch(error){lifecycle.push({phase:'normal-close-failed',...result,processGroupAbsentUnconfirmed:true});throw error;}
}
const report={status:'not-started',officialVersion:'0.1.7-nightly.20261103.4119',sourceCommit:'cefb544af3c98224874419198c0359b652ca3c94',assetBytes:186437562,assetSha256:'3a65c0355a08a8d32e0df04d7719f545551d76be5e7b4662b7f26335f06f0c95',fixtureContentSha256:fixture.contentSha256,history:{priorConversationPairs:count,priorCompletedTurnItems:count*2,priorProviderRuns:0,priorMessages:count*2,textLength:256,seed:'official AgentSessionScanner + AgentSessionImporter + EventSink; no raw SQLite writes'},hostBefore,results,lifecycle,durability:'SQLite WAL synchronous=NORMAL; normal process close/cold reopen only. Not equivalent to per-send fsync or power-loss durability.',modelSelection:{instanceId:'codex',model:'gpt-6-astra',source:'Official packages/contracts/src/model.ts DEFAULT_MODEL and codex default; no model credentials supplied'},presentationEvidence:'Shared native IO + transcript/composer clipping + distinct later rAF, not screenshot/pixel-presented proof. Do not pool with existing Zen strict later-frame results.'};
try{
 await launch();await rpcSetup();
 await rpc('projects.mutate',{type:'project.create',commandId:randomUUID(),projectId,title:'Owned ordinary Send comparison',workspaceRoot:workspace,defaultModelSelection:{instanceId:'codex',model:'gpt-6-astra'}});
 const imported=await rpc('agentSessions.import',{projectId,expectedWorkspaceRoot:workspace});assert.equal(imported.importedCount,1);
 const initial=await rpc('orchestration.getThreadProjection',{threadId});
 // The official UI snapshot intentionally contains a bounded history window.
 const {DatabaseSync}=await import('node:sqlite');const dbPath=path.join(base,'userdata','statev2.sqlite');
 const seededDb=new DatabaseSync(dbPath,{readOnly:true});try{const rows=seededDb.prepare('SELECT role, COUNT(*) AS n FROM orchestration_v2_projection_messages WHERE thread_id=? GROUP BY role').all(threadId);assert.equal(rows.find(r=>r.role==='user')?.n,count);assert.equal(rows.find(r=>r.role==='assistant')?.n,count);const messages=seededDb.prepare('SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=? ORDER BY created_at,message_id').all(threadId).map(r=>JSON.parse(r.payload_json));assert.deepEqual(messages.map(m=>({role:m.role,text:m.text})),fixture.turns.flatMap(t=>[{role:'user',text:t.user},{role:'assistant',text:t.assistant}]));}finally{seededDb.close();}
 assert(!initial.turnItems.some(t=>t.type==='system_notice'&&/not imported/.test(t.message)),'Official import must not truncate this short fixture');
 const target=await page.evaluate(`new URL('/'+${JSON.stringify('primary')}+'/'+encodeURIComponent(${JSON.stringify(threadId)}),location.href).href`);
 await page.send('Page.navigate',{url:target});
 await until(()=>page.evaluate(`Boolean(document.querySelector('[data-testid="composer-editor"][contenteditable="true"]'))`),'official composer');
 await page.evaluate(`window.__ownedDocumentIdentity=crypto.randomUUID();true`);
 await rpcSetup();
 // Install observational hooks after preparation, never inject a bubble or ACK.
 await page.evaluate(`(()=>{window.__ownedSends=[];const original=WebSocket.prototype.send;const listening=new WeakSet();WebSocket.prototype.send=function(data){if(!listening.has(this)){listening.add(this);this.addEventListener('message',e=>{let all;try{all=[].concat(JSON.parse(e.data));}catch{return;}for(const m of all){const t=performance.now();for(const s of window.__ownedSends){if(m._tag==='Exit'&&String(m.requestId)===s.requestId){s.responseAt=t;s.responseSuccess=m.exit._tag==='Success';s.sequence=m.exit.value?.sequence??null;}const visit=(x)=>{if(!x||typeof x!=='object')return;if(x.type==='message.updated'&&x.payload?.id===s.messageId&&x.payload.role==='user'&&x.payload.text===s.nonce){s.canonicalEchoAt??=t;}for(const v of Object.values(x))if(v&&typeof v==='object')Array.isArray(v)?v.forEach(visit):visit(v);};visit(m);}}});}try{for(const m of [].concat(JSON.parse(data))){if(m._tag==='Request'&&m.tag==='orchestration.dispatchCommand'&&m.payload?.type==='message.dispatch'){const s=window.__ownedSends.find(s=>s.nonce===m.payload.text);if(s){s.requestId=String(m.id);s.messageId=m.payload.messageId;s.commandId=m.payload.commandId;s.requestAt=performance.now();}}}}catch{}return original.call(this,data);};return true;})()`);
 for(let i=0;i<3;i++){
  const nonce=fixture.sends[i];
  await requireLiveBottom(page,'.messages-timeline-scroll');
  await until(async()=>{const p=await rpc('orchestration.getThreadProjection',{threadId});return p.runs.every(r=>['completed','failed','interrupted'].includes(r.status));},'previous provider run terminal before ordinary Send',90000);
  await page.evaluate(`document.querySelector('[data-testid="composer-editor"]').focus();window.__ownedSends.push({nonce:${JSON.stringify(nonce)}});true`);
  const beforeInput=await assertOwnedInput(main,page,'[data-testid="composer-editor"]');
  await main.evaluate(`(async()=>{await __ownedComparisonWindow.webContents.insertText(${JSON.stringify(nonce)});return true;})()`);
  await until(()=>page.evaluate(`document.querySelector('[data-testid="composer-editor"]').textContent===${JSON.stringify(nonce)}`),'native text inserted');
  await installObservation(page,{rootSelector:'.messages-timeline-scroll',rowSelector:'[data-message-role="user"]',composerSelector:'[data-testid="composer-editor"]',idAttribute:'data-message-id'},nonce);
  const beforeEnter=await assertOwnedInput(main,page,'[data-testid="composer-editor"]');assert.deepEqual(beforeEnter,beforeInput);
  await main.evaluate(`__ownedComparisonWindow.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});__ownedComparisonWindow.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});true`);
  const sample=await until(()=>page.evaluate(`(()=>{const s=window.__ownedSends.at(-1);return s?.responseAt!==undefined&&s.canonicalEchoAt!==undefined&&window.__ownedFrame?.laterEligibleRafAt!==undefined?{...s,...window.__ownedFrame}:null;})()`),'real Send response and later eligible frame',20000);
  assert.equal(sample.enterTrusted,true);assert.equal(sample.responseSuccess,true);assert(Number.isSafeInteger(sample.sequence));
  results.push({...sample,enterToFirstEligibleRafMs:sample.firstEligibleRafAt-sample.enterAt,enterToLaterEligibleRafMs:sample.laterEligibleRafAt-sample.enterAt,enterToCanonicalUserEventMs:sample.canonicalEchoAt-sample.enterAt,enterToAdmissionResponseMs:sample.responseAt-sample.enterAt});
  await delay(1000);
 }
 await rpcSetup();const after=await rpc('orchestration.getThreadProjection',{threadId});
 for(const sample of results){assert.equal(after.messages.filter(m=>m.id===sample.messageId&&m.text===sample.nonce).length,1);sample.canonicalProjectionConfirmed=true;}
 report.providerRunOutcomes=after.runs.map(r=>({id:r.id,status:r.status}));
 await quit();
 const receiptDb=new DatabaseSync(dbPath,{readOnly:true});try{let sequence=0;report.independentReceipts=results.map(sample=>{const rows=receiptDb.prepare('SELECT command_id, aggregate_id, command_type, result_sequence, status FROM orchestration_command_receipts WHERE command_id=?').all(sample.commandId);assert.equal(rows.length,1);const r=rows[0];assert.equal(r.aggregate_id,threadId);assert.equal(r.command_type,'message.dispatch');assert.equal(r.status,'accepted');assert.equal(r.result_sequence,sample.sequence);assert(r.result_sequence>sequence);sequence=r.result_sequence;return {commandId:r.command_id,status:r.status,sequence:r.result_sequence};});}finally{receiptDb.close();}
 await launch();await rpcSetup();
 const reopened=await rpc('orchestration.getThreadProjection',{threadId});
 let prior=-1;for(const sample of results){assert.equal(reopened.messages.filter(m=>m.id===sample.messageId&&m.text===sample.nonce).length,1);const index=reopened.messages.findIndex(m=>m.id===sample.messageId);assert(index>prior);prior=index;}
 report.coldReopen={matchedMessages:results.length,duplicateMatches:0,ordered:true,normalCloseObserved:true};
 await quit();report.status='completed';report.hostAfter=host();
}catch(error){report.status='failed';report.error={name:error.name,message:error.message.slice(0,350)};try{if(child?.exitCode===null&&child?.signalCode===null)await quit();}catch{}process.exitCode=1;}
finally{try{await stopOwnedProcess(child,closed,main,page,privateLog);}catch(error){report.status='failed';report.cleanupError=error.message;process.exitCode=1;}await writeFile(path.join(out,'official-t3-summary.json'),JSON.stringify(report,null,2)+'\n');if(!report.cleanupError)await rm(owned,{recursive:true,force:true});}
