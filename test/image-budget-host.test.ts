import assert from "node:assert/strict";
import test from "node:test";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { compileItemList, type ContextItem } from "../src/item-list.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import type { ModelAdapter, ModelMessage, ModelRequest } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolEnvironment } from "../src/tool.js";
import { ViewImageToolRuntime } from "../src/view-image.js";
import { modelMediaOrigin } from "../src/model-media-origin.js";
import { png1x1 } from "./fixtures.js";

function countImages(messages: readonly ModelMessage[]): number {
  return messages.reduce(
    (count, message) =>
      count +
      (message.role === "user" && "content" in message
        ? message.content
        : message.role === "tool"
          ? (message.modelContent ?? [])
          : []
      ).filter((part) => part.type === "image").length,
    0,
  );
}

test("Host budgets the actual compiled sample and preserves exact stored replay", async () => {
  const attachments = new InMemoryAttachmentStore();
  const ref = await attachments.importBytes(png1x1());
  const journal = new InMemoryThreadJournal();
  let actual: ModelRequest | undefined;
  let rejectNext = false;
  const model: ModelAdapter = {
    provider: "synthetic",
    async *stream(request) {
      actual = request;
      if (rejectNext) {
        rejectNext = false;
        const lastImage = request.messages
          .flatMap((message) =>
            message.role === "user" && "content" in message
              ? message.content
              : [],
          )
          .findLast((part) => part.type === "image")!;
        throw Object.assign(new Error("Synthetic exact image rejection"), {
          code: "invalid_image",
          recoveryRejectedMediaParts: [lastImage],
        });
      }
      yield { type: "text_delta", delta: "ok" };
    },
  };
  const environment = new ToolEnvironment({ runtimes: [] });
  const server = new ZenAppServer({
    journal,
    attachments,
    runtime: new AgentRuntime({ toolEnvironment: environment }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "synthetic",
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          {
            id: "image-model",
            isDefault: true,
            contextWindow: 100000,
            inputModalities: ["text", "image"],
          },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: "/tmp",
      providerProfileId: "synthetic",
      modelId: "image-model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  try {
    const thread = await server.startThread();
    for (let index = 0; index < 25; index++)
      await (
        await server.startTurn(thread.id, [{ type: "image", attachment: ref }])
      ).done;
    assert(actual?.debugContext !== undefined);
    assert.equal(
      countImages(actual.messages),
      24,
      "the real Host must not bypass the media budget",
    );
    const snapshot = await server.readThread(thread.id);
    const stored = snapshot.itemList!;
    const selected = actual.debugContext.selectedItemIds!;
    const itemList = stored.slice(
      0,
      stored.findIndex((item) => item.id === selected.at(-1)) + 1,
    );
    const options = {
      sampleId: actual.debugContext.sampleId,
      selection: { providerProfileId: "synthetic", modelId: "image-model" },
      inputModalities: ["text", "image"],
    };
    assert.deepEqual(
      compileItemList(itemList, options).messages,
      actual.messages,
    );
    const reloaded = JSON.parse(JSON.stringify(itemList)) as ContextItem[];
    assert.deepEqual(
      compileItemList(reloaded, options).messages,
      actual.messages,
    );
    assert.equal(
      countImages(
        compileItemList(reloaded, { ...options, sampleId: "other" }).messages,
      ),
      25,
      "the omission is sample-only, not a mutation of canonical images",
    );
    assert.equal(
      snapshot.items.filter((item) => item.type === "user_message").length,
      25,
    );
    assert.match(JSON.stringify(actual.messages), /omitted.*image budget/u);
    assert.deepEqual([...(await attachments.read(ref))], [...png1x1()]);
    const receipt = actual.messages
      .flatMap((message) =>
        message.role === "user" && "content" in message ? message.content : [],
      )
      .filter((part) => part.type === "text")
      .find((part) => part.text.includes("view_image("));
    assert(receipt?.type === "text");
    const recovered = await new ViewImageToolRuntime({
      attachments,
      journal,
    }).execute({
      name: "view_image",
      callId: "recover-budgeted-image",
      threadId: thread.id,
      cwd: "/tmp",
      signal: new AbortController().signal,
      arguments: JSON.parse(receipt.text.match(/view_image\((\{.*\})\)/u)![1]!),
    });
    assert.deepEqual(
      recovered.modelContent,
      [{ type: "image", attachment: ref }],
      "the receipt alone must be sufficient to retrieve an uploaded original",
    );
    const users = snapshot.items.filter((item) => item.type === "user_message");
    rejectNext = true;
    await (
      await server.startTurn(thread.id, "continue")
    ).done;
    const afterRecovery = await server.readThread(thread.id);
    const failure = afterRecovery.items.findLast(
      (item) => item.type === "failure",
    );
    assert(failure?.type === "failure");
    assert.equal(failure.recovery?.mediaScope, "exact");
    assert.deepEqual(failure.recovery?.withheldMedia, [
      {
        itemId: users.at(-1)!.id,
        field: "content",
        partIndex: 0,
        sha256: ref.sha256,
      },
    ]);
    assert.equal(countImages(actual.messages), 24);
    const retainedOrigins = actual.messages
      .flatMap((message) =>
        message.role === "user" && "content" in message ? message.content : [],
      )
      .filter((part) => part.type === "image")
      .map((part) => modelMediaOrigin(part)?.itemId);
    assert(
      retainedOrigins.includes(users[0]!.id),
      "a budget omission expires with its sample",
    );
    assert(
      !retainedOrigins.includes(users.at(-1)!.id),
      "only the provider-rejected occurrence stays withheld",
    );
  } finally {
    await environment.close();
  }
});
