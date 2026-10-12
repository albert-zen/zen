import type {
  CanonicalItem,
  ToolCallItem,
  ToolResultItem,
} from "../../../../src/item.js";

/** Request-local matching only; canonical history remains the disclosure authority. */
export function* disclosureCallResults(
  items: readonly CanonicalItem[],
): Generator<{ call: ToolCallItem; result: ToolResultItem }> {
  const pending = new Map<
    string,
    { call: ToolCallItem | undefined; outstanding: number }
  >();
  let scope:
    | { threadId: string; turnId: string; modelResponseId: string | undefined }
    | undefined;
  const expireRoots = (): void => {
    for (const entry of pending.values()) {
      if (entry.call !== undefined && entry.call.parentCallId === undefined)
        entry.call = undefined;
    }
  };
  for (const item of items) {
    if (
      item.type === "turn_started" ||
      item.type === "turn_completed" ||
      item.type === "turn_aborted"
    ) {
      pending.clear();
      scope = undefined;
      continue;
    }
    if (item.type === "agent_message" || item.type === "tool_call") {
      if (scope?.threadId !== item.threadId || scope.turnId !== item.turnId) {
        pending.clear();
        scope = {
          threadId: item.threadId,
          turnId: item.turnId,
          modelResponseId: undefined,
        };
      }
      if (item.type === "agent_message") {
        expireRoots();
        scope.modelResponseId = undefined;
        continue;
      }
      if (item.parentCallId === undefined) {
        if (
          item.modelResponseId !== undefined &&
          scope.modelResponseId !== undefined &&
          scope.modelResponseId !== item.modelResponseId
        )
          expireRoots();
        scope.modelResponseId = item.modelResponseId ?? scope.modelResponseId;
      }
      const earlier = pending.get(item.callId);
      // Results have no canonical call identity or response ID. If calls overlap,
      // neither can claim any result until all ambiguous outstanding calls settle.
      pending.set(item.callId, {
        call: earlier === undefined ? item : undefined,
        outstanding: (earlier?.outstanding ?? 0) + 1,
      });
      continue;
    }
    if (
      item.type !== "tool_result" ||
      scope?.threadId !== item.threadId ||
      scope.turnId !== item.turnId
    )
      continue;
    const entry = pending.get(item.callId);
    if (entry === undefined) continue;
    if (--entry.outstanding === 0) pending.delete(item.callId);
    // Nested calls are runtime-generated and can complete after their coordinator
    // yields into later model responses. Only Thread/Turn closure expires them.
    if (entry.call !== undefined) yield { call: entry.call, result: item };
  }
}
