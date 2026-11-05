import assert from "node:assert/strict";
import { execFile, fork, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { promisify } from "node:util";
import {
  MAC_APP_SHOT_MODIFIER_PAIR_JXA,
  startAppShotModifierPair,
} from "../src/main/app-shot-shortcut.js";

const nativeSkip =
  process.env.ZENX_APP_SHOT_NATIVE_SMOKE !== "1"
    ? "Opt in with ZENX_APP_SHOT_NATIVE_SMOKE=1 on a native macOS runner"
    : process.platform !== "darwin"
      ? "Native macOS API unavailable on " +
        process.platform +
        "; that platform has not been validated"
      : false;
const execute = promisify(execFile);

// These tests never synthesize keys, capture windows, or change TCC grants.
// They validate API loading, finite native sampling, parent loss and disposal,
// not physical keyboard delivery, Screen Recording, or complete App Shot UX.
it(
  "App Shot native smoke: reads the real modifier API for four finite samples",
  { skip: nativeSkip, timeout: 10_000 },
  async (context) => {
    const result = await execute(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        MAC_APP_SHOT_MODIFIER_PAIR_JXA,
        String(process.pid),
        "4",
      ],
      { timeout: 5000, killSignal: "SIGKILL", maxBuffer: 4096, encoding: "utf8" },
    );
    const lines = result.stderr.trim().split(/\r?\n/u);
    assert.equal(result.stdout.trim(), "");
    assert.equal(lines[0], "ready");
    assert.equal(lines.at(-1), "smoke:4");
    assert.ok(lines.slice(1, -1).every((line) => line === "trigger"));
    context.diagnostic(
      JSON.stringify({
        platform: process.platform,
        nativeApi: "CGEventSourceFlagsState",
        samples: 4,
        keyboardInjection: false,
        physicalChordVerified: false,
      }),
    );
  },
);

it(
  "App Shot native smoke: rejects a mismatched parent without sampling",
  { skip: nativeSkip, timeout: 10_000 },
  async () => {
    const result = await execute(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        MAC_APP_SHOT_MODIFIER_PAIR_JXA,
        String(process.pid + 1),
        "4",
      ],
      { timeout: 5000, killSignal: "SIGKILL", maxBuffer: 4096, encoding: "utf8" },
    );
    assert.deepEqual(result.stderr.trim().split(/\r?\n/u), [
      "ready",
      "smoke:0",
    ]);
  },
);

it(
  "App Shot native smoke: start/stop settles the real helper process",
  { skip: nativeSkip, timeout: 10_000 },
  async (context) => {
    let child: ChildProcess | undefined;
    let closed = false;
    const failures: Error[] = [];
    context.after(() => {
      if (!closed) child?.kill("SIGKILL");
    });
    const monitor = await startAppShotModifierPair(
      {
        onTrigger: () => {},
        onFailure: (error) => failures.push(error),
      },
      {
        spawn: (file, args) => {
          child = spawn(file, [...args], {
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
          });
          child.once("close", () => {
            closed = true;
          });
          return child;
        },
      },
    );
    await monitor.stop();
    assert.equal(closed, true);
    assert.deepEqual(failures, []);
  },
);

const windowsSkip =
  process.env.ZENX_APP_SHOT_NATIVE_SMOKE !== "1"
    ? "Opt in with ZENX_APP_SHOT_NATIVE_SMOKE=1 on a native Windows runner"
    : process.platform !== "win32"
      ? "Native Windows API unavailable on " +
        process.platform +
        "; that platform has not been validated"
      : false;
// Tests explicitly name the built entry; the production host supplies its own
// app.getAppPath()/out/main path and never resolves from a bundled shared chunk.
const windowsWorkerPath =
  process.env.ZENX_APP_SHOT_WORKER_PATH ??
  fileURLToPath(new URL("../out/main/app-shot-shortcut-worker.js", import.meta.url));

function forkWindowsWorker(file: string, args: readonly string[]): ChildProcess {
  return fork(file, [...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
}

function observeWindowsWorker(disconnectOnReady: boolean): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const child = forkWindowsWorker(
      windowsWorkerPath,
      disconnectOnReady
        ? ["app-shot-modifier-monitor"]
        : ["app-shot-modifier-smoke", "4"],
    );
    const messages: unknown[] = [];
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => fail(new Error("Windows modifier native smoke timed out")),
      5000,
    );
    child.once("error", (error) => {
      failure ??= error;
    });
    child.stdout?.on("data", () =>
      fail(new Error("Windows modifier native smoke returned unexpected stdout")),
    );
    child.stderr?.on("data", () =>
      fail(new Error("Windows modifier native smoke returned unexpected stderr")),
    );
    child.on("message", (message: unknown) => {
      if (messages.length >= 32) {
        fail(new Error("Windows modifier native smoke exceeded message limit"));
        return;
      }
      const smokeResult =
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "smoke" &&
        "samples" in message &&
        message.samples === 4 &&
        Object.keys(message).length === 2;
      if (message !== "ready" && message !== "trigger" && !smokeResult) {
        fail(new Error("Windows modifier native smoke returned invalid IPC"));
        return;
      }
      messages.push(message);
      if (disconnectOnReady && message === "ready") child.disconnect();
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0 || signal !== null)
        reject(new Error("Windows modifier native smoke exited unsuccessfully"));
      else resolve(messages);
    });
  });
}

it(
  "App Shot native smoke: reads real GetAsyncKeyState for four finite samples",
  { skip: windowsSkip, timeout: 10_000 },
  async (context) => {
    const messages = await observeWindowsWorker(false);
    assert.equal(messages[0], "ready");
    assert.deepEqual(messages.at(-1), { type: "smoke", samples: 4 });
    assert.ok(messages.slice(1, -1).every((message) => message === "trigger"));
    context.diagnostic(
      JSON.stringify({
        platform: process.platform,
        nativeApi: "GetAsyncKeyState",
        samples: 4,
        keyboardInjection: false,
        physicalChordVerified: false,
      }),
    );
  },
);

it(
  "App Shot native smoke: Windows worker exits after its parent IPC disconnects",
  { skip: windowsSkip, timeout: 10_000 },
  async () => {
    const messages = await observeWindowsWorker(true);
    assert.equal(messages[0], "ready");
  },
);

it(
  "App Shot native smoke: Windows start/stop settles the real worker",
  { skip: windowsSkip, timeout: 10_000 },
  async (context) => {
    let child: ChildProcess | undefined;
    let closed = false;
    const failures: Error[] = [];
    context.after(() => {
      if (!closed) child?.kill("SIGKILL");
    });
    const monitor = await startAppShotModifierPair(
      {
        workerPath: windowsWorkerPath,
        onTrigger: () => {},
        onFailure: (error) => failures.push(error),
      },
      {
        fork: (file, args) => {
          child = forkWindowsWorker(file, args);
          child.once("close", () => {
            closed = true;
          });
          return child;
        },
      },
    );
    await monitor.stop();
    assert.equal(closed, true);
    assert.deepEqual(failures, []);
  },
);
