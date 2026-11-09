import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { planImpact } from "./ci-impact-shadow.mjs";

// Deliberately narrower than the observation-only classifier. Executable docs,
// assets, fixtures, manifests and agent instructions must still run full CI.
export function isDocumentationPath(path) {
  return (
    (path === "README.md" ||
      /^(?:docs|apps\/zenx\/docs)\/(?:[^/]+\/)*[^/]+\.md$/.test(path)) &&
    !path
      .split("/")
      .some(
        (part) => part.startsWith(".") || part.toLowerCase() === "agents.md",
      )
  );
}

export function selectDocumentation({
  event,
  base,
  head,
  checkout,
  cwd = process.cwd(),
}) {
  const report = {
    schemaVersion: 1,
    mode: "full",
    docsOnly: false,
    event: event || null,
    baseSha: base || null,
    headSha: head || null,
    expectedCheckoutSha: checkout || null,
    paths: [],
    reasons: [],
  };
  if (event !== "pull_request") {
    report.reasons.push(
      "Only verified pull requests may select documentation-only work",
    );
    return report;
  }
  const impact = planImpact(base, head, { cwd });
  report.checkoutSha = impact.checkoutSha || null;
  report.paths = impact.paths;
  // Shadow candidates never authorize a skip. Independently prove an exact
  // checkout, complete nonempty diff, path allowlist and ordinary blob modes.
  if (
    !/^[a-f0-9]{40}$/.test(checkout || "") ||
    impact.checkoutSha !== checkout
  ) {
    report.reasons.push("Missing or mismatched exact checkout");
    return report;
  }
  if (
    !impact.paths.length ||
    impact.reasons.some((reason) =>
      reason.startsWith("Unavailable complete diff:"),
    )
  ) {
    report.reasons.push("Missing complete nonempty pinned diff");
    return report;
  }
  if (!impact.paths.every(isDocumentationPath)) {
    report.reasons.push(
      "Changed path outside the proven documentation allowlist",
    );
    return report;
  }
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
  try {
    const seen = new Set();
    for (const sha of [base, head]) {
      for (const entry of git("ls-tree", "-r", "-z", sha, "--", ...impact.paths)
        .split("\0")
        .filter(Boolean)) {
        const tab = entry.indexOf("\t");
        const metadata = entry.slice(0, tab).split(" ");
        const path = entry.slice(tab + 1);
        if (
          metadata[0] !== "100644" ||
          metadata[1] !== "blob" ||
          !impact.paths.includes(path)
        ) {
          throw new Error("Non-ordinary documentation entry");
        }
        seen.add(path);
      }
    }
    if (seen.size !== impact.paths.length)
      throw new Error("Incomplete file-mode evidence");
    // A body-only PR cannot smuggle untested integration changes via a different
    // checkout. The event checkout must have exactly the selected head tree.
    // This conservatively runs full when the PR merge tree incorporates newer base work.
    if (
      git("rev-parse", `${checkout}^{tree}`).trim() !==
      git("rev-parse", `${head}^{tree}`).trim()
    ) {
      throw new Error("Integration tree differs from the selected head");
    }
    git("diff", "--check", base, head, "--");
    report.mode = "documentation-only";
    report.docsOnly = true;
    report.reasons.push(
      "Complete pinned ordinary-Markdown diff; no code, configuration or fixture changes",
    );
  } catch (error) {
    report.reasons.push(
      `Conservative full fallback: ${error.message.split("\n")[0]}`,
    );
  }
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const destination = process.argv[2];
  if (!destination) throw new Error("A selection report path is required");
  const report = selectDocumentation({
    event: process.env.GITHUB_EVENT_NAME,
    base: process.env.CI_BASE_SHA,
    head: process.env.CI_HEAD_SHA,
    checkout: process.env.CI_CHECKOUT_SHA,
  });
  writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `docs-only=${report.docsOnly}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### CI selection\nMode: ${report.mode}. Changed paths: ${report.paths.length}.\n\n${report.reasons.join("\n")}\n\nMain and manual dispatch always run full acceptance. Documentation-only preserves named checks with explicit no-op receipts; it is not native or product acceptance.\n`,
    );
}
