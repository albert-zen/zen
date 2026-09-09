import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { projectModelMessages } from "../src/model-content.js";
import type { ModelMessage } from "../src/model.js";
import { png1x1 } from "./fixtures.js";

test("capability projection covers historical user and tool media without changing canonical content", async () => {
  const attachment = await new InMemoryAttachmentStore().importBytes(png1x1());
  const messages: ModelMessage[] = [
    { role: "user", content: [{ type: "image", attachment }] },
    {
      role: "tool",
      callId: "old",
      text: "receipt",
      exitCode: 0,
      modelContent: [{ type: "image", attachment }],
    },
  ];
  const before = structuredClone(messages);
  const textOnly = projectModelMessages(messages, ["text"]);
  assert.match(JSON.stringify(textOnly), new RegExp(attachment.sha256));
  assert.doesNotMatch(JSON.stringify(textOnly), /"type":"image"/);
  assert.deepEqual(projectModelMessages(messages), textOnly);
  assert.deepEqual(projectModelMessages(messages, ["text", "image"]), before);
  assert.deepEqual(messages, before);
});

import {
  createMediaOutputConverter,
  resolveCodeMedia,
} from "../src/model-content.js";
import { compileModelMessages } from "../src/model.js";
import {
  decodeCanonicalItem,
  normalizeUserInput,
  previewFromUserInput,
  sameUserInput,
  type CanonicalItem,
} from "../src/item.js";
import { ViewImageToolRuntime } from "../src/view-image.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const base = {
  threadId: "thread",
  turnId: "turn",
  createdAt: "2026-09-09T00:00:00.000Z",
};
function userItem(content: import("../src/item.js").UserInput): CanonicalItem {
  return { ...base, id: "user", type: "user_message", content };
}
function wav(): Buffer {
  const bytes = Buffer.alloc(46);
  bytes.write("RIFF");
  bytes.writeUInt32LE(38, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(2, 40);
  return bytes;
}

test("explicit image accepts inline/MCP bytes and authorized refs, rejects foreign refs, paths and network URLs", async () => {
  const store = new InMemoryAttachmentStore();
  const value = `data:image/png;base64,${Buffer.from(png1x1()).toString("base64")}`;
  const content = await resolveCodeMedia("image", value, store);
  const part = content[0]!;
  assert(part.type === "image");
  assert.deepEqual(
    await resolveCodeMedia(
      "image",
      {
        type: "image",
        data: Buffer.from(png1x1()).toString("base64"),
        mimeType: "image/png",
      },
      store,
    ),
    content,
  );
  assert.deepEqual(
    await resolveCodeMedia("image", { image_url: value }, store),
    content,
  );
  await assert.rejects(
    resolveCodeMedia("image", part.attachment, store),
    /not referenced/,
  );
  assert.deepEqual(
    await resolveCodeMedia("image", part.attachment, store, [
      userItem(content),
    ]),
    content,
  );
  assert.deepEqual(
    await resolveCodeMedia("image", part, store, [userItem(content)]),
    content,
  );
  await assert.rejects(
    resolveCodeMedia(
      "image",
      { ...part.attachment, byteLength: part.attachment.byteLength + 1 },
      store,
      [userItem(content)],
    ),
    /not referenced/,
  );
  for (const invalid of [
    "/tmp/image.png",
    "https://example.com/a.png",
    { path: "/tmp/image.png" },
    "data:image/png;base64,%%%",
  ])
    await assert.rejects(resolveCodeMedia("image", invalid, store));
  await assert.rejects(
    resolveCodeMedia("audio", value, store),
    /Expected audio/,
  );
  await assert.rejects(
    resolveCodeMedia("image", part.attachment, new InMemoryAttachmentStore(), [
      userItem(content),
    ]),
    /missing/,
  );
});

test("audio converts to validated canonical content and survives text-only projection and replay", async () => {
  const store = new InMemoryAttachmentStore();
  const content = await resolveCodeMedia(
    "audio",
    { type: "audio", mimeType: "audio/wav", data: wav().toString("base64") },
    store,
  );
  const item = userItem(content);
  assert.deepEqual(decodeCanonicalItem(JSON.parse(JSON.stringify(item))), item);
  assert.deepEqual(normalizeUserInput(content), content);
  assert.equal(previewFromUserInput(content), "[Audio]");
  assert(sameUserInput(content, structuredClone(content)));
  const messages = compileModelMessages([item]);
  assert.deepEqual(projectModelMessages(messages, ["audio"]), messages);
  assert.doesNotMatch(
    JSON.stringify(projectModelMessages(messages, ["image", "text"])),
    /"type":"audio"/,
  );
  assert.match(
    JSON.stringify(projectModelMessages(messages, null)),
    /audio input unavailable/,
  );
  const part = content[0]!;
  assert(part.type === "audio");
  assert.deepEqual(
    await resolveCodeMedia("audio", part.attachment, store, [item]),
    content,
  );
  assert.equal(part.attachment.width, undefined);
  assert.throws(() =>
    decodeCanonicalItem(
      userItem([{ type: "image", attachment: part.attachment }]),
    ),
  );
  assert.throws(() =>
    decodeCanonicalItem(
      userItem([
        {
          type: "audio",
          attachment: {
            ...part.attachment,
            mediaType: "image/png",
            width: 1,
            height: 1,
          },
        },
      ]),
    ),
  );
});

test("converter shares the store and removes duplicate explicit media while nested view_image still emits automatically", async () => {
  const store = new InMemoryAttachmentStore();
  const content = await createMediaOutputConverter(store)([
    {
      type: "image",
      value: `data:image/png;base64,${Buffer.from(png1x1()).toString("base64")}`,
    },
    {
      type: "image",
      value: {
        type: "image",
        data: Buffer.from(png1x1()).toString("base64"),
        mimeType: "image/png",
      },
    },
  ]);
  assert.equal(content.length, 1);
  const items: CanonicalItem[] = [
    {
      ...base,
      id: "outer",
      type: "tool_call",
      callId: "outer",
      name: "run_code",
      arguments: {},
    },
    {
      ...base,
      id: "middle",
      type: "tool_call",
      callId: "middle",
      parentCallId: "outer",
      name: "run_code",
      arguments: {},
    },
    {
      ...base,
      id: "child",
      type: "tool_call",
      callId: "child",
      parentCallId: "middle",
      name: "view_image",
      arguments: {},
    },
    {
      ...base,
      id: "child-result",
      type: "tool_result",
      callId: "child",
      output: "viewed",
      exitCode: 0,
      modelContent: content,
    },
    {
      ...base,
      id: "middle-result",
      type: "tool_result",
      callId: "middle",
      output: "",
      exitCode: 0,
    },
    {
      ...base,
      id: "outer-result",
      type: "tool_result",
      callId: "outer",
      output: "done",
      exitCode: 0,
      modelContent: content,
    },
  ];
  const before = structuredClone(items);
  const messages = compileModelMessages(items);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.at(-1), {
    role: "tool",
    callId: "outer",
    text: "done",
    exitCode: 0,
    modelContent: content,
  });
  assert.deepEqual(items, before);
  assert.deepEqual(
    await createMediaOutputConverter(store)(
      [{ type: "image", value: content[0] }],
      items,
    ),
    content,
  );
});

