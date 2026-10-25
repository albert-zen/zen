import {
  safeProviderErrorIdentity,
  safeProviderErrorParameter,
  providerRecoveryBlocked,
} from "../loop-recovery.js";
import {
  isRetryableModelSampleError,
  retryableModelSampleError,
} from "../model.js";
import type { ModelEvent } from "../model.js";
import { isTransientTransportError } from "./request-retry.js";
const providerToolName = /^[a-zA-Z0-9_-]{1,64}$/u;

/** Shared Responses SSE decoding only. Authentication and endpoint policy stay in each adapter. */
interface StreamState {
  slots: Map<number, OutputSlot>;
  startedReasoningIndexes: Set<number>;
  emittedToolCalls: Set<string>;
  finishedOutputIndexes: Set<number>;
  terminalSeen: boolean;
}

type OutputSlot =
  | {
      type: "reasoning";
      text: string;
      pendingSummarySeparator: boolean;
      itemId?: string;
      encryptedContent?: string;
      summary: Array<{ type: "summary_text"; text: string }>;
    }
  | { type: "message"; text: string }
  | {
      type: "function_call";
      callId: string;
      itemId?: string;
      name: string;
      arguments: string;
    }
  | {
      type: "custom_tool_call";
      callId: string;
      itemId?: string;
      name: string;
      input: string;
    };

