import type { NativeQuestionListResult } from "../../../../src/protocol/native/wire.js";

/** Exact read-only empty question page for the synthetic navigation owner. */
export function readNavigationQuestions(
  request: unknown,
  childNavigation = false,
): NativeQuestionListResult {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some((key) => key !== "threadId") ||
    !("threadId" in request) ||
    (request.threadId !== "thread-1" &&
      !(childNavigation && request.threadId === "design-child"))
  )
    throw new Error("Unexpected synthetic navigation question request");
  return { questions: [], totalPending: 0 };
}
