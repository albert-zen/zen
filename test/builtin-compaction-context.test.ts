import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import {
  decodeContextItem,
  compileItemList,
  type ContextItem,
} from "../src/item-list.js";
import { validateModelReferenceBindings } from "../src/model-references.js";
import { FileTraceStore } from "../src/trace.js";

for (const input of ["published-ref", "native-id"] as const)
  test(`actual Host compaction retention accepts only ${input === "published-ref" ? "persisted sample references" : "published references, not a native ID"}`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zen-builtin-compaction-"),
    );
    const original = globalThis.fetch;
    let threadId = "",
      calls = 0,
      userId = "",
      validationError: unknown;
    const items = async (): Promise<ContextItem[]> =>
      (
        await readFile(
          path.join(directory, "threads", "items", `${threadId}.jsonl`),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => decodeContextItem(JSON.parse(line)));
    globalThis.fetch = async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      try {
        if (calls !== 1)
          return new Response(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        const context = await items();
        const notice = context.findLast(
          (item) =>
            item.source.kind === "context_notice" &&
            item.source.metadata?.referenceBindings !== undefined,
        );
        assert(notice?.kind === "message");
        assert.equal(notice.role, "developer");
        const binding = validateModelReferenceBindings(
          notice.source.metadata!.referenceBindings,
        )[0]!;
        assert.equal(binding.ref, "c1");
        assert.equal(binding.ownerThreadId, threadId);
        userId = (binding.value as { itemId: string }).itemId;
        assert.match(notice.content.text, /c1 user message/);
        assert(!notice.content.text.includes(userId));
        const compiled = compileItemList(context, {
          sampleId: String(notice.source.metadata!.onlySampleId),
        });
        assert(
          request.messages.some(
            (message: { role: string; content: unknown }) =>
              message.role === "developer" &&
              message.content === notice.content.text,
          ),
        );
        assert(compiled.selectedItemIds.includes(notice.id));
        const log = await new FileTraceStore(
          path.join(directory, "trace"),
        ).read(threadId);
        assert(
          log.records.some(
            (record) =>
              record.type === "context_source" &&
              JSON.stringify(record.data).includes(notice.id),
          ),
        );
      } catch (error) {
        validationError = error;
      }
      const event =
        calls === 1
          ? {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "compact",
                        type: "function",
                        function: {
                          name: "compact_context",
                          arguments: JSON.stringify({
                            text: "Keep the exact source",
                            retention: {
                              itemIds: [
                                input === "published-ref" ? "c1" : userId,
                              ],
                            },
                            includeOriginalReference: false,
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }
          : {
              choices: [
                { index: 0, delta: { content: "done" }, finish_reason: "stop" },
              ],
            };
      return new Response(
        `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const host = createHostedAppServer({
      cwd: directory,
      dataDirectory: directory,
      model: "synthetic",
      provider: {
        type: "openai-compatible",
        baseUrl: "https://synthetic.invalid/v1",
        apiKey: "synthetic",
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
      contextCompaction: {
        agenticEnabled: true,
        triggerPercent: 99,
        targetPercent: 80,
      },
    });
    try {
      threadId = (await host.startThread()).id;
      await (
        await host.startTurn(threadId, "literal content remains unchanged")
      ).done;
      if (validationError) throw validationError;
      assert.equal(calls, 2);
      const snapshot = await host.readThread(threadId);
      const reset = snapshot.items.find(
        (item) => item.type === "context_compaction",
      );
      if (input === "published-ref") {
        assert(reset?.type === "context_compaction");
        assert(reset.retainedItemIds.includes(userId));
      } else {
        assert.equal(reset, undefined);
        const failure = snapshot.items.find(
          (item) => item.type === "tool_result",
        );
        assert(failure?.type === "tool_result");
        assert.equal(failure.exitCode, 1);
        assert.match(failure.output, /reference unavailable/);
      }
      const completed = snapshot.items.findLast(
        (item) => item.type === "turn_completed",
      );
      assert(completed?.type === "turn_completed");
      assert.equal(completed.status, "completed");
    } finally {
      globalThis.fetch = original;
      await host.closeHostResources();
      await rm(directory, { recursive: true, force: true });
    }
  });
