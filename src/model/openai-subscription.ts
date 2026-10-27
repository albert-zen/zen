import { retryableModelSampleError } from "../model.js";
import {
  parseResponsesStream,
  assertProviderToolName,
  providerCallId,
  serializeArguments,
  requiredSecret,
  requiredLabel,
  recordValue,
  stringField,
  isRecord,
} from "./responses-stream.js";
import { contextUserContent } from "./context-content.js";
import {
  safeProviderErrorIdentity,
  safeProviderErrorParameter,
  providerRecoveryBlocked,
  mediaRequestRejected,
  recordMediaPaths,
  rejectedMediaParts,
} from "../loop-recovery.js";
import {
  fetchObservedModelResponse,
  ModelDispatchRevokedError,
} from "./request-observation.js";
import { historicalCallId, historicalToolName } from "./imported-history.js";
import { fetchModelResponse, retryAfterMilliseconds } from "./request-retry.js";
import type {
  ModelAdapter,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelTool,
} from "../model.js";
import type { ModelTransportHooks } from "./transport-types.js";
import type { AttachmentStore } from "../attachment.js";

const defaultEndpoint = "https://chatgpt.com/backend-api/codex/responses";
const jwtClaim = "https://api.openai.com/auth";

export const DEFAULT_OPENAI_SUBSCRIPTION_MODEL = "gpt-5.6-terra";

export interface OpenAiSubscriptionAccessLease {
  accessToken: string;
  signal?: AbortSignal;
  /** Live Host identity check; never invalidates an already-dispatched response. */
  assertDispatchAllowed?: () => void;
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
  readonly requestPayloadFormat = "responses" as const;

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

  get contextInstructions(): string {
    return this.#instructions;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    request.signal.throwIfAborted();
    const tools = request.tools.map(toResponsesTool);
    const allowedToolNames = new Set(tools.map((tool) => tool.name));
    const rawToolNames = new Set(
      request.tools
        .filter((tool) => tool.rawSource !== undefined)
        .map((tool) => tool.name),
    );
    // History is canonical and may predate the current tool disclosure/mode.
    const replayRawToolNames = new Set([...rawToolNames, "run_code"]);
    const rawCallIds = new Set(
      request.messages.flatMap((message) =>
        message.role === "assistant" && "toolCalls" in message
          ? message.toolCalls
              .filter((call) =>
                call.imported
                  ? call.imported.inputFormat === "text"
                  : replayRawToolNames.has(call.name),
              )
              .map((call) => call.callId)
          : [],
      ),
    );
    const sessionHint = promptCacheHint(request.sessionId);
    const input: Array<Record<string, unknown>> = [];
    const mediaPaths = new Map<string, object>();
    for (const [index, message] of request.messages.entries()) {
      if (message.role === "system") continue;
      const encoded = await toResponsesInput(
        message,
        index,
        this.#attachments,
        replayRawToolNames,
        rawCallIds,
      );
      if (message.role === "user")
        recordMediaPaths(
          mediaPaths,
          `input[${input.length}]`,
          contextUserContent(message),
          ["image"],
        );
      if (message.role === "tool" && message.modelContent !== undefined)
        recordMediaPaths(
          mediaPaths,
          `input[${input.length + encoded.length - 1}]`,
          message.modelContent,
          ["image"],
        );
      input.push(...encoded);
    }
    const body = JSON.stringify({
      model: requiredLabel(request.model, "model"),
      store: false,
      stream: true,
      instructions: request.messages
        .flatMap((message) => (message.role === "system" ? [message.text] : []))
        .join("\n\n"),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { max_output_tokens: request.maxOutputTokens }),
      input,
      include: ["reasoning.encrypted_content"],
      text: { verbosity: "low" },
      reasoning: {
        effort: requiredLabel(
          request.reasoningEffort ?? "",
          "reasoning effort",
        ),
      },
      tool_choice: tools.length === 0 ? "none" : "auto",
      parallel_tool_calls: true,
      ...(tools.length === 0 ? {} : { tools }),
      ...(sessionHint === undefined ? {} : { prompt_cache_key: sessionHint }),
    });

