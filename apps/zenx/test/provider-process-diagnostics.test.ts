import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SystemExternalProviderProcessRunner } from "../src/main/capabilities/external-provider.js";
import { SpawnWinAppCliRunner } from "../src/main/capabilities/windows-computer-provider.js";
import { createProviderProcessDiagnosticReporter } from "../src/main/capabilities/provider-process-diagnostics.js";

for (const kind of ["external", "windows"] as const)
  test(`${kind} helper preserves owner stderr while keeping model error cleaned`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-provider-diagnostic-"),
    );
    try {
      const report = createProviderProcessDiagnosticReporter(directory);
      const runner =
        kind === "external"
          ? new SystemExternalProviderProcessRunner(undefined, report)
          : new SpawnWinAppCliRunner(report);
      await assert.rejects(
        runner.run(
          process.execPath,
          [
            "-e",
            "process.stderr.write('Bearer synthetic-helper-secret');process.stdout.write('synthetic output');process.exit(2)",
          ],
          { timeoutMs: 5000, redactions: ["synthetic-helper-secret"] },
        ),
        (error) => {
          assert.doesNotMatch(
            (error as Error).message,
            /synthetic-helper-secret/,
          );
          return true;
        },
      );
      const records = await readFile(
        path.join(directory, "diagnostics", "provider-process.jsonl"),
        "utf8",
      );
      assert.match(records, /synthetic-helper-secret/);
      assert.match(records, /synthetic output/);
      assert.doesNotMatch(records, /process.stderr.write/); // arguments are not captured
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
test("failed diagnostic sink cannot alter helper rejection or hang process settlement", async () => {
  const runner = new SystemExternalProviderProcessRunner(
    undefined,
    async () => {
      throw new Error("synthetic log failure");
    },
  );
  await assert.rejects(
    runner.run(process.execPath, ["-e", "process.exit(4)"], {
      timeoutMs: 5000,
    }),
    /failed \(4\)/,
  );
});
