import { createHash } from "node:crypto";
import type { AttachmentStore } from "../attachment.js";
import type { OpaqueReasoningReplayProvenance, UserInput } from "../item.js";
import {
  modelUserContent,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from "../model.js";
import {
  mediaRequestRejected,
  providerRecoveryBlocked,
  recordMediaPaths,
  rejectedMediaParts,
  safeProviderErrorIdentity,
  safeProviderErrorParameter,
} from "../loop-recovery.js";
import { historicalCallId, historicalToolName } from "./imported-history.js";
import { observeRequestBody } from "./request-observation.js";
import { fetchModelResponse, retryAfterMilliseconds } from "./request-retry.js";
import {
  assertProviderToolName,
  parseResponsesStream,
  providerCallId,
  serializeArguments,
} from "./responses-stream.js";

export interface OpenAiResponsesModelOptions {
  baseUrl: string;
  apiKey: string;
  provider?: string;
  defaultParams?: Readonly<Record<string, unknown>>;
  fetch?: typeof globalThis.fetch;
  attachments?: Pick<AttachmentStore, "read">;
}

/** Public API-key Responses transport. Never uses subscription authentication or server continuation state. */
export class OpenAiResponsesModel implements ModelAdapter {
  readonly provider: string;
  readonly contextInstructions: string;
  readonly requestPayloadFormat = "responses" as const;
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #provenance: OpaqueReasoningReplayProvenance;
  readonly #fetch: typeof globalThis.fetch;
  readonly #attachments: Pick<AttachmentStore, "read"> | undefined;
  readonly #params: Readonly<Record<string, unknown>>;
  constructor(options: OpenAiResponsesModelOptions) {
    this.#endpoint = responsesEndpoint(options.baseUrl);
    this.#provenance = {
      version: 1,
      adapter: "public-responses",
      endpointSha256: createHash("sha256").update(this.#endpoint).digest("hex"),
    };
    if (!options.apiKey.trim())
      throw new Error("Public Responses API key is required");
    this.#apiKey = options.apiKey;
    this.provider = options.provider?.trim() || "openai-responses";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#attachments = options.attachments;
    this.#params = { ...options.defaultParams };
    const instructions = this.#params.instructions;
    if (instructions != null && typeof instructions !== "string")
      throw new Error("Public Responses instructions must be a string or null");
    this.contextInstructions = instructions ?? "";
    for (const key of [
      "input",
      "messages",
      "model",
      "tools",
      "stream",
      "store",
      "previous_response_id",
      "conversation",
      "background",
      "include",
      "reasoning",
      "max_tokens",
      "n",
      "stream_options",
      "reasoning_effort",
    ])
      if (Object.hasOwn(this.#params, key))
        throw new Error(
          `Public Responses parameter ${key} is owned by the adapter`,
        );
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    request.signal.throwIfAborted();
    if (!request.model.trim())
      throw new Error("Public Responses model is required");
    const input: Record<string, unknown>[] = [];
    const mediaPaths = new Map<string, object>();
    for (const message of request.messages) {
      if (message.role === "reasoning") {
        if (message.contentVisibility === "opaque") {
          const provenance = message.opaqueReplayProvenance;
          if (
            !message.providerItemId ||
            provenance?.version !== 1 ||
            provenance.adapter !== "public-responses" ||
            provenance.endpointSha256 !== this.#provenance.endpointSha256
          ) {
            throw Object.assign(
              new Error(
                "Public Responses opaque reasoning continuation has unknown or different transport provenance; request was not submitted",
              ),
              { retryable: false, modelRecoveryBlocked: true },
            );
          }
          input.push({
            type: "reasoning",
            id: message.providerItemId,
            encrypted_content: message.reasoningContent,
            summary:
              message.summary === undefined
                ? []
                : [{ type: "summary_text", text: message.summary }],
          });
        }
        continue;
      }
      if (message.role === "tool") {
        const receipt = `${message.exitCode === null ? "Historical tool result; execution outcome unknown." : `Exit code: ${message.exitCode}`}\n${message.text}`;
        const content: UserInput = [
          { type: "text", text: receipt },
          ...(message.modelContent ?? []),
        ];
        const output =
          message.modelContent === undefined
            ? receipt
            : await this.#content(content);
        content.forEach((part, index) => {
          if (part.type !== "text")
            mediaPaths.set(`input[${input.length}].output[${index}]`, part);
        });
        input.push({
          type: "function_call_output",
          call_id:
            message.exitCode === null
              ? historicalCallId(message.callId)
              : providerCallId(message.callId),
          output,
        });
      } else if (message.role === "assistant" && "toolCalls" in message) {
        if (message.text) input.push(assistantText(message.text));
        for (const call of message.toolCalls)
          input.push({
            type: "function_call",
            call_id: call.imported
              ? historicalCallId(call.callId)
              : providerCallId(call.callId),
            name: call.imported ? historicalToolName(call) : call.name,
            arguments: serializeArguments(call.arguments),
          });
      } else if (message.role === "user") {
        const content = modelUserContent(message);
        recordMediaPaths(mediaPaths, `input[${input.length}]`, content, [
          "image",
        ]);
        input.push({ role: "user", content: await this.#content(content) });
      } else input.push(assistantText(message.text));
    }
    for (const tool of request.tools) assertProviderToolName(tool.name);
    const tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    }));
    const body = JSON.stringify({
      ...this.#params,
      model: request.model.trim(),
      input,
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      ...(request.reasoningEffort === null
        ? {}
        : { reasoning: { effort: request.reasoningEffort } }),
      ...(tools.length === 0
        ? {}
        : { tools, tool_choice: "auto", parallel_tool_calls: true }),
    });
    let attempt = 0;
    let response: Response;
    try {
      response = await fetchModelResponse(
        () => {
          observeRequestBody(
            request,
            body,
            this.requestPayloadFormat,
            this.provider,
            ++attempt,
            [this.#apiKey],
          );
          return this.#fetch(this.#endpoint, {
            method: "POST",
            signal: request.signal,
            headers: {
              authorization: `Bearer ${this.#apiKey}`,
              "content-type": "application/json",
              accept: "text/event-stream",
            },
            body,
          });
        },
        request.signal,
        { allowRetries: request.isSamplingRetry !== true },
      );
    } catch {
      request.signal.throwIfAborted();
      throw Object.assign(
        new Error(
          "Public Responses request failed before receiving a response",
        ),
        { retryable: true },
      );
    }
    if (!response.ok)
      throw await responseError(
        response,
        request.signal,
        mediaPaths,
        this.#apiKey,
      );
    if (response.body === null)
      throw Object.assign(
        new Error("Public Responses returned no stream body"),
        { retryable: true },
      );
    try {
      for await (const event of parseResponsesStream(
        response.body,
        request.signal,
        new Set(tools.map((t) => t.name)),
        new Set(),
        this.#apiKey,
        { requireEncryptedReasoning: true },
      )) {
        yield event.type === "reasoning" && event.contentVisibility === "opaque"
          ? { ...event, opaqueReplayProvenance: { ...this.#provenance } }
          : event;
      }
    } catch (error) {
      if (error instanceof Error)
        Object.assign(error, {
          recoveryRejectedMediaParts: rejectedMediaParts(
            mediaPaths,
            (error as Error & { recoveryDetails?: { param?: string } })
              .recoveryDetails?.param,
          ),
        });
      if (error instanceof Error && nativeToolMediaRejected(mediaPaths, error))
        Object.assign(error, { modelRecoveryBlocked: true });
      throw error;
    }
  }

  async #content(content: UserInput): Promise<Record<string, unknown>[]> {
    return await Promise.all(
      content.map(async (part) => {
        if (part.type === "text")
          return { type: "input_text", text: part.text };
        if (part.type !== "image")
          throw new Error(
            "Public Responses adapter does not support audio input; no media was submitted or removed",
          );
        if (this.#attachments === undefined)
          throw new Error("Public Responses attachment reader is required");
        const bytes = await this.#attachments.read(part.attachment);
        return {
          type: "input_image",
          image_url: `data:${part.attachment.mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
          detail: "auto",
        };
      }),
    );
  }
}
function assistantText(text: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}
function responsesEndpoint(value: string): string {
  const url = new URL(value.trim());
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Public Responses base URL is invalid");
  if (url.pathname.replace(/\/+$/u, "").endsWith("/chat/completions"))
    throw new Error(
      "Public Responses requires a base URL or /responses endpoint, not /chat/completions",
    );
  url.pathname = url.pathname.replace(/\/+$/u, "");
  if (!url.pathname.endsWith("/responses")) url.pathname += "/responses";
  return url.toString();
}
async function responseError(
  response: Response,
  signal: AbortSignal,
  paths: ReadonlyMap<string, object>,
  secret: string,
): Promise<Error> {
  let text = "";
  const reader = response.body?.getReader();
  if (reader !== undefined) {
    const decoder = new TextDecoder();
    let bytes = 0;
    const abort = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) {
          text += decoder.decode();
          break;
        }
        bytes += part.value.length;
        if (bytes > 16384) break;
        text += decoder.decode(part.value, { stream: true });
      }
    } catch {
      signal.throwIfAborted();
      text = "";
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  signal.throwIfAborted();
  let decoded = false;
  let value: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error && typeof parsed.error === "object") {
      value = parsed.error;
      decoded = true;
    }
  } catch {
    /* bounded response could not be decoded */
  }
  const details = {
    code: safeProviderErrorIdentity(value.code),
    type: safeProviderErrorIdentity(value.type),
    param: safeProviderErrorParameter(value.param),
  };
  const message =
    typeof value.message === "string"
      ? value.message.replaceAll(secret, "[redacted]").slice(0, 2048)
      : "";
  const error = Object.assign(
    new Error(
      `Public Responses request rejected with HTTP ${response.status}${message ? `: ${message}` : ""}`,
    ),
    {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
      recoveryDetails: details,
      recoveryDelayMs: retryAfterMilliseconds(
        response.headers.get("retry-after") ?? "",
      ),
      modelRecoveryBlocked: !decoded || providerRecoveryBlocked(details),
      recoveryRejectedMediaParts: rejectedMediaParts(paths, details.param),
    },
  );
  return Object.assign(error, {
    recoveryMediaRejected: mediaRequestRejected(error),
    ...(nativeToolMediaRejected(paths, error)
      ? { modelRecoveryBlocked: true }
      : {}),
  });
}

/** A rejected native tool image is not permission to silently remove it and continue. */
function nativeToolMediaRejected(
  paths: ReadonlyMap<string, object>,
  error: Error,
): boolean {
  if (
    !mediaRequestRejected(error) ||
    ![...paths.keys()].some((path) => path.includes(".output["))
  )
    return false;
  const parameter = (error as Error & { recoveryDetails?: { param?: string } })
    .recoveryDetails?.param;
  if (parameter !== undefined) {
    const exact = [...paths.keys()].filter(
      (path) => parameter === path || parameter.startsWith(`${path}.`),
    );
    if (exact.length === 1) return exact[0]!.includes(".output[");
  }
  // An ambiguous image rejection might concern a native tool output: fail closed.
  return true;
}
