import {
  ModelReferenceRegistry,
  attachModelReferenceBindings,
  type ModelReferenceScope,
} from "./model-references.js";
import type { ToolInvocation, ToolRuntime } from "./tool.js";
import type { UserQuestionSpecification } from "./user-question.js";
import {
  ASK_USER_QUESTION_NAME,
  USER_QUESTION_PUBLICATION_KIND,
  parseUserQuestionSpecification,
} from "./user-question.js";

export interface RoomUserQuestionPublicationInput {
  roomId: string;
  origin: { threadId: string; callItemId: string };
  specification: UserQuestionSpecification;
}
export interface RoomUserQuestionPublicationReceipt {
  roomId: string;
  questionId: string;
  revision: number;
}
export type RoomUserQuestionPublisher = (
  input: RoomUserQuestionPublicationInput,
  signal: AbortSignal,
) => Promise<RoomUserQuestionPublicationReceipt>;

export class AskUserQuestionToolRuntime implements ToolRuntime {
  constructor(readonly publishRoomQuestion?: RoomUserQuestionPublisher) {
    if (publishRoomQuestion) {
      this.specification.description = this.specification.description.replace(
        "Questions are immutable: use a new call for a new request.",
        "Thread questions are immutable: use a new call for a new request. Open Room resources can be revised or withdrawn through the Room tools using their current revision.",
      );
      this.specification.description +=
        " To publish an independent Room workspace question, explicitly supply the scoped Room ref returned by the Room tools. Omit roomId to ask in this Thread. Room answers arrive as ordinary Room messages under that Room's delivery policy. Never infer a Room from membership or silently fall back to a Thread.";
      Object.assign(this.specification.inputSchema.properties, {
        roomId: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description:
            "Explicit target Room ref from a Room read (or an exact Room ID for native Host integrations). The caller must be a current member. The Room owns the question independently of the originating Thread.",
        },
      });
    }
  }
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
    const { roomId, ...specificationInput } = invocation.arguments;
    const specification = parseUserQuestionSpecification(specificationInput);
    if (roomId !== undefined) {
      if (
        typeof roomId !== "string" ||
        !roomId ||
        roomId.trim() !== roomId ||
        roomId.length > 512 ||
        /[\u0000-\u001f\u007f]/u.test(roomId)
      )
        throw new Error("Exact bounded Room ID required");
      let targetRoomId = roomId;
      let references: ModelReferenceScope | undefined;
      if (/^[rcst][1-9][0-9]*$/u.test(roomId)) {
        references = new ModelReferenceRegistry().scope(
          invocation.threadId,
          invocation.modelReferences,
        );
        const target = references.resolve(roomId, "rooms", "room");
        const targetId =
          target && typeof target === "object" && !Array.isArray(target)
            ? (target as Record<string, unknown>).id
            : undefined;
        if (
          !target ||
          typeof target !== "object" ||
          Array.isArray(target) ||
          Object.keys(target).some((key) => key !== "id") ||
          typeof targetId !== "string" ||
          !targetId ||
          targetId.trim() !== targetId ||
          targetId.length > 512 ||
          /[\u0000-\u001f\u007f]/u.test(targetId)
        )
          throw new Error(
            "Room reference has no exact current native identity",
          );
        targetRoomId = targetId;
      }
      if (!this.publishRoomQuestion)
        throw new Error(
          "Room question publication is unavailable on this Host",
        );
      const receipt = await this.publishRoomQuestion(
        {
          roomId: targetRoomId,
          origin: {
            threadId: invocation.threadId,
            callItemId: invocation.canonicalToolCallId,
          },
          specification,
        },
        invocation.signal,
      );
      // The Room service owns this receipt. It is deliberately not the native
      // Thread publication marker and never enters the Thread question index.
      const result = {
        exitCode: 0,
        output: JSON.stringify({
          kind: "zen.room-question.published",
          version: 1,
          ...receipt,
          ...(references ? { roomId } : {}),
        }),
      };
      return references
        ? attachModelReferenceBindings(result, references.newBindings)
        : result;
    }
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
