import type {
  ModelAdapter,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelTool,
} from "../model.js";
import type { AttachmentStore } from "../attachment.js";

const defaultEndpoint = "https://chatgpt.com/backend-api/codex/responses";
const jwtClaim = "https://api.openai.com/auth";
const providerToolName = /^[a-zA-Z0-9_-]{1,64}$/u;

export const DEFAULT_OPENAI_SUBSCRIPTION_MODEL = "gpt-5.6-terra";

export interface OpenAiSubscriptionAccessLease {
  accessToken: string;
  signal?: AbortSignal;
}

export interface OpenAiSubscriptionModelOptions {
  acquireAccessLease: (
    signal: AbortSignal,
  ) => Promise<OpenAiSubscriptionAccessLease>;
  renewAccessLease?: (
    rejectedAccessToken: string,
    signal: AbortSignal,
  ) => Promise<OpenAiSubscriptionAccessLease>;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  instructions?: string;
  attachments?: Pick<AttachmentStore, "read">;
}

/**
 * A stateless, native adapter for the ChatGPT Codex Responses SSE endpoint.
 * Each request is rebuilt from canonical Zen history, including compatible
 * encrypted reasoning Items; no continuation authority is kept in memory.
 */
export class OpenAiSubscriptionModel implements ModelAdapter {
  readonly provider = "openai-codex";

  readonly #acquireAccessLease: OpenAiSubscriptionModelOptions["acquireAccessLease"];
  readonly #renewAccessLease:
    OpenAiSubscriptionModelOptions["renewAccessLease"] | undefined;
  readonly #endpoint: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #instructions: string;
  readonly #attachments: Pick<AttachmentStore, "read"> | undefined;

  constructor(options: OpenAiSubscriptionModelOptions) {
    this.#acquireAccessLease = options.acquireAccessLease;
    this.#renewAccessLease = options.renewAccessLease;
    this.#endpoint = subscriptionEndpoint(options.endpoint ?? defaultEndpoint);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#instructions =
      options.instructions?.trim() || "You are a helpful assistant.";
    this.#attachments = options.attachments;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    request.signal.throwIfAborted();
    const tools = request.tools.map(toResponsesTool);
    const allowedToolNames = new Set(tools.map((tool) => tool.name));
    const sessionHint = promptCacheHint(request.sessionId);
    const input: Array<Record<string, unknown>> = [];
    for (const [index, message] of request.messages.entries()) {
      input.push(
        ...(await toResponsesInput(message, index, this.#attachments)),
      );
    }
    const body = JSON.stringify({
      model: requiredLabel(request.model, "model"),
      store: false,
      stream: true,
      instructions: this.#instructions,
      input,
      include: ["reasoning.encrypted_content"],
      text: { verbosity: "low" },
      reasoning: {
        effort: requiredLabel(request.reasoningEffort, "reasoning effort"),
      },
      tool_choice: tools.length === 0 ? "none" : "auto",
      parallel_tool_calls: true,
      ...(tools.length === 0 ? {} : { tools }),
      ...(sessionHint === undefined ? {} : { prompt_cache_key: sessionHint }),
    });

    let lease = await this.#acquireAccessLease(request.signal);
    let accessToken = requiredSecret(lease.accessToken);
    let signal = accessLeaseSignal(request.signal, lease.signal);
    let response = await this.#request(body, sessionHint, accessToken, signal);

    if (response.status === 401 && this.#renewAccessLease !== undefined) {
      await response.body?.cancel().catch(() => undefined);
      request.signal.throwIfAborted();
      lease = await this.#renewAccessLease(accessToken, request.signal);
      accessToken = requiredSecret(lease.accessToken);
      signal = accessLeaseSignal(request.signal, lease.signal);
      response = await this.#request(body, sessionHint, accessToken, signal);
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `OpenAI subscription model request failed with HTTP ${response.status}`,
      );
    }
    if (response.body === null) {
      throw new Error("OpenAI subscription model response had no stream body");
    }

    yield* parseResponsesStream(
      response.body,
      signal,
      allowedToolNames,
      accessToken,
    );
  }

  async #request(
    body: string,
    sessionHint: string | undefined,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<Response> {
    signal.throwIfAborted();
    const headers = new Headers({
      accept: "text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": extractChatGptAccountId(accessToken),
      "content-type": "application/json",
      "openai-beta": "responses=experimental",
      originator: "zen",
      "user-agent": "zen/0.1.0",
    });
    if (sessionHint !== undefined) {
      headers.set("session-id", sessionHint);
      headers.set("x-client-request-id", sessionHint);
    }
    try {
      return await this.#fetch(this.#endpoint, {
        method: "POST",
        body,
        headers,
        signal,
      });
    } catch {
      signal.throwIfAborted();
      throw new Error(
        "OpenAI subscription model request failed before receiving a response",
      );
    }
  }
}

function accessLeaseSignal(
  requestSignal: AbortSignal,
  leaseSignal: AbortSignal | undefined,
): AbortSignal {
  const signal =
    leaseSignal === undefined
      ? requestSignal
      : AbortSignal.any([requestSignal, leaseSignal]);
  signal.throwIfAborted();
  return signal;
}

