import React, { useEffect, useMemo } from "react";
import { UserQuestionCards } from "../../src/renderer/src/UserQuestionCards.js";
import { createUserQuestionStore } from "../../src/renderer/src/user-question-state.js";
import { parseUserQuestionSpecification } from "../../../../src/user-question.js";
import { answeredQuestionFixture } from "./answered-question-data.js";

/** Real information card with the same synthetic choices as the answered preview. */
export function AnsweredQuestionCardVisual() {
  const store = useMemo(() => {
    const call = answeredQuestionFixture().canonicalItems!.find(
      (item) => item.type === "tool_call",
    )!;
    if (call.type !== "tool_call")
      throw new Error("Missing synthetic question");
    const question = {
      request: { threadId: "question-demo", callItemId: "question-call" },
      createdAt: "2026-11-05T00:00:00Z",
      resultItemId: "question-result",
      state: "open" as const,
      specification: parseUserQuestionSpecification(call.arguments),
    };
    return createUserQuestionStore({
      list: async () => {
        if (new URLSearchParams(location.search).has("question-read-failure"))
          throw new Error("Synthetic question list unavailable");
        return { questions: [question], totalPending: 1 };
      },
      read: async () => ({ question }),
      respond: async () => {
        throw new Error("Synthetic preview does not submit");
      },
    });
  }, []);
  useEffect(() => {
    void store.refresh("question-demo").then(() =>
      store.edit("question-demo", "question-call", [
        { questionId: "scope", optionIds: ["summary"] },
        {
          questionId: "note",
          optionIds: [],
          text: "请保留重点案例，周五前发给我。\n这里的 **标记** 是我的原文。",
        },
      ]),
    );
  }, [store]);
  return (
    <main style={{ maxWidth: 420, margin: "24px auto", padding: "0 16px" }}>
      <p style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
        合成数据 · 生产资料卡组件 · 不提交
      </p>
      <UserQuestionCards threadId="question-demo" store={store} />
    </main>
  );
}
