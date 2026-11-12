import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";
const read = (path) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const ci = parse(read(".github/workflows/ci.yml"));
const full =
  "${{ github.event_name != 'pull_request' || needs.selection.result != 'success' || needs.selection.outputs.docs-only != 'true' }}";
const heavy = [
  "core-cli-imzen",
  "zenx-check",
  "zenx-ui",
  "zenx-capability-smoke",
  "zenx-windows-computer-smoke",
  "zenx-windows-packaged-provider-smoke",
  "zenx-windows-user-browser-smoke",
  "zenx-playwright-provider-smoke",
  "android-mobile",
];

test("selection never prevents named checks or individual UI shards from being emitted", () => {
  assert.deepEqual(ci.on.pull_request.types, [
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
  ]);
  assert.equal(ci.on.workflow_dispatch, null);
  assert.deepEqual(ci.on.push.branches, ["main"]);
  for (const id of heavy) {
    const job = ci.jobs[id];
    assert.equal(job.needs, "selection");
    assert.equal(job.if, "${{ !cancelled() }}");
    assert.match(job.env.CI_RUN_FULL, /needs.selection.result != 'success'/);
    assert.match(job.env.CI_RUN_FULL, /omit-docs/);
    assert.match(job.env.CI_RUN_FULL, /policy-version/);
    const requiredDecision = job.steps.at(-2);
    assert.equal(
      requiredDecision.name,
      "Require successful workload selection",
    );
    assert.equal(requiredDecision.if, "${{ always() }}");
    assert.equal(requiredDecision["working-directory"], "${{ runner.temp }}");
    for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
      const outcome = spawnSync("bash", ["-e", "-c", requiredDecision.run], {
        env: { ...process.env, SELECTION_RESULT: result },
      });
      assert.equal(outcome.status === 0, result === "success");
    }
    const receipt = job.steps.at(-1);
    assert.equal(receipt.if, "${{ env.CI_RUN_FULL != 'true' }}");
    assert.equal(receipt["working-directory"], "${{ runner.temp }}");
    assert.match(
      receipt.run,
      /no product, native, browser or build acceptance/,
    );
    for (const step of job.steps.slice(0, -2))
      assert.match(step.if, /^\$\{\{ env.CI_RUN_FULL == 'true'/);
  }
  assert.deepEqual(ci.jobs["zenx-ui"].strategy.matrix.shard, [
    "overflow",
    "layout",
    "conversation",
  ]);
  assert.equal(ci.jobs.zenx.name, "ZenX typecheck, tests, and build");
  assert.deepEqual(ci.jobs.zenx.needs, ["zenx-check", "zenx-ui"]);
});

test("missing or failed selection, main and manual events cannot suppress heavy work", () => {
  const expression = full.slice(3, -2).trim();
  for (const event of [
    "pull_request",
    "push",
    "workflow_dispatch",
    "merge_group",
  ])
    for (const result of ["success", "failure", "cancelled", "skipped", ""])
      for (const docs of ["true", "false", "", undefined]) {
        const github = { event_name: event };
        const needs = { selection: { result, outputs: { "docs-only": docs } } };
        const evaluated = Function(
          "github",
          "needs",
          `return ${expression.replaceAll("needs.selection.outputs.docs-only", 'needs.selection.outputs["docs-only"]')}`,
        )(github, needs);
        assert.equal(
          evaluated,
          !(
            event === "pull_request" &&
            result === "success" &&
            docs === "true"
          ),
        );
      }
});

test("selection verifies contracts, checkout identity and formatting before authorizing no-op checks", () => {
  const job = ci.jobs.selection;
  assert.ok(
    !job.steps.some(
      (step) => step.name === "Record deliberate documentation-only omission",
    ),
  );
  assert.equal(job.steps[0].with["fetch-depth"], 0);
  assert.equal(job.steps[0].with["persist-credentials"], false);
  const select = job.steps.find((step) => step.id === "select");
  assert.equal(select.env.CI_CHECKOUT_SHA, "${{ github.sha }}");
  assert.equal(
    job.outputs["docs-only"],
    "${{ steps.select.outputs.docs-only }}",
  );
  assert.ok(
    job.steps.some((step) => step.run?.includes("ci-docs-selection.test.mjs")),
  );
  assert.ok(
    job.steps.some(
      (step) => step.run === "npm ci --ignore-scripts --no-audit --no-fund",
    ),
  );
  assert.ok(
    job.steps.some(
      (step) => step.run === "npx --no-install prettier --check .",
    ),
  );
  for (const step of job.steps)
    assert.equal(step["continue-on-error"], undefined);
});

test("coverage gate always reports and rejects every missing/failed/cancelled/skipped dependency", () => {
  const gate = ci.jobs.coverage;
  assert.equal(gate.if, "${{ always() }}");
  assert.deepEqual(
    [...gate.needs].sort(),
    Object.keys(ci.jobs)
      .filter((id) => id !== "coverage")
      .sort(),
  );
  const run = (results) =>
    spawnSync("bash", ["-e", "-c", gate.steps[0].run], {
      env: {
        ...process.env,
        RESULTS: JSON.stringify(results),
        EXPECTED_JOBS: gate.steps[0].env.EXPECTED_JOBS,
        CI_EVENT: "push",
      },
    }).status;
  const success = Object.fromEntries(
    gate.needs.map((id) => [id, { result: "success" }]),
  );
  success.selection.outputs = {
    "policy-version": "1",
    "plan-digest": "a".repeat(64),
    tier: "full",
    "docs-only": "false",
    ...Object.fromEntries(
      [
        "quick",
        "aggregate",
        "core",
        "ui",
        "capability",
        "windows-computer",
        "windows-packaged",
        "windows-browser",
        "playwright",
        "android",
      ].map((lane) => [lane + "-mode", "run"]),
    ),
  };
  assert.equal(run(success), 0);
  for (const id of gate.needs)
    for (const result of ["failure", "cancelled", "skipped", ""])
      assert.notEqual(run({ ...success, [id]: { result } }), 0);
  for (const id of gate.needs) {
    const missing = { ...success };
    delete missing[id];
    assert.notEqual(run(missing), 0);
  }
  assert.notEqual(run({}), 0);
});

test("fast feedback preserves formatting while omitting only docs typecheck setup", () => {
  const fast = parse(read(".github/workflows/fast-feedback.yml"));
  const steps = fast.jobs.static.steps;
  assert.equal(
    steps.find((step) => step.id === "sdk").if,
    "${{ steps.selection.outputs.docs-only != 'true' }}",
  );
  assert.match(
    steps.find((step) => step.run === "npm run typecheck").if,
    /steps.selection.outputs.docs-only != 'true'/,
  );
  assert.doesNotMatch(
    steps.find((step) => step.run === "npx --no-install prettier --check .").if,
    /docs-only/,
  );
});
