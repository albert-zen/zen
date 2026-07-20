import { mkdir, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ProjectCoordinationJournalCorruptionError,
  cloneCoordinationItem,
  type ProjectCoordinationItem,
  type ProjectCoordinationJournal,
} from '../../product/index.js';

const VERSION = 1;

type FileHandle = {
  write(buffer: Buffer, position?: number | null): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

export type ProjectCoordinationFileSystem = {
  mkdir(path: string, options: { readonly recursive: true }): Promise<string | undefined>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  open(path: string, flags: string): Promise<FileHandle>;
};

export type FileProjectCoordinationJournalOptions = {
  readonly filePath?: string;
  readonly fileSystem?: ProjectCoordinationFileSystem;
};

export class FileProjectCoordinationJournal implements ProjectCoordinationJournal {
  private readonly filePath: string;
  private readonly fileSystem: ProjectCoordinationFileSystem;
  private tail: Promise<void> = Promise.resolve();
  private handle?: FileHandle;
  private closed = false;

  constructor(options: FileProjectCoordinationJournalOptions = {}) {
    this.filePath =
      options.filePath ?? join(homedir(), '.zen', 'agent-app', 'project-coordination.jsonl');
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
  }

  async append(item: ProjectCoordinationItem): Promise<void> {
    if (this.closed) throw new Error('Project coordination journal is closed');
    assertItem(item, this.filePath, 0);
    const line = Buffer.from(`${JSON.stringify({ version: VERSION, item })}\n`, 'utf8');
    const operation = this.tail.then(async () => {
      await this.fileSystem.mkdir(dirname(this.filePath), { recursive: true });
      this.handle ??= await this.fileSystem.open(this.filePath, 'a');
      await writeAll(this.handle, line);
      await this.handle.sync();
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;
  }

  async replay(): Promise<readonly ProjectCoordinationItem[]> {
    let text: string;
    try {
      text = await this.fileSystem.readFile(this.filePath, 'utf8');
    } catch (cause) {
      if (isMissing(cause)) return [];
      throw cause;
    }
    if (!text.endsWith('\n') && text.length > 0) {
      throw new ProjectCoordinationJournalCorruptionError(
        this.filePath,
        0,
        'truncated final record'
      );
    }
    if (!text) return [];
    return text
      .slice(0, -1)
      .split('\n')
      .map((line, index) => decodeLine(line, this.filePath, index + 1));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    if (!this.handle) return;
    await this.handle.sync();
    await this.handle.close();
    this.handle = undefined;
  }
}

const nodeFileSystem: ProjectCoordinationFileSystem = { mkdir, readFile, open };

function decodeLine(line: string, path: string, recordNumber: number): ProjectCoordinationItem {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    throw new ProjectCoordinationJournalCorruptionError(path, recordNumber, 'invalid JSON');
  }
  if (!isRecord(record) || record.version !== VERSION) {
    throw new ProjectCoordinationJournalCorruptionError(
      path,
      recordNumber,
      'invalid version envelope'
    );
  }
  assertItem(record.item, path, recordNumber);
  return cloneCoordinationItem(record.item);
}

function assertItem(
  value: unknown,
  path: string,
  recordNumber: number
): asserts value is ProjectCoordinationItem {
  if (
    !isRecord(value) ||
    value.version !== VERSION ||
    typeof value.id !== 'string' ||
    typeof value.type !== 'string' ||
    typeof value.projectId !== 'string' ||
    !Number.isSafeInteger(value.createdAtMs) ||
    !Number.isSafeInteger(value.seq) ||
    !isRecord(value.payload)
  ) {
    throw new ProjectCoordinationJournalCorruptionError(
      path,
      recordNumber,
      'invalid coordination item'
    );
  }
}

async function writeAll(handle: FileHandle, line: Buffer): Promise<void> {
  let offset = 0;
  while (offset < line.byteLength) {
    const { bytesWritten } = await handle.write(line.subarray(offset), null);
    if (bytesWritten <= 0) throw new Error('Coordination journal write accepted zero bytes');
    offset += bytesWritten;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(cause: unknown): boolean {
  return isRecord(cause) && cause.code === 'ENOENT';
}
