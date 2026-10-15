import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  InspectDiagnosticTransport,
  InspectEvidenceJournal,
  INSPECT_OUTCOME_MS,
  INSPECT_LATE_MS,
  inspectSourceSha256,
  instrumentInspectNative,
  observeFirstInspect,
  timedInspectExpression,
  type InspectLatencyReport,
} from "../src/main/browser-inspect-latency.js";
import { browserInspectScript } from "../src/main/capabilities/browser-provider.js";

interface Request {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}
const ownedUrl = "http://127.0.0.1:12345/agent";
class FakeSocket extends EventEmitter {
  readyState = 1;
  requests: Request[] = [];
  marker: unknown;
  constructor(
    readonly mode = "normal",
    readonly failureMethod = "Runtime.evaluate",
  ) {
    super();
  }
  send(data: string) {
    const request = JSON.parse(data) as Request;
    this.requests.push(request);
    if (
      this.mode === "silent-control" &&
      request.method === "Browser.getVersion"
    )
      return;
    const reply = (result: unknown, session = request.sessionId) =>
      this.emit(
        "message",
        JSON.stringify({
          id: request.id,
          result,
          ...(session ? { sessionId: session } : {}),
        }),
      );
    let result: unknown = {};
    if (request.method === "Target.createTarget") {
      this.marker = request.params.url;
      result = { targetId: "private-target" };
    }
    if (request.method === "Target.getTargets") result = { targetInfos: [] };
    if (request.method === "Target.attachToTarget")
      result = { sessionId: "private-session" };
    if (request.method === "Page.getFrameTree")
      result = {
        frameTree: {
          frame: {
            id: "private-frame",
            loaderId: "private-loader",
            url: ownedUrl,
          },
        },
      };
    if (request.method === "Page.createIsolatedWorld")
      result = { executionContextId: 7 };
    if (request.method === "Runtime.evaluate")
      result = {
        result: {
          value: {
            executionMs: 12,
            readyState: "complete",
            visibility: "hidden",
            nodeCount: 9,
            itemTotal: 3,
            textTotal: 6,
            malicious: "PRIVATE DATA",
          },
        },
      };
    if (request.method === this.failureMethod) {
      if (this.mode === "silent") return;
      if (this.mode === "exception") {
        queueMicrotask(() =>
          reply({ exceptionDetails: { text: "PRIVATE exception" } }),
        );
        return;
      }
      if (this.mode === "late") {
        setTimeout(() => reply(result), 2_050);
        return;
      }
      if (this.mode === "late-error") {
        setTimeout(
          () =>
            this.emit(
              "message",
              JSON.stringify({
                id: request.id,
                sessionId: request.sessionId,
                error: { message: "PRIVATE ERROR" },
              }),
            ),
          2_050,
        );
        return;
      }
      if (this.mode === "wrong-session") {
        queueMicrotask(() => {
          reply(result, "wrong-private-session");
          this.emit("close");
        });
        return;
      }
      if (this.mode === "closed") {
        queueMicrotask(() => this.emit("close"));
        return;
      }
      if (this.mode === "error") {
        queueMicrotask(() =>
          this.emit(
            "message",
            JSON.stringify({
              id: request.id,
              sessionId: request.sessionId,
              error: { message: "PRIVATE ERROR" },
            }),
          ),
        );
        return;
      }
    }
    queueMicrotask(() => {
      reply(result);
      if (request.method === "Page.navigate") {
        this.emit(
          "message",
          JSON.stringify({
            method: "Page.frameNavigated",
            sessionId: request.sessionId,
            params: { frame: { id: "private-frame", url: ownedUrl } },
          }),
        );
        this.emit(
          "message",
          JSON.stringify({
            method: "Page.frameStoppedLoading",
            sessionId: request.sessionId,
            params: { frameId: "private-frame" },
          }),
        );
      }
    });
  }
}
function fixture(mode = "normal", failureMethod = "Runtime.evaluate") {
  const socket = new FakeSocket(mode, failureMethod);
  const transport = new InspectDiagnosticTransport(socket);
  const report: InspectLatencyReport = {
    scope: "owned first-inspect replica; not acceptance",
    sourceSha256: inspectSourceSha256,
    classification: "setup-failed",
    stages: [],
  };
  const run = observeFirstInspect({
    transport,
    report,
    ownedPageUrl: ownedUrl,
    listOwnedTargets: async () => [
      { id: "private-target", url: socket.marker, type: "page" },
    ],
  });
  return { socket, transport, report, run };
}
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
function assertBounded(socket: FakeSocket) {
  assert(
    socket.requests.filter((r) => r.method === "Runtime.evaluate").length <= 1,
  );
  assert(
    socket.requests.filter((r) => r.method === "Browser.getVersion").length <=
      1,
  );
  assert(
    !socket.requests.some((r) =>
      /^(Input\.|Page\.captureScreenshot$|Runtime\.getIsolateId$)/.test(
        r.method,
      ),
    ),
  );
  for (const method of [
    "Target.createTarget",
    "Target.attachToTarget",
    "Page.enable",
    "Runtime.enable",
    "Page.navigate",
    "Page.createIsolatedWorld",
  ])
    assert.equal(
      socket.requests.filter((r) => r.method === method).length <= 1,
      true,
    );
}

