import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import {
  AttachmentStoreError,
  InMemoryAttachmentStore,
  FileAttachmentStore,
} from "../src/attachment.js";
import {
  compileItemList,
  decodeContextItem,
  type ContextItem,
} from "../src/item-list.js";
import {
  ImagePreparationError,
  prepareSampleImages,
} from "../src/image-preparation.js";
import { ToolEnvironment } from "../src/tool.js";

async function undecodablePng(width = 1): Promise<Uint8Array> {
  const bytes = await sharp({
    create: { width, height: width, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      bytes.fill(0, offset + 8, offset + 8 + length);
      let crc = 0xffffffff;
      for (const byte of bytes.subarray(offset + 4, offset + 8 + length)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
          crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, offset + 8 + length);
    }
    offset += length + 12;
  }
  return bytes;
}

test("an admitted undecodable image becomes a durable per-sample placeholder without blocking later Turns or compaction", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-unavailable-image-"),
  );
  const attachments = new FileAttachmentStore(
    path.join(directory, "attachments"),
  );
  const bytes = await undecodablePng();
  const original = await attachments.importBytes(bytes);
  const previousFetch = globalThis.fetch;
  const bodies: any[] = [];
  const prefixes: ContextItem[][] = [];
  let threadId = "";
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    prefixes.push(
      (
        await readFile(
          path.join(directory, "threads/items", `${threadId}.jsonl`),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
    return new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"Synthetic answer or summary"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  };
  const options: import("../apps/cli/src/host.js").ZenHostOptions = {
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
    toolEnvironment: new ToolEnvironment(),
    attachments,
  };
  const host = createHostedAppServer(options);
  try {
    const thread = await host.startThread();
    threadId = thread.id;
    await (
      await host.startTurn(thread.id, [{ type: "image", attachment: original }])
    ).done;
    await (
      await host.startTurn(
        thread.id,
        "Continue with text despite the unavailable image",
      )
    ).done;
    let compactionErrorCode: string | undefined;
    try {
      await host.compactThread(thread.id, { includeOriginalReference: false });
    } catch (error) {
      compactionErrorCode = String(
        (error as { code?: unknown }).code ?? "unexpected_error",
      );
    }
    const snapshot = await host.readThread(thread.id);
    const statuses = snapshot.turns.map((turn) => turn.status);
    console.log(
      JSON.stringify({
        admittedUndecodableImage: true,
        turnStatuses: statuses,
        actualRequests: bodies.length,
        compactionErrorCode,
      }),
    );
    assert.deepEqual(statuses, ["completed", "completed"]);
    assert.equal(compactionErrorCode, undefined);
    assert.equal(bodies.length, 3);
    assert(
      !bodies.some((body) => JSON.stringify(body).includes('"image_url"')),
    );
    const user = snapshot.items.find((item) => item.type === "user_message")!;
    assert(user.type === "user_message" && user.content !== undefined);
    assert.deepEqual(user.content, [{ type: "image", attachment: original }]);
    assert.deepEqual(
      Buffer.from(await attachments.read(original)),
      Buffer.from(bytes),
    );
    const firstPrefix = prefixes[0]!;
    const placeholder = firstPrefix.find(
      (item) => item.source.kind === "image_preparation",
    )!;
    assert(placeholder.kind === "message");
    assert.match(
      placeholder.content.text,
      /unavailable.*No image pixels.*original attachment/iu,
    );
    assert.doesNotMatch(
      placeholder.content.text,
      /pngload|libpng|vips|invalid.*block|\/workspace\/|\/private\//iu,
    );
    const metadata = placeholder.source.metadata!.imagePreparation as Record<
      string,
      unknown
    >;
    assert.equal(metadata.outcome, "unavailable");
    assert.equal(metadata.reason, "image_decode_failed");
    assert.equal(placeholder.content.parts.length, 1);
    const cold = compileItemList(JSON.parse(JSON.stringify(firstPrefix)), {
      sampleId: String(placeholder.source.metadata!.onlySampleId),
      inputModalities: ["text", "image"],
    });
    const content = cold.messages.flatMap((message) =>
      message.role === "user" && "content" in message ? message.content : [],
    );
    assert(
      content.some(
        (part) =>
          part.type === "text" && part.text === placeholder.content.text,
      ),
    );
    assert(!content.some((part) => part.type === "image"));
    await host.closeHostResources();
    const filename = path.join(directory, "threads/items", `${threadId}.jsonl`);
    const stored = (await readFile(filename, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const poisoned = stored.find(
      (item) => item.source.kind === "image_preparation",
    );
    poisoned.content.text += " private-codec-error /private/path.png";
    poisoned.content.parts[0].text = poisoned.content.text;
    await writeFile(
      filename,
      stored.map((item) => JSON.stringify(item)).join("\n") + "\n",
    );
    const coldHost = createHostedAppServer({
      ...options,
      toolEnvironment: new ToolEnvironment(),
    });
    try {
      await assert.rejects(
        coldHost.readThread(threadId),
        /unavailable image notice.*template|Invalid persisted context item/iu,
      );
      assert.equal(
        bodies.length,
        3,
        "tampered cold unavailable prose must never reach another wire request",
      );
    } finally {
      await coldHost.closeHostResources();
    }
  } finally {
    globalThis.fetch = previousFetch;
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  }
});

function userItem(
  attachment: Awaited<ReturnType<InMemoryAttachmentStore["importBytes"]>>,
  count = 1,
): ContextItem {
  return {
    id: "original",
    threadId: "thread",
    createdAt: "2026-11-03T00:00:00Z",
    kind: "message",
    role: "user",
    source: { kind: "user_message", sequence: 0 },
    content: {
      text: "",
      parts: Array.from({ length: count }, () => ({
        type: "image" as const,
        attachment,
      })),
    },
  };
}
function preparationOptions(
  itemList: readonly ContextItem[],
  attachments: Parameters<typeof prepareSampleImages>[0]["attachments"],
  sampleId = "sample",
) {
  let next = 0;
  return {
    threadId: "thread",
    sampleId,
    itemList,
    selection: { providerProfileId: "synthetic", modelId: "model" },
    inputModalities: ["text", "image"],
    attachments,
    id: () => `overlay-${sampleId}-${++next}`,
    now: () => "2026-11-03T00:00:00Z",
  };
}

test("unavailable metadata rejects forged outcome, pixels, identity, reason and original capability while legacy success remains readable", async () => {
  const store = new InMemoryAttachmentStore();
  const original = await store.importBytes(await undecodablePng());
  const [overlay] = await prepareSampleImages(
    preparationOptions([userItem(original)], store),
  );
  assert(overlay);
  assert.doesNotThrow(() => decodeContextItem(overlay));
  const invalid: Array<(value: any) => void> = [
    (value) => (value.source.metadata.imagePreparation.outcome = "future"),
    (value) =>
      (value.source.metadata.imagePreparation.reason =
        "raw private /workspace/error"),
    (value) => delete value.source.metadata.imagePreparation.originalAttachment,
    (value) =>
      (value.source.metadata.imagePreparation.originalAttachment.privatePath =
        "/private/path.png"),
    (value) =>
      (value.source.metadata.imagePreparation.originalAttachment.sha256 =
        "0".repeat(64)),
    (value) => delete value.source.metadata.imagePreparation.requestedDetail,
    (value) =>
      delete value.source.metadata.imagePreparation.supportsImageDetailOriginal,
    (value) =>
      (value.source.metadata.imagePreparation.profile = "codex-original-v1"),
    (value) => {
      value.source.metadata.imagePreparation.requestedDetail = "original";
      value.source.metadata.imagePreparation.supportsImageDetailOriginal = true;
    },
    (value) =>
      value.content.parts.push({ type: "image", attachment: original }),
    (value) => (value.content.parts[0].text = "different notice"),
    (value) => {
      value.content.text += " private-codec-error /private/path.png";
      value.content.parts[0].text = value.content.text;
    },
    (value) => {
      value.content.text = "";
      value.content.parts[0].text = "";
    },
  ];
  for (const mutate of invalid) {
    const value = JSON.parse(JSON.stringify(overlay));
    mutate(value);
    assert.throws(() => decodeContextItem(value));
  }
  const large = await store.importBytes(
    await sharp({
      create: { width: 2048, height: 2048, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer(),
  );
  const [success] = await prepareSampleImages(
    preparationOptions([userItem(large)], store),
  );
  const legacy = JSON.parse(JSON.stringify(success));
  delete legacy.source.metadata.imagePreparation.outcome;
  assert.doesNotThrow(() => decodeContextItem(legacy));
});

test("only codec operations become unavailable; missing/corrupt original or derived storage/import failures remain hard errors", async () => {
  const store = new InMemoryAttachmentStore();
  const original = await store.importBytes(
    await sharp({
      create: { width: 2048, height: 2048, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer(),
  );
  const item = userItem(original);
  const overlays = await prepareSampleImages(preparationOptions([item], store));
  for (const code of ["attachment_missing", "attachment_corrupt"] as const) {
    for (const cached of [false, true]) {
      const failing = {
        read: async () => {
          throw new AttachmentStoreError(code, "private /workspace/store path");
        },
        importBytes: store.importBytes.bind(store),
      };
      await assert.rejects(
        prepareSampleImages(
          preparationOptions(
            [item, ...(cached ? overlays : [])],
            failing,
            "next",
          ),
        ),
        (error) => {
          assert(error instanceof ImagePreparationError);
          assert(error.cause instanceof AttachmentStoreError);
          assert.equal(error.cause.code, code);
          assert.equal(error.retryable, false);
          assert.doesNotMatch(
            error.message,
            /private|workspace|original attachment is preserved/,
          );
          return true;
        },
      );
    }
  }
  await assert.rejects(
    prepareSampleImages(
      preparationOptions([item], {
        read: store.read.bind(store),
        importBytes: async () => {
          throw new Error("synthetic durable import failure");
        },
      }),
    ),
    (error) => {
      assert(error instanceof ImagePreparationError);
      assert.match(String(error.cause), /durable import failure/);
      return true;
    },
  );
  const preparedRef =
    overlays[0]!.kind === "message" ? overlays[0]!.content.parts[1] : undefined;
  assert(preparedRef?.type === "image");
  await assert.rejects(
    prepareSampleImages(
      preparationOptions(
        [item, ...overlays],
        {
          read: async (ref) => {
            if (ref.sha256 === preparedRef.attachment.sha256)
              throw new AttachmentStoreError(
                "attachment_missing",
                "derived missing",
              );
            return store.read(ref);
          },
          importBytes: store.importBytes.bind(store),
        },
        "cached-next",
      ),
    ),
    (error) => {
      assert(error instanceof ImagePreparationError);
      assert(error.cause instanceof AttachmentStoreError);
      return true;
    },
  );
});

test("mixed same-hash unavailable occurrences remain exact and are reconsidered for each model sample", async () => {
  const store = new InMemoryAttachmentStore();
  const original = await store.importBytes(await undecodablePng());
  const healthy = await store.importBytes(
    await sharp({
      create: { width: 2048, height: 2048, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer(),
  );
  const bad = userItem(original, 2);
  const good = { ...userItem(healthy), id: "healthy" };
  const originals = [bad, good];
  const first = await prepareSampleImages({
    ...preparationOptions(originals, store),
    supportsImageDetailOriginal: true,
  });
  assert.equal(first.length, 3);
  const badOverlays = first.filter(
    (item) =>
      (item.source.metadata!.imagePreparation as any).outcome === "unavailable",
  );
  assert.deepEqual(
    badOverlays.map(
      (item) =>
        (item.source.metadata!.imagePreparation as any).occurrence.partIndex,
    ),
    [0, 1],
  );
  const next = await prepareSampleImages({
    ...preparationOptions([...originals, ...first], store, "new-model"),
    selection: { providerProfileId: "other", modelId: "unknown" },
    supportsImageDetailOriginal: null,
  });
  assert.equal(next.length, 3);
  const compiled = compileItemList(
    JSON.parse(JSON.stringify([...originals, ...first, ...next])),
    {
      sampleId: "new-model",
      selection: { providerProfileId: "other", modelId: "unknown" },
      inputModalities: null,
    },
  );
  const parts = compiled.messages.flatMap((message) =>
    message.role === "user" && "content" in message ? message.content : [],
  );
  assert.equal(parts.filter((part) => part.type === "image").length, 1);
  assert.equal(
    parts.filter(
      (part) =>
        part.type === "text" && part.text.includes("Image input unavailable"),
    ).length,
    2,
  );
  assert.equal(
    parts.find((part) => part.type === "image")!.attachment.sha256,
    (
      next.find(
        (item) =>
          (item.source.metadata!.imagePreparation as any).outcome ===
          "prepared",
      ) as any
    ).content.parts[1].attachment.sha256,
  );
  assert.deepEqual(
    Buffer.from(await store.read(original)),
    Buffer.from(await undecodablePng()),
  );
});

test("codec resize failure has a stable category and freezes original selection even when no pixels exist", async () => {
  const store = new InMemoryAttachmentStore();
  const original = await store.importBytes(await undecodablePng(4096));
  const item = userItem(original);
  assert(item.kind === "message");
  item.content.parts = [
    { type: "image", attachment: original, detail: "original" },
  ];
  for (const capability of [true, false, null] as const) {
    const [overlay] = await prepareSampleImages({
      ...preparationOptions([item], store, String(capability)),
      supportsImageDetailOriginal: capability,
    });
    assert(overlay);
    const metadata = overlay.source.metadata!.imagePreparation as any;
    assert.equal(metadata.outcome, "unavailable");
    assert.equal(metadata.reason, "image_processing_failed");
    assert.equal(metadata.requestedDetail, "original");
    assert.equal(
      metadata.profile,
      capability === true ? "codex-original-v1" : "codex-high-v1",
    );
    assert.equal(metadata.supportsImageDetailOriginal, capability);
    assert.doesNotThrow(() => decodeContextItem(overlay));
    assert(overlay.kind === "message");
    assert.doesNotMatch(
      overlay.content.text,
      /using a bounded HIGH|libpng|vips|private|workspace/,
    );
  }
});

test("real Host user/tool same-hash unavailable overlays survive fork and cold replay at exact child occurrences", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-unavailable-fork-"),
  );
  const attachments = new FileAttachmentStore(
    path.join(directory, "attachments"),
  );
  const original = await attachments.importBytes(await undecodablePng());
  const healthy = await attachments.importBytes(
    await sharp({
      create: { width: 2048, height: 2048, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer(),
  );
  const tools = () => {
    const environment = new ToolEnvironment({ runtimes: [] });
    environment.registerRuntime(
      {
        name: "fixture_bad_images",
        specification: {
          name: "fixture_bad_images",
          description: "Synthetic undecodable image fixture",
          inputSchema: { type: "object", properties: {} },
        },
        execute: async () => ({
          output: "Synthetic original image references",
          exitCode: 0,
          modelContent: [
            { type: "image", attachment: original },
            { type: "image", attachment: original },
          ],
        }),
      },
      { kind: "builtin", id: "fixture-bad-images" },
    );
    return environment;
  };
  const options: import("../apps/cli/src/host.js").ZenHostOptions = {
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
  const previousFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const delta =
      bodies.length === 1
        ? {
            tool_calls: [
              {
                index: 0,
                id: "bad-images",
                type: "function",
                function: { name: "fixture_bad_images", arguments: "{}" },
              },
            ],
          }
        : { content: "done" };
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  };
  const host = createHostedAppServer({ ...options, toolEnvironment: tools() });
  let cold: ReturnType<typeof createHostedAppServer> | undefined;
  try {
    const source = await host.startThread();
    await (
      await host.startTurn(source.id, [
        { type: "image", attachment: original },
        { type: "image", attachment: original },
        { type: "image", attachment: healthy },
      ])
    ).done;
    const parent = await host.readThread(source.id);
    assert.equal(parent.turns[0]!.status, "completed");
    const fork = await host.forkThread({
      sourceThreadId: source.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    });
    await host.closeHostResources();
    cold = createHostedAppServer({ ...options, toolEnvironment: tools() });
    const child = await cold.readThread(fork.id);
    const overlays = child.itemList!.filter(
      (item) => item.source.kind === "image_preparation",
    );
    const lastSample = String(overlays.at(-1)!.source.metadata!.onlySampleId);
    const last = overlays.filter(
      (item) => item.source.metadata!.onlySampleId === lastSample,
    );
    const unavailable = last.filter(
      (item) =>
        (item.source.metadata!.imagePreparation as any).outcome ===
        "unavailable",
    );
    assert.equal(unavailable.length, 4);
    const childIds = new Set(child.items.map((item) => item.id));
    const parentIds = new Set(parent.items.map((item) => item.id));
    const occurrences = unavailable.map(
      (item) => (item.source.metadata!.imagePreparation as any).occurrence,
    );
    assert.deepEqual(
      occurrences.map((origin) => [origin.field, origin.partIndex]),
      [
        ["content", 0],
        ["content", 1],
        ["modelContent", 0],
        ["modelContent", 1],
      ],
    );
    assert(
      occurrences.every(
        (origin) =>
          childIds.has(origin.itemId) &&
          !parentIds.has(origin.itemId) &&
          origin.sha256 === original.sha256,
      ),
    );
    const compiled = compileItemList(
      JSON.parse(JSON.stringify(child.itemList)),
      { sampleId: lastSample, inputModalities: ["text", "image"] },
    );
    const parts = compiled.messages.flatMap((message) =>
      message.role === "user" && "content" in message
        ? message.content
        : message.role === "tool"
          ? (message.modelContent ?? [])
          : [],
    );
    assert.equal(parts.filter((part) => part.type === "image").length, 1);
    assert.equal(
      parts.filter(
        (part) =>
          part.type === "text" && part.text.includes("Image input unavailable"),
      ).length,
      4,
    );
    assert.equal(bodies.length, 2, "cold replay must not invoke model or tool");
    await (
      await cold.startTurn(fork.id, "Continue after cold fork")
    ).done;
    assert.equal(bodies.length, 3);
    assert.equal(
      JSON.stringify(bodies[2]).match(/Image input unavailable/g)?.length,
      4,
    );
    assert.deepEqual(
      Buffer.from(await attachments.read(original)),
      Buffer.from(await undecodablePng()),
    );
  } finally {
    globalThis.fetch = previousFetch;
    await cold?.closeHostResources();
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable unavailable observations budget historical pixels as text across smaller-model preflight and compaction", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-unavailable-budget-"),
  );
  const attachments = new FileAttachmentStore(
    path.join(directory, "attachments"),
  );
  const bad = await attachments.importBytes(await undecodablePng(4096));
  const healthy = await attachments.importBytes(
    await sharp({
      create: { width: 2048, height: 2048, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer(),
  );
  const previousFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"short synthetic summary or answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  };
  const host = createHostedAppServer({
    cwd: directory,
    dataDirectory: directory,
    approvalPolicy: "never",
    model: "large",
    toolPresentation: "direct",
    provider: {
      type: "openai-compatible",
      baseUrl: "https://synthetic.invalid/v1",
      apiKey: "synthetic-not-real",
    },
    modelCatalog: [
      {
        id: "large",
        supportedReasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
        contextWindow: 64000,
        inputModalities: ["text", "image"],
        source: "manual",
      },
      {
        id: "small",
        supportedReasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
        contextWindow: 5000,
        inputModalities: ["text", "image"],
        source: "manual",
      },
    ],
    contextCompaction: { triggerPercent: 100, targetPercent: 100 },
    toolEnvironment: new ToolEnvironment({ runtimes: [] }),
    attachments,
  });
  try {
    const thread = await host.startThread();
    await (
      await host.startTurn(thread.id, [
        { type: "image", attachment: bad },
        { type: "image", attachment: healthy },
        { type: "image", attachment: bad },
      ])
    ).done;
    const snapshot = await host.readThread(thread.id);
    assert.equal(snapshot.turns[0]!.status, "completed");
    const originalId = snapshot.items.find(
      (item) => item.type === "user_message",
    )!.id;
    await host.updateThreadSettings(thread.id, {
      selection: { providerProfileId: "openai-compatible", modelId: "small" },
    });
    const usage = await host.readModelUsage(thread.id);
    assert(
      usage.context.inputTokens! < 5000,
      "read-only historical estimate must use durable unavailable notices rather than guessed image patches",
    );
    await host.compactThread(thread.id, {
      includeOriginalReference: false,
      retention: {
        mode: "selected-items",
        itemRanges: [{ fromItemId: originalId, toItemId: originalId }],
      },
    });
    assert.equal(bodies.length, 2);
    const summary = JSON.stringify(bodies[1]);
    assert.equal(
      bodies[1].messages
        .flatMap((message: any) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .filter((part: any) => part.type === "image_url").length,
      1,
      "healthy pixels still fit alongside two actual unavailable notices",
    );
    assert.equal((summary.match(/Image input unavailable/g) ?? []).length, 2);
    assert(!summary.includes("[excerpt]"));
    await (
      await host.startTurn(thread.id, "Continue with retained sources")
    ).done;
    assert.equal(
      bodies.length,
      3,
      "historical bad images must not force another automatic compaction",
    );
    assert.equal(
      (JSON.stringify(bodies[2]).match(/Image input unavailable/g) ?? [])
        .length,
      2,
    );
  } finally {
    globalThis.fetch = previousFetch;
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  }
});

test("read-only unavailable estimates bind exact occurrence, requested profile and capability without decoding or sticky negatives", async () => {
  const { unavailableImageTokenEstimate } =
    await import("../src/image-preparation.js");
  const { estimateModelMessageInputTokens } =
    await import("../src/model-usage.js");
  const store = new InMemoryAttachmentStore();
  const bad = await store.importBytes(await undecodablePng(4096));
  const source = userItem(bad);
  const [overlay] = await prepareSampleImages({
    ...preparationOptions([source], store),
    supportsImageDetailOriginal: null,
  });
  assert(overlay?.kind === "message");
  const compiled = compileItemList([source], {
    inputModalities: ["text", "image"],
  });
  const image = compiled.messages
    .flatMap((message) =>
      message.role === "user" && "content" in message ? message.content : [],
    )
    .find((part) => part.type === "image")!;
  const estimate = unavailableImageTokenEstimate([overlay], null);
  assert.equal(estimate(image), Math.ceil(overlay.content.text.length / 4));
  assert.equal(
    unavailableImageTokenEstimate([overlay], false)(image),
    undefined,
  );
  const different = compileItemList([{ ...source, id: "other-origin" }], {
    inputModalities: ["text", "image"],
  }).messages[0]!;
  assert(
    different.role === "user" &&
      "content" in different &&
      different.content[0]?.type === "image",
  );
  assert.equal(estimate(different.content[0]), undefined);
  const originalRequest = { ...image, detail: "original" as const };
  const { bindModelMediaOrigin, modelMediaOrigin } =
    await import("../src/model-media-origin.js");
  bindModelMediaOrigin(originalRequest, modelMediaOrigin(image)!);
  assert.equal(
    estimate(originalRequest),
    undefined,
    "HIGH codec observations do not stand in for ORIGINAL transforms",
  );
  const healthy = await store.importBytes(
    await sharp({
      create: { width: 1, height: 1, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer(),
  );
  const later = JSON.parse(JSON.stringify(overlay));
  later.source.metadata.imagePreparation.outcome = "prepared";
  delete later.source.metadata.imagePreparation.reason;
  later.content.parts.push({ type: "image", attachment: healthy });
  decodeContextItem(later);
  assert.equal(
    unavailableImageTokenEstimate([overlay, later], null)(image),
    undefined,
    "a later success supersedes an earlier unavailable estimate",
  );
  for (const value of [-1, NaN, Infinity, 1.5])
    assert.throws(() =>
      estimateModelMessageInputTokens(
        compiled.messages,
        undefined,
        () => value,
      ),
    );
});