test("view_image reads local files for text-only delivery, keeps canonical image and rejects audio paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-media-"));
  try {
    await writeFile(path.join(directory, "test.png"), png1x1());
    await writeFile(path.join(directory, "test.wav"), wav());
    const runtime = new ViewImageToolRuntime({
      attachments: new InMemoryAttachmentStore(),
      journal: new InMemoryThreadJournal(),
    });
    const invocation = {
      callId: "view",
      name: "view_image",
      cwd: directory,
      arguments: { path: "test.png" },
      signal: new AbortController().signal,
    };
    const result = await runtime.execute(invocation);
    assert.equal(result.exitCode, 0);
    assert.equal(result.modelContent?.[0]?.type, "image");
    const projected = projectModelMessages(
      [
        {
          role: "tool",
          callId: "view",
          text: result.output,
          exitCode: result.exitCode,
          modelContent: result.modelContent!,
        },
      ],
      ["text"],
    );
    assert.doesNotMatch(JSON.stringify(projected), /"type":"image"/);
    await assert.rejects(
      runtime.execute({ ...invocation, arguments: { path: "test.wav" } }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("WAV and MP3 use the same immutable file store and reject corrupt, oversized or mislabeled audio", async () => {
  const { FileAttachmentStore, MAX_AUDIO_BYTES } =
    await import("../src/attachment.js");
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-audio-"));
  try {
    const store = new FileAttachmentStore(directory);
    // A complete MPEG-1 Layer III 128kbps/44.1kHz frame, structurally valid.
    const mp3 = Buffer.alloc(417);
    mp3.set([0xff, 0xfb, 0x90, 0x00]);
    for (const [bytes, mime] of [
      [wav(), "audio/wav"],
      [mp3, "audio/mpeg"],
    ] as const) {
      const ref = await store.importBytes(bytes, mime);
      assert.equal(ref.mediaType, mime);
      assert.equal(ref.width, undefined);
      assert.deepEqual(await store.importBytes(bytes, mime), ref);
      assert.deepEqual(
        Buffer.from(await new FileAttachmentStore(directory).read(ref)),
        bytes,
      );
      await assert.rejects(
        store.importBytes(bytes.subarray(0, bytes.length - 1), mime),
        /corrupt/,
      );
      await assert.rejects(
        store.read({ ...ref, byteLength: ref.byteLength + 1 }),
        /immutable reference/,
      );
      await assert.rejects(
        store.importBytes(bytes, "image/png"),
        /does not match/,
      );
    }
    await assert.rejects(
      store.importBytes(Buffer.from("not audio"), "audio/wav"),
    );
    await assert.rejects(
      store.importBytes(
        Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000"),
        "audio/mpeg",
      ),
      /corrupt/,
    );
    const large = Buffer.alloc(MAX_AUDIO_BYTES + 1);
    large.write("RIFF");
    large.write("WAVE", 8);
    await assert.rejects(store.importBytes(large, "audio/wav"), /limit/);
    const invalidWav = wav();
    invalidWav.writeUInt16LE(0, 32);
    await assert.rejects(store.importBytes(invalidWav, "audio/wav"), /corrupt/);
    const valid = await store.importBytes(wav(), "audio/wav");
    const forged = { ...valid, width: 1, height: 1 };
    await assert.rejects(
      store.read(forged as import("../src/attachment.js").AttachmentRef),
      /invalid/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("media explicitly emitted on wait is not also lifted into the original run_code receipt", async () => {
  const attachment = await new InMemoryAttachmentStore().importBytes(png1x1());
  const modelContent = [{ type: "image" as const, attachment }];
  const items: CanonicalItem[] = [
    {
      ...base,
      id: "p",
      type: "tool_call",
      callId: "program",
      name: "run_code",
      arguments: { code: "" },
    },
    {
      ...base,
      id: "p-r",
      type: "tool_result",
      callId: "program",
      output: "running",
      exitCode: 0,
    },
    {
      ...base,
      id: "c",
      type: "tool_call",
      callId: "child",
      parentCallId: "program",
      name: "view_image",
      arguments: {},
    },
    {
      ...base,
      id: "c-r",
      type: "tool_result",
      callId: "child",
      output: "image",
      exitCode: 0,
      modelContent,
    },
    {
      ...base,
      id: "w",
      type: "tool_call",
      callId: "wait",
      name: "wait",
      arguments: { task_id: "task" },
    },
    {
      ...base,
      id: "w-r",
      type: "tool_result",
      callId: "wait",
      output: "completed",
      exitCode: 0,
      modelContent,
    },
  ];
  const before = structuredClone(items);
  const messages = compileModelMessages(items);
  assert.equal(
    messages
      .flatMap((m) => (m.role === "tool" ? (m.modelContent ?? []) : []))
      .filter((p) => p.type === "image").length,
    1,
  );
  assert.deepEqual(items, before);
});
