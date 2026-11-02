/** Actual isolated Electron App; synthetic data never leaves its private profile. */
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
import {
  seedUserQuestionAcceptance,
  verifyUserQuestionAcceptance,
} from "./seed-user-question-acceptance.mjs";
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.ok(["win32", "darwin"].includes(process.platform));
const directory = path.resolve(process.argv[2]);
const root = fileURLToPath(new URL("../", import.meta.url));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
assert.equal(
  execFileSync("git", ["diff", "--name-only", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  "",
  "Capture must use an unchanged production checkout",
);
await mkdir(directory, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), "zenx-owned-question-"));
const profile = path.join(temporary, "profile"),
  data = path.join(temporary, "zen-data"),
  home = path.join(temporary, "home"),
  workspace = path.join(temporary, "workspace");
for (const p of [profile, data, home, workspace, path.join(home, "Documents")])
  await mkdir(p, { recursive: true, mode: 0o700 });
await writeFile(
  path.join(workspace, "fixture.txt"),
  "Synthetic workspace resource. No user data.\n",
);
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
            description: "Offline question card acceptance",
            hidden: false,
            source: "manual",
            supportedReasoningEfforts: ["medium"],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
            contextWindow: 1000000,
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
const fixture = await seedUserQuestionAcceptance({ data, workspace });
await writeFile(path.join(temporary, "fixture.json"), JSON.stringify(fixture));
const hashes = {};
for (const file of [
  ...(
    await Promise.all(
      ["out/main", "out/preload", "out/renderer"].map(async (directory) =>
        (await readdir(path.join(root, directory), { recursive: true }))
          .filter((file) => /\.(html|js|cjs|css|json|png|svg)$/.test(file))
          .map((file) => directory + "/" + file),
      ),
    )
  ).flat(),
  "src/renderer/src/App.tsx",
  "src/renderer/src/plugin-information-host.tsx",
  "src/renderer/src/UserQuestionCards.tsx",
  "src/renderer/src/user-question-state.ts",
  "scripts/seed-user-question-acceptance.mjs",
  "src/renderer/src/ConversationInformationCards.tsx",
  "scripts/capture-user-question.cjs",
  "scripts/launch-user-question-acceptance.mjs",
])
  hashes[file] = createHash("sha256")
    .update(await readFile(path.join(root, file)))
    .digest("hex");
await writeFile(
  path.join(directory, "source.json"),
  JSON.stringify(
    {
      sourceCommit,
      sourceTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
        encoding: "utf8",
      }).trim(),
      platform: process.platform,
      hashes,
      synthetic: true,
      scope:
        "Full production Electron App, preload, child Host, native input, production DomainThreadJournal. Private fake provider only. Questions genuinely published by a separate explicitly enabled Host, closed before normal Desktop starts with default-off publication. One driver-only lost IPC reply after real Host admission; no injected UI, no user data, no user device.",
    },
    null,
    2,
  ),
);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(HOME|USERPROFILE|USER_HOME|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|XDG_CONFIG_HOME|XDG_CACHE_HOME)$/i.test(
        key,
      ) &&
      !/OPENAI|ANTHROPIC|GEMINI|GOOGLE_API|AZURE|CODEX|AUTH|TOKEN|SECRET|PASSWORD|ZENX_|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|ELECTRON_EXTRA_LAUNCH_ARGS|NODE_OPTIONS/i.test(
        key,
      ),
  ),
);
Object.assign(environment, {
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  ZENX_DATA_DIR: data,
  GITHUB_ACTIONS: "true",
});
if (process.platform === "win32") {
  Object.assign(environment, {
    USERPROFILE: home,
    USER_HOME: home,
    HOMEDRIVE: path.parse(home).root.slice(0, 2),
    HOMEPATH: home.slice(2),
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
  });
  await mkdir(environment.APPDATA, { recursive: true });
  await mkdir(environment.LOCALAPPDATA, { recursive: true });
}
const child = spawn(
  electron,
  [
    path.join(root, "scripts/capture-user-question.cjs"),
    directory,
    temporary,
    `--user-data-dir=${profile}`,
  ],
  {
    env: environment,
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform === "darwin",
  },
);
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
let validated = false,
  observedClose;
child.once("close", (code, signal) => {
  observedClose = { code, signal };
});
try {
  const code = await (
    process.platform === "win32" ? waitOwnedWindowsTree : waitOwnedPosixGroup
  )(child, 240000);
  assert.equal(code, 0, "Owned production App acceptance must pass");
  const result = JSON.parse(
    await readFile(path.join(directory, "acceptance.json"), "utf8"),
  );
  assert.equal(result.ok, true);
  assert.ok(result.cases.length >= 5);
  assert.equal(result.receipts.length, 3);
  result.coldModelInputVerification = await verifyUserQuestionAcceptance({
    data,
    workspace,
    receipts: result.receipts,
  });
  await writeFile(
    path.join(directory, "acceptance.json"),
    JSON.stringify(result, null, 2),
  );
  validated = true;
} finally {
  await writeFile(
    path.join(directory, "lifecycle.json"),
    JSON.stringify(
      {
        observedClose,
        validated,
        privateFixture: validated
          ? "removed after confirmed normal Host shutdown"
          : "retained privately, not uploaded",
      },
      null,
      2,
    ),
  );
  if (validated) await rm(temporary, { recursive: true, force: true });
}
