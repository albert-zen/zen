// Opt-in hosted acceptance, not a local developer smoke test. No OS grants or input.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "vite";
import { stageAppShotRuntime } from "./stage-app-shot-runtime.mjs";
import {
  bounded,
  closeOwnedFixture,
  initialReceipt,
  acceptanceExitCode,
  failedOutcome,
  requireAcceptance,
  AcceptanceError,
} from "../test/fixtures/app-shot-macos-contract.mjs";

const root = resolve(import.meta.dirname, "../../..");
const artifacts = resolve(process.argv[2]);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
let receipt = initialReceipt();
let scratch;
let fixture;
let fixtureClose;
let electron;
let electronClose;
let stop;
function start(file, args, env = process.env) {
  const child = spawn(file, args, { env, stdio: "ignore" });
  const closed = new Promise((resolve) => {
    child.once("error", () => {});
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, closed };
}

try {
  requireAcceptance(
    process.platform === "darwin" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.ZENX_APP_SHOT_MACOS_ACCEPTANCE === "1",
    "opt-in-required",
    true,
  );
  // Refuse even staging/running the harness against the old all-window adapter.
  const serviceSource = await readFile(
    join(root, "apps/zenx/src/main/app-shot.ts"),
    "utf8",
  );
  requireAcceptance(
    serviceSource.includes("hasExactWindowSurfaceCapture"),
    "exact-backend-unavailable",
    true,
  );
  scratch = await realpath(
    await mkdtemp(join(tmpdir(), "zenx-owned-app-shot-")),
  );
  const appDirectory = join(scratch, "electron-app");
  const mainDirectory = join(appDirectory, "out/main");
  await mkdir(mainDirectory, { recursive: true });
  await cp(
    join(root, "apps/zenx/out/main/app-shot-native-worker.js"),
    join(mainDirectory, "app-shot-native-worker.js"),
  );
  await cp(
    join(root, "apps/zenx/out/main/chunks"),
    join(mainDirectory, "chunks"),
    { recursive: true },
  );
  await stageAppShotRuntime(root, appDirectory, "darwin", process.arch);
  await writeFile(
    join(appDirectory, "package.json"),
    JSON.stringify({
      name: "zenx-owned-app-shot-acceptance",
      private: true,
      type: "module",
      main: "acceptance.mjs",
    }),
  );
  await build({
    configFile: false,
    root,
    logLevel: "silent",
    build: {
      ssr: join(root, "apps/zenx/test/fixtures/app-shot-macos-main.mjs"),
      outDir: appDirectory,
      emptyOutDir: false,
      minify: false,
      rollupOptions: {
        external: [
          "electron",
          "sharp",
          "ffi-rs",
          "@crowecawcaw/xa11y",
          "dbus-next",
        ],
        output: {
          entryFileNames: "acceptance.mjs",
          // Preserve platform boundaries: inlining hoists Linux-only externals
          // into the macOS entry even when that capture path is never selected.
          chunkFileNames: "acceptance-chunks/[name]-[hash].mjs",
        },
      },
    },
  });
  const bundle = join(scratch, "Owned App Shot.app");
  const executable = join(bundle, "Contents/MacOS/OwnedAppShot");
  await mkdir(join(bundle, "Contents/MacOS"), { recursive: true });
  await writeFile(
    join(bundle, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>OwnedAppShot</string><key>CFBundleIdentifier</key><string>io.zenx.synthetic.app-shot</string><key>CFBundleName</key><string>Owned App Shot</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/></dict></plist>`,
  );
  await promisify(execFile)(
    "/usr/bin/xcrun",
    [
      "swiftc",
      join(root, "apps/zenx/test/fixtures/app-shot-macos-owned.swift"),
      "-o",
      executable,
    ],
    { timeout: 60_000, maxBuffer: 64 * 1024 },
  );
  const nonce = randomBytes(16).toString("hex");
  stop = join(scratch, "stop");
  const probe = join(scratch, "probe");
  const snapshot = join(scratch, "snapshot.json");
  ({ child: fixture, closed: fixtureClose } = start(executable, [
    "--nonce",
    nonce,
    "--probe",
    probe,
    "--snapshot",
    snapshot,
    "--stop",
    stop,
  ]));
  requireAcceptance(
    Number.isSafeInteger(fixture.pid) && fixture.pid > 0,
    "fixture-launch-failed",
  );
  const configPath = join(scratch, "config.json");
  const result = join(scratch, "result.json");
  const userData = join(scratch, "user-data");
  await mkdir(userData);
  await writeFile(
    configPath,
    JSON.stringify({
      owned: { pid: fixture.pid, nonce, bundle, executable },
      probe,
      snapshot,
      artifacts,
      result,
      userData,
      appDirectory,
    }),
    { mode: 0o600 },
  );
  const require = createRequire(join(root, "apps/zenx/package.json"));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  ({ child: electron, closed: electronClose } = start(
    require("electron"),
    [appDirectory, configPath],
    environment,
  ));
  const outcome = await bounded(
    Promise.race([
      electronClose,
      fixtureClose.then(() => {
        throw new AcceptanceError("fixture-closed-before-acceptance");
      }),
    ]),
    45_000,
  );
  requireAcceptance(
    outcome.code === 0 && outcome.signal === null,
    "electron-process-failed",
  );
  receipt = JSON.parse(await readFile(result, "utf8"));
} catch (error) {
  receipt.pixels = failedOutcome(error);
  receipt.accessibility = {
    status: "blocked",
    reason: "harness-not-completed",
  };
  receipt.foreground = { status: "blocked", reason: "harness-not-completed" };
} finally {
  // Only the actual ChildProcess owned by this launcher may be terminated.
  if (electron && electron.exitCode === null && electron.signalCode === null) {
    electron.kill("SIGTERM");
    try {
      await bounded(electronClose, 2000);
    } catch {
      electron.kill("SIGKILL");
      try {
        await bounded(electronClose, 2000);
      } catch {
        receipt.cleanup = {
          status: "failed",
          reason: "electron-close-unconfirmed",
        };
      }
    }
  }
  if (fixture) {
    try {
      const cleanup = await closeOwnedFixture(
        () => writeFile(stop, "stop", { mode: 0o600 }),
        fixtureClose,
      );
      if (receipt.cleanup.status !== "failed") receipt.cleanup = cleanup;
    } catch {
      receipt.cleanup = {
        status: "failed",
        reason: "fixture-close-unconfirmed",
      };
    }
  } else receipt.cleanup = { status: "blocked", reason: "fixture-not-started" };
  // Leave the stop file in place until close is actually observed, even on failure.
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
    try {
      await bounded(fixtureClose, 90_000);
    } catch {
      /* Still a failure; never kill a PID from a receipt. */
    }
  }
  if (
    scratch &&
    (!fixture || fixture.exitCode !== null || fixture.signalCode !== null)
  ) {
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch {
      receipt.cleanup = {
        status: "failed",
        reason: "private-scratch-cleanup-failed",
      };
    }
  }
  receipt.sourceRevision = /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "")
    ? process.env.GITHUB_SHA
    : "unavailable";
  const exitCode = acceptanceExitCode(receipt);
  await writeFile(
    join(artifacts, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    `Owned macOS App Shot acceptance: ${exitCode === 0 ? "passed" : exitCode === 2 ? "blocked" : "failed"}; see allowlisted receipt.`,
  );
  process.exitCode = exitCode;
}