test("sole subject is the exact exported first-inspect expression, same isolated context and unchanged outcome bounds", async () => {
  assert.equal(INSPECT_OUTCOME_MS, 2_000);
  assert.equal(INSPECT_LATE_MS, 5_000);
  assert.equal(
    inspectSourceSha256,
    createHash("sha256").update(browserInspectScript).digest("hex"),
  );
  assert.equal(timedInspectExpression.split(browserInspectScript).length, 2);
  const { run, report, socket, transport } = fixture();
  await run;
  assert.equal(report.classification, "not-reproduced");
  const subject = socket.requests.find((r) => r.method === "Runtime.evaluate");
  assert(subject);
  assert.deepEqual(subject.params, {
    expression: timedInspectExpression,
    awaitPromise: true,
    returnByValue: true,
    contextId: 7,
  });
  assert.equal(subject.sessionId, "private-session");
  assert.equal(report.renderer?.executionMs, 12);
  assert.equal(report.browserProbe?.status, "success");
  assertBounded(socket);
  assert.equal(socket.requests.at(-1)?.method, "Browser.getVersion");
  assert(!JSON.stringify(report).includes("PRIVATE"));
  assert(!JSON.stringify(transport.events).includes("private-"));
  const setup = transport.events.filter(
    (e) =>
      e.kind === "send" &&
      ["Page.enable", "Runtime.enable"].includes(String(e.method)),
  );
  assert(
    setup.every(
      (e) => Number(e.timeoutMs) > 2_000 && Number(e.timeoutMs) <= 10_000,
    ),
  );
  assert.equal(
    transport.events.find(
      (e) => e.kind === "send" && e.method === "Runtime.evaluate",
    )?.timeoutMs,
    2_000,
  );
  transport.dispose();
});

test("late original evaluate success preserves unknown and execution timing without another target command", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture("late");
  await flush();
  t.mock.timers.tick(2_000);
  await flush();
  assert.equal(f.report.stages.at(-1)?.initial.status, "outcome-unknown");
  t.mock.timers.tick(50);
  await f.run;
  assert.equal(f.report.classification, "outcome-unknown");
  assert.equal(f.report.stages.at(-1)?.late?.status, "success");
  assert.equal(f.report.renderer?.executionMs, 12);
  assertBounded(f.socket);
  f.transport.dispose();
});

test("silent subject stops after the original 5s observation window with no timing invented", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture("silent");
  await flush();
  t.mock.timers.tick(2_000);
  await flush();
  t.mock.timers.tick(5_000);
  await f.run;
  assert.equal(f.report.classification, "outcome-unknown");
  assert.equal(f.report.stages.at(-1)?.late?.status, "outcome-unknown");
  assert.equal(f.report.renderer, undefined);
  assertBounded(f.socket);
  f.transport.dispose();
});

