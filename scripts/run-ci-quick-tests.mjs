import { spawnSync } from "node:child_process";
import { lstatSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isTestPath,
  planDigest,
  riskOptions,
  selectRisk,
} from "./ci-risk-selection.mjs";

export function runQuickTests(
  destination,
  { cwd = process.cwd(), env = process.env, spawn = spawnSync } = {},
) {
  const report = selectRisk({ ...riskOptions(env), cwd });
  const digest = planDigest(report);
  if (
    report.tier !== "pr-risk" ||
    digest !== env.CI_PLAN_DIGEST ||
    !report.quickTests.length
  )
    throw new Error("Missing or mismatched current-run PR risk plan");
  for (const file of report.quickTests) {
    if (
      !isTestPath(file) ||
      !lstatSync(resolve(cwd, file)).isFile() ||
      lstatSync(resolve(cwd, file)).isSymbolicLink()
    )
      throw new Error(`Invalid selected test: ${file}`);
  }
  const started = Date.now();
  console.log(
    `Running ${report.quickTests.length} explicit PR unit files; no test-name filters or full-aggregate claim.`,
  );
  const result = spawn(
    process.execPath,
    ["--import", "tsx", "--test", ...report.quickTests],
    { cwd, env, stdio: "inherit" },
  );
  const receipt = {
    schemaVersion: 1,
    tier: report.tier,
    planDigest: digest,
    checkoutSha: report.checkoutSha,
    runId: report.runId,
    runAttempt: report.runAttempt,
    files: report.quickTests,
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    error: result.error?.message || null,
    durationMs: Date.now() - started,
  };
  writeFileSync(destination, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
  });
  return result.status === 0 && !result.signal && !result.error ? 0 : 1;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.argv[2]) throw new Error("A receipt path is required");
  process.exitCode = runQuickTests(process.argv[2]);
}
