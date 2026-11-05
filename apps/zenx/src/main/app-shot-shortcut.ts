import { fork, spawn, type ChildProcess } from "node:child_process";
import { win32 } from "node:path";
import { isAppShotModifier, type AppShotModifier } from "../app-shot.js";

/**
 * Observes only the chosen two physical modifier bits. It does not install an
 * event tap, request Accessibility access, read key contents or inject input.
 * Ready/trigger go to stderr because that is where JXA console.log writes.
 *
 * The first pressed sample is a rising edge, including when both keys were
 * already held at startup, matching T3. The shortcut is nonexclusive.
 */
export const MAC_APP_SHOT_MODIFIER_PAIR_JXA = String.raw`
ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("CoreGraphics");
ObjC.import("unistd");
function run(argv) {
  const ownerPid = Number(argv[0]);
  const sampleLimit = Number(argv[1]);
  const modifier = argv[2] === undefined ? "shift" : argv[2];
  const masks = { shift: [0x2, 0x4], control: [0x1, 0x2000], alt: [0x20, 0x40], meta: [0x8, 0x10] };
  if (typeof modifier !== "string" || !Object.prototype.hasOwnProperty.call(masks, modifier)) {
    throw Error("Invalid App Shot modifier");
  }
  const pair = masks[modifier];
  if (!Number.isInteger(ownerPid) || ownerPid <= 1 ||
      !Number.isInteger(sampleLimit) || sampleLimit < 0 || sampleLimit > 20) {
    throw Error("Invalid modifier monitor arguments");
  }
  let wasPressed = false;
  let samples = 0;
  console.log("ready");
  while (Number($.getppid()) === ownerPid) {
    const flags = Number($.CGEventSourceFlagsState(0));
    const pressed = (flags & pair[0]) !== 0 && (flags & pair[1]) !== 0;
    if (pressed && !wasPressed) console.log("trigger");
    wasPressed = pressed;
    samples++;
    if (sampleLimit > 0 && samples >= sampleLimit) break;
    delay(0.05);
  }
  if (sampleLimit > 0) console.log("smoke:" + samples);
}
`;

export interface AppShotModifierPair {
  /** Resolves after child exit and owned channel closure; rejects if unconfirmed. */
  stop(): Promise<void>;
}

export interface AppShotModifierPairOptions {
  /** Omitted by existing Both Shift callers; never an arbitrary chord or mask. */
  modifier?: AppShotModifier;
  /** May fire immediately after the ready message, before start's await resumes. */
  onTrigger: () => void;
  /** Called once on failure after ready. Startup failures reject start instead. */
  onFailure: (error: Error) => void;
  /** Revoke the owning composer even if the native helper is still starting. */
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  /** Absolute packaged entry path supplied by the host, required on Windows. */
  workerPath?: string;
}

export interface AppShotModifierPairDependencies {
  /** Process seam for unit tests; production always uses a fixed system binary. */
  spawn?: (file: string, args: readonly string[]) => ChildProcess;
  fork?: (file: string, args: readonly string[]) => ChildProcess;
  /** Tests may shorten the production bounds, never make them unbounded. */
  readyTimeoutMs?: number;
  stopGraceMs?: number;
  stopTimeoutMs?: number;
}

function boundedTimeout(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new Error("Invalid App Shot modifier monitor timeout");
  return value;
}

/**
 * Start only for an explicitly enabled, current composer. The caller owns
 * cancellation on navigation, owner replacement, disable and app shutdown.
 * No preferences, permissions, retry loop or global owner are created here.
 *
 * macOS uses the same HID-system flags, physical masks and 50 ms edge polling
 * as T3. Windows uses its isolated GetAsyncKeyState worker over bounded IPC.
 * Unsupported platforms fail closed.
 */
