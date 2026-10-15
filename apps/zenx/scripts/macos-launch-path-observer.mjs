// Copied only into an isolated acceptance app before its existing ad-hoc signing.
// This observes the production bootstrap and Host composition, without supplying
// PATH, replacing recovery, constructing a Shell runtime, or adding product IPC.
import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

const config = JSON.parse(
  readFileSync(process.env.ZENX_LAUNCH_PATH_FIXTURE, "utf8"),
);
let watchdog;
let appInstance;
let shutdownFailureCount = 0;

function receipt(name, record) {
  writeFileSync(
    path.join(config.evidence, `${name}.json`),
    JSON.stringify(
      {
        round: config.round,
        receiptId: config.receiptId,
        pid: process.pid,
        ...record,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
}

function hasFixturePath() {
  return process.env.PATH?.split(path.delimiter).includes(config.bin) === true;
}

export function matchesFixtureUserData(userData) {
  return realpathSync(userData) === realpathSync(config.userData);
}

function noProfileSecrets() {
  return (
    process.env.ZENX_SYNTHETIC_PROFILE_SECRET === undefined &&
    process.env.ZENX_SYNTHETIC_PROFILE_TOKEN === undefined
  );
}

function fail(error) {
  try {
    receipt(`failure-${process.pid}`, { ok: false, error: String(error) });
  } catch {
    /* Retain first failure. */
  }
  if (appInstance) {
    process.exitCode = 1;
    appInstance.quit();
    setTimeout(() => appInstance.exit(1), 10_000).unref();
  }
}

export function observeMain(app) {
  appInstance = app;
  const control = new Worker(
    new URL("./macos-launch-path-control.mjs", import.meta.url),
    { workerData: { config }, execArgv: [] },
  );
  control.on("error", fail);
  control.unref();
  // The watchdog only stops this owned fixture app; no saved PID is signalled.
  watchdog = setTimeout(
    () => fail(new Error("LaunchServices acceptance timed out")),
    120_000,
  );
  app.once("will-quit", () => {
    clearTimeout(watchdog);
    observeQuit();
  });
  try {
    const terminal = Boolean(
      process.stdin.isTTY ||
      process.stdout.isTTY ||
      process.env.TERM_PROGRAM ||
      (process.env.TERM && process.env.TERM !== "dumb"),
    );
    receipt("entry", {
      packaged: app.isPackaged,
      platform: process.platform,
      sparsePath: process.env.PATH === config.sparsePath,
      hasFixturePath: hasFixturePath(),
      terminal,
      noProfileSecrets: noProfileSecrets(),
      isolatedHome:
        process.env.HOME === config.home && process.env.ZDOTDIR === config.home,
      isolatedUserData: matchesFixtureUserData(app.getPath("userData")),
    });
    assert(
      app.isPackaged && process.platform === "darwin",
      "Expected a packaged macOS app",
    );
    assert.equal(
      process.env.PATH,
      config.sparsePath,
      "LaunchServices did not apply sparse PATH",
    );
    assert(
      !terminal && !hasFixturePath() && noProfileSecrets(),
      "Expected a clean GUI launch context",
    );
    assert.equal(process.env.HOME, config.home);
    assert.equal(process.env.ZDOTDIR, config.home);
    assert(
      matchesFixtureUserData(app.getPath("userData")),
      "App userData does not resolve to the isolated fixture directory",
    );
  } catch (error) {
    fail(error);
    throw error;
  }
}

export function observeQuit() {
  receipt("quit", {
    event: "will-quit",
    exitCode: process.exitCode ?? 0,
    shutdownFailureCount,
  });
}

export function observeShutdownFailure(error) {
  shutdownFailureCount += 1;
  try {
    receipt(`shutdown-failure-${shutdownFailureCount}`, {
      ok: false,
      error: String(error),
    });
  } catch (recordingError) {
    // Keep the count for the quit receipt and let the original product reporter
    // run. A diagnostic write failure must never erase the real stop failure.
    console.error("Launch path shutdown receipt failed", recordingError);
  }
}

export function observeCapture(result) {
  try {
    receipt("capture", {
      result,
      hasFixturePath: hasFixturePath(),
      noProfileSecrets: noProfileSecrets(),
    });
    assert.equal(
      result,
      "restored",
      "Real login-shell capture did not restore PATH",
    );
    assert(
      hasFixturePath(),
      "Real login-shell capture omitted the profile fixture bin",
    );
    assert(
      noProfileSecrets(),
      "Login-shell capture imported synthetic secrets",
    );
  } catch (error) {
    fail(error);
    throw error;
  }
}

export async function observeHost(toolEnvironment) {
  try {
    assert(hasFixturePath(), "Real Host did not inherit recovered PATH");
    assert(noProfileSecrets(), "Real Host imported synthetic profile secrets");
    const prepared = toolEnvironment.prepare({
      name: "shell",
      callId: `launch-path-${config.round}-${process.pid}`,
      arguments: { command: "zenx-path-fixture", timeout_ms: 5_000 },
      task: { waitForCompletion: true },
      cwd: config.home,
      signal: AbortSignal.timeout(10_000),
    });
    assert.deepEqual(prepared.owner, { kind: "builtin", id: "shell" });
    const result = await toolEnvironment.execute(prepared);
    assert.equal(
      result.exitCode,
      0,
      "The first real Host shell command failed",
    );
    assert.equal(
      result.output.trim(),
      config.marker,
      "The first real Host shell command did not produce its marker",
    );
    receipt(`host-${process.pid}`, {
      parentPid: process.ppid,
      hasFixturePath: hasFixturePath(),
      noProfileSecrets: noProfileSecrets(),
      owner: prepared.owner,
      exitCode: result.exitCode,
      markerMatched: result.output.trim() === config.marker,
    });
  } catch (error) {
    fail(error);
    throw error;
  }
}

function hosts() {
  return readdirSync(config.evidence)
    .filter((name) => /^host-\d+\.json$/u.test(name))
    .map((name) =>
      JSON.parse(readFileSync(path.join(config.evidence, name), "utf8")),
    );
}

async function until(check, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function completeMain(app, appWindows) {
  try {
    const before = hosts();
    assert.equal(
      before.length,
      1,
      "Expected one initial Host before safe restart",
    );
    let window;
    await until(async () => {
      window = appWindows().find(
        (candidate) =>
          !candidate.isDestroyed() &&
          /\/renderer\/index\.html(?:$|[?#])/u.test(
            candidate.webContents.getURL(),
          ),
      );
      if (!window || window.webContents.isLoading()) return false;
      return await window.webContents.executeJavaScript(
        "document.readyState === 'complete' && !!document.getElementById('root')?.firstElementChild && typeof window.zenx?.settings?.safeRestart === 'function'",
      );
    }, "the real app renderer and preload bridge");
    await window.webContents.executeJavaScript(
      "window.zenx.settings.safeRestart().then(() => true)",
    );
    const after = hosts();
    assert.equal(
      after.length,
      2,
      "Safe restart did not create exactly one new Host",
    );
    assert.notEqual(
      after[0].pid,
      after[1].pid,
      "Safe restart reused the Host PID",
    );
    assert(
      after.every(
        (host) => host.parentPid === process.pid && host.markerMatched,
      ),
      "Host receipt did not belong to this app",
    );
    receipt("complete", {
      ok: true,
      rendererSafeRestart: true,
      hostPids: after.map((host) => host.pid),
      noProfileSecrets: noProfileSecrets(),
    });
    app.quit();
  } catch (error) {
    fail(error);
    throw error;
  }
}
