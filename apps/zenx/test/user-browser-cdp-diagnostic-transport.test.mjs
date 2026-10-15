import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { UserBrowserCdpDiagnosticObserver } from "../src/main/capabilities/user-browser-cdp-diagnostics.ts";
import { UserBrowserCdpOutcomeUnknownError } from "../src/main/capabilities/user-browser-provider.ts";

// Exercise the actual private transport, without exporting a product test hook
// or starting a socket/browser. Only test accessors are appended before transpile.
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
const classSource = clientClass.getText(ast).replace(
  /}\s*$/,
  `
  testSend(...args) { return this.#send(...args); }
  testReapEpoch(sessionId) { this.#reapEpoch({ cdpSessionId: sessionId, targetId: "owned-target" }, false); }
  testState() { return { pending: this.#pending.size, late: this.#lateResponses.size, closed: this.#closed }; }
}`,
);
const code = ts.transpileModule(`${classSource}; JsonRpcUserBrowserCdpClient`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(mode = "enabled") {
  let now = 100;
  let nextTimer = 0;
  const timers = new Map();
  const timerHistory = [];
  const events = [];
  const observer =
    mode === "disabled"
      ? undefined
      : new UserBrowserCdpDiagnosticObserver((event) => {
          events.push(event);
          if (mode === "throwing")
            throw new Error("observer must stay isolated");
        });
  // Keep provider clock deterministic while using its real controller methods.
  if (observer) observer.now = () => now;
  const Client = runInNewContext(code, {
    JSON,
    WebSocket: { OPEN: 1 },
    Error,
    Map,
    Set,
    Promise,
    AbortSignal,
    UserBrowserCdpOutcomeUnknownError,
    USER_BROWSER_MAX_PENDING_CDP_REQUESTS: 128,
    USER_BROWSER_MAX_TARGET_EVIDENCE: 128,
    USER_BROWSER_MAX_OPERATION_EVIDENCE: 64,
    USER_BROWSER_CDP_OUTCOME_TIMEOUT_MS: 2_000,
    USER_BROWSER_LATE_RESPONSE_RETENTION_MS: 2_000,
    asRecord: (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined,
    abortReason: (signal) =>
      signal.reason instanceof Error ? signal.reason : new Error("aborted"),
    describeError: (error) => String(error),
    setTimeout: (callback, ms) => {
      const id = ++nextTimer;
      timers.set(id, { callback, ms, at: now });
      timerHistory.push({ id, ms, at: now });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  const socket = new EventEmitter();
  socket.readyState = 1;
  const sends = [];
  socket.send = (raw) => {
    sends.push(JSON.parse(raw));
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
    socket,
    sends,
    events,
    observer,
    timers,
    timerHistory,
    advance: (ms) => {
      now += ms;
    },
    fire: () => {
      const entry = timers.entries().next().value;
      assert.ok(entry, "original timer must exist");
      const [id, timer] = entry;
      timers.delete(id);
      timer.callback();
    },
    reply: (message) =>
      socket.emit("message", Buffer.from(JSON.stringify(message))),
    send: (...args) =>
      client.testSend(
        "Page.createIsolatedWorld",
        { secret: "never record params" },
        ...args,
      ),
    state: () => ({ ...client.testState() }),
  };
}

for (const mode of ["disabled", "enabled", "throwing"]) {
  test(`${mode}: normal response preserves result, one send and original timer`, async () => {
    const f = fixture(mode);
    const result = { executionContextId: 42 };
    const pending = f.send("route-a");
    f.reply({ id: 1, sessionId: "route-a", result });
    assert.deepEqual(await pending, result);
    assert.equal(f.sends.length, 1);
    assert.equal(f.timerHistory.length, 1);
    assert.equal(f.timerHistory[0].ms, 2_000);
    assert.deepEqual(f.state(), { pending: 0, late: 0, closed: false });
    assert.equal(f.timers.size, 0);
    if (mode === "throwing")
      assert.equal(f.observer.counters.observerErrors, f.events.length);
  });

  for (const failure of ["beforeDispatch", "send", "onDispatched"]) {
    test(`${mode}: ${failure} throw preserves the same error object`, async () => {
      const f = fixture(mode);
      const error = new Error(`original ${failure}`);
      const fail = () => {
        throw error;
      };
      if (failure === "send") f.socket.send = fail;
      const pending = f.send(
        "route-a",
        undefined,
        undefined,
        undefined,
        failure === "onDispatched" ? fail : undefined,
        failure === "beforeDispatch" ? fail : undefined,
      );
      await assert.rejects(pending, (actual) => actual === error);
      assert.equal(f.sends.length, failure === "onDispatched" ? 1 : 0);
      assert.equal(f.timers.size, 0);
      assert.deepEqual(f.state(), { pending: 0, late: 0, closed: false });
      if (mode === "throwing")
        assert.equal(f.observer.counters.observerErrors, f.events.length);
    });
  }

  for (const afterDispatch of [false, true]) {
    test(`${mode}: abort ${afterDispatch ? "after" : "before"} dispatch keeps original semantics`, async () => {
      const f = fixture(mode);
      const controller = new AbortController();
      const reason = new Error("original abort");
      if (!afterDispatch) controller.abort(reason);
      const pending = f.send("route-a", controller.signal);
      if (afterDispatch) controller.abort(reason);
      await assert.rejects(pending, (actual) =>
        afterDispatch
          ? actual instanceof UserBrowserCdpOutcomeUnknownError &&
            actual.message.includes(reason.message)
          : actual === reason,
      );
      assert.equal(f.sends.length, afterDispatch ? 1 : 0);
      assert.equal(f.timers.size, 0);
      assert.equal(f.state().pending, 0);
    });
  }

  test(`${mode}: timeout and ignored late reply keep unknown, with no replay/late timer`, async () => {
    const f = fixture(mode);
    const pending = f.send(
      "route-a",
      undefined,
      2_000,
      undefined,
      undefined,
      () => f.advance(350),
    );
    f.advance(1_900);
    f.fire();
    let original;
    await assert.rejects(pending, (error) => {
      original = error;
      return error instanceof UserBrowserCdpOutcomeUnknownError;
    });
    f.reply({
      id: 1,
      sessionId: "route-a",
      result: { executionContextId: 99 },
    });
    await assert.rejects(pending, (error) => error === original);
    assert.equal(f.sends.length, 1);
    assert.equal(f.timerHistory.length, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.state().late, 0);
    if (f.observer) {
      const armed = f.events.find((event) => event.kind === "timer-armed");
      const accepted = f.events.find(
        (event) => event.kind === "dispatch-accepted",
      );
      const timeout = f.events.find((event) => event.kind === "timeout-fired");
      const reply = f.events.find((event) => event.kind === "receive");
      assert.equal(armed.atMs, 100);
      assert.equal(armed.deadlineMs, 2_100);
      assert.equal(accepted.atMs, 450);
      assert.equal(timeout.atMs, 2_350);
      assert.equal(reply.disposition, "ignored-no-pending");
      assert.equal(reply.routeMatches, true);
      assert.equal(reply.correlation, "tombstone");
      assert.equal(
        f.observer.stop().connections[0].failures[0].kind,
        "timeout-fired",
      );
    }
  });

  test(`${mode}: close/failAll reject dispatched pending as unknown without replay`, async () => {
    const f = fixture(mode);
    const pending = f.send("route-a");
    await f.client.close();
    await assert.rejects(pending, UserBrowserCdpOutcomeUnknownError);
    assert.equal(f.sends.length, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.state().closed, true);
  });
}

test("route mismatch fails once; later correct reply is observed but never restores request", async () => {
  const f = fixture();
  const pending = f.send("route-a");
  f.reply({ id: 1, sessionId: "route-b", result: {} });
  await assert.rejects(pending, UserBrowserCdpOutcomeUnknownError);
  f.reply({ id: 1, sessionId: "route-a", result: {} });
  const replies = f.events.filter((event) => event.kind === "receive");
  assert.equal(replies[0].disposition, "session-mismatch");
  assert.equal(replies[0].routeMatches, false);
  assert.equal(replies[1].disposition, "ignored-no-pending");
  assert.equal(replies[1].routeMatches, true);
  assert.equal(f.sends.length, 1);
});

test("retained-late matching is original provider state, before compensation dispatch", async () => {
  const f = fixture();
  let compensation;
  const pending = f.send("route-a", undefined, 2_000, async () => {
    compensation = f.client.testSend("Target.detachFromTarget", {}, "route-a");
  });
  f.fire();
  await assert.rejects(pending, UserBrowserCdpOutcomeUnknownError);
  assert.equal(f.state().late, 1);
  assert.equal(f.timerHistory.length, 2, "only original retention timer added");
  f.reply({ id: 1, sessionId: "route-wrong", result: {} });
  assert.equal(f.state().late, 1);
  f.reply({ id: 1, sessionId: "route-a", result: {} });
  assert.equal(f.state().late, 0);
  const received = f.events.findIndex(
    (event) => event.disposition === "retained-late",
  );
  const dispatched = f.events.findIndex(
    (event) => event.kind === "dispatch-attempt" && event.id === 2,
  );
  assert.ok(received >= 0 && dispatched > received);
  f.reply({ id: 2, sessionId: "route-a", result: {} });
  await compensation;
  assert.equal(f.sends.length, 2, "only the original compensation path sends");
  assert.equal(f.timers.size, 0);
});

test("protocol errors and malformed JSON preserve original rejection paths", async () => {
  const f = fixture();
  const pending = f.send();
  f.reply({ id: 1, error: { message: "original protocol error" } });
  await assert.rejects(pending, /original protocol error/);
  assert.equal(f.events.at(-1).disposition, "protocol-error");
  const next = f.send();
  f.socket.emit("message", Buffer.from("bad json"));
  await assert.rejects(next, UserBrowserCdpOutcomeUnknownError);
  assert.ok(f.events.some((event) => event.disposition === "invalid-json"));
});

for (const method of ["Page.enable", "Runtime.enable"]) {
  for (const lateMode of ["absent", "ignored", "retained"]) {
    test(`${method} attachment teardown keeps original unknown and diagnostic failure with ${lateMode} late reply`, async () => {
      const f = fixture("throwing");
      let compensated = 0;
      const pending = f.client.testSend(
        method,
        {},
        "route-a",
        undefined,
        2_000,
        lateMode === "retained"
          ? async () => {
              compensated += 1;
            }
          : undefined,
      );
      f.client.testReapEpoch("route-a");
      let original;
      await assert.rejects(pending, (error) => {
        original = error;
        return (
          error instanceof UserBrowserCdpOutcomeUnknownError &&
          error.message.includes("attachment ended during setup")
        );
      });
      assert.equal(f.state().pending, 0);
      assert.equal(f.state().late, lateMode === "retained" ? 1 : 0);
      assert.equal(f.timerHistory.length, lateMode === "retained" ? 2 : 1);
      const ended = f.events.find((event) => event.kind === "attachment-ended");
      assert.ok(ended);
      if (lateMode !== "absent") {
        f.reply({ id: 1, sessionId: "route-a", result: {} });
        const reply = f.events.find((event) => event.kind === "receive");
        assert.equal(reply.correlation, "tombstone");
        assert.equal(reply.routeMatches, true);
        assert.equal(
          reply.disposition,
          lateMode === "retained" ? "retained-late" : "ignored-no-pending",
        );
      }
      assert.equal(compensated, lateMode === "retained" ? 1 : 0);
      await f.client.close();
      await assert.rejects(pending, (error) => error === original);
      const report = f.observer.stop();
      assert.deepEqual(report.connections[0].unfinished, []);
      assert.deepEqual(report.connections[0].failures, [ended]);
      assert.equal(f.sends.length, 1);
      assert.equal(f.timers.size, 0);
      assert.equal(report.observerErrors, f.events.length);
    });
  }
}
