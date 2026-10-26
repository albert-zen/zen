import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { browserInspectScript } from "../src/main/capabilities/browser-provider.ts";
import {
  browserInputSnapshotScript,
  includesBrowserInputSnapshot,
  resolveBrowserInputEvidence,
} from "../src/main/capabilities/browser-targeted-input.ts";
import { UserBrowserCdpDiagnosticObserver } from "../src/main/capabilities/user-browser-cdp-diagnostics.ts";
import {
  UserBrowserCdpOutcomeUnknownError,
  UserBrowserDocumentChangedBeforeDispatchError,
  UserBrowserDocumentChangedAfterDispatchError,
  UserBrowserMutationOutcomeUnknownError,
} from "../src/main/capabilities/user-browser-provider.ts";

// Run the real client, attachment setup, document fences, evaluateDocument and
// transport together. Only private-state accessors are appended for assertions;
// the socket and clock are deterministic and no real browser/network is used.
const source = readFileSync(
  new URL("../src/main/capabilities/user-browser-provider.ts", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "provider.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);
const clientClass = ast.statements.find(
  (node) =>
    ts.isClassDeclaration(node) &&
    node.name?.text === "JsonRpcUserBrowserCdpClient",
);
assert.ok(clientClass);
const helpers = new Set([
  "asRecord",
  "describeError",
  "sameAttachmentOwner",
  "promiseCapability",
  "throwIfAborted",
  "abortReason",
]);
const extracted = ast.statements
  .filter(
    (node) =>
      (ts.isFunctionDeclaration(node) && helpers.has(node.name?.text)) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.every((declaration) =>
          declaration.name.getText(ast).startsWith("USER_BROWSER_"),
        )),
  )
  .map((node) => node.getText(ast).replace(/^export /, ""))
  .join("\n");
const classSource = clientClass.getText(ast).replace(
  /}\s*$/,
  `
  testEpoch() { return this.#attachmentClosures.get("target-1"); }
  testFence() { return this.#executionDocument("target-1", owner); }
  testCommand(fence, method, params, signal) { return this.#sendDocumentCommand(fence, method, params, signal); }
  testClaim(fence) { ${source.includes("#claimFirstInspectDeadline(") ? "return this.#claimFirstInspectDeadline(fence, browserInspectScript);" : 'throw new Error("No startup allowance in reference implementation");'} }
  testSend(...args) { return this.#send(...args); }
}`,
);
const code = ts.transpileModule(
  `${extracted}\n${classSource}; JsonRpcUserBrowserCdpClient`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  },
).outputText;
const owner = { logicalSessionId: "work", logicalSessionIncarnation: 1 };
const value = { title: "Owned synthetic fixture", targets: [] };

function fixture(options = {}) {
  let now = 100;
  let nextTimer = 0;
  let routeNumber = 0;
  let mainHook;
  const timers = new Map();
  const timerHistory = [];
  const sends = [];
  const observer = new UserBrowserCdpDiagnosticObserver((event) =>
    mainHook?.(event),
  );
  observer.now = () => now;
  const Client = runInNewContext(code, {
    JSON,
    Error,
    Map,
    Set,
    Promise,
    AbortSignal,
    owner,
    WebSocket: { OPEN: 1 },
    performance: { now: () => now },
    browserInspectScript,
    browserInputSnapshotScript,
    includesBrowserInputSnapshot,
    resolveBrowserInputEvidence,
    UserBrowserCdpOutcomeUnknownError,
    UserBrowserDocumentChangedBeforeDispatchError,
    UserBrowserDocumentChangedAfterDispatchError,
    UserBrowserMutationOutcomeUnknownError,
    setTimeout: (callback, ms) => {
      const id = ++nextTimer;
      const timer = { id, callback, ms, at: now, due: now + ms };
      timers.set(id, timer);
      timerHistory.push(timer);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  const socket = new EventEmitter();
  socket.readyState = 1;
  const reply = (request, result = {}) =>
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          id: request.id,
          sessionId: request.sessionId,
          result,
        }),
      ),
    );
  socket.send = (raw) => {
    const request = JSON.parse(raw);
    request.timer = timerHistory.at(-1);
    sends.push(request);
    queueMicrotask(() => {
      if (
        options.hold?.(request) ||
        request.params.expression === browserInspectScript
      )
        return;
      now += options.delay?.(request) ?? 0;
      let result = {};
      if (request.method === "Target.attachToTarget")
        result = { sessionId: `route-${++routeNumber}` };
      if (request.method === "Page.getFrameTree")
        result = {
          frameTree: {
            frame: {
              id: "frame-1",
              loaderId: "loader-1",
              url: "https://owned.test/fixture",
            },
          },
        };
      if (request.method === "Page.createIsolatedWorld")
        result = { executionContextId: 42 };
      if (request.method === "Runtime.evaluate") result = { result: { value } };
      reply(request, result);
    });
  };
  socket.close = () => {
    socket.readyState = 3;
    socket.emit("close");
  };
  const client = new Client(
    socket,
    new URL("http://127.0.0.1"),
    undefined,
    undefined,
    observer,
  );
  return {
    client,
    sends,
    timers,
    timerHistory,
    observer,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    hook: (callback) => {
      mainHook = callback;
    },
    reply,
    protocolError: (request) =>
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            id: request.id,
            sessionId: request.sessionId,
            error: { code: -32000, message: "Execution context was destroyed" },
          }),
        ),
      ),
    main: () =>
      sends.filter(
        (request) => request.params.expression === browserInspectScript,
      ),
    inspect: (signal, expectedIdentity, requestedOwner = owner) =>
      client.evaluateDocument(
        "target-1",
        browserInspectScript,
        requestedOwner,
        expectedIdentity,
        signal,
      ),
    complete: (request) => reply(request, { result: { value } }),
    event: (method, params = {}) =>
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            method,
            params,
            sessionId: client.testEpoch()?.cdpSessionId,
          }),
        ),
      ),
    fire: (timer) => {
      assert.ok(timers.delete(timer.id));
      now = Math.max(now, timer.due);
      timer.callback();
    },
  };
}
async function until(predicate) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail("expected actual client path to advance");
}
async function start(f, signal, expectedIdentity) {
  const count = f.main().length;
  const result = f.inspect(signal, expectedIdentity);
  void result.catch(() => undefined);
  await until(() => f.main().length > count);
  return { result, request: f.main().at(-1) };
}

