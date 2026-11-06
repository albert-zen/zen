import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  ),
);

test("ZenX checks and synthetic UI run independently with a fail-closed compatibility gate", () => {
  const { jobs } = workflow;
  assert.ok(jobs["zenx-check"]);
  assert.ok(jobs["zenx-ui"]);
  assert.equal(jobs["zenx-check"].needs, undefined);
  assert.equal(jobs["zenx-ui"].needs, undefined);
  assert.deepEqual(jobs.zenx.needs, ["zenx-check", "zenx-ui"]);
  assert.equal(jobs.zenx.name, "ZenX typecheck, tests, and build");
  assert.equal(jobs.zenx.if, "${{ always() }}");
  assert.match(jobs.zenx.steps[0].run, /CHECK_RESULT.*success/);
  assert.match(jobs.zenx.steps[0].run, /UI_RESULT.*success/);
  for (const job of [jobs["zenx-check"], jobs["zenx-ui"], jobs.zenx]) {
    assert.equal(job["continue-on-error"], undefined);
    assert.equal(job.permissions, undefined);
    for (const step of job.steps)
      assert.equal(step["continue-on-error"], undefined);
  }
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
});

test("aggregate stays observed and preview commands do not occupy its runner", () => {
  const check = workflow.jobs["zenx-check"];
  const aggregate = check.steps.find(
    (step) => step.run === "npm --workspace apps/zenx run check:observed",
  );
  assert.ok(aggregate);
  assert.equal(
    aggregate.env.ZENX_TEST_EXECUTION_TRACE_FILE,
    "${{ runner.temp }}/zenx-test-execution.ndjson",
  );
  assert.ok(aggregate["timeout-minutes"] < check["timeout-minutes"]);
  assert.ok(!check.steps.some((step) => step.run?.includes("capture-")));
  const ui = workflow.jobs["zenx-ui"];
  assert.ok(
    ui.steps.some((step) =>
      step.run?.includes("capture-trigger-management-preview"),
    ),
  );
  assert.ok(!ui.steps.some((step) => step.run?.includes("check:observed")));
  for (const job of [check, ui]) {
    assert.ok(
      job.steps.some((step) => step.run?.includes("write-ci-provenance.mjs")),
    );
    const upload = job.steps.find(
      (step) => step.name === "Retain exact checkout provenance",
    );
    assert.equal(upload.if, "${{ always() }}");
    assert.match(upload.with.name, /github.run_attempt/);
  }
});

test("compatibility gate rejects failed, cancelled, skipped or missing lane outcomes", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const check of ["success", "failure", "cancelled", "skipped", ""]) {
    for (const ui of ["success", "failure", "cancelled", "skipped", ""]) {
      const result = spawnSync(
        "bash",
        ["-e", "-c", workflow.jobs.zenx.steps[0].run],
        {
          env: { ...process.env, CHECK_RESULT: check, UI_RESULT: ui },
        },
      );
      assert.equal(
        result.status === 0,
        check === "success" && ui === "success",
      );
    }
  }
});

test("provenance binds head/base and actual checkout without collecting arbitrary environment", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { execFileSync } = await import("node:child_process");
  const { writeProvenance } =
    await import("../../../scripts/write-ci-provenance.mjs");
  const directory = mkdtempSync(join(tmpdir(), "zen-ci-provenance-"));
  const cwd = fileURLToPath(new URL("../../../", import.meta.url));
  try {
    const destination = join(directory, "receipt.json");
    const receipt = writeProvenance(destination, {
      cwd,
      env: {
        CI_HEAD_SHA: "head",
        CI_BASE_SHA: "base",
        GITHUB_SHA: "merge",
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "2",
        SECRET_NOT_ALLOWED: "sentinel",
      },
    });
    assert.equal(receipt.headSha, "head");
    assert.equal(receipt.baseSha, "base");
    assert.equal(receipt.eventSha, "merge");
    assert.equal(
      receipt.checkoutSha,
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd,
        encoding: "utf8",
      }).trim(),
    );
    assert.equal(
      receipt.checkoutTree,
      execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
        cwd,
        encoding: "utf8",
      }).trim(),
    );
    assert.match(receipt.lockSha256, /^[a-f0-9]{64}$/);
    assert.equal(receipt.runAttempt, "2");
    assert.ok(!readFileSync(destination, "utf8").includes("sentinel"));
    assert.throws(() => writeProvenance(destination, { cwd, env: {} }), {
      code: "EEXIST",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pending steer browser matrix and failure artifacts stay in the synthetic UI lane", () => {
  const steps = workflow.jobs["zenx-ui"].steps;
  const capture = steps.find(
    (s) =>
      s.name === "Verify pending steer previews against canonical messages",
  );
  assert.ok(capture);
  assert.equal(capture["timeout-minutes"], 5);
  assert.match(capture.if, /!cancelled\(\)/);
  assert.match(capture.if, /zenx-dependencies/);
  assert.match(capture.if, /zenx-fonts/);
  for (const path of [
    "tsconfig.steer-image-preview.json",
    "steer-image-geometry.test.mjs",
    "build-steer-image-preview.mjs",
    "capture-steer-image-preview.mjs",
  ])
    assert.ok(capture.run.includes(path));
  const artifact = steps.find(
    (s) => s.name === "Retain synthetic steer image evidence",
  );
  assert.ok(artifact);
  assert.equal(
    artifact.if,
    "${{ matrix.shard == 'conversation' && always() }}",
  );
  assert.deepEqual(workflow.jobs["zenx-ui"].strategy.matrix.shard, [
    "overflow",
    "layout",
    "conversation",
  ]);
  assert.match(capture.if, /matrix\.shard == 'conversation'/);
  assert.equal(
    steps.filter((s) => s.run?.includes("capture-steer-image-preview.mjs"))
      .length,
    1,
  );
  assert.equal(
    steps.filter((s) => s.with?.name === artifact.with.name).length,
    1,
  );
  assert.equal(artifact.with.path, "${{ runner.temp }}/zenx-steer-image");
  assert.equal(artifact.with["retention-days"], 14);
  assert.ok(
    !workflow.jobs["zenx-check"].steps.some((s) =>
      s.run?.includes("capture-steer-image-preview.mjs"),
    ),
  );
});
