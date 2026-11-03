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
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageZenX } from "./package-zenx-portable.mjs";
import {
  seedLongThread,
  verifyLongThread,
} from "./long-thread-domain-seed.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.platform, "darwin");
const uploadDirectory = path.resolve(process.argv[2]);
const version = "current";
const count = Number(process.argv[3]);
assert.equal(count, 5000);
const sourceLabel = process.argv[4];
const pairCase = process.argv[5];
const viewportWidth = Number(process.argv[6]);
assert.ok([1120, 1280].includes(viewportWidth));
assert.ok(
  [
    "control-baseline",
    "control-candidate",
    "narrow-baseline",
    "narrow-candidate",
  ].includes(pairCase),
);
assert.equal(
  pairCase,
  (viewportWidth === 1120 ? "narrow" : "control") + "-" + sourceLabel,
);
const activationKind = process.argv[7] ?? "click";
assert.ok(["click", "enter"].includes(activationKind));
assert.equal(process.argv[8], undefined);
const hostSnapshot = () => ({
  platform: os.platform(),
  release: os.release(),
  arch: os.arch(),
  cpuModel: os.cpus()[0]?.model,
  cpuCount: os.cpus().length,
  loadAverage: os.loadavg(),
  freeMemoryBytes: os.freemem(),
  totalMemoryBytes: os.totalmem(),
  uptimeSeconds: os.uptime(),
});
const hostBefore = hostSnapshot();
const snapshots = {
  baseline: {
    commit: "3b411e8480d6dacd7b9baed6276849fa99fbda7e",
    tree: "c0afbda944b4714544bd1f24d984e0d16909cda8",
  },
  candidate: {
    commit: "85ea447d369c144a5d1125fc7c5518ec62b276f2",
    tree: "fa7a613cd33b9bbd2f3205c583a9a12d9c59acab",
  },
};
const snapshot = snapshots[sourceLabel];
const expected = snapshot?.commit;
assert.ok(
  expected,
  "Only independently identified source snapshots are allowed",
);
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  expected,
);
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    encoding: "utf8",
  }).trim(),
  snapshot.tree,
);
assert.equal(
  execFileSync("git", ["diff", "--name-only", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  "",
  "Tracked production checkout must be unchanged",
);
await mkdir(uploadDirectory, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), "zenx-owned-full-app-"));
const directory = path.join(temporary, "measurements");
await mkdir(directory, { mode: 0o700 });
const privateLog = await open(
  path.join(temporary, "native-process.log"),
  "wx",
  0o600,
);
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
    providerProfiles: [
      {
        type: "fake",
        displayName: "Synthetic local only",
        providerProfileId: "fake",
        models: [
          {
            id: "fake",
            displayName: "fake",
            description: "Offline ordinary-send baseline",
            hidden: false,
            source: "manual",
            supportedReasoningEfforts: ["medium"],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
            contextWindow: 100000000,
          },
        ],
      },
    ],
    defaultModel: { providerProfileId: "fake", modelId: "fake" },
    titleModel: { providerProfileId: "fake", modelId: "fake" },
    workspace,
    workspaces: [workspace],
    lastUsedWorkspace: workspace,
    approvalPolicy: "never",
  }),
);
await seedLongThread({
  isolationRoot: temporary,
  dataDirectory: data,
  workspace,
  userMessageCount: count,
  providerProfileId: "fake",
  modelId: "fake",
});
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
  "src/renderer/src/plugin-information-host.tsx",
  "scripts/capture-send-feedback.cjs",
  "scripts/launch-send-feedback.mjs",
  "scripts/long-thread-domain-seed.mjs",
  "scripts/summarize-send-timeline.cjs",
])
  hashes[file] = createHash("sha256")
    .update(await readFile(path.join(root, file)))
    .digest("hex");
// Reuse the normal signed portable packager. Only the private diagnostic app's
// entry is redirected to our observer; production main/preload/renderer stay intact.
let stagedEntryHash;
const stagedMainHashes = {};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function verifyMainPackaging(built, staged, manifestDigest) {
  assert.match(manifestDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    staged,
    built.replaceAll(
      "__ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__",
      manifestDigest,
    ),
    "Only the normal provider-manifest substitution may change packaged main JavaScript",
  );
}
const mainFiles = (
  await readdir(path.join(root, "out/main"), { recursive: true })
)
  .filter((file) => file.endsWith(".js"))
  .sort();
