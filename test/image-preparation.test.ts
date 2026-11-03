import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import {
  preparedImageDimensions,
  prepareImageAttachment,
} from "../src/image-preparation.js";

test("Codex dimension profiles honor edge and ceil32 patch limits without upscaling", () => {
  assert.deepEqual(preparedImageDimensions(2048, 2048), [1600, 1600]);
  assert.deepEqual(preparedImageDimensions(4096, 2048), [2048, 1024]);
  assert.deepEqual(
    preparedImageDimensions(4096, 2048, "original"),
    [4096, 2048],
  );
  assert.deepEqual(
    preparedImageDimensions(6000, 6000, "original"),
    [3200, 3200],
  );
  assert.deepEqual(preparedImageDimensions(31, 17), [31, 17]);
  for (const detail of ["high", "original"] as const)
    for (const [w, h] of [
      [16384, 1],
      [1, 16384],
      [6000, 6000],
      [3457, 789],
      [1601, 1600],
    ]) {
      const [width, height] = preparedImageDimensions(w!, h!, detail);
      assert(width <= w! && height <= h!);
      assert(Math.max(width, height) <= (detail === "high" ? 2048 : 6000));
      assert(
        Math.ceil(width / 32) * Math.ceil(height / 32) <=
          (detail === "high" ? 2500 : 10000),
      );
    }
});

test("small PNG/JPEG/WebP pass byte-for-byte; resizing keeps their formats and original bytes", async () => {
  const store = new InMemoryAttachmentStore();
  for (const format of ["png", "jpeg", "webp"] as const) {
    const image = (width: number) =>
      sharp({
        create: { width, height: width, channels: 3, background: "#c0ffee" },
      })
        [format]()
        .toBuffer();
    const small = await store.importBytes(await image(32));
    assert.deepEqual(await prepareImageAttachment(small, store), small);
    const originalBytes = await image(2048);
    const original = await store.importBytes(originalBytes);
    const prepared = await prepareImageAttachment(original, store);
    assert.equal(prepared.mediaType, original.mediaType);
    assert.deepEqual([prepared.width, prepared.height], [1600, 1600]);
    assert.notEqual(prepared.sha256, original.sha256);
    assert.deepEqual(Buffer.from(await store.read(original)), originalBytes);
  }
});

test("GIF becomes a static PNG and resize preserves EXIF orientation/ICC without auto orientation", async () => {
  const store = new InMemoryAttachmentStore();
  const gif = await store.importBytes(
    await sharp({
      create: { width: 20, height: 10, channels: 3, background: "red" },
    })
      .gif()
      .toBuffer(),
  );
  const png = await prepareImageAttachment(gif, store);
  assert.equal(png.mediaType, "image/png");
  assert.deepEqual([png.width, png.height], [20, 10]);
  const bytes = await sharp({
    create: { width: 3000, height: 1000, channels: 3, background: "green" },
  })
    .withMetadata({ orientation: 6 })
    .withIccProfile("srgb")
    .jpeg()
    .toBuffer();
  const original = await store.importBytes(bytes);
  const prepared = await prepareImageAttachment(original, store);
  const before = await sharp(bytes).metadata();
  const after = await sharp(await store.read(prepared)).metadata();
  assert.deepEqual([after.width, after.height], [2048, 683]);
  assert.equal(after.orientation, 6);
  assert.deepEqual(after.icc, before.icc);
  assert.deepEqual(after.exif, before.exif);
});

