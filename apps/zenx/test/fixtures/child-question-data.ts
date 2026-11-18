import type {
  NativeThreadSummary,
  ThreadSummary,
} from "../../../../src/thread-summary.js";

/** Synthetic Host catalog only. This does not answer or execute any task. */
export function createChildQuestionData(
  base: (id: string, name: string) => ThreadSummary,
) {
  const rows: NativeThreadSummary[] = [
    {
      ...base("question-idle", "Design review · 等待方案确认"),
      parentThreadId: "thread-1",
      status: "idle",
      userQuestionSummary: { openCount: 1 },
    },
    {
      ...base("question-active", "Implementation · 跨项目组件一致性检查"),
      parentThreadId: "thread-1",
      status: "active",
      userQuestionSummary: { openCount: 2 },
    },
    {
      ...base("question-clear", "Test coverage"),
      parentThreadId: "thread-1",
      status: "idle",
      userQuestionSummary: { openCount: 0 },
    },
    {
      threadId: "question-error",
      name: "Unavailable review",
      parentThreadId: "thread-1",
      archived: false,
      createdAt: null,
      updatedAt: null,
      preview: "",
      status: "systemError",
      error: "Synthetic unavailable Host summary",
    },
  ];
  return {
    rows,
    clear() {
      for (const [index, row] of rows.entries()) {
        if (row.status !== "systemError")
          rows[index] = { ...row, userQuestionSummary: { openCount: 0 } };
      }
      return {
        kind: "synthetic-question-attention-cleared",
        threadIds: rows
          .filter((row) => row.status !== "systemError")
          .map((row) => row.threadId),
      };
    },
  };
}
