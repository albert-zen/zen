/** Small shared observer/fixture only. No product code or existing driver changes. */
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export class Wire{
 constructor(url){this.socket=new WebSocket(url);this.next=0;this.pending=new Map();this.listeners=[];this.ready=new Promise((resolve,reject)=>{this.socket.addEventListener('open',resolve,{once:true});this.socket.addEventListener('error',reject,{once:true});});this.socket.addEventListener('message',e=>{for(const x of [].concat(JSON.parse(String(e.data)))){if(x.id&&this.pending.has(x.id)){const {resolve,reject,t}=this.pending.get(x.id);clearTimeout(t);this.pending.delete(x.id);x.error?reject(new Error(JSON.stringify(x.error))):resolve(x.result);}for(const f of this.listeners)f(x);}});}
 async send(method,params={}){await this.ready;const id=++this.next;return new Promise((resolve,reject)=>{const t=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP timeout: '+method));},30000);this.pending.set(id,{resolve,reject,t});this.socket.send(JSON.stringify({id,method,params}));});}
 async evaluate(expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text+' '+(r.exceptionDetails.exception?.description??''));return r.result?.value;}
 close(){for(const {reject,t} of this.pending.values()){clearTimeout(t);reject(new Error('Owned CDP connection closed'));}this.pending.clear();this.socket.close();}
}

export const delay=ms=>new Promise(r=>setTimeout(r,ms));
export async function until(f,label,ms=60000){const end=Date.now()+ms;let last;while(Date.now()<end){try{const x=await f();if(x)return x;}catch(e){last=e;}await delay(100);}throw new Error(label+' timed out'+(last?': '+last.message:''));}
export function frameProgress(s,ordinal,callbackTime,observedAt){
 if(s.firstEligibleRafAt===undefined){s.firstEligibleRafAt=observedAt;s.firstFrameOrdinal=ordinal;s.firstFrameCallbackTime=callbackTime;}
 else if(ordinal>s.firstFrameOrdinal&&callbackTime>s.firstFrameCallbackTime&&s.laterEligibleRafAt===undefined){s.laterEligibleRafAt=observedAt;s.laterFrameOrdinal=ordinal;s.laterFrameCallbackTime=callbackTime;}
}
export function installFrameObservation(options,advance){
 window.__ownedFrameStop?.();
 const root=document.querySelector(options.rootSelector),composer=document.querySelector(options.composerSelector);
 if(!root||!composer)throw Error('Missing actual product transcript/composer');
 const s={nonce:options.text};window.__ownedFrame=s;let ordinal=0,row=null,intersecting=false,stopped=false;
 const io=new IntersectionObserver(entries=>{for(const e of entries)if(e.target===row){intersecting=e.isIntersecting&&e.intersectionRect.width>0&&e.intersectionRect.height>0;s.nativeIntersectionAt=performance.now();s.nativeIntersectionEntryTime=e.time;}},{root,threshold:0});
 const key=e=>{if(e.key!=='Enter'||e.shiftKey||s.enterAt!==undefined)return;s.enterAt=performance.now();s.enterTrusted=e.isTrusted;requestAnimationFrame(tick);};
 function tick(callbackTime){
  if(stopped)return;ordinal++;
  const current=Array.from(root.querySelectorAll(options.rowSelector)).find(n=>n.textContent.includes(options.text));
  if(current!==row){if(row)io.unobserve(row);row=current;intersecting=false;if(row)io.observe(row);}
  if(row&&row.isConnected&&intersecting){
   const r=row.getBoundingClientRect(),v=root.getBoundingClientRect(),c=composer.getBoundingClientRect(),style=getComputedStyle(row);
   const box={left:Math.max(0,r.left,v.left),right:Math.min(innerWidth,r.right,v.right),top:Math.max(0,r.top,v.top),bottom:Math.min(innerHeight,r.bottom,v.bottom,c.top)};
   if(box.right>box.left&&box.bottom>box.top&&style.visibility==='visible'&&style.display!=='none'){
    const hit=document.elementFromPoint((box.left+box.right)/2,(box.top+box.bottom)/2);
    if(hit&&row.contains(hit)){advance(s,ordinal,callbackTime,performance.now());s.ownerMessageId=row.getAttribute(options.idAttribute);s.ownerClientId=row.getAttribute('data-pending-send-client-id');s.visibleIntersection=box;}
   }
  }
  if(!s.laterEligibleRafAt&&performance.now()-s.enterAt<15000)requestAnimationFrame(tick);
 }
 document.addEventListener('keydown',key,true);
 window.__ownedFrameStop=()=>{stopped=true;document.removeEventListener('keydown',key,true);io.disconnect();};
 return true;
}
export async function assertOwnedInput(main,page,composerSelector){
 const frame=(await page.send('Page.getFrameTree')).frameTree.frame;
 const identity=await page.evaluate(`({url:location.href,document:window.__ownedDocumentIdentity,focused:document.hasFocus(),active:document.activeElement===document.querySelector(${JSON.stringify(composerSelector)})})`);
 assert.equal(frame.url,identity.url);assert(identity.document);assert.equal(identity.focused,true);assert.equal(identity.active,true);
 const actual=await main.evaluate(`({id:__ownedComparisonWindow.id,url:__ownedComparisonWindow.webContents.getURL(),focused:__ownedComparisonWindow.isFocused(),destroyed:__ownedComparisonWindow.isDestroyed(),frame:__ownedComparisonWindow.webContents.mainFrame.url})`);
 assert.equal(actual.destroyed,false);assert.equal(actual.focused,true);assert.equal(actual.url,frame.url);assert.equal(actual.frame,frame.url);
 return {frameId:frame.id,document:identity.document,url:frame.url,windowId:actual.id};
}
export async function installObservation(page,selectors,text){return page.evaluate(`(${installFrameObservation.toString()})(${JSON.stringify({...selectors,text})},${frameProgress.toString()})`);}
export async function requireLiveBottom(page,rootSelector){
 return until(()=>page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(rootSelector)});if(!e)return null;const distance=e.scrollHeight-e.clientHeight-e.scrollTop;return distance<=4?{distance,clientHeight:e.clientHeight}:null;})()`),'actual transcript at live bottom before Send');
}
export async function stopOwnedProcess(child,closed,main,page,log,{normalCloseOnly=false}={}){
 page?.close();main?.close();
 const result={processGroupDead:true,cleanupSignals:[]};
 if(child?.pid!==undefined){
  assert.notEqual(process.platform,'win32','Owned group cleanup requires POSIX');
  const groupAlive=()=>{try{process.kill(-child.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
  // A zero-exit leader is not proof its detached descendants have exited.
  // Normal close must fail before forced cleanup, preventing cold reopen.
  if(normalCloseOnly)assert.equal(groupAlive(),false,'Normal close left owned POSIX group alive');
  else for(const signal of ['SIGTERM','SIGKILL']){
   if(!groupAlive())break;
   try{process.kill(-child.pid,signal);result.cleanupSignals.push(signal);}catch(error){if(error.code!=='ESRCH')throw error;}
   const deadline=Date.now()+5000;while(groupAlive()&&Date.now()<deadline)await delay(25);
  }
  assert.equal(groupAlive(),false,'Owned POSIX group still present; keep profile for safe cleanup');
  if(child.exitCode===null&&child.signalCode===null)await Promise.race([closed,delay(5000).then(()=>{throw Error('Owned leader close unconfirmed; keep profile');})]);
 }
 await log?.close().catch(()=>{});return result;
}
export async function loadFixture(file){const f=JSON.parse(await readFile(file,'utf8'));assert.equal(f.contentSha256,createHash('sha256').update(JSON.stringify({turns:f.turns,sends:f.sends})).digest('hex'));assert.equal(f.turns.length,100);assert.equal(f.sends.length,3);for(const t of f.turns)for(const key of ['user','assistant'])assert.equal(Buffer.byteLength(t[key]),256);for(const t of f.sends)assert.equal(Buffer.byteLength(t),256);return f;}
export function makeFixture(){
 const body=(role,i)=>('Synthetic '+role+' '+i+'. '+'Fixture-only ordinary history. '.repeat(Math.ceil(256/30))).slice(0,256);
 const now=Date.now()-401000;
 const turns=Array.from({length:100},(_,i)=>({user:body('user',i),assistant:body('assistant',i),userAt:new Date(now+i*4000+1000).toISOString(),assistantAt:new Date(now+i*4000+2000).toISOString()}));
 const sends=Array.from({length:3},(_,i)=>body('ordinary Send comparison',100+i));
 return {synthetic:true,turns,sends,textBytes:51200,contentSha256:createHash('sha256').update(JSON.stringify({turns,sends})).digest('hex')};
}
if(import.meta.url===pathToFileURL(process.argv[1]).href){
 const s={};frameProgress(s,1,10,20);frameProgress(s,1,10,999);assert.equal(s.laterEligibleRafAt,undefined,'same rAF, advancing now, must not pass');frameProgress(s,2,10,1000);assert.equal(s.laterEligibleRafAt,undefined,'second callback with same frame timestamp must not pass');frameProgress(s,3,26,1001);assert.equal(s.laterEligibleRafAt,1001);assert(s.laterFrameOrdinal>s.firstFrameOrdinal);assert(s.laterFrameCallbackTime>s.firstFrameCallbackTime);
 if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(makeFixture())+'\n',{mode:0o600});
 console.log('Shared rAF same-frame negative checks passed; fixture is 100 turns / 200 messages, 256 UTF-8 bytes each.');
}