export async function* parseResponsesStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  allowedToolNames: ReadonlySet<string>,
  rawToolNames: ReadonlySet<string>,
  accessToken: string,
  options: { requireEncryptedReasoning?: boolean } = {},
): AsyncIterable<ModelEvent> {
  const state: StreamState = {
    slots: new Map(),
    startedReasoningIndexes: new Set(),
    emittedToolCalls: new Set(),
    finishedOutputIndexes: new Set(),
    terminalSeen: false,
  };

  for await (const payload of readSse(body, signal)) {
    if (payload === "[DONE]") {
      break;
    }

    const event = parseEvent(payload);
    const type = stringField(event, "type");
    const terminalResponse =
      type === "response.completed" || type === "response.done"
        ? recordField(event, "response")
        : undefined;
    if (type === undefined) {
      continue;
    }
    if (state.terminalSeen) {
      throw new Error("Responses stream emitted an event after completion");
    }

    if (type === "error") {
      throw providerEventError(event, accessToken);
    }

    if (type === "response.failed" || terminalResponse?.status === "failed") {
      state.terminalSeen = true;
      const usage = terminalResponseUsage(recordField(event, "response"));
      if (usage !== undefined) yield usage;
      throw providerEventError(event, accessToken);
    }

    if (type === "response.output_item.added") {
      const outputIndex = numberField(event, "output_index");
      const item = recordField(event, "item");
      if (outputIndex !== undefined && item !== undefined) {
        const slot = outputSlot(item);
        if (slot !== undefined) {
          state.slots.set(outputIndex, slot);
        }
      }
      continue;
    }

    if (type === "response.reasoning_summary_text.delta") {
      const slot = slotFor(state, event, "reasoning");
      const delta = stringField(event, "delta");
      const outputIndex = numberField(event, "output_index");
      if (
        slot !== undefined &&
        outputIndex !== undefined &&
        delta !== undefined &&
        delta.length > 0
      ) {
        const started = startReasoningEvent(state, outputIndex);
        if (started !== undefined) yield started;
        const separator = slot.pendingSummarySeparator ? "\n\n" : "";
        slot.pendingSummarySeparator = false;
        yield {
          type: "reasoning_summary_delta",
          reasoningId: reasoningStreamId(outputIndex),
          delta: separator + delta,
        };
        slot.text += separator + delta;
      }
      continue;
    }

    if (type === "response.reasoning_summary_text.done") {
      const slot = slotFor(state, event, "reasoning");
      const text = stringField(event, "text");
      if (slot !== undefined && text !== undefined) {
        slot.text = text;
      }
      continue;
    }

    if (type === "response.reasoning_summary_part.done") {
      const slot = slotFor(state, event, "reasoning");
      if (slot !== undefined && slot.text.length > 0) {
        slot.pendingSummarySeparator = true;
      }
      continue;
    }

    if (
      type === "response.output_text.delta" ||
      type === "response.refusal.delta"
    ) {
      const slot = slotFor(state, event, "message");
      const delta = stringField(event, "delta");
      if (slot !== undefined && delta !== undefined) {
        slot.text += delta;
        yield { type: "text_delta", delta };
      }
      continue;
    }

    if (
      type === "response.custom_tool_call_input.delta" ||
      type === "response.custom_tool_call_input.done"
    ) {
      const slot = slotFor(state, event, "custom_tool_call");
      const value = customInputField(
        event,
        type.endsWith(".delta") ? "delta" : "input",
      );
      if (slot !== undefined && value !== undefined) {
        slot.input = type.endsWith(".delta") ? slot.input + value : value;
      }
      continue;
    }

    if (type === "response.function_call_arguments.delta") {
      const slot = slotFor(state, event, "function_call");
      const delta = functionArgumentsField(event, "delta");
      if (slot !== undefined && delta !== undefined) {
        slot.arguments += delta;
      }
      continue;
    }

    if (type === "response.function_call_arguments.done") {
      const slot = slotFor(state, event, "function_call");
      const argumentsJson = functionArgumentsField(event, "arguments");
      if (slot !== undefined && argumentsJson !== undefined) {
        slot.arguments = argumentsJson;
      }
      continue;
    }

    if (type === "response.output_item.done") {
      const outputIndex = numberField(event, "output_index");
      const item = recordField(event, "item");
      if (outputIndex !== undefined && item !== undefined) {
        yield* finishOutputItem(
          state,
          outputIndex,
          item,
          allowedToolNames,
          rawToolNames,
          options.requireEncryptedReasoning === true,
        );
      }
      continue;
    }

    if (
      type === "response.incomplete" ||
      terminalResponse?.status === "incomplete"
    ) {
      state.terminalSeen = true;
      const response = recordField(event, "response");
      const usage = terminalResponseUsage(response);
      if (usage !== undefined) yield usage;
      const details =
        response === undefined
          ? undefined
          : recordValue(response.incomplete_details);
      const reason =
        details === undefined ? undefined : stringField(details, "reason");
      throw Object.assign(
        new Error(
          `Responses response was incomplete${
            reason === undefined ? "" : `: ${reason}`
          }`,
        ),
        {
          modelRecoveryBlocked: reason === "content_filter",
          recoveryOutputLimit: reason === "max_output_tokens",
          recoveryRedact: (text: string) =>
            text
              .replaceAll(accessToken, "[redacted]")
              .replaceAll(
                JSON.stringify(accessToken).slice(1, -1),
                "[redacted]",
              ),
        },
      );
    }

    if (type === "response.completed" || type === "response.done") {
      state.terminalSeen = true;
      const response = recordField(event, "response");
      if (response === undefined || response.status !== "completed") {
        throw retryableModelSampleError(
          "Responses response ended without completed status",
        );
      }
      const output = response?.output;
      if (Array.isArray(output)) {
        for (const [outputIndex, item] of output.entries()) {
          if (isRecord(item)) {
            yield* finishOutputItem(
              state,
              outputIndex,
              item,
              allowedToolNames,
              rawToolNames,
              options.requireEncryptedReasoning === true,
            );
          }
        }
      }
      yield terminalResponseUsage(response) ?? {
        type: "usage",
        inputTokens: 0,
        outputTokens: 0,
      };
      break;
    }
  }

  if (!state.terminalSeen) {
    throw retryableModelSampleError(
      "Responses stream ended without a terminal response event",
    );
  }
}

function terminalResponseUsage(
  response: Record<string, unknown> | undefined,
): Extract<ModelEvent, { type: "usage" }> | undefined {
  const usage =
    response === undefined ? undefined : recordValue(response.usage);
  if (usage === undefined) return undefined;

  const inputDetails = recordValue(usage.input_tokens_details);
  const outputDetails = recordValue(usage.output_tokens_details);
  const cachedInputTokens = optionalTokenCount(inputDetails?.cached_tokens);
  const reasoningOutputTokens = optionalTokenCount(
    outputDetails?.reasoning_tokens,
  );
  return {
    type: "usage",
    inputTokens: tokenCount(usage.input_tokens),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    outputTokens: tokenCount(usage.output_tokens),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
  };
}

