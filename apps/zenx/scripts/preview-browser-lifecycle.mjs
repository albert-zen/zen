/** CI fixture infrastructure only. Never retries UI actions or restarts Chrome. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

export const PREVIEW_STARTUP_TIMEOUT_MS = 30_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function observePreviewChrome(child, profile, options = {}) {
  const {
    timeoutMs = PREVIEW_STARTUP_TIMEOUT_MS,
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
  const started = now();
  const deadline = started + timeoutMs;
  let spawnError;
  let exited = child.exitCode !== null || child.signalCode !== null;
  let closed = false;
  let stderr = "";
  const receipt = {
    schemaVersion: 1,
    pid: child.pid ?? null,
    executable: child.spawnfile ?? null,
    startupTimeoutMs: timeoutMs,
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
    const error = new Error(
      `Preview browser ${receipt.phase} failed after ${Math.round(now() - started)}ms: ${message}; stderr tail: ${stderr || "(empty)"}`,
    );
    receipt.failure = { phase: receipt.phase, message: error.message };
    return error;
  };
  const alive = () => {
    if (spawnError) {
      phase("spawn");
      throw failure(spawnError.message);
    }
    if (exited)
      throw failure(
        `Chrome exited (code=${child.exitCode}, signal=${child.signalCode})`,
      );
  };
  const remaining = () => Math.max(0, deadline - now());
  // Bound even a stalled read/body promise; abort the underlying supported I/O too.
  const bounded = async (operation, budgetMs) => {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => {
              const error = new Error("Readiness I/O deadline exceeded");
              controller.abort(error);
              reject(error);
            },
            Math.max(1, Math.ceil(budgetMs)),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    receipt,
    async connect() {
      let port;
      let target;
      phase("devtools-port");
      while (remaining() > 0) {
        alive();
        receipt.pollCount++;
        try {
          if (!port) {
            const value = Number(
              (await bounded(readPort, remaining())).split("\n")[0],
            );
            if (!Number.isInteger(value) || value < 1 || value > 65535)
              throw new Error("DevToolsActivePort has no valid port yet");
            port = value;
            receipt.port = port;
            phase("target-list");
          }
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
          if (target) break;
          receipt.lastObservation = "DevTools reachable, no page target yet";
        } catch (error) {
          receipt.lastObservation =
            error instanceof Error ? error.message : String(error);
        }
        await delay(Math.min(pollMs, remaining()));
      }
      alive();
      if (!target || remaining() <= 0)
        throw failure(
          `startup deadline ${timeoutMs}ms exceeded; last observation: ${receipt.lastObservation ?? "none"}`,
        );
      phase("websocket-connect");
      let socket;
      try {
        socket = createSocket(
          target.webSocketDebuggerUrl,
          Math.max(1, Math.ceil(remaining())),
        );
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            socket.off("open", opened);
            socket.off("error", failed);
            socket.off("close", closed);
            child.off("exit", closed);
            child.off("error", failed);
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
            failed(new Error("Chrome or socket closed before connection"));
          const timer = setTimeout(
            () => failed(new Error("WebSocket startup deadline exceeded")),
            remaining(),
          );
          socket.once("open", opened);
          socket.once("error", failed);
          socket.once("close", closed);
          child.once("exit", closed);
          child.once("error", failed);
        });
        // Avoid an unhandled socket error after opening; commands retain their own deadlines.
        socket.on("error", (error) => {
          receipt.socketError = error.message;
        });
        phase("page-setup");
        receipt.readyElapsedMs = Math.round(now() - started);
        return socket;
      } catch (error) {
        socket?.on("error", () => {});
        socket?.terminate();
        throw failure(error.message);
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
