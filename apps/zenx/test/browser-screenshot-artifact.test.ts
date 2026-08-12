import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  BrowserScreenshotArtifactStore,
  MAX_BROWSER_SCREENSHOT_BYTES,
} from "../src/main/capabilities/browser-provider.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("browser screenshot artifacts are bounded, scoped, and cleaned", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-browser-artifact-"));
  const store = new BrowserScreenshotArtifactStore(root);
  try {
    const artifact = await store.write(
      "session/tab",
      "observation-1",
      ONE_PIXEL_PNG,
    );
    assert.equal(artifact.bytes, ONE_PIXEL_PNG.byteLength);
    assert.equal(artifact.width, 1);
    await access(artifact.artifactPath);
    await store.clearScope("session");
    await assert.rejects(access(artifact.artifactPath));
    await assert.rejects(
      store.write("session/tab", "observation-2", oversizedPng()),
      /exceeded/u,
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

function oversizedPng(): Buffer {
  const png = Buffer.alloc(MAX_BROWSER_SCREENSHOT_BYTES + 1);
  ONE_PIXEL_PNG.copy(png, 0, 0, 24);
  return png;
}
