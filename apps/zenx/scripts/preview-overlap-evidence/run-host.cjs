const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");

// Windows Chromium keeps profile handles open until its process exits. Own
// profile deletion in the parent, after the exact child has settled.
function runOwnedElectron(
  executable,
  script = path.join(__dirname, "run.cjs"),
) {
  const profile = fs.mkdtempSync(
    path.join(os.tmpdir(), "zen-overlay-evidence-"),
  );
  const lifecycle = {
    childExitCode: null,
    childSignal: null,
    profileRemoved: false,
  };
  try {
    const child = spawnSync(executable, [script], {
      env: { ...process.env, ZENX_OVERLAY_EVIDENCE_PROFILE: profile },
      stdio: "inherit",
    });
    lifecycle.childExitCode = child.status;
    lifecycle.childSignal = child.signal;
    if (child.error) lifecycle.childError = String(child.error);
  } finally {
    try {
      fs.rmSync(profile, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
      lifecycle.profileRemoved = !fs.existsSync(profile);
    } catch (error) {
      lifecycle.cleanupError = String(error);
    }
  }
  return lifecycle;
}
module.exports = { runOwnedElectron };
if (require.main === module) {
  const assert = require("node:assert/strict");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const resolve = createRequire(path.join(process.cwd(), "package.json"));
  const lifecycle = runOwnedElectron(resolve("electron"));
  fs.writeFileSync(
    path.join(__dirname, "lifecycle.json"),
    JSON.stringify(lifecycle, null, 2),
  );
  process.exitCode =
    lifecycle.childExitCode === 0 &&
    lifecycle.profileRemoved &&
    !lifecycle.childError
      ? 0
      : 1;
}
