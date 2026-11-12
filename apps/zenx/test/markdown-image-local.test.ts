import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { png1x1 } from "../../../test/fixtures.js";
import { readLocalImagePayload } from "../src/main/image-attachments.js";
import { classifyImageSource } from "../src/image-source.js";

test("Markdown local images read absolute, file URI and cwd-relative paths without writing state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zenx-render-image-"));
  try {
    const filename = join(directory, "an image.png");
    await writeFile(filename, png1x1());
    for (const source of [
      filename,
      pathToFileURL(filename).href,
      "an%20image.png",
    ]) {
      const payload = await readLocalImagePayload(source, directory);
      assert.equal(payload.mediaType, "image/png");
      assert.deepEqual(payload.bytes, Uint8Array.from(png1x1()));
    }
    assert.deepEqual(await readdir(directory), ["an image.png"]);
    await assert.rejects(
      readLocalImagePayload("an image.png", undefined),
      /working directory/,
    );
    await assert.rejects(
      readLocalImagePayload(join(directory, "missing.png"), directory),
    );
    await writeFile(join(directory, "text.png"), "not an image");
    await assert.rejects(
      readLocalImagePayload(join(directory, "text.png"), directory),
    );
    await assert.rejects(
      readLocalImagePayload(directory, directory),
      /regular file/,
    );
    await assert.rejects(
      readLocalImagePayload("https://example.com/a.png", directory),
      /Invalid local/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("image URL policy allows supported data and web images without allowing executable schemes", () => {
  for (const source of [
    "https://example.com/a.png",
    "http://localhost/a.png",
    "data:image/png;base64,AA==",
  ])
    assert.equal(classifyImageSource(source).kind, "url");
  for (const source of [
    "javascript:alert(1)",
    "data:text/html;base64,AA==",
    "data:image/svg+xml;base64,AA==",
    "//example.com/image.png",
    "https://user:secret@example.com/a.png",
  ])
    assert.equal(classifyImageSource(source).kind, "rejected");
});
