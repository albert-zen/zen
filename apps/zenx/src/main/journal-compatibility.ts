import { access, lstat, mkdir, realpath, rename } from "node:fs/promises";
import path from "node:path";

import { Thread } from "../../../../src/thread.js";
import {
  JsonlThreadJournal,
  type ThreadJournal,
} from "../../../../src/journal.js";

const THREAD_FILE_SUFFIX = ".jsonl";
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const LEGACY_RECORD_VERSION = 1;
const LEGACY_EMPTY_QUARANTINE_NAME = "legacy-journal-quarantine";

const CANONICAL_ITEM_TYPES = new Set([
  "thread_metadata",
  "thread_configuration_changed",
  "turn_started",
  "turn_completed",
  "turn_aborted",
  "turn_replacement_requested",
  "user_message",
  "agent_message",
  "reasoning",
  "tool_call",
  "tool_result",
  "failure",
]);

const LEGACY_USEFUL_TYPES = new Set([
  "turn.queued",
  "run.started",
  "turn.started",
  "system.message.completed",
  "user.message.completed",
  "model.request.started",
  "assistant.message.started",
  "assistant.message.delta",
  "assistant.message.completed",
  "model.request.completed",
  "turn.completed",
  "run.completed",
]);

export type JournalCandidateClassification =
  | "current"
  | "known-legacy-no-useful-content"
  | "known-legacy-useful-content"
  | "unknown";

export interface JournalCandidate {
  readonly threadId: string;
  readonly filePath: string;
  readonly classification: JournalCandidateClassification;
  readonly recordCount: number;
  readonly usefulLegacyRecordCount: number;
  readonly reason?: string;
}

export interface JournalCompatibilityCounts {
  readonly current: number;
  readonly knownLegacy: number;
  readonly legacyNoUsefulContent: number;
  readonly legacyUsefulContent: number;
  readonly unknown: number;
  readonly unavailable: number;
}

export interface JournalCompatibilityProjection {
  readonly zenHome: string;
  readonly threadsDirectory: string;
  readonly quarantineDirectory: string;
  readonly counts: JournalCompatibilityCounts;
  readonly candidates: readonly JournalCandidate[];
}

export interface JournalQuarantineResult {
  readonly moved: readonly JournalCandidate[];
  readonly quarantineDirectory: string;
  readonly projection: JournalCompatibilityProjection;
}

export interface JournalCompatibilityServiceOptions {
  readonly zenHome: string;
  readonly journal?: ThreadJournal;
  readonly threadsDirectory?: string;
  readonly quarantineDirectory?: string;
}

/**
 * Projects the current JSONL journal loader into compatibility diagnostics and
 * safely quarantines only the known legacy files with no useful content.
 */
export class ZenXJournalCompatibilityService {
  readonly #zenHome: string;
  readonly #threadsDirectory: string;
  readonly #quarantineDirectory: string;
  readonly #journal: ThreadJournal;

