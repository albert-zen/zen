import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  nativeProcessIdentity,
  requestFixtureControl,
  settleOwnedLaunch,
} from "../scripts/macos-launch-path-cleanup.mjs";
import {
  bundleDigest,
  validateLaunchRound,
} from "../scripts/smoke-macos-launch-path.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zx-lp-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    round: "unit",
    receiptId: randomUUID(),
    controlToken: randomUUID(),
    controlSocket: path.join(directory, "control.sock"),
    ownershipFile: path.join(directory, "owner.json"),
  };
}

async function startHungMain(t, config) {
  const source = `
    import { Worker } from 'node:worker_threads';
    import { existsSync, writeFileSync } from 'node:fs';
    const config = ${JSON.stringify(config)};
    const worker = new Worker(new URL(${JSON.stringify(new URL("../scripts/macos-launch-path-control.mjs", import.meta.url).href)}), { workerData: { config }, execArgv: [] });
    worker.on('error', (error) => { console.error(error.message); process.exit(1); });
    const check = setInterval(() => {
      if (!existsSync(config.ownershipFile)) return;
      clearInterval(check);
      writeFileSync(config.directory + '/main-hung', 'true');
      while (true) {} // Deliberately prevent all main-loop watchdogs and IPC.
    }, 5);
  `;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      source,
      "--",
      `--zenx-launch-path-instance=${config.receiptId}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (data) => (stderr += data.toString()));
  const exited = once(child, "exit");
  t.after(async () => {
    // Only this directly owned unreaped test child is eligible for fallback.
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Control fixture exited: ${stderr}`);
    try {
      await readFile(path.join(config.directory, "main-hung"));
      return {
        child,
        exited,
        identity: JSON.parse(await readFile(config.ownershipFile, "utf8")),
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error(`Control fixture did not become ready: ${stderr}`);
}

test(
  "owned independent control survives a hung main loop and refuses forged target credentials",
  { skip: process.platform === "win32" },
  async (t) => {
    const config = await fixture(t);
    const { child, exited, identity } = await startHungMain(t, config);
    assert.equal(
      (await requestFixtureControl(config, identity, "inspect")).pid,
      child.pid,
    );
    for (const [wrongConfig, wrongIdentity] of [
      [{ ...config, controlToken: randomUUID() }, identity],
      [config, { ...identity, start: "wrong-start" }],
      [config, { ...identity, bootId: randomUUID() }],
      [config, { ...identity, pid: process.pid }],
      [config, { ...identity, executable: "/bin/sh" }],
    ])
      await assert.rejects(
        requestFixtureControl(wrongConfig, wrongIdentity, "terminate"),
        /identity mismatch/u,
      );
    assert.equal(
      (await nativeProcessIdentity(child.pid)).start,
      identity.start,
    );
    const result = await settleOwnedLaunch(config, process.execPath, {
      allowTerminate: true,
    });
    assert.deepEqual(result, { exited: true, forced: true, pid: child.pid });
    assert.deepEqual(await exited, [null, "SIGKILL"]);
    // Repeated cleanup only confirms absence; it never signals a saved PID.
    assert.deepEqual(
      await settleOwnedLaunch(config, process.execPath, {
        allowTerminate: true,
      }),
      { exited: true, forced: false, pid: child.pid },
    );
  },
);

test(
  "wrong OS start identity preserves the live fixture rather than signalling it",
  { skip: process.platform === "win32" },
  async (t) => {
    const config = await fixture(t);
    const { child, identity } = await startHungMain(t, config);
    await writeFile(
      config.ownershipFile,
      JSON.stringify({ ...identity, start: "stale-start" }),
    );
    const rejected = await settleOwnedLaunch(config, process.execPath, {
      allowTerminate: true,
    });
    assert.equal(rejected.exited, false);
    assert.equal(rejected.forced, false);
    assert.match(rejected.error, /identity changed/u);
    assert(await nativeProcessIdentity(child.pid));
    await writeFile(config.ownershipFile, JSON.stringify(identity));
    assert.equal(
      (
        await settleOwnedLaunch(config, process.execPath, {
          allowTerminate: true,
        })
      ).exited,
      true,
    );
  },
);

test("missing ownership receipt cannot authorize termination", async (t) => {
  const config = await fixture(t);
  const outcome = await settleOwnedLaunch(config, process.execPath, {
    allowTerminate: true,
  });
  assert.equal(outcome.exited, false);
  assert.equal(outcome.forced, false);
});

test(
  "missing ownership receipt and unavailable private endpoint fail closed",
  { skip: process.platform === "win32" },
  async (t) => {
    const config = await fixture(t);
    assert.equal(
      (
        await settleOwnedLaunch(config, process.execPath, {
          allowTerminate: true,
        })
      ).exited,
      false,
    );
    const { child } = await startHungMain(t, config);
    const outcome = await settleOwnedLaunch(
      { ...config, controlSocket: path.join(config.directory, "missing.sock") },
      process.execPath,
      { allowTerminate: true },
    );
    assert.equal(outcome.exited, false);
    assert.equal(outcome.forced, false);
    assert(await nativeProcessIdentity(child.pid));
    assert.equal(
      (
        await settleOwnedLaunch(config, process.execPath, {
          allowTerminate: true,
        })
      ).exited,
      true,
    );
    const runner = await readFile(
      new URL("../scripts/smoke-macos-launch-path.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      runner,
      /if \(!shutdown\.exited\) \{\s+retainFixture = true;/u,
    );
    assert.match(runner, /if \(capabilities && !retainFixture\)/u);
    assert.match(runner, /if \(!retainFixture\) \{\s+await rm\(root/u);
  },
);

for (const rejectStop of [false, true])
  test(`real HostLifecycle ${rejectStop ? "rejecting" : "successful"} stop preserves shutdown outcome despite will-quit exit code zero`, async (t) => {
    const config = await fixture(t);
    config.evidence = path.join(config.directory, "evidence");
    await mkdir(config.evidence);
    const configPath = path.join(config.directory, "config.json");
    await writeFile(configPath, JSON.stringify(config));
    const source = `
    import { ZenXHostLifecycle } from ${JSON.stringify(new URL("../src/main/host-lifecycle.ts", import.meta.url).href)};
    import { observeShutdownFailure, observeQuit } from ${JSON.stringify(new URL("../scripts/macos-launch-path-observer.mjs", import.meta.url).href)};
    const lifecycle = new ZenXHostLifecycle({ platform: 'darwin', windowCount: () => 0, createWindow() {},
      stopHost: async () => { ${rejectStop ? "throw new Error('synthetic-stop-rejection');" : ""} },
      reportStopFailure: observeShutdownFailure,
      finishQuit: observeQuit,
    });
    lifecycle.beforeQuit(() => {});
    await lifecycle.quitCompletion;
  `;
    await run(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      {
        cwd: root,
        env: { ...process.env, ZENX_LAUNCH_PATH_FIXTURE: configPath },
      },
    );
    const observed = Object.fromEntries(
      await Promise.all(
        (await readdir(config.evidence)).map(async (name) => [
          name.slice(0, -5),
          JSON.parse(await readFile(path.join(config.evidence, name), "utf8")),
        ]),
      ),
    );
    assert.equal(observed.quit.exitCode, 0);
    assert.equal(observed.quit.shutdownFailureCount, rejectStop ? 1 : 0);
    if (rejectStop)
      assert.match(
        observed["shutdown-failure-1"].error,
        /synthetic-stop-rejection/u,
      );
    const base = {
      round: config.round,
      receiptId: config.receiptId,
      pid: observed.quit.pid,
    };
    const hosts = [observed.quit.pid + 1, observed.quit.pid + 2];
    const records = {
      entry: {
        ...base,
        packaged: true,
        platform: "darwin",
        sparsePath: true,
        hasFixturePath: false,
        terminal: false,
        noProfileSecrets: true,
        isolatedHome: true,
        isolatedUserData: true,
      },
      capture: {
        ...base,
        result: "restored",
        hasFixturePath: true,
        noProfileSecrets: true,
      },
      complete: {
        ...base,
        ok: true,
        rendererSafeRestart: true,
        hostPids: hosts,
        noProfileSecrets: true,
      },
      ...Object.fromEntries(
        hosts.map((pid) => [
          `host-${pid}`,
          {
            ...base,
            pid,
            parentPid: base.pid,
            hasFixturePath: true,
            noProfileSecrets: true,
            owner: { kind: "builtin", id: "shell" },
            exitCode: 0,
            markerMatched: true,
          },
        ]),
      ),
      ...observed,
    };
    if (rejectStop)
      assert.throws(
        () => validateLaunchRound(records, config.round, config.receiptId),
        /observer reported failure/u,
      );
    else
      assert.doesNotThrow(() =>
        validateLaunchRound(records, config.round, config.receiptId),
      );
    assert(
      !JSON.stringify(observed).includes(config.controlToken),
      "Public receipts must not disclose private control credentials",
    );
  });

test("bundle evidence digest changes when signed resources change", async (t) => {
  const config = await fixture(t);
  const directory = path.join(config.directory, "ZenX.app");
  await mkdir(directory);
  await writeFile(path.join(directory, "resource"), "before");
  const before = await bundleDigest(directory);
  assert.equal(await bundleDigest(directory), before);
  await writeFile(path.join(directory, "resource"), "after");
  assert.notEqual(await bundleDigest(directory), before);
});
