import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { png1x1 } from "./fixtures.js";

import {
  AttachmentStoreError,
  FileAttachmentStore,
  InMemoryAttachmentStore,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
} from "../src/attachment.js";

test("accepts the four explicitly supported image formats", async () => {
  const store = new InMemoryAttachmentStore();
  const fixtures = [
    ["image/png", png1x1()],
    [
      "image/jpeg",
      Buffer.from(
        "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==",
        "base64",
      ),
    ],
    [
      "image/gif",
      Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
    ],
    [
      "image/webp",
      Buffer.from(
        "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
        "base64",
      ),
    ],
  ] as const;

  for (const [mediaType, bytes] of fixtures) {
    const ref = await store.importBytes(bytes, mediaType);
    assert.equal(ref.mediaType, mediaType);
    assert.equal(ref.width, 1);
    assert.equal(ref.height, 1);
  }
});

test("imports identical image bytes once through the public Attachment Store", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-attachment-"));
  try {
    const store = new FileAttachmentStore(directory);
    const image = png1x1();
    const [first, ...duplicates] = await Promise.all(
      Array.from({ length: 8 }, async () => await store.importBytes(image)),
    );
    assert(first !== undefined);

    assert(duplicates.every((duplicate) => duplicate.sha256 === first.sha256));
    assert.deepEqual(await store.read(first), image);
    assert.deepEqual(await readdir(path.join(directory, "sha256")), [
      first.sha256,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("never overwrites an existing content-addressed payload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-attachment-"));
  try {
    const store = new FileAttachmentStore(directory);
    const image = png1x1();
    const ref = await store.importBytes(image);
    const payload = path.join(directory, "sha256", ref.sha256, "payload");
    await chmod(payload, 0o600);
    await writeFile(payload, Buffer.alloc(image.byteLength, 7));

    await assert.rejects(store.importBytes(image), (error: unknown) => {
      assert(error instanceof AttachmentStoreError);
      assert.equal(error.code, "attachment_corrupt");
      return true;
    });
    await assert.rejects(store.read(ref), { code: "attachment_corrupt" });
    assert.deepEqual(
      await readFile(payload),
      Buffer.alloc(image.byteLength, 7),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects non-images, corrupt images, oversized bytes, MIME lies, and excessive dimensions", async () => {
  const store = new FileAttachmentStore(
    await mkdtemp(path.join(os.tmpdir(), "zen-attachment-validation-")),
  );
  await assert.rejects(store.importBytes(Buffer.from("plain text")), {
    code: "attachment_invalid",
  });
  await assert.rejects(store.importBytes(png1x1().subarray(0, 32)), {
    code: "attachment_invalid",
  });
  await assert.rejects(store.importBytes(new Uint8Array(MAX_IMAGE_BYTES + 1)), {
    code: "attachment_too_large",
  });
  await assert.rejects(store.importBytes(png1x1(), "image/jpeg"), {
    code: "attachment_mime_mismatch",
  });
  const excessive = pngWithDimensions(MAX_IMAGE_DIMENSION + 1, 1);
  await assert.rejects(store.importBytes(excessive), {
    code: "attachment_dimensions_exceeded",
  });

  const damaged = Uint8Array.from(png1x1());
  const damagedIndex = damaged.length - 16;
  damaged[damagedIndex] = damaged[damagedIndex]! ^ 0xff;
  await assert.rejects(store.importBytes(damaged), {
    code: "attachment_invalid",
  });
});

function pngWithDimensions(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from(png1x1());
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(29, crc32(bytes.subarray(12, 29)));
  return bytes;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
