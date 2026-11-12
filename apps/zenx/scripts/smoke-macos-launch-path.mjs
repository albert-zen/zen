import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readlink,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createBuildSnapshot, packageZenX } from "./package-zenx-portable.mjs";
import { prepareLaunchPathApp } from "./macos-launch-path-instrumentation.mjs";
import { settleOwnedLaunch } from "./macos-launch-path-cleanup.mjs";

const run = promisify(execFile);
export const SPARSE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export async function createLaunchFixture(directory) {
  const home = path.join(directory, "home with spaces");
  const bin = path.join(home, "bin");
  const userData = path.join(directory, "user-data");
  const zenData = path.join(directory, "zen-data");
  const marker = `zenx-login-path-${randomUUID()}`;
  await Promise.all(
    [bin, userData, zenData].map((value) =>
      mkdir(value, { recursive: true, mode: 0o700 }),
    ),
  );
  await writeFile(
    path.join(home, ".zprofile"),
    'export PATH="$HOME/bin:$PATH"\nexport ZENX_SYNTHETIC_PROFILE_SECRET="synthetic-not-a-credential"\nexport ZENX_SYNTHETIC_PROFILE_TOKEN="synthetic-not-a-token"\n',
    { mode: 0o600 },
  );
  await writeFile(
    path.join(bin, "zenx-path-fixture"),
    `#!/bin/sh\n[ "\${ZENX_SYNTHETIC_PROFILE_SECRET+present}" != present ] || exit 91\n[ "\${ZENX_SYNTHETIC_PROFILE_TOKEN+present}" != present ] || exit 92\nprintf '%s\\n' '${marker}'\n`,
    { mode: 0o700 },
  );
  await writeFile(
    path.join(userData, "host-profile.json"),
    JSON.stringify({
      version: 1,
      onboardingComplete: true,
      provider: { type: "fake", displayName: "LaunchServices fixture" },
      defaultModel: "fake",
      titleModel: "gpt-5.6-luna",
      models: ["fake"],
      workspace: null,
      workspaces: [],
      lastUsedWorkspace: null,
      approvalPolicy: "never",
    }) + "\n",
    { mode: 0o600 },
  );
  return { home, bin, userData, zenData, marker, sparsePath: SPARSE_PATH };
}

export function launchServicesArguments(bundle, configPath, fixture) {
  const environment = {
    PATH: SPARSE_PATH,
    TERM: "",
    TERM_PROGRAM: "",
    HOME: fixture.home,
    ZDOTDIR: fixture.home,
    SHELL: "/bin/zsh",
    ZENX_DATA_DIR: fixture.zenData,
    ZENX_LAUNCH_PATH_FIXTURE: configPath,
  };
  return [
    "-n",
    "-W",
    "-a",
    bundle,
    ...Object.entries(environment).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]),
    "--args",
    `--user-data-dir=${fixture.userData}`,
    `--zenx-launch-path-instance=${fixture.receiptId}`,
  ];
}

export function validateLaunchRound(records, round, receiptId) {
  const named = (name) => {
    const record = records[name];
    assert(record, `Missing ${name} receipt`);
    assert.equal(record.round, round);
    assert.equal(record.receiptId, receiptId);
    return record;
  };
  assert(
    !Object.keys(records).some(
      (name) =>
        name.startsWith("failure-") || name.startsWith("shutdown-failure-"),
    ),
    "An observer reported failure",
  );
  const entry = named("entry");
  assert(
    entry.packaged === true &&
      entry.platform === "darwin" &&
      entry.sparsePath === true &&
      entry.hasFixturePath === false &&
      entry.terminal === false &&
      entry.noProfileSecrets === true &&
      entry.isolatedHome === true &&
      entry.isolatedUserData === true,
    "LaunchServices context did not prove an isolated sparse-PATH GUI launch",
  );
  assert(Number.isSafeInteger(entry.pid) && entry.pid > 0);
  const capture = named("capture");
  assert(
    capture.pid === entry.pid &&
      capture.result === "restored" &&
      capture.hasFixturePath === true &&
      capture.noProfileSecrets === true,
    "Real bootstrap recovery did not pass",
  );
  const complete = named("complete");
  assert(
    complete.pid === entry.pid &&
      complete.ok === true &&
      complete.rendererSafeRestart === true &&
      complete.noProfileSecrets === true,
    "Renderer safe-restart did not complete",
  );
  assert.equal(complete.hostPids?.length, 2);
  assert.notEqual(complete.hostPids[0], complete.hostPids[1]);
  const hostNames = Object.keys(records).filter((name) =>
    /^host-\d+$/u.test(name),
  );
  assert.equal(hostNames.length, 2, "Unexpected Host construction count");
  for (const pid of complete.hostPids) {
    assert(Number.isSafeInteger(pid) && pid > 0 && pid !== entry.pid);
    const host = named(`host-${pid}`);
    assert(
      host.pid === pid &&
        host.parentPid === entry.pid &&
        host.hasFixturePath === true &&
        host.noProfileSecrets === true &&
        host.exitCode === 0 &&
        host.markerMatched === true,
      "First real Host tool execution did not pass",
    );
    assert.deepEqual(host.owner, { kind: "builtin", id: "shell" });
  }
  const quit = named("quit");
  assert(
    quit.pid === entry.pid &&
      quit.event === "will-quit" &&
      quit.exitCode === 0 &&
      quit.shutdownFailureCount === 0,
    "Normal app quit did not complete",
  );
  return { appPid: entry.pid, hostPids: complete.hostPids };
}

