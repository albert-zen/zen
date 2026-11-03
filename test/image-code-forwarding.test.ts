import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { FileAttachmentStore } from "../src/attachment.js";
import { ToolEnvironment } from "../src/tool.js";

for (const scenario of [
  {
    name: "forwarded original",
    capability: true,
    mixed: false,
    explicit: false,
  },
  {
    name: "explicit HIGH and nested ORIGINAL",
    capability: true,
    mixed: true,
    explicit: false,
  },
  {
    name: "explicit original on unsupported model",
    capability: false,
    mixed: false,
    explicit: true,
  },
  {
    name: "explicit original on Unknown model",
    capability: null,
    mixed: false,
    explicit: true,
  },
] as const)
  test(`real run_code preserves ${scenario.name} through actual serialized images`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zen-code-image-detail-"),
    );
    const imagePath = path.join(directory, "source.png");
    const originalBytes = await sharp({
      create: { width: 4096, height: 2048, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    await writeFile(imagePath, originalBytes);
    const attachments = new FileAttachmentStore(
      path.join(directory, "attachments"),
    );
    const original = await attachments.importBytes(originalBytes);
    const code = scenario.explicit
      ? `image(${JSON.stringify({ type: "image", attachment: original, detail: "original" })});`
      : `const result = await tools.view_image({path: ${JSON.stringify(imagePath)}, detail: "original"}); image(${scenario.mixed ? '{ ...result.modelContent[0], detail: "high" }' : "result.modelContent[0]"});`;
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
                  id: "code",
                  type: "function",
                  function: {
                    name: "run_code",
                    arguments: JSON.stringify({ code }),
                  },
                },
              ],
            }
          : { content: "done" };
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
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
          supportsImageDetailOriginal: scenario.capability,
          supportedReasoningEfforts: ["medium"],
          defaultReasoningEffort: "medium",
          contextWindow: 32768,
          source: "manual",
        },
      ],
      toolPresentation: "code",
      toolEnvironment: new ToolEnvironment(),
      attachments,
    });
    try {
      const thread = await host.startThread();
      await (
        await host.startTurn(
          thread.id,
          scenario.explicit
            ? [{ type: "image", attachment: original }]
            : "Read the original image",
        )
      ).done;
      assert.equal(bodies.length, 2);
      const snapshot = await host.readThread(thread.id);
      const calls = snapshot.items.filter((item) => item.type === "tool_call");
      const parentCall = calls.find((item) => item.name === "run_code")!;
      const parentResult = snapshot.items.find(
        (item) =>
          item.type === "tool_result" && item.callId === parentCall.callId,
      )!;
      assert(
        parentResult.type === "tool_result" &&
          parentResult.executionStatus === "completed",
      );
      const emitted = parentResult.modelContent?.find(
        (part) => part.type === "image",
      );
      assert(emitted?.type === "image");
      assert.equal(emitted.detail, scenario.mixed ? "high" : "original");
      const wireImages = bodies[1].messages
        .flatMap((message: any) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .filter((part: any) => part.type === "image_url");
      const actual = await Promise.all(
        wireImages.map(async (part: any) => {
          const metadata = await sharp(
            Buffer.from(part.image_url.url.split(",")[1], "base64"),
          ).metadata();
          return {
            width: metadata.width,
            height: metadata.height,
            detail: part.image_url.detail ?? null,
          };
        }),
      );
      assert.deepEqual(
        actual,
        scenario.explicit
          ? [
              { width: 2048, height: 1024, detail: null },
              { width: 2048, height: 1024, detail: null },
            ]
          : scenario.mixed
            ? [
                { width: 2048, height: 1024, detail: "high" },
                { width: 4096, height: 2048, detail: "original" },
              ]
            : [{ width: 4096, height: 2048, detail: "original" }],
      );
      if (scenario.explicit)
        assert.match(
          JSON.stringify(bodies[1]),
          /Original image detail .*bounded HIGH view/u,
        );
      assert.deepEqual(await readFile(imagePath), originalBytes);
      assert.deepEqual(
        Buffer.from(await attachments.read(original)),
        originalBytes,
      );
    } finally {
      globalThis.fetch = priorFetch;
      await host.closeHostResources();
      await rm(directory, { recursive: true, force: true });
    }
  });
