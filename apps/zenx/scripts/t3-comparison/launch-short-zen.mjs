/** New bounded 100-turn entry. Never changes/reuses the existing 5000 driver. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile,rm,open,realpath} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Wire,delay,until,loadFixture,installObservation,assertOwnedInput,requireLiveBottom,stopOwnedProcess,ownedProcessMetadata} from './short-run-common.mjs';
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
const [checkoutArg,outArg,workspaceArg,fixtureArg]=process.argv.slice(2);assert(checkoutArg&&outArg&&workspaceArg&&fixtureArg);assert.equal(process.argv.length,6);
const checkout=await realpath(checkoutArg),out=path.resolve(outArg),workspace=await realpath(workspaceArg),fixture=await loadFixture(fixtureArg);
const tree=execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:checkout,encoding:'utf8'}).trim();assert.equal(tree,'db349a545c3f6502a6babb291314224c1708e5f6');
assert.equal(execFileSync('git',['diff','--name-only','HEAD'],{cwd:checkout,encoding:'utf8'}).trim(),'');
const root=path.dirname(workspace);assert(workspace.startsWith((await realpath(process.env.RUNNER_TEMP))+path.sep),'Only owned CI workspace');
const owned=await mkdtemp(path.join(root,'zen-short-owned-')),home=path.join(owned,'home'),profile=path.join(owned,'profile'),data=path.join(owned,'data');
for(const d of [home,profile,data,path.join(home,'Documents')])await mkdir(d,{recursive:true,mode:0o700});await mkdir(out,{recursive:true});
const moduleAt=relative=>import(pathToFileURL(path.join(checkout,relative)).href);
// Rebind only the existing diagnostic seeder's three production imports in an
// owned temporary module. Neither original helper nor product sources change.
const seedSource=await readFile(new URL('../long-thread-domain-seed.mjs',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(seedSource).digest('hex'),'b535d48f6fc94ebe0039271438213cd5d91a4a72fbab010ef8d8a77d044e0054');
let boundSeedSource=seedSource;for(const name of ['domain-journal','trace','thread-metadata']){const from='"../../../dist/src/'+name+'.js"';assert.equal(boundSeedSource.split(from).length,2);boundSeedSource=boundSeedSource.replace(from,JSON.stringify(pathToFileURL(path.join(checkout,'dist/src/'+name+'.js')).href));}
const seedHelper=path.join(owned,'production-bound-seed.mjs');await writeFile(seedHelper,boundSeedSource,{mode:0o600});const {seedLongThread,verifyLongThread}=await import(pathToFileURL(seedHelper).href);
// Reuse the existing seed seam at its supported zero-history count, then append
// this bounded shared fixture through the same production DomainThreadJournal.
const seed=await seedLongThread({isolationRoot:root,dataDirectory:data,workspace,userMessageCount:0,providerProfileId:'fake',modelId:'fake'});
const {DomainThreadJournal}=await moduleAt('dist/src/domain-journal.js'),{FileTraceStore}=await moduleAt('dist/src/trace.js'),{JsonlThreadMetadataStore}=await moduleAt('dist/src/thread-metadata.js');
const trace=new FileTraceStore(path.join(data,'trace')),metadata=new JsonlThreadMetadataStore(path.join(data,'thread-metadata.jsonl'));
const journal=new DomainThreadJournal({directory:path.join(data,'threads'),trace,metadata}),threadId=seed.threadId,selection={providerProfileId:'fake',modelId:'fake',reasoningEffort:'medium'};
try{
 for(let i=0;i<fixture.turns.length;i++){const t=fixture.turns[i],turnId=threadId+'-shared-'+i,common={threadId,turnId};for(const item of [
  {...common,id:turnId+'-started',createdAt:t.userAt,type:'turn_started',selection},
  {...common,id:turnId+'-user',createdAt:t.userAt,type:'user_message',clientId:turnId+'-client',content:[{type:'text',text:t.user}],receiptTimezone:{timeZone:'UTC',source:'client'}},
  {...common,id:turnId+'-assistant',createdAt:t.assistantAt,type:'agent_message',text:t.assistant},
  {...common,id:turnId+'-completed',createdAt:t.assistantAt,type:'turn_completed',status:'completed'}
 ])await journal.append(item);}
 await metadata.setName(threadId,'Owned ordinary Send comparison: 100 prior turns');
 const facts=await journal.read(threadId);assert.equal(facts.filter(x=>x.type==='user_message').length,100);assert.equal(facts.filter(x=>x.type==='agent_message').length,100);assert.equal(facts.filter(x=>x.type==='turn_completed').length,100);assert.deepEqual(facts.filter(x=>x.type==='user_message'||x.type==='agent_message').map(x=>x.type==='user_message'?x.content[0].text:x.text),fixture.turns.flatMap(t=>[t.user,t.assistant]));
}finally{await journal.close();await trace.flush();}
await writeFile(path.join(profile,'host-profile.json'),JSON.stringify({version:3,onboardingComplete:true,providerProfiles:[{type:'fake',displayName:'Synthetic local only',providerProfileId:'fake',models:[{id:'fake',displayName:'fake',description:'Offline ordinary-send baseline',hidden:false,source:'manual',supportedReasoningEfforts:['medium'],defaultReasoningEffort:'medium',inputModalities:['text'],contextWindow:100000000}]}],defaultModel:{providerProfileId:'fake',modelId:'fake'},titleModel:{providerProfileId:'fake',modelId:'fake'},workspace,workspaces:[workspace],lastUsedWorkspace:workspace,approvalPolicy:'never'}),{mode:0o600});
const {packageZenX}=await moduleAt('apps/zenx/scripts/package-zenx-portable.mjs');
const oldIdentity=process.env.ZENX_CODESIGN_IDENTITY;process.env.ZENX_CODESIGN_IDENTITY='-';let packaged;
try{packaged=await packageZenX(['--app'],{buildDirectory:path.join(checkout,'apps/zenx/out'),artifactDirectory:path.join(owned,'package')});}finally{if(oldIdentity===undefined)delete process.env.ZENX_CODESIGN_IDENTITY;else process.env.ZENX_CODESIGN_IDENTITY=oldIdentity;}
const executable=packaged.executable;execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',path.join(packaged.packagedArtifact,'ZenX.app')]);
const host=()=>({platform:os.platform(),arch:os.arch(),release:os.release(),cpu:os.cpus()[0]?.model,cpuCount:os.cpus().length,load:os.loadavg(),freeMemory:os.freemem()});
const results=[],lifecycle=[],diagnostics={processIdentities:[]};let child,closed,main,page,privateLog,phase='prepared',rpcTag=null;
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|LANG|LC_ALL|TMPDIR|GITHUB_ACTIONS|CI|DISPLAY)$/.test(k)));
Object.assign(env,{HOME:home,USER_HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),ZENX_DATA_DIR:data});
async function launch(){
 phase='launch.spawn';rpcTag=null;
 let logs='';privateLog=await open(path.join(owned,'process-'+lifecycle.length+'.log'),'wx',0o600);
 child=spawn(executable,['--inspect=127.0.0.1:0','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile],{env,cwd:workspace,stdio:['ignore','pipe','pipe'],detached:true});
 closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{logs=(logs+String(b)).slice(-131072);void privateLog.write(b).catch(()=>{});});
 phase='launch.inspectors';
 const endpoints=await until(()=>{const a=/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/.exec(logs)?.[1],b=/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/.exec(logs)?.[1];return a&&b?{a,b}:null;},'Zen inspector and Chromium startup');
 main=new Wire(endpoints.a);await main.ready;const inspector=await main.evaluate(`({pid:process.pid,uid:process.getuid?.()??null,node:process.versions.node,electron:process.versions.electron??null})`);diagnostics.processIdentities.push({...ownedProcessMetadata(child.pid,inspector.pid),inspectorRuntime:inspector});phase='launch.target';const browser=new Wire(endpoints.b);await browser.ready;
 const target=await until(async()=>{const x=await browser.send('Target.getTargets');const matches=x.targetInfos.filter(t=>t.type==='page'&&/^file:/.test(t.url)&&/\/renderer\/index\.html$/.test(t.url));assert(matches.length<=1);return matches[0];},'exact Zen main renderer');
 const targets=await (await fetch('http://127.0.0.1:'+new URL(endpoints.b).port+'/json/list')).json(),exact=targets.find(t=>t.id===target.targetId);assert(exact?.webSocketDebuggerUrl);page=new Wire(exact.webSocketDebuggerUrl);await page.ready;browser.close();
 phase='launch.window-binding';
 await main.evaluate(`globalThis.__ownedComparisonElectron=(typeof require==='function'?require:process.mainModule.require.bind(process.mainModule))('electron');const matches=__ownedComparisonElectron.BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL()===${JSON.stringify(target.url)});if(matches.length!==1)throw Error('No unique exact Zen main Window');globalThis.__ownedComparisonWindow=matches[0];__ownedComparisonWindow.setSize(1280,820);__ownedComparisonWindow.show();__ownedComparisonWindow.focus();true`);
 phase='launch.host-ready';
 await until(()=>page.evaluate(`window.zenx?.protocol?.getStatus().then(s=>s.type==='ready')`),'Zen Host ready');
 await page.evaluate(`window.__ownedDocumentIdentity=crypto.randomUUID();true`);
 lifecycle.push({phase:'launched',pid:child.pid,host:host()});
}
async function quit(){phase='lifecycle.quit-request';rpcTag=null;page?.close();if(main){await main.evaluate(`setImmediate(()=>__ownedComparisonElectron.app.quit());true`);main.close();}phase='lifecycle.wait-close';const result=await Promise.race([closed,delay(20000).then(()=>{throw Error('Zen normal close timed out');})]);try{assert.equal(result.code,0);assert.equal(result.signal,null);const group=await stopOwnedProcess(child,closed,main,page,privateLog,{normalCloseOnly:true});lifecycle.push({phase:'normal-close',...result,...group});}catch(error){lifecycle.push({phase:'normal-close-failed',...result,processGroupAbsentUnconfirmed:true});throw error;}}
const report={status:'not-started',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:checkout,encoding:'utf8'}).trim(),sourceTree:tree,fixtureContentSha256:fixture.contentSha256,hostBefore:host(),history:{priorCompletedTurns:100,priorMessages:200,textLength:256,seed:'existing seedLongThread zero + production DomainThreadJournal append; original seeder count guards unchanged'},results,lifecycle,diagnostics,durability:'Production Zen journal/Trace, normal process close and independent read-only reopen. Not equal to T3 WAL NORMAL power-loss durability.',presentationEvidence:'Same shared IntersectionObserver+scrollport/composer clipping+distinct later-rAF predicate as T3. No screenshot or pixel-presented claim.',admissionTiming:'Real main-process protocol request-to-response duration, own monotonic clock. No renderer/main clock subtraction; unlike T3 renderer response time this is not Enter-to-response.'};
try{
 await launch();
 const settings=await page.evaluate('window.zenx.settings.get()');assert.equal(settings.hasApiKey,false);assert.equal(settings.subscription.authenticated,false);assert.equal(settings.profile.defaultModel.providerProfileId,'fake');
 const selector='.thread-row-shell[data-thread-id="'+threadId+'"] > button.thread-row';
 const point=await until(()=>page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return e.contains(document.elementFromPoint(x,y))?{x:Math.round(x),y:Math.round(y)}:null;})()`),'owned seeded sidebar row');
 await main.evaluate(`__ownedComparisonWindow.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...${JSON.stringify(point)}});__ownedComparisonWindow.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...${JSON.stringify(point)}});true`);
 await until(()=>page.evaluate(`Boolean(document.querySelector('#thread-composer:not(:disabled)'))`),'Zen idle composer');
 const initial=await page.evaluate(`window.zenx.protocol.request('thread/read',{threadId:${JSON.stringify(threadId)},includeTurns:true})`);assert.equal(initial.thread.turns.length,100);assert.equal(initial.thread.turns.flatMap(t=>t.items).filter(i=>['userMessage','agentMessage'].includes(i.type)).length,200);
 // Observe the actual registered handler and preserve its real value/error. This
 // runtime-guarded Map is diagnostic-only; no production source is rewritten.
 await main.evaluate(`(()=>{const handlers=__ownedComparisonElectron.ipcMain._invokeHandlers;if(!(handlers instanceof Map))throw Error('Unsupported Electron IPC handler observation seam');const original=handlers.get('zenx:protocol:request');if(typeof original!=='function')throw Error('Missing actual protocol request handler');globalThis.__ownedZenReceipts=[];handlers.set('zenx:protocol:request',async(event,method,params)=>{if(method!=='zen/turn/send')return original(event,method,params);const r={clientUserMessageId:params.clientUserMessageId,threadId:params.threadId,receivedAt:performance.now()};__ownedZenReceipts.push(r);try{const receipt=await original(event,method,params);r.responseAt=performance.now();r.receipt=structuredClone(receipt);return receipt;}catch(error){r.responseAt=performance.now();r.failed=true;throw error;}});return true;})()`);
 await page.evaluate(`window.__ownedZenEvents=[];window.zenx.protocol.onNotification((method,params)=>{if(method==='zen/thread/event'&&params.threadId===${JSON.stringify(threadId)}){const e=params.event;window.__ownedZenEvents.push({at:performance.now(),type:e?.type,itemType:e?.item?.type,itemId:e?.item?.id,turnId:e?.turnId??params.turnId,clientId:e?.item?.clientId});}});true`);
 for(let i=0;i<3;i++){
  const nonce=fixture.sends[i];phase='send.prepare.'+i;rpcTag=null;
  await requireLiveBottom(page,'.messages');
  await until(()=>page.evaluate(`window.zenx.protocol.request('thread/read',{threadId:${JSON.stringify(threadId)},includeTurns:true}).then(r=>r.thread.turns.every(t=>t.status!=='inProgress'))`),'previous Zen turn terminal');
  await page.evaluate(`document.querySelector('#thread-composer').focus();true`);const beforeInput=await assertOwnedInput(main,page,'#thread-composer');
  await main.evaluate(`(async()=>{await __ownedComparisonWindow.webContents.insertText(${JSON.stringify(nonce)});return true;})()`);
  await until(()=>page.evaluate(`document.querySelector('#thread-composer').value===${JSON.stringify(nonce)}&&Boolean(document.querySelector('.composer-send-control > button.action-orb.send:not(:disabled)'))`),'Zen text and Send enabled');
  await installObservation(page,{rootSelector:'.messages',rowSelector:'.user-row',composerSelector:'#thread-composer',idAttribute:'data-sent-message-id'},nonce);
  const beforeEnter=await assertOwnedInput(main,page,'#thread-composer');assert.deepEqual(beforeEnter,beforeInput);
  await main.evaluate(`__ownedComparisonWindow.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});__ownedComparisonWindow.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});true`);
  phase='send.await-visible-frame';rpcTag='zen/turn/send';
  const frame=await until(()=>page.evaluate(`window.__ownedFrame?.laterEligibleRafAt!==undefined?window.__ownedFrame:null`),'Zen real visible bubble and later frame',20000);assert.equal(frame.enterTrusted,true);
  const receipt=await until(async()=>{const rows=await main.evaluate('__ownedZenReceipts');return rows[i]?.responseAt!==undefined?rows[i]:null;},'real Zen admission response');assert.equal(receipt.failed,undefined);assert(receipt.receipt?.turnId);if(frame.ownerClientId)assert.equal(frame.ownerClientId,receipt.clientUserMessageId);
  phase='send.canonical-readback';rpcTag='thread/read';
  const canonical=await until(async()=>{const r=await page.evaluate(`window.zenx.protocol.request('thread/read',{threadId:${JSON.stringify(threadId)},includeTurns:true})`);const matches=r.thread.turns.flatMap(t=>t.items).filter(x=>x.type==='userMessage'&&x.clientId===receipt.clientUserMessageId);return matches.length===1?matches[0]:null;},'Zen matching canonical user message');assert(canonical.content.some(p=>p.text===nonce));
  const canonicalEvent=await until(()=>page.evaluate(`window.__ownedZenEvents.find(e=>e.type==='item_completed'&&e.itemType==='user_message'&&e.itemId===${JSON.stringify(canonical.id)}&&e.clientId===${JSON.stringify(receipt.clientUserMessageId)})??null`),'matching committed canonical Zen user event');
  results.push({...frame,messageId:canonical.id,ipc:[receipt],canonicalProjectionConfirmed:true,canonicalEchoAt:canonicalEvent.at,enterToCanonicalUserEventMs:canonicalEvent.at-frame.enterAt,enterToFirstEligibleRafMs:frame.firstEligibleRafAt-frame.enterAt,enterToLaterEligibleRafMs:frame.laterEligibleRafAt-frame.enterAt,mainAdmissionRequestToResponseMs:receipt.responseAt-receipt.receivedAt});
 }
 await quit();report.independentReopen=await verifyLongThread({dataDirectory:data,threadId,samples:results,userMessageCount:100});
 await launch();const reopened=await page.evaluate(`window.zenx.protocol.request('thread/read',{threadId:${JSON.stringify(threadId)},includeTurns:true})`);
 let prior=-1;for(const s of results){const messages=reopened.thread.turns.flatMap(t=>t.items).filter(x=>x.type==='userMessage'),matches=messages.filter(x=>x.id===s.messageId&&x.clientId===s.ipc[0].clientUserMessageId);assert.equal(matches.length,1);assert(matches[0].content.some(p=>p.text===s.nonce));const index=messages.findIndex(x=>x.id===s.messageId);assert(index>prior);prior=index;}
 report.coldReopen={matchedMessages:3,duplicateMatches:0,ordered:true};await quit();report.status='completed';report.hostAfter=host();
}catch(error){report.status='failed';report.error={name:error.name,message:error.message.slice(0,350),phase,rpcTag};try{if(child?.exitCode===null&&child?.signalCode===null)await quit();}catch{}process.exitCode=1;}
finally{try{await stopOwnedProcess(child,closed,main,page,privateLog);}catch(error){report.status='failed';report.cleanupError=error.message;report.cleanupDiagnostic=error.ownedProcess??null;process.exitCode=1;}await writeFile(path.join(out,'zen-short-summary.json'),JSON.stringify(report,null,2)+'\n');if(!report.cleanupError)await rm(owned,{recursive:true,force:true});}
