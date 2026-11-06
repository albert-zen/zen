import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Observation only: this report must never control required jobs or test selection.
export function planImpact(base, head, { cwd = process.cwd() } = {}) {
  const report = {
    schemaVersion: 1,
    mode: "shadow-only",
    fullAcceptanceRequired: true,
    baseSha: base || null,
    headSha: head || null,
    rangeSemantics:
      "pinned base-to-head endpoint diff (not a changed-file API)",
    fallback: true,
    reasons: [],
    candidateLanes: ["full"],
    paths: [],
  };
  try {
    if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ""))) {
      throw new Error("Missing or invalid pinned commit SHA");
    }
    const git = (...args) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    for (const sha of [base, head]) git("cat-file", "-e", `${sha}^{commit}`);
    report.checkoutSha = git("rev-parse", "HEAD").trim();
    // Disabling rename detection keeps BOTH old and new paths. NUL delimiters
    // preserve whitespace/newlines. Buffer overflow fails closed, never truncates.
    report.paths = git(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      base,
      head,
      "--",
    )
      .split("\0")
      .filter(Boolean);
    const lanes = new Set();
    for (const path of report.paths) {
      if (path.startsWith("apps/zenx/src/renderer/"))
        lanes.add("zenx-renderer");
      else if (path.startsWith("apps/mobile/src/")) lanes.add("mobile");
      else if (/^(docs\/.*|[^/]+\.md)$/.test(path)) lanes.add("documentation");
      else report.reasons.push(`Unproven/shared impact: ${path}`);
    }
    if (report.paths.length === 0)
      report.reasons.push("Empty diff: no selection inferred");
    report.fallback = report.reasons.length > 0;
    if (!report.fallback) report.candidateLanes = [...lanes].sort();
  } catch (error) {
    // A missing base (including a new branch), git error, or oversize diff must
    // not turn an incomplete path list into a selective recommendation.
    report.paths = [];
    report.reasons = [
      `Unavailable complete diff: ${error.message.split("\n")[0]}`,
    ];
  }
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const destination = process.argv[2];
  if (!destination) throw new Error("A shadow-report output path is required");
  writeFileSync(
    destination,
    `${JSON.stringify(planImpact(process.env.CI_BASE_SHA, process.env.CI_HEAD_SHA), null, 2)}\n`,
  );
}
