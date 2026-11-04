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
assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.platform,'darwin');
assert.equal(process.arch,'arm64');
const [executableArg,outArg,workspaceArg]=process.argv.slice(2);
assert(executableArg&&outArg&&workspaceArg);
assert.equal(process.argv.length,5);
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
const body=(role,index)=>('Synthetic '+role+' '+index+'. '+'Fixture-only ordinary history. '.repeat(Math.ceil(256/30))).slice(0,256);
const now=Date.now()-1000*count*4;
const stamp=i=>new Date(now+i*1000).toISOString();
const transcript=[{timestamp:stamp(0),type:'session_meta',payload:{id:session,cwd:workspace,originator:'owned-comparison'}}];
for(let i=0;i<count;i++)transcript.push(
 {timestamp:stamp(i*4+1),type:'event_msg',payload:{type:'user_message',message:body('user',i)}},
 {timestamp:stamp(i*4+2),type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:body('assistant',i)}]}}
);
const sessions=path.join(codex,'sessions','2026','11','04');await mkdir(sessions,{recursive:true,mode:0o700});
await writeFile(path.join(sessions,'rollout-'+session+'.jsonl'),transcript.map(x=>JSON.stringify(x)).join('\n')+'\n',{mode:0o600});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,label,ms=60000){const end=Date.now()+ms;let last;while(Date.now()<end){try{const x=await f();if(x)return x;}catch(e){last=e;}await delay(100);}throw new Error(label+' timed out'+(last?': '+last.message:''));}
class Wire{
 constructor(url){this.socket=new WebSocket(url);this.next=0;this.pending=new Map();this.listeners=[];this.ready=new Promise((resolve,reject)=>{this.socket.addEventListener('open',resolve,{once:true});this.socket.addEventListener('error',reject,{once:true});});this.socket.addEventListener('message',e=>{for(const x of [].concat(JSON.parse(String(e.data)))){if(x.id&&this.pending.has(x.id)){const {resolve,reject,t}=this.pending.get(x.id);clearTimeout(t);this.pending.delete(x.id);x.error?reject(new Error(JSON.stringify(x.error))):resolve(x.result);}for(const f of this.listeners)f(x);}});}
 async send(method,params={}){await this.ready;const id=++this.next;return new Promise((resolve,reject)=>{const t=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP timeout: '+method));},30000);this.pending.set(id,{resolve,reject,t});this.socket.send(JSON.stringify({id,method,params}));});}
 async evaluate(expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text+' '+(r.exceptionDetails.exception?.description??''));return r.result?.value;}
 close(){this.socket.close();}
}
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|LANG|LC_ALL|TMPDIR|GITHUB_ACTIONS|CI|DISPLAY)$/.test(k)));
Object.assign(env,{HOME:home,USER_HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),T3CODE_HOME:base,CODEX_HOME:codex,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),T3CODE_DISABLE_AUTO_UPDATE:'true',T3CODE_TELEMETRY_ENABLED:'false',T3CODE_OTEL_SDK_DISABLED:'true',OTEL_SDK_DISABLED:'true'});
let child,closed,main,page,privateLog;
const lifecycle=[];const results=[];
async function launch(){
 privateLog=await open(path.join(owned,'process-'+lifecycle.length+'.log'),'wx',0o600);
 let logs='';
 child=spawn(executable,['--inspect=127.0.0.1:0','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0'],{env,cwd:workspace,stdio:['ignore','pipe','pipe'],detached:true});
 closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{logs=(logs+String(b)).slice(-131072);void privateLog.write(b);});
 const endpoints=await until(()=>{const a=/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/.exec(logs)?.[1],b=/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/.exec(logs)?.[1];return a&&b?{a,b}:null;},'official inspector and Chromium startup');
 main=new Wire(endpoints.a);await main.ready;
 const browser=new Wire(endpoints.b);await browser.ready;
 const target=await until(async()=>{const x=await browser.send('Target.getTargets');return x.targetInfos.find(t=>t.type==='page'&&!/devtools:/.test(t.url));},'official main page');
 const port=new URL(endpoints.b).port;
 const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 const exact=targets.find(t=>t.id===target.targetId);assert(exact?.webSocketDebuggerUrl);
 page=new Wire(exact.webSocketDebuggerUrl);await page.ready;browser.close();
 await main.evaluate(`globalThis.__ownedComparisonElectron=(typeof require==='function'?require:process.mainModule.require.bind(process.mainModule))('electron');globalThis.__ownedComparisonWindow=__ownedComparisonElectron.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===${JSON.stringify(target.url)})??__ownedComparisonElectron.BrowserWindow.getAllWindows()[0];__ownedComparisonWindow.setSize(1280,820);__ownedComparisonWindow.show();__ownedComparisonWindow.focus();true`);
 await until(()=>page.evaluate(`Boolean(window.desktopBridge?.getLocalEnvironmentBootstraps?.().some(b=>b.httpBaseUrl&&b.wsBaseUrl))`),'official local environment');
 lifecycle.push({phase:'launched',pid:child.pid,host:host()});
}
async function rpcSetup(){
 // Credentials stay entirely inside this owned renderer and are never returned or logged.
 await page.evaluate(`(async()=>{const b=window.desktopBridge.getLocalEnvironmentBootstraps().find(b=>b.id==='primary'&&b.httpBaseUrl);if(!b)throw Error('No primary local backend');const h=new URL(b.httpBaseUrl);if(!['localhost','127.0.0.1','[::1]'].includes(h.hostname))throw Error('Non-loopback backend refused');const token=await window.desktopBridge.getLocalEnvironmentBearerToken();const response=await fetch(new URL('/api/auth/websocket-ticket/rpc',h),{method:'POST',headers:{authorization:'Bearer '+token}});if(!response.ok)throw Error('Official ticket request status '+response.status);const ticket=await response.json(),u=new URL('/ws',b.wsBaseUrl);u.searchParams.set('orchestrationProtocol','2');u.searchParams.set('wsTicket',ticket.ticket);const socket=new WebSocket(u);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',()=>j(Error('Owned RPC open failed')),{once:true});});let id=0;const pending=new Map();socket.addEventListener('message',event=>{for(const m of [].concat(JSON.parse(event.data))){if(m._tag==='Ping'){socket.send(JSON.stringify({_tag:'Pong'}));continue;}if(m._tag==='Exit'&&pending.has(String(m.requestId))){const p=pending.get(String(m.requestId));clearTimeout(p.timer);pending.delete(String(m.requestId));m.exit._tag==='Success'?p.resolve(m.exit.value):p.reject(Error('Official RPC rejected '+JSON.stringify(m.exit)));}}});window.__ownedOfficialRpc=(tag,payload)=>new Promise((resolve,reject)=>{const n=String(++id),timer=setTimeout(()=>{pending.delete(n);reject(Error('Official RPC timeout '+tag));},30000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({_tag:'Request',id:n,tag,payload,headers:[]}));});window.__ownedOfficialRpcClose=()=>socket.close();return true;})()`);
}
async function rpc(tag,payload){return page.evaluate(`window.__ownedOfficialRpc(${JSON.stringify(tag)},${JSON.stringify(payload)})`);}
async function quit(){
 page?.close();main?.evaluate(`__ownedComparisonElectron.app.quit();true`).catch(()=>{});
 const result=await Promise.race([closed,delay(20000).then(()=>{throw Error('Official normal app quit did not finish');})]);
 lifecycle.push({phase:'normal-close',...result});assert.equal(result.code,0);assert.equal(result.signal,null);
 main?.close();await privateLog?.close();
}
const report={status:'not-started',officialVersion:'0.1.7-nightly.20261103.4119',sourceCommit:'cefb544af3c98224874419198c0359b652ca3c94',assetBytes:186437562,assetSha256:'3a65c0355a08a8d32e0df04d7719f545551d76be5e7b4662b7f26335f06f0c95',history:{priorCompletedTurns:count,priorMessages:count*2,textLength:256,seed:'official AgentSessionScanner + AgentSessionImporter + EventSink; no raw SQLite writes'},hostBefore,results,lifecycle,durability:'SQLite WAL synchronous=NORMAL; normal process close/cold reopen only. Not equivalent to per-send fsync or power-loss durability.',presentationEvidence:'Renderer DOM/rAF observations only, not screenshot/pixel-presented proof. Do not pool with existing Zen strict later-frame results.'};
try{
 await launch();await rpcSetup();
 await rpc('projects.mutate',{type:'project.create',commandId:randomUUID(),projectId,title:'Owned ordinary Send comparison',workspaceRoot:workspace,defaultModelSelection:{instanceId:'codex',model:'gpt-6-astra'}});
 const imported=await rpc('agentSessions.import',{projectId,expectedWorkspaceRoot:workspace});assert.equal(imported.importedCount,1);
 const initial=await rpc('orchestration.getThreadProjection',{threadId});
 assert.equal(initial.messages.filter(m=>m.role==='user').length,count);assert.equal(initial.messages.filter(m=>m.role==='assistant').length,count);
 assert(!initial.turnItems.some(t=>t.type==='system_notice'&&/not imported/.test(t.message)),'Official import must not truncate this short fixture');
 const target=await page.evaluate(`new URL('/'+${JSON.stringify('primary')}+'/'+encodeURIComponent(${JSON.stringify(threadId)}),location.href).href`);
 await page.send('Page.navigate',{url:target});
 await until(()=>page.evaluate(`Boolean(document.querySelector('[data-testid="composer-editor"][contenteditable="true"]'))`),'official composer');
 // Install observational hooks after preparation, never inject a bubble or ACK.
 await page.evaluate(`(()=>{window.__ownedSends=[];const original=WebSocket.prototype.send;const listening=new WeakSet();WebSocket.prototype.send=function(data){if(!listening.has(this)){listening.add(this);this.addEventListener('message',e=>{let all;try{all=[].concat(JSON.parse(e.data));}catch{return;}for(const m of all){const t=performance.now();for(const s of window.__ownedSends){if(m._tag==='Exit'&&String(m.requestId)===s.requestId){s.responseAt=t;s.responseSuccess=m.exit._tag==='Success';s.sequence=m.exit.value?.sequence??null;}const visit=(x)=>{if(!x||typeof x!=='object')return;if(x.type==='message.updated'&&x.payload?.id===s.messageId){s.canonicalEchoAt??=t;}for(const v of Object.values(x))if(v&&typeof v==='object')Array.isArray(v)?v.forEach(visit):visit(v);};visit(m);}}});}try{for(const m of [].concat(JSON.parse(data))){if(m._tag==='Request'&&m.tag==='orchestration.dispatchCommand'&&m.payload?.type==='message.dispatch'){const s=window.__ownedSends.find(s=>s.nonce===m.payload.text);if(s){s.requestId=String(m.id);s.messageId=m.payload.messageId;s.commandId=m.payload.commandId;s.requestAt=performance.now();}}}}catch{}return original.call(this,data);};document.addEventListener('keydown',e=>{if(e.key!=='Enter'||e.shiftKey)return;const s=window.__ownedSends.at(-1);if(!s||s.enterAt!==undefined)return;s.enterAt=performance.now();s.enterTrusted=e.isTrusted;const loop=()=>{const row=s.messageId?document.querySelector('[data-message-id="'+CSS.escape(s.messageId)+'"][data-message-role="user"]'):Array.from(document.querySelectorAll('[data-message-role="user"]')).find(n=>n.textContent.includes(s.nonce));if(row){const r=row.getBoundingClientRect(),style=getComputedStyle(row);if(r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&style.visibility==='visible'&&style.display!=='none'){s.firstEligibleRafAt??=performance.now();if(s.firstEligibleRafAt!==performance.now())s.laterEligibleRafAt??=performance.now();}}if(!s.laterEligibleRafAt&&performance.now()-s.enterAt<15000)requestAnimationFrame(loop);};requestAnimationFrame(loop);},true);return true;})()`);
 for(let i=0;i<3;i++){
  const nonce='Owned ordinary Send comparison '+i+'. '+randomUUID();
  await page.evaluate(`document.querySelector('[data-testid="composer-editor"]').focus();window.__ownedSends.push({nonce:${JSON.stringify(nonce)}});true`);
  await main.evaluate(`__ownedComparisonWindow.webContents.insertText(${JSON.stringify(nonce)});true`);
  await delay(150);
  await main.evaluate(`__ownedComparisonWindow.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});__ownedComparisonWindow.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});true`);
  const sample=await until(()=>page.evaluate(`(()=>{const s=window.__ownedSends.at(-1);return s?.responseAt!==undefined&&s.laterEligibleRafAt!==undefined?s:null;})()`),'real Send response and later eligible frame',20000);
  assert.equal(sample.enterTrusted,true);assert.equal(sample.responseSuccess,true);assert(Number.isSafeInteger(sample.sequence));
  results.push({...sample,enterToFirstEligibleRafMs:sample.firstEligibleRafAt-sample.enterAt,enterToLaterEligibleRafMs:sample.laterEligibleRafAt-sample.enterAt,enterToAdmissionResponseMs:sample.responseAt-sample.enterAt});
  await delay(1000);
 }
 await rpcSetup();const after=await rpc('orchestration.getThreadProjection',{threadId});
 for(const sample of results){assert.equal(after.messages.filter(m=>m.id===sample.messageId&&m.text===sample.nonce).length,1);sample.canonicalProjectionConfirmed=true;}
 report.providerRunOutcomes=after.runs.map(r=>({id:r.id,status:r.status}));
 await quit();await launch();await rpcSetup();
 const reopened=await rpc('orchestration.getThreadProjection',{threadId});
 for(const sample of results)assert.equal(reopened.messages.filter(m=>m.id===sample.messageId&&m.text===sample.nonce).length,1);
 report.coldReopen={matchedMessages:results.length,duplicateMatches:0,normalCloseObserved:true};
 await quit();report.status='completed';report.hostAfter=host();
}catch(error){report.status='failed';report.error={name:error.name,message:error.message};if(child?.exitCode===null&&child?.signalCode===null){try{await quit();}catch{try{process.kill(-child.pid,'SIGTERM');}catch{}await Promise.race([closed.catch(()=>{}),delay(5000)]);}}process.exitCode=1;}
finally{await writeFile(path.join(out,'official-t3-summary.json'),JSON.stringify(report,null,2)+'\n');await rm(owned,{recursive:true,force:true});}
