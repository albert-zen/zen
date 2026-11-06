import { runtimeMessage, runtimeThread } from "./agent-runtime-data.js";
import type { CanonicalItem } from "../../../../src/item.js";
import {
  parseUserQuestionSpecification,
  renderUserQuestionReply,
  type UserQuestionReply,
} from "../../../../src/user-question.js";

export function answeredQuestionFixture(
  missing = false,
  widthCase: string | null = null,
) {
  let specification = parseUserQuestionSpecification({
    questions: [
      {
        id: "scope",
        prompt:
          "这次巡查后，需要我准备哪些内容？请选择需要的材料，也可以补充具体要求。",
        multiSelect: true,
        options: [
          {
            id: "summary",
            label: "一页摘要",
            description: "重点、风险和下一步",
          },
          {
            id: "details",
            label: "完整明细",
            description: "保留全部原始记录和对应说明",
          },
          { id: "later", label: "暂不整理" },
        ],
      },
      { id: "note", prompt: "还有其他需要补充的内容吗？" },
    ],
  });
  const reply: UserQuestionReply = {
    version: 1,
    request: { threadId: "question-demo", callItemId: "question-call" },
    outcome: "answer",
    answers: [
      {
        questionId: "scope",
        optionIds: ["summary"],
      },
      {
        questionId: "note",
        optionIds: [],
        text: "请保留重点案例，周五前发给我。\n这里的 **标记** 是我的原文。",
      },
    ],
  };
  if (widthCase) {
    specification.questions.splice(1);
    specification.questions[0]!.prompt =
      widthCase === "short-prompt"
        ? "继续吗？"
        : "合成问题：哪些事项需要确认，下一步应该怎样处理？".repeat(30);
    specification = parseUserQuestionSpecification({
      questions: specification.questions,
    });
    reply.answers = [
      {
        questionId: "scope",
        optionIds: [],
        text:
          widthCase === "long-answer"
            ? "这是较长的回答，需要自然换行并完整保留。".repeat(40)
            : widthCase === "unbroken-answer"
              ? "abcdefghij".repeat(100)
              : "具体什么情况",
      },
    ];
  }
  const text = renderUserQuestionReply(specification, reply);
  const facts = {
    threadId: "question-demo",
    turnId: "runtime-turn",
    createdAt: "2026-11-05T00:00:00Z",
  };
  const call: CanonicalItem = {
    ...facts,
    id: "question-call",
    type: "tool_call",
    callId: "question-rpc",
    name: "ask_user_question",
    arguments: specification as unknown as Record<string, unknown>,
  };
  const input: CanonicalItem = {
    ...facts,
    id: "question-answer",
    type: "user_message",
    clientId: "question-client",
    text,
    questionReply: reply,
  };
  return {
    ...runtimeThread(
      [
        {
          type: "userMessage" as const,
          id: input.id,
          clientId: "question-client",
          content: [{ type: "text" as const, text, text_elements: [] }],
        },
        runtimeMessage(
          "synthetic-question-final",
          "我会准备一页摘要，保留重点案例，周五前发给你。",
        ),
      ],
      "completed",
      "question-demo",
    ),
    name: "问答回顾",
    canonicalItems: [...(missing ? [] : [call]), input],
  };
}
