/** CI fixture infrastructure only. Never retries UI actions or restarts Chrome. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

const DEFAULT_PHASE_TIMEOUTS_MS = Object.freeze({
  "devtools-port": 30_000,
  "target-list": 10_000,
  "websocket-connect": 5_000,
});
export const PREVIEW_STARTUP_TIMEOUT_MS = 45_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function observePreviewChrome(child, profile, options = {}) {
  const {
    timeoutMs = PREVIEW_STARTUP_TIMEOUT_MS,
    phaseTimeoutsMs: phaseOverrides = {},
    pollMs = 100,
    now = () => performance.now(),
    delay = sleep,
    readPort = (signal) =>
      readFile(path.join(profile, "DevToolsActivePort"), {
        encoding: "utf8",
        signal,
      }),
    fetchTargets = (port, signal) =>
      fetch(`http://127.0.0.1:${port}/json/list`, { signal }),
    createSocket = (url, timeout) =>
      new WebSocket(url, { handshakeTimeout: timeout }),
    writeArtifact = writeFile,
    termMs = 5_000,
    killMs = 2_000,
  } = options;
  if (
    !phaseOverrides ||
    typeof phaseOverrides !== "object" ||
    Array.isArray(phaseOverrides)
  )
    throw new TypeError("phaseTimeoutsMs must be a phase budget object");
  const phaseTimeoutsMs = { ...DEFAULT_PHASE_TIMEOUTS_MS, ...phaseOverrides };
  for (const name of Object.keys(phaseOverrides)) {
    if (!Object.hasOwn(DEFAULT_PHASE_TIMEOUTS_MS, name))
      throw new TypeError(`Unknown startup phase: ${name}`);
  }
  for (const [name, value] of Object.entries({
    timeoutMs,
    pollMs,
    ...phaseTimeoutsMs,
  })) {
    if (!Number.isFinite(value) || value <= 0 || value > 2 ** 31 - 1)
      throw new RangeError(
        `${name} must be finite positive milliseconds no greater than 2147483647`,
      );
  }
  const started = now();
  const deadline = started + timeoutMs;
  let phaseDeadline = deadline;
  let startupPhase;
  let spawnError;
  let exited = child.exitCode !== null || child.signalCode !== null;
  let closed = false;
  let stderr = "";
  const receipt = {
    schemaVersion: 1,
    pid: child.pid ?? null,
    executable: child.spawnfile ?? null,
    startupTimeoutMs: timeoutMs,
    phaseTimeoutsMs,
    phase: "spawn",
    events: [],
    pollCount: 0,
    captureStatus: "not-started",
  };
  const phase = (name) => {
    if (receipt.phase !== name || !receipt.events.length) {
      receipt.phase = name;
      receipt.events.push({
        phase: name,
        elapsedMs: Math.round(now() - started),
      });
    }
  };
  phase("spawn");
  child.on("error", (error) => {
    spawnError = error;
  });
  child.on("close", () => {
    closed = true;
  });
  child.on("exit", () => {
    exited = true;
  });
  child.stderr?.on("data", (data) => {
    stderr = (stderr + String(data)).slice(-65_536);
  });
  const failure = (message) => {
    finishStartupPhase("failed");
    const error = new Error(
      `Preview browser ${receipt.phase} failed after ${Math.round(now() - started)}ms: ${message}; stderr tail: ${stderr || "(empty)"}`,
    );
    receipt.failure = { phase: receipt.phase, message: error.message };
    return error;
  };
  const alive = () => {
    if (spawnError) {
      phase("spawn");
      throw new Error(spawnError.message);
    }
    if (exited)
      throw new Error(
        `Chrome exited (code=${child.exitCode}, signal=${child.signalCode})`,
      );
  };
  const finishStartupPhase = (outcome) => {
    if (startupPhase && !startupPhase.outcome) {
      startupPhase.durationMs =
        Math.round(now() - started) - startupPhase.elapsedMs;
      startupPhase.outcome = outcome;
    }
  };
  const beginStartupPhase = (name) => {
    finishStartupPhase("passed");
    phase(name);
    phaseDeadline = Math.min(deadline, now() + phaseTimeoutsMs[name]);
    startupPhase = receipt.events.at(-1);
    Object.assign(startupPhase, {
      timeoutMs: phaseTimeoutsMs[name],
      deadlineElapsedMs: Math.round(phaseDeadline - started),
      pollCount: 0,
    });
    delete receipt.lastObservation;
  };
  const remaining = () => Math.max(0, phaseDeadline - now());
  const checkpoint = () => {
    alive();
    const time = now();
    if (time >= phaseDeadline) {
      const limit =
        time >= deadline
          ? `startup deadline ${timeoutMs}ms`
          : `${receipt.phase} deadline ${phaseTimeoutsMs[receipt.phase]}ms`;
      throw new Error(
        `${limit} exceeded; last observation: ${receipt.lastObservation ?? "none"}`,
      );
    }
  };
  // Only readiness observations are polled. Every wait is bounded and child
  // termination aborts supported I/O, including a stalled response body.
  const bounded = async (operation, budgetMs) => {
    checkpoint();
    const operationDeadline = Math.min(phaseDeadline, now() + budgetMs);
    const controller = new AbortController();
    const checkOperationDeadline = () => {
      checkpoint();
      if (now() >= operationDeadline) {
        const error = new Error("Readiness I/O deadline exceeded");
        controller.abort(error);
        throw error;
      }
    };
    let timer;
    let failed;
    const stopped = () => failed(new Error("Chrome exited during readiness"));
    try {
      const interrupted = new Promise((_resolve, reject) => {
        failed = (error) => {
          controller.abort(error);
          reject(error);
        };
        child.once("exit", stopped);
        child.once("error", failed);
        const expire = () => {
          const left = operationDeadline - now();
          // Node timers may fire slightly early. Keep the absolute deadline;
          // rescheduling this timer never repeats the underlying operation.
          if (left > 0) timer = setTimeout(expire, Math.ceil(left));
          else failed(new Error("Readiness I/O deadline exceeded"));
        };
        expire();
      });
      const result = await Promise.race([
        Promise.resolve().then(() => {
          checkOperationDeadline();
          return operation(controller.signal);
        }),
        interrupted,
      ]);
      // Timers can run late under load; an I/O completion is not proof that
      // it arrived before the absolute deadline.
      checkOperationDeadline();
      return result;
    } catch (error) {
      checkpoint();
      throw error;
    } finally {
      clearTimeout(timer);
      child.off("exit", stopped);
      child.off("error", failed);
    }
  };
  const pause = () =>
    bounded(() => delay(Math.min(pollMs, remaining())), remaining());
  return {
    receipt,
    async connect() {
      let port;
      let target;
      let socket;
      try {
        beginStartupPhase("devtools-port");
        while (!port) {
          checkpoint();
          receipt.pollCount++;
          startupPhase.pollCount++;
          try {
            const value = Number(
              (await bounded(readPort, remaining())).split("\n")[0],
            );
            if (!Number.isInteger(value) || value < 1 || value > 65535)
              throw new Error("DevToolsActivePort has no valid port yet");
            port = value;
            receipt.port = port;
          } catch (error) {
            checkpoint();
            receipt.lastObservation = String(error?.message ?? error);
          }
          if (!port) await pause();
        }
        checkpoint();
        beginStartupPhase("target-list");
        while (!target) {
          checkpoint();
          receipt.pollCount++;
          startupPhase.pollCount++;
          try {
            const pages = await bounded(
              async (signal) => {
                const response = await fetchTargets(port, signal);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
              },
              Math.min(2_000, remaining()),
            );
            target = pages.find(
              (page) => page.type === "page" && page.webSocketDebuggerUrl,
            );
            if (!target)
              receipt.lastObservation =
                "DevTools reachable, no page target yet";
          } catch (error) {
            checkpoint();
            receipt.lastObservation = String(error?.message ?? error);
          }
          if (!target) await pause();
        }
        checkpoint();
        beginStartupPhase("websocket-connect");
        await bounded((signal) => {
          socket = createSocket(
            target.webSocketDebuggerUrl,
            Math.max(1, Math.ceil(remaining())),
          );
          checkpoint();
          return new Promise((resolve, reject) => {
            const cleanup = () => {
              socket.off("open", opened);
              socket.off("error", failed);
              socket.off("close", closed);
              signal.removeEventListener("abort", aborted);
            };
            const opened = () => {
              cleanup();
              resolve();
            };
            const failed = (error) => {
              cleanup();
              reject(error);
            };
            const closed = () =>
              failed(new Error("Socket closed before connection"));
            const aborted = () => failed(signal.reason);
            socket.once("open", opened);
            socket.once("error", failed);
            socket.once("close", closed);
            signal.addEventListener("abort", aborted, { once: true });
            if (signal.aborted) aborted();
          });
        }, remaining());
        checkpoint();
        // Avoid an unhandled socket error after opening; commands retain their own deadlines.
        socket.on("error", (error) => {
          receipt.socketError = error.message;
        });
        finishStartupPhase("passed");
        phase("page-setup");
        receipt.readyElapsedMs = Math.round(now() - started);
        return socket;
      } catch (error) {
        socket?.on("error", () => {});
        socket?.terminate();
        throw failure(String(error?.message ?? error));
      }
    },
    commandStarted(method) {
      receipt.lastCommand = { method, elapsedMs: Math.round(now() - started) };
    },
    captureStarted() {
      phase("capture");
      receipt.captureStatus = "running";
    },
    captureFinished(status, error) {
      receipt.captureStatus = status;
      if (error && !receipt.failure)
        receipt.failure = {
          phase: receipt.phase,
          message: String(error.message ?? error),
        };
    },
    async close(directory) {
      const waitForExit = async (ms) => {
        const until = now() + ms;
        while (!closed && now() < until)
          await delay(Math.min(50, until - now()));
      };
      if (!exited && !spawnError) {
        child.kill("SIGTERM");
        await waitForExit(termMs);
      }
      if (!exited && !spawnError) {
        receipt.forcedKill = true;
        child.kill("SIGKILL");
      }
      if (!closed) await waitForExit(killMs);
      receipt.cleanupComplete = closed;
      receipt.profileRetained = !closed;
      receipt.stderrTailLimit = 65_536;
      if (!closed)
        receipt.cleanupFailure =
          "Chrome close was not observed within TERM/KILL deadlines";
      receipt.exitCode = child.exitCode;
      receipt.signalCode = child.signalCode;
      receipt.elapsedMs = Math.round(now() - started);
      receipt.artifactErrors = [];
      for (const [name, contents] of [
        ["chrome.log", () => stderr],
        [
          "browser-lifecycle.json",
          () => JSON.stringify(receipt, null, 2) + "\n",
        ],
      ]) {
        try {
          await writeArtifact(path.join(directory, name), contents());
        } catch (error) {
          receipt.artifactErrors.push({
            file: name,
            message: String(error.message ?? error),
          });
          // An artifact failure cannot mask the original capture error or skip cleanup.
          console.error(
            `Preview artifact ${name} failed: ${error.message ?? error}`,
          );
        }
      }
      return receipt.cleanupComplete;
    },
  };
}
