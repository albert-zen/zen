import assert from "node:assert/strict";
import { lstat, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DomainThreadJournal } from "../../../dist/src/domain-journal.js";
import { FileTraceStore } from "../../../dist/src/trace.js";
import { JsonlThreadMetadataStore } from "../../../dist/src/thread-metadata.js";

export async function seedLongThread({ isolationRoot, dataDirectory, workspace, userMessageCount, providerProfileId, modelId, textLength = 256 }) {
  assert([0, 1000, 5000].includes(userMessageCount));
  assert(Number.isSafeInteger(textLength) && textLength >= 32 && textLength <= 4096);
  assert(typeof providerProfileId === "string" && providerProfileId.length > 0);
  assert(typeof modelId === "string" && modelId.length > 0);
  const root = await realpath(isolationRoot), data = await realpath(dataDirectory), cwd = await realpath(workspace);
  for (const candidate of [data,cwd]) {
    const relative=path.relative(root,candidate);
    assert(relative!==""&&!relative.startsWith("..")&&!path.isAbsolute(relative),"Fixture paths below isolated root");
  }
  const directory=path.join(data,"threads");
  await assert.rejects(lstat(directory),{code:"ENOENT"});
  const threadId="synthetic-send-"+userMessageCount;
  const trace=new FileTraceStore(path.join(data,"trace"));
  const metadata=new JsonlThreadMetadataStore(path.join(data,"thread-metadata.jsonl"));
  const journal=new DomainThreadJournal({directory,trace,metadata});
  const instant=offset=>new Date(Date.UTC(2026,0,1)+offset*1000).toISOString();
  const selection={providerProfileId,modelId,reasoningEffort:null};
  const items=[{id:threadId+"-metadata",threadId,createdAt:instant(0),type:"thread_metadata",cwd,...selection,sandbox:"danger-full-access",approvalPolicy:"never"}];
  const body=(role,index)=>("Synthetic "+role+" "+index+". "+"Fixture-only ordinary history. ".repeat(Math.ceil(textLength/30))).slice(0,textLength);
  for(let index=0;index<userMessageCount;index++){
    const turnId=threadId+"-turn-"+index,common={threadId,turnId};
    items.push(
      {...common,id:turnId+"-started",createdAt:instant(index*4+1),type:"turn_started",selection},
      {...common,id:turnId+"-user",createdAt:instant(index*4+2),type:"user_message",clientId:turnId+"-client",content:[{type:"text",text:body("user",index)}],receiptTimezone:{timeZone:"UTC",source:"client"}},
      {...common,id:turnId+"-assistant",createdAt:instant(index*4+3),type:"agent_message",text:body("assistant",index)},
      {...common,id:turnId+"-completed",createdAt:instant(index*4+4),type:"turn_completed",status:"completed"}
    );
  }
  const started=performance.now();let semanticCount;
  try {
    await journal.create(items);
    await metadata.setName(threadId,"Synthetic ordinary send: "+userMessageCount+" prior user messages");
    const facts=await journal.read(threadId);
    assert.equal(facts.length,1+4*userMessageCount);
    assert.equal(facts.filter(i=>i.type==="user_message").length,userMessageCount);
    assert.equal(facts.filter(i=>i.type==="turn_completed").length,userMessageCount);
    semanticCount=(await journal.readItemList(threadId)).length;
    const observed=await trace.read(threadId,{verifyArtifacts:false});
    assert.equal(observed.completeness,"complete");
    assert.equal(observed.records.filter(r=>r.type==="runtime_item").length,facts.length);
  } finally {await journal.close();await trace.flush();}
  const manifest={synthetic:true,storage:"production DomainThreadJournal + FileTraceStore + FileItemListStore",threadId,userMessageCount,completedTurnCount:userMessageCount,visibleMessageCount:userMessageCount*2,canonicalItemCount:items.length,semanticCount,textLength,totalMessageTextBytes:userMessageCount*textLength*2,itemListBytes:(await stat(path.join(directory,"items",threadId+".jsonl"))).size,seedMs:performance.now()-started,seedTimingExcludedFromSend:true};
  await writeFile(path.join(isolationRoot,"seed-manifest.json"),JSON.stringify(manifest,null,2)+"\n");
  return manifest;
}
