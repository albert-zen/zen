import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";
import { lanes } from "../../../scripts/ci-risk-selection.mjs";
const read = (p) =>
  readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
const ci = parse(read(".github/workflows/ci.yml"));
function evaluate(expression, event, result, tier, mode, version = "1") {
  return Function(
    "github",
    "needs",
    `return ${expression.slice(3, -2).replace(/needs.selection.outputs.([\w-]+)/g, (_, k) => `needs.selection.outputs[${JSON.stringify(k)}]`)}`,
  )(
    { event_name: event },
    {
      selection: {
        result,
        outputs: {
          tier,
          "policy-version": version,
          ...Object.fromEntries(lanes.map((l) => [l + "-mode", mode])),
        },
      },
    },
  );
}
test("all PR states use risk work; ready events are explicit and no draft gate exists", () => {
  assert.deepEqual(ci.on.pull_request.types, [
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
  ]);
  assert.doesNotMatch(read(".github/workflows/ci.yml"), /pull_request\.draft/);
  assert.deepEqual(ci.jobs.zenx.needs, ["zenx-check", "zenx-ui"]);
  assert.equal(ci.jobs.zenx.if, "${{ always() }}");
  assert.equal(ci.jobs.coverage.if, "${{ always() }}");
});
test("typed omission requires matching tier, successful selector and PR event", () => {
  for (const [id, job] of Object.entries(ci.jobs)) {
    if (!job.env?.CI_RUN_FULL) continue;
    for (const expression of [
      job.env.CI_RUN_FULL,
      ...(job.env.CI_FULL_AGGREGATE ? [job.env.CI_FULL_AGGREGATE] : []),
    ])
      for (const event of ["pull_request", "push", "workflow_dispatch"])
        for (const result of ["success", "failure", "cancelled", "skipped", ""])
          for (const tier of [
            "pr-risk",
            "documentation",
            "full",
            "",
            undefined,
          ])
            for (const mode of [
              "run",
              "omit-pr-risk",
              "omit-docs",
              "false",
              "unknown",
              undefined,
            ]) {
              const omit =
                event === "pull_request" &&
                result === "success" &&
                ((tier === "pr-risk" && mode === "omit-pr-risk") ||
                  (tier === "documentation" && mode === "omit-docs"));
              assert.equal(
                evaluate(expression, event, result, tier, mode),
                !omit,
                id,
              );
            }
    assert.equal(
      evaluate(
        job.env.CI_RUN_FULL,
        "pull_request",
        "success",
        "pr-risk",
        "omit-pr-risk",
        null,
      ),
      true,
    );
    assert.equal(job.steps.at(-2).if, "${{ always() }}");
    assert.equal(job.steps.at(-2).run, 'test "$SELECTION_RESULT" = success');
  }
});
test("PR unit runner is bound to current plan; full original aggregate remains unfiltered", () => {
  const job = ci.jobs["zenx-check"];
  const full = job.steps.find(
    (s) => s.run === "npm --workspace apps/zenx run check:observed",
  );
  assert.match(full.if, /CI_FULL_AGGREGATE == 'true'/);
  const quick = job.steps.find((s) =>
    s.run?.includes("run-ci-quick-tests.mjs"),
  );
  assert.match(quick.if, /CI_FULL_AGGREGATE != 'true'/);
  assert.equal(
    quick.env.CI_PLAN_DIGEST,
    "${{ needs.selection.outputs.plan-digest }}",
  );
  assert.equal(quick.env.CI_CHECKOUT_SHA, "${{ github.sha }}");
  assert.equal(job.steps[0].with["fetch-depth"], 0);
  const upload = job.steps.find(
    (s) => s.name === "Retain current-run PR unit receipt",
  );
  assert.match(
    upload.with.name,
    /github.sha.*github.run_id.*github.run_attempt/,
  );
  assert.equal(upload.with["if-no-files-found"], "error");
  const scripts = JSON.parse(read("apps/zenx/package.json")).scripts;
  assert.equal(
    scripts["check:observed"],
    "npm run brand:check && npm run prepare:first-party-plugins && npm run typecheck:prepared && npm run test:prepared:observed && npm run build:prepared",
  );
});
test("coverage gate rejects unknown/contradictory outputs and validates the current tier", () => {
  const step = ci.jobs.coverage.steps[0];
  const outputs = {
    "policy-version": "1",
    "plan-digest": "a".repeat(64),
    tier: "pr-risk",
    "docs-only": "false",
    ...Object.fromEntries(
      lanes.map((l) => [l + "-mode", l === "quick" ? "run" : "omit-pr-risk"]),
    ),
  };
  const run = (output, event = "pull_request") =>
    spawnSync("bash", ["-e", "-c", step.run], {
      env: {
        ...process.env,
        CI_EVENT: event,
        EXPECTED_JOBS: step.env.EXPECTED_JOBS,
        RESULTS: JSON.stringify(
          Object.fromEntries(
            ci.jobs.coverage.needs.map((id) => [
              id,
              {
                result: "success",
                ...(id === "selection" ? { outputs: output } : {}),
              },
            ]),
          ),
        ),
      },
    }).status;
  assert.equal(run(outputs), 0);
  assert.notEqual(run(outputs, "push"), 0);
  for (const key of Object.keys(outputs)) {
    const missing = { ...outputs };
    delete missing[key];
    assert.notEqual(run(missing), 0, key);
  }
  for (const lane of lanes)
    assert.notEqual(run({ ...outputs, [lane + "-mode"]: "false" }), 0, lane);
  assert.notEqual(run({ ...outputs, "aggregate-mode": "run" }), 0);
  assert.notEqual(run({ ...outputs, "quick-mode": "omit-pr-risk" }), 0);
});

test("arbitrary changed tests retain original dependency lifecycle and prepared plugin inputs", () => {
  const steps = ci.jobs["zenx-check"].steps;
  assert.equal(
    steps.find((step) => step.id === "zenx-dependencies").run,
    "npm ci",
  );
  assert.ok(
    steps.some(
      (step) =>
        step.run ===
          "npm --workspace apps/zenx run prepare:first-party-plugins" &&
        step.if.includes("CI_FULL_AGGREGATE != 'true'"),
    ),
  );
  const smoke = read("apps/zenx/src/main/workspace-browser-smoke.ts");
  assert.match(smoke, /renderer\/src\/workspace-browser-panel/);
});
