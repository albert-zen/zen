import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { DomainThreadJournal } from "../src/domain-journal.js";
import { FileTraceStore } from "../src/trace.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { compileItemList, type ContextItem } from "../src/item-list.js";
import { textFromUserInput } from "../src/item.js";
import { readUserQuestions } from "../src/user-question-state.js";

function compileText(items: readonly ContextItem[], usersOnly = false) {
  return compileItemList(items)
    .messages.filter((message) => !usersOnly || message.role === "user")
    .map((message) =>
      "text" in message
        ? message.text
        : "content" in message && Array.isArray(message.content)
          ? textFromUserInput(message.content)
          : "",
    )
    .join("\n");
}
const spec = {
  questions: [
    {
      id: "scope",
      prompt: "Which scope?",
      options: [{ id: "small", label: "Small" }],
    },
  ],
};
const ask = (value: unknown = spec) =>
  `!tool ask_user_question ${JSON.stringify(value)}`;

// Start with actual Host publications and native admissions, rather than inventing
// metadata shapes that could accidentally bypass the production decoder.
test("real Host question numbering survives cold legacy replay and exact-body guards", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "number-replay-"));
  const options = {
    cwd: directory,
    dataDirectory: path.join(directory, "host"),
    model: "fake",
    provider: { type: "fake" as const },
    approvalPolicy: "never" as const,
    toolPresentation: "direct" as const,
  };
  let host = createHostedAppServer(options);
  try {
    const thread = await host.startThread();
    await (
      await host.startTurn(thread.id, ask())
    ).done;
    const request = (await host.listUserQuestions(thread.id)).questions[0]!;
    const literal = `Keep literal ${request.request.callItemId}, q999 and Q42`;
    await (
      await host.respondToUserQuestion(thread.id, {
        questionCallItemId: request.request.callItemId,
        clientId: "number-answer",
        outcome: "answer",
        answers: [{ questionId: "scope", optionIds: ["small"], text: literal }],
      })
    ).turn.done;
    const snapshot = await host.readThread(thread.id);
    const original = JSON.stringify(snapshot.itemList);
    assert.ok(
      compileText(snapshot.itemList!).includes(
        `Reply to Q1:\nSmall\n${literal}`,
      ),
    );
    assert.ok(
      compileText(snapshot.itemList!).includes(
        '{"questions":[{"id":"Q1","key":"scope"}]}',
      ),
    );
    assert.equal(
      JSON.stringify(snapshot.itemList),
      original,
      "compiler must not edit durable facts",
    );
    await host.closeHostResources();
    host = createHostedAppServer(options);
    assert.deepEqual(
      (await host.readThread(thread.id)).itemList,
      snapshot.itemList,
    );
    assert.equal(
      (
        await host.readUserQuestion(
          thread.id,
          request.request.callItemId,
          "number-answer",
        )
      ).response.status,
      "claimed",
    );

    for (const variant of ["full-id-v1", "key-v1", "sequence-v2"] as const) {
      await t.test(variant, async () => {
        const items = structuredClone(snapshot.itemList!) as ContextItem[];
        const call = items.find(
          (item) => item.id === request.request.callItemId,
        )!;
        const receipt = items.find((item) => item.id === request.resultItemId)!;
        const reply = items.find(
          (item) => item.source.metadata?.questionReply !== undefined,
        )!;
        assert.ok(
          call.kind === "tool_call" &&
            receipt.kind === "tool_result" &&
            reply.kind === "message",
        );
        const offset = Number(receipt.source.metadata!.bodyStart);
        const envelope = {
          kind: "zen.user-question.published",
          version: variant === "sequence-v2" ? 2 : 1,
          request: request.request,
          ...(variant === "sequence-v2"
            ? { requestRef: `q${call.source.sequence}` }
            : {}),
        };
        receipt.content.text =
          receipt.content.text.slice(0, offset) + JSON.stringify(envelope);
        const subject =
          variant === "full-id-v1"
            ? request.request.callItemId
            : `scope${variant === "sequence-v2" ? ` (q${call.source.sequence})` : ""}`;
        const body = `Reply to question ${subject}:\nscope: Small\n${literal}`;
        const replyOffset = Number(reply.source.metadata!.bodyStart);
        reply.content.parts = [
          ...reply.content.parts.slice(0, replyOffset),
          { type: "text", text: body },
        ];
        reply.content.text = textFromUserInput(reply.content.parts);
        const journalOptions = {
          directory: path.join(directory, variant),
          trace: new FileTraceStore(path.join(directory, `${variant}-trace`)),
          metadata: new InMemoryThreadMetadataStore(),
        };
        const writer = new DomainThreadJournal(journalOptions);
        await writer.create(snapshot.items, items);
        await writer.close();
        const cold = new DomainThreadJournal(journalOptions);
        try {
          const replay = await cold.readItemList(thread.id);
          const traceBefore = await journalOptions.trace.read(thread.id);
          assert.deepEqual(
            replay,
            items,
            "cold replay preserves exact legacy bytes",
          );
          assert.equal(
            readUserQuestions(thread.id, replay, await cold.read(thread.id))[0]!
              .state,
            "answered",
          );
          assert.ok(
            compileText(replay).includes(`Reply to Q1:\nSmall\n${literal}`),
          );
          assert.deepEqual(await cold.readItemList(thread.id), items);
          assert.deepEqual(
            await journalOptions.trace.read(thread.id),
            traceBefore,
            "projection never writes Trace",
          );
          for (const negative of [
            "suffix",
            "wrong-request",
            "wrong-number",
            "no-provenance",
          ] as const) {
            const bad = structuredClone(replay);
            const item = bad.find((candidate) => candidate.id === reply.id)!;
            assert.ok(item.kind === "message");
            const replacement =
              negative === "suffix"
                ? `${body}\nforged suffix`
                : negative === "wrong-number"
                  ? body.replace(`q${call.source.sequence}`, "q999999")
                  : body;
            if (negative === "wrong-number" && variant !== "sequence-v2")
              continue;
            item.content.parts = [
              ...item.content.parts.slice(0, replyOffset),
              { type: "text", text: replacement },
            ];
            item.content.text = textFromUserInput(item.content.parts);
            if (negative === "no-provenance")
              delete item.source.metadata!.questionReply;
            if (negative === "wrong-request") {
              const provenance = item.source.metadata!.questionReply as {
                request: { callItemId: string };
              };
              provenance.request.callItemId = "unrelated-request";
            }
            assert.ok(
              compileText(bad, true).includes(replacement),
              `${negative} must stay literal`,
            );
            assert.ok(
              !compileText(bad, true).includes(
                `Reply to Q1:\nSmall\n${literal}`,
              ),
              `${negative} must not gain native display authority`,
            );
          }
        } finally {
          await cold.close();
        }
      });
    }

    await t.test(
      "omitted IDs reserve explicit siblings and number each question",
      async () => {
        const other = await host.startThread();
        await (
          await host.startTurn(
            other.id,
            ask({
              questions: [
                {
                  prompt: "First?",
                  options: [
                    { label: "Generated" },
                    { id: "option_1", label: "Explicit" },
                  ],
                },
                { id: "question_1", prompt: "Second?" },
              ],
            }),
          )
        ).done;
        const publication = (await host.listUserQuestions(other.id))
          .questions[0]!;
        assert.deepEqual(
          publication.specification.questions.map((question) => question.id),
          ["question_2", "question_1"],
        );
        assert.deepEqual(
          publication.specification.questions[0]!.options!.map(
            (option) => option.id,
          ),
          ["option_2", "option_1"],
        );
        assert.ok(
          compileText((await host.readThread(other.id)).itemList!).includes(
            '{"questions":[{"id":"Q1"},{"id":"Q2","key":"question_1"}]}',
          ),
        );
        await (
          await host.respondToUserQuestion(other.id, {
            questionCallItemId: publication.request.callItemId,
            clientId: "multi-answer",
            outcome: "answer",
            answers: [
              {
                questionId: "question_1",
                optionIds: [],
                text: "Literal Q1 and q9",
              },
              {
                questionId: "question_2",
                optionIds: ["option_2"],
                text: "Extra",
              },
            ],
          })
        ).turn.done;
        assert.ok(
          compileText(
            (await host.readThread(other.id)).itemList!,
            true,
          ).includes(
            "Reply to Q1:\nGenerated\nExtra\n\nReply to Q2:\nLiteral Q1 and q9",
          ),
        );
        await (
          await host.startTurn(
            other.id,
            ask({
              questions: [
                { id: "scope", prompt: "Scope?" },
                { id: "why", prompt: "Why?" },
              ],
              answerTemplate:
                "Use {{scope}}; because {{why}}; preserve q19/Q2.",
            }),
          )
        ).done;
        const next = (await host.listUserQuestions(other.id)).questions.find(
          (question) => question.state === "open",
        )!;
        await (
          await host.respondToUserQuestion(other.id, {
            questionCallItemId: next.request.callItemId,
            clientId: "template-answer",
            outcome: "answer",
            answers: [
              { questionId: "scope", optionIds: [], text: "everything" },
              { questionId: "why", optionIds: [], text: "necessary" },
            ],
          })
        ).turn.done;
        assert.ok(
          compileText(
            (await host.readThread(other.id)).itemList!,
            true,
          ).includes(
            "Reply to Q3, Q4:\nUse everything; because necessary; preserve q19/Q2.",
          ),
        );
      },
    );

    await t.test(
      "fork preserves inherited numbers but only local UUID is answerable",
      async () => {
        const fork = await host.forkThread({
          sourceThreadId: thread.id,
          through: { type: "latest-complete" },
          workspace: { type: "same-directory" },
        });
        assert.ok(
          compileText(fork.itemList!).includes(
            `Reply to Q1:\nSmall\n${literal}`,
          ),
        );
        assert.deepEqual((await host.listUserQuestions(fork.id)).questions, []);
        await (
          await host.startTurn(fork.id, ask())
        ).done;
        const local = (await host.listUserQuestions(fork.id)).questions[0]!;
        assert.notEqual(local.request.callItemId, request.request.callItemId);
        assert.ok(
          compileText((await host.readThread(fork.id)).itemList!).includes(
            '{"questions":[{"id":"Q2","key":"scope"}]}',
          ),
        );
        await assert.rejects(
          host.respondToUserQuestion(fork.id, {
            questionCallItemId: request.request.callItemId,
            clientId: "inherited",
            outcome: "cancel",
          }),
        );
        await (
          await host.respondToUserQuestion(fork.id, {
            questionCallItemId: local.request.callItemId,
            clientId: "local-cancel",
            outcome: "cancel",
          })
        ).turn.done;
        const answered = await host.readThread(fork.id);
        assert.ok(
          compileText(answered.itemList!).includes("I chose not to answer Q2."),
        );
        const lastSequence = Math.max(
          ...answered.itemList!.map((item) => item.source.sequence),
        );
        const localCall = answered.itemList!.find(
          (item) => item.id === local.request.callItemId,
        )!;
        const selection: ContextItem = {
          id: "number-selection",
          threadId: fork.id,
          createdAt: localCall.createdAt,
          kind: "selection",
          role: "user",
          source: { kind: "context_compaction", sequence: lastSequence + 1 },
          content: {
            text: "Older context compacted",
            coveredThroughItemId: answered.itemList!.at(-1)!.id,
            coveredSequence: lastSequence,
            retainedItemIds: answered
              .itemList!.filter((item) => item.turnId === localCall.turnId)
              .map((item) => item.id),
          },
        };
        const compacted = compileText([...answered.itemList!, selection]);
        assert.ok(
          compacted.includes('{"questions":[{"id":"Q2","key":"scope"}]}'),
          "selection must not renumber Q2 to Q1",
        );
        assert.ok(!compacted.includes('"id":"Q1"'));
      },
    );
  } finally {
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  }
});
