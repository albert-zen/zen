import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createExecutionTrace,
  EXECUTION_TRACE_LIMITS,
} from "../scripts/test-execution-reporter.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const reporter = fileURLToPath(
  new URL("../scripts/test-execution-reporter.mjs", import.meta.url),
);
const location = path.join(root, "apps/zenx/test/fixture.test.mjs");
const event = (name = "safe test name", file = location) => ({
  type: "test:dequeue",
  data: { file, name, nesting: 0 },
});

function harness(overrides = {}) {
  const buffers = { 7: [], 2: [] };
  let now = 20;
  const trace = createExecutionTrace({
    root,
    file: "unused",
    open: () => 7,
    close: () => {},
    utc: () => "2026-10-15T00:00:00.000Z",
    monotonic: () => now++,
    write: (fd, buffer, offset, length) => {
      buffers[fd].push(buffer.subarray(offset, offset + length));
      return length;
    },
    ...overrides,
  });
  const output = (fd) => Buffer.concat(buffers[fd]);
  const records = (fd = 7) =>
    output(fd)
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { trace, buffers, output, records };
}

test("execution reporter projects only dequeue fields and repository-relative file names", () => {
  const h = harness();
  const item = event(location);
  for (const key of [
    "stdout",
    "stderr",
    "error",
    "environment",
    "details",
    "arguments",
  ])
    Object.defineProperty(item.data, key, {
      get() {
        throw new Error("private payload must never be read");
      },
    });
  h.trace.observe(item);
  h.trace.observe({
    type: "test:stdout",
    get data() {
      throw new Error("private output");
    },
  });
  h.trace.observe(
    event("private outside test name", "/private/outside.test.mjs"),
  );
  h.trace.observe(event("/private/absolute-name"));
  h.trace.finish();
  assert.deepEqual(h.output(7), h.output(2));
  const first = h.records()[1];
  assert.deepEqual(Object.keys(first), [
    "kind",
    "scope",
    "sequence",
    "file",
    "name",
    "fileTruncated",
    "nameTruncated",
    "nesting",
    "utc",
    "elapsedMs",
  ]);
  assert.equal(first.scope, "file");
  assert.equal(h.records()[2].scope, "case");
  assert.equal(h.records()[0].timeBasis, "reporter-receipt");
  assert.equal(h.records()[0].caseEventsMayBeBuffered, true);
  assert.equal(first.file, "apps/zenx/test/fixture.test.mjs");
  assert.equal(first.name, first.file);
  assert.equal(first.elapsedMs, 1);
  assert.doesNotMatch(
    h.output(7).toString(),
    /private|stdout|stderr|arguments|environment|details/,
  );
  assert.equal(h.records().at(-1).ignored, 1);
});