test("first exact inspection starts its own window after setup, including frame and world cost", async () => {
  const f = fixture({
    delay: (r) =>
      r.method === "Runtime.enable"
        ? 3_000
        : r.method === "Page.createIsolatedWorld"
          ? 3_000
          : r.method === "Page.getFrameTree"
            ? 500
            : 0,
  });
  const { result, request } = await start(f);
  assert.equal(request.timer.ms, 5_500);
  assert.equal(request.timer.due, 13_100);
  assert.equal(f.client.testEpoch().setupDeadline, 10_100);
  f.advance(1_728);
  f.complete(request);
  assert.deepEqual((await result).value, value);
  assert.equal(f.main().length, 1);
  for (const r of f.sends.filter((r) => r.method === "Page.getFrameTree"))
    assert.equal(r.timer.ms, 2_000, r.method);
  const world = f.sends.find((r) => r.method === "Page.createIsolatedWorld");
  assert.equal(world.timer.ms, 9_000);
  assert.equal(world.timer.due, 13_100);
  assert.equal(
    f.sends.find((r) => r.params.expression === "void 0").timer.ms,
    2_000,
  );
});

for (const elapsed of [8_000, 8_500, 10_001, 50_000]) {
  test(`first inspection after ${elapsed}ms claims once independently of attachment age`, async () => {
    const f = fixture();
    await f.client.testFence();
    f.advance(elapsed);
    const { result, request } = await start(f);
    assert.equal(request.timer.ms, 10_000);
    assert.equal(request.timer.due, 10_100 + elapsed);
    assert.equal(f.client.testEpoch().setupDeadline, 10_100);
    assert.equal(f.client.testEpoch().firstInspectClaimed, true);
    f.complete(request);
    await result;
    const next = await start(f);
    assert.equal(next.request.timer.ms, 2_000);
    assert.equal(
      f.client.testEpoch().firstInspectGrantedDeadline,
      request.timer.due,
    );
    f.complete(next.request);
    await next.result;
  });
}

test("cached attachment and concurrent first inspections can claim only once", async () => {
  const f = fixture();
  const first = f.inspect();
  const second = f.inspect();
  await until(() => f.main().length === 2);
  assert.deepEqual(
    f.main().map((r) => r.timer.ms),
    [10_000, 2_000],
  );
  assert.equal(
    f.sends.filter((r) => r.method === "Target.attachToTarget").length,
    1,
  );
  assert.deepEqual(
    f.sends
      .filter((r) => r.method === "Page.createIsolatedWorld")
      .map((r) => r.timer.ms),
    [10_000, 2_000],
  );
  f.main().forEach(f.complete);
  await Promise.all([first, second]);
  const third = await start(f);
  assert.equal(third.request.timer.ms, 2_000);
  f.complete(third.request);
  await third.result;
});

test("slow successful setup cannot starve the first observation's original response", async () => {
  const f = fixture({
    delay: (r) =>
      r.method === "Runtime.enable"
        ? 7_800
        : r.method === "Page.createIsolatedWorld"
          ? 600
          : r.method === "Page.getFrameTree"
            ? 200
            : 0,
  });
  const { result, request } = await start(f);
  const epoch = f.client.testEpoch();
  assert.equal(epoch.setupDeadline, 10_100);
  assert.equal(epoch.firstInspectGrantedDeadline, 17_900);
  assert.equal(request.timer.ms, 8_800);
  assert.equal(epoch.setupDeadline - f.now(), 1_000);
  f.advance(2_300);
  assert.ok(f.now() > epoch.setupDeadline);
  f.complete(request);
  assert.deepEqual((await result).value, value);
  assert.equal(f.main().length, 1);
  for (const method of [
    "Target.attachToTarget",
    "Page.enable",
    "Runtime.enable",
    "Page.navigate",
  ])
    assert.equal(
      f.sends.filter((r) => r.method === method).length,
      method === "Page.navigate" ? 0 : 1,
    );
});

test("a returned observation reservation after slow setup keeps its own original deadline", async () => {
  const f = fixture({
    delay: (r) => (r.method === "Runtime.enable" ? 6_000 : 0),
  });
  f.hook((event) => {
    if (event.kind !== "timer-armed" || event.method !== "Page.getFrameTree")
      return;
    f.hook(undefined);
    f.event("Page.frameStartedLoading", { frameId: "frame-1" });
  });
  await assert.rejects(
    f.inspect(),
    UserBrowserDocumentChangedBeforeDispatchError,
  );
  const epoch = f.client.testEpoch();
  assert.equal(epoch.setupDeadline, 10_100);
  assert.equal(epoch.firstInspectGrantedDeadline, 16_100);
  assert.equal(epoch.firstInspectClaimed, false);
  assert.equal(
    f.sends.filter((r) => r.method === "Page.createIsolatedWorld").length,
    0,
  );
  f.advance(8_500);
  const { result, request } = await start(f);
  assert.equal(request.timer.due, 16_100);
  assert.equal(request.timer.ms, 1_500);
  assert.equal(epoch.firstInspectGrantedDeadline, 16_100);
  f.complete(request);
  await result;
});

test("first deadline timeout keeps original unknown after its same-route late response", async () => {
  const f = fixture({
    delay: (r) => (r.method === "Runtime.enable" ? 5_500 : 0),
  });
  const { result, request } = await start(f);
  assert.equal(request.timer.ms, 10_000);
  assert.equal(request.timer.due, 15_600);
  f.fire(request.timer);
  let original;
  await assert.rejects(result, (error) => {
    original = error;
    return error instanceof UserBrowserMutationOutcomeUnknownError;
  });
  f.advance(100);
  f.complete(request);
  await original.settlement;
  await assert.rejects(result, (error) => error === original);
  assert.equal(f.main().length, 1);
  assert.equal(
    f.sends.filter((r) => r.params.expression === "void 0").length,
    0,
  );
});

test("reply observed after absolute deadline cannot beat an overdue timer into success", async () => {
  const f = fixture();
  const { result, request } = await start(f);
  f.advance(10_001); // Deliberately do not deliver the timer callback yet.
  f.complete(request);
  await assert.rejects(result, /original reserved deadline elapsed/);
  assert.equal(f.main().length, 1);
  assert.equal(
    f.sends.filter((r) => r.params.expression === "void 0").length,
    0,
  );
  assert.equal(
    f.timers.size,
    0,
    "original reply already settled; no new late timer",
  );
});

