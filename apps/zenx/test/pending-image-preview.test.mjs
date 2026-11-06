import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");
const capture = await read("../scripts/capture-pending-image-preview.mjs");
const build = await read("../scripts/build-pending-image-preview.mjs");
const fixture = await read("./fixtures/pending-image-visual.tsx");
const workflow = parse(await read("../../../.github/workflows/ci.yml"));

test("pending image evidence uses production rendering and generated images only", () => {
  assert.match(fixture, /import \{ ThreadView \}/);
  assert.match(fixture, /canvas\.toDataURL\("image\/png"\)/);
  for (const reducer of [
    "beginImmediateComposerSubmission",
    "acceptComposerSubmission",
    "failImmediateComposerSubmission",
    "reconcileCanonicalAdmission",
  ])
    assert.ok(fixture.includes(reducer));
  assert.match(build, /workingTreeDiffSha256/);
  assert.match(build, /bundleSha256/);
  assert.match(build, /connect-src 'none'/);
  assert.match(build, /img-src data: blob:/);
});

test("pending image capture is sandboxed and asserts real decoded images at every stage", () => {
  assert.doesNotMatch(
    capture,
    /--no-sandbox|--disable-setuid-sandbox|--disable-web-security/,
  );
  assert.match(capture, /chromiumSandboxDisabled: false/);
  assert.match(capture, /Input\.dispatchMouseEvent/);
  assert.match(capture, /assert\.equal\(state\.brokenImages, 0\)/);
  assert.match(capture, /assert\.equal\(state\.overflow, false\)/);
  for (const stage of [
    "draft",
    "sending",
    "admitted",
    "canonical",
    "unconfirmed",
    "notSent",
  ])
    assert.ok(capture.includes(`record("${stage}"`));
  assert.match(capture, /for \(const count of \[1, 2\]\)/);
});

test("CI retains pending-image evidence on failure and bounds browser execution", () => {
  const steps = workflow.jobs.zenx.steps;
  const run = steps.find((step) =>
    step.run?.includes("capture-pending-image-preview.mjs"),
  );
  assert.equal(run["timeout-minutes"], 3);
  assert.match(run.run, /tsconfig\.pending-image-preview\.json/);
  const upload = steps.find(
    (step) => step.with?.name === "zenx-pending-image-${{ github.sha }}",
  );
  assert.equal(upload.if, "${{ always() }}");
  assert.equal(upload.with.path, "${{ runner.temp }}/zenx-pending-image");
});

test("geometry rejects hidden, clipped, offscreen, zero-size and occluded decoded images", async () => {
  const { measureImageVisibility } =
    await import("../scripts/pending-image-visibility.mjs");
  const keys = ["innerWidth", "innerHeight", "getComputedStyle", "document"];
  const originals = keys.map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  const visibleStyle = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    overflowX: "visible",
    overflowY: "visible",
    contentVisibility: "visible",
  };
  let style = visibleStyle;
  let box = {
    left: 20,
    top: 20,
    right: 120,
    bottom: 80,
    width: 100,
    height: 60,
  };
  let hit;
  const image = {
    complete: true,
    naturalWidth: 480,
    parentElement: null,
    contains: () => false,
    getBoundingClientRect: () => box,
  };
  const check = () => measureImageVisibility(image).visible;
  try {
    Object.assign(globalThis, {
      innerWidth: 390,
      innerHeight: 600,
      getComputedStyle: () => style,
      document: { elementFromPoint: () => hit },
    });
    hit = image;
    assert.equal(check(), true);
    for (const hidden of [
      { display: "none" },
      { visibility: "hidden" },
      { opacity: "0" },
      { contentVisibility: "hidden" },
    ]) {
      style = { ...visibleStyle, ...hidden };
      assert.equal(check(), false);
    }
    style = visibleStyle;
    const validBox = box;
    for (const bad of [
      { left: 400, right: 500 },
      { top: -100, bottom: -40 },
      { width: 0, right: 20 },
      { left: 380, right: 480 },
      { width: 10, right: 30 },
    ]) {
      box = { ...validBox, ...bad };
      assert.equal(check(), false);
    }
    box = validBox;
    hit = {};
    assert.equal(check(), false);
    hit = image;
    const parent = {
      parentElement: null,
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        right: 50,
        bottom: 600,
      }),
    };
    image.parentElement = parent;
    globalThis.getComputedStyle = (node) =>
      node === parent ? { ...visibleStyle, overflowX: "hidden" } : visibleStyle;
    assert.equal(check(), false, "ancestor clipping must be included");
    globalThis.getComputedStyle = (node) =>
      node === parent ? { ...visibleStyle, opacity: "0" } : visibleStyle;
    assert.equal(check(), false, "transparent ancestors must be included");
  } finally {
    keys.forEach((key, index) =>
      originals[index]
        ? Object.defineProperty(globalThis, key, originals[index])
        : delete globalThis[key],
    );
  }
});

