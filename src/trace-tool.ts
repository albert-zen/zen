import { inspect } from "node:util";
import { serialize } from "node:v8";
import { open } from "node:fs/promises";
import type { AttachmentStore } from "./attachment.js";
import {
  attachModelReferenceBindings,
  validateModelReferenceBindings,
  type ModelReferenceBinding,
} from "./model-references.js";
import {
  capturedToolOutput,
  type ToolExecutionResult,
  type ToolInvocation,
  type ToolRuntime,
} from "./tool.js";
import type {
  RuntimeTrace,
  TraceArtifactInput,
  TraceReader,
  TraceRecord,
  TraceReceipt,
} from "./trace.js";

export type ToolTraceLocator = {
  threadId: string;
  recordId: string;
  callId: string;
  toolCallItemId?: string;
};
export type ToolTraceResultReceipt =
  | { durability: "durable"; locator: ToolTraceLocator }
  | { durability: "degraded"; error: string };
export interface ToolTraceCapture {
  recordInvocation(details: unknown): Promise<void>;
  recordResult(result: unknown, layer: string): Promise<ToolTraceResultReceipt>;
  recordAcceptedResult(result: ToolExecutionResult): Promise<void>;
  recordReferenceBindings(
    bindings: readonly ModelReferenceBinding[],
  ): Promise<void>;
  write(
    source: string,
    bytes: Uint8Array | string,
    captureLayer?: string,
  ): Promise<void>;
  end(source: string, complete: boolean, reason?: string): Promise<void>;
  flush(): Promise<void>;
  hasObservedResult(): boolean;
  hasAcceptedResult(): boolean;
}
export interface ToolTraceContext {
  threadId: string;
  turnId?: string | null;
  callId: string;
  toolCallItemId?: string;
  toolName?: string;
  origin?: string;
}
/** Per-invocation evidence; completion here never grants permission to replay effects. */
export function createToolTraceCapture(
  trace: RuntimeTrace,
  context: ToolTraceContext,
  options: { attachments?: AttachmentStore; maxPendingBytes?: number } = {},
): ToolTraceCapture {
  const streams = new Map<
    string,
    {
      offset: number;
      pending: Promise<void>;
      gapStart?: number;
      gapEnd?: number;
      gapReason?: string;
      complete: boolean;
      loss: boolean;
    }
  >();
  let pendingBytes = 0,
    pendingWrites = 0,
    observed = false,
    accepted = false;
  const maxPending = options.maxPendingBytes ?? 1024 * 1024;
  const base = {
    threadId: context.threadId,
    ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
  };
  const data = {
    callId: context.callId,
    ...(context.toolCallItemId === undefined
      ? {}
      : { toolCallItemId: context.toolCallItemId }),
    ...(context.toolName === undefined ? {} : { toolName: context.toolName }),
    origin: context.origin ?? "tool-execution",
  };
  const record = async (
    type: string,
    extra: object = {},
    artifacts?: TraceArtifactInput[],
  ): Promise<TraceReceipt> => {
    try {
      return await trace.record({
        ...base,
        type,
        data: { ...data, ...extra },
        ...(artifacts === undefined ? {} : { artifacts }),
      });
    } catch (error) {
      return { durability: "degraded", error: String(error) };
    }
  };
  const stream = (source: string) => {
    let state = streams.get(source);
    if (!state) {
      state = {
        offset: 0,
        pending: Promise.resolve(),
        complete: false,
        loss: false,
      };
      streams.set(source, state);
    }
    return state;
  };
  const gap = async (source: string, state: ReturnType<typeof stream>) => {
    if (state.gapStart === undefined) return;
    const receipt = await record("tool_output_gap", {
      source,
      offset: state.gapStart,
      endOffset: state.gapEnd,
      reason: state.gapReason,
    });
    if (receipt.durability === "durable") {
      delete state.gapStart;
      delete state.gapEnd;
      delete state.gapReason;
    }
  };
  const sink: ToolTraceCapture = {
    hasObservedResult: () => observed,
    hasAcceptedResult: () => accepted,
    async recordInvocation(details) {
      await record("tool_invocation_observed", {
        details,
        captureLayer: "tool-executor-input",
      });
    },
    async recordReferenceBindings(bindings) {
      await record("tool_reference_bindings", { bindings });
    },
    write(source, input, captureLayer = "tool-output-bytes") {
      const state = stream(source),
        size =
          typeof input === "string"
            ? Buffer.byteLength(input)
            : input.byteLength,
        offset = state.offset;
      state.offset += size;
      if (pendingBytes + size > maxPending || pendingWrites >= 128) {
        state.loss = true;
        state.gapStart ??= offset;
        state.gapEnd = state.offset;
        state.gapReason = "capture_pending_budget_exceeded";
        return Promise.resolve();
      }
      const bytes =
        typeof input === "string" ? Buffer.from(input) : Uint8Array.from(input);
      pendingBytes += size;
      pendingWrites++;
      const operation = state.pending
        .then(async () => {
          await gap(source, state);
          const receipt = await record(
            "tool_output_chunk",
            { source, offset, byteLength: size, captureLayer },
            [{ name: "tool_output", bytes, captureLayer }],
          );
          if (receipt.durability !== "durable") {
            state.loss = true;
            state.gapStart ??= offset;
            state.gapEnd = Math.max(state.gapEnd ?? 0, offset + size);
            state.gapReason = receipt.error;
          }
        })
        .finally(() => {
          pendingBytes -= size;
          pendingWrites--;
        });
      state.pending = operation;
      return operation;
    },
    async end(source, complete, reason) {
      const state = stream(source);
      await state.pending;
      await gap(source, state);
      state.complete = complete && !state.loss;
      await record("tool_output_end", {
        source,
        offset: state.offset,
        completeness: state.complete ? "complete" : "incomplete",
        ...(reason === undefined ? {} : { reason }),
      });
    },
    async flush() {
      for (const [source, state] of streams) {
        await state.pending;
        await gap(source, state);
      }
    },
    async recordResult(result, layer) {
      observed = true;
      try {
        if (streams.has("task-output")) await sink.end("task-output", true);
        await sink.flush();
        const artifacts: TraceArtifactInput[] = [];
        let error: string | undefined = [...streams.values()].some(
          (state) => state.loss,
        )
          ? "One or more output byte ranges were not retained"
          : undefined;
        try {
          artifacts.push({
            name: "raw_result",
            bytes: serialize(result),
            mediaType: "application/vnd.node.v8",
            captureLayer: "tool-returned-js-value",
          });
        } catch (cause) {
          error = `Raw JavaScript result could not be serialized: ${String(cause)}`;
          artifacts.push({
            name: "raw_result_inspection",
            bytes: inspect(result, {
              depth: null,
              maxStringLength: Infinity,
              maxArrayLength: Infinity,
            }),
            mediaType: "text/plain",
            captureLayer: "javascript-inspection-not-lossless",
          });
        }
        if (result && typeof result === "object") {
          const typed = result as ToolExecutionResult;
          // Portable projection is a viewer aid; raw_result preserves other fields and non-JSON values.
          try {
            artifacts.push({
              name: "result_json",
              bytes: JSON.stringify(typed),
              mediaType: "application/json",
              captureLayer: "tool-returned-json-view",
            });
          } catch {
            /* Raw V8 artifact remains the observed value. */
          }
          const captured = capturedToolOutput(typed);
          if (captured && streams.size === 0) {
            if (captured.path) {
              let file;
              try {
                file = await open(captured.path, "r");
                const bytes = Buffer.alloc(64 * 1024);
                let offset = 0;
                for (;;) {
                  const { bytesRead } = await file.read(
                    bytes,
                    0,
                    bytes.length,
                    offset,
                  );
                  if (!bytesRead) break;
                  await sink.write(
                    "retained-spool",
                    bytes.subarray(0, bytesRead),
                    "bounded-host-spool",
                  );
                  offset += bytesRead;
                }
                await sink.end(
                  "retained-spool",
                  !captured.sourceTruncated,
                  captured.sourceTruncated
                    ? "source_already_truncated"
                    : undefined,
                );
              } catch (cause) {
                error = String(cause);
              } finally {
                await file?.close();
              }
            } else if (captured.output !== undefined)
              await sink.write(
                "retained-spool",
                captured.output,
                "bounded-host-spool",
              );
            if (captured.sourceTruncated) {
              error ??= "Source was truncated before this capture boundary";
              await record("tool_output_gap", {
                source: "retained-spool",
                offset: captured.capturedBytes,
                reason: error,
              });
            }
          }
          for (const [index, part] of (typed.modelContent ?? []).entries())
            if (part.type !== "text") {
              try {
                if (!options.attachments)
                  throw new Error("Attachment reader unavailable");
                artifacts.push({
                  name: `media_${index}`,
                  bytes: await options.attachments.read(part.attachment),
                  mediaType: part.attachment.mediaType,
                  captureLayer: "tool-result-attachment",
                });
              } catch (cause) {
                error = String(cause);
                await record("tool_media_gap", {
                  index,
                  attachment: part.attachment,
                  reason: error,
                });
              }
            }
        }
        if (error)
          await record("tool_output_gap", { source: "result", reason: error });
        const receipt = await record(
          "tool_result_observed",
          {
            captureLayer: layer,
            completeness: error ? "incomplete" : "complete",
          },
          artifacts,
        );
        if (receipt.durability !== "durable") return receipt;
        if (error) return { durability: "degraded", error };
        return {
          durability: "durable",
          locator: {
            threadId: context.threadId,
            recordId: receipt.recordId,
            callId: context.callId,
            ...(context.toolCallItemId === undefined
              ? {}
              : { toolCallItemId: context.toolCallItemId }),
          },
        };
      } catch (cause) {
        const error = String(cause);
        await record("tool_output_gap", { source: "result", reason: error });
        return { durability: "degraded", error };
      }
    },
    async recordAcceptedResult(result) {
      const receipt = await record(
        "tool_result_accepted",
        { captureLayer: "normalized-tool-result" },
        [
          {
            name: "accepted_result",
            bytes: JSON.stringify(result),
            mediaType: "application/json",
            captureLayer: "normalized-tool-result",
          },
        ],
      );
      accepted = receipt.durability === "durable";
    },
  };
  return sink;
}
function recordMatches(
  record: TraceRecord,
  locator: ToolTraceLocator,
): boolean {
  const data = record.data as Record<string, unknown> | undefined;
  return (
    record.threadId === locator.threadId &&
    !record.origin &&
    data?.callId === locator.callId &&
    data?.toolCallItemId === locator.toolCallItemId
  );
}
export async function readObservedToolResult(
  reader: TraceReader,
  locator: ToolTraceLocator,
): Promise<TraceRecord> {
  const { records } = await reader.read(locator.threadId, {
    verifyArtifacts: false,
  });
  const record = records.find(
    (record) =>
      record.id === locator.recordId &&
      record.type === "tool_result_observed" &&
      recordMatches(record, locator),
  );
  if (!record)
    throw new Error("Observed tool result does not match this local call");
  return record;
}
export async function readKnownToolResult(
  reader: TraceReader,
  threadId: string,
  callId: string,
  toolCallItemId?: string,
): Promise<ToolExecutionResult | undefined> {
  const locator = {
    threadId,
    callId,
    recordId: "",
    ...(toolCallItemId === undefined ? {} : { toolCallItemId }),
  };
  const { records } = await reader.read(threadId, { verifyArtifacts: false });
  for (const record of records.toReversed())
    if (
      record.type === "tool_result_accepted" &&
      recordMatches(record, locator)
    ) {
      const artifact = record.artifacts.find(
        (entry) => entry.name === "accepted_result",
      );
      if (!artifact) return undefined;
      try {
        const result = JSON.parse(
          Buffer.from(await reader.readArtifact(artifact.ref)).toString("utf8"),
        ) as ToolExecutionResult;
        if (
          typeof result.output !== "string" ||
          !Number.isSafeInteger(result.exitCode)
        )
          return undefined;
        if (result.referenceBindings !== undefined)
          return attachModelReferenceBindings(
            result,
            validateModelReferenceBindings(result.referenceBindings),
          );
        return result;
      } catch {
        return undefined;
      }
    }
  return undefined;
}
/** Bounded passive evidence inspection using only trusted, current-thread provenance. */
export class TraceReadToolRuntime implements ToolRuntime {
  readonly name = "trace_read";
  readonly executionMode = "parallel_safe";
  readonly specification = {
    name: this.name,
    description:
      "Read retained raw tool evidence using its trace reference. Read-only; evidence is not permission to repeat an action. Returns a bounded page; offset and limit are bytes.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        artifact: { type: "string" },
        source: {
          type: "string",
          description:
            "Raw output stream name, for example stdout or stderr; use instead of artifact.",
        },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 65536 },
      },
      required: ["ref"],
      additionalProperties: false,
    },
  };
  constructor(readonly reader: TraceReader) {}
  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    const binding = invocation.modelReferences?.find(
      (binding) =>
        binding.ref === invocation.arguments.ref &&
        binding.ownerThreadId === invocation.threadId &&
        binding.namespace === "trace" &&
        binding.kind === "tool-result",
    );
    if (
      !binding ||
      !binding.value ||
      typeof binding.value !== "object" ||
      Array.isArray(binding.value)
    )
      throw new Error("Unknown Trace reference for this thread");
    const value = binding.value as {
      locator?: ToolTraceLocator;
      tool?: string;
    };
    const locator = value.locator;
    if (
      value.tool !== this.name ||
      !locator ||
      locator.threadId !== invocation.threadId ||
      typeof locator.recordId !== "string" ||
      typeof locator.callId !== "string"
    )
      throw new Error("Invalid Trace reference");
    const record = await readObservedToolResult(this.reader, locator);
    const offset = invocation.arguments.offset ?? 0,
      limit = invocation.arguments.limit ?? 8192;
    if (
      !Number.isSafeInteger(offset) ||
      Number(offset) < 0 ||
      !Number.isSafeInteger(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 65536
    )
      throw new Error("Invalid Trace byte range");
    const all = (
      await this.reader.read(locator.threadId, { verifyArtifacts: false })
    ).records.filter(
      (entry) =>
        entry.sequence <= record.sequence && recordMatches(entry, locator),
    );
    const sources = [
      ...new Set(
        all
          .filter(
            (entry) =>
              entry.type === "tool_output_chunk" ||
              entry.type === "tool_output_end",
          )
          .map((entry) => (entry.data as { source: string }).source),
      ),
    ];
    if (typeof invocation.arguments.source === "string") {
      const source = invocation.arguments.source;
      if (!sources.includes(source))
        throw new Error("Unknown captured output source");
      const selected = all.filter(
          (entry) => (entry.data as { source?: string }).source === source,
        ),
        pages: Array<{ offset: number; data: string }> = [];
      for (const entry of selected)
        if (entry.type === "tool_output_chunk") {
          const data = entry.data as { offset: number; byteLength: number },
            from = Math.max(Number(offset), data.offset),
            to = Math.min(
              Number(offset) + Number(limit),
              data.offset + data.byteLength,
            );
          if (to <= from) continue;
          const artifact = entry.artifacts.find(
            (artifact) => artifact.name === "tool_output",
          );
          if (!artifact) throw new Error("Raw output artifact unavailable");
          const bytes = this.reader.readArtifactRange
            ? await this.reader.readArtifactRange(
                artifact.ref,
                from - data.offset,
                to - from,
              )
            : (await this.reader.readArtifact(artifact.ref)).subarray(
                from - data.offset,
                to - data.offset,
              );
          pages.push({
            offset: from,
            data: Buffer.from(bytes).toString("base64"),
          });
        }
      const end = selected.findLast(
        (entry) => entry.type === "tool_output_end",
      );
      return {
        output: JSON.stringify({
          source,
          offset,
          limit,
          encoding: "base64",
          pages,
          end: end?.data ?? null,
          gaps: selected
            .filter((entry) => entry.type === "tool_output_gap")
            .map((entry) => entry.data),
        }),
        exitCode: 0,
      };
    }
    const name =
      typeof invocation.arguments.artifact === "string"
        ? invocation.arguments.artifact
        : "result_json";
    const artifact = record.artifacts.find((entry) => entry.name === name);
    if (!artifact)
      return {
        output: JSON.stringify({
          sources,
          artifacts: record.artifacts.map((entry) => ({
            name: entry.name,
            ...entry.ref,
          })),
        }),
        exitCode: 0,
      };
    const page = this.reader.readArtifactRange
      ? await this.reader.readArtifactRange(
          artifact.ref,
          Number(offset),
          Number(limit),
        )
      : (await this.reader.readArtifact(artifact.ref)).subarray(
          Number(offset),
          Number(offset) + Number(limit),
        );
    // Base64 preserves exact byte ranges, including split UTF8 and arbitrary binary artifacts.
    return {
      output: JSON.stringify({
        artifact: name,
        sources,
        mediaType: artifact.ref.mediaType,
        offset,
        byteLength: artifact.ref.byteLength,
        nextOffset: Number(offset) + page.length,
        eof: Number(offset) + page.length >= artifact.ref.byteLength,
        encoding: "base64",
        data: Buffer.from(page).toString("base64"),
      }),
      exitCode: 0,
    };
  }
}
