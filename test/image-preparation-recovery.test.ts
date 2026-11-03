import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { prepareSampleImages } from "../src/image-preparation.js";
import { compileItemList, type ContextItem } from "../src/item-list.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { sampledMediaOccurrences } from "../src/loop-recovery.js";
import { modelMediaOrigin } from "../src/model-media-origin.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolEnvironment } from "../src/tool.js";

async function convergentImages() {
  const attachments = new InMemoryAttachmentStore();
  const refs = await Promise.all(
    [2048, 3000].map(
      async (width) =>
        await attachments.importBytes(
          await sharp({
            create: { width, height: width, channels: 3, background: "blue" },
          })
            .png()
            .toBuffer(),
        ),
    ),
  );
  assert.notEqual(refs[0]!.sha256, refs[1]!.sha256);
  return { attachments, refs };
}

test("exact rejection and diagnostic selection retain distinct origins when prepared pixels converge", async () => {
  const { attachments, refs } = await convergentImages();
  const item: ContextItem = {
    id: "input",
    threadId: "thread",
    createdAt: "2026-11-03T00:00:00Z",
    kind: "message",
    role: "user",
    source: { kind: "user_message", sequence: 0 },
    content: {
      text: "",
      parts: refs.map((attachment) => ({ type: "image", attachment })),
    },
  };
  let next = 0;
  const overlays = await prepareSampleImages({
    threadId: "thread",
    sampleId: "sample",
    itemList: [item],
    selection: { providerProfileId: "synthetic", modelId: "model" },
    inputModalities: ["text", "image"],
    attachments,
    id: () => `overlay-${next++}`,
    now: () => item.createdAt,
  });
  const compiled = compileItemList([item, ...overlays], {
    sampleId: "sample",
    inputModalities: ["text", "image"],
  });
  const images = compiled.messages
    .flatMap((message) =>
      message.role === "user" && "content" in message ? message.content : [],
    )
    .filter((part) => part.type === "image");
  assert.equal(images.length, 2);
  assert.equal(images[0]!.attachment.sha256, images[1]!.attachment.sha256);
  const origins = images.map((image) => modelMediaOrigin(image)!);
  for (const modalities of [["text", "image"], null]) {
    assert.deepEqual(
      sampledMediaOccurrences([], compiled.messages, modalities, [images[1]!]),
      [origins[1]],
    );
    assert.deepEqual(
      sampledMediaOccurrences([], compiled.messages, modalities),
      origins,
    );
  }
  assert.deepEqual(
    sampledMediaOccurrences([], compiled.messages, ["text"]),
    [],
  );
});

for (const unknown of [false, true])
  test(`real Host recovery with ${unknown ? "Unknown" : "known"} modalities omits exactly the rejected convergent occurrence`, async () => {
    const { attachments, refs } = await convergentImages();
    const counts: number[] = [];
    const adapter = new OpenAiCompatibleModel({
      provider: "synthetic",
      baseUrl: "https://synthetic.invalid/v1",
      apiKey: "synthetic-not-real",
      attachments,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const paths: string[] = [];
        body.messages.forEach((message: any, messageIndex: number) =>
          message.content?.forEach?.((part: any, partIndex: number) => {
            if (part.type === "image_url")
              paths.push(
                `messages[${messageIndex}].content[${partIndex}].image_url`,
              );
          }),
        );
        counts.push(paths.length);
        if (counts.length === 1)
          return new Response(
            JSON.stringify({
              error: {
                code: "invalid_image_url",
                message: "Synthetic invalid image URL",
                param: paths.at(-1),
              },
            }),
            { status: 400 },
          );
        return new Response(
          'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      },
    });
    const tools = new ToolEnvironment({ runtimes: [] });
    const server = new ZenAppServer({
      journal: new InMemoryThreadJournal(),
      attachments,
      runtime: new AgentRuntime({
        toolEnvironment: tools,
        sampleRetry: { sleep: async () => {}, random: () => 0 },
      }),
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: "synthetic",
          adapter,
          modelCatalog: new StaticModelCatalog([
            {
              id: "known",
              isDefault: true,
              contextWindow: 32768,
              inputModalities: ["text", "image"],
            },
            { id: "unknown", contextWindow: 32768, inputModalities: null },
          ]),
        },
      ]),
      threadMetadata: new InMemoryThreadMetadataStore(),
      defaults: {
        cwd: process.env.TMPDIR ?? "/tmp",
        providerProfileId: "synthetic",
        modelId: "known",
        reasoningEffort: "medium",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
    });
    try {
      const thread = await server.startThread();
      if (unknown)
        await server.updateThreadSettings(thread.id, {
          selection: { providerProfileId: "synthetic", modelId: "unknown" },
        });
      await (
        await server.startTurn(
          thread.id,
          refs.map((attachment) => ({ type: "image", attachment })),
        )
      ).done;
      const snapshot = await server.readThread(thread.id);
      const user = snapshot.items.find((item) => item.type === "user_message")!;
      const failure = snapshot.items.find(
        (item) => item.type === "failure" && item.recovery !== undefined,
      )!;
      assert(failure.type === "failure" && failure.recovery !== undefined);
      assert.equal(failure.recovery.mediaScope, "exact");
      assert.deepEqual(failure.recovery.withheldMedia, [
        {
          itemId: user.id,
          field: "content",
          partIndex: 1,
          sha256: refs[1]!.sha256,
        },
      ]);
      assert.deepEqual(counts, [2, 1]);
      assert.equal(snapshot.turns[0]!.status, "completed");
      assert.deepEqual(
        Buffer.from(await attachments.read(refs[0]!)),
        Buffer.from(await attachments.read(refs[0]!)),
      );
    } finally {
      await tools.close();
    }
  });
