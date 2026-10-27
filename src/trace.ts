import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

const clockDomain = randomUUID();
const clockStart = process.hrtime.bigint();
const identifier = /^[A-Za-z0-9_-]+$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
export interface TraceClock {
  domain: string;
  monotonicNs: string;
  wallTime: string;
}
export interface TraceArtifactRef {
  sha256: string;
  byteLength: number;
  mediaType: string;
}
export interface TraceArtifactInput {
  name: string;
  bytes: Uint8Array | string;
  mediaType?: string;
  captureLayer?: string;
}
export interface TraceEvent {
  threadId: string;
  turnId?: string | null;
  sampleId?: string;
  type: string;
  data?: unknown;
  artifacts?: readonly TraceArtifactInput[];
}
export interface TraceRecord {
  id: string;
  threadId: string;
  sequence: number;
  turnId?: string | null;
  sampleId?: string;
  type: string;
  clock: TraceClock;
  data?: unknown;
  artifacts: Array<{
    name: string;
    ref: TraceArtifactRef;
    captureLayer?: string;
  }>;
  origin?: { threadId: string; recordId: string; sequence: number };
}
export type TraceReceipt =
  | {
      durability: "durable";
      recordId: string;
      sequence: number;
      sync: "file-and-directory" | "file";
    }
  | { durability: "degraded"; error: string; recordId?: string };
export interface TraceIssue {
  kind:
    | "read_failure"
    | "partial_frame"
    | "invalid_frame"
    | "artifact_unavailable"
    | "write_failure"
    | "capture_gap";
  message: string;
  segment?: string;
  line?: number;
  recordId?: string;
}
export interface TraceReadResult {
  records: TraceRecord[];
  /** Storage integrity, not proof that a model/tool reached EOF or completed. */
  completeness: "complete" | "incomplete" | "unavailable";
  issues: TraceIssue[];
  artifactVerification?: "verified" | "not-checked";
}
export interface RuntimeTrace {
  record(event: TraceEvent): Promise<TraceReceipt>;
}
export interface TraceReader {
  read(
    threadId: string,
    options?: { verifyArtifacts?: boolean },
  ): Promise<TraceReadResult>;
  readArtifact(ref: TraceArtifactRef): Promise<Uint8Array>;
}
export interface TraceStatus {
  durability: "healthy" | "degraded";
  failedRecords: number;
  lastError?: string;
}