test("incomplete browser cleanup fails even after successful screenshots", async () => {
  const { captureExitCode } =
    await import("../scripts/pending-image-visibility.mjs");
  assert.equal(captureExitCode("passed", true), 0);
  assert.equal(captureExitCode("passed", false), 1);
  assert.equal(captureExitCode("failed", true), 1);
  assert.equal(captureExitCode("not-started", true), 1);
  assert.match(capture, /assert\.equal\(\s*geometry\.visible,\s*true/);
  assert.match(capture, /assert\.equal\(\s*previewGeometry\.visible,\s*true/);
  assert.match(
    capture,
    /process\.exitCode = captureExitCode\(\s*lifecycle\.receipt\.captureStatus,\s*closed,?\s*\)/,
  );
  assert.ok(
    capture.indexOf('path.join(directory, "acceptance.json")') <
      capture.indexOf("process.exitCode ="),
  );
});

test("coordinate clicks reveal their target and settle layout before measuring", () => {
  const click = capture.slice(
    capture.indexOf("const click ="),
    capture.indexOf("const screenshot ="),
  );
  assert.ok(
    click.indexOf("scrollIntoView") < click.indexOf("requestAnimationFrame"),
  );
  assert.ok(
    click.indexOf("requestAnimationFrame") <
      click.indexOf("getBoundingClientRect"),
  );
  assert.match(click, /Input\.dispatchMouseEvent/);
});

test("canonical transition preserves synthetic images in authoritative canonical content", () => {
  assert.match(fixture, /const canonicalItem: CanonicalItem =/);
  assert.match(
    fixture,
    /images\.map\(\(image\) => \(\{\s*type: "image" as const,\s*attachment: image\.attachment/,
  );
  assert.match(
    fixture,
    /thread\.canonicalItems = canonical \? \[canonicalItem\] : \[\]/,
  );
  assert.match(fixture, /reconcileCanonicalAdmission\(s, \[canonicalItem\]\)/);
  assert.doesNotMatch(fixture, /threadAttachments=/);
});

test("capture waits for expected image counts and retains failed-transition diagnostics", () => {
  const expectedWait = capture.indexOf("Empty image lists must not pass");
  const decodeWait = capture.indexOf(
    "every(e => e.complete && e.naturalWidth > 0)",
  );
  assert.ok(expectedWait >= 0 && expectedWait < decodeWait);
  for (const count of ["draftImages", "pendingImages", "messageImages"])
    assert.ok(capture.includes(`length === \${${count}}`));
  assert.match(capture, /expectedState = \{/);
  assert.match(capture, /path\.join\(directory, "failure\.json"\)/);
  assert.match(capture, /await screenshot\("failure\.png"\)/);
  assert.match(capture, /await reportFailure\(error\)/);
  assert.ok(
    capture.indexOf("cases.push({ lang") < capture.indexOf("const record ="),
  );
});

test("virtual-row visibility waits use the bounded strict probe for thumbnails and preview", async () => {
  const start = capture.indexOf("const waitForVisibleImage =");
  const end = capture.indexOf("const click =", start);
  const helperSource = capture.slice(start, end);
  const { measureImageVisibility } =
    await import("../scripts/pending-image-visibility.mjs");
  assert.match(helperSource, /await wait\(/);
  assert.match(helperSource, /measureImageVisibility\.toString\(\)/);
  assert.match(capture, /for \(let i = 0; i < 200; i\+\+\)/);
  assert.match(capture, /throw Error\(`Condition timed out:/);
  assert.match(capture, /const geometry = await waitForVisibleImage/);
  assert.match(capture, /const previewGeometry = await waitForVisibleImage/);
  assert.match(capture, /observed\.imageGeometry = await evaluate/);
  let waited = false;
  const geometry = { visible: true, painted: true, coverage: 1 };
  const makeHelper = new Function(
    "wait",
    "evaluate",
    "measureImageVisibility",
    `${helperSource}; return waitForVisibleImage;`,
  );
  const helper = makeHelper(
    async (expression) => {
      assert.match(expression, /\?\.visible === true/);
      assert.match(expression, /style\.opacity/);
      waited = true;
    },
    async () => {
      assert.equal(
        waited,
        true,
        "do not sample the screenshot geometry before visible readiness",
      );
      return geometry;
    },
    measureImageVisibility,
  );
  assert.equal(await helper("document.querySelector('img')"), geometry);
  let sampled = false;
  const failing = makeHelper(
    async () => {
      throw Error("Condition timed out: still transparent");
    },
    async () => {
      sampled = true;
    },
    measureImageVisibility,
  );
  await assert.rejects(
    failing("document.querySelector('img')"),
    /still transparent/,
  );
  assert.equal(
    sampled,
    false,
    "persistent opacity must fail, not accept a screenshot",
  );
});