const builtMainHashes = Object.fromEntries(
  await Promise.all(
    mainFiles.map(async (file) => [
      file,
      digest(await readFile(path.join(root, "out/main", file))),
    ]),
  ),
);
const builtMainBundleSha256 = digest(JSON.stringify(builtMainHashes));
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
      const stagedFiles = (
        await readdir(path.join(appDirectory, "out/main"), { recursive: true })
      )
        .filter((file) => file.endsWith(".js"))
        .sort();
      assert.deepEqual(stagedFiles, mainFiles);
      for (const file of mainFiles)
        stagedMainHashes[file] = digest(
          await readFile(path.join(appDirectory, "out/main", file)),
        );
      stagedEntryHash = createHash("sha256")
        .update(await readFile(main))
        .digest("hex");
      await mkdir(path.join(appDirectory, "scripts"), { mode: 0o700 });
      await copyFile(
        path.join(root, "scripts/capture-send-feedback.cjs"),
        path.join(appDirectory, "scripts/capture-send-feedback.cjs"),
      );
      await copyFile(
        path.join(root, "scripts/summarize-send-timeline.cjs"),
        path.join(appDirectory, "scripts/summarize-send-timeline.cjs"),
      );
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

for (const file of mainFiles) {
  const built = await readFile(path.join(root, "out/main", file), "utf8");
  const shipped = await readFile(
    path.join(resources, "app/out/main", file),
    "utf8",
  );
  verifyMainPackaging(built, shipped, packaged.manifestDigest);
  assert.equal(
    digest(shipped),
    stagedMainHashes[file],
    "Signing must preserve staged main JavaScript",
  );
}
const packagedMainFiles = (
  await readdir(path.join(resources, "app/out/main"), { recursive: true })
)
  .filter((file) => file.endsWith(".js"))
  .sort();
assert.deepEqual(packagedMainFiles, mainFiles);
const packagedMainBundleSha256 = digest(JSON.stringify(stagedMainHashes));
for (const file of rendererFiles)
  assert.equal(
    digest(await readFile(path.join(resources, "app", file))),
    hashes[file],
    "Packaged renderer must equal the production build",
  );
const rendererSourceBundles = Object.fromEntries(
  rendererFiles
    .filter((file) => /(?:^|[/\\])index-[A-Za-z0-9_-]+\.js$/.test(file))
    .slice(0, 4)
    .map((file) => [path.basename(file), hashes[file]]),
);
const rendererBundleSha256 = digest(
  JSON.stringify(
    Object.fromEntries(rendererFiles.map((file) => [file, hashes[file]])),
  ),
);

