import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ApprovalPolicy, SandboxMode } from "./item.js";

export interface CurrentMetadata {
  providerProfileId?: string;
  modelId?: string;
  reasoningEffort?: string;
  /** Compatibility projections for existing product callers. */
  model: string;
  provider: string;
  cwd: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
}

export interface ThreadSummary {
  threadId: string;
  currentMetadata: CurrentMetadata;
  name?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  preview: string;
  status: "idle" | "active";
}

export interface UnavailableThreadSummary {
  threadId: string;
  name?: string;
  archived: boolean;
  createdAt: null;
  updatedAt: null;
  preview: string;
  status: "systemError";
  error: string;
}

export type NativeThreadSummary = ThreadSummary | UnavailableThreadSummary;

export interface ThreadSummaryListOptions {
  archived?: boolean;
}

export interface ThreadSummaryProjection {
  load(): Promise<NativeThreadSummary[] | undefined>;
  replace(summaries: readonly NativeThreadSummary[]): Promise<void>;
}

export class InMemoryThreadSummaryProjection implements ThreadSummaryProjection {
  #summaries: NativeThreadSummary[] | undefined;

  async load(): Promise<NativeThreadSummary[] | undefined> {
    return this.#summaries === undefined
      ? undefined
      : structuredClone(this.#summaries);
  }

  async replace(summaries: readonly NativeThreadSummary[]): Promise<void> {
    this.#summaries = structuredClone([...summaries]);
  }
}

export class JsonThreadSummaryProjection implements ThreadSummaryProjection {
  readonly #filename: string;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(filename: string) {
    this.#filename = path.resolve(filename);
  }

  async load(): Promise<NativeThreadSummary[] | undefined> {
    let contents: string;
    try {
      contents = await readFile(this.#filename, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const value: unknown = JSON.parse(contents);
      if (!isProjectionFile(value)) throw new Error("invalid shape");
      return structuredClone(value.summaries);
    } catch (error) {
      console.warn(
        `Ignoring invalid native Thread summary projection ${this.#filename}`,
        error,
      );
      return undefined;
    }
  }

  async replace(summaries: readonly NativeThreadSummary[]): Promise<void> {
    const write = this.#writeChain.then(async () => {
      await mkdir(path.dirname(this.#filename), { recursive: true });
      const temporary = `${this.#filename}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, summaries })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporary, this.#filename);
    });
    this.#writeChain = write.catch(() => undefined);
    await write;
  }
}

interface ProjectionFile {
  version: 1;
  summaries: NativeThreadSummary[];
}

function isProjectionFile(value: unknown): value is ProjectionFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.summaries) &&
    value.summaries.every(isNativeThreadSummary)
  );
}

export function isNativeThreadSummary(
  value: unknown,
): value is NativeThreadSummary {
  if (
    !isRecord(value) ||
    typeof value.threadId !== "string" ||
    value.threadId.length === 0 ||
    typeof value.archived !== "boolean" ||
    (value.name !== undefined && typeof value.name !== "string") ||
    typeof value.preview !== "string"
  ) {
    return false;
  }
  if (value.status === "systemError") {
    return (
      value.createdAt === null &&
      value.updatedAt === null &&
      typeof value.error === "string" &&
      value.currentMetadata === undefined
    );
  }
  return (
    (value.status === "idle" || value.status === "active") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    value.error === undefined &&
    isCurrentMetadata(value.currentMetadata)
  );
}

function isCurrentMetadata(value: unknown): value is CurrentMetadata {
  return (
    isRecord(value) &&
    (value.providerProfileId === undefined ||
      typeof value.providerProfileId === "string") &&
    (value.modelId === undefined || typeof value.modelId === "string") &&
    (value.reasoningEffort === undefined ||
      typeof value.reasoningEffort === "string") &&
    typeof value.model === "string" &&
    typeof value.provider === "string" &&
    typeof value.cwd === "string" &&
    value.sandbox === "danger-full-access" &&
    (value.approvalPolicy === "always" || value.approvalPolicy === "never")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
