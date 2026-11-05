import type { CanonicalItem } from "../../../../../src/item.js";
import {
  ASK_USER_QUESTION_NAME,
  matchesUserQuestionReplyBody,
  normalizeUserQuestionReply,
  parseUserQuestionReply,
  parseUserQuestionSpecification,
  type UserQuestion,
} from "../../../../../src/user-question.js";

export interface AnsweredQuestionPresentation {
  questions?: readonly {
    question: UserQuestion;
    selectedLabels: readonly string[];
    selectedOptionIds: readonly string[];
    text?: string;
  }[];
  /** Keep recorded text when the original question cannot safely explain it. */
  fallbackText?: string;
}

/** Exact native reply identity selects original authored content, never text guesses. */
export function indexAnsweredQuestions(
  items: readonly CanonicalItem[],
): ReadonlyMap<string, AnsweredQuestionPresentation> {
  const calls = new Map<
    string,
    Extract<CanonicalItem, { type: "tool_call" }>[]
  >();
  const key = (threadId: string, id: string) => JSON.stringify([threadId, id]);
  for (const item of items) {
    if (item.type !== "tool_call" || item.name !== ASK_USER_QUESTION_NAME)
      continue;
    const identity = key(item.threadId, item.id);
    calls.set(identity, [...(calls.get(identity) ?? []), item]);
  }
  const result = new Map<string, AnsweredQuestionPresentation>();
  for (const item of items) {
    if (item.type !== "user_message" || item.questionReply === undefined)
      continue;
    try {
      const reply = parseUserQuestionReply(item.questionReply);
      if (
        reply.outcome !== "answer" ||
        reply.request.threadId !== item.threadId
      )
        continue;
      const body =
        item.text ??
        item.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
      const prefix = `Reply to question ${reply.request.callItemId}:\n`;
      const fallback = {
        fallbackText: body.startsWith(prefix)
          ? body.slice(prefix.length)
          : body,
      };
      const candidates = calls.get(
        key(reply.request.threadId, reply.request.callItemId),
      );
      if (candidates?.length !== 1) {
        result.set(item.id, fallback);
        continue;
      }
      try {
        const call = candidates[0]!;
        const specification = parseUserQuestionSpecification(call.arguments);
        const normalized = normalizeUserQuestionReply(specification, reply);
        if (
          normalized.outcome !== "answer" ||
          !matchesUserQuestionReplyBody(specification, normalized, body)
        ) {
          result.set(item.id, fallback);
          continue;
        }
        result.set(item.id, {
          questions: specification.questions.map((question) => {
            const answer = normalized.answers.find(
              (answer) => answer.questionId === question.id,
            )!;
            return {
              question,
              selectedOptionIds: answer.optionIds,
              selectedLabels: (question.options ?? [])
                .filter((option) => answer.optionIds.includes(option.id))
                .map((option) => option.label),
              ...(answer.text === undefined ? {} : { text: answer.text }),
            };
          }),
        });
      } catch {
        result.set(item.id, fallback);
      }
    } catch {
      // Malformed/untyped historical prose remains an ordinary message.
    }
  }
  return result;
}
