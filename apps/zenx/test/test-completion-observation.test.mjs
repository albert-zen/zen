import assert from "node:assert/strict";
import test from "node:test";
import {
  createExecutionTrace,
  COMPLETION_TRACE_LIMITS,
  PROCESS_TRACE_LIMITS,
} from "../scripts/test-execution-reporter.mjs";
function fixture(options = {}) {
  let now = 0,
    calls = 0;
  const rows = [];
  const trace = createExecutionTrace({
    root: "/repo",
    cwd: "/repo/apps/zenx",
    file: "unused",
    open: () => 9,
    close: () => {},
    write: (fd, buffer, offset, length) => {
      if (fd === 9)
        rows.push(
          JSON.parse(buffer.subarray(offset, offset + length).toString()),
        );
      return length;
    },
    monotonic: () => now,
    utc: () => "2026-10-15T00:00:00Z",
    completionObservation: true,
    resourceObservation: true,
    processObservation: true,
    resourcePlatform: "linux",
    resourceRead: () => "",
    rss: () => {
      calls++;
      return 10;
    },
    heap: () => ({ used_heap_size: 2, total_heap_size: 3, heap_size_limit: 4 }),
    reporterPid: 42,
    reporterMainThread: false,
    ...options,
  });
  const event = (type, file = "test/a.test.ts", name = file, nesting = 0) =>
    trace.observe({ type, data: { file, name, nesting, line: 1, column: 1 } });
  return {
    rows,
    trace,
    event,
    time: (t) => {
      now = t;
    },
    calls: () => calls,
  };
}
test("only paired wrapper complete closes a file, independently of buffered cases", () => {
  const h = fixture();
  h.event("test:complete");
  h.event("test:dequeue");
  h.event("test:complete", "test/a.test.ts", "child case");
  h.event("test:complete", "test/a.test.ts", "test/a.test.ts", 1);
  h.event("test:complete", "/private/secret.test.ts");
  h.time(20);
  h.event("test:complete");
  h.event("test:complete");
  const complete = h.rows.filter((r) => r.kind === "file-complete");
  assert.deepEqual(complete, [
    {
      kind: "file-complete",
      file: "apps/zenx/test/a.test.ts",
      startSequence: 1,
      elapsedMs: 20,
      utc: "2026-10-15T00:00:00Z",
    },
  ]);
  assert.ok(!JSON.stringify(h.rows).includes("private"));
});
test("duplicate starts are ambiguous; missing completion is never synthesized", () => {
  const h = fixture();
  h.event("test:dequeue");
  h.event("test:dequeue");
  h.event("test:complete");
  h.trace.finish();
  assert.equal(h.rows.filter((r) => r.kind === "file-complete").length, 0);
});
test("process samples share successful host sampling gate and project numbers only", () => {
  const h = fixture();
  h.event("test:dequeue");
  h.time(14999);
  h.event("test:dequeue");
  assert.equal(h.calls(), 1);
  h.time(15000);
  h.event("test:dequeue");
  assert.equal(h.calls(), 2);
  assert.deepEqual(h.rows.filter((r) => r.kind === "process")[0], {
    kind: "process",
    elapsedMs: 0,
    pid: 42,
    mainThread: 0,
    rssBytes: 10,
    heapUsed: 2,
    heapTotal: 3,
    heapLimit: 4,
  });
});
test("unavailable and invalid process values cannot fail observation", () => {
  const h = fixture({
    rss: () => {
      throw Error("SECRET");
    },
    heap: () => ({
      used_heap_size: -1,
      total_heap_size: NaN,
      heap_size_limit: "SECRET",
    }),
  });
  assert.doesNotThrow(() => h.event("test:dequeue"));
  const row = h.rows.find((r) => r.kind === "process");
  assert.equal(row.rssBytes, null);
  assert.equal(row.heapUsed, null);
  assert.equal(row.heapTotal, null);
  assert.equal(row.heapLimit, null);
  assert.ok(!JSON.stringify(h.rows).includes("SECRET"));
});
test("completion state and output remain bounded; original dequeues continue", () => {
  const h = fixture({ resourceObservation: false });
  for (let i = 0; i < 600; i++) {
    const f = `test/${i}.test.ts`;
    h.event("test:dequeue", f);
    h.event("test:complete", f);
  }
  const rows = h.rows.filter((r) => r.kind === "file-complete");
  assert.equal(rows.length, COMPLETION_TRACE_LIMITS.records);
  assert.ok(
    rows.reduce(
      (n, r) => n + 2 * Buffer.byteLength(JSON.stringify(r) + "\n"),
      0,
    ) <= COMPLETION_TRACE_LIMITS.combinedBytes,
  );
  assert.equal(h.rows.filter((r) => r.kind === "dequeue").length, 600);
});
test("resource and process ceilings stop API calls and retain last sample time", () => {
  const h = fixture();
  for (let i = 0; i < 100; i++) {
    h.time(i * 15000);
    h.event("test:dequeue");
  }
  const rows = h.rows.filter((r) => r.kind === "process");
  assert.ok(rows.length <= PROCESS_TRACE_LIMITS.records);
  assert.equal(h.calls(), rows.length);
  assert.ok(
    rows.reduce(
      (n, r) => n + 2 * Buffer.byteLength(JSON.stringify(r) + "\n"),
      0,
    ) <= PROCESS_TRACE_LIMITS.combinedBytes,
  );
  assert.ok(rows.at(-1).elapsedMs < 99 * 15000);
});
test("disabling added observations leaves existing dequeue stream unchanged", () => {
  const a = fixture({
    completionObservation: false,
    processObservation: false,
  });
  const b = fixture({ completionObservation: true, processObservation: true });
  for (const h of [a, b]) {
    h.event("test:dequeue");
    h.event("test:complete");
    h.trace.finish();
  }
  assert.deepEqual(
    b.rows.filter((r) => !["file-complete", "process"].includes(r.kind)),
    a.rows,
  );
});

