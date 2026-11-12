import assert from "node:assert/strict";
import test from "node:test";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { prepareSampleContext } from "../src/context-preparation.js";
import { compileItemList, type ContextItem } from "../src/item-list.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import type { ModelAdapter, ModelMessage, ModelRequest } from "../src/model.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolEnvironment } from "../src/tool.js";
import { png1x1 } from "./fixtures.js";

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

function paddedPng(): Uint8Array {
  const png = Buffer.from(png1x1());
  const data = Buffer.alloc(4 * 1024 * 1024, 65);
  data.set(Buffer.from("synthetic\0"));
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write("tEXt", 4);
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}

test("rollback removes both fixed defaults from real Host samples without changing attachments", async () => {
  const attachments = new InMemoryAttachmentStore();
  const small = await attachments.importBytes(png1x1());
  const bigBytes = paddedPng();
  const big = await attachments.importBytes(bigBytes);
  let actual: ModelRequest | undefined;
  const model: ModelAdapter = {
    provider: "synthetic",
    async *stream(request) {
      actual = request;
      yield { type: "text_delta", delta: "ok" };
    },
  };
  const environment = new ToolEnvironment({ runtimes: [] });
  const server = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    attachments,
    runtime: new AgentRuntime({ toolEnvironment: environment }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "synthetic",
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          {
            id: "image-model",
            isDefault: true,
            contextWindow: 100000,
            inputModalities: ["text", "image"],
          },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: "/tmp",
      providerProfileId: "synthetic",
      modelId: "image-model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  try {
    const thread = await server.startThread();
    for (let index = 0; index < 30; index++)
      await (
        await server.startTurn(thread.id, [
          { type: "image", attachment: index < 27 ? small : big },
        ])
      ).done;
    assert(actual !== undefined);
    const sent = images(actual.messages);
    assert.equal(sent.length, 30, "there is no implicit 24-image cap");
    assert(
      sent.reduce((sum, part) => sum + part.attachment.byteLength, 0) >
        8 * 1024 * 1024,
      "there is no implicit 8-MiB aggregate cap",
    );
    assert.doesNotMatch(
      JSON.stringify(actual.messages),
      /omitted from this request by the image budget/u,
    );
    assert.deepEqual([...(await attachments.read(big))], [...bigBytes]);
    assert.equal(
      (await server.readThread(thread.id)).items.filter(
        (item) => item.type === "user_message",
      ).length,
      30,
    );
  } finally {
    await environment.close();
  }
});

test("rollback preserves stored budget-era sample receipts and lets future samples see original media", async () => {
  const ref = await new InMemoryAttachmentStore().importBytes(png1x1());
  const base = { threadId: "thread", createdAt: "2026-11-03T00:00:00Z" };
  const items: ContextItem[] = Array.from({ length: 25 }, (_, sequence) => ({
    ...base,
    id: `image-${sequence}`,
    kind: "message",
    role: "user",
    source: { kind: "user_message", sequence },
    content: { text: "", parts: [{ type: "image", attachment: ref }] },
  }));
  const text = `[image 1x1, ${ref.byteLength} bytes omitted from this request by the image budget; pixels were not read in this sample. Retrieve the original with view_image({"attachment":${JSON.stringify(ref)}}) if needed.]`;
  items.push({
    ...base,
    id: "old-budget",
    kind: "message",
    role: "user",
    source: {
      kind: "media_unavailable",
      sequence: 24,
      metadata: {
        onlySampleId: "old-sample",
        omittedMedia: [
          {
            itemId: "image-0",
            field: "content",
            partIndex: 0,
            sha256: ref.sha256,
          },
        ],
      },
    },
    content: { text, parts: [{ type: "text", text }] },
  });
  const bytes = JSON.stringify(items);
  const cold = JSON.parse(bytes) as ContextItem[];
  const old = compileItemList(cold, {
    sampleId: "old-sample",
    inputModalities: ["text", "image"],
  });
  assert.equal(images(old.messages).length, 24);
  assert(
    old.messages.some(
      (message) =>
        message.role === "user" &&
        "content" in message &&
        message.content.some(
          (part) => part.type === "text" && part.text === text,
        ),
    ),
  );
  let next = 0;
  const additions = prepareSampleContext({
    threadId: "thread",
    sampleId: "new-sample",
    items: [],
    itemList: cold,
    sandbox: "danger-full-access",
    tools: [],
    inputModalities: ["text", "image"],
    id: () => `new-${next++}`,
    now: () => base.createdAt,
  });
  assert.equal(
    images(
      compileItemList([...cold, ...additions], {
        sampleId: "new-sample",
        inputModalities: ["text", "image"],
      }).messages,
    ).length,
    25,
  );
  assert.equal(
    JSON.stringify(cold),
    bytes,
    "existing semantic bytes are never rewritten",
  );
});