    let transportAttempt = 0;
    const initialLease = await this.#acquireAccessLease(request.signal);
    const initialAccountId = extractChatGptAccountId(
      requiredSecret(initialLease.accessToken),
    );
    const initialLeaseGuardMethod = initialLease.assertDispatchAllowed;
    const initialLeaseGuard = initialLeaseGuardMethod?.bind(initialLease);
    const coreGuard = (
      request as ModelRequest & ModelTransportHooks
    ).assertDispatchAllowed?.bind(request);
    let lease = initialLease;
    let accessToken = requiredSecret(lease.accessToken);
    const requestForLease = (
      current: OpenAiSubscriptionAccessLease,
      token: string,
    ): ModelRequest & ModelTransportHooks => {
      const currentGuard =
        current === initialLease &&
        current.assertDispatchAllowed === initialLeaseGuardMethod
          ? initialLeaseGuard
          : current.assertDispatchAllowed?.bind(current);
      return {
        ...request,
        assertDispatchAllowed() {
          // Keep the original closures, even if a credential provider reuses a
          // mutable lease object. Renewal is never permission to replace them.
          assertSynchronousDispatchAllowed(coreGuard);
          try {
            assertSynchronousDispatchAllowed(initialLeaseGuard);
            if (currentGuard !== initialLeaseGuard)
              assertSynchronousDispatchAllowed(currentGuard);
          } catch (error) {
            throw new ModelDispatchRevokedError("auth_session_changed", {
              cause: error,
            });
          }
          if (extractChatGptAccountId(token) !== initialAccountId)
            throw new ModelDispatchRevokedError("account_changed");
        },
      };
    };
    let signal = accessLeaseSignal(request.signal, lease.signal);
    let response = await this.#request(
      body,
      sessionHint,
      accessToken,
      signal,
      request.isSamplingRetry !== true,
      requestForLease(lease, accessToken),
      () => ++transportAttempt,
    );

    if (response.status === 401 && this.#renewAccessLease !== undefined) {
      await response.body?.cancel().catch(() => undefined);
      request.signal.throwIfAborted();
      lease = await this.#renewAccessLease(accessToken, request.signal);
      accessToken = requiredSecret(lease.accessToken);
      signal = accessLeaseSignal(request.signal, lease.signal);
      response = await this.#request(
        body,
        sessionHint,
        accessToken,
        signal,
        request.isSamplingRetry !== true,
        requestForLease(lease, accessToken),
        () => ++transportAttempt,
      );
    }

    if (!response.ok) {
      throw await subscriptionHttpError(response, signal, mediaPaths);
    }
    if (response.body === null) {
      throw retryableModelSampleError(
        "OpenAI subscription model response had no stream body",
      );
    }

    try {
      yield* parseResponsesStream(
        response.body,
        signal,
        allowedToolNames,
        rawToolNames,
        accessToken,
      );
    } catch (error) {
      if (error instanceof Error) {
        const details = (
          error as Error & { recoveryDetails?: { param?: string } }
        ).recoveryDetails;
        Object.assign(error, {
          recoveryRejectedMediaParts: rejectedMediaParts(
            mediaPaths,
            details?.param,
          ),
        });
      }
      throw error;
    }
  }

  async #request(
    body: string,
    sessionHint: string | undefined,
    accessToken: string,
    signal: AbortSignal,
    allowRetries: boolean,
    request: ModelRequest,
    nextAttempt: () => number,
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
      return await fetchModelResponse(
        () =>
          fetchObservedModelResponse({
            request,
            fetch: this.#fetch,
            url: this.#endpoint,
            format: this.requestPayloadFormat,
            provider: this.provider,
            transportAttempt: nextAttempt(),
            init: { method: "POST", body, headers, signal },
          }),
        signal,
        { allowRetries },
      );
    } catch (error) {
      if (error instanceof ModelDispatchRevokedError) throw error;
      signal.throwIfAborted();
      throw new Error(
        "OpenAI subscription model request failed before receiving a response",
      );
    }
  }
}