async function* finishOutputItem(
  state: StreamState,
  outputIndex: number,
  item: Record<string, unknown>,
  allowedToolNames: ReadonlySet<string>,
  rawToolNames: ReadonlySet<string>,
  requireEncryptedReasoning: boolean,
): AsyncIterable<ModelEvent> {
  if (state.finishedOutputIndexes.has(outputIndex)) {
    return;
  }
  const existing = state.slots.get(outputIndex);
  const slot = existing ?? outputSlot(item);
  if (slot === undefined) {
    return;
  }

  if (slot.type === "reasoning") {
    const itemId = stringField(item, "id") ?? slot.itemId;
    const encryptedContent =
      stringField(item, "encrypted_content") ?? slot.encryptedContent;
    const summary = reasoningSummary(item);
    const replaySummary = summary.length > 0 ? summary : slot.summary;
    if (requireEncryptedReasoning && (!itemId || !encryptedContent)) {
      throw Object.assign(
        new Error(
          "Public Responses returned reasoning without encrypted continuation; stateless continuation is unsupported and this sample's tools were not executed",
        ),
        { retryable: false, modelRecoveryBlocked: true },
      );
    }
    if (
      itemId !== undefined &&
      itemId.length > 0 &&
      encryptedContent !== undefined &&
      encryptedContent.length > 0
    ) {
      const finalText = reasoningSummaryText(replaySummary) || slot.text;
      const started = startReasoningEvent(state, outputIndex);
      if (started !== undefined) yield started;
      yield {
        type: "reasoning",
        reasoningId: reasoningStreamId(outputIndex),
        reasoningContent: encryptedContent,
        contentVisibility: "opaque",
        providerItemId: itemId,
        ...(finalText.length === 0 ? {} : { summary: finalText }),
      };
    } else {
      const finalText = reasoningSummaryText(replaySummary) || slot.text;
      if (finalText.length > 0) {
        const started = startReasoningEvent(state, outputIndex);
        if (started !== undefined) yield started;
        yield {
          type: "reasoning",
          reasoningId: reasoningStreamId(outputIndex),
          reasoningContent: finalText,
          summary: finalText,
          contentVisibility: "public",
        };
      }
    }
  } else if (slot.type === "message") {
    const finalText = messageText(item);
    if (
      finalText.startsWith(slot.text) &&
      finalText.length > slot.text.length
    ) {
      yield { type: "text_delta", delta: finalText.slice(slot.text.length) };
    } else if (slot.text.length === 0 && finalText.length > 0) {
      yield { type: "text_delta", delta: finalText };
    }
  } else {
    const itemCallId = stringField(item, "call_id");
    const itemId = stringField(item, "id");
    const name = stringField(item, "name");
    const argumentsJson = functionArgumentsField(item, "arguments");
    if ((itemCallId ?? slot.callId).trim().length === 0) {
      throw retryableModelSampleError(
        "Responses model returned invalid tool call id",
      );
    }
    const callId = canonicalCallId(
      itemCallId ?? slot.callId,
      itemId ?? slot.itemId,
    );
    if (state.emittedToolCalls.has(callId)) {
      state.slots.delete(outputIndex);
      state.finishedOutputIndexes.add(outputIndex);
      return;
    }
    const toolName = name ?? slot.name;
    if (!providerToolName.test(toolName)) {
      throw retryableModelSampleError(
        "Responses model returned invalid tool name",
      );
    }
    if (!allowedToolNames.has(toolName)) {
      throw retryableModelSampleError(
        `Responses model requested unavailable tool: ${toolName}`,
      );
    }
    if ((slot.type === "custom_tool_call") !== rawToolNames.has(toolName)) {
      throw retryableModelSampleError(
        "Responses model returned mismatched tool input format",
      );
    }
    state.emittedToolCalls.add(callId);
    yield {
      type: "tool_call",
      callId,
      name: toolName,
      arguments:
        slot.type === "custom_tool_call"
          ? { code: customInputField(item, "input") ?? slot.input }
          : parseArguments(argumentsJson ?? slot.arguments),
    };
  }

  state.slots.delete(outputIndex);
  state.finishedOutputIndexes.add(outputIndex);
}