test("completion byte ceiling does not consume original dequeue budget", () => {
  const h = fixture({ resourceObservation: false });
  for (let i = 0; i < 512; i++) {
    const f = `test/${"x".repeat(205)}${i}.test.ts`;
    h.event("test:dequeue", f);
    h.event("test:complete", f);
  }
  const rows = h.rows.filter((r) => r.kind === "file-complete");
  assert.ok(rows.length < 512 && rows.length > 0);
  assert.ok(
    rows.reduce(
      (n, r) => n + 2 * Buffer.byteLength(JSON.stringify(r) + "\n"),
      0,
    ) <= COMPLETION_TRACE_LIMITS.combinedBytes,
  );
  assert.equal(h.rows.filter((r) => r.kind === "dequeue").length, 512);
});
test("separate wrappers may complete out of start order", () => {
  const h = fixture();
  h.event("test:dequeue", "test/a.test.ts");
  h.event("test:dequeue", "test/b.test.ts");
  h.event("test:complete", "test/b.test.ts");
  h.event("test:complete", "test/a.test.ts");
  assert.deepEqual(
    h.rows
      .filter((r) => r.kind === "file-complete")
      .map((r) => r.startSequence),
    [2, 1],
  );
});

test("original trace exhaustion blocks process sampling and completion", () => {
  const h = fixture();
  for (let i = 0; i < 8192; i++)
    h.event("test:dequeue", "test/a.test.ts", "case");
  assert.equal(h.calls(), 1);
  h.time(15000);
  h.event("test:dequeue");
  h.event("test:complete");
  assert.equal(h.calls(), 1);
  assert.equal(h.rows.filter((r) => r.kind === "file-complete").length, 0);
});

test("observation APIs and sink failures never escape the reporter", () => {
  const h = fixture({
    heap: () => {
      throw Error("private");
    },
    write: () => {
      throw Error("sink");
    },
  });
  assert.doesNotThrow(() => {
    h.event("test:dequeue");
    h.event("test:complete");
    h.trace.finish();
  });
});

test("owned descendant reads share resource opportunity and stop at caps or original exhaustion", () => {
  let reads = 0;
  const h = fixture({
    ownedProcessObservation: true,
    ownedProcesses: () => {
      reads++;
      return { scope: "leader-descendants", incomplete: true, nodes: [] };
    },
  });
  h.event("test:dequeue");
  h.time(14999);
  h.event("test:dequeue");
  assert.equal(reads, 1);
  for (let n = 1; n < 40; n++) {
    h.time(n * 15000);
    h.event("test:dequeue");
  }
  assert.equal(reads, 32);
  const e = fixture({
    ownedProcessObservation: true,
    ownedProcesses: () => {
      reads++;
      return {};
    },
  });
  for (let n = 0; n < 8300; n++) e.event("test:dequeue");
  const before = reads;
  e.time(15000);
  e.event("test:dequeue");
  assert.equal(reads, before);
});
test("owned descendant failure cannot replace original trace outcome", () => {
  const h = fixture({
    ownedProcessObservation: true,
    ownedProcesses: () => {
      throw Error("SECRET");
    },
  });
  h.event("test:dequeue");
  h.trace.finish();
  assert.equal(h.rows.at(-1).kind, "end");
  assert.ok(!JSON.stringify(h.rows).includes("SECRET"));
});