test("an earlier unknown never advances to world/evaluate even when its original reply arrives", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture("late", "Target.createTarget");
  await flush();
  t.mock.timers.tick(2_000);
  await flush();
  t.mock.timers.tick(50);
  await f.run;
  assert.equal(f.report.classification, "outcome-unknown");
  assert.equal(f.report.stages.at(-1)?.method, "Target.createTarget");
  assert(
    !f.socket.requests.some(
      (r) =>
        r.method === "Target.attachToTarget" || r.method === "Runtime.evaluate",
    ),
  );
  assertBounded(f.socket);
  assert.equal(
    f.socket.requests.filter((r) => r.method === "Browser.getVersion").length,
    0,
  );
  f.transport.dispose();
});

test("protocol errors, closure and wrong routes cannot be interpreted as successful measurements", async () => {
  for (const mode of ["error", "exception", "closed", "wrong-session"]) {
    const f = fixture(mode);
    await f.run;
    assert.equal(
      f.report.classification,
      mode === "error" || mode === "exception"
        ? "protocol-error"
        : mode === "closed"
          ? "transport-closed"
          : "session-route-mismatch",
    );
    assert.equal(f.report.renderer, undefined);
    assertBounded(f.socket);
    assert(!JSON.stringify(f.report).includes("PRIVATE"));
    f.transport.dispose();
  }
});

test("late protocol failure also preserves original unknown and previous stages", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture("late-error");
  await flush();
  t.mock.timers.tick(2_000);
  await flush();
  t.mock.timers.tick(50);
  await f.run;
  assert.equal(f.report.classification, "outcome-unknown");
  assert.equal(f.report.stages.at(-1)?.late?.status, "protocol-error");
  assert.equal(f.report.stages[0]?.method, "Target.setDiscoverTargets");
  assert.equal(f.report.renderer, undefined);
  assertBounded(f.socket);
  f.transport.dispose();
});

test("a real 2s subject deadline retains unknown after one original late reply", async () => {
  const f = fixture("late");
  await f.run;
  assert.equal(f.report.classification, "outcome-unknown");
  assert(Number(f.report.stages.at(-1)?.initial.elapsedMs) >= 1_950);
  assert(Number(f.report.stages.at(-1)?.late?.elapsedMs) >= 2_000);
  assertBounded(f.socket);
  f.transport.dispose();
});

test("the timing envelope evaluates the full original expression with the same fixture results", () => {
  const html =
    '<!doctype html><title>synthetic</title><canvas tabindex="0"></canvas><input aria-label="Agent input"><button>Submit</button>';
  const execute = (expression: string) => {
    const dom = new JSDOM(html, { runScripts: "outside-only", url: ownedUrl });
    Object.defineProperty(
      dom.window.HTMLElement.prototype,
      "getBoundingClientRect",
      {
        value: () => ({
          width: 100,
          height: 20,
          top: 1,
          left: 1,
          right: 101,
          bottom: 21,
        }),
      },
    );
    Object.defineProperty(dom.window, "CSS", {
      value: { escape: (s: string) => s },
    });
    try {
      return dom.window.eval(expression) as Record<string, unknown>;
    } finally {
      dom.window.close();
    }
  };
  const original = execute(browserInspectScript);
  const wrapped = execute(timedInspectExpression);
  assert.equal(wrapped.itemTotal, original.itemTotal);
  assert.equal(wrapped.textTotal, original.textTotal);
  assert(Number.isFinite(wrapped.executionMs));
  assert(Number(wrapped.executionMs) >= 0);
  assert(!("visibleText" in wrapped));
  assert(!("targets" in wrapped));
});

