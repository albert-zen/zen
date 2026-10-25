import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  observePreviewChrome,
  PREVIEW_STARTUP_TIMEOUT_MS,
} from "../scripts/preview-browser-lifecycle.mjs";

function harness(overrides = {}) {
  let time = 0;
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    spawnfile: "/fixture/chrome",
    exitCode: null,
    signalCode: null,
    stderr: new EventEmitter(),
    signals: [],
    kill(signal) {
      this.signals.push(signal);
      this.signalCode = signal;
      this.emit("exit");
      this.emit("close");
    },
  });
  const socket = Object.assign(new EventEmitter(), {
    terminate() {
      this.terminated = true;
    },
  });
  const options = {
    now: () => time,
    delay: async (ms) => {
      time += ms;
    },
    readPort: async () => "9222\n/devtools/browser/test\n",
    fetchTargets: async () => ({
      ok: true,
      json: async () => [
        { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/page" },
      ],
    }),
    createSocket: () => {
      queueMicrotask(() => socket.emit("open"));
      return socket;
    },
    termMs: 50,
    killMs: 50,
    ...overrides,
  };
  const lifecycle = observePreviewChrome(child, "/synthetic-profile", options);
  return {
    child,
    socket,
    lifecycle,
    options,
    advance: (ms) => {
      time += ms;
    },
  };
}

async function receipt(t, lifecycle) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "preview-lifecycle-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stopped = await lifecycle.close(directory);
  return {
    stopped,
    data: JSON.parse(
      await readFile(path.join(directory, "browser-lifecycle.json"), "utf8"),
    ),
    log: await readFile(path.join(directory, "chrome.log"), "utf8"),
  };
}

test("slow first launch beyond old 10s budget succeeds once, without restarting Chrome", async (t) => {
  let polls = 0;
  const h = harness({
    readPort: async () => {
      if (++polls < 122) throw new Error("ENOENT");
      return "9222\n";
    },
  });
  assert.equal(PREVIEW_STARTUP_TIMEOUT_MS, 30_000);
  assert.equal(await h.lifecycle.connect(), h.socket);
  assert.ok(h.lifecycle.receipt.readyElapsedMs > 10_000);
  assert.deepEqual(h.child.signals, []);
  h.lifecycle.captureStarted();
  h.lifecycle.captureFinished("passed");
  const result = await receipt(t, h.lifecycle);
  assert.equal(result.stopped, true);
  assert.equal(result.data.captureStatus, "passed");
  assert.deepEqual(h.child.signals, ["SIGTERM"]);
});

test("missing and malformed port are bounded and never report UI failure", async (t) => {
  const h = harness({ timeoutMs: 200, readPort: async () => "0\n" });
  await assert.rejects(
    h.lifecycle.connect(),
    /devtools-port failed.*startup deadline 200ms/,
  );
  const result = await receipt(t, h.lifecycle);
  assert.equal(result.data.failure.phase, "devtools-port");
  assert.equal(result.data.captureStatus, "not-started");
});

test("spawn errors are classified separately and do not become unhandled events", async (t) => {
  const h = harness();
  h.child.emit("error", new Error("EACCES"));
  h.child.emit("close");
  await assert.rejects(h.lifecycle.connect(), /spawn failed.*EACCES/);
  assert.equal((await receipt(t, h.lifecycle)).data.failure.phase, "spawn");
});

