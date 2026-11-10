// The pure helper suite also runs under the standard ZenX test glob.
import "../../../scripts/desktop-archive-cache.test.mjs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const read = (p) =>
  readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
const action = "./.github/actions/desktop-archive-cache";
const composite = parse(
  read(".github/actions/desktop-archive-cache/action.yml"),
);
const workflows = readdirSync(
  new URL("../../../.github/workflows", import.meta.url),
).filter((p) => p.endsWith(".yml"));
const rootInstall = (step, job) =>
  /^npm ci(?:\s|$)/mu.test(step.run || "") &&
  !step.run.includes("--ignore-scripts") &&
  (step["working-directory"] ??
    job.defaults?.run?.["working-directory"] ??
    ".") === ".";

test("every root npm ci entry prepares potential archive consumers and verifies before saving", () => {
  let count = 0;
  let main = 0;
  for (const file of workflows) {
    const workflow = parse(read(`.github/workflows/${file}`));
    for (const [id, job] of Object.entries(workflow.jobs || {})) {
      const index = job.steps?.findIndex((s) => rootInstall(s, job)) ?? -1;
      const cacheSteps = job.steps?.filter((s) => s.uses === action) ?? [];
      if (index < 0) {
        assert.equal(
          cacheSteps.length,
          0,
          `${file}/${id} should not cache unused archives`,
        );
        continue;
      }
      count++;
      if (file === "ci.yml") main++;
      assert.equal(cacheSteps.length, 2, `${file}/${id}`);
      const restore = cacheSteps.find((s) => s.with.phase === "restore");
      const save = cacheSteps.find((s) => s.with.phase === "save");
      assert.equal(restore.id, "desktop-archives");
      assert.ok(job.steps.indexOf(restore) < index);
      assert.ok(
        job.steps
          .slice(0, job.steps.indexOf(restore))
          .some((s) => s.uses?.startsWith("actions/checkout@")),
      );
      assert.ok(
        job.steps
          .slice(0, job.steps.indexOf(restore))
          .some((s) => s.uses?.startsWith("actions/setup-node@")),
      );
      assert.equal(restore.if, job.steps[index].if);
      assert.ok(job.steps.indexOf(save) > index);
      assert.match(
        save.if,
        /always\(\).*steps\.desktop-archives\.outcome == 'success'/u,
      );
      assert.equal(
        save.with["electron-cache-hit"],
        "${{ steps.desktop-archives.outputs.electron-cache-hit }}",
      );
      assert.equal(
        save.with["rtk-cache-hit"],
        "${{ steps.desktop-archives.outputs.rtk-cache-hit }}",
      );
      if (job.env?.CI_RUN_FULL)
        assert.match(save.if, /^\$\{\{ env.CI_RUN_FULL == 'true' && /u);
    }
  }
  assert.ok(count >= 32, "new root installers are discovered automatically");
  assert.equal(
    main,
    9,
    "includes Android root install despite its mobile default directory",
  );
});

test("archive persistence is exact-key exact-file and save is independently checksum gated", () => {
  const steps = composite.runs.steps;
  for (const step of steps.filter((s) => s.run)) {
    assert.equal(step["working-directory"], "${{ github.workspace }}");
    assert.equal(step.shell, "bash");
  }
  const plan = steps.findIndex((s) => s.id === "plan");
  for (const kind of ["electron", "rtk"]) {
    const restore = steps.find((s) => s.id === `${kind}-restore`);
    const save = steps.find(
      (s) =>
        s.uses === "actions/cache/save@v4" &&
        s.with.key.includes(`${kind}-key`),
    );
    assert.ok(plan < steps.indexOf(restore));
    assert.equal(
      restore.with.path,
      `\u0024{{ steps.plan.outputs.${kind}-path }}`,
    );
    assert.equal(save.with.path, restore.with.path);
    assert.equal(save.with.key, restore.with.key);
    assert.equal(restore.with["restore-keys"], undefined);
    assert.match(
      save.if,
      new RegExp(`steps.verified.outputs.${kind}-verified == 'true'`),
    );
    assert.ok(
      steps.findIndex((s) => s.id === "verified") < steps.indexOf(save),
    );
  }
  assert.ok(
    steps.some(
      (s) => s.run === "node scripts/desktop-archive-cache.mjs restored",
    ),
  );
  assert.ok(
    steps.some((s) => s.run === "node scripts/desktop-archive-cache.mjs save"),
  );
  assert.doesNotMatch(
    JSON.stringify(composite),
    /continue-on-error|node_modules|\.partial|sha256\/\*/u,
  );
});