test("execution reporter identifies the actual Node 22 workspace-relative file wrapper", () => {
  const ciRoot = "/home/runner/work/zen/zen";
  const ciFile = `${ciRoot}/apps/zenx/test/imzenx-setup-service.test.ts`;
  const h = harness({ root: ciRoot, cwd: `${ciRoot}/apps/zenx` });
  h.trace.observe(event("test/imzenx-setup-service.test.ts", ciFile));
  h.trace.observe(event("./test/imzenx-setup-service.test.ts", ciFile));
  h.trace.observe(event("../zenx/test/imzenx-setup-service.test.ts", ciFile));
  h.trace.observe(event("explicit runtime preparation", ciFile));
  h.trace.observe(event("/private/outside.test.ts", ciFile));
  h.trace.observe(event("../../outside.test.ts", ciFile));
  h.trace.finish();
  const rows = h.records().filter((row) => row.kind === "dequeue");
  assert.deepEqual(
    rows.map((row) => row.scope),
    ["file", "file", "file", "case", "case", "case"],
  );
  for (const row of rows.slice(0, 3)) {
    assert.equal(row.name, "apps/zenx/test/imzenx-setup-service.test.ts");
    assert.equal(row.file, row.name);
  }
  assert.doesNotMatch(h.output(7).toString(), /\/home\/runner|\/private\//u);
});

test("execution reporter bounds escaped fields and Unicode without broken UTF-8", () => {
  for (const name of [
    '"\\\n'.repeat(5000),
    "界😀".repeat(5000),
    "\ud800".repeat(5000),
  ]) {
    const h = harness();
    h.trace.observe(event(name));
    h.trace.finish();
    const raw = h.output(7);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const row = h.records()[1];
    assert(
      Buffer.byteLength(JSON.stringify(row.name)) <=
        EXECUTION_TRACE_LIMITS.fieldBytes,
    );
    for (const line of decoded.trim().split("\n"))
      assert(
        Buffer.byteLength(`${line}\n`) <= EXECUTION_TRACE_LIMITS.recordBytes,
      );
    assert.equal(row.kind, "dequeue");
    assert.equal(row.nameTruncated, true);
  }
});

test("execution reporter record cap reserves a visible end and budget marker", () => {
  const h = harness();
  for (let i = 0; i < EXECUTION_TRACE_LIMITS.records + 5; i++)
    h.trace.observe(event("x"));
  h.trace.finish();
  h.trace.finish();
  const rows = h.records();
  assert.equal(
    rows.filter((row) => row.kind === "dequeue").length,
    EXECUTION_TRACE_LIMITS.records,
  );
  assert.equal(rows.filter((row) => row.kind === "budget-exhausted").length, 1);
  assert.equal(rows.filter((row) => row.kind === "end").length, 1);
  assert.equal(rows.at(-1).dropped, 5);
  assert.equal(rows.at(-1).truncated, true);
  assert(
    h.output(7).length + h.output(2).length <=
      EXECUTION_TRACE_LIMITS.combinedBytes,
  );
});

test("execution reporter shared byte cap counts both sinks rather than doubling the budget", () => {
  const h = harness();
  const file = path.join(
    root,
    "apps/zenx/test",
    `${"long".repeat(80)}.test.mjs`,
  );
  for (let i = 0; i < EXECUTION_TRACE_LIMITS.records + 5; i++)
    h.trace.observe(event("界".repeat(1000), file));
  h.trace.finish();
  const rows = h.records();
  assert(rows.at(-1).recorded < EXECUTION_TRACE_LIMITS.records);
  assert.equal(rows.at(-1).truncated, true);
  assert.equal(rows.filter((row) => row.kind === "budget-exhausted").length, 1);
  assert(
    h.output(7).length + h.output(2).length <=
      EXECUTION_TRACE_LIMITS.combinedBytes,
  );
});

for (const failure of ["open", "file", "console", "close", "zero-write"])
  test(`execution reporter ${failure} failure is explicit and does not throw`, () => {
    const buffers = { 7: [], 2: [] };
    let calls = 0;
    const h = harness({
      open: () => {
        if (failure === "open") throw new Error("private filesystem path");
        return 7;
      },
      close: () => {
        if (failure === "close") throw new Error("private close error");
      },
      write(fd, buffer, offset, length) {
        calls++;
        if (
          (failure === "file" && fd === 7) ||
          (failure === "console" && fd === 2)
        )
          throw new Error("private sink error");
        if (failure === "zero-write" && fd === 7) return 0;
        buffers[fd].push(buffer.subarray(offset, offset + length));
        return length;
      },
    });
    assert.doesNotThrow(() => {
      h.trace.observe(event());
      h.trace.finish();
    });
    const text = Buffer.concat([...buffers[7], ...buffers[2]]).toString();
    assert.match(text, /diagnostic-unavailable/);
    assert.doesNotMatch(text, /private/);
    assert(calls < 20);
  });

test("execution reporter joins short writes into complete JSONL records", () => {
  const buffers = { 7: [], 2: [] };
  const h = harness({
    write(fd, buffer, offset, length) {
      const count = Math.min(3, length);
      buffers[fd].push(buffer.subarray(offset, offset + count));
      return count;
    },
  });
  h.trace.observe(event());
  h.trace.finish();
  assert.deepEqual(Buffer.concat(buffers[7]), Buffer.concat(buffers[2]));
  assert.equal(
    Buffer.concat(buffers[7])
      .toString()
      .trim()
      .split("\n")
      .map(JSON.parse)
      .at(-1).kind,
    "end",
  );
});

async function fixture(t, source) {
  // The test file remains under the repository's eligible test directory.
  const directory = await mkdtemp(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      ".execution-trace-",
    ),
  );
  const evidence = await mkdtemp(
    path.join(os.tmpdir(), "zenx-execution-evidence-"),
  );
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(evidence, { recursive: true, force: true });
  });
  const file = path.join(directory, "fixture.test.mjs");
  await writeFile(file, source);
  return { file, evidence, trace: path.join(evidence, "trace.ndjson") };
}
function run(file, trace, observed = true, extraArgs = [], cwd) {
  const options = observed
    ? [
        "--test-reporter=tap",
        `--test-reporter=${reporter}`,
        "--test-reporter-destination=stdout",
        "--test-reporter-destination=stderr",
      ]
    : ["--test-reporter=tap"];
  const environment = { ...process.env, ZENX_TEST_EXECUTION_TRACE_FILE: trace };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    ["--test", ...options, ...extraArgs, file],
    {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
  return { child, done };
}

for (const failing of [false, true])
  test(`execution reporter retains TAP and original ${failing ? "failure" : "success"} exit`, async (t) => {
    const f = await fixture(
      t,
      `import test from 'node:test'; test('fixture-result',()=>{${failing ? "throw new Error('original fixture failure')" : ""}});`,
    );
    const base = await run(f.file, f.trace, false).done;
    const observed = await run(f.file, f.trace).done;
    assert.equal(observed.code, base.code);
    assert.equal(observed.code, failing ? 1 : 0);
    assert.match(observed.stdout, /^TAP version 13/mu);
    assert.match(
      observed.stdout,
      failing ? /not ok 1 - fixture-result/u : /ok 1 - fixture-result/u,
    );
    const rows = (await readFile(f.trace, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert(
      rows.some(
        (row) => row.kind === "dequeue" && row.name === "fixture-result",
      ),
    );
    assert.equal(rows.at(-1).kind, "end");
    assert.doesNotMatch(
      await readFile(f.trace, "utf8"),
      /original fixture failure/,
    );
  });

test("execution reporter classifies wrappers from a workspace-relative CLI invocation", async (t) => {
  const f = await fixture(
    t,
    "import test from 'node:test'; test('fixture-workspace-case',()=>{});",
  );
  const cwd = path.join(root, "apps/zenx");
  const relativeFile = path.relative(cwd, f.file);
  const result = await run(relativeFile, f.trace, true, [], cwd).done;
  assert.equal(result.code, 0);
  const rows = (await readFile(f.trace, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  const wrapper = rows.find(
    (row) => row.kind === "dequeue" && row.scope === "file",
  );
  assert(wrapper);
  assert.equal(
    wrapper.name,
    path.relative(root, f.file).split(path.sep).join("/"),
  );
  assert.equal(wrapper.file, wrapper.name);
  assert.equal(
    rows.find((row) => row.name === "fixture-workspace-case").scope,
    "case",
  );
  assert.equal(rows.at(-1).kind, "end");
  assert.doesNotMatch(
    await readFile(f.trace, "utf8"),
    /\/tmp\/|\/home\/runner/u,
  );
});

test("execution reporter file error keeps an originally successful suite successful", async (t) => {
  const f = await fixture(
    t,
    "import test from 'node:test'; test('fixture-result',()=>{});",
  );
  const result = await run(
    f.file,
    path.join(f.evidence, "missing", "trace.ndjson"),
  ).done;
  assert.equal(result.code, 0);
  assert.match(result.stdout, /ok 1 - fixture-result/u);
  assert.match(result.stderr, /diagnostic-unavailable/u);
  assert.doesNotMatch(result.stderr, /ENOENT|missing|Error:|stack/u);
});

test("execution reporter leaves incremental evidence after its exact owned runner is killed", async (t) => {
  const f = await fixture(
    t,
    "import test from 'node:test'; import { writeFileSync } from 'node:fs'; writeFileSync(new URL('fixture.pid',import.meta.url), String(process.pid)); test('fixture-wait',async()=>{await new Promise(r=>setTimeout(r,6000));});",
  );
  // This synthetic interruption fixture must have no isolated descendant.
  // Other fixtures and the real aggregate keep the original process isolation.
  const pending = run(f.file, f.trace, true, [
    "--experimental-test-isolation=none",
  ]);
  t.after(async () => {
    if (pending.child.exitCode === null && pending.child.signalCode === null)
      pending.child.kill("SIGKILL");
    await pending.done;
  });
  const deadline = Date.now() + 4000;
  let text = "";
  while (Date.now() < deadline) {
    try {
      text = await readFile(f.trace, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (text.includes('"name":"fixture-wait"')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(text, /"name":"fixture-wait"/u);
  assert.equal(
    Number(
      await readFile(path.join(path.dirname(f.file), "fixture.pid"), "utf8"),
    ),
    pending.child.pid,
    "the fixture and its directly owned runner must be the same process",
  );
  // Kill only the directly owned, still unreaped test runner handle.
  assert.equal(pending.child.kill("SIGKILL"), true);
  const result = await pending.done;
  assert.equal(result.signal, "SIGKILL");
  const rows = (await readFile(f.trace, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert(rows.some((row) => row.name === "fixture-wait"));
  assert(!rows.some((row) => row.kind === "end"));
});

test("observed aggregate bounds file concurrency without changing coverage or check order", async () => {
  const { scripts } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const added =
    " --test-concurrency=2 --test-reporter=tap --test-reporter=./scripts/test-execution-reporter.mjs --test-reporter-destination=stdout --test-reporter-destination=stderr";
  assert.equal(
    scripts["test:prepared:observed"].replace(added, ""),
    scripts["test:prepared"],
  );
  assert.equal(
    scripts["check:observed"].replace(
      "test:prepared:observed",
      "test:prepared",
    ),
    scripts.check,
  );
  assert.doesNotMatch(
    scripts["test:prepared:observed"],
    /NODE_OPTIONS|test-timeout|test-isolation|test-only|test-name-pattern|test-skip-pattern|test-shard|test-force-exit/u,
  );
  const original = "tsx --test test/**/*.test.ts test/**/*.test.mjs";
  assert.equal(scripts.test, original);
  assert.equal(scripts["test:prepared"], original);
  // Exact argv equality rejects duplicate overrides, filters or missing globs.
  assert.deepEqual(scripts["test:prepared:observed"].split(" "), [
    "tsx",
    "--test",
    "--test-concurrency=2",
    "--test-reporter=tap",
    "--test-reporter=./scripts/test-execution-reporter.mjs",
    "--test-reporter-destination=stdout",
    "--test-reporter-destination=stderr",
    "test/**/*.test.ts",
    "test/**/*.test.mjs",
  ]);
  const workflow = await readFile(
    path.join(root, ".github/workflows/ci.yml"),
    "utf8",
  );
  const aggregateJob = workflow
    .split("\n  zenx:\n")[1]
    ?.split(/\n  [a-z][a-z-]*:\n/u)[0];
  assert(aggregateJob, "the original aggregate job must still exist");
  assert.match(aggregateJob, /timeout-minutes: 20\n/u);
  assert.match(
    aggregateJob,
    /run: npm --workspace apps\/zenx run check:observed\n/u,
  );
  assert.doesNotMatch(
    aggregateJob,
    /continue-on-error|test-timeout|test-skip|test-only|test-name-pattern|NODE_OPTIONS/u,
  );
  const source = await readFile(
    new URL("../scripts/test-execution-reporter.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /process\.(?:on|once|kill|exit)\s*\(|setTimeout\s*\(|setInterval\s*\(/u,
  );
});