for (const failure of ["abort", "document", "deadline"]) {
  test(`${failure} during before-dispatch boundary burns claim without sending or reclaiming`, async () => {
    const f = fixture();
    const controller = new AbortController();
    f.hook((event) => {
      if (event.kind !== "timer-armed" || event.method !== "Runtime.evaluate")
        return;
      f.hook(undefined);
      if (failure === "abort")
        controller.abort(new Error("abort before dispatch"));
      if (failure === "document") f.event("Runtime.executionContextsCleared");
      if (failure === "deadline") f.advance(10_001);
    });
    await assert.rejects(
      f.inspect(controller.signal),
      /abort before dispatch|document changed|deadline elapsed before dispatch/,
    );
    assert.equal(f.main().length, 0);
    assert.equal(f.client.testEpoch().firstInspectClaimed, true);
    const next = await start(f);
    assert.equal(next.request.timer.ms, 2_000);
    f.complete(next.request);
    await next.result;
  });
}

test("expected document mismatch consumes claim before failing without a main evaluation", async () => {
  const f = fixture();
  await assert.rejects(
    f.inspect(undefined, "stale identity"),
    UserBrowserDocumentChangedBeforeDispatchError,
  );
  assert.equal(f.main().length, 0);
  assert.equal(f.client.testEpoch().firstInspectClaimed, true);
  const next = await start(f);
  assert.equal(next.request.timer.ms, 2_000);
  f.complete(next.request);
  await next.result;
});

test("navigation cannot reset a used allowance, and a different owner cannot borrow it", async () => {
  const f = fixture();
  const first = await start(f);
  f.complete(first.request);
  await first.result;
  await f.client.navigate("target-1", "https://owned.test/next", owner);
  f.event("Runtime.executionContextsCleared");
  const second = await start(f);
  assert.equal(second.request.timer.ms, 2_000);
  f.complete(second.request);
  await second.result;
  await assert.rejects(
    f.inspect(undefined, undefined, { ...owner, logicalSessionIncarnation: 2 }),
    /ownership changed/,
  );
  assert.equal(f.main().length, 2);
});

test("retired fence cannot lend its unclaimed window to a new attachment epoch", async () => {
  const f = fixture();
  const oldFence = await f.client.testFence();
  await f.client.detachTarget("target-1", owner);
  f.advance(1_000);
  const freshFence = await f.client.testFence();
  assert.notEqual(freshFence.attachmentEpoch, oldFence.attachmentEpoch);
  assert.throws(
    () => f.client.testClaim(oldFence),
    UserBrowserDocumentChangedBeforeDispatchError,
  );
  assert.equal(oldFence.attachmentEpoch.firstInspectClaimed, true);
  assert.equal(freshFence.attachmentEpoch.firstInspectClaimed, false);
  assert.equal(freshFence.attachmentEpoch.setupDeadline, 11_100);
  const current = await start(f);
  assert.equal(current.request.timer.due, 11_100);
  f.complete(current.request);
  await current.result;
});

