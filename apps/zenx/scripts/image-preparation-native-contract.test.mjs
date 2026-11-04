import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const scripts = new URL("./", import.meta.url);

test("image acceptance uses real Host preparation and cold verification without Electron", async () => {
  const seed = await import(
    new URL("seed-user-question-acceptance.mjs", scripts)
  );
  assert.equal(typeof seed.seedImagePreparationAcceptance, "function");
  assert.equal(typeof seed.verifyImagePreparationAcceptance, "function");
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "zenx-image-contract-"),
  );
  const data = path.join(temporary, "data"),
    workspace = path.join(temporary, "workspace");
  await mkdir(workspace);
  try {
    const fixture = await seed.seedImagePreparationAcceptance({
      data,
      workspace,
    });
    const evidence = await seed.verifyImagePreparationAcceptance({
      data,
      workspace,
      fixture,
    });
    assert.equal(fixture.scenario, "image");
    assert.equal(
      evidence.scope,
      "synthetic-real-Host-model-adapter-input-not-HTTP",
    );
    assert.equal(evidence.threads.length, 2);
    for (const entry of evidence.threads) {
      assert.equal(entry.originalBytesUnchanged, true);
      assert.ok(entry.modelInputs.length >= 2);
      assert.equal(entry.agentNoticeEcho, false);
      assert.ok(entry.prepared.length > 0);
    }
    assert.ok(evidence.threads[1].unavailable.length > 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("native image branch preserves existing question guards, limits and artifact boundaries", async () => {
  const launcher = await readFile(
    new URL("launch-user-question-acceptance.mjs", scripts),
    "utf8",
  );
  const capture = await readFile(
    new URL("capture-user-question.cjs", scripts),
    "utf8",
  );
  const workflow = parse(
    await readFile(
      new URL(
        "../../../.github/workflows/user-question-ui.yml",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.match(launcher, /\["cards", "origin", "image"\]/);
  assert.match(launcher, /\)\(child, 240000\)/);
  assert.match(launcher, /Capture must use an unchanged production checkout/);
  assert.match(launcher, /assert.equal\(process.env.GITHUB_ACTIONS, "true"\)/);
  assert.match(capture, /assert.equal\(prefs.sandbox, true\)/);
  assert.match(capture, /assert.equal\(prefs.contextIsolation, true\)/);
  assert.match(capture, /assert.equal\(prefs.nodeIntegration, false\)/);
  assert.match(capture, /fixture.scenario === "image"/);
  assert.match(capture, /Image input prepared with/);
  assert.match(capture, /image-placeholder\[role=.?alert/);
  const job = workflow.jobs["native-question"];
  assert.equal(job["runs-on"], "macos-14");
  assert.equal(job["timeout-minutes"], 18);
  const origin = job.steps.find((s) => s.run?.trim().endsWith('" origin'));
  assert.equal(origin["timeout-minutes"], 6);
  const image = job.steps.find((s) => s.run?.trim().endsWith('" image'));
  assert.equal(image["timeout-minutes"], 6);
  const upload = job.steps.find(
    (s) => s.with?.name === "image-preparation-ui-macos-${{ github.sha }}",
  );
  assert.equal(upload.if, "always()");
  assert.deepEqual(
    upload.with.path
      .trim()
      .split("\n")
      .map((s) => s.split("/").at(-1)),
    [
      "source.json",
      "acceptance.json",
      "lifecycle.json",
      "image-evidence.json",
      "*.png",
    ],
  );
});
