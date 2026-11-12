import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { planImpact } from "../ci-impact-shadow.mjs";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "ci-impact-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Synthetic fixture");
  const put = (path) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), "fixture\n");
  };
  const commit = () => {
    git("add", ".");
    git("commit", "--allow-empty", "-m", "synthetic");
    return git("rev-parse", "HEAD");
  };
  return { cwd, put, commit };
}

test("renderer-only suggestion is explicitly shadow, never acceptance", (t) => {
  const f = fixture(t);
  const base = f.commit();
  f.put("apps/zenx/src/renderer/view.tsx");
  const report = planImpact(base, f.commit(), f);
  assert.equal(report.fallback, false);
  assert.deepEqual(report.candidateLanes, ["zenx-renderer"]);
  assert.equal(report.fullAcceptanceRequired, true);
  assert.equal(report.mode, "shadow-only");
});

test("shared, core and unknown changes always fall back", (t) => {
  for (const path of [
    "package-lock.json",
    ".github/workflows/ci.yml",
    "src/runtime.ts",
    "packages/zenx-plugin-sdk/src/index.ts",
    "apps/zenx/tsconfig.web.json",
    "apps/zenx/src/main/index.ts",
  ]) {
    const f = fixture(t);
    const base = f.commit();
    f.put(path);
    const report = planImpact(base, f.commit(), f);
    assert.equal(report.fallback, true);
    assert.deepEqual(report.candidateLanes, ["full"]);
  }
});

test("renames retain both paths and deletions remain visible", (t) => {
  const f = fixture(t);
  f.put("src/core.ts");
  f.put("apps/zenx/src/renderer/deleted.ts");
  const base = f.commit();
  mkdirSync(join(f.cwd, "apps/zenx/src/renderer"), { recursive: true });
  renameSync(
    join(f.cwd, "src/core.ts"),
    join(f.cwd, "apps/zenx/src/renderer/moved.ts"),
  );
  rmSync(join(f.cwd, "apps/zenx/src/renderer/deleted.ts"));
  const report = planImpact(base, f.commit(), f);
  assert.equal(report.fallback, true);
  assert.deepEqual(report.paths.sort(), [
    "apps/zenx/src/renderer/deleted.ts",
    "apps/zenx/src/renderer/moved.ts",
    "src/core.ts",
  ]);
});

test("complete NUL-delimited diff handles over 300 files and unusual names", (t) => {
  const f = fixture(t);
  const base = f.commit();
  for (let i = 0; i < 400; i++) f.put(`docs/${i}.md`);
  f.put("docs/space and\nnewline.md");
  f.put("z-unknown");
  const report = planImpact(base, f.commit(), f);
  assert.equal(report.paths.length, 402);
  assert.ok(report.paths.includes("docs/space and\nnewline.md"));
  assert.equal(report.fallback, true);
});

test("missing, invalid and empty ranges fail closed", (t) => {
  const f = fixture(t);
  const sha = f.commit();
  for (const base of [undefined, "main", "0".repeat(40), sha]) {
    const report = planImpact(base, sha, f);
    assert.equal(report.fallback, true);
    assert.deepEqual(report.candidateLanes, ["full"]);
    assert.ok(report.reasons.length);
  }
});

test("pinned endpoints are used even when checkout has moved", (t) => {
  const f = fixture(t);
  const base = f.commit();
  f.put("docs/a.md");
  const head = f.commit();
  f.put("src/later.ts");
  const checkout = f.commit();
  const report = planImpact(base, head, f);
  assert.deepEqual(report.paths, ["docs/a.md"]);
  assert.equal(report.checkoutSha, checkout);
  assert.equal(report.headSha, head);
});

test("the fast workflow never activates shadow candidates directly", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../../.github/workflows/fast-feedback.yml", import.meta.url),
    "utf8",
  );
  assert.match(source, /pull_request:/);
  assert.doesNotMatch(
    source,
    /pull_request_target:|paths:|paths-ignore:|needs:|fromJSON|candidateLanes/,
  );
  assert.match(source, /fetch-depth: 0/);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(source, /npm run build --workspace @zenx\/plugin-sdk/);
  assert.match(source, /npm run typecheck/);
  assert.match(source, /npm --workspace apps\/zenx run typecheck:prepared/);
  assert.match(source, /npx --no-install prettier --check \./);
});