export function validateRelaunch(first, second) {
  assert.notEqual(
    first.appPid,
    second.appPid,
    "A fresh LaunchServices launch must have a new app PID",
  );
  assert.equal(
    new Set([...first.hostPids, ...second.hostPids]).size,
    4,
    "All observed Host lifetimes must be distinct",
  );
}

async function readRecords(directory) {
  const records = {};
  for (const name of await readdir(directory))
    if (name.endsWith(".json"))
      records[name.slice(0, -5)] = JSON.parse(
        await readFile(path.join(directory, name), "utf8"),
      );
  return records;
}

export async function bundleDigest(directory) {
  const digest = createHash("sha256");
  const visit = async (relative) => {
    const file = path.join(directory, relative);
    const entry = await lstat(file);
    const key = [relative.split(path.sep).join("/"), entry.mode & 0o777];
    if (entry.isSymbolicLink())
      digest.update(
        JSON.stringify([...key, "link", await readlink(file)]) + "\n",
      );
    else if (entry.isDirectory()) {
      digest.update(JSON.stringify([...key, "directory"]) + "\n");
      for (const name of (await readdir(file)).sort())
        await visit(path.join(relative, name));
    } else if (entry.isFile()) {
      const contents = createHash("sha256");
      for await (const chunk of createReadStream(file)) contents.update(chunk);
      digest.update(
        JSON.stringify([...key, "file", contents.digest("hex")]) + "\n",
      );
    } else throw new Error("Unexpected entry in signed app bundle");
  };
  await visit("");
  return digest.digest("hex");
}

