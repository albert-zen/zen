import { execFileSync } from "node:child_process";
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

// Shared evidence only. Shadow candidate labels never grant omission authority.
export function verifyPinnedChanges({
  event,
  base,
  head,
  checkout,
  cwd = process.cwd(),
  isAllowedPath,
  selectedMode,
  selectionReason,
  requireExistingFiles = false,
}) {
  const report = {
    schemaVersion: 1,
    mode: "full",
    event: event || null,
    baseSha: base || null,
    headSha: head || null,
    expectedCheckoutSha: checkout || null,
    paths: [],
    reasons: [],
  };
  if (event !== "pull_request") {
    report.reasons.push("Only verified pull requests may select reduced work");
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
  if (!impact.paths.every(isAllowedPath)) {
    report.reasons.push("Changed path outside the proven allowlist");
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
      const endpointPaths = new Set();
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
          throw new Error("Non-ordinary selected entry");
        }
        seen.add(path);
        endpointPaths.add(path);
      }
      if (requireExistingFiles && endpointPaths.size !== impact.paths.length)
        throw new Error("Selected source must exist at both endpoints");
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
    report.mode = selectedMode;
    report.reasons.push(selectionReason);
  } catch (error) {
    report.reasons.push(
      `Conservative full fallback: ${error.message.split("\n")[0]}`,
    );
  }
  return report;
}
