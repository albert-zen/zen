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
  assert.equal(PREVIEW_STARTUP_TIMEOUT_MS, 45_000);
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
  const h = harness({
    timeoutMs: 20,
    now: () => performance.now(),
    createSocket: () => h.socket,
  });
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

test("stalled port-file read is bounded even if the injected I/O ignores abort", async () => {
  const h = harness({
    timeoutMs: 20,
    now: () => performance.now(),
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    readPort: () => new Promise(() => {}),
  });
  await assert.rejects(
    h.lifecycle.connect(),
    /devtools-port failed.*startup deadline/,
  );
});

test("stalled HTTP body is bounded, not just the response headers", async () => {
  const h = harness({
    timeoutMs: 20,
    now: () => performance.now(),
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    fetchTargets: async () => ({ ok: true, json: () => new Promise(() => {}) }),
  });
  await assert.rejects(
    h.lifecycle.connect(),
    /target-list failed.*startup deadline/,
  );
});

test("synchronous WebSocket constructor failure retains its phase", async () => {
  const h = harness({
    createSocket: () => {
      throw new Error("invalid URL");
    },
  });
  await assert.rejects(
    h.lifecycle.connect(),
    /websocket-connect failed.*invalid URL/,
  );
  assert.equal(h.lifecycle.receipt.failure.phase, "websocket-connect");
});

test("artifact failures are reported without losing primary capture failure or skipping close", async () => {
  const written = [];
  const h = harness({
    writeArtifact: async (file) => {
      written.push(path.basename(file));
      throw new Error("ENOSPC");
    },
  });
  h.lifecycle.captureFinished("failed", new Error("original capture mismatch"));
  assert.equal(await h.lifecycle.close("/synthetic"), true);
  assert.deepEqual(written, ["chrome.log", "browser-lifecycle.json"]);
  assert.equal(
    h.lifecycle.receipt.failure.message,
    "original capture mismatch",
  );
  assert.equal(h.lifecycle.receipt.artifactErrors.length, 2);
  assert.deepEqual(h.child.signals, ["SIGTERM"]);
});

