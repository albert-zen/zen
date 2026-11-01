/** Launch only the owned synthetic Electron App on disposable Linux CI. */
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
import { waitForSmokeProcess } from "./workspace-browser-persistence-smoke.mjs";
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.platform, "linux");
const directory = path.resolve(process.argv[2]);
const version = process.argv[3];
const expected = {
  before: "c6f4592e15c6abbc5db890a86ceef0865f70681e",
  current: "4ed8fb0f2294d234a10cf293b67335f72d2bb332",
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
for (const d of [profile, data, home, workspace])
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
      hashes,
      scope:
        "Actual production main/preload/renderer and fake local Host. Idle Thread initialized through real protocol, NOT UI first-Send creation. Actual UI selects thread, opens Subagents and maximizes pane. Linux Electron only.",
    },
    null,
    2,
  ),
);
// Do not pass inherited provider/auth environment variables to the owned App.
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      key === "XAUTHORITY" || // Owned Xvfb cookie, required for this isolated display.
      !/(OPENAI|ANTHROPIC|GEMINI|GOOGLE_API|AZURE|CODEX|AUTH|TOKEN|SECRET|PASSWORD|ZENX_|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|ELECTRON_EXTRA_LAUNCH_ARGS|NODE_OPTIONS)/i.test(
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
const child = spawn(
  electron,
  [
    path.join(root, "scripts/capture-full-app-expansion.cjs"),
    directory,
    version,
    temporary,
    `--user-data-dir=${profile}`,
  ],
  { env: environment, stdio: ["ignore", "inherit", "inherit"] },
);
let cleanupSafe = true;
try {
  const code = await waitForSmokeProcess(child, 180000).catch((error) => {
    cleanupSafe = error.reaped !== false;
    throw error;
  });
  assert.equal(code, 0, "Owned full App diagnostic must pass");
  const result = JSON.parse(
    await readFile(path.join(directory, "full-app-measurements.json"), "utf8"),
  );
  assert.equal(result.ok, true);
} finally {
  if (cleanupSafe) await rm(temporary, { recursive: true, force: true });
  else
    console.error(
      "Owned diagnostic process exit unconfirmed; private fixture retained, not uploaded",
    );
}
