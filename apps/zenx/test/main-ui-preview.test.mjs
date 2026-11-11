import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const load = (file) => readFile(new URL(file, import.meta.url), "utf8");
test("fast capture preserves browser sandbox and requires actual CI", async () => {
  const capture = await load("../scripts/capture-main-ui-preview.mjs");
  assert.match(capture, /process\.env\.GITHUB_ACTIONS,\s*"true"/u);
  assert.doesNotMatch(
    capture,
    /["']--(?:no-sandbox|disable-setuid-sandbox|disable-web-security)/u,
  );
  assert.match(capture, /browserSandboxDisabled: false/u);
  assert.match(capture, /Page\.captureScreenshot/u);
  assert.match(capture, /Input\.dispatchMouseEvent/u);
});
test("bundle source and screenshot receipts bind actual production scenes", async () => {
  const build = await load("../scripts/build-main-ui-preview.mjs");
  const capture = await load("../scripts/capture-main-ui-preview.mjs");
  for (const file of [
    "ui-polish-visual.tsx",
    "queue-steer-visual.tsx",
    "information-layout-preview.tsx",
  ])
    assert.ok(build.includes(file));
  assert.match(build, /preview-source-receipt/u);
  assert.match(build, /connect-src 'none'/u);
  assert.match(build, /dirtyFiles:/u);
  assert.match(build, /diffSha256:/u);
  assert.match(capture, /Rebuild changed source/u);
  assert.match(capture, /evidence\.screenshots\[filename\] = hash\(bytes\)/u);
});
test("independent fast workflow does not depend on aggregate CI or native build", async () => {
  const workflow = await load("../../../.github/workflows/main-ui-preview.yml");
  assert.match(workflow, /head\.sha \|\| github\.sha/u);
  assert.match(workflow, /npm ci --ignore-scripts --no-audit --no-fund/u);
  assert.doesNotMatch(
    workflow,
    /\bneeds:|npm (?:test|run (?:check|build|typecheck))\b/u,
  );
  assert.match(workflow, /timeout-minutes: 6/u);
  assert.match(workflow, /persist-credentials: false/u);
});