export async function startAppShotModifierPair(
  options: AppShotModifierPairOptions,
  dependencies: AppShotModifierPairDependencies = {},
): Promise<AppShotModifierPair> {
  const modifier = options.modifier === undefined ? "shift" : options.modifier;
  if (!isAppShotModifier(modifier))
    throw new Error("Invalid App Shot modifier");
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32")
    throw new Error(
      "App Shot modifier shortcut is unavailable on this platform",
    );
  if (options.signal?.aborted)
    throw new Error("App Shot modifier shortcut start was cancelled");

  if (
    platform === "win32" &&
    (!options.workerPath || !win32.isAbsolute(options.workerPath))
  )
    throw new Error(
      "App Shot modifier shortcut requires an absolute worker path",
    );

  const readyTimeoutMs = boundedTimeout(dependencies.readyTimeoutMs, 5000);
  const stopGraceMs = boundedTimeout(dependencies.stopGraceMs, 250);
  const stopTimeoutMs = boundedTimeout(dependencies.stopTimeoutMs, 2000);
  const launch =
    dependencies.spawn ??
    ((file: string, args: readonly string[]) =>
      spawn(file, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      }));
  const forkWorker =
    dependencies.fork ??
    ((file: string, args: readonly string[]) =>
      fork(file, [...args], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        execArgv: [],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }));
  const child =
    platform === "win32"
      ? forkWorker(options.workerPath!, [
          "app-shot-modifier-monitor",
          "0",
          modifier,
        ])
      : launch("/usr/bin/osascript", [
          "-l",
          "JavaScript",
          "-e",
          MAC_APP_SHOT_MODIFIER_PAIR_JXA,
          String(process.pid),
          "0",
          modifier,
        ]);

  return await new Promise<AppShotModifierPair>((resolve, reject) => {
    let phase: "starting" | "running" | "stopping" | "stopped" = "starting";
    let closed = false;
    let exited = false;
    let stdoutClosed = !child.stdout;
    let stderrClosed = !child.stderr;
    let ipcClosed = platform !== "win32" || !child.connected;
    let buffered = "";
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let settleClosed!: () => void;
    let rejectClosed!: (error: Error) => void;
    const childClosed = new Promise<void>((done, failed) => {
      settleClosed = done;
      rejectClosed = failed;
    });
    // Automatic failure cleanup may have no external stop waiter. The original
    // promise still rejects for callers that explicitly await stop().
    void childClosed.catch(() => {});

    const kill = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal);
      } catch {
        // A signal can race exit. Never claim disposal until close is observed.
      }
    };
    const onParentExit = () => kill("SIGKILL");
    const stop = (): Promise<void> => {
      if (phase === "stopping" || phase === "stopped") return childClosed;
      phase = "stopping";
      clearTimeout(readyTimer);
      buffered = "";
      if (!closed) {
        killTimer = setTimeout(() => kill("SIGKILL"), stopGraceMs);
        closeTimer = setTimeout(() => {
          kill("SIGKILL");
          rejectClosed(
            new Error(
              "App Shot modifier shortcut child exit was not confirmed",
            ),
          );
          // Keep ownership/listeners until actual exit, even after reporting failure.
        }, stopTimeoutMs);
        kill("SIGTERM");
      }
      return childClosed;
    };
    const fail = (error: Error) => {
      if (phase !== "starting" && phase !== "running") return;
      const wasReady = phase === "running";
      const stopped = stop(); // Disable triggers synchronously, before callbacks.
      if (wasReady) {
        try {
          options.onFailure(error);
        } catch {
          // Consumer callbacks cannot prevent owned-process cleanup.
        }
      } else {
        // A rejected start does not abandon its still-owned native child.
        void stopped.then(
          () => reject(error),
          (cleanupError: Error) =>
            reject(new Error(error.message + "; " + cleanupError.message)),
        );
      }
    };
    const onAbort = () => {
      if (phase === "starting")
        fail(new Error("App Shot modifier shortcut start was cancelled"));
      else void stop();
    };
    const onError = () =>
      fail(new Error("App Shot modifier shortcut helper failed"));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      exited = true;
      fail(
        new Error(
          "App Shot modifier shortcut helper exited (" +
            (signal ?? code ?? "unknown") +
            ")",
        ),
      );
      maybeClosed();
    };
    const onStdout = (chunk: Buffer) => {
      // This protocol has no stdout. Do not collect or echo unexpected output.
      if (chunk.length)
        fail(
          new Error("App Shot modifier shortcut returned unexpected output"),
        );
    };
    const acceptMessage = (message: unknown) => {
      if (phase !== "starting" && phase !== "running") return;
      // Accept only two constant-size protocol values; retain no incoming payload.
      if (message === "ready" && phase === "starting") {
        clearTimeout(readyTimer);
        phase = "running";
        resolve({ stop });
      } else if (message === "trigger" && phase === "running") {
        try {
          options.onTrigger();
        } catch {
          fail(new Error("App Shot modifier shortcut callback failed"));
        }
      } else {
        fail(new Error("App Shot modifier shortcut returned invalid output"));
      }
    };
    const onDisconnect = () => {
      ipcClosed = true;
      fail(new Error("App Shot modifier shortcut helper disconnected"));
      maybeClosed();
    };
    const onStderr = (chunk: Buffer) => {
      if (platform === "win32") {
        if (chunk.length) onError();
        return;
      }
      if (phase !== "starting" && phase !== "running") return;
      if (chunk.length > 4096) {
        fail(new Error("App Shot modifier shortcut output exceeded its limit"));
        return;
      }
      buffered += chunk.toString("utf8");
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline).replace(/\r$/u, "");
        buffered = buffered.slice(newline + 1);
        acceptMessage(line);
        if (phase !== "starting" && phase !== "running") return;
      }
      if (buffered.length > 128)
        fail(new Error("App Shot modifier shortcut output exceeded its limit"));
    };
    const onClose = () => {
      if (closed) return;
      closed = true;
      fail(new Error("App Shot modifier shortcut helper closed"));
      phase = "stopped";
      buffered = "";
      clearTimeout(readyTimer);
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      child.stdout?.off("data", onStdout);
      child.stdout?.off("close", onStdoutClose);
      child.stderr?.off("data", onStderr);
      child.stderr?.off("close", onStderrClose);
      child.off("close", onClose);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", acceptMessage);
      child.off("disconnect", onDisconnect);
      options.signal?.removeEventListener("abort", onAbort);
      process.off("exit", onParentExit);
      settleClosed();
    };

    // Node 22 can omit aggregate ChildProcess "close" after a parent-initiated
    // IPC disconnect. These independent facts still prove the owned process
    // exited and every channel closed. Disconnect alone never proves exit.
    const maybeClosed = () => {
      if (exited && stdoutClosed && stderrClosed && ipcClosed) onClose();
    };
    const onStdoutClose = () => {
      stdoutClosed = true;
      maybeClosed();
    };
    const onStderrClose = () => {
      stderrClosed = true;
      maybeClosed();
    };

    child.once("close", onClose);
    child.on("error", onError);
    child.once("exit", onExit);
    if (platform === "win32") {
      child.on("message", acceptMessage);
      child.once("disconnect", onDisconnect);
    }
    child.stdout?.on("data", onStdout);
    child.stdout?.once("close", onStdoutClose);
    child.stderr?.on("data", onStderr);
    child.stderr?.once("close", onStderrClose);
    process.once("exit", onParentExit);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    readyTimer = setTimeout(
      () => fail(new Error("App Shot modifier shortcut ready timed out")),
      readyTimeoutMs,
    );
    if (!child.stdout || !child.stderr)
      fail(new Error("App Shot modifier shortcut pipes are unavailable"));
    if (platform === "win32" && !child.connected) onDisconnect();
    // Covers revocation during the injected/native spawn call.
    if (options.signal?.aborted) onAbort();
  });
}
