import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  createHostedAppServer,
  type ZenHostOptions,
} from "../../../apps/cli/src/host.js";
import { FileAttachmentStore } from "../../../src/attachment.js";
import { png1x1 } from "../../../test/fixtures.js";
import { ZenXDraftAttachments } from "../src/main/draft-attachments.js";
import {
  addComposerImages,
  beginComposerSubmission,
  emptyComposerState,
  removeComposerImage,
} from "../src/renderer/src/composer-state.js";
import { composerRetainsImage } from "../src/renderer/src/draft-image-lifecycle.js";

async function fixture(
  run: (context: {
    root: string;
    permanent: FileAttachmentStore;
    drafts: ZenXDraftAttachments;
    advance(): void;
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-draft-lifecycle-"));
  let now = 100;
  const permanent = new FileAttachmentStore(path.join(root, "attachments"));
  const drafts = new ZenXDraftAttachments(
    path.join(root, "drafts"),
    permanent,
    { now: () => now, graceMs: 10, autoCollect: false },
  );
  try {
    await run({
      root,
      permanent,
      drafts,
      advance() {
        now += 20;
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const input = (bytes = png1x1()) => [
  { name: "synthetic.png", mediaType: "image/png", bytes },
];

function distinctPng(index: number): Uint8Array {
  // Add a valid tEXt chunk to the synthetic image. Original pixels remain synthetic.
  const data = Buffer.from(`Fixture\0${index}`);
  const body = Buffer.concat([Buffer.from("tEXt"), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  const png = Buffer.from(png1x1());
  return Buffer.concat([
    png.subarray(0, -12),
    size,
    body,
    checksum,
    png.subarray(-12),
  ]);
}

test("discarded drafts never enter the permanent store and can be collected after the grace period", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-draft-attachments-"));
  let now = 100;
  try {
    const permanent = new FileAttachmentStore(path.join(root, "attachments"));
    const drafts = new ZenXDraftAttachments(
      path.join(root, "drafts"),
      permanent,
      { now: () => now, graceMs: 10, autoCollect: false },
    );
    const [image] = await drafts.importImages(1, [
      { name: "one.png", mediaType: "image/png", bytes: png1x1() },
    ]);
    await assert.rejects(permanent.read(image!.attachment), {
      code: "attachment_missing",
    });
    assert.deepEqual(await drafts.read(image!.attachment), png1x1());
    await drafts.abandon(1, [image!.id]);
    assert.equal(
      (await drafts.inventory()).abandonedBytes,
      image!.attachment.byteLength,
    );
    assert.equal((await drafts.collectAbandoned()).length, 0);
    now += 11;
    assert.deepEqual(await drafts.collectAbandoned(), [
      image!.attachment.sha256,
    ]);
    await assert.rejects(drafts.read(image!.attachment), {
      code: "attachment_missing",
    });
    assert.deepEqual(await readdir(root), ["drafts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("32 distinct drafts deduplicate repeat imports and return to the staging baseline only after every shared lease is removed", async (t) => {
  await fixture(async ({ root, drafts, permanent, advance }) => {
    const images = await Promise.all(
      Array.from({ length: 32 }, async (_, index) => {
        let seed = index + 1;
        const pixels = Buffer.alloc(96 * 96 * 3);
        for (let byte = 0; byte < pixels.length; byte++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          pixels[byte] = seed >>> 24;
        }
        return input(
          await sharp(pixels, { raw: { width: 96, height: 96, channels: 3 } })
            .png()
            .toBuffer(),
        )[0]!;
      }),
    );
    const first = await drafts.importImages(1, images);
    const second = await drafts.importImages(1, images);
    assert.equal(
      (await readdir(path.join(root, "drafts", "sha256"))).length,
      32,
    );
    assert.equal(
      (await drafts.inventory()).retainedBytes,
      images.reduce((sum, image) => sum + image.bytes.byteLength, 0),
    );
    await drafts.abandon(
      1,
      first.map((image) => image.id),
    );
    advance();
    assert.deepEqual(await drafts.collectAbandoned(), []);
    await drafts.abandon(
      1,
      second.map((image) => image.id),
    );
    advance();
    assert.equal((await drafts.collectAbandoned()).length, 32);
    t.diagnostic(
      JSON.stringify({
        syntheticPngs: 32,
        width: first[0]!.attachment.width,
        height: first[0]!.attachment.height,
        uniquePayloadBytes: images.reduce(
          (sum, image) => sum + image.bytes.byteLength,
          0,
        ),
        importedDrafts: 64,
        afterCollectionPayloadBytes: (await drafts.inventory()).abandonedBytes,
        permanentPayloads: 0,
      }),
    );
    assert.deepEqual(await readdir(path.join(root, "drafts", "sha256")), []);
    for (const image of first)
      await assert.rejects(permanent.read(image.attachment), {
        code: "attachment_missing",
      });
  });
});

test("cross-window content sharing and wrong-owner retirement never delete a live draft", async () => {
  await fixture(async ({ drafts, advance }) => {
    const [first] = await drafts.importImages(1, input());
    const [second] = await drafts.importImages(2, input());
    await drafts.abandon(2, [first!.id]);
    assert.equal((await drafts.inventory()).abandonedBytes, 0);
    await drafts.abandon(1, [first!.id]);
    advance();
    assert.deepEqual(await drafts.collectAbandoned(), []);
    assert.deepEqual(await drafts.read(second!.attachment), png1x1());
    await drafts.abandon(2, [second!.id]);
    advance();
    assert.equal((await drafts.collectAbandoned()).length, 1);
  });
});

test("restart retains active/unknown leases but can collect previously explicit abandoned leases", async () => {
  await fixture(async ({ root, drafts, permanent }) => {
    const [active] = await drafts.importImages(1, input(distinctPng(1)));
    const [abandoned] = await drafts.importImages(1, input(distinctPng(2)));
    await drafts.abandon(1, [abandoned!.id]);
    const restarted = new ZenXDraftAttachments(
      path.join(root, "drafts"),
      permanent,
      { now: () => 1_000, graceMs: 10, autoCollect: false },
    );
    assert.equal(
      (await restarted.inventory()).unknownBytes,
      active!.attachment.byteLength,
    );
    await restarted.abandon(1, [active!.id]); // Reused WebContents IDs do not regain the previous session's lease.
    assert.deepEqual(await restarted.collectAbandoned(), [
      abandoned!.attachment.sha256,
    ]);
    assert.deepEqual(await restarted.read(active!.attachment), distinctPng(1));
    await restarted.prepareRequest("zen/turn/send", {
      input: [{ type: "attachment", attachment: active!.attachment }],
    });
    assert.deepEqual(await permanent.read(active!.attachment), distinctPng(1));
  });
});

test("all input entry points publish exact bytes before dispatch and preserve shared drafts across cleanup and retries", async () => {
  for (const method of [
    "turn/start",
    "turn/steer",
    "turn/replace",
    "zen/turn/send",
    "zen/turn/send-unarchived",
    "zen/thread/queue/edit",
  ]) {
    await fixture(async ({ root, drafts, permanent, advance }) => {
      const [image] = await drafts.importImages(1, input());
      const [shared] = await drafts.importImages(2, input());
      const params = {
        threadId: "synthetic",
        input: [
          {
            type: method === "zen/turn/send" ? "attachment" : "image",
            attachment: image!.attachment,
          },
        ],
      };
      const before = JSON.stringify(params);
      await drafts.prepareRequest(method, params);
      assert.equal(JSON.stringify(params), before);
      assert.deepEqual(await permanent.read(image!.attachment), png1x1());
      assert.deepEqual(await readdir(path.join(root, "drafts", "sha256")), []);
      await drafts.abandon(1, [image!.id]);
      advance();
      await drafts.collectAbandoned();
      assert.deepEqual(await drafts.read(shared!.attachment), png1x1());
      // The Host may reject or its reply may be lost. A delayed same-ID retry still works.
      const restarted = new ZenXDraftAttachments(
        path.join(root, "drafts"),
        permanent,
      );
      await restarted.prepareRequest(method, params);
      assert.deepEqual(await restarted.read(image!.attachment), png1x1());
    });
  }
});

test("failed publication retains bytes and a subsequent retry can publish without changing identity", async () => {
  await fixture(async ({ root, permanent }) => {
    let fail = true;
    const drafts = new ZenXDraftAttachments(path.join(root, "drafts"), {
      read: (ref) => permanent.read(ref),
      importBytes: async (bytes, mediaType) => {
        if (fail) throw new Error("Synthetic disk failure");
        return permanent.importBytes(bytes, mediaType);
      },
    });
    const [image] = await drafts.importImages(1, input());
    const params = {
      input: [{ type: "image", attachment: image!.attachment }],
    };
    await assert.rejects(
      drafts.prepareRequest("zen/turn/send", params),
      /Synthetic disk failure/u,
    );
    assert.deepEqual(await drafts.read(image!.attachment), png1x1());
    assert.equal(
      (await drafts.inventory()).retainedBytes,
      image!.attachment.byteLength,
    );
    fail = false;
    await drafts.prepareRequest("zen/turn/send", params);
    assert.deepEqual(await permanent.read(image!.attachment), png1x1());
  });
});

test("concurrent removal, publication and reimport serialize without losing shared image bytes", async () => {
  await fixture(async ({ drafts, permanent, advance }) => {
    const [image] = await drafts.importImages(1, input());
    await Promise.all([
      drafts.abandon(1, [image!.id]),
      drafts.prepareRequest("zen/thread/queue/edit", {
        input: [{ type: "image", attachment: image!.attachment }],
      }),
      drafts.importImages(2, input()),
    ]);
    advance();
    await drafts.collectAbandoned();
    assert.deepEqual(await permanent.read(image!.attachment), png1x1());
    assert.deepEqual(await drafts.read(image!.attachment), png1x1());
  });
});

test("corrupt lease metadata and incomplete imports stay unknown rather than proving no references", async () => {
  await fixture(async ({ root, drafts, advance }) => {
    const [image] = await drafts.importImages(1, input());
    await drafts.abandon(1, [image!.id]);
    await writeFile(
      path.join(root, "drafts", "leases", `${image!.id}.json`),
      "not json",
    );
    advance();
    assert.equal(
      (await drafts.inventory()).unknownBytes,
      image!.attachment.byteLength,
    );
    assert.deepEqual(await drafts.collectAbandoned(), []);
    assert.deepEqual(await drafts.read(image!.attachment), png1x1());
  });
});

test("an unpublished atomic-write temporary stays unknown without preventing collection of unrelated abandoned images", async () => {
  await fixture(async ({ root, drafts, advance }) => {
    const [abandoned] = await drafts.importImages(1, input());
    await drafts.abandon(1, [abandoned!.id]);
    const stage = new FileAttachmentStore(path.join(root, "drafts"));
    const orphan = await stage.importBytes(distinctPng(4));
    const id = randomUUID();
    const temporary = path.join(
      root,
      "drafts",
      "leases",
      `.${id}.json.${randomUUID()}.tmp`,
    );
    await writeFile(
      temporary,
      JSON.stringify({
        id,
        session: "interrupted",
        owner: 1,
        attachment: orphan,
      }),
    );
    advance();
    assert.deepEqual(await drafts.collectAbandoned(), [
      abandoned!.attachment.sha256,
    ]);
    assert.equal((await drafts.inventory()).unknownBytes, orphan.byteLength);
    assert.deepEqual(await drafts.read(orphan), distinctPng(4));
    assert.ok(
      (await readdir(path.dirname(temporary))).includes(
        path.basename(temporary),
      ),
    );
  });
});

test("read-only protocol requests do not publish or mutate legacy permanent attachments", async () => {
  await fixture(async ({ drafts, permanent }) => {
    const [image] = await drafts.importImages(1, input());
    await drafts.prepareRequest("zen/thread/read", {
      input: [{ type: "image", attachment: image!.attachment }],
    });
    await assert.rejects(permanent.read(image!.attachment), {
      code: "attachment_missing",
    });
    const legacy = await permanent.importBytes(distinctPng(3), "image/png");
    await drafts.abandon(1, [legacy.sha256, "../../attachments"]);
    await drafts.collectAbandoned();
    assert.deepEqual(await drafts.read(legacy), distinctPng(3));
  });
});

test("editing away an image does not retire frozen pending, failed or unconfirmed sends", async () => {
  await fixture(async ({ drafts }) => {
    const [image] = await drafts.importImages(1, input());
    let state = addComposerImages(emptyComposerState(), [image!]);
    assert.equal(
      composerRetainsImage(removeComposerImage(state, image!.id), image!.id),
      false,
    );
    state = beginComposerSubmission(state, "start", null, () => "send");
    state = removeComposerImage(state, image!.id);
    assert.equal(composerRetainsImage(state, image!.id), true);
    state = {
      ...state,
      submission: { ...state.submission!, status: "failed" },
    };
    assert.equal(composerRetainsImage(state, image!.id), true);
    state = {
      ...state,
      submission: null,
      pendingSends: [
        {
          clientId: "send",
          intent: "start",
          draft: { text: "", images: [image!] },
          status: "unconfirmed",
          error: null,
        },
      ],
    };
    assert.equal(composerRetainsImage(state, image!.id), true);
  });
});

test("the automatic collector revisits a later shared-lease deadline without polling or expiring live drafts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-draft-timer-"));
  try {
    const permanent = new FileAttachmentStore(path.join(root, "attachments"));
    const drafts = new ZenXDraftAttachments(
      path.join(root, "drafts"),
      permanent,
      { graceMs: 60 },
    );
    const [first] = await drafts.importImages(1, input());
    const [second] = await drafts.importImages(2, input());
    await drafts.abandon(1, [first!.id]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await drafts.abandon(2, [second!.id]);
    const deadline = Date.now() + 5_000;
    while (
      (await drafts.inventory()).abandonedBytes !== 0 &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(drafts.read(first!.attachment), {
      code: "attachment_missing",
    });
    assert.equal((await drafts.inventory()).abandonedBytes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real persisted Host retains the same original attachment through admission, fork, archive, recoverable deletion and cold restore", async () => {
  await fixture(async ({ root, drafts, permanent, advance }) => {
    const options: ZenHostOptions = {
      cwd: root,
      dataDirectory: root,
      approvalPolicy: "never" as const,
      model: "fake",
      models: ["fake"],
      provider: { type: "fake" as const },
      attachments: permanent,
      toolPresentation: "direct",
      modelCatalog: [
        {
          id: "fake",
          inputModalities: ["text", "image"],
          contextWindow: 32768,
          supportedReasoningEfforts: ["medium"],
          defaultReasoningEffort: "medium",
          source: "manual",
        },
      ],
    };
    const host = createHostedAppServer(options);
    const [image] = await drafts.importImages(1, input());
    const parts = [{ type: "image" as const, attachment: image!.attachment }];
    let sourceId = "";
    let childId = "";
    let deletionId = "";
    try {
      sourceId = (await host.startThread()).id;
      await drafts.prepareRequest("zen/turn/send", { input: parts });
      await (
        await host.startTurn(sourceId, parts)
      ).done;
      const source = await host.readThread(sourceId);
      assert.ok(
        source.items.some(
          (item) =>
            item.type === "user_message" &&
            item.content?.some(
              (part) =>
                part.type === "image" &&
                part.attachment.sha256 === image!.attachment.sha256,
            ),
        ),
      );
      childId = (
        await host.forkThread({
          sourceThreadId: sourceId,
          through: { type: "latest-complete" },
          workspace: { type: "same-directory" },
        })
      ).id;
      await host.setThreadArchived(sourceId, true);
      const archived = await host.readThread(sourceId);
      deletionId = (
        await host.deleteThread(sourceId, archived.items.at(-1)!.id)
      ).deletionItemId;
      await drafts.abandon(1, [image!.id]);
      advance();
      await drafts.collectAbandoned();
      assert.deepEqual(await permanent.read(image!.attachment), png1x1());
    } finally {
      await host.closeHostResources();
    }
    const cold = createHostedAppServer(options);
    try {
      const restored = await cold.restoreThread(sourceId, deletionId);
      const child = await cold.readThread(childId);
      for (const thread of [restored, child])
        assert.ok(
          thread.items.some(
            (item) =>
              item.type === "user_message" &&
              item.content?.some(
                (part) =>
                  part.type === "image" &&
                  part.attachment.sha256 === image!.attachment.sha256,
              ),
          ),
        );
      assert.deepEqual(await drafts.read(image!.attachment), png1x1());
    } finally {
      await cold.closeHostResources();
    }
  });
});