export async function runMacOsLaunchPathSmoke({ capabilities = false } = {}) {
  assert.equal(
    process.platform,
    "darwin",
    "LaunchServices acceptance requires a real macOS runner",
  );
  const help = await run("/usr/bin/open", ["-h"]).catch((error) => ({
    stdout: error.stdout ?? "",
    stderr: error.stderr ?? "",
  }));
  assert(
    /--env\b/u.test(help.stdout + help.stderr),
    "This runner's /usr/bin/open does not support --env",
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-launch-path-"));
  // macOS Unix-domain sockets have a short pathname limit. This is a separately
  // owned private directory, never a shared or predictable socket pathname.
  const controlDirectory = await mkdtemp("/tmp/zenx-lp-control-");
  const evidenceBase =
    process.env.ZENX_LAUNCH_PATH_EVIDENCE ??
    path.join(os.tmpdir(), "zenx-launch-path-evidence");
  await mkdir(evidenceBase, { recursive: true, mode: 0o700 });
  const evidence = await mkdtemp(path.join(evidenceBase, "run-"));
  const previousIdentity = process.env.ZENX_CODESIGN_IDENTITY;
  const previousMode = process.env.ZENX_CODESIGN_MODE;
  process.env.ZENX_CODESIGN_IDENTITY = "-";
  delete process.env.ZENX_CODESIGN_MODE;
  const report = {
    schemaVersion: 1,
    bundleDigestFormat: "sorted-path-mode-type-content-sha256-v1",
    launchMethod: "/usr/bin/open -n -W -a",
    evidence,
    updater: "not-applicable: product has no updater or app.relaunch path",
    rounds: [],
    shutdowns: [],
  };
  const failures = [];
  let retainFixture = false;
  try {
    const repository = fileURLToPath(new URL("../../..", import.meta.url));
    const revision = (
      await run("git", ["rev-parse", "HEAD", "HEAD^{tree}"], {
        cwd: repository,
      })
    ).stdout
      .trim()
      .split("\n");
    report.source = {
      head: revision[0],
      tree: revision[1],
      workingTreeDirty: Boolean(
        (
          await run("git", ["status", "--porcelain", "--untracked-files=no"], {
            cwd: repository,
          })
        ).stdout.trim(),
      ),
    };
    const buildDirectory = await createBuildSnapshot(root);
    try {
      const fixture = await createLaunchFixture(root);
      const packaged = await packageZenX(["--app"], {
        buildDirectory,
        artifactDirectory: path.join(root, "artifacts"),
        prepareApp: prepareLaunchPathApp,
      });
      const bundle = path.join(packaged.packagedArtifact, "ZenX.app");
      await run("/usr/bin/codesign", [
        "--verify",
        "--deep",
        "--strict",
        bundle,
      ]);
      const signature = await run("/usr/bin/codesign", [
        "--display",
        "--verbose=2",
        bundle,
      ]);
      assert(
        /Signature=adhoc/u.test(signature.stdout + signature.stderr),
        "Fixture app must use the existing ad-hoc signing path",
      );
      report.bundleSha256 = await bundleDigest(bundle);
      for (const round of ["initial", "reopen"]) {
        const roundEvidence = path.join(evidence, round);
        await mkdir(roundEvidence, { mode: 0o700 });
        const config = {
          ...fixture,
          round,
          receiptId: randomUUID(),
          evidence: roundEvidence,
          controlToken: randomUUID(),
          controlSocket: path.join(controlDirectory, `${round}.sock`),
          ownershipFile: path.join(controlDirectory, `${round}.json`),
        };
        const configPath = path.join(root, `config-${round}.json`);
        await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
        let launchError;
        // Release the fixture only after both external exit and all normal
        // lifecycle receipts have been verified for this exact app lifetime.
        retainFixture = true;
        try {
          await run(
            "/usr/bin/open",
            launchServicesArguments(bundle, configPath, config),
            { timeout: 160_000, maxBuffer: 64 * 1024 },
          );
        } catch (error) {
          launchError = error;
        }
        const shutdown = await settleOwnedLaunch(config, packaged.executable, {
          allowTerminate: true,
        });
        report.shutdowns.push({ round, ...shutdown });
        if (!shutdown.exited) {
          retainFixture = true;
          throw new Error(
            "Owned app exit is unconfirmed; preserve the fixture and do not run provider smoke",
          );
        }
        if (shutdown.forced) {
          retainFixture = true;
          throw new Error(
            "App was forcibly terminated; normal Host cleanup is unconfirmed, so preserve the fixture and skip provider smoke",
          );
        }
        const records = await readRecords(roundEvidence);
        if (
          Object.keys(records).some((name) =>
            name.startsWith("shutdown-failure-"),
          ) ||
          records.quit?.shutdownFailureCount > 0
        ) {
          retainFixture = true;
          throw new Error(
            "Real Host shutdown reported failure; preserve its evidence and skip provider smoke",
          );
        }
        if (launchError) throw launchError;
        const result = validateLaunchRound(records, round, config.receiptId);
        assert.equal(
          result.appPid,
          shutdown.pid,
          "Public receipt does not match the externally observed app lifetime",
        );
        report.rounds.push(result);
        retainFixture = false;
      }
      validateRelaunch(...report.rounds);
      await run("/usr/bin/codesign", [
        "--verify",
        "--deep",
        "--strict",
        bundle,
      ]);
      assert.equal(
        await bundleDigest(bundle),
        report.bundleSha256,
        "Signed app bundle changed during acceptance",
      );
      report.ok = true;
      console.log(
        "LaunchServices sparse-PATH bootstrap, first Host shell tool, renderer safe restart, and normal quit/open: PASS",
      );
    } catch (error) {
      report.ok = false;
      report.error = String(error);
      failures.push(error);
    }
    await writeFile(
      path.join(evidence, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    if (capabilities && !retainFixture) {
      try {
        await packageZenX([], { buildDirectory });
      } catch (error) {
        failures.push(error);
      }
    } else if (capabilities)
      report.providerSkipped =
        "Owned app or normal Host shutdown is unconfirmed";
    if (failures.length)
      throw new AggregateError(
        failures,
        "Packaged macOS acceptance failed; see independent PATH report and provider output",
      );
    return report;
  } finally {
    if (previousIdentity === undefined)
      delete process.env.ZENX_CODESIGN_IDENTITY;
    else process.env.ZENX_CODESIGN_IDENTITY = previousIdentity;
    if (previousMode === undefined) delete process.env.ZENX_CODESIGN_MODE;
    else process.env.ZENX_CODESIGN_MODE = previousMode;
    if (report.ok === undefined) {
      report.ok = false;
      report.error =
        "Build preparation failed before LaunchServices validation";
    }
    report.fixtureRetained = retainFixture;
    if (retainFixture) report.retainedFixtureDirectory = root;
    try {
      await writeFile(
        path.join(evidence, "report.json"),
        JSON.stringify(report, null, 2) + "\n",
      );
    } finally {
      if (!retainFixture) {
        await rm(root, { recursive: true, force: true });
        await rm(controlDirectory, { recursive: true, force: true });
      }
      console.log(`LaunchServices evidence: ${evidence}`);
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await runMacOsLaunchPathSmoke({
    capabilities: process.argv.slice(2).includes("--capabilities"),
  });