/** Always-on append-only evidence; no side-effect authority, replay, eviction or hidden redaction. */
export class FileTraceStore implements RuntimeTrace, TraceReader {
  readonly directory: string;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #next = new Map<string, number>();
  readonly #artifactQueues = new Map<string, Promise<unknown>>();
  readonly #segments = new Map<string, string>();
  readonly #gaps = new Map<string, { count: number; error: string }>();
  readonly #onFailure: ((issue: TraceIssue) => void) | undefined;
  #failedRecords = 0;
  #lastError: string | undefined;
  constructor(
    directory: string,
    options: { onFailure?: (issue: TraceIssue) => void } = {},
  ) {
    this.directory = path.resolve(directory);
    this.#onFailure = options.onFailure;
  }
  status(): TraceStatus {
    return {
      durability: this.#lastError === undefined ? "healthy" : "degraded",
      failedRecords: this.#failedRecords,
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
    };
  }
  async record(event: TraceEvent): Promise<TraceReceipt> {
    const id = randomUUID(),
      clock = traceClock();
    let snapshot: TraceEvent;
    try {
      assertIdentifier(event.threadId);
      if (!event.type) throw new Error("Trace event type is required");
      snapshot = {
        ...event,
        ...(event.data === undefined ? {} : { data: jsonSnapshot(event.data) }),
        artifacts: (event.artifacts ?? []).map((artifact) => ({
          ...artifact,
          bytes:
            typeof artifact.bytes === "string"
              ? Buffer.from(artifact.bytes, "utf8")
              : Uint8Array.from(artifact.bytes),
        })),
      };
    } catch (error) {
      return this.#failed(event.threadId, id, error);
    }
    return this.#serialize(snapshot.threadId, async () => {
      try {
        await this.#initialize(snapshot.threadId);
        await this.#recordGap(snapshot.threadId);
        const artifacts: TraceRecord["artifacts"] = [];
        for (const artifact of snapshot.artifacts ?? []) {
          if (!artifact.name)
            throw new Error("Trace artifact name is required");
          artifacts.push({
            name: artifact.name,
            ref: await this.#storeArtifact(artifact.bytes, artifact.mediaType),
            ...(artifact.captureLayer === undefined
              ? {}
              : { captureLayer: artifact.captureLayer }),
          });
        }
        const record: TraceRecord = {
          id,
          threadId: snapshot.threadId,
          sequence: this.#allocate(snapshot.threadId),
          type: snapshot.type,
          clock,
          artifacts,
          ...(snapshot.turnId === undefined ? {} : { turnId: snapshot.turnId }),
          ...(snapshot.sampleId === undefined
            ? {}
            : { sampleId: snapshot.sampleId }),
          ...(snapshot.data === undefined ? {} : { data: snapshot.data }),
        };
        const sync = await this.#append(record);
        if (this.#gaps.size === 0) this.#lastError = undefined;
        return {
          durability: "durable",
          recordId: id,
          sequence: record.sequence,
          sync,
        };
      } catch (error) {
        this.#segments.delete(snapshot.threadId);
        return this.#failed(snapshot.threadId, id, error);
      }
    });
  }
  async read(
    threadId: string,
    options: { verifyArtifacts?: boolean } = {},
  ): Promise<TraceReadResult> {
    assertIdentifier(threadId);
    await this.#queues.get(threadId)?.catch(() => undefined);
    return {
      ...(await this.#readStored(threadId, options.verifyArtifacts !== false)),
      artifactVerification:
        options.verifyArtifacts === false ? "not-checked" : "verified",
    };
  }
  async listThreadIds(): Promise<string[]> {
    try {
      await this.#assertDirectories("threads");
      return (
        await readdir(path.join(this.directory, "threads"), {
          withFileTypes: true,
        })
      )
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            identifier.test(entry.name),
        )
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (isCode(error, "ENOENT")) return [];
      throw error;
    }
  }
  async readArtifact(ref: TraceArtifactRef): Promise<Uint8Array> {
    assertArtifactRef(ref);
    await this.#assertDirectories("artifacts");
    const bytes = await readOwnedFile(this.#artifactPath(ref.sha256));
    await this.#assertDirectories("artifacts");
    assertBytes(bytes, ref);
    return bytes;
  }
  /** Copies independent bytes; imported evidence never authorizes local execution. */
  async importRecords(
    threadId: string,
    records: readonly TraceRecord[],
    source: TraceReader,
  ): Promise<TraceReceipt[]> {
    assertIdentifier(threadId);
    const receipts: TraceReceipt[] = [];
    for (const input of records) {
      const id = randomUUID();
      let snapshot: TraceRecord;
      try {
        snapshot = jsonSnapshot(input) as TraceRecord;
        validateRecord(snapshot);
      } catch (error) {
        receipts.push(this.#failed(threadId, id, error));
        break;
      }
      const receipt = await this.#serialize(
        threadId,
        async (): Promise<TraceReceipt> => {
          try {
            await this.#initialize(threadId);
            await this.#recordGap(threadId);
            for (const artifact of snapshot.artifacts) {
              const bytes = await source.readArtifact(artifact.ref);
              assertBytes(bytes, artifact.ref);
              await this.#storeArtifact(bytes, artifact.ref.mediaType);
            }
            const record: TraceRecord = {
              ...snapshot,
              id,
              threadId,
              sequence: this.#allocate(threadId),
              origin: snapshot.origin ?? {
                threadId: snapshot.threadId,
                recordId: snapshot.id,
                sequence: snapshot.sequence,
              },
            };
            const sync = await this.#append(record);
            if (this.#gaps.size === 0) this.#lastError = undefined;
            return {
              durability: "durable",
              recordId: id,
              sequence: record.sequence,
              sync,
            };
          } catch (error) {
            this.#segments.delete(threadId);
            return this.#failed(threadId, id, error);
          }
        },
      );
      receipts.push(receipt);
      if (receipt.durability === "degraded") break;
    }
    return receipts;
  }
  async flush(): Promise<void> {
    await Promise.allSettled([...this.#queues.values()]);
  }
  #serialize<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.#queues.get(threadId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.#queues.set(threadId, pending);
    void pending
      .finally(() => {
        if (this.#queues.get(threadId) === pending)
          this.#queues.delete(threadId);
      })
      .catch(() => undefined);
    return pending;
  }
  async #assertDirectories(...parts: string[]): Promise<void> {
    let current = this.directory;
    await assertRealDirectory(current);
    for (const part of parts) {
      current = path.join(current, part);
      await assertRealDirectory(current);
    }
  }
  async #initialize(threadId: string): Promise<void> {
    // Recheck on every append: cached readiness cannot legitimize a replaced directory alias.
    await privateDirectory(this.directory);
    await privateDirectory(path.join(this.directory, "artifacts"));
    await privateDirectory(path.join(this.directory, "threads"));
    await privateDirectory(this.#threadPath(threadId));
    await syncDirectory(this.directory);
    await syncDirectory(path.dirname(this.directory));
    await syncDirectory(path.join(this.directory, "threads"));
    if (!this.#next.has(threadId)) {
      const prior = await this.#readStored(threadId, false);
      this.#next.set(
        threadId,
        prior.records.reduce(
          (max, record) => Math.max(max, record.sequence),
          0,
        ) + 1,
      );
    }
  }
  #allocate(threadId: string): number {
    const value = this.#next.get(threadId)!;
    this.#next.set(threadId, value + 1);
    return value;
  }
  async #recordGap(threadId: string): Promise<void> {
    const gap = this.#gaps.get(threadId);
    if (gap === undefined) return;
    await this.#append({
      id: randomUUID(),
      threadId,
      sequence: this.#allocate(threadId),
      type: "trace_capture_gap",
      clock: traceClock(),
      data: { failedRecords: gap.count, error: gap.error },
      artifacts: [],
    });
    this.#gaps.delete(threadId);
  }
  async #append(record: TraceRecord): Promise<"file-and-directory" | "file"> {
    let segment = this.#segments.get(record.threadId);
    if (segment === undefined) {
      segment = `${clockDomain}-${randomUUID()}.jsonl`;
      this.#segments.set(record.threadId, segment);
    }
    const body = JSON.stringify(record),
      frame = Buffer.from(
        JSON.stringify({ record, sha256: digest(body) }) + "\n",
      );
    await this.#assertDirectories("threads", record.threadId);
    const target = path.join(this.#threadPath(record.threadId), segment);
    const file = await open(
      target,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const opened = await file.stat();
      assertOwnedRegularFile(opened);
      await writeAll(file, frame);
      await file.sync();
      const current = await lstat(target);
      assertOwnedRegularFile(current);
      assertSameFile(opened, current);
      await this.#assertDirectories("threads", record.threadId);
    } finally {
      await file.close();
    }
    return (await syncDirectory(this.#threadPath(record.threadId)))
      ? "file-and-directory"
      : "file";
  }
  async #storeArtifact(
    bytes: Uint8Array | string,
    mediaType = "application/octet-stream",
  ): Promise<TraceArtifactRef> {
    const payload =
      typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
    const ref = {
      sha256: digest(payload),
      byteLength: payload.byteLength,
      mediaType,
    };
    const prior = this.#artifactQueues.get(ref.sha256) ?? Promise.resolve();
    const pending = prior
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.readArtifact(ref);
          return ref;
        } catch (error) {
          if (!isCode(error, "ENOENT")) throw error;
        }
        await this.#assertDirectories("artifacts");
        const target = this.#artifactPath(ref.sha256),
          temporary = `${target}.${randomUUID()}.tmp`;
        const file = await open(temporary, "wx", 0o600);
        try {
          await writeAll(file, payload);
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          try {
            await link(temporary, target);
          } catch (error) {
            if (!isCode(error, "EEXIST")) throw error;
            await this.readArtifact(ref);
          }
        } finally {
          await rm(temporary, { force: true });
        }
        await syncDirectory(path.dirname(target));
        await this.readArtifact(ref);
        return ref;
      });
    this.#artifactQueues.set(ref.sha256, pending);
    void pending
      .finally(() => {
        if (this.#artifactQueues.get(ref.sha256) === pending)
          this.#artifactQueues.delete(ref.sha256);
      })
      .catch(() => undefined);
    return pending;
  }

  async #readStored(
    threadId: string,
    verifyArtifacts: boolean,
  ): Promise<TraceReadResult> {
    const records: TraceRecord[] = [],
      issues: TraceIssue[] = [];
    let segments: string[];
    try {
      await this.#assertDirectories("threads", threadId);
      segments = (await readdir(this.#threadPath(threadId)))
        .filter((name) => name.endsWith(".jsonl"))
        .sort();
    } catch (error) {
      if (isCode(error, "ENOENT"))
        return { records, issues, completeness: "complete" };
      return {
        records,
        issues: [{ kind: "read_failure", message: describe(error) }],
        completeness: "unavailable",
      };
    }
    for (const segment of segments) {
      let bytes: Buffer;
      try {
        await this.#assertDirectories("threads", threadId);
        bytes = await readOwnedFile(
          path.join(this.#threadPath(threadId), segment),
        );
        await this.#assertDirectories("threads", threadId);
      } catch (error) {
        issues.push({
          kind: "read_failure",
          message: describe(error),
          segment,
        });
        continue;
      }
      let offset = 0,
        line = 0;
      while (offset < bytes.length) {
        line++;
        const end = bytes.indexOf(10, offset);
        if (end < 0) {
          issues.push({
            kind: "partial_frame",
            message: `Uncommitted trailing bytes (${bytes.length - offset}) preserved`,
            segment,
            line,
          });
          break;
        }
        try {
          const frame = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              bytes.subarray(offset, end),
            ),
          ) as { record: TraceRecord; sha256: string };
          validateRecord(frame.record);
          if (
            frame.record.threadId !== threadId ||
            frame.sha256 !== digest(JSON.stringify(frame.record))
          )
            throw new Error("Trace frame identity or checksum mismatch");
          records.push(frame.record);
        } catch (error) {
          issues.push({
            kind: "invalid_frame",
            message: describe(error),
            segment,
            line,
          });
        }
        offset = end + 1;
      }
    }
    records.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    const seen = new Set<string>();
    for (const record of records) {
      if (seen.has(record.id))
        issues.push({
          kind: "invalid_frame",
          message: "Duplicate occurrence id",
          recordId: record.id,
        });
      seen.add(record.id);
      if (
        [
          "trace_capture_gap",
          "model_capture_gap",
          "tool_output_gap",
          "tool_media_gap",
        ].includes(record.type)
      )
        issues.push({
          kind: "capture_gap",
          message:
            "Capture failed for one or more observations; this Trace is not complete",
          recordId: record.id,
        });
      if (verifyArtifacts)
        for (const artifact of record.artifacts)
          try {
            await this.readArtifact(artifact.ref);
          } catch (error) {
            issues.push({
              kind: "artifact_unavailable",
              message: describe(error),
              recordId: record.id,
            });
          }
    }
    return {
      records,
      issues,
      completeness: issues.length ? "incomplete" : "complete",
    };
  }
  #failed(threadId: string, id: string, error: unknown): TraceReceipt {
    const message = describe(error);
    this.#failedRecords++;
    this.#lastError = message;
    if (identifier.test(threadId)) {
      const old = this.#gaps.get(threadId);
      this.#gaps.set(threadId, {
        count: (old?.count ?? 0) + 1,
        error: message,
      });
    }
    try {
      this.#onFailure?.({ kind: "write_failure", message, recordId: id });
    } catch {
      /* observation failure cannot grant execution authority */
    }
    return { durability: "degraded", error: message, recordId: id };
  }
  #threadPath(threadId: string): string {
    return path.join(this.directory, "threads", threadId);
  }
  #artifactPath(hash: string): string {
    return path.join(this.directory, "artifacts", hash);
  }
}

