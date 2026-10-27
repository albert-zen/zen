import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createHostedAppServer,
  type ZenHostOptions,
} from "../apps/cli/src/host.js";
import {
  compileItemList,
  decodeContextItem,
  type ContextItem,
} from "../src/item-list.js";
import { textFromUserInput, type CanonicalItem } from "../src/item.js";
import {
  ModelReferenceRegistry,
  validateModelReferenceBindings,
} from "../src/model-references.js";
import { FileTraceStore } from "../src/trace.js";
import { referenceMessage } from "../apps/zenx/src/renderer/src/reference-draft.js";
import { decodeThreadArguments } from "../apps/zenx/src/main/capabilities/model-thread-facade.js";

const response = (text: string) =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
const bindings = (items: readonly ContextItem[]) =>
  items.flatMap((item) =>
    item.source.metadata?.referenceBindings === undefined
      ? []
      : validateModelReferenceBindings(item.source.metadata.referenceBindings),
  );

test("actual Host persists compact user content before wire while log retains the original; compaction/fork/cold restart do not remint authority", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zen-selected-source-host-"),
  );
  const savedFetch = globalThis.fetch;
  const options: ZenHostOptions = {
    cwd: root,
    dataDirectory: root,
    model: "synthetic",
    provider: {
      type: "openai-compatible",
      baseUrl: "https://synthetic.invalid/v1",
      apiKey: "synthetic-header-only",
    },
    modelCatalog: [
      {
        id: "synthetic",
        isDefault: true,
        contextWindow: 32768,
        inputModalities: ["text"],
      },
    ],
    toolPresentation: "direct",
    approvalPolicy: "never",
  };
  let selectedThreadId = "";
  let payload = "";
  let wireChecks = 0;
  let requests = 0;
  let observedError: unknown;
  globalThis.fetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    const wire = body.messages as Array<{
      role: string;
      content: string | Array<{ text: string }>;
    }>;
    const summary = wire.some(
      (message) =>
        message.role === "developer" &&
        String(message.content).includes("ZEN_CONTEXT_COMPACTION_V1"),
    );
    if (selectedThreadId && !summary) {
      try {
        const items = (
          await readFile(
            path.join(root, "threads", "items", `${selectedThreadId}.jsonl`),
            "utf8",
          )
        )
          .trim()
          .split("\n")
          .map((line) => decodeContextItem(JSON.parse(line)));
        const selected = items.find(
          (item) => item.source.metadata?.generatedReference === true,
        );
        assert.ok(selected?.kind === "message");
        assert.equal(selected.role, "user");
        assert.ok(!selected.content.text.includes("zenx-reference-message:v3"));
        assert.match(
          selected.content.text,
          /Selected message "Recorded source"; s1;/,
        );
        assert.match(selected.content.text, /Message received at/);
        const actual = wire.findLast((message) => message.role === "user")!;
        const text =
          typeof actual.content === "string"
            ? actual.content
            : actual.content.map((part) => part.text).join("\n");
        assert.equal(text, selected.content.text);
        const records = (
          await new FileTraceStore(path.join(root, "trace")).read(
            selectedThreadId,
          )
        ).records;
        assert.ok(
          records.some(
            (record) =>
              record.type === "runtime_item" &&
              (record.data as { item: CanonicalItem }).item.type ===
                "user_message" &&
              JSON.stringify(record.data).includes(
                JSON.stringify(payload).slice(1, -1),
              ),
          ),
        );
        wireChecks++;
      } catch (error) {
        observedError = error;
      }
    }
    return response(
      summary ? "Remember the exact selected conclusion in s1." : "recorded",
    );
  };
  const host = createHostedAppServer(options);
  try {
    const source = await host.startThread();
    const excerpt =
      '  literal UUID 799d6949-3c55-40aa-9573-e18198441be2\nconst file = "/tmp/unchanged-user-path";  ';
    await (
      await host.startTurn(source.id, excerpt)
    ).done;
    const sourceSnapshot = await host.readThread(source.id);
    const original = sourceSnapshot.items.find(
      (item) => item.type === "user_message",
    )!;
    const target = await host.startThread();
    const clientId = "client-550e8400-e29b-41d4-a716-446655440000";
    payload = referenceMessage(
      "Explain \uFFFC",
      [
        {
          kind: "message",
          name: "Recorded source",
          cwd: root,
          threadId: source.id,
          id: original.id,
          excerpt,
          position: 8,
        },
      ],
      clientId,
    );
    selectedThreadId = target.id;
    await (
      await host.startTurn(target.id, payload, { clientId })
    ).done;
    assert.ifError(observedError);
    assert.equal(wireChecks, 1);
    let snapshot = await host.readThread(target.id);
    const received = snapshot.items.find(
      (item) => item.type === "user_message",
    );
    assert.ok(received?.type === "user_message");
    assert.equal(received.text ?? textFromUserInput(received.content), payload);
    const selected = snapshot.itemList!.find(
      (item) => item.source.metadata?.generatedReference === true,
    )!;
    assert.equal(selected.kind, "message");
    if (selected.kind !== "message") throw Error("message expected");
    assert.ok(selected.content.text.includes(excerpt));
    for (const routing of [source.id, original.id, clientId, root])
      assert.ok(!selected.content.text.includes(routing));
    const before = snapshot.items;
    await host.compactThread(target.id, { includeOriginalReference: true });
    snapshot = await host.readThread(target.id);
    assert.deepEqual(snapshot.items.slice(0, before.length), before);
    const selection = snapshot.itemList!.findLast(
      (item) => item.kind === "selection",
    )!;
    assert.equal(selection.kind, "selection");
    if (selection.kind !== "selection") throw Error("selection expected");
    assert.match(selection.content.text, /Original conversation history; s2;/);
    assert.ok(!selection.content.text.includes("zen-thread://"));
    assert.ok(!selection.content.text.includes(target.id));
    const refs = new ModelReferenceRegistry().scope(
      target.id,
      bindings(snapshot.itemList!),
    );
    assert.deepEqual(
      decodeThreadArguments("zenx_threads_read", { ref: "s1" }, refs, "epoch"),
      { threadId: source.id, itemId: original.id, granularity: "item" },
    );
    assert.deepEqual(
      decodeThreadArguments("zenx_threads_read", { ref: "s2" }, refs, "epoch"),
      {
        threadId: target.id,
        throughItemId: selection.content.coveredThroughItemId,
      },
    );
    const fork = await host.forkThread({
      sourceThreadId: target.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    });
    assert.deepEqual(
      compileItemList(fork.itemList!).messages,
      compileItemList(snapshot.itemList!).messages,
    );
    const forkScope = new ModelReferenceRegistry().scope(
      fork.id,
      bindings(fork.itemList!),
    );
    assert.throws(
      () => forkScope.resolve("s1", "selected-reference", "message"),
      /unavailable/,
    );
    assert.throws(
      () => forkScope.resolve("s2", "selected-reference", "history"),
      /unavailable/,
    );
    const checkpoint = "2026-10-26T23:00:00Z";
    const imported = await host.importThread(
      {
        source: {
          format: "synthetic-selected-input",
          sourceId: "external-source",
          sourceVersion: "1",
          sourceCwd: root,
          sha256: "e".repeat(64),
          exclusions: [],
          contextBasis: {
            kind: "replacement-history",
            sourceLine: 3,
            earlierRecords: 2,
          },
        },
        turns: [
          {
            createdAt: checkpoint,
            endedAt: checkpoint,
            status: "completed",
            items: [
              { type: "user_message", text: payload, createdAt: checkpoint },
              {
                type: "agent_message",
                text: "Historical only",
                createdAt: checkpoint,
              },
            ],
          },
        ],
      },
      { cwd: root },
    );
    const importedUser = imported.thread.itemList!.find(
      (item) => item.source.kind === "user_message",
    );
    assert.ok(importedUser?.kind === "message");
    assert.equal(
      importedUser.content.parts[0]?.type === "text" &&
        importedUser.content.parts[0].text,
      "[Message receipt time unavailable]",
    );
    assert.equal(
      importedUser.content.parts[1]?.type === "text" &&
        importedUser.content.parts[1].text,
      payload,
    );
    assert.deepEqual(
      bindings(imported.thread.itemList!),
      [],
      "imported envelope never mints local selected-source authority",
    );
    await host.closeHostResources();
    const count = requests;
    const cold = createHostedAppServer(options);
    try {
      const restored = await cold.readThread(target.id);
      assert.deepEqual(restored.items, snapshot.items);
      assert.deepEqual(restored.itemList, snapshot.itemList);
      assert.deepEqual(
        compileItemList(restored.itemList!).messages,
        compileItemList(snapshot.itemList!).messages,
      );
      const restoredRefs = new ModelReferenceRegistry().scope(
        target.id,
        bindings(restored.itemList!),
      );
      assert.deepEqual(
        restoredRefs.resolve("s1", "selected-reference", "message"),
        { threadId: source.id, id: original.id, cwd: root },
      );
      const restoredFork = await cold.readThread(fork.id);
      assert.deepEqual(restoredFork.itemList, fork.itemList);
      assert.deepEqual(
        (await cold.readThread(imported.thread.id)).itemList,
        imported.thread.itemList,
      );
      assert.equal(
        requests,
        count,
        "inspection and restart do not dispatch model or tool work",
      );
    } finally {
      await cold.closeHostResources();
    }
  } finally {
    globalThis.fetch = savedFetch;
    await host.closeHostResources();
    await rm(root, { recursive: true, force: true });
  }
});
