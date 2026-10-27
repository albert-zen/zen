import {
  buildTraceTimeline,
  observedTraceClock,
  clockElapsed,
  relatedTimelineRecords,
} from "./trace-timeline.js";
import type {
  TraceArtifactRef,
  TraceReader,
  TraceRecord,
  TraceStatus,
} from "../../../src/trace.js";
import type {
  ModelRequestDebugCommand,
  ModelRequestDebugResult,
  ModelRequestDebugSummary,
  ModelRequestDebugView,
} from "./model-request-debug-types.js";
const views: readonly ModelRequestDebugView[] = [
  "payload",
  "messages",
  "tools",
  "configuration",
  "output",
  "timeline",
  "artifact",
];
const validId = (x: unknown): x is string =>
  typeof x === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(x);
const ordinal = (x: unknown) =>
  x === undefined || (Number.isSafeInteger(x) && Number(x) >= 0);
/** Do not accept arbitrary artifact refs/paths, coercible views, or obsolete mutation commands. */
export function validateModelRequestDebugCommand(
  input: unknown,
): ModelRequestDebugCommand {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid Trace read command");
  const v = input as Record<string, unknown>;
  const keys =
    v.action === "status"
      ? ["action"]
      : v.action === "list"
        ? ["action", "threadId", "query", "mode", "offset"]
        : v.action === "read"
          ? ["action", "threadId", "id", "offset", "view", "artifactIndex"]
          : [];
  if (!keys.length || Object.keys(v).some((k) => !keys.includes(k)))
    throw new Error("Invalid Trace read command");
  if (v.action === "status") return { action: "status" };
  if (!ordinal(v.offset)) throw new Error("Invalid Trace offset");
  if (
    v.action === "list" &&
    (v.threadId === "" || validId(v.threadId)) &&
    (v.query === undefined ||
      (typeof v.query === "string" && v.query.length <= 1000)) &&
    (v.mode === undefined || v.mode === "requests" || v.mode === "events")
  )
    return { ...v } as ModelRequestDebugCommand;
  if (
    v.action === "read" &&
    validId(v.threadId) &&
    validId(v.id) &&
    ordinal(v.artifactIndex) &&
    (v.view === undefined ||
      (typeof v.view === "string" &&
        views.includes(v.view as ModelRequestDebugView)))
  )
    return { ...v } as ModelRequestDebugCommand;
  throw new Error("Invalid Trace read command");
}
type Reader = TraceReader & {
  listThreadIds?(): Promise<string[]>;
  status?(): TraceStatus;
};
type Attempt = {
  records: TraceRecord[];
  responseBytes: number;
  responseChunks: number;
  request?: TraceRecord;
  dispatched?: TraceRecord;
  blocked?: TraceRecord;
  end?: TraceRecord;
  error?: TraceRecord;
};
type Sample = {
  records: TraceRecord[];
  start?: TraceRecord;
  finish?: TraceRecord;
  attempts: Map<number, Attempt>;
};
type Index = {
  records: TraceRecord[];
  byId: Map<string, TraceRecord>;
  samples: Map<string, Sample>;
};
function data(r: TraceRecord | undefined): Record<string, unknown> {
  return r?.data && typeof r.data === "object" && !Array.isArray(r.data)
    ? (r.data as Record<string, unknown>)
    : {};
}
function number(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function string(x: unknown, fallback = "unknown"): string {
  return typeof x === "string" ? x : fallback;
}
function sampleKey(r: TraceRecord) {
  return JSON.stringify([r.threadId, r.sampleId ?? r.id]);
}
function indexRecords(records: TraceRecord[]): Index {
  const byId = new Map<string, TraceRecord>(),
    samples = new Map<string, Sample>();
  for (const r of records) {
    byId.set(r.id, r);
    const key = sampleKey(r),
      s = samples.get(key) ?? {
        records: [],
        attempts: new Map<number, Attempt>(),
      };
    samples.set(key, s);
    s.records.push(r);
    if (r.type === "model_sample_started") s.start = r;
    if (r.type === "model_sample_finished") s.finish = r;
    const attempt = number(data(r).transportAttempt);
    if (attempt === null) continue;
    const a = s.attempts.get(attempt) ?? {
      records: [],
      responseBytes: 0,
      responseChunks: 0,
    };
    s.attempts.set(attempt, a);
    a.records.push(r);
    for (const artifact of r.artifacts)
      if (artifact.name === "response_body") {
        a.responseBytes += artifact.ref.byteLength;
        a.responseChunks++;
      }
    if (r.type === "model_request") a.request = r;
    if (r.type === "model_request_dispatched") a.dispatched = r;
    if (r.type === "model_dispatch_blocked") a.blocked = r;
    if (r.type === "model_response_end") a.end = r;
    if (r.type === "model_transport_error") a.error = r;
  }
  return { records, byId, samples };
}
function elapsed(from?: TraceRecord, to?: TraceRecord): number | null {
  return clockElapsed(observedTraceClock(from), observedTraceClock(to));
}
function summarize(r: TraceRecord, index: Index): ModelRequestDebugSummary {
  const s = index.samples.get(sampleKey(r)),
    d = data(r),
    frozen = data(s?.start),
    attempt = number(d.transportAttempt),
    a = attempt === null ? undefined : s?.attempts.get(attempt);
  const outcome = data(s?.finish).outcome;
  const sampleOutcome =
    outcome === "completed" ||
    outcome === "failed" ||
    outcome === "cancelled" ||
    outcome === "consumer_cancelled"
      ? outcome
      : "unknown";
  const ns = data(s?.finish).elapsedNs;
  const duration =
    typeof ns === "string" && /^\d+$/u.test(ns)
      ? Number(BigInt(ns)) / 1e6
      : null;
  const request = a?.request ?? (r.type === "model_request" ? r : undefined);
  const responseCapture = !a
    ? "not-applicable"
    : a.error
      ? "error"
      : data(a.end).completeness === "complete"
        ? (number(data(a.end).bytes) !== null &&
            data(a.end).bytes !== a.responseBytes) ||
          (number(data(a.end).chunks) !== null &&
            data(a.end).chunks !== a.responseChunks)
          ? "incomplete"
          : "complete"
        : data(a.end).completeness === "interrupted"
          ? "interrupted"
          : "unknown";
  return {
    id: r.id,
    threadId: r.threadId,
    capturedAt: r.clock.wallTime,
    type: r.type,
    turnId: r.turnId ?? null,
    sampleId: r.sampleId ?? null,
    purpose: string(frozen.purpose),
    provider: string(d.provider ?? frozen.provider),
    model: string(d.model ?? frozen.model),
    format: string(
      d.format,
      r.type === "model_input" ? "model-adapter-input (not HTTP)" : "unknown",
    ),
    sampleAttempt: number(frozen.sampleAttempt),
    transportAttempt: attempt,
    sampleOutcome,
    dispatch: !a
      ? "not-applicable"
      : a.blocked
        ? "blocked"
        : a.dispatched
          ? "observed"
          : "unknown",
    preparedRequestCaptured:
      request?.artifacts.some((x) => x.name === "request_body") ?? false,
    responseCapture,
    sampleDurationMs: duration,
    attemptDurationMs: a?.blocked
      ? elapsed(a.request, a.blocked)
      : elapsed(a?.dispatched, a?.end ?? a?.error),
    attemptTimingScope: a?.blocked
      ? a.request
        ? "request-preparation-to-block"
        : null
      : a?.dispatched && (a.end || a.error)
        ? "fetch-invocation-to-capture-end"
        : null,
    requestBytes:
      request?.artifacts.find((x) => x.name === "request_body")?.ref
        .byteLength ?? null,
    responseBytes: a?.responseBytes ?? 0,
    artifacts: r.artifacts.map((x) => ({
      name: x.name,
      byteLength: x.ref.byteLength,
      mediaType: x.ref.mediaType,
      ...(x.captureLayer === undefined ? {} : { captureLayer: x.captureLayer }),
    })),
  };
}
function decode(bytes: Uint8Array): {
  text: string;
  encoding: "utf8" | "base64";
} {
  // ignoreBOM preserves the leading U+FEFF as part of the original body.
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      ),
      encoding: "utf8",
    };
  } catch {
    return { text: Buffer.from(bytes).toString("base64"), encoding: "base64" };
  }
}
/** Disposable read index over the durable source. No adapter wrapping, write, toggle, eviction or clear. */
export class ModelRequestDebugStore {
  readonly #reader: Reader;
  readonly #limits: { pageCharacters: number; pageRecords: number };
  constructor(
    reader: Reader,
    limits: Partial<{ pageCharacters: number; pageRecords: number }> = {},
  ) {
    this.#reader = reader;
    this.#limits = { pageCharacters: 64 * 1024, pageRecords: 100, ...limits };
    if (
      Object.values(this.#limits).some((x) => !Number.isSafeInteger(x) || x < 1)
    )
      throw new Error("Invalid Trace page limits");
  }
  async control(
    input: ModelRequestDebugCommand,
  ): Promise<ModelRequestDebugResult> {
    const c = validateModelRequestDebugCommand(input);
    const status = this.#reader.status?.();
    const result: ModelRequestDebugResult = {
      durability: status?.durability ?? "unknown",
      completeness: "complete",
      artifactVerification: "on-read",
      issues: [],
      limits: { ...this.#limits },
    };
    if (status?.lastError)
      result.issues.push({ kind: "write_failure", message: status.lastError });
    if (c.action === "status") return result;
    const ids =
      c.threadId === "" ? await this.#reader.listThreadIds?.() : [c.threadId];
    if (!ids) throw new Error("All-local Trace enumeration unavailable");
    const records: TraceRecord[] = [];
    for (const threadId of ids) {
      const read = await this.#reader.read(threadId, {
        verifyArtifacts: false,
      });
      records.push(...read.records);
      result.issues.push(
        ...read.issues.map((issue) => ({ ...issue, threadId })),
      );
      if (read.completeness !== "complete")
        result.completeness =
          read.completeness === "unavailable" && records.length === 0
            ? "unavailable"
            : "incomplete";
    }
    if (result.completeness === "unavailable" && records.length)
      result.completeness = "incomplete";
    const index = indexRecords(records);
    if (c.action === "list") {
      const query = c.query?.toLocaleLowerCase();
      const chosen = records
        .filter((r) => {
          if (
            c.mode !== "events" &&
            r.type !== "model_request" &&
            r.type !== "model_input" &&
            !(
              r.type === "context_preparation_started" &&
              !index.samples
                .get(sampleKey(r))
                ?.records.some((x) =>
                  [
                    "model_request",
                    "model_input",
                    "model_dispatch_blocked",
                  ].includes(x.type),
                )
            ) &&
            !(
              r.type === "model_dispatch_blocked" &&
              !index.samples
                .get(sampleKey(r))
                ?.attempts.get(number(data(r).transportAttempt) ?? -1)?.request
            )
          )
            return false;
          return (
            !query ||
            JSON.stringify({
              type: r.type,
              threadId: r.threadId,
              sampleId: r.sampleId,
              data: r.data,
            })
              .toLocaleLowerCase()
              .includes(query)
          );
        })
        .sort(
          (a, b) =>
            b.clock.wallTime.localeCompare(a.clock.wallTime) ||
            b.sequence - a.sequence,
        );
      const offset = c.offset ?? 0;
      result.totalRecords = chosen.length;
      result.records = chosen
        .slice(offset, offset + this.#limits.pageRecords)
        .map((r) => summarize(r, index));
      result.nextOffset =
        offset + this.#limits.pageRecords < chosen.length
          ? offset + this.#limits.pageRecords
          : null;
      return result;
    }
    const r = index.byId.get(c.id);
    if (!r || r.threadId !== c.threadId)
      throw new Error("Trace record not found in selected scope");
    const view = c.view ?? "payload";
    if (view === "payload" || view === "output" || view === "artifact") {
      try {
        const rawPage = await this.#rawPage(
          r,
          index,
          view,
          c.offset ?? 0,
          c.artifactIndex ?? 0,
        );
        if (rawPage) {
          result.page = { record: summarize(r, index), view, ...rawPage };
          return result;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.completeness = "incomplete";
        result.issues.push({
          kind: "artifact_unavailable",
          message,
          threadId: c.threadId,
          recordId: c.id,
        });
        result.page = {
          record: summarize(r, index),
          view,
          text: `Unavailable: ${message}`,
          encoding: "utf8",
          availability: "unavailable",
          offset: 0,
          nextOffset: null,
          totalCharacters: null,
        };
        return result;
      }
    }
    let payload: {
      text: string;
      encoding: "utf8" | "base64";
      availability: "available" | "unavailable";
    };
    try {
      payload = {
        ...(await this.#content(r, index, view, c.artifactIndex ?? 0)),
        availability: "available",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      payload = {
        text: `Unavailable: ${message}`,
        encoding: "utf8",
        availability: "unavailable",
      };
      result.completeness = "incomplete";
      result.issues.push({
        kind: "artifact_unavailable",
        message,
        threadId: c.threadId,
        recordId: c.id,
      });
    }
    const offset = c.offset ?? 0;
    if (offset > payload.text.length)
      throw new Error("Invalid Trace page offset");
    let end = Math.min(
      payload.text.length,
      offset + this.#limits.pageCharacters,
    );
    if (
      end < payload.text.length &&
      /[\uD800-\uDBFF]/u.test(payload.text[end - 1]!)
    )
      end--;
    if (end === offset && end < payload.text.length) end += 2;
    result.page = {
      record: summarize(r, index),
      view,
      ...(view === "timeline"
        ? {
            timeline: buildTraceTimeline(
              r,
              relatedTimelineRecords(r, index.records),
            ),
          }
        : {}),
      ...payload,
      text: payload.text.slice(offset, end),
      offset,
      nextOffset: end < payload.text.length ? end : null,
      totalCharacters: payload.text.length,
    };
    return result;
  }
  /** Raw pagination is byte-addressed, hash-checked, and retains only one page in memory. */
  async #rawPage(
    r: TraceRecord,
    index: Index,
    view: "payload" | "output" | "artifact",
    offset: number,
    artifactIndex: number,
  ): Promise<
    | Omit<NonNullable<ModelRequestDebugResult["page"]>, "record" | "view">
    | undefined
  > {
    const sample = index.samples.get(sampleKey(r)),
      attempt = number(data(r).transportAttempt),
      a = attempt === null ? undefined : sample?.attempts.get(attempt);
    let refs: TraceArtifactRef[];
    if (view === "artifact") {
      const artifact = r.artifacts[artifactIndex];
      if (!artifact) throw new Error("No artifact at this index");
      refs = [artifact.ref];
    } else if (view === "payload") {
      const artifact = (a?.request ?? r).artifacts.find(
        (x) => x.name === "request_body",
      );
      if (!artifact)
        throw new Error(
          "Actual HTTP request body was not captured; semantic input is not a substitute",
        );
      refs = [artifact.ref];
    } else {
      if (!a)
        throw new Error(
          "No HTTP response observation; inspect original artifacts instead",
        );
      refs = a.records.flatMap((event) =>
        event.artifacts
          .filter((x) => x.name === "response_body")
          .map((x) => x.ref),
      );
      if (!refs.length && (!a.end || number(data(a.end).bytes) !== 0))
        throw new Error(
          "Response bytes were not captured; absence is not an empty response",
        );
    }
    const total = refs.reduce((n, ref) => n + ref.byteLength, 0);
    if (!Number.isSafeInteger(total) || offset > total)
      throw new Error("Invalid Trace byte offset");
    if (!this.#reader.readArtifactRange) {
      if (total > 4 * 1024 * 1024)
        throw new Error(
          "This reader cannot provide bounded original-byte pages",
        );
      return undefined;
    }
    const chunks: Uint8Array[] = [];
    let position = 0,
      remaining = Math.min(
        1024 * 1024,
        Math.max(4, this.#limits.pageCharacters),
      );
    for (const ref of refs) {
      if (ref.byteLength === 0 || (offset === total && ref === refs.at(-1)))
        await this.#reader.readArtifactRange(ref, ref.byteLength, 1);
      if (offset < position + ref.byteLength && remaining > 0) {
        const start = Math.max(0, offset - position),
          count = Math.min(remaining, ref.byteLength - start);
        const bytes = await this.#reader.readArtifactRange(ref, start, count);
        if (bytes.byteLength !== count)
          throw new Error("Incomplete original-byte page");
        chunks.push(bytes);
        remaining -= count;
      }
      position += ref.byteLength;
      if (remaining === 0) break;
    }
    let bytes = Buffer.concat(chunks),
      decoded = decode(bytes);
    if (decoded.encoding === "base64" && offset + bytes.length < total) {
      // Do not cut a valid UTF-8 code point across display pages. Invalid binary stays Base64.
      for (let suffix = 1; suffix <= 3 && suffix < bytes.length; suffix++) {
        const candidate = decode(bytes.subarray(0, -suffix));
        if (candidate.encoding === "utf8") {
          bytes = bytes.subarray(0, -suffix);
          decoded = candidate;
          break;
        }
      }
    }
    const endOffset = offset + bytes.length;
    return {
      ...decoded,
      availability: "available",
      offset,
      offsetUnit: "bytes",
      endOffset,
      nextOffset: endOffset < total ? endOffset : null,
      totalBytes: total,
      totalCharacters: null,
    };
  }
  async #content(
    r: TraceRecord,
    index: Index,
    view: ModelRequestDebugView,
    artifactIndex: number,
  ): Promise<{ text: string; encoding: "utf8" | "base64" }> {
    const s = index.samples.get(sampleKey(r)),
      attempt = number(data(r).transportAttempt),
      a = attempt === null ? undefined : s?.attempts.get(attempt);
    const json = (value: unknown) => ({
      text: JSON.stringify(value, null, 2),
      encoding: "utf8" as const,
    });
    if (view === "timeline")
      return json(relatedTimelineRecords(r, index.records));
    if (view === "configuration")
      return json({
        frozenSample: s?.start?.data ?? null,
        selectedRecord: r.data ?? null,
        sampleFinish: s?.finish?.data ?? null,
        note: "Recorded settings, not current UI settings; actual serialized settings are in Request body.",
      });
    if (view === "artifact") {
      const artifact = r.artifacts[artifactIndex];
      if (!artifact) throw new Error("No artifact at this index");
      return decode(await this.#reader.readArtifact(artifact.ref));
    }
    if (view === "output") {
      if (!a)
        throw new Error(
          "No HTTP response observation for this record; inspect its original artifacts instead",
        );
      const artifacts = a.records.flatMap((x) =>
        x.artifacts.filter((y) => y.name === "response_body"),
      );
      if (!artifacts.length && (!a.end || number(data(a.end).bytes) !== 0))
        throw new Error(
          "Response bytes were not captured; absence is not an empty response",
        );
      const chunks = await Promise.all(
        artifacts.map((x) => this.#reader.readArtifact(x.ref)),
      );
      return decode(Buffer.concat(chunks));
    }
    const artifact = (a?.request ?? r).artifacts.find(
      (x) => x.name === "request_body",
    );
    if (!artifact)
      throw new Error(
        "Actual HTTP request body was not captured; semantic input is not a substitute",
      );
    if (artifact.ref.byteLength > 4 * 1024 * 1024)
      throw new Error(
        "Structured view exceeds 4 MiB; use lossless original-byte pages",
      );
    const body = decode(await this.#reader.readArtifact(artifact.ref));
    if (view === "payload") return body;
    if (body.encoding !== "utf8")
      throw new Error(
        "Structured view requires UTF-8 JSON; original bytes remain in Request body",
      );
    const parsed = JSON.parse(body.text.replace(/^\uFEFF/u, "")) as Record<
      string,
      unknown
    >;
    return json(
      view === "messages"
        ? {
            ...(parsed.instructions === undefined
              ? {}
              : { instructions: parsed.instructions }),
            ...(parsed.messages === undefined
              ? {}
              : { messages: parsed.messages }),
            ...(parsed.input === undefined ? {} : { input: parsed.input }),
          }
        : (parsed.tools ?? []),
    );
  }
}
