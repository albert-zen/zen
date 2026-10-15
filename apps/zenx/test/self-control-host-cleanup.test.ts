import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupSelfControlHostFixture } from "./fixtures/self-control-host-cleanup.js";

function fixture(failing: string[] = []) {
  const calls: string[] = [];
  const reports: Array<{ message: string; error?: unknown }> = [];
  const errors = new Map(failing.map((stage) => [stage, new Error(stage)]));
  const operation = (stage: string) => async () => {
    calls.push(stage);
    if (errors.has(stage)) throw errors.get(stage);
  };
  return {
    calls,
    errors,
    reports,
    options: {
      directory: "synthetic-fixture",
      stop: operation("stop"),
      release: operation("release"),
      closeCapabilities: operation("capabilities"),
      removeDirectory: operation("remove"),
      report(message: string, error?: unknown) {
        reports.push({ message, error });
      },
    },
  };
}

test("self-control cleanup joins Stop before release and removes a confirmed fixture", async () => {
  const f = fixture();
  let finishStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finishStop = resolve;
  });
  f.options.stop = async () => {
    f.calls.push("stop");
    await stopped;
  };
  const cleaning = cleanupSelfControlHostFixture(f.options);
  await Promise.resolve();
  assert.deepEqual(f.calls, ["stop"]);
  finishStop();
  await cleaning;
  assert.deepEqual(f.calls, ["stop", "release", "capabilities", "remove"]);
  assert.deepEqual(f.reports, []);
});

test("self-control cleanup preserves release and evidence after unconfirmed Stop", async () => {
  const f = fixture(["stop"]);
  await assert.rejects(cleanupSelfControlHostFixture(f.options), (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0].cause, f.errors.get("stop"));
    assert.equal(f.reports.at(-1)?.error, error);
    return true;
  });
  assert.deepEqual(f.calls, ["stop", "release", "capabilities"]);
  assert.match(f.reports[0]!.message, /Retained synthetic.*synthetic-fixture/u);
});

test("self-control cleanup retains independent Stop, release and capability errors", async () => {
  const f = fixture(["stop", "release", "capabilities"]);
  await assert.rejects(cleanupSelfControlHostFixture(f.options), (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((failure: Error) => failure.cause),
      [
        f.errors.get("stop"),
        f.errors.get("release"),
        f.errors.get("capabilities"),
      ],
    );
    return true;
  });
  assert.deepEqual(f.calls, ["stop", "release", "capabilities"]);
});

test("self-control cleanup still removes a stopped fixture after other cleanup failures", async () => {
  const f = fixture(["release", "capabilities", "remove"]);
  await assert.rejects(cleanupSelfControlHostFixture(f.options), (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((failure: Error) => failure.cause),
      [
        f.errors.get("release"),
        f.errors.get("capabilities"),
        f.errors.get("remove"),
      ],
    );
    return true;
  });
  assert.deepEqual(f.calls, ["stop", "release", "capabilities", "remove"]);
  assert.equal(f.reports.length, 1);
});

test("self-control after-hook cleanup preserves body failures and still fails a successful body", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-cleanup-test-"));
  const entry = path.join(directory, "fixture.mjs");
  const cleanupModule = new URL(
    "./fixtures/self-control-host-cleanup.ts",
    import.meta.url,
  ).href;
  try {
    await writeFile(
      entry,
      `import test from 'node:test';
import { cleanupSelfControlHostFixture } from ${JSON.stringify(cleanupModule)};
for (const bodyFails of [true, false]) {
  test(bodyFails ? 'body-failure' : 'cleanup-only-failure', (context) => {
    context.after(() => cleanupSelfControlHostFixture({
      directory: 'synthetic-fixture',
      stop: async () => { throw new Error('synthetic Stop failure'); },
      release: async () => {},
      closeCapabilities: async () => {},
      removeDirectory: async () => { throw new Error('must retain release'); },
      report: (...args) => console.error(...args),
    }));
    if (bodyFails) throw new Error('original body failure');
  });
}
`,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--test", "--test-reporter=tap", entry],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /error: 'original body failure'/u);
    assert.match(
      result.stdout,
      /error: 'Self-control Host fixture cleanup failed'/u,
    );
    assert.match(result.stdout, /synthetic Stop failure/u);
    assert.match(result.stdout, /# fail 2/u);
    assert.doesNotMatch(result.stdout + result.stderr, /must retain release/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
