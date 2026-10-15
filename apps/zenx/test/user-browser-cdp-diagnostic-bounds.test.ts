import assert from "node:assert/strict";
import test from "node:test";
import { finishCdpDiagnostic } from "../src/main/browser-parallel-input-smoke.js";
import {
  UserBrowserCdpDiagnosticObserver,
  type CdpDiagnosticEvent,
} from "../src/main/capabilities/user-browser-cdp-diagnostics.js";

// These tests only call passive observation APIs and injected output sinks.
// Importing the fixture does not execute its guarded main or start a browser.
function fixture() {
  const events: CdpDiagnosticEvent[] = [];
  const observer = new UserBrowserCdpDiagnosticObserver((event) => {
    events.push(event);
  });
  const connection = observer.connect();
  assert.ok(connection);
  return { observer, connection, events };
}

function last(events: readonly CdpDiagnosticEvent[]): CdpDiagnosticEvent {
  const event = events.at(-1);
  assert.ok(event);
  return event;
}

test("CDP diagnostics isolate equal request ids and aliases by connection", () => {
  const { observer, connection: first, events } = fixture();
  const second = observer.connect();
  assert.ok(second);
  first.armed(7, "Runtime.evaluate", "private-first-session", 20, 1);
  second.armed(7, "Page.captureScreenshot", "private-second-session", 40, 2);
  first.event("timeout-fired", 7, true);
  second.receive(7, "private-second-session", "pending-match", 3);
  const secondReply = last(events);
  first.receive(7, "private-first-session", "ignored-no-pending", 4);
  const firstReply = last(events);
  first.armed(8, "Page.enable", "private-first-session", 10, 5);
  second.receive(8, "private-first-session", "ignored-no-pending", 6);
  const unrelatedReply = last(events);
  const report = observer.stop();

  assert.equal(secondReply.connection, 2);
  assert.equal(secondReply.method, "Page.captureScreenshot");
  assert.equal(secondReply.route, "session-1");
  assert.equal(secondReply.routeMatches, true);
  assert.equal(secondReply.correlation, "request");
  assert.equal(firstReply.connection, 1);
  assert.equal(firstReply.method, "Runtime.evaluate");
  assert.equal(firstReply.route, "session-1");
  assert.equal(firstReply.routeMatches, true);
  assert.equal(firstReply.correlation, "tombstone");
  assert.equal(unrelatedReply.correlation, "uncorrelated");
  assert.equal(unrelatedReply.routeMatches, undefined);
  assert.equal(unrelatedReply.method, undefined);
  assert.deepEqual(
    report.connections.map((item) => ({
      connection: item.connection,
      unfinished: item.unfinished.map((event) => event.id),
      failures: item.failures.map((event) => [event.id, event.kind]),
    })),
    [
      { connection: 1, unfinished: [8], failures: [[7, "timeout-fired"]] },
      { connection: 2, unfinished: [], failures: [] },
    ],
  );
});

test("CDP route matching remains exact when distinct raw routes share overflow", () => {
  const { observer, connection, events } = fixture();
  for (let id = 1; id <= 64; id += 1)
    connection.armed(id, "Page.enable", `private-session-${id}`, 20, id);

  connection.armed(65, "Runtime.evaluate", "private-overflow-a", 20, 65);
  connection.armed(66, "Runtime.evaluate", "private-overflow-b", 20, 66);
  connection.receive(65, "private-overflow-b", "session-mismatch", 67);
  const mismatch = last(events);
  connection.receive(66, "private-overflow-b", "pending-match", 68);
  const match = last(events);
  connection.receive(65, "private-overflow-a", "retained-late", 69);
  const late = last(events);
  const report = observer.stop();

  for (const event of [mismatch, match, late]) {
    assert.equal(event.route, "overflow");
    assert.equal(event.receivedRoute, "overflow");
  }
  assert.equal(mismatch.routeMatches, false);
  assert.equal(mismatch.correlation, "request");
  assert.equal(match.routeMatches, true);
  assert.equal(late.routeMatches, true);
  assert.equal(late.correlation, "tombstone");
  assert.equal(report.connections[0]?.aliasesOverflow, 5);
  assert.equal(report.connections[0]?.requestsEvicted, 0);
  assert.equal(report.connections[0]?.failures[0]?.routeMatches, false);
});

