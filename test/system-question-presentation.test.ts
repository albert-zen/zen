import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { FakeModel, type ModelRequest } from "../src/model.js";
import { textFromUserInput } from "../src/item.js";

const specification = { questions: [{ id: "scope", prompt: "Which scope?" }] };
const command = `!tool ask_user_question ${JSON.stringify(specification)}`;
function userText(request: ModelRequest): string {
  return request.messages
    .flatMap((message) =>
      message.role === "user"
        ? [
            "content" in message
              ? textFromUserInput(message.content)
              : message.text,
          ]
        : [],
    )
    .join("\n");
}

test("production Host Ask entry points preserve numbered receipts across direct, code and default both", async (t) => {
  for (const presentation of ["direct", "code", undefined] as const) {
    await t.test(
      presentation ?? "default both (option omitted)",
      async (subtest) => {
        const root = await mkdtemp(
          path.join(os.tmpdir(), "question-presentation-"),
        );
        const requests: ModelRequest[] = [];
        const stream = FakeModel.prototype.stream;
        FakeModel.prototype.stream = async function* (request) {
          requests.push(request);
          yield* stream.call(this, request);
        };
        subtest.after(() => {
          FakeModel.prototype.stream = stream;
        });
        const host = createHostedAppServer({
          // The production worker is JavaScript. Source-TS runs use the existing
          // compiled worker while Host admission and projection run live source.
          codeRuntimeOptions: {
            workerUrl: new URL(
              import.meta.url.endsWith(".ts")
                ? "../dist/src/code-runtime-worker.js"
                : "../src/code-runtime-worker.js",
              import.meta.url,
            ),
          },
          cwd: root,
          dataDirectory: root,
          model: "fake",
          provider: { type: "fake" },
          approvalPolicy: "never",
          ...(presentation === undefined
            ? {}
            : { toolPresentation: presentation }),
        });
        try {
          for (const outcome of ["answer", "cancel"] as const) {
            const thread = await host.startThread();
            const start = requests.length;
            await (
              await host.startTurn(thread.id, command)
            ).done;
            const published = await host.readThread(thread.id);
            const question = published.userQuestions![0]!;
            assert.ok(
              question,
              "actual invocation must publish, not merely expose schema",
            );
            const call = published.itemList!.find(
              (item) => item.id === question.request.callItemId,
            )!;
            assert.ok(call.kind === "tool_call");
            assert.equal(call.content.name, "ask_user_question");
            assert.equal(call.source.kind, "tool_call");
            const canonical = published.items.find(
              (item) => item.id === call.id,
            )!;
            assert.ok(canonical.type === "tool_call");
            assert.equal(canonical.name, "ask_user_question");
            assert.equal(
              canonical.parentCallId,
              undefined,
              "code presentation still admits Ask as a direct native call",
            );
            const afterPublication = requests
              .slice(start)
              .find((request) =>
                request.messages.some(
                  (message) =>
                    message.role === "tool" &&
                    message.callId === call.content.callId,
                ),
              );
            assert.ok(
              afterPublication,
              "inspect the actual subsequent ModelRequest",
            );
            const receipt = afterPublication.messages.find(
              (message) =>
                message.role === "tool" &&
                message.callId === call.content.callId,
            )!;
            assert.ok(receipt.role === "tool");
            assert.equal(
              receipt.text,
              'Exit code: 0\n{"questions":[{"id":"Q1","key":"scope"}]}',
            );
            assert.ok(!receipt.text.includes(question.request.callItemId));
            assert.ok(!receipt.text.includes(thread.id));
            assert.ok(!receipt.text.includes("zen.user-question.published"));
            const responseStart = requests.length;
            const response =
              outcome === "answer"
                ? {
                    outcome,
                    answers: [
                      {
                        questionId: "scope",
                        optionIds: [],
                        text: "Literal q99 and Q42",
                      },
                    ],
                  }
                : { outcome };
            await (
              await host.respondToUserQuestion(thread.id, {
                questionCallItemId: question.request.callItemId,
                clientId: `${presentation ?? "both"}-${outcome}`,
                ...response,
              })
            ).turn.done;
            const responseRequest = requests[responseStart]!;
            assert.ok(responseRequest);
            const expected =
              outcome === "answer"
                ? "Reply to Q1:\nLiteral q99 and Q42"
                : "I chose not to answer Q1.";
            assert.ok(userText(responseRequest).includes(expected));
            assert.ok(
              !userText(responseRequest).includes(question.request.callItemId),
            );
            assert.ok(!userText(responseRequest).includes(thread.id));
          }
          const failedThread = await host.startThread();
          const failedStart = requests.length;
          await (
            await host.startTurn(
              failedThread.id,
              '!tool ask_user_question {"questions":[]}',
            )
          ).done;
          const failed = await host.readThread(failedThread.id);
          assert.deepEqual(failed.userQuestions, []);
          const failedReceipt = failed.itemList!.find(
            (item) => item.kind === "tool_result",
          );
          assert.ok(failedReceipt?.kind === "tool_result");
          assert.notEqual(failedReceipt.content.exitCode, 0);
          assert.ok(
            requests
              .slice(failedStart)
              .some((request) =>
                request.messages.some(
                  (message) =>
                    message.role === "tool" &&
                    message.text === failedReceipt.content.text,
                ),
              ),
            "ordinary failed Ask text reaches the actual model unchanged",
          );
          if (presentation !== "direct") {
            const nestedThread = await host.startThread();
            const nestedStart = requests.length;
            await (
              await host.startTurn(
                nestedThread.id,
                `!tool run_code ${JSON.stringify({ code: `const result = await tools.ask_user_question(${JSON.stringify(specification)}); text(result);` })}`,
              )
            ).done;
            const nested = await host.readThread(nestedThread.id);
            const calls = nested.items.filter(
              (item) => item.type === "tool_call",
            );
            assert.ok(
              calls.some((item) => item.name === "run_code"),
              "run_code must actually execute, not fail fake-model schema lookup",
            );
            assert.deepEqual(nested.userQuestions, []);
            const receipts = nested.itemList!.filter(
              (item) => item.kind === "tool_result",
            );
            assert.ok(receipts.length > 0);
            assert.ok(
              receipts.every(
                (item) =>
                  !item.content.text.includes("zen.user-question.published"),
              ),
            );
            const toolMessages = requests
              .slice(nestedStart)
              .flatMap((request) => request.messages)
              .filter((message) => message.role === "tool");
            assert.ok(
              toolMessages.length > 0,
              "nested refusal remains visible to the next actual model request",
            );
            assert.ok(
              toolMessages.every(
                (message) =>
                  !message.text.includes("zen.user-question.published"),
              ),
            );
            assert.ok(
              toolMessages.some((message) =>
                /ask_user_question.*(direct native|not a function|not available|not exposed|unknown)|(?:unknown|not available).*ask_user_question/i.test(
                  message.text,
                ),
              ),
              "refusal must concern attempted Ask helper, not unrelated worker startup failure",
            );
          }
        } finally {
          await host.closeHostResources();
          FakeModel.prototype.stream = stream;
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }
});