test("AX instrumentation only brackets the original title read; cooldown and every guard remain byte-identical", async () => {
  const source = await readFile(
    new URL("../src/main/browser-parallel-input-smoke.ts", import.meta.url),
    "utf8",
  );
  const start =
    source.indexOf("const MAC_NATIVE = String.raw`") +
    "const MAC_NATIVE = String.raw`".length;
  const native = source.slice(start, source.indexOf("\n`;", start));
  assert(native.includes("let idleTitleCooldown = 0.25"));
  const instrumented = instrumentInspectNative(native);
  const added = instrumented.slice(
    instrumented.indexOf("  let diagnosticStart"),
    instrumented.indexOf("  titleSamples += 1"),
  );
  assert.equal(instrumented.replace(added, ""), native);
  assert(!added.includes("AXUIElementCopyAttributeValue"));
  assert(!added.includes("sample("));
  assert(!added.includes("owns("));
  assert.throws(() => instrumentInspectNative("missing seam"));
});

test("event evidence is bounded and never stores arbitrary CDP payload", () => {
  const socket = new FakeSocket();
  const transport = new InspectDiagnosticTransport(socket);
  for (let i = 0; i < 1_000; i++)
    socket.emit(
      "message",
      JSON.stringify({
        method: "Runtime.executionContextCreated",
        params: { secret: "PRIVATE" },
      }),
    );
  assert.equal(transport.events.length, 256);
  assert.equal(transport.droppedEvents, 744);
  assert(!JSON.stringify(transport.events).includes("PRIVATE"));
  transport.dispose();
});

