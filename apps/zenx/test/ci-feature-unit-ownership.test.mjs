import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const selected = {
  "answered-question-ui.yml": [
    "Native answer provenance and real renderer interactions",
  ],
  "quote-bubble-ui.yml": [
    "Exact identity, missing sources and recycled virtual rows",
  ],
  "information-content-ui.yml": [
    "Content visibility, draft hints and control interactions",
  ],
  "native-history.yml": [
    "Verify page merge, source navigation, drafts and reconnect",
  ],
};

for (const [file, names] of Object.entries(selected)) {
  test(`${file}: only duplicate Linux unit tests defer to aggregate on PRs`, () => {
    const workflow = parse(read(`.github/workflows/${file}`));
    assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
    assert.ok(Object.hasOwn(workflow.on, "pull_request"));
    const jobs = Object.values(workflow.jobs);
    assert.equal(jobs.length, 1);
    assert.match(jobs[0]["runs-on"], /^ubuntu-/);
    const steps = jobs[0].steps;
    for (const name of names) {
      const matches = steps.filter((step) => step.name === name);
      assert.equal(matches.length, 1);
      const step = matches[0];
      assert.equal(step.if, "${{ github.event_name == 'workflow_dispatch' }}");
      assert.equal(step.env, undefined);
      assert.equal(step["continue-on-error"], undefined);
      assert.match(step.run, /^node --import tsx --test /);
      // These are explicit top-level files in ZenX's always-on aggregate glob,
      // not platform-native scripts or a filtered replacement for a full suite.
      const files = step.run.match(
        /apps\/zenx\/test\/[\w-]+\.test\.(?:ts|mjs)/g,
      );
      assert.ok(files?.length);
      for (const path of files)
        assert.ok(existsSync(new URL(path, root)), path);
      assert.equal(
        step.run
          .replace(/apps\/zenx\/test\/[\w-]+\.test\.(?:ts|mjs)/g, "")
          .replace(/^node --import tsx --test /, "")
          .replace(/--test-name-pattern='[^']*'/, "")
          .trim(),
        "",
      );
    }
    const captures = steps.filter((step) =>
      /scripts\/(?:build|capture|measure)-/.test(step.run ?? ""),
    );
    assert.ok(captures.length);
    for (const step of captures) assert.equal(step.if, undefined);
    assert.ok(
      steps.some((step) => step.uses?.startsWith("actions/upload-artifact@")),
    );
  });
}

test("CI preserves the full ZenX suite on main/manual and explicit PR unit policy", () => {
  const ci = parse(read(".github/workflows/ci.yml"));
  assert.ok(ci.on.pull_request.types.includes("ready_for_review"));
  assert.deepEqual(ci.on.push.branches, ["main"]);
  const owners = Object.values(ci.jobs).filter((job) =>
    job.steps?.some(
      (step) => step.run === "npm --workspace apps/zenx run check:observed",
    ),
  );
  assert.equal(owners.length, 1);
  assert.ok(
    owners[0].steps.some(
      (step) =>
        step.run === "npm --workspace apps/zenx run check:observed" &&
        step.if.includes("CI_FULL_AGGREGATE"),
    ),
  );
  assert.ok(
    owners[0].steps.some((step) =>
      step.run?.includes("run-ci-quick-tests.mjs"),
    ),
  );
  assert.equal(owners[0].if, "${{ !cancelled() }}");
  assert.equal(owners[0].needs, "selection");
  assert.match(
    owners[0].env.CI_RUN_FULL,
    /needs.selection.result != 'success'/,
  );
  assert.match(owners[0]["runs-on"], /^ubuntu-/);
  const scripts = JSON.parse(read("apps/zenx/package.json")).scripts;
  assert.match(scripts["check:observed"], /npm run test:prepared:observed/);
  assert.match(
    scripts["test:prepared:observed"],
    /test\/\*\*\/\*\.test\.ts test\/\*\*\/\*\.test\.mjs$/,
  );
  assert.doesNotMatch(scripts["test:prepared:observed"], /test-name-pattern/);
});

test("focused real Host integration remains independent of the aggregate", () => {
  const workflow = parse(read(".github/workflows/information-content-ui.yml"));
  const step = workflow.jobs["information-content"].steps.find(
    (value) =>
      value.name ===
      "Real Host questions survive hiding every managed information widget",
  );
  assert.ok(step);
  assert.equal(step.if, undefined);
  assert.match(
    step.run,
    /--test-name-pattern='real Host questions render in full App information panel'/,
  );
});
