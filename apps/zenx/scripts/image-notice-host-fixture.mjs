/** Owned synthetic images through the production Host, never authored overlays. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createHostedAppServer } from "../../../dist/apps/cli/src/host.js";
import { FileAttachmentStore } from "../../../dist/src/attachment.js";
import { FileItemListStore } from "../../../dist/src/item-list-store.js";
import { compileItemList } from "../../../dist/src/item-list.js";
import { ToolEnvironment } from "../../../dist/src/tool.js";
import { FileTraceStore } from "../../../dist/src/trace.js";

export const imageModel = Object.freeze({
  id: "image-notice-fake",
  displayName: "Synthetic image model",
  description: "Offline image preparation and disclosure fixture",
  hidden: false,
  source: "manual",
  supportedReasoningEfforts: ["medium"],
  defaultReasoningEffort: "medium",
  inputModalities: ["text", "image"],
  contextWindow: 100000000,
});
export const imageSelection = Object.freeze({ providerProfileId: "fake", modelId: imageModel.id });
export const imageFollowupText = "Synthetic native image disclosure second sample";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function seedImageNotice({ isolationRoot, dataDirectory, workspace }) {
  const root = await realpath(isolationRoot);
  for (const candidate of [dataDirectory, workspace]) {
    const relative = path.relative(root, await realpath(candidate));
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  }
  const attachments = new FileAttachmentStore(path.join(dataDirectory, "attachments"));
  // Same dimensions, codec and origin as packaged-host-image-smoke.ts (#674).
  const originalBytes = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: "#aabbcc" } }).png().toBuffer();
  const original = await attachments.importBytes(originalBytes);
  const host = createHostedAppServer({
    cwd: workspace, dataDirectory, approvalPolicy: "never",
    model: imageModel.id, provider: { type: "fake" }, modelCatalog: [imageModel],
    toolPresentation: "direct", toolEnvironment: new ToolEnvironment(), attachments,
  });
  const threads = [];
  try {
    for (const label of ["A", "B"]) {
      const thread = await host.startThread();
      const turn = await host.startTurn(thread.id, [
        { type: "text", text: `Synthetic image disclosure Thread ${label}` },
        { type: "image", attachment: original },
      ]);
      await turn.done;
      const snapshot = await host.readThread(thread.id);
      assert(snapshot.items.some((item) => item.type === "turn_completed" && item.turnId === turn.id && item.status === "completed"));
      threads.push({ label, threadId: thread.id });
    }
  } finally { await host.closeHostResources(); }
  const manifest = { synthetic: true, provider: "fake", original, originalSha256: digest(originalBytes), threads, followupText: imageFollowupText };
  await verifyImageNoticeCold({ dataDirectory, manifest, afterNativeSend: false });
  await writeFile(path.join(isolationRoot, "image-notice-private-fixture.json"), JSON.stringify(manifest));
  return manifest;
}

/** Only called after each writer Host has closed; no live journal inspection. */
export async function verifyImageNoticeCold({ dataDirectory, manifest, afterNativeSend }) {
  assert.equal(manifest.synthetic, true);
  const attachments = new FileAttachmentStore(path.join(dataDirectory, "attachments"));
  assert.equal(digest(await attachments.read(manifest.original)), manifest.originalSha256);
  const trace = new FileTraceStore(path.join(dataDirectory, "trace"));
  const evidence = [];
  try {
    for (const { label, threadId } of manifest.threads) {
      const cold = await new FileItemListStore(path.join(dataDirectory, "threads/items")).read(threadId);
      const originalItem = cold.find((item) => item.source.kind === "user_message");
      assert.equal(originalItem?.kind, "message");
      assert.deepEqual(originalItem.content.parts.find((part) => part.type === "image")?.attachment, manifest.original);
      const observed = await trace.read(threadId);
      assert.equal(observed.completeness, "complete");
      assert.equal(observed.records.filter((record) => record.type.startsWith("context_compaction_")).length, 0);
      const samples = observed.records.filter((record) => record.type === "model_input");
      const expectedSamples = label === "A" && afterNativeSend ? 2 : 1;
      assert.equal(samples.length, expectedSamples);
      const overlays = cold.filter((item) => item.source.kind === "image_preparation");
      assert.equal(overlays.length, expectedSamples);
      assert.equal(new Set(samples.map((sample) => sample.sampleId)).size, expectedSamples);
      for (const sample of samples) {
        const overlay = overlays.find((item) => item.source.metadata?.onlySampleId === sample.sampleId);
        assert.equal(overlay?.kind, "message");
        assert.equal(overlay.source.metadata.imagePreparation.outcome, "prepared");
        assert.equal(overlay.source.metadata.imagePreparation.profile, "codex-high-v1");
        const artifact = sample.artifacts.find((entry) => entry.name === "model_input");
        assert(artifact);
        const captured = JSON.parse(Buffer.from(await trace.readArtifact(artifact.ref)).toString("utf8"));
        const sent = images(captured.messages);
        assert.equal(sent.length, 1);
        assert.deepEqual([sent[0].attachment.width, sent[0].attachment.height], [1600, 1600]);
        assert.notEqual(sent[0].attachment.sha256, manifest.original.sha256);
        const selected = observed.records.find((record) => record.type === "model_sample_started" && record.sampleId === sample.sampleId)?.data?.selectedItemIds;
        assert(selected?.includes(overlay.id));
        const replay = compileItemList(cold.filter((item) => selected.includes(item.id)), { sampleId: sample.sampleId, selection: imageSelection, inputModalities: ["text", "image"] });
        assert.deepEqual(images(replay.messages).map((part) => part.attachment), sent.map((part) => part.attachment));
        const dimensions = await sharp(await attachments.read(sent[0].attachment)).metadata();
        assert.deepEqual([dimensions.width, dimensions.height], [1600, 1600]);
      }
      if (label === "A" && afterNativeSend) assert.equal(cold.filter((item) => item.source.kind === "user_message" && item.kind === "message" && item.content.parts.some((part) => part.type === "text" && part.text === imageFollowupText)).length, 1);
      evidence.push({ thread: label, samples: samples.length, overlays: overlays.length, modelInputImagesPerSample: 1, originalBytesPreserved: true, coldCompilerMatches: true });
    }
  } finally { await trace.flush(); }
  return { independentColdRead: true, afterNativeSend, originalDimensions: [2048, 2048], preparedDimensions: [1600, 1600], threads: evidence };
}
function images(messages) {
  return messages.flatMap((message) => message.role === "user" && "content" in message ? message.content : message.role === "tool" ? message.modelContent ?? [] : []).filter((part) => part.type === "image");
}
