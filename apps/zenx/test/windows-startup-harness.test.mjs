import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
