/** Launch only the owned synthetic Electron App on disposable native CI. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
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
import { DomainThreadJournal } from "../../../dist/src/domain-journal.js";
import { FileTraceStore } from "../../../dist/src/trace.js";
import { JsonlThreadMetadataStore } from "../../../dist/src/thread-metadata.js";
import { serializeSentReferenceV3 } from "../../../dist/src/selected-reference-protocol.js";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.platform, "darwin");
const directory = path.resolve(process.argv[2]);
const version = "current";
const count = 1000;
const expected = "51007e8f8ed21ce6db3ef94c5401ca2726564173";
// Correctness-only. No send-latency thresholds or timing samples are changed/reused.
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  expected,
);
assert.equal(
  execFileSync("git", ["diff", "--name-only", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  "",
  "Tracked production checkout must be unchanged",
);
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
const threadId = "synthetic-cv-reading",
  otherId = "synthetic-cv-other";
const selection = {
  providerProfileId: "fake",
  modelId: "fake",
  reasoningEffort: "medium",
};
const instant = (n) => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
const shortId = `${threadId}-turn-400-user`,
  tallId = `${threadId}-turn-401-user`;
const references = [shortId, tallId].map((id, i) => ({
  kind: "message",
  name: i ? "Tall source" : "Short source",
  cwd: workspace,
  threadId,
  id,
  excerpt: i ? "Synthetic tall source line 0" : "Synthetic short source",
}));
const envelope = (clientId) =>
  serializeSentReferenceV3(
    [
      { text: "Synthetic source navigation: " },
      ...references.flatMap((reference) => [{ reference }, { text: " " }]),
    ],
    clientId,
  );
const threadItems = (id) => [
  {
    id: id + "-metadata",
    threadId: id,
    createdAt: instant(0),
    type: "thread_metadata",
    cwd: workspace,
    ...selection,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  },
];
const items = threadItems(threadId);
for (let i = 0; i < count; i++) {
  const turnId = `${threadId}-turn-${i}`,
    clientId = turnId + "-client",
    common = { threadId, turnId };
  const text =
    i === 400
      ? "Synthetic short source"
      : i === 401
        ? Array.from(
            { length: 120 },
            (_, line) =>
              `Synthetic tall source line ${line}. Exact fixture text, no personal content.`,
          ).join("\n\n")
        : i === 999
          ? envelope(clientId)
          : `Synthetic historical user ${i}. ` +
            "Ordinary fixture reading. ".repeat(8);
  items.push(
    {
      ...common,
      id: turnId + "-started",
      createdAt: instant(i * 4 + 1),
      type: "turn_started",
      selection,
    },
    {
      ...common,
      id: turnId + "-user",
      clientId,
      createdAt: instant(i * 4 + 2),
      type: "user_message",
      content: [{ type: "text", text }],
      receiptTimezone: { timeZone: "UTC", source: "client" },
    },
    {
      ...common,
      id: turnId + "-assistant",
      createdAt: instant(i * 4 + 3),
      type: "agent_message",
      text: `Synthetic assistant ${i}. Historical content only.`,
    },
    {
      ...common,
      id: turnId + "-completed",
      createdAt: instant(i * 4 + 4),
      type: "turn_completed",
      status: "completed",
    },
  );
}
const queued = {
  type: "user_message_queued",
  id: "synthetic-cv-queue",
  clientId: "synthetic-cv-queued-client",
  threadId,
  createdAt: instant(5000),
  input: [{ type: "text", text: envelope("synthetic-cv-queued-client") }],
};
items.push(queued);
function storage(access) {
  const trace = new FileTraceStore(path.join(data, "trace"));
  const metadata = new JsonlThreadMetadataStore(
    path.join(data, "thread-metadata.jsonl"),
  );
  return {
    trace,
    metadata,
    journal: new DomainThreadJournal({
      directory: path.join(data, "threads"),
      trace,
      metadata,
      ...(access ? { access } : {}),
    }),
  };
}
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
let originalSemantic;
{
  const { trace, metadata, journal } = storage();
  try {
    await journal.create(items);
    await metadata.setName(threadId, "Synthetic CV reading — 1000 turns");
    await journal.create(threadItems(otherId));
    await metadata.setName(otherId, "Synthetic other thread");
    originalSemantic = digest(await journal.readItemList(threadId));
    assert.equal(
      (await journal.read(threadId)).filter((x) => x.type === "turn_completed")
        .length,
      count,
    );
  } finally {
    await journal.close();
    await trace.flush();
  }
}
await writeFile(
  path.join(temporary, "reading-fixture.json"),
  JSON.stringify({
    threadId,
    otherId,
    shortId,
    tallId,
    lastId: `${threadId}-turn-999-user`,
    queueId: queued.id,
    completedTurns: count,
  }),
);
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
  "scripts/capture-cv-reading-correctness.cjs",
  "scripts/launch-cv-reading-correctness.mjs",
])
  hashes[file] = createHash("sha256")
    .update(await readFile(path.join(root, file)))
    .digest("hex");
// Reuse the normal signed portable packager. Only the private acceptance app's
// entry is redirected to our observer; production main/preload/renderer stay intact.
let stagedEntryHash;
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
      stagedEntryHash = createHash("sha256")
        .update(await readFile(main))
        .digest("hex");
      await mkdir(path.join(appDirectory, "scripts"), { mode: 0o700 });
      await copyFile(
        path.join(root, "scripts/capture-cv-reading-correctness.cjs"),
        path.join(appDirectory, "scripts/capture-cv-reading-correctness.cjs"),
      );
      const manifestPath = path.join(appDirectory, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(manifest.main, "out/main/index.js");
      manifest.main = "scripts/capture-cv-reading-correctness.cjs";
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
  "app/scripts/capture-cv-reading-correctness.cjs",
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
  packagedHashes["app/scripts/capture-cv-reading-correctness.cjs"],
  hashes["scripts/capture-cv-reading-correctness.cjs"],
);

await writeFile(
  path.join(directory, "reading-source.json"),
  JSON.stringify(
    {
      version,
      sourceCommit: expected,
      purpose: "correctness-only reading restoration and source navigation",
      priorUserMessages: count,
      priorCompletedTurns: count,
      mountedHistoricalMessages: count * 2,
      fixtureContextWindow: 100000000,
      platform: process.platform,
      hashes,
      launchMode: "signed-private-packaged-bundle",
      packagedHashes,
      stagedProductionEntryUnchanged: true,
      scope:
        "Actual production App, private synthetic DomainThreadJournal history, native wheel/click/keyboard/selection; no send or latency claim. No injected UI or receipt.",
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
  [directory, version, temporary, `--user-data-dir=${profile}`],
  {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform === "darwin",
  },
);
// Child output remains private; upload only fixed synthetic evidence files.
const childOutput = [];
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => childOutput.push(chunk));
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
  const code = await waitOwnedPosixGroup(child, 240000);
  const result = JSON.parse(
    await readFile(path.join(directory, "reading-correctness.json"), "utf8"),
  );
  console.log(
    "CV_READING_CORRECTNESS " +
      JSON.stringify({
        sourceCommit: expected,
        ok: result.ok,
        stage: result.stage,
        reason: result.reason,
        cases: result.cases,
      }),
  );
  assert.equal(code, 0, "Owned correctness capture exited unsuccessfully");
  assert.equal(result.ok, true);
  assert.equal(result.packagedRuntime.isPackaged, true);
  assert.equal(result.packagedRuntime.defaultApp, false);
  assert.equal(result.packagedRuntime.productionEntrySha256, stagedEntryHash);
  assert.equal(Object.keys(result.packagedRuntime.helperHashes).length, 4);
  for (const [file, hash] of Object.entries(
    result.packagedRuntime.helperHashes,
  ))
    assert.equal(hash, packagedHashes[file]);
  assert.equal(result.harnessVersion, "cv-reading-correctness-v1");
  assert.equal(result.cases.length, 9);
  assert.ok(result.cases.every((x) => x.passed));
  const { trace, journal } = storage("read-only");
  try {
    const facts = await journal.read(threadId),
      semantic = await journal.readItemList(threadId);
    assert.equal(
      digest(semantic),
      originalSemantic,
      "Reading did not append/change model semantic history",
    );
    assert.equal(facts.filter((x) => x.type === "user_message").length, count);
    assert.deepEqual(
      facts.filter((x) => x.type.startsWith("user_message_queue")),
      [queued],
    );
    assert.equal(facts.filter((x) => x.type.includes("compact")).length, 0);
    const observed = await trace.read(threadId, { verifyArtifacts: false });
    assert.equal(observed.completeness, "complete");
    await writeFile(
      path.join(directory, "reading-storage.json"),
      JSON.stringify(
        {
          independentReopen: true,
          semanticUnchanged: true,
          semanticDigest: originalSemantic,
          userMessages: count,
          queuedUnchanged: true,
          traceCompleteness: observed.completeness,
        },
        null,
        2,
      ),
    );
  } finally {
    await journal.close();
    await trace.flush();
  }
  cleanupSafe = true;
} finally {
  await writeFile(
    path.join(temporary, "owned-app-output.log"),
    Buffer.concat(childOutput),
  );
  await writeFile(
    path.join(directory, "reading-lifecycle.json"),
    JSON.stringify(
      {
        childCloseObserved: observedClose !== undefined,
        exitCode: observedClose?.code ?? null,
        signal: observedClose?.signal ?? null,
        captureValidated: cleanupSafe,
        privateFixturePolicy: cleanupSafe
          ? "removed after validated normal close"
          : "retained privately; not uploaded",
      },
      null,
      2,
    ),
  );
  if (cleanupSafe) await rm(temporary, { recursive: true, force: true });
}
