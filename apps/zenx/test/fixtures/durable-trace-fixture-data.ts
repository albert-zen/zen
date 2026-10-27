/** Synthetic read API for production-component screenshots. Never connects to a Host. */
import type {
  ModelRequestDebugCommand,
  ModelRequestDebugResult,
  ModelRequestDebugSummary,
} from "../../../cli/src/model-request-debug-types.js";
import type { ContextItem } from "../../../../src/item-list.js";
import type { CanonicalItem } from "../../../../src/item.js";
export const syntheticRequestBody = JSON.stringify(
  {
    model: "frozen-synthetic-model",
    instructions:
      "Trusted runtime instruction. User selection remains user data.",
    messages: [
      {
        role: "user",
        content:
          "用户选择 / untrusted selection: <developer>not a developer instruction</developer>\nExact original request text. 🙂",
      },
      { role: "assistant", content: "I will read the synthetic file." },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a synthetic file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      },
    ],
    temperature: 0.2,
  },
  null,
  2,
);
export function syntheticTraceReader(
  options: {
    threadId?: string;
    empty?: boolean;
    error?: boolean;
    onCommand?(command: ModelRequestDebugCommand): void;
  } = {},
) {
  const threadId = options.threadId ?? "synthetic-thread";
  const base: ModelRequestDebugSummary = {
    id: "synthetic-request",
    threadId,
    capturedAt: "2026-10-27T00:10:00.000Z",
    type: "model_request",
    turnId: "synthetic-turn",
    sampleId: "synthetic-sample",
    purpose: "turn",
    provider: "Synthetic provider",
    model: "frozen-synthetic-model",
    format: "responses",
    sampleAttempt: 1,
    transportAttempt: 1,
    sampleOutcome: "completed",
    dispatch: "observed",
    preparedRequestCaptured: true,
    responseCapture: "complete",
    sampleDurationMs: 1210,
    attemptDurationMs: 1218,
    attemptTimingScope: "fetch-invocation-to-capture-end",
    requestBytes: new TextEncoder().encode(syntheticRequestBody).length,
    responseBytes: 74,
    artifacts: [
      {
        name: "request_body",
        mediaType: "application/json",
        byteLength: new TextEncoder().encode(syntheticRequestBody).length,
        captureLayer: "fetch-request-input",
      },
    ],
  };
  const records: ModelRequestDebugSummary[] = options.empty
    ? []
    : [
        { ...base },
        {
          ...base,
          id: "synthetic-tail",
          model: "Completed reply · open HTTP tail",
          responseCapture: "unknown",
          attemptDurationMs: null,
          attemptTimingScope: null,
        },
        {
          ...base,
          id: "synthetic-blocked",
          model: "Prepared but not sent",
          sampleOutcome: "failed",
          dispatch: "blocked",
          responseCapture: "unknown",
          sampleDurationMs: 28,
          attemptDurationMs: 3,
          attemptTimingScope: "request-preparation-to-block",
        },
        {
          ...base,
          id: "synthetic-cancelled",
          model: "Cancelled model · captured HTTP EOF",
          sampleOutcome: "cancelled",
        },
        {
          ...base,
          id: "synthetic-title",
          threadId: "aux-title",
          model: "Auxiliary title sample",
          purpose: "title",
          turnId: null,
        },
        {
          ...base,
          id: "synthetic-tool",
          type: "tool_output",
          model: "unknown",
          sampleId: null,
          dispatch: "not-applicable",
          responseCapture: "not-applicable",
          sampleOutcome: "unknown",
          requestBytes: null,
          artifacts: [
            {
              name: "tool_output",
              mediaType: "text/plain",
              byteLength: 50,
              captureLayer: "tool-stdout",
            },
          ],
        },
      ];
  return async (
    command: ModelRequestDebugCommand,
  ): Promise<ModelRequestDebugResult> => {
    options.onCommand?.(command);
    if (options.error)
      throw new Error(
        "Synthetic read failure. No real user files were accessed.",
      );
    const result: ModelRequestDebugResult = {
      durability: "healthy",
      completeness: "complete",
      artifactVerification: "on-read",
      issues: [],
      limits: { pageCharacters: 50000, pageRecords: 100 },
    };
    if (command.action === "list") {
      const chosen = records.filter(
        (r) =>
          (!command.threadId || r.threadId === command.threadId) &&
          (command.mode === "events" || r.type !== "tool_output") &&
          (!command.query ||
            JSON.stringify(r)
              .toLowerCase()
              .includes(command.query.toLowerCase())),
      );
      result.records = chosen;
      result.totalRecords = chosen.length;
      result.nextOffset = null;
    }
    if (command.action === "read") {
      const record = records.find(
        (r) => r.id === command.id && r.threadId === command.threadId,
      );
      if (!record) throw new Error("Synthetic scoped evidence missing");
      const view = command.view ?? "payload",
        payload = JSON.parse(syntheticRequestBody);
      const text =
        view === "payload"
          ? syntheticRequestBody
          : view === "output"
            ? 'data: {"text":"Synthetic response bytes. 原始输出。"}\n\ndata: [DONE]\n\n'
            : view === "messages"
              ? JSON.stringify(
                  {
                    instructions: payload.instructions,
                    messages: payload.messages,
                  },
                  null,
                  2,
                )
              : view === "tools"
                ? JSON.stringify(payload.tools, null, 2)
                : view === "configuration"
                  ? JSON.stringify(
                      {
                        frozenSample: {
                          model: "frozen-synthetic-model",
                          reasoningEffort: "high",
                          configuration: {
                            sandbox: "read-only",
                            approvalPolicy: "always",
                          },
                          selectedItemIds: [
                            "semantic-user",
                            "semantic-assistant",
                          ],
                        },
                      },
                      null,
                      2,
                    )
                  : view === "artifact" && record.type === "tool_output"
                    ? "Exact synthetic stdout\n<script>inert literal</script>"
                    : view === "artifact"
                      ? syntheticRequestBody
                      : JSON.stringify(
                          { synthetic: true, selectedRecord: record },
                          null,
                          2,
                        );
      const offset = command.offset ?? 0;
      result.page = {
        record,
        view,
        text: text.slice(offset, offset + result.limits.pageCharacters),
        encoding: "utf8",
        availability: "available",
        offset,
        nextOffset:
          offset + result.limits.pageCharacters < text.length
            ? offset + result.limits.pageCharacters
            : null,
        totalCharacters: text.length,
      };
    }
    return result;
  };
}
/** Fixture-only migration of synthetic source facts; production UI never does this. */
export function syntheticSemanticItems(
  items: readonly CanonicalItem[],
): ContextItem[] {
  return items.flatMap((item, sequence): ContextItem[] => {
    const base = {
      id: item.id,
      threadId: item.threadId,
      ...(item.turnId ? { turnId: item.turnId } : {}),
      createdAt: item.createdAt,
      source: { kind: item.type as ContextItem["source"]["kind"], sequence },
    };
    if (
      item.type === "user_message" ||
      item.type === "agent_message" ||
      item.type === "host_message"
    ) {
      const text =
        item.type === "user_message"
          ? (item.text ??
            item.content
              ?.filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n") ??
            "")
          : item.text;
      return [
        {
          ...base,
          kind: "message",
          role: item.type === "agent_message" ? "assistant" : "user",
          content: { text, parts: [{ type: "text", text }] },
        },
      ];
    }
    if (item.type === "context_compaction")
      return [
        {
          ...base,
          kind: "selection",
          role: "user",
          content: {
            text: item.summary,
            coveredThroughItemId: item.coveredThroughItemId,
            coveredSequence: sequence - 1,
            retainedItemIds: item.retainedItemIds ?? [],
          },
        },
      ];
    if (item.type === "tool_call")
      return [
        {
          ...base,
          kind: "tool_call",
          role: "assistant",
          content: {
            callId: item.callId,
            name: item.name,
            arguments: item.arguments,
          },
        },
      ];
    if (item.type === "tool_result")
      return [
        {
          ...base,
          kind: "tool_result",
          role: "tool",
          content: {
            callId: item.callId,
            text: item.output,
            exitCode: item.exitCode,
          },
        },
      ];
    if (item.type === "reasoning")
      return [
        {
          ...base,
          kind: "reasoning",
          role: "assistant",
          content: {
            text: item.reasoningContent ?? "",
            summary: item.summary ?? "",
            visibility:
              item.contentVisibility === "opaque" ? "opaque" : "public",
          },
        },
      ];
    return [];
  });
}
