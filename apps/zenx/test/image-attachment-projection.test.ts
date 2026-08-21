import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadSnapshot } from "../../../src/app-server.js";
import type { AttachmentRef } from "../../../src/attachment.js";
import {
  importImageDrafts,
  importLocalImageDrafts,
  projectThreadAttachments,
  readAttachmentPayload,
} from "../src/main/image-attachments.js";

const attachment = (suffix: string): AttachmentRef => ({
  type: "attachment",
  sha256: suffix.padEnd(64, "0"),
  mediaType: "image/png",
  byteLength: 68,
  width: 1,
  height: 1,
});

test("payload IPC reader accepts AttachmentRef authority and rejects filesystem paths", async () => {
  let reads = 0;
  const store = {
    read: async (value: AttachmentRef) => {
      reads += 1;
      assert.equal(value.sha256, "a".padEnd(64, "0"));
      return new Uint8Array([1, 2, 3]);
    },
  };
  assert.deepEqual(
    await readAttachmentPayload(store, attachment("a")),
    new Uint8Array([1, 2, 3]),
  );
  await assert.rejects(
    readAttachmentPayload(store, { path: "/etc/passwd" }),
    /Invalid image attachment/u,
  );
  assert.equal(reads, 1);
});

test("picker and byte imports preserve their supplied image order", async () => {
  const refs = [attachment("a"), attachment("b"), attachment("c")];
  const picked = await importLocalImageDrafts(
    {
      importLocalImage: async (filename) => {
        const index = ["a.png", "b.jpg", "c.webp"].findIndex((name) =>
          filename.endsWith(name),
        );
        await new Promise((resolve) => setTimeout(resolve, 3 - index));
        return refs[index]!;
      },
    },
    ["/private/a.png", "/private/b.jpg", "/private/c.webp"],
  );
  assert.deepEqual(
    picked.map((image) => [image.name, image.attachment.sha256]),
    refs.map((ref, index) => [["a.png", "b.jpg", "c.webp"][index], ref.sha256]),
  );
  assert.equal(JSON.stringify(picked).includes("/private/"), false);

  const pasted = await importImageDrafts(
    {
      importBytes: async (bytes) => refs[bytes[0]!]!,
    },
    [0, 1, 2].map((value) => ({
      name: `${String(value)}.gif`,
      mediaType: "image/gif",
      bytes: new Uint8Array([value]),
    })),
  );
  assert.deepEqual(
    pasted.map((image) => image.attachment.sha256),
    refs.map((ref) => ref.sha256),
  );
});

test("projects canonical user-message attachments in message and image order", () => {
  const first = attachment("a");
  const second = attachment("b");
  const snapshot: ThreadSnapshot = {
    id: "thread-1",
    turns: [],
    cwd: "/workspace",
    providerProfileId: "provider",
    modelId: "model",
    reasoningEffort: "medium",
    model: "model",
    provider: "provider",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    archived: false,
    items: [
      {
        id: "message-1",
        threadId: "thread-1",
        turnId: "turn-1",
        createdAt: "2026-08-21T00:00:00.000Z",
        type: "user_message",
        content: [
          { type: "text", text: "look" },
          { type: "image", attachment: first },
          { type: "image", attachment: second },
        ],
      },
    ],
  };
  const projection = projectThreadAttachments(snapshot);
  assert.deepEqual(projection, { "message-1": [first, second] });
  assert.equal(JSON.stringify(projection).includes("base64"), false);
  assert.equal(JSON.stringify(projection).includes("/tmp/"), false);
});