test("early exit retains signal and stderr rather than waiting full deadline", async (t) => {
  const h = harness();
  h.child.stderr.emit("data", "startup failed\n");
  h.child.exitCode = 12;
  h.child.emit("exit");
  h.child.emit("close");
  await assert.rejects(
    h.lifecycle.connect(),
    /Chrome exited \(code=12.*startup failed/,
  );
  const result = await receipt(t, h.lifecycle);
  assert.equal(result.data.exitCode, 12);
  assert.equal(result.log, "startup failed\n");
});

test("transient HTTP failure and empty target list wait within the same startup budget", async () => {
  let calls = 0;
  const h = harness({
    fetchTargets: async () => {
      if (++calls === 1) throw new Error("ECONNREFUSED");
      return {
        ok: true,
        json: async () =>
          calls === 2
            ? []
            : [{ type: "page", webSocketDebuggerUrl: "ws://localhost/page" }],
      };
    },
  });
  await h.lifecycle.connect();
  assert.equal(calls, 3);
  assert.equal(h.lifecycle.receipt.readyElapsedMs, 200);
});

test("missing page target reports target-list phase, not a renderer failure", async (t) => {
  const h = harness({
    timeoutMs: 200,
    fetchTargets: async () => ({ ok: true, json: async () => [] }),
  });
  await assert.rejects(
    h.lifecycle.connect(),
    /target-list failed.*no page target/,
  );
  assert.equal(
    (await receipt(t, h.lifecycle)).data.captureStatus,
    "not-started",
  );
});

test("stalled HTTP response is aborted at the real deadline", async () => {
  const h = harness({
    timeoutMs: 30,
    now: () => performance.now(),
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    fetchTargets: async (_port, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
  });
  await assert.rejects(
    h.lifecycle.connect(),
    /target-list failed.*startup deadline/,
  );
});

test("WebSocket handshake failure terminates socket and preserves its phase", async (t) => {
  const h = harness({
    createSocket: () => {
      queueMicrotask(() => h.socket.emit("error", new Error("refused")));
      return h.socket;
    },
  });
  await assert.rejects(
    h.lifecycle.connect(),
    /websocket-connect failed.*refused/,
  );
  assert.equal(h.socket.terminated, true);
  assert.equal(
    (await receipt(t, h.lifecycle)).data.failure.phase,
    "websocket-connect",
  );
});

test("WebSocket handshake cannot hang indefinitely", async () => {
  const h = harness({ timeoutMs: 20, createSocket: () => h.socket });
  await assert.rejects(
    h.lifecycle.connect(),
    /websocket-connect failed.*deadline/,
  );
  assert.equal(h.socket.terminated, true);
});

test("capture failure is distinct from successful browser startup", async (t) => {
  const h = harness();
  await h.lifecycle.connect();
  h.lifecycle.captureStarted();
  h.lifecycle.captureFinished("failed", new Error("UI assertion mismatch"));
  const result = await receipt(t, h.lifecycle);
  assert.equal(result.data.failure.phase, "capture");
  assert.equal(result.data.captureStatus, "failed");
});

test("shutdown escalates once, waits for close and preserves cleanup outcome", async (t) => {
  const h = harness();
  h.child.kill = (signal) => {
    h.child.signals.push(signal);
    if (signal === "SIGKILL") {
      h.child.signalCode = signal;
      h.child.emit("exit");
      h.child.emit("close");
    }
  };
  assert.equal((await receipt(t, h.lifecycle)).stopped, true);
  assert.deepEqual(h.child.signals, ["SIGTERM", "SIGKILL"]);
});

test("unreaped child is reported, not treated as safe to remove its profile", async (t) => {
  const h = harness();
  h.child.kill = (signal) => h.child.signals.push(signal);
  assert.equal((await receipt(t, h.lifecycle)).stopped, false);
  assert.deepEqual(h.child.signals, ["SIGTERM", "SIGKILL"]);
});

test("real subprocess exit is reaped and stderr preserved", async (t) => {
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    ["-e", "process.stderr.write('fixture exit\\n'); process.exitCode=7"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const lifecycle = observePreviewChrome(
    child,
    "/nonexistent-preview-fixture",
    { timeoutMs: 2_000, pollMs: 10 },
  );
  await assert.rejects(lifecycle.connect(), /Chrome exited \(code=7/);
  const result = await receipt(t, lifecycle);
  assert.equal(result.stopped, true);
  assert.equal(result.log, "fixture exit\n");
});

test("real spawn failure still emits close and yields a complete failure receipt", async (t) => {
  const { spawn } = await import("node:child_process");
  const child = spawn("/nonexistent-preview-chrome-test", [], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const lifecycle = observePreviewChrome(child, "/unused", {
    timeoutMs: 1_000,
    pollMs: 10,
  });
  await assert.rejects(lifecycle.connect(), /spawn failed.*ENOENT/);
  const result = await receipt(t, lifecycle);
  assert.equal(result.stopped, true);
  assert.equal(result.data.captureStatus, "not-started");
});
