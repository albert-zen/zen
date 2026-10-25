import { randomUUID } from "node:crypto";
import type {
  ModelAdapter,
  ModelRequestObservation,
} from "../../../src/model.js";
import { observeRequestBody } from "../../../src/model/request-observation.js";
import type {
  ModelRequestDebugCommand,
  ModelRequestDebugResult,
  ModelRequestDebugSummary,
} from "./model-request-debug-types.js";

const defaultLimits = {
  maxRecords: 64,
  maxBytes: 16 * 1024 * 1024,
  maxRecordBytes: 8 * 1024 * 1024,
  pageCharacters: 64 * 1024,
};

export function validateModelRequestDebugCommand(
  input: unknown,
): ModelRequestDebugCommand {
  if (input === null || typeof input !== "object")
    throw new Error("Invalid model debug request");
  const value = input as Record<string, unknown>;
  if (value.action === "status" || value.action === "clear")
    return { action: value.action };
  if (value.action === "setEnabled" && typeof value.enabled === "boolean")
    return { action: value.action, enabled: value.enabled };
  if (
    value.action === "list" &&
    typeof value.threadId === "string" &&
    value.threadId.length <= 200 &&
    (value.itemId === undefined ||
      (typeof value.itemId === "string" &&
        value.itemId.length > 0 &&
        value.itemId.length <= 200)) &&
    (value.query === undefined ||
      (typeof value.query === "string" && value.query.length <= 1000))
  )
    return {
      action: value.action,
      threadId: value.threadId,
      ...(value.query === undefined ? {} : { query: value.query }),
      ...(typeof value.itemId === "string" ? { itemId: value.itemId } : {}),
    };
  if (
    value.action === "read" &&
    (value.view === undefined ||
      ["payload", "messages", "tools", "configuration", "message"].includes(
        String(value.view),
      )) &&
    (value.view !== "message" ||
      (typeof value.itemId === "string" &&
        value.itemId.length > 0 &&
        value.itemId.length <= 200)) &&
    typeof value.id === "string" &&
    value.id.length <= 200 &&
    (value.offset === undefined ||
      (Number.isSafeInteger(value.offset) && Number(value.offset) >= 0))
  )
    return {
      action: value.action,
      id: value.id,
      ...(value.view === undefined
        ? {}
        : {
            view: value.view as
              "payload" | "messages" | "tools" | "configuration" | "message",
          }),
      ...(value.offset === undefined ? {} : { offset: Number(value.offset) }),
      ...(value.view === "message" ? { itemId: String(value.itemId) } : {}),
    };
  throw new Error("Invalid model debug request");
}