test("CDP root request and missing response routes stay distinguishable", () => {
  const { observer, connection, events } = fixture();
  connection.armed(1, "Target.getTargets", undefined, 10, 1);
  connection.receive(1, undefined, "pending-match", 2);
  const root = last(events);
  connection.armed(2, "Page.enable", "private-session", 10, 3);
  connection.receive(2, undefined, "session-mismatch", 4);
  const missing = last(events);
  connection.armed(3, "Target.getTargets", undefined, 10, 5);
  connection.receive(3, "", "session-mismatch", 6);
  const empty = last(events);
  connection.receive(99, undefined, "ignored-no-pending", 7);
  const unknown = last(events);
  observer.stop();

  assert.equal(root.route, "root");
  assert.equal(root.receivedRoute, "missing");
  assert.equal(root.routeMatches, true);
  assert.equal(missing.route, "session-1");
  assert.equal(missing.receivedRoute, "missing");
  assert.equal(missing.routeMatches, false);
  assert.equal(empty.route, "root");
  assert.equal(empty.receivedRoute, "session-2");
  assert.equal(empty.routeMatches, false);
  assert.equal(unknown.receivedRoute, "missing");
  assert.equal(unknown.route, undefined);
  assert.equal(unknown.routeMatches, undefined);
  assert.equal(unknown.correlation, "uncorrelated");
});

test("CDP routes at the retention limit match exactly and oversized routes stay uncorrelated", () => {
  const { observer, connection, events } = fixture();
  const boundary = "s".repeat(256);
  const oversized = `${boundary}a`;
  const samePrefix = `${boundary}b`;
  connection.armed(1, "Page.enable", boundary, 10, 1);
  connection.receive(1, boundary, "pending-match", 2);
  const exact = last(events);
  connection.armed(2, "Page.enable", oversized, 10, 3);
  const oversizedRequest = last(events);
  connection.receive(2, samePrefix, "session-mismatch", 4);
  const different = last(events);
  connection.receive(2, oversized, "retained-late", 5);
  const late = last(events);
  connection.armed(3, "Page.enable", oversized, 10, 6);
  connection.receive(3, oversized, "pending-match", 7);
  const same = last(events);
  const report = observer.stop();

  assert.equal(exact.route, "session-1");
  assert.equal(exact.receivedRoute, "session-1");
  assert.equal(exact.routeMatches, true);
  assert.equal(exact.correlation, "request");
  assert.equal(oversizedRequest.route, "overflow");
  for (const event of [different, late, same]) {
    assert.equal(event.receivedRoute, "overflow");
    assert.equal(event.routeMatches, undefined);
    assert.equal(event.correlation, "uncorrelated");
  }
  assert.equal(JSON.stringify(report).includes(boundary), false);
});

test("CDP observer bounds connection allocation and counts refused connections", () => {
  const observer = new UserBrowserCdpDiagnosticObserver();
  for (let ordinal = 1; ordinal <= 4; ordinal += 1)
    assert.equal(observer.connect()?.ordinal, ordinal);
  assert.equal(observer.connect(), undefined);
  assert.equal(observer.connect(), undefined);
  const report = observer.stop();
  assert.equal(report.limits.connections, 4);
  assert.equal(report.connections.length, 4);
  assert.equal(report.connectionOverflow, 2);
  assert.equal(observer.connect(), undefined);
  assert.equal(observer.counters.connectionOverflow, 2);
});

test("CDP diagnostics bound live requests and explicitly lose evicted correlation", () => {
  const { observer, connection, events } = fixture();
  for (let id = 1; id <= 130; id += 1)
    connection.armed(id, "Runtime.evaluate", "private-session", 10, id);
  connection.receive(1, "private-session", "pending-match", 131);
  const evicted = last(events);
  const report = observer.stop();
  const state = report.connections[0];
  assert.ok(state);

  assert.equal(report.limits.requests, 128);
  assert.equal(state.requestsEvicted, 2);
  assert.equal(state.unfinished.length, 128);
  assert.deepEqual(
    state.unfinished.map((event) => event.id),
    Array.from({ length: 128 }, (_, index) => index + 3),
  );
  assert.equal(evicted.correlation, "uncorrelated");
  assert.equal(evicted.method, undefined);
  assert.equal(evicted.routeMatches, undefined);
  assert.equal(state.tombstonesEvicted, 0);
  assert.equal(state.failuresEvicted, 0);
});

