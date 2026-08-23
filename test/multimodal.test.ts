import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { png1x1 } from "./fixtures.js";

import { ZenAppServer } from "../src/app-server.js";
import {
  FileAttachmentStore,
  InMemoryAttachmentStore,
  type AttachmentStore,
} from "../src/attachment.js";
import type { CanonicalItem } from "../src/item.js";
import {
  InMemoryThreadJournal,
  JsonlThreadJournal,
  type ThreadJournal,
} from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import {
  compileModelMessages,
  type ModelAdapter,
  type ModelEvent,
  type ModelMessage,
} from "../src/model.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { CodexConnection } from "../src/protocol/codex/connection.js";
import { projectThread } from "../src/protocol/codex/mapper.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ShellToolExecutor } from "../src/tool.js";

test("runs typed image input through AttachmentRef to provider and replays it after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-multimodal-"));
  const journal = new JsonlThreadJournal(path.join(root, "threads"));
  const attachments = new FileAttachmentStore(path.join(root, "attachments"));
  const localPath = path.join(root, "temporary-input.png");
  const bodies: Array<Record<string, unknown>> = [];
  try {
    await writeFile(localPath, png1x1());
    const firstModel = capturingCompatibleModel(attachments, bodies);
    const first = createServer({ journal, attachments, model: firstModel });
    const thread = await first.startThread();
    const turnCompleted = deferred<void>();
    const connection = new CodexConnection({
      appServer: first,
      zenHome: path.join(root, "home"),
      send: (message) => {
        if ("method" in message && message.method === "turn/completed") {
          turnCompleted.resolve();
        }
      },
    });
    await connection.receive({ id: 1, method: "initialize", params: {} });
    await connection.receive({ method: "initialized" });
    await connection.receive({
      id: 2,
      method: "turn/start",
      params: {
        threadId: thread.id,
        input: [
          { type: "text", text: "describe this" },
          { type: "localImage", path: localPath },
        ],
      },
    });
    await turnCompleted.promise;
    connection.close();

    assert.equal(bodies.length, 1);
    assert.deepEqual(
      (bodies[0]?.messages as Array<Record<string, unknown>>)[0]?.content,
      [
        { type: "text", text: "describe this" },
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${Buffer.from(png1x1()).toString("base64")}`,
          },
        },
      ],
    );

    const journalText = await readFile(
      path.join(root, "threads", `${thread.id}.jsonl`),
      "utf8",
    );
    assert.equal(journalText.includes(localPath), false);
    assert.equal(journalText.includes("base64"), false);
    assert.equal(
      journalText.includes(Buffer.from(png1x1()).toString("base64")),
      false,
    );
    const firstMessage = (await first.readThread(thread.id)).items.find(
      (item) => item.type === "user_message",
    );
    assert(firstMessage?.type === "user_message");
    const ref = firstMessage.content?.find(
      (part) => part.type === "image",
    )?.attachment;
    assert(ref !== undefined);
    assert(journalText.includes(ref.sha256));

    const beforeRestart = await first.readThread(thread.id);
    const initialHistory = beforeRestart.items.slice(
      0,
      beforeRestart.items.findIndex((item) => item.type === "user_message") + 1,
    );
    const projectedBefore = compileModelMessages(initialHistory);

    const replayBodies: Array<Record<string, unknown>> = [];
    const restarted = createServer({
      journal,
      attachments: new FileAttachmentStore(path.join(root, "attachments")),
      model: capturingCompatibleModel(
        new FileAttachmentStore(path.join(root, "attachments")),
        replayBodies,
      ),
    });
    const replayed = await restarted.readThread(thread.id);
    const projectedAfter = compileModelMessages(
      replayed.items.slice(0, initialHistory.length),
    );
    assert.deepEqual(projectedAfter, projectedBefore);
    await drainModel(
      capturingCompatibleModel(
        new FileAttachmentStore(path.join(root, "attachments")),
        replayBodies,
      ),
      projectedAfter,
    );
    assert.deepEqual(replayBodies[0], bodies[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attachment import failure appends no Item and journal failure may leave only an unreferenced blob", async () => {
  const attachments = new InMemoryAttachmentStore();
  const backing = new InMemoryThreadJournal();
  let failTurnStart = false;
  const journal: ThreadJournal = {
    append: async (item) => {
      if (failTurnStart && item.type === "turn_started") {
        throw new Error("journal unavailable");
      }
      await backing.append(item);
    },
    listThreadIds: async () => await backing.listThreadIds(),
    read: async (threadId) => await backing.read(threadId),
  };
  const server = createServer({ journal, attachments });
  const thread = await server.startThread();
  const before = thread.items;
  await assert.rejects(server.importImageBytes(Buffer.from("not an image")), {
    code: "attachment_invalid",
  });
  assert.deepEqual((await server.readThread(thread.id)).items, before);

  const ref = await server.importImageBytes(png1x1());
  failTurnStart = true;
  await assert.rejects(
    server.startTurn(thread.id, [{ type: "image", attachment: ref }]),
    /journal unavailable/u,
  );
  assert.deepEqual(
    Buffer.from(await attachments.read(ref)),
    Buffer.from(png1x1()),
  );
  assert.deepEqual(
    (await backing.read(thread.id)).map((item) => item.type),
    ["thread_metadata"],
  );
});

test("an initial user-message journal failure leaves an interrupted start without synthetic failure Items", async () => {
  const attachments = new InMemoryAttachmentStore();
  const backing = new InMemoryThreadJournal();
  const journal: ThreadJournal = {
    append: async (item) => {
      if (item.type === "user_message") throw new Error("input unavailable");
      await backing.append(item);
    },
    listThreadIds: async () => await backing.listThreadIds(),
    read: async (threadId) => await backing.read(threadId),
  };
  const server = createServer({ journal, attachments });
  const thread = await server.startThread();
  const ref = await server.importImageBytes(png1x1());

  await assert.rejects(
    server.startTurn(thread.id, [{ type: "image", attachment: ref }]),
    /input unavailable/u,
  );
  assert.deepEqual(
    (await backing.read(thread.id)).map((item) => item.type),
    ["thread_metadata", "turn_started"],
  );
});

test("Unknown image capability is attempted while unsupported fails before a Turn starts", async () => {
  for (const [inputModalities, expectedCode] of [
    [null, null],
    [["text"] as const, "image_input_unsupported"],
  ] as const) {
    const attachments = new InMemoryAttachmentStore();
    const journal = new InMemoryThreadJournal();
    let providerInvocations = 0;
    const server = createServer({
      journal,
      attachments,
      inputModalities,
      model: {
        provider: "image-provider",
        async *stream(): AsyncIterable<ModelEvent> {
          providerInvocations += 1;
        },
      },
    });
    const thread = await server.startThread();
    const ref = await server.importImageBytes(png1x1());
    if (expectedCode === null) {
      const turn = await server.startTurn(thread.id, [
        { type: "image", attachment: ref },
      ]);
      await turn.done;
      assert.equal(providerInvocations, 1);
    } else {
      await assert.rejects(
        server.startTurn(thread.id, [{ type: "image", attachment: ref }]),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === expectedCode,
      );
      assert.deepEqual(
        (await journal.read(thread.id)).map((item) => item.type),
        ["thread_metadata"],
      );
      assert.equal(providerInvocations, 0);
    }
  }
});

test("soft steer validates image input against the active Turn's frozen model", async () => {
  const attachments = new InMemoryAttachmentStore();
  const firstSampleStarted = deferred<void>();
  const releaseFirstSample = deferred<void>();
  const requests: ModelMessage[][] = [];
  const server = createServer({
    journal: new InMemoryThreadJournal(),
    attachments,
    model: {
      provider: "image-provider",
      async *stream(request): AsyncIterable<ModelEvent> {
        requests.push(request.messages);
        if (requests.length === 1) {
          firstSampleStarted.resolve();
          await releaseFirstSample.promise;
        }
        yield { type: "text_delta", delta: "ok" };
      },
    },
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "initial");
  await firstSampleStarted.promise;
  await server.updateThreadSettings(thread.id, { model: "text-model" });
  const ref = await server.importImageBytes(png1x1());
  await server.steerTurn(thread.id, turn.id, [
    { type: "image", attachment: ref },
  ]);
  releaseFirstSample.resolve();
  await turn.done;

  assert.equal(requests.length, 2);
  assert(
    requests[1]?.some(
      (message) =>
        message.role === "user" &&
        "content" in message &&
        message.content.some((part) => part.type === "image"),
    ),
  );
});

test("soft steer does not borrow image capability from the next Turn", async () => {
  const attachments = new InMemoryAttachmentStore();
  const sampleStarted = deferred<void>();
  const releaseSample = deferred<void>();
  const server = createServer({
    journal: new InMemoryThreadJournal(),
    attachments,
    model: {
      provider: "image-provider",
      async *stream(): AsyncIterable<ModelEvent> {
        sampleStarted.resolve();
        await releaseSample.promise;
        yield { type: "text_delta", delta: "ok" };
      },
    },
  });
  const thread = await server.startThread({ model: "text-model" });
  const turn = await server.startTurn(thread.id, "initial");
  await sampleStarted.promise;
  await server.updateThreadSettings(thread.id, { model: "image-model" });
  const ref = await server.importImageBytes(png1x1());
  await assert.rejects(
    server.steerTurn(thread.id, turn.id, [{ type: "image", attachment: ref }]),
    { code: "image_input_unsupported" },
  );
  releaseSample.resolve();
  await turn.done;
});

test("hard replace keeps typed image input in its canonical public seam", async () => {
  const attachments = new InMemoryAttachmentStore();
  const oldSampleStarted = deferred<void>();
  let samples = 0;
  const server = createServer({
    journal: new InMemoryThreadJournal(),
    attachments,
    model: {
      provider: "image-provider",
      async *stream(request): AsyncIterable<ModelEvent> {
        samples += 1;
        if (samples === 1) {
          oldSampleStarted.resolve();
          await new Promise<never>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            );
          });
        }
        yield { type: "text_delta", delta: "ok" };
      },
    },
  });
  const thread = await server.startThread();
  const oldTurn = await server.startTurn(thread.id, "old");
  await oldSampleStarted.promise;
  const ref = await server.importImageBytes(png1x1());
  const replacement = await server.replaceTurn(
    thread.id,
    oldTurn.id,
    [{ type: "image", attachment: ref }],
    { clientId: "typed-image-replacement" },
  );
  await replacement.turn.done;

  const snapshot = await server.readThread(thread.id);
  const intent = snapshot.items.find(
    (item) => item.type === "turn_replacement_requested",
  );
  assert(intent?.type === "turn_replacement_requested" && "input" in intent);
  assert.equal(intent.input[0]?.type, "image");
  const replacementMessage = snapshot.items.find(
    (item) =>
      item.type === "user_message" &&
      item.clientId === "typed-image-replacement",
  );
  assert.equal(replacementMessage?.type, "user_message");
  assert.equal(replacementMessage.content?.[0]?.type, "image");
});

test("uses a provider-neutral preview for image-only input", async () => {
  const attachments = new InMemoryAttachmentStore();
  const server = createServer({
    journal: new InMemoryThreadJournal(),
    attachments,
  });
  const thread = await server.startThread();
  const ref = await server.importImageBytes(png1x1());
  await (
    await server.startTurn(thread.id, [{ type: "image", attachment: ref }])
  ).done;

  assert.equal((await server.listThreadSummaries())[0]?.preview, "[Image]");
  assert.equal(
    projectThread(await server.readThread(thread.id), { includeTurns: false })
      .preview,
    "[Image]",
  );
});

test("legacy text-only user messages still compile after restart", async () => {
  const item: CanonicalItem = {
    id: "legacy-user",
    threadId: "legacy-thread",
    turnId: "legacy-turn",
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "user_message",
    text: "legacy text",
  };
  assert.deepEqual(compileModelMessages([item]), [
    { role: "user", text: "legacy text" },
  ]);
});

test("retained AttachmentRefs survive compaction projection and restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-compaction-image-"));
  const journal = new JsonlThreadJournal(path.join(root, "threads"));
  const attachments = new FileAttachmentStore(path.join(root, "attachments"));
  const requests: ModelMessage[][] = [];
  const model: ModelAdapter = {
    provider: "image-provider",
    async *stream(request): AsyncIterable<ModelEvent> {
      const latest = request.messages.at(-1);
      if (
        latest?.role === "user" &&
        "text" in latest &&
        latest.text.includes("ZEN_CONTEXT_COMPACTION_V1")
      ) {
        yield { type: "text_delta", delta: "image context summary" };
        return;
      }
      requests.push(structuredClone(request.messages));
      yield { type: "text_delta", delta: "ok" };
    },
  };
  try {
    const first = createServer({ journal, attachments, model });
    const thread = await first.startThread();
    const ref = await first.importImageBytes(png1x1(), "image/png");
    await (
      await first.startTurn(thread.id, [
        { type: "text", text: "remember this image" },
        { type: "image", attachment: ref },
      ])
    ).done;
    await first.compactThread(thread.id);
    const beforeRestart = await first.readThread(thread.id);
    const projectedBefore = compileModelMessages(beforeRestart.items);
    assert.deepEqual(projectedBefore[0], {
      role: "user",
      content: [
        { type: "text", text: "remember this image" },
        { type: "image", attachment: ref },
      ],
    });

    const restartedAttachments = new FileAttachmentStore(
      path.join(root, "attachments"),
    );
    const restarted = createServer({
      journal: new JsonlThreadJournal(path.join(root, "threads")),
      attachments: restartedAttachments,
      model,
    });
    const replayed = await restarted.readThread(thread.id);
    const projectedAfter = compileModelMessages(replayed.items);
    assert.equal(
      JSON.stringify(projectedAfter),
      JSON.stringify(projectedBefore),
    );
    assert.deepEqual(
      [...(await restartedAttachments.read(ref))],
      [...png1x1()],
    );

    const providerBodies: Array<Record<string, unknown>> = [];
    await drainModel(
      capturingCompatibleModel(restartedAttachments, providerBodies),
      projectedAfter,
    );
    const providerMessages = providerBodies[0]?.messages;
    assert(Array.isArray(providerMessages));
    assert.equal(
      JSON.stringify(providerMessages).includes("data:image/png;base64"),
      true,
    );

    await (
      await restarted.startTurn(thread.id, "continue")
    ).done;
    assert.deepEqual(requests.at(-1), [
      ...projectedBefore,
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createServer(options: {
  journal: ThreadJournal;
  attachments: AttachmentStore;
  model?: ModelAdapter;
  inputModalities?: readonly "text"[] | null;
}): ZenAppServer {
  const model = options.model ?? echoModel();
  const catalog = new StaticModelCatalog([
    {
      id: "image-model",
      isDefault: true,
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      inputModalities:
        options.inputModalities === undefined
          ? ["text", "image"]
          : options.inputModalities,
      source: "manual",
    },
    {
      id: "text-model",
      isDefault: false,
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      inputModalities: ["text"],
      source: "manual",
    },
  ]);
  return new ZenAppServer({
    journal: options.journal,
    attachments: options.attachments,
    runtime: new AgentRuntime({ tools: new ShellToolExecutor() }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: catalog,
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: model.provider,
      modelId: "image-model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}

function echoModel(): ModelAdapter {
  return {
    provider: "image-provider",
    async *stream(): AsyncIterable<ModelEvent> {
      yield { type: "text_delta", delta: "ok" };
    },
  };
}

function capturingCompatibleModel(
  attachments: AttachmentStore,
  bodies: Array<Record<string, unknown>>,
): OpenAiCompatibleModel {
  return new OpenAiCompatibleModel({
    baseUrl: "https://provider.test/v1",
    apiKey: "fixture-key",
    provider: "image-provider",
    attachments,
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    },
  });
}

async function drainModel(
  model: ModelAdapter,
  messages: ModelMessage[],
): Promise<void> {
  for await (const _event of model.stream({
    model: "image-model",
    reasoningEffort: "medium",
    messages,
    tools: new ShellToolExecutor().definitions,
    signal: new AbortController().signal,
  })) {
    // Consume the provider stream so the captured request is complete.
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