  constructor(options: JournalCompatibilityServiceOptions) {
    this.#zenHome = path.resolve(options.zenHome);
    this.#threadsDirectory = path.resolve(
      options.threadsDirectory ?? path.join(this.#zenHome, "threads"),
    );
    this.#quarantineDirectory = path.resolve(
      options.quarantineDirectory ??
        path.join(this.#zenHome, LEGACY_EMPTY_QUARANTINE_NAME),
    );
    this.#journal =
      options.journal ?? new JsonlThreadJournal(this.#threadsDirectory);
    assertPathInside(this.#zenHome, this.#threadsDirectory, "threads");
    assertPathInside(this.#zenHome, this.#quarantineDirectory, "quarantine");
    if (samePath(this.#threadsDirectory, this.#quarantineDirectory)) {
      throw new Error(
        "Journal quarantine must be outside the threads directory",
      );
    }
  }

  async refresh(): Promise<JournalCompatibilityProjection> {
    return await this.inspect();
  }

  async inspect(): Promise<JournalCompatibilityProjection> {
    const threadIds = await this.#journal.listThreadIds();
    const candidates: JournalCandidate[] = [];
    for (const threadId of threadIds) {
      candidates.push(await this.#classify(threadId));
    }
    candidates.sort((left, right) =>
      left.threadId.localeCompare(right.threadId),
    );
    return makeProjection(
      this.#zenHome,
      this.#threadsDirectory,
      this.#quarantineDirectory,
      candidates,
    );
  }

  async quarantineLegacyNoUsefulContent(): Promise<JournalQuarantineResult> {
    const projection = await this.inspect();
    const toMove = projection.candidates.filter(
      (candidate) =>
        candidate.classification === "known-legacy-no-useful-content",
    );
    const targets = toMove.map((candidate) => ({
      candidate,
      source: this.#sourcePath(candidate.threadId),
      target: this.#targetPath(candidate.threadId),
    }));

    await this.#validateMoveSet(targets);
    if (targets.length > 0) {
      await mkdir(this.#quarantineDirectory, { recursive: true });
      await this.#assertDirectoryInsideZenHome(
        this.#quarantineDirectory,
        "quarantine",
      );
    }
    for (const target of targets) {
      await rename(target.source, target.target);
    }

    return {
      moved: Object.freeze(toMove),
      quarantineDirectory: this.#quarantineDirectory,
      projection: await this.refresh(),
    };
  }

  async #classify(threadId: string): Promise<JournalCandidate> {
    const filePath = this.#sourcePath(threadId);
    try {
      const records = await this.#journal.read(threadId);
      if (records.length === 0) {
        return candidate(
          threadId,
          filePath,
          "unknown",
          0,
          0,
          "Journal contains no records",
        );
      }
      if (records.every((record) => isLegacyRecord(record))) {
        const usefulLegacyRecordCount = records.filter((record) =>
          isUsefulLegacyRecord(record),
        ).length;
        if (usefulLegacyRecordCount === 0) {
          return candidate(
            threadId,
            filePath,
            "known-legacy-no-useful-content",
            records.length,
            usefulLegacyRecordCount,
          );
        }
        return candidate(
          threadId,
          filePath,
          "known-legacy-useful-content",
          records.length,
          usefulLegacyRecordCount,
          "Known legacy journal contains useful execution records",
        );
      }
      if (records.every((record) => isCanonicalItem(record, threadId))) {
        try {
          new Thread(threadId, records);
          return candidate(threadId, filePath, "current", records.length, 0);
        } catch (error) {
          return candidate(
            threadId,
            filePath,
            "unknown",
            records.length,
            0,
            describeError(error),
          );
        }
      }
      return candidate(
        threadId,
        filePath,
        "unknown",
        records.length,
        0,
        "Records do not match a known current or legacy journal format",
      );
    } catch (error) {
      return candidate(
        threadId,
        filePath,
        "unknown",
        0,
        0,
        describeError(error),
      );
    }
  }

  #sourcePath(threadId: string): string {
    if (!THREAD_ID_PATTERN.test(threadId)) {
      throw new Error(`Invalid journal thread id: ${threadId}`);
    }
    const source = path.resolve(
      this.#threadsDirectory,
      `${threadId}${THREAD_FILE_SUFFIX}`,
    );
    assertPathInside(this.#threadsDirectory, source, "journal source");
    return source;
  }

  #targetPath(threadId: string): string {
    const target = path.resolve(
      this.#quarantineDirectory,
      `${threadId}${THREAD_FILE_SUFFIX}`,
    );
    assertPathInside(this.#quarantineDirectory, target, "journal target");
    assertPathInside(this.#zenHome, target, "journal target");
    return target;
  }

  async #validateMoveSet(
    targets: readonly {
      candidate: JournalCandidate;
      source: string;
      target: string;
    }[],
  ): Promise<void> {
    const seenTargets = new Set<string>();
    for (const { candidate, source, target } of targets) {
      if (seenTargets.has(normalizePath(target))) {
        throw new Error(`Duplicate journal quarantine target: ${target}`);
      }
      seenTargets.add(normalizePath(target));
      await this.#assertFileInsideThreads(source, candidate.threadId);
      if (await exists(target)) {
        throw new Error(`Journal quarantine target already exists: ${target}`);
      }
    }
  }

  async #assertFileInsideThreads(
    source: string,
    threadId: string,
  ): Promise<void> {
    assertPathInside(this.#threadsDirectory, source, "journal source");
    const sourceStat = await lstat(source).catch((error: unknown) => {
      throw new Error(
        `Journal source disappeared for ${threadId}: ${describeError(error)}`,
      );
    });
    if (!sourceStat.isFile()) {
      throw new Error(`Journal source is not a regular file: ${source}`);
    }
    const [sourceRealPath, threadsRealPath] = await Promise.all([
      realpath(source),
      realpath(this.#threadsDirectory),
    ]);
    assertPathInside(threadsRealPath, sourceRealPath, "journal source");
  }

  async #assertDirectoryInsideZenHome(
    directory: string,
    label: string,
  ): Promise<void> {
    const [directoryRealPath, zenHomeRealPath] = await Promise.all([
      realpath(directory),
      realpath(this.#zenHome),
    ]);
    assertPathInside(zenHomeRealPath, directoryRealPath, label);
  }
}

function candidate(
  threadId: string,
  filePath: string,
  classification: JournalCandidateClassification,
  recordCount: number,
  usefulLegacyRecordCount: number,
  reason?: string,
): JournalCandidate {
  return {
    threadId,
    filePath,
    classification,
    recordCount,
    usefulLegacyRecordCount,
    ...(reason === undefined ? {} : { reason }),
  };
}

function makeProjection(
  zenHome: string,
  threadsDirectory: string,
  quarantineDirectory: string,
  candidates: readonly JournalCandidate[],
): JournalCompatibilityProjection {
  const current = count(candidates, "current");
  const legacyNoUsefulContent = count(
    candidates,
    "known-legacy-no-useful-content",
  );
  const legacyUsefulContent = count(candidates, "known-legacy-useful-content");
  const unknown = count(candidates, "unknown");
  return {
    zenHome,
    threadsDirectory,
    quarantineDirectory,
    counts: {
      current,
      knownLegacy: legacyNoUsefulContent + legacyUsefulContent,
      legacyNoUsefulContent,
      legacyUsefulContent,
      unknown,
      unavailable: legacyNoUsefulContent + legacyUsefulContent + unknown,
    },
    candidates: Object.freeze([...candidates]),
  };
}

function count(
  candidates: readonly JournalCandidate[],
  classification: JournalCandidateClassification,
): number {
  return candidates.filter(
    (candidate) => candidate.classification === classification,
  ).length;
}

function isCanonicalItem(value: unknown, threadId: string): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    typeof value.threadId !== "string" ||
    value.threadId !== threadId ||
    typeof value.createdAt !== "string" ||
    typeof value.type !== "string" ||
    !CANONICAL_ITEM_TYPES.has(value.type)
  ) {
    return false;
  }
  if (value.type === "thread_metadata") {
    return (
      typeof value.cwd === "string" &&
      typeof value.model === "string" &&
      typeof value.provider === "string" &&
      value.sandbox === "danger-full-access" &&
      (value.approvalPolicy === "always" || value.approvalPolicy === "never")
    );
  }
  if (value.type === "thread_configuration_changed") {
    return (
      isRecord(value.model) &&
      typeof value.model.from === "string" &&
      typeof value.model.to === "string"
    );
  }
  if (value.type === "turn_started") {
    return typeof value.turnId === "string";
  }
  if (value.type === "turn_completed") {
    return (
      typeof value.turnId === "string" &&
      (value.status === "completed" || value.status === "failed")
    );
  }
  if (value.type === "turn_aborted") {
    return typeof value.turnId === "string" && typeof value.reason === "string";
  }
  if (value.type === "turn_replacement_requested") {
    return (
      typeof value.turnId === "string" &&
      typeof value.successorTurnId === "string" &&
      typeof value.text === "string" &&
      typeof value.clientId === "string"
    );
  }
  if (value.type === "user_message" || value.type === "agent_message") {
    return typeof value.turnId === "string" && typeof value.text === "string";
  }
  if (value.type === "reasoning") {
    return (
      typeof value.turnId === "string" && typeof value.summary === "string"
    );
  }
  if (value.type === "tool_call") {
    return (
      typeof value.turnId === "string" &&
      typeof value.callId === "string" &&
      typeof value.name === "string" &&
      isRecord(value.arguments)
    );
  }
  if (value.type === "tool_result") {
    return (
      typeof value.turnId === "string" &&
      typeof value.callId === "string" &&
      typeof value.output === "string" &&
      typeof value.exitCode === "number"
    );
  }
  return (
    value.type === "failure" &&
    typeof value.turnId === "string" &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

function isLegacyRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.version !== LEGACY_RECORD_VERSION) return false;
  if (!isRecord(value.item)) return false;
  return (
    (typeof value.item.id === "string" &&
      typeof value.item.type === "string" &&
      typeof value.item.createdAtMs === "number" &&
      Number.isFinite(value.item.createdAtMs) &&
      typeof value.item.seq === "number" &&
      Number.isInteger(value.item.seq) &&
      typeof value.item.runId === "string" &&
      typeof value.item.turnId === "string" &&
      isRecord(value.item.payload) &&
      LEGACY_USEFUL_TYPES.has(value.item.type)) ||
    (value.item.type === "thread.created" && isLegacyThreadCreated(value.item))
  );
}

function isLegacyThreadCreated(item: Record<string, unknown>): boolean {
  if (
    typeof item.id !== "string" ||
    typeof item.createdAtMs !== "number" ||
    !Number.isFinite(item.createdAtMs) ||
    typeof item.seq !== "number" ||
    !Number.isInteger(item.seq) ||
    typeof item.runId !== "string" ||
    typeof item.turnId !== "string" ||
    !isRecord(item.payload)
  ) {
    return false;
  }
  return typeof item.payload.threadId === "string";
}

function isUsefulLegacyRecord(value: Record<string, unknown>): boolean {
  return isRecord(value.item) && value.item.type !== "thread.created";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPathInside(base: string, target: string, label: string): void {
  const relative = path.relative(base, target);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must remain inside ${base}: ${target}`);
  }
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(value: string): string {
  return path.normalize(value).toLowerCase();
}

async function exists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
