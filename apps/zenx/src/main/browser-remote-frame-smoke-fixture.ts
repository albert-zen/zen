import assert from "node:assert/strict";

export const remoteFrameModes = [
  "cross-origin-same-process",
  "cross-origin-oopif",
  "nested-oopif",
  "nested-same-process",
] as const;
export type RemoteFrameMode = (typeof remoteFrameModes)[number];
export function isRemoteFrameMode(
  value: string | null,
): value is RemoteFrameMode {
  return remoteFrameModes.some((mode) => mode === value);
}
export interface RemoteFrameFixture {
  mode: RemoteFrameMode;
  parentOrigin: string;
  childOrigin: string;
  nonce: string;
  leafOrigin?: string;
  outerAffine?: "true";
}

/** Fixed synthetic commands only; neither side accepts code from postMessage. */
export function remoteFrameContractPage(
  role: "parent" | "child",
  fixture: RemoteFrameFixture,
): string {
  for (const origin of [
    fixture.parentOrigin,
    fixture.childOrigin,
    ...(fixture.leafOrigin ? [fixture.leafOrigin] : []),
  ]) {
    const url = new URL(origin);
    assert.ok(
      url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "nested.localhost"].includes(url.hostname) &&
        url.origin === origin,
      "Remote frame fixtures must use exact disposable loopback origins",
    );
  }
  assert.notEqual(fixture.parentOrigin, fixture.childOrigin);
  assert.match(fixture.nonce, /^[a-f0-9-]{36}$/u);
  assert.ok(isRemoteFrameMode(fixture.mode));
  const config = JSON.stringify(fixture).replaceAll("<", "\\u003c");
  if (role === "child" && fixture.leafOrigin) {
    const leafUrl = new URL("/remote-frame-child", fixture.leafOrigin);
    for (const [key, value] of Object.entries({
      ...fixture,
      parentOrigin: fixture.childOrigin,
      childOrigin: fixture.leafOrigin,
      leafOrigin: "",
    }))
      leafUrl.searchParams.set(key, value);
    return `<!doctype html><meta charset="utf-8"><title>ZenX nested frame owner</title>
<style>body{margin:0}iframe{position:absolute;display:block;left:40px;top:50px;width:400px;height:300px;border:3px solid #573;padding:2px}</style>
<script>
const config=${config},documentId=crypto.randomUUID(),pending=new Map(),frame=document.createElement('iframe');
frame.id='nested-contract-frame';
window.addEventListener('message',event=>{
  const message=event.data;
  if(!message||message.nonce!==config.nonce)return;
  if(event.source===parent&&event.origin===config.parentOrigin&&message.kind==='request'&&Number.isSafeInteger(message.id)&&message.id>0){
    if(!['state','focus','point','mutate','armReplace'].includes(message.method)||pending.size>=32||pending.has(message.id))return;
    const timer=setTimeout(()=>pending.delete(message.id),5000);pending.set(message.id,{method:message.method,timer});
    frame.contentWindow.postMessage(message,config.leafOrigin);return;
  }
  if(event.source!==frame.contentWindow||event.origin!==config.leafOrigin)return;
  if(message.kind==='ready'){parent.postMessage({kind:'ready',nonce:config.nonce,documentId},config.parentOrigin);return}
  if(message.kind!=='reply')return;
  const request=pending.get(message.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timer);
  let result=message.result;
  // Independent forward oracle for this authored owner: known offset, border,
  // and padding. Never derive expected coordinates from provider geometry.
  if(request.method==='point'){const x=result.x+40+3+2,y=result.y+50+3+2,r=frame.getBoundingClientRect();result={...result,x,y,owners:[{id:frame.id,left:r.left,top:r.top,width:r.width,height:r.height,hitId:document.elementFromPoint?.(x,y)?.id||'',scrollX,scrollY},...(result.owners||[])]}}
  if(request.method==='state')result={...result,ownerDocuments:[documentId,...(result.ownerDocuments||[])]};
  parent.postMessage({kind:'reply',nonce:config.nonce,id:message.id,result},config.parentOrigin);
});
frame.src=${JSON.stringify(leafUrl.href)};document.documentElement.append(frame);
</script>`;
  }
  if (role === "child")
    return `<!doctype html><meta charset="utf-8"><title>ZenX remote child fixture</title>
<style>body{margin:0;min-height:900px}canvas,input{position:absolute;box-sizing:border-box;left:0}canvas{top:0;background:#acf}input{width:190px;height:32px}#text-a{top:90px}#text-b{top:140px}</style>
<canvas id="canvas" tabindex="0" width="200" height="60"></canvas><input id="text-a"><input id="text-b">
<script>
const config=${config},events=[],routeEvents=[];let clicks=0,replaceOnPress=false,documentId=crypto.randomUUID();
const node=id=>['canvas','text-a','text-b'].includes(id)?document.getElementById(id):null;
const witness=event=>{
  events.push({type:event.type,trusted:event.isTrusted,target:event.target.id});
  if(event.type==='pointerdown'&&event.isTrusted&&replaceOnPress){
    replaceOnPress=false;
    const body='<canvas id="canvas" tabindex="0" width="200" height="60"></canvas><input id="text-a"><input id="text-b">';
    document.open();document.write('<!doctype html><body>'+body+'</body>');document.close();documentId=crypto.randomUUID();bind();node('text-b').focus({preventScroll:true});
  }
};
const bind=()=>{
  for(const type of ['pointermove','pointerdown','pointerup','mousemove','mousedown','mouseup','click','keydown','keyup'])window.addEventListener(type,event=>routeEvents.push({type:event.type,trusted:event.isTrusted,target:event.target.id||event.target.localName,clientX:event.clientX,clientY:event.clientY}),true);
  for(const type of ['pointerdown','pointerup','keydown','keyup'])window.addEventListener(type,witness,true);
  window.addEventListener('message',receive);
  node('canvas').onclick=event=>{if(!event.isTrusted)throw Error('Untrusted fixture click');clicks++;event.currentTarget.focus({preventScroll:true})};
};
const viewport=()=>({width:innerWidth,height:innerHeight,scrollX,scrollY});
const state=()=>({mode:config.mode,documentId,viewport:viewport(),routeEvents:[...routeEvents],events:[...events],clicks,widgets:{},values:{'text-a':node('text-a').value,'text-b':node('text-b').value},inner:document.activeElement?.id,visibility:document.visibilityState});
const receive=event=>{
  const message=event.data;
  if(event.source!==parent||event.origin!==config.parentOrigin||!message||message.nonce!==config.nonce||message.kind!=='request'||!Number.isSafeInteger(message.id)||message.id<1)return;
  let result;
  if(message.method==='state')result=state();
  else if(message.method==='focus'&&node(message.argument)){node(message.argument).focus({preventScroll:true});result={inner:document.activeElement?.id}}
  else if(message.method==='point'&&node(message.argument)){const r=node(message.argument).getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;result={x,y,localPoint:{x,y},childViewport:viewport(),documentId,hitId:document.elementFromPoint?.(x,y)?.id||'',owners:[]}}
  else if(message.method==='mutate'){node('text-a').style.marginLeft='8px';result=state()}
  else if(message.method==='armReplace'){replaceOnPress=true;result={armed:true}}
  else return;
  parent.postMessage({kind:'reply',nonce:config.nonce,id:message.id,result},config.parentOrigin);
};
// Initial OOPIF focus can precede its viewport. Fixture focus must not scroll
// the authored canvas out of view; this is setup, never repair after input.
bind();node('text-a').focus({preventScroll:true});
parent.postMessage({kind:'ready',nonce:config.nonce,documentId},config.parentOrigin);
</script>`;
  const childUrl = new URL("/remote-frame-child", fixture.childOrigin);
  for (const [key, value] of Object.entries(fixture))
    childUrl.searchParams.set(key, value);
  return `<!doctype html><meta charset="utf-8"><title>ZenX remote frame contract</title>
<style>body{margin:0}iframe{position:absolute;display:block;left:20px;top:20px;width:620px;height:480px;border:5px solid #345;padding:11px 7px}</style>
<script>
const config=${config},childUrl=${JSON.stringify(childUrl.href)},pending=new Map(),rootEvents=[];
for(const type of ['pointermove','pointerdown','pointerup','mousemove','mousedown','mouseup','click','keydown','keyup'])window.addEventListener(type,event=>rootEvents.push({type:event.type,trusted:event.isTrusted,target:event.target.id||event.target.localName,clientX:event.clientX,clientY:event.clientY}),true);
const frame=document.createElement('iframe');frame.id='contract-frame';
let sequence=0,revision=0,ready=false,reflected=false;
const cosine=0.9659258262890683,sine=0.25881904510252074;
const applyAffine=()=>{frame.style.transform='matrix('+[cosine,reflected?-sine:sine,reflected?sine:-sine,cosine,0,0].join(',')+')'};
if(config.outerAffine){frame.style.left='100px';frame.style.top='90px';frame.style.transformOrigin='322px 256px';applyAffine()}
window.addEventListener('message',event=>{
  const message=event.data;
  if(event.source!==frame.contentWindow||event.origin!==config.childOrigin||!message||message.nonce!==config.nonce)return;
  if(message.kind==='ready'){ready=true;return}
  if(message.kind!=='reply'||!Number.isSafeInteger(message.id))return;
  const request=pending.get(message.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timer);request.resolve(message.result);
});
const request=(method,argument)=>new Promise((resolve,reject)=>{
  if(!ready){reject(Error('Remote fixture not ready'));return}
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Remote fixture response deadline'))},5000);
  pending.set(id,{resolve,reject,timer});frame.contentWindow.postMessage({kind:'request',nonce:config.nonce,id,method,argument},config.childOrigin);
});
window.contract={mode:config.mode,get ready(){return ready},
  async state(){const child=await request('state');return {...child,childVisibility:child.visibility,rootEvents:[...rootEvents],visibility:document.visibilityState,outer:document.activeElement?.id}},
  async focus(id){return {...await request('focus',id),outer:document.activeElement?.id}},
  async point(id){const point=await request('point',id);let x=point.x+20+5+7,y=point.y+20+5+11;
    // Authored forward matrix only: no provider inverse, native quad or AABB.
    if(config.outerAffine){const localX=point.x+12-322,localY=point.y+16-256,angle=reflected?-sine:sine;x=100+322+cosine*localX-angle*localY;y=90+256+angle*localX+cosine*localY}
    const r=frame.getBoundingClientRect();return {...point,x,y,...(config.outerAffine?{outerAffine:true,reflected}:{}),owners:[{id:frame.id,left:r.left,top:r.top,width:r.width,height:r.height,hitId:document.elementFromPoint?.(x,y)?.id||'',scrollX,scrollY},...(point.owners||[])]}},
  flipTransform(){if(!config.outerAffine)throw Error('Affine remote fixture required');const before=frame.getBoundingClientRect().toJSON();reflected=!reflected;applyAffine();return {before,after:frame.getBoundingClientRect().toJSON()}},
  mutate(){return request('mutate')},
  armReplace(){return request('armReplace')},
  reopenFrame(){ready=false;frame.src=childUrl+'&revision='+(++revision)}
};
frame.src=childUrl;document.documentElement.append(frame);
</script>`;
}

export function remoteFrameFixtureFromUrl(
  requestUrl: string,
): RemoteFrameFixture {
  const query = new URL(requestUrl, "http://127.0.0.1").searchParams;
  const mode = query.get("mode");
  assert.ok(isRemoteFrameMode(mode));
  return {
    mode,
    parentOrigin: query.get("parentOrigin") ?? "",
    childOrigin: query.get("childOrigin") ?? "",
    nonce: query.get("nonce") ?? "",
    ...(query.get("outerAffine") === "true"
      ? { outerAffine: "true" as const }
      : {}),
    ...(query.get("leafOrigin")
      ? { leafOrigin: query.get("leafOrigin")! }
      : {}),
  };
}