test("arbitrary evaluate, input snapshot, input dispatch and cleanup keep existing budgets", async () => {
  const f = fixture();
  for (const expression of [
    "document.title",
    browserInputSnapshotScript,
    `${browserInspectScript} `,
  ])
    await f.client.evaluateDocument("target-1", expression, owner);
  const fence = await f.client.testFence();
  for (const method of ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent"])
    await f.client.testCommand(fence, method, {});
  await f.client.navigate("target-1", "https://owned.test/next", owner);
  assert.equal(f.client.testEpoch().firstInspectClaimed, false);
  assert.ok(
    f.sends
      .filter((r) =>
        [
          "Runtime.evaluate",
          "Input.dispatchMouseEvent",
          "Input.dispatchKeyEvent",
          "Page.navigate",
          "Page.createIsolatedWorld",
          "Page.getFrameTree",
        ].includes(r.method),
      )
      .every((r) => r.timer.ms === 2_000),
  );
  await f.client.detachTarget("target-1", owner);
  assert.equal(f.sends.at(-1).method, "Target.detachFromTarget");
  assert.equal(f.sends.at(-1).timer.ms, 2_000);
});

test("claim does not reset the absolute timer when synchronous dispatch work consumes observation time", async () => {
  const f = fixture();
  f.hook((event) => {
    if (event.kind === "timer-armed" && event.method === "Runtime.evaluate") {
      f.hook(undefined);
      f.advance(1_500);
    }
  });
  const { result, request } = await start(f);
  assert.equal(request.timer.due, 10_100);
  assert.equal(f.now(), 1_600);
  f.complete(request);
  await result;
});

test("abort after dispatch retains the original unknown and no renewed inspection claim", async () => {
  const f = fixture();
  const controller = new AbortController();
  const { result, request } = await start(f, controller.signal);
  controller.abort(new Error("cancel original inspection"));
  let original;
  await assert.rejects(result, (error) => {
    original = error;
    return error instanceof UserBrowserMutationOutcomeUnknownError;
  });
  f.complete(request);
  await original.settlement;
  await assert.rejects(result, (error) => error === original);
  const next = await start(f);
  assert.equal(next.request.timer.ms, 2_000);
  f.complete(next.request);
  await next.result;
  assert.equal(
    f.main().length,
    2,
    "only the explicitly requested later inspection",
  );
});

test("ordinary action evaluation still times out once at 2s without claiming observation time", async () => {
  const expression = "document.querySelector('button').click()";
  const f = fixture({
    hold: (request) => request.params.expression === expression,
  });
  const operation = f.client.evaluateDocument("target-1", expression, owner);
  void operation.catch(() => undefined);
  await until(() =>
    f.sends.some((request) => request.params.expression === expression),
  );
  const request = f.sends.find(
    (request) => request.params.expression === expression,
  );
  assert.equal(request.timer.ms, 2_000);
  f.fire(request.timer);
  await assert.rejects(operation, UserBrowserMutationOutcomeUnknownError);
  assert.equal(f.client.testEpoch().firstInspectClaimed, false);
  f.complete(request);
  assert.equal(
    f.sends.filter((request) => request.params.expression === expression)
      .length,
    1,
  );
});

test("first inspection document change after response still fails its original publication fence", async () => {
  const f = fixture();
  const { result, request } = await start(f);
  f.complete(request);
  f.event("Runtime.executionContextsCleared");
  await assert.rejects(result, /outcome is unknown|document identity changed/);
  assert.equal(f.client.testEpoch().firstInspectClaimed, true);
  assert.equal(f.main().length, 1);
});

for (const elapsed of [10_000, 10_001]) {
  test(`protocol error observed at/after absolute deadline (${elapsed}ms) remains unknown`, async () => {
    const f = fixture();
    const { result, request } = await start(f);
    f.advance(elapsed); // The original timer deliberately has not fired.
    f.protocolError(request);
    let original;
    await assert.rejects(result, (error) => {
      original = error;
      return (
        error instanceof UserBrowserMutationOutcomeUnknownError &&
        /original reserved deadline elapsed/.test(error.message) &&
        /Execution context was destroyed/.test(error.message)
      );
    });
    await original.settlement;
    assert.equal(
      f.timers.size,
      0,
      "the original error reply already settled; do not wait for another",
    );
    assert.equal(f.main().length, 1);
    assert.equal(
      f.sends.filter((r) => r.params.expression === "void 0").length,
      0,
    );
    f.complete(request);
    await assert.rejects(result, (error) => error === original);
  });
}

test("protocol error observed before deadline retains known rejection even if continuation is later", async () => {
  const f = fixture();
  const { result, request } = await start(f);
  f.advance(9_999);
  f.protocolError(request);
  f.advance(2); // Continuation is late, but the error reply itself was on time.
  await assert.rejects(
    result,
    (error) =>
      error instanceof Error &&
      !(error instanceof UserBrowserMutationOutcomeUnknownError) &&
      /Execution context was destroyed/.test(error.message),
  );
  assert.equal(f.timers.size, 0);
  assert.equal(f.main().length, 1);
});

test("deadline expiry before any dispatch remains a known unsent failure", async () => {
  const f = fixture();
  f.hook((event) => {
    if (event.kind === "timer-armed" && event.method === "Runtime.evaluate") {
      f.hook(undefined);
      f.advance(10_001);
    }
  });
  await assert.rejects(
    f.inspect(),
    (error) =>
      error instanceof Error &&
      !(error instanceof UserBrowserMutationOutcomeUnknownError) &&
      /deadline elapsed before dispatch/.test(error.message),
  );
  assert.equal(f.main().length, 0);
  assert.equal(f.client.testEpoch().firstInspectClaimed, true);
  assert.equal(f.timers.size, 0);
});

test("ordinary evaluation protocol error keeps its existing classification without an absolute allowance", async () => {
  const expression = "document.title";
  const f = fixture({
    hold: (request) => request.params.expression === expression,
  });
  const result = f.client.evaluateDocument("target-1", expression, owner);
  void result.catch(() => undefined);
  await until(() => f.sends.some((r) => r.params.expression === expression));
  const request = f.sends.find((r) => r.params.expression === expression);
  assert.equal(request.timer.ms, 2_000);
  f.advance(2_001); // Existing ordinary-request ordering is intentionally unchanged.
  f.protocolError(request);
  await assert.rejects(
    result,
    (error) =>
      error instanceof Error &&
      !(error instanceof UserBrowserMutationOutcomeUnknownError) &&
      /Execution context was destroyed/.test(error.message),
  );
  assert.equal(f.timers.size, 0);
});

async function startWorld(f, signal) {
  const result = f.inspect(signal);
  void result.catch(() => undefined);
  await until(() =>
    f.sends.some((r) => r.method === "Page.createIsolatedWorld"),
  );
  return {
    result,
    request: f.sends.find((r) => r.method === "Page.createIsolatedWorld"),
  };
}

for (const elapsed of [10_000, 10_001]) {
  for (const response of ["success", "error"]) {
    test(`world ${response} reply at ${elapsed}ms cannot beat overdue original timer`, async () => {
      const f = fixture({
        hold: (r) => r.method === "Page.createIsolatedWorld",
      });
      const { result, request } = await startWorld(f);
      assert.equal(request.timer.due, 10_100);
      f.advance(elapsed);
      if (response === "success") f.reply(request, { executionContextId: 42 });
      else f.protocolError(request);
      await assert.rejects(
        result,
        (error) =>
          error instanceof UserBrowserCdpOutcomeUnknownError &&
          /original reserved deadline elapsed/.test(error.message),
      );
      assert.equal(f.main().length, 0);
      assert.equal(f.client.testEpoch().firstInspectClaimed, true);
      assert.equal(f.timers.size, 0);
    });
  }
}

test("on-time world protocol rejection stays known despite late continuation", async () => {
  const f = fixture({ hold: (r) => r.method === "Page.createIsolatedWorld" });
  const { result, request } = await startWorld(f);
  f.advance(9_999);
  f.protocolError(request);
  f.advance(2);
  await assert.rejects(
    result,
    (error) =>
      !(error instanceof UserBrowserCdpOutcomeUnknownError) &&
      /Execution context was destroyed/.test(error.message),
  );
  assert.equal(f.main().length, 0);
});

test("world can consume its independent window below 2s without a fresh fallback", async () => {
  const f = fixture({
    delay: (r) =>
      r.method === "Page.enable"
        ? 2_200
        : r.method === "Runtime.enable"
          ? 1_500
          : r.method === "Page.createIsolatedWorld"
            ? 8_700
            : 0,
  });
  const { result, request } = await start(f);
  const world = f.sends.find((r) => r.method === "Page.createIsolatedWorld");
  assert.equal(world.timer.ms, 10_000);
  assert.equal(world.timer.due, 13_800);
  assert.equal(request.timer.ms, 1_300);
  assert.equal(request.timer.due, 13_800);
  f.complete(request);
  await result;
});

for (const phase of ["initial-frame", "before-world", "after-world"]) {
  test(`${phase} preflight exhausting claim prevents subsequent dispatch`, async () => {
    let frames = 0;
    const delayedFrame = {
      "initial-frame": 1,
      "before-world": 2,
      "after-world": 3,
    }[phase];
    const f = fixture({
      delay: (r) =>
        r.method === "Page.getFrameTree" && ++frames === delayedFrame
          ? 10_000
          : 0,
    });
    await assert.rejects(
      f.inspect(),
      (error) =>
        !(error instanceof UserBrowserCdpOutcomeUnknownError) &&
        /deadline elapsed before dispatch/.test(error.message),
    );
    assert.equal(f.main().length, 0);
    assert.equal(
      f.sends.filter((r) => r.method === "Page.createIsolatedWorld").length,
      phase === "after-world" ? 1 : 0,
    );
    assert.equal(f.client.testEpoch().firstInspectClaimed, true);
    const next = await start(f);
    assert.equal(next.request.timer.ms, 2_000);
    f.complete(next.request);
    await next.result;
    assert.equal(
      f.sends.filter((r) => r.method === "Page.createIsolatedWorld").at(-1)
        .timer.ms,
      2_000,
    );
  });
}

for (const failure of ["timeout", "abort", "document"]) {
  test(`world ${failure} consumes the one claim and never replays`, async () => {
    let holdWorld = true;
    const f = fixture({
      hold: (r) => holdWorld && r.method === "Page.createIsolatedWorld",
    });
    const controller = new AbortController();
    const { result, request } = await startWorld(f, controller.signal);
    if (failure === "timeout") f.fire(request.timer);
    if (failure === "abort") controller.abort(new Error("cancel world"));
    if (failure === "document") {
      f.event("Runtime.executionContextsCleared");
      f.reply(request, { executionContextId: 42 });
    }
    await assert.rejects(
      result,
      failure === "document"
        ? UserBrowserDocumentChangedBeforeDispatchError
        : UserBrowserCdpOutcomeUnknownError,
    );
    assert.equal(f.client.testEpoch().firstInspectClaimed, true);
    assert.equal(f.main().length, 0);
    assert.equal(
      f.sends.filter((r) => r.method === "Page.createIsolatedWorld").length,
      1,
    );
    if (failure !== "document") f.reply(request, { executionContextId: 42 });
    holdWorld = false;
    const next = await start(f);
    assert.equal(next.request.timer.ms, 2_000);
    assert.equal(
      f.sends.filter((r) => r.method === "Page.createIsolatedWorld").at(-1)
        .timer.ms,
      2_000,
    );
    f.complete(next.request);
    await next.result;
  });
}

for (const failure of ["abort", "document", "deadline"]) {
  test(`world predispatch ${failure} rejects without sending`, async () => {
    const f = fixture();
    const controller = new AbortController();
    f.hook((event) => {
      if (
        event.kind !== "timer-armed" ||
        event.method !== "Page.createIsolatedWorld"
      )
        return;
      f.hook(undefined);
      if (failure === "abort")
        controller.abort(new Error("abort before world"));
      if (failure === "document") f.event("Runtime.executionContextsCleared");
      if (failure === "deadline") f.advance(10_001);
    });
    await assert.rejects(
      f.inspect(controller.signal),
      (error) =>
        !(error instanceof UserBrowserCdpOutcomeUnknownError) &&
        /abort before world|document changed|deadline elapsed before dispatch/.test(
          error.message,
        ),
    );
    assert.equal(
      f.sends.filter((r) => r.method === "Page.createIsolatedWorld").length,
      0,
    );
    assert.equal(f.main().length, 0);
    assert.equal(
      f.client.testEpoch().firstInspectClaimed,
      failure !== "document",
    );
    const next = await start(f);
    assert.equal(
      next.request.timer.ms,
      failure === "document" ? 10_000 : 2_000,
    );
    f.complete(next.request);
    await next.result;
  });
}

for (const invalidation of ["context", "detach"]) {
  test(`world ${invalidation} invalidation cannot publish through its claimed fence`, async () => {
    const f = fixture({ hold: (r) => r.method === "Page.createIsolatedWorld" });
    const { result, request } = await startWorld(f);
    const oldEpoch = f.client.testEpoch();
    if (invalidation === "context")
      f.event("Runtime.executionContextDestroyed", { executionContextId: 42 });
    else await f.client.detachTarget("target-1", owner);
    f.reply(request, { executionContextId: 42 });
    await assert.rejects(result, UserBrowserDocumentChangedBeforeDispatchError);
    assert.equal(oldEpoch.firstInspectClaimed, true);
    assert.equal(f.main().length, 0);
  });
}

async function rejectInitialLifecycle(f) {
  f.hook((event) => {
    if (event.kind !== "timer-armed" || event.method !== "Page.getFrameTree")
      return;
    f.hook(undefined);
    f.event("Page.frameStartedLoading", { frameId: "frame-1" });
  });
  await assert.rejects(
    f.inspect(),
    (error) =>
      error instanceof UserBrowserDocumentChangedBeforeDispatchError &&
      /pending lifecycle Page.frameStartedLoading/.test(error.message),
  );
  assert.equal(f.main().length, 0);
  assert.equal(
    f.sends.filter((r) => r.method === "Page.createIsolatedWorld").length,
    0,
  );
  assert.equal(f.client.testEpoch().firstInspectClaimed, false);
  assert.equal(f.client.testEpoch().firstInspectGrantedDeadline, 10_100);
  assert.equal(f.client.testEpoch().firstInspectReservation, undefined);
}

test("known initial lifecycle rejection returns only its original undispatched reservation", async () => {
  const f = fixture({
    delay: (r) => (r.method === "Page.getFrameTree" ? 100 : 0),
  });
  await rejectInitialLifecycle(f);
  f.advance(50);
  const next = await start(f);
  const world = f.sends.find((r) => r.method === "Page.createIsolatedWorld");
  assert.equal(world.timer.due, 10_100);
  assert.equal(world.timer.ms, 9_650);
  assert.equal(next.request.timer.due, 10_100);
  assert.equal(next.request.timer.ms, 9_550);
  f.complete(next.request);
  await next.result;
  assert.equal(f.client.testEpoch().firstInspectClaimed, true);
  assert.equal(f.client.testEpoch().firstInspectReservation, undefined);
});

for (const elapsed of [8_500, 10_000, 10_001]) {
  test(`reclaim after ${elapsed}ms preserves granted deadline without ordinary fallback`, async () => {
    const f = fixture();
    await rejectInitialLifecycle(f);
    f.advance(elapsed);
    if (elapsed < 10_000) {
      const next = await start(f);
      assert.equal(next.request.timer.ms, 1_500);
      assert.equal(next.request.timer.due, 10_100);
      const world = f.sends.find(
        (r) => r.method === "Page.createIsolatedWorld",
      );
      assert.equal(world.timer.ms, 1_500);
      assert.equal(world.timer.due, 10_100);
      f.complete(next.request);
      await next.result;
    } else {
      const frameCount = f.sends.filter(
        (r) => r.method === "Page.getFrameTree",
      ).length;
      await assert.rejects(f.inspect(), /deadline elapsed before dispatch/);
      assert.equal(f.main().length, 0);
      assert.equal(
        f.sends.filter((r) => r.method === "Page.createIsolatedWorld").length,
        0,
      );
      assert.equal(
        f.sends.filter((r) => r.method === "Page.getFrameTree").length,
        frameCount,
      );
    }
    assert.equal(f.client.testEpoch().firstInspectClaimed, true);
    assert.equal(f.client.testEpoch().firstInspectReservation, undefined);
  });
}

test("repeated explicit lifecycle stabilization never renews the granted deadline", async () => {
  const f = fixture();
  await rejectInitialLifecycle(f);
  f.advance(4_000);
  await rejectInitialLifecycle(f);
  f.advance(4_500);
  const next = await start(f);
  assert.equal(next.request.timer.ms, 1_500);
  assert.equal(next.request.timer.due, 10_100);
  f.complete(next.request);
  await next.result;
});

test("a concurrent nonholder cannot return a newer exclusive reservation", async () => {
  let holdFrames = true;
  const f = fixture({
    hold: (r) => holdFrames && r.method === "Page.getFrameTree",
  });
  const frames = () => f.sends.filter((r) => r.method === "Page.getFrameTree");
  const frameResult = {
    frameTree: {
      frame: {
        id: "frame-1",
        loaderId: "loader-1",
        url: "https://owned.test/fixture",
      },
    },
  };
  const first = f.inspect();
  const nonholder = f.inspect();
  void first.catch(() => undefined);
  void nonholder.catch(() => undefined);
  await until(() => frames().length === 2);
  f.event("Page.frameStartedLoading", { frameId: "frame-1" });
  f.reply(frames()[0], frameResult);
  await assert.rejects(first, UserBrowserDocumentChangedBeforeDispatchError);
  assert.equal(f.client.testEpoch().firstInspectClaimed, false);
  const successor = f.inspect();
  void successor.catch(() => undefined);
  await until(() => frames().length === 3);
  const successorToken = f.client.testEpoch().firstInspectReservation;
  assert.ok(successorToken);
  f.reply(frames()[1], frameResult);
  await assert.rejects(
    nonholder,
    UserBrowserDocumentChangedBeforeDispatchError,
  );
  assert.equal(f.client.testEpoch().firstInspectClaimed, true);
  assert.equal(f.client.testEpoch().firstInspectReservation, successorToken);
  holdFrames = false;
  f.reply(frames()[2], frameResult);
  const concurrent = f.inspect();
  await until(() => f.main().length === 2);
  assert.deepEqual(
    f.sends
      .filter((r) => r.method === "Page.createIsolatedWorld")
      .map((r) => r.timer.ms)
      .sort((a, b) => a - b),
    [2_000, 10_000],
  );
  assert.deepEqual(
    f
      .main()
      .map((r) => r.timer.ms)
      .sort((a, b) => a - b),
    [2_000, 10_000],
  );
  f.main().forEach(f.complete);
  await Promise.all([successor, concurrent]);
});

for (const failure of ["abort", "owner", "detach", "timeout", "protocol"]) {
  test(`pre-world ${failure} cannot return its reserved grant`, async () => {
    const f = fixture({ hold: (r) => r.method === "Page.getFrameTree" });
    const controller = new AbortController();
    const result = f.inspect(controller.signal);
    void result.catch(() => undefined);
    await until(() => f.sends.some((r) => r.method === "Page.getFrameTree"));
    const frame = f.sends.find((r) => r.method === "Page.getFrameTree");
    const epoch = f.client.testEpoch();
    if (failure === "abort")
      controller.abort(new Error("abort reserved preflight"));
    if (failure === "owner") epoch.logicalSessionIncarnation++;
    if (failure === "detach") await f.client.detachTarget("target-1", owner);
    if (failure === "timeout") f.fire(frame.timer);
    if (failure === "protocol") f.protocolError(frame);
    else if (failure === "owner" || failure === "detach") f.reply(frame, {});
    await assert.rejects(result);
    assert.equal(epoch.firstInspectClaimed, true);
    assert.equal(epoch.firstInspectReservation, undefined);
    assert.equal(
      f.sends.filter((r) => r.method === "Page.createIsolatedWorld").length,
      0,
    );
    assert.equal(f.main().length, 0);
  });
}

test("refund compares the captured owner fence, not a subsequently mutated caller object", async () => {
  const f = fixture({ hold: (r) => r.method === "Page.getFrameTree" });
  const callerOwner = { ...owner };
  const result = f.inspect(undefined, undefined, callerOwner);
  void result.catch(() => undefined);
  await until(() => f.sends.some((r) => r.method === "Page.getFrameTree"));
  const epoch = f.client.testEpoch();
  epoch.logicalSessionIncarnation++;
  callerOwner.logicalSessionIncarnation++;
  const frame = f.sends.find((r) => r.method === "Page.getFrameTree");
  f.reply(frame, {});
  await assert.rejects(result, UserBrowserDocumentChangedBeforeDispatchError);
  assert.equal(epoch.firstInspectClaimed, true);
  assert.equal(epoch.firstInspectReservation, undefined);
  assert.equal(
    f.sends.filter((r) => r.method === "Page.createIsolatedWorld").length,
    0,
  );
});

// Both subscriptions are independent CDP commands, but together form one
// attachment-owned readiness barrier. These tests execute the actual client and
// its transport, not a duplicated setup algorithm or a faster fake provider.
const attachmentDomains = ["Page.enable", "Runtime.enable"];
async function pendingDomains(options = {}) {
  const f = fixture({
    ...options,
    hold: (request) => attachmentDomains.includes(request.method),
  });
  const result = f.inspect(options.signal);
  void result.catch(() => undefined);
  await until(() =>
    attachmentDomains.every((method) =>
      f.sends.some((request) => request.method === method),
    ),
  );
  const requests = attachmentDomains.map((method) =>
    f.sends.find((request) => request.method === method),
  );
  return { f, result, requests, epoch: f.client.testEpoch() };
}
function assertNoDocumentDispatch(f) {
  assert.equal(
    f.sends.filter(
      (r) =>
        [
          "Page.navigate",
          "Page.getFrameTree",
          "Page.createIsolatedWorld",
          "Runtime.evaluate",
        ].includes(r.method) || r.method.startsWith("Input."),
    ).length,
    0,
  );
}
function assertSingleSetup(f, detached = 1) {
  for (const method of ["Target.attachToTarget", ...attachmentDomains])
    assert.equal(f.sends.filter((r) => r.method === method).length, 1, method);
  assert.equal(
    f.sends.filter((r) => r.method === "Target.detachFromTarget").length,
    detached,
  );
}
for (const first of [0, 1]) {
  test(`parallel attachment waits for both subscriptions, reply order ${first}`, async () => {
    const { f, result, requests, epoch } = await pendingDomains();
    // Both commands were sent before either reply, under the original deadline.
    assert.equal(requests[0].timer.at, requests[1].timer.at);
    for (const request of requests) {
      assert.equal(request.sessionId, epoch.cdpSessionId);
      assert.equal(request.timer.due, epoch.setupDeadline);
      assert.equal(request.timer.ms, 10_000);
    }
    assertNoDocumentDispatch(f);
    f.advance(3_000);
    f.reply(requests[first]);
    await until(
      () => epoch[first === 0 ? "enable" : "runtimeEnable"] === "known-success",
    );
    assertNoDocumentDispatch(f);
    f.advance(500);
    f.reply(requests[1 - first]);
    await until(() => f.main().length === 1);
    assert.equal(f.main()[0].timer.ms, 10_000);
    assert.equal(f.main()[0].timer.due, epoch.setupDeadline + 3_500);
    f.complete(f.main()[0]);
    await result;
    assertSingleSetup(f, 0);
    await f.client.detachTarget("target-1", owner);
    assertSingleSetup(f);
  });
}
for (const failed of [0, 1]) {
  test(`known ${attachmentDomains[failed]} failure joins sibling before one compensation`, async () => {
    const { f, result, requests } = await pendingDomains();
    f.protocolError(requests[failed]);
    await until(() => !f.timers.has(requests[failed].timer.id));
    assertSingleSetup(f, 0);
    assertNoDocumentDispatch(f);
    f.reply(requests[1 - failed]);
    await assert.rejects(result, /Execution context was destroyed/);
    assertNoDocumentDispatch(f);
    assertSingleSetup(f);
    assert.equal(f.client.closureProblem(["target-1"], owner), undefined);
  });

  test(`unknown ${attachmentDomains[failed]} remains unknown after sibling success and late reply`, async () => {
    const { f, result, requests, epoch } = await pendingDomains();
    f.reply(requests[1 - failed]);
    f.fire(requests[failed].timer);
    await assert.rejects(
      result,
      (error) => error instanceof UserBrowserCdpOutcomeUnknownError,
    );
    assertNoDocumentDispatch(f);
    assertSingleSetup(f);
    const field = failed === 0 ? "enable" : "runtimeEnable";
    assert.equal(epoch[field], "outcome-unknown");
    assert.match(epoch.unknownEvidence[field], /timed out after dispatch/);
    f.reply(requests[failed]);
    await Promise.resolve();
    assert.equal(epoch[field], "outcome-unknown");
    await assert.rejects(f.inspect(), /outcome is unknown/);
    assertSingleSetup(f);
    assertNoDocumentDispatch(f);
  });

  test(`known sibling failure cannot hide unknown ${attachmentDomains[failed]}`, async () => {
    const { f, result, requests } = await pendingDomains();
    f.protocolError(requests[1 - failed]);
    f.fire(requests[failed].timer);
    await assert.rejects(
      result,
      (error) =>
        error instanceof UserBrowserCdpOutcomeUnknownError &&
        error.message.includes(attachmentDomains[failed]),
    );
    assertSingleSetup(f);
    assertNoDocumentDispatch(f);
  });
}

test("both known setup failures compensate once and preserve a known rejection", async () => {
  const { f, result, requests } = await pendingDomains();
  requests.forEach(f.protocolError);
  await assert.rejects(
    result,
    (error) =>
      !(error instanceof UserBrowserCdpOutcomeUnknownError) &&
      /Execution context was destroyed/.test(error.message),
  );
  assertSingleSetup(f);
  assertNoDocumentDispatch(f);
  assert.equal(f.client.closureProblem(["target-1"], owner), undefined);
});

test("both setup timeouts retain both unknown receipts and compensate once", async () => {
  const { f, result, requests, epoch } = await pendingDomains();
  requests.forEach((request) => f.fire(request.timer));
  await assert.rejects(
    result,
    (error) => error instanceof UserBrowserCdpOutcomeUnknownError,
  );
  assert.equal(epoch.enable, "outcome-unknown");
  assert.equal(epoch.runtimeEnable, "outcome-unknown");
  assert.deepEqual(Object.keys(epoch.unknownEvidence), [
    "enable",
    "runtimeEnable",
  ]);
  assertSingleSetup(f);
  assertNoDocumentDispatch(f);
  requests.forEach((request) => f.reply(request));
  await assert.rejects(f.inspect(), /outcome is unknown/);
  assertSingleSetup(f);
});

test("abort after both setup sends joins both unknown outcomes without retry", async () => {
  const controller = new AbortController();
  const { f, result, requests, epoch } = await pendingDomains({
    signal: controller.signal,
  });
  controller.abort(new Error("synthetic setup abort"));
  await assert.rejects(
    result,
    (error) => error instanceof UserBrowserCdpOutcomeUnknownError,
  );
  assert.equal(epoch.enable, "outcome-unknown");
  assert.equal(epoch.runtimeEnable, "outcome-unknown");
  assertSingleSetup(f);
  assertNoDocumentDispatch(f);
  requests.forEach((request) => f.reply(request));
  await assert.rejects(f.inspect(), /outcome is unknown/);
  assertSingleSetup(f);
});

test("connection close in parallel setup observes both failures and never publishes ready", async () => {
  const { f, result, requests, epoch } = await pendingDomains();
  await f.client.close();
  await assert.rejects(
    result,
    (error) => error instanceof UserBrowserCdpOutcomeUnknownError,
  );
  assert.equal(epoch.enable, "outcome-unknown");
  assert.equal(epoch.runtimeEnable, "outcome-unknown");
  assert.match(epoch.taint, /setup closure failed/);
  // Closed transport cannot send compensation; retain the honest closure failure.
  assertSingleSetup(f, 0);
  assertNoDocumentDispatch(f);
  requests.forEach((request) => f.reply(request));
  await assert.rejects(f.inspect(), /outcome is unknown/);
  assertSingleSetup(f, 0);
});

for (const event of [
  [
    "Page.frameStartedNavigating",
    { frameId: "frame-1", url: "https://owned.test/next" },
  ],
  ["Runtime.executionContextDestroyed", { executionContextId: 42 }],
]) {
  test(`${event[0]} during parallel subscriptions reaches the document fence`, async () => {
    const { f, result, requests } = await pendingDomains();
    f.event(...event);
    requests.forEach((request) => f.reply(request));
    await assert.rejects(
      result,
      (error) => error instanceof UserBrowserDocumentChangedBeforeDispatchError,
    );
    assert.equal(f.main().length, 0);
    assertSingleSetup(f, 0);
    await f.client.detachTarget("target-1", owner);
    assertSingleSetup(f);
  });
}

for (const reply of ["success", "error"]) {
  test(`parallel setup ${reply} reply cannot beat an overdue original timer`, async () => {
    const { f, result, requests, epoch } = await pendingDomains();
    f.reply(requests[0]);
    await until(() => epoch.enable === "known-success");
    f.advance(10_000);
    if (reply === "success") f.reply(requests[1]);
    else f.protocolError(requests[1]);
    await assert.rejects(
      result,
      (error) => error instanceof UserBrowserCdpOutcomeUnknownError,
    );
    assert.equal(epoch.runtimeEnable, "outcome-unknown");
    assertNoDocumentDispatch(f);
    assertSingleSetup(f);
  });
}

test("parallel setup shares the pending barrier with a concurrent caller", async () => {
  const { f, result, requests } = await pendingDomains();
  const concurrent = f.inspect();
  void concurrent.catch(() => undefined);
  f.reply(requests[1]);
  await Promise.resolve();
  assertNoDocumentDispatch(f);
  assertSingleSetup(f, 0);
  f.reply(requests[0]);
  await until(() => f.main().length === 2);
  f.main().forEach(f.complete);
  await Promise.all([result, concurrent]);
  assertSingleSetup(f, 0);
  await f.client.detachTarget("target-1", owner);
  assertSingleSetup(f);
});

test("detach while parallel setup is pending waits on the same barrier and never repeats cleanup", async () => {
  const { f, result, requests } = await pendingDomains();
  const detached = f.client.detachTarget("target-1", owner);
  void detached.catch(() => undefined);
  f.protocolError(requests[0]);
  await Promise.resolve();
  assertSingleSetup(f, 0);
  assertNoDocumentDispatch(f);
  f.reply(requests[1]);
  await assert.rejects(result, /Execution context was destroyed/);
  await detached;
  assertSingleSetup(f);
  assertNoDocumentDispatch(f);
});

test("abort during first setup send prevents the sibling send and retains the dispatched unknown", async () => {
  const controller = new AbortController();
  const f = fixture({
    hold: (request) => attachmentDomains.includes(request.method),
  });
  f.hook((event) => {
    if (event.kind === "dispatch-accepted" && event.method === "Page.enable")
      controller.abort(new Error("abort at first domain dispatch"));
  });
  await assert.rejects(
    f.inspect(controller.signal),
    (error) => error instanceof UserBrowserCdpOutcomeUnknownError,
  );
  const epoch = f.client.testEpoch();
  assert.equal(epoch.enable, "outcome-unknown");
  assert.equal(epoch.runtimeEnable, "known-failure");
  assert.equal(f.sends.filter((r) => r.method === "Page.enable").length, 1);
  assert.equal(f.sends.filter((r) => r.method === "Runtime.enable").length, 0);
  assert.equal(
    f.sends.filter((r) => r.method === "Target.detachFromTarget").length,
    1,
  );
  assertNoDocumentDispatch(f);
});

test("synchronous setup dispatch work cannot renew the original absolute deadline", async () => {
  const f = fixture({
    hold: (request) => attachmentDomains.includes(request.method),
  });
  f.hook((event) => {
    if (event.kind === "dispatch-attempt" && event.method === "Page.enable")
      f.advance(10_000);
  });
  await assert.rejects(f.inspect(), /deadline elapsed before dispatch/);
  assert.equal(
    f.sends.filter((r) => attachmentDomains.includes(r.method)).length,
    0,
  );
  assert.equal(
    f.sends.filter((r) => r.method === "Target.detachFromTarget").length,
    1,
  );
  assertNoDocumentDispatch(f);
});

test("joint setup readiness crossing its deadline cannot grant a fresh inspection window", async () => {
  const { f, result, requests, epoch } = await pendingDomains();
  let settled = false;
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  requests.forEach((request) => f.reply(request));
  await until(
    () =>
      epoch.enable === "known-success" &&
      epoch.runtimeEnable === "known-success",
  );
  assertNoDocumentDispatch(f);
  // Both domain continuations passed on time; only their aggregate readiness
  // continuation is delayed. An expired *ready* attachment would otherwise
  // incorrectly grant a separate first-inspection window.
  f.advance(10_000);
  await until(() => settled || f.main().length > 0);
  assertNoDocumentDispatch(f);
  await assert.rejects(
    result,
    (error) =>
      !(error instanceof UserBrowserCdpOutcomeUnknownError) &&
      /deadline elapsed before readiness/.test(error.message),
  );
  assert.equal(epoch.enable, "known-success");
  assert.equal(epoch.runtimeEnable, "known-success");
  assert.equal(f.client.closureProblem(["target-1"], owner), undefined);
  assertSingleSetup(f);
});
