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

test("browser screenshot cleanup serializes close and scope races", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-browser-race-"));
  const store = new BrowserScreenshotArtifactStore(root);
  try {
    const write = store.write("session/tab", "observation-race", ONE_PIXEL_PNG);
    const clear = store.clearScope("session");
    const artifact = await write;
    await clear;
    await assert.rejects(access(artifact.artifactPath));

    const close = store.close();
    await assert.rejects(
      store.write("session/tab", "after-close", ONE_PIXEL_PNG),
      /closed/u,
    );
    await close;
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser screenshot stores isolate ownership when sharing a root", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-browser-shared-root-"),
  );
  const first = new BrowserScreenshotArtifactStore(root);
  const second = new BrowserScreenshotArtifactStore(root);
  try {
    const firstArtifact = await first.write("one/tab", "one", ONE_PIXEL_PNG);
    const secondArtifact = await second.write("two/tab", "two", ONE_PIXEL_PNG);
    await first.close();
    await access(secondArtifact.artifactPath);
    await assert.rejects(access(firstArtifact.artifactPath));
  } finally {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser screenshot validation rejects truncation, bad CRC, and huge dimensions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-browser-png-"));
  const store = new BrowserScreenshotArtifactStore(root);
  try {
    await assert.rejects(
      store.write("session/tab", "truncated", ONE_PIXEL_PNG.subarray(0, -1)),
      /PNG/u,
    );
    const badCrc = Buffer.from(ONE_PIXEL_PNG);
    badCrc[badCrc.length - 1]! ^= 1;
    await assert.rejects(store.write("session/tab", "crc", badCrc), /CRC/u);
    const huge = Buffer.from(ONE_PIXEL_PNG);
    huge.writeUInt32BE(5_000, 16);
    huge.writeUInt32BE(crc32(huge.subarray(12, 29)), 29);
    await assert.rejects(
      store.write("session/tab", "huge", huge),
      /dimensions/u,
    );
    const valid = await store.write("session/tab", "valid", ONE_PIXEL_PNG);
    assert.equal(valid.width, 1);
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

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
