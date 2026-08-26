import type {
  ModelAdapter,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelTool,
} from "../model.js";
import type { AttachmentStore } from "../attachment.js";

export interface OpenAiCompatibleModelOptions {
  baseUrl: string;
  apiKey: string;
  provider?: string;
  defaultParams?: Readonly<Record<string, unknown>>;
  fetch?: typeof globalThis.fetch;
  attachments?: Pick<AttachmentStore, "read">;
}

export type OpenAiCompatibleModelErrorKind =
  "configuration" | "transport" | "http" | "protocol";

export class OpenAiCompatibleModelError extends Error {
  readonly kind: OpenAiCompatibleModelErrorKind;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  readonly explicitlyRejectsImageInput: boolean;

  constructor(
    kind: OpenAiCompatibleModelErrorKind,
    message: string,
    options: {
      status?: number;
      requestId?: string;
      retryable?: boolean;
      explicitlyRejectsImageInput?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "OpenAiCompatibleModelError";
    this.kind = kind;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.explicitlyRejectsImageInput =
      options.explicitlyRejectsImageInput ?? false;
  }
}

/**
 * A stateless Chat Completions adapter. Credentials and provider configuration
 * are injected by the host and never enter a Thread or protocol response.
 */
export class OpenAiCompatibleModel implements ModelAdapter {
  readonly provider: string;

  readonly #apiKey: string;
  readonly #defaultParams: Readonly<Record<string, unknown>>;
  readonly #endpoint: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #attachments: Pick<AttachmentStore, "read"> | undefined;

  constructor(options: OpenAiCompatibleModelOptions) {
    this.#endpoint = chatCompletionsEndpoint(options.baseUrl);
    this.#apiKey = requiredSecret(options.apiKey);
    this.provider = requiredLabel(
      options.provider ?? "openai-compatible",
      "provider",
    );
    this.#defaultParams = options.defaultParams ?? {};
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#attachments = options.attachments;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    request.signal.throwIfAborted();
    const tools = request.tools.map(toChatTool);
    const allowedToolNames = new Set(tools.map((tool) => tool.function.name));
    const reasoningPolicy = compatibleReasoningPolicy({
      provider: this.provider,
      endpoint: this.#endpoint,
      model: request.model,
      defaultParams: this.#defaultParams,
    });
    const messages: Readonly<Record<string, unknown>>[] = [];
    let pendingReasoning = "";
    for (const message of request.messages) {
      if (message.role === "reasoning") {
        if (message.contentVisibility === "public") {
          pendingReasoning = [pendingReasoning, message.reasoningContent]
            .filter((part) => part.length > 0)
            .join("\n\n");
        }
        continue;
      }
      const encoded = await toChatMessage(message, this.#attachments);
      if (pendingReasoning.length > 0) {
        if (shouldReplayReasoning(reasoningPolicy.replay, message)) {
          messages.push({ ...encoded, reasoning_content: pendingReasoning });
          pendingReasoning = "";
          continue;
        }
        if (
          reasoningPolicy.replay === "all-assistant" &&
          message.role !== "assistant"
        ) {
          messages.push({
            role: "assistant",
            content: null,
            reasoning_content: pendingReasoning,
          });
        }
        pendingReasoning = "";
      }
      messages.push(encoded);
    }
    if (
      pendingReasoning.length > 0 &&
      reasoningPolicy.replay === "all-assistant"
    ) {
      messages.push({
        role: "assistant",
        content: null,
        reasoning_content: pendingReasoning,
      });
    }
    const body = serializeRequest({
      ...this.#defaultParams,
      model: requiredLabel(request.model, "model"),
      messages,
      n: 1,
      stream: true,
      reasoning_effort: reasoningPolicy.forwardReasoningEffort
        ? requiredLabel(request.reasoningEffort, "reasoning effort")
        : undefined,
      ...(reasoningPolicy.enableToolStream
        ? { tool_stream: tools.length > 0 ? true : undefined }
        : {}),
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? "auto" : undefined,
    });

    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        signal: request.signal,
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body,
      });
    } catch {
      request.signal.throwIfAborted();
      throw modelError(
        "transport",
        "OpenAI-compatible model request failed before receiving a response",
      );
    }

