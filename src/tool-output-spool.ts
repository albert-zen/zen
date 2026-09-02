import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TOOL_OUTPUT_PREVIEW_BYTES = 32 * 1024;
export const DEFAULT_TOOL_OUTPUT_CAPTURE_BYTES = 64 * 1024 * 1024;

export interface ToolOutputSpoolOptions {
  rootDirectory?: string;
  previewBytes?: number;
  maxCaptureBytes?: number;
}

/** Non-canonical metadata consumed by AgentRuntime before it appends an Item. */
export interface ToolOutputCaptureMetadata {
  readonly capturedBytes: number;
  readonly sha256: string;
  readonly path?: string;
  readonly lifetime: "host_instance";
  readonly sourceTruncated: boolean;
  readonly head: string;
  readonly tail: string;
  readonly output?: string;
}

export interface ToolOutputCaptureFinishOptions {
  sourceTruncated?: boolean;
}

/**
 * Host-owned boundary for bounded tool output capture and temporary lifecycle.
 * Files are only a short-lived readback aid; the rendered receipt is canonical.
 */
export class ToolOutputSpool {
  readonly #rootDirectory: string;
  readonly #instanceDirectory: string;
  readonly #previewBytes: number;
  readonly #maxCaptureBytes: number;
  readonly #ready: Promise<void>;
  readonly #active = new Set<Promise<void>>();
  #closed = false;

