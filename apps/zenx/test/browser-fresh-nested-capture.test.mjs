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
    reports = [],
    navigations = [];
  let nonceSequence = 0;
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
          method: "Page.frameNavigated",
          params: { frame: { id: "root", loaderId: "current" } },
        });
        listener({
          method: "Page.lifecycleEvent",
          params: {
            name: "firstPaint",
            frameId: "root",
            loaderId: "current",
            url: "private-payload",
          },
        });
        listener({
          method: "Page.lifecycleEvent",
          params: {
            name: "firstPaint",
            frameId: "root",
            loaderId: "predecessor",
          },
        });
        listener({
          method: "Page.lifecycleEvent",
          params: { name: "firstPaint", frameId: "child", loaderId: "current" },
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
    randomUUID: () =>
      `12345678-1234-1234-1234-${String(++nonceSequence).padStart(12, "0")}`,
    isRemoteFrameMode: (mode) =>
      [
        "cross-origin-same-process",
        "cross-origin-oopif",
        "nested-oopif",
        "nested-same-process",
      ].includes(mode),
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
    navigations,
    run: (overrides = {}) =>
      run({
        backend: {
          open: async (_session, url) => {
            assert.equal(url, "about:blank");
            calls.push("open");
            return { tabId: "owned" };
          },
          navigate: async (_session, id, url) => {
            assert.equal(id, "owned");
            navigations.push(new URL(url));
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
        ...overrides,
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
    'process.env.ZENX_FRESH_NESTED_CAPTURE_ONLY === "1"',
  );
  const end = source.indexOf('phase = "startup-agent-inspection"', start);
  assert.ok(start > 0 && end > start);
  const branch = source.slice(start, end);
  assert.match(branch, /await runCaptureDiagnostic\(/u);
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

test("navigation-only history preserves exact preceding mode order with one final capture", async () => {
  const f = fixture();
  await f.run({ condition: "navigation-history" });
  const acceptance = ast.statements.find(
    (n) =>
      ts.isFunctionDeclaration(n) &&
      n.name?.text === "runTargetedInputContractSmoke",
  );
  let normalModes;
  const visit = (node) => {
    if (
      ts.isForOfStatement(node) &&
      ts.isArrayLiteralExpression(node.expression) &&
      node.expression.elements.some(
        (e) => ts.isStringLiteral(e) && e.text === "stop-propagation",
      )
    )
      normalModes = node.expression.elements
        .filter(ts.isStringLiteral)
        .map((e) => e.text);
    ts.forEachChild(node, visit);
  };
  visit(acceptance);
  assert.ok(normalModes);
  const expected = [
    ...normalModes,
    "cross-origin-same-process",
    "cross-origin-oopif",
    "nested-oopif",
  ];
  assert.deepEqual(
    f.navigations.map((url) => url.searchParams.get("mode")),
    expected,
  );
  const remote = f.navigations.filter((url) => url.searchParams.has("nonce"));
  assert.equal(
    new Set(remote.map((url) => url.searchParams.get("nonce"))).size,
    3,
  );
  assert.equal(
    remote[0].searchParams.get("childOrigin"),
    "http://127.0.0.1:12345",
  );
  assert.equal(f.calls.filter((x) => x === "placement").length, 1);
  assert.equal(
    f.calls.filter((x) => x === "window.contract.focus('text-a')").length,
    1,
  );
  assert.equal(f.calls.filter((x) => x === "Page.captureScreenshot").length, 1);
  assert.equal(f.reports[0].history.length, 12);
  assert.equal(f.reports[0].historyInputDispatches, 0);
  assert.equal(f.reports[0].historyProviderInspections, 0);
  assert.equal(typeof f.reports[0].finalNavigationToCaptureMs, "number");
  assert.equal(typeof f.reports[0].heartbeatElapsedMs, "number");
});

function matrix(runScene) {
  const declaration = ast.statements.find(
    (n) =>
      ts.isFunctionDeclaration(n) &&
      n.name?.text === "runNestedCaptureMatrixSmoke",
  );
  return runInNewContext(
    ts.transpileModule(
      `${declaration.getText(ast).replace(/^export /u, "")}; runNestedCaptureMatrixSmoke`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    { runFreshNestedCaptureSmoke: runScene, Error, Date },
  );
}

test("matrix predeclares three independent scenes and preserves a capture failure", async () => {
  const conditions = [],
    receipts = [];
  const timeout = Object.assign(new Error("synthetic timeout"), {
    fixtureCdp: { method: "Page.captureScreenshot" },
  });
  const run = matrix(async (options) => {
    conditions.push(options.condition);
    options.report({
      stage: "capture-and-heartbeat",
      heartbeatOutcome: "success",
      cleanupStatus: "completed",
      condition: options.condition,
    });
    if (options.condition === "navigation-history") throw timeout;
  });
  await assert.rejects(
    run({ report: (r) => receipts.push(r) }),
    (e) => e === timeout,
  );
  assert.deepEqual(conditions, [
    "fresh-early",
    "navigation-history",
    "fresh-late",
  ]);
  assert.equal(receipts.length, 3);
  for (const receipt of receipts) {
    assert.deepEqual(Array.from(receipt.plannedConditions), conditions);
    assert.equal(typeof receipt.sceneStartedAfterMatrixMs, "number");
  }
});

for (const invalid of ["cleanup", "heartbeat", "stage", "non-timeout"])
  test(`matrix stops instead of continuing after ${invalid} failure`, async () => {
    const conditions = [];
    const failure = Object.assign(
      new Error("synthetic failure"),
      invalid === "non-timeout"
        ? {}
        : { fixtureCdp: { method: "Page.captureScreenshot" } },
    );
    const run = matrix(async (options) => {
      conditions.push(options.condition);
      options.report({
        stage:
          invalid === "stage" ? "verify-placement" : "capture-and-heartbeat",
        heartbeatOutcome: invalid === "heartbeat" ? "pending" : "success",
        cleanupStatus: invalid === "cleanup" ? "failed" : "completed",
      });
      throw failure;
    });
    await assert.rejects(run({ report: () => {} }), (e) => e === failure);
    assert.deepEqual(conditions, ["fresh-early"]);
  });

test("matrix invokes the real scene helper once per condition, each with its own open and physical close", async () => {
  const scenes = [],
    receipts = [];
  const run = matrix(async (options) => {
    const scene = fixture();
    scenes.push(scene);
    await scene.run({ condition: options.condition, report: options.report });
  });
  await run({ report: (receipt) => receipts.push(receipt) });
  assert.equal(scenes.length, 3);
  assert.deepEqual(
    scenes.map((scene) => scene.navigations.length),
    [1, 13, 1],
  );
  for (const scene of scenes) {
    assert.equal(scene.calls.filter((call) => call === "open").length, 1);
    assert.equal(
      scene.calls.filter((call) => call === "Page.captureScreenshot").length,
      1,
    );
    assert.equal(
      scene.calls.filter((call) => call === "physical-close").length,
      1,
    );
  }
  assert.deepEqual(
    receipts.map((receipt) => receipt.condition),
    ["fresh-early", "navigation-history", "fresh-late"],
  );
  assert.ok(
    receipts.every(
      (receipt) =>
        receipt.status === "passed" && receipt.cleanupStatus === "completed",
    ),
  );
});
