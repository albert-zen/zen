import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

test("native startup CI reuses the single downstream portable package and retains failure evidence", () => {
  const workflow = parse(
    readFileSync(
      new URL("../../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  const jobs = Object.values(workflow.jobs);
  const owners = jobs.filter((job) =>
    job.steps.some((step) =>
      step.run?.includes("windows-startup-acceptance.ps1"),
    ),
  );
  assert.equal(owners.length, 1);
  const owner = owners[0];
  assert.equal(owner["runs-on"], "windows-2025");
  const packageIndex = owner.steps.findIndex((step) =>
    step.run?.includes("run package:portable -- --downstream "),
  );
  const startupIndex = owner.steps.findIndex((step) =>
    step.run?.includes("windows-startup-acceptance.ps1"),
  );
  assert(packageIndex >= 0 && startupIndex > packageIndex);
  assert.match(
    owner.steps[startupIndex].run,
    /-PackageDirectory "apps\/zenx\/\.packaged\/artifact\/ZenX-win32-x64"/u,
  );
  const upload = owner.steps.find(
    (step) => step.with?.name === "zenx-windows-startup-evidence",
  );
  assert.equal(upload?.if, "${{ always() }}");
  assert.equal(upload.with.path, "apps/zenx/.packaged/startup-evidence");
  assert.equal(
    workflow.jobs["zenx-windows-project-workspace-smoke"],
    undefined,
  );
});

test(
  "PowerShell harness rejects invalid visible windows and attempts every owned-process cleanup",
  {
    skip:
      process.platform !== "win32"
        ? "PowerShell/Windows-only harness check"
        : false,
  },
  () => {
    const result = execFileSync(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        fileURLToPath(
          new URL(
            "./fixtures/startup-acceptance/check-harness.ps1",
            import.meta.url,
          ),
        ),
        "-HarnessPath",
        fileURLToPath(
          new URL("../scripts/windows-startup-acceptance.ps1", import.meta.url),
        ),
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.match(result, /Startup harness helper checks passed/u);
  },
);
