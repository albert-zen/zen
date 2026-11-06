import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const build = await readFile(
  new URL("../scripts/build-image-preparation-preview.mjs", import.meta.url),
  "utf8",
);
const capture = await readFile(
  new URL("../scripts/capture-image-preparation-preview.mjs", import.meta.url),
  "utf8",
);
const fixture = await readFile(
  new URL("./fixtures/image-preparation-visual.tsx", import.meta.url),
  "utf8",
);
const workflow = parse(
  await readFile(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  ),
);

test("image evidence records current HEAD, tree and source hashes instead of a local-only revision", () => {
  assert.match(build, /sourceCommit = git\(\["rev-parse", "HEAD"\]\)/);
  assert.match(build, /sourceTree = git\(\["rev-parse", "HEAD\^\{tree\}"\]\)/);
  assert.match(build, /sources: Object\.fromEntries/);
  assert.match(build, /bundleSha256: sha\(html\)/);
  assert.match(build, /__IMAGE_PREPARATION_SOURCE__: JSON\.stringify/);
  assert.match(fixture, /__IMAGE_PREPARATION_SOURCE__\.commit/);
  assert.match(fixture, /__IMAGE_PREPARATION_SOURCE__\.tree/);
  for (const source of [build, fixture])
    assert.doesNotMatch(source, /8e767d35|4ae2919e|d584ef32/);
});

test("image capture resolves installed Chrome and keeps Chromium sandbox enabled", () => {
  for (const candidate of [
    "CHROME_PATH",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ])
    assert.ok(capture.includes(candidate));
  assert.match(capture, /await access\(candidate, constants\.X_OK\)/);
  assert.match(capture, /assert\.ok\(chrome/);
  assert.match(capture, /spawn\(chrome, args/);
  assert.match(capture, /prerequisite\.json/);
  assert.doesNotMatch(
    capture,
    /--no-sandbox|--disable-setuid-sandbox|--disable-web-security/,
  );
  assert.match(capture, /chromiumSandboxDisabled: false/);
});

test("capture verifies no card across prepared, unavailable, selected and navigated histories", () => {
  assert.match(
    capture,
    /requestAnimationFrame\(\(\) => requestAnimationFrame\(resolve\)\)/,
  );
  for (const label of [
    "Current",
    "Ordinary prepared",
    "Codec unavailable",
    "Mixed outcome",
    "Codec cold selected",
    "Compacted",
    "Later unavailable",
    "Retained only",
    "Other thread",
  ])
    assert.ok(capture.includes(`"${label}"`));
  assert.match(capture, /assert\.equal\(state\.noticeCount, 0\)/);
  assert.match(capture, /assert\.equal\(state\.composerCount, 1\)/);
  assert.match(capture, /assert\.doesNotMatch\(\s+state\.threadText,/);
  assert.match(capture, /Synthetic snapshot: \$\{label\}/);
  assert.doesNotMatch(
    capture,
    /waitExpandedNotice|Enter did not close image details/,
  );
  assert.doesNotMatch(
    build,
    /ImagePreparationNotice|image-preparation-projection/,
  );
});

test("Ubuntu image capture is bounded and retains artifacts on failure without replacing prior coverage", () => {
  const job = workflow.jobs["zenx-ui"];
  assert.equal(job["runs-on"], "ubuntu-24.04");
  const captureStep = job.steps.find((step) =>
    step.run?.includes("capture-image-preparation-preview.mjs"),
  );
  assert.ok(captureStep);
  assert.equal(captureStep["timeout-minutes"], 3);
  assert.match(captureStep.if, /zenx-fonts\.outcome == 'success'/);
  const upload = job.steps.find(
    (step) => step.with?.name === "zenx-image-preparation-${{ github.sha }}",
  );
  assert.equal(upload.if, "${{ always() }}");
  assert.equal(upload.uses, "actions/upload-artifact@v4");
  assert.equal(upload.with.path, "${{ runner.temp }}/zenx-image-preparation");
  for (const existing of [
    "capture-send-preparation-preview.mjs",
    "capture-approved-ui-preview.mjs",
    "capture-compaction-preview.mjs",
  ])
    assert.ok(job.steps.some((step) => step.run?.includes(existing)));
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.on.schedule, undefined);
});