test("sample overlays preserve exact repeated occurrences, frozen selection, and capability downgrade without mutating source", async () => {
  const { prepareSampleImages } = await import("../src/image-preparation.js");
  const { compileItemList } = await import("../src/item-list.js");
  const { sampledMediaOccurrences } = await import("../src/loop-recovery.js");
  const { modelMediaOrigin } = await import("../src/model-media-origin.js");
  const store = new InMemoryAttachmentStore();
  const original = await store.importBytes(
    await sharp({
      create: { width: 4096, height: 2048, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer(),
  );
  const base = { threadId: "thread", createdAt: "2026-11-03T00:00:00Z" };
  const items: import("../src/item-list.js").ContextItem[] = [0, 1].map(
    (sequence) => ({
      ...base,
      id: `image-${sequence}`,
      kind: "message",
      role: "user",
      source: { kind: "user_message", sequence },
      content: {
        text: "",
        parts: [{ type: "image", attachment: original, detail: "original" }],
      },
    }),
  );
  let next = 0;
  const input = {
    threadId: "thread",
    sampleId: "high-sample",
    itemList: items,
    selection: { providerProfileId: "unknown-original", modelId: "model" },
    inputModalities: ["text", "image"],
    supportsImageDetailOriginal: null,
    attachments: store,
    id: () => `prep-${next++}`,
    now: () => base.createdAt,
  };
  const before = JSON.stringify(items);
  const high = await prepareSampleImages(input);
  assert.equal(high.length, 2);
  assert(
    high.every(
      (i) =>
        i.kind === "message" &&
        /capability is unknown.*HIGH/u.test(i.content.text),
    ),
  );
  const compiled = compileItemList([...items, ...high], {
    sampleId: input.sampleId,
    selection: input.selection,
    inputModalities: input.inputModalities,
  });
  const images = compiled.messages
    .flatMap((m) => (m.role === "user" && "content" in m ? m.content : []))
    .filter((p) => p.type === "image");
  assert.equal(images.length, 2);
  assert(
    images.every((p) => p.attachment.width === 2048 && p.detail === undefined),
  );
  const occurrences = images.map((p) => modelMediaOrigin(p)!);
  assert.deepEqual(
    occurrences.map((o) => o.itemId),
    ["image-0", "image-1"],
  );
  assert(occurrences.every((o) => o.sha256 === original.sha256));
  assert.deepEqual(
    sampledMediaOccurrences(
      [],
      compiled.messages,
      ["text", "image"],
      [images[1]!],
    ),
    [occurrences[1]],
  );
  const omitted = {
    ...base,
    id: "exact-omit",
    kind: "message" as const,
    role: "user" as const,
    source: {
      kind: "media_unavailable" as const,
      sequence: 2,
      metadata: {
        onlySampleId: input.sampleId,
        omittedMedia: [
          occurrences[1] as unknown as import("../src/item.js").JsonValue,
        ],
      },
    },
    content: {
      text: "one rejected image",
      parts: [{ type: "text" as const, text: "one rejected image" }],
    },
  };
  const one = compileItemList([...items, ...high, omitted], {
    sampleId: input.sampleId,
    selection: input.selection,
    inputModalities: input.inputModalities,
  });
  assert.equal(
    one.messages
      .flatMap((m) => (m.role === "user" && "content" in m ? m.content : []))
      .filter((p) => p.type === "image").length,
    1,
  );
  assert.throws(
    () =>
      compileItemList([...items, ...high], {
        sampleId: input.sampleId,
        selection: { providerProfileId: "other", modelId: "model" },
      }),
    /selection does not match/u,
  );
  assert.equal(JSON.stringify(items), before);
  const originalView = await prepareSampleImages({
    ...input,
    sampleId: "original-sample",
    supportsImageDetailOriginal: true,
  });
  const cold = JSON.parse(JSON.stringify([...items, ...high, ...originalView]));
  const replay = compileItemList(cold, {
    sampleId: "original-sample",
    selection: input.selection,
  });
  const restored = replay.messages
    .flatMap((m) => (m.role === "user" && "content" in m ? m.content : []))
    .filter((p) => p.type === "image");
  assert(
    restored.every(
      (p) => p.attachment.sha256 === original.sha256 && p.detail === "original",
    ),
  );
});

test("small original-detail input falls back honestly when capability becomes unknown", async () => {
  const { prepareSampleImages } = await import("../src/image-preparation.js");
  const { compileItemList } = await import("../src/item-list.js");
  const store = new InMemoryAttachmentStore();
  const original = await store.importBytes(
    await sharp({
      create: { width: 32, height: 32, channels: 3, background: "red" },
    })
      .png()
      .toBuffer(),
  );
  const item: import("../src/item-list.js").ContextItem = {
    id: "small",
    threadId: "thread",
    createdAt: "2026-11-03T00:00:00Z",
    kind: "message",
    role: "user",
    source: { kind: "user_message", sequence: 0 },
    content: {
      text: "",
      parts: [{ type: "image", attachment: original, detail: "original" }],
    },
  };
  const additions = await prepareSampleImages({
    threadId: "thread",
    sampleId: "unknown",
    itemList: [item],
    selection: { providerProfileId: "provider", modelId: "model" },
    inputModalities: ["text", "image"],
    supportsImageDetailOriginal: null,
    attachments: store,
    id: () => "overlay",
    now: () => item.createdAt,
  });
  assert.equal(additions.length, 1);
  const compiled = compileItemList([item, ...additions], {
    sampleId: "unknown",
  });
  const content = compiled.messages.flatMap((m) =>
    m.role === "user" && "content" in m ? m.content : [],
  );
  assert(
    content.some(
      (p) => p.type === "text" && /capability is unknown/u.test(p.text),
    ),
  );
  const image = content.find((p) => p.type === "image")!;
  assert(
    image.type === "image" &&
      image.detail === undefined &&
      image.attachment.sha256 === original.sha256,
  );
});

test("all preserved image formats keep raw EXIF and RGB ICC after resize", async () => {
  const store = new InMemoryAttachmentStore();
  for (const format of ["png", "jpeg", "webp"] as const) {
    const bytes = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: "#2374ab" },
    })
      .withMetadata({ orientation: 6 })
      .withIccProfile("srgb")
      [format]()
      .toBuffer();
    const original = await store.importBytes(bytes);
    const prepared = await prepareImageAttachment(original, store);
    const before = await sharp(bytes).metadata();
    const after = await sharp(await store.read(prepared)).metadata();
    assert.deepEqual(
      after.exif,
      before.exif,
      `${format} EXIF must not silently rewrite dimension/orientation tags`,
    );
    assert.deepEqual(after.icc, before.icc);
    assert.equal(after.orientation, 6);
    assert.deepEqual([after.width, after.height], [2048, 683]);
  }
});