/** Session-only local support observations. Whole old requests are evicted; nothing is journaled or uploaded. */
export class ModelRequestDebugStore {
  readonly #sessionId = randomUUID();
  readonly #limits: typeof defaultLimits;
  #enabled = false;
  #generation = 0;
  #evictedCount = 0;
  #bytes = 0;
  #records: Array<{
    summary: ModelRequestDebugSummary;
    body: string;
    bytes: number;
  }> = [];

  constructor(limits: Partial<typeof defaultLimits> = {}) {
    this.#limits = { ...defaultLimits, ...limits };
    for (const value of Object.values(this.#limits))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Invalid debug limit");
    if (this.#limits.maxRecordBytes > this.#limits.maxBytes)
      throw new Error("Invalid debug record limit");
  }

  control(input: ModelRequestDebugCommand): ModelRequestDebugResult {
    const command = validateModelRequestDebugCommand(input);
    if (command.action === "setEnabled" && command.enabled !== this.#enabled) {
      this.#enabled = command.enabled;
      this.#clear();
    } else if (command.action === "clear") this.#clear();
    const result: ModelRequestDebugResult = {
      sessionId: this.#sessionId,
      generation: this.#generation,
      enabled: this.#enabled,
      retainedCount: this.#records.length,
      retainedBytes: this.#bytes,
      evictedCount: this.#evictedCount,
      limits: { ...this.#limits },
    };
    if (command.action === "list") {
      const query = command.query?.toLocaleLowerCase();
      result.records = this.#records
        .filter(
          ({ summary, body }) =>
            (command.threadId === "" ||
              summary.threadId === command.threadId) &&
            (command.itemId === undefined ||
              summary.messageSources?.some(
                (source) => source.itemId === command.itemId,
              )) &&
            (!query ||
              body.toLocaleLowerCase().includes(query) ||
              JSON.stringify(summary).toLocaleLowerCase().includes(query)),
        )
        .map(({ summary }) => structuredClone(summary))
        .reverse();
    }
    if (command.action === "read") {
      const record = this.#records.find(
        ({ summary }) => summary.id === command.id,
      );
      if (record === undefined)
        throw new Error("Captured request expired or was cleared");
      const view = command.view ?? "payload";
      let body = record.body;
      if (view !== "payload") {
        if (record.summary.truncated)
          throw new Error(
            "Structured views are unavailable for truncated captures",
          );
        const payload = JSON.parse(body) as Record<string, unknown>;
        const mappings =
          record.summary.messageSources?.filter(
            (source) => source.itemId === command.itemId,
          ) ?? [];
        if (view === "message" && mappings.length !== 1)
          throw new Error("Exact message attribution unavailable");
        const mapping = mappings[0];
        const entries =
          mapping === undefined ? undefined : payload[mapping.container];
        if (
          view === "message" &&
          (!Array.isArray(entries) || entries[mapping!.index]?.role !== "user")
        )
          throw new Error("Captured message unavailable");
        const value =
          view === "message"
            ? (entries as unknown[])[mapping!.index]
            : view === "messages"
              ? (payload.messages ?? payload.input ?? [])
              : view === "tools"
                ? (payload.tools ?? [])
                : Object.fromEntries(
                    Object.entries(payload).filter(
                      ([key]) => !["messages", "input", "tools"].includes(key),
                    ),
                  );
        body = JSON.stringify(value, null, 2);
      }
      const offset = command.offset ?? 0;
      if (offset > body.length) throw new Error("Invalid debug page offset");
      let end = Math.min(body.length, offset + this.#limits.pageCharacters);
      // Never split a surrogate pair across display pages.
      if (end < body.length && /[\uD800-\uDBFF]/u.test(body[end - 1]!))
        end -= 1;
      if (end === offset && end < body.length) end += 2;
      result.page = {
        record: structuredClone(record.summary),
        view,
        text: body.slice(offset, end),
        offset,
        nextOffset: end < body.length ? end : null,
        totalCharacters: body.length,
      };
    }
    return result;
  }

  observe(adapter: ModelAdapter): ModelAdapter {
    const store = this;
    return {
      provider: adapter.provider,
      ...(adapter.requestPayloadFormat === undefined
        ? {}
        : { requestPayloadFormat: adapter.requestPayloadFormat }),
      async *stream(request) {
        const context =
          request.debugContext === undefined
            ? undefined
            : { ...request.debugContext };
        if (!store.#enabled || context === undefined) {
          yield* adapter.stream(request);
          return;
        }
        const generation = store.#generation;
        let active = true;
        const attachmentRefs = request.messages.flatMap((message) => {
          const parts =
            "content" in message
              ? message.content
              : "modelContent" in message
                ? message.modelContent
                : undefined;
          return (parts ?? []).flatMap((part) =>
            part.type === "text" ? [] : [part.attachment],
          );
        });
        const sourceAttachments = attachmentRefs.slice(0, 64).map((ref) => ({
          sha256: ref.sha256,
          mediaType: ref.mediaType,
          byteLength: ref.byteLength,
          ...(ref.width === undefined
            ? {}
            : { width: ref.width, height: ref.height }),
        }));
        const observe = (event: ModelRequestObservation) => {
          if (
            !active ||
            !store.#enabled ||
            generation !== store.#generation ||
            request.signal.aborted
          )
            return;
          store.#record(
            {
              id: randomUUID(),
              capturedAt: new Date().toISOString(),
              ...context,
              provider: event.provider,
              model: event.model,
              format: event.format,
              transportAttempt: event.transportAttempt,
              redacted: event.redacted,
              originalBytes: event.originalBytes,
              ...(event.messageSources === undefined
                ? {}
                : { messageSources: event.messageSources }),
              sourceAttachments,
              sourceAttachmentCount: attachmentRefs.length,
            },
            event.body,
          );
        };
        const observed = { ...request, onRequest: observe };
        if (adapter.requestPayloadFormat === undefined) {
          try {
            observeRequestBody(
              observed,
              JSON.stringify({
                model: request.model,
                reasoningEffort: request.reasoningEffort,
                messages: request.messages,
                tools: request.tools,
              }),
              "model-input",
              adapter.provider,
              0,
            );
          } catch {
            /* An unsupported adapter's projection is also observational. */
          }
        }
        try {
          yield* adapter.stream(observed);
        } finally {
          active = false;
        }
      },
    };
  }

  #clear(): void {
    this.#generation += 1;
    this.#records = [];
    this.#bytes = 0;
    this.#evictedCount = 0;
  }

  #record(
    input: Omit<ModelRequestDebugSummary, "retainedBytes" | "truncated">,
    body: string,
  ): void {
    const original = Buffer.from(body, "utf8");
    const truncated = original.byteLength > this.#limits.maxRecordBytes;
    let end = Math.min(original.byteLength, this.#limits.maxRecordBytes);
    while (
      end > 0 &&
      end < original.byteLength &&
      (original[end]! & 0xc0) === 0x80
    )
      end -= 1;
    const retained = original.subarray(0, end).toString("utf8");
    const summary = {
      ...input,
      retainedBytes: Buffer.byteLength(retained),
      truncated,
    };
    const bytes = summary.retainedBytes;
    while (
      this.#records.length > 0 &&
      (this.#bytes + bytes > this.#limits.maxBytes ||
        this.#records.length >= this.#limits.maxRecords)
    ) {
      this.#bytes -= this.#records.shift()!.bytes;
      this.#evictedCount += 1;
    }
    this.#records.push({ summary, body: retained, bytes });
    this.#bytes += bytes;
  }
}
