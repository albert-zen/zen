import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  createHostedAppServer,
  type ZenHostOptions,
} from "../apps/cli/src/host.js";
import { FileAttachmentStore } from "../src/attachment.js";
import { compileItemList, type ContextItem } from "../src/item-list.js";
import type { JsonValue } from "../src/item.js";
import { modelMediaOrigin } from "../src/model-media-origin.js";
import { ToolEnvironment } from "../src/tool.js";

test("real Host fork cold replay remaps prepared user/tool occurrences while preserving same-hash images and prose", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-prepared-fork-"));
  const attachments = new FileAttachmentStore(
    path.join(directory, "attachments"),
  );
  const originalBytes = await sharp({
    create: { width: 2048, height: 2048, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  const original = await attachments.importBytes(originalBytes);
  const makeTools = () => {
    const environment = new ToolEnvironment({ runtimes: [] });
    environment.registerRuntime(
      {
        name: "fixture_images",
        specification: {
          name: "fixture_images",
          description: "Return repeated synthetic images",
          inputSchema: { type: "object", properties: {} },
        },
        execute: async () => ({
          output: "Synthetic tool images",
          exitCode: 0,
          modelContent: [
            { type: "image", attachment: original },
            { type: "image", attachment: original },
          ],
        }),
      },
      { kind: "builtin", id: "fixture-images" },
    );
    return environment;
  };
  const options: ZenHostOptions = {
    cwd: directory,
    dataDirectory: directory,
    approvalPolicy: "never",
    model: "image-model",
    provider: {
      type: "openai-compatible",
      baseUrl: "https://synthetic.invalid/v1",
      apiKey: "synthetic-not-real",
    },
    modelCatalog: [
      {
        id: "image-model",
        inputModalities: ["text", "image"],
        supportedReasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
        contextWindow: 32768,
        source: "manual",
      },
    ],
    toolPresentation: "direct",
    attachments,
  };
  const oldFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    const delta =
      ++requests === 1
        ? {
            tool_calls: [
              {
                index: 0,
                id: "fixture",
                type: "function",
                function: { name: "fixture_images", arguments: "{}" },
              },
            ],
          }
        : { content: "done" };
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: requests === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  };
  const host = createHostedAppServer({
    ...options,
    toolEnvironment: makeTools(),
  });
  try {
    const source = await host.startThread();
    await (
      await host.startTurn(source.id, [
        { type: "image", attachment: original },
        { type: "image", attachment: original },
      ])
    ).done;
    const parent = await host.readThread(source.id);
    const fork = await host.forkThread({
      sourceThreadId: source.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    });
    await host.closeHostResources();
    const cold = createHostedAppServer({
      ...options,
      toolEnvironment: makeTools(),
    });
    try {
      const child = await cold.readThread(fork.id);
      const parentPrep = parent.itemList!.filter(
        (item) => item.source.kind === "image_preparation",
      );
      const childPrep = child.itemList!.filter(
        (item) => item.source.kind === "image_preparation",
      );
      assert(parentPrep.length > 0);
      assert.equal(childPrep.length, parentPrep.length);
      const parentIds = new Set(parent.items.map((item) => item.id));
      const childIds = new Set(child.items.map((item) => item.id));
      const occurrence = (item: ContextItem) =>
        (
          item.source.metadata!.imagePreparation as {
            occurrence: { itemId: string; field: string; partIndex: number };
            originalAttachment: JsonValue;
          }
        ).occurrence;
      for (let index = 0; index < childPrep.length; index++) {
        const childItem = childPrep[index]!;
        const parentItem = parentPrep[index]!;
        assert(childIds.has(occurrence(childItem).itemId));
        assert(!parentIds.has(occurrence(childItem).itemId));
        assert.deepEqual(
          childItem.content,
          parentItem.content,
          "fork must not rewrite persisted pixels, original reference, or notice prose",
        );
        const sourceMetadata = parentItem.source.metadata!
          .imagePreparation as Record<string, JsonValue>;
        const childMetadata = childItem.source.metadata!
          .imagePreparation as Record<string, JsonValue>;
        assert.deepEqual(
          childMetadata.originalAttachment,
          sourceMetadata.originalAttachment,
        );
      }
      const imagesFor = (items: readonly ContextItem[], sampleId: string) =>
        compileItemList(JSON.parse(JSON.stringify(items)), {
          sampleId,
          selection: {
            providerProfileId: "openai-compatible",
            modelId: "image-model",
          },
          inputModalities: ["text", "image"],
        })
          .messages.flatMap((message) =>
            message.role === "user" && "content" in message
              ? message.content
              : message.role === "tool"
                ? (message.modelContent ?? [])
                : [],
          )
          .filter((part) => part.type === "image");
      const parentSample = String(
        parentPrep.at(-1)!.source.metadata!.onlySampleId,
      );
      const childSample = String(
        childPrep.at(-1)!.source.metadata!.onlySampleId,
      );
      const parentImages = imagesFor(parent.itemList!, parentSample);
      const childImages = imagesFor(child.itemList!, childSample);
      assert.equal(parentImages.length, 4);
      assert.equal(childImages.length, 4);
      assert.deepEqual(
        childImages.map((part) => part.attachment),
        parentImages.map((part) => part.attachment),
      );
      assert(
        childImages.every(
          (part) =>
            part.attachment.width === 1600 && part.attachment.height === 1600,
        ),
      );
      const origins = childImages.map((part) => modelMediaOrigin(part)!);
      assert.deepEqual(
        origins.map((origin) => origin.field),
        ["content", "content", "modelContent", "modelContent"],
      );
      assert.deepEqual(
        origins.map((origin) => origin.partIndex),
        [0, 1, 0, 1],
      );
      assert(
        origins.every(
          (origin) =>
            childIds.has(origin.itemId) && origin.sha256 === original.sha256,
        ),
      );
      assert.deepEqual(
        Buffer.from(await attachments.read(original)),
        originalBytes,
      );
      assert.equal(
        requests,
        2,
        "cold fork inspection must not invoke the model or re-run a tool",
      );
    } finally {
      await cold.closeHostResources();
    }
  } finally {
    await host.closeHostResources();
    globalThis.fetch = oldFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