test("re-encoding never labels RGB output with a source CMYK ICC profile", async () => {
  const store = new InMemoryAttachmentStore();
  const bytes = await sharp({
    create: { width: 3000, height: 1000, channels: 3, background: "red" },
  })
    .withIccProfile("cmyk")
    .jpeg()
    .toBuffer();
  const before = await sharp(bytes).metadata();
  assert.equal(before.icc?.subarray(16, 20).toString("ascii"), "CMYK");
  const original = await store.importBytes(bytes);
  const prepared = await prepareImageAttachment(original, store);
  const after = await sharp(await store.read(prepared)).metadata();
  assert.notEqual(after.icc?.subarray(16, 20).toString("ascii"), "CMYK");
  assert.equal(after.space, "srgb");
  assert.deepEqual(Buffer.from(await store.read(original)), bytes);
});

test("a CRC-valid but undecodable small image receives a safe sample-scoped unavailable notice", async () => {
  const { prepareSampleImages } = await import("../src/image-preparation.js");
  const store = new InMemoryAttachmentStore();
  const bytes = Buffer.from(
    await sharp({
      create: { width: 1, height: 1, channels: 3, background: "red" },
    })
      .png()
      .toBuffer(),
  );
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
  const original = await store.importBytes(bytes);
  const item: import("../src/item-list.js").ContextItem = {
    id: "corrupt-pixels",
    threadId: "thread",
    createdAt: "2026-11-03T00:00:00Z",
    kind: "message",
    role: "user",
    source: { kind: "user_message", sequence: 0 },
    content: { text: "", parts: [{ type: "image", attachment: original }] },
  };
  const overlays = await prepareSampleImages({
    threadId: "thread",
    sampleId: "corrupt-sample",
    itemList: [item],
    selection: { providerProfileId: "provider", modelId: "model" },
    inputModalities: ["text", "image"],
    attachments: store,
    id: () => "overlay",
    now: () => item.createdAt,
  });
  assert.equal(overlays.length, 1);
  assert(overlays[0]?.kind === "message");
  assert.match(overlays[0].content.text, /image_decode_failed/u);
  assert.equal(overlays[0].content.parts.length, 1);
  assert.deepEqual(Buffer.from(await store.read(original)), bytes);
});

test("unknown image modality keeps Host attempt semantics but still prepares a bounded HIGH view", async () => {
  const { prepareSampleImages } = await import("../src/image-preparation.js");
  const { compileItemList } = await import("../src/item-list.js");
  const store = new InMemoryAttachmentStore();
  const original = await store.importBytes(
    await sharp({
      create: { width: 2048, height: 2048, channels: 3, background: "gray" },
    })
      .png()
      .toBuffer(),
  );
  const item: import("../src/item-list.js").ContextItem = {
    id: "unknown-modality",
    threadId: "thread",
    createdAt: "2026-11-03T00:00:00Z",
    kind: "message",
    role: "user",
    source: { kind: "user_message", sequence: 0 },
    content: { text: "", parts: [{ type: "image", attachment: original }] },
  };
  const additions = await prepareSampleImages({
    threadId: "thread",
    sampleId: "unknown-modality-sample",
    itemList: [item],
    selection: { providerProfileId: "unknown", modelId: "model" },
    inputModalities: null,
    attachments: store,
    id: () => "unknown-overlay",
    now: () => item.createdAt,
  });
  const compiled = compileItemList([item, ...additions], {
    sampleId: "unknown-modality-sample",
    inputModalities: null,
  });
  const images = compiled.messages
    .flatMap((m) => (m.role === "user" && "content" in m ? m.content : []))
    .filter((p) => p.type === "image");
  assert.equal(images.length, 1);
  assert.deepEqual(
    [images[0]!.attachment.width, images[0]!.attachment.height],
    [1600, 1600],
  );
  assert.equal(images[0]!.detail, undefined);
});