    if (!response.ok) {
      const providerError = await readProviderError(response);
      const requestId = safeRequestId(response.headers, this.#apiKey);
      throw new OpenAiCompatibleModelError(
        "http",
        `OpenAI-compatible model request failed with HTTP ${response.status}${
          requestId === undefined ? "" : ` (request ${requestId})`
        }`,
        {
          status: response.status,
          ...(requestId === undefined ? {} : { requestId }),
          retryable: isRetryableStatus(response.status),
          explicitlyRejectsImageInput:
            providerError.explicitlyRejectsImageInput,
        },
      );
    }

    if (response.body === null) {
      throw modelError(
        "protocol",
        "OpenAI-compatible model response had no stream body",
      );
    }

    yield* parseChatCompletionStream(
      response.body,
      request.signal,
      allowedToolNames,
    );
  }
}

type ReasoningReplay = "none" | "tool-calls" | "all-assistant";

interface CompatibleReasoningPolicy {
  replay: ReasoningReplay;
  forwardReasoningEffort: boolean;
  enableToolStream: boolean;
}

function compatibleReasoningPolicy(options: {
  provider: string;
  endpoint: string;
  model: string;
  defaultParams: Readonly<Record<string, unknown>>;
}): CompatibleReasoningPolicy {
  const provider = options.provider.toLowerCase();
  const endpoint = options.endpoint.toLowerCase();
  const model = requiredLabel(options.model, "model").toLowerCase();
  const familyModel = model.split("/").at(-1) ?? model;
  const isDashScope =
    provider.includes("dashscope") ||
    endpoint.includes("dashscope.aliyuncs.com");
  const isZhipu =
    provider.includes("zhipu") || endpoint.includes("bigmodel.cn");

  if (/^qwen3\.8(?:-|$)/u.test(familyModel)) {
    return {
      replay:
        options.defaultParams["preserve_thinking"] === true
          ? "all-assistant"
          : "none",
      forwardReasoningEffort: false,
      enableToolStream: false,
    };
  }

  if (/^glm-5\.(?:2|3)(?:-|$)/u.test(familyModel)) {
    return {
      replay: glmPreservedThinking(options.defaultParams)
        ? "all-assistant"
        : "tool-calls",
      forwardReasoningEffort: isZhipu && !isDashScope,
      enableToolStream: true,
    };
  }

  if (/^deepseek(?:-|$)/u.test(familyModel) || provider === "deepseek") {
    return {
      replay: "tool-calls",
      forwardReasoningEffort: false,
      enableToolStream: false,
    };
  }

  return {
    replay: "all-assistant",
    forwardReasoningEffort: true,
    enableToolStream: false,
  };
}

function glmPreservedThinking(
  defaultParams: Readonly<Record<string, unknown>>,
): boolean {
  const thinking = defaultParams["thinking"];
  return (
    typeof thinking === "object" &&
    thinking !== null &&
    !Array.isArray(thinking) &&
    (thinking as Readonly<Record<string, unknown>>)["clear_thinking"] === false
  );
}

function shouldReplayReasoning(
  replay: ReasoningReplay,
  message: ModelMessage,
): boolean {
  if (message.role !== "assistant") return false;
  if (replay === "all-assistant") return true;
  return (
    replay === "tool-calls" &&
    "toolCalls" in message &&
    message.toolCalls.length > 0
  );
}

