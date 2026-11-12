import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { planImpact } from "./ci-impact-shadow.mjs";
import { isDocumentationPath } from "./ci-docs-selection.mjs";

// Explicit PR risk policy, not a proof of exhaustive dependency coverage.
// Full aggregate acceptance remains on main and manual/release validation.
export const lanes = Object.freeze([
  "quick",
  "aggregate",
  "core",
  "ui",
  "capability",
  "windows-computer",
  "windows-packaged",
  "windows-browser",
  "playwright",
  "android",
]);
const platform = [
  "capability",
  "windows-computer",
  "windows-packaged",
  "windows-browser",
  "playwright",
];
const allRisk = lanes.filter((lane) => lane !== "aggregate");
export const baselineTests = Object.freeze([
  "scripts/test/ci-impact-shadow.test.mjs",
  "scripts/test/ci-docs-selection.test.mjs",
  "scripts/test/ci-risk-selection.test.mjs",
  "apps/zenx/test/ci-docs-selection-workflow.test.mjs",
  "apps/zenx/test/ci-risk-workflow.test.mjs",
  "apps/zenx/test/ci-zenx-jobs.test.mjs",
  "apps/zenx/test/ci-ui-shards.test.mjs",
  "apps/zenx/test/ci-feature-unit-ownership.test.mjs",
  "apps/zenx/test/renderer-style-policy.test.ts",
  "apps/zenx/test/project-projection.test.ts",
  "apps/zenx/test/packaged-provider-smoke-exit.test.ts",
  "test/journal.test.ts",
]);
export const rendererNativeBridgePaths = Object.freeze(
  [
    "workspace-browser-panel.tsx",
    "browser-thread-panel.tsx",
    "browser-external-open.tsx",
    "bundled-browser-ui.tsx",
    "native-view-overlays.ts",
    "computer-thread-panel.tsx",
    "shell-thread-panel.tsx",
    "shell-terminal-security.ts",
    "shell-target-navigation.tsx",
    "auxiliary-panel.tsx",
    "ImagePresentation.tsx",
    "styles.css",
  ].map((name) => `apps/zenx/src/renderer/src/${name}`),
);
const domainTests = {
  "renderer-native": [
    "apps/zenx/test/native-view-overlays.test.ts",
    "apps/zenx/test/workspace-browser-control-ui.test.ts",
    "apps/zenx/test/shell-panel-renderer.test.ts",
    "apps/zenx/test/inline-reference-codec.test.ts",
    "apps/zenx/test/unified-reference-serialization.test.ts",
  ],
  renderer: [
    "apps/zenx/test/inline-reference-codec.test.ts",
    "apps/zenx/test/unified-reference-serialization.test.ts",
  ],
  browser: [
    "apps/zenx/test/browser-frame-geometry.test.ts",
    "apps/zenx/test/browser-targeted-input.test.ts",
  ],
  native: [
    "apps/zenx/test/windows-smoke-phase.test.ts",
    "apps/zenx/test/login-shell-environment.test.ts",
  ],
  packaging: ["apps/zenx/test/first-party-plugin-packaging.test.mjs"],
  mobile: [
    "apps/mobile/test/app-actions.test.mjs",
    "apps/mobile/test/fleet.test.mjs",
    "apps/mobile/test/rooms.test.mjs",
    "apps/mobile/test/session.test.mjs",
  ],
};
export function isTestPath(path) {
  return (
    /^(?:test|scripts\/test|apps\/zenx\/test|apps\/mobile\/(?:test|integration))\/(?:[^/]+\/)*[^/]+\.test\.(?:ts|tsx|mjs)$/.test(
      path,
    ) && !path.split("/").some((part) => part.startsWith("."))
  );
}
export function classifyRisk(path) {
  if (isDocumentationPath(path)) return { domain: "documentation", lanes: [] };
  if (path.startsWith("apps/mobile/"))
    return { domain: "mobile", lanes: ["android"] };
  if (rendererNativeBridgePaths.includes(path))
    return { domain: "renderer-native", lanes: ["ui", ...platform] };
  if (path.startsWith("apps/zenx/src/renderer/"))
    return { domain: "renderer", lanes: ["ui"] };
  if (
    /^(?:src\/|apps\/cli\/|apps\/imzen\/|packages\/zenx-(?:plugin-sdk|imzenx-plugin)\/|test\/|package(?:-lock)?\.json$|tsconfig[^/]*\.json$)/.test(
      path,
    )
  )
    return { domain: "shared", lanes: allRisk };
  if (
    /^packages\//.test(path) ||
    /^apps\/zenx\/(?:package(?:-lock)?\.json$|electron\.vite\.config\.ts$|tsconfig[^/]*\.json$|resources\/)/.test(
      path,
    ) ||
    /^(?:apps\/zenx\/scripts\/(?:package-|pack-|stage-|prepare-)|scripts\/(?:assemble-|build-zenx-winapp|verified-artifact))/.test(
      path,
    )
  )
    return { domain: "packaging", lanes: ["ui", ...platform] };
  // Scope the name inventory to actual ZenX source/script/test directories.
  // A new directory or unmatched file never borrows a small lane by substring.
  const scoped =
    /^apps\/zenx\/(?:src\/main\/(?:capabilities\/)?|scripts\/|test\/)([^/]+)$/.exec(
      path,
    )?.[1];
  if (scoped && /^chrome-native-host/.test(scoped))
    return {
      domain: "browser",
      lanes: [
        "capability",
        "windows-packaged",
        "windows-browser",
        "playwright",
      ],
    };
  if (
    scoped &&
    /^(?:browser-|user-browser|workspace-browser|playwright-|chrome-|model-browser)/.test(
      scoped,
    )
  )
    return { domain: "browser", lanes: ["windows-browser", "playwright"] };
  if (scoped && /^(?:windows-|winapp-|app-shot-windows)/.test(scoped))
    return {
      domain: "native",
      lanes: ["windows-computer", "windows-packaged", "windows-browser"],
    };
  if (scoped && /^(?:macos-|app-shot-macos|login-shell-)/.test(scoped))
    return { domain: "native", lanes: ["capability", "playwright"] };
  if (
    scoped &&
    /^(?:computer-|model-computer|peekaboo-|app-shot-|shell-)/.test(scoped)
  )
    return { domain: "native", lanes: platform };
  if (
    scoped &&
    /^(?:provider-|packaged-provider|external-provider|first-party-)/.test(
      scoped,
    )
  )
    return { domain: "packaging", lanes: ["ui", ...platform] };
  // Changed standalone unit files run directly. Deleted/renamed tests are
  // promoted to all-risk by the endpoint proof below, never silently dropped.
  if (isTestPath(path)) return { domain: "unit", lanes: [] };
  return { domain: "unknown", lanes: allRisk };
}
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
export function selectRisk({
  event,
  base,
  head,
  checkout,
  cwd = process.cwd(),
  runId = null,
  runAttempt = null,
}) {
  const report = {
    schemaVersion: 1,
    policyVersion: "1",
    tier: "full",
    event: event || null,
    baseSha: base || null,
    headSha: head || null,
    checkoutSha: checkout || null,
    runId,
    runAttempt,
    paths: [],
    decisions: [],
    reasons: [],
    quickTests: [],
    modes: Object.fromEntries(lanes.map((lane) => [lane, "run"])),
  };
  if (event !== "pull_request") {
    report.reasons.push(
      "Main, manual and other non-PR events retain full acceptance",
    );
    return report;
  }
  report.tier = "pr-risk";
  report.modes.aggregate = "omit-pr-risk";
  const selected = new Set(["quick"]),
    tests = new Set(baselineTests);
  try {
    const impact = planImpact(base, head, { cwd });
    report.paths = impact.paths;
    if (
      !/^[a-f0-9]{40}$/.test(checkout || "") ||
      impact.checkoutSha !== checkout
    )
      throw new Error("Missing or mismatched checkout identity");
    if (
      !impact.paths.length ||
      impact.reasons.some((reason) =>
        reason.startsWith("Unavailable complete diff:"),
      )
    )
      throw new Error("Unavailable complete nonempty pinned diff");
    if (
      git(cwd, "rev-parse", `${checkout}^{tree}`).trim() !==
      git(cwd, "rev-parse", `${head}^{tree}`).trim()
    )
      throw new Error("Integration tree differs from selected head");
    git(cwd, "diff", "--check", base, head, "--");
    const entries = [base, head].map(
      (sha) =>
        new Map(
          git(cwd, "ls-tree", "-r", "-z", sha, "--", ...impact.paths)
            .split("\0")
            .filter(Boolean)
            .map((entry) => {
              const tab = entry.indexOf("\t");
              const [mode, type] = entry.slice(0, tab).split(" ");
              return [entry.slice(tab + 1), { mode, type }];
            }),
        ),
    );
    for (const path of impact.paths) {
      const before = entries[0].get(path),
        after = entries[1].get(path);
      if (
        (!before && !after) ||
        [before, after].some(
          (entry) =>
            entry && (entry.mode !== "100644" || entry.type !== "blob"),
        )
      )
        throw new Error(`Unproven ordinary file: ${path}`);
      const decision = classifyRisk(path);
      report.decisions.push({ path, ...decision });
      for (const lane of decision.lanes) selected.add(lane);
      for (const file of domainTests[decision.domain] || []) tests.add(file);
      if (isTestPath(path)) {
        if (after) tests.add(path);
        if (!before || !after) {
          allRisk.forEach((lane) => selected.add(lane));
          report.reasons.push(
            `New/deleted/renamed test retains every PR risk lane: ${path}`,
          );
        }
      }
    }
    if (impact.paths.every(isDocumentationPath)) {
      report.tier = "documentation";
      report.modes = Object.fromEntries(
        lanes.map((lane) => [lane, "omit-docs"]),
      );
      report.reasons.push(
        "Verified ordinary documentation-only change; format checks retained",
      );
      return report;
    }
  } catch (error) {
    allRisk.forEach((lane) => selected.add(lane));
    Object.values(domainTests)
      .flat()
      .forEach((file) => tests.add(file));
    report.reasons.push(
      `Conservative all-risk fallback: ${error.message.split("\n")[0]}`,
    );
  }
  if (allRisk.every((lane) => selected.has(lane)))
    Object.values(domainTests)
      .flat()
      .forEach((file) => tests.add(file));
  report.quickTests = [...tests].sort();
  report.modes = Object.fromEntries(
    lanes.map((lane) => [lane, selected.has(lane) ? "run" : "omit-pr-risk"]),
  );
  report.reasons.push(
    "PR risk acceptance is not full aggregate acceptance; the complete suite runs on main/manual",
  );
  return report;
}
export function planDigest(report) {
  // A partial GitHub rerun can retain the successful selection from attempt 1.
  // The source/run plan stays immutable; the execution receipt owns its attempt.
  const { runAttempt: _attempt, ...plan } = report;
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}
export function riskOptions(env = process.env) {
  return {
    event: env.GITHUB_EVENT_NAME,
    base: env.CI_BASE_SHA,
    head: env.CI_HEAD_SHA,
    checkout: env.CI_CHECKOUT_SHA,
    runId: env.GITHUB_RUN_ID || null,
    runAttempt: env.GITHUB_RUN_ATTEMPT || null,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.argv[2]) throw new Error("A risk report path is required");
  const report = selectRisk(riskOptions());
  writeFileSync(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `policy-version=1\ntier=${report.tier}\nplan-digest=${planDigest(report)}\ndocs-only=${report.tier === "documentation"}\n` +
        lanes.map((lane) => `${lane}-mode=${report.modes[lane]}\n`).join(""),
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### CI tier: ${report.tier}\nRun: ${lanes.filter((lane) => report.modes[lane] === "run").join(", ") || "documentation formatting"}.\nOmitted: ${lanes.filter((lane) => report.modes[lane] !== "run").join(", ") || "none"}.\n${report.reasons.join("\n")}\n`,
    );
}
