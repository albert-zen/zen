import type { ToolInvocation, ToolRuntime } from "./tool.js";
import {
  ASK_USER_QUESTION_NAME,
  USER_QUESTION_PUBLICATION_KIND,
  parseUserQuestionSpecification,
} from "./user-question.js";

export class AskUserQuestionToolRuntime implements ToolRuntime {
  readonly name = ASK_USER_QUESTION_NAME;
  readonly enforcesSandbox = true;
  readonly executionMode = "parallel_safe" as const;
  readonly specification = {
    name: ASK_USER_QUESTION_NAME,
    description:
      "Ask the user one or more questions with optional choices and free-text answers. This publishes a question card and returns immediately; it does not wait for an answer. Answers or explicit cancellation arrive later as ordinary user messages linked to this request. Continue independent work, or finish your turn if the next step requires the answer. Do not poll or treat defaults as user approval. Do not request secrets or use this tool instead of a permission approval flow. Questions are immutable: use a new call for a new request. You may omit answerTemplate to receive answers labelled by question ID in question order. An explicit answerTemplate must contain each question ID exactly once as {{id}}; no expressions are evaluated. Free-text answers are always supported.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["questions"],
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "prompt"],
            properties: {
              id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" },
              prompt: { type: "string", minLength: 1, maxLength: 4096 },
              multiSelect: { type: "boolean" },
              options: {
                type: "array",
                maxItems: 12,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "label"],
                  properties: {
                    id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" },
                    label: { type: "string", minLength: 1, maxLength: 256 },
                    description: {
                      type: "string",
                      minLength: 1,
                      maxLength: 1024,
                    },
                  },
                },
              },
            },
          },
        },
        answerTemplate: {
          type: "string",
          minLength: 1,
          maxLength: 4096,
          description:
            "Optional reply formatting. Include each question ID exactly once as {{id}}. If omitted, answers are labelled by question ID in authored order.",
        },
      },
    },
  };
  async execute(invocation: ToolInvocation) {
    invocation.signal.throwIfAborted();
    if (
      invocation.outputAudience === "program" ||
      !invocation.threadId ||
      !invocation.canonicalToolCallId
    )
      throw new Error("ask_user_question requires a direct native model call");
    parseUserQuestionSpecification(invocation.arguments);
    return {
      exitCode: 0,
      output: JSON.stringify({
        kind: USER_QUESTION_PUBLICATION_KIND,
        version: 1,
        request: {
          threadId: invocation.threadId,
          callItemId: invocation.canonicalToolCallId,
        },
      }),
    };
  }
}