async function readProviderError(
  response: Response,
): Promise<{ explicitlyRejectsImageInput: boolean }> {
  let text: string;
  try {
    text = (await response.text()).slice(0, 16_384);
  } catch {
    return { explicitlyRejectsImageInput: false };
  }
  try {
    const body = JSON.parse(text) as unknown;
    if (typeof body !== "object" || body === null || !("error" in body))
      return { explicitlyRejectsImageInput: false };
    const error = (body as { error?: unknown }).error;
    if (typeof error !== "object" || error === null)
      return { explicitlyRejectsImageInput: false };
    const value = error as {
      code?: unknown;
      type?: unknown;
      message?: unknown;
    };
    const code =
      typeof value.code === "string"
        ? value.code.slice(0, 256)
        : typeof value.type === "string"
          ? value.type.slice(0, 256)
          : undefined;
    const message =
      typeof value.message === "string"
        ? value.message.slice(0, 2_048)
        : undefined;
    const detail = `${code ?? ""} ${message ?? ""}`.toLowerCase();
    return {
      explicitlyRejectsImageInput:
        /image|vision|multimodal|content[_ -]?type/u.test(detail) &&
        /not supported|unsupported|does not accept|invalid.*(?:image|content[_ -]?type)/u.test(
          detail,
        ),
    };
  } catch {
    return { explicitlyRejectsImageInput: false };
  }
}

interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

