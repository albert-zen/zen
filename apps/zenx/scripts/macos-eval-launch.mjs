// Public entry: own the temporary profile until Electron and its process group exit.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { evaluationDuration } from "./macos-eval-lifecycle.mjs";
const output = process.env.ZENX_MACOS_EVAL_DIR;
let scratch,
  child,
  timer,
  forced = false;
const result = { errors: [], removed: false, remainingProcessGroup: false };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const groupAlive = () => {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const signalGroup = (signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const stopOwned = () => {
  forced = true;
  if (child?.pid) {
    signalGroup("SIGTERM");
    setTimeout(() => {
      if (groupAlive()) signalGroup("SIGKILL");
    }, 1000).unref();
  }
};
process.on("SIGINT", stopOwned);
process.on("SIGTERM", stopOwned);
let code = 1;
try {
  if (process.platform !== "darwin")
    throw Error("macOS evaluation requires darwin");
  if (!output)
    throw Error("Set ZENX_MACOS_EVAL_DIR to a new private directory");
  for (const [name, fallback, zero] of [
    ["ZENX_STATE_WATCH_MS", 300000, false],
    ["ZENX_MACOS_EVAL_TIMEOUT_MS", 300000, false],
    ["ZENX_MACOS_FIXTURE_HOLD_MS", 0, true],
  ])
    evaluationDuration(name, process.env[name], fallback, zero);
  const nonce = randomUUID();
  await mkdir(output, { recursive: false, mode: 0o700 });
  scratch = await mkdtemp(path.join(os.tmpdir(), "zenx-macos-owned-"));
  const owner = { nonce, parentPid: process.pid, scratch };
  await writeFile(path.join(scratch, ".owner.json"), JSON.stringify(owner));
  await writeFile(path.join(output, ".launcher.json"), JSON.stringify(owner));
  const electron = createRequire(import.meta.url)("electron");
  const entry =
    process.env.ZENX_MACOS_EVAL_ENTRY ??
    fileURLToPath(new URL("../out/macos-provider-eval.mjs", import.meta.url));
  if (forced) throw Error("Evaluation interrupted during startup");
  child = spawn(
    electron,
    [
      entry,
      ...process.argv.slice(2),
      `--user-data-dir=${path.join(scratch, "profile")}`,
    ],
    {
      detached: true,
      stdio: "inherit",
      env: {
        ...process.env,
        ZENX_EVAL_SCRATCH: scratch,
        ZENX_EVAL_NONCE: nonce,
      },
    },
  );
  result.childPid = child.pid;
  // The group is created by this live ChildProcess, never accepted from a file or user-supplied PID.
  timer = setTimeout(() => {
    forced = true;
    signalGroup("SIGTERM");
    setTimeout(() => {
      if (groupAlive()) signalGroup("SIGKILL");
    }, 1000).unref();
  }, 290000);
  const exited = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  result.exit = exited;
  code = exited.exitCode ?? 1;
} catch (error) {
  result.errors.push(String(error));
} finally {
  clearTimeout(timer);
  // A provider's first Swift compile may not honor cancellation. Retire only this
  // launch's isolated group and wait for descendants before removing their files.
  try {
    if (groupAlive()) {
      result.retiredRemainingDescendants = true;
      signalGroup("SIGTERM");
      const end = Date.now() + 1000;
      while (groupAlive() && Date.now() < end) await pause(25);
      if (groupAlive()) signalGroup("SIGKILL");
      const killEnd = Date.now() + 1000;
      while (groupAlive() && Date.now() < killEnd) await pause(25);
    }
    result.remainingProcessGroup = groupAlive();
    if (result.remainingProcessGroup)
      throw Error("Owned process group did not settle; retaining profile");
    if (scratch) {
      const owner = JSON.parse(
        await readFile(path.join(scratch, ".owner.json"), "utf8"),
      );
      const expected = JSON.parse(
        await readFile(path.join(output, ".launcher.json"), "utf8"),
      );
      if (
        owner.nonce !== expected.nonce ||
        owner.parentPid !== process.pid ||
        expected.scratch !== scratch
      )
        throw Error("Profile identity changed; retaining directory");
      await rm(scratch, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
      await pause(200);
      try {
        await access(scratch);
        throw Error("Profile was recreated after group exit");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      result.removed = true;
      result.scratch = scratch;
    }
  } catch (error) {
    result.errors.push(String(error));
  }
  result.forced = forced;
  if (output && scratch)
    await writeFile(
      path.join(output, "cleanup-after-exit.json"),
      JSON.stringify(result, null, 2),
    );
  console.log(JSON.stringify({ launcherCleanup: result }));
  process.exitCode = result.errors.length || forced ? 1 : code;
}