test("CDP diagnostics bound tombstones and failure summaries independently", () => {
  const { observer, connection, events } = fixture();
  for (let id = 1; id <= 131; id += 1) {
    connection.armed(id, "Input.dispatchKeyEvent", "private-session", 10, id);
    connection.event("timeout-fired", id, true);
  }
  connection.receive(3, "private-session", "ignored-no-pending", 132);
  const evicted = last(events);
  connection.receive(4, "private-session", "ignored-no-pending", 133);
  const oldestRetained = last(events);
  connection.receive(131, "private-session", "retained-late", 134);
  const latest = last(events);
  const report = observer.stop();
  const state = report.connections[0];
  assert.ok(state);

  assert.equal(state.requestsEvicted, 0);
  assert.equal(state.tombstonesEvicted, 3);
  assert.equal(state.failuresEvicted, 115);
  assert.deepEqual(state.unfinished, []);
  assert.equal(state.failures.length, 16);
  assert.deepEqual(
    state.failures.map((event) => event.id),
    Array.from({ length: 16 }, (_, index) => index + 116),
  );
  assert.ok(state.failures.every((event) => event.kind === "timeout-fired"));
  assert.equal(evicted.correlation, "uncorrelated");
  assert.equal(oldestRetained.correlation, "tombstone");
  assert.equal(oldestRetained.routeMatches, true);
  assert.equal(latest.correlation, "tombstone");
  assert.equal(latest.routeMatches, true);
  // The late success is evidence only; it cannot rewrite the saved failure.
  assert.equal(state.failures.at(-1)?.kind, "timeout-fired");
});

test("CDP fail-all retires bounded requests with terminal failure summaries", () => {
  const { observer, connection } = fixture();
  for (let id = 1; id <= 20; id += 1) {
    connection.armed(id, "Runtime.evaluate", undefined, 10, id);
    connection.event("dispatch-accepted", id, true);
  }
  connection.event("fail-all");
  const report = observer.stop();
  const state = report.connections[0];
  assert.ok(state);
  assert.deepEqual(state.unfinished, []);
  assert.equal(state.failuresEvicted, 4);
  const failed = report.events.find((event) => event.kind === "fail-all");
  assert.ok(failed);
  for (const summary of state.failures) {
    assert.equal(summary.sequence, failed.sequence);
    assert.equal(summary.atMs, failed.atMs);
  }
  assert.deepEqual(
    state.failures.map((event) => [event.id, event.kind, event.dispatched]),
    Array.from({ length: 16 }, (_, index) => [index + 5, "fail-all", true]),
  );
});

test("CDP event history keeps fixed head and tail with exact drop counts", () => {
  const { observer, connection, events } = fixture();
  for (let index = 0; index < 300; index += 1)
    connection.malformed("non-object", index);
  observer.mark("cleanup-start");
  observer.mark("cleanup-complete");
  const report = observer.stop();

  assert.equal(events.length, 303);
  assert.equal(report.limits.head, 128);
  assert.equal(report.limits.tail, 128);
  assert.equal(report.events.length, 256);
  assert.equal(report.eventsDropped, 47);
  assert.deepEqual(
    report.events.map((event) => event.sequence),
    [
      ...Array.from({ length: 128 }, (_, index) => index + 1),
      ...Array.from({ length: 128 }, (_, index) => index + 176),
    ],
  );
  assert.deepEqual(
    report.events.slice(-3).map((event) => event.kind),
    ["cleanup-start", "cleanup-complete", "cutoff"],
  );
});

