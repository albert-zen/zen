import assert from "node:assert/strict";
import test from "node:test";
import {
  createImzenxCaseWriter,
  createImzenxCaseReader,
  IMZENX_CASE_FILE,
} from "../scripts/imzenx-case-observation.mjs";
const runId = "12345678-1234-4234-8234-123456789abc";
const identity = { pid: process.pid, ppid: process.ppid, startTicks: 123 };
function writer(options = {}) {
  const rows = [],
    opens = [],
    closes = [];
  const result = createImzenxCaseWriter({
    traceFile: "/owned/trace",
    readRunId: () => runId,
    identity: () => identity,
    open: (...args) => {
      opens.push(args);
      return 7;
    },
    write: (fd, b, o, n) => {
      rows.push(b.subarray(o, o + n).toString());
      return n;
    },
    close: (fd) => closes.push(fd),
    utc: () => "2026-10-16T00:00:00.000Z",
    ...options,
  });
  return { result, rows, opens, closes };
}
function reader(text, options = {}) {
  let reads = 0;
  const rows = [];
  const observe = createImzenxCaseReader({
    file: "/owned/trace",
    runId,
    read: (p, limit) => {
      reads++;
      assert.equal(p, `/owned/trace.imzenx-${runId}.ndjson`);
      assert.equal(limit, 32768);
      return typeof text === "function" ? text() : text;
    },
    emit: (r) => {
      rows.push(r);
      return true;
    },
    ...options,
  });
  return { observe, rows, reads: () => reads };
}
test("writer projects fixed identity, exclusive append path, bounded start/complete receipts and closes", () => {
  const h = writer();
  for (let i = 1; i <= 20; i++) {
    h.result.record(i, "case-start");
    h.result.record(i, "case-complete");
  }
  h.result.record(20, "case-complete");
  h.result.record(21, "case-start");
  h.result.close();
  h.result.close();
  assert.equal(h.rows.length, 41);
  assert.equal(h.closes.length, 1);
  assert.ok(h.rows.every((r) => Buffer.byteLength(r) < 512));
  assert.equal(h.opens[0][0], `/owned/trace.imzenx-${runId}.ndjson`);
  const r = JSON.parse(h.rows[0]);
  assert.equal(r.file, IMZENX_CASE_FILE);
  assert.equal(r.pid, process.pid);
  assert.equal(r.caseId, 0);
});
test("writer never opens for missing/invalid current run or mismatched own identity", () => {
  for (const options of [
    { traceFile: "" },
    { readRunId: () => "old" },
    { identity: () => ({ ...identity, pid: 999999 }) },
    {
      readRunId: () => {
        throw Error("secret");
      },
    },
  ]) {
    const h = writer(options);
    h.result.record(1, "case-start");
    h.result.close();
    assert.equal(h.opens.length, 0);
    assert.equal(h.rows.length, 0);
  }
});
test("writer exclusive creation failure, partial write and overflow stop without throwing", () => {
  const failed = writer({
    open: () => {
      throw Error("EEXIST");
    },
  });
  failed.result.record(1, "case-start");
  assert.equal(failed.rows.length, 0);
  const partial = writer({ write: () => 1 });
  partial.result.record(1, "case-start");
  assert.equal(partial.closes.length, 1);
  const long = writer({ utc: () => "X".repeat(1000) });
  assert.equal(long.rows.length, 0);
  assert.equal(long.closes.length, 1);
  const h = writer();
  for (const [id, phase] of [
    [0, "case-start"],
    [0, "case-complete"],
    [1, "case-complete"],
    [1, "unknown"],
    [NaN, "case-start"],
  ])
    h.result.record(id, phase);
  assert.equal(h.rows.length, 1);
});
test("reader accepts only current owned identity, deduplicates, and retains partial-line unknown", () => {
  const w = writer();
  w.result.record(1, "case-start");
  w.result.record(1, "case-complete");
  let text = w.rows.join("");
  const r = reader(() => text);
  r.observe([{ ...identity }]);
  r.observe([{ ...identity }]);
  assert.equal(r.rows.filter((x) => x.kind === "imzenx-case").length, 3);
  text += '{"unfinished"';
  r.observe([{ ...identity }]);
  assert.equal(r.rows.at(-1).state, "partial");
  const unmatched = reader(w.rows.join(""));
  unmatched.observe([{ ...identity, startTicks: 124 }]);
  assert.equal(unmatched.rows[0].state, "unmatched");
});
test("stale nonce, malformed/oversize/extra-field rows and duplicate case starts cannot be attributed", () => {
  const w = writer();
  w.result.record(1, "case-start");
  const first = JSON.parse(w.rows[0]);
  const invalid = [
    JSON.stringify({
      ...first,
      runId: "22345678-1234-4234-8234-123456789abc",
    }) + "\n",
    JSON.stringify({ ...first, secret: "never" }) + "\n",
    "bad\n",
    "x".repeat(32769),
    w.rows.join("") +
      JSON.stringify({ ...JSON.parse(w.rows[1]), sequence: 3 }) +
      "\n",
  ];
  for (const text of invalid) {
    const r = reader(text);
    r.observe([{ ...identity }]);
    assert.equal(r.rows.filter((x) => x.kind === "imzenx-case").length, 0);
    assert.ok(!JSON.stringify(r.rows).includes("never"));
  }
});
test("reader checks caps before IO and preserves unknown on failures", () => {
  const r = reader("", { canRead: () => false });
  r.observe([]);
  assert.equal(r.reads(), 0);
  const unavailable = reader("", {
    read: () => {
      throw Error("SECRET");
    },
  });
  for (let i = 0; i < 100; i++) unavailable.observe([]);
  assert.equal(unavailable.rows.length, 32);
  assert.ok(!JSON.stringify(unavailable.rows).includes("SECRET"));
});

test("reporter binds sidecar to this run and current owned identity at existing resource gate", async () => {
  const { createExecutionTrace } =
    await import("../scripts/test-execution-reporter.mjs");
  const w = writer();
  w.result.record(1, "case-start");
  let reads = 0,
    now = 0;
  const rows = [];
  const trace = createExecutionTrace({
    file: "/owned/trace",
    root: "/repo",
    cwd: "/repo",
    open: () => 7,
    close: () => {},
    write: (fd, b, o, n) => {
      if (fd === 7) rows.push(JSON.parse(b.subarray(o, o + n)));
      return n;
    },
    monotonic: () => now,
    resourceObservation: true,
    resourcePlatform: "linux",
    resourceRead: () => "",
    ownedProcessObservation: true,
    ownedProcesses: () => ({ nodes: [identity] }),
    imzenxCaseObservation: true,
    traceRunId: runId,
    caseRead: () => {
      reads++;
      return w.rows.join("");
    },
  });
  const event = {
    type: "test:dequeue",
    data: { file: "apps/zenx/test/a.test.mjs", name: "case", nesting: 0 },
  };
  trace.observe(event);
  trace.observe(event);
  assert.equal(reads, 1);
  assert.equal(rows[0].runId, runId);
  assert.equal(rows.filter((r) => r.kind === "imzenx-case").length, 2);
  now = 15000;
  trace.observe(event);
  assert.equal(reads, 2);
  assert.equal(rows.filter((r) => r.kind === "imzenx-case").length, 2);
  trace.finish();
});
