import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  renameSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  selectDocumentation,
  isDocumentationPath,
} from "../ci-docs-selection.mjs";
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "ci-docs-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  const put = (path, text = "fixture\n") => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "--allow-empty", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  const select = (base, head, options = {}) =>
    selectDocumentation({
      event: "pull_request",
      base,
      head,
      checkout: head,
      cwd,
      ...options,
    });
  return { cwd, git, put, commit, select };
}
test("only proven ordinary Markdown paths are eligible", () => {
  for (const path of [
    "README.md",
    "docs/guide.md",
    "docs/nested/a b\nc.md",
    "apps/zenx/docs/ui-ux.md",
  ])
    assert.equal(isDocumentationPath(path), true, path);
  for (const path of [
    "AGENTS.md",
    "docs/AGENTS.md",
    "apps/zenx/docs/nested/agents.md",
    "ARCHITECTURE.md",
    "docs/run.sh",
    "docs/fixture.json",
    "docs/picture.png",
    "docs/guide.mdx",
    "docs/.config.md",
    "src/README.md",
    "package-lock.json",
    ".github/workflows/ci.yml",
  ])
    assert.equal(isDocumentationPath(path), false, path);
});
test("docs-only changes select; every other event keeps full", (t) => {
  const f = fixture(t),
    base = f.commit();
  f.put("docs/guide.md");
  const head = f.commit();
  assert.equal(f.select(base, head).docsOnly, true);
  for (const event of ["push", "workflow_dispatch", "merge_group", undefined])
    assert.equal(f.select(base, head, { event }).docsOnly, false);
});
test("deletions and doc-to-doc renames stay eligible, source-to-doc rename does not", (t) => {
  const f = fixture(t);
  f.put("docs/a.md");
  f.put("docs/deleted.md");
  const base = f.commit();
  renameSync(join(f.cwd, "docs/a.md"), join(f.cwd, "docs/b.md"));
  rmSync(join(f.cwd, "docs/deleted.md"));
  const head = f.commit();
  assert.equal(f.select(base, head).docsOnly, true);
  assert.equal(f.select(base, head).paths.length, 3);
  f.put("src/code.ts");
  const base2 = f.commit();
  renameSync(join(f.cwd, "src/code.ts"), join(f.cwd, "docs/code.md"));
  assert.equal(f.select(base2, f.commit()).docsOnly, false);
});
test("unknown and shared paths, missing bases, empty diffs, mismatched checkout run full", (t) => {
  const f = fixture(t),
    base = f.commit();
  f.put("docs/a.md");
  const head = f.commit();
  for (const invalid of [undefined, "main", "0".repeat(40), head])
    assert.equal(f.select(invalid, head).docsOnly, false);
  assert.equal(f.select(base, head, { checkout: base }).docsOnly, false);
  for (const path of [
    "docs/script.js",
    "src/core.ts",
    "package.json",
    ".github/workflows/ci.yml",
    "AGENTS.md",
  ]) {
    f.put(path);
    assert.equal(f.select(base, f.commit()).docsOnly, false);
  }
});
test("symlinks, executable mode changes and non-document deletion run full", (t) => {
  const f = fixture(t);
  f.put("docs/a.md");
  f.put("src/a.ts");
  const base = f.commit();
  chmodSync(join(f.cwd, "docs/a.md"), 0o755);
  assert.equal(f.select(base, f.commit()).docsOnly, false);
  chmodSync(join(f.cwd, "docs/a.md"), 0o644);
  rmSync(join(f.cwd, "docs/a.md"));
  symlinkSync("../src/a.ts", join(f.cwd, "docs/a.md"));
  assert.equal(f.select(base, f.commit()).docsOnly, false);
  rmSync(join(f.cwd, "docs/a.md"));
  f.put("docs/a.md");
  rmSync(join(f.cwd, "src/a.ts"));
  assert.equal(f.select(base, f.commit()).docsOnly, false);
});
test("large NUL-delimited diffs cannot hide a late unknown path", (t) => {
  const f = fixture(t),
    base = f.commit();
  for (let i = 0; i < 400; i++) f.put(`docs/${i}.md`);
  f.put("docs/line\nbreak.md");
  let head = f.commit();
  assert.equal(f.select(base, head).docsOnly, true);
  f.put("z-hidden-runtime.ts");
  head = f.commit();
  assert.equal(f.select(base, head).docsOnly, false);
});
test("integration checkout with extra base changes cannot borrow a docs head classification", (t) => {
  const f = fixture(t),
    base = f.commit();
  f.put("docs/a.md");
  const head = f.commit();
  f.put("src/new-base.ts");
  const checkout = f.commit();
  assert.equal(f.select(base, head, { checkout }).docsOnly, false);
});

test("documentation renamed into source and deleted symlink cannot select docs-only", (t) => {
  const f = fixture(t);
  f.put("docs/a.md");
  const base = f.commit();
  mkdirSync(join(f.cwd, "src"));
  renameSync(join(f.cwd, "docs/a.md"), join(f.cwd, "src/a.ts"));
  assert.equal(f.select(base, f.commit()).docsOnly, false);
  symlinkSync("../src/a.ts", join(f.cwd, "docs/link.md"));
  const linked = f.commit();
  rmSync(join(f.cwd, "docs/link.md"));
  assert.equal(f.select(linked, f.commit()).docsOnly, false);
});

test("gitlinks and missing head objects are full fallback", (t) => {
  const f = fixture(t),
    base = f.commit();
  f.git(
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${base},docs/submodule.md`,
  );
  f.git("commit", "-m", "gitlink fixture");
  const head = f.git("rev-parse", "HEAD");
  assert.equal(f.select(base, head).docsOnly, false);
  assert.equal(f.select(base, "f".repeat(40)).docsOnly, false);
});

test("CLI publishes exact boolean selection and a bounded evidence report", (t) => {
  const f = fixture(t),
    base = f.commit();
  f.put("docs/a.md");
  const head = f.commit();
  const report = join(f.cwd, "report.json"),
    output = join(f.cwd, "output.txt");
  execFileSync(
    process.execPath,
    [new URL("../ci-docs-selection.mjs", import.meta.url).pathname, report],
    {
      cwd: f.cwd,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        CI_BASE_SHA: base,
        CI_HEAD_SHA: head,
        CI_CHECKOUT_SHA: head,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: "",
      },
    },
  );
  assert.equal(readFileSync(output, "utf8"), "docs-only=true\n");
  const value = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(value.mode, "documentation-only");
  assert.equal(value.checkoutSha, head);
  assert.deepEqual(value.paths, ["docs/a.md"]);
});