function reasoningStreamId(outputIndex: number): string {
  return `reasoning:${String(outputIndex)}`;
}

function startReasoningEvent(
  state: StreamState,
  outputIndex: number,
): ModelEvent | undefined {
  if (state.startedReasoningIndexes.has(outputIndex)) return undefined;
  state.startedReasoningIndexes.add(outputIndex);
  return {
    type: "reasoning_started",
    reasoningId: reasoningStreamId(outputIndex),
  };
}

function customInputField(
  item: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = item[field];
  if (value !== undefined && typeof value !== "string") {
    throw retryableModelSampleError(
      "Responses model returned invalid custom tool input",
    );
  }
  return value;
}

function functionArgumentsField(
  item: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = item[field];
  if (value !== undefined && typeof value !== "string") {
    throw retryableModelSampleError(
      "Responses model returned invalid tool arguments",
    );
  }
  return value;
}

function outputSlot(item: Record<string, unknown>): OutputSlot | undefined {
  const type = stringField(item, "type");
  if (type === "reasoning") {
    const itemId = stringField(item, "id");
    const encryptedContent = stringField(item, "encrypted_content");
    return {
      type,
      text: reasoningText(item),
      pendingSummarySeparator: false,
      summary: reasoningSummary(item),
      ...(itemId === undefined ? {} : { itemId }),
      ...(encryptedContent === undefined ? {} : { encryptedContent }),
    };
  }
  if (type === "message") {
    return { type, text: "" };
  }
  if (type === "function_call" || type === "custom_tool_call") {
    const callId = stringField(item, "call_id");
    const name = stringField(item, "name");
    if (callId === undefined || name === undefined) {
      throw retryableModelSampleError(
        "Responses model returned incomplete tool call",
      );
    }
    const itemId = stringField(item, "id");
    return {
      callId,
      ...(itemId === undefined ? {} : { itemId }),
      name,
      ...(type === "custom_tool_call"
        ? { type, input: customInputField(item, "input") ?? "" }
        : { type, arguments: functionArgumentsField(item, "arguments") ?? "" }),
    };
  }
  return undefined;
}

function slotFor<T extends OutputSlot["type"]>(
  state: StreamState,
  event: Record<string, unknown>,
  type: T,
): Extract<OutputSlot, { type: T }> | undefined {
  const outputIndex = numberField(event, "output_index");
  if (outputIndex === undefined) {
    return undefined;
  }
  const slot = state.slots.get(outputIndex);
  return slot?.type === type
    ? (slot as Extract<OutputSlot, { type: T }>)
    : undefined;
}

async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let reachedEof = false;
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });

  const consumeLines = function* (final: boolean): Iterable<string> {
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const rawLine = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0) {
        if (dataLines.length > 0) {
          yield dataLines.join("\n");
          dataLines = [];
        }
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
      newline = buffer.indexOf("\n");
    }
    if (final) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
      buffer = "";
      if (dataLines.length > 0) {
        yield dataLines.join("\n");
        dataLines = [];
      }
    }
  };

  try {
    while (true) {
      signal.throwIfAborted();
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        signal.throwIfAborted();
        if (
          error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError")
        )
          throw error;
        if (isRetryableModelSampleError(error)) throw error;
        if (
          isTransientTransportError(error) ||
          (error instanceof Error &&
            (error.cause as { code?: string } | undefined)?.code ===
              "UND_ERR_BODY_TIMEOUT") ||
          (error instanceof TypeError && error.message === "terminated")
        ) {
          throw retryableModelSampleError("Responses model stream read failed");
        }
        throw error;
      }
      signal.throwIfAborted();
      if (result.done) {
        reachedEof = true;
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      yield* consumeLines(false);
    }
    buffer += decoder.decode();
    yield* consumeLines(true);
  } finally {
    signal.removeEventListener("abort", abort);
    if (!reachedEof) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function parseEvent(payload: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw retryableModelSampleError("Responses stream contained invalid JSON");
  }
  if (!isRecord(value)) {
    throw retryableModelSampleError(
      "Responses stream contained an invalid event",
    );
  }
  return value;
}

