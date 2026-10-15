import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { InspectEvidenceJournal } from "../src/main/browser-inspect-latency.js";

const source = readFileSync(
  new URL("../src/main/browser-inspect-diagnostic.ts", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "runner.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);
const main = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "main",
);
assert(main);
const executable = ts.transpileModule(
  main.getText(ast).replace(/^export /, ""),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

async function exercise({
  cleanupFailure = false,
  removalFailure = false,
  storageFailure = false,
  observationFailure = false,
  stalledCleanup = false,
  subjectSuccessControlUnknown = false,
} = {}) {
  const calls = [];
  const printed = [];
  const writes = [];
  const journalWrites = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    exitCode: null,
    signalCode: null,
    stderr: new EventEmitter(),
  });
  const nativeChild = Object.assign(new EventEmitter(), {
    pid: 99,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
  });
  const processStub = {
    platform: "darwin",
    env: {
      CI: "1",
      GITHUB_RUN_ATTEMPT: "1",
      ZENX_USER_BROWSER_EXECUTABLE: "/owned/chrome",
      ZENX_INSPECT_ARTIFACT_DIR: "/owned/evidence",
      ZENX_DIAGNOSTIC_HEAD: "a".repeat(40),
      ZENX_DIAGNOSTIC_TREE: "b".repeat(40),
    },
  };
  const server = Object.assign(new EventEmitter(), {
    listening: false,
    listen(_port, _host, callback) {
      this.listening = true;
      callback();
    },
    address: () => ({ port: 3000 }),
    close(callback) {
      calls.push("server-close");
      this.listening = false;
      callback();
    },
    closeAllConnections() {},
  });
  class Socket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit("open"));
    }
    terminate() {
      calls.push("socket-terminate");
    }
  }
  const run = runInNewContext(`${executable}; main`, {
    assert,
    AbortSignal,
    path,
    process: processStub,
    performance,
    Date,
    Promise,
    URL,
    JSON,
    Number,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    os: { tmpdir: () => "/tmp" },
    randomUUID: () => "owned-profile",
    mkdtemp: async () => "/tmp/owned-inspect",
    mkdir: async () => {},
    readFile: async () => "3100\n",
    rm: async () => {
      calls.push("rm");
      if (removalFailure) throw Error("cannot remove");
    },
    appendFile: async (_path, value) => {
      journalWrites.push(JSON.parse(value));
    },
    InspectEvidenceJournal,
    writeFile: async (_path, value) => {
      if (value === "") return;
      writes.push(JSON.parse(value));
      if (storageFailure) throw Error("storage unavailable");
    },
    createHash: () => ({
      update() {
        return this;
      },
      digest: () => "fixed-hash",
    }),
    createServer: () => server,
    createInterface: () => Object.assign(new EventEmitter(), { close() {} }),
    page: () => "<title>USER owned</title>",
    recordValue: (value) =>
      value && typeof value === "object" ? value : undefined,
    startNative: async () => ({
      child: nativeChild,
      ready: Promise.resolve({ pid: 99, axTrusted: true }),
      call: async (method) => {
        calls.push(`native:${method}`);
        return { pid: 42, drift: false };
      },
      close: async () => calls.push("native-close"),
    }),
    spawn: () => child,
    fetch: async (url) => ({
      ok: true,
      json: async () =>
        url.endsWith("json/version")
          ? {
              Browser: "Chrome/153.0.0.0",
              webSocketDebuggerUrl:
                "ws://127.0.0.1:3100/devtools/browser/owned",
            }
          : [
              {
                id: "user",
                title: "USER owned",
                type: "page",
                url: "http://127.0.0.1:3000/user",
                webSocketDebuggerUrl: "ws://127.0.0.1:3100/devtools/page/owned",
              },
            ],
    }),
    poll: async (read) => {
      const value = await read();
      assert.notEqual(value, undefined);
      return value;
    },
    Rpc: {
      connect: async () => ({
        evaluate: async () => true,
        send: async () => ({}),
        close: () => {},
      }),
    },
    WebSocket: Socket,
    InspectDiagnosticTransport: class {
      events = [];
      droppedEvents = 0;
      dispose() {
        calls.push("transport-dispose");
      }
    },
    monitorEventLoopDelay: () => ({
      enable() {},
      disable() {},
      mean: 1,
      max: 1,
      percentile: () => 1,
    }),
    inspectSourceSha256: "source-sha",
    timedInspectExpression: "exact-timed-source",
    instrumentInspectNative: (source) => source,
    observeFirstInspect: async ({ report }) => {
      report.classification = "outcome-unknown";
      report.stages.push({
        method: "Runtime.evaluate",
        initial: { status: "outcome-unknown", elapsedMs: 2000 },
      });
      if (subjectSuccessControlUnknown) {
        report.classification = "not-reproduced";
        report.stages[0].initial.status = "success";
        report.renderer = { executionMs: 12 };
        report.browserProbe = { status: "outcome-unknown", elapsedMs: 2000 };
      }
      if (observationFailure) throw Error("observer broke after evidence");
    },
    confirmInspectChildExit: async (target) => {
      calls.push(`confirm:${target.pid}`);
      if (stalledCleanup) return await new Promise(() => {});
      if (cleanupFailure && target.pid === 42) throw Error("alive");
      target.exitCode = 0;
    },
    console: { log: (value) => printed.push(JSON.parse(value)) },
  });
  if (stalledCleanup) {
    void run();
    for (let i = 0; i < 200; i++) await Promise.resolve();
    return { journalWrites, calls, printed, writes };
  }
  if (storageFailure) await assert.rejects(run(), /storage unavailable/);
  else await run();
  const final = printed.filter((entry) => entry.observation);
  assert.equal(final.length, 1);
  assert.equal(writes.length, 1);
  assert.equal(
    final[0].observation.classification,
    subjectSuccessControlUnknown ? "not-reproduced" : "outcome-unknown",
  );
  assert.equal(
    final[0].observation.stages[0].initial.status,
    subjectSuccessControlUnknown ? "success" : "outcome-unknown",
  );
  assert.equal(
    calls.filter((call) => call === "native:snapshot").length,
    1,
    "No extra AX snapshot during observation or cleanup",
  );
  return { report: final[0], calls, processStub, journalWrites };
}

