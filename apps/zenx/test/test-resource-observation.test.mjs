import assert from "node:assert/strict";
import test from "node:test";
import {
  createResourceObservation,
  createExecutionTrace,
  EXECUTION_TRACE_LIMITS,
  RESOURCE_TRACE_LIMITS,
} from "../scripts/test-execution-reporter.mjs";

const values = {
  "/proc/meminfo":
    "MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\nSecret: NEVER_EMIT\n",
  "/sys/fs/cgroup/cgroup.controllers": "memory cpu\n",
  "/sys/fs/cgroup/memory.current": "1200\n",
  "/sys/fs/cgroup/memory.max": "max\n",
  "/sys/fs/cgroup/memory.events":
    "oom 2\noom_kill 1\noom_group_kill 0\nsecret NEVER_EMIT\n",
};
function fixture(options = {}) {
  let now = 0;
  const rows = [],
    reads = [];
  const read = (file, limit) => {
    reads.push([file, limit]);
    return values[file];
  };
  const observe = createResourceObservation({
    platform: "linux",
    started: 0,
    monotonic: () => now,
    utc: () => "2026-10-15T00:00:00Z",
    read,
    emit: (row) => rows.push(row),
    ...options,
  });
  return {
    observe,
    rows,
    reads,
    time: (value) => {
      now = value;
    },
  };
}

test("resource sampling uses fixed numeric projection and no payloads", () => {
  const h = fixture();
  h.observe();
  assert.deepEqual(
    h.reads.map(([file]) => file),
    Object.keys(values),
  );
  const row = h.rows[0];
  assert.equal(row.memAvailableKiB, 500);
  assert.equal(row.swapFreeKiB, 0);
  assert.equal(row.cgroupVersion, 2);
  assert.equal(row.currentBytes, 1200);
  assert.equal(row.maxBytes, null);
  assert.equal(row.limitState, "unlimited");
  assert.equal(row.oomKill, 1);
  assert.equal(row.oomGroupKill, 0);
  assert.doesNotMatch(
    JSON.stringify(row),
    /NEVER_EMIT|\/proc|\/sys|memory cpu/,
  );
  assert.deepEqual(Object.keys(row), [
    "kind",
    "sequence",
    "utc",
    "elapsedMs",
    "scope",
    "cgroupVersion",
    "memTotalKiB",
    "memAvailableKiB",
    "swapTotalKiB",
    "swapFreeKiB",
    "currentBytes",
    "maxBytes",
    "limitState",
    "oom",
    "oomKill",
    "oomGroupKill",
  ]);
});

test("resource IO occurs only at 15 second event boundaries without catch-up", () => {
  const h = fixture();
  h.observe();
  for (let i = 0; i < 10000; i++) h.observe();
  h.time(14999);
  h.observe();
  assert.equal(h.reads.length, 5);
  h.time(15000);
  h.observe();
  assert.equal(h.rows.length, 2);
  h.time(0);
  h.observe();
  assert.equal(h.rows.length, 2);
  h.time(90000);
  h.observe();
  assert.equal(h.rows.length, 3);
  assert.equal(h.rows[2].elapsedMs, 90000);
});

test("missing v2, failures, malformed and unsafe values remain null", () => {
  let calls = 0;
  const h = fixture({
    read: () => {
      calls++;
      throw new Error("NEVER_EMIT");
    },
  });
  h.observe();
  h.observe();
  assert.equal(calls, 2);
  assert.equal(h.rows[0].cgroupVersion, null);
  assert.equal(h.rows[0].oomKill, null);
  for (const value of [
    "-1",
    "1.5",
    "NaN",
    "9007199254740992",
    "NEVER_EMIT",
    "x".repeat(129),
  ]) {
    const f = fixture({
      read: (file) =>
        file.endsWith("memory.current") || file.endsWith("memory.max")
          ? value
          : values[file],
    });
    f.observe();
    assert.equal(f.rows[0].currentBytes, null);
    assert.equal(f.rows[0].maxBytes, null);
    assert.equal(f.rows[0].limitState, "unavailable");
  }
  const f = fixture({
    read: (file) =>
      file === "/proc/meminfo"
        ? "MemTotal: 1 kB\nMemTotal: 2 kB\nMemAvailable: 1 MB\n"
        : values[file],
  });
  f.observe();
  assert.equal(f.rows[0].memTotalKiB, null);
  assert.equal(f.rows[0].memAvailableKiB, null);
});

test("non-Linux and exhausted record or byte budgets do no reads", () => {
  const a = fixture({ platform: "darwin" });
  a.observe();
  assert.equal(a.reads.length, 0);
  const b = fixture({ canEmit: () => false });
  b.observe();
  assert.equal(b.reads.length, 0);
  const c = fixture();
  for (let i = 0; i < 100; i++) {
    c.time(i * 15000);
    c.observe();
  }
  assert.equal(c.rows.length, RESOURCE_TRACE_LIMITS.records);
  assert.equal(c.reads.length, RESOURCE_TRACE_LIMITS.records * 5);
});

