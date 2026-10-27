import assert from "node:assert/strict";
import { test } from "node:test";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { FileAttachmentStore } from "../src/attachment.js";
import { png1x1 } from "./fixtures.js";
for (const target of [
  "root",
  "sha256",
  "hash",
  "payload-symlink",
  "payload-hardlink",
] as const)
  test(`read and import dedup reject ${target} aliases before reference ACK`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zen-blob-alias-"));
    const directory = path.join(root, "owned");
    const store = new FileAttachmentStore(directory);
    const bytes = png1x1();
    const ref = await store.importBytes(bytes);
    const original =
      target === "root"
        ? directory
        : target === "sha256"
          ? path.join(directory, "sha256")
          : target === "hash"
            ? path.join(directory, "sha256", ref.sha256)
            : path.join(directory, "sha256", ref.sha256, "payload");
    const external = path.join(root, "external");
    await rename(original, external);
    if (target === "payload-hardlink") await link(external, original);
    else
      await symlink(
        external,
        original,
        target.startsWith("payload") ? "file" : "dir",
      );
    await assert.rejects(store.read(ref), /symlink|unaliased/);
    await assert.rejects(store.importBytes(bytes), /symlink|unaliased/);
    if (target.startsWith("payload"))
      assert.deepEqual(await readFile(external), bytes);
  });
test("ordinary owned attachment dedup remains complete", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-blob-own-"));
  const store = new FileAttachmentStore(directory);
  const first = await store.importBytes(png1x1());
  assert.deepEqual(await store.importBytes(png1x1()), first);
  assert.deepEqual(await store.read(first), png1x1());
});
