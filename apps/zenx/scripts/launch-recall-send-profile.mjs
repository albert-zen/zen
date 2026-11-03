/** Launch only the owned synthetic Electron App on disposable native CI. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  open,
  copyFile,
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
import { packageZenX } from "./package-zenx-portable.mjs";
import { seedLongThread, verifyLongThread } from "./long-thread-domain-seed.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.platform, "darwin");
const uploadDirectory = path.resolve(process.argv[2]);
const version = "current";
const count = Number(process.argv[3]);
assert.equal(count,5000);
const sourceLabel = process.argv[4] ?? "baseline";
assert.equal(process.argv[5],undefined,"Exactly one fixed diagnostic configuration");
const hostSnapshot=()=>({platform:os.platform(),release:os.release(),arch:os.arch(),cpuModel:os.cpus()[0]?.model,cpuCount:os.cpus().length,loadAverage:os.loadavg(),freeMemoryBytes:os.freemem(),totalMemoryBytes:os.totalmem(),uptimeSeconds:os.uptime()});
const hostBefore=hostSnapshot();
const expected = { profile:"9188f8e915f25ae4d693fae43ad5b8350282a87f" }[sourceLabel];
assert.ok(expected,"Only independently identified source snapshots are allowed");
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  expected,
);
assert.equal(execFileSync("git",["rev-parse","HEAD^{tree}"],{encoding:"utf8"}).trim(),"dcd68b25656bf34e059382c2b461bd87a9355ceb");
assert.equal(execFileSync("git",["diff","--name-only","HEAD"],{encoding:"utf8"}).trim(),"","Tracked production checkout must be unchanged");
await mkdir(uploadDirectory, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), "zenx-owned-full-app-"));
const directory=path.join(temporary,"measurements");
await mkdir(directory,{mode:0o700});
const privateLog=await open(path.join(temporary,"native-process.log"),"wx",0o600);
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
  "out/preload/index.cjs",
  "src/renderer/src/main.tsx",
  "src/renderer/src/App.tsx",
  "src/renderer/src/auxiliary-panel.tsx",
  "scripts/capture-send-feedback.cjs",
  "scripts/launch-send-feedback.mjs",
  "scripts/long-thread-domain-seed.mjs",
  "scripts/summarize-send-timeline.cjs",
])
  hashes[file] = createHash("sha256")
    .update(await readFile(path.join(root, file)))
    .digest("hex");
// Reuse the normal signed portable packager. Only the private acceptance app's
// entry is redirected to our observer; production main/preload/renderer stay intact.
let stagedEntryHash;
const stagedMainHashes = {};
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function verifyMainPackaging(built, staged, manifestDigest) {
  assert.match(manifestDigest,/^[a-f0-9]{64}$/);
  assert.equal(staged,built.replaceAll("__ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__",manifestDigest),"Only the normal provider-manifest substitution may change packaged main JavaScript");
}
const mainFiles=(await readdir(path.join(root,"out/main"),{recursive:true})).filter(file=>file.endsWith(".js")).sort();
const builtMainHashes=Object.fromEntries(await Promise.all(mainFiles.map(async file=>[file,digest(await readFile(path.join(root,"out/main",file)))])));
const builtMainBundleSha256=digest(JSON.stringify(builtMainHashes));
const previousSigningIdentity = process.env.ZENX_CODESIGN_IDENTITY;
const previousSigningMode = process.env.ZENX_CODESIGN_MODE;
let packaged;
try {
  process.env.ZENX_CODESIGN_IDENTITY = "-";
  delete process.env.ZENX_CODESIGN_MODE;
  packaged = await packageZenX(["--app"], {
    buildDirectory: path.join(root, "out"),
    artifactDirectory: path.join(temporary, "packaged-artifact"),
    prepareApp: async (appDirectory) => {
      const main = path.join(appDirectory, "out/main/index.js");
      const stagedFiles=(await readdir(path.join(appDirectory,"out/main"),{recursive:true})).filter(file=>file.endsWith(".js")).sort();
      assert.deepEqual(stagedFiles,mainFiles);
      for(const file of mainFiles)stagedMainHashes[file]=digest(await readFile(path.join(appDirectory,"out/main",file)));
      stagedEntryHash = createHash("sha256")
        .update(await readFile(main))
        .digest("hex");
      await mkdir(path.join(appDirectory, "scripts"), { mode: 0o700 });
      await copyFile(
        path.join(root, "scripts/capture-send-feedback.cjs"),
        path.join(appDirectory, "scripts/capture-send-feedback.cjs"),
      );
      await copyFile(path.join(root,"scripts/summarize-send-timeline.cjs"),path.join(appDirectory,"scripts/summarize-send-timeline.cjs"));
      const manifestPath = path.join(appDirectory, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(manifest.main, "out/main/index.js");
      manifest.main = "scripts/capture-send-feedback.cjs";
      await writeFile(manifestPath, JSON.stringify(manifest) + "\n");
      assert.equal(
        createHash("sha256")
          .update(await readFile(main))
          .digest("hex"),
        stagedEntryHash,
      );
    },
  });
} finally {
  if (previousSigningIdentity === undefined)
    delete process.env.ZENX_CODESIGN_IDENTITY;
  else process.env.ZENX_CODESIGN_IDENTITY = previousSigningIdentity;
  if (previousSigningMode === undefined) delete process.env.ZENX_CODESIGN_MODE;
  else process.env.ZENX_CODESIGN_MODE = previousSigningMode;
}
const bundle = path.join(packaged.packagedArtifact, "ZenX.app");
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
const resources = path.join(bundle, "Contents/Resources");
const packagedHashes = {};
for (const file of [
  "app/out/main/index.js",
  "app/out/preload/index.cjs",
  "app/scripts/capture-send-feedback.cjs",
  "app/scripts/summarize-send-timeline.cjs",
  "native-helpers/zenx-accessibility",
  "native-helpers/zenx-bound-target",
  "native-helpers/zenx-foreground-input",
  "native-helpers/zenx-ocr",
])
  packagedHashes[file] = createHash("sha256")
    .update(await readFile(path.join(resources, file)))
    .digest("hex");
assert.equal(packagedHashes["app/out/main/index.js"], stagedEntryHash);
assert.equal(
  packagedHashes["app/out/preload/index.cjs"],
  hashes["out/preload/index.cjs"],
);
assert.equal(
  packagedHashes["app/scripts/capture-send-feedback.cjs"],
  hashes["scripts/capture-send-feedback.cjs"],
);

for(const file of mainFiles){
  const built=await readFile(path.join(root,"out/main",file),"utf8");
  const shipped=await readFile(path.join(resources,"app/out/main",file),"utf8");
  verifyMainPackaging(built,shipped,packaged.manifestDigest);
  assert.equal(digest(shipped),stagedMainHashes[file],"Signing must preserve staged main JavaScript");
}
const packagedMainFiles=(await readdir(path.join(resources,"app/out/main"),{recursive:true})).filter(file=>file.endsWith(".js")).sort();
assert.deepEqual(packagedMainFiles,mainFiles);
const packagedMainBundleSha256=digest(JSON.stringify(stagedMainHashes));
for(const file of rendererFiles)assert.equal(digest(await readFile(path.join(resources,"app",file))),hashes[file],"Packaged renderer must equal the production build");
const rendererBundleSha256=digest(JSON.stringify(Object.fromEntries(rendererFiles.map(file=>[file,hashes[file]]))));
assert.equal(packagedHashes["app/scripts/summarize-send-timeline.cjs"],hashes["scripts/summarize-send-timeline.cjs"]);

await writeFile(
  path.join(directory, "full-app-source.json"),
  JSON.stringify(
    {
      version,
      sourceCommit: expected,
      sourceTree:"dcd68b25656bf34e059382c2b461bd87a9355ceb",
      packagedHashes,
      comparisonRole:sourceLabel==="baseline"?"unmodified-production-baseline":"isolated-"+sourceLabel+"-candidate",
      priorUserMessages:count,
      priorCompletedTurns:count,
      visibleHistoricalMessages:count*2,
      fixtureContextWindow:100000000,
      platform:process.platform,
      hashes,
      scope:"Actual production App, native Send, private production DomainThreadJournal history. Fake model only, no compaction, only actual product local pending UI, no injected bubbles or fake receipt. Timing seed excluded.",
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
});
if (process.platform === "win32") {
  await mkdir(environment.APPDATA, { recursive: true });
  await mkdir(environment.LOCALAPPDATA, { recursive: true });
}
const child = spawn(
  packaged.executable,
  [
    directory,
    version,
    temporary,
    `--user-data-dir=${profile}`,
  ],
  {
    env: environment,
    stdio: ["ignore", privateLog.fd, privateLog.fd],
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
// The only failure detail allowed outside the owned private fixture.
function safeDiagnosticFailure(result) {
  const stages = ["capture", "trace-collection", "private-review", "timeline-summary", "summary-write"];
  const allowed = ["capture-contract-failed", "trace-collection-failed", "known-credential-literal", "private-configuration-content", "credential-or-configuration-pattern", "non-fixture-user-path", "review-input-unavailable-or-invalid", "timeline-contract-invalid", "summary-write-failed"];
  const failure = result?.diagnosticFailure;
  return {
    stage: stages.includes(failure?.stage) ? failure.stage : "unclassified",
    reasonCodes: Array.isArray(failure?.reasonCodes) ? failure.reasonCodes.filter(code => allowed.includes(code)).slice(0, allowed.length) : [],
  };
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
  const result = JSON.parse(
    await readFile(path.join(directory, "full-app-measurements.json"), "utf8"),
  );
  if(!result.ok)console.error("PRIVATE_DIAGNOSTIC_FAILURE "+JSON.stringify(safeDiagnosticFailure(result)));
  assert.equal(code, 0, "Owned full App diagnostic must pass");
  assert.equal(result.ok, true);
  assert.equal(result.packagedRuntime?.isPackaged,true);
  assert.equal(result.packagedRuntime?.defaultApp,false);
  assert.equal(result.packagedRuntime?.productionEntrySha256,stagedEntryHash);
  assert.equal(result.packagedRuntime?.mainBundleSha256,packagedMainBundleSha256);
  assert.equal(result.packagedRuntime?.preloadSha256,hashes["out/preload/index.cjs"]);
  assert.equal(Object.keys(result.packagedRuntime.helperHashes).length,4);
  for(const [file,hash] of Object.entries(result.packagedRuntime.helperHashes))assert.equal(hash,packagedHashes[file]);
  assert.equal(result.profile.schemaVersion,3);
  assert.equal(new Set(result.samples.map(s=>s.messageId)).size,3);
  assert.equal(new Set(result.samples.map(s=>s.ipc[0].receipt.turnId)).size,3);
  assert.equal(new Set(result.samples.map(s=>s.ipc[0].clientUserMessageId)).size,3);
  assert.equal(sourceLabel,"profile");
  assert.equal(result.profile?.acceptance,false);
  assert.equal(result.profile?.traceStopped,true);
  assert.equal(result.profile?.review?.passed,true);
  console.log("DIAGNOSTIC_PROFILE_ONLY_NOT_PERFORMANCE_ACCEPTANCE");
  assert.equal(result.samples.length,3);
  assert.ok(result.samples.every(s=>Number.isFinite(s.firstVisibleFeedbackMs)&&s.firstVisibleFeedbackMs>=0&&Number.isFinite(s.clickToClearFrameMs)&&s.clickToClearFrameMs>=0),"Finite nonnegative feedback and clear measurements required");
  const persisted=await verifyLongThread({dataDirectory:data,threadId:result.seed.threadId,samples:result.samples,userMessageCount:count});
  await writeFile(path.join(directory,"independent-storage-verification.json"),JSON.stringify(persisted,null,2));
  /* Private full measurement stays with its fixture. */
  const summary=JSON.parse(await readFile(path.join(directory,"owned-native-send-profile.summary.json"),"utf8"));
  assert.equal(summary.review?.passed,true); assert.equal(summary.acceptance,false);
  summary.sourceCommit=expected;
  summary.sourceTree="dcd68b25656bf34e059382c2b461bd87a9355ceb";
  summary.packaged={isPackaged:true,defaultApp:false,signedBundleVerified:true,builtEntrySha256:hashes["out/main/index.js"],packagedEntrySha256:stagedEntryHash,builtMainBundleSha256,packagedMainBundleSha256,rendererBundleSha256,providerManifestSha256:packaged.manifestDigest,providerManifestSubstitutionOnly:true,preloadSha256:hashes["out/preload/index.cjs"],helperSha256:["zenx-accessibility","zenx-bound-target","zenx-foreground-input","zenx-ocr"].map(name=>packagedHashes["native-helpers/"+name])};
  summary.priorCompletedTurns=count;
  summary.historicalMessages=count*2;
  summary.hashes={capture:hashes["scripts/capture-send-feedback.cjs"],launcher:hashes["scripts/launch-send-feedback.mjs"],statistics:hashes["scripts/summarize-send-timeline.cjs"]};
  summary.independentStorage={independentReopen:persisted.independentReopen,userMessages:persisted.userMessages,matchedNewMessages:persisted.matchedNewMessages,compactionAttempts:persisted.compactionAttempts,compactionFacts:persisted.compactionFacts,traceCompleteness:persisted.traceCompleteness};
  // Final export permits only the pure summary, fixed metadata, numeric counts and checked hashes.
  const privateConfig=await readFile(path.join(profile,"host-profile.json"),"utf8");
  const privateToken=(await readFile(path.join(profile,"runtime/app-server.token"),"utf8")).trim();
  const serialized=JSON.stringify(summary,null,2);
  assert(!serialized.includes(privateToken)&&!serialized.includes(privateConfig));
  assert(!/Bearer\s+[A-Za-z0-9._~+/=-]{12,}|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\/(?:Users|home)\//.test(serialized));
  await writeFile(path.join(uploadDirectory,"owned-native-send-profile.summary.json"),JSON.stringify(summary,null,2),{flag:"wx"});
  console.log("GATE_REVIEWED_TIMELINE_SUMMARY "+JSON.stringify(summary));
  cleanupSafe = true; // Successful production before-quit awaits stopZenXHost.
  if(sourceLabel==="pending") assert.ok(result.samples.every(s=>s.feedbackWithinTarget && s.clickToClearFrameMs<=200),"Actual first visible feedback and input clear must each meet 200ms target in every observed sample; see verified numeric output, no threshold relaxation");
} finally {
  await privateLog.close();
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

