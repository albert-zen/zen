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

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.ok(["win32", "darwin"].includes(process.platform));
const directory = path.resolve(process.argv[2]);
const version = process.argv[3];
const expected = {
  before: "c6f4592e15c6abbc5db890a86ceef0865f70681e",
  current: "dd25fe08cffd4d77421e8349ded2a150e106f74c",
}[version];
assert.ok(expected);
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  expected,
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
    version: 1,
    onboardingComplete: true,
    provider: { type: "fake", displayName: "Synthetic local only" },
    defaultModel: "fake",
    titleModel: "fake",
    models: ["fake"],
    workspace: null,
    workspaces: [],
    lastUsedWorkspace: null,
    approvalPolicy: "never",
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
  "scripts/capture-full-app-expansion.cjs",
  "scripts/launch-full-app-expansion.mjs",
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
      comparisonRole:
        version === "current"
          ? "fixed-product-candidate"
          : "unmodified-before-primary-control",
      platform: process.platform,
      hashes,
      scope:
        "Actual production main/preload/renderer and fake local Host. Idle Thread initialized through real protocol, NOT UI first-Send creation. Actual UI selects thread, opens Subagents and maximizes pane. Native Electron platform recorded separately; no CSS platform emulation.",
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
  electron,
  [
    path.join(root, "scripts/capture-full-app-expansion.cjs"),
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
  )(child, 180000);
  assert.equal(code, 0, "Owned full App diagnostic must pass");
  const result = JSON.parse(
    await readFile(path.join(directory, "full-app-measurements.json"), "utf8"),
  );
  assert.equal(result.ok, true);
  cleanupSafe = true; // Successful production before-quit awaits stopZenXHost.
} finally {
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
