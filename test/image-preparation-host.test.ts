import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { FileAttachmentStore } from "../src/attachment.js";
import { compileItemList, type ContextItem } from "../src/item-list.js";
import { modelMediaOrigin } from "../src/model-media-origin.js";
import { ToolEnvironment } from "../src/tool.js";

test("real Host prepares uploaded images before serialization and cold compiler replays the stored view at its occurrence", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-image-preparation-"),
  );
  const attachments = new FileAttachmentStore(
    path.join(directory, "attachments"),
  );
  const originalBytes = await sharp({
    create: { width: 2048, height: 2048, channels: 3, background: "#aabbcc" },
  })
    .png()
    .toBuffer();
  const original = await attachments.importBytes(originalBytes);
  const priorFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] })}\n\n`,
    );
  };
  const host = createHostedAppServer({
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
      {
        id: "unknown-image-model",
        inputModalities: null,
        supportedReasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
        contextWindow: 32768,
        source: "manual",
      },
    ],
    toolPresentation: "direct",
    toolEnvironment: new ToolEnvironment(),
    attachments,
  });
  try {
    const thread = await host.startThread();
    await host.updateThreadSettings(thread.id, {
      selection: {
        providerProfileId: "openai-compatible",
        modelId: "unknown-image-model",
      },
    });
    await (
      await host.startTurn(thread.id, [
        { type: "text", text: "before" },
        { type: "image", attachment: original },
        { type: "text", text: "after" },
      ])
    ).done;
    assert.equal(bodies.length, 1);
    assert.equal(
      /input is unavailable|were not sent or read/u.test(
        JSON.stringify(bodies[0]),
      ),
      false,
      "Unknown modality follows Host attempt semantics; its persisted notice must not falsely deny the sent/read image",
    );
    const message = bodies[0].messages.find(
      (m: any) =>
        Array.isArray(m.content) &&
        m.content.some((p: any) => p.type === "image_url"),
    );
    const index = message.content.findIndex((p: any) => p.type === "image_url");
    const sentBytes = Buffer.from(
      message.content[index].image_url.url.split(",")[1],
      "base64",
    );
    const metadata = await sharp(sentBytes).metadata();
    assert.deepEqual([metadata.width, metadata.height], [1600, 1600]);
    assert.equal(message.content[index - 2].text, "before");
    assert.match(
      message.content[index - 1].text,
      /2048x2048.*1600x1600.*original.*view_image/u,
    );
    assert.equal(message.content[index + 1].text, "after");
    assert.deepEqual(
      Buffer.from(await attachments.read(original)),
      originalBytes,
    );
    const snapshot = await host.readThread(thread.id);
    const user = snapshot.items.find((i) => i.type === "user_message")!;
    assert(user.type === "user_message" && user.content !== undefined);
    assert.deepEqual(user.content[1], { type: "image", attachment: original });
    await host.closeHostResources();
    const cold = (
      await readFile(
        path.join(directory, "threads", "items", `${thread.id}.jsonl`),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as ContextItem[];
    const preparation = cold.find(
      (i) => i.source.kind === ("image_preparation" as string),
    )!;
    assert(preparation !== undefined);
    const sampleId = String(preparation.source.metadata!.onlySampleId);
    const replay = compileItemList(cold, {
      sampleId,
      inputModalities: ["text", "image"],
    });
    const images = replay.messages
      .flatMap((m) =>
        m.role === "user" && "content" in m
          ? m.content
          : m.role === "tool"
            ? (m.modelContent ?? [])
            : [],
      )
      .filter((p) => p.type === "image");
    assert.equal(
      images.length,
      1,
      "prepared supplement must not appear a second time at the tail",
    );
    assert.equal(images[0]!.attachment.width, 1600);
    assert.deepEqual(modelMediaOrigin(images[0]!), {
      itemId: user.id,
      field: "content",
      partIndex: 1,
      sha256: original.sha256,
    });
    const withoutSample = compileItemList(cold, {
      sampleId: "different-sample",
      inputModalities: ["text", "image"],
    });
    const unchanged = withoutSample.messages
      .flatMap((m) => (m.role === "user" && "content" in m ? m.content : []))
      .find((p) => p.type === "image")!;
    assert.equal(unchanged.type, "image");
    if (unchanged.type === "image")
      assert.equal(unchanged.attachment.sha256, original.sha256);
  } finally {
    await host.closeHostResources();
    globalThis.fetch = priorFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "default high",
    detail: undefined,
    capability: undefined,
    width: 2048,
    height: 1024,
  },
  {
    name: "supported original",
    detail: "original",
    capability: true,
    width: 4096,
    height: 2048,
  },
  {
    name: "unknown original",
    detail: "original",
    capability: undefined,
    error: /capability is unknown/u,
  },
  {
    name: "unsupported original",
    detail: "original",
    capability: false,
    error: /does not support original/u,
  },
] as const)
  test(`real Host view_image ${scenario.name} uses the same sample preparation and capability gate`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zen-view-preparation-"),
    );
    const { writeFile } = await import("node:fs/promises");
    const imagePath = path.join(directory, "source.png");
    const originalBytes = await sharp({
      create: { width: 4096, height: 2048, channels: 3, background: "orange" },
    })
      .png()
      .toBuffer();
    await writeFile(imagePath, originalBytes);
    const attachments = new FileAttachmentStore(
      path.join(directory, "attachments"),
    );
    const priorFetch = globalThis.fetch;
    const bodies: any[] = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const delta =
        bodies.length === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "call_view",
                  type: "function",
                  function: {
                    name: "view_image",
                    arguments: JSON.stringify({
                      path: imagePath,
                      ...(scenario.detail === undefined
                        ? {}
                        : { detail: scenario.detail }),
                    }),
                  },
                },
              ],
            }
          : { content: "done" };
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }] })}\n\n`,
      );
    };
    const host = createHostedAppServer({
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
          ...(scenario.capability === undefined
            ? {}
            : { supportsImageDetailOriginal: scenario.capability }),
        },
      ],
      toolPresentation: "direct",
      toolEnvironment: new ToolEnvironment(),
      attachments,
    });
    try {
      const thread = await host.startThread();
      await (
        await host.startTurn(thread.id, "Read the image")
      ).done;
      assert.equal(bodies.length, 2);
      const snapshot = await host.readThread(thread.id);
      const result = snapshot.items.find((i) => i.type === "tool_result")!;
      assert(result.type === "tool_result");
      if ("error" in scenario) {
        assert.match(result.output, scenario.error);
        assert.equal(result.modelContent, undefined);
        assert.equal(result.executionStatus, "failed");
        assert(!JSON.stringify(bodies).includes("data:image/"));
      } else {
        assert.equal(result.modelContent?.[0]?.type, "image");
        const ref = result.modelContent![0]!;
        assert(ref.type === "image");
        assert.deepEqual(
          [ref.attachment.width, ref.attachment.height],
          [4096, 2048],
        );
        assert.deepEqual(
          Buffer.from(await attachments.read(ref.attachment)),
          originalBytes,
        );
        const sent = bodies[1].messages
          .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
          .filter((p: any) => p.type === "image_url");
        assert.equal(sent.length, 1);
        const metadata = await sharp(
          Buffer.from(sent[0].image_url.url.split(",")[1], "base64"),
        ).metadata();
        assert.deepEqual(
          [metadata.width, metadata.height],
          [scenario.width, scenario.height],
        );
        assert.equal(sent[0].image_url.detail, scenario.detail);
      }
      assert.deepEqual(
        await readFile(imagePath),
        originalBytes,
        "view_image never overwrites its local source",
      );
    } finally {
      await host.closeHostResources();
      globalThis.fetch = priorFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });

