import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/main/browser-parallel-input-smoke.ts", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "smoke.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);
const declaration = ast.statements.find(
  (n) =>
    ts.isFunctionDeclaration(n) &&
    n.name?.text === "runFreshNestedCaptureSmoke",
);
const code = ts.transpileModule(
  `${declaration.getText(ast).replace(/^export /u, "")}; runFreshNestedCaptureSmoke`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function fixture({
  failCapture = false,
  failGuard = false,
  failSink = false,
  failCleanup,
} = {}) {
  const calls = [],
    reports = [];
  const cleanupFailure = new Error("synthetic cleanup failure");
  const step = (name) => {
    calls.push(name);
    if (name === failCleanup) throw cleanupFailure;
  };
  const failure = new Error("synthetic capture timeout");
  const guardFailure = new Error("synthetic foreground drift");
  const state = {
    visibility: "hidden",
    childVisibility: "hidden",
    events: [],
    rootEvents: [],
  };
  let listener;
  const rpc = {
    onEvent: (fn) => {
      listener = fn;
      return () => step("remove-listener");
    },
    send: async (method, params) => {
      calls.push(method);
      assert.equal(method.startsWith("Input."), false);
      if (method === "Page.captureScreenshot") {
        assert.equal(params.fromSurface, true);
        assert.equal(params.captureBeyondViewport, false);
        listener({
          method: "Page.lifecycleEvent",
          params: { name: "firstPaint", url: "private-payload" },
        });
        listener({
          method: "Page.lifecycleEvent",
          params: { name: "private-event" },
        });
        if (failCapture) throw failure;
        return { data: "synthetic-image" };
      }
      return {};
    },
    evaluate: async (expression) => {
      calls.push(expression);
      if (expression.includes("window.contract?.mode")) return true;
      if (expression.includes("focus('text-a')")) return { inner: "text-a" };
      assert.equal(expression, "window.contract.state()");
      return state;
    },
    screenshotTransport: () => ({ records: [] }),
    close: () => step("rpc-close"),
  };
  const server = new EventEmitter();
  server.listen = (_port, host, resolve) => {
    assert.equal(host, "127.0.0.1");
    server.listening = true;
    resolve();
  };
  server.address = () => ({ port: 12345 });
  server.close = (resolve) => {
    calls.push("server-close");
    server.listening = false;
    resolve(failCleanup === "server-close" ? cleanupFailure : undefined);
  };
  server.closeAllConnections = () => calls.push("server-close-all");
  const run = runInNewContext(code, {
    assert,
    URL,
    Object,
    Promise,
    String,
    Math,
    createServer: () => server,
    randomUUID: () => "12345678-1234-1234-1234-123456789012",
    Rpc: { connect: async () => rpc },
    poll: async (fn) => {
      const value = await fn();
      assert.ok(value);
      return value;
    },
    AbortSignal,
    fetch: async () => ({
      json: async () => [
        { id: "owned", webSocketDebuggerUrl: "ws://synthetic" },
      ],
    }),
    observeRemoteFramePlacement: async (_rpc, _browserRpc, mode, url) => {
      calls.push("placement");
      assert.equal(mode, "nested-oopif");
      assert.equal(new URL(url).searchParams.get("outerAffine"), "true");
      assert.equal(
        new URL(url).searchParams.get("leafOrigin"),
        "http://nested.localhost:12345",
      );
    },
  });
  return {
    calls,
    reports,
    failure,
    guardFailure,
    cleanupFailure,
    run: () =>
      run({
        backend: {
          open: async (_session, url) => {
            assert.equal(url, "about:blank");
            calls.push("open");
            return { tabId: "owned" };
          },
          navigate: async (_session, id, url) => {
            assert.equal(id, "owned");
            assert.equal(new URL(url).searchParams.get("mode"), "nested-oopif");
            calls.push("navigate");
          },
          closeTab: async (_session, id) => {
            assert.equal(id, "owned");
            step("backend-close");
          },
        },
        sessionId: "synthetic",
        origin: "http://127.0.0.1:1234",
        endpoint: "http://127.0.0.1:9222",
        browserRpc: {
          send: async (method, params) => {
            assert.equal(method, "Target.closeTarget");
            assert.equal(params.targetId, "owned");
            step("physical-close");
            return { success: true };
          },
        },
        guard: async () => {
          calls.push("guard");
          if (
            failCleanup === "foreground-guard" &&
            calls.includes("physical-close")
          )
            throw cleanupFailure;
          if (failGuard) throw guardFailure;
        },
        report: (receipt) => {
          reports.push(receipt);
          if (failSink) throw new Error("synthetic sink failure");
        },
      }),
  };
}

for (const failCapture of [false, true])
  test(`fresh capture ${failCapture ? "failure" : "success"} has one capture and preplanned heartbeat, no input or retry`, async () => {
    const f = fixture({ failCapture, failSink: true });
    if (failCapture) await assert.rejects(f.run(), (e) => e === f.failure);
    else await f.run();
    assert.equal(
      f.calls.filter((x) => x === "Page.captureScreenshot").length,
      1,
    );
    assert.equal(
      f.calls.filter((x) => x === "window.contract.state()").length,
      2,
    );
    assert.equal(f.calls.filter((x) => x === "physical-close").length, 1);
    assert.ok(
      f.calls.indexOf("placement") < f.calls.indexOf("Page.captureScreenshot"),
    );
    assert.ok(f.calls.indexOf("rpc-close") < f.calls.indexOf("physical-close"));
    const receipt = f.reports[0];
    assert.equal(receipt.status, failCapture ? "failed" : "passed");
    assert.equal(receipt.dispatchAttempts, 0);
    assert.equal(receipt.captureAttempts, 1);
    assert.equal(receipt.heartbeatAttempts, 1);
    assert.equal(receipt.heartbeatOutcome, "success");
    assert.equal(receipt.lifecycle["lifecycle:firstPaint"], 1);
    assert.equal(JSON.stringify(receipt).includes("private-"), false);
  });

test("foreground failure prevents opening a diagnostic target", async () => {
  const f = fixture({ failGuard: true });
  await assert.rejects(f.run(), (e) => e === f.guardFailure);
  assert.equal(f.calls.includes("open"), false);
  assert.equal(f.calls.includes("Page.captureScreenshot"), false);
});

test("fresh-only entry precedes inspection, extensions, and all scenario input, then returns", () => {
  const start = source.indexOf(
    'if (process.env.ZENX_FRESH_NESTED_CAPTURE_ONLY === "1")',
  );
  const end = source.indexOf('phase = "startup-agent-inspection"', start);
  assert.ok(start > 0 && end > start);
  const branch = source.slice(start, end);
  assert.match(branch, /await runFreshNestedCaptureSmoke\(/u);
  assert.match(branch, /return;/u);
  assert.match(branch, /assert.equal\(front.drift, false\)/u);
  assert.match(branch, /assert.equal\(visibility, "hidden"\)/u);
  assert.equal(branch.includes("Target.activateTarget"), false);
  assert.equal(declaration.getText(ast).includes('"Input.'), false);
  assert.equal(declaration.getText(ast).includes("setTimeout"), false);
});

for (const stage of [
  "remove-listener",
  "rpc-close",
  "backend-close",
  "physical-close",
  "foreground-guard",
  "server-close",
]) {
  for (const failCapture of [false, true])
    test(`cleanup ${stage} failure preserves ${failCapture ? "primary failure" : "cleanup failure"} and never reports passed`, async () => {
      const f = fixture({ failCapture, failCleanup: stage });
      await assert.rejects(
        f.run(),
        (error) => error === (failCapture ? f.failure : f.cleanupFailure),
      );
      const receipt = f.reports[0];
      assert.equal(receipt.status, "failed");
      assert.equal(receipt.cleanupStatus, "failed");
      assert.equal(receipt.cleanupFailures.length, 1);
      assert.equal(receipt.primaryFailure, failCapture ? true : undefined);
      assert.ok(f.calls.includes("physical-close"));
      assert.ok(f.calls.includes("server-close"));
      assert.equal(
        f.calls.filter((x) => x === "Page.captureScreenshot").length,
        1,
      );
    });
}

test("successful capture reports completed cleanup separately", async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.reports[0].cleanupStatus, "completed");
  assert.equal(f.reports[0].status, "passed");
});
