import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

test("mock startup boundary does not start a C# compiler inside the assertion deadline", () => {
  const source = readFileSync(
    new URL("./fixtures/startup-acceptance/check-harness.ps1", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /Add-Type|DllImport|Start-Process/u);
  assert.match(source, /class StartupWindows \{/u);
  assert.match(
    source,
    /static \[long\[\]\] Visible\(\[uint32\] \$ProcessId\) \{ return \[StartupWindows\]::Handles \}/u,
  );
  assert.match(
    source,
    /static \[bool\] IsIconic\(\[IntPtr\] \$WindowHandle\) \{ return \[StartupWindows\]::Minimized \}/u,
  );
  assert.match(source, /Write-Phase "mock-boundary-ready"/u);
});

test("secondary failure state is captured before cleanup without replacing the original error", () => {
  const source = readFileSync(
    new URL("../scripts/windows-startup-acceptance.ps1", import.meta.url),
    "utf8",
  );
  assert.match(source, /function Get-OwnedProcessState\(\$Process\)/u);
  assert.match(source, /\$state\.hasExited = \$Process\.HasExited/u);
  assert.match(
    source,
    /if \(\$state\.hasExited\) \{ \$state\.exitCode = \$Process\.ExitCode \}/u,
  );
  assert.match(
    source,
    /catch \{ \$state\.observationError = \$_\.Exception\.Message \}/u,
  );
  assert.match(
    source,
    /\$sample\.error = \$_\.Exception\.Message\s+\$sample\.secondaryAtFailure = Get-OwnedProcessState \$secondary\s+\} finally \{\s+\$sample\.cleanupErrors = @\(Stop-OwnedFixtures/u,
  );
  assert.match(
    source,
    /if \(\$null -ne \$scenarioFailure\) \{ throw \$scenarioFailure \}/u,
  );
  assert.match(source, /\$deadline = \[DateTime\]::UtcNow\.AddSeconds\(120\)/u);
  assert.match(
    source,
    /\$activation = Wait-Event \$directory \$primary "second-instance"/u,
  );
});

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
  (t) => {
    let result;
    try {
      result = execFileSync(
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
            new URL(
              "../scripts/windows-startup-acceptance.ps1",
              import.meta.url,
            ),
          ),
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
    } catch (error) {
      for (const stream of ["stdout", "stderr"]) {
        t.diagnostic(
          `${stream}: ${String(error[stream] ?? "").slice(-16_384)}`,
        );
      }
      throw error;
    }
    assert.match(result, /Startup harness helper checks passed/u);
  },
);

test("startup event readers share live writes and retain strict complete-line parsing", () => {
  const harness = readFileSync(
    new URL("../scripts/windows-startup-acceptance.ps1", import.meta.url),
    "utf8",
  );
  assert.match(harness, /\[IO\.FileShare\]::ReadWrite/u);
  assert.doesNotMatch(harness, /\[IO\.File\]::ReadAllText/u);
  assert.match(harness, /finally \{ \$reader\.Dispose\(\) \}/u);
  assert.match(harness, /\$raw = Read-SharedText \$file/u);
  assert.match(harness, /\$text = Read-SharedText \$file/u);
  assert.match(harness, /\$i -lt \$lines\.Length - 1/u);
  assert.match(harness, /\$lines\[\$i\] \| ConvertFrom-Json/u);
});

test(
  "Windows event reader permits real Node appends without accepting malformed complete lines",
  { skip: process.platform !== "win32" ? "Windows file-sharing check" : false },
  () => {
    const result = execFileSync(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        fileURLToPath(
          new URL(
            "./fixtures/startup-acceptance/check-event-reader.ps1",
            import.meta.url,
          ),
        ),
        "-HarnessPath",
        fileURLToPath(
          new URL("../scripts/windows-startup-acceptance.ps1", import.meta.url),
        ),
        "-NodeExecutable",
        process.execPath,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assert.match(result, /Startup event reader sharing checks passed/u);
  },
);
