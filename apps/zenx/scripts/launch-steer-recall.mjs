/** Launch only the owned synthetic Electron App on disposable native CI. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { contentFromUserMessage } from "../../../dist/src/item.js";
import { DomainThreadJournal } from "../../../dist/src/domain-journal.js";
import { FileTraceStore } from "../../../dist/src/trace.js";
import { JsonlThreadMetadataStore } from "../../../dist/src/thread-metadata.js";
import { seedLongThread } from "./long-thread-domain-seed.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.ok(["win32", "darwin"].includes(process.platform));
const directory = path.resolve(process.argv[2]);
const version = "current";
const count = Number(process.argv[3]);
assert.equal(count,0);
const sourceLabel = process.argv[4] ?? "pending";
assert.equal(sourceLabel,"pending");
const pairCase = process.argv[5];
assert.ok(["recall-wins","claim-wins","navigation","lost-reply"].includes(pairCase));
const hostSnapshot=()=>({platform:os.platform(),release:os.release(),arch:os.arch(),cpuModel:os.cpus()[0]?.model,cpuCount:os.cpus().length,loadAverage:os.loadavg(),freeMemoryBytes:os.freemem(),totalMemoryBytes:os.totalmem(),uptimeSeconds:os.uptime()});
const hostBefore=hostSnapshot();
const expected = {
  baseline:"6aa0a5055530eeb018cc41a3ce486603756c06bb",
  pending:"279f84ff35c68979a55f35c5322c941235dff7be",
  frontend:"3819977ddd2da5698bcbee2c14fd8165f9934009",
  backend:"8e036167d864ae5d452dccc411970352ce26e433",
  combined:"a8c7615b11b3a8f63c4d251a6fe5da5b82e13f09",
}[sourceLabel];
assert.ok(expected,"Only independently identified source snapshots are allowed");
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  expected,
);
const instrumentedPath="apps/zenx/src/main/app-server-host.ts";
assert.equal(execFileSync("git",["diff","--name-only","HEAD"],{encoding:"utf8"}).trim(),instrumentedPath,"Only explicit diagnostic child instrumentation allowed");
const baseHost=execFileSync("git",["show","HEAD:"+instrumentedPath],{encoding:"utf8"});
const expectedHost='import { installSyntheticSteerGate } from "./synthetic-steer-gate.js";\n'+baseHost.replace('process.on("message",','installSyntheticSteerGate();\n\nprocess.on("message",');
assert.equal(await readFile(instrumentedPath,"utf8"),expectedHost,"Exact source-bound diagnostic-only instrumentation, never unmodified baseline");
await mkdir(directory, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), "zenx-owned-full-app-"));
const profile = path.join(temporary, "profile"),
  data = path.join(temporary, "zen-data"),
  home = path.join(temporary, "home"),
  workspace = path.join(temporary, "workspace");
for (const d of [profile, data, home, workspace, path.join(home, "Documents")])
  await mkdir(d, { recursive: true, mode: 0o700 });
await writeFile(
  path.join(profile, "host-profile.json"),
  JSON.stringify({
    version: 3,
    onboardingComplete: true,
    providerProfiles: [{type:"fake", displayName:"Synthetic local only",providerProfileId:"fake",models:[{id:"fake",displayName:"fake",description:"Offline ordinary-send baseline",hidden:false,source:"manual",supportedReasoningEfforts:["medium"],defaultReasoningEffort:"medium",inputModalities:["text"],contextWindow:100000000}]}],
    defaultModel: {providerProfileId:"fake",modelId:"fake"},
    titleModel: {providerProfileId:"fake",modelId:"fake"},
    workspace,
    workspaces: [workspace],
    lastUsedWorkspace: workspace,
    approvalPolicy: "never",
  }),
);
await seedLongThread({isolationRoot:temporary,dataDirectory:data,workspace,userMessageCount:count,providerProfileId:"fake",modelId:"fake"});
const root = fileURLToPath(new URL("../", import.meta.url));
const hashes = {};
const rendererFiles = (
  await readdir(path.join(root, "out/renderer"), { recursive: true })
)
  .filter((f) => /\.(html|js|css)$/.test(f))
  .sort()
  .map((f) => "out/renderer/" + f);
for (const file of [
  ...rendererFiles,
  "out/main/index.js",
  "out/main/app-server-host.js",
  "out/preload/index.cjs",
  "src/renderer/src/main.tsx",
  "src/renderer/src/App.tsx",
  "src/renderer/src/auxiliary-panel.tsx",
  "scripts/capture-steer-recall.cjs",
  "scripts/launch-steer-recall.mjs",
  "scripts/long-thread-domain-seed.mjs",
  "src/main/app-server-host.ts",
  "src/main/synthetic-steer-gate.ts",
])
  hashes[file] = createHash("sha256")
    .update(await readFile(path.join(root, file)))
    .digest("hex");
await writeFile(
  path.join(directory, "full-app-source.json"),
  JSON.stringify(
    {
      version,
      sourceCommit: expected,
      comparisonRole:"explicitly-instrumented-owned-Host-diagnostic-not-acceptance",
      priorUserMessages:count,
      priorCompletedTurns:count,
      visibleHistoricalMessages:count*2,
      fixtureContextWindow:100000000,
      platform:process.platform,
      hashes,
      scope:"Actual production App/native Send and Recall with test-only owned fake-provider stream gates. No synthetic protocol receipt or UI rows. Functional correctness, not performance acceptance.",
    },
    null,
    2,
  ),
);
// Do not pass inherited provider/auth environment variables to the owned App.
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(HOME|USERPROFILE|USER_HOME|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|XDG_CONFIG_HOME|XDG_CACHE_HOME)$/i.test(
        key,
      ) &&
      (key === "XAUTHORITY" || // Owned Xvfb cookie, required for this isolated display.
        !/(OPENAI|ANTHROPIC|GEMINI|GOOGLE_API|AZURE|CODEX|AUTH|TOKEN|SECRET|PASSWORD|ZENX_|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|ELECTRON_EXTRA_LAUNCH_ARGS|NODE_OPTIONS)/i.test(
          key,
        )),
  ),
);
Object.assign(environment, {
  HOME: home,
  ...(process.platform === "win32"
    ? {
        USERPROFILE: home,
        USER_HOME: home,
        HOMEDRIVE: path.parse(home).root.slice(0, 2),
        HOMEPATH: home.slice(2),
        APPDATA: path.join(home, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(home, "AppData", "Local"),
      }
    : {}),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  ZENX_DATA_DIR: data,
  GITHUB_ACTIONS: "true",
  SYNTHETIC_RECALL_CASE: pairCase,
});
if (process.platform === "win32") {
  await mkdir(environment.APPDATA, { recursive: true });
  await mkdir(environment.LOCALAPPDATA, { recursive: true });
}
const child = spawn(
  electron,
  [
    path.join(root, "scripts/capture-steer-recall.cjs"),
    directory,
    version,
    temporary,
    `--user-data-dir=${profile}`,
  ],
  {
    env: environment,
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform === "darwin",
  },
);
// The generic helper kills only the parent; Windows must terminate the owned tree on timeout.
async function waitOwnedWindowsTree(child, timeoutMs) {
  let closed = false;
  const terminal = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      closed = true;
      resolve(code);
    });
  });
  let timer;
  try {
    return await Promise.race([
      terminal,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Owned Electron diagnostic timed out")),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    if (
      !closed &&
      child.exitCode === null &&
      child.signalCode === null &&
      child.pid !== undefined
    ) {
      // PID is from our still-live ChildProcess, never process-name-wide termination.
      execFileSync(
        path.join(
          process.env.SystemRoot ?? process.env.SYSTEMROOT,
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        { timeout: 5000, windowsHide: true, stdio: "ignore" },
      );
      let closeTimer;
      try {
        await Promise.race([
          terminal,
          new Promise((_, reject) => {
            closeTimer = setTimeout(
              () => reject(new Error("Owned tree exit unconfirmed")),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(closeTimer);
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
// macOS child owns a new POSIX process group (detached:true above).
// Never target another process name/session or weaken Chromium's sandbox.
async function waitOwnedPosixGroup(child, timeoutMs) {
  const terminal = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const within = async (ms) => {
    let deadline;
    try {
      return await Promise.race([
        terminal,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Owned POSIX group exit timeout")),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  };
  const signalGroup = (signal) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  try {
    return await within(timeoutMs);
  } catch (error) {
    if (
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      throw error;
    signalGroup("SIGTERM");
    try {
      await within(5000);
    } catch {
      signalGroup("SIGKILL");
      await within(5000);
    }
    // Parent close alone does not prove the group's remaining descendants exited.
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 0);
        signalGroup("SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    throw error;
  }
}
let cleanupSafe = false;
let observedClose;
child.once("close", (code, signal) => {
  observedClose = { code, signal };
});
try {
  const code = await (
    process.platform === "win32" ? waitOwnedWindowsTree : waitOwnedPosixGroup
  )(child, count===5000?600000:240000);
  assert.equal(code, 0, "Owned full App diagnostic must pass");
  const result = JSON.parse(
    await readFile(path.join(directory, "full-app-measurements.json"), "utf8"),
  );
  assert.equal(result.ok, true);

  assert.equal(result.caseId,pairCase);
  const trace=new FileTraceStore(path.join(data,"trace"));
  const journal=new DomainThreadJournal({directory:path.join(data,"threads"),trace,metadata:new JsonlThreadMetadataStore(path.join(data,"thread-metadata.jsonl")),access:"read-only"});
  let persisted;
  try{
   const facts=await journal.read(result.threadId),semantic=await journal.readItemList(result.threadId);
   const observed=await trace.read(result.threadId,{verifyArtifacts:false});
   assert.equal(observed.completeness,"complete");
   assert.equal(facts.filter(i=>i.type==="context_compaction").length,0);
   assert.equal(observed.records.filter(r=>["context_compaction_started","context_compaction_sample","context_compaction_finished"].includes(r.type)).length,0);
   const queued=facts.filter(i=>i.type==="user_message_queued");
   assert.equal(queued.length,2);
   for(const [index,record] of result.sends.entries()){
    const canonical=facts.filter(i=>i.type==="user_message"&&i.clientId===record.params.clientUserMessageId);
    const expectedCount=pairCase!=="claim-wins"&&index>0?0:1;
    assert.equal(canonical.length,expectedCount);
    if(index>0){const q=queued.filter(i=>i.clientId===record.params.clientUserMessageId);assert.equal(q.length,1);assert.equal(q[0].deliveryMode,"steer");assert.equal(q[0].expectedTurnId,result.turnId);assert.equal(semantic.filter(i=>i.id===q[0].id).length,0);}
    for(const item of canonical){assert(contentFromUserMessage(item).some(p=>p.type==="text"&&p.text===result.nonces[index]));assert.equal(semantic.filter(i=>i.id===item.id).length,1);}
   }
   const recalls=facts.filter(i=>i.type==="user_message_steer_recalled");
   assert.equal(recalls.length,pairCase!=="claim-wins"?1:0);
   if(pairCase!=="claim-wins"){
    assert.equal(recalls[0].id,(result.recall.realHandlerReceipt??result.recall.receipt).receipt.id);
    assert.deepEqual(recalls[0].targets,result.recall.params.targets);
    assert.equal(semantic.filter(i=>i.id===recalls[0].id).length,0);
    assert(!JSON.stringify(semantic).includes(result.nonces[1])&&!JSON.stringify(semantic).includes(result.nonces[2]),"withdrawn nonces never semantic model history");
    assert.equal(result.finalDraft,result.nonces[1]+"\n\n"+result.nonces[2]+"\n\n"+result.newerDraft);
   }else assert.equal(result.finalDraft,result.newerDraft);
   assert.equal(facts.filter(i=>i.type==="turn_completed"&&i.turnId===result.turnId&&i.status==="completed").length,1);
   persisted={independentReopen:true,queued:2,canonicalUserMessages:facts.filter(i=>i.type==="user_message").length,recallFacts:recalls.length,semanticItems:semantic.length,traceCompleteness:observed.completeness,compactionFacts:0,compactionAttempts:0};
  }finally{await journal.close();await trace.flush();}
  await writeFile(path.join(directory,"independent-storage-verification.json"),JSON.stringify(persisted,null,2));
  console.log("SYNTHETIC_STEER_RECALL_VERIFIED_JSON "+JSON.stringify({sourceCommit:expected,caseId:pairCase,diagnosticProviderGate:true,notPerformanceAcceptance:true,provider:result.provider,recallRequest:result.recall.params,recallResult:result.recall.receipt,realHandlerReceipt:result.recall.realHandlerReceipt,replyDelivered:result.recall.receipt!==undefined,recoveryReads:result.recoveryReads,recoveryCheckpoint:result.lostReplyRecoveryCheckpoint,scenario:pairCase==="lost-reply"?"durable recall reply and first automatic read reply both lost; explicit Check succeeds":pairCase,persisted,noAutomaticResend:result.ipc.filter(r=>r.method==="zen/turn/send").length===3}));
  cleanupSafe = true; // Successful production before-quit awaits stopZenXHost.
} finally {
  try { const report=JSON.parse(await readFile(path.join(directory,"full-app-measurements.json"),"utf8")); if(!report.ok)console.error("SYNTHETIC_SEND_FAILURE_JSON "+JSON.stringify(report)); } catch {}
  await writeFile(
    path.join(directory, "full-app-lifecycle.json"),
    JSON.stringify(
      {
        childCloseObserved: observedClose !== undefined,
        exitCode: observedClose?.code ?? null,
        signal: observedClose?.signal ?? null,
        captureValidated: cleanupSafe,
        privateFixturePolicy: cleanupSafe
          ? "remove after validated normal close"
          : "retained conservatively; not uploaded",
      },
      null,
      2,
    ),
  );
  if (cleanupSafe) await rm(temporary, { recursive: true, force: true });
  else
    console.error(
      observedClose !== undefined
        ? `Owned Electron close confirmed (${JSON.stringify(observedClose)}); capture validation failed; private fixture retained conservatively, not uploaded`
        : "Owned diagnostic process exit unconfirmed; private fixture retained, not uploaded",
    );
}
