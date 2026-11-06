import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// CI-only observation, never a source of execution authorization or test results.
export function writeProvenance(
  destination,
  { cwd = process.cwd(), env = process.env } = {},
) {
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const receipt = {
    schemaVersion: 1,
    event: env.GITHUB_EVENT_NAME ?? null,
    headSha: env.CI_HEAD_SHA || null,
    baseSha: env.CI_BASE_SHA || null,
    eventSha: env.GITHUB_SHA || null,
    checkoutSha: git("rev-parse", "HEAD"),
    checkoutTree: git("rev-parse", "HEAD^{tree}"),
    runId: env.GITHUB_RUN_ID ?? null,
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
    job: env.GITHUB_JOB ?? null,
    runnerOS: env.RUNNER_OS ?? process.platform,
    runnerArch: env.RUNNER_ARCH ?? process.arch,
    lockSha256: createHash("sha256")
      .update(readFileSync(resolve(cwd, "package-lock.json")))
      .digest("hex"),
  };
  writeFileSync(destination, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
  });
  return receipt;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.argv[2]) throw new Error("A provenance output path is required");
  writeProvenance(process.argv[2]);
}
