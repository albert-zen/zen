/** Synthetic real Host publication; no manually authored tool/result journal. */
import assert from "node:assert/strict";
import {
  pendingSteerMessages,
  recoverSteerRecall,
} from "../../../dist/src/steer-recall.js";
import { createHostedAppServer } from "../../../dist/apps/cli/src/host.js";

export async function seedUserQuestionAcceptance({
  data,
  workspace,
  scenario = "cards",
}) {
  const host = createHostedAppServer({
    cwd: workspace,
    dataDirectory: data,
    model: "fake",
    provider: { type: "fake" },
    approvalPolicy: "never",
    toolPresentation: "direct",
  });
  const fixture = {
    synthetic: true,
    scenario,
    publicationDefault: true,
    questions: [],
  };
  try {
    for (const [key, title, specifications] of [
      [
        "main",
        "Synthetic · Question card review",
        [
          {
            questions: [
              {
                id: "color",
                prompt: "Synthetic: which review color?",
                options: [
                  {
                    id: "blue",
                    label: "Blue",
                    description: "A calm review accent",
                  },
                  {
                    id: "green",
                    label: "Green",
                    description: "A natural review accent",
                  },
                ],
              },
            ],
            answerTemplate: "Synthetic color answer: {{color}}",
          },
          {
            questions: [
              {
                id: "note",
                prompt: "Synthetic: add a review note, or cancel this request.",
              },
            ],
            answerTemplate: "Synthetic note: {{note}}",
          },
        ],
      ],
      [
        "other",
        "Synthetic · Unknown response review",
        [
          {
            questions: [
              {
                id: "scope",
                prompt: "Synthetic: which scope should be checked?",
                options: [
                  { id: "small", label: "Small slice" },
                  { id: "all", label: "Full suite later" },
                ],
              },
            ],
            answerTemplate: "Synthetic scope: {{scope}}",
          },
        ],
      ],
    ]) {
      const thread = await host.startThread();
      fixture[key] = thread.id;
      const selected =
        scenario === "origin" ? specifications.slice(0, 1) : specifications;
      for (const specification of selected) {
        await (
          await host.startTurn(
            thread.id,
            `!tool ask_user_question ${JSON.stringify(specification)}`,
          )
        ).done;
      }
      await host.setThreadName(
        thread.id,
        scenario === "origin" ? `Synthetic · Mixed origin ${key}` : title,
      );
      const snapshot = await host.readThread(thread.id);
      assert.equal(snapshot.userQuestions.length, selected.length);
      for (const question of snapshot.userQuestions) {
        assert.equal(question.state, "open");
        assert.equal(question.request.threadId, thread.id);
        fixture.questions.push(question);
      }
    }
    return fixture;
  } finally {
    await host.closeHostResources();
  }
}

/** One cold read per synthetic owner after normal Desktop exit, never UI polling. */
export async function verifyUserQuestionAcceptance({
  data,
  workspace,
  receipts,
  origin,
}) {
  const host = createHostedAppServer({
    cwd: workspace,
    dataDirectory: data,
    model: "fake",
    provider: { type: "fake" },
    approvalPolicy: "never",
    toolPresentation: "direct",
  });
  try {
    const snapshots = new Map();
    const evidence = [];
    if (origin) {
      for (const batch of origin.batches) {
        const snapshot = await host.readThread(batch.threadId);
        snapshots.set(batch.threadId, snapshot);
        const records = snapshot.items.filter(
          (item) => item.type === "user_message_steer_recalled",
        );
        assert.equal(
          records.length,
          1,
          "exactly one durable whole-batch recall",
        );
        assert.equal(pendingSteerMessages(snapshot.items).length, 0);
        const recovered = recoverSteerRecall(
          snapshot.items,
          batch.threadId,
          batch.recall.params.recallId,
        );
        assert.ok(recovered);
        assert.equal(recovered.messages.length, 2);
        const ordinary = recovered.messages.find(
          (item) => item.clientId === batch.ordinary.params.clientUserMessageId,
        );
        assert.deepEqual(ordinary.input, batch.ordinary.params.input);
        const answer = recovered.messages.find(
          (item) => item.clientId === batch.answer.params.clientUserMessageId,
        );
        assert.deepEqual(
          answer.questionReply.answers,
          batch.answer.params.answers,
        );
        const exact = await host.readUserQuestion(
          batch.threadId,
          batch.answer.params.questionCallItemId,
          batch.answer.params.clientUserMessageId,
        );
        assert.equal(exact.response.status, "withdrawn");
        const semantic = snapshot.itemList.filter(
          (item) =>
            item.role === "user" &&
            [ordinary.clientId, answer.clientId].includes(
              item.source.metadata?.clientId,
            ),
        );
        assert.equal(
          semantic.length,
          0,
          "withdrawn drafts were not resent or model-consumed",
        );
        evidence.push({
          threadId: batch.threadId,
          recallId: records[0].recallId,
          targets: records[0].targets,
          questionResponse: exact.response.status,
          modelVisibleRecalledInputs: semantic.length,
        });
      }
      return {
        synthetic: true,
        defaultOnColdHost: true,
        boundedThreadReads: snapshots.size,
        evidence,
      };
    }
    for (const { params } of receipts) {
      if (!snapshots.has(params.threadId))
        snapshots.set(params.threadId, await host.readThread(params.threadId));
      const matches = snapshots
        .get(params.threadId)
        .itemList.filter(
          (item) =>
            item.role === "user" &&
            item.source.metadata?.clientId === params.clientUserMessageId,
        );
      assert.equal(
        matches.length,
        1,
        "one ordinary model-visible human input per explicit intent",
      );
      assert.deepEqual(matches[0].source.metadata.questionReply, {
        version: 1,
        request: {
          threadId: params.threadId,
          callItemId: params.questionCallItemId,
        },
        ...(params.outcome === "cancel"
          ? { outcome: "cancel" }
          : { outcome: "answer", answers: params.answers }),
      });
      evidence.push({
        threadId: params.threadId,
        callItemId: params.questionCallItemId,
        clientId: params.clientUserMessageId,
        outcome: params.outcome,
        ordinaryHumanInputCount: matches.length,
      });
    }
    return {
      synthetic: true,
      defaultOnColdHost: true,
      boundedThreadReads: snapshots.size,
      evidence,
    };
  } finally {
    await host.closeHostResources();
  }
}
