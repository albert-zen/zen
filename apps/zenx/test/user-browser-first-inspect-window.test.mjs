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

test("first exact inspection borrows only original remaining time, including prior setup/frame/world cost", async () => {
  const f = fixture({
    delay: (r) =>
      r.method === "Runtime.enable"
        ? 3_000
        : r.method === "Page.createIsolatedWorld"
          ? 1_000
          : r.method === "Page.getFrameTree"
            ? 500
            : 0,
  });
  const { result, request } = await start(f);
  assert.equal(request.timer.ms, 4_500);
  assert.equal(request.timer.due, 10_100);
  assert.equal(f.client.testEpoch().setupDeadline, 10_100);
  f.advance(3_728);
  f.complete(request);
  assert.deepEqual((await result).value, value);
  assert.equal(f.main().length, 1);
  for (const r of f.sends.filter((r) =>
    ["Page.getFrameTree", "Page.createIsolatedWorld"].includes(r.method),
  ))
    assert.equal(r.timer.ms, 2_000, r.method);
  assert.equal(
    f.sends.find((r) => r.params.expression === "void 0").timer.ms,
    2_000,
  );
});

for (const elapsed of [8_000, 8_500, 10_001, 50_000]) {
  test(`first inspection after ${elapsed}ms retains ordinary 2s without renewal`, async () => {
    const f = fixture();
    await f.client.testFence();
    f.advance(elapsed);
    const { result, request } = await start(f);
    assert.equal(request.timer.ms, 2_000);
    assert.equal(f.client.testEpoch().setupDeadline, 10_100);
    assert.equal(f.client.testEpoch().firstInspectClaimed, true);
    f.complete(request);
    await result;
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
  f.main().forEach(f.complete);
  await Promise.all([first, second]);
  const third = await start(f);
  assert.equal(third.request.timer.ms, 2_000);
  f.complete(third.request);
  await third.result;
});

test("first deadline timeout keeps original unknown after its same-route late response", async () => {
  const f = fixture({
    delay: (r) => (r.method === "Runtime.enable" ? 5_500 : 0),
  });
  const { result, request } = await start(f);
  assert.equal(request.timer.ms, 4_500);
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
  await assert.rejects(
    result,
    /original attachment inspection deadline elapsed/,
  );
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
        ].includes(r.method),
      )
      .every((r) => r.timer.ms === 2_000),
  );
  await f.client.detachTarget("target-1", owner);
  assert.equal(f.sends.at(-1).method, "Target.detachFromTarget");
  assert.equal(f.sends.at(-1).timer.ms, 2_000);
});

test("claim does not reset the absolute timer when synchronous dispatch work consumes startup time", async () => {
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

test("ordinary action evaluation still times out once at 2s while startup time remains", async () => {
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
        /original attachment inspection deadline elapsed/.test(error.message) &&
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
