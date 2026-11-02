import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [variant, expectedSha, outputArgument] = process.argv.slice(2);
assert.ok(["baseline", "candidate"].includes(variant));
assert.match(expectedSha, /^[0-9a-f]{40}$/);
const root = process.cwd();
const output = path.resolve(outputArgument);
await mkdir(output, { recursive: true });
const head = spawnSync("git", ["rev-parse", "HEAD"], {encoding:"utf8"});
assert.equal(head.status,0);
assert.equal(head.stdout.trim(), expectedSha);
const reporter = path.join(output, "proof-reporter.mjs");
await writeFile(reporter, `
function errorDetails(error, depth=0) {
  if (!error || depth>4) return undefined;
  return {name:error.name, message:error.message, code:error.code,
    failureType:error.failureType, operator:error.operator,
    actual:error.actual, expected:error.expected,
    cause:errorDetails(error.cause,depth+1)};
}
export default async function* report(source) {
  for await (const event of source) {
    if(event.type==="test:pass"||event.type==="test:fail")
      yield JSON.stringify({type:event.type,name:event.data.name,
        skip:!!event.data.skip,todo:!!event.data.todo,
        error:errorDetails(event.data.details?.error)})+"\\n";
    else if(event.type==="test:diagnostic")
      yield JSON.stringify({type:event.type,message:event.data.message})+"\\n";
  }
}
`);
const outcomes = [];
async function run(name, cwd, args, expectedNames, expectedFailures, validateFailure) {
  const result = spawnSync(process.execPath,
    [...args.prefix, "--test", "--test-reporter="+pathToFileURL(reporter).href,
      ...args.tests], {cwd,encoding:"utf8",timeout:180000,maxBuffer:32*1024*1024});
  await writeFile(path.join(output,name+".events.jsonl"),result.stdout??"");
  await writeFile(path.join(output,name+".stderr.log"),result.stderr??"");
  console.log(JSON.stringify({suite:name,exitCode:result.status,signal:result.signal}));
  console.log(result.stdout??"");
  if(result.stderr) console.error(result.stderr);
  assert.equal(result.error,undefined,name+" must execute without spawn/timeout error");
  assert.equal(result.signal,null,name+" must exit normally");
  assert.equal(result.status,expectedFailures.length?1:0,name+" expected test exit");
  const events=(result.stdout??"").split("\n").filter(Boolean).map(line=>JSON.parse(line));
  const tests=events.filter(e=>["test:pass","test:fail"].includes(e.type)&&!e.skip);
  assert.deepEqual(tests.map(e=>e.name).sort(),[...expectedNames].sort(),name+" exact executed tests; no import/file crash or missing tests");
  assert.ok(tests.every(e=>!e.todo),name+" no TODO allowance");
  const failures=tests.filter(e=>e.type==="test:fail");
  assert.deepEqual(failures.map(e=>e.name).sort(),[...expectedFailures].sort(),name+" only intended regressions may fail");
  for(const event of failures){
    const chain=[];for(let e=event.error;e;e=e.cause)chain.push(e);
    const assertion=chain.find(e=>e.code==="ERR_ASSERTION");
    assert.ok(assertion,name+" failure must be a real assertion");
    validateFailure(event.name,assertion);
  }
  outcomes.push({name,exitCode:result.status,tests,diagnostics:events.filter(e=>e.type==="test:diagnostic")});
}
const backendNames=[
  "compiled 32-turn history does not copy context per lifecycle fact",
  "compiled 128-turn history does not copy context per lifecycle fact",
  "reconciliation restores a missing semantic suffix with exact source output",
  "frozen imported semantic sources remain exact and conflicts still fail closed",
];
await run("domain",root,{prefix:[],tests:["dist/test/domain-reconciliation-performance.test.js"]},
  backendNames,variant==="baseline"?backendNames.slice(0,2):[],(name,error)=>{
    const turns=name.includes("32-turn")?32:128;
    assert.equal(error.operator,"==");
    assert.equal(error.actual,false);
    assert.equal(error.expected,true);
    assert.equal(error.message,"context iteration must be linear: "+(2*turns*(2*turns+1))+" for "+(2*turns)+" items");
  });
const componentName="long-history composer renders do not scan canonical history once per turn";
await run("component",path.join(root,"apps/zenx"),
  {prefix:["--import","tsx"],tests:["--test-name-pattern=^"+componentName+"$","test/thread-view-component.test.ts"]},
  [componentName],variant==="baseline"?[componentName]:[],(_name,error)=>{
    const match=/^Expected bounded linear canonical reads, got (\d+) for 160 turns$/.exec(error.message);
    assert.ok(match,"Only the canonical scan assertion is an acceptable RED");
    assert.ok(Number(match[1])>=51200,"Old full per-turn scans must actually execute");
    assert.equal(error.actual,false);assert.equal(error.expected,true);assert.equal(error.operator,"==");
  });
if(variant==="candidate")
  await run("outcome-index",path.join(root,"apps/zenx"),
    {prefix:["--import","tsx"],tests:["test/turn-outcome-index.test.ts"]},
    ["outcome lookup exactly preserves some/findLast semantics and item identity",
     "outcome indexing visits each item once and per-turn lookups never rescan history"],[],()=>{});
const proof={schemaVersion:1,kind:"synthetic operation-count regression proof, not native latency",
  variant,sourceSha:expectedSha,ok:true,outcomes};
await writeFile(path.join(output,"proof.json"),JSON.stringify(proof,null,2)+"\n");
console.log(JSON.stringify(proof,null,2));
