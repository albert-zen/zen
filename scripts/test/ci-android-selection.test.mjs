import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  androidSourcePaths,
  boundaryPath,
  dependencyFingerprint,
  isAndroidSourcePath,
  selectAndroid,
} from "../ci-android-selection.mjs";
import {
  isDocumentationPath,
  verifyPinnedChanges,
} from "../ci-selection-proof.mjs";
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "android-selection-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const put = (path, data = "fixture\n") => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), data);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "--allow-empty", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  for (const path of androidSourcePaths) put(path);
  put("package.json", '{"workspaces":["apps/zenx"]}\n');
  const boundary = {
    schemaVersion: 1,
    algorithm: "sha256-git-tree-projection-v1",
    fingerprint: dependencyFingerprint(commit(), { cwd }),
  };
  put(boundaryPath, JSON.stringify(boundary));
  const base = commit();
  const options = (head, overrides = {}) => ({
    event: "pull_request",
    base,
    head,
    checkout: head,
    cwd,
    ...overrides,
  });
  return {
    cwd,
    git,
    put,
    commit,
    base,
    boundary,
    options,
    select: (head, overrides) => selectAndroid(options(head, overrides)),
  };
}
test("only the eleven reviewed source paths qualify", () => {
  assert.equal(androidSourcePaths.length, 11);
  for (const path of androidSourcePaths)
    assert.equal(isAndroidSourcePath(path), true);
  for (const path of [
    "apps/mobile/src/new.ts",
    "apps/mobile/src/nested/App.tsx",
    "apps/mobile/src/app.tsx",
    "apps/mobile/src/config.json",
    "apps/mobile/src/.hidden.ts",
    "apps/mobile/src/App.tsx/extra",
    "apps/mobile/app.json",
    "apps/mobile/package.json",
    "apps/mobile/tsconfig.json",
    "apps/mobile/index.js",
    "apps/mobile/test/a.test.mjs",
    "src/protocol/native/remote-wire.ts",
  ])
    assert.equal(isAndroidSourcePath(path), false, path);
});
test("modifications to all existing sources select against both pinned consumer trees", (t) => {
  const f = fixture(t);
  for (const path of androidSourcePaths) f.put(path, "changed\n");
  const report = f.select(f.commit());
  assert.equal(report.androidOnly, true);
  assert.equal(report.mode, "android-only");
  assert.equal(report.paths.length, 11);
  assert.deepEqual(report.dependencyBoundary, {
    expected: f.boundary.fingerprint,
    base: f.boundary.fingerprint,
    head: f.boundary.fingerprint,
  });
});
test("new paths, deletions and rename directions all retain full", (t) => {
  for (const mutate of [
    (f) => f.put("apps/mobile/src/new.ts"),
    (f) => rmSync(join(f.cwd, androidSourcePaths[0])),
    (f) =>
      renameSync(
        join(f.cwd, androidSourcePaths[0]),
        join(f.cwd, "apps/mobile/src/new.tsx"),
      ),
    (f) => {
      f.put("docs/renamed.md");
      renameSync(
        join(f.cwd, androidSourcePaths[0]),
        join(f.cwd, "docs/renamed.md"),
      );
    },
    (f) => {
      f.put("docs/source.md");
      const base = f.commit();
      renameSync(
        join(f.cwd, "docs/source.md"),
        join(f.cwd, androidSourcePaths[0]),
      );
      return { base };
    },
    (f) => {
      rmSync(join(f.cwd, androidSourcePaths[0]));
      const base = f.commit();
      f.put(androidSourcePaths[0]);
      return { base };
    },
  ]) {
    const f = fixture(t);
    const overrides = mutate(f) || {};
    assert.equal(f.select(f.commit(), overrides).androidOnly, false);
  }
});
test("non-PR events, missing/invalid objects, empty diff and mismatched checkout retain full", (t) => {
  const f = fixture(t);
  f.put(androidSourcePaths[0], "changed\n");
  const head = f.commit();
  for (const event of [
    undefined,
    "push",
    "workflow_dispatch",
    "merge_group",
    "pull_request_target",
  ])
    assert.equal(f.select(head, { event }).androidOnly, false);
  for (const base of [undefined, "main", "0".repeat(40), "f".repeat(40), head])
    assert.equal(f.select(head, { base }).androidOnly, false);
  for (const invalid of [undefined, "HEAD", "f".repeat(40)])
    assert.equal(f.select(invalid).androidOnly, false);
  for (const checkout of [undefined, "HEAD", f.base])
    assert.equal(f.select(head, { checkout }).androidOnly, false);
  f.put("src/integration.ts");
  const checkout = f.commit();
  assert.equal(f.select(head, { checkout }).androidOnly, false);
  assert.equal(f.select(head).androidOnly, false);
});
test("symlinks, executables and gitlinks at either endpoint retain full", (t) => {
  for (const type of ["symlink", "executable", "gitlink"]) {
    const f = fixture(t),
      path = androidSourcePaths[0];
    if (type === "executable") chmodSync(join(f.cwd, path), 0o755);
    else {
      rmSync(join(f.cwd, path));
      if (type === "symlink")
        symlinkSync("../../../package.json", join(f.cwd, path));
      else f.git("update-index", "--cacheinfo", `160000,${f.base},${path}`);
    }
    let head;
    if (type === "gitlink") {
      f.git("commit", "-m", "gitlink");
      head = f.git("rev-parse", "HEAD");
    } else head = f.commit();
    assert.equal(f.select(head).androidOnly, false, type);
    if (type !== "gitlink") rmSync(join(f.cwd, path));
    f.put(path, "ordinary\n");
    assert.equal(
      f.select(f.commit(), { base: head }).androidOnly,
      false,
      `old ${type}`,
    );
  }
});
test("mixed docs, config, manifest and shared diffs retain full", (t) => {
  for (const path of [
    "docs/guide.md",
    "apps/mobile/package-lock.json",
    "apps/mobile/app.json",
    "src/shared.ts",
    "package.json",
    ".github/workflows/ci.yml",
    boundaryPath,
  ]) {
    const f = fixture(t);
    f.put(androidSourcePaths[0], "changed\n");
    f.put(path, "changed\n");
    assert.equal(f.select(f.commit()).androidOnly, false, path);
  }
});
test("consumer drift already present in base cannot borrow the old boundary", (t) => {
  for (const path of [
    "new-root.ts",
    "new-root/consumer.mjs",
    "apps/zenx/src/main/consumer.ts",
    "packages/plugin/src.ts",
    "src/consumer.ts",
    "apps/cli/src/host.ts",
    "apps/imzen/consumer.py",
    "scripts/package.mjs",
    "test/consumer.test.ts",
    ".github/workflows/ci.yml",
    "tsconfig.json",
    "package.json",
    "apps/mobile/app.json",
    "scripts/ci-android-selection.mjs",
    "scripts/test/ci-android-selection.test.mjs",
  ]) {
    const f = fixture(t);
    f.put(path, "consumer\n");
    const base = f.commit();
    f.put(androidSourcePaths[0], "changed\n");
    const report = f.select(f.commit(), { base });
    assert.equal(report.androidOnly, false, path);
    assert.match(report.reasons.at(-1), /reviewed baseline/, path);
  }
});
test("mobile inventory drift is pinned even if it happened before the current PR", (t) => {
  const f = fixture(t);
  rmSync(join(f.cwd, androidSourcePaths[0]));
  const base = f.commit();
  f.put(androidSourcePaths[1], "changed\n");
  const report = f.select(f.commit(), { base });
  assert.equal(report.androidOnly, false);
  assert.match(report.reasons.at(-1), /reviewed baseline/);
});
test("ordinary docs evolution is excluded but nonordinary docs are pinned", (t) => {
  const f = fixture(t);
  f.put("docs/guide.md");
  let base = f.commit();
  f.put(androidSourcePaths[0], "changed\n");
  assert.equal(f.select(f.commit(), { base }).androidOnly, true);
  chmodSync(join(f.cwd, "docs/guide.md"), 0o755);
  base = f.commit();
  f.put(androidSourcePaths[0], "twice\n");
  assert.equal(f.select(f.commit(), { base }).androidOnly, false);
});
test("missing, invalid, changed and nonordinary boundary manifests retain full", (t) => {
  for (const mutate of [
    (f) => rmSync(join(f.cwd, boundaryPath)),
    (f) => f.put(boundaryPath, "bad JSON"),
    (f) => f.put(boundaryPath, "null"),
    (f) => f.put(boundaryPath, JSON.stringify({ ...f.boundary, extra: true })),
    (f) =>
      f.put(
        boundaryPath,
        JSON.stringify({ ...f.boundary, fingerprint: "bad" }),
      ),
    (f) =>
      f.put(boundaryPath, JSON.stringify({ ...f.boundary, schemaVersion: 2 })),
    (f) =>
      f.put(
        boundaryPath,
        JSON.stringify({ ...f.boundary, algorithm: "unknown" }),
      ),
    (f) =>
      f.put(
        boundaryPath,
        JSON.stringify({ ...f.boundary, fingerprint: "f".repeat(64) }),
      ),
    (f) => chmodSync(join(f.cwd, boundaryPath), 0o755),
    (f) => {
      rmSync(join(f.cwd, boundaryPath));
      symlinkSync("../package.json", join(f.cwd, boundaryPath));
    },
  ]) {
    const f = fixture(t);
    mutate(f);
    const base = f.commit();
    f.put(androidSourcePaths[0], "changed\n");
    assert.equal(f.select(f.commit(), { base }).androidOnly, false);
  }
  const f = fixture(t);
  f.put(androidSourcePaths[0], "changed\n");
  f.put(boundaryPath, JSON.stringify({ ...f.boundary, note: "changed" }));
  assert.equal(f.select(f.commit()).androidOnly, false);
});
test("shared proof preserves docs-only rename/delete behavior without source presence restriction", (t) => {
  const f = fixture(t);
  f.put("docs/a.md");
  f.put("docs/deleted.md");
  const base = f.commit();
  renameSync(join(f.cwd, "docs/a.md"), join(f.cwd, "docs/b.md"));
  rmSync(join(f.cwd, "docs/deleted.md"));
  const head = f.commit();
  const report = verifyPinnedChanges({
    ...f.options(head, { base }),
    isAllowedPath: isDocumentationPath,
    selectedMode: "documentation-only",
    selectionReason: "fixture",
  });
  assert.equal(report.mode, "documentation-only");
  assert.equal(report.paths.length, 3);
});