test("real Host preflight counts forthcoming prepared dimensions and final window guard remains active", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-image-window-"));
  const attachments = new FileAttachmentStore(
    path.join(directory, "attachments"),
  );
  const original = await attachments.importBytes(
    await sharp({
      create: { width: 4096, height: 4096, channels: 3, background: "cyan" },
    })
      .png()
      .toBuffer(),
  );
  const priorFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] })}\n\n`,
    );
  };
  const host = createHostedAppServer({
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
        contextWindow: 10000,
        source: "manual",
      },
    ],
    toolPresentation: "direct",
    toolEnvironment: new ToolEnvironment(),
    attachments,
  });
  try {
    const thread = await host.startThread();
    await (
      await host.startTurn(thread.id, [{ type: "image", attachment: original }])
    ).done;
    assert.equal(
      bodies.length,
      1,
      "raw 16384-patch source must not trigger needless compaction before its 2500-patch prepared sample",
    );
    const snapshot = await host.readThread(thread.id);
    assert(!snapshot.items.some((i) => i.type === "context_compaction"));
    assert(
      snapshot.items.some(
        (i) => i.type === "turn_completed" && i.status === "completed",
      ),
    );
    const usage = await host.readModelUsage(thread.id);
    assert(usage.context.estimate!.total < 10000);
    await (
      await host.startTurn(thread.id, "X".repeat(50000))
    ).done;
    assert(
      !JSON.stringify(bodies.slice(1)).includes("X".repeat(50000)),
      "over-window input must not dispatch; bounded compaction of the preceding history may still run",
    );
    assert(
      (await host.readThread(thread.id)).items.some(
        (i) => i.type === "failure",
      ),
    );
  } finally {
    await host.closeHostResources();
    globalThis.fetch = priorFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
