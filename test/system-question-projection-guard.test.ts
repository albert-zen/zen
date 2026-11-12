import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { ZenAppServer } from "../src/app-server.js";
import { DomainThreadJournal } from "../src/domain-journal.js";
import { FileTraceStore } from "../src/trace.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { AgentRuntime } from "../src/runtime.js";
import { ToolEnvironment } from "../src/tool.js";
import {
  compileItemList,
  contextItemsFromLegacy,
  type ContextItem,
} from "../src/item-list.js";
import type { ModelAdapter, ModelRequest } from "../src/model.js";

const diagnostic = /Cannot safely display user question/;

test("Host publications fail closed at compiler and cold dispatch boundaries without rewriting ordinary text", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "question-guard-"));
  const host = createHostedAppServer({
    cwd: root,
    dataDirectory: path.join(root, "host"),
    model: "fake",
    provider: { type: "fake" },
    approvalPolicy: "never",
    toolPresentation: "direct",
  });
  try {
    const thread = await host.startThread();
    await (
      await host.startTurn(
        thread.id,
        '!tool ask_user_question {"questions":[{"id":"scope","prompt":"Which scope?"}]}',
      )
    ).done;
    const publication = (await host.readThread(thread.id)).userQuestions![0]!;
    await (
      await host.respondToUserQuestion(thread.id, {
        questionCallItemId: publication.request.callItemId,
        clientId: "guard-answer",
        outcome: "answer",
        answers: [
          {
            questionId: "scope",
            optionIds: [],
            text: "literal UUID 12345678-1234-1234-1234-123456789abc",
          },
        ],
      })
    ).turn.done;
    const snapshot = await host.readThread(thread.id);
    const originalReply = snapshot.itemList!.find(
      (item) => item.source.metadata?.questionReply !== undefined,
    )!;
    assert.ok(originalReply.kind === "message");
    const image = {
      type: "image" as const,
      attachment: {
        type: "attachment" as const,
        sha256: "a".repeat(64),
        mediaType: "image/png" as const,
        byteLength: 68,
        width: 1,
        height: 1,
      },
    };

    const originalCall = snapshot.itemList!.find(
      (item) => item.id === publication.request.callItemId,
    )!;
    const originalReceipt = snapshot.itemList!.find(
      (item) => item.id === publication.resultItemId,
    )!;
    assert.ok(
      originalCall.kind === "tool_call" &&
        originalReceipt.kind === "tool_result",
    );
    const originalBody = originalReceipt.content.text.slice(
      Number(originalReceipt.source.metadata!.bodyStart),
    );
    const variants: [string, (items: ContextItem[]) => ContextItem[]][] = [
      [
        "missing-call",
        (items) => items.filter((item) => item.id !== originalCall.id),
      ],
      [
        "duplicate-ask",
        (items) => [
          ...items,
          { ...structuredClone(originalCall), id: "duplicate-ask" },
        ],
      ],
      [
        "mixed-ask-and-nonask",
        (items) => [
          ...items,
          {
            ...structuredClone(originalCall),
            id: "duplicate-other",
            content: { ...originalCall.content, name: "unrelated_tool" },
          },
        ],
      ],
      ...([undefined, -1, 0, 1, 999999] as const).map(
        (offset): [string, (items: ContextItem[]) => ContextItem[]] => [
          `bodyStart-${String(offset)}`,
          (items) => {
            const receipt = items.find(
              (item) => item.id === originalReceipt.id,
            )!;
            if (offset === undefined) delete receipt.source.metadata!.bodyStart;
            else receipt.source.metadata!.bodyStart = offset;
            return items;
          },
        ],
      ),
    ];
    variants.push([
      "duplicate-question-origin",
      (items) => {
        const call = structuredClone(originalCall);
        call.id = "other-inherited-call";
        call.content.callId = "other-provider-call";
        call.source.metadata = {
          ...call.source.metadata,
          questionOrigin: { ...publication.request },
        };
        const receipt: Extract<ContextItem, { kind: "tool_result" }> =
          structuredClone(originalReceipt);
        receipt.id = "other-inherited-result";
        receipt.content.callId = call.content.callId;
        return [...items, call, receipt];
      },
    ]);
    for (const offset of [undefined, -1, 0, 999999] as const)
      variants.push([
        `reply-bodyStart-${String(offset)}`,
        (items) => {
          const reply = items.find((item) => item.id === originalReply.id)!;
          if (offset === undefined) delete reply.source.metadata!.bodyStart;
          else reply.source.metadata!.bodyStart = offset;
          return items;
        },
      ]);
    variants.push([
      "reply-with-image",
      (items) => {
        const reply = items.find((item) => item.id === originalReply.id)!;
        assert.ok(reply.kind === "message");
        reply.content.parts = [...reply.content.parts, image];
        return items;
      },
    ]);
    variants.push([
      "reply-with-skillSource",
      (items) => {
        const reply = items.find((item) => item.id === originalReply.id)!;
        assert.ok(reply.kind === "message");
        reply.content.parts = reply.content.parts.map((part, index) =>
          index === Number(reply.source.metadata!.bodyStart) &&
          part.type === "text"
            ? {
                ...part,
                skillSource: { kind: "catalog", sha256: "b".repeat(64) },
              }
            : part,
        );
        return items;
      },
    ]);
    for (const [name, body, prefix] of [
      ["crlf-native-prefix", originalBody, "Exit code: 0\r\n"],
      ["custom-native-prefix", originalBody, "Observed result:\n"],
      ["native-json-suffix", originalBody + " trailing", "Exit code: 0\n"],
      [
        "native-unparseable-success",
        "unparseable publication",
        "Exit code: 0\n",
      ],
    ])
      variants.push([
        name!,
        (items) => {
          const receipt = items.find((item) => item.id === originalReceipt.id)!;
          assert.ok(receipt.kind === "tool_result");
          receipt.content.text = prefix! + body!;
          receipt.source.metadata!.bodyStart = prefix!.length;
          return items;
        },
      ]);
    const cancelThread = await host.startThread();
    await (
      await host.startTurn(
        cancelThread.id,
        '!tool ask_user_question {"questions":[{"id":"scope","prompt":"Which?"}]}',
      )
    ).done;
    const cancelPublication = (await host.listUserQuestions(cancelThread.id))
      .questions[0]!;
    await (
      await host.respondToUserQuestion(cancelThread.id, {
        questionCallItemId: cancelPublication.request.callItemId,
        clientId: "orphan-cancel",
        outcome: "cancel",
      })
    ).turn.done;
    const cancelSnapshot = await host.readThread(cancelThread.id);
    const cancelReply = cancelSnapshot.itemList!.find(
      (item) => item.source.metadata?.questionReply !== undefined,
    )!;
    assert.ok(cancelReply.kind === "message");
    const orphanItems = cancelSnapshot.itemList!.filter(
      (item) => item.kind !== "tool_call" && item.kind !== "tool_result",
    );
    variants.push([
      "orphan-exact-cancel",
      () => structuredClone(orphanItems) as ContextItem[],
    ]);
    for (const [name, mutate] of variants) {
      const baseSnapshot =
        name === "orphan-exact-cancel" ? cancelSnapshot : snapshot;
      const testThreadId = baseSnapshot.id;
      const facts =
        name === "orphan-exact-cancel"
          ? baseSnapshot.items.filter(
              (item) =>
                item.type !== "tool_call" && item.type !== "tool_result",
            )
          : baseSnapshot.items;
      const items = mutate(
        structuredClone(baseSnapshot.itemList!) as ContextItem[],
      );
      await t.test(`${name}: standalone compiler`, () => {
        const exact = structuredClone(items);
        let error: unknown;
        try {
          compileItemList(items);
        } catch (caught) {
          error = caught;
        }
        assert.deepEqual(
          items,
          exact,
          "even rejected projection cannot mutate input",
        );
        assert.match(
          String(error),
          diagnostic,
          "recognizable native receipt must be rejected, not exposed or ambiguously numbered",
        );
      });
      await t.test(
        `${name}: cold journal and actual ModelAdapter boundary`,
        async () => {
          const directory = path.join(root, name);
          const metadata = new InMemoryThreadMetadataStore();
          const trace = new FileTraceStore(path.join(directory, "trace"));
          const journalOptions = {
            directory: path.join(directory, "threads"),
            trace,
            metadata,
          };
          const writer = new DomainThreadJournal(journalOptions);
          await writer.create(facts, items);
          await writer.close();
          const journal = new DomainThreadJournal(journalOptions);
          const requests: ModelRequest[] = [];
          const model: ModelAdapter = {
            provider: "fake",
            async *stream(request) {
              requests.push(request);
              yield { type: "text_delta", delta: "boundary reached" };
            },
          };
          const server = new ZenAppServer({
            journal,
            threadMetadata: metadata,
            runtime: new AgentRuntime({
              toolEnvironment: new ToolEnvironment({ runtimes: [] }),
            }),
            providerRegistry: new ProviderRegistry([
              {
                providerProfileId: baseSnapshot.providerProfileId,
                adapter: model,
                modelCatalog: new StaticModelCatalog([
                  {
                    id: baseSnapshot.modelId,
                    isDefault: true,
                    contextWindow: 32768,
                  },
                ]),
              },
            ]),
            defaults: {
              cwd: root,
              providerProfileId: baseSnapshot.providerProfileId,
              modelId: baseSnapshot.modelId,
              reasoningEffort: "medium",
              sandbox: "read-only",
              approvalPolicy: "never",
            },
          });
          try {
            const replay = await journal.readItemList(testThreadId);
            if (name === "missing-call") {
              assert.ok(
                replay.some((item) => item.id === originalCall.id),
                "DomainJournal legitimately repairs a missing semantic call from original canonical facts",
              );
              assert.deepEqual(
                replay.filter((item) => item.id !== originalCall.id),
                items,
              );
            } else assert.deepEqual(replay, items);
            const traceBefore = await trace.read(testThreadId);
            let compileError: unknown;
            try {
              compileItemList(replay);
            } catch (caught) {
              compileError = caught;
            }
            assert.deepEqual(
              await journal.readItemList(testThreadId),
              replay,
              "compiler never rewrites committed ItemList",
            );
            assert.deepEqual(
              await trace.read(testThreadId),
              traceBefore,
              "compiler never rewrites Trace",
            );
            let dispatchError: unknown;
            try {
              await (
                await server.startTurn(testThreadId, "Continue safely")
              ).done;
            } catch (caught) {
              dispatchError = caught;
            }
            assert.deepEqual(
              (await journal.readItemList(testThreadId)).slice(
                0,
                replay.length,
              ),
              replay,
              "dispatch cannot rewrite original semantic facts",
            );
            assert.deepEqual(
              (await trace.read(testThreadId)).records.slice(
                0,
                traceBefore.records.length,
              ),
              traceBefore.records,
              "dispatch cannot rewrite original observed Trace",
            );
            if (name === "missing-call") {
              assert.equal(compileError, undefined);
              assert.equal(dispatchError, undefined);
              assert.ok(
                requests.length > 0,
                "repaired publication remains usable",
              );
              const tools = requests
                .flatMap((request) => request.messages)
                .filter((message) => message.role === "tool");
              assert.ok(JSON.stringify(tools).includes("Q1"));
              assert.ok(
                !JSON.stringify(tools).includes("zen.user-question.published"),
              );
            } else {
              assert.equal(
                requests.length,
                0,
                "ambiguous or malformed persisted native receipt must stop before adapter.stream",
              );
              assert.match(String(compileError), diagnostic);
            }
          } finally {
            await server.closeRuntimeConfiguration();
            await journal.close();
          }
        },
      );
    }
    await t.test(
      "orphan cancellation text requires exact native provenance; unknown answers stay literal",
      () => {
        for (const mode of ["wrong-request", "no-provenance"] as const) {
          const items = structuredClone(orphanItems);
          const reply = items.find((item) => item.id === cancelReply.id)!;
          assert.ok(reply.kind === "message");
          if (mode === "no-provenance")
            delete reply.source.metadata!.questionReply;
          else {
            const provenance = reply.source.metadata!.questionReply as {
              request: { callItemId: string };
            };
            provenance.request.callItemId = "unrelated-request";
          }
          const before = structuredClone(items);
          const users = compileItemList(items).messages.filter(
            (message) => message.role === "user",
          );
          assert.ok(
            users.some(
              (message) =>
                "content" in message &&
                JSON.stringify(message.content) ===
                  JSON.stringify(reply.content.parts),
            ),
            mode,
          );
          assert.deepEqual(items, before);
        }
        const unknownAnswer = snapshot.itemList!.filter(
          (item) => item.kind !== "tool_call" && item.kind !== "tool_result",
        );
        const users = compileItemList(unknownAnswer).messages.filter(
          (message) => message.role === "user",
        );
        assert.ok(
          users.some(
            (message) =>
              "content" in message &&
              JSON.stringify(message.content) ===
                JSON.stringify(originalReply.content.parts),
          ),
          "unknown specification cannot justify guessing an answer body",
        );
      },
    );
    await t.test(
      "failed and denied Ask error text remains model-visible",
      () => {
        for (const status of ["failed", "denied"] as const) {
          const receipt: Extract<ContextItem, { kind: "tool_result" }> =
            structuredClone(originalReceipt);
          receipt.content.exitCode = 1;
          receipt.source.metadata!.executionStatus = status;
          receipt.content.text = `Exit code: 1\nAsk ${status}: publication did not happen`;
          receipt.source.metadata!.bodyStart = "Exit code: 1\n".length;
          const items: ContextItem[] = [originalCall, receipt];
          const before = structuredClone(items);
          assert.deepEqual(
            compileItemList(items)
              .messages.filter((message) => message.role === "tool")
              .map((message) => message.text),
            [receipt.content.text],
          );
          assert.deepEqual(items, before);
        }
      },
    );

    await t.test(
      "user prose, UUIDs and full JSON publication text stay literal",
      () => {
        const text = `Literal ${publication.request.callItemId} and Q42.\n${originalBody}`;
        const user = contextItemsFromLegacy(
          {
            id: "literal-user",
            threadId: thread.id,
            turnId: "literal-turn",
            createdAt: originalCall.createdAt,
            type: "user_message",
            text,
          },
          [],
          999,
        )[0]!;
        const items = [...snapshot.itemList!, user];
        const before = structuredClone(items);
        const userMessages = compileItemList(items).messages.filter(
          (message) => message.role === "user",
        );
        assert.ok(
          JSON.stringify(userMessages).includes(
            JSON.stringify(text).slice(1, -1),
          ),
        );
        assert.deepEqual(items, before);
      },
    );
    await t.test(
      "ordinary user images and annotated text are not projected",
      () => {
        const user = structuredClone(originalReply);
        delete user.source.metadata!.questionReply;
        user.content.parts = [
          ...user.content.parts.map((part) =>
            part.type === "text"
              ? {
                  ...part,
                  skillSource: {
                    kind: "catalog" as const,
                    sha256: "b".repeat(64),
                  },
                }
              : part,
          ),
          image,
        ];
        const items = [
          ...snapshot.itemList!.filter((item) => item.id !== originalReply.id),
          user,
        ];
        const before = structuredClone(items);
        const messages = compileItemList(items).messages.filter(
          (message) => message.role === "user",
        );
        assert.ok(
          messages.some(
            (message) =>
              "content" in message &&
              JSON.stringify(message.content) ===
                JSON.stringify(user.content.parts),
          ),
        );
        assert.deepEqual(items, before);
      },
    );
    await t.test(
      "uniquely paired non-Ask tool returning identical JSON stays literal",
      () => {
        const call = {
          ...structuredClone(originalCall),
          content: { ...originalCall.content, name: "unrelated_tool" },
        };
        const items = [call, structuredClone(originalReceipt)];
        const before = structuredClone(items);
        const tools = compileItemList(items).messages.filter(
          (message) => message.role === "tool",
        );
        assert.deepEqual(
          tools.map((message) => message.text),
          [originalReceipt.content.text],
        );
        assert.deepEqual(items, before);
      },
    );
    await t.test(
      "Room publication remains literal and reserves no native Q number",
      () => {
        const call = structuredClone(originalCall);
        call.content.arguments.roomId = "r1";
        const receipt: Extract<ContextItem, { kind: "tool_result" }> =
          structuredClone(originalReceipt);
        const body = JSON.stringify({
          kind: "zen.room-question.published",
          version: 1,
          roomId: "r1",
          questionId: "room-question",
          revision: 1,
        });
        receipt.content.text =
          receipt.content.text.slice(
            0,
            Number(receipt.source.metadata!.bodyStart),
          ) + body;
        const items = [call, receipt];
        const before = structuredClone(items);
        const tools = compileItemList(items).messages.filter(
          (message) => message.role === "tool",
        );
        assert.deepEqual(
          tools.map((message) => message.text),
          [receipt.content.text],
        );
        assert.deepEqual(items, before);
      },
    );
  } finally {
    await host.closeHostResources();
    await rm(root, { recursive: true, force: true });
  }
});