function assertSynchronousDispatchAllowed(
  assertion: (() => void) | undefined,
): void {
  const result: unknown = assertion?.();
  if (
    result !== null &&
    result !== undefined &&
    (typeof result === "object" || typeof result === "function") &&
    "then" in result &&
    typeof result.then === "function"
  ) {
    void Promise.resolve(result).catch(() => undefined);
    throw new Error("Dispatch assertions must be synchronous");
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

type ResponsesTool = {
  name: string;
  description: string;
} & (
  | { type: "function"; parameters: Record<string, unknown>; strict: null }
  | {
      type: "custom";
      format: { type: "grammar"; syntax: "lark"; definition: string };
    }
);

// Provider grammar constrains the envelope; the runtime validates the pragma JSON.
const sourceGrammar = String.raw`start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE
PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

function toResponsesTool(tool: ModelTool): ResponsesTool {
  assertProviderToolName(tool.name);
  if (tool.rawSource !== undefined) {
    return {
      type: "custom",
      name: tool.name,
      description: tool.description,
      format: { type: "grammar", syntax: "lark", definition: sourceGrammar },
    };
  }
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
  rawToolNames: ReadonlySet<string>,
  rawCallIds: ReadonlySet<string>,
): Promise<Array<Record<string, unknown>>> {
  if (message.role === "system" || message.role === "developer")
    return [
      {
        role: message.role,
        content: [{ type: "input_text", text: message.text }],
      },
    ];
  if (message.role === "reasoning") {
    if (message.opaqueReplayProvenance !== undefined)
      throw Object.assign(
        new Error(
          "Subscription transport cannot replay public Responses opaque state",
        ),
        { modelRecoveryBlocked: true, retryable: false },
      );
    if (
      message.contentVisibility !== "opaque" ||
      message.providerItemId === undefined
    ) {
      return [];
    }
    return [
      {
        type: "reasoning",
        id: message.providerItemId,
        encrypted_content: message.reasoningContent,
        summary:
          message.summary === undefined
            ? []
            : [{ type: "summary_text", text: message.summary }],
      },
    ];
  }
  if (message.role === "user") {
    const content: Array<Record<string, unknown>> = [];
    for (const part of contextUserContent(message)) {
      if (part.type === "text") {
        content.push({ type: "input_text", text: part.text });
      } else {
        const attachment = part.attachment;
        if (part.type !== "image") {
          throw new Error(
            "Subscription Responses transport does not support audio input; media was not replaced or submitted",
          );
        }
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

  if (message.role === "tool") {
    const input: Array<Record<string, unknown>> = [
      {
        type: rawCallIds.has(message.callId)
          ? "custom_tool_call_output"
          : "function_call_output",
        call_id:
          message.exitCode === null
            ? historicalCallId(message.callId)
            : providerCallId(message.callId),
        output: message.text,
      },
    ];
    if (message.modelContent !== undefined) {
      input.push(
        ...(await toResponsesInput(
          { role: "user", content: message.modelContent },
          index,
          attachments,
          rawToolNames,
          rawCallIds,
        )),
      );
    }
    return input;
  }

  if ("toolCalls" in message) {
    const input: Array<Record<string, unknown>> = [];
    if (message.text !== undefined && message.text.length > 0) {
      input.push(assistantTextInput(message.text, index));
    }
    for (const call of message.toolCalls) {
      if (call.imported) {
        input.push(
          call.imported.inputFormat === "text"
            ? {
                type: "custom_tool_call",
                call_id: historicalCallId(call.callId),
                name: historicalToolName(call),
                input: call.arguments.input,
              }
            : {
                type: "function_call",
                call_id: historicalCallId(call.callId),
                name: historicalToolName(call),
                arguments: serializeArguments(call.arguments),
              },
        );
        continue;
      }
      assertProviderToolName(call.name);
      if (rawToolNames.has(call.name)) {
        if (
          typeof call.arguments.code !== "string" ||
          Object.keys(call.arguments).some((key) => key !== "code")
        ) {
          throw new Error(
            "OpenAI subscription raw source requires canonical {code} arguments",
          );
        }
        input.push({
          type: "custom_tool_call",
          call_id: providerCallId(call.callId),
          name: call.name,
          input: call.arguments.code,
        });
      } else {
        input.push({
          type: "function_call",
          call_id: providerCallId(call.callId),
          name: call.name,
          arguments: serializeArguments(call.arguments),
        });
      }
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

async function subscriptionHttpError(
  response: Response,
  signal: AbortSignal,
  mediaPaths: ReadonlyMap<string, object>,
): Promise<Error> {
  const reader = response.body?.getReader();
  let text = "";
  let complete = false;
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
        const chunk = await reader.read();
        if (chunk.done) {
          complete = true;
          text += decoder.decode();
          break;
        }
        bytes += chunk.value.byteLength;
        if (bytes > 16_384) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  signal.throwIfAborted();
  let details: { code?: string; type?: string; param?: string } = {};
  let mediaRejected = false;
  if (complete) {
    try {
      const payload: unknown = JSON.parse(text);
      const value =
        payload !== null && typeof payload === "object"
          ? (payload as { error?: unknown }).error
          : undefined;
      if (value !== null && typeof value === "object") {
        const error = value as {
          code?: unknown;
          type?: unknown;
          param?: unknown;
          message?: unknown;
        };
        const code = safeProviderErrorIdentity(error.code);
        const type = safeProviderErrorIdentity(error.type);
        const param = safeProviderErrorParameter(error.param);
        details = {
          ...(code === undefined ? {} : { code }),
          ...(type === undefined ? {} : { type }),
          ...(param === undefined ? {} : { param }),
        };
        mediaRejected = mediaRequestRejected(
          Object.assign(
            new Error(typeof error.message === "string" ? error.message : ""),
            { recoveryDetails: details },
          ),
        );
      }
    } catch {
      /* Unparseable/oversized bodies are never model context. */
    }
  }
  return Object.assign(
    new Error(
      `OpenAI subscription model request failed with HTTP ${response.status}`,
    ),
    {
      status: response.status,
      recoveryDetails: details,
      // A bounded/truncated envelope cannot prove that a safety rejection is absent.
      modelRecoveryBlocked:
        providerRecoveryBlocked(details) || (reader !== undefined && !complete),
      recoveryDelayMs: retryAfterMilliseconds(
        response.headers.get("retry-after") ?? "",
      ),
      recoveryMediaRejected: mediaRejected,
      recoveryRejectedMediaParts: rejectedMediaParts(mediaPaths, details.param),
    },
  );
}