test("every launcher closes its owned server in finally independent of receipt writes", async () => {
  for (const name of [
    "preview-browser",
    "capture-whats-new-preview",
    "capture-trigger-message-preview",
    "capture-settings-audit-preview",
    "capture-file-sidebar-preview",
  ]) {
    const source = await readFile(
      new URL(`../scripts/${name}.mjs`, import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /finally\s*\{\s*server\??\.closeAllConnections\(\)/,
      name,
    );
    assert.match(source, /lifecycle\??\.receipt.cleanupComplete/, name);
    assert.match(source, /receipt.artifactErrors.length/, name);
  }
});

for (const portElapsedMs of [24_537, 29_437]) {
  test(`port at ${portElapsedMs}ms preserves target and handshake budgets without restarting`, async () => {
    let targetCalls = 0;
    let socketCalls = 0;
    let handshakeTimeout;
    const h = harness({
      readPort: async () => {
        h.advance(portElapsedMs);
        return "9222\n";
      },
      fetchTargets: async () => {
        targetCalls++;
        h.advance(1_500);
        return {
          ok: true,
          json: async () =>
            targetCalls < 4
              ? []
              : [{ type: "page", webSocketDebuggerUrl: "ws://fixture/page" }],
        };
      },
      createSocket: (_url, timeout) => {
        socketCalls++;
        handshakeTimeout = timeout;
        queueMicrotask(() => {
          h.advance(3_000);
          h.socket.emit("open");
        });
        return h.socket;
      },
    });
    assert.equal(await h.lifecycle.connect(), h.socket);
    assert.equal(targetCalls, 4);
    assert.equal(socketCalls, 1);
    assert.equal(handshakeTimeout, 5_000);
    assert.equal(h.lifecycle.receipt.readyElapsedMs, portElapsedMs + 9_300);
    assert.deepEqual(h.child.signals, []);
    assert.equal(h.lifecycle.receipt.captureStatus, "not-started");
    assert.deepEqual(h.lifecycle.receipt.phaseTimeoutsMs, {
      "devtools-port": 30_000,
      "target-list": 10_000,
      "websocket-connect": 5_000,
    });
    assert.deepEqual(
      h.lifecycle.receipt.events
        .filter((event) => event.timeoutMs)
        .map(({ phase, durationMs, outcome, pollCount }) => ({
          phase,
          durationMs,
          outcome,
          pollCount,
        })),
      [
        {
          phase: "devtools-port",
          durationMs: portElapsedMs,
          outcome: "passed",
          pollCount: 1,
        },
        {
          phase: "target-list",
          durationMs: 6_300,
          outcome: "passed",
          pollCount: 4,
        },
        {
          phase: "websocket-connect",
          durationMs: 3_000,
          outcome: "passed",
          pollCount: 0,
        },
      ],
    );
  });
}

test("invalid startup and poll budgets are rejected", () => {
  for (const invalid of [0, -1, NaN, Infinity, 2 ** 31, "100"]) {
    for (const options of [
      { timeoutMs: invalid },
      { pollMs: invalid },
      { phaseTimeoutsMs: { "devtools-port": invalid } },
      { phaseTimeoutsMs: { "target-list": invalid } },
      { phaseTimeoutsMs: { "websocket-connect": invalid } },
    ]) {
      assert.throws(() => harness(options), /finite positive.*milliseconds/);
    }
  }
});

for (const elapsedMs of [100, 101]) {
  test(`port completing at ${elapsedMs}ms cannot cross its 100ms phase deadline`, async () => {
    let fetched = false;
    const h = harness({
      timeoutMs: 500,
      phaseTimeoutsMs: { "devtools-port": 100 },
      readPort: async () => {
        h.advance(elapsedMs);
        return "9222\n";
      },
      fetchTargets: async () => {
        fetched = true;
        return { ok: true, json: async () => [] };
      },
    });
    await assert.rejects(
      h.lifecycle.connect(),
      /devtools-port failed.*deadline/,
    );
    assert.equal(fetched, false);
    assert.equal(h.lifecycle.receipt.captureStatus, "not-started");
  });

  test(`target completing at ${elapsedMs}ms cannot cross its 100ms phase deadline`, async () => {
    let connected = false;
    const h = harness({
      timeoutMs: 500,
      phaseTimeoutsMs: { "target-list": 100 },
      fetchTargets: async () => ({
        ok: true,
        json: async () => {
          h.advance(elapsedMs);
          return [{ type: "page", webSocketDebuggerUrl: "ws://fixture/page" }];
        },
      }),
      createSocket: () => {
        connected = true;
        queueMicrotask(() => h.socket.emit("open"));
        return h.socket;
      },
    });
    await assert.rejects(h.lifecycle.connect(), /target-list failed.*deadline/);
    assert.equal(connected, false);
  });

  test(`WebSocket open at ${elapsedMs}ms is rejected after its 100ms phase deadline`, async () => {
    const h = harness({
      timeoutMs: 500,
      phaseTimeoutsMs: { "websocket-connect": 100 },
      createSocket: () => {
        queueMicrotask(() => {
          h.advance(elapsedMs);
          h.socket.emit("open");
        });
        return h.socket;
      },
    });
    await assert.rejects(
      h.lifecycle.connect(),
      /websocket-connect failed.*deadline/,
    );
    assert.equal(h.socket.terminated, true);
    assert.equal(h.lifecycle.receipt.readyElapsedMs, undefined);
    assert.equal(h.lifecycle.receipt.captureStatus, "not-started");
  });
}

test("an explicit total budget still caps all phases together", async () => {
  let connected = false;
  const h = harness({
    timeoutMs: 100,
    readPort: async () => {
      h.advance(80);
      return "9222\n";
    },
    fetchTargets: async () => ({
      ok: true,
      json: async () => {
        h.advance(20);
        return [{ type: "page", webSocketDebuggerUrl: "ws://fixture/page" }];
      },
    }),
    createSocket: () => {
      connected = true;
      return h.socket;
    },
  });
  await assert.rejects(
    h.lifecycle.connect(),
    /target-list failed.*startup deadline 100ms/,
  );
  assert.equal(connected, false);
});

test("repeated malformed ports cannot reset the port phase deadline", async () => {
  let reads = 0;
  const h = harness({
    timeoutMs: 500,
    pollMs: 10,
    phaseTimeoutsMs: { "devtools-port": 50 },
    readPort: async () => {
      reads++;
      return "0\n";
    },
  });
  await assert.rejects(
    h.lifecycle.connect(),
    /devtools-port failed.*deadline 50ms/,
  );
  assert.equal(reads, 5);
});

test("transient HTTP failures and empty lists cannot reset the target phase deadline", async () => {
  let targets = 0;
  const h = harness({
    timeoutMs: 500,
    pollMs: 10,
    phaseTimeoutsMs: { "target-list": 50 },
    fetchTargets: async () => {
      if (++targets % 2) throw new Error("ECONNREFUSED");
      return { ok: true, json: async () => [] };
    },
  });
  await assert.rejects(
    h.lifecycle.connect(),
    /target-list failed.*deadline 50ms/,
  );
  assert.equal(targets, 5);
});

for (const stage of ["port", "response", "body"]) {
  test(`child exit immediately aborts a stalled ${stage} operation`, async () => {
    let abortedAtExit = false;
    const stall = (signal) => {
      h.child.exitCode = 9;
      h.child.emit("exit");
      abortedAtExit = signal.aborted;
      return new Promise(() => {});
    };
    const h = harness({
      timeoutMs: 80,
      now: () => performance.now(),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...(stage === "port"
        ? { readPort: stall }
        : {
            fetchTargets: async (_port, signal) =>
              stage === "response"
                ? stall(signal)
                : { ok: true, json: () => stall(signal) },
          }),
    });
    await assert.rejects(h.lifecycle.connect(), /Chrome exited \(code=9/);
    assert.equal(abortedAtExit, true);
    assert.equal(h.child.listenerCount("exit"), 1);
    assert.equal(h.child.listenerCount("error"), 1);
    assert.equal(h.lifecycle.receipt.captureStatus, "not-started");
  });
}

test("child exit during a handshake terminates the sole socket without retrying", async () => {
  let socketCalls = 0;
  const h = harness({
    createSocket: () => {
      socketCalls++;
      queueMicrotask(() => {
        h.child.exitCode = 9;
        h.child.emit("exit");
      });
      return h.socket;
    },
  });
  await assert.rejects(h.lifecycle.connect(), /websocket-connect failed/);
  assert.equal(socketCalls, 1);
  assert.equal(h.socket.terminated, true);
  assert.deepEqual(h.child.signals, []);
  assert.equal(h.child.listenerCount("exit"), 1);
  assert.equal(h.child.listenerCount("error"), 1);
});

test("real subprocess exit aborts a never-settling port read and is reaped", async (t) => {
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    ["-e", "process.stderr.write('stalled-read exit\\n'); process.exitCode=9"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let readSignal;
  let aborted = false;
  const lifecycle = observePreviewChrome(
    child,
    "/unused-stalled-read-profile",
    {
      timeoutMs: 2_000,
      readPort: (signal) => {
        readSignal = signal;
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        return new Promise(() => {});
      },
    },
  );
  await assert.rejects(lifecycle.connect(), /Chrome exited \(code=9/);
  assert.equal(readSignal?.aborted, true);
  assert.equal(aborted, true);
  const result = await receipt(t, lifecycle);
  assert.equal(result.stopped, true);
  assert.equal(result.data.cleanupComplete, true);
  assert.equal(result.data.profileRetained, false);
  assert.equal(result.data.captureStatus, "not-started");
  assert.equal(result.log, "stalled-read exit\n");
});

for (const stage of ["port", "response", "body", "socket"]) {
  test(`a stalled ${stage} is limited by its 20ms phase, not the 500ms total`, async () => {
    const phase =
      stage === "port"
        ? "devtools-port"
        : stage === "socket"
          ? "websocket-connect"
          : "target-list";
    let readSignal;
    const never = (signal) => {
      readSignal = signal;
      return new Promise(() => {});
    };
    const h = harness({
      timeoutMs: 500,
      phaseTimeoutsMs: { [phase]: 20 },
      now: () => performance.now(),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...(stage === "port"
        ? { readPort: never }
        : stage === "socket"
          ? { createSocket: () => h.socket }
          : {
              fetchTargets: async (_port, signal) =>
                stage === "response"
                  ? never(signal)
                  : { ok: true, json: () => never(signal) },
            }),
    });
    await assert.rejects(
      h.lifecycle.connect(),
      new RegExp(`${phase} failed.*${phase} deadline 20ms`),
    );
    if (stage === "socket") assert.equal(h.socket.terminated, true);
    else assert.equal(readSignal?.aborted, true);
    assert.equal(h.lifecycle.receipt.captureStatus, "not-started");
    assert.equal(
      h.lifecycle.receipt.events.find((event) => event.phase === phase).outcome,
      "failed",
    );
    assert.equal(h.child.listenerCount("exit"), 1);
    assert.equal(h.child.listenerCount("error"), 1);
  });
}

test("an early timer cannot abort I/O or misclassify the phase deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let time = 0;
  let reads = 0;
  let readSignal;
  const h = harness({
    timeoutMs: 500,
    phaseTimeoutsMs: { "devtools-port": 20 },
    now: () => time,
    delay: () => new Promise(() => {}),
    readPort: (signal) => {
      reads++;
      readSignal = signal;
      return new Promise(() => {});
    },
  });
  t.after(() => {
    h.child.exitCode = 9;
    h.child.emit("exit");
  });
  const connecting = h.lifecycle.connect();
  void connecting.catch(() => {});
  await Promise.resolve();
  time = 19;
  t.mock.timers.tick(20);
  assert.equal(readSignal.aborted, false);
  time = 20;
  t.mock.timers.tick(1);
  await assert.rejects(
    connecting,
    /devtools-port failed.*devtools-port deadline 20ms/,
  );
  assert.equal(readSignal.aborted, true);
  assert.equal(reads, 1);
});

test("an HTTP body after its 2s deadline is discarded within the 10s target phase", async () => {
  let requests = 0;
  let lateSignal;
  let socketUrl;
  const h = harness({
    phaseTimeoutsMs: { "target-list": 10_000 },
    fetchTargets: async (_port, signal) => {
      const late = ++requests === 1;
      if (late) lateSignal = signal;
      return {
        ok: true,
        json: async () => {
          if (late) h.advance(2_001);
          return [
            {
              type: "page",
              webSocketDebuggerUrl: late
                ? "ws://late/page"
                : "ws://timely/page",
            },
          ];
        },
      };
    },
    createSocket: (url) => {
      socketUrl = url;
      queueMicrotask(() => h.socket.emit("open"));
      return h.socket;
    },
  });
  assert.equal(await h.lifecycle.connect(), h.socket);
  assert.equal(requests, 2);
  assert.equal(lateSignal.aborted, true);
  assert.equal(socketUrl, "ws://timely/page");
  assert.equal(h.lifecycle.receipt.readyElapsedMs, 2_101);
  assert.deepEqual(h.child.signals, []);
});