await writeFile(
  path.join(directory, "full-app-source.json"),
  JSON.stringify(
    {
      version,
      sourceCommit: expected,
      sourceTree: snapshot.tree,
      packagedHashes,
      comparisonRole:
        "full-DOM versus real Legend WIP native pair, not production acceptance: " +
        activationKind,
      priorUserMessages: count,
      priorCompletedTurns: count,
      visibleHistoricalMessages: count * 2,
      fixtureContextWindow: 100000000,
      platform: process.platform,
      hashes,
      scope:
        "Actual production App, native Send, private production DomainThreadJournal history. Fake model only, no compaction, only actual product local pending UI, no injected bubbles or fake receipt. Timing seed excluded.",
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
    String(viewportWidth),
    activationKind,
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
// Capture only this owned fixture's live credential. Normal Host shutdown removes
// its file; keep the exact value in this process only until the final export scan.
async function captureLiveExportGuard(tokenFile, isClosed) {
  let token;
  while (!isClosed()) {
    let handle;
    try {
      handle = await open(
        tokenFile,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65)
        throw new Error("Invalid owned fixture credential");
      const value = await handle.readFile("utf8");
      // The producer opens the file before writing. An empty/partial first read
      // is not a credential and may be observed again while the child is live.
      if (/^[a-f0-9]{64}\n?$/.test(value)) token = value.trim();
    } catch (error) {
      if (error?.code !== "ENOENT")
        throw new Error("Owned fixture credential capture failed");
    } finally {
      await handle?.close();
    }
    if (token !== undefined) {
      return {
        scan(serialized, privateConfig) {
          if (
            token === undefined ||
            typeof privateConfig !== "string" ||
            privateConfig.length === 0
          )
            throw new Error("Final export guard unavailable");
          const contains = (value) =>
            serialized.includes(value) ||
            serialized.includes(JSON.stringify(value).slice(1, -1));
          assert(
            !contains(token) && !contains(privateConfig),
            "Final export contains private fixture data",
          );
          assert(
            !/Bearer\s+[A-Za-z0-9._~+/=-]{12,}|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\/(?:Users|home)\//.test(
              serialized,
            ),
            "Final export contains prohibited data",
          );
        },
        clear() {
          token = undefined;
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Owned fixture credential unavailable before shutdown");
}
function projectFailureNativeContinuity(sample) {
  try {
    return projectNativeContinuity(sample);
  } catch {
    return { unavailable: true, reason: "native-continuity-contract-invalid" };
  }
}
function projectNativeContinuity(sample) {
  const evidence = sample.nativeFeedbackContinuity;
  if (!evidence) return null;
  assert.ok(["pending", "canonical"].includes(evidence.owner));
  assert.equal(evidence.identityVerified, true);
  assert.equal(evidence.ownerConnected, true);
  assert.equal(evidence.pendingToCanonical, evidence.owner === "canonical");
  const timing = {};
  for (const field of [
    "pendingNativeIntersectionMs",
    "ownerNativeIntersectionEntryMs",
    "ownerNativeIntersectionMs",
    "subsequentFrameMs",
  ]) {
    assert.ok(
      Number.isFinite(evidence[field]) && evidence[field] >= sample.clickMs,
    );
    timing[field] = evidence[field] - sample.clickMs;
  }
  assert.ok(timing.subsequentFrameMs > timing.ownerNativeIntersectionMs);
  return {
    owner: evidence.owner,
    pendingToCanonical: evidence.pendingToCanonical,
    identityVerified: true,
    ownerConnected: true,
    ...timing,
  };
}

// One fixed image allowlist for successful and failed owned-synthetic captures.
// No raw trace, process log, profile, configuration or arbitrary path is eligible.
async function copyOwnedSyntheticScreenshots({
  directory,
  uploadDirectory,
  capture,
  close,
  guard,
  privateConfig,
}) {
  assert.ok(
    close && close.signal === null && [0, 1].includes(close.code),
    "Normal owned App exit required for screenshot export",
  );
  assert.equal(capture?.seed?.synthetic, true);
  assert.equal(capture?.seed?.userMessageCount, 5000);
  assert.equal(capture?.fixtureModel?.provider, "fake");
  assert.equal(capture?.packagedRuntime?.isPackaged, true);
  assert.equal(typeof guard?.scan, "function");
  const names = (await readdir(directory))
    .filter((name) =>
      /^(?:messages-\d+-sample-[0-2]-(?:before|after)|information-presentation-before-timing|paused-reader-after-native-resize|responsive-history-(?:390|640|641)|legend-history-(?:after-canonical|before-natural-up|after-natural-up)|send-latency-failure)\.png$/.test(
        name,
      ),
    )
    .sort();
  assert.ok(names.length <= 15, "Owned synthetic image count stays bounded");
  guard.scan(
    JSON.stringify({ synthetic: true, provider: "fake", screenshots: names }),
    privateConfig,
  );
  for (const name of names) {
    let handle;
    try {
      handle = await open(
        path.join(directory, name),
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      assert.ok(
        stat.isFile() &&
          stat.nlink === 1 &&
          stat.size >= 8 &&
          stat.size <= 32 * 1024 * 1024,
        "Owned screenshot must be a bounded regular PNG",
      );
      const bytes = await handle.readFile();
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      await writeFile(path.join(uploadDirectory, name), bytes, { flag: "wx" });
    } finally {
      await handle?.close();
    }
  }
  return names;
}

let cleanupSafe = false;
let observedClose;
let exportGuard;
let captureForScreenshots;
let screenshotExport = { status: "not-eligible", copiedCount: 0 };
child.once("close", (code, signal) => {
  observedClose = { code, signal };
});
try {
  let ownedWaitSettled = false;
  const ownedExit = (
    process.platform === "win32" ? waitOwnedWindowsTree : waitOwnedPosixGroup
  )(child, count === 5000 ? 600000 : 240000);
  void ownedExit.then(
    () => {
      ownedWaitSettled = true;
    },
    () => {
      ownedWaitSettled = true;
    },
  );
  // Both operations settle before lifecycle cleanup, even when capture fails.
  const [exitStatus, guardStatus] = await Promise.allSettled([
    ownedExit,
    captureLiveExportGuard(
      path.join(profile, "runtime/app-server.token"),
      () => ownedWaitSettled,
    ),
  ]);
  if (guardStatus.status === "fulfilled") exportGuard = guardStatus.value;
  if (exitStatus.status === "rejected") throw exitStatus.reason;
  if (guardStatus.status === "rejected") throw guardStatus.reason;
  const code = exitStatus.value;
  const result = JSON.parse(
    await readFile(path.join(directory, "full-app-measurements.json"), "utf8"),
  );
  captureForScreenshots = result;
  assert.equal(code, 0, "Owned full App diagnostic must pass");
  assert.equal(result.ok, true);
  assert.equal(result.packagedRuntime?.isPackaged, true);
  assert.equal(result.packagedRuntime?.defaultApp, false);
  assert.equal(result.packagedRuntime?.productionEntrySha256, stagedEntryHash);
  assert.equal(
    result.packagedRuntime?.mainBundleSha256,
    packagedMainBundleSha256,
  );
  assert.equal(
    result.packagedRuntime?.preloadSha256,
    hashes["out/preload/index.cjs"],
  );
  assert.equal(Object.keys(result.packagedRuntime.helperHashes).length, 4);
  for (const [file, hash] of Object.entries(
    result.packagedRuntime.helperHashes,
  ))
    assert.equal(hash, packagedHashes[file]);
  assert.equal(
    result.harnessVersion,
    "native-style-invalidation-v2-first-trace-not-acceptance",
  );
  assert.equal(result.acceptance, false);
  assert.equal(result.viewportWidth, viewportWidth);
  assert.equal(result.activationKind, activationKind);
  assert.equal(
    result.informationPresentation.mode,
    viewportWidth === 1120 ? "popover" : "dock",
  );
  assert.equal(new Set(result.samples.map((s) => s.messageId)).size, 3);
  assert.equal(
    new Set(result.samples.map((s) => s.ipc[0].receipt.turnId)).size,
    3,
  );
  assert.equal(
    new Set(result.samples.map((s) => s.ipc[0].clientUserMessageId)).size,
    3,
  );
  for (const sample of result.samples) {
    assert.equal(sample.trusted, true);
    assert.equal(sample.ipc.length, 1);
    assert.equal(sample.feedbackClientId, sample.ipc[0].clientUserMessageId);
    assert.deepEqual(sample.visibilityAtClick, {
      state: "visible",
      focused: true,
    });
    for (const key of [
      "clickToFeedbackGeometryCompleteMs",
      "clickToFeedbackSubsequentFrameMs",
      "clickToClearGeometryCompleteMs",
      "clickToClearSubsequentFrameMs",
    ])
      assert.ok(Number.isFinite(sample[key]) && sample[key] >= 0);
    assert.ok(
      sample.clickToFeedbackSubsequentFrameMs >=
        sample.clickToFeedbackGeometryCompleteMs,
    );
    assert.ok(
      sample.clickToClearSubsequentFrameMs >=
        sample.clickToClearGeometryCompleteMs,
    );
  }
  assert.equal(result.samples.length, 3);
  assert.ok(
    result.samples.every(
      (s) =>
        Number.isFinite(s.firstVisibleFeedbackMs) &&
        s.firstVisibleFeedbackMs >= 0 &&
        Number.isFinite(s.clickToClearFrameMs) &&
        s.clickToClearFrameMs >= 0,
    ),
    "Finite nonnegative feedback and clear measurements required",
  );
  const persisted = await verifyLongThread({
    dataDirectory: data,
    threadId: result.seed.threadId,
    samples: result.samples,
    userMessageCount: count,
  });
  await writeFile(
    path.join(directory, "independent-storage-verification.json"),
    JSON.stringify(persisted, null, 2),
  );
  // Export only bounded source identity, numeric observations and fixture evidence.
  const timingFields = [
    "firstVisibleFeedbackMs",
    "clickToPendingDomMs",
    "clickToPendingVisibleFrameMs",
    "clickToFeedbackGeometryCompleteMs",
    "clickToFeedbackSubsequentFrameMs",
    "clickToClearGeometryCompleteMs",
    "clickToClearSubsequentFrameMs",
    "clickToBubbleDomMs",
    "clickToVisibleFrameMs",
    "clickToClearFrameMs",
    "clickToCanonicalNotificationMs",
  ];
  assert.deepEqual(result.experimentalSession, {
    enabledOnBothApps: true,
    reloadedBeforeSelection: true,
  });
  assert.equal(result.before.turns, count);
  assert.equal(result.before.messages, count * 2);
  const virtual = sourceLabel === "candidate";
  assert.equal(result.before.rendered.virtual, virtual);
  const mountedCount = result.before.rendered.turnBlocks;
  if (virtual) {
    assert.ok(mountedCount >= 2 && mountedCount < 200);
    assert.equal(result.before.rendered.virtualRows, mountedCount);
    assert.equal(
      result.before.rendered.contentSelector,
      ".messages > .virtual-transcript-content",
    );
    assert.equal(result.before.rendered.contentDisplay, "block");
    assert.equal(result.before.rendered.historyGroups, 0);
    assert.equal(result.before.rendered.rowGapPx, 24);
    assert.ok(
      result.virtualHistoryVisual.earlier.firstCanonicalIndex <
        result.virtualHistoryVisual.live.firstCanonicalIndex,
    );
    assert.ok(
      result.virtualHistoryVisual.earlier.lastCanonicalIndex <
        result.virtualHistoryVisual.live.lastCanonicalIndex,
    );
    assert.equal(
      result.virtualHistoryVisual.returned.exactCanonicalSuffix,
      true,
    );
  } else {
    assert.equal(mountedCount, count);
    assert.equal(result.before.rendered.historyGroups, 1);
    assert.equal(result.before.rendered.directTurns, 0);
    assert.equal(result.before.rendered.groupTurns, count);
    assert.equal(result.before.rendered.outerGapPx, 24);
    assert.equal(result.before.rendered.historyGapPx, 24);
  }
  assert.equal(result.before.rendered.userRows, mountedCount);
  assert.equal(result.before.rendered.assistantRows, mountedCount);
  assert.equal(result.before.rendered.historyPager, false);
  assert.equal(result.before.rendered.exactCanonicalSuffix, true);
  assert.equal(result.before.rendered.canonicalMembers, mountedCount);
  assert.equal(result.before.rendered.canonicalContiguous, true);
  assert.equal(result.before.rendered.pendingHosts, 0);
  assert.equal(result.afterRendered.exactCanonicalSuffix, true);
  assert.equal(
    result.afterRendered.turnBlocks,
    virtual ? result.afterRendered.canonicalMembers : count + 3,
  );
  for (const rendered of [result.before.rendered, result.afterRendered]) {
    assert.equal(rendered.inspection.withinSendTiming, false);
    assert.equal(
      rendered.inspection.rendererRowRectReads,
      virtual ? rendered.turnBlocks : 0,
    );
    assert.ok(
      Number.isFinite(rendered.inspection.mainWallMs) &&
        rendered.inspection.mainWallMs >= 0,
    );
  }
  const samples = result.samples.map((sample, index) => {
    for (const name of [
      "own.value.set",
      "prototype.defaultValue.set",
      "prototype.selectionStart.get",
      "prototype.selectionEnd.get",
    ])
      assert.ok(
        sample.geometryProbes.textareaAccessorWrappers.includes(name),
        "Required real textarea accessor coverage: " + name,
      );
    assert.equal(sample.activationKind, activationKind);
    assert.equal(sample.sendPanelClosedAfterSend, true);
    assert.equal(sample.editorFocusedAfterSend, true);
    assert.equal(sample.geometryProbes.cssReturnProxy.instrumented, true);
    // Coverage is an observed hypothesis result, never a fabricated zero-cost pass.
    // A fast click may not have mounted the panel; keep that sample explicit.
    if (activationKind === "enter")
      assert.equal(sample.sendPanelOpenAtActivation, false);
    const timings = Object.fromEntries(
      timingFields.map((key) => {
        const value = sample[key];
        assert.ok(
          value === null || (Number.isFinite(value) && value >= 0),
          "Finite nonnegative timing or explicit null required: " + key,
        );
        return [key, value];
      }),
    );
    return {
      index,
      phase: index === 0 ? "first" : "warm",
      activationKind: sample.activationKind,
      presencePathMeasured:
        (sample.geometryProbes.counts[
          "style.cached.animationName:send-controls"
        ]?.calls ?? 0) > 0,
      sendPanelOpenAtActivation: sample.sendPanelOpenAtActivation,
      editorFocusedAtActivation: sample.editorFocusedAtActivation,
      sendPanelClosedAfterSend: sample.sendPanelClosedAfterSend,
      sendPanelPresentAfterSend: sample.sendPanelPresentAfterSend,
      editorFocusedAfterSend: sample.editorFocusedAfterSend,
      firstVisibleFeedbackKind: sample.firstVisibleFeedbackKind,
      ...timings,
      ipcDurationMs: sample.ipc[0].durationMs,
      feedbackWithinTarget: sample.feedbackWithinTarget,
      verifiedFeedbackWithinTarget: sample.verifiedFeedbackWithinTarget,
      verifiedClearWithinTarget: sample.verifiedClearWithinTarget,
      visibilityAtClick: sample.visibilityAtClick,
      instrumentation: sample.instrumentation,
      geometryProbes: sample.geometryProbes,
      clickToPendingContentResizeMs: sample.clickToPendingContentResizeMs,
      nativeLayoutAtClick: sample.nativeLayoutAtClick,
      clickToPendingNativeIntersectionMs:
        sample.clickToPendingNativeIntersectionMs,
      clickToPendingNativeSubsequentFrameMs:
        sample.clickToPendingNativeSubsequentFrameMs,
      clickToPendingNativeIntersectionEntryMs:
        sample.pendingNativeIntersectionEntryMs - sample.clickMs,
      nativeFinalOwnership: sample.nativeFinalOwnership,
      nativeFeedbackContinuity: projectNativeContinuity(sample),
      pendingNativeIntersectionRatio: sample.pendingNativeIntersectionRatio,
      pendingNativeIntersectionBounds: sample.pendingNativeIntersectionBounds,
      nativeLayoutEvents: sample.nativeLayoutEvents.map(
        ({ atMs, ...event }) => event,
      ),
    };
  });
  const timeline = JSON.parse(
    await readFile(
      path.join(directory, "owned-native-send-profile.summary.json"),
      "utf8",
    ),
  );
  assert.equal(timeline.review?.passed, true);
  assert.equal(timeline.acceptance, false);
  assert.equal(timeline.tracedSampleCount, 1);
  assert.equal(timeline.samples.length, 1);
  const summary = {
    schemaVersion: 1,
    timeline,
    diagnosticOnly: true,
    acceptance: false,
    measurementContract: result.measurementContract,
    diagnosticTargetMeaning: result.diagnosticTargetMeaning,
    experimentalSession: result.experimentalSession,
    sourceCommit: expected,
    sourceTree: snapshot.tree,
    sourceLabel,
    pairCase,
    viewportWidth,
    activationKind,
    legacyTimingColumnMeaning: result.legacyTimingColumnMeaning,
    priorCompletedTurns: count,
    historicalMessages: count * 2,
    hostBefore,
    hostAfter: hostSnapshot(),
    nativeWindow: result.nativeWindow,
    informationPresentation: result.informationPresentation,
    canonicalBefore: {
      turns: result.before.turns,
      messages: result.before.messages,
    },
    virtualHistoryVisual: result.virtualHistoryVisual,
    rendered: result.before.rendered,
    renderedAfter: result.afterRendered,
    readerBeforeSend: result.readerBeforeSend,
    pausedReaderResize: result.pausedReaderResize,
    responsiveHistoryLayout: result.responsiveHistoryLayout,
    rendererSourceBundles,
    geometryProbeScope:
      "instrumented click-to-first-pending-observer getter wall times; not additive, not CPU, not performance acceptance",
    samples,
    packaged: {
      isPackaged: true,
      defaultApp: false,
      signedBundleVerified: true,
      builtEntrySha256: hashes["out/main/index.js"],
      packagedEntrySha256: stagedEntryHash,
      builtMainBundleSha256,
      packagedMainBundleSha256,
      rendererBundleSha256,
      providerManifestSha256: packaged.manifestDigest,
      providerManifestSubstitutionOnly: true,
      preloadSha256: hashes["out/preload/index.cjs"],
      helperSha256: [
        "zenx-accessibility",
        "zenx-bound-target",
        "zenx-foreground-input",
        "zenx-ocr",
      ].map((name) => packagedHashes["native-helpers/" + name]),
    },
    hashes: {
      capture: hashes["scripts/capture-send-feedback.cjs"],
      launcher: hashes["scripts/launch-send-feedback.mjs"],
      seed: hashes["scripts/long-thread-domain-seed.mjs"],
      statistics: hashes["scripts/summarize-send-timeline.cjs"],
    },
    independentStorage: {
      independentReopen: persisted.independentReopen,
      userMessages: persisted.userMessages,
      matchedNewMessages: persisted.matchedNewMessages,
      compactionAttempts: persisted.compactionAttempts,
      compactionFacts: persisted.compactionFacts,
      traceCompleteness: persisted.traceCompleteness,
    },
  };
  // Final export permits only the pure summary, fixed metadata, numeric counts and checked hashes.
  const privateConfig = await readFile(
    path.join(profile, "host-profile.json"),
    "utf8",
  );
  const serialized = JSON.stringify(summary, null, 2);
  exportGuard.scan(serialized, privateConfig);
  await writeFile(
    path.join(uploadDirectory, "send-information-layout.summary.json"),
    JSON.stringify(summary, null, 2),
    { flag: "wx" },
  );
  console.log(
    "REVIEWED_NATIVE_AB_OBSERVATION_NOT_ACCEPTANCE " + JSON.stringify(summary),
  );
  cleanupSafe = true; // Successful production before-quit awaits stopZenXHost.
} catch (error) {
  let capture;
  try {
    capture = JSON.parse(
      await readFile(
        path.join(directory, "full-app-measurements.json"),
        "utf8",
      ),
    );
  } catch {}
  captureForScreenshots = capture;
  const failure = {
    diagnosticOnly: true,
    acceptance: false,
    sourceCommit: expected,
    sourceTree: snapshot.tree,
    pairCase,
    viewportWidth,
    activationKind,
    stage:
      capture?.waitingFor ?? capture?.pendingOperation ?? "launcher validation",
    reason: "native-capture-or-validation-failed",
    captureCompleted: capture?.ok === true,
    // Fixed stage/reason enums only. Raw trace, error stacks and paths stay
    // private even when the final timeline contract rejects a capture.
    validationLine:
      Number(/launch-send-feedback\.mjs:(\d+):/.exec(error.stack ?? "")?.[1]) ||
      null,
    profileState: {
      stage: ["private-review", "timeline-summary", "summary-write"].includes(
        capture?.profile?.reviewStage,
      )
        ? capture.profile.reviewStage
        : "unavailable",
      passed: capture?.profile?.review?.passed === true,
      reasonCodes: (capture?.profile?.review?.reasonCodes ?? [])
        .filter((reason) =>
          [
            "known-credential-literal",
            "private-configuration-content",
            "credential-or-configuration-pattern",
            "non-fixture-user-path",
            "review-input-unavailable-or-invalid",
            "timeline-contract-invalid",
            "summary-write-failed",
          ].includes(reason),
        )
        .slice(0, 8),
      traceStopped: capture?.profile?.traceStopped === true,
      deadlineExceeded: capture?.profile?.deadlineExceeded === true,
      durationMs: Number.isFinite(capture?.profile?.durationMs)
        ? capture.profile.durationMs
        : null,
    },
    rendererSourceBundles,
    driverHashes: {
      capture: hashes["scripts/capture-send-feedback.cjs"],
      launcher: hashes["scripts/launch-send-feedback.mjs"],
    },
    informationPresentation: capture?.informationPresentation,
    readerBeforeSend: capture?.readerBeforeSend,
    rendered: capture?.before?.rendered,
    mountedInspection: capture?.mountedInspectionDiagnostic,
    pausedReaderResize: capture?.pausedReaderResize,
    responsiveHistoryLayout: capture?.responsiveHistoryLayout,
    observedSamples: (capture?.samples ?? [])
      .slice(0, 3)
      .map((sample, index) => ({
        index,
        activationKind: sample.activationKind,
        sendPanelOpenAtActivation: sample.sendPanelOpenAtActivation,
        editorFocusedAtActivation: sample.editorFocusedAtActivation,
        sendPanelClosedAfterSend: sample.sendPanelClosedAfterSend,
        editorFocusedAfterSend: sample.editorFocusedAfterSend,
        geometryProbes: sample.geometryProbes,
        nativeFinalOwnership: sample.nativeFinalOwnership,
        nativeFeedbackContinuity: projectFailureNativeContinuity(sample),
        nativeLayoutAtClick: sample.nativeLayoutAtClick,
        nativeLayoutEvents: (sample.nativeLayoutEvents ?? [])
          .slice(0, 16)
          .map(({ atMs, ...entry }) => ({
            ...entry,
            relativeToClickMs: atMs - sample.clickMs,
          })),
        nativeLayoutEventsTruncated:
          (sample.nativeLayoutEvents?.length ?? 0) > 16,
        pendingIntersectionRatio: sample.pendingNativeIntersectionRatio,
        pendingIntersectionBounds: sample.pendingNativeIntersectionBounds,
        nativeIntersectionEntryMs: Number.isFinite(
          sample.pendingNativeIntersectionEntryMs,
        )
          ? sample.pendingNativeIntersectionEntryMs - sample.clickMs
          : null,
        nativeIntersectionCallbackMs: Number.isFinite(
          sample.pendingNativeIntersectionMs,
        )
          ? sample.pendingNativeIntersectionMs - sample.clickMs
          : null,
        nativeSubsequentFrameMs: Number.isFinite(
          sample.pendingNativeSubsequentFrameMs,
        )
          ? sample.pendingNativeSubsequentFrameMs - sample.clickMs
          : null,
        timings: Object.fromEntries(
          [
            "firstVisibleFeedbackMs",
            "clickToPendingDomMs",
            "clickToFeedbackGeometryCompleteMs",
            "clickToFeedbackSubsequentFrameMs",
            "clickToClearFrameMs",
            "clickToCanonicalNotificationMs",
          ]
            .filter((key) => Number.isFinite(sample[key]))
            .map((key) => [key, sample[key]]),
        ),
      })),
  };
  if (exportGuard) {
    const detail = {
      ...failure,
      message: String(error.message).slice(0, 1000),
      captureError:
        typeof capture?.error === "string"
          ? capture.error.slice(0, 2000)
          : undefined,
    };
    try {
      exportGuard.scan(
        JSON.stringify(detail),
        await readFile(path.join(profile, "host-profile.json"), "utf8"),
      );
      Object.assign(failure, detail);
    } catch {}
  }
  await writeFile(
    path.join(uploadDirectory, "failure.json"),
    JSON.stringify(failure, null, 2),
    { flag: "wx" },
  );
  console.error("NATIVE_AB_CASE_FAILED " + JSON.stringify(failure));
  process.exitCode = 1;
} finally {
  if (captureForScreenshots && observedClose && exportGuard) {
    try {
      const names = await copyOwnedSyntheticScreenshots({
        directory,
        uploadDirectory,
        capture: captureForScreenshots,
        close: observedClose,
        guard: exportGuard,
        privateConfig: await readFile(
          path.join(profile, "host-profile.json"),
          "utf8",
        ),
      });
      screenshotExport = { status: "copied", copiedCount: names.length };
    } catch {
      screenshotExport = { status: "failed", copiedCount: null };
      cleanupSafe = false;
      process.exitCode = 1;
    }
  }
  exportGuard?.clear();
  exportGuard = undefined;
  await privateLog.close();
  await writeFile(
    path.join(uploadDirectory, "lifecycle.json"),
    JSON.stringify(
      {
        childCloseObserved: observedClose !== undefined,
        exitCode: observedClose?.code ?? null,
        signal: observedClose?.signal ?? null,
        captureValidated: cleanupSafe,
        screenshotExport,
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