test("actual main preserves partial observation and unknown through successful cleanup", async () => {
  const { report, calls } = await exercise({ observationFailure: true });
  assert.equal(report.cleanupConfirmed, true);
  assert.equal(typeof report.setupError, "string");
  assert(calls.indexOf("confirm:42") < calls.indexOf("rm"));
  assert(calls.indexOf("confirm:99") < calls.indexOf("rm"));
});

test("actual main retains owned directory and evidence when child exit is unconfirmed", async () => {
  const { report, calls, processStub } = await exercise({
    cleanupFailure: true,
  });
  assert.equal(report.cleanupConfirmed, false);
  assert.equal(report.ownedDirectoryRetained, true);
  assert(!calls.includes("rm"));
  assert.equal(processStub.exitCode, 1);
});

test("actual main keeps the completed evidence when directory removal fails", async () => {
  const { report, processStub } = await exercise({ removalFailure: true });
  assert.equal(report.cleanupConfirmed, false);
  assert(report.cleanupErrors.includes("owned-directory-removal-failed"));
  assert.equal(processStub.exitCode, 1);
});

test("actual main prints evidence before an artifact-storage failure", async () => {
  await exercise({ storageFailure: true });
});

test("actual main leaves durable unknown evidence before intentionally stalled cleanup", async () => {
  const { journalWrites, calls, printed, writes } = await exercise({
    stalledCleanup: true,
  });
  assert(calls.includes("confirm:42"));
  assert(!calls.includes("rm"));
  assert(
    journalWrites.some(
      (entry) =>
        entry.kind === "before-cleanup" &&
        entry.value.observation.stages[0].initial.status === "outcome-unknown",
    ),
  );
  assert.equal(
    writes.length,
    0,
    "final report not required to preserve progress",
  );
  assert(!printed.some((entry) => entry.observation));
});

test("actual main exits nonzero for unknown even if cleanup and evidence succeed", async () => {
  const { report, processStub } = await exercise();
  assert.equal(report.cleanupConfirmed, true);
  assert.equal(report.evidenceError, undefined);
  assert.equal(processStub.exitCode, 1);
});

test("actual main rejects an unknown control without overwriting successful subject evidence", async () => {
  const { report, processStub } = await exercise({
    subjectSuccessControlUnknown: true,
  });
  assert.equal(report.observation.classification, "not-reproduced");
  assert.equal(report.observation.renderer.executionMs, 12);
  assert.equal(report.observation.browserProbe.status, "outcome-unknown");
  assert.equal(processStub.exitCode, 1);
});
