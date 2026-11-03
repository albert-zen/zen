import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  createHostedAppServer,
  type HostedZenAppServer,
} from "../../../cli/src/host.js";
import { FileAttachmentStore } from "../../../../src/attachment.js";
import { FileItemListStore } from "../../../../src/item-list-store.js";
import { compileItemList } from "../../../../src/item-list.js";
import type { JsonValue, UserInput } from "../../../../src/item.js";
import type { ModelMessage } from "../../../../src/model.js";
import { modelMediaOrigin } from "../../../../src/model-media-origin.js";
import { ToolEnvironment } from "../../../../src/tool.js";
import { FileTraceStore } from "../../../../src/trace.js";

/** One owned synthetic fixture through the packaged Host, never an HTTP request. */
export async function verifyPackagedHostImagePreparation(
  temporaryDirectory = os.tmpdir(),
) {
  const directory = await mkdtemp(
    path.join(temporaryDirectory, "zenx-packaged-host-image-"),
  );
  let host: HostedZenAppServer | undefined;
  try {
    const attachmentDirectory = path.join(directory, "attachments");
    const attachments = new FileAttachmentStore(attachmentDirectory);
    const originalBytes = await sharp({
      create: { width: 2048, height: 2048, channels: 3, background: "#aabbcc" },
    })
      .png()
      .toBuffer();
    const original = await attachments.importBytes(originalBytes);
    const selection = { providerProfileId: "fake", modelId: "image-smoke" };
    host = createHostedAppServer({
      cwd: directory,
      dataDirectory: directory,
      approvalPolicy: "never",
      model: selection.modelId,
      provider: { type: "fake" },
      modelCatalog: [
        {
          id: selection.modelId,
          inputModalities: ["text", "image"],
          supportedReasoningEfforts: ["medium"],
          defaultReasoningEffort: "medium",
          contextWindow: 32768,
          source: "manual",
        },
      ],
      toolPresentation: "direct",
      toolEnvironment: new ToolEnvironment(),
      attachments,
    });
    const thread = await host.startThread();
    const input: UserInput = [
      { type: "text", text: "Synthetic packaged image before" },
      { type: "image", attachment: original },
      { type: "text", text: "Synthetic packaged image after" },
    ];
    const turn = await host.startTurn(thread.id, input);
    await turn.done;
    const snapshot = await host.readThread(thread.id);
    assert(
      snapshot.items.some(
        (item) =>
          item.type === "turn_completed" &&
          item.turnId === turn.id &&
          item.status === "completed",
      ),
      "synthetic image Turn must complete",
    );
    await host.closeHostResources();
    host = undefined;

    // Fresh readers exercise durable decoding, not the live Host's projections.
    const cold = await new FileItemListStore(
      path.join(directory, "threads", "items"),
    ).read(thread.id);
    const originalItem = cold.find(
      (item) => item.source.kind === "user_message",
    );
    assert(originalItem?.kind === "message");
    assert.deepEqual(originalItem.content.parts.slice(-input.length), input);
    const overlays = cold.filter(
      (item) => item.source.kind === "image_preparation",
    );
    assert.equal(
      overlays.length,
      1,
      "one image occurrence needs one durable overlay",
    );
    const overlay = overlays[0]!;
    assert(overlay.kind === "message");
    const metadata = overlay.source.metadata!;
    // FileItemListStore has strictly decoded the persisted overlay schema.
    const preparation = metadata.imagePreparation as Readonly<
      Record<string, JsonValue>
    >;
    assert.equal(preparation.outcome, "prepared");
    assert.equal(preparation.profile, "codex-high-v1");
    assert.deepEqual(metadata.selection, {
      ...selection,
      reasoningEffort: "medium",
    });
    const occurrence = {
      itemId: originalItem.id,
      field: "content",
      partIndex: input.findIndex((part) => part.type === "image"),
      sha256: original.sha256,
    };
    assert.deepEqual(preparation.occurrence, occurrence);
    const sampleId = metadata.onlySampleId;
    assert(typeof sampleId === "string");

    const trace = new FileTraceStore(path.join(directory, "trace"));
    const observed = await trace.read(thread.id);
    assert.equal(observed.completeness, "complete");
    const samples = observed.records.filter(
      (record) => record.type === "model_input",
    );
    assert.equal(
      samples.length,
      1,
      "the offline fake provider must receive one sample",
    );
    const sample = samples[0]!;
    assert.equal(sample.sampleId, sampleId);
    const inputArtifact = sample.artifacts.find(
      (artifact) => artifact.name === "model_input",
    );
    assert(inputArtifact, "real Host must capture its fake model input");
    const captured = JSON.parse(
      Buffer.from(await trace.readArtifact(inputArtifact.ref)).toString("utf8"),
    ) as { messages: ModelMessage[] };
    const sentImages = images(captured.messages);
    assert.equal(sentImages.length, 1);
    const sent = sentImages[0]!;
    assert.deepEqual(
      [sent.attachment.width, sent.attachment.height],
      [1600, 1600],
    );
    assert.notEqual(sent.attachment.sha256, original.sha256);

    const started = observed.records.find(
      (record) =>
        record.type === "model_sample_started" && record.sampleId === sampleId,
    );
    const selectedIds = (
      started?.data as { selectedItemIds?: string[] } | undefined
    )?.selectedItemIds;
    assert(selectedIds !== undefined);
    assert(
      selectedIds.includes(overlay.id),
      "sample must select its committed image overlay",
    );
    const selected = cold.filter((item) => selectedIds.includes(item.id));
    assert.equal(selected.length, selectedIds.length);
    const replay = compileItemList(selected, {
      sampleId,
      selection,
      inputModalities: ["text", "image"],
    });
    const replayImages = images(replay.messages);
    assert.equal(
      replayImages.length,
      1,
      "cold replay must not duplicate the overlay at the tail",
    );
    assert.deepEqual(replayImages[0]!.attachment, sent.attachment);
    assert.deepEqual(modelMediaOrigin(replayImages[0]!), occurrence);
    const replayUser = replay.messages.find(
      (message) =>
        message.role === "user" &&
        "content" in message &&
        message.content.some((part) => part.type === "image"),
    );
    assert(replayUser?.role === "user" && "content" in replayUser);
    const imageIndex = replayUser.content.findIndex(
      (part) => part.type === "image",
    );
    assert.deepEqual(replayUser.content[imageIndex - 2], input[0]);
    assert.deepEqual(replayUser.content[imageIndex + 1], input[2]);
    const notice = replayUser.content[imageIndex - 1];
    assert(notice?.type === "text");
    assert.match(notice.text, /2048x2048.*1600x1600.*original.*view_image/u);

    const coldAttachments = new FileAttachmentStore(attachmentDirectory);
    assert.deepEqual(
      Buffer.from(await coldAttachments.read(original)),
      originalBytes,
    );
    const preparedMetadata = await sharp(
      await coldAttachments.read(sent.attachment),
    ).metadata();
    assert.deepEqual(
      [preparedMetadata.width, preparedMetadata.height],
      [1600, 1600],
    );
    return {
      syntheticFixture: true,
      provider: "fake",
      originalDimensions: [2048, 2048],
      preparedDimensions: [1600, 1600],
      modelInputImages: sentImages.length,
      durablePreparationOverlays: overlays.length,
      originalBytesPreserved: true,
      coldCompilerMatches: true,
    };
  } finally {
    try {
      await host?.closeHostResources();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function images(messages: readonly ModelMessage[]) {
  return messages
    .flatMap((message) =>
      message.role === "user" && "content" in message
        ? message.content
        : message.role === "tool"
          ? (message.modelContent ?? [])
          : [],
    )
    .filter((part) => part.type === "image");
}
