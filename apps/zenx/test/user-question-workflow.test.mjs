import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    new URL("../../../.github/workflows/user-question-ui.yml", import.meta.url),
    "utf8",
  ),
);

test("native question acceptance retains full-App evidence on supported Intel macOS", () => {
  const job = workflow.jobs["native-question"];
  assert.equal(job["runs-on"], "macos-15-intel");
  assert.equal(job["timeout-minutes"], 18);
  assert.equal(job["continue-on-error"], undefined);
  assert.ok(
    job.steps.some(
      (step) => step.run === "npm run build --workspace @zen/zenx",
    ),
  );
  const capture = job.steps.find((step) =>
    step.run?.includes("launch-user-question-acceptance.mjs"),
  );
  assert.equal(
    capture.run,
    'node apps/zenx/scripts/launch-user-question-acceptance.mjs "${{ runner.temp }}/user-question-ui" origin',
  );
  assert.equal(capture["timeout-minutes"], 6);
  assert.equal(capture["continue-on-error"], undefined);
  const upload = job.steps.find(
    (step) => step.uses === "actions/upload-artifact@v4",
  );
  assert.equal(upload.if, "always()");
  assert.equal(upload.with["if-no-files-found"], "error");
  for (const file of [
    "source.json",
    "acceptance.json",
    "lifecycle.json",
    "*.png",
  ])
    assert.ok(upload.with.path.includes(file));
});
