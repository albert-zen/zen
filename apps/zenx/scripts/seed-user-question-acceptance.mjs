/** Synthetic real Host publication; no manually authored tool/result journal. */
import assert from "node:assert/strict";
import { createHostedAppServer } from "../../../dist/apps/cli/src/host.js";

export async function seedUserQuestionAcceptance({ data, workspace }) {
  const host = createHostedAppServer({
    cwd: workspace,
    dataDirectory: data,
    model: "fake",
    provider: { type: "fake" },
    approvalPolicy: "never",
    toolPresentation: "direct",
    experimentalUserQuestions: true,
  });
  const fixture = { synthetic: true, publicationGate: true, questions: [] };
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
      for (const specification of specifications) {
        await (
          await host.startTurn(
            thread.id,
            `!tool ask_user_question ${JSON.stringify(specification)}`,
          )
        ).done;
      }
      await host.setThreadName(thread.id, title);
      const snapshot = await host.readThread(thread.id);
      assert.equal(snapshot.userQuestions.length, specifications.length);
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
      defaultOffColdHost: true,
      boundedThreadReads: snapshots.size,
      evidence,
    };
  } finally {
    await host.closeHostResources();
  }
}