test("CDP listener receives only frozen scalar projections without raw payloads", () => {
  const events: CdpDiagnosticEvent[] = [];
  const observer = new UserBrowserCdpDiagnosticObserver((event) => {
    assert.ok(Object.isFrozen(event));
    assert.ok(
      Object.values(event).every(
        (value) =>
          value === undefined ||
          ["string", "number", "boolean"].includes(typeof value),
      ),
    );
    assert.equal(Reflect.set(event, "method", "listener-mutation"), false);
    assert.equal(Reflect.set(event, "result", { secret: "injected" }), false);
    events.push(event);
  });
  const connection = observer.connect();
  assert.ok(connection);
  const secrets = {
    sessionId: "private-session-secret",
    targetId: "private-target-secret",
    url: "https://private.invalid/secret-url",
    params: { expression: "private-expression-secret" },
    result: { value: "private-result-secret" },
  };
  connection.armed(1, "Runtime.evaluate", secrets.sessionId, 12, 4);
  connection.event("dispatch-accepted", 1, true);
  connection.receive(1, secrets, "session-mismatch", 7);
  connection.armed(2, JSON.stringify(secrets), secrets.targetId, 12, 8);
  connection.receive(2, secrets.targetId, "pending-match", 9);
  const report = observer.stop();
  const encoded = JSON.stringify({ events, report });
  for (const value of [
    secrets.sessionId,
    secrets.targetId,
    secrets.url,
    secrets.params.expression,
    secrets.result.value,
    "listener-mutation",
    "injected",
  ])
    assert.equal(encoded.includes(value), false, value);
  for (const event of events)
    for (const key of ["sessionId", "targetId", "url", "params", "result"])
      assert.equal(Object.hasOwn(event, key), false, key);
  assert.equal(events[0]?.deadlineMs, 16);
  assert.equal(events[2]?.receivedRoute, "invalid");
  assert.equal(events[2]?.routeMatches, false);
  assert.equal(events[3]?.method, "other");
  assert.equal(report.observerErrors, 0);
});

test("CDP listener and capture throws are counted without interrupting observation", () => {
  let calls = 0;
  const observer = new UserBrowserCdpDiagnosticObserver(() => {
    calls += 1;
    throw new Error("optional listener failure");
  });
  const connection = observer.connect();
  assert.ok(connection);
  assert.doesNotThrow(() => {
    connection.armed(1, "Page.enable", "private-session", 10, 1);
    connection.event("timeout-fired", 1, true);
    connection.receive(1, "private-session", "retained-late", 2);
    observer.capture(() => {
      throw new Error("optional capture failure");
    });
    observer.mark("cleanup-complete");
  });
  const report = observer.stop();
  assert.equal(calls, 5);
  assert.equal(report.observerErrors, 6);
  assert.equal(report.events.length, 5);
  assert.equal(report.connections[0]?.failures[0]?.kind, "timeout-fired");
  assert.equal(report.events[2]?.correlation, "tombstone");
});

test("CDP stop cuts off every observation entry point and preserves its snapshot", () => {
  const { observer, connection, events } = fixture();
  connection.armed(1, "Page.enable", "private-session", 10, 1);
  connection.armed(2, "Page.enable", "private-other-session", 10, 2);
  connection.event("timeout-fired", 2, true);
  const first = observer.stop();
  const encoded = JSON.stringify(first);
  const recorded = events.length;
  let captured = false;

  connection.armed(3, "Page.enable", "post-cutoff-session", 10, 3);
  connection.event("socket-close");
  connection.receive(1, "private-session", "pending-match", 4);
  connection.malformed("invalid-json", 5);
  observer.mark("cleanup-complete");
  observer.capture(() => {
    captured = true;
    throw new Error("must not run");
  });
  observer.record({ kind: "socket-error", connection: 1, atMs: 6 });
  assert.equal(observer.connect(), undefined);
  const second = observer.stop();

  assert.equal(captured, false);
  assert.equal(events.length, recorded);
  assert.equal(JSON.stringify(first), encoded);
  assert.deepEqual(second, first);
  assert.equal(second.events.at(-1)?.kind, "cutoff");
  assert.deepEqual(
    second.connections[0]?.unfinished.map((event) => event.id),
    [1],
  );
  assert.deepEqual(
    second.connections[0]?.failures.map((event) => event.id),
    [2],
  );
});