interface ResponsesTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: null;
}

function toResponsesTool(tool: ModelTool): ResponsesTool {
  assertProviderToolName(tool.name);
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: null,
  };
}

async function toResponsesInput(
  message: ModelMessage,
  index: number,
  attachments: Pick<AttachmentStore, "read"> | undefined,
): Promise<Array<Record<string, unknown>>> {
  if (message.role === "reasoning") {
    return [
      {
        type: "reasoning",
        id: message.providerItemId,
        encrypted_content: message.encryptedContent,
        summary: structuredClone(message.providerSummary),
      },
    ];
  }
  if (message.role === "user") {
    if ("content" in message) {
      const content: Array<Record<string, unknown>> = [];
      for (const part of message.content) {
        if (part.type === "text") {
          content.push({ type: "input_text", text: part.text });
        } else {
          if (attachments === undefined) {
            throw new Error(
              "OpenAI subscription attachment reader is required for image input",
            );
          }
          const bytes = await attachments.read(part.attachment);
          content.push({
            type: "input_image",
            image_url: `data:${part.attachment.mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
          });
        }
      }
      return [{ role: "user", content }];
    }
    return [
      {
        role: "user",
        content: [{ type: "input_text", text: message.text }],
      },
    ];
  }

  if (message.role === "tool") {
    return [
      {
        type: "function_call_output",
        call_id: providerCallId(message.callId),
        output: `Exit code: ${String(message.exitCode)}\n${message.text}`,
      },
    ];
  }

  if ("toolCalls" in message) {
    const input: Array<Record<string, unknown>> = [];
    if (message.text !== undefined && message.text.length > 0) {
      input.push(assistantTextInput(message.text, index));
    }
    for (const call of message.toolCalls) {
      assertProviderToolName(call.name);
      input.push({
        type: "function_call",
        call_id: providerCallId(call.callId),
        name: call.name,
        arguments: serializeArguments(call.arguments),
      });
    }
    return input;
  }

  return [assistantTextInput(message.text, index)];
}

function assistantTextInput(
  text: string,
  index: number,
): Record<string, unknown> {
  return {
    type: "message",
    id: `msg_zen_${String(index)}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

interface StreamState {
  slots: Map<number, OutputSlot>;
  emittedToolCalls: Set<string>;
  finishedOutputIndexes: Set<number>;
  terminalSeen: boolean;
}

type OutputSlot =
  | {
      type: "reasoning";
      text: string;
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
    };

async function* parseResponsesStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  allowedToolNames: ReadonlySet<string>,
  accessToken: string,
): AsyncIterable<ModelEvent> {
  const state: StreamState = {
    slots: new Map(),
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
    if (type === undefined) {
      continue;
    }
    if (state.terminalSeen) {
      throw new Error(
        "OpenAI subscription stream emitted an event after completion",
      );
    }

    if (type === "error" || type === "response.failed") {
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
      if (slot !== undefined && delta !== undefined) {
        slot.text += delta;
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
        slot.text += "\n\n";
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

    if (type === "response.function_call_arguments.delta") {
      const slot = slotFor(state, event, "function_call");
      const delta = stringField(event, "delta");
      if (slot !== undefined && delta !== undefined) {
        slot.arguments += delta;
      }
      continue;
    }

    if (type === "response.function_call_arguments.done") {
      const slot = slotFor(state, event, "function_call");
      const argumentsJson = stringField(event, "arguments");
      if (slot !== undefined && argumentsJson !== undefined) {
        slot.arguments = argumentsJson;
      }
      continue;
    }

    if (type === "response.output_item.done") {
      const outputIndex = numberField(event, "output_index");
      const item = recordField(event, "item");
      if (outputIndex !== undefined && item !== undefined) {
        yield* finishOutputItem(state, outputIndex, item, allowedToolNames);
      }
      continue;
    }

    if (type === "response.incomplete") {
      state.terminalSeen = true;
      const response = recordField(event, "response");
      const details =
        response === undefined
          ? undefined
          : recordValue(response.incomplete_details);
      const reason =
        details === undefined ? undefined : stringField(details, "reason");
      throw new Error(
        `OpenAI subscription response was incomplete${
          reason === undefined ? "" : `: ${reason}`
        }`,
      );
    }

    if (type === "response.completed" || type === "response.done") {
      state.terminalSeen = true;
      const response = recordField(event, "response");
      if (response === undefined || response.status !== "completed") {
        throw new Error(
          "OpenAI subscription response ended without completed status",
        );
      }
      const output = response?.output;
      if (Array.isArray(output)) {
        for (const [outputIndex, item] of output.entries()) {
          if (isRecord(item)) {
            yield* finishOutputItem(state, outputIndex, item, allowedToolNames);
          }
        }
      }
      const usage =
        response === undefined ? undefined : recordValue(response.usage);
      yield {
        type: "usage",
        inputTokens: tokenCount(usage?.input_tokens),
        outputTokens: tokenCount(usage?.output_tokens),
      };
      break;
    }
  }

  if (!state.terminalSeen) {
    throw new Error(
      "OpenAI subscription stream ended without a terminal response event",
    );
  }
}

async function* finishOutputItem(
  state: StreamState,
  outputIndex: number,
  item: Record<string, unknown>,
  allowedToolNames: ReadonlySet<string>,
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
    if (
      itemId !== undefined &&
      itemId.length > 0 &&
      encryptedContent !== undefined &&
      encryptedContent.length > 0
    ) {
      const finalText =
        reasoningSummaryText(replaySummary) || slot.text.replace(/\n\n$/u, "");
      yield {
        type: "reasoning",
        summary: finalText,
        providerItemId: itemId,
        encryptedContent,
        providerSummary: structuredClone(replaySummary),
      };
    } else {
      const finalText =
        reasoningSummaryText(replaySummary) || slot.text.replace(/\n\n$/u, "");
      if (finalText.length > 0) {
        yield { type: "reasoning", summary: finalText };
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
    const argumentsJson = stringField(item, "arguments");
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
    assertProviderToolName(toolName);
    if (!allowedToolNames.has(toolName)) {
      throw new Error(
        `OpenAI subscription model requested unavailable tool: ${toolName}`,
      );
    }
    state.emittedToolCalls.add(callId);
    yield {
      type: "tool_call",
      callId,
      name: toolName,
      arguments: parseArguments(argumentsJson ?? slot.arguments),
    };
  }

  state.slots.delete(outputIndex);
  state.finishedOutputIndexes.add(outputIndex);
}

function outputSlot(item: Record<string, unknown>): OutputSlot | undefined {
  const type = stringField(item, "type");
  if (type === "reasoning") {
    const itemId = stringField(item, "id");
    const encryptedContent = stringField(item, "encrypted_content");
    return {
      type,
      text: reasoningText(item),
      summary: reasoningSummary(item),
      ...(itemId === undefined ? {} : { itemId }),
      ...(encryptedContent === undefined ? {} : { encryptedContent }),
    };
  }
  if (type === "message") {
    return { type, text: "" };
  }
  if (type === "function_call") {
    const callId = stringField(item, "call_id");
    const name = stringField(item, "name");
    if (callId === undefined || name === undefined) {
      return undefined;
    }
    const itemId = stringField(item, "id");
    return {
      type,
      callId,
      ...(itemId === undefined ? {} : { itemId }),
      name,
      arguments: stringField(item, "arguments") ?? "",
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
      const result = await reader.read();
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
    throw new Error("OpenAI subscription stream contained invalid JSON");
  }
  if (!isRecord(value)) {
    throw new Error("OpenAI subscription stream contained an invalid event");
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
  return new Error(
    `OpenAI subscription response failed${
      code === undefined ? "" : ` (${code})`
    }${safeMessage === undefined ? "" : `: ${safeMessage}`}`,
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
    throw new Error(
      "OpenAI subscription model returned invalid tool arguments",
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      "OpenAI subscription model returned invalid tool arguments",
    );
  }
  return parsed;
}

function serializeArguments(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw new Error(
      "OpenAI subscription tool arguments are not JSON serializable",
    );
  }
}

function canonicalCallId(callId: string, itemId?: string): string {
  const requiredCallId = requiredLabel(callId, "tool call id");
  return itemId === undefined || itemId.length === 0
    ? requiredCallId
    : `${requiredCallId}|${itemId}`;
}

function providerCallId(callId: string): string {
  return requiredLabel(callId.split("|", 1)[0] ?? "", "tool call id");
}

function assertProviderToolName(name: string): void {
  if (!providerToolName.test(name)) {
    throw new Error(
      `OpenAI subscription tool name is unsupported: ${JSON.stringify(name)}`,
    );
  }
}

function requiredSecret(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("OpenAI subscription access lease returned an empty token");
  }
  return value;
}

function requiredLabel(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`OpenAI subscription ${label} is required`);
  }
  return value.trim();
}

function subscriptionEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OpenAI subscription endpoint is invalid");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("OpenAI subscription endpoint is invalid");
  }
  return url.toString();
}

function promptCacheHint(value: string | undefined): string | undefined {
  return value === undefined
    ? undefined
    : Array.from(value).slice(0, 64).join("");
}

export function extractChatGptAccountId(accessToken: string): string {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) {
      throw new Error("invalid JWT");
    }
    const payload = JSON.parse(
      Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
    ) as unknown;
    if (!isRecord(payload)) {
      throw new Error("invalid JWT payload");
    }
    const auth = recordValue(payload[jwtClaim]);
    const accountId =
      auth === undefined ? undefined : stringField(auth, "chatgpt_account_id");
    if (accountId === undefined || accountId.length === 0) {
      throw new Error("missing account");
    }
    return accountId;
  } catch {
    throw new Error(
      "OpenAI subscription access token did not contain a ChatGPT account id",
    );
  }
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function recordField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  return recordValue(value[key]);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringField(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