test("workflow is exact-head, readonly, single opened attempt and one profile; cleanup confirms exits before deletion", async () => {
  const workflow = await readFile(
    new URL(
      "../../../.github/workflows/browser-inspect-diagnostic.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert(workflow.includes("types: [opened]"));
  assert(workflow.includes("github.run_attempt == 1"));
  assert(workflow.includes("github.event.pull_request.head.sha"));
  assert(workflow.includes("persist-credentials: false"));
  assert(!workflow.includes("workflow_dispatch"));
  assert(!workflow.includes("for mode"));
  const runner = await readFile(
    new URL("../src/main/browser-inspect-diagnostic.ts", import.meta.url),
    "utf8",
  );
  assert.equal(runner.split("await observeFirstInspect(").length, 2);
  assert(
    runner.indexOf("await confirmInspectChildExit(browser)") <
      runner.indexOf("await rm(directory"),
  );
  assert(
    runner.indexOf("await confirmInspectChildExit(native.child)") <
      runner.indexOf("await rm(directory"),
  );
  assert(runner.includes("if (cleanupErrors.length === 0)"));
  assert(runner.includes("ownedDirectoryRetained = true"));
});

test("incremental evidence writes are serialized and retain order before a flush", async () => {
  const written: string[] = [];
  const release: (() => void)[] = [];
  const journal = new InspectEvidenceJournal({
    head: "head",
    tree: "tree",
    emit: () => {},
    append: async (line) => {
      written.push(line);
      await new Promise<void>((resolve) => release.push(resolve));
    },
  });
  journal.record("first", { original: "unknown" });
  journal.record("second", { late: "success" });
  await flush();
  assert.equal(written.length, 1);
  release.shift()!();
  await flush();
  assert.equal(written.length, 2);
  release.shift()!();
  await journal.flush();
  assert.deepEqual(
    written.map((line) => JSON.parse(line).kind),
    ["first", "second"],
  );
});

test("incremental write rejection blocks the next target command, preserving completed stage evidence", async () => {
  const emitted: string[] = [];
  const journal = new InspectEvidenceJournal({
    head: "head",
    tree: "tree",
    emit: (line) => emitted.push(line),
    append: async () => {
      throw Error("disk unavailable");
    },
  });
  const socket = new FakeSocket();
  const transport = new InspectDiagnosticTransport(socket, (event) =>
    journal.record("transport", event),
  );
  const report: InspectLatencyReport = {
    scope: "owned first-inspect replica; not acceptance",
    sourceSha256: inspectSourceSha256,
    classification: "setup-failed",
    stages: [],
  };
  await assert.rejects(
    observeFirstInspect({
      transport,
      report,
      ownedPageUrl: ownedUrl,
      listOwnedTargets: async () => [],
      checkpoint: () => journal.flush(),
      progress: (value) => journal.record("observation", value),
    }),
    /evidence-append-failed-or-timed-out/,
  );
  assert.equal(socket.requests.length, 1);
  assert.equal(socket.requests[0]?.method, "Target.setDiscoverTargets");
  assert.equal(report.stages[0]?.initial.status, "success");
  assert.equal(report.classification, "setup-failed");
  assert.equal(
    emitted.filter((line) => JSON.parse(line).kind === "evidence-write-failed")
      .length,
    1,
  );
  await assert.rejects(journal.flush());
  transport.dispose();
});

test("stalled evidence writes have a bound and cannot authorize more stages", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const journal = new InspectEvidenceJournal({
    head: "head",
    tree: "tree",
    emit: () => {},
    append: async () => await new Promise(() => {}),
  });
  journal.record("deadline", { initial: "outcome-unknown" });
  await flush();
  t.mock.timers.tick(2_000);
  await flush();
  await assert.rejects(journal.flush(), /evidence-append-failed-or-timed-out/);
});

test("evidence record/byte limits fail closed instead of unbounded output", async () => {
  let writes = 0;
  const journal = new InspectEvidenceJournal({
    head: "head",
    tree: "tree",
    emit: () => {},
    append: async () => {
      writes++;
    },
  });
  journal.record("oversized", "x".repeat(1_048_576));
  await assert.rejects(journal.flush(), /evidence-bound-exceeded/);
  assert.equal(writes, 0);
  const counted = new InspectEvidenceJournal({
    head: "head",
    tree: "tree",
    emit: () => {},
    append: async () => {
      writes++;
    },
  });
  for (let i = 0; i < 1_025; i++) counted.record("counter", {});
  await assert.rejects(counted.flush(), /evidence-bound-exceeded/);
  assert.equal(writes, 0);
});

test("subject timing/classification is persisted before waiting for a silent independent control", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const written: Record<string, any>[] = [];
  const journal = new InspectEvidenceJournal({
    head: "head",
    tree: "tree",
    emit: () => {},
    append: async (line) => {
      written.push(JSON.parse(line));
    },
  });
  const socket = new FakeSocket("silent-control");
  const transport = new InspectDiagnosticTransport(socket, (event) =>
    journal.record("transport", event),
  );
  const report: InspectLatencyReport = {
    scope: "owned first-inspect replica; not acceptance",
    sourceSha256: inspectSourceSha256,
    classification: "setup-failed",
    stages: [],
  };
  let completed = false;
  const run = observeFirstInspect({
    transport,
    report,
    ownedPageUrl: ownedUrl,
    listOwnedTargets: async () => [
      { id: "private-target", type: "page", url: socket.marker },
    ],
    checkpoint: () => journal.flush(),
    progress: (value) => journal.record("observation", value),
  }).then(() => {
    completed = true;
  });
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(completed, false);
  assert(
    written.some(
      (entry) =>
        entry.kind === "observation" &&
        entry.value.renderer?.executionMs === 12 &&
        entry.value.classification === "not-reproduced",
    ),
    "known subject timing must reach disk before control's deadline",
  );
  assert.equal(
    socket.requests.filter((request) => request.method === "Runtime.evaluate")
      .length,
    1,
  );
  t.mock.timers.tick(2_000);
  await flush();
  assert(
    written.some(
      (entry) =>
        entry.kind === "observation" &&
        entry.value.browserProbe?.status === "outcome-unknown",
    ),
  );
  assert.equal(completed, false);
  t.mock.timers.tick(5_000);
  await run;
  assert.equal(report.classification, "not-reproduced");
  assert.equal(report.renderer?.executionMs, 12);
  assert.equal(report.browserProbe?.status, "outcome-unknown");
  assertBounded(socket);
  transport.dispose();
});