function providerEventError(
  event: Record<string, unknown>,
  accessToken: string,
): Error {
  const response = recordField(event, "response");
  const nested =
    recordField(event, "error") ??
    (response === undefined ? undefined : recordValue(response.error));
  const code =
    stringField(event, "code") ??
    (nested === undefined ? undefined : stringField(nested, "code"));
  const message =
    stringField(event, "message") ??
    (nested === undefined ? undefined : stringField(nested, "message"));
  const safeMessage = message?.replaceAll(accessToken, "[redacted]");
  const identity = safeProviderErrorIdentity(code);
  const type = safeProviderErrorIdentity(nested?.type);
  const param = safeProviderErrorParameter(nested?.param ?? event.param);
  const details = {
    ...(identity === undefined ? {} : { code: identity }),
    ...(type === undefined ? {} : { type }),
    ...(param === undefined ? {} : { param }),
  };
  return Object.assign(
    new Error(
      `Responses response failed${
        code === undefined ? "" : ` (${code})`
      }${safeMessage === undefined ? "" : `: ${safeMessage}`}`,
    ),
    {
      recoveryDetails: details,
      modelRecoveryBlocked: providerRecoveryBlocked(details),
    },
  );
}

function reasoningText(item: Record<string, unknown>): string {
  return reasoningSummaryText(reasoningSummary(item));
}

function reasoningSummary(
  item: Record<string, unknown>,
): Array<{ type: "summary_text"; text: string }> {
  if (!Array.isArray(item.summary)) return [];
  return item.summary.flatMap((part) => {
    if (!isRecord(part) || stringField(part, "type") !== "summary_text") {
      return [];
    }
    const text = stringField(part, "text");
    return text === undefined ? [] : [{ type: "summary_text", text }];
  });
}

function reasoningSummaryText(
  summary: readonly { type: "summary_text"; text: string }[],
): string {
  return summary
    .map((part) => part.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function messageText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content)) {
    return "";
  }
  return item.content
    .filter(isRecord)
    .map((content) => {
      const type = stringField(content, "type");
      return type === "output_text"
        ? (stringField(content, "text") ?? "")
        : type === "refusal"
          ? (stringField(content, "refusal") ?? "")
          : "";
    })
    .join("");
}

function parseArguments(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}");
  } catch {
    throw retryableModelSampleError(
      "Responses model returned invalid tool arguments",
    );
  }
  if (!isRecord(parsed)) {
    throw retryableModelSampleError(
      "Responses model returned invalid tool arguments",
    );
  }
  return parsed;
}

export function serializeArguments(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw new Error("Responses tool arguments are not JSON serializable");
  }
}

function canonicalCallId(callId: string, itemId?: string): string {
  const requiredCallId = requiredLabel(callId, "tool call id");
  return itemId === undefined || itemId.length === 0
    ? requiredCallId
    : `${requiredCallId}|${itemId}`;
}

export function providerCallId(callId: string): string {
  return requiredLabel(callId.split("|", 1)[0] ?? "", "tool call id");
}

export function assertProviderToolName(name: string): void {
  if (!providerToolName.test(name)) {
    throw new Error(
      `Responses tool name is unsupported: ${JSON.stringify(name)}`,
    );
  }
}

export function requiredSecret(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Responses access lease returned an empty token");
  }
  return value;
}

export function requiredLabel(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Responses ${label} is required`);
  }
  return value.trim();
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function optionalTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function recordField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  return recordValue(value[key]);
}

export function recordValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function numberField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  return typeof value[key] === "number" && Number.isInteger(value[key])
    ? value[key]
    : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