  constructor(options: ToolOutputSpoolOptions = {}) {
    this.#rootDirectory = path.resolve(
      options.rootDirectory ?? path.join(os.tmpdir(), "zen-tool-output-spool"),
    );
    this.#instanceDirectory = path.join(
      this.#rootDirectory,
      `instance-${String(process.pid)}-${randomUUID()}`,
    );
    if (
      process.platform === "win32" &&
      !isPathWithin(this.#rootDirectory, path.resolve(os.tmpdir()))
    ) {
      throw new Error(
        "Windows tool output spool must inherit the current user's private temp ACL",
      );
    }
    this.#previewBytes = positiveInteger(
      options.previewBytes ?? DEFAULT_TOOL_OUTPUT_PREVIEW_BYTES,
      "Tool output preview bytes",
    );
    this.#maxCaptureBytes = positiveInteger(
      options.maxCaptureBytes ?? DEFAULT_TOOL_OUTPUT_CAPTURE_BYTES,
      "Tool output capture bytes",
    );
    if (this.#previewBytes > this.#maxCaptureBytes) {
      throw new Error("Tool output preview cannot exceed its capture limit");
    }
    this.#ready = this.#initialize();
  }

  beginCapture(
    options: {
      redactedValues?: readonly string[];
      maxCaptureBytes?: number;
    } = {},
  ): ToolOutputCapture {
    if (this.#closed) throw new Error("Tool output spool is closed");
    const capture = new ToolOutputCapture({
      ready: this.#ready,
      filePath: path.join(this.#instanceDirectory, `${randomUUID()}.txt`),
      previewBytes: this.#previewBytes,
      maxCaptureBytes:
        options.maxCaptureBytes === undefined
          ? this.#maxCaptureBytes
          : Math.min(
              this.#maxCaptureBytes,
              positiveInteger(
                options.maxCaptureBytes,
                "Tool output capture bytes",
              ),
            ),
      redactedValues: options.redactedValues ?? [],
      onSettled: (settled) => this.#active.delete(settled),
      register: (settled) => this.#active.add(settled),
    });
    return capture;
  }

  async captureText(
    output: string,
    options: ToolOutputCaptureFinishOptions = {},
  ): Promise<ToolOutputCaptureMetadata> {
    const capture = this.beginCapture();
    capture.write(output);
    return await capture.finish(options);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#active]);
    await this.#ready.catch(() => undefined);
    await rm(this.#instanceDirectory, { recursive: true, force: true });
  }

  async #initialize(): Promise<void> {
    await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
    await assertRealDirectory(this.#rootDirectory, "Tool output spool root");
    if (process.platform !== "win32") await chmod(this.#rootDirectory, 0o700);
    await this.#removeStaleInstances();
    await mkdir(this.#instanceDirectory, { mode: 0o700 });
    await assertRealDirectory(
      this.#instanceDirectory,
      "Tool output spool instance",
    );
    if (process.platform !== "win32")
      await chmod(this.#instanceDirectory, 0o700);
  }

  async #removeStaleInstances(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.#rootDirectory);
    } catch {
      return;
    }
    await Promise.allSettled(
      entries.map(async (entry) => {
        const match = /^instance-(\d+)-/u.exec(entry);
        if (match === null || Number(match[1]) === process.pid) return;
        if (processIsAlive(Number(match[1]))) return;
        await rm(path.join(this.#rootDirectory, entry), {
          recursive: true,
          force: true,
        });
      }),
    );
  }
}

export class ToolOutputCapture {
  readonly #decoder = new StringDecoder("utf8");
  readonly #redactor: StreamingRedactor;
  readonly #ready: Promise<void>;
  readonly #filePath: string;
  readonly #previewBytes: number;
  readonly #maxCaptureBytes: number;
  readonly #headLimit: number;
  readonly #tailLimit: number;
  readonly #hash = createHash("sha256");
  readonly #small: Buffer[] = [];
  readonly #head: Buffer[] = [];
  readonly #tail: Buffer[] = [];
  readonly #settled: Promise<void>;
  readonly #resolveSettled: () => void;
  readonly #onSettled: (settled: Promise<void>) => void;
  #file: Promise<FileHandle | undefined>;
  #writes: Promise<void> = Promise.resolve();
  #capturedBytes = 0;
  #headBytes = 0;
  #tailBytes = 0;
  #sourceTruncated = false;
  #fileUnavailable = false;
  #finished = false;

  constructor(options: {
    ready: Promise<void>;
    filePath: string;
    previewBytes: number;
    maxCaptureBytes: number;
    redactedValues: readonly string[];
    register(settled: Promise<void>): void;
    onSettled(settled: Promise<void>): void;
  }) {
    this.#ready = options.ready;
    this.#filePath = options.filePath;
    this.#previewBytes = options.previewBytes;
    this.#maxCaptureBytes = options.maxCaptureBytes;
    this.#headLimit = Math.floor(options.previewBytes / 2);
    this.#tailLimit = options.previewBytes - this.#headLimit;
    this.#redactor = new StreamingRedactor(options.redactedValues);
    let resolveSettled!: () => void;
    this.#settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    this.#resolveSettled = resolveSettled;
    this.#onSettled = options.onSettled;
    options.register(this.#settled);
    this.#file = this.#openFile();
  }

  write(chunk: Buffer | string): void {
    if (this.#finished) throw new Error("Tool output capture is finished");
    const decoded =
      typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    this.#appendText(this.#redactor.write(decoded));
  }

  async finish(
    options: ToolOutputCaptureFinishOptions = {},
  ): Promise<ToolOutputCaptureMetadata> {
    if (this.#finished) throw new Error("Tool output capture is finished");
    this.#finished = true;
    this.#appendText(this.#redactor.write(this.#decoder.end()));
    this.#appendText(this.#redactor.end());
    this.#sourceTruncated ||= options.sourceTruncated ?? false;
    await this.#writes;
    const file = await this.#file;
    if (file !== undefined) {
      try {
        await file.close();
      } catch {
        this.#fileUnavailable = true;
      }
    }
    const oversized = this.#capturedBytes > this.#previewBytes;
    let requiresReceipt =
      oversized || this.#sourceTruncated || this.#fileUnavailable;
    if (!requiresReceipt || this.#fileUnavailable) {
      try {
        await rm(this.#filePath, { force: true });
      } catch {
        this.#fileUnavailable = true;
        requiresReceipt = true;
      }
    }
    const metadata: ToolOutputCaptureMetadata = {
      capturedBytes: this.#capturedBytes,
      sha256: this.#hash.digest("hex"),
      ...(requiresReceipt && !this.#fileUnavailable
        ? { path: this.#filePath }
        : {}),
      lifetime: "host_instance",
      sourceTruncated: this.#sourceTruncated || this.#fileUnavailable,
      head: decodeHead(Buffer.concat(this.#head), this.#headLimit),
      tail: decodeTail(Buffer.concat(this.#tail), this.#tailLimit),
      ...(requiresReceipt
        ? {}
        : { output: Buffer.concat(this.#small).toString("utf8") }),
    };
    this.#resolveSettled();
    this.#onSettled(this.#settled);
    return metadata;
  }

  async discard(): Promise<void> {
    if (!this.#finished) await this.finish({ sourceTruncated: true });
    await rm(this.#filePath, { force: true }).catch(() => undefined);
  }

  #appendText(text: string): void {
    if (text.length === 0) return;
    const encoded = Buffer.from(text, "utf8");
    const remaining = this.#maxCaptureBytes - this.#capturedBytes;
    if (remaining <= 0) {
      this.#sourceTruncated = true;
      return;
    }
    const kept = utf8Prefix(encoded, remaining);
    if (kept.length < encoded.length) this.#sourceTruncated = true;
    if (kept.length === 0) return;
    this.#capturedBytes += kept.length;
    this.#hash.update(kept);
    if (this.#capturedBytes <= this.#previewBytes) {
      this.#small.push(kept);
    } else {
      this.#small.length = 0;
    }
    if (this.#headBytes < this.#headLimit) {
      const head = kept.subarray(0, this.#headLimit - this.#headBytes);
      this.#head.push(head);
      this.#headBytes += head.length;
    }
    this.#tail.push(kept);
    this.#tailBytes += kept.length;
    while (this.#tailBytes > this.#tailLimit + 4 && this.#tail.length > 0) {
      const first = this.#tail[0]!;
      const excess = this.#tailBytes - (this.#tailLimit + 4);
      if (first.length <= excess) {
        this.#tail.shift();
        this.#tailBytes -= first.length;
      } else {
        this.#tail[0] = first.subarray(excess);
        this.#tailBytes -= excess;
      }
    }
    this.#writes = this.#writes.then(async () => {
      const file = await this.#file;
      if (file === undefined) return;
      try {
        await writeAll(file, kept);
      } catch {
        this.#fileUnavailable = true;
        await file.close().catch(() => undefined);
      }
    });
  }

  async #openFile(): Promise<FileHandle | undefined> {
    try {
      await this.#ready;
      return await open(this.#filePath, "wx", 0o600);
    } catch {
      this.#fileUnavailable = true;
      return undefined;
    }
  }
}

export function renderToolOutput(capture: ToolOutputCaptureMetadata): string {
  if (capture.output !== undefined) return capture.output;
  const fullOutput = capture.path ?? "unavailable";
  return [
    "[tool output receipt]",
    `captured_bytes: ${String(capture.capturedBytes)}`,
    `sha256: ${capture.sha256}`,
    `full_output: ${fullOutput}`,
    `lifetime: ${capture.lifetime}`,
    `source_truncated: ${String(capture.sourceTruncated)}`,
    "--- head ---",
    capture.head,
    "--- tail ---",
    capture.tail,
  ].join("\n");
}

class StreamingRedactor {
  readonly #values: readonly string[];
  readonly #maximumLength: number;
  #carry = "";

  constructor(values: readonly string[]) {
    this.#values = Object.freeze(
      values
        .filter(
          (value, index) => value.length > 0 && values.indexOf(value) === index,
        )
        .sort((left, right) => right.length - left.length),
    );
    this.#maximumLength = Math.max(
      1,
      ...this.#values.map((value) => value.length),
    );
  }

  write(text: string): string {
    if (text.length === 0) return "";
    const combined = this.#carry + text;
    const safeEnd = combined.length - this.#maximumLength + 1;
    if (safeEnd <= 0) {
      this.#carry = combined;
      return "";
    }
    let position = 0;
    let output = "";
    let boundary = safeEnd;
    if (
      boundary > 0 &&
      boundary < combined.length &&
      isHighSurrogate(combined.charCodeAt(boundary - 1)) &&
      isLowSurrogate(combined.charCodeAt(boundary))
    ) {
      boundary -= 1;
    }
    while (position < boundary) {
      const match = this.#values.find((value) =>
        combined.startsWith(value, position),
      );
      if (match !== undefined) {
        output += "[REDACTED]";
        position += match.length;
      } else {
        output += combined[position]!;
        position += 1;
      }
    }
    this.#carry = combined.slice(position);
    return output;
  }

  end(): string {
    const output = this.#redact(this.#carry);
    this.#carry = "";
    return output;
  }

  #redact(text: string): string {
    let output = text;
    for (const value of this.#values)
      output = output.replaceAll(value, "[REDACTED]");
    return output;
  }
}

function utf8Prefix(value: Buffer, limit: number): Buffer {
  let end = Math.min(value.length, limit);
  while (end > Math.max(0, Math.min(value.length, limit) - 4)) {
    const candidate = value.subarray(0, end);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(candidate);
      return candidate;
    } catch {
      end -= 1;
    }
  }
  return Buffer.alloc(0);
}

function decodeHead(value: Buffer, limit: number): string {
  return utf8Prefix(value, Math.min(value.length, limit)).toString("utf8");
}

function decodeTail(value: Buffer, limit: number): string {
  let start = Math.max(0, value.length - limit);
  while (start < value.length && (value[start]! & 0xc0) === 0x80) start += 1;
  return value.subarray(start).toString("utf8");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

async function writeAll(file: FileHandle, value: Buffer): Promise<void> {
  let offset = 0;
  while (offset < value.length) {
    const { bytesWritten } = await file.write(
      value,
      offset,
      value.length - offset,
      null,
    );
    if (bytesWritten < 1)
      throw new Error("Tool output spool write made no progress");
    offset += bytesWritten;
  }
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function assertRealDirectory(
  directory: string,
  label: string,
): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
