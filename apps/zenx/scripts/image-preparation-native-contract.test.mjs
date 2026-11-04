import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
    for (const entry of evidence.threads)
      assert.match(entry.semanticItemListSha256, /^[a-f0-9]{64}$/);
    const { createHostedAppServer } =
      await import("../../../dist/apps/cli/src/host.js");
    const { compileItemList } = await import("../../../dist/src/item-list.js");
    const host = createHostedAppServer({
      cwd: workspace,
      dataDirectory: data,
      provider: { type: "fake" },
      model: "fake",
      approvalPolicy: "never",
    });
    let snapshot;
    try {
      snapshot = await host.readThread(fixture.threads[1].threadId);
    } finally {
      await host.closeHostResources();
    }
    const digest = (items) =>
      createHash("sha256").update(JSON.stringify(items)).digest("hex");
    assert.equal(
      digest(snapshot.itemList),
      evidence.threads[1].semanticItemListSha256,
    );
    const changedHistory = structuredClone(snapshot.itemList);
    changedHistory.find(
      (item) => item.source.kind === "user_message",
    ).content.text += " unrelated mutation";
    assert.notEqual(
      digest(changedHistory),
      evidence.threads[1].semanticItemListSha256,
      "even an unrelated semantic text edit invalidates the history receipt",
    );
    const sampleId = evidence.threads[1].modelInputs[0].sampleId;
    const valid = {
      sampleId,
      user: snapshot.items.find((item) => item.type === "user_message"),
      originals: fixture.threads[1].originals,
      overlays: snapshot.itemList.filter(
        (item) => item.source.kind === "image_preparation",
      ),
      messages: compileItemList(snapshot.itemList, {
        sampleId,
        inputModalities: ["text", "image"],
      }).messages,
    };
    seed.assertImagePreparationSample(valid);
    const replaced = structuredClone(valid);
    replaced.messages
      .flatMap((message) => message.content ?? message.modelContent ?? [])
      .find((part) => part.type === "image").attachment.sha256 = "0".repeat(64);
    assert.throws(
      () => seed.assertImagePreparationSample(replaced),
      /exact prepared attachment/,
      "same-size 1600px substitute cannot pass",
    );
    const wrongOccurrence = structuredClone(valid);
    wrongOccurrence.overlays.find(
      (item) => item.source.metadata.onlySampleId === sampleId,
    ).source.metadata.imagePreparation.occurrence.partIndex = 99;
    assert.throws(
      () => seed.assertImagePreparationSample(wrongOccurrence),
      /exact original user image occurrence/,
    );
    const wrongOriginal = structuredClone(valid);
    wrongOriginal.overlays.find(
      (item) => item.source.metadata.onlySampleId === sampleId,
    ).source.metadata.imagePreparation.originalAttachment.sha256 = "0".repeat(
      64,
    );
    assert.throws(
      () => seed.assertImagePreparationSample(wrongOriginal),
      /exact original receipt/,
    );
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

test("thumbnail diagnostics measure decode state without refetching restricted blobs", async () => {
  const { runInNewContext } = await import("node:vm");
  const capture = await readFile(
    new URL("capture-user-question.cjs", scripts),
    "utf8",
  );
  const start = capture.indexOf(
    "async function collectImageThumbnailDiagnostics(",
  );
  const end = capture.indexOf(
    "// Accept only independently proven browser terminal states",
    start,
  );
  const diagnosticSource = capture.slice(start, end).trim();
  assert.doesNotMatch(diagnosticSource, /fetch\(|crypto\.subtle|arrayBuffer\(/);
  const images = [2048, 1].map((size, index) => ({
    complete: true,
    naturalWidth: size,
    naturalHeight: size,
    currentSrc: `blob:owned-${index}`,
    decode: async () => {
      if (index) throw new Error("Synthetic decoder rejection");
    },
  }));
  const buttons = images.map((image) => ({
    querySelector: (selector) => (selector === "img" ? image : null),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 120, height: 90 }),
    disabled: false,
    getAttribute: () => "false",
  }));
  const collect = runInNewContext(`(${diagnosticSource})`, {
    document: { querySelectorAll: () => buttons },
    setTimeout,
    clearTimeout,
    fetch: () => {
      throw new Error("Must not add a second blob read");
    },
  });
  const result = JSON.parse(JSON.stringify(await collect([])));
  assert.equal(result[0].decode.status, "resolved");
  assert.equal(result[1].decode.status, "rejected");
  assert.equal(
    result[1].placeholder,
    null,
    "decoder rejection is not invented as product alert state",
  );
  for (const value of result) {
    assert.match(
      value.identityEvidence,
      /mounted blob identity not directly measured/,
    );
    assert.equal(value.blob, undefined);
  }
  assert.match(capture, /exact Host canonical original refs/);
  assert.match(capture, /normal original must actually decode in the browser/);
  assert.match(
    capture,
    /real Host seed evidence for the displayed owner is required/,
  );
});

test("browser outcome requires actual decode, original dimensions and Host reference without claiming blob identity", async () => {
  const { runInNewContext } = await import("node:vm");
  const capture = await readFile(
    new URL("capture-user-question.cjs", scripts),
    "utf8",
  );
  const start = capture.indexOf("function unavailableImageBrowserOutcome(");
  const end = capture.indexOf("// Image-only read/preview acceptance.", start);
  const classify = runInNewContext(`(${capture.slice(start, end).trim()})`, {
    assert,
  });
  const original = {
    type: "attachment",
    mediaType: "image/png",
    width: 1,
    height: 1,
    sha256: "1".repeat(64),
    byteLength: 90,
  };
  const valid = {
    image: { complete: true, naturalWidth: 1, naturalHeight: 1 },
    placeholder: null,
    decode: { status: "resolved" },
    disabled: false,
    busy: "false",
    sourceProtocol: "blob",
  };
  assert.equal(
    classify(valid, original),
    "browser-original-visible/model-unavailable",
  );
  assert.equal(
    classify({ image: null, placeholder: { role: "alert" } }, original),
    "browser-unavailable/model-unavailable",
  );
  assert.throws(
    () => classify(valid, undefined),
    /Host original reference is required/,
  );
  assert.throws(() => classify(valid, { ...original, sha256: "missing" }));
  for (const mutate of [
    (v) => {
      v.decode.status = "rejected";
    },
    (v) => {
      v.decode.status = "timeout";
    },
    (v) => {
      v.image.complete = false;
    },
    (v) => {
      v.image.naturalWidth = 0;
    },
    (v) => {
      v.image.naturalWidth = 1600;
    },
    (v) => {
      v.sourceProtocol = "https";
    },
    (v) => {
      v.image = null;
      v.placeholder = { role: "status" };
    },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => classify(invalid, original));
  }
  // This assertion deliberately does not claim to detect same-dimension browser
  // byte substitution: mounted bytes are not directly measured. Host/model
  // substitution and exact occurrence negative controls remain in the first test.
  assert.doesNotMatch(capture.slice(start, end), /thumbnail\.blob/);
});