test("CDP connection finish clears raw request, tombstone, alias and failure maps", () => {
  const { observer, connection, events } = fixture();
  connection.armed(1, "Page.enable", "private-first-route", 10, 1);
  connection.armed(2, "Runtime.evaluate", "private-second-route", 10, 2);
  connection.event("timeout-fired", 2, true);
  const finished = connection.finish();
  const encoded = JSON.stringify(finished);
  assert.deepEqual(
    finished.unfinished.map((event) => event.id),
    [1],
  );
  assert.deepEqual(
    finished.failures.map((event) => event.id),
    [2],
  );

  // Exercise the same connection while its observer is active to prove clearing,
  // rather than relying on stop() hiding access to retained raw maps.
  connection.receive(1, "private-first-route", "ignored-no-pending", 3);
  const formerlyPending = last(events);
  connection.receive(2, "private-second-route", "ignored-no-pending", 4);
  const formerlyRetired = last(events);
  assert.equal(formerlyPending.correlation, "uncorrelated");
  assert.equal(formerlyRetired.correlation, "uncorrelated");
  assert.deepEqual(connection.finish().unfinished, []);
  assert.deepEqual(connection.finish().failures, []);
  connection.armed(3, "Page.enable", "private-second-route", 10, 5);
  assert.equal(last(events).route, "session-1");
  assert.equal(JSON.stringify(finished), encoded);
  assert.equal(encoded.includes("private-"), false);
  observer.stop();
});

test("CDP final artifact reports explicit outcome, cleanup and cutoff", async () => {
  for (const outcome of ["running", "passed", "failed"] as const) {
    for (const cleanupCompleted of [false, true]) {
      const { observer } = fixture();
      const calls: string[] = [];
      const reports: unknown[] = [];
      await finishCdpDiagnostic(observer, outcome, cleanupCompleted, {
        write: async (report) => {
          calls.push("write");
          reports.push(report);
        },
        log: (report) => {
          calls.push("log");
          reports.push(report);
        },
      });
      assert.deepEqual(calls, ["write", "log"]);
      assert.equal(reports[0], reports[1]);
      assert.deepEqual(reports[0], {
        ...observer.stop(),
        outcome,
        cleanupCompleted,
        artifactErrors: 0,
      });
    }
  }
});

test("CDP artifact write and log exceptions never replace fixture outcomes", async () => {
  for (const writeFails of [false, true]) {
    for (const logFails of [false, true]) {
      for (const fixtureFails of [false, true]) {
        const { observer } = fixture();
        const original = new Error("original fixture failure");
        const success = { original: "fixture success" };
        let writeCalls = 0;
        let logCalls = 0;
        let logged: unknown;
        const run = async () => {
          try {
            if (fixtureFails) throw original;
            return success;
          } finally {
            await finishCdpDiagnostic(
              observer,
              fixtureFails ? "failed" : "passed",
              true,
              {
                write: async () => {
                  writeCalls += 1;
                  if (writeFails) throw new Error("artifact write failed");
                },
                log: (report) => {
                  logCalls += 1;
                  logged = report;
                  if (logFails) throw new Error("artifact log failed");
                },
              },
            );
          }
        };
        if (fixtureFails)
          await assert.rejects(run(), (error) => error === original);
        else assert.equal(await run(), success);
        assert.equal(writeCalls, 1);
        assert.equal(logCalls, 1);
        assert.deepEqual(logged, {
          ...observer.stop(),
          outcome: fixtureFails ? "failed" : "passed",
          cleanupCompleted: true,
          artifactErrors: writeFails ? 1 : 0,
        });
      }
    }
  }
});

test("CDP final artifact suppresses synchronous writer and snapshot failures", async (t) => {
  const { observer } = fixture();
  let logged = false;
  await assert.doesNotReject(
    finishCdpDiagnostic(observer, "failed", false, {
      write: () => {
        throw new Error("synchronous writer failure");
      },
      log: () => {
        logged = true;
      },
    }),
  );
  assert.equal(logged, true);

  const broken = new UserBrowserCdpDiagnosticObserver();
  t.mock.method(broken, "stop", () => {
    throw new Error("snapshot failure");
  });
  let sinkCalls = 0;
  const original = new Error("original cleanup failure");
  await assert.rejects(
    (async () => {
      try {
        throw original;
      } finally {
        await finishCdpDiagnostic(broken, "failed", false, {
          write: async () => {
            sinkCalls += 1;
          },
          log: () => {
            sinkCalls += 1;
          },
        });
      }
    })(),
    (error) => error === original,
  );
  assert.equal(sinkCalls, 0);
});
