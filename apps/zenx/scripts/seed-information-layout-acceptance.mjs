/** Real Host publishes a default-on asynchronous question, then shuts down. */
import assert from "node:assert/strict";
import { createHostedAppServer } from "../../../dist/apps/cli/src/host.js";
export async function seedInformationLayoutQuestion({ data, workspace }) {
  const host = createHostedAppServer({
    cwd: workspace,
    dataDirectory: data,
    model: "fake",
    provider: { type: "fake" },
    approvalPolicy: "never",
    toolPresentation: "direct",
  });
  try {
    const questions = {};
    for (const threadId of ["information-main", "information-other"]) {
      const turn = await host.startTurn(
        threadId,
        `!tool ask_user_question ${JSON.stringify({
          questions: [
            {
              id: "review",
              prompt: `Synthetic ${threadId} review: answer whenever convenient.`,
              options: [
                { id: "focused", label: "Focused checks" },
                { id: "later", label: "Full suite later" },
              ],
            },
          ],
          answerTemplate: "Synthetic information answer: {{review}}",
        })}`,
      );
      await turn.done;
      const snapshot = await host.readThread(threadId);
      const question = snapshot.userQuestions?.find(
        (entry) => entry.state === "open",
      );
      assert.ok(
        question,
        "default-on async question remains open after its Turn completes",
      );
      questions[threadId] = question;
    }
    return {
      synthetic: true,
      publishedByRealHost: true,
      hostClosedBeforeDesktop: true,
      question: questions["information-main"],
      questions,
    };
  } finally {
    await host.closeHostResources();
  }
}