function toChatTool(tool: ModelTool): ChatTool {
  return {
    type: "function",
    function: {
      name: requiredLabel(tool.name, "tool name"),
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

async function toChatMessage(
  message: ModelMessage,
  attachments: Pick<AttachmentStore, "read"> | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  if (message.role === "reasoning") {
    throw modelError(
      "configuration",
      "Semantic reasoning must be encoded with its assistant message",
    );
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: requiredLabel(message.callId, "tool call id"),
      content: `Exit code: ${String(message.exitCode)}\n${message.text}`,
    };
  }

  if ("toolCalls" in message) {
    return {
      role: "assistant",
      content: message.text ?? null,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: requiredLabel(toolCall.callId, "tool call id"),
        type: "function",
        function: {
          name: requiredLabel(toolCall.name, "tool name"),
          arguments: serializeToolArguments(toolCall.arguments),
        },
      })),
    };
  }

  if ("content" in message) {
    const content: Array<Record<string, unknown>> = [];
    for (const part of message.content) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text });
      } else {
        if (attachments === undefined) {
          throw modelError(
            "configuration",
            "OpenAI-compatible attachment reader is required for image input",
          );
        }
        const bytes = await attachments.read(part.attachment);
        content.push({
          type: "image_url",
          image_url: {
            url: `data:${part.attachment.mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
          },
        });
      }
    }
    return { role: "user", content };
  }

  return { role: message.role, content: message.text };
}

function chatCompletionsEndpoint(baseUrl: string): string {
  const value = requiredLabel(baseUrl, "base URL").trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw modelError("configuration", "OpenAI-compatible base URL is invalid");
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw modelError("configuration", "OpenAI-compatible base URL is invalid");
  }

  return `${value.replace(/\/+$/u, "")}/chat/completions`;
}

function requiredSecret(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw modelError("configuration", "OpenAI-compatible API key is required");
  }
  return value;
}

function requiredLabel(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw modelError("configuration", `OpenAI-compatible ${label} is required`);
  }
  return value.trim();
}

function serializeRequest(value: Readonly<Record<string, unknown>>): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw modelError(
      "configuration",
      "OpenAI-compatible model request is not JSON serializable",
    );
  }
}

function serializeToolArguments(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw modelError(
      "configuration",
      "OpenAI-compatible tool arguments are not JSON serializable",
    );
  }
}

interface StreamState {
  finishReason?: string;
  doneSeen: boolean;
  reasoningContent: string;
  reasoningStarted: boolean;
  toolCalls: Map<number, ToolCallAccumulator>;
}

interface ToolCallAccumulator {
  id?: string;
  name?: string;
  arguments: string;
}

async function* parseChatCompletionStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  allowedToolNames: ReadonlySet<string>,
): AsyncIterable<ModelEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const sse: SseState = { buffer: "", dataLines: [] };
  const state: StreamState = {
    doneSeen: false,
    reasoningContent: "",
    reasoningStarted: false,
    toolCalls: new Map(),
  };
  let reachedEof = false;
  let endedByDone = false;

  try {
    stream: while (true) {
      const result = await readWithAbort(reader, signal);
      if (result.done) {
        reachedEof = true;
        break;
      }

      const payloads = feedSse(
        sse,
        decoder.decode(result.value, { stream: true }),
        false,
      );
      for (const payload of payloads) {
        yield* consumePayload(payload, state);
      }
      if (state.doneSeen) {
        endedByDone = true;
        break stream;
      }
    }

    if (!endedByDone) {
      const payloads = feedSse(sse, decoder.decode(), true);
      for (const payload of payloads) {
        yield* consumePayload(payload, state);
      }
    }
  } finally {
    if (!reachedEof) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  if (!state.doneSeen && state.finishReason === undefined) {
    throw modelError(
      "protocol",
      "OpenAI-compatible model stream ended without a terminal marker",
    );
  }

  if (
    state.toolCalls.size > 0 &&
    state.finishReason !== undefined &&
    state.finishReason !== "tool_calls" &&
    state.finishReason !== "function_call"
  ) {
    throw modelError(
      "protocol",
      "OpenAI-compatible model stream ended inconsistently",
    );
  }

  if (
    state.toolCalls.size === 0 &&
    (state.finishReason === "tool_calls" ||
      state.finishReason === "function_call")
  ) {
    throw modelError(
      "protocol",
      "OpenAI-compatible model stream omitted its tool call",
    );
  }

  if (state.reasoningContent.length > 0) {
    yield {
      type: "reasoning",
      reasoningId: "reasoning:0",
      reasoningContent: state.reasoningContent,
      contentVisibility: "public",
    };
  }

  for (const [, call] of [...state.toolCalls.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    if (call.id === undefined || call.name === undefined) {
      throw modelError(
        "protocol",
        "OpenAI-compatible model stream had an incomplete tool call",
      );
    }
    if (!allowedToolNames.has(call.name)) {
      throw modelError(
        "protocol",
        "OpenAI-compatible model requested an unavailable tool",
      );
    }

    yield {
      type: "tool_call",
      callId: call.id,
      name: call.name,
      arguments: parseToolArguments(call.arguments),
    };
  }
}

async function* consumePayload(
  payload: string,
  state: StreamState,
): AsyncIterable<ModelEvent> {
  if (payload.trim() === "[DONE]") {
    if (state.doneSeen) {
      throw modelError(
        "protocol",
        "OpenAI-compatible model stream repeated its terminal marker",
      );
    }
    state.doneSeen = true;
    return;
  }

  if (state.doneSeen) {
    throw modelError(
      "protocol",
      "OpenAI-compatible model stream continued after completion",
    );
  }

  const chunk = parseChunk(payload);
  if ("error" in chunk) {
    throw modelError(
      "protocol",
      "OpenAI-compatible provider reported a streaming error",
    );
  }

  const usage = readUsage(chunk.usage);
  if (usage !== undefined) {
    yield { type: "usage", ...usage };
  }

  if (!Array.isArray(chunk.choices)) {
    throw modelError(
      "protocol",
      "OpenAI-compatible model stream omitted choices",
    );
  }

  for (const choiceValue of chunk.choices) {
    const choice = record(choiceValue, "choice");
    const choiceIndex = choice.index;
    if (choiceIndex !== undefined && choiceIndex !== 0) {
      throw modelError(
        "protocol",
        "OpenAI-compatible model stream returned multiple choices",
      );
    }

    const delta =
      choice.delta === undefined ? {} : record(choice.delta, "choice delta");
    const content = delta.content;
    if (
      content !== undefined &&
      content !== null &&
      typeof content !== "string"
    ) {
      throw modelError(
        "protocol",
        "OpenAI-compatible model stream had invalid text content",
      );
    }
    if (
      state.finishReason !== undefined &&
      typeof content === "string" &&
      content.length > 0
    ) {
      throw modelError(
        "protocol",
        "OpenAI-compatible model stream continued after finishing",
      );
    }
    if (typeof content === "string" && content.length > 0) {
      yield { type: "text_delta", delta: content };
    }

    const reasoningContent = delta.reasoning_content;
    if (
      reasoningContent !== undefined &&
      reasoningContent !== null &&
      typeof reasoningContent !== "string"
    ) {
      throw modelError(
        "protocol",
        "OpenAI-compatible model stream had invalid reasoning content",
      );
    }
    if (
      state.finishReason !== undefined &&
      typeof reasoningContent === "string" &&
      reasoningContent.length > 0
    ) {
      throw modelError(
        "protocol",
        "OpenAI-compatible model stream continued after finishing",
      );
    }
    if (typeof reasoningContent === "string" && reasoningContent.length > 0) {
      if (!state.reasoningStarted) {
        state.reasoningStarted = true;
        yield { type: "reasoning_started", reasoningId: "reasoning:0" };
      }
      yield {
        type: "reasoning_content_delta",
        reasoningId: "reasoning:0",
        delta: reasoningContent,
      };
      state.reasoningContent += reasoningContent;
    }

    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) {
        throw modelError(
          "protocol",
          "OpenAI-compatible model stream had invalid tool calls",
        );
      }
      if (state.finishReason !== undefined && delta.tool_calls.length > 0) {
        throw modelError(
          "protocol",
          "OpenAI-compatible model stream continued after finishing",
        );
      }
      mergeToolCalls(state.toolCalls, delta.tool_calls);
    }

    const finishReason = choice.finish_reason;
    if (finishReason !== undefined && finishReason !== null) {
      if (typeof finishReason !== "string" || finishReason.length === 0) {
        throw modelError(
          "protocol",
          "OpenAI-compatible model stream had an invalid finish reason",
        );
      }
      if (state.finishReason !== undefined) {
        throw modelError(
          "protocol",
          "OpenAI-compatible model stream repeated its finish reason",
        );
      }
      if (
        finishReason !== "stop" &&
        finishReason !== "tool_calls" &&
        finishReason !== "function_call"
      ) {
        throw modelError(
          "protocol",
          "OpenAI-compatible model response was incomplete",
        );
      }
      state.finishReason = finishReason;
    }
  }
}

function parseChunk(payload: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw modelError(
      "protocol",
      "OpenAI-compatible model stream contained invalid JSON",
    );
  }
  return record(value, "stream chunk");
}

function readUsage(
  value: unknown,
): { inputTokens: number; outputTokens: number } | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const usage = record(value, "usage");
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) {
    throw modelError(
      "protocol",
      "OpenAI-compatible model stream had invalid usage",
    );
  }
  return { inputTokens, outputTokens };
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function mergeToolCalls(
  calls: Map<number, ToolCallAccumulator>,
  deltas: readonly unknown[],
): void {
  for (const value of deltas) {
    const delta = record(value, "tool call delta");
    const index = delta.index ?? 0;
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0
    ) {
      throw modelError(
        "protocol",
        "OpenAI-compatible model stream had an invalid tool call index",
      );
    }

    const current = calls.get(index) ?? { arguments: "" };
    const id = nonEmptyFragment(delta.id, "tool call id");
    if (id !== undefined && current.id !== undefined && id !== current.id) {
      throw modelError(
        "protocol",
        "OpenAI-compatible model stream changed a tool call id",
      );
    }

    const functionDelta =
      delta.function === undefined
        ? {}
        : record(delta.function, "tool call function");
    const name = nonEmptyFragment(functionDelta.name, "tool name");
    if (
      name !== undefined &&
      current.name !== undefined &&
      name !== current.name
    ) {
      throw modelError(
        "protocol",
        "OpenAI-compatible model stream changed a tool name",
      );
    }

    const argumentDelta = functionDelta.arguments;
    if (argumentDelta !== undefined && typeof argumentDelta !== "string") {
      throw modelError(
        "protocol",
        "OpenAI-compatible model stream had invalid tool arguments",
      );
    }

    const mergedId = id ?? current.id;
    const mergedName = name ?? current.name;
    calls.set(index, {
      ...(mergedId === undefined ? {} : { id: mergedId }),
      ...(mergedName === undefined ? {} : { name: mergedName }),
      arguments: current.arguments + (argumentDelta ?? ""),
    });
  }
}

function nonEmptyFragment(value: unknown, label: string): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw modelError(
      "protocol",
      `OpenAI-compatible model stream had an invalid ${label}`,
    );
  }
  return value;
}

function parseToolArguments(value: string): Record<string, unknown> {
  if (value.trim().length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw modelError(
      "protocol",
      "OpenAI-compatible model returned invalid tool arguments",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw modelError(
      "protocol",
      "OpenAI-compatible model returned invalid tool arguments",
    );
  }
  return parsed as Record<string, unknown>;
}

function record(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw modelError(
      "protocol",
      `OpenAI-compatible model stream had an invalid ${label}`,
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

interface SseState {
  buffer: string;
  dataLines: string[];
}

function feedSse(state: SseState, text: string, final: boolean): string[] {
  state.buffer += text;
  const payloads: string[] = [];

  while (true) {
    const ending = findLineEnding(state.buffer, final);
    if (ending === undefined) {
      break;
    }
    const line = state.buffer.slice(0, ending.index);
    state.buffer = state.buffer.slice(ending.index + ending.width);
    consumeSseLine(state, line, payloads);
  }

  if (final) {
    if (state.buffer.length > 0) {
      consumeSseLine(state, state.buffer, payloads);
      state.buffer = "";
    }
    dispatchSseData(state, payloads);
  }

  return payloads;
}

function findLineEnding(
  value: string,
  final: boolean,
): { index: number; width: number } | undefined {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\n") {
      return { index, width: 1 };
    }
    if (character === "\r") {
      if (index + 1 >= value.length && !final) {
        return undefined;
      }
      return { index, width: value[index + 1] === "\n" ? 2 : 1 };
    }
  }
  return undefined;
}

function consumeSseLine(
  state: SseState,
  line: string,
  payloads: string[],
): void {
  if (line.length === 0) {
    dispatchSseData(state, payloads);
    return;
  }
  if (line.startsWith(":")) {
    return;
  }

  const colon = line.indexOf(":");
  const field = colon === -1 ? line : line.slice(0, colon);
  let value = colon === -1 ? "" : line.slice(colon + 1);
  if (value.startsWith(" ")) {
    value = value.slice(1);
  }
  if (field === "data") {
    state.dataLines.push(value);
  }
}

function dispatchSseData(state: SseState, payloads: string[]): void {
  if (state.dataLines.length === 0) {
    return;
  }
  payloads.push(state.dataLines.join("\n"));
  state.dataLines = [];
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const abort = (): void => {
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    void reader
      .read()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", abort);
      });
  });
}

function safeRequestId(headers: Headers, apiKey: string): string | undefined {
  const value = headers.get("x-request-id") ?? headers.get("request-id");
  if (
    value === null ||
    value.length === 0 ||
    value.length > 128 ||
    value.includes(apiKey)
  ) {
    return undefined;
  }
  return /^[a-zA-Z0-9._:-]+$/u.test(value) ? value : undefined;
}

function isRetryableStatus(status: number): boolean {
  return [408, 409, 429, 500, 502, 503, 504].includes(status);
}

function modelError(
  kind: Exclude<OpenAiCompatibleModelErrorKind, "http">,
  message: string,
): OpenAiCompatibleModelError {
  return new OpenAiCompatibleModelError(kind, message);
}