export function traceClock(): TraceClock {
  return {
    domain: clockDomain,
    monotonicNs: (process.hrtime.bigint() - clockStart).toString(),
    wallTime: new Date().toISOString(),
  };
}
export async function recordTraceJson(
  trace: RuntimeTrace,
  event: Omit<TraceEvent, "artifacts">,
  name: string,
  value: unknown,
  captureLayer = "runtime-json-value",
): Promise<TraceReceipt> {
  try {
    const bytes = JSON.stringify(value);
    if (bytes === undefined)
      throw new Error("Trace JSON value is not serializable");
    return await trace.record({
      ...event,
      artifacts: [{ name, bytes, mediaType: "application/json", captureLayer }],
    });
  } catch (error) {
    const message = describe(error);
    try {
      await trace.record({
        ...event,
        type: "trace_capture_gap",
        data: { eventType: event.type, artifactName: name, reason: message },
      });
    } catch {
      /* failing foreign writer */
    }
    return { durability: "degraded", error: message };
  }
}
/** Explicitly non-durable test fixture, never the production default. */
export class InMemoryTraceStore implements RuntimeTrace, TraceReader {
  readonly #records = new Map<string, TraceRecord[]>();
  readonly #artifacts = new Map<string, Uint8Array>();
  async record(event: TraceEvent): Promise<TraceReceipt> {
    const id = randomUUID();
    try {
      assertIdentifier(event.threadId);
      const records = this.#records.get(event.threadId) ?? [];
      const artifacts: TraceRecord["artifacts"] = (event.artifacts ?? []).map(
        (artifact) => {
          const bytes =
            typeof artifact.bytes === "string"
              ? Buffer.from(artifact.bytes)
              : Uint8Array.from(artifact.bytes);
          const ref = {
            sha256: digest(bytes),
            byteLength: bytes.length,
            mediaType: artifact.mediaType ?? "application/octet-stream",
          };
          this.#artifacts.set(ref.sha256, bytes);
          return {
            name: artifact.name,
            ref,
            ...(artifact.captureLayer === undefined
              ? {}
              : { captureLayer: artifact.captureLayer }),
          };
        },
      );
      records.push({
        id,
        threadId: event.threadId,
        sequence: records.length + 1,
        type: event.type,
        clock: traceClock(),
        artifacts,
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        ...(event.sampleId === undefined ? {} : { sampleId: event.sampleId }),
        ...(event.data === undefined ? {} : { data: jsonSnapshot(event.data) }),
      });
      this.#records.set(event.threadId, records);
      return {
        durability: "degraded",
        recordId: id,
        error: "Trace is memory-only (test fixture)",
      };
    } catch (error) {
      return { durability: "degraded", recordId: id, error: describe(error) };
    }
  }
  async read(
    threadId: string,
    options: { verifyArtifacts?: boolean } = {},
  ): Promise<TraceReadResult> {
    return {
      records: jsonSnapshot(this.#records.get(threadId) ?? []) as TraceRecord[],
      completeness: "incomplete",
      issues: [
        {
          kind: "write_failure",
          message: "Trace is memory-only (test fixture)",
        },
      ],
      artifactVerification:
        options.verifyArtifacts === false ? "not-checked" : "verified",
    };
  }
  async readArtifact(ref: TraceArtifactRef): Promise<Uint8Array> {
    assertArtifactRef(ref);
    const bytes = this.#artifacts.get(ref.sha256);
    if (bytes === undefined) throw new Error("Trace artifact unavailable");
    assertBytes(bytes, ref);
    return Uint8Array.from(bytes);
  }
  async listThreadIds(): Promise<string[]> {
    return [...this.#records.keys()].sort();
  }
  status(): TraceStatus {
    return {
      durability: "degraded",
      failedRecords: 0,
      lastError: "Trace is memory-only (test fixture)",
    };
  }
  async flush(): Promise<void> {}
}
function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
function jsonSnapshot(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
function assertIdentifier(value: string): void {
  if (!identifier.test(value)) throw new Error("Invalid Trace thread id");
}
function assertArtifactRef(value: TraceArtifactRef): void {
  if (
    !value ||
    !hashPattern.test(value.sha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0 ||
    typeof value.mediaType !== "string"
  )
    throw new Error("Invalid Trace artifact reference");
}
function assertBytes(bytes: Uint8Array, ref: TraceArtifactRef): void {
  if (bytes.byteLength !== ref.byteLength || digest(bytes) !== ref.sha256)
    throw new Error("Trace artifact hash or byte length mismatch");
}
function validateRecord(value: TraceRecord): void {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.threadId !== "string" ||
    !identifier.test(value.threadId) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    typeof value.type !== "string" ||
    !value.type ||
    !value.clock ||
    typeof value.clock.domain !== "string" ||
    !/^[0-9]+$/u.test(value.clock.monotonicNs) ||
    typeof value.clock.wallTime !== "string" ||
    !Array.isArray(value.artifacts)
  )
    throw new Error("Invalid Trace record");
  for (const artifact of value.artifacts) {
    if (!artifact || typeof artifact.name !== "string")
      throw new Error("Invalid Trace artifact");
    assertArtifactRef(artifact.ref);
  }
}
async function assertRealDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error(
      "Trace storage must be an owned real directory, not an alias",
    );
}
function assertOwnedRegularFile(metadata: Stats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
    throw new Error(
      "Trace storage must be an owned regular file, not a symbolic or hard-link alias",
    );
}
function assertSameFile(left: Stats, right: Stats): void {
  if (left.dev !== right.dev || left.ino !== right.ino)
    throw new Error("Trace file ownership changed during access");
}
async function readOwnedFile(filename: string): Promise<Buffer> {
  const before = await lstat(filename);
  assertOwnedRegularFile(before);
  const file = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await file.stat();
    assertOwnedRegularFile(opened);
    assertSameFile(before, opened);
    const bytes = await file.readFile();
    const after = await lstat(filename);
    assertOwnedRegularFile(after);
    assertSameFile(opened, after);
    return bytes;
  } finally {
    await file.close();
  }
}
async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertRealDirectory(directory);
  if (process.platform !== "win32") await chmod(directory, 0o700);
}
async function syncDirectory(directory: string): Promise<boolean> {
  if (process.platform === "win32") return false;
  const file = await open(directory, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  return true;
}
async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten === 0)
      throw new Error("Trace write made no progress");
    offset += result.bytesWritten;
  }
}