test("resource reads require eligible dequeues and preserve original trace budget and sequence", () => {
  let now = 0,
    reads = 0;
  const buffers = [];
  const trace = createExecutionTrace({
    root: "/repo",
    cwd: "/repo",
    file: "unused",
    open: () => 7,
    close: () => {},
    write: (_fd, buffer, offset, length) => {
      buffers.push(buffer.subarray(offset, offset + length));
      return length;
    },
    utc: () => "2026-10-15T00:00:00Z",
    monotonic: () => now,
    resourceObservation: true,
    resourcePlatform: "linux",
    resourceRead: (file) => {
      reads++;
      return values[file];
    },
  });
  trace.observe({
    type: "test:stdout",
    get data() {
      throw Error("not inspected");
    },
  });
  trace.observe({
    type: "test:dequeue",
    data: { file: "/private/test.ts", name: "private" },
  });
  assert.equal(reads, 0);
  for (let i = 0; i < 8300; i++) {
    now = i * 15000;
    trace.observe({
      type: "test:dequeue",
      data: {
        file: "/repo/apps/zenx/test/fixture.test.mjs",
        name: "safe",
        nesting: 0,
      },
    });
  }
  trace.finish();
  const rows = Buffer.concat(buffers)
    .toString()
    .trim()
    .split("\n")
    .map(JSON.parse);
  const resource = rows.filter((r) => r.kind === "resource");
  const regular = rows.filter((r) => r.kind !== "resource");
  assert.equal(
    regular.filter((r) => r.kind === "dequeue").length,
    2 * EXECUTION_TRACE_LIMITS.records,
  );
  assert.equal(regular.at(-1).recorded, EXECUTION_TRACE_LIMITS.records);
  assert.equal(resource.length, 2 * RESOURCE_TRACE_LIMITS.records);
  assert.equal(reads, 5 * RESOURCE_TRACE_LIMITS.records);
  const bytes = (list) =>
    list.reduce(
      (sum, row) => sum + Buffer.byteLength(JSON.stringify(row) + "\n"),
      0,
    );
  assert(bytes(resource) <= RESOURCE_TRACE_LIMITS.combinedBytes);
  assert(bytes(regular) <= EXECUTION_TRACE_LIMITS.combinedBytes);
});

test("independent resource byte exhaustion stops reads and sink failure never throws", () => {
  let now = 0,
    reads = 0;
  const rows = [];
  const trace = createExecutionTrace({
    root: "/repo",
    cwd: "/repo",
    file: "unused",
    open: () => 7,
    close: () => {},
    write: (fd, buffer, offset, length) => {
      if (fd === 7) throw Error("private");
      rows.push(buffer.subarray(offset, offset + length));
      return length;
    },
    utc: () => "u".repeat(400),
    monotonic: () => now,
    resourceObservation: true,
    resourcePlatform: "linux",
    resourceRead: (file) => {
      reads++;
      return values[file];
    },
  });
  for (let i = 0; i < 100; i++) {
    now = i * 15000;
    assert.doesNotThrow(() =>
      trace.observe({
        type: "test:dequeue",
        data: {
          file: "/repo/apps/zenx/test/fixture.test.mjs",
          name: "safe",
          nesting: 0,
        },
      }),
    );
  }
  const before = reads;
  now += 15000;
  trace.finish();
  const parsed = Buffer.concat(rows)
    .toString()
    .trim()
    .split("\n")
    .map(JSON.parse);
  const samples = parsed.filter((row) => row.kind === "resource");
  assert(samples.length > 0 && samples.length < 32);
  assert.equal(reads, before);
  assert.equal(reads, samples.length * 5);
  assert(
    samples.reduce(
      (sum, row) => sum + 2 * Buffer.byteLength(JSON.stringify(row) + "\n"),
      0,
    ) <= RESOURCE_TRACE_LIMITS.combinedBytes,
  );
  assert.equal(parsed.filter((row) => row.kind === "dequeue").length, 100);
  assert.doesNotMatch(JSON.stringify(parsed), /private/);
});

for (const cap of ["record", "byte"])
  test(`trace ${cap} exhaustion does not sample on the exhausting event`, () => {
    function setup() {
      let now = 0,
        reads = 0;
      const rows = [];
      const trace = createExecutionTrace({
        root: "/repo",
        cwd: "/repo",
        file: "unused",
        open: () => 7,
        close: () => {},
        write: (fd, buffer, offset, length) => {
          if (fd === 7)
            rows.push(
              JSON.parse(buffer.subarray(offset, offset + length).toString()),
            );
          return length;
        },
        utc: () => "2026-10-15T00:00:00Z",
        monotonic: () => now,
        resourceObservation: true,
        resourcePlatform: "linux",
        resourceRead: (file) => {
          reads++;
          return values[file];
        },
      });
      const event = {
        type: "test:dequeue",
        data: {
          file: `/repo/apps/zenx/test/${cap === "byte" ? "x".repeat(300) : "fixture"}.test.mjs`,
          name: cap === "byte" ? "界".repeat(1000) : "safe",
          nesting: 0,
        },
      };
      return {
        trace,
        rows,
        event,
        reads: () => reads,
        time: (value) => {
          now = value;
        },
      };
    }
    // Discover the original cap boundary with a stationary injected clock.
    const baseline = setup();
    let count = 0;
    while (!baseline.rows.some((row) => row.kind === "budget-exhausted")) {
      assert(count <= EXECUTION_TRACE_LIMITS.records);
      baseline.trace.observe(baseline.event);
      count++;
    }
    baseline.trace.finish();
    assert(cap === "record" ? count === 8193 : count < 8193);
    const h = setup();
    for (let i = 1; i < count; i++) h.trace.observe(h.event);
    assert.equal(h.reads(), 5);
    h.time(15000);
    h.trace.observe(h.event);
    assert.equal(h.reads(), 5, "exhausting event must not read resources");
    assert.equal(h.rows.at(-1).kind, "budget-exhausted");
    h.time(30000);
    h.trace.observe(h.event);
    h.trace.finish();
    assert.equal(h.reads(), 5);
    assert.equal(h.rows.filter((row) => row.kind === "resource").length, 1);
  });
