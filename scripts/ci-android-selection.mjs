import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  isDocumentationPath,
  verifyPinnedChanges,
} from "./ci-selection-proof.mjs";

export const boundaryPath = "scripts/ci-android-boundary.json";
// Existing reviewed source files only. Additions, removals and renames run full.
export const androidSourcePaths = Object.freeze([
  "apps/mobile/src/App.tsx",
  "apps/mobile/src/app-actions.mjs",
  "apps/mobile/src/fixture.d.mts",
  "apps/mobile/src/fixture.mjs",
  "apps/mobile/src/fleet.d.mts",
  "apps/mobile/src/fleet.mjs",
  "apps/mobile/src/remote-core.ts",
  "apps/mobile/src/remote.ts",
  "apps/mobile/src/session.d.mts",
  "apps/mobile/src/session.mjs",
  "apps/mobile/src/transport.ts",
]);
export const isAndroidSourcePath = (path) => androidSourcePaths.includes(path);
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });

// Freeze all possible consumers, including new roots, workflows, selectors,
// tests, config and packaging. This is not an import-regex completeness claim.
export function dependencyFingerprint(tree, { cwd = process.cwd() } = {}) {
  const entries = git(cwd, "ls-tree", "-r", "-z", tree)
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, type] = entry.slice(0, tab).split(" ");
      const path = entry.slice(tab + 1);
      if (mode !== "100644" || type !== "blob") return [entry];
      // Only the exact ordinary manifest is excluded to avoid self-reference.
      if (path === boundaryPath || isDocumentationPath(path)) return [];
      // Ignore mobile content, but retain its exact reviewed path/mode inventory.
      if (isAndroidSourcePath(path))
        return [`100644 blob mobile-source\t${path}`];
      return [entry];
    });
  return createHash("sha256")
    .update(entries.join("\0") + "\0")
    .digest("hex");
}

export function selectAndroid(options) {
  const report = {
    ...verifyPinnedChanges({
      ...options,
      isAllowedPath: isAndroidSourcePath,
      selectedMode: "android-only",
      requireExistingFiles: true,
      selectionReason:
        "Complete pinned diff modifies only existing reviewed Android source files",
    }),
    androidOnly: false,
  };
  if (report.mode !== "android-only") return report;
  report.mode = "full";
  const cwd = options.cwd || process.cwd();
  try {
    const manifests = [options.base, options.head].map((sha) => {
      const entry = git(cwd, "ls-tree", "-z", sha, "--", boundaryPath);
      if (!/^100644 blob [a-f0-9]{40}\t/.test(entry))
        throw new Error("Missing ordinary dependency-boundary manifest");
      return git(cwd, "show", `${sha}:${boundaryPath}`);
    });
    if (manifests[0] !== manifests[1])
      throw new Error("Dependency-boundary manifest changed between endpoints");
    const boundary = JSON.parse(manifests[0]);
    if (
      !boundary ||
      Object.keys(boundary).sort().join(",") !==
        "algorithm,fingerprint,schemaVersion" ||
      boundary.schemaVersion !== 1 ||
      boundary.algorithm !== "sha256-git-tree-projection-v1" ||
      !/^[a-f0-9]{64}$/.test(boundary.fingerprint || "")
    )
      throw new Error("Invalid dependency-boundary manifest");
    report.dependencyBoundary = {
      expected: boundary.fingerprint,
      base: dependencyFingerprint(options.base, { cwd }),
      head: dependencyFingerprint(options.head, { cwd }),
    };
    if (
      report.dependencyBoundary.base !== boundary.fingerprint ||
      report.dependencyBoundary.head !== boundary.fingerprint
    )
      throw new Error("Dependency inputs differ from the reviewed baseline");
    report.mode = "android-only";
    report.androidOnly = true;
    report.reasons.push(
      "Both endpoint consumer trees match the reviewed boundary; checkout tree equals head",
      "Core/CLI/IMZen, ZenX aggregate, Android and Fast feedback remain full; only ZenX UI/platform work may be omitted",
    );
  } catch (error) {
    report.reasons.push(
      `Conservative full fallback: ${error.message.split("\n")[0]}`,
    );
  }
  return report;
}
